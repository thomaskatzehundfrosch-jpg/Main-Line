import {board} from './core.js';
export function rarityOf(database,move){
 const row=database.moves.find(m=>m.uci===move),total=database.games;
 const missing=Math.max(0,total-database.moves.reduce((n,m)=>n+m.games,0));
 return {games:row?.games??null,frequency:total&&row?row.games/total:null,upper:total?(row?row.games:missing)/total:null,listed:!!row};
}
export function rareScreenMoves(database,analysis,s){
 const finite=analysis.rows.filter(r=>Number.isFinite(r.cp)),best=Math.max(...finite.map(r=>r.cp));
 return finite.filter(row=>{const rarity=rarityOf(database,row.uci);return ((rarity.upper!==null&&rarity.upper<=(s.rareThreshold??.05))||database.games<s.minGames)&&row.cp>=s.floor&&best-row.cp<=s.tolerance+50;}).sort((a,b)=>(rarityOf(database,a.uci).upper??1)-(rarityOf(database,b.uci).upper??1)||b.cp-a.cp).map(r=>r.uci);
}
export async function examineDefences(state,client,s,emit){
 const legal=board(state).moves().length;if(!legal)return {rows:[],legalCount:0,adequateCount:0,status:'terminal'};
 let width=Math.min(3,legal),analysis;
 while(true){client.check();emit('Stockfish: checking '+width+'/'+legal+' defensive choices');analysis=await client.analyse(state,width);client.check();
  const rows=analysis.rows,best=rows[0],last=rows.at(-1);
  if(!Number.isFinite(best?.cp)||!Number.isFinite(last?.cp))return {rows,legalCount:legal,adequateCount:null,status:'mate_separate',depth:best?.depth};
  if(width===legal||last.cp-best.cp>=s.mistakeThreshold)return {rows,legalCount:legal,depth:best.depth,rankBoundary:width<legal,status:'complete'};
  width=Math.min(legal,width*2);
 }
}
export function defenceEvidence(candidate,data,s){
 const d=candidate.defensiveOptions;if(!d)return null;
 const scores=new Map(d.rows.map(row=>[row.uci,row.cp]));for(const row of candidate.replies||[])scores.set(row.uci,row.cp);
 let adequateMass=0,mistakeMass=0;
 for(const move of data.moves){const cp=scores.get(move.uci);if(move.games<s.minReplyGames||!Number.isFinite(cp)||!Number.isFinite(candidate.cp))continue;const probability=data.games?move.games/data.games:0;if(cp-candidate.cp<s.mistakeThreshold)adequateMass+=probability;else mistakeMass+=probability;}
 const unknown=Math.max(0,1-adequateMass-mistakeMass);
 return {adequateCount:d.status==='mate_separate'||!Number.isFinite(candidate.cp)?null:[...scores.values()].filter(cp=>Number.isFinite(cp)&&cp-candidate.cp<s.mistakeThreshold).length,checked:scores.size,legalCount:d.legalCount,depth:d.depth,status:d.status,adequateMass,adequateUpper:Math.min(1,adequateMass+unknown),mistakeMass,unknown};
}
export function rareLeaders(result){
 return result.candidates.filter(c=>c.sound&&c.rarity&&((c.rarity.upper!==null&&c.rarity.upper<=(result.settings.rareThreshold??.05))||(c.outcomes?.games??0)<result.settings.minGames)&&c.defenceEvidence?.adequateCount!=null&&c.repliesComplete).sort((a,b)=>a.defenceEvidence.adequateCount-b.defenceEvidence.adequateCount||(a.rarity.upper??1)-(b.rarity.upper??1)||(b.cp??-Infinity)-(a.cp??-Infinity));
}
