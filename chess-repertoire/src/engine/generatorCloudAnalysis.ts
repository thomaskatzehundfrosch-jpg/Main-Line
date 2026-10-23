import { Chess } from 'chess.js';
import { normalizeExplorerUci } from '../utils/explorerMove.js';
import type { PositionEval, TopMoveResult } from './analyzer';
import { abortError, abortableDelay } from '../utils/generatorCancellation';

type LocalEngine = {
  analyze: (worker: Worker, fen: string, depth: number, signal?: AbortSignal) => Promise<PositionEval>;
  topMoves: (worker: Worker, fen: string, depth: number, count: number, timeout?: number, signal?: AbortSignal) => Promise<TopMoveResult[]>;
};
type CloudResult = { depth: number; rows: Array<{ uci: string; cp?: number; mate?: number }> };

/** Pace cache lookups; rate-limit cooldowns fall back to the local engine. */
export function createGeneratorCloudAnalysis(local: LocalEngine, fetcher: typeof fetch = (...args) => globalThis.fetch(...args), now = Date.now, log: (message: string) => void = () => {}) {
  const cache = new Map<string, { result: CloudResult | null; expires: number }>();
  let cooldownUntil = 0;
  let nextRequest = 0;
  let requestQueue: Promise<void> = Promise.resolve();
  async function query(fen: string, count: number, depth: number, signal?: AbortSignal): Promise<CloudResult | null> {
    if (signal?.aborted) throw abortError();
    // Lichess provides at most five PVs. Keep six-candidate/full-width searches local.
    const report = (reason: string) => log(`Cloud: ${reason}; requested depth ${depth}, MultiPV ${count}. FEN: ${fen}`);
    if (count > 5 || new Chess(fen).isGameOver()) { report(count > 5 ? 'unsupported width (maximum 5)' : 'terminal position'); return null; }
    const key = JSON.stringify([fen, count]);
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      report(!cached.result ? 'cached miss' : cached.result.depth < depth ? `cached depth ${cached.result.depth} insufficient` : `cache hit at depth ${cached.result.depth}`);
      return cached.result && cached.result.depth >= depth ? cached.result : null;
    }
    if (now() < cooldownUntil) { report(`rate-limit/service cooldown (${Math.ceil((cooldownUntil - now()) / 1000)}s remaining)`); return null; }
    const delay = Math.max(0, nextRequest - now());
    if (delay) { report(`pacing request by ${delay}ms`); await abortableDelay(delay, signal); }
    if (signal?.aborted) throw abortError();
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
        report('HTTP 429, rate limited');
        return null;
      }
      if (!response.ok) {
        if (response.status === 404) {
          cache.set(key, { result: null, expires: now() + 300000 });
        } else cooldownUntil = now() + 30000;
        report(`HTTP ${response.status}${response.status === 404 ? ', position not cached' : ', service unavailable'}`);
        return null;
      }
      const data = await response.json();
      if (typeof data?.fen === 'string' && data.fen.split(' ').slice(0, 4).join(' ') !== fen.split(' ').slice(0, 4).join(' ')) { report('mismatched position'); return null; }
      if (!Number.isInteger(data?.depth) || data.depth <= 0 || !Array.isArray(data.pvs) || data.pvs.length < count) { report('invalid depth or insufficient PV width'); return null; }
      const chess = new Chess(fen);
      const legal = new Set(chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || '')));
      const seen = new Set<string>();
      const rows: CloudResult['rows'] = [];
      for (const pv of data.pvs.slice(0, count)) {
        const rawUci = typeof pv.moves === 'string' ? pv.moves.trim().split(/\s+/)[0] : '';
        const uci = normalizeExplorerUci(fen, rawUci);
        const hasCp = Number.isFinite(pv.cp), hasMate = Number.isInteger(pv.mate) && pv.mate !== 0;
        if (!legal.has(uci)) { report(`illegal first move ${rawUci || '(missing)'}`); return null; }
        if (seen.has(uci)) { report(`duplicate first move ${uci}; insufficient distinct PVs`); return null; }
        if (hasCp === hasMate) { report(`missing or conflicting score for ${uci}`); return null; }
        seen.add(uci);
        rows.push({ uci, ...(hasCp ? { cp: pv.cp } : { mate: pv.mate }) });
      }
      const result = { depth: data.depth, rows };
      cache.set(key, { result, expires: now() + 3600000 });
      report(result.depth >= depth ? `hit at depth ${result.depth}` : `depth ${result.depth} insufficient`);
      return result.depth >= depth ? result : null;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      cooldownUntil = now() + 30000;
      report(controller.signal.aborted ? 'request timed out after 1500ms' : `request failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  // Hold the queue/lock through JSON parsing, not just until response headers arrive.
  function serialQuery(fen: string, count: number, depth: number, signal?: AbortSignal) {
    const task = () => query(fen, count, depth, signal);
    const execute = async (): Promise<CloudResult | null> => typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('main-line-lichess-api', { signal }, task) : task();
    const pending = requestQueue.then(execute, execute);
    requestQueue = pending.then(() => {}, () => {});
    return pending;
  }
  const gateway = {
    async verify(worker: Worker, fen: string, depth: number, signal?: AbortSignal): Promise<PositionEval> {
      return gateway.analyze(worker, fen, depth, signal);
    },
    async analyze(worker: Worker, fen: string, depth: number, signal?: AbortSignal): Promise<PositionEval> {
      const cloud = await serialQuery(fen, 1, depth, signal);
      if (signal?.aborted) throw abortError();
      if (!cloud) return local.analyze(worker, fen, depth, signal);
      const row = cloud.rows[0], chess = new Chess(fen);
      const move = chess.move({ from: row.uci.slice(0, 2), to: row.uci.slice(2, 4), promotion: row.uci[4] });
      return { fen, score: row.cp ?? (row.mate! > 0 ? 10000 : -10000), depth: cloud.depth, isMate: row.mate != null, mateIn: row.mate ?? null, bestMoveUci: row.uci, bestMoveSan: move.san, source: 'lichess-cloud' };
    },
    async topMoves(worker: Worker, fen: string, depth: number, count = 3, timeout = 90000, signal?: AbortSignal): Promise<TopMoveResult[]> {
      const cloud = await serialQuery(fen, count, depth, signal);
      if (signal?.aborted) throw abortError();
      if (!cloud) return local.topMoves(worker, fen, depth, count, timeout, signal);
      return cloud.rows.map(row => ({ uci: row.uci, eval: row.cp != null ? row.cp / 100 : row.mate! > 0 ? 100 : -100, depth: cloud.depth }));
    },
  };
  return gateway;
}
