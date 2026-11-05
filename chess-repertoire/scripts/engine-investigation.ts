import { Chess } from 'chess.js';
import { createAnalysisWorker, analyzePositionWithStockfish, analyzePositionWithRetry, getTopMovesWithFallback } from '../src/engine/analyzer';
import { setEngineDiagnostics } from '../src/engine/uciSearch';
import { createRecyclingWorkerSession } from '../src/engine/recyclingWorker';
import { createGeneratorCloudAnalysis } from '../src/engine/generatorCloudAnalysis';
import { buildTree } from '../src/engine/generatorTreeBuilder';
import { getMostLikelyMoves } from '../src/utils/lichessApi';
import { DEFAULT_GENERATOR_SETTINGS } from '../src/types/generator';
const common = ['e4','e5','Nf3','Nc6','Bc4'];
const seeds = ['Nxe4','Bc5','Be7','d6'].map(reply => [...common,'Nf6','d4','exd4','O-O',reply]);
seeds.push([...common,'Nf6','d4','d6']);
const board = new Chess(); [...seeds[3],'Ng5','Ne5','Qxd4','Be7'].forEach(san => board.move(san));
const fen = new URLSearchParams(location.search).get('fen') || board.fen();
const settings = {...DEFAULT_GENERATOR_SETTINGS, trustSuppliedMoves: true};
let controller: AbortController, owned: Worker | null, running = false;
const recent: string[] = [], metrics: unknown[] = [];
const status = document.querySelector('#status')!, summary = document.querySelector('#summary')!;
let writes = Promise.resolve();
function log(entry: Record<string, unknown>) {
  writes = writes.then(async () => { await fetch('/__engine-investigation', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(entry)}); });
  if (entry.kind === 'engine') metrics.push(entry);
  if (entry.kind !== 'tree') { recent.push(JSON.stringify(entry)); document.querySelector('#recent')!.textContent = recent.slice(-6).join('\n\n'); }
}
async function create() {
  owned = await createAnalysisWorker(1);
  setEngineDiagnostics(owned, row => log({kind:'engine', ...row}));
  return owned;
}
async function run(mode: string) {
  if (running) return;
  running = true; controller = new AbortController();
  status.textContent = `Running ${mode}`;
  const runSeeds = mode === 'position' ? [new URLSearchParams(location.search).has('fen') ? ['e4','e5','Nf3','Nc6','Bc4','Nf6','d4','d6','Ng5','Be6'] : [...seeds[3],'Ng5','Ne5','Qxd4','Be7']] : seeds;
  const runSettings = mode === 'position' ? {...settings,maxMoveNumber:8,tacticalExtension:0} : settings;
  log({kind:'setup',mode,fen,seeds:runSeeds,settings:runSettings,browser:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency});
  try {
    if (mode === 'benchmark') {
      let worker = await create();
      const isolated = await analyzePositionWithStockfish(worker,fen,25,controller.signal); worker.terminate();
      worker = await create();
      const search = createRecyclingWorkerSession(worker,create,next=>{owned=next;},controller.signal);
      const gateway = createGeneratorCloudAnalysis({analyze:(_w,fen,depth,signal)=>search(w=>analyzePositionWithRetry(w,fen,depth,signal)),topMoves:getTopMovesWithFallback},
        async()=>new Response('',{status:404}),Date.now,message=>log({kind:'cloud',message}));
      const generation = await gateway.analyze(worker,fen,25,controller.signal);
      summary.textContent = JSON.stringify({fen,isolated,generation,metrics},null,2);
      log({kind:'benchmark-complete',isolated,generation});
    } else {
      if (mode === 'position') {
        const isolatedWorker = await create();
        log({kind:'position-isolated',result:await analyzePositionWithStockfish(isolatedWorker,fen,25,controller.signal)});
        isolatedWorker.terminate();
      }
      const worker = await create();
      const search = createRecyclingWorkerSession(worker,create,next=>{owned=next;},controller.signal);
      const analysis = createGeneratorCloudAnalysis({
        analyze:(_w,fen,depth,signal)=>search(w=>analyzePositionWithRetry(w,fen,depth,signal,message=>log({kind:'recovery',message})),true,depth>=22),
        topMoves:(_w,fen,depth,count,timeout,signal)=>search(w=>getTopMovesWithFallback(w,fen,depth,count,timeout,signal,message=>log({kind:'recovery',message}))),
      },mode === 'position' ? async()=>new Response('',{status:404}) : undefined,undefined,message=>log({kind:'cloud',message}));
      const resume = new URLSearchParams(location.search).get('resume') === 'correct' ? await (await fetch('/investigation-results/browser/correct-seed-timeout-tree.json')).json() : undefined;
      const tree = await buildTree(runSeeds,runSettings,{
        onProgress:progress=>{status.textContent=JSON.stringify(progress);log({kind:'progress',...progress});},
        onLog:entry=>log({kind:'generator',...entry}),
        onNodeAdded:tree=>log({kind:'tree',tree}),
      },{current:false,signal:controller.signal},worker,{...analysis,replies:getMostLikelyMoves},resume);
      log({kind:'tree',tree}); log({kind:'generation-ended'});
      summary.textContent = `Run ended; ${metrics.length} local searches. Saved tree and diagnostic log: investigation-results/browser.`;
    }
    status.textContent += ' — finished';
  } catch(error) { log({kind:'error',message:String(error)}); status.textContent=String(error); }
  finally {owned?.terminate();owned=null;running=false;await writes;}
}
document.querySelector('#benchmark')!.addEventListener('click',()=>run('benchmark'));
document.querySelector('#generate')!.addEventListener('click',()=>run('generate'));
document.querySelector('#position')!.addEventListener('click',()=>run('position'));
document.querySelector('#stop')!.addEventListener('click',()=>{controller?.abort();owned?.terminate();});
