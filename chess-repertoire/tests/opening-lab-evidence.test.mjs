import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replyEvidence,sacrificeCp} from '../src/openingLab/evidence.js';
test('shared evidence preserves sparse and unvisited probability as unknown',()=>{
 const e=replyEvidence([{cp:100,frequency:.4,supported:true},{cp:0,frequency:.2,supported:true},{cp:200,frequency:.3,supported:false}],0,30);
 assert.equal(e.weightedLoss,40);assert.equal(e.mistakeMass,.4);assert.ok(Math.abs(e.unknown-.4)<1e-8);assert.ok(Math.abs(e.adequateUpper-.6)<1e-8);
 assert.equal(sacrificeCp(40,-10),50);assert.equal(sacrificeCp(0,10),0);assert.equal(sacrificeCp(null,10),null);
});
