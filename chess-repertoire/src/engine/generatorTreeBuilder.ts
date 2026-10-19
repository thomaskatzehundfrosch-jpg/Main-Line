import { createGeneratorCloudAnalysis } from './generatorCloudAnalysis';
import { buildTree as buildLegacyTree } from './legacyGeneratorTreeBuilder';
import { replyEvidence, winLowerBound } from '../openingLab/evidence.js';
/** Preserve supplied moves, then expand a breadth-first frontier of continuations. */
import { Chess } from 'chess.js';
import type { GeneratorCallbacks, GeneratorNode, GeneratorSettings, GeneratorEndReason } from '../types/generator';
import { normalizeGeneratorSettings, STUDY_SIZES } from '../types/generator';
import { analyzePositionWithStockfish, getTopMovesWithStockfish } from './analyzer';
import { getMostLikelyMoves } from '../utils/lichessApi';
import type { LichessMove } from '../utils/lichessApi';
import { buildSeedTree, cloneGeneratorTree, countGeneratorNodes } from '../utils/generatorSeeds';
import { abortError, abortableDelay } from '../utils/generatorCancellation';
import { abandonsCastling, preservesCastling, CASTLING_PREFERENCE_MARGIN } from '../utils/castlingPreference';
import { sacrificeLimits } from '../utils/sacrificeLimits';

const localDependencies = { analyze: analyzePositionWithStockfish, topMoves: getTopMovesWithStockfish, replies: getMostLikelyMoves };
const dependencies = { ...localDependencies, ...createGeneratorCloudAnalysis(localDependencies) };
type Candidate = { san: string; uci: string; fen: string; score: number; depth: number; source?: 'lichess-cloud' | 'local'; stats?: LichessMove; strongestDefense?: boolean; reason: string };
const positionKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
const scoreFor = (score: number, color: 'white' | 'black') => color === 'white' ? score : -score;

/** Unknown frequencies do not imply a rare path. First two generated opponent turns stay wide. */
export function decayReplyLimit(mode: GeneratorSettings['branchDecay'], turns: number, probability: number | null): number {
  if (mode === 'off' || turns < 2 || probability === null) return Infinity;
  const narrow = mode === 'balanced' ? 0.02 : 0.005;
  const medium = mode === 'balanced' ? 0.10 : 0.05;
  return probability < narrow ? 1 : probability <= medium ? 2 : Infinity;
}

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
  popular: T[], best: T, coverageTarget: number, maxReplies: number, minPlayRate: number = 10
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
  services?: typeof dependencies,
  resumeTree?: GeneratorNode,
): Promise<GeneratorNode> {
  if (input.generatorMode === 'legacy') return buildLegacyTree(seeds, input, callbacks, stop, worker, services ?? localDependencies, resumeTree);
  const analysisServices = services ?? dependencies;
  if (!worker) throw new Error('Stockfish is required to verify continuations.');
  const settings = normalizeGeneratorSettings(input);
  const searchDepth = Math.min(18, settings.sfDepth);
  const { maxNodes, maxReplies, coverage } = STUDY_SIZES[settings.studySize];
  if (resumeTree && resumeTree.repertoireColor !== settings.color) throw new Error('Saved run color does not match its settings.');
  const root = resumeTree ? cloneGeneratorTree(resumeTree) : buildSeedTree(seeds ?? [], settings.color);
  const signal = stop.signal;
  let totalNodes = countGeneratorNodes(root);
  let apiCalls = 0;
  let nextId = 0;
  const existingIds = new Set<string>();
  const rememberIds = (node: GeneratorNode) => { existingIds.add(node.id); node.children.forEach(rememberIds); };
  rememberIds(root);
  const nextNodeId = () => { let id: string; do { id = `gen_${++nextId}`; } while (existingIds.has(id)); existingIds.add(id); return id; };
  const check = () => { if (stop.current || signal?.aborted) throw abortError(); };
  const log = (level: 'info' | 'warning' | 'error', message: string) => {
    callbacks.onLog?.({ id: `log_${Date.now()}_${++nextId}`, timestamp: new Date().toLocaleTimeString(), level, message, context: null });
  };
  const publish = () => callbacks.onNodeAdded?.(cloneGeneratorTree(root));
  const progress = (status: string) => callbacks.onProgress?.({ nodes: totalNodes, maxNodes, apiCalls, status, outcome: 'running' });
  const evalCache = new Map<string, Promise<{ score: number; depth: number; source?: 'lichess-cloud' | 'local'; bestMoveUci?: string }>>();
  const replyCache = new Map<string, LichessMove[]>();
  const topCache = new Map<string, ReturnType<typeof analysisServices.topMoves>>();
  async function topMoves(fen: string, depth: number, count: number) {
    check();
    const key = JSON.stringify([fen, depth, count]);
    if (!topCache.has(key)) topCache.set(key, analysisServices.topMoves(worker!, fen, depth, count, 90000, signal)
      .catch(error => { topCache.delete(key); throw error; }));
    const result = await topCache.get(key)!;
    check();
    return result;
  }
  const choiceCache = new Map<string, Candidate[]>();
  const coverages: number[] = [];
  let explorerFailures = 0;

  async function evaluate(fen: string, depth = searchDepth): Promise<{ score: number; depth: number; source?: 'lichess-cloud' | 'local'; bestMoveUci?: string }> {
    check();
    const chess = new Chess(fen);
    if (chess.isCheckmate()) return { score: chess.turn() === 'w' ? -100 : 100, depth };
    if (chess.isGameOver()) return { score: 0, depth };
    const key = JSON.stringify([fen, depth]);
    if (!evalCache.has(key)) {
      evalCache.set(key, analysisServices.analyze(worker!, fen, depth, signal).then(result => {
        if (result.depth < depth || !Number.isFinite(result.score)) throw new Error('Engine did not reach the requested analysis quality.');
        return { score: result.score / 100, depth: result.depth, source: result.source ?? 'local' as const, bestMoveUci: result.bestMoveUci };
      }).catch(error => { evalCache.delete(key); throw error; }));
    }
    const result = await evalCache.get(key)!;
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
      const replies = await analysisServices.replies(fen, settings, (level, message) => { check(); log(level, message); }, 100, signal);
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

  async function choose(fen: string, ourTurn: boolean, node: GeneratorNode, replyLimit = Infinity): Promise<Candidate[]> {
    const key = positionKey(fen);
    // Same position, same recommendation; preserve explicit alternatives in seeds.
    if (ourTurn && choiceCache.has(key)) return choiceCache.get(key)!.map(c => {
      const chess = new Chess(fen); chess.move(c.san); return { ...c, fen: chess.fen() };
    });
    const popular = await popularReplies(fen);
    const tricky = settings.trickiness !== 'off' && settings.analysisMode !== 'stockfish';
    const count = ourTurn ? (tricky ? 6 : settings.avoidQueenTrades ? 4 : 1) : maxReplies;
    let top = await topMoves(fen, searchDepth, count);
    // Engine-only mode normally asks for one move. Discover alternatives only
    // when that recommendation would abandon castling rights.
    if (ourTurn && count === 1 && top[0]) {
      const board = new Chess(fen), uci = top[0].uci;
      const move = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      if (move && abandonsCastling(fen, { uci, fen: board.fen() })) top = await topMoves(fen, searchDepth, 4);
    }
    check();
    if (!top.length || top.some(move => move.depth < searchDepth || move.eval == null)) {
      throw new Error('Engine did not return a verified best move.');
    }
    const strongest = top[0];
    if (ourTurn) {
      let rare: string[] = [];
      if (tricky) {
        // Cheap discovery only: every shortlisted move is verified below at full depth.
        const screen = await topMoves(fen, Math.min(10, settings.sfDepth), new Chess(fen).moves().length);
        const bestScreen = Math.max(...screen.filter(m => m.eval != null).map(m => scoreFor(m.eval!, settings.color)));
        rare = screen.filter(m => m.eval != null && bestScreen - scoreFor(m.eval!, settings.color) <= settings.trickinessMaxLoss + 0.5)
          .filter(m => popular.some(p => p.uci === m.uci && p.playRate <= 5))
          .sort((a, b) => (popular.find(p => p.uci === a.uci)?.playRate ?? 100) - (popular.find(p => p.uci === b.uci)?.playRate ?? 100))
          .slice(0, 2).map(m => m.uci);
      }
      const supportedWins = [...popular].sort((a, b) => winLowerBound(b.winRate / 100 * b.totalGames, b.totalGames) - winLowerBound(a.winRate / 100 * a.totalGames, a.totalGames));
      const pool = [...new Set([...top.map(m => m.uci), ...rare, ...popular.slice(0, tricky ? 1 : settings.analysisMode === 'stockfish' ? 0 : 3).map(m => m.uci), ...(tricky ? supportedWins.slice(0, 1).map(m => m.uci) : [])])].slice(0, tricky ? 10 : 7);
      const checked: Candidate[] = [];
      for (const uci of pool) {
        try { checked.push(await candidate(fen, uci, popular.find(move => move.uci === uci))); }
        catch (error) { check(); if (uci === strongest.uci) throw error; }
      }
      const winEvidence = (move: Candidate) => move.stats && move.stats.totalGames >= Math.max(100, settings.minGames)
        ? winLowerBound(move.stats.winRate / 100 * move.stats.totalGames, move.stats.totalGames) : 0;
      async function verifyWinner(ranked: Candidate[]): Promise<Candidate[]> {
        const rootEvaluation = await evaluate(fen, settings.sfDepth);
        const reference = scoreFor(rootEvaluation.score, settings.color);
        const { maximum } = sacrificeLimits(reference, tricky ? settings.trickinessMaxLoss : settings.maxEvalLoss);
        const belowFloor = settings.evaluationFloorEnabled && reference < settings.evaluationFloor - 1e-8;
        const protectAdvantage = reference >= 1;
        // Include all discovered candidates: shallow screening and a minimum
        // sacrifice must not hide the best conversion at full depth.
        const order = [...(protectAdvantage ? checked : belowFloor ? [...ranked].sort((a, b) => scoreFor(b.score, settings.color) - scoreFor(a.score, settings.color)) : ranked)];
        // A best move discovered at final depth may be absent from the shallow
        // shortlist, or have been removed by shallow safety screening.
        const deepUci = rootEvaluation.bestMoveUci;
        if (deepUci && !order.some(move => move.uci === deepUci)) {
          const board = new Chess(fen);
          const move = board.move({ from: deepUci.slice(0, 2), to: deepUci.slice(2, 4), promotion: deepUci[4] });
          if (move) order.push({ san: move.san, uci: deepUci, fen: board.fen(), score: rootEvaluation.score,
            depth: rootEvaluation.depth, stats: popular.find(row => row.uci === deepUci),
            reason: `Best move from depth-${settings.sfDepth} root analysis; fallback after shallow candidate screening` });
        }
        let bestConversion: Candidate | null = null;
        let kingFallback: Candidate | null = null;
        for (const move of order) {
          check();
          try {
            progress(`Verifying ${move.san} at depth ${settings.sfDepth}…`);
            const verified = await evaluate(move.fen, settings.sfDepth);
            const objective = scoreFor(verified.score, settings.color);
            if (reference - objective > maximum + 1e-8 ||
                (settings.evaluationFloorEnabled && !belowFloor && objective < settings.evaluationFloor - 1e-8)) {
              log('info', `${move.san} failed depth-${settings.sfDepth} safety limits: reference ${reference.toFixed(2)}, candidate ${objective.toFixed(2)}, loss ${(reference - objective).toFixed(2)}, allowed ${maximum.toFixed(2)}${settings.evaluationFloorEnabled && !belowFloor ? `, floor ${settings.evaluationFloor.toFixed(2)}` : ''} (all from your side); checking the next candidate.`);
              continue;
            }
            const evidence = winEvidence(move);
            const reason = protectAdvantage ? 'Protecting an advantage of at least +1: strongest full-depth verified candidate; practical bonuses disabled'
              : belowFloor ? 'Below evaluation floor; objective continuation selected without a practical bonus'
              : move.reason || 'Next ranked candidate after deeper verification';
            const chosen = { ...move, ...verified, reason: `${reason}; verified at depth ${verified.depth} (${verified.source === 'lichess-cloud' ? 'Lichess cloud; engine version unspecified' : 'local Stockfish 19 Full'})${evidence > 0 ? `; ${move.stats!.winRate.toFixed(1)}% recorded wins in ${move.stats!.totalGames} games (95% lower bound ${(evidence * 100).toFixed(1)}%)` : ''}` };
            if (protectAdvantage) {
              if (!bestConversion || objective > scoreFor(bestConversion.score, settings.color)) bestConversion = chosen;
              continue;
            }
            if (!belowFloor && !kingFallback && abandonsCastling(fen, chosen)) {
              kingFallback = chosen;
              continue;
            }
            if (kingFallback) {
              if (!preservesCastling(fen, chosen) || objective + CASTLING_PREFERENCE_MARGIN + 1e-8 < scoreFor(kingFallback.score, settings.color)) continue;
              chosen.reason += '; preserves castling options or castles instead of an uncastled king move (within 0.30 pawns at verified depth)';
            }
            choiceCache.set(key, [chosen]);
            return [chosen];
          } catch (error) {
            check();
            log('warning', `Could not verify ${move.san} at depth ${settings.sfDepth}: ${error instanceof Error ? error.message : String(error)}; checking the next candidate.`);
          }
        }
        if (bestConversion) {
          choiceCache.set(key, [bestConversion]);
          return [bestConversion];
        }
        if (kingFallback) {
          choiceCache.set(key, [kingFallback]);
          return [kingFallback];
        }
        throw new Error(`No candidate passed depth-${settings.sfDepth} verification within the loss limit from the current evaluation and evaluation floor limits. Reference ${reference.toFixed(2)}, allowed loss ${maximum.toFixed(2)}${settings.evaluationFloorEnabled ? `, floor ${settings.evaluationFloor.toFixed(2)}` : ''} (from your side).`);
      }
      const current = scoreFor((await evaluate(fen)).score, settings.color);
      if (scoreFor((await evaluate(fen, settings.sfDepth)).score, settings.color) >= 1) return verifyWinner(checked);
      const { maximum: maximumLoss, minimum: minimumLoss } = sacrificeLimits(current,
        tricky ? settings.trickinessMaxLoss : settings.maxEvalLoss, tricky ? settings.trickinessMinLoss : 0);
      let permitted = checked.filter(move => current - scoreFor(move.score, settings.color) <= maximumLoss + 1e-8);
      if (!permitted.length) return verifyWinner(checked);
      if (settings.evaluationFloorEnabled) {
        if (current < settings.evaluationFloor - 1e-8) {
          // Already below the floor: no practical or popularity bonus, only the best defense.
          const chosen = permitted.reduce((a, b) => scoreFor(a.score, settings.color) >= scoreFor(b.score, settings.color) ? a : b);
          chosen.reason = `Current evaluation ${current.toFixed(2)} is below your ${settings.evaluationFloor.toFixed(2)} floor; strongest verified continuation selected without deliberate sacrifice`;
          return verifyWinner([chosen, ...permitted.filter(move => move !== chosen)]);
        }
        permitted = permitted.filter(move => scoreFor(move.score, settings.color) + 1e-8 >= settings.evaluationFloor);
        if (!permitted.length) return verifyWinner(checked);
      }
      if (tricky) {
        // A fallback may be below the minimum sacrifice, but never exceeds the maximum.
        const baseline = permitted.reduce((a, b) => scoreFor(a.score, settings.color) >= scoreFor(b.score, settings.color) ? a : b);
        let eligible = permitted.filter(move => {
          const loss = Math.max(0, current - scoreFor(move.score, settings.color));
          return loss + 1e-8 >= minimumLoss && loss <= maximumLoss + 1e-8;
        });
        if (settings.avoidQueenTrades) {
          const keepQueens = eligible.filter(move => !allowsImmediateQueenTrade(fen, move.san));
          if (keepQueens.length) eligible = keepQueens;
        }
        const practicalScores = new Map(permitted.map(move => [move.uci, scoreFor(move.score, settings.color)]));
        const winLeader = [...eligible].filter(move => winEvidence(move) > 0).sort((a, b) => winEvidence(b) - winEvidence(a) || scoreFor(b.score, settings.color) - scoreFor(a.score, settings.color))[0];
        let chosen = winLeader ?? baseline;
        let chosenScore = scoreFor(chosen.score, settings.color);
        let chosenAdequate = Infinity;
        let explanation = winEvidence(chosen) > 0 ? 'Supported win-rate preference within safety limits' : 'No supported practical improvement in your sacrifice interval; best verified candidate retained';
        // Bound detailed investigation to six contenders, strongest first.
        eligible.sort((a, b) => scoreFor(b.score, settings.color) - scoreFor(a.score, settings.color));
        for (const move of eligible.slice(0, 6)) {
          check();
          try {
            const recorded = await popularReplies(move.fen);
            if (!recorded.length) continue;
            const objective = scoreFor(move.score, settings.color);
            // Bounded version of the Lab's defensive-width check. It establishes
            // checked options only; unsearched legal moves are never called refuted.
            const defences = await topMoves(move.fen, searchDepth, 3);
            if (!defences.length || defences.some(row => row.eval == null || row.depth < searchDepth)) continue;
            const defenceScore = Math.min(objective, ...defences.map(row => scoreFor(row.eval!, settings.color)));
            const adequateChecked = defences.filter(row => scoreFor(row.eval!, settings.color) - defenceScore < 0.3).length;
            const rows: Array<{ cp: number; frequency: number; supported: boolean; games: number }> = [];
            let mass = 0;
            for (const reply of [...recorded].sort((a, b) => b.playRate - a.playRate).slice(0, 3)) {
              const after = await candidate(move.fen, reply.uci);
              rows.push({ cp: scoreFor(after.score, settings.color) * 100, frequency: reply.playRate / 100, supported: reply.totalGames >= settings.minGames, games: reply.totalGames });
              mass += reply.playRate / 100;
              if (mass >= 0.8) break;
            }
            // Recorded replies can expose a stronger defence; never reward that discrepancy.
            const defended = Math.min(defenceScore, ...rows.map(row => row.cp / 100));
            const loss = Math.max(0, current - defended);
            if (loss > maximumLoss + 1e-8 || loss + 1e-8 < minimumLoss ||
                (settings.evaluationFloorEnabled && defended < settings.evaluationFloor - 1e-8)) continue;
            const evidence = replyEvidence(rows, defended * 100, 30);
            const benefit = rows.reduce((sum, row) => {
              const gain = Math.max(0, Math.min(300, row.cp - defended * 100));
              return sum + (gain >= 30 ? row.frequency * gain / 100 * row.games / (row.games + 100) : 0);
            }, 0);
            const practicalScore = defended + (settings.trickiness === 'high' ? 1 : 0.5) * benefit;
            practicalScores.set(move.uci, practicalScore);
            if (winEvidence(move) > winEvidence(chosen) + 1e-8 || (Math.abs(winEvidence(move) - winEvidence(chosen)) <= 1e-8 &&
                (practicalScore > chosenScore + 1e-8 || (benefit > 0 && Math.abs(practicalScore - chosenScore) <= 1e-8 && adequateChecked < chosenAdequate)))) {
              chosen = { ...move, score: settings.color === 'white' ? defended : -defended };
              chosenScore = practicalScore;
              chosenAdequate = adequateChecked;
              explanation = `Trickiness: ${loss.toFixed(2)} pawn sacrifice from the current evaluation; supported mistakes in ${(evidence.mistakeMass * 100).toFixed(0)}% of database games; ${(evidence.unknown * 100).toFixed(0)}% unknown; ${adequateChecked} adequate defences among ${defences.length} checked; confidence-adjusted benefit ${benefit.toFixed(2)} pawns (up to 3 replies examined)`;
            }
          } catch (error) {
            check();
            log('warning', `Could not assess trickiness for ${move.san}; no practical bonus used.`);
          }
        }
        chosen.reason = explanation;
        const ranked = [...eligible].filter(move => move.uci !== chosen.uci).sort((a, b) => winEvidence(b) - winEvidence(a) || (practicalScores.get(b.uci) ?? -Infinity) - (practicalScores.get(a.uci) ?? -Infinity));
        return verifyWinner([chosen, ...ranked, ...permitted.filter(move => move.uci !== chosen.uci && !ranked.some(other => other.uci === move.uci))]);
      }
      let sound = permitted;
      if (settings.avoidQueenTrades) {
        const keepQueens = sound.filter(move => !allowsImmediateQueenTrade(fen, move.san));
        if (keepQueens.length) sound = keepQueens;
      }
      sound.sort((a, b) => winEvidence(b) - winEvidence(a) || scoreFor(b.score, settings.color) - scoreFor(a.score, settings.color));
      const chosen = sound[0];
      if (!chosen) throw new Error('No verified continuation available.');
      const loss = Math.max(0, current - scoreFor(chosen.score, settings.color));
      chosen.reason = chosen.stats
        ? `Common in your opponent profile; ${loss.toFixed(2)} pawns lost from the current evaluation`
        : 'Best verified candidate within your preferences';
      return verifyWinner(sound);
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
    if (replyLimit < selected.length) {
      const strongestReply = selected.find(move => move.uci === strongest.uci)!;
      const likelyReply = popular[0];
      if (replyLimit === 1 && likelyReply && likelyReply.uci !== strongest.uci) {
        const defense = await candidate(fen, strongest.uci);
        const likely = await candidate(fen, likelyReply.uci);
        // Retain the engine defense if it worsens our position by at least half a pawn.
        selected = [scoreFor(likely.score - defense.score, settings.color) >= 0.5 ? strongestReply : likelyReply];
      } else if (replyLimit <= 2) {
        selected = [strongestReply];
        if (replyLimit >= 2 && likelyReply && likelyReply.uci !== strongest.uci) selected.push(likelyReply);
        if (!likelyReply) selected = top.slice(0, replyLimit).map(move => ({ uci: move.uci, playRate: 0 }));
      }
      else selected = selected.slice(0, replyLimit);
      node.warning = [node.warning, 'Branching reduced by decay or reserved continuation budget.'].filter(Boolean).join(' ');
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

  type Pending = { node: GeneratorNode; likelihood: number; pathProbability: number | null; opponentTurns: number; targetDepth: number; ancestors: Set<string> };
  const queue: Pending[] = [];
  const seedNodes: Array<{ node: GeneratorNode; parent: GeneratorNode }> = [];
  function collect(node: GeneratorNode, ancestors = new Set<string>()) {
    const next = new Set(ancestors).add(positionKey(node.fen));
    const revisitReplies = settings.fillBranchesFromMove !== undefined
      && new Chess(node.fen).turn() !== (settings.color === 'white' ? 'w' : 'b')
      && Number(node.fen.split(' ')[5]) >= settings.fillBranchesFromMove;
    if (!node.children.length || revisitReplies) queue.push({ node, likelihood: 1, pathProbability: 1, opponentTurns: 0, targetDepth: settings.maxMoveNumber * 2, ancestors });
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
      if (!node.isOurMove || (resumeTree && node.stockfish && node.stockfish.depth >= settings.sfDepth)) continue;
      progress(`Checking your move ${node.fullMoveNumber}${settings.color === 'white' ? '.' : '...'} ${node.san} (preserved)`);
      try {
        const reference = await evaluate(parent.fen, settings.sfDepth);
        const actual = await evaluate(node.fen, settings.sfDepth);
        node.stockfish = { eval: actual.score, depth: actual.depth, source: actual.source };
        const drop = scoreFor(reference.score - actual.score, settings.color);
        if (drop > settings.maxEvalLoss) {
          node.warning = `Your move was preserved; engine estimates a ${drop.toFixed(2)} pawn loss against its best continuation.`;
          log('warning', `${node.san}: ${node.warning}`);
        }
      } catch (error) {
        check();
        const reason = error instanceof Error ? error.message : String(error);
        node.warning = `Your move was preserved, but engine verification failed: ${reason}`;
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
      active.endReason = undefined;
      active.cappedByMoveLimit = false;
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
        let replyLimit = Infinity;
        if (!ourTurn && settings.branchDecay !== 'off') {
          replyLimit = decayReplyLimit(settings.branchDecay, item.opponentTurns, item.pathProbability);
          const reserved = queue.reduce((sum, pending) => sum + Math.max(0, pending.targetDepth + settings.tacticalExtension * 2 - pending.node.depth), 0);
          const costPerBranch = Math.max(1, hardDepth - active.depth);
          const affordable = Math.max(1, Math.floor((maxNodes - totalNodes - reserved) / costPerBranch));
          replyLimit = Math.min(replyLimit, affordable);
        }
        const moves = await choose(active.fen, ourTurn, active, replyLimit);
        check();
        const added: Candidate[] = [];
        for (const move of moves) {
          // Existing branches were queued by collect; only create and queue missing replies.
          if (active.children.some(child => child.uci === move.uci)) { added.push(move); continue; }
          if (totalNodes >= maxNodes) { active.endReason = 'budget'; break; }
          const node: GeneratorNode = {
            id: nextNodeId(), san: move.san, uci: move.uci, fen: move.fen,
            children: [], depth: active.depth + 1, fullMoveNumber: Number(active.fen.split(' ')[5]),
            isOurMove: ourTurn, isMainLine: active.children.length === 0,
            isDangerous: !ourTurn && scoreFor(move.score, settings.color) < -0.5,
            cappedByMoveLimit: false, stockfish: { eval: move.score, depth: move.depth, source: move.source },
            lichess: move.stats ? { ...move.stats } : null, reason: move.reason,
          };
          active.children.push(node); added.push(move); totalNodes++;
          const probability = move.stats ? move.stats.playRate / 100 : null;
          const rareReply = !ourTurn && settings.branchDecay === 'off' && settings.adaptiveOpponentDepth && !move.strongestDefense
            && move.stats !== undefined && move.stats.playRate < settings.opponentMinPlayRate;
          // Reduce the overall horizon once, not once per rare move. Always leave
          // room for our answer; tactical extensions still apply at the shorter horizon.
          const targetDepth = rareReply
            ? Math.min(item.targetDepth, Math.max(node.depth + 1, settings.maxMoveNumber * 2 - 4))
            : item.targetDepth;
          queue.push({ node, targetDepth, likelihood: item.likelihood * (ourTurn ? 1 : probability ?? 1), pathProbability: ourTurn ? item.pathProbability : item.pathProbability === null || probability === null ? null : item.pathProbability * probability, opponentTurns: item.opponentTurns + (ourTurn ? 0 : 1), ancestors: new Set(item.ancestors).add(positionKey(active.fen)) });
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
