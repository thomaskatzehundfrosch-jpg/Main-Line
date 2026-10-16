import {key,advance,san} from './core.js';
import {suggestionChoices} from './human-suggestions.js';
function squareCentre(square,flipped=false){const file=square.charCodeAt(0)-97,rank=Number(square[1])-1;return {x:((flipped?7-file:file)+.5)*100,y:((flipped?rank:7-rank)+.5)*100};}
export function humanArrows(result,view,flipped=false,mode='tricks'){
 if(!result||key(view)!==key(result.input))return [];
 const rows=suggestionChoices(result,mode);
 return rows.map(({candidate:c,basis,provisional},i)=>({move:c.uci,san:c.san,rank:i+1,color:i?'#79c8ff':'#1565e8',from:squareCentre(c.uci.slice(0,2),flipped),to:squareCentre(c.uci.slice(2,4),flipped),basis,provisional}));
}

// Conditional on the blue first choice; database frequency, not engine preference.
export function opponentReplyArrow(result,view,flipped=false,mode='tricks'){
 if(!result||key(view)!==key(result.input))return null;
 const choice=suggestionChoices(result,mode)[0]?.candidate;if(!choice)return null;
 const candidate=result.candidates.find(c=>c.uci===choice.uci);if(!candidate?.replyData?.games)return null;
 const reply=[...candidate.replyData.moves].sort((a,b)=>b.games-a.games)[0];if(!reply?.games)return null;
 const after=advance(view,candidate.uci);let label;
 try{label=san(after,reply.uci);}catch{return null;}
 return {move:reply.uci,san:label,after:candidate.san,frequency:reply.games/candidate.replyData.games,games:reply.games,sparse:reply.games<result.settings.minReplyGames,color:'#edbd27',from:squareCentre(reply.uci.slice(0,2),flipped),to:squareCentre(reply.uci.slice(2,4),flipped),basis:'Lichess 2000 rapid · after '+candidate.san};
}
