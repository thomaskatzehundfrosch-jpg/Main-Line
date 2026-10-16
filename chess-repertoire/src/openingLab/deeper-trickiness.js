import {defenceEvidence} from './rarity.js';
import {advance,board,san} from './core.js';
import {leaders} from './trickiness.js';
export function deepTargets(result,mode='tricks'){
 const ranks=leaders(result),preferred=mode==='wins'?ranks.wins:ranks.tricks;
 return [...new Map([...preferred,...ranks.wins,...(result.settings.engineVariant==='single'?ranks.rare||[]:[])].filter(c=>c.repliesComplete).map(c=>[c.uci,c])).values()].slice(0,2);
}
export function responsePrecision(analysis,threshold,legalCount){
 const rows=analysis.rows||[],best=rows[0];
 if(!Number.isFinite(best?.cp))return null;
 const scored=rows.filter(r=>Number.isFinite(r.cp));
 return {checked:rows.length,adequate:scored.filter(r=>best.cp-r.cp<=threshold).length,secondBestLossCp:scored[1]?Math.max(0,best.cp-scored[1].cp):null,legalCount,depth:best.depth,complete:analysis.complete};
}
export function defenceAccess(replies,threshold){
 let adequate=0,mistakes=0;
 for(const reply of replies){if(!reply.supported||!Number.isFinite(reply.lossCp))continue;if(reply.lossCp>=threshold)mistakes+=reply.frequency;else adequate+=reply.frequency;}
 return {adequate,mistakes,unknown:Math.max(0,1-adequate-mistakes)};
}
export function deepSummary(candidate,threshold){
 let firstMistakes=0,delayedMistakes=0,noMistake=0;
 for(const first of candidate.replies){
  if(!first.supported)continue;
  const branch=candidate.deep?.branches.find(b=>b.reply===first.uci);
  const loss=branch?.firstChecked?branch.firstLossCp:first.lossCp;
  if(!Number.isFinite(loss))continue;
  if(loss>=threshold){firstMistakes+=first.frequency;continue;}
  if(!branch?.secondBaselineChecked)continue;
  const access=defenceAccess(branch.replies,threshold);
  delayedMistakes+=first.frequency*access.mistakes;noMistake+=first.frequency*access.adequate;
 }
 const lower=Math.min(1,firstMistakes+delayedMistakes),upper=Math.max(lower,Math.min(1,1-noMistake));
 return {firstMistakes,delayedMistakes,lower,upper,unknown:Math.max(0,upper-lower),firstDefence:defenceAccess(candidate.replies,threshold)};
}
function scoreOf(a){return a.rows[0]||a.terminal||{};}
export async function deepen(result,client,db,mode='tricks',update=(_result)=>{},options={}){
 const targets=options.targetUci?result.candidates.filter(c=>c.uci===options.targetUci&&c.sound&&c.repliesComplete).slice(0,1):deepTargets(result,mode),s={...result.settings,depth:client.settings?.depth??result.settings.depth};
 result.deep={status:'running',targets:targets.map(c=>c.uci),mode,phase:'Starting selective two-turn checks',created:new Date().toISOString(),depth:s.depth};
 const emit=phase=>{result.deep.phase=phase;const total=targets.reduce((n,c)=>n+Math.min(3,c.replies.length),0);const done=targets.reduce((n,c)=>n+(c.deep?.branches||[]).filter(b=>b.status!=='running').length,0);result.deep.progress=result.deep.status==='complete'?100:total?Math.min(95,95*done/total):0;result.deep.seconds=(performance.now()-client.started)/1000;result.deep.stats={...client.stats};for(const c of targets)if(c.deep)c.deep.summary=deepSummary(c,s.mistakeThreshold);update(result);};
 try{
  if(!targets.length)throw Error('Finish supported candidate reply checks before investigating deeper.');
  for(const c of targets){
   c.deep={status:'running',branches:[]};const after=advance(result.input,c.uci);
   for(const first of c.replies.slice(0,3)){
    client.check();const branch={reply:first.uci,san:first.san,frequency:first.frequency,replies:[],status:'running'};c.deep.branches.push(branch);
    if(!first.supported){branch.status='insufficient_data';emit('Skipping a reply with too few games');continue;}
    const ownState=advance(after,first.uci);
    if(board(ownState).isGameOver()){branch.status='terminal';emit('Terminal first reply');continue;}
    emit('Checking our response: '+c.san+' '+first.san);
    const own=await client.analyse(ownState,Math.min(3,board(ownState).moves().length)),best=scoreOf(own);
    client.check();
    if((Number.isFinite(best.cp)&&Number.isFinite(c.cp)&&best.cp<c.cp)||(best.mate!=null&&best.mate<0)){
     c.cp=best.cp??null;c.mate=best.mate??null;c.defence=first.uci;c.defencePv=[first.uci,...(best.pv||[])];c.depth=best.depth||s.depth;
     c.sacrifice=c.cp!==null&&result.baseline!==null?Math.max(0,result.baseline-c.cp):null;
     c.sound=c.mate!==null?c.mate>0:c.cp!==null&&c.cp>=s.floor&&c.sacrifice!==null&&c.sacrifice<=s.tolerance;
     for(const previous of c.deep.branches)if(previous.firstChecked)previous.firstLossCp=Number.isFinite(previous.firstCp)&&Number.isFinite(c.cp)?Math.max(0,previous.firstCp-c.cp):null;
    }
    first.cp=best.cp??null;first.mate=best.mate??null;first.depth=best.depth||s.depth;
    c.weightedLoss=0;for(const row of c.replies){row.lossCp=Number.isFinite(c.cp)&&Number.isFinite(row.cp)?Math.max(0,row.cp-c.cp):null;if(row.supported&&row.lossCp!==null&&row.lossCp>=s.mistakeThreshold)c.weightedLoss+=row.frequency*row.lossCp;}
    if(s.engineVariant==='single'&&c.defensiveOptions&&c.replyData)c.defenceEvidence=defenceEvidence(c,c.replyData,s);
    branch.firstChecked=true;branch.firstCp=best.cp??null;branch.firstLossCp=Number.isFinite(best.cp)&&Number.isFinite(c.cp)?Math.max(0,best.cp-c.cp):null;
    branch.precision=responsePrecision(own,s.mistakeThreshold,board(ownState).moves().length);
    if(!c.sound){branch.status='outside_limits';emit('Deeper check found a stronger defence; candidate outside soundness limits');break;}
    branch.ownMove=best.uci;branch.ownSan=best.uci?san(ownState,best.uci):null;
    if(!best.uci){branch.status='unknown';emit('No complete own response');continue;}
    const secondState=advance(ownState,best.uci);branch.state=secondState;
    if(board(secondState).isGameOver()){branch.status='terminal';emit('Continuation ends before a second opponent decision');continue;}
    emit('Loading second-turn human replies: '+c.san+' '+first.san+' '+branch.ownSan);
    const data=await db.query(secondState);branch.games=data.games;branch.retrieved=data.retrieved;branch.cached=!!data.cached;
    if(data.games<s.minReplyGames){branch.status='insufficient_data';emit('Insufficient second-turn human data');continue;}
    client.check();emit('Checking the strongest second-turn defence');
    const defence=await client.analyse(secondState,1),baseline=scoreOf(defence);client.check();branch.baselineCp=baseline.cp??null;branch.baselineMate=baseline.mate??null;branch.defence=baseline.uci;branch.baselineDepth=baseline.depth;branch.secondBaselineChecked=true;
    for(const record of selectDeepReplies(data,s.minReplyGames,options.maxReplies??3,options.coverage??1)){
     client.check();const reply={uci:record.uci,san:san(secondState,record.uci),games:record.games,frequency:record.games/data.games,supported:record.games>=s.minReplyGames,lossCp:null};
     if(!reply.supported){branch.replies.push(reply);emit('Second-turn reply has too few games');continue;}
     const punishmentState=advance(secondState,record.uci);emit('Checking delayed mistake: '+reply.san);
     const analysis=await client.analyse(punishmentState,Math.min(3,Math.max(1,board(punishmentState).moves().length))),score=scoreOf(analysis);
     client.check();Object.assign(reply,{cp:score.cp??null,mate:score.mate??null,depth:score.depth||s.depth,punishment:score.pv||[],precision:responsePrecision(analysis,s.mistakeThreshold,board(punishmentState).moves().length)});
     branch.replies.push(reply);
     if(Number.isFinite(reply.cp)&&Number.isFinite(branch.baselineCp)&&reply.cp<branch.baselineCp){branch.baselineCp=reply.cp;branch.defence=reply.uci;}
     if(reply.mate!==null&&reply.mate<0){branch.baselineCp=null;branch.baselineMate=reply.mate;branch.defence=reply.uci;}
     for(const r of branch.replies)r.lossCp=Number.isFinite(r.cp)&&Number.isFinite(branch.baselineCp)?Math.max(0,r.cp-branch.baselineCp):null;
     emit('Second-turn reply checked');
    }
    branch.status='complete';emit('Second opponent decision checked');
   }
   c.deep.status='complete';emit('Deeper checks finished: '+c.san);
  }
  result.deep.status='complete';emit('Selective two-turn investigation complete');
 }catch(error){result.deep.status=client.cancelled?'paused':'partial';result.deep.message=error.message;for(const c of targets)if(c.deep?.status==='running')c.deep.status=result.deep.status;emit('Deeper investigation stopped');}
 return result;
}

// Preserve full-database denominators; sparse and unvisited mass remains unknown.
export function selectDeepReplies(data,minGames,maxReplies=5,coverage=.8){
 const chosen=[];let mass=0;
 for(const move of [...data.moves].sort((a,b)=>b.games-a.games)){
  if(chosen.length>=maxReplies||mass>=coverage*data.games)break;
  if(move.games<minGames)continue;
  chosen.push(move);mass+=move.games;
 }
 return chosen;
}
