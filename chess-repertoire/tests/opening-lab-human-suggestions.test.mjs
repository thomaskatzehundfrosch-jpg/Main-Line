import test from 'node:test';
import assert from 'node:assert/strict';
import {position,board} from '../src/openingLab/core.js';
import {suggestionChoices,suggestionLine,orderedCandidates} from '../src/openingLab/human-suggestions.js';
import {humanArrows} from '../src/openingLab/human-arrows.js';
const input=position('1.e4 e5 *');
function candidate(uci,loss){return {uci,san:uci,cp:20,sound:true,outcomes:{games:1000,wins:600,winRate:.6},coverage:.8,repliesComplete:true,weightedLoss:loss,replies:[]};}
test('a zero-error sound alternative still receives the second arrow and its evidence label',()=>{
 const r={input,status:'complete',settings:{minGames:100},candidates:[candidate('g1f3',30),candidate('f1c4',0)]};
 const choices=suggestionChoices(r);assert.equal(choices.length,2);assert.equal(choices[1].basis,'Win-rate alternative');assert.equal(humanArrows(r,input)[1].color,'#79c8ff');
 r.candidates[1].sound=false;assert.equal(humanArrows(r,input).length,1);
});
test('root iterations supply provisional full engine lines before human checks finish',()=>{
 const r={input,status:'running',settings:{minGames:100},candidates:[],rootLive:[{uci:'g1f3',pv:['g1f3','b8c6','f1b5'],depth:8,cp:20},{uci:'f1c4',pv:['f1c4','g8f6'],depth:8,cp:10}]};
 const choices=suggestionChoices(r);assert.equal(choices.length,2);assert.ok(choices.every(c=>c.provisional));assert.deepEqual(suggestionLine(choices[0].candidate).moves,['g1f3','b8c6','f1b5']);r.status='complete';assert.deepEqual(suggestionChoices(r),[]);
});
test('a deep human branch yields a legal whole line from the original candidate',()=>{
 const c=candidate('g1f3',30);c.deep={branches:[{reply:'b8c6',ownMove:'f1b5',frequency:.5,replies:[{uci:'a7a6',frequency:.6,lossCp:80,supported:true,punishment:['b5a4','g8f6']}]}]};
 const line=suggestionLine(c);const b=board(input);for(const move of line.moves)b.move(move);assert.equal(line.moves.length,6);assert.match(line.basis,/second-turn/);
});
test('Italian candidate list uses recommendation fallback rather than engine discovery order',()=>{
 const quiet={...candidate('c2c3',0),san:'c3',outcomes:{games:1000,wins:500,winRate:.5}};
 const castle={...candidate('e1g1',0),san:'O-O',outcomes:{games:1000,wins:510,winRate:.51}};
 const gambit={...candidate('b2b4',0),san:'b4',outcomes:{games:1000,wins:600,winRate:.6}};
 const r={input,status:'complete',settings:{minGames:100,engineVariant:'single'},candidates:[quiet,castle,gambit]};
 assert.equal(suggestionChoices(r)[0].candidate.uci,'b2b4');
 assert.equal(orderedCandidates(r)[0].uci,'b2b4');
 gambit.sound=false;
 assert.notEqual(orderedCandidates(r)[0].uci,'b2b4');
});
