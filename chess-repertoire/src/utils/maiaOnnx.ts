/**
 * Maia Chess v2 – in-browser ONNX inference engine.
 *
 * Maia v2 is an ELO-conditioned neural network trained on human chess games.
 * A single model file (`maia_rapid.onnx`, ~50 MB) covers all skill levels.
 * The model accepts `boards` (18-plane board tensor), `elo_self`, and
 * `elo_oppo` as inputs, and returns a policy over 1 880 possible moves.
 *
 * Architecture:
 *   Input:  boards [1, 18, 8, 8], elo_self [1] (int64), elo_oppo [1] (int64)
 *   Output: logits_maia [1, 1880]  (raw policy logits)
 *
 * References:
 *   https://github.com/CSSLab/maia-platform-frontend
 *   https://github.com/CSSLab/maia-chess
 *
 * onnxruntime-web is loaded lazily from CDN at first use so the ~2 MB WASM
 * bundle and ~50 MB model are not downloaded until Maia mode is selected.
 */

import { Chess } from 'chess.js';
import maiaMovesList from './maiaMoves.json';

// ---------------------------------------------------------------------------
// Move index tables (generated once at module load)
// ---------------------------------------------------------------------------

/** index → UCI move (from White's perspective after possible board-mirror) */
const ALL_MOVES_REVERSED: string[] = maiaMovesList as string[];

/** UCI move → policy index */
const ALL_MOVES: Record<string, number> = {};
ALL_MOVES_REVERSED.forEach((m, i) => { ALL_MOVES[m] = i; });

const POLICY_SIZE = 1880;

// ---------------------------------------------------------------------------
// Board encoding helpers (ported from CSSLab tensor.ts)
// ---------------------------------------------------------------------------

const PIECE_ORDER = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'] as const;

/** Flip a rank string char: '1'↔'8', '2'↔'7', etc. */
function flipRank(r: string): string {
  return String(9 - parseInt(r));
}

/** Mirror a square name for the opponent's perspective (flip rank). */
function mirrorSquare(sq: string): string {
  return sq[0] + flipRank(sq[1]);
}

/** Mirror a UCI move string (flip ranks of from- and to-squares). */
export function mirrorMove(uci: string): string {
  if (uci.length < 4) return uci;
  const from = mirrorSquare(uci.substring(0, 2));
  const to   = mirrorSquare(uci.substring(2, 4));
  const promo = uci.length > 4 ? uci[4] : '';
  return from + to + promo;
}

/**
 * Mirror a FEN so that Black becomes the side to move and the board is
 * shown from White's perspective.  Exactly matches CSSLab mirrorFEN().
 *
 * Steps:
 *  1. Reverse the rank order (rank 8 ↔ rank 1).
 *  2. Swap piece colours (uppercase ↔ lowercase).
 *  3. Swap the active-colour field (w ↔ b).
 *  4. Swap castling characters (K↔k, Q↔q).
 *  5. Mirror the en-passant square rank if present.
 */
export function mirrorFEN(fen: string): string {
  const parts = fen.split(' ');
  if (parts.length < 6) return fen;

  // 1. Reverse ranks
  const ranks = parts[0].split('/').reverse();

  // 2. Swap piece colours in each rank
  const swappedRanks = ranks.map(rank =>
    rank.split('').map(c => {
      if (c >= 'A' && c <= 'Z') return c.toLowerCase();
      if (c >= 'a' && c <= 'z') return c.toUpperCase();
      return c;
    }).join('')
  );

  parts[0] = swappedRanks.join('/');

  // 3. Active colour
  parts[1] = parts[1] === 'w' ? 'b' : 'w';

  // 4. Castling
  parts[2] = parts[2] === '-' ? '-' : parts[2]
    .split('')
    .map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())
    .join('');

  // 5. En-passant
  if (parts[3] !== '-') {
    parts[3] = parts[3][0] + flipRank(parts[3][1]);
  }

  return parts.join(' ');
}

/**
 * Encode a FEN position as an 18-plane Float32Array of shape [18, 8, 8].
 * The board is ALWAYS from White's perspective (caller must mirror if needed).
 *
 * Planes:
 *   0-11  : piece presence (P, N, B, R, Q, K, p, n, b, r, q, k) – White = upper
 *   12    : side to move (1.0 = White)
 *   13-16 : castling rights (K, Q, k, q)
 *   17    : en-passant target square
 */
function boardToTensor(fen: string): Float32Array {
  const chess = new Chess(fen);
  const board = chess.board(); // [rank][file], rank 0 = rank 8 (a8 corner)
  const tensor = new Float32Array(18 * 8 * 8);

  // Planes 0-11: piece locations
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = board[rank][file];
      if (piece) {
        const symbol = piece.color === 'w' ? piece.type.toUpperCase() : piece.type.toLowerCase();
        const planeIdx = PIECE_ORDER.indexOf(symbol as typeof PIECE_ORDER[number]);
        if (planeIdx >= 0) {
          // chess.js board: rank 0 = rank 8; we want rank 0 = rank 1 for our tensor
          const tensorRank = 7 - rank;
          tensor[planeIdx * 64 + tensorRank * 8 + file] = 1.0;
        }
      }
    }
  }

  const fenParts = fen.split(' ');

  // Plane 12: side to move
  if (fenParts[1] === 'w') {
    for (let i = 0; i < 64; i++) tensor[12 * 64 + i] = 1.0;
  }

  // Planes 13-16: castling rights
  const castling = fenParts[2] || '-';
  const castlingFlags = ['K', 'Q', 'k', 'q'];
  castlingFlags.forEach((flag, idx) => {
    if (castling.includes(flag)) {
      for (let i = 0; i < 64; i++) tensor[(13 + idx) * 64 + i] = 1.0;
    }
  });

  // Plane 17: en-passant square
  const ep = fenParts[3];
  if (ep && ep !== '-') {
    const epFile = ep.charCodeAt(0) - 97; // 'a'=0
    const epRank = parseInt(ep[1]) - 1;    // rank 1=0
    tensor[17 * 64 + epRank * 8 + epFile] = 1.0;
  }

  return tensor;
}

/**
 * Map an ELO rating to an integer category (0–10) used by Maia v2.
 * Matches CSSLab's mapToCategory() with their eloDict.
 */
function eloToCategory(elo: number): number {
  if (elo < 1100) return 0;
  if (elo < 1200) return 1;
  if (elo < 1300) return 2;
  if (elo < 1400) return 3;
  if (elo < 1500) return 4;
  if (elo < 1600) return 5;
  if (elo < 1700) return 6;
  if (elo < 1800) return 7;
  if (elo < 1900) return 8;
  if (elo < 2000) return 9;
  return 10;
}

// ---------------------------------------------------------------------------
// Softmax over a subset of logits
// ---------------------------------------------------------------------------

function softmaxSubset(logits: Float32Array, indices: number[]): Float32Array {
  const vals = indices.map(i => logits[i]);
  const maxVal = Math.max(...vals);
  const exps = vals.map(v => Math.exp(v - maxVal));
  const sum = exps.reduce((a, b) => a + b, 0);
  const result = new Float32Array(indices.length);
  exps.forEach((e, i) => { result[i] = e / sum; });
  return result;
}

// ---------------------------------------------------------------------------
// IndexedDB model cache
// ---------------------------------------------------------------------------

const IDB_DB_NAME  = 'maia-model-cache';
const IDB_STORE    = 'models';
const IDB_KEY      = 'maia_rapid';
const MODEL_URL    =
  'https://raw.githubusercontent.com/CSSLab/maia-platform-frontend/e23a50e/public/maia2/maia_rapid.onnx';

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function getCachedModel(): Promise<ArrayBuffer | null> {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result as ArrayBuffer ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function cacheModel(buffer: ArrayBuffer): Promise<void> {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(buffer, IDB_KEY);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  } catch {
    // cache failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// onnxruntime-web dynamic loader (script-tag approach, no npm install)
// ---------------------------------------------------------------------------

// We inject a <script> tag pointing to the UMD bundle so ort is available
// as window.ort. This sidesteps ESM module-namespace differences across CDN
// builds and requires no bundler configuration.
const ORT_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js';
const ORT_WASM_BASE  = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ort: any = null;
let _ortLoadPromise: Promise<any> | null = null;

function getOrt(): Promise<any> {
  if (_ort) return Promise.resolve(_ort);
  if (_ortLoadPromise) return _ortLoadPromise;

  _ortLoadPromise = new Promise<any>((resolve, reject) => {
    // Already present (e.g. script tag in index.html or prior inject)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).ort) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _ort = (window as any).ort;
      _ort.env.wasm.wasmPaths = ORT_WASM_BASE;
      return resolve(_ort);
    }

    const script = document.createElement('script');
    script.src = ORT_SCRIPT_URL;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _ort = (window as any).ort;
      if (!_ort) {
        return reject(new Error('onnxruntime-web script loaded but window.ort is undefined'));
      }
      _ort.env.wasm.wasmPaths = ORT_WASM_BASE;
      resolve(_ort);
    };
    script.onerror = () =>
      reject(new Error('Failed to load onnxruntime-web from CDN'));
    document.head.appendChild(script);
  });

  return _ortLoadPromise;
}

// ---------------------------------------------------------------------------
// MaiaEngine singleton
// ---------------------------------------------------------------------------

export interface MaiaTopMove {
  uci: string;
  san: string;
  probability: number;
}

type LogFn = (level: 'info' | 'warning' | 'error', message: string) => void;

const NOOP_LOG: LogFn = () => {};

export class MaiaEngine {
  private static _instance: MaiaEngine | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _session: any = null;
  private _loading  = false;
  private _loadPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): MaiaEngine {
    if (!MaiaEngine._instance) MaiaEngine._instance = new MaiaEngine();
    return MaiaEngine._instance;
  }

  /** Ensure the ONNX model is loaded (downloads + caches on first call). */
  async ensureLoaded(log: LogFn = NOOP_LOG): Promise<void> {
    if (this._session) return;
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = (async () => {
      try {
        log('info', 'Maia: loading onnxruntime-web from CDN…');
        const ort = await getOrt();

        let modelBuffer = await getCachedModel();

        if (modelBuffer) {
          log('info', 'Maia: model loaded from IndexedDB cache.');
        } else {
          log('info', 'Maia: downloading model (~50 MB, first use only)…');
          const resp = await fetch(MODEL_URL);
          if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching Maia model`);
          modelBuffer = await resp.arrayBuffer();
          await cacheModel(modelBuffer);
          log('info', 'Maia: model downloaded and cached.');
        }

        this._session = await ort.InferenceSession.create(modelBuffer, {
          executionProviders: ['wasm'],
        });
        log('info', 'Maia: inference session ready.');
      } catch (err: unknown) {
        this._loadPromise = null;
        throw err;
      }
    })();

    return this._loadPromise;
  }

  /**
   * Return the top `n` moves predicted by Maia for the given FEN.
   *
   * @param fen         Position to evaluate.
   * @param maiaLevel   Target human ELO (used as both elo_self and elo_oppo).
   * @param n           Maximum number of moves to return.
   * @param log         Logger callback.
   */
  async getTopMoves(
    fen: string,
    maiaLevel: number,
    n = 5,
    log: LogFn = NOOP_LOG,
  ): Promise<MaiaTopMove[]> {
    await this.ensureLoaded(log);

    const ort = await getOrt();
    const chess = new Chess(fen);
    const sideToMove = chess.turn(); // 'w' or 'b'

    // Always encode from White's perspective
    const workingFen = sideToMove === 'b' ? mirrorFEN(fen) : fen;
    const boardData  = boardToTensor(workingFen);

    // ELO category
    const eloCategory = BigInt(eloToCategory(maiaLevel));

    // Build input tensors
    const boardTensor = new ort.Tensor('float32', boardData, [1, 18, 8, 8]);
    const eloSelf     = new ort.Tensor('int64', [eloCategory], [1]);
    const eloOppo     = new ort.Tensor('int64', [eloCategory], [1]);

    const feeds = {
      boards:    boardTensor,
      elo_self:  eloSelf,
      elo_oppo:  eloOppo,
    };

    const results = await this._session.run(feeds);
    const logits: Float32Array = results['logits_maia'].data as Float32Array;

    // Get legal moves and map to policy indices
    const legalMoves = chess.moves({ verbose: true });
    const legalIndices: number[] = [];
    const legalUciWhitePerspective: string[] = [];

    for (const m of legalMoves) {
      const uci = m.from + m.to + (m.promotion ?? '');
      // If Black to move, mirror the UCI for index lookup (policy is White POV)
      const lookupUci = sideToMove === 'b' ? mirrorMove(uci) : uci;
      const idx = ALL_MOVES[lookupUci];
      if (idx !== undefined) {
        legalIndices.push(idx);
        legalUciWhitePerspective.push(uci);   // original FEN UCI
      }
    }

    if (legalIndices.length === 0) return [];

    // Softmax over legal move logits only
    const probs = softmaxSubset(logits, legalIndices);

    // Build result array sorted by probability descending
    const combined = legalIndices.map((_, i) => ({
      uci:         legalUciWhitePerspective[i],
      probability: probs[i],
    }));
    combined.sort((a, b) => b.probability - a.probability);

    // Convert UCI to SAN (using original FEN) and return top n
    const topMoves: MaiaTopMove[] = [];
    for (const { uci, probability } of combined.slice(0, n)) {
      try {
        const tempChess = new Chess(fen);
        const moveResult = tempChess.move({
          from: uci.substring(0, 2),
          to:   uci.substring(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
        if (moveResult) {
          topMoves.push({ uci, san: moveResult.san, probability });
        }
      } catch {
        // skip invalid move
      }
    }

    return topMoves;
  }
}
