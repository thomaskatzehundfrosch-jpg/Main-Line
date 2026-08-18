/**
 * Core BFS tree expansion logic for auto-repertoire generation.
 * Supports Stockfish-only, Lichess-only, or combined mode.
 * BFS ensures the tree grows evenly across all branches.
 */

import { Chess } from 'chess.js';
import type {
  GeneratorNode,
  GeneratorSettings,
  GeneratorCallbacks,
  GeneratorLogEntry,
  MoveCandidate,
} from '../types/generator';
import {
  getTopMoves, uciToSan, failsEvalThreshold, isDangerousResponse,
  selectSignificantMoves, getStyleEvalThreshold, styleScore,
  computeOpponentErrorRate, applyTrickynessBonus, analyzePosition,
} from './analyzer';
import { getMaiaMoves } from '../utils/maiaApi';
import type { MaiaLevel } from '../utils/maiaApi';
import { getMostPlayedMoves, getLichessMoveCounts } from '../utils/lichessApi';

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MAX_OUR_MOVE_DROP_FROM_BEST = 0.75;

let _nodeIdCounter = 0;

function genNodeId(): string {
  return 'gen_' + (++_nodeIdCounter);
}

function resetGenNodeIdCounter(): void {
  _nodeIdCounter = 0;
}

/**
 * Apply a SAN move to a FEN and return the resulting FEN. Returns null if illegal.
 */
function makeMove(fen: string, san: string): string | null {
  try {
    const game = new Chess(fen);
    const result = game.move(san);
    if (!result) return null;
    return game.fen();
  } catch {
    return null;
  }
}

/**
 * Get the full move number from a FEN string.
 */
function getFullMoveNumber(fen: string): number {
  if (!fen) return 1;
  const parts = fen.split(' ');
  return parseInt(parts[5], 10) || 1;
}

/**
 * Create a delay promise.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a generator tree node from a move candidate.
 */
function createNode(
  candidate: MoveCandidate,
  sfEval: number | null,
  sfDepth: number,
  fullMoveNumber: number,
  fen: string,
  isOurMove: boolean,
  depth: number
): GeneratorNode {
  const node: GeneratorNode = {
    id: genNodeId(),
    san: candidate.san,
    uci: candidate.uci || '',
    fen,
    fullMoveNumber,
    isOurMove,
    depth,
    stockfish: {
      eval: sfEval,
      depth: sfDepth || 0,
    },
    lichess: null,
    isMainLine: false,
    isDangerous: false,
    cappedByMoveLimit: false,
    children: [],
  };

  // Attach Lichess stats if present
  if (candidate._lichess) {
    node.lichess = {
      totalGames: candidate._lichess.totalGames,
      winRate: candidate._lichess.winRate,
      lossRate: candidate._lichess.lossRate,
      drawRate: candidate._lichess.drawRate,
      averageRating: candidate._lichess.averageRating,
    };
  }

  return node;
}

/**
 * Deep clone a generator tree (for React state updates).
 */
function deepCloneTree(node: GeneratorNode): GeneratorNode {
  const clone: any = {};
  for (const key in node) {
    if (key === 'children') {
      clone.children = (node as any).children.map((c: GeneratorNode) => deepCloneTree(c));
    } else if (key === 'stockfish' || key === 'lichess') {
      clone[key] = (node as any)[key] ? { ...(node as any)[key] } : null;
    } else {
      clone[key] = (node as any)[key];
    }
  }
  return clone as GeneratorNode;
}

/**
 * Check whether a position is "tactical" (not quiet).
 * Tactical = side to move is in check OR captures are available.
 */
function isPositionTactical(fen: string): boolean {
  try {
    const chess = new Chess(fen);
    if (chess.isCheck()) return true;
    const moves = chess.moves({ verbose: true });
    return moves.some((m) => (m as any).captured);
  } catch {
    return false;
  }
}

/** Standard piece values in pawns. */
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function hasQueen(chess: Chess, color: 'w' | 'b'): boolean {
  return chess.board().some((rank) =>
    rank.some((piece) => piece?.type === 'q' && piece.color === color)
  );
}

function bothQueensPresent(chess: Chess): boolean {
  return hasQueen(chess, 'w') && hasQueen(chess, 'b');
}

/**
 * True when our candidate either reaches a queenless/traded-queen position or
 * gives the opponent an immediate queen-trade reply. Only meaningful while
 * both queens are still on the board before the move.
 */
function allowsImmediateQueenTrade(fromFen: string, san: string): boolean {
  try {
    const chess = new Chess(fromFen);
    if (!bothQueensPresent(chess)) return false;

    const moveResult = chess.move(san);
    if (!moveResult) return false;

    // If the move itself reaches a position without both queens, treat it as
    // queen-trade territory and prefer any sound alternative.
    if (!bothQueensPresent(chess)) return true;

    const replies = chess.moves({ verbose: true });
    for (const reply of replies) {
      const afterReply = new Chess(chess.fen());
      const replyResult = afterReply.move(reply);
      if (!replyResult) continue;
      if (!bothQueensPresent(afterReply)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Detect whether a move is a sacrifice — moving side gives away more material
 * than it captures (e.g. Nxf7 when the knight isn't recaptured cleanly).
 * Returns the number of extra moves the line should stay alive after the sac,
 * or 0 if it's a normal capture or non-capture.
 */
function sacrificeExtensionMoves(fromFen: string, san: string, baseExtension: number): number {
  try {
    const chess = new Chess(fromFen);
    const result = chess.move(san);
    if (!result || !result.captured) return 0;                  // not a capture
    const movingVal  = PIECE_VALUES[result.piece]    ?? 0;
    const capturedVal = PIECE_VALUES[result.captured] ?? 0;
    if (movingVal <= capturedVal) return 0;                     // equal or winning trade
    // Material given away — extend proportionally to how big the sacrifice is
    const deficit = movingVal - capturedVal;                    // e.g. 2 for N×P
    return baseExtension + Math.min(deficit * 2, 6);            // cap bonus at 6 extra moves
  } catch {
    return 0;
  }
}

/** DFS stack item. */
interface QueueItem {
  node: GeneratorNode;
  isOurTurn: boolean;
  depth: number;
  effectiveMaxDepth: number;
  fullMoveNumber: number;
  branchPriority: AdaptiveDepthCategory;
  /** Moves still allowed past maxMoveNumber due to a sacrifice earlier in the line. */
  sacrificeMovesLeft: number;
}

type AdaptiveDepthCategory = 'likely' | 'possible' | 'rare';

function classifyAdaptiveDepth(
  candidate: MoveCandidate,
  candidateIndex: number,
  siblingLichessGames: number
): { category: AdaptiveDepthCategory; likelihood: number | null; source: 'lichess' | 'stockfish' } {
  const games = candidate._lichess?.totalGames ?? 0;

  if (games > 0 && siblingLichessGames > 0) {
    const likelihood = games / siblingLichessGames;
    return {
      category: likelihood >= 0.4 ? 'likely' : likelihood >= 0.15 ? 'possible' : 'rare',
      likelihood,
      source: 'lichess',
    };
  }

  if (candidateIndex === 0) {
    return { category: 'likely', likelihood: null, source: 'stockfish' };
  }
  if (candidateIndex === 1) {
    return { category: 'possible', likelihood: null, source: 'stockfish' };
  }
  return { category: 'rare', likelihood: null, source: 'stockfish' };
}

function getAdaptiveOpponentResponseCount(
  baseCount: number,
  branchPriority: AdaptiveDepthCategory,
  likelyExtraResponses: number
): number {
  if (branchPriority === 'likely') {
    return Math.max(1, baseCount + Math.max(0, likelyExtraResponses));
  }
  if (branchPriority === 'rare') {
    return 1;
  }
  return Math.max(1, baseCount);
}

function addOrMergeCandidate(candidates: MoveCandidate[], next: MoveCandidate): boolean {
  const existing = candidates.find((candidate) => candidate.san === next.san);
  if (!existing) {
    candidates.push(next);
    return true;
  }

  if (!existing.uci && next.uci) existing.uci = next.uci;
  const existingSfDepth = existing._sfDepth ?? 0;
  const nextSfDepth = next._sfDepth ?? 0;
  if (
    next._sfEval !== undefined &&
    (existing._sfEval === undefined || nextSfDepth >= existingSfDepth)
  ) {
    existing._sfEval = next._sfEval;
  }
  if (existingSfDepth < nextSfDepth) existing._sfDepth = next._sfDepth;
  if (!existing._lichess && next._lichess) existing._lichess = next._lichess;
  if (!existing._maia && next._maia) existing._maia = next._maia;
  if (existing._trickynessErrorRate === undefined && next._trickynessErrorRate !== undefined) {
    existing._trickynessErrorRate = next._trickynessErrorRate;
  }
  return false;
}

function evalForColor(candidate: MoveCandidate, color: 'white' | 'black'): number | null {
  if (candidate._sfEval == null) return null;
  return color === 'white' ? candidate._sfEval : -candidate._sfEval;
}

function bestEngineMoveGap(candidates: MoveCandidate[], color: 'white' | 'black'): number | null {
  const evals = candidates
    .map((candidate) => evalForColor(candidate, color))
    .filter((value): value is number => value !== null)
    .sort((a, b) => b - a);

  if (evals.length < 2) return null;
  return evals[0] - evals[1];
}

function sortByEngineEval(candidates: MoveCandidate[], color: 'white' | 'black'): MoveCandidate[] {
  return [...candidates].sort((a, b) => {
    const evalA = evalForColor(a, color);
    const evalB = evalForColor(b, color);
    if (evalA == null && evalB == null) return 0;
    if (evalA == null) return 1;
    if (evalB == null) return -1;
    return evalB - evalA;
  });
}

function keepMovesCloseToBestEval(
  candidates: MoveCandidate[],
  color: 'white' | 'black',
  maxDrop: number
): { kept: MoveCandidate[]; rejected: { candidate: MoveCandidate; drop: number }[]; bestScore: number | null } {
  if (candidates.length <= 1) {
    return { kept: candidates, rejected: [], bestScore: null };
  }

  const scored = candidates
    .map((candidate) => ({ candidate, score: evalForColor(candidate, color) }))
    .filter((entry): entry is { candidate: MoveCandidate; score: number } => entry.score !== null);

  if (scored.length <= 1) {
    return { kept: candidates, rejected: [], bestScore: scored[0]?.score ?? null };
  }

  const bestScore = Math.max(...scored.map((entry) => entry.score));
  const rejectedSans = new Set<string>();
  const rejected: { candidate: MoveCandidate; drop: number }[] = [];

  for (const entry of scored) {
    const drop = bestScore - entry.score;
    if (drop > maxDrop) {
      rejectedSans.add(entry.candidate.san);
      rejected.push({ candidate: entry.candidate, drop });
    }
  }

  const kept = candidates.filter((candidate) => !rejectedSans.has(candidate.san));
  return { kept: kept.length > 0 ? kept : sortByEngineEval(candidates, color).slice(0, 1), rejected, bestScore };
}

function getOurMoveBranchPriority(
  parentPriority: AdaptiveDepthCategory,
  candidateIndex: number
): AdaptiveDepthCategory {
  if (candidateIndex === 0) return parentPriority;
  if (candidateIndex === 1) return parentPriority === 'rare' ? 'rare' : 'possible';
  return 'rare';
}

/**
 * Build a complete repertoire tree using Stockfish and/or Lichess.
 * Uses BFS so the tree grows evenly across all branches.
 *
 * @param seeds - Array of SAN move arrays (starting positions), or null for starting position
 * @param settings - Generation settings
 * @param callbacks - Progress/log/completion callbacks
 * @param stopRef - Set stopRef.current = true to halt generation
 * @param sfWorker - Stockfish Web Worker (optional if Lichess-only)
 */
export async function buildTree(
  seeds: string[][] | null,
  settings: GeneratorSettings,
  callbacks: GeneratorCallbacks,
  stopRef: { current: boolean },
  sfWorker: Worker | null
): Promise<GeneratorNode | null> {
  let totalNodes = 0;
  let apiCalls = 0;
  resetGenNodeIdCounter();

  const color = settings.color || 'white';
  const maxMoveNumber = settings.maxMoveNumber || 15;
  const maxDepth = maxMoveNumber * 2;
  const maxNodes = settings.maxNodes || 300;
  const analysisMode = settings.analysisMode || 'stockfish';
  const useStockfish = (
    analysisMode === 'stockfish' ||
    analysisMode === 'lichess+stockfish'
  ) && sfWorker !== null;
  const useMaia = false;
  const maiaOnly = false;
  const useLichess = analysisMode === 'lichess+stockfish';
  const lichessOnly = false;

  if (!useStockfish && !useMaia && !useLichess) {
    logError('error', 'No analysis source available. Stockfish, Maia, or Lichess required.');
    return null;
  }

  // Create root node
  const root: GeneratorNode = {
    id: 'root',
    san: null,
    uci: '',
    fen: DEFAULT_FEN,
    fullMoveNumber: 0,
    isOurMove: color === 'white',
    depth: 0,
    stockfish: { eval: null, depth: 0 },
    lichess: null,
    isMainLine: false,
    isDangerous: false,
    cappedByMoveLimit: false,
    children: [],
    isRoot: true,
  };

  function logError(level: 'info' | 'warning' | 'error', message: string, context?: string) {
    if (callbacks.onLog) {
      callbacks.onLog({
        id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
        level,
        message,
        context: context || null,
      });
    }
  }

  function updateProgress(nodes: number, status: string) {
    if (callbacks.onProgress) {
      callbacks.onProgress({ nodes, maxNodes, status, apiCalls });
    }
  }

  /**
   * Find or create the parent path in the tree for seed moves.
   */
  function ensureSeedPath(seedMoves: string[]): GeneratorNode {
    let current = root;
    let currentFen = root.fen;

    for (let i = 0; i < seedMoves.length; i++) {
      const san = seedMoves[i];
      const newFen = makeMove(currentFen, san);
      if (!newFen) break;

      let existing: GeneratorNode | null = null;
      for (const child of current.children) {
        if (child.san === san) {
          existing = child;
          break;
        }
      }

      if (!existing) {
        const fmn = getFullMoveNumber(newFen);
        const turn = newFen.split(' ')[1];
        const wasOurMove = (color === 'white' && turn === 'b') || (color === 'black' && turn === 'w');

        existing = {
          id: genNodeId(),
          san,
          uci: '',
          fen: newFen,
          fullMoveNumber: getFullMoveNumber(currentFen),
          isOurMove: wasOurMove,
          depth: i + 1,
          stockfish: { eval: null, depth: 0 },
          lichess: null,
          isMainLine: true,
          isDangerous: false,
          cappedByMoveLimit: false,
          children: [],
          isSeed: true,
        };
        current.children.push(existing);
        totalNodes++;
      }

      current = existing;
      currentFen = newFen;
    }

    return current;
  }

  /**
   * Gather move candidates for a position from Stockfish and/or Lichess.
   */
  async function gatherCandidates(
    fen: string,
    isOurTurn: boolean,
    fullMoveNumber: number,
    opponentResponseTarget?: number,
    forceStockfishOnly = false
  ): Promise<MoveCandidate[]> {
    const sfAnalysisDepth = settings.sfDepth || 12;
    const multiPvDepth = settings.candidateDepth || sfAnalysisDepth;
    const trickynessDepth = settings.trickynessDepth || sfAnalysisDepth;
    const styleValue = settings.styleValue ?? 0;
    const tw = settings.trickynessWeight ?? 0;
    const avoidQueenTrades = settings.avoidQueenTrades ?? false;

    // How many candidates we ultimately want
    const targetPV = isOurTurn
      ? (settings.maxBranchesOur || 1)
      : (opponentResponseTarget || settings.maxOpponentResponses || 2);

    // When trickyness is active, approve up to 2 extra candidates beyond
    // targetPV so the combined style+trickyness sort has a real choice to make.
    const trickExtra = (isOurTurn && tw > 0) ? Math.min(2, targetPV) : 0;
    const queenTradeExtra = (isOurTurn && avoidQueenTrades) ? 4 : 0;
    const approvalTarget = targetPV + trickExtra + queenTradeExtra;

    // Style-adjusted eval threshold (only applies to our moves)
    const effectiveThreshold = isOurTurn
      ? getStyleEvalThreshold(settings.evalThreshold ?? -0.3, styleValue)
      : (settings.evalThreshold ?? -0.3);

    const gatherAnalysisMode = forceStockfishOnly ? 'stockfish' : analysisMode;
    const gatherUseLichess = useLichess && !forceStockfishOnly;

    // For maia+stockfish / lichess+stockfish (our turn): skip the expensive upfront MultiPV.
    // Maia/Lichess suggests moves in order; SF evaluates each one lazily
    // and we stop as soon as we have enough approved candidates.
    // For all other cases, gather SF candidates upfront.
    const skipUpfrontSF = gatherAnalysisMode === 'lichess+stockfish' && isOurTurn;

    // Request extra SF PVs when style/trickyness/queen-trade avoidance needs
    // a wider candidate pool.
    const sfRequestPV = isOurTurn && (styleValue !== 0 || tw > 0 || avoidQueenTrades)
      ? Math.min(8, approvalTarget)
      : targetPV;

    const sfCandidates: MoveCandidate[] = [];
    const maiaCandidates: MoveCandidate[] = [];

    // Stockfish candidates (upfront, for non-lazy cases)
    if (useStockfish && sfWorker && (!skipUpfrontSF || isOurTurn)) {
      const SF_RETRIES = 2;
      let sfAttempt = 0;
      let sfSearchSucceeded = false;
      while (sfAttempt <= SF_RETRIES && !sfSearchSucceeded) {
        if (sfAttempt > 0) {
          logError('warning', `SF MultiPV retry ${sfAttempt}/${SF_RETRIES} at move ${fullMoveNumber}...`);
        }
        try {
          const stockfishRequestPV = skipUpfrontSF ? 1 : sfRequestPV;
          const topMoves = await getTopMoves(sfWorker, fen, multiPvDepth, stockfishRequestPV);
          sfSearchSucceeded = true;
          for (const tm of topMoves) {
            const san = uciToSan(fen, tm.uci);
            if (!san) continue;

            if (isOurTurn && failsEvalThreshold(tm.eval, color, effectiveThreshold)) {
              logError('info', `SF: Move ${san} filtered by eval: ${tm.eval !== null ? tm.eval.toFixed(2) : '?'} fails threshold ${effectiveThreshold.toFixed(2)}`);
              continue;
            }

            sfCandidates.push({
              san,
              uci: tm.uci,
              _sfEval: tm.eval,
              _sfDepth: tm.depth,
            });
          }
          if (sfCandidates.length === 0) {
            logError('info', `SF: no candidate passed filters at move ${fullMoveNumber}.`);
          }
        } catch (err: any) {
          logError('warning', `SF MultiPV attempt ${sfAttempt + 1} failed at move ${fullMoveNumber}: ${err.message}`);
        }
        sfAttempt++;
      }
      if (!sfSearchSucceeded && sfCandidates.length === 0 && sfAttempt > 1) {
        logError('warning', `SF MultiPV gave up after ${SF_RETRIES} retries at move ${fullMoveNumber} — trying single-PV recovery.`);
        try {
          const singlePv = await analyzePosition(sfWorker, fen, multiPvDepth);
          const san = uciToSan(fen, singlePv.bestMoveUci);
          const evalPawns = singlePv.score / 100;
          if (!san) {
            logError('warning', `SF single-PV recovery failed at move ${fullMoveNumber}: could not convert best move ${singlePv.bestMoveUci}.`);
          } else if (isOurTurn && failsEvalThreshold(evalPawns, color, effectiveThreshold)) {
            logError('info', `SF single-PV recovery: ${san} filtered by eval ${evalPawns.toFixed(2)} fails threshold ${effectiveThreshold.toFixed(2)}.`);
          } else {
            sfCandidates.push({
              san,
              uci: singlePv.bestMoveUci,
              _sfEval: evalPawns,
              _sfDepth: singlePv.depth,
            });
            logError('info', `SF single-PV recovery kept ${san} at depth ${singlePv.depth}.`);
          }
        } catch (err: any) {
          logError('warning', `SF single-PV recovery failed at move ${fullMoveNumber}: ${err.message}`);
        }
      }
    }

    // Maia candidates — practical human-like moves at the selected skill level
    if (useMaia) {
      try {
        // Request extra Maia candidates so the lazy SF loop has more choices to
        // approve from before falling back to SF. We ask for at least targetPV*4
        // moves to give a good chance of finding SF-approved ones early.
        const maiaRequestCount = (isOurTurn && styleValue !== 0)
            ? Math.max(sfRequestPV * 2, targetPV * 3)
            : targetPV * 2;
        const maiaMoves = await getMaiaMoves(
          fen,
          (settings.maiaLevel || 1500) as MaiaLevel,
          logError,
          maiaRequestCount,
          settings.maiaApiUrl || undefined
        );
        for (const mm of maiaMoves) {
          maiaCandidates.push({
            san: mm.san,
            uci: mm.uci,
            _maia: { probability: mm.probability },
          });
        }
      } catch (err: any) {
        logError('warning', `Maia API failed at move ${fullMoveNumber}: ${err.message}. Falling back to Stockfish.`);
      }
    }

    // Lichess Explorer candidates — popularity + win-rate ranked
    const lichessCandidates: MoveCandidate[] = [];
    if (gatherUseLichess) {
      try {
        const lichessRequestCount = isOurTurn
          ? Math.max(approvalTarget * 4, 8)
          : targetPV * 2;
        const lichessMoves = await getMostPlayedMoves(fen, settings, logError, lichessRequestCount);
        apiCalls++;
        for (const lm of lichessMoves) {
          lichessCandidates.push({
            san: lm.san,
            uci: lm.uci,
            _lichess: {
              totalGames: lm.totalGames,
              winRate: lm.winRate,
              lossRate: lm.lossRate,
              drawRate: lm.drawRate,
              averageRating: lm.averageRating,
            },
          });
        }
      } catch (err: any) {
        logError('warning', `Lichess API failed at move ${fullMoveNumber}: ${err.message}`);
      }
    }

    // Merge candidates
    let candidates: MoveCandidate[] = [];

    if (gatherAnalysisMode === 'lichess+stockfish') {
      if (isOurTurn) {
        // Lichess popularity-ranked with individual SF approval
        const usedSans = new Set<string>();

        for (const lc of lichessCandidates) {
          if (candidates.length >= approvalTarget) break;
          if (!sfWorker) break;

          // Enforce minGames threshold
          const minG = settings.minGames || 10;
          if (lc._lichess && lc._lichess.totalGames < minG) {
            logError('info', `Lichess+SF: ${lc.san} skipped — only ${lc._lichess.totalGames} games < minGames ${minG}`);
            continue;
          }

          try {
            const chess = new Chess(fen);
            const moveResult = chess.move(lc.san);
            if (!moveResult) {
              logError('info', `Lichess+SF: ${lc.san} is illegal — skipped`);
              continue;
            }
            const resultFen = chess.fen();
            const indivResult = await analyzePosition(sfWorker, resultFen, sfAnalysisDepth);
            if (indivResult.depth <= 0) {
              logError('warning', `Lichess+SF: ${lc.san} rejected — Stockfish returned no usable depth.`);
              continue;
            }
            const evalPawns = indivResult.score / 100;

            if (failsEvalThreshold(evalPawns, color, effectiveThreshold)) {
              logError('info', `Lichess+SF: ${lc.san} rejected — eval ${evalPawns.toFixed(2)} fails threshold ${effectiveThreshold.toFixed(2)}`);
              continue;
            }

            addOrMergeCandidate(candidates, {
              san: lc.san,
              uci: lc.uci,
              _sfEval: evalPawns,
              _sfDepth: indivResult.depth,
              _lichess: lc._lichess,
            });
            usedSans.add(lc.san);
          } catch (err: any) {
            logError('warning', `Lichess+SF: ${lc.san} evaluation failed: ${err.message}`);
          }
        }

        // Fallback: not enough Lichess moves approved → ask SF directly
        if (candidates.length < approvalTarget && sfWorker) {
          logError('info', `Lichess+SF: only ${candidates.length}/${approvalTarget} desired moves approved — falling back to SF`);
          const needed = approvalTarget - candidates.length;
          const SF_RETRIES = 2;
          for (let attempt = 0; attempt <= SF_RETRIES; attempt++) {
            if (attempt > 0) logError('warning', `Lichess+SF fallback MultiPV retry ${attempt}/${SF_RETRIES}...`);
            try {
              const fallbackMoves = await getTopMoves(sfWorker, fen, multiPvDepth, needed + 4);
              for (const tm of fallbackMoves) {
                if (candidates.length >= approvalTarget) break;
                const san = uciToSan(fen, tm.uci);
                if (!san || usedSans.has(san)) continue;
                if (failsEvalThreshold(tm.eval, color, effectiveThreshold)) continue;
                addOrMergeCandidate(candidates, {
                  san,
                  uci: tm.uci,
                  _sfEval: tm.eval,
                  _sfDepth: tm.depth,
                  _lichess: null,
                });
                usedSans.add(san);
              }
              break; // success — exit retry loop
            } catch (err: any) {
              logError('warning', `Lichess+SF fallback MultiPV attempt ${attempt + 1} failed: ${err.message}`);
            }
          }
        }
      } else {
        // Opponent moves: SF ordering enriched with Lichess stats
        const lichessMap: Record<string, MoveCandidate> = {};
        for (const lc of lichessCandidates) lichessMap[lc.san] = lc;

        for (const sc of sfCandidates) {
          const lMatch = lichessMap[sc.san];
          candidates.push({
            san: sc.san,
            uci: sc.uci,
            _sfEval: sc._sfEval,
            _sfDepth: sc._sfDepth,
            _lichess: lMatch ? lMatch._lichess : null,
          });
        }
        // Add popular Lichess moves not covered by SF
        const sfSans = new Set(sfCandidates.map((c) => c.san));
        for (const lc of lichessCandidates) {
          if (candidates.length >= targetPV) break;
          if (!sfSans.has(lc.san)) candidates.push(lc);
        }
      }
    } else {
      candidates = sfCandidates;
    }

    if (isOurTurn && sfCandidates.length > 0) {
      for (const sc of sfCandidates) {
        addOrMergeCandidate(candidates, sc);
      }
    }

    // Final soundness gate for every move we add for our side, regardless of
    // whether it came from Lichess, Stockfish MultiPV, or fallback discovery.
    if (isOurTurn && sfWorker && candidates.length > 0) {
      const verifiedCandidates: MoveCandidate[] = [];

      for (const candidate of candidates) {
        const resultFen = makeMove(fen, candidate.san);
        if (!resultFen) {
          logError('info', `Final SF check: ${candidate.san} is illegal — skipped`);
          continue;
        }

        try {
          const finalResult = await analyzePosition(sfWorker, resultFen, sfAnalysisDepth);
          if (finalResult.depth <= 0) {
            logError('warning', `Final SF check: ${candidate.san} rejected — Stockfish returned no usable depth.`);
            continue;
          }
          const finalEval = finalResult.score / 100;

          if (failsEvalThreshold(finalEval, color, effectiveThreshold)) {
            logError(
              'info',
              `Final SF check: ${candidate.san} rejected — eval ${finalEval.toFixed(2)} at depth ${finalResult.depth} fails threshold ${effectiveThreshold.toFixed(2)}; best reply ${finalResult.bestMoveSan || finalResult.bestMoveUci || '?'}.`
            );
            continue;
          }

          logError(
            'info',
            `Final SF check: ${candidate.san} accepted — eval ${finalEval.toFixed(2)} at depth ${finalResult.depth}; best reply ${finalResult.bestMoveSan || finalResult.bestMoveUci || '?'}.`
          );

          verifiedCandidates.push({
            ...candidate,
            _sfEval: finalEval,
            _sfDepth: finalResult.depth,
          });
        } catch (err: any) {
          logError('warning', `Final SF check: ${candidate.san} evaluation failed: ${err.message}`);
        }
      }

      candidates = verifiedCandidates;
    }

    if (isOurTurn && candidates.length > 1) {
      const { kept, rejected } = keepMovesCloseToBestEval(
        candidates,
        color,
        MAX_OUR_MOVE_DROP_FROM_BEST
      );

      if (rejected.length > 0) {
        logError(
          'info',
          `Best-move guard: rejected ${rejected.map(({ candidate, drop }) => `${candidate.san} (-${drop.toFixed(2)})`).join(', ')} because stronger verified moves exist.`
        );
      }

      candidates = kept;
    }

    // ── Avoid queen trades ──────────────────────────────────────────────────
    // At this point our candidates have already passed the eval threshold.
    // Prefer any eval-approved move that keeps queens on and does not allow an
    // immediate queen-trade reply.
    if (isOurTurn && avoidQueenTrades && candidates.length > 1) {
      const queenTradeMoves = candidates.filter((candidate) =>
        allowsImmediateQueenTrade(fen, candidate.san)
      );
      if (queenTradeMoves.length > 0 && queenTradeMoves.length < candidates.length) {
        const queenTradeSans = new Set(queenTradeMoves.map((candidate) => candidate.san));
        candidates = candidates.filter((candidate) => !queenTradeSans.has(candidate.san));
        logError(
          'info',
          `Avoid queen trades: skipped ${queenTradeMoves.map((candidate) => candidate.san).join(', ')} because eval-approved alternatives exist.`
        );
      } else if (queenTradeMoves.length === candidates.length) {
        logError(
          'info',
          'Avoid queen trades: all eval-approved moves allow a queen trade, so keeping the approved candidate pool.'
        );
      }
    }

    // ── Trickyness: opponent error rate ──────────────────────────────────────
    // For each of our move candidates, run a quick MultiPV on the resulting
    // position (opponent's turn) and compute what fraction of the engine's
    // top moves are significantly worse than the best response.  High error
    // rate → tricky for the opponent.
    if (isOurTurn && tw > 0 && sfWorker && candidates.length > 0) {
      const opponentIsBlack = color === 'white';
      for (const candidate of candidates) {
        // Skip if already computed (e.g. in a future inline path)
        if (candidate._trickynessErrorRate !== undefined) continue;
        try {
          const chessT = new Chess(fen);
          const mvT = chessT.move(candidate.san);
          if (!mvT) continue;
          const resultFen = chessT.fen();

          // SF MultiPV: get evals for the opponent's top moves
          const oppTopMoves = await getTopMoves(sfWorker, resultFen, trickynessDepth, 5);

          // Lichess counts: frequency-weight each move so a mistake 40% of
          // players make counts far more than one only 2% attempt.
          // Falls back to uniform weights (1 per move) if the call fails.
          let lichessCounts = new Map<string, number>();
          if (gatherUseLichess) {
            try {
              lichessCounts = await getLichessMoveCounts(resultFen, settings, logError);
              apiCalls++;
            } catch {
              // non-fatal — uniform weights used below
            }
          }

          const oppCandidates: MoveCandidate[] = oppTopMoves
            .filter((m) => m.eval != null)
            .map((m) => {
              const san = uciToSan(resultFen, m.uci) ?? m.uci;
              const games = lichessCounts.get(san) ?? 0;
              return {
                san,
                uci: m.uci,
                _sfEval: m.eval,
                // Only attach lichess stats when we have a real game count;
                // computeOpponentErrorRate falls back to uniform weight otherwise
                _lichess: games > 0
                  ? { totalGames: games, winRate: 0, lossRate: 0, drawRate: 0, averageRating: null }
                  : null,
              };
            });

          const errorRate = computeOpponentErrorRate(oppCandidates, opponentIsBlack);
          candidate._trickynessErrorRate = errorRate;
          if (errorRate !== null) {
            const weighted = lichessCounts.size > 0 ? ' (freq-weighted)' : ' (uniform)';
            logError(
              'info',
              `Trickyness: ${candidate.san} → opponent error rate ${(errorRate * 100).toFixed(0)}%${weighted}`
            );
          }
        } catch {
          candidate._trickynessErrorRate = null; // non-fatal — skip for this candidate
        }
      }
    }

    // ── Combined style + trickyness re-ranking ───────────────────────────────
    // Replaces the old style-only sort; no-op when both are neutral (style=0,
    // trickyness=0) or only one candidate is available.
    if (isOurTurn && (styleValue !== 0 || tw > 0) && candidates.length > 1) {
      const engineGap = bestEngineMoveGap(candidates, color);

      if (engineGap !== null && engineGap >= 1.25) {
        candidates = sortByEngineEval(candidates, color);
        logError(
          'info',
          `Engine priority: top move is ahead by ${engineGap.toFixed(1)} pawns, so style/trickyness re-ranking was skipped.`
        );
      } else {
        candidates = [...candidates].sort((a, b) => {
          const sA = applyTrickynessBonus(
            styleScore(a, styleValue, color),
            a._trickynessErrorRate ?? null,
            tw
          );
          const sB = applyTrickynessBonus(
            styleScore(b, styleValue, color),
            b._trickynessErrorRate ?? null,
            tw
          );
          return sB - sA;
        });
      }
    }

    candidates = candidates.slice(0, targetPV);
    return candidates;
  }

  // ============================================================
  // Main execution — BFS (breadth-first) expansion
  // ============================================================
  const sourceDesc = analysisMode === 'lichess+stockfish'
    ? 'Lichess Explorer + Stockfish'
    : 'Stockfish';
  logError('info', `Starting repertoire generation for ${color} using ${sourceDesc} (BFS)...`);
  updateProgress(0, 'Initializing...');

  // Build the BFS queue with starting points
  const queue: QueueItem[] = [];
  // Track which node IDs have already been enqueued to prevent the same node
  // from being expanded twice (e.g. when two seed lines share a leaf node).
  const enqueuedNodeIds = new Set<string>();

  if (seeds && seeds.length > 0) {
    for (let si = 0; si < seeds.length; si++) {
      if (stopRef.current) break;

      const seedMoves = seeds[si];
      logError('info', `Processing seed line ${si + 1}/${seeds.length} (${seedMoves.length} moves)`);

      const leafNode = ensureSeedPath(seedMoves);

      updateProgress(totalNodes, `Seed line ${si + 1}/${seeds.length} loaded`);
      if (callbacks.onNodeAdded) {
        callbacks.onNodeAdded(deepCloneTree(root));
      }

      // Don't enqueue the same leaf node twice (happens when two seeds share
      // a common endpoint, which would cause duplicate white-move generation).
      if (enqueuedNodeIds.has(leafNode.id)) {
        logError('info', `Seed ${si + 1}: leaf node already queued — skipping duplicate enqueue`);
        continue;
      }
      enqueuedNodeIds.add(leafNode.id);

      const seedFen = leafNode.fen;
      const seedTurn = seedFen.split(' ')[1];
      const seedIsOurTurn = (color === 'white' && seedTurn === 'w') || (color === 'black' && seedTurn === 'b');
      const seedFullMove = getFullMoveNumber(seedFen);
      const seedDepth = leafNode.depth || seedMoves.length;

      queue.push({
        node: leafNode,
        isOurTurn: seedIsOurTurn,
        depth: seedDepth,
        effectiveMaxDepth: maxDepth,
        fullMoveNumber: seedFullMove,
        branchPriority: 'likely',
        sacrificeMovesLeft: 0,
      });
    }
  } else {
    queue.push({
      node: root,
      isOurTurn: color === 'white',
      depth: 0,
      effectiveMaxDepth: maxDepth,
      fullMoveNumber: 1,
      branchPriority: 'likely',
      sacrificeMovesLeft: 0,
    });
  }

  // ── DFS expansion with deferred branch queue ─────────────────────────────
  // Main line (ci=0) is always prepended (DFS) so it goes to full depth first.
  // Branch alternatives (ci>0) are placed in deferredBranches, sorted by depth
  // ascending. When the DFS stack drains, the shallowest deferred branch is
  // promoted — guaranteeing early branching is always covered before deep sidelines.
  const sfAnalysisDepth = settings.sfDepth || 12;
  const tacticalExtension = settings.tacticalExtension ?? 4;
  const adaptiveBranching = settings.adaptiveBranching ?? false;
  const adaptiveLikelyExtraResponses = settings.adaptiveBranchingLikelyExtraResponses ?? 2;

  // Deferred branch items, kept sorted by depth ascending (shallowest first).
  const deferredBranches: QueueItem[] = [];

  function insertDeferred(newItem: QueueItem): void {
    // Binary-search insertion to keep array sorted by depth ascending.
    let lo = 0, hi = deferredBranches.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (deferredBranches[mid].depth <= newItem.depth) lo = mid + 1;
      else hi = mid;
    }
    deferredBranches.splice(lo, 0, newItem);
  }

  while ((queue.length > 0 || deferredBranches.length > 0) && totalNodes < maxNodes && !stopRef.current) {
    // If the DFS stack is empty, promote the shallowest deferred branch.
    if (queue.length === 0 && deferredBranches.length > 0) {
      queue.unshift(deferredBranches.shift()!);
    }
    // Stack: shift from front — items were prepended (DFS order)
    const item = queue.shift()!;

    // Check move number limit
    if (item.fullMoveNumber > maxMoveNumber) {
      // 1. Sacrifice extension: a sac happened earlier in this line — keep going
      if (item.sacrificeMovesLeft > 0) {
        logError('info', `Move ${item.fullMoveNumber}: post-sacrifice extension (${item.sacrificeMovesLeft} moves left).`);
      // 2. Tactical extension: current position has captures / is in check
      } else if (item.fullMoveNumber <= maxMoveNumber + tacticalExtension && isPositionTactical(item.node.fen)) {
        logError('info', `Move ${item.fullMoveNumber}: tactical position — extending past move limit.`);
      // 3. Hard stop
      } else {
        item.node.cappedByMoveLimit = true;
        continue;
      }
    }

    // Check depth limit
    if (item.depth >= item.effectiveMaxDepth) continue;

    const opponentResponseTarget = !item.isOurTurn && adaptiveBranching
      ? getAdaptiveOpponentResponseCount(
          settings.maxOpponentResponses || 2,
          item.branchPriority,
          adaptiveLikelyExtraResponses
        )
      : (settings.maxOpponentResponses || 2);

    if (!item.isOurTurn && adaptiveBranching && opponentResponseTarget !== (settings.maxOpponentResponses || 2)) {
      logError(
        'info',
        `Adaptive branching: ${item.branchPriority} branch → ${opponentResponseTarget} opponent response${opponentResponseTarget !== 1 ? 's' : ''}.`
      );
    }

    // Gather candidates from Stockfish / Lichess
    let candidates = await gatherCandidates(
      item.node.fen,
      item.isOurTurn,
      item.fullMoveNumber,
      opponentResponseTarget
    );

    if (candidates.length === 0 && analysisMode === 'lichess+stockfish' && useStockfish && sfWorker) {
      logError(
        'info',
        `No Lichess-qualified moves at move ${item.fullMoveNumber}; retrying this branch with Stockfish-only candidates.`
      );
      candidates = await gatherCandidates(
        item.node.fen,
        item.isOurTurn,
        item.fullMoveNumber,
        opponentResponseTarget,
        true
      );
    }

    // Smart filtering: reduce opponent responses when one move is clearly dominant
    if (!item.isOurTurn && settings.smartFiltering && useStockfish && candidates.length > 1) {
      const opponentIsBlack = color === 'white';
      const { filtered, reason } = selectSignificantMoves(
        candidates,
        opponentResponseTarget,
        opponentIsBlack
      );
      if (reason) {
        logError('info', `Move ${item.fullMoveNumber}: ${filtered.length} of ${candidates.length} responses kept — ${reason}`);
      }
      candidates = filtered;
    }

    if (candidates.length === 0) {
      logError('info', `No qualifying moves at move ${item.fullMoveNumber}. Branch ends here.`);
      continue;
    }

    // Process each candidate — collect queue items, then prepend (DFS)
    const newQueueItems: QueueItem[] = [];
    const opponentSiblingLichessGames = !item.isOurTurn && adaptiveBranching
      ? candidates.reduce((sum, candidate) => sum + Math.max(0, candidate._lichess?.totalGames ?? 0), 0)
      : 0;

    for (let ci = 0; ci < candidates.length; ci++) {
      if (stopRef.current) break;
      if (totalNodes >= maxNodes) break;

      const candidate = candidates[ci];

      // Skip if this node already has a child with this SAN (e.g. from a seed
      // line that was loaded before BFS reached this position).
      if (item.node.children.some((c) => c.san === candidate.san)) {
        logError('info', `Skipping duplicate move ${candidate.san} at move ${item.fullMoveNumber} (already present from seed/earlier expansion)`);
        continue;
      }

      const newFen = makeMove(item.node.fen, candidate.san);
      if (!newFen) {
        logError('warning', `Invalid move ${candidate.san} at FEN ${item.node.fen}. Skipping.`);
        continue;
      }

      const sfEval = candidate._sfEval !== undefined ? (candidate._sfEval ?? null) : null;
      const sfDepthUsed = sfEval !== null ? (candidate._sfDepth || sfAnalysisDepth) : 0;

      const node = createNode(
        candidate, sfEval, sfDepthUsed,
        item.fullMoveNumber, newFen, item.isOurTurn, item.depth + 1
      );

      if (ci === 0 && item.isOurTurn) {
        node.isMainLine = true;
      }

      // Flag dangerous opponent responses
      if (!item.isOurTurn && settings.flagDangerousResponses && sfEval !== null) {
        if (isDangerousResponse(sfEval, color)) {
          node.isDangerous = true;
        }
      }

      item.node.children.push(node);
      totalNodes++;

      // Fire onNewNode with a shallow copy (no children) for live board animation
      if (callbacks.onNewNode) {
        callbacks.onNewNode({ ...node, children: [] });
      }

      let statusMsg = `Move ${item.fullMoveNumber}: ${candidate.san} (node ${totalNodes}/${maxNodes})`;
      if (candidate._lichess) {
        statusMsg += ` [${candidate._lichess.totalGames} games]`;
      }
      updateProgress(totalNodes, statusMsg);

      if (callbacks.onNodeAdded) {
        callbacks.onNodeAdded(deepCloneTree(root));
      }

      const nextFenParts = newFen.split(' ');
      const nextFullMove = parseInt(nextFenParts[5], 10) || item.fullMoveNumber;

      // Depth decay for sidelines
      let childMaxDepth = item.effectiveMaxDepth;
      if (settings.depthDecay && ci > 0) {
        childMaxDepth = Math.max(item.depth + 2, item.effectiveMaxDepth - 4);
      }

      // Sacrifice detection: if this move gives away more material than it
      // captures, the resulting line gets extra moves past maxMoveNumber so
      // the compensation has room to unfold.
      const sacMoves = sacrificeExtensionMoves(item.node.fen, candidate.san, tacticalExtension);
      const childSacrificeMovesLeft = sacMoves > 0
        ? sacMoves                                    // fresh sacrifice — start countdown
        : Math.max(0, item.sacrificeMovesLeft - 1);  // carry forward existing countdown

      if (sacMoves > 0) {
        logError('info', `Sacrifice detected: ${candidate.san} at move ${item.fullMoveNumber} — line extended by ${sacMoves} moves.`);
      }

      const newItem: QueueItem = {
        node,
        isOurTurn: !item.isOurTurn,
        depth: item.depth + 1,
        effectiveMaxDepth: childMaxDepth,
        fullMoveNumber: nextFullMove,
        branchPriority: !item.isOurTurn
          ? (adaptiveBranching
              ? classifyAdaptiveDepth(candidate, ci, opponentSiblingLichessGames).category
              : item.branchPriority)
          : getOurMoveBranchPriority(item.branchPriority, ci),
        sacrificeMovesLeft: childSacrificeMovesLeft,
      };

      if (ci === 0) {
        // Main line: keep on DFS stack for immediate deep exploration.
        newQueueItems.push(newItem);
      } else {
        // Branch alternative: defer until the current DFS line completes,
        // then process shallowest-first so early branches are never skipped.
        insertDeferred(newItem);
      }

      // Short delay to keep UI responsive
      await delay(50);
    }

    // DFS: prepend main-line item so it is processed before any deferred branches.
    if (newQueueItems.length > 0) {
      queue.unshift(...newQueueItems);
    }
  }

  logError('info', `Generation complete. ${totalNodes} nodes built. ${apiCalls} Lichess API calls made.`);
  updateProgress(totalNodes, `Complete! ${totalNodes} nodes.`);

  if (callbacks.onComplete) {
    callbacks.onComplete(deepCloneTree(root));
  }

  return root;
}
