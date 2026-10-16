import {board,uci} from './core.js';
import {get,deferPut} from './storage.js';
class Interrupted extends Error {}
export class LabEngine {
 constructor(update=(_message)=>{}){this.update=update;this.stats={calls:0,nodes:0,hits:0};this.cancelled=false;}
 async init(){
  this.sf=new Worker('/stockfish/stockfish.js#/stockfish/stockfish.wasm');
  this.identity={engine:'Stockfish',sha256:'mainline-stockfish-17.1-lab-v1'};
  this.sf.onmessage=e=>{for(const line of String(e.data).split('\n'))this.onLine?.(line);};
  this.sf.onerror=()=>{this.sfError=Error('Stockfish could not load. Reload and try again.');this.onLine?.('__ERROR__');};
  await this.until('uciok','uci',30000);this.check();
  await this.until('readyok','setoption name Threads value 1\nsetoption name Hash value 32\nisready',30000);
 }
 send(command){for(const line of command.split('\n'))this.sf.postMessage(line);}
 until(marker,command,timeout){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.onLine=null;reject(Error('Stockfish did not respond'));},timeout);this.abortSearch=e=>{clearTimeout(timer);this.onLine=null;reject(e);};this.onLine=line=>{if(line===marker||line==='__ERROR__'){clearTimeout(timer);this.onLine=null;this.abortSearch=null;line===marker?resolve():reject(this.sfError);}};this.send(command);});}
 start(settings){this.settings=settings;this.cancelled=false;this.deadline=Infinity;this.started=performance.now();this.stats={calls:0,nodes:0,hits:0};}
 check(){if(this.cancelled)throw new Interrupted('Stopped');}
 pause(){this.cancelled=true;this.abortSearch?.(new Interrupted('Stopped'));this.abortSearch=null;this.sf?.terminate();}
 async analyse(state,width){
  const callStarted=performance.now();this.check();const b=board(state);if(b.isGameOver())return {rows:[],complete:true,terminal:{cp:b.isCheckmate()?null:0,mate:b.isCheckmate()?(b.turn()===this.settings.side?-1:1):null}};
  const legal=b.moves({verbose:true}),legalMap=new Map(legal.map(m=>[uci(m),m]));width=Math.min(width,legal.length);const s=this.settings;
  const cacheKey='sf-browser-v3:'+JSON.stringify([this.identity.sha256,state,s.side,s.depth,s.callNodes,width,!!s.coldSearch]);const cached=s.bypassCache?null:await get(cacheKey);if(cached){this.stats.hits++;this.activity?.({component:'stockfish',status:'cached',depth:cached.rows[0]?.depth,state,ms:performance.now()-callStarted});this.searchUpdate?.({state,rows:cached.rows,depth:cached.rows[0]?.depth||0,target:s.depth,cached:true});return cached;}
  if(s.totalNodes>0&&s.callNodes>0&&s.totalNodes-this.stats.nodes<s.callNodes+2048)throw new Interrupted('Node budget cannot fund another full call');
  this.activity?.({component:'stockfish',status:'searching',depth:s.depth,state});if(s.coldSearch)await this.until('readyok','ucinewgame\nsetoption name Clear Hash\nisready');this.send('setoption name MultiPV value '+width);this.check();
  const callTime=Number.isFinite(this.deadline)?Math.max(1,Math.floor(this.deadline-performance.now())):null;
  const nodeLimit=s.callNodes>0?s.callNodes:(s.totalNodes>0?Math.max(1,s.totalNodes-this.stats.nodes-2048):null);
  const result=await new Promise((resolve,reject)=>{
   let complete=[],seen=new Map(),used=0,depthSeen=0,bounds=0,reportedDepth=-1;
   const timer=callTime===null?null:setTimeout(()=>{this.sf?.terminate();this.sf=null;this.onLine=null;this.abortSearch=null;reject(new Interrupted('Engine reached time limit'));},callTime+2500);
   this.abortSearch=e=>{clearTimeout(timer);this.onLine=null;this.abortSearch=null;reject(e);};
   this.onLine=line=>{if(line==='__ERROR__'){clearTimeout(timer);this.onLine=null;this.abortSearch=null;reject(this.sfError);return;}
    if(line.startsWith('bestmove')){clearTimeout(timer);this.onLine=null;this.abortSearch=null;resolve({rows:complete,nodes:used,complete:complete.length===width&&!this.cancelled,allLegal:width===legal.length,highestDepthSeen:depthSeen,skippedBounds:bounds});return;}
    if(!line.startsWith('info ')||!line.includes(' pv '))return;
    const dp=Number(line.match(/\bdepth (\d+)/)?.[1]||0),rank=Number(line.match(/\bmultipv (\d+)/)?.[1]||1),n=Number(line.match(/\bnodes (\d+)/)?.[1]||0);used=Math.max(used,n);depthSeen=Math.max(depthSeen,dp);if(rank===1&&dp!==reportedDepth){reportedDepth=dp;this.update(`${this.identity?.engine||'Engine'} searching · depth ${dp}/${s.depth} · ${(used/1e6).toFixed(2)}M nodes`);}
    const score=line.match(/\bscore (cp|mate) (-?\d+)/);if(!score)return;if(/\b(lowerbound|upperbound)\b/.test(line)){bounds++;return;}
    const pv=line.split(' pv ')[1].trim().split(/\s+/),move=pv[0];if(!legalMap.has(move))return;
    const sign=b.turn()===s.side?1:-1,val=Number(score[2])*sign,row={uci:move,san:legalMap.get(move).san,cp:score[1]==='cp'?val:null,mate:score[1]==='mate'?val:null,pv,depth:dp};
    if(!seen.has(dp))seen.set(dp,new Map());seen.get(dp).set(rank,row);const map=seen.get(dp);
    if(map.size===width&&Array.from({length:width},(_,i)=>map.has(i+1)).every(Boolean)){const rows=Array.from({length:width},(_,i)=>map.get(i+1));if(new Set(rows.map(r=>r.uci)).size===width){complete=rows;this.partial?.(rows);this.searchUpdate?.({state,rows,depth:dp,target:s.depth,cached:false});}}
    for(const d of seen.keys())if(d<dp-1)seen.delete(d);
   };
   this.send('position fen '+state.root+(state.moves.length?' moves '+state.moves.join(' '):''));
   this.send(`go depth ${s.depth}`+(nodeLimit?` nodes ${nodeLimit}`:'')+(callTime!==null?` movetime ${callTime}`:''));
  });
  this.stats.nodes+=result.nodes;this.stats.calls++;result.elapsedMs=performance.now()-callStarted;result.searchMemory=s.coldSearch?'cold':'warm';this.stats.engineMs=(this.stats.engineMs||0)+result.elapsedMs;this.activity?.({component:'stockfish',status:'complete',depth:result.rows[0]?.depth,state,ms:result.elapsedMs});
  if(!result.rows.length)throw new Interrupted('No complete engine iteration within this budget');
  // Cache only depth/node-completed calls, not a partial wall-time cutoff.
  const achieved=result.rows[0].depth;if(result.complete&&(achieved>=s.depth||(nodeLimit>0&&result.nodes>=nodeLimit)))deferPut(cacheKey,result);
  return result;
 }
}
