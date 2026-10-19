const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Chess } = require('chess.js');
const { normalizeExplorerUci } = require('../src/utils/explorerMove.js');

for (const side of ['w', 'b']) {
  const rank = side === 'w' ? '1' : '8';
  const fen = `r3k2r/8/8/8/8/8/8/R3K2R ${side} KQkq - 0 1`;
  test(`normalizes legal ${side} castling on both wings without changing ordinary moves`, () => {
    for (const [rook, destination, san] of [['h', 'g', 'O-O'], ['a', 'c', 'O-O-O']]) {
      const result = normalizeExplorerUci(fen, `e${rank}${rook}${rank}`);
      assert.equal(result, `e${rank}${destination}${rank}`);
      assert.equal(new Chess(fen).move({ from: result.slice(0, 2), to: result.slice(2, 4) }).san, san);
      assert.equal(normalizeExplorerUci(fen, result), result);
    }
    assert.equal(normalizeExplorerUci(fen, `a${rank}a4`), `a${rank}a4`);
    assert.equal(normalizeExplorerUci(fen.replace('KQkq', '-'), `e${rank}h${rank}`), `e${rank}h${rank}`);
  });
}

test('all explorer lookup paths normalize black castling and preserve its frequency', async () => {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../src/utils/lichessApi.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => {
    if (name === './explorerMove.js') return { normalizeExplorerUci };
    if (name === './lichessAuth') return { getStoredToken: () => 'test' };
    if (name === './generatorCancellation') return { abortableDelay: async () => {}, abortError: () => Error('aborted') };
    throw Error(name);
  }, URLSearchParams, Date, fetch: async () => ({ ok: true, status: 200,
    json: async () => ({ white: 40, draws: 20, black: 40, moves: [
      { uci: 'e8h8', san: 'O-O', white: 40, draws: 20, black: 40 },
    ] }),
  }) });
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1';
  const settings = { color: 'white', ratingMin: 1800, ratingMax: 2200, speeds: ['rapid'] };
  for (const method of ['getMostLikelyMoves', 'getMostPlayedMoves', 'getMostLikelyMove']) {
    const result = await exports[method](fen, settings, () => {});
    const move = Array.isArray(result) ? result[0] : result;
    assert.equal(move.uci, 'e8g8');
    assert.equal(move.san, 'O-O');
    assert.equal(move.playRate, 100);
    assert.equal(move.totalGames, 100);
  }
});
