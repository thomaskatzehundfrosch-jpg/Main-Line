import test from 'node:test';
import assert from 'node:assert/strict';
import {position,board,uci} from '../src/openingLab/core.js';
import {rarityOf,rareScreenMoves,examineDefences,defenceEvidence,rareLeaders} from '../src/openingLab/rarity.js';
import {selectCandidates,leaders} from '../src/openingLab/trickiness.js';
const input=position('1.e4 e5 *');
test('unlisted moves retain unknown frequency when database reply list is truncated',()=>{
 const db={games:1000,moves:[{uci:'g1f3',games:800}]};assert.equal(rarityOf(db,'a2a3').upper,.2);assert.equal(rarityOf(db,'a2a3').frequency,null);assert.equal(rarityOf(db,'g1f3').frequency,.8);
});
test('Stockfish reserves discovery space for rare screen-sound alternatives; Patricia selection does not change',()=>{
 const db={games:1000,moves:[{uci:'g1f3',games:800,white:400,draws:80,black:320},{uci:'f1c4',games:190,white:95,draws:19,black:76},{uci:'a2a3',games:10,white:5,draws:1,black:4}]};
 const screen={rows:[{uci:'g1f3',cp:30},{uci:'f1c4',cp:20},{uci:'a2a3',cp:10},{uci:'f2f3',cp:-200}]},s={side:'w',floor:-50,tolerance:50,minGames:100,candidateLimit:3,engineVariant:'single'};
 const rare=rareScreenMoves(db,screen,s);assert.ok(rare.includes('a2a3'));assert.ok(!rare.includes('f2f3'));
 const sf=selectCandidates(input,db,{rows:screen.rows.slice(0,2)},{...s,rareMoves:rare});assert.ok(sf.includes('a2a3'));
 const pat=selectCandidates(input,db,{rows:screen.rows.slice(0,2)},{...s,engineVariant:'patricia',rareMoves:rare});assert.deepEqual(pat.slice(0,2),['g1f3','f1c4']);
});
test('progressive MultiPV widens until the adequate-defence boundary is found',async()=>{
 const widths=[],moves=board(input).moves({verbose:true}).map(uci),client={check(){},async analyse(state,width){widths.push(width);return {rows:moves.slice(0,width).map((uci,i)=>({uci,cp:i<3?i*10:50+i,depth:25}))};}};
 const d=await examineDefences(input,client,{mistakeThreshold:40},()=>{});assert.deepEqual(widths,[3,6]);assert.equal(d.legalCount,moves.length);assert.equal(d.rankBoundary,true);
 const c={cp:0,replies:[],defensiveOptions:d};const e=defenceEvidence(c,{games:1000,moves:[{uci:moves[0],games:200},{uci:moves[2],games:300},{uci:moves[7],games:500}]},{minReplyGames:20,mistakeThreshold:40});
 assert.equal(e.adequateCount,3);assert.equal(e.adequateMass,.5);assert.equal(e.adequateUpper,1);assert.equal(e.unknown,.5);
});
test('rare low-data candidates stay visible without inventing human difficulty or historical win-rate leaders',()=>{
 const c={uci:'a2a3',cp:10,sound:true,outcomes:{games:3,wins:2,winRate:2/3},rarity:{upper:.003},repliesComplete:true,coverage:0,weightedLoss:0,replyData:{games:3},defenceEvidence:{adequateCount:1,adequateUpper:1}};
 const r={settings:{engineVariant:'single',minGames:100},candidates:[c]};assert.equal(rareLeaders(r)[0],c);assert.equal(leaders(r).rare[0],c);assert.equal(leaders(r).win,null);assert.equal(leaders(r).trick,null);
});
test('Stockfish human ranking prefers hard-to-find adequate defences before rarity',()=>{
 const c={sound:true,repliesComplete:true,replyData:{games:1000},outcomes:{games:1000,wins:500,winRate:.5},weightedLoss:50,rarity:{upper:.01},defenceEvidence:{adequateUpper:.8,adequateCount:1}};
 const difficult={...c,uci:'difficult',rarity:{upper:.04},defenceEvidence:{adequateUpper:.2,adequateCount:2}};
 const r={settings:{engineVariant:'single',minGames:100},candidates:[c,difficult]};assert.equal(leaders(r).trick,difficult);
});
test('zero human data retains engine-screened alternatives without calling them known rare',()=>{
 const s={side:'w',floor:-50,tolerance:50,minGames:100,candidateLimit:6,engineVariant:'single'};
 const db={games:0,moves:[]},analysis={rows:[{uci:'g1f3',cp:30},{uci:'f1c4',cp:20}]};assert.equal(rareScreenMoves(db,analysis,s).length,2);
 const c={sound:true,cp:20,outcomes:null,rarity:rarityOf(db,'g1f3'),repliesComplete:true,defenceEvidence:{adequateCount:2}};const r={settings:s,candidates:[c]};assert.equal(rareLeaders(r)[0],c);assert.equal(c.rarity.upper,null);assert.equal(leaders(r).trick,null);
});
