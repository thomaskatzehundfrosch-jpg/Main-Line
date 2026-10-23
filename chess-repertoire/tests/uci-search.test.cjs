const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
const { synchronizeEngineSearch, trackEngineSearch, setEngineDiagnostics, UnresponsiveEngineError } = require('../src/engine/uciSearch.ts');
const { createRecyclingWorkerSession } = require('../src/engine/recyclingWorker.ts');
const { createGeneratorCloudAnalysis } = require('../src/engine/generatorCloudAnalysis.ts');
const { Chess } = require('chess.js');
class WorkerStub extends EventTarget {
  commands = []; terminated = 0;
  postMessage(command) { this.commands.push(command); }
  terminate() { this.terminated++; }
  emit(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
test('stop waits for bestmove even when readyok arrives first; delayed PV cannot contaminate next search', () => {
  const worker = new WorkerStub();
  const finish = trackEngineSearch(worker, 'old', 25, 3);
  finish('failed');
  let starts = 0;
  synchronizeEngineSearch(worker, () => starts++, error => { throw error; });
  assert.deepEqual(worker.commands, ['stop']);
  worker.emit('readyok'); worker.emit('info depth 24 multipv 1 score cp 1 pv e2e4');
  assert.equal(starts, 0);
  worker.emit('bestmove e2e4');
  assert.deepEqual(worker.commands, ['stop', 'isready']);
  assert.equal(starts, 0);
  worker.emit('readyok'); assert.equal(starts, 1);
});
test('unresponsive stop terminates the engine and session retries the request once with a fresh worker', async () => {
  const old = new WorkerStub(), fresh = new WorkerStub(), owned = [];
  trackEngineSearch(old, 'old', 25, 1)('failed');
  const search = createRecyclingWorkerSession(old, async () => fresh, worker => owned.push(worker), new AbortController().signal);
  let attempts = 0;
  const result = await search(worker => {
    attempts++;
    if (worker === fresh) return Promise.resolve(42);
    return new Promise((resolve, reject) => synchronizeEngineSearch(worker, resolve, reject, 5));
  });
  assert.equal(result, 42); assert.equal(attempts, 2);
  assert.ok(old.terminated >= 1); assert.deepEqual(owned, [null, fresh]);
  const broken = createRecyclingWorkerSession(new WorkerStub(), async () => new WorkerStub(), () => {}, new AbortController().signal);
  let failures = 0;
  await assert.rejects(broken(async () => { failures++; throw new UnresponsiveEngineError('dead'); }), /dead/);
  assert.equal(failures, 2);
});
test('diagnostics preserve exact FEN and engine counters for successful and timed-out searches', () => {
  const worker = new WorkerStub(), reports = [];
  setEngineDiagnostics(worker, row => reports.push(row));
  const finish = trackEngineSearch(worker, 'exact FEN', 25, 1);
  worker.emit('info depth 24 multipv 1 score cp 42 nodes 123456 nps 654321 time 19000 pv e2e4');
  finish('failed'); finish('complete'); worker.emit('bestmove e2e4');
  assert.equal(reports.length, 1);
  assert.deepEqual({...reports[0], wallTimeMs:0}, {fen:'exact FEN',requestedDepth:25,multiPV:1,depth:24,engineTimeMs:19000,nodes:123456,nps:654321,wallTimeMs:0,outcome:'failed'});
});
test('closely spaced cloud lookups wait rather than skip, and missing/insufficient results explain fallback', async () => {
  const starts = [], logs = []; let local = 0;
  const gateway = createGeneratorCloudAnalysis({ analyze: async () => { local++; return {}; } }, async () => {
    starts.push(Date.now()); return new Response(JSON.stringify({depth:30,pvs:[{cp:10,moves:starts.length === 1 ? 'e2e4' : 'e7e5'}]}));
  }, Date.now, message => logs.push(message));
  const board = new Chess(); await gateway.analyze({}, board.fen(), 25);
  board.move('e4'); await gateway.analyze({}, board.fen(), 25);
  assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 240); assert.equal(local, 0);
  assert.ok(logs.some(message => message.includes('pacing')));
  await gateway.analyze({}, board.fen(), 35);
  assert.equal(local, 1); assert.match(logs.at(-1), /cached depth 30 insufficient/);
});
test('cancellation while waiting for cloud pacing never sends the request or starts local work', async () => {
  const controller = new AbortController(); let fetches = 0, local = 0;
  const gateway = createGeneratorCloudAnalysis({ analyze: async () => { local++; return {}; } }, async () => {
    fetches++; return new Response('', {status:404});
  });
  const board = new Chess(); await gateway.analyze({}, board.fen(), 25);
  board.move('e4'); const pending = gateway.analyze({}, board.fen(), 25, controller.signal);
  await new Promise(setImmediate); controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(fetches, 1); assert.equal(local, 1);
});
test('cloud lookup queue holds until the full JSON body is parsed', async () => {
  let release, requests = 0;
  const board = new Chess(), firstFen = board.fen(); board.move('e4');
  const gateway = createGeneratorCloudAnalysis({ analyze: async () => ({}) }, async () => {
    requests++;
    if (requests === 1) return {ok:true,status:200,json:()=>new Promise(resolve=>{release=()=>resolve({depth:30,pvs:[{cp:10,moves:'e2e4'}]});})};
    return new Response(JSON.stringify({depth:30,pvs:[{cp:10,moves:'e7e5'}]}));
  });
  const first = gateway.analyze({},firstFen,25);
  const second = gateway.analyze({},board.fen(),25);
  await new Promise(setImmediate);
  assert.equal(requests,1); release();
  await Promise.all([first,second]); assert.equal(requests,2);
});
test('idle but unresponsive workers are replaced without waiting for the search timeout', async () => {
  const worker = new WorkerStub();
  await assert.rejects(new Promise((resolve,reject)=>synchronizeEngineSearch(worker,resolve,reject,5)), /isready with readyok/);
  assert.equal(worker.terminated,1);
});
test('timed-out MultiPV cannot leak its late result into single-PV recovery', async () => {
  global.window = global;
  const { getTopMovesWithFallback } = require('../src/engine/analyzer.ts');
  const worker = new WorkerStub(), warnings = [];
  const pending = getTopMovesWithFallback(worker, new Chess().fen(), 18, 3, 5, undefined, message => warnings.push(message));
  worker.emit('readyok'); worker.emit('readyok');
  worker.emit('info depth 17 multipv 1 score cp 50 nodes 100 time 2 pv e2e4');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(warnings.length,1);
  worker.emit('readyok');
  assert.equal(worker.commands.filter(command=>command === 'go depth 18').length,1);
  worker.emit('info depth 17 multipv 1 score cp 50 pv e2e4');
  worker.emit('bestmove e2e4'); worker.emit('readyok');
  assert.equal(worker.commands.filter(command=>command === 'go depth 18').length,2);
  worker.emit('info depth 18 score cp 20 pv d2d4'); worker.emit('bestmove d2d4');
  assert.equal((await pending)[0].uci,'d2d4');
});
for (const side of ['w','b']) for (const wing of ['h','a']) {
  test(`cloud accepts legal ${side} king-to-rook castling on ${wing} wing without local fallback`,async()=>{
    const rank=side==='w'?'1':'8',fen=`r3k2r/8/8/8/8/8/8/R3K2R ${side} KQkq - 0 1`;
    const gateway=createGeneratorCloudAnalysis({analyze:async()=>{throw Error('unnecessary fallback');}},async()=>new Response(JSON.stringify({depth:30,pvs:[{cp:40,moves:`e${rank}${wing}${rank}`}]})));
    const result=await gateway.analyze({},fen,25);
    assert.equal(result.bestMoveUci,`e${rank}${wing==='h'?'g':'c'}${rank}`);
    assert.equal(result.bestMoveSan,wing==='h'?'O-O':'O-O-O');
    assert.equal(result.source,'lichess-cloud');
  });
}
test('cloud castling normalization never accepts blocked castling or duplicate canonical moves',async()=>{
  const fen='r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';let local=0;const reasons=[];
  const gateway=createGeneratorCloudAnalysis({topMoves:async()=>{local++;return [];}},async()=>new Response(JSON.stringify({depth:30,pvs:[{cp:40,moves:'e1h1'},{cp:35,moves:'e1g1'}]})),Date.now,message=>reasons.push(message));
  await gateway.topMoves({},fen,25,2);assert.equal(local,1);assert.match(reasons.at(-1),/duplicate first move e1g1/);
  const blocked=createGeneratorCloudAnalysis({analyze:async()=>{local++;return {};}},async()=>new Response(JSON.stringify({depth:30,pvs:[{cp:40,moves:'e1h1'}]})));
  await blocked.analyze({},new Chess().fen(),25);assert.equal(local,2);
});
test('four ordinary cloud misses do not suppress a later cached position',async()=>{
  let requests=0,local=0,time=0;
  const gateway=createGeneratorCloudAnalysis({analyze:async()=>{local++;return {};}},async()=>++requests<=4
    ? new Response('',{status:404}) : new Response(JSON.stringify({depth:30,pvs:[{cp:30,moves:'f1c4'}]})),()=>time);
  const board=new Chess();
  for(const san of ['e4','e5','Nf3','Nc6']) {await gateway.analyze({},board.fen(),25);board.move(san);time+=1000;}
  const result=await gateway.analyze({},board.fen(),25);
  assert.equal(requests,5);assert.equal(local,4);assert.equal(result.bestMoveSan,'Bc4');
});
