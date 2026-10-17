import test from 'node:test';
import assert from 'node:assert/strict';
import {position,board,advance} from '../src/openingLab/core.js';
import {parseHumanData,HumanDatabase} from '../src/openingLab/human-data.js';
import {outcomes,winLowerBound,leaders,investigate} from '../src/openingLab/trickiness.js';
const input=position('1.e4 e5 *');
const row=(uci,white,draws,black)=>({uci,white,draws,black,games:white+draws+black});
test('historical wins use repertoire colour and draws are separate from win fraction',()=>{
 assert.deepEqual(outcomes(row('g1f3',60,10,30),'b'),{games:100,wins:30,draws:10,losses:60,winRate:.3,scoreRate:.35});
 assert.ok(winLowerBound(600,1000)>winLowerBound(3,3));
});
test('human records reject illegal or duplicate moves and preserve unlisted reply mass',()=>{
 const x=parseHumanData({white:60,draws:10,black:30,moves:[row('g1f3',20,5,15)]},input);assert.equal(x.games,100);assert.equal(x.moves[0].games,40);
 assert.throws(()=>parseHumanData({white:60,draws:10,black:30,moves:[row('e2e4',20,5,15)]},input),/Invalid/);
 assert.throws(()=>parseHumanData({white:60,draws:10,black:30,moves:[row('g1f3',20,5,15),row('g1f3',20,5,15)]},input),/duplicate/);
});
test('live database fixes 2000 rapid filters and surfaces authentication without inventing data',async()=>{
 const state=position('1.d4 Nf6 2.c4 e6 *');let requested;
 const db=new HumanDatabase('test-only-token',async url=>{requested=new URL(url);return {status:401,ok:false};});
 await assert.rejects(db.query(state),e=>e.status==='authentication_required');assert.equal(requested.searchParams.get('ratings'),'2000');assert.equal(requested.searchParams.get('speeds'),'rapid');
});
test('small samples, unsafe candidates and unfinished reply checks cannot lead',()=>{
 const c={sound:true,outcomes:outcomes(row('g1f3',600,100,300),'w'),repliesComplete:true,coverage:.6,weightedLoss:40};
 const r={settings:{minGames:100},candidates:[c,{...c,uci:'tiny',outcomes:outcomes(row('a2a3',9,0,1),'w'),weightedLoss:100},{...c,uci:'unsafe',sound:false,weightedLoss:1000},{...c,uci:'pending',repliesComplete:false,weightedLoss:1000}]};
 assert.equal(leaders(r).win,c);assert.equal(leaders(r).trick,c);
});
test('bounded investigation uses human frequencies, checks strongest defence, and never calls Maia',async()=>{
 const calls=[],root={games:1000,white:600,draws:100,black:300,moves:[row('g1f3',600,100,300)]};
 const replies={games:1000,white:600,draws:100,black:300,moves:[row('b8c6',300,50,150),row('f7f6',120,20,60)]};
 const db={query:async state=>state.moves.length===input.moves.length?root:replies};
 const client={started:performance.now(),stats:{calls:0},identity:{engine:'test'},check(){},policy(){throw Error('Maia must never be called');},async analyse(state,width){calls.push({state,width});this.stats.calls++;const last=state.moves.at(-1),cp=state.moves.length===input.moves.length?30:last==='f7f6'?150:20;return {complete:true,rows:[{uci:board(state).moves({verbose:true})[0].from+board(state).moves({verbose:true})[0].to,cp,mate:null,depth:16,pv:[]}].map(r=>state.moves.length===input.moves.length?{...r,uci:'g1f3'}:r)};}};
 const s={side:'w',depth:16,candidateLimit:1,minGames:100,minReplyGames:20,mistakeThreshold:40,tolerance:50,floor:-50};
 const r=await investigate(input,s,client,db);assert.equal(r.status,'complete');assert.equal(calls.length,4);const c=r.candidates[0];assert.equal(c.coverage,.7);assert.equal(c.replies[1].frequency,.2);assert.equal(c.replies[1].lossCp,130);assert.equal(c.weightedLoss,26);assert.equal(c.sound,true);
});
test('explorer rook-square castling is normalized for both colours and both wings',()=>{
 for(const [fen,moves,expected]of [
  ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',['e1h1','e1a1'],['e1g1','e1c1']],
  ['r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1',['e8h8','e8a8'],['e8g8','e8c8']]
 ]){
  const state=position(fen,'fen');const records=moves.map(uci=>row(uci,30,10,10));
  const parsed=parseHumanData({white:60,draws:20,black:20,moves:records},state);
  assert.deepEqual(parsed.moves.map(m=>m.uci),expected);assert.ok(parsed.moves.every(m=>m.games===50));
 }
});
test('normalization never permits blocked castling or duplicate canonical castle records',()=>{
 assert.throws(()=>parseHumanData({white:60,draws:20,black:20,moves:[row('e1h1',30,10,10)]},position('')),/Invalid Lichess move/);
 const state=position('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','fen');
 assert.throws(()=>parseHumanData({white:60,draws:20,black:20,moves:[row('e1h1',30,10,10),row('e1g1',30,10,10)]},state),/duplicate/);
});

// Browser fetch requires the Window/global receiver; a method call on HumanDatabase
// must not forward the database instance as the native function's receiver.
test('default explorer fetch preserves the browser global receiver', async () => {
 const original = globalThis.fetch;
 let called = false;
 globalThis.fetch = async function(url, options) {
  assert.equal(this, globalThis);
  assert.equal(new URL(url).hostname, 'explorer.lichess.org');
  assert.equal(options.headers.Authorization, 'Bearer regression-test-token');
  called = true;
  return { status: 401, ok: false };
 };
 try {
  const db = new HumanDatabase('regression-test-token');
  await assert.rejects(db.query(position('1. a3 h6 2. b3 *')), error => error.status === 'authentication_required');
  assert.equal(called, true);
 } finally { globalThis.fetch = original; }
});

test('fixed sacrifice baseline applies independently of the evaluation floor',async()=>{
 const run=async(baselineCp,floor=-50)=>{
  const client={started:performance.now(),stats:{},identity:{engine:'test'},check(){},async analyse(state){return {rows:[{uci:state.moves.length===input.moves.length?'g1f3':board(state).moves({verbose:true}).map(m=>m.from+m.to)[0],cp:state.moves.length===input.moves.length?100:20,mate:null,depth:12,pv:[]}]};}};
  return investigate(input,{side:'w',depth:12,candidateLimit:1,minGames:100,minReplyGames:20,mistakeThreshold:40,tolerance:50,floor,baselineCp},client,{query:async()=>({games:0,white:0,draws:0,black:0,moves:[]})});
 };
 const automatic=await run(null);
 assert.equal(automatic.baseline,100);assert.equal(automatic.candidates[0].sound,false);
 const fixed=await run(0);
 assert.equal(fixed.baseline,0);assert.equal(fixed.candidates[0].sacrifice,0);assert.equal(fixed.candidates[0].sound,true);
 assert.equal((await run(0,30)).candidates[0].sound,false,'floor remains independent');
});

test('rating groups filter requests and isolate cached human evidence',async()=>{
 const state=position('1. a4 h5 2. Ra3 *');let calls=0;
 const fetcher=async url=>{calls++;assert.equal(new URL(url).searchParams.get('ratings'),calls===1?'1600':'2200');return {ok:true,json:async()=>({white:30,draws:10,black:20,moves:[]})};};
 const first=await new HumanDatabase('test',fetcher,1600).query(state);
 const second=await new HumanDatabase('test',fetcher,2200).query(state);
 assert.deepEqual(first.ratings,[1600]);assert.deepEqual(second.ratings,[2200]);
 const cached=await new HumanDatabase('test',()=>{throw Error('should reuse matching group');},1600).query(state);
 assert.equal(cached.cached,true);assert.equal(calls,2);
 assert.throws(()=>new HumanDatabase('test',fetcher,1750),/Unsupported/);
});
