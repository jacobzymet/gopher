const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function harness(fetch) {
  const source = readFileSync(join(__dirname, '../src/ui/chat/scripts/state.js'), 'utf8').replace(/\r\n/g, '\n');
  const state = vm.createContext({
    fetch, AbortController, setTimeout, clearTimeout,
    reportPersistenceFailure() {},
    storageWriteEpoch: 0,
    diskEncryptionLocked: () => false,
    storeWriteChain: Promise.resolve(),
    pendingStoreWrite: null, storeWriteRunning: false,
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
  await Promise.all([state.enqueueStoreWrite({ a: 1 }), state.enqueueStoreWrite({ a: 2 })]);
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

test('queued snapshots from before lock are discarded without another request', async () => {
  const writes = [];
  let finish;
  const state = harness((_, options) => {
    writes.push(JSON.parse(options.body));
    return new Promise((resolve) => { finish = () => resolve({ ok: true, body: null }); });
  });
  const first = state.enqueueStoreWrite({ version: 1 });
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
