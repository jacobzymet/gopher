// Run without compiling the app: node --test tests/clear-data.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
  join(__dirname, '../src/ui/chat/scripts/controls.js'),
  'utf8'
).replace(/\r\n/g, '\n');

function declaration(name) {
  const match = source.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
  assert.ok(match, 'missing function ' + name);
  return match[0];
}

function harness(conversations, projects = []) {
  const aborted = [];
  const state = vm.createContext({
    conversations,
    projects,
    activeId: null,
    activeProjectId: null,
    editingQueueId: null,
    editingRow: null,
    mainView: 'chat',
    outboundQueues: new Map(conversations.map((convo) => [convo.id, [{}]])),
    stickByConvo: new Map(conversations.map((convo) => [convo.id, true])),
    requireUnlockedData: () => true,
    confirm: () => true,
    abortStream: (id) => aborted.push(id),
    saveStore() {},
    startDraft() {},
    renderSidebar() {},
    renderProjectsPage() {},
    refreshSettingsDataSummary() {},
    updateGreeting() {},
    closeMentionMenu() {},
  });
  for (const name of ['clearAllChats', 'clearAllChatsAndProjects']) {
    vm.runInContext(declaration(name), state);
  }
  return { state, aborted };
}

test('clearing chats removes every conversation', () => {
  const { state, aborted } = harness([
    { id: 'chat-1', surface: 'chat' },
    { id: 'chat-2', surface: 'chat' },
  ]);
  state.clearAllChats();
  assert.equal(state.conversations.length, 0);
  assert.equal(aborted.sort().join(','), 'chat-1,chat-2');
});

test('clear everything includes chats and projects', () => {
  const { state, aborted } = harness([
    { id: 'chat', surface: 'chat' },
  ], [{ id: 'project' }]);
  state.clearAllChatsAndProjects();
  assert.equal(state.conversations.length, 0);
  assert.equal(state.projects.length, 0);
  assert.equal(aborted.join(','), 'chat');
});
