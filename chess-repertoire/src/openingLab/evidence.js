/** Pure evidence rules shared by interactive investigations and generation. Scores are centipawns. */
export function sacrificeCp(baseline, cp) {
 return Number.isFinite(baseline)&&Number.isFinite(cp)?Math.max(0,baseline-cp):null;
}
export function replyEvidence(replies, baseline, threshold=30) {
 let weightedLoss=0,adequateMass=0,mistakeMass=0;
 for(const reply of replies){
  if(!reply.supported||!Number.isFinite(reply.cp)||!Number.isFinite(baseline))continue;
  const frequency=Math.max(0,Math.min(1,reply.frequency));
  const loss=Math.max(0,reply.cp-baseline);
  if(loss>=threshold){mistakeMass+=frequency;weightedLoss+=frequency*loss;}else adequateMass+=frequency;
 }
 const unknown=Math.max(0,1-adequateMass-mistakeMass);
 return {weightedLoss,adequateMass,mistakeMass,unknown,adequateUpper:Math.min(1,adequateMass+unknown)};
}
export function winLowerBound(wins,n){if(!n)return 0;const z=1.96,p=wins/n;return (p+z*z/(2*n)-z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n);}
