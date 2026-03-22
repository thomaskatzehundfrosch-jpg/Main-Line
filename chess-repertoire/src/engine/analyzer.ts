import { Chess } from 'chess.js';
import type { ImportedGame, MistakeRecord, MistakeTier } from '../types/game';
import { classifyMistake, generateMistakeId } from '../types/game';
import type { MoveCandidate, RepertoireStyle } from '../types/generator';

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
  return new Promise((resolve) => {
    let bestScore = 0;
    let isMate = false;
    let mateIn: number | null = null;
    let bestMoveUci = '';
    let bestDepth = 0;

    // Phase 2: register the real analysis handler and kick off the search.
    function startAnalysis() {
      const handler = (e: MessageEvent<string>) => {
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
          worker.removeEventListener('message', handler);

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

          resolve({
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

      worker.addEventListener('message', handler);
      worker.postMessage('setoption name MultiPV value 1');
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${depth}`);
    }

    // Phase 1: stop any running search, then wait for readyok before starting.
    // Any stale 'bestmove' emitted by the stop fires with no handler and is
    // simply discarded — preventing it from being captured by our real handler.
    const syncHandler = (e: MessageEvent<string>) => {
      if (e.data === 'readyok') {
        worker.removeEventListener('message', syncHandler);
        startAnalysis();
      }
    };
    worker.addEventListener('message', syncHandler);
    worker.postMessage('stop');
    worker.postMessage('isready');
  });
}

/**
 * Wait for the engine to be ready.
 */
export function waitForReady(worker: Worker): Promise<void> {
  return new Promise((resolve) => {
    const handler = (e: MessageEvent<string>) => {
      if (e.data === 'readyok') {
        worker.removeEventListener('message', handler);
        resolve();
      }
    };
    worker.addEventListener('message', handler);
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
  customThresholds?: CustomThresholds
): Promise<MistakeRecord[]> {
  const mistakes: MistakeRecord[] = [];
  const chess = new Chess();
  const totalMoves = game.moves.length;

  // Wait for engine readiness
  await waitForReady(worker);

  // Step 1: Evaluate the starting position
  const positions: { fen: string; moveSan: string; moveIndex: number }[] = [];

  // Collect all FENs
  const fens: string[] = [chess.fen()]; // starting position
  for (let i = 0; i < totalMoves; i++) {
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

/**
 * Create a dedicated Stockfish worker for batch analysis.
 * This is separate from the interactive engine worker.
 *
 * Tries to load the real Stockfish WASM engine first (as a classic worker),
 * falls back to the simulation module worker if not available.
 *
 * @param threads Number of search threads (defaults to half of logical cores)
 */
export async function createAnalysisWorker(threads?: number): Promise<Worker> {
  let worker: Worker;

  // Try loading the real Stockfish engine directly as a classic worker
  try {
    const res = await fetch('/stockfish/stockfish.js', { method: 'HEAD' });
    if (res.ok) {
      worker = new Worker('/stockfish/stockfish.js');
    } else {
      worker = new Worker(
        new URL('../workers/stockfish.worker.ts', import.meta.url),
        { type: 'module' }
      );
    }
  } catch {
    worker = new Worker(
      new URL('../workers/stockfish.worker.ts', import.meta.url),
      { type: 'module' }
    );
  }

  const numThreads = threads ?? Math.max(1, Math.floor((navigator?.hardwareConcurrency ?? 2) / 2));

  // Wait for the worker to be ready, then configure threads
  return new Promise((resolve) => {
    let resolved = false;

    const handler = (e: MessageEvent<string>) => {
      if (e.data === 'uciok' || e.data === 'readyok') {
        if (!resolved) {
          resolved = true;
          worker.postMessage(`setoption name Threads value ${numThreads}`);
          worker.postMessage('isready');
          const readyHandler = (e2: MessageEvent<string>) => {
            if (e2.data === 'readyok') {
              worker.removeEventListener('message', readyHandler);
              resolve(worker);
            }
          };
          worker.addEventListener('message', readyHandler);
        }
      }
    };

    worker.addEventListener('message', handler);
    worker.postMessage('uci');

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(worker);
      }
    }, 10000);
  });
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
  timeoutMs: number = 30000
): Promise<TopMoveResult[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', handler);
      // Halt the engine so it is not left running after the timeout.
      // The 'bestmove' it emits in response to 'stop' fires with no handler
      // (we just removed it) and is discarded — it will not pollute the next
      // analyzePosition call, which now syncs via isready/readyok anyway.
      worker.postMessage('stop');
      reject(new Error(`Stockfish MultiPV timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Map: multipv index -> { uci, eval, depth }
    const pvMap: Record<number, TopMoveResult> = {};

    function handler(e: MessageEvent<string>) {
      const msg = e.data;
      if (typeof msg !== 'string') return;

      // Parse info lines with multipv
      if (msg.includes('info depth') && msg.includes('multipv')) {
        const depthMatch = msg.match(/info depth (\d+)/);
        const pvIdxMatch = msg.match(/multipv (\d+)/);
        const pvMoveMatch = msg.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
        const cpMatch = msg.match(/score cp (-?\d+)/);
        const mateMatch = msg.match(/score mate (-?\d+)/);

        if (pvIdxMatch && pvMoveMatch) {
          const pvIdx = parseInt(pvIdxMatch[1], 10);
          const uci = pvMoveMatch[1];
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
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);

        // Collect results sorted by multipv index (1 = best)
        const results: TopMoveResult[] = [];
        for (let i = 1; i <= numMoves; i++) {
          if (pvMap[i]) results.push(pvMap[i]);
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

        resolve(results);
      }
    }

    worker.addEventListener('message', handler);
    worker.postMessage(`setoption name MultiPV value ${numMoves}`);
    worker.postMessage('ucinewgame');
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${depth}`);
  });
}

/**
 * Check if an eval fails the threshold for a given side.
 * Eval is from White's perspective.
 */
export function failsEvalThreshold(evalScore: number | null, color: string, threshold: number): boolean {
  if (evalScore === null || evalScore === undefined) return false;
  if (color === 'white') {
    return evalScore < threshold;
  } else {
    return evalScore > -threshold;
  }
}

/**
 * Check if an opponent response is dangerous.
 * Eval is from White's perspective.
 */
export function isDangerousResponse(evalScore: number | null, color: string): boolean {
  if (evalScore === null || evalScore === undefined) return false;
  if (color === 'white') {
    return evalScore < -0.8;
  } else {
    return evalScore > 0.8;
  }
}

/**
 * Configurable thresholds for smart filtering of opponent responses.
 * All values are in pawns.
 */
export const SMART_FILTER_THRESHOLDS = {
  /** Eval gap between #1 and #2 to treat position as "only move" */
  onlyMoveGap: 1.5,
  /** Eval gap between #N and #N+1 to cut off remaining weaker moves */
  significantGap: 1.0,
};

/**
 * Filter opponent move candidates by eval gap significance.
 *
 * When one move is vastly superior to the rest, there's no point including
 * weak alternatives in the repertoire tree. This function trims the list:
 *
 * - If #1 is a forced mate and #2 is not → only move
 * - If gap(#1, #2) >= onlyMoveGap → return only #1
 * - If gap(#2, #3) >= significantGap → return #1 and #2
 * - Otherwise return up to maxCount
 *
 * Candidates must include _sfEval (White's perspective) for filtering to work.
 * If evals are missing, returns candidates unfiltered up to maxCount.
 *
 * @param candidates - Array of move candidates (should be pre-sorted best-first
 *                     from getTopMoves / gatherCandidates)
 * @param maxCount   - User's requested max opponent responses
 * @param opponentIsBlack - True when opponent is Black (we play White)
 * @returns Filtered candidate array (length ≤ maxCount)
 */
export function selectSignificantMoves(
  candidates: MoveCandidate[],
  maxCount: number,
  opponentIsBlack: boolean
): { filtered: MoveCandidate[]; reason: string | null } {
  if (candidates.length <= 1 || maxCount <= 1) {
    return { filtered: candidates.slice(0, maxCount), reason: null };
  }

  // Separate candidates with and without SF evals
  const withEval = candidates.filter((c) => c._sfEval != null);
  const withoutEval = candidates.filter((c) => c._sfEval == null);

  if (withEval.length <= 1) {
    // Can't compute gaps without at least 2 evals
    return { filtered: candidates.slice(0, maxCount), reason: null };
  }

  // Sort by eval quality for the opponent.
  // Opponent's best move = lowest eval (White's perspective) if Black,
  //                        highest eval if White.
  const sorted = [...withEval].sort((a, b) => {
    const ea = a._sfEval!;
    const eb = b._sfEval!;
    return opponentIsBlack ? ea - eb : eb - ea;
  });

  // Helper: detect mate-level scores (±99 from getTopMoves encoding)
  const isMateScore = (e: number) => Math.abs(e) >= 90;

  // Check: mate vs non-mate → only move
  if (isMateScore(sorted[0]._sfEval!) && !isMateScore(sorted[1]._sfEval!)) {
    return { filtered: [sorted[0]], reason: 'only move (mate)' };
  }

  // Check gap between #1 and #2
  const gap12 = Math.abs(sorted[0]._sfEval! - sorted[1]._sfEval!);
  if (gap12 >= SMART_FILTER_THRESHOLDS.onlyMoveGap) {
    return {
      filtered: [sorted[0]],
      reason: `only move (gap ${gap12.toFixed(1)} pawns)`,
    };
  }

  // Check gap between #2 and #3 (if 3+ candidates available and user wants 3+)
  if (sorted.length >= 3 && maxCount >= 3) {
    const gap23 = Math.abs(sorted[1]._sfEval! - sorted[2]._sfEval!);
    if (gap23 >= SMART_FILTER_THRESHOLDS.significantGap) {
      return {
        filtered: sorted.slice(0, 2),
        reason: `2 of ${sorted.length} kept (gap ${gap23.toFixed(1)} pawns after #2)`,
      };
    }
  }

  // No significant gaps — return all candidates up to maxCount
  const merged = [...sorted, ...withoutEval];
  return { filtered: merged.slice(0, maxCount), reason: null };
}

// ============================================================
// Repertoire Style: scoring and re-ranking
// ============================================================

/**
 * Configurable weights for style-based candidate scoring.
 * Tweak these to adjust how strongly each style biases move selection.
 */
export const STYLE_WEIGHTS = {
  aggressive: {
    /** Eval threshold relaxed by this many pawns (more permissive). */
    evalThresholdAdjust: -0.3,
    /** Bonus per 1 % point of win rate (our perspective). */
    winRateBonus: 0.01,
    /** Penalty per 1 % point of draw rate. */
    drawRatePenalty: 0.006,
  },
  solid: {
    /** Eval threshold tightened by this many pawns (more strict). */
    evalThresholdAdjust: 0.15,
    /** Penalty per 1 % point of loss rate. */
    lossRatePenalty: 0.015,
    /** Bonus per 1 % point of (winRate + drawRate) — safe outcomes. */
    safeOutcomeBonus: 0.003,
  },
} as const;

/**
 * Return the effective eval threshold after adjusting for repertoire style.
 *
 * styleValue is a continuous integer on −2 … +2:
 *   negative = aggressive (relaxes threshold, lets more speculative moves through)
 *   zero     = balanced   (no adjustment)
 *   positive = solid      (tightens threshold, rejects dubious moves)
 *
 * The adjustment scales linearly:
 *   ±1 maps to the original single-step aggressive/solid adjustments
 *   ±2 doubles the effect.
 */
export function getStyleEvalThreshold(
  baseThreshold: number,
  styleValue: number
): number {
  if (styleValue < 0) {
    // Aggressive: scale from 0 to full aggressive adjustment at −2
    return baseThreshold + (styleValue / 2) * STYLE_WEIGHTS.aggressive.evalThresholdAdjust;
  }
  if (styleValue > 0) {
    // Solid: scale from 0 to full solid adjustment at +2
    return baseThreshold + (styleValue / 2) * STYLE_WEIGHTS.solid.evalThresholdAdjust;
  }
  return baseThreshold;
}

/**
 * Compute a composite score that blends engine eval with style preferences.
 * Used to re-rank **our** move candidates so the top pick matches the style.
 *
 * styleValue is a continuous integer on −2 … +2.
 * The Lichess-based bonus/penalty weights scale linearly with |styleValue|/2
 * so that ±2 applies the full original weight and ±1 applies half of it.
 *
 * Lichess rates are already from our color's perspective (see lichessApi.ts).
 */
export function styleScore(
  candidate: MoveCandidate,
  styleValue: number,
  color: 'white' | 'black'
): number {
  // Base: engine eval, normalised so positive = good for us
  let score = candidate._sfEval ?? 0;
  if (color === 'black') score = -score;

  const stats = candidate._lichess;
  if (!stats || styleValue === 0) return score;

  const { winRate, drawRate, lossRate } = stats;

  if (styleValue < 0) {
    // Aggressive side: blend weight 0→1 as styleValue goes 0→−2
    const t = Math.abs(styleValue) / 2;
    const w = STYLE_WEIGHTS.aggressive;
    score += winRate  * t * w.winRateBonus;
    score -= drawRate * t * w.drawRatePenalty;
  } else {
    // Solid side: blend weight 0→1 as styleValue goes 0→+2
    const t = styleValue / 2;
    const w = STYLE_WEIGHTS.solid;
    score -= lossRate            * t * w.lossRatePenalty;
    score += (winRate + drawRate) * t * w.safeOutcomeBonus;
  }

  return score;
}

/**
 * Re-rank move candidates by style preference.
 * Returns a new array sorted best-first according to the style score.
 * No-op when styleValue is 0 (balanced) or only one candidate.
 */
export function reRankByStyle(
  candidates: MoveCandidate[],
  styleValue: number,
  color: 'white' | 'black'
): MoveCandidate[] {
  if (styleValue === 0 || candidates.length <= 1) return candidates;
  return [...candidates].sort(
    (a, b) => styleScore(b, styleValue, color) - styleScore(a, styleValue, color)
  );
}
