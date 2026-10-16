const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const { Chess } = require('chess.js');
const { createLabPreview } = require('../src/openingLab/preview.ts');

test('preview branches never mutate the saved repertoire, including existing alternatives', () => {
  const board = new Chess();
  const root = { id: 'root', move: '', fen: board.fen(), parentId: null, children: [], depth: 0, nags: [], comment: '' };
  board.move('d4');
  root.children.push({ ...root, id: 'saved-d4', parentId: 'root', children: [], move: 'd4', fen: board.fen(), depth: 1 });
  const before = structuredClone(root);
  board.reset();
  const line = ['e4', 'e5', 'Nf3'].map(move => { board.move(move); return { move, fen: board.fen() }; });
  const preview = createLabPreview(root, 'root', line);
  assert.deepEqual(root, before);
  assert.equal(preview.tree.children[0].id, 'saved-d4');
  assert.deepEqual(preview.nodes.map(n => n.move), ['e4', 'e5', 'Nf3']);
  assert.equal(preview.nodes[2].parentId, preview.nodes[1].id);
  assert.ok(preview.nodes.every(n => n._labPreview));
  assert.equal(createLabPreview(root, 'missing', line).tree, root);
  assert.equal(createLabPreview(root, 'root', []).tree, root);
});
