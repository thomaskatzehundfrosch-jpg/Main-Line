const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Chess } = require('chess.js');

function harness(cloud = null, suspended = false) {
  const effects = [], timers = [], actions = [], commands = [];
  const state = { enabled: true, depth: 20, multiPV: 3, threads: 1 };
  let created = 0, terminated = 0;
  const worker = { postMessage: (c) => commands.push(c), terminate() { terminated++; } };
  const context = { exports: {}, console, navigator: { hardwareConcurrency: 1 },
    Worker: function () { created++; return worker; },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    require: (name) => {
      if (name === 'react') return { useRef: (current) => ({ current }), useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn) };
      if (name === 'chess.js') return { Chess };
      if (name.includes('EngineContext')) return { useEngineContext: () => ({ state, dispatch: (a) => actions.push(a) }) };
      if (name.includes('lichessApi')) return { getCloudEval: async () => cloud };
      if (name.includes('errorLogger')) return { logger: { error() {}, info() {} } };
      return { STOCKFISH_WORKER_URL: 'stockfish.js' };
    } };
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/hooks/useEngine.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  const engine = context.exports.useEngine(suspended);
  const cleanups = effects.map((fn) => fn());
  return { engine, worker, actions, commands, timers, cleanups, counts: () => ({ created, terminated }) };
}
const tick = () => new Promise(setImmediate);
const info = (pv) => `info depth 15 multipv 1 score cp 20 pv ${pv}`;

test('main view starts analysis on worker readiness and restarts after generation without a position change', () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/components/App.tsx'), 'utf8');
  const marker = source.indexOf('// Analyze position when current node or game viewer position changes');
  assert.ok(marker >= 0);
  const effect = source.slice(marker).match(/useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/)[0];
  const calls = [], fen = new Chess().fen();
  let previous;
  const context = {
    displayFen: fen,
    engine: { enabled: true, workerReady: false, analyze: value => calls.push(value) },
    generator: { isGenerating: false },
    useEffect: (run, deps) => {
      if (!previous || deps.some((value, index) => value !== previous[index])) run();
      previous = deps;
    },
  };
  const render = () => vm.runInNewContext(effect, context);
  render(); assert.equal(calls.length, 0, 'Wait for asynchronous startup');
  context.engine.workerReady = true;
  render(); assert.deepEqual(calls, [fen]);
  render(); assert.equal(calls.length, 1, 'Ordinary renders do not restart searches');
  context.generator.isGenerating = true;
  context.engine.workerReady = false;
  render(); assert.equal(calls.length, 1);
  context.generator.isGenerating = false;
  render(); assert.equal(calls.length, 1, 'Wait for replacement worker');
  context.engine.workerReady = true;
  render(); assert.deepEqual(calls, [fen, fen]);
  context.engine.workerReady = false; render();
  context.engine.workerReady = true; render();
  assert.equal(calls.length, 3, 'Crash recovery restarts the same position too');
});

test('ignores old search output during position changes and rejects illegal moves', async () => {
  const h = harness(); await tick();
  h.worker.onmessage({ data: 'readyok' });
  h.engine.analyze(new Chess().fen());
  await h.timers.at(-1)();
  h.worker.onmessage({ data: 'readyok' });
  h.worker.onmessage({ data: info('e2e4 e7e5') });
  assert.equal(h.actions.at(-2).lines[0].pv[0], 'e4');
  const board = new Chess(); board.move('e4');
  h.engine.analyze(board.fen());
  const count = h.actions.length;
  h.worker.onmessage({ data: info('e2e4') });
  assert.equal(h.actions.length, count);
  await h.timers.at(-1)();
  h.worker.onmessage({ data: 'readyok' });
  const readyCount = h.actions.length;
  h.worker.onmessage({ data: info('e2e4') });
  assert.equal(h.actions.length, readyCount);
  h.worker.onmessage({ data: info('g8f6 e4e5') });
  assert.equal(h.actions.at(-2).lines[0].pv[0], 'Nf6');
});

test('invalid cloud PV falls back to local search without destination-square notation', async () => {
  const h = harness({ depth: 25, pvs: [{ cp: 20, moves: 'g8f6' }] }); await tick();
  h.worker.onmessage({ data: 'readyok' });
  h.engine.analyze(new Chess().fen());
  await h.timers.at(-1)();
  assert.equal(h.actions.some((a) => a.type === 'SET_LINES'), false);
  h.worker.onmessage({ data: 'readyok' });
  assert.ok(h.commands.includes('go depth 20'));
});


test('batch generation suspends the interactive engine without allocating another worker', async () => {
  const h = harness(null, true); await tick();
  assert.equal(h.counts().created, 0);
  h.engine.analyze(new Chess().fen());
  assert.equal(h.commands.length, 0);
});

test('disposing before asynchronous initialization completes terminates the late worker', async () => {
  const h = harness();
  h.cleanups.filter(fn => typeof fn === 'function').forEach(fn => fn());
  await tick();
  assert.equal(h.counts().created, 1);
  assert.equal(h.counts().terminated, 1);
  assert.ok(!h.commands.includes('uci'), 'Late worker never starts its handshake');
});

test('local board evaluation starts even if cloud lookup would never resolve', async () => {
  const h = harness(new Promise(() => {})); await tick();
  h.worker.onmessage({ data: 'readyok' });
  h.worker.onmessage({ data: 'readyok' });
  h.engine.analyze(new Chess().fen());
  await h.timers.at(-1)();
  h.worker.onmessage({ data: 'readyok' });
  assert.ok(h.commands.includes('go depth 20'));
  h.worker.onmessage({ data: info('e2e4 e7e5') });
  assert.equal(h.actions.findLast(action => action.type === 'SET_LINES').lines[0].pv[0], 'e4');
});
