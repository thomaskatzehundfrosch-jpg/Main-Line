/** Preserve supplied moves, then expand a breadth-first frontier of continuations. */
import { Chess } from 'chess.js';
import type { GeneratorCallbacks, GeneratorNode, GeneratorSettings, GeneratorEndReason } from '../types/generator';
import { normalizeGeneratorSettings, STUDY_SIZES } from '../types/generator';
import { analyzePositionWithStockfish, getTopMovesWithStockfish } from './analyzer';
import { getMostLikelyMoves } from '../utils/lichessApi';
import type { LichessMove } from '../utils/lichessApi';
import { buildSeedTree, cloneGeneratorTree, countGeneratorNodes } from '../utils/generatorSeeds';
import { abortError, abortableDelay } from '../utils/generatorCancellation';

const dependencies = { analyze: analyzePositionWithStockfish, topMoves: getTopMovesWithStockfish, replies: getMostLikelyMoves };
type Candidate = { san: string; uci: string; fen: string; score: number; depth: number; stats?: LichessMove; strongestDefense?: boolean; reason: string };
const positionKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
const scoreFor = (score: number, color: 'white' | 'black') => color === 'white' ? score : -score;

export function isTactical(fen: string): boolean {
  const chess = new Chess(fen);
  return chess.isCheck() || chess.moves({ verbose: true }).some(move => Boolean(move.captured));
}

/** Only immediate queen captures/recaptures; never claims to predict later exchanges. */
export function allowsImmediateQueenTrade(fen: string, san: string): boolean {
  const chess = new Chess(fen);
  const queens = (board: Chess) => board.board().flat().filter(p => p?.type === 'q').length;
  if (queens(chess) !== 2) return false;
  const move = chess.move(san);
  if (move.piece === 'q' && move.captured === 'q') {
    return chess.moves({ verbose: true }).some(reply => reply.to === move.to && reply.captured === 'q');
  }
  return chess.moves({ verbose: true }).some(reply => {
    if (reply.piece !== 'q' || reply.captured !== 'q') return false;
    const after = new Chess(chess.fen());
    after.move(reply);
    return after.moves({ verbose: true }).some(recapture => recapture.to === reply.to && recapture.captured === 'q');
  });
}

/** Common mistakes remain useful preparation; reserve a place for the best defense. */
export function selectOpponentReplies<T extends { uci: string; playRate: number }>(
  popular: T[], best: T, coverageTarget: number, maxReplies: number, minPlayRate: number = 5
): T[] {
  const selected: T[] = [popular.find(move => move.uci === best.uci) ?? best];
  const ranked = [...popular].sort((a, b) => b.playRate - a.playRate);
  // Frequency-qualified replies override both soft study-size limits.
  for (const move of ranked) {
    if (move.playRate + 1e-8 >= minPlayRate && !selected.some(chosen => chosen.uci === move.uci)) selected.push(move);
  }
  let coverage = selected.reduce((sum, move) => sum + move.playRate / 100, 0);
  for (const move of ranked) {
    if (selected.length >= maxReplies || coverage >= coverageTarget) break;
    if (selected.some(chosen => chosen.uci === move.uci)) continue;
    selected.push(move);
    coverage += move.playRate / 100;
  }
  return selected; // strongest first, including when the remaining node budget is small
}

export async function buildTree(
  seeds: string[][] | null,
  input: GeneratorSettings,
  callbacks: GeneratorCallbacks,
  stop: { current: boolean; signal?: AbortSignal },
  worker: Worker | null,
  services = dependencies
): Promise<GeneratorNode> {
  if (!worker) throw new Error('Stockfish is required to verify continuations.');
  const settings = normalizeGeneratorSettings(input);
  const { maxNodes, maxReplies, coverage } = STUDY_SIZES[settings.studySize];
  const root = buildSeedTree(seeds ?? [], settings.color);
  const signal = stop.signal;
  let totalNodes = countGeneratorNodes(root);
  let apiCalls = 0;
  let nextId = 0;
  const check = () => { if (stop.current || signal?.aborted) throw abortError(); };
  const log = (level: 'info' | 'warning' | 'error', message: string) => {
    callbacks.onLog?.({ id: `log_${Date.now()}_${++nextId}`, timestamp: new Date().toLocaleTimeString(), level, message, context: null });
  };
  const publish = () => callbacks.onNodeAdded?.(cloneGeneratorTree(root));
  const progress = (status: string) => callbacks.onProgress?.({ nodes: totalNodes, maxNodes, apiCalls, status, outcome: 'running' });
  const evalCache = new Map<string, Promise<{ score: number; depth: number }>>();
  const replyCache = new Map<string, LichessMove[]>();
  const choiceCache = new Map<string, Candidate[]>();
  const coverages: number[] = [];
  let explorerFailures = 0;

  async function evaluate(fen: string): Promise<{ score: number; depth: number }> {
    check();
    const chess = new Chess(fen);
    if (chess.isCheckmate()) return { score: chess.turn() === 'w' ? -100 : 100, depth: settings.sfDepth };
    if (chess.isGameOver()) return { score: 0, depth: settings.sfDepth };
    if (!evalCache.has(fen)) {
      evalCache.set(fen, services.analyze(worker!, fen, settings.sfDepth, signal).then(result => {
        if (result.depth < settings.sfDepth || !Number.isFinite(result.score)) throw new Error('Engine did not reach the requested analysis quality.');
        return { score: result.score / 100, depth: result.depth };
      }));
    }
    const result = await evalCache.get(fen)!;
    check();
    return result;
  }

  async function popularReplies(fen: string): Promise<LichessMove[]> {
    if (settings.analysisMode === 'stockfish') return [];
    const key = positionKey(fen);
    if (replyCache.has(key)) return replyCache.get(key)!;
    check();
    try {
      apiCalls++;
      const replies = await services.replies(fen, settings, (level, message) => { check(); log(level, message); }, 100, signal);
      check();
      // Very small samples do not establish human coverage. Fall back explicitly.
      const supported = replies.filter(reply => reply.totalGames >= settings.minGames);
      replyCache.set(key, supported);
      return supported;
    } catch (error) {
      check();
      explorerFailures++;
      log('warning', `Human reply data unavailable; using engine replies here. ${error instanceof Error ? error.message : error}`);
      replyCache.set(key, []);
      return [];
    }
  }

  async function candidate(fen: string, uci: string, stats?: LichessMove): Promise<Candidate> {
    const chess = new Chess(fen);
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (!move) throw new Error(`Engine returned an illegal move: ${uci}`);
    const evaluation = await evaluate(chess.fen());
    return { san: move.san, uci, fen: chess.fen(), ...evaluation, stats, reason: '' };
  }

  async function choose(fen: string, ourTurn: boolean, node: GeneratorNode): Promise<Candidate[]> {
    const key = positionKey(fen);
    // Same position, same recommendation; preserve explicit alternatives in seeds.
    if (ourTurn && choiceCache.has(key)) return choiceCache.get(key)!.map(c => {
      const chess = new Chess(fen); chess.move(c.san); return { ...c, fen: chess.fen() };
    });
    const popular = await popularReplies(fen);
    const tricky = settings.trickiness !== 'off' && settings.analysisMode !== 'stockfish';
    const count = ourTurn ? (tricky ? 5 : settings.avoidQueenTrades ? 4 : 1) : maxReplies;
    const top = await services.topMoves(worker!, fen, settings.sfDepth, count, 90000, signal);
    check();
    if (!top.length || top.some(move => move.depth < settings.sfDepth || move.eval == null)) {
      throw new Error('Engine did not return a verified best move.');
    }
    const strongest = top[0];
    if (ourTurn) {
      const pool = [...new Set([...top.map(m => m.uci), ...popular.slice(0, 3).map(m => m.uci)])];
      const checked: Candidate[] = [];
      for (const uci of pool) {
        try { checked.push(await candidate(fen, uci, popular.find(move => move.uci === uci))); }
        catch (error) { check(); if (uci === strongest.uci) throw error; }
      }
      const current = scoreFor((await evaluate(fen)).score, settings.color);
      const maximumLoss = tricky ? settings.trickinessMaxLoss : settings.maxEvalLoss;
      const permitted = checked.filter(move => current - scoreFor(move.score, settings.color) <= maximumLoss + 1e-8);
      if (!permitted.length) throw new Error(`No verified candidate stays within the ${maximumLoss.toFixed(2)} pawn loss limit from the current evaluation (${current.toFixed(2)} from your side).`);
      const best = Math.max(...permitted.map(move => scoreFor(move.score, settings.color)));
      if (tricky) {
        // A fallback may be below the minimum sacrifice, but never exceeds the maximum.
        const baseline = permitted.reduce((a, b) => scoreFor(a.score, settings.color) >= scoreFor(b.score, settings.color) ? a : b);
        let eligible = permitted.filter(move => {
          const loss = Math.max(0, current - scoreFor(move.score, settings.color));
          return loss + 1e-8 >= settings.trickinessMinLoss && loss <= settings.trickinessMaxLoss + 1e-8;
        });
        if (settings.avoidQueenTrades) {
          const keepQueens = eligible.filter(move => !allowsImmediateQueenTrade(fen, move.san));
          if (keepQueens.length) eligible = keepQueens;
        }
        let chosen = baseline;
        let chosenScore = best;
        let explanation = 'No supported practical improvement in your sacrifice interval; best verified candidate retained';
        for (const move of eligible) {
          check();
          try {
            // Full position frequencies: unexamined replies contribute zero benefit.
            const replies = (await popularReplies(move.fen)).slice(0, 8);
            let benefit = 0;
            let mistakeFrequency = 0;
            const objective = scoreFor(move.score, settings.color);
            for (const reply of replies) {
              const after = await candidate(move.fen, reply.uci);
              const gain = Math.max(0, Math.min(3, scoreFor(after.score, settings.color) - objective));
              const probability = Math.max(0, Math.min(1, reply.playRate / 100));
              // Shrink each reply's contribution until it has substantial evidence.
              const confidence = reply.totalGames / (reply.totalGames + 100);
              benefit += probability * gain * confidence;
              if (gain >= 0.3) mistakeFrequency += probability;
            }
            const practicalScore = objective + (settings.trickiness === 'high' ? 1 : 0.5) * benefit;
            if (practicalScore > chosenScore + 1e-8) {
              chosen = move; chosenScore = practicalScore;
              explanation = `Trickiness: ${Math.max(0, current - objective).toFixed(2)} pawn sacrifice from the current evaluation; inferior replies in ${(mistakeFrequency * 100).toFixed(0)}% of database games; confidence-adjusted benefit ${benefit.toFixed(2)} pawns (up to 8 replies examined)`;
            }
          } catch (error) {
            check();
            log('warning', `Could not assess trickiness for ${move.san}; no practical bonus used.`);
          }
        }
        chosen.reason = explanation;
        choiceCache.set(key, [chosen]);
        return [chosen];
      }
      let sound = permitted;
      if (settings.avoidQueenTrades) {
        const keepQueens = sound.filter(move => !allowsImmediateQueenTrade(fen, move.san));
        if (keepQueens.length) sound = keepQueens;
      }
      sound.sort((a, b) => (b.stats?.totalGames ?? 0) - (a.stats?.totalGames ?? 0) || scoreFor(b.score, settings.color) - scoreFor(a.score, settings.color));
      const chosen = sound[0];
      if (!chosen) throw new Error('No verified continuation available.');
      const loss = Math.max(0, current - scoreFor(chosen.score, settings.color));
      chosen.reason = chosen.stats
        ? `Common in your opponent profile; ${loss.toFixed(2)} pawns lost from the current evaluation`
        : 'Best verified candidate within your preferences';
      choiceCache.set(key, [chosen]);
      return [chosen];
    }
    let selected: Array<{ uci: string; playRate: number }>;
    if (popular.length) {
      selected = selectOpponentReplies(popular, { uci: strongest.uci, playRate: 0 } as LichessMove, coverage, maxReplies, settings.opponentMinPlayRate);
      node.responseCoverage = Math.min(1, selected.reduce((sum, move) => sum + move.playRate / 100, 0));
      coverages.push(node.responseCoverage);
      if (node.responseCoverage + 1e-8 < coverage) {
        node.coverageLimited = true;
        node.warning = 'Reply limit or limited data prevented the requested human coverage.';
      }
    } else {
      selected = top.map(move => ({ uci: move.uci, playRate: 0 }));
      if (settings.analysisMode !== 'stockfish') {
        node.coverageLimited = true;
        node.warning = 'Insufficient human data; replies selected by the engine. Human coverage is unknown.';
      }
    }
    const result: Candidate[] = [];
    for (const move of selected) {
      const checked = await candidate(fen, move.uci, popular.find(reply => reply.uci === move.uci));
      checked.strongestDefense = move.uci === strongest.uci;
      checked.reason = checked.strongestDefense ? 'Strongest engine defense'
        : checked.stats ? `Common opponent reply (${checked.stats.playRate.toFixed(1)}% of database games)` : 'Engine defense';
      result.push(checked);
    }
    return result;
  }

  type Pending = { node: GeneratorNode; likelihood: number; targetDepth: number; ancestors: Set<string> };
  const queue: Pending[] = [];
  const seedNodes: Array<{ node: GeneratorNode; parent: GeneratorNode }> = [];
  function collect(node: GeneratorNode, ancestors = new Set<string>()) {
    const next = new Set(ancestors).add(positionKey(node.fen));
    if (!node.children.length) queue.push({ node, likelihood: 1, targetDepth: settings.maxMoveNumber * 2, ancestors });
    for (const child of node.children) { seedNodes.push({ node: child, parent: node }); collect(child, next); }
  }
  collect(root);
  let active: GeneratorNode | null = null;
  let stopped = false;
  publish();
  try {
    // Seeds are audited, never filtered. Shared prefixes are checked only once.
    for (const { node, parent } of seedNodes) {
      check();
      if (!node.isOurMove) continue;
      progress(`Checking your move ${node.fullMoveNumber}${settings.color === 'white' ? '.' : '...'} ${node.san} (preserved)`);
      try {
        const reference = await evaluate(parent.fen);
        const actual = await evaluate(node.fen);
        node.stockfish = { eval: actual.score, depth: actual.depth };
        const drop = scoreFor(reference.score - actual.score, settings.color);
        if (drop > settings.maxEvalLoss) {
          node.warning = `Your move was preserved; engine estimates a ${drop.toFixed(2)} pawn loss against its best continuation.`;
          log('warning', `${node.san}: ${node.warning}`);
        }
      } catch (error) {
        check();
        node.warning = 'Your move was preserved, but engine verification failed.';
        log('warning', `${node.san}: ${node.warning}`);
      }
      publish();
    }

    while (queue.length) {
      check();
      // Cover shallower positions first, prioritising likely paths at equal depth.
      queue.sort((a, b) => a.node.depth - b.node.depth || b.likelihood - a.likelihood);
      const item = queue.shift()!;
      active = item.node;
      const chess = new Chess(active.fen);
      if (chess.isGameOver() || item.ancestors.has(positionKey(active.fen))) {
        active.endReason = item.ancestors.has(positionKey(active.fen)) ? 'repetition' : 'terminal';
        if (item.ancestors.has(positionKey(active.fen))) active.reason = 'Repeated position; continuation already represented on this line';
        continue;
      }
      const baseDepth = item.targetDepth;
      const hardDepth = baseDepth + settings.tacticalExtension * 2;
      if (active.depth >= baseDepth && (!isTactical(active.fen) || settings.tacticalExtension === 0)) {
        active.endReason = baseDepth < settings.maxMoveNumber * 2 ? 'adaptive-depth' : 'target'; active.cappedByMoveLimit = true; continue;
      }
      if (active.depth >= hardDepth) {
        active.endReason = 'extension-limit'; active.cappedByMoveLimit = true; continue;
      }
      if (totalNodes >= maxNodes) { active.endReason = 'budget'; continue; }
      progress(`Choosing a continuation at move ${chess.fen().split(' ')[5]}…`);
      try {
        const ourTurn = chess.turn() === (settings.color === 'white' ? 'w' : 'b');
        const moves = await choose(active.fen, ourTurn, active);
        check();
        const added: Candidate[] = [];
        for (const move of moves) {
          if (totalNodes >= maxNodes) { active.endReason = 'budget'; break; }
          const node: GeneratorNode = {
            id: `gen_${++nextId}`, san: move.san, uci: move.uci, fen: move.fen,
            children: [], depth: active.depth + 1, fullMoveNumber: Number(active.fen.split(' ')[5]),
            isOurMove: ourTurn, isMainLine: active.children.length === 0,
            isDangerous: !ourTurn && scoreFor(move.score, settings.color) < -0.5,
            cappedByMoveLimit: false, stockfish: { eval: move.score, depth: move.depth },
            lichess: move.stats ? { ...move.stats } : null, reason: move.reason,
          };
          active.children.push(node); added.push(move); totalNodes++;
          const probability = move.stats ? move.stats.playRate / 100 : 1 / Math.max(1, moves.length);
          const rareReply = !ourTurn && settings.adaptiveOpponentDepth && !move.strongestDefense
            && move.stats !== undefined && move.stats.playRate < settings.opponentMinPlayRate;
          // Reduce the overall horizon once, not once per rare move. Always leave
          // room for our answer; tactical extensions still apply at the shorter horizon.
          const targetDepth = rareReply
            ? Math.min(item.targetDepth, Math.max(node.depth + 1, settings.maxMoveNumber * 2 - 4))
            : item.targetDepth;
          queue.push({ node, targetDepth, likelihood: item.likelihood * (ourTurn ? 1 : probability), ancestors: new Set(item.ancestors).add(positionKey(active.fen)) });
          callbacks.onNewNode?.({ ...node, children: [] });
        }
        if (active.responseCoverage !== undefined) {
          active.responseCoverage = added.reduce((sum, move) => sum + (move.stats?.playRate ?? 0) / 100, 0);
          coverages[coverages.length - 1] = active.responseCoverage;
          active.coverageLimited = active.responseCoverage + 1e-8 < coverage;
        }
      } catch (error) {
        check();
        active.endReason = 'analysis-failed';
        if (active.responseCoverage !== undefined) {
          active.responseCoverage = 0;
          active.coverageLimited = true;
          coverages[coverages.length - 1] = 0;
        }
        active.warning = error instanceof Error ? error.message : String(error);
        log('warning', `Continuation unfinished: ${active.warning}`);
      }
      publish();
      progress(`${totalNodes} moves prepared`);
      await abortableDelay(0, signal);
    }
  } catch (error) {
    if (!stop.current && !signal?.aborted) throw error;
    stopped = true;
    if (active && !active.endReason && !active.children.length) active.endReason = 'stopped';
    for (const item of queue) if (!item.node.endReason) item.node.endReason = 'stopped';
  }
  const unfinishedReasons = new Set<GeneratorEndReason>(['budget', 'stopped', 'analysis-failed', 'extension-limit']);
  let unfinished = 0;
  let coverageGaps = 0;
  const count = (node: GeneratorNode) => {
    if (node.endReason && unfinishedReasons.has(node.endReason)) unfinished++;
    if (node.coverageLimited) coverageGaps++;
    node.children.forEach(count);
  };
  count(root);
  const outcome = stopped ? 'stopped' : (unfinished || coverageGaps) ? 'partial' : 'complete';
  const status = stopped ? `Stopped — ${unfinished} unfinished positions`
    : unfinished ? `Partial repertoire — ${unfinished} unfinished positions`
    : coverageGaps ? `Target reached; reply coverage limited at ${coverageGaps} positions`
    : 'Study depth reached for all selected lines';
  log(outcome === 'complete' ? 'info' : 'warning', status);
  if (explorerFailures) log('warning', `${explorerFailures} positions used engine replies after a database error.`);
  publish();
  callbacks.onProgress?.({ nodes: totalNodes, maxNodes, apiCalls, status, outcome, unfinished,
    averageResponseCoverage: coverages.length ? coverages.reduce((a, b) => a + b, 0) / coverages.length : undefined,
    coveragePositions: coverages.length, coverageGaps });
  callbacks.onComplete?.(cloneGeneratorTree(root));
  return root;
}
