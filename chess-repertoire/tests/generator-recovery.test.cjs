const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
const { createRecyclingWorkerSession } = require('../src/engine/recyclingWorker.ts');
const { readGeneratorCheckpoint, saveGeneratorCheckpoint } = require('../src/utils/generatorCheckpoint.ts');
const { buildSeedTree } = require('../src/utils/generatorSeeds.ts');
const { DEFAULT_GENERATOR_SETTINGS } = require('../src/types/generator.ts');
const fake = () => ({ terminated: 0, terminate() { this.terminated++; } });

test('worker rotation happens between searches and releases old worker before allocating its replacement', async () => {
  const first = fake(), second = fake(), owned = [];
  let finish;
  const search = createRecyclingWorkerSession(first, async () => {
    assert.equal(first.terminated, 1); return second;
  }, worker => owned.push(worker), new AbortController().signal, { searches: 1, milliseconds: Infinity });
  const pending = search(async worker => { assert.equal(worker, first); await new Promise(resolve => { finish = resolve; }); return 7; });
  assert.equal(first.terminated, 0, 'Active search is not terminated');
  finish(); assert.equal(await pending, 7);
  assert.equal(await search(async worker => worker), second);
  assert.deepEqual(owned, [null, second]);
});

test('worker rotates on elapsed time even below search-count limit', async () => {
  let now = 0;
  const first = fake(), second = fake();
  const search = createRecyclingWorkerSession(first, async () => second, () => {}, new AbortController().signal,
    { searches: 40, milliseconds: 120000 }, () => now);
  await search(async () => {}); now = 120000;
  assert.equal(await search(async worker => worker), second);
  assert.equal(first.terminated, 1);
});

test('cancellation during replacement startup terminates late worker and never starts a search', async () => {
  const controller = new AbortController(), first = fake(), replacement = fake();
  let resolve;
  const search = createRecyclingWorkerSession(first, () => new Promise(done => { resolve = done; }), () => {}, controller.signal,
    { searches: 0, milliseconds: Infinity });
  let called = false;
  const pending = search(async () => { called = true; });
  controller.abort(); resolve(replacement);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(called, false); assert.equal(replacement.terminated, 1);
});

test('a failed search releases its worker and the next request uses a fresh engine', async () => {
  const first = fake(), second = fake();
  const search = createRecyclingWorkerSession(first, async () => second, () => {}, new AbortController().signal);
  await assert.rejects(search(async () => { throw new Error('timeout'); }), /timeout/);
  assert.equal(first.terminated, 1);
  assert.equal(await search(async worker => worker), second);
});

test('checkpoint round trips tree metadata and settings; corrupt or blocked storage is safe', () => {
  let data;
  const storage = { setItem: (_key, value) => { data = value; }, getItem: () => data };
  const tree = buildSeedTree([['e4', 'e5']], 'white');
  tree.children[0].warning = 'Preserved note';
  assert.ok(saveGeneratorCheckpoint(tree, DEFAULT_GENERATOR_SETTINGS, storage));
  const recovered = readGeneratorCheckpoint(storage);
  assert.deepEqual(recovered.tree, tree);
  assert.equal(recovered.settings.sfDepth, DEFAULT_GENERATOR_SETTINGS.sfDepth);
  data = '{broken'; assert.equal(readGeneratorCheckpoint(storage), null);
  data = JSON.stringify({ version: 1, tree: { isRoot: true, children: [null] }, settings: { speeds: [] }, savedAt: 'now' });
  assert.equal(readGeneratorCheckpoint(storage), null);
  assert.equal(saveGeneratorCheckpoint(tree, DEFAULT_GENERATOR_SETTINGS, { setItem() { throw Error('quota'); } }), null);
});
