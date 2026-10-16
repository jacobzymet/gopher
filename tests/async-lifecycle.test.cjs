const { readUiScript } = require('./helpers/ui-source.cjs');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function load(context, file, name) {
  const source = readUiScript(file).replace(/\r\n/g, '\n');
  const match = source.match(new RegExp('^async function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0], context);
}

test('a poll from before encryption lock cannot restore private UI state', async () => {
  let finish;
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout, performance,
    statePollInFlight: false, storageWriteEpoch: 0,
    fetch: () => new Promise(resolve => { finish = resolve; }),
    syncExternalEncryptionState: () => assert.fail('stale encryption state'),
    updateInferenceState: () => assert.fail('stale provider credentials or paths'),
    resumeLiveTurns: () => assert.fail('stale live turns'),
  });
  load(context, 'runtime.js', 'pollState');
  const pending = context.pollState();
  context.storageWriteEpoch++;
  finish({ ok: true, json: async () => ({ network: { private: true } }) });
  await pending;
  assert.equal(context.statePollInFlight, false);
});

test('a stalled state poll times out and frees the next poll', async () => {
  let timeout;
  let cleared = 0;
  const context = vm.createContext({
    AbortController, performance, statePollInFlight: false, storageWriteEpoch: 0,
    setTimeout: callback => { timeout = callback; return 1; },
    clearTimeout: () => { cleared++; },
    fetch: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
  });
  load(context, 'runtime.js', 'pollState');
  const pending = context.pollState();
  assert.equal(context.statePollInFlight, true);
  timeout();
  await pending;
  assert.equal(context.statePollInFlight, false);
  assert.equal(cleared, 1);
});

test('overlapping steering flushes post each pending instruction once', async () => {
  const sent = [];
  const pending = [];
  const context = vm.createContext({
    postSteerToAgent: async (_, entry) => {
      sent.push(entry.item.id);
      await new Promise(resolve => pending.push(resolve));
    },
    showAttachHint: () => assert.fail('unexpected failure'),
    restoreSteerToQueue: () => assert.fail('unexpected requeue'),
  });
  load(context, 'controls.js', 'flushPendingSteers');
  const first = { item: { id: 'first' } };
  const second = { item: { id: 'second' } };
  const stream = { steerId: 'agent', pendingSteers: [first] };
  const a = context.flushPendingSteers(stream);
  stream.pendingSteers.push(second);
  const b = context.flushPendingSteers(stream);
  assert.deepEqual(sent, ['first']);
  pending.shift()();
  // Let the first request settle before the next instruction can be posted.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['first', 'second']);
  pending.shift()();
  await Promise.all([a, b]);
  await context.flushPendingSteers(stream);
  assert.deepEqual(sent, ['first', 'second']);
  assert.equal(first.posting, false);
  assert.equal(second.posting, false);
});

test('a failed in-flight steer cannot restore an instruction already cancelled', async () => {
  let rejectPost;
  const context = vm.createContext({
    postSteerToAgent: () => new Promise((_, reject) => { rejectPost = reject; }),
    showAttachHint() {},
    restoreSteerToQueue: () => assert.fail('cancelled entry must stay cancelled'),
  });
  load(context, 'controls.js', 'flushPendingSteers');
  const entry = { item: { id: 'cancelled' } };
  const stream = { steerId: 'agent', pendingSteers: [entry] };
  const pending = context.flushPendingSteers(stream);
  stream.pendingSteers.length = 0;
  rejectPost(new Error('request failed'));
  await pending;
  assert.equal(entry.posting, false);
});

function compactHarness() {
  let finish;
  let saves = 0;
  let memories = 0;
  const convo = { id: 'loop', messages: Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: String(i) })) };
  const context = vm.createContext({
    console, BOT_COMPACT_CHARS: 1, BOT_COMPACT_KEEP: 10, storageWriteEpoch: 0,
    conversations: [convo], window: {}, estimateConvoChars: () => 100,
    botsOutboundEpochOf: () => 1, diskEncryptionLocked: () => false,
    isBotGroup: () => true, getBot: () => null,
    conversationModelId: () => 'owning-chat-model',
    collectCompletionText: () => new Promise(resolve => { finish = resolve; }),
    parseCompactJson: () => ({ summary: 'summary', memory: 'memory' }),
    persistGroupMemory: () => { memories++; },
    saveStore: () => { saves++; },
  });
  load(context, 'bots.js', 'maybeCompactBotsConvo');
  return { context, convo, finish: () => finish('result'), saves: () => saves, memories: () => memories };
}

test('Loop compaction commits a current snapshot and preserves its recent messages', async () => {
  const h = compactHarness();
  const kept = h.convo.messages.slice(-10);
  const pending = h.context.maybeCompactBotsConvo(h.convo, null);
  h.finish();
  await pending;
  assert.equal(h.convo.messages.length, 11);
  assert.equal(h.convo.messages[0].content, 'summary');
  assert.deepEqual(Array.from(h.convo.messages.slice(1)), kept);
  assert.equal(h.saves(), 1);
});

for (const [name, mutate] of [
  ['new messages', h => h.convo.messages.push({ role: 'user', content: 'new' })],
  ['an edited message', h => { h.convo.messages[0] = { role: 'user', content: 'edited' }; }],
  ['deletion', h => { h.context.conversations = []; }],
  ['locking', h => { h.context.storageWriteEpoch++; }],
  ['Stop', h => { h.context.botsOutboundEpochOf = () => 2; }],
]) {
  test('late Loop compaction preserves state after ' + name, async () => {
    const h = compactHarness();
    const pending = h.context.maybeCompactBotsConvo(h.convo, null);
    mutate(h);
    const current = h.convo.messages.slice();
    h.finish();
    await pending;
    assert.deepEqual(h.convo.messages, current);
    assert.equal(h.saves(), 0);
    assert.equal(h.memories(), 0);
  });
}
