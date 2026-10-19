const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function setup() {
  const records = new Map();
  let failRead = false;
  const ref = (...parts) => ({ path: parts.flatMap(p => typeof p === 'string' ? [p] : p.path ? [p.path] : []).join('/') });
  const snapshot = (path, value) => ({ id: path.split('/').at(-1), ref: { path }, data: () => value, exists: () => value !== undefined });
  const api = {
    Bytes: { fromUint8Array: value => ({ toUint8Array: () => value }) },
    doc: ref, collection: ref,
    getDocs: async ({ path }) => {
      if (failRead) throw new Error('permission-denied');
      const docs = [...records].filter(([key]) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(([key, value]) => snapshot(key, value));
      return { docs, empty: !docs.length };
    },
    getDoc: async ({ path }) => snapshot(path, records.get(path)),
    setDoc: async ({ path }, value) => { records.set(path, value); },
    writeBatch: () => {
      const changes = [];
      return {
        set: (ref, value) => changes.push([ref.path, value]),
        delete: ref => changes.push([ref.path, undefined]),
        commit: async () => { changes.forEach(([key, value]) => value === undefined ? records.delete(key) : records.set(key, value)); },
      };
    },
  };
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../src/lib/firebaseSync.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => name === './firebase' ? { db: {} } : api, TextEncoder, TextDecoder, Uint8Array, console });
  return { sync: exports, records, failReads: () => { failRead = true; } };
}
function file(tree = {}) { return { id: 'rep/one', name: 'Test', tree, nodeCount: 1, createdAt: '2026-10-19', updatedAt: '2026-10-19' }; }

test('large Unicode repertoires round-trip in bounded binary chunks', async () => {
  const { sync, records } = setup();
  const value = file({ comment: '♟🌲'.repeat(200_000) });
  await sync.upsertRemoteFile('alice', value);
  const chunks = [...records.values()].filter(value => value.payload);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.payload.toUint8Array().length <= 400_000));
  assert.deepEqual(JSON.parse(JSON.stringify(await sync.fetchRemoteFiles('alice'))), [value]);
  assert.equal((await sync.fetchRemoteFiles('bob')).length, 0);
});
test('shrinking then deleting a repertoire removes obsolete chunks', async () => {
  const { sync, records } = setup();
  await sync.upsertRemoteFile('alice', file({ text: 'x'.repeat(900_000) }));
  await sync.upsertRemoteFile('alice', file());
  assert.equal([...records.values()].filter(value => value.payload).length, 1);
  await sync.deleteRemoteFile('alice', 'rep/one');
  assert.equal(records.size, 0);
});
test('failed fetches reject rather than returning an empty account', async () => {
  const { sync, failReads } = setup();
  failReads();
  await assert.rejects(sync.fetchRemoteFiles('alice'), /permission-denied/);
});
test('queued saves use the snapshot at invocation and the last save wins', async () => {
  const { sync } = setup();
  const first = file({ text: 'original' });
  const pending = sync.upsertRemoteFile('alice', first);
  first.tree.text = 'changed after save';
  await pending;
  assert.equal((await sync.fetchRemoteFiles('alice'))[0].tree.text, 'original');
  await Promise.all([sync.upsertRemoteFile('alice', file({ text: 'a' })), sync.upsertRemoteFile('alice', file({ text: 'b' }))]);
  assert.equal((await sync.fetchRemoteFiles('alice'))[0].tree.text, 'b');
});
test('empty training card save clears the previous cards', async () => {
  const { sync } = setup();
  await sync.saveAllRemoteCards('alice', [{ id: 'card' }]);
  await sync.saveAllRemoteCards('alice', []);
  assert.equal((await sync.fetchRemoteCards('alice')).length, 0);
});
test('oversized saves fail before replacing the existing remote file', async () => {
  const { sync } = setup();
  await sync.upsertRemoteFile('alice', file({ text: 'safe' }));
  await assert.rejects(sync.upsertRemoteFile('alice', file({ text: 'x'.repeat(8_000_001) })), /8 MB/);
  assert.equal((await sync.fetchRemoteFiles('alice'))[0].tree.text, 'safe');
});
