const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Chess } = require('chess.js');
function compile(source, context) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, ...context });
  return exports;
}
const scheduler = compile(fs.readFileSync(require.resolve('../src/lib/srScheduler.ts'), 'utf8'), { Date, Math });
let source = fs.readFileSync(require.resolve('../src/components/SpacedRepetitionTrainer.tsx'), 'utf8');
source = source.slice(source.indexOf('const INITIAL_FEN'), source.indexOf('const AccuracyComparisonCard'));
const trainer = compile('const sharedPlaceholder = 0;\n' + source + '\nexport { buildCardsForSelection, collapseToDeepestLines, buildPromptSteps };', { Chess, createCard: scheduler.createCard });
function file(id) {
  const chess = new Chess();
  const tree = { move: '', fen: chess.fen(), children: [] };
  let node = tree;
  for (const move of ['e4', 'e5', 'Nf3', 'Nc6']) {
    chess.move(move);
    const child = { move, fen: chess.fen(), children: [] };
    node.children.push(child);
    node = child;
  }
  return { id, name: 'Opening', tree };
}
test('training starts without secure-context crypto and builds playable prompts', () => {
  const cards = trainer.buildCardsForSelection(file('one'), 'white', []);
  assert.equal(cards.length, 2);
  const lines = trainer.collapseToDeepestLines(cards);
  assert.equal(lines.length, 1);
  const prompts = trainer.buildPromptSteps(lines[0], 'white');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].expectedMove, 'e2e4');
  assert.equal(prompts[1].expectedMove, 'g1f3');
});
test('completed lines survive rebuilding and stay isolated by repertoire and color', () => {
  const cards = trainer.buildCardsForSelection(file('one'), 'white', []);
  const reviewed = cards.map(card => scheduler.reviewCard(card, 2));
  const rebuilt = trainer.buildCardsForSelection(file('one'), 'white', reviewed);
  assert.ok(rebuilt.every(card => card.lastReviewed && card.repetitions === 1));
  assert.ok(trainer.buildCardsForSelection(file('two'), 'white', reviewed).every(card => card.lastReviewed === null));
  assert.ok(trainer.buildCardsForSelection(file('one'), 'both', reviewed).every(card => card.lastReviewed === null));
});
