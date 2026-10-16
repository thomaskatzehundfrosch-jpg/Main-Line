import {leaders} from './trickiness.js';
export function suggestionChoices(result,mode='tricks'){
 if(!result)return [];
 const ranking=leaders(result),choices=[],seen=new Set();
 const add=(candidate,basis,provisional=false)=>{if(seen.has(candidate.uci)||candidate.sound===false)return;seen.add(candidate.uci);choices.push({candidate,basis,provisional});};
 for(const c of mode==='wins'?ranking.wins:ranking.tricks)add(c,mode==='wins'?'Win-rate evidence':'Common-mistake opportunity',result.status!=='complete');
 if(mode!=='wins'&&result.settings.engineVariant==='single')for(const c of ranking.rare||[])add(c,'Rare move · narrow engine-estimated defences; human difficulty may be unknown',result.status!=='complete');
 for(const c of ranking.wins)add(c,'Win-rate alternative',result.status!=='complete');
 for(const c of [...result.candidates].filter(c=>c.sound).sort((a,b)=>(b.cp??-Infinity)-(a.cp??-Infinity)))add(c,'Sound engine alternative · limited human evidence',result.status!=='complete');
 if(result.status!=='complete')for(const row of result.rootLive||result.discovery?.rows||[])add({...row,sound:null},'Engine preview · human checks pending',true);
 return choices.slice(0,2);
}
export function suggestionLine(candidate){
 const deep=[];
 for(const branch of candidate.deep?.branches||[])for(const reply of branch.replies||[])if(reply.supported&&reply.lossCp>0&&reply.punishment?.length&&branch.ownMove)deep.push({moves:[candidate.uci,branch.reply,branch.ownMove,reply.uci,...reply.punishment],basis:'Recorded second-turn reply + engine continuation',weight:branch.frequency*reply.frequency*reply.lossCp});
 if(deep.length)return deep.sort((a,b)=>b.weight-a.weight)[0];
 const replies=(candidate.replies||[]).filter(r=>r.punishment?.length);
 if(replies.length){const reply=[...replies].sort((a,b)=>(b.supported?b.frequency*(b.lossCp||0):0)-(a.supported?a.frequency*(a.lossCp||0):0)||b.frequency-a.frequency)[0];return {moves:[candidate.uci,reply.uci,...reply.punishment],basis:'Recorded human reply + engine continuation'};}
 return {moves:candidate.livePv||[candidate.uci,...(candidate.defencePv||candidate.pv?.slice(1)||[])],basis:'Strongest searched defence · engine continuation'};
}

// Keep the candidate list aligned with the original lab's suggested lines.
// Discovery order is not recommendation order when human evidence is limited.
export function orderedCandidates(result,mode='tricks'){
 if(!result)return [];
 const choices=suggestionChoices(result,mode),rank=new Map(choices.map((choice,index)=>[choice.candidate.uci,index]));
 return [...result.candidates].sort((a,b)=>(rank.get(a.uci)??Infinity)-(rank.get(b.uci)??Infinity));
}
