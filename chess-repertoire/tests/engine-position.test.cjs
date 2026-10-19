const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Chess } = require('chess.js');

function harness(cloud = null) {
  const effects = [], timers = [], actions = [], commands = [];
  const state = { enabled: true, depth: 20, multiPV: 3, threads: 1 };
  const worker = { postMessage: (c) => commands.push(c), terminate() {} };
  const context = { exports: {}, console, navigator: { hardwareConcurrency: 1 },
    Worker: function () { return worker; },
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
  const engine = context.exports.useEngine();
  effects.forEach((fn) => fn());
  return { engine, worker, actions, commands, timers };
}
const tick = () => new Promise(setImmediate);
const info = (pv) => `info depth 15 multipv 1 score cp 20 pv ${pv}`;

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
