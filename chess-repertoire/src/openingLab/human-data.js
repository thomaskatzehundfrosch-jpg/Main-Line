import {board,uci} from './core.js';
import {get,put} from './storage.js';
let retryAt=0;
export class HumanDataError extends Error{constructor(status,message){super(message);this.status=status;}}
export function normaliseExplorerMove(state,move){
 const b=board(state);
 if(typeof move!=='string')return move;
 const from=move.slice(0,2),to=move.slice(2,4),king=b.get(from),rook=b.get(to);
 if(move.length===4&&king?.type==='k'&&rook?.type==='r'&&king.color===rook.color&&from[0]==='e'&&from[1]===to[1]&&['1','8'].includes(from[1])&&['a','h'].includes(to[0])){
  const castle=b.moves({square:from,verbose:true}).find(m=>m.flags.includes(to[0]==='h'?'k':'q'));
  if(castle)return uci(castle);
 }
 return move;
}
export function parseHumanData(data,state){
 const valid=n=>Number.isSafeInteger(n)&&n>=0;
 const counts=x=>{if(!['white','draws','black'].every(k=>valid(x[k])))throw Error('Invalid Lichess game counts');return x.white+x.draws+x.black;};
 const games=counts(data);if(!Array.isArray(data.moves))throw Error('Invalid Lichess moves');
 const legal=new Set(board(state).moves({verbose:true}).map(uci)),seen=new Set();
 const moves=data.moves.map(m=>{const move=normaliseExplorerMove(state,m.uci);if(!legal.has(move))throw Error('Invalid Lichess move: '+m.uci);if(seen.has(move))throw Error('Invalid or duplicate Lichess move: '+m.uci);seen.add(move);return {uci:move,white:m.white,draws:m.draws,black:m.black,games:counts(m)};});
 if(moves.reduce((n,m)=>n+m.games,0)>games)throw Error('Lichess move counts exceed total games');
 return {games,white:data.white,draws:data.draws,black:data.black,moves,ratings:[2000],speeds:'rapid',source:'Lichess opening explorer',retrieved:new Date().toISOString()};
}
export class HumanDatabase{
 constructor(token,fetcher=(...args)=>globalThis.fetch(...args)){this.token=token;this.fetcher=fetcher;}
 cancel(){this.controller?.abort();}
 async query(state){
  const fen=board(state).fen(),key='human-wdl-v1:2000:rapid:'+fen.split(' ').slice(0,4).join(' '),cached=await get(key);
  if(cached&&Date.now()-Date.parse(cached.retrieved)<7*86400000)return {...cached,cached:true};
  if(!this.token)throw new HumanDataError('authentication_required','Connect Lichess to load 2000 rapid games.');
  if(Date.now()<retryAt)throw new HumanDataError('rate_limited','Lichess is limiting requests. Wait one minute and retry.');
  const params=new URLSearchParams({fen,variant:'standard',speeds:'rapid',ratings:'2000',moves:'50',topGames:'0',recentGames:'0'});
  const controller=this.controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
   const response=await this.fetcher('https://explorer.lichess.org/lichess?'+params,{headers:{Authorization:'Bearer '+this.token},signal:controller.signal});
   if(response.status===401)throw new HumanDataError('authentication_required','Lichess authorization is required. Connect again.');
   if(response.status===429){retryAt=Date.now()+Math.max(60,Number(response.headers.get('retry-after'))||60)*1000;throw new HumanDataError('rate_limited','Lichess is limiting requests. Wait one minute and retry.');}
   if(!response.ok)throw new HumanDataError('unavailable','Lichess request failed (HTTP '+response.status+').');
   const result=parseHumanData(await response.json(),state);await put(key,result);return result;
  }finally{clearTimeout(timer);}
 }
}
