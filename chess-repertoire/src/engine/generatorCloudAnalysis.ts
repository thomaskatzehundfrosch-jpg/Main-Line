import { Chess } from 'chess.js';
import type { PositionEval, TopMoveResult } from './analyzer';
import { abortError } from '../utils/generatorCancellation';

type LocalEngine = {
  analyze: (worker: Worker, fen: string, depth: number, signal?: AbortSignal) => Promise<PositionEval>;
  topMoves: (worker: Worker, fen: string, depth: number, count: number, timeout?: number, signal?: AbortSignal) => Promise<TopMoveResult[]>;
};
type CloudResult = { depth: number; rows: Array<{ uci: string; cp?: number; mate?: number }> };

/** Opportunistic cache lookup: never queue retries in front of local engine work. */
export function createGeneratorCloudAnalysis(local: LocalEngine, fetcher: typeof fetch = (...args) => globalThis.fetch(...args), now = Date.now) {
  const cache = new Map<string, { result: CloudResult | null; expires: number }>();
  let cooldownUntil = 0;
  let nextRequest = 0;
  let misses = 0;
  async function query(fen: string, count: number, depth: number, signal?: AbortSignal): Promise<CloudResult | null> {
    if (signal?.aborted) throw abortError();
    // Lichess provides at most five PVs. Keep six-candidate/full-width searches local.
    if (count > 5 || new Chess(fen).isGameOver()) return null;
    const key = JSON.stringify([fen, count]);
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.result && cached.result.depth >= depth ? cached.result : null;
    if (now() < cooldownUntil || now() < nextRequest) return null;
    nextRequest = now() + 250;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 1500);
    try {
      const params = new URLSearchParams({ fen, multiPv: String(count), variant: 'standard' });
      const response = await fetcher(`https://lichess.org/api/cloud-eval?${params}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (signal?.aborted) throw abortError();
      if (response.status === 429) {
        cooldownUntil = now() + Math.max(60000, (Number(response.headers.get('Retry-After')) || 0) * 1000);
        return null;
      }
      if (!response.ok) {
        if (response.status === 404) {
          cache.set(key, { result: null, expires: now() + 300000 });
          if (++misses >= 4) { cooldownUntil = now() + 30000; misses = 0; }
        } else cooldownUntil = now() + 30000;
        return null;
      }
      const data = await response.json();
      if (typeof data?.fen === 'string' && data.fen.split(' ').slice(0, 4).join(' ') !== fen.split(' ').slice(0, 4).join(' ')) return null;
      if (!Number.isInteger(data?.depth) || data.depth <= 0 || !Array.isArray(data.pvs) || data.pvs.length < count) return null;
      const chess = new Chess(fen);
      const legal = new Set(chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || '')));
      const seen = new Set<string>();
      const rows: CloudResult['rows'] = [];
      for (const pv of data.pvs.slice(0, count)) {
        const uci = typeof pv.moves === 'string' ? pv.moves.trim().split(/\s+/)[0] : '';
        const hasCp = Number.isFinite(pv.cp), hasMate = Number.isInteger(pv.mate) && pv.mate !== 0;
        if (!legal.has(uci) || seen.has(uci) || hasCp === hasMate) return null;
        seen.add(uci);
        rows.push({ uci, ...(hasCp ? { cp: pv.cp } : { mate: pv.mate }) });
      }
      const result = { depth: data.depth, rows };
      cache.set(key, { result, expires: now() + 3600000 });
      misses = 0;
      return result.depth >= depth ? result : null;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      cooldownUntil = now() + 30000;
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    verify: local.analyze,
    async analyze(worker: Worker, fen: string, depth: number, signal?: AbortSignal): Promise<PositionEval> {
      const cloud = await query(fen, 1, depth, signal);
      if (signal?.aborted) throw abortError();
      if (!cloud) return local.analyze(worker, fen, depth, signal);
      const row = cloud.rows[0], chess = new Chess(fen);
      const move = chess.move({ from: row.uci.slice(0, 2), to: row.uci.slice(2, 4), promotion: row.uci[4] });
      return { fen, score: row.cp ?? (row.mate! > 0 ? 10000 : -10000), depth: cloud.depth, isMate: row.mate != null, mateIn: row.mate ?? null, bestMoveUci: row.uci, bestMoveSan: move.san, source: 'lichess-cloud' };
    },
    async topMoves(worker: Worker, fen: string, depth: number, count = 3, timeout = 90000, signal?: AbortSignal): Promise<TopMoveResult[]> {
      const cloud = await query(fen, count, depth, signal);
      if (signal?.aborted) throw abortError();
      if (!cloud) return local.topMoves(worker, fen, depth, count, timeout, signal);
      return cloud.rows.map(row => ({ uci: row.uci, eval: row.cp != null ? row.cp / 100 : row.mate! > 0 ? 100 : -100, depth: cloud.depth }));
    },
  };
}
