const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
const { Chess } = require('chess.js');
const { parsePGN, exportGeneratorPGN } = require('../src/utils/generatorPgn.ts');
const { buildSeedTree } = require('../src/utils/generatorSeeds.ts');
const { convertToTreeNode } = require('../src/utils/generatorConverter.ts');
const { buildTree, selectOpponentReplies, allowsImmediateQueenTrade } = require('../src/engine/generatorTreeBuilder.ts');
const { DEFAULT_GENERATOR_SETTINGS, normalizeGeneratorSettings } = require('../src/types/generator.ts');
const { analyzePositionWithStockfish, getTopMovesWithStockfish } = require('../src/engine/analyzer.ts');
const defaults = { ...DEFAULT_GENERATOR_SETTINGS, analysisMode: 'stockfish', maxMoveNumber: 1, tacticalExtension: 0, sfDepth: 12, studySize: 'compact' };
const dummyWorker = {};
const uci = move => move.from + move.to + (move.promotion ?? '');
function services(overrides = {}) {
  return {
    analyze: async (_worker, fen, depth) => ({ score: 0, depth, fen, bestMoveUci: '', bestMoveSan: '', isMate: false, mateIn: null }),
    topMoves: async (_worker, fen, depth, count) => new Chess(fen).moves({ verbose: true }).slice(0, count).map(move => ({ uci: uci(move), eval: 0, depth })),
    replies: async () => [], ...overrides,
  };
}
function walk(root) { return [root, ...root.children.flatMap(walk)]; }
function paths(root, moveField = 'san', prefix = []) {
  if (!root.children.length) return prefix.length ? [prefix.join(' ')] : [];
  return root.children.flatMap(child => paths(child, moveField, [...prefix, child[moveField]]));
}

// Input, preview and output must describe exactly the same legal lines.
test('PGN compact parentheses, nested alternatives, comments and multiple games', () => {
  const lines = parsePGN('[Event "One"]\n\n1.e4 e5 (1...c5 (1...e6) 2.Nf3) 2.Nf3 {note} *\n\n[Event "Two"]\n\n1.d4 d5 *');
  assert.equal(lines[0].join(' '), 'e4 e5 Nf3');
  assert.deepEqual(new Set(lines.map(l => l.join(' '))), new Set(['e4 e5 Nf3', 'e4 c5 Nf3', 'e4 e6', 'd4 d5']));
});
test('invalid moves and custom FEN fail explicitly without partial import', () => {
  assert.throws(() => parsePGN('1.e4 e5 2.Qh8 *'));
  assert.throws(() => parsePGN('[SetUp "1"]\n[FEN "8/8/8/8/8/8/4K3/7k w - - 0 1"]\n\n1.Kf3 *'), /custom FEN/);
  assert.throws(() => buildSeedTree([['e4'], ['d4', 'bad']], 'white'), /illegal move/);
});
test('all own alternatives and transpositions survive PGN and import', () => {
  const lines = [['Nf3', 'Nf6', 'g3', 'g6', 'Bg2'], ['g3', 'g6', 'Nf3', 'Nf6', 'd4'], ['e4', 'e5']];
  const tree = buildSeedTree(lines, 'white');
  assert.deepEqual(new Set(parsePGN(exportGeneratorPGN(tree, { color: 'white' })).map(l => l.join(' '))), new Set(lines.map(l => l.join(' '))));
  assert.deepEqual(paths(convertToTreeNode(tree), 'move'), paths(tree));
});
test('black win statistics retain their actual color on import', () => {
  const root = buildSeedTree([['e4', 'e5']], 'black');
  root.children[0].lichess = { totalGames: 100, winRate: 60, lossRate: 20, drawRate: 20, averageRating: null };
  const node = convertToTreeNode(root, null, true, 'black').children[0];
  assert.equal(node.whiteWins, 20); assert.equal(node.blackWins, 60);
});
test('settings accept zero evaluation loss and repair invalid bounds', () => {
  const s = normalizeGeneratorSettings({ ...defaults, maxEvalLoss: 0, ratingMin: 2500, ratingMax: 1000, speeds: [], maxMoveNumber: Infinity });
  assert.equal(s.maxEvalLoss, 0); assert.equal(s.ratingMin, 1000); assert.equal(s.ratingMax, 2500);
  assert.ok(s.speeds.length); assert.equal(s.maxMoveNumber, 15);
});
test('seeds are preserved even when badly evaluated; duplicate prefixes merge', async () => {
  const root = await buildTree([['e4', 'e5'], ['e4']], defaults, {}, { current: false }, dummyWorker,
    services({ analyze: async (_w, fen, depth) => ({ score: fen.split(' ')[1] === 'b' ? -900 : 0, depth }) }));
  assert.equal(root.children.length, 1); assert.equal(root.children[0].san, 'e4');
  assert.equal(root.children[0].children[0].san, 'e5');
  assert.match(root.children[0].warning, /preserved/);
});
test('a losing position still gets its best available continuation', async () => {
  const root = await buildTree(null, defaults, {}, { current: false }, dummyWorker,
    services({ analyze: async (_w, _fen, depth) => ({ score: -800, depth }) }));
  assert.equal(root.children.length, 1); assert.ok(root.children[0].children.length);
});
test('common mistakes remain included and strongest defense is mandatory', () => {
  const chosen = selectOpponentReplies([{ uci: 'mistake', playRate: 65 }, { uci: 'normal', playRate: 30 }], { uci: 'best', playRate: 0 }, .7, 3);
  assert.deepEqual(new Set(chosen.map(m => m.uci)), new Set(['mistake', 'normal', 'best']));
});
test('queen preference recognises opponent queen capture and recapture', () => {
  const fen = '3r2k1/8/8/3q4/8/8/3Q4/3R2K1 w - - 0 1';
  assert.equal(allowsImmediateQueenTrade(fen, 'Qxd5+'), true);
  assert.equal(allowsImmediateQueenTrade(fen, 'Kh2'), true);
});
test('tactical extensions actually pass the normal target and stop at a hard bound', async () => {
  const settings = { ...defaults, maxMoveNumber: 2, tacticalExtension: 1 };
  const seeds = [['e4', 'e5', 'Qh5', 'Nc6']];
  const root = await buildTree(seeds, settings, {}, { current: false }, dummyWorker, services());
  assert.ok(walk(root).some(n => n.depth > 4));
  assert.ok(walk(root).every(n => n.depth <= 6));
  const noExtension = await buildTree(seeds, { ...settings, tacticalExtension: 0 }, {}, { current: false }, dummyWorker, services());
  assert.equal(Math.max(...walk(noExtension).map(n => n.depth)), 4);
});
test('budget exhaustion is partial, marked, and never destroys long seed lines', async () => {
  let progress;
  const root = await buildTree(null, { ...defaults, maxMoveNumber: 10 }, { onProgress: p => progress = p }, { current: false }, dummyWorker, services());
  assert.equal(walk(root).length - 1, 150); assert.equal(progress.outcome, 'partial');
  assert.ok(walk(root).some(n => n.endReason === 'budget'));
  assert.ok(progress.unfinished > 0);
});
test('engine failure leaves an explained unfinished position instead of complete', async () => {
  let progress;
  const root = await buildTree(null, defaults, { onProgress: p => progress = p }, { current: false }, dummyWorker,
    services({ topMoves: async () => { throw new Error('engine unavailable'); } }));
  assert.equal(root.endReason, 'analysis-failed'); assert.equal(progress.outcome, 'partial');
});
test('stopping during analysis publishes no late moves and reports stopped', async () => {
  let release;
  let started;
  const pending = new Promise(resolve => release = resolve);
  const entered = new Promise(resolve => started = resolve);
  const controller = new AbortController();
  const stop = { current: false, signal: controller.signal };
  let progress;
  const result = buildTree(null, defaults, { onProgress: p => progress = p }, stop, dummyWorker,
    services({ topMoves: async () => { started(); await pending; return [{ uci: 'e2e4', eval: 0, depth: 12 }]; } }));
  await entered; stop.current = true; controller.abort(); release();
  const tree = await result;
  assert.equal(tree.children.length, 0); assert.equal(tree.endReason, 'stopped'); assert.equal(progress.outcome, 'stopped');
});
test('terminal seeds finish without asking engine for an illegal continuation', async () => {
  const root = await buildTree([['f3', 'e5', 'g4', 'Qh4#']], { ...defaults, maxMoveNumber: 10 }, {}, { current: false }, dummyWorker, services());
  assert.equal(walk(root).at(-1).endReason, 'terminal');
});

class WorkerStub extends EventTarget {
  constructor() { super(); this.commands = []; }
  postMessage(message) { this.commands.push(message); }
}
test('local engine cancellation rejects immediately for single and multi PV', async () => {
  global.window = global;
  for (const multipv of [1, 3]) {
    const worker = new WorkerStub(); const controller = new AbortController();
    const task = multipv === 1 ? analyzePositionWithStockfish(worker, new Chess().fen(), 12, controller.signal)
      : getTopMovesWithStockfish(worker, new Chess().fen(), 12, multipv, 90000, controller.signal);
    controller.abort();
    await assert.rejects(task, error => error.name === 'AbortError');
    assert.equal(worker.commands.at(-1), 'stop');
  }
});

test('relative loss guard rejects a popular inferior move for either color', async () => {
  for (const color of ['white', 'black']) {
    const root = await buildTree(color === 'black' ? [['e4']] : null,
      { ...defaults, color, analysisMode: 'lichess+stockfish', maxEvalLoss: 0 }, {}, { current: false }, dummyWorker, services({
        topMoves: async (_w, fen, depth, count) => new Chess(fen).moves({ verbose: true }).slice(0, count).map(m => ({ uci: uci(m), eval: 0, depth })),
        replies: async fen => {
          const m = new Chess(fen).moves({ verbose: true })[1];
          return [{ san: m.san, uci: uci(m), totalGames: 100, playRate: 99, winRate: 60, lossRate: 20, drawRate: 20, averageRating: null }];
        },
        analyze: async (_w, fen, depth) => {
          // Give the most popular move a worse score based on its resulting position.
          const base = new Chess(); if (color === 'black') base.move('e4');
          const alternate = base.moves({ verbose: true })[1]; base.move(alternate);
          return { score: fen === base.fen() ? (color === 'white' ? -100 : 100) : 0, depth };
        },
      }));
    const parent = color === 'white' ? root : root.children[0];
    const best = new Chess(parent.fen).moves({ verbose: true })[0];
    assert.equal(parent.children[0].uci, uci(best));
  }
});
test('local coverage uses full database frequency, not a renormalized shortlist', async () => {
  let progress;
  const root = await buildTree([['e4']], { ...defaults, analysisMode: 'lichess+stockfish' }, { onProgress: p => progress = p }, { current: false }, dummyWorker, services({
    replies: async fen => new Chess(fen).moves({ verbose: true }).slice(0, 3).map((m, i) => ({ san: m.san, uci: uci(m), totalGames: 100, playRate: [10, 20, 25][i], winRate: 50, lossRate: 30, drawRate: 20, averageRating: null })),
  }));
  assert.equal(root.children[0].responseCoverage, .55);
  assert.equal(progress.averageResponseCoverage, .55);
  assert.equal(progress.outcome, 'partial');
  assert.equal(progress.coverageGaps, 1);
  assert.match(root.children[0].warning, /coverage/);
});
test('seeds exceeding the budget are retained, and the result is marked partial', async () => {
  const seedLines = [];
  const chess = new Chess();
  for (const first of chess.moves()) {
    const after = new Chess(); after.move(first);
    for (const second of after.moves()) seedLines.push([first, second]);
  }
  let progress;
  const root = await buildTree(seedLines, { ...defaults, maxMoveNumber: 3 }, { onProgress: p => progress = p }, { current: false }, dummyWorker, services());
  assert.equal(paths(root).length, seedLines.length);
  assert.equal(progress.outcome, 'partial'); assert.ok(progress.nodes > progress.maxNodes);
});
test('all generated edges are legal and cached transpositions retain their own move counters', async () => {
  const root = await buildTree([['Nf3', 'Nf6', 'g3', 'g6'], ['g3', 'g6', 'Nf3', 'Nf6']], { ...defaults, maxMoveNumber: 3 }, {}, { current: false }, dummyWorker, services());
  for (const parent of walk(root)) for (const child of parent.children) {
    const chess = new Chess(parent.fen); chess.move(child.san); assert.equal(child.fen, chess.fen());
  }
});

test('failed reply verification cannot claim coverage for branches that were not added', async () => {
  let progress;
  const root = await buildTree([['e4']], { ...defaults, analysisMode: 'lichess+stockfish' }, { onProgress: p => progress = p }, { current: false }, dummyWorker, services({
    analyze: async () => { throw new Error('verification failed'); },
    replies: async fen => {
      const move = new Chess(fen).moves({ verbose: true })[0];
      return [{ san: move.san, uci: uci(move), totalGames: 100, playRate: 100, winRate: 50, lossRate: 30, drawRate: 20, averageRating: null }];
    },
  }));
  assert.equal(root.children[0].children.length, 0);
  assert.equal(root.children[0].responseCoverage, 0);
  assert.equal(progress.averageResponseCoverage, 0);
  assert.equal(progress.outcome, 'partial');
});


test('frequency threshold overrides both coverage and reply caps, including equality', () => {
  const popular = [{ uci: 'best', playRate: 90 }, { uci: 'common', playRate: 5 }, { uci: 'rare', playRate: 4 }];
  assert.deepEqual(selectOpponentReplies(popular, popular[0], .7, 1, 5).map(m => m.uci), ['best', 'common']);
  const many = Array.from({ length: 10 }, (_, i) => ({ uci: String(i), playRate: 10 }));
  assert.equal(selectOpponentReplies(many, many[0], .7, 3, 5).length, 10);
});
test('opponent frequency settings normalize missing and out-of-range values', () => {
  assert.equal(normalizeGeneratorSettings({ ...defaults, opponentMinPlayRate: undefined }).opponentMinPlayRate, 5);
  assert.equal(normalizeGeneratorSettings({ ...defaults, opponentMinPlayRate: 0 }).opponentMinPlayRate, 1);
  assert.equal(normalizeGeneratorSettings({ ...defaults, opponentMinPlayRate: 101 }).opponentMinPlayRate, 100);
});
test('frequent inferior opponent replies survive the evaluation guard for either color', async () => {
  for (const color of ['white', 'black']) {
    const position = new Chess(); if (color === 'white') position.move('e4');
    const moves = position.moves({ verbose: true });
    const root = await buildTree(color === 'white' ? [['e4']] : null,
      { ...defaults, color, analysisMode: 'lichess+stockfish', maxEvalLoss: 0 }, {}, { current: false }, dummyWorker, services({
        replies: async fen => fen === position.fen() ? moves.slice(0, 5).map((m, i) => ({ san: m.san, uci: uci(m), totalGames: 100, playRate: i === 0 ? 80 : 5, winRate: 50, lossRate: 30, drawRate: 20, averageRating: null })) : [],
        analyze: async (_w, _fen, depth) => ({ score: color === 'white' ? 100 : -100, depth }),
      }));
    const parent = color === 'white' ? root.children[0] : root;
    assert.equal(parent.children.length, 5);
    assert.ok(parent.children.some(n => n.uci === uci(moves[4])));
  }
});
test('adaptive depth shortens only rare additional replies and can be disabled', async () => {
  const start = new Chess(); start.move('e4');
  for (const adaptive of [true, false]) {
    const root = await buildTree([['e4']], { ...defaults, analysisMode: 'lichess+stockfish', studySize: 'broad', maxMoveNumber: 4, opponentMinPlayRate: 10, adaptiveOpponentDepth: adaptive }, {}, { current: false }, dummyWorker, services({
      topMoves: async (_w, fen, depth) => {
        const chess = new Chess(fen);
        const move = fen === start.fen() ? chess.moves({ verbose: true }).find(m => m.san === 'e5') : chess.moves({ verbose: true })[0];
        return [{ uci: uci(move), eval: 0, depth }];
      },
      replies: async fen => fen === start.fen() ? ['e5', 'c5', 'e6'].map((san, i) => {
        const chess = new Chess(fen); const move = chess.move(san);
        return { san, uci: uci(move), totalGames: 100, playRate: [5, 85, 5][i], winRate: 50, lossRate: 30, drawRate: 20, averageRating: null };
      }) : [],
    }));
    const branches = root.children[0].children;
    for (const san of ['e5', 'c5', 'e6']) {
      const branch = branches.find(n => n.san === san);
      assert.ok(branch, san);
      const expected = adaptive && san === 'e6' ? 4 : 8;
      assert.equal(Math.max(...walk(branch).map(n => n.depth)), expected, san);
      if (adaptive && san === 'e6') assert.ok(walk(branch).some(n => n.endReason === 'adaptive-depth'));
    }
  }
});

test('trickiness settings default off and normalize the sacrifice interval', () => {
  const settings = normalizeGeneratorSettings({ ...defaults, trickiness: undefined, trickinessMinLoss: 1.2, trickinessMaxLoss: .2 });
  assert.equal(settings.trickiness, 'off');
  assert.equal(settings.trickinessMinLoss, .2);
  assert.equal(settings.trickinessMaxLoss, 1.2);
  const repaired = normalizeGeneratorSettings({ ...defaults, trickinessMinLoss: -1, trickinessMaxLoss: Infinity });
  assert.equal(repaired.trickinessMinLoss, 0);
  assert.equal(repaired.trickinessMaxLoss, .6);
});

test('trickiness respects color, interval, evidence, and strength setting', async () => {
  for (const color of ['white', 'black']) {
    const start = new Chess(); if (color === 'black') start.move('e4');
    const legal = start.moves({ verbose: true });
    const safe = legal[0], tricky = legal[1];
    const afterTricky = new Chess(start.fen()); afterTricky.move(tricky);
    const humanReply = afterTricky.moves({ verbose: true })[0];
    const afterMistake = new Chess(afterTricky.fen()); afterMistake.move(humanReply);
    for (const scenario of [
      { mode: 'high', min: .4, max: .4, games: 10000, expected: tricky },
      { mode: 'balanced', min: 0, max: .6, games: 10000, expected: safe },
      { mode: 'off', min: 0, max: .6, games: 10000, expected: safe },
      { mode: 'high', min: 0, max: .3, games: 10000, expected: safe },
      { mode: 'high', min: .5, max: 1, games: 10000, expected: safe },
      { mode: 'high', min: 0, max: .6, games: 10, expected: safe },
      { mode: 'high', min: 0, max: .6, games: 0, expected: safe },
    ]) {
      const root = await buildTree(color === 'black' ? [['e4']] : null,
        { ...defaults, color, analysisMode: 'lichess+stockfish', maxEvalLoss: 0, trickiness: scenario.mode, trickinessMinLoss: scenario.min, trickinessMaxLoss: scenario.max }, {}, { current: false }, dummyWorker, services({
          topMoves: async (_w, fen, depth, count) => (fen === start.fen() ? [safe, tricky] : new Chess(fen).moves({ verbose: true })).slice(0, count).map(m => ({ uci: uci(m), eval: 0, depth })),
          analyze: async (_w, fen, depth) => ({ score: (fen === afterTricky.fen() ? -40 : fen === afterMistake.fen() ? 20 : 0) * (color === 'white' ? 1 : -1), depth }),
          replies: async fen => fen === afterTricky.fen() && scenario.games ? [{ san: humanReply.san, uci: uci(humanReply), totalGames: scenario.games, playRate: 100, winRate: 90, lossRate: 5, drawRate: 5, averageRating: null }] : [],
        }));
      const parent = color === 'black' ? root.children[0] : root;
      assert.equal(parent.children[0].uci, uci(scenario.expected), `${color} ${JSON.stringify(scenario)}`);
      if (scenario.expected === tricky) assert.match(parent.children[0].reason, /Trickiness: 0.40 pawn sacrifice/);
    }
  }
});

test('trickiness cancellation during reply analysis adds no late candidate', async () => {
  const stop = { current: false };
  const initial = new Chess().fen();
  let progress;
  const root = await buildTree(null, { ...defaults, analysisMode: 'lichess+stockfish', trickiness: 'high' }, { onProgress: p => progress = p }, stop, dummyWorker, services({
    replies: async fen => {
      if (fen !== initial) stop.current = true;
      return [];
    },
  }));
  assert.equal(root.children.length, 0);
  assert.equal(progress.outcome, 'stopped');
});

test('current-position loss limit holds for both colors and all trickiness modes', async () => {
  for (const color of ['white', 'black']) for (const mode of ['off', 'balanced', 'high']) {
    for (const afterScore of [50, 49]) {
      const start = new Chess(); if (color === 'black') start.move('e4');
      let progress;
      const root = await buildTree(color === 'black' ? [['e4']] : null,
        { ...defaults, color, analysisMode: 'lichess+stockfish', maxEvalLoss: .5, trickiness: mode, trickinessMaxLoss: .5 },
        { onProgress: p => progress = p }, { current: false }, dummyWorker, services({
          analyze: async (_w, fen, depth) => ({ score: (fen === start.fen() ? 100 : afterScore) * (color === 'white' ? 1 : -1), depth }),
        }));
      const parent = color === 'black' ? root.children[0] : root;
      if (afterScore === 50) assert.ok(parent.children.length, `${color} ${mode}: exact boundary accepted`);
      else {
        assert.equal(parent.children.length, 0, `${color} ${mode}: fallback must not bypass limit`);
        assert.match(parent.warning, /loss limit from the current evaluation/);
        assert.equal(progress.outcome, 'partial');
      }
    }
  }
});
