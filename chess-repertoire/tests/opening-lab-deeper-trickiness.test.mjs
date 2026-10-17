import test from 'node:test';
import assert from 'node:assert/strict';
import {position,board,uci} from '../src/openingLab/core.js';
import {deepen,deepTargets,deepSummary,defenceAccess,responsePrecision,selectDeepReplies} from '../src/openingLab/deeper-trickiness.js';
const input=position('1.e4 e5 *');
const first=(move,freq,loss)=>({uci:move,san:move,frequency:freq,lossCp:loss,supported:true});
test('two-turn error mass counts first mistakes only once and retains unlisted mass',()=>{
 const c={replies:[first('b8c6',.6,100),first('g8f6',.4,0)],deep:{branches:[{reply:'b8c6',secondBaselineChecked:true,replies:[first('a7a6',1,200)]},{reply:'g8f6',secondBaselineChecked:true,replies:[first('a7a6',.5,100)]}]}};
 let s=deepSummary(c,40);assert.equal(s.firstMistakes,.6);assert.equal(s.delayedMistakes,.2);assert.equal(s.lower,.8);assert.equal(s.upper,1);assert.ok(Math.abs(s.unknown-.2)<1e-10);
 c.deep.branches[1].replies.push(first('a7a5',.5,0));s=deepSummary(c,40);assert.equal(s.lower,.8);assert.equal(s.upper,.8);assert.equal(s.unknown,0);
});
test('sparse replies and mate scores remain unknown rather than becoming easy defences',()=>{
 const x=defenceAccess([first('a7a6',.3,0),{...first('a7a5',.4,100),supported:false},first('h7h6',.2,null)],40);assert.equal(x.adequate,.3);assert.equal(x.mistakes,0);assert.equal(x.unknown,.7);
});
test('response precision compares top engine responses without claiming human ability',()=>{
 const p=responsePrecision({complete:true,rows:[{cp:100,depth:25},{cp:30,depth:25},{cp:20,depth:25}]},40,30);assert.equal(p.checked,3);assert.equal(p.adequate,1);assert.equal(p.secondBestLossCp,70);assert.equal(p.legalCount,30);assert.equal(responsePrecision({rows:[{mate:2,cp:null}]},40,30),null);
});
function fixture(){const c={uci:'g1f3',san:'Nf3',cp:0,mate:null,sound:true,outcomes:{games:1000,wins:600,winRate:.6},repliesComplete:true,coverage:.8,weightedLoss:0,replies:[first('b8c6',.5,20),first('f7f6',.3,20)]};return {input,baseline:0,status:'complete',settings:{side:'w',depth:25,minGames:100,minReplyGames:20,mistakeThreshold:40,tolerance:50,floor:-50},candidates:[c]};}
test('top-two deep selection falls back to supported win-rate candidates without error opportunities',()=>{
 const r=fixture();r.candidates.push({...r.candidates[0],uci:'f1c4',san:'Bc4'});r.candidates.push({...r.candidates[0],uci:'a2a3',repliesComplete:false});assert.equal(deepTargets(r).length,2);
});
test('selective deep search is bounded, uses conditional human counts and never calls a policy',async()=>{
 const r=fixture(),client={started:performance.now(),stats:{calls:0},check(){},policy(){throw Error('No Maia');},async analyse(state,width){this.stats.calls++;return {complete:true,rows:board(state).moves({verbose:true}).slice(0,width).map((m,i)=>({uci:uci(m),cp:(state.moves.length===6?100:state.moves.length===4?20:0)-i*60,mate:null,depth:25,pv:[uci(m)]}))};}};
 let queries=0;const db={async query(state){queries++;return {games:1000,moves:board(state).moves({verbose:true}).slice(0,3).map((m,i)=>({uci:uci(m),games:[500,300,100][i]}))};}};
 await deepen(r,client,db);assert.equal(r.deep.status,'complete');assert.equal(queries,2);assert.ok(client.stats.calls<=10);assert.equal(r.candidates[0].deep.branches.length,2);assert.ok(r.candidates[0].deep.summary.delayedMistakes>.7);assert.equal(r.candidates[0].deep.branches[0].precision.adequate,1);
});
test('stopping deeper investigation retains first-turn evidence and marks the result paused',async()=>{
 const r=fixture(),client={started:performance.now(),stats:{},cancelled:true,check(){throw Error('Paused');}};
 await deepen(r,client,{});assert.equal(r.deep.status,'paused');assert.equal(r.candidates[0].deep.status,'paused');assert.equal(r.candidates[0].deep.summary.unknown,1);
});
test('a newly discovered strong defence removes an unsafe candidate without expanding it',async()=>{
 const r=fixture(),client={started:performance.now(),stats:{calls:0},check(){},async analyse(state,width){this.stats.calls++;return {complete:true,rows:board(state).moves({verbose:true}).slice(0,width).map(m=>({uci:uci(m),cp:-100,mate:null,depth:25,pv:[uci(m)]}))};}};
 await deepen(r,client,{query(){throw Error('Unsafe candidate must not be expanded');}});
 assert.equal(r.deep.status,'complete');assert.equal(r.candidates[0].sound,false);assert.equal(r.candidates[0].cp,-100);assert.equal(client.stats.calls,1);assert.equal(r.candidates[0].deep.branches[0].status,'outside_limits');
});

test('adaptive reply breadth stops at coverage or cap and excludes unsupported records',()=>{
 const data={games:1000,moves:[{uci:'a',games:500},{uci:'b',games:200},{uci:'c',games:100},{uci:'d',games:50},{uci:'e',games:10}]};
 assert.deepEqual(selectDeepReplies(data,20,5,.8).map(m=>m.uci),['a','b','c']);
 assert.equal(selectDeepReplies(data,20,2,.8).length,2);
 assert.equal(selectDeepReplies(data,20,5,1).length,4);
});
test('deeper searches use increased engine depth and selected candidate only',async()=>{
 const r=fixture();r.candidates.push({...r.candidates[0],uci:'f1c4',san:'Bc4'});
 const client={settings:{depth:27},started:performance.now(),stats:{calls:0},check(){},async analyse(state,width){this.stats.calls++;return {complete:true,rows:board(state).moves({verbose:true}).slice(0,width).map(m=>({uci:uci(m),cp:0,mate:null,depth:27,pv:[uci(m)]}))};}};
 await deepen(r,client,{query:async()=>({games:0,moves:[]})},'tricks',()=>{},{targetUci:'g1f3',maxReplies:5,coverage:.8});
 assert.equal(r.deep.depth,27);
 assert.equal(r.settings.depth,25,'first tier provenance stays unchanged');
 assert.deepEqual(r.deep.targets,['g1f3']);
 assert.equal(r.candidates[1].deep,undefined);
});

test('expanded variants investigate additional supported first replies',async()=>{
 const r=fixture();
 const after=board(r.input);after.move('Nf3');
 r.candidates[0].replyData={games:1000,moves:after.moves({verbose:true}).slice(0,7).map(m=>({uci:uci(m),games:100}))};
 const client={settings:{depth:27},started:performance.now(),stats:{calls:0},check(){},async analyse(state,width){this.stats.calls++;return {rows:board(state).moves({verbose:true}).slice(0,width).map(m=>({uci:uci(m),cp:0,mate:null,depth:27,pv:[uci(m)]}))};}};
 await deepen(r,client,{query:async()=>({games:0,moves:[]})},'tricks',()=>{},{targetUci:'g1f3',firstMaxReplies:6,maxReplies:8,coverage:.95});
 assert.equal(r.deep.status,'complete');
 assert.equal(r.candidates[0].deep.branches.length,6);
 assert.ok(r.candidates[0].deep.branches.every(b=>b.firstChecked));
});
