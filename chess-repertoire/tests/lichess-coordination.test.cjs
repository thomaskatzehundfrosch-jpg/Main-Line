const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(require.resolve('../src/utils/lichessApi.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
function client(fetch, waits, navigator) {
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => {
    if (name === './explorerMove.js') return { normalizeExplorerUci: (_, uci) => uci };
    if (name === './lichessAuth') return { getStoredToken: () => 'test' };
    if (name === './generatorCancellation') return { abortableDelay: async (_, signal) => {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    }, abortError: () => new DOMException('Stopped', 'AbortError') };
    throw Error(name);
  }, URLSearchParams, Date, Response, navigator, fetch, setTimeout: (fn, ms) => {
    waits.push(ms); fn();
  } });
  return exports;
}
const evaluation = () => new Response(JSON.stringify({ depth: 20, pvs: [{ moves: 'e2e4', cp: 20 }] }));
test('move statistics use the authenticated explorer endpoint with the selected filters', async () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const requests = [];
  const api = client(async (url, init) => {
    requests.push({ url: new URL(url), authorization: new Headers(init.headers).get('Authorization') });
    return Response.json({ white: 40, draws: 20, black: 40, moves: [
      { uci: 'c7c5', san: 'c5', white: 10, draws: 5, black: 15 },
    ] });
  }, []);
  const settings = { color: 'white', ratingMin: 2000, ratingMax: 2500, speeds: ['blitz', 'rapid', 'classical'] };

  const [move] = await api.getMostLikelyMoves(fen, { ...settings, useMasters: false }, () => {});
  await api.getMostLikelyMoves(fen, { ...settings, useMasters: true }, () => {});

  assert.deepEqual(requests.map(({ url }) => url.origin + url.pathname), [
    'https://explorer.lichess.org/lichess', 'https://explorer.lichess.org/masters',
  ]);
  for (const { url, authorization } of requests) {
    assert.equal(url.searchParams.get('fen'), fen);
    assert.equal(authorization, 'Bearer test');
  }
  assert.equal(requests[0].url.searchParams.get('ratings'), '2000,2200,2500');
  assert.equal(requests[0].url.searchParams.get('speeds'), 'blitz,rapid,classical');
  assert.equal(requests[1].url.searchParams.has('ratings'), false);
  assert.equal(requests[1].url.searchParams.has('speeds'), false);
  assert.equal(move.san, 'c5');
  assert.equal(move.totalGames, 30);
  assert.equal(move.playRate, 30);
});
test('cloud requests are serialized until the entire body arrives', async () => {
  let release, started = 0;
  const api = client(async () => {
    started++;
    if (started === 1) return { status: 200, headers: {}, statusText: 'OK', arrayBuffer: () => new Promise(resolve => {
      release = () => resolve(new TextEncoder().encode(JSON.stringify({depth:20,pvs:[]})).buffer);
    }) };
    return evaluation();
  }, []);
  const first = api.getCloudEval('one');
  const second = api.getCloudEval('two');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(started, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(started, 2);
});
test('429 holds the shared tab lock for a full-minute cooldown before retrying', async () => {
  const events = [], waits = [];
  let count = 0;
  const api = client(async () => {
    events.push('fetch');
    return ++count === 1 ? new Response('', {status:429}) : evaluation();
  }, waits, { locks: { request: async (name, task) => {
    assert.equal(name, 'main-line-lichess-api');
    events.push('lock');
    const result = await task();
    if (count === 1) assert.deepEqual(waits, [60000]);
    events.push('unlock');
    return result;
  } } });
  assert.equal((await api.getCloudEval('one')).depth, 20);
  assert.deepEqual(events, ['lock','fetch','unlock','lock','fetch','unlock']);
  assert.deepEqual(waits, [60000]);
});
