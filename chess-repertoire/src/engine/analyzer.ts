import { Chess } from 'chess.js';
import type { ImportedGame, MistakeRecord, MistakeTier } from '../types/game';
import { classifyMistake, generateMistakeId } from '../types/game';
import { logger } from '../utils/errorLogger';
import { getCloudEval } from '../utils/lichessApi';

const ENGINE_READY_TIMEOUT_MS = 15000;
const POSITION_ANALYSIS_TIMEOUT_MS = 45000;
const WORKER_BOOT_TIMEOUT_MS = 10000;

/**
 * Custom thresholds for mistake classification.
 */
export interface CustomThresholds {
  inaccuracy: number;
  mistake: number;
  blunder: number;
}

/**
 * Classify a mistake with custom thresholds.
 */
function classifyMistakeCustom(evalDrop: number, thresholds: CustomThresholds): MistakeTier | null {
  if (evalDrop >= thresholds.blunder) return 'blunder';
  if (evalDrop >= thresholds.mistake) return 'mistake';
  if (evalDrop >= thresholds.inaccuracy) return 'inaccuracy';
  return null;
}

/**
 * Represents a single position evaluation result from the engine.
 */
export interface PositionEval {
  fen: string;
  score: number; // centipawns from White's perspective
  isMate: boolean;
  mateIn: number | null;
  bestMoveUci: string;
  bestMoveSan: string;
  depth: number;
}

function firstUciFromPv(moves: string): string {
  return moves.trim().split(/\s+/)[0] ?? '';
}

function cloudScoreToCentipawns(pv: { cp?: number; mate?: number }): {
  score: number;
  isMate: boolean;
  mateIn: number | null;
} {
  if (typeof pv.mate === 'number') {
    return {
      score: pv.mate > 0 ? 10000 : -10000,
      isMate: true,
      mateIn: pv.mate,
    };
  }

  return {
    score: typeof pv.cp === 'number' ? pv.cp : 0,
    isMate: false,
    mateIn: null,
  };
}

async function analyzePositionFromCloud(fen: string): Promise<PositionEval | null> {
  const cloudEval = await getCloudEval(fen, 1);
  const pv = cloudEval?.pvs?.[0];
  if (!cloudEval || !pv) return null;

  const bestMoveUci = firstUciFromPv(pv.moves);
  if (!bestMoveUci) return null;

  const score = cloudScoreToCentipawns(pv);

  return {
    fen,
    score: score.score,
    isMate: score.isMate,
    mateIn: score.mateIn,
    bestMoveUci,
    bestMoveSan: uciToSan(fen, bestMoveUci) ?? bestMoveUci,
    depth: cloudEval.depth,
  };
}

/**
 * Callback for progress updates during analysis.
 */
export type AnalysisProgressCallback = (current: number, total: number) => void;

/**
 * Callback to check if analysis should be cancelled.
 */
export type CancellationCheck = () => boolean;

/**
 * Analyze a single position using the Stockfish worker.
 * Returns a promise that resolves when the engine sends 'bestmove'.
 *
 * Sends 'stop' + 'isready' first so that any bestmove from a previous search
 * (e.g. a timed-out MultiPV call that was never halted) is discarded before
 * we start listening for our own result.  This prevents an off-by-one cascade
 * where every call resolves with the previous position's evaluation.
 */
export function analyzePosition(
  worker: Worker,
  fen: string,
  depth: number
): Promise<PositionEval> {
  return analyzePositionFromCloud(fen).then((cloudResult) => {
    if (cloudResult && cloudResult.depth >= depth) return cloudResult;
    return analyzePositionWithStockfish(worker, fen, depth);
  });
}

export function analyzePositionWithStockfish(
  worker: Worker,
  fen: string,
  depth: number,
  signal?: AbortSignal
): Promise<PositionEval> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Generation stopped', 'AbortError')); return; }
    let bestScore = 0;
    let isMate = false;
    let mateIn: number | null = null;
    let bestMoveUci = '';
    let bestDepth = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);
      worker.removeEventListener('message', syncHandler);
      worker.removeEventListener('message', analysisHandler);
      worker.removeEventListener('error', errorHandler);
    };

    const resolveOnce = (result: PositionEval) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const abortHandler = () => {
      rejectOnce(new DOMException('Generation stopped', 'AbortError'));
      try { worker.postMessage('stop'); } catch { /* worker already closed */ }
    };

    const errorHandler = (event: ErrorEvent) => {
      rejectOnce(new Error(`Stockfish analysis worker crashed: ${event.message || 'Unknown worker error'}`));
    };

    const timeoutId = window.setTimeout(() => {
      try {
        worker.postMessage('stop');
      } catch {
        // Ignore secondary shutdown errors after a timeout.
      }
      rejectOnce(new Error(`Stockfish position analysis timed out after ${POSITION_ANALYSIS_TIMEOUT_MS}ms.`));
    }, POSITION_ANALYSIS_TIMEOUT_MS);

    // Phase 2: register the real analysis handler and kick off the search.
    const analysisHandler = (e: MessageEvent<string>) => {
      if (settled) return;
      const msg = e.data;

      if (msg.startsWith('info') && msg.includes('score') && msg.includes(' pv ')) {
        // Only process multipv 1 (best line)
        const multipvMatch = msg.match(/multipv (\d+)/);
        const mpv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
        if (mpv !== 1) return;

        const depthMatch = msg.match(/depth (\d+)/);
        const scoreMatch = msg.match(/score (cp|mate) (-?\d+)/);
        const pvMatch = msg.match(/ pv (\S+)/);

        if (depthMatch && scoreMatch) {
          const d = parseInt(depthMatch[1], 10);
          const scoreType = scoreMatch[1];
          const scoreValue = parseInt(scoreMatch[2], 10);

          if (d >= bestDepth) {
            bestDepth = d;
            if (scoreType === 'cp') {
              bestScore = scoreValue;
              isMate = false;
              mateIn = null;
            } else {
              // mate score: convert to large centipawn value
              isMate = true;
              mateIn = scoreValue;
              bestScore = scoreValue > 0 ? 10000 : -10000;
            }
            if (pvMatch) {
              bestMoveUci = pvMatch[1];
            }
          }
        }
      } else if (msg.startsWith('bestmove')) {
        const bestmoveMatch = msg.match(/^bestmove\s+(\S+)/);
        if (!bestMoveUci && bestmoveMatch && bestmoveMatch[1] !== '(none)') {
          bestMoveUci = bestmoveMatch[1];
        }

        if (bestDepth <= 0 || !bestMoveUci) {
          rejectOnce(new Error(`Stockfish returned no usable evaluation for position: ${fen}`));
          return;
        }

        // Convert best move UCI to SAN
        let bestMoveSan = bestMoveUci;
        try {
          const chess = new Chess(fen);
          const from = bestMoveUci.substring(0, 2);
          const to = bestMoveUci.substring(2, 4);
          const promotion = bestMoveUci.length > 4 ? bestMoveUci[4] : undefined;
          const move = chess.move({ from, to, promotion });
          if (move) bestMoveSan = move.san;
        } catch {
          // keep UCI if conversion fails
        }

        // Stockfish reports scores from the side-to-move's perspective.
        // Normalize to always be from White's perspective.
        const isBlackToMove = fen.split(' ')[1] === 'b';
        if (isBlackToMove) {
          bestScore = -bestScore;
          if (mateIn !== null) mateIn = -mateIn;
        }

        resolveOnce({
          fen,
          score: bestScore,
          isMate,
          mateIn,
          bestMoveUci,
          bestMoveSan,
          depth: bestDepth,
        });
      }
    };

    function startAnalysis() {
      worker.addEventListener('message', analysisHandler);
      worker.postMessage('setoption name MultiPV value 1');
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${depth}`);
    }

    // Phase 1: stop any running search, then wait for readyok before starting.
    // Any stale 'bestmove' emitted by the stop fires with no handler and is
    // simply discarded — preventing it from being captured by our real handler.
    const syncHandler = (e: MessageEvent<string>) => {
      if (settled) return;
      if (e.data === 'readyok') {
        worker.removeEventListener('message', syncHandler);
        startAnalysis();
      }
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
    worker.addEventListener('error', errorHandler);
    worker.addEventListener('message', syncHandler);
    worker.postMessage('stop');
    worker.postMessage('isready');
  });
}

/**
 * Wait for the engine to be ready.
 */
export function waitForReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', handler);
      worker.removeEventListener('error', errorHandler);
    };

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const handler = (e: MessageEvent<string>) => {
      if (e.data === 'readyok') {
        resolveOnce();
      }
    };

    const errorHandler = (event: ErrorEvent) => {
      rejectOnce(new Error(`Stockfish worker crashed while waiting for ready: ${event.message || 'Unknown worker error'}`));
    };

    const timeoutId = window.setTimeout(() => {
      rejectOnce(new Error(`Stockfish worker did not respond to isready within ${ENGINE_READY_TIMEOUT_MS}ms.`));
    }, ENGINE_READY_TIMEOUT_MS);

    worker.addEventListener('message', handler);
    worker.addEventListener('error', errorHandler);
    worker.postMessage('isready');
  });
}

/**
 * Analyze a complete game and find mistakes.
 *
 * For each position, evaluates BEFORE the move is made.
 * Then evaluates AFTER the move is made.
 * The eval drop = eval_before - eval_after (from the moving side's perspective).
 *
 * Actually, more efficiently: we evaluate each position once, and compare
 * consecutive evaluations to find drops.
 */
export async function analyzeGame(
  game: ImportedGame,
  worker: Worker,
  depth: number = 18,
  onProgress?: AnalysisProgressCallback,
  isCancelled?: CancellationCheck,
  customThresholds?: CustomThresholds,
  maxMoves?: number
): Promise<MistakeRecord[]> {
  const mistakes: MistakeRecord[] = [];
  const chess = new Chess();
  const totalMoves = game.moves.length;

  // Wait for engine readiness
  await waitForReady(worker);

  // Step 1: Evaluate the starting position
  const positions: { fen: string; moveSan: string; moveIndex: number }[] = [];

  // Collect all FENs, capped at maxMoves if provided
  const moveLimit = maxMoves && maxMoves > 0 ? Math.min(totalMoves, maxMoves) : totalMoves;
  const fens: string[] = [chess.fen()]; // starting position
  for (let i = 0; i < moveLimit; i++) {
    try {
      chess.move(game.moves[i]);
      fens.push(chess.fen());
      positions.push({
        fen: chess.fen(),
        moveSan: game.moves[i],
        moveIndex: i,
      });
    } catch {
      // Invalid move, stop here
      break;
    }
  }

  // Step 2: Evaluate each position
  const evals: number[] = []; // scores from White's perspective in centipawns

  for (let i = 0; i < fens.length; i++) {
    if (isCancelled && isCancelled()) {
      return mistakes; // return what we have so far
    }

    if (onProgress) {
      onProgress(i, fens.length);
    }

    const evalResult = await analyzePosition(worker, fens[i], depth);
    evals.push(evalResult.score);

    // Check after each position too — so a cancel mid-evaluation exits on the
    // very next opportunity (after the in-progress 'bestmove' arrives).
    if (isCancelled && isCancelled()) {
      return mistakes;
    }
  }

  // Step 3: Compare consecutive evaluations to find mistakes
  for (let i = 0; i < positions.length; i++) {
    const evalBefore = evals[i];     // eval of position BEFORE the move
    const evalAfter = evals[i + 1];  // eval of position AFTER the move

    // Determine who moved
    const side: 'white' | 'black' = i % 2 === 0 ? 'white' : 'black';

    // Compute eval drop from the moving side's perspective.
    let evalDrop: number;
    if (side === 'white') {
      evalDrop = (evalBefore - evalAfter) / 100;
    } else {
      evalDrop = (evalAfter - evalBefore) / 100;
    }

    // Only consider positive drops (actual mistakes)
    if (evalDrop <= 0) continue;

    // Use custom thresholds if provided, otherwise default
    const tier = customThresholds
      ? classifyMistakeCustom(evalDrop, customThresholds)
      : classifyMistake(evalDrop);
    if (!tier) continue;

    // Get best move for this position
    const bestEval = await analyzePosition(worker, fens[i], Math.min(depth, 14));

    const moveNumber = Math.floor(i / 2) + 1;

    mistakes.push({
      id: generateMistakeId(),
      gameId: game.id,
      moveNumber,
      fen: fens[i],
      side,
      movePlayed: game.moves[i],
      bestMove: bestEval.bestMoveSan,
      evalBefore: evalBefore / 100,
      evalAfter: evalAfter / 100,
      evalDrop,
      tier,
      reviewed: false,
    });
  }

  if (onProgress) {
    onProgress(fens.length, fens.length);
  }

  return mistakes;
}

function terminateWorkerSafely(worker: Worker): void {
  try {
    worker.postMessage('quit');
  } catch {
    // Ignore if the worker is already dead.
  }

  try {
    worker.terminate();
  } catch {
    // Ignore termination failures for already-dead workers.
  }
}

async function createRawAnalysisWorker(): Promise<Worker> {
  return new Worker('/stockfish/stockfish.js#/stockfish/stockfish.wasm');
}

function initializeAnalysisWorker(worker: Worker, numThreads: number): Promise<Worker> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let phase: 'boot' | 'configure' = 'boot';

    const cleanup = () => {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(worker);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateWorkerSafely(worker);
      reject(error);
    };

    const onError = (event: ErrorEvent) => {
      rejectOnce(new Error(`Stockfish worker failed during startup: ${event.message || 'Unknown worker error'}`));
    };

    const onMessage = (e: MessageEvent<string>) => {
      if (settled) return;

      if (phase === 'boot' && (e.data === 'uciok' || e.data === 'readyok')) {
        phase = 'configure';
        worker.postMessage(`setoption name Threads value ${numThreads}`);
        worker.postMessage('isready');
        return;
      }

      if (phase === 'configure' && e.data === 'readyok') {
        resolveOnce();
      }
    };

    const timeoutId = window.setTimeout(() => {
      rejectOnce(new Error(`Stockfish worker did not become ready within ${WORKER_BOOT_TIMEOUT_MS}ms.`));
    }, WORKER_BOOT_TIMEOUT_MS);

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage('uci');
  });
}

/**
 * Create a dedicated Stockfish worker for batch analysis.
 * This is separate from the interactive engine worker.
 *
 * Tries to load the real Stockfish WASM engine first (as a classic worker),
 * falls back to the simulation module worker if not available.
 *
 * @param threads Number of search threads (defaults to all logical cores)
 */
export async function createAnalysisWorker(threads?: number): Promise<Worker> {
  const numThreads = threads ?? Math.max(1, navigator?.hardwareConcurrency ?? 1);
  try {
    const worker = await createRawAnalysisWorker();
    return await initializeAnalysisWorker(worker, numThreads);
  } catch (err) {
    logger.warn(
      'engine',
      'Primary Stockfish analysis worker failed to start; retrying with fallback worker.',
      err instanceof Error ? err.message : String(err)
    );

    const fallbackWorker = new Worker('/stockfish/stockfish.js#/stockfish/stockfish.wasm');
    return initializeAnalysisWorker(fallbackWorker, numThreads);
  }
}

/**
 * Convert a UCI move string (e.g. "e2e4", "e7e8q") to SAN (e.g. "e4", "e8=Q")
 * using chess.js at the given FEN. Returns null if the move is illegal.
 */
export function uciToSan(fen: string, uci: string): string | null {
  if (!uci || uci.length < 4) return null;
  try {
    const chess = new Chess(fen);
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const move = chess.move({ from, to, promotion });
    if (!move) return null;
    return move.san;
  } catch {
    return null;
  }
}

/**
 * Result from getTopMoves MultiPV analysis.
 */
export interface TopMoveResult {
  uci: string;
  eval: number | null; // pawns from White's perspective
  depth: number;
}

async function getTopMovesFromCloud(fen: string, numMoves: number): Promise<TopMoveResult[] | null> {
  const cloudEval = await getCloudEval(fen, numMoves);
  if (!cloudEval || !Array.isArray(cloudEval.pvs) || cloudEval.pvs.length === 0) return null;

  const results = cloudEval.pvs
    .slice(0, numMoves)
    .map((pv) => {
      const uci = firstUciFromPv(pv.moves);
      if (!uci) return null;

      let evalScore: number | null = null;
      if (typeof pv.cp === 'number') {
        evalScore = pv.cp / 100;
      } else if (typeof pv.mate === 'number') {
        evalScore = pv.mate > 0 ? 99 : -99;
      }

      return {
        uci,
        eval: evalScore,
        depth: cloudEval.depth,
      };
    })
    .filter((result): result is TopMoveResult => result !== null);

  return results.length > 0 ? results : null;
}

/**
 * Get top N moves for a position using Stockfish MultiPV.
 * Sets MultiPV, runs analysis, collects info lines, returns sorted moves.
 * Resets MultiPV to 1 after analysis.
 */
export function getTopMoves(
  worker: Worker,
  fen: string,
  depth: number,
  numMoves: number = 3,
  timeoutMs: number = 90000
): Promise<TopMoveResult[]> {
  return getTopMovesFromCloud(fen, numMoves).then((cloudResults) => {
    if (cloudResults && cloudResults.length >= numMoves && cloudResults.every(result => result.depth >= depth)) return cloudResults;
    return getTopMovesWithStockfish(worker, fen, depth, numMoves, timeoutMs);
  });
}

export function getTopMovesWithStockfish(
  worker: Worker,
  fen: string,
  depth: number,
  numMoves: number = 3,
  timeoutMs: number = 90000,
  signal?: AbortSignal
): Promise<TopMoveResult[]> {
  if (numMoves <= 1) {
    return analyzePositionWithStockfish(worker, fen, depth, signal).then((result) => ([{
      uci: result.bestMoveUci,
      eval: result.score / 100,
      depth: result.depth,
    }]));
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Generation stopped', 'AbortError')); return; }
    let settled = false;
    let bestMoveUci = '';

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
      worker.removeEventListener('message', syncHandler);
      worker.removeEventListener('message', optionReadyHandler);
      worker.removeEventListener('message', handler);
      worker.removeEventListener('error', errorHandler);
    };

    const resolveOnce = (results: TopMoveResult[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(results);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const abortHandler = () => {
      rejectOnce(new DOMException('Generation stopped', 'AbortError'));
      try { worker.postMessage('stop'); } catch { /* worker already closed */ }
    };

    const errorHandler = (event: ErrorEvent) => {
      rejectOnce(new Error(`Stockfish MultiPV worker crashed: ${event.message || 'Unknown worker error'}`));
    };

    const timeout = setTimeout(() => {
      // Halt the engine so it is not left running after the timeout.
      // The 'bestmove' it emits in response to 'stop' fires with no handler
      // (we just removed it) and is discarded — it will not pollute the next
      // analyzePosition call, which now syncs via isready/readyok anyway.
      worker.postMessage('stop');
      worker.postMessage('setoption name MultiPV value 1');
      rejectOnce(new Error(`Stockfish MultiPV timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Map: multipv index -> { uci, eval, depth }
    const pvMap: Record<number, TopMoveResult> = {};

    function handler(e: MessageEvent<string>) {
      const msg = e.data;
      if (typeof msg !== 'string') return;

      // Parse MultiPV info lines and ordinary PV lines. Some WASM builds omit
      // "multipv 1" even after MultiPV is set, so treat bare PV lines as PV #1.
      if (msg.includes('info depth') && msg.includes(' pv ')) {
        const depthMatch = msg.match(/info depth (\d+)/);
        const pvIdxMatch = msg.match(/multipv (\d+)/);
        const pvMoveMatch = msg.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
        const cpMatch = msg.match(/score cp (-?\d+)/);
        const mateMatch = msg.match(/score mate (-?\d+)/);

        if (pvMoveMatch) {
          const pvIdx = pvIdxMatch ? parseInt(pvIdxMatch[1], 10) : 1;
          if (pvIdx > numMoves) return;
          const uci = pvMoveMatch[1];
          if (pvIdx === 1) bestMoveUci = uci;
          let evalScore: number | null = null;

          if (cpMatch) {
            evalScore = parseInt(cpMatch[1], 10) / 100;
          } else if (mateMatch) {
            evalScore = parseInt(mateMatch[1], 10) > 0 ? 99 : -99;
          }

          const d = depthMatch ? parseInt(depthMatch[1], 10) : 0;
          pvMap[pvIdx] = { uci, eval: evalScore, depth: d };
        }
      }

      if (msg.startsWith('bestmove')) {
        const bestmoveMatch = msg.match(/^bestmove\s+(\S+)/);
        if (!bestMoveUci && bestmoveMatch && bestmoveMatch[1] !== '(none)') {
          bestMoveUci = bestmoveMatch[1];
        }

        // Collect results sorted by multipv index (1 = best)
        const results: TopMoveResult[] = [];
        for (let i = 1; i <= numMoves; i++) {
          if (pvMap[i]) results.push(pvMap[i]);
        }
        if (results.length === 0) {
          rejectOnce(new Error(`Stockfish MultiPV returned no usable PV lines for position: ${fen}`));
          return;
        }

        // Normalize evals to White's perspective
        const isBlackToMove = fen.split(' ')[1] === 'b';
        if (isBlackToMove) {
          for (const r of results) {
            if (r.eval !== null) r.eval = -r.eval;
          }
        }

        // Reset MultiPV back to 1 for future single-PV analysis
        worker.postMessage('setoption name MultiPV value 1');

        resolveOnce(results);
      }
    }

    function startAnalysis() {
      worker.addEventListener('message', handler);
      worker.postMessage(`setoption name MultiPV value ${numMoves}`);
      worker.addEventListener('message', optionReadyHandler);
      worker.postMessage('isready');
    }

    function optionReadyHandler(e: MessageEvent<string>) {
      if (settled) return;
      if (e.data === 'readyok') {
        worker.removeEventListener('message', optionReadyHandler);
        worker.postMessage('ucinewgame');
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage(`go depth ${depth}`);
      }
    }

    const syncHandler = (e: MessageEvent<string>) => {
      if (settled) return;
      if (e.data === 'readyok') {
        worker.removeEventListener('message', syncHandler);
        startAnalysis();
      }
    };

    signal?.addEventListener('abort', abortHandler, { once: true });
    worker.addEventListener('error', errorHandler);
    worker.addEventListener('message', syncHandler);
    worker.postMessage('stop');
    worker.postMessage('isready');
  });
}
