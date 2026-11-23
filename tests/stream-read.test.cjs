const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../src/ui/chat/scripts/runtime.js'), 'utf8').replace(/\r\n/g, '\n');
const context = vm.createContext({});
vm.runInContext(source.match(/^async function readStreamChunk\([\s\S]*?^\}$/m)[0], context);

function trackedSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  const listeners = new Set();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (event, listener, options) => { listeners.add(listener); add(event, listener, options); };
  signal.removeEventListener = (event, listener) => { listeners.delete(listener); remove(event, listener); };
  return { controller, signal, listeners };
}

test('stream reads release abort listeners after every chunk and error', async () => {
  const { signal, listeners } = trackedSignal();
  for (let i = 0; i < 1000; i++) {
    const result = await context.readStreamChunk({ read: async () => ({ value: i, done: false }) }, signal);
    assert.equal(result.chunk.value, i);
    assert.equal(listeners.size, 0);
  }
  await assert.rejects(context.readStreamChunk({ read: async () => { throw new Error('read failed'); } }, signal), /read failed/);
  assert.equal(listeners.size, 0);
});

test('Stop releases a stalled read and never starts another read after abort', async () => {
  const { controller, signal, listeners } = trackedSignal();
  const pending = context.readStreamChunk({ read: () => new Promise(() => {}) }, signal);
  assert.equal(listeners.size, 1);
  controller.abort();
  assert.equal((await pending).aborted, true);
  assert.equal(listeners.size, 0);
  assert.equal((await context.readStreamChunk({ read: () => assert.fail('already aborted') }, signal)).aborted, true);
});
