// Run without compiling the app: node --test tests/loops-removal.test.cjs
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

test('legacy Loop transcripts become ordinary chats without resuming their queued automation', () => {
  const declaration = read('src/ui/chat/scripts/state.js').match(/^function normalizeConversation\([\s\S]*?^\}$/m);
  assert.ok(declaration);
  const context = vm.createContext({ newId: () => 'new', normalizeOutboundItem: (item) => item });
  vm.runInContext(declaration[0], context);
  const messages = [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Answer', speakerHandle: 'solver' }];
  const old = {
    id: 'old', title: 'Saved conversation', surface: 'bots', messages,
    loopAgents: [{ id: 'solver', memory: 'Preserved historical configuration' }],
    outboundQueue: [{ id: 'queued', displayText: 'Do not auto-run this' }],
  };
  const migrated = context.normalizeConversation(old);
  assert.equal(migrated.surface, 'chat');
  assert.equal(migrated.messages, messages);
  assert.equal(migrated.outboundQueue.length, 0);
  assert.equal(migrated.loopAgents[0].memory, old.loopAgents[0].memory);
  assert.equal(context.normalizeConversation({ ...old, surface: 'chat' }).outboundQueue.length, 1);
});

test('Loops controls, prompts and scripts are removed from the shipped app', () => {
  const html = read('src/ui/chat.html');
  assert.doesNotMatch(html, /New loop|Clear all loops|Loop progress|data-surface="bots"|id="groupModal"|id="wordmarkMenu"/);
  assert.doesNotMatch(read('build.rs'), /bots\.(js|css)/);
  for (const path of ['src/ui/chat/scripts/bots.js', 'src/ui/chat/styles/bots.css', 'prompts/chat/bot-group.md']) {
    assert.equal(existsSync(join(root, path)), false, path);
  }
});

test('the unlock screen cannot be dismissed', () => {
  const html = read('src/ui/chat.html');
  assert.doesNotMatch(html, /btnUnlockModalDismiss|Not now/);
  assert.match(html, /Unlock Gopher/);
  const state = read('src/ui/chat/scripts/state.js');
  assert.match(state, /case 'unlockModal': focusUnlockPassphrase\(\); break;/);
  assert.match(read('src/web/mod.rs'), /data-session-locked=\\"true\\"/);
});
