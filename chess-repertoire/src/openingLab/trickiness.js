import {winLowerBound,replyEvidence,sacrificeCp} from './evidence.js';
import {rarityOf,rareScreenMoves,examineDefences,defenceEvidence,rareLeaders} from './rarity.js';
import {board,advance,san,uci} from './core.js';
export function outcomes(row,side){const games=row.games??row.white+row.draws+row.black,wins=side==='w'?row.white:row.black,losses=side==='w'?row.black:row.white;return {games,wins,draws:row.draws,losses,winRate:games?wins/games:null,scoreRate:games?(wins+row.draws/2)/games:null};}
export {winLowerBound} from './evidence.js';
export function selectCandidates(state,root,analysis,s){
 const legal=board(state).moves({verbose:true}).map(uci),stats=root.moves.filter(m=>m.games>=s.minGames);
 const bestStats=[...stats].sort((a,b)=>winLowerBound(outcomes(b,s.side).wins,b.games)-winLowerBound(outcomes(a,s.side).wins,a.games));
 const popular=[...root.moves].sort((a,b)=>b.games-a.games);
 const manual=(s.manual||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,2).map(m=>uci(board(state).move(m)));
 const rare=s.rareMoves||[];
 const queue=s.engineVariant==='single'?[...manual,...analysis.rows.slice(0,1).map(r=>r.uci),...rare.slice(0,2),...popular.slice(0,1).map(r=>r.uci),...bestStats.slice(0,1).map(r=>r.uci),...analysis.rows.map(r=>r.uci),...popular.map(r=>r.uci)]:[...manual,...analysis.rows.slice(0,2).map(r=>r.uci),...popular.slice(0,2).map(r=>r.uci),...bestStats.slice(0,2).map(r=>r.uci),...analysis.rows.map(r=>r.uci),...popular.map(r=>r.uci)];
 return [...new Set(queue)].filter(m=>legal.includes(m)).slice(0,s.candidateLimit);
}
export function leaders(result){
 const eligible=result.candidates.filter(c=>c.sound&&c.outcomes?.games>=result.settings.minGames);
 const wins=eligible.filter(c=>c.outcomes.winRate!==null).sort((a,b)=>winLowerBound(b.outcomes.wins,b.outcomes.games)-winLowerBound(a.outcomes.wins,a.outcomes.games));
 let tricks=eligible.filter(c=>c.repliesComplete&&c.coverage>0&&c.weightedLoss>0).sort((a,b)=>b.weightedLoss-a.weightedLoss);
 if(result.settings.engineVariant==='single')tricks=result.candidates.filter(c=>c.sound&&c.repliesComplete&&c.replyData?.games>=result.settings.minGames&&c.weightedLoss>0&&c.defenceEvidence).sort((a,b)=>a.defenceEvidence.adequateUpper-b.defenceEvidence.adequateUpper||(a.defenceEvidence.adequateCount??Infinity)-(b.defenceEvidence.adequateCount??Infinity)||(a.rarity?.upper??1)-(b.rarity?.upper??1)||b.weightedLoss-a.weightedLoss);
 const rare=result.settings.engineVariant==='single'?rareLeaders(result):[];
 return {wins,tricks,rare,win:wins[0]||null,trick:tricks[0]||null};
}
export async function investigate(input,s,client,db,update=(_result)=>{}){
 const r={schema:'human-trickiness-v1',input,settings:s,status:'running',phase:'Loading Lichess '+(s.rating??2000)+' rapid games',candidates:[],created:new Date().toISOString(),engines:{analysis:client.identity}};
 const emit=phase=>{r.phase=phase;const total=r.candidateCount||s.candidateLimit;const checked=r.candidates.filter(c=>c.depth!=null).length;const finished=r.candidates.filter(c=>c.repliesComplete||c.sound===false).length;r.progress=r.status==='complete'?100:r.baseline!=null?55+40*finished/total:r.candidates.length?20+35*checked/total:r.rareScreen?20:r.rootDepth?15:r.database?5:0;r.elapsedSeconds=(performance.now()-client.started)/1000;r.stats={...client.stats};update(r);};
 try{
  r.database=await db.query(input);emit('Finding a small candidate set');
  const root=await client.analyse(input,3);r.rootDepth=root.rows[0]?.depth||0;
  let discoverySettings=s;
  if(s.engineVariant==='single'){
   emit('Rare discovery preview at depth '+Math.min(10,s.depth)+' · selected moves are verified at depth '+s.depth);const previous=client.settings;
   try{client.settings={...previous,depth:Math.min(10,s.depth)};r.rareScreen=await client.analyse(input,board(input).moves().length);}finally{client.settings=previous;}
   discoverySettings={...s,rareMoves:rareScreenMoves(r.database,r.rareScreen,s)};
  }
  const selected=selectCandidates(input,r.database,root,discoverySettings);r.candidateCount=selected.length;
  for(const move of selected){
   client.check();const c={uci:move,san:san(input,move),replies:[],sound:null,repliesComplete:false};r.candidates.push(c);
   const stats=r.database.moves.find(m=>m.uci===move);c.outcomes=stats?outcomes(stats,s.side):null;if(s.engineVariant==='single')c.rarity=rarityOf(r.database,move);
   emit('Checking '+c.san+' against the strongest defence');
   const after=advance(input,move),a=await client.analyse(after,1),best=a.rows[0]||a.terminal;
   c.cp=best?.cp??null;c.mate=best?.mate??null;c.depth=a.rows[0]?.depth||s.depth;c.defence=a.rows[0]?.uci||null;c.defencePv=a.rows[0]?.pv||[];
  }
  const scores=r.candidates.map(c=>c.cp).filter(Number.isFinite);const baseline=Number.isFinite(s.baselineCp)?s.baselineCp:Math.max(...scores,...root.rows.map(row=>row.cp).filter(Number.isFinite));r.baseline=Number.isFinite(baseline)?baseline:null;
  const winningMate=r.candidates.some(c=>c.mate>0)||root.rows.some(row=>row.mate>0);
  for(const c of r.candidates){c.sacrifice=c.cp===null||r.baseline===null?null:sacrificeCp(r.baseline,c.cp);c.sound=c.mate!==null?c.mate>0:!winningMate&&c.cp!==null&&c.cp>=s.floor&&c.sacrifice!==null&&c.sacrifice<=s.tolerance;}
  emit('Soundness checks complete');
  for(const c of r.candidates.filter(c=>c.sound)){
   client.check();emit('Loading recorded replies to '+c.san);const after=advance(input,c.uci),data=await db.query(after);c.replyData=data;c.replyOutcomes=outcomes(data,s.side);
   if(s.engineVariant==='single'){
    c.defensiveOptions=await examineDefences(after,client,s,emit);const best=c.defensiveOptions.rows[0];
    if(best?.mate!=null){c.mate=best.mate;c.cp=null;c.defence=best.uci;c.defencePv=best.pv;c.sacrifice=null;c.sound=best.mate>0;}else if(Number.isFinite(best?.cp)&&(c.cp===null||best.cp<c.cp)){c.cp=best.cp;c.mate=null;c.defence=best.uci;c.defencePv=best.pv;c.sacrifice=r.baseline===null?null:sacrificeCp(r.baseline,c.cp);c.sound=!winningMate&&c.cp>=s.floor&&c.sacrifice!==null&&c.sacrifice<=s.tolerance;}
    c.defenceEvidence=defenceEvidence(c,data,s);if(!c.sound){emit('Broader defence check rejected '+c.san);continue;}
   }
   const replies=[...data.moves].sort((a,b)=>b.games-a.games).slice(0,3);c.coverage=0;c.weightedLoss=0;
   for(const reply of replies){
    client.check();emit('Checking '+c.san+' '+san(after,reply.uci));
    const next=advance(after,reply.uci),a=await client.analyse(next,1),score=a.rows[0]||a.terminal;
    const loss=Number.isFinite(c.cp)&&Number.isFinite(score?.cp)?Math.max(0,score.cp-c.cp):null;
    const supported=reply.games>=s.minReplyGames;
    const row={cp:score?.cp??null,uci:reply.uci,san:san(after,reply.uci),games:reply.games,frequency:data.games?reply.games/data.games:0,lossCp:loss,supported,depth:a.rows[0]?.depth||s.depth,mate:score?.mate??null,punishment:a.rows[0]?.pv||[]};
    c.replies.push(row);c.coverage+=row.frequency;
    // A recorded reply can reveal a stronger defence than the earlier search.
    if(Number.isFinite(row.cp)&&Number.isFinite(c.cp)&&row.cp<c.cp){c.cp=row.cp;c.defence=reply.uci;c.defencePv=[reply.uci,...row.punishment];}
    if(row.mate!==null&&row.mate<0){c.mate=row.mate;c.cp=null;c.defence=reply.uci;c.defencePv=[reply.uci,...row.punishment];}
    c.sacrifice=c.cp!==null&&r.baseline!==null?sacrificeCp(r.baseline,c.cp):null;
    c.sound=c.mate!==null?c.mate>0:!winningMate&&c.cp!==null&&c.cp>=s.floor&&c.sacrifice!==null&&c.sacrifice<=s.tolerance;
    c.weightedLoss=0;for(const checked of c.replies){checked.lossCp=Number.isFinite(c.cp)&&Number.isFinite(checked.cp)?Math.max(0,checked.cp-c.cp):null;if(checked.supported&&checked.lossCp!==null&&checked.lossCp>=s.mistakeThreshold)c.weightedLoss+=checked.frequency*checked.lossCp;}
    if(s.engineVariant==='single')c.defenceEvidence=defenceEvidence(c,data,s);
    emit('Reply checked');
   }
   c.weightedLoss=replyEvidence(c.replies,c.cp,s.mistakeThreshold).weightedLoss;
   c.repliesComplete=true;emit('Finished '+c.san);
  }
  r.status='complete';emit('Investigation complete');
 }catch(error){r.status=client.cancelled?'paused':error.status||'partial';r.message=error.message;emit(r.status==='paused'?'Paused':'Investigation stopped');}
 return r;
}
