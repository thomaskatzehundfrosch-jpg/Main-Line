import test from 'node:test';
import assert from 'node:assert/strict';
import {LabEngine} from '../src/openingLab/engine.js';
import {position} from '../src/openingLab/core.js';

test('browser transport completes UCI handshake, preserves root-side scores and cancels immediately', async () => {
  const previous = globalThis.Worker;
  class MockWorker {
    postMessage(command) {
      queueMicrotask(() => {
        const emit = data => this.onmessage?.({data});
        if (command === 'uci') emit('uciok');
        if (command === 'isready') emit('readyok');
        if (command.startsWith('go')) {
          emit(`info depth ${command.match(/depth (\d+)/)[1]} multipv 1 score cp 40 nodes 120 pv e7e5 g1f3`);
          emit('bestmove e7e5');
        }
      });
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = MockWorker;
  try {
    const client = new LabEngine();
    client.start({side:'w',depth:12,totalNodes:0,callNodes:0});
    await client.init();
    const result = await client.analyse(position('1. e4 *'), 1);
    assert.equal(result.rows[0].cp, -40);
    assert.equal(result.rows[0].uci, 'e7e5');
    assert.equal(result.complete, true);
    await client.analyse(position('1. e4 *'), 1);
    assert.equal(client.stats.calls, 1, 'same-depth search reuses cache');
    assert.equal(client.stats.hits, 1);
    client.settings = {...client.settings, depth:14};
    await client.analyse(position('1. e4 *'), 1);
    assert.equal(client.stats.calls, 2, 'higher depth performs fresh work');
    client.settings.bypassCache = true;
    await client.analyse(position('1. e4 *'), 1);
    assert.equal(client.stats.calls, 3, 'force recompute bypasses completed cache');
    client.sf.postMessage = () => {};
    const pending = client.analyse(position('1. d4 *'), 1);
    client.pause();
    await assert.rejects(pending, /Stopped/);
    assert.ok(client.sf.terminated);
  } finally { globalThis.Worker = previous; }
});
