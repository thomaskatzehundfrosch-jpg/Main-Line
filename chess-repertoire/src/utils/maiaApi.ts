/**
 * Maia Chess API client.
 *
 * Provides human-like move predictions using Maia Chess v2.
 *
 * Primary:   In-browser ONNX inference via onnxruntime-web (no server needed).
 *            Model (~50 MB) is downloaded once and cached in IndexedDB.
 *
 * Fallback:  HTTP REST API (configurable endpoint). The public maiachess.com
 *            site does not expose a CORS-friendly API, so the fallback only
 *            works if you self-host Maia or have a compatible endpoint.
 *
 * Project: https://github.com/CSSLab/maia-chess
 */

import { MaiaEngine } from './maiaOnnx';

/** Supported Maia skill levels (correspond to trained network weights). */
export const MAIA_LEVELS = [1100, 1300, 1500, 1700, 1900] as const;
export type MaiaLevel = (typeof MAIA_LEVELS)[number];

/** Default public Maia API endpoint (self-hosted only – not public CORS). */
export const DEFAULT_MAIA_API_URL = 'https://maiachess.com/api/maia_move';

type LogFn = (level: 'info' | 'warning' | 'error', message: string) => void;

/** A single move prediction from Maia. */
export interface MaiaMove {
  uci: string;
  san: string;
  /** Predicted probability (0–1) that a human at this level plays this move. */
  probability: number;
}

/**
 * Fetch move predictions from Maia Chess.
 *
 * Tries in-browser ONNX inference first.  Falls back to an HTTP API only if
 * ONNX fails (e.g. browser lacks WASM support) and a custom API URL is given.
 *
 * @param fen       - Position to query (any legal FEN)
 * @param maiaLevel - Target human skill level
 * @param logFn     - Logger callback
 * @param maxMoves  - Max moves to return
 * @param apiUrl    - Optional HTTP fallback endpoint
 */
export async function getMaiaMoves(
  fen: string,
  maiaLevel: MaiaLevel,
  logFn: LogFn,
  maxMoves: number = 5,
  apiUrl?: string,
): Promise<MaiaMove[]> {
  // --- Primary: in-browser ONNX ---
  try {
    logFn('info', `Maia ${maiaLevel}: running in-browser inference…`);
    const engine = MaiaEngine.getInstance();
    const moves = await engine.getTopMoves(fen, maiaLevel, maxMoves, logFn);
    logFn('info', `Maia ${maiaLevel}: got ${moves.length} moves via ONNX.`);
    return moves;
  } catch (onnxErr: unknown) {
    const msg = onnxErr instanceof Error ? onnxErr.message : String(onnxErr);
    logFn('warning', `Maia ONNX failed: ${msg}`);
  }

  // --- Fallback: HTTP REST API ---
  if (!apiUrl || apiUrl === DEFAULT_MAIA_API_URL) {
    logFn('warning', 'Maia: no working HTTP fallback available (maiachess.com has no public API).');
    return [];
  }

  logFn('info', `Maia ${maiaLevel}: trying HTTP fallback at ${apiUrl}…`);
  try {
    const model = `maia_kdd_${maiaLevel}`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen, model }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const data = await res.json();
    const raw: Array<{ uci: string; prob?: number; probability?: number }> =
      data.top_moves ?? data.moves ?? data.policy ?? [];

    return raw
      .map(m => ({
        uci:         m.uci,
        san:         m.uci,           // SAN unavailable from raw HTTP; caller may override
        probability: m.prob ?? m.probability ?? 0,
      }))
      .sort((a, b) => b.probability - a.probability)
      .slice(0, maxMoves);
  } catch (httpErr: unknown) {
    const msg = httpErr instanceof Error ? httpErr.message : String(httpErr);
    logFn('error', `Maia HTTP fallback also failed: ${msg}`);
    return [];
  }
}
