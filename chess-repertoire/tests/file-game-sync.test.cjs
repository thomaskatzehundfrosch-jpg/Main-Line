const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function setup(signedIn, original = false) {
  let state = { files: [{ id: 'one', importedGames: [], updatedAt: 'original' }], activeFileId: 'one' };
  let saves = 0, dispatches = 0;
  const exports = {};
  const react = {
    createContext: () => ({}), useCallback: fn => fn,
    useContext: () => ({ state, dispatch, isSyncing: false }),
  };
  function dispatch(action) { dispatches++; state = exports.fileReducer(state, action); }
  let source = fs.readFileSync(require.resolve('../src/context/FileContext.tsx'), 'utf8');
  source = source.replaceAll('import.meta.env.DEV', 'false');
  if (original) source = source.replace('if (!existing || existing.importedGames === games) return;', '')
    .replace('if (!state.files.some(f => f.id === action.id && f.importedGames !== action.games)) return state;', '');
  source += '\nexport { fileReducer };';
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
  } }).outputText;
  vm.runInNewContext(compiled, { exports, require: name => {
    if (name === 'react') return react;
    if (name === './AuthContext') return { useAuth: () => ({ user: signedIn ? { id: 'user' } : null }) };
    if (name === '../lib/firebaseSync') return { upsertRemoteFile: () => { saves++; return new Promise(() => {}); } };
    return {};
  }, console });
  return { exports, get state() { return state; }, get saves() { return saves; }, get dispatches() { return dispatches; } };
}

for (const signedIn of [false, true]) {
  test(`game sync converges with slow cloud writes (signed in: ${signedIn})`, () => {
    const app = setup(signedIn);
    const games = [{ id: 'game', moves: ['e4'] }];
    // A new file list recreates the callback, triggering App's sync effect again.
    // Keep cloud writes pending to model the backlog that retained snapshots.
    for (let render = 0; render < 1000; render++) app.exports.useFiles().updateFileGames('one', games);
    assert.equal(app.dispatches, 1);
    assert.equal(app.saves, signedIn ? 1 : 0);
    assert.equal(app.state.files[0].importedGames, games);
    app.exports.useFiles().updateFileGames('one', [...games, { id: 'second' }]);
    assert.equal(app.dispatches, 2, 'Actual changes still save');
    app.exports.useFiles().updateFileGames('missing', games);
    assert.equal(app.dispatches, 2);
  });
}
test('reducer preserves state for unchanged games and missing files', () => {
  const app = setup(false), state = app.state;
  assert.equal(app.exports.fileReducer(state, { type: 'UPDATE_FILE_GAMES', id: 'one', games: state.files[0].importedGames }), state);
  assert.equal(app.exports.fileReducer(state, { type: 'UPDATE_FILE_GAMES', id: 'missing', games: [] }), state);
});
test('previous callback queues a cloud snapshot on every repeated effect', () => {
  const app = setup(true, true), games = [{ id: 'game' }];
  for (let render = 0; render < 1000; render++) app.exports.useFiles().updateFileGames('one', games);
  assert.equal(app.saves, 1000);
});
