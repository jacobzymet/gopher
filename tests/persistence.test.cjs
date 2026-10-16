const { readUiScript } = require('./helpers/ui-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const vm = require('node:vm');

function harness(fetch) {
  const source = readUiScript("state").replace(/\r\n/g, '\n');
  const state = vm.createContext({
    fetch, AbortController, setTimeout, clearTimeout, queueMicrotask,
    reportPersistenceFailure() {},
    storageWriteEpoch: 0,
    diskEncryptionLocked: () => false,
    storeWriteChain: Promise.resolve(),
    pendingStoreWrite: null, activeStoreWrite: null, storeWriteRunning: false,
  });
  for (const name of ['putJsonWithRetry', 'enqueueStoreWrite', 'drainStoreWrites']) {
    const match = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
    vm.runInContext(match[0], state);
  }
  return state;
}

test('save releases echoed response bodies before the next queued write', async () => {
  let occupied = false;
  let released = 0;
  const state = harness(async () => {
    assert.equal(occupied, false);
    occupied = true;
    return { ok: true, body: { async cancel() { occupied = false; released++; } } };
  });
  const first = state.enqueueStoreWrite({ a: 1 });
  await Promise.resolve();
  await Promise.all([first, state.enqueueStoreWrite({ a: 2 })]);
  assert.equal(released, 2);
});

test('a burst of snapshots writes only the active save and the latest replacement', async () => {
  const writes = [];
  const finish = [];
  const state = harness((_, options) => {
    writes.push(JSON.parse(options.body));
    return new Promise((resolve) => finish.push(() => resolve({ ok: true, body: null })));
  });
  const first = state.enqueueStoreWrite({ version: 1 });
  await Promise.resolve();
  const second = state.enqueueStoreWrite({ version: 2 });
  const third = state.enqueueStoreWrite({ version: 3 });
  let secondDone = false;
  second.then(() => { secondDone = true; });
  assert.deepEqual(writes, [{ version: 1 }]);
  finish.shift()();
  assert.equal(await first, true);
  await new Promise(setImmediate);
  assert.deepEqual(writes, [{ version: 1 }, { version: 3 }]);
  assert.equal(secondDone, false, 'superseded callers must wait until the replacement is saved');
  finish.shift()();
  assert.equal(await second, true);
  assert.equal(await third, true);
  assert.equal(state.storeWriteRunning, false);
});

test('synchronous queue changes persist only the final dispatched snapshot', async () => {
  const writes = [];
  const state = harness(async (_, options) => {
    writes.push(JSON.parse(options.body));
    return { ok: true, body: null };
  });
  await Promise.all([
    state.enqueueStoreWrite({ queued: ['hello'], messages: [] }),
    state.enqueueStoreWrite({ queued: [], messages: [] }),
    state.enqueueStoreWrite({ queued: [], messages: ['hello'] }),
  ]);
  assert.deepEqual(writes, [{ queued: [], messages: ['hello'] }]);
});

test('identical pre-send saves share one durable write', async () => {
  let writes = 0;
  let finish;
  const state = harness(() => {
    writes++;
    return new Promise((resolve) => { finish = () => resolve({ ok: true, body: null }); });
  });
  const first = state.enqueueStoreWrite({ messages: ['hello'] });
  await Promise.resolve();
  const retrieval = state.enqueueStoreWrite({ messages: ['hello'] });
  let ready = false;
  retrieval.then(() => { ready = true; });
  await new Promise(setImmediate);
  assert.equal(writes, 1);
  assert.equal(ready, false);
  finish();
  assert.equal(await first, true);
  assert.equal(await retrieval, true);
  assert.equal(writes, 1);
});

test('queued snapshots retain their content when live messages mutate', async () => {
  const writes = [];
  const finish = [];
  const state = harness((_, options) => {
    writes.push(JSON.parse(options.body));
    return new Promise((resolve) => finish.push(() => resolve({ ok: true, body: null })));
  });
  const first = state.enqueueStoreWrite({ messages: [] });
  await Promise.resolve();
  const live = { messages: ['saved'] };
  const second = state.enqueueStoreWrite(live);
  live.messages.push('not yet saved');
  finish.shift()();
  await first;
  assert.deepEqual(writes[1], { messages: ['saved'] });
  finish.shift()();
  await second;
});

test('queued snapshots from before lock are discarded without another request', async () => {
  const writes = [];
  let finish;
  const state = harness((_, options) => {
    writes.push(JSON.parse(options.body));
    return new Promise((resolve) => { finish = () => resolve({ ok: true, body: null }); });
  });
  const first = state.enqueueStoreWrite({ version: 1 });
  await Promise.resolve();
  const stale = state.enqueueStoreWrite({ version: 2 });
  state.storageWriteEpoch++;
  finish();
  await first;
  assert.equal(await stale, false);
  assert.equal(writes.length, 1);
});

test('a stalled save times out and later writes can complete', async () => {
  let firstSignal;
  let calls = 0;
  const state = harness(async (_, options) => {
    if (++calls === 1) {
      firstSignal = options.signal;
      return new Promise(() => {});
    }
    return { ok: true, body: null };
  });
  assert.equal(await state.putJsonWithRetry('/save', {}, { attempts: 1, timeoutMs: 5 }), false);
  assert.equal(firstSignal.aborted, true);
  assert.equal(await state.enqueueStoreWrite({ a: 2 }), true);
});
