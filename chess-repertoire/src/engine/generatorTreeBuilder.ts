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

/** BFS queue item. */
interface QueueItem {
  node: GeneratorNode;
  isOurTurn: boolean;
  depth: number;
  effectiveMaxDepth: number;
  fullMoveNumber: number;
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
    fullMoveNumber: number
  ): Promise<MoveCandidate[]> {
    const sfAnalysisDepth = settings.sfDepth || 12;
    // MultiPV analysis is much slower than single-PV: cap at depth 15 so we
    // never time out at complex middlegame positions.  Single-PV evaluations
    // (analyzePosition calls below) still use the full sfAnalysisDepth.
    const multiPvDepth = Math.min(sfAnalysisDepth, 15);
    const styleValue = settings.styleValue ?? 0;
    const tw = settings.trickynessWeight ?? 0;

    // How many candidates we ultimately want
    const targetPV = isOurTurn
      ? (settings.maxBranchesOur || 1)
      : (settings.maxOpponentResponses || 2);

    // When trickyness is active, approve up to 2 extra candidates beyond
    // targetPV so the combined style+trickyness sort has a real choice to make.
    const trickExtra = (isOurTurn && tw > 0) ? Math.min(2, targetPV) : 0;
    const approvalTarget = targetPV + trickExtra;

    // Style-adjusted eval threshold (only applies to our moves)
    const effectiveThreshold = isOurTurn
      ? getStyleEvalThreshold(settings.evalThreshold ?? -0.3, styleValue)
      : (settings.evalThreshold ?? -0.3);

    // For maia+stockfish / lichess+stockfish (our turn): skip the expensive upfront MultiPV.
    // Maia/Lichess suggests moves in order; SF evaluates each one lazily
    // and we stop as soon as we have enough approved candidates.
    // For all other cases, gather SF candidates upfront.
    const skipUpfrontSF = analysisMode === 'lichess+stockfish' && isOurTurn;

    // Request extra SF PVs when style OR trickyness needs a wider candidate pool
    const sfRequestPV = isOurTurn && (styleValue !== 0 || tw > 0)
      ? Math.min(5, targetPV + 2)
      : targetPV;

    const sfCandidates: MoveCandidate[] = [];
    const maiaCandidates: MoveCandidate[] = [];

    // Stockfish candidates (upfront, for non-lazy cases)
    if (useStockfish && sfWorker && !skipUpfrontSF) {
      const SF_RETRIES = 2;
      let sfAttempt = 0;
      while (sfAttempt <= SF_RETRIES && sfCandidates.length === 0) {
        if (sfAttempt > 0) {
          logError('warning', `SF MultiPV retry ${sfAttempt}/${SF_RETRIES} at move ${fullMoveNumber}...`);
        }
        try {
          const topMoves = await getTopMoves(sfWorker, fen, multiPvDepth, sfRequestPV);
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
        } catch (err: any) {
          logError('warning', `SF MultiPV attempt ${sfAttempt + 1} failed at move ${fullMoveNumber}: ${err.message}`);
        }
        sfAttempt++;
      }
      if (sfCandidates.length === 0 && sfAttempt > 1) {
        logError('warning', `SF MultiPV gave up after ${SF_RETRIES} retries at move ${fullMoveNumber} — branch will be skipped.`);
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
    if (useLichess) {
      try {
        const lichessRequestCount = isOurTurn
          ? Math.max(targetPV * 4, 8)
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

    if (analysisMode === 'lichess+stockfish') {
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
            const evalPawns = indivResult.score / 100;

            if (failsEvalThreshold(evalPawns, color, effectiveThreshold)) {
              logError('info', `Lichess+SF: ${lc.san} rejected — eval ${evalPawns.toFixed(2)} fails threshold ${effectiveThreshold.toFixed(2)}`);
              continue;
            }

            candidates.push({
              san: lc.san,
              uci: lc.uci,
              _sfEval: evalPawns,
              _sfDepth: sfAnalysisDepth,
              _lichess: lc._lichess,
            });
            usedSans.add(lc.san);
          } catch (err: any) {
            logError('warning', `Lichess+SF: ${lc.san} evaluation failed: ${err.message}`);
          }
        }

        // Fallback: not enough Lichess moves approved → ask SF directly
        if (candidates.length < targetPV && sfWorker) {
          logError('info', `Lichess+SF: only ${candidates.length}/${targetPV} Lichess moves approved — falling back to SF`);
          const needed = targetPV - candidates.length;
          const SF_RETRIES = 2;
          for (let attempt = 0; attempt <= SF_RETRIES; attempt++) {
            if (attempt > 0) logError('warning', `Lichess+SF fallback MultiPV retry ${attempt}/${SF_RETRIES}...`);
            try {
              const fallbackMoves = await getTopMoves(sfWorker, fen, multiPvDepth, needed + 4);
              for (const tm of fallbackMoves) {
                if (candidates.length >= targetPV) break;
                const san = uciToSan(fen, tm.uci);
                if (!san || usedSans.has(san)) continue;
                if (failsEvalThreshold(tm.eval, color, effectiveThreshold)) continue;
                candidates.push({
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

    // ── Trickyness: opponent error rate ──────────────────────────────────────
    // For each of our move candidates, run a quick MultiPV on the resulting
    // position (opponent's turn) and compute what fraction of the engine's
    // top moves are significantly worse than the best response.  High error
    // rate → tricky for the opponent.  Uses a lightweight depth (≤10) to
    // keep the extra cost manageable.
    if (isOurTurn && tw > 0 && sfWorker && candidates.length > 0) {
      const opponentIsBlack = color === 'white';
      const trickyDepth = Math.min(sfAnalysisDepth, 10);
      for (const candidate of candidates) {
        // Skip if already computed (e.g. in a future inline path)
        if (candidate._trickynessErrorRate !== undefined) continue;
        try {
          const chessT = new Chess(fen);
          const mvT = chessT.move(candidate.san);
          if (!mvT) continue;
          const resultFen = chessT.fen();

          // SF MultiPV: get evals for the opponent's top moves
          const oppTopMoves = await getTopMoves(sfWorker, resultFen, trickyDepth, 5, 12000);

          // Lichess counts: frequency-weight each move so a mistake 40% of
          // players make counts far more than one only 2% attempt.
          // Falls back to uniform weights (1 per move) if the call fails.
          let lichessCounts = new Map<string, number>();
          if (useLichess) {
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
      });
    }
  } else {
    queue.push({
      node: root,
      isOurTurn: color === 'white',
      depth: 0,
      effectiveMaxDepth: maxDepth,
      fullMoveNumber: 1,
    });
  }

  // BFS loop
  const sfAnalysisDepth = settings.sfDepth || 12;

  while (queue.length > 0 && totalNodes < maxNodes && !stopRef.current) {
    const item = queue.shift()!;

    // Check move number limit
    if (item.fullMoveNumber > maxMoveNumber) {
      item.node.cappedByMoveLimit = true;
      logError('info', `Move ${item.fullMoveNumber} exceeds max move limit (${maxMoveNumber}). Branch capped.`);
      continue;
    }

    // Check depth limit
    if (item.depth >= item.effectiveMaxDepth) continue;

    // Gather candidates from Stockfish / Lichess
    let candidates = await gatherCandidates(item.node.fen, item.isOurTurn, item.fullMoveNumber);

    // Smart filtering: reduce opponent responses when one move is clearly dominant
    if (!item.isOurTurn && settings.smartFiltering && useStockfish && candidates.length > 1) {
      const opponentIsBlack = color === 'white';
      const { filtered, reason } = selectSignificantMoves(
        candidates,
        settings.maxOpponentResponses || 2,
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

    // Process each candidate
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

      queue.push({
        node,
        isOurTurn: !item.isOurTurn,
        depth: item.depth + 1,
        effectiveMaxDepth: childMaxDepth,
        fullMoveNumber: nextFullMove,
      });

      // Short delay to keep UI responsive
      await delay(50);
    }
  }

  // ── Second-pass blunder correction ────────────────────────────────────────
  // After BFS completes, scan EVERY node where it was our turn to move —
  // interior nodes as well as leaves.  Any position that evaluates below the
  // blunder threshold is "corrected":
  //
  //   1. Ask Stockfish for the best move at the PARENT's position (i.e. what
  //      we should have played instead).
  //   2. If that best move already exists as a sibling in the tree, simply
  //      remove the blundering node (the correct response is already covered).
  //   3. Otherwise replace the node in-place with the corrected move, clear
  //      its children (they were built from the wrong resulting position), and
  //      update the stored evaluation.
  //
  // Non-blundering nodes have their stored eval upgraded to the more accurate
  // single-PV result obtained here.
  if (useStockfish && sfWorker && !stopRef.current && settings.blunderCorrection !== false) {
    // Relax the blunder threshold to match the maximum trickyness bonus.
    // A trickyness-selected move can be up to (trickynessWeight / 5) pawns
    // below the base threshold, so we must not flag those as blunders.
    const trickRelax = (settings.trickynessWeight ?? 0) / 5;
    const blunderThreshold = (settings.evalThreshold ?? -0.3) - trickRelax;

    // Collect {parent, node} for every node that represents one of OUR moves.
    // Seed nodes are user-specified starting moves and are exempt — we don't
    // want to replace moves the user explicitly chose to include.
    const ourMoveEntries: { parent: GeneratorNode; node: GeneratorNode }[] = [];
    function collectOurMoveEntries(n: GeneratorNode): void {
      for (const child of n.children) {
        if (child.isOurMove && !child.isSeed) {
          ourMoveEntries.push({ parent: n, node: child });
        }
        collectOurMoveEntries(child);
      }
    }
    collectOurMoveEntries(root);

    if (ourMoveEntries.length > 0) {
      logError('info', `Blunder correction pass: scanning ${ourMoveEntries.length} of our move(s)...`);

      let corrected = 0;
      let removedCount = 0;

      for (let i = 0; i < ourMoveEntries.length; i++) {
        if (stopRef.current) break;

        const { parent, node } = ourMoveEntries[i];
        const originalSan = node.san;

        updateProgress(totalNodes, `Blunder check ${i + 1}/${ourMoveEntries.length}: ${originalSan ?? '?'}`);

        // Skip nodes orphaned by an earlier correction in this same pass.
        if (!parent.children.some((c) => c.id === node.id)) continue;

        try {
          // Evaluate the position reached after our move.
          const result = await analyzePosition(sfWorker, node.fen, sfAnalysisDepth);
          const evalPawns = result.score / 100;

          if (!failsEvalThreshold(evalPawns, color, blunderThreshold)) {
            // Sound move — upgrade its stored eval to the fresh single-PV result.
            if (node.stockfish) {
              node.stockfish.eval = evalPawns;
              node.stockfish.depth = sfAnalysisDepth;
            }
            continue;
          }

          // Blunder detected — ask SF for the best move from the parent position
          // (i.e. what we should have played instead).
          logError(
            'warning',
            `Blunder: ${originalSan} → eval ${evalPawns.toFixed(2)} fails threshold ${blunderThreshold.toFixed(2)}, seeking correction...`,
          );

          const parentResult = await analyzePosition(sfWorker, parent.fen, sfAnalysisDepth);
          const bestUci = parentResult.bestMoveUci;
          const bestSan = parentResult.bestMoveSan;

          if (!bestSan || !bestUci) {
            // No correction available — just remove the blundering node.
            parent.children = parent.children.filter((c) => c.id !== node.id);
            removedCount++;
            logError('warning', `Blunder: ${originalSan} removed (no correction found)`);
            continue;
          }

          // If the corrected move already exists as a sibling, removing the
          // blunder is enough — the tree already has the right response.
          const sibling = parent.children.find((c) => c.san === bestSan && c.id !== node.id);
          if (sibling) {
            parent.children = parent.children.filter((c) => c.id !== node.id);
            removedCount++;
            logError('info', `Blunder: ${originalSan} removed — correct move ${bestSan} already in tree`);
            continue;
          }

          // Replace this node in-place with the corrected move.
          const correctedFen = makeMove(parent.fen, bestSan);
          if (!correctedFen) {
            parent.children = parent.children.filter((c) => c.id !== node.id);
            removedCount++;
            logError('warning', `Blunder: ${originalSan} removed (correction ${bestSan} is illegal)`);
            continue;
          }

          const correctedResult = await analyzePosition(sfWorker, correctedFen, sfAnalysisDepth);
          const correctedEvalPawns = correctedResult.score / 100;

          // Mutate the node in-place — san, uci, fen, eval all updated.
          // Children are cleared because they were generated from the blundering
          // position and are no longer valid under the corrected move.
          node.san = bestSan;
          node.uci = bestUci;
          node.fen = correctedFen;
          node.children = [];
          node.stockfish = { eval: correctedEvalPawns, depth: sfAnalysisDepth };

          corrected++;
          logError(
            'info',
            `Blunder corrected: ${originalSan} (${evalPawns.toFixed(2)}) → ${bestSan} (${correctedEvalPawns.toFixed(2)})`,
          );

          if (callbacks.onNodeAdded) {
            callbacks.onNodeAdded(deepCloneTree(root));
          }
        } catch (err: any) {
          logError('warning', `Blunder check error for ${originalSan ?? '?'}: ${err.message}`);
        }
      }

      logError('info', `Blunder correction pass complete — ${corrected} corrected, ${removedCount} removed.`);
      if (callbacks.onNodeAdded) {
        callbacks.onNodeAdded(deepCloneTree(root));
      }
    }
  }

  logError('info', `Generation complete. ${totalNodes} nodes built. ${apiCalls} Lichess API calls made.`);
  updateProgress(totalNodes, `Complete! ${totalNodes} nodes.`);

  if (callbacks.onComplete) {
    callbacks.onComplete(deepCloneTree(root));
  }

  return root;
}
