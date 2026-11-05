// Run the identical browser WASM in an isolated Node process, with Worker-compatible events.
// Usage: node scripts/investigate-generator.cjs [benchmark|generate] [output-directory]
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
global.window = global;
// The CLI intentionally uses anonymous explorer requests and never reads browser credentials.
Object.defineProperty(global, 'localStorage', {value:{getItem:()=>null},configurable:true});
const { Chess } = require('chess.js');
const { analyzePositionWithStockfish, analyzePositionWithRetry, getTopMovesWithFallback, waitForReady } = require('../src/engine/analyzer.ts');
const { setEngineDiagnostics } = require('../src/engine/uciSearch.ts');
const { createRecyclingWorkerSession } = require('../src/engine/recyclingWorker.ts');
const { createGeneratorCloudAnalysis } = require('../src/engine/generatorCloudAnalysis.ts');
const { buildTree } = require('../src/engine/generatorTreeBuilder.ts');
const { getMostLikelyMoves } = require('../src/utils/lichessApi.ts');
const { DEFAULT_GENERATOR_SETTINGS } = require('../src/types/generator.ts');
const mode = process.argv[2] || 'benchmark';
const output = path.resolve(process.argv[3] || 'investigation-results');
fs.mkdirSync(output, { recursive: true });
const log = event => { fs.appendFileSync(path.join(output, `${mode}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); console.log(JSON.stringify(event)); };
const common = ['e4','e5','Nf3','Nc6','Bc4'];
const seeds = ['Nxe4','Bc5','Be7','d6'].map(reply => [...common,'Nf6','d4','exd4','O-O',reply]);
seeds.push([...common,'Nf6','d4','d6']);
// Visible failed branch reconstructed from the screenshot; the original timeout log is unavailable.
const board = new Chess(); [...seeds[3],'Ng5','Ne5','Qxd4','Be7'].forEach(san => board.move(san));
const fen = process.env.INVESTIGATION_FEN || board.fen();
const live = new Set();
class EngineWorker extends EventTarget {
  constructor() {
    super(); live.add(this);
    this.child = spawn(process.execPath, [require.resolve('stockfish/bin/stockfish-19-single.js')], { stdio: ['pipe','pipe','pipe'] });
    let pending = '';
    this.child.stdout.on('data', chunk => {
      pending += chunk.toString(); const rows = pending.split('\n'); pending = rows.pop();
      rows.forEach(data => this.dispatchEvent(new MessageEvent('message', { data: data.trim() })));
    });
    this.child.stderr.on('data', chunk => log({ kind: 'stderr', message: chunk.toString() }));
    this.child.on('error', error => this.dispatchEvent(Object.assign(new Event('error'), { message: error.message })));
  }
  postMessage(command) { this.child.stdin.write(command + '\n'); }
  terminate() { this.child.kill(); live.delete(this); }
}
const controller = new AbortController();
process.on('SIGINT', () => { controller.abort(); live.forEach(worker => worker.terminate()); process.exit(130); });
async function create() {
  const worker = new EngineWorker();
  worker.postMessage('uci'); await waitForReady(worker);
  worker.postMessage('setoption name Hash value 32'); worker.postMessage('setoption name MultiPV value 1'); await waitForReady(worker);
  setEngineDiagnostics(worker, metrics => log({ kind: 'engine', ...metrics }));
  return worker;
}
(async () => {
  log({ kind: 'setup', engine: 'Stockfish 19.0.1 Full single-thread WASM', hashMB: 32, fen, seeds, settings: DEFAULT_GENERATOR_SETTINGS });
  if (mode === 'benchmark') {
    const isolated = await create();
    log({ kind: 'isolated', result: await analyzePositionWithStockfish(isolated, fen, 25) }); isolated.terminate();
    const generation = await create();
    const search = createRecyclingWorkerSession(generation, create, () => {}, controller.signal);
    // Exercise the same cloud/recycling/analyzer composition as generation, forcing this comparison local.
    const gateway = createGeneratorCloudAnalysis({ analyze: (_w, position, depth, signal) => search(w => analyzePositionWithRetry(w, position, depth, signal)), topMoves: getTopMovesWithFallback },
      async () => new Response('', { status: 404 }), Date.now, message => log({kind: 'cloud',message}));
    log({ kind: 'generation-path', result: await gateway.analyze(generation, fen, 25) }); generation.terminate();
  } else {
    const worker = await create();
    const search = createRecyclingWorkerSession(worker, create, () => {}, controller.signal);
    const analysis = createGeneratorCloudAnalysis({
      analyze: (_w, position, depth, signal) => search(w => analyzePositionWithRetry(w, position, depth, signal, message => log({ kind: 'recovery', message }))),
      topMoves: (_w, position, depth, count, timeout, signal) => search(w => getTopMovesWithFallback(w, position, depth, count, timeout, signal, message => log({kind:'recovery',message}))),
    }, undefined, undefined, message => log({ kind: 'cloud', message }));
    const root = await buildTree(seeds, { ...DEFAULT_GENERATOR_SETTINGS, trustSuppliedMoves: true }, {
      onProgress: progress => log({ kind: 'progress', ...progress }),
      onLog: entry => log({ kind: 'generator', ...entry }),
      onNodeAdded: root => fs.writeFileSync(path.join(output, 'tree.json'), JSON.stringify(root)),
    }, { current: false, signal: controller.signal }, worker, { ...analysis, replies: getMostLikelyMoves });
    fs.writeFileSync(path.join(output, 'tree.json'), JSON.stringify(root));
    log({ kind: 'finished' });
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { live.forEach(worker => worker.terminate()); });
