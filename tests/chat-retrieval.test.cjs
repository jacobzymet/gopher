const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const read = (name) => readFileSync(join(__dirname, '../src/ui/chat/scripts', name), 'utf8').replace(/\r\n/g, '\n');
const state = read('state.js');
const render = read('render.js');
const input = read('input.js');
function load(context, source, name) {
  const match = source.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0], context);
}
function settingsContext() {
  const context = vm.createContext({
    URL, RECENT_MODELS_MAX: 24, PINNED_MODELS_MAX: 24,
    normalizeChatBackgroundImage: () => '', normalizeModelIds: () => [],
    sessionWorkspaceRoot: () => '', userSkills: [],
    PROFILE_CONTEXT_KEYS: ['about', 'instructions', 'memory'],
  });
  vm.runInContext(state.slice(state.indexOf('const WEB_SEARCH_DEPTHS'), state.indexOf('const DEFAULT_SETTINGS')), context);
  vm.runInContext(state.match(/^const DEFAULT_SETTINGS = \{[\s\S]*?^\};/m)[0], context);
  for (const name of ['normalizeThinkingEffort', 'normalizeSearxngUrl', 'normalizeSettings', 'preferencesPayload', 'buildSystemPrompt']) load(context, state, name);
  load(context, input, 'resolveTurnSkills');
  load(context, input, 'resolveForcedTools');
  return context;
}
function renderingContext() {
  const context = vm.createContext({
    URL, window: { location: { origin: 'http://gopher.localhost:3930' } },
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    THINK_CHEVRON: '',
  });
  for (const name of ['chatSourceTarget', 'chatRetrievalResultHtml', 'agentStepResultHtml', 'skillLabel', 'skillLiveVerb', 'citeFaviconUrl']) load(context, render, name);
  return context;
}

test('past-chat retrieval defaults on and an explicit off survives normalization and persistence', () => {
  const context = settingsContext();
  assert.equal(context.normalizeSettings(null).chatRetrieval, true);
  assert.equal(context.normalizeSettings({}).chatRetrieval, true);
  const disabled = context.normalizeSettings({ chatRetrieval: false });
  const stored = JSON.parse(JSON.stringify(context.preferencesPayload(disabled)));
  assert.equal(context.normalizeSettings(stored).chatRetrieval, false);
  context.settings = context.normalizeSettings({ agentMode: false });
  assert.equal(context.resolveTurnSkills(new Set()).skills.chat_retrieval, true);
  assert.equal(context.resolveTurnSkills(new Set()).useAgent, true);
  context.settings = disabled;
  assert.equal(context.resolveTurnSkills(new Set()).skills.chat_retrieval, false);
  assert.equal(context.resolveTurnSkills(new Set()).useAgent, false);
});

test('project prompts preserve saved memory without silently injecting sibling messages', () => {
  const context = settingsContext();
  context.settings = context.normalizeSettings({ memory: 'Saved preference' });
  context.window = { GOPHER_PROMPTS: {}, fillPrompt: (template, values) => template ? template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] || '') : '' };
  context.window.GOPHER_PROMPTS['chat.projectMemory'] = '{{memory}}';
  context.window.GOPHER_PROMPTS['chat.globalMemory'] = '{{memory}}';
  context.getProject = () => ({ id: 'p', name: 'Project', instructions: '', memory: 'Saved decision' });
  context.formatPromptToday = () => 'today';
  context.conversations = [{ id: 'other', projectId: 'p', messages: [{ role: 'user', content: 'Secret sibling text' }] }];
  for (const enabled of [true, false]) {
    context.settings.chatRetrieval = enabled;
    const prompt = context.buildSystemPrompt('p');
    assert.match(prompt, /Saved preference/);
    assert.match(prompt, /Saved decision/);
    assert.doesNotMatch(prompt, /Secret sibling text/);
  }
});

test('temporary Ghost chats neither consume nor update any saved memory', () => {
  const context = settingsContext();
  context.settings = context.normalizeSettings({ memory: 'Shared secret', instructions: 'Custom instruction' });
  context.window = {
    GOPHER_PROMPTS: { 'chat.globalMemory': '{{memory}}', 'chat.projectMemory': '{{memory}}', 'chat.globalInstructions': '{{instructions}}' },
    fillPrompt: (template, values) => template ? template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] || '') : '',
  };
  context.getProject = () => ({ name: 'Project', memory: 'Project secret', instructions: '' });
  context.formatPromptToday = () => 'today';
  context.botSystemPromptParts = () => assert.fail('Ghost chat read bot memory');
  const ghost = { incognito: true, projectId: 'p' };
  const prompt = context.buildSystemPrompt('p', { convo: ghost });
  assert.doesNotMatch(prompt, /Shared secret|Project secret/);
  assert.match(prompt, /Custom instruction/);
  context.isIncognitoContext = () => true;
  assert.doesNotMatch(context.buildSystemPrompt('p'), /Shared secret|Project secret/);
  for (const name of ['persistGlobalMemory', 'persistProjectMemory', 'persistBotMemory', 'persistGroupMemory']) {
    context[name] = () => assert.fail('Ghost chat updated saved memory');
  }
  load(context, state, 'applyExtractedMemories');
  const changes = context.applyExtractedMemories(ghost, {
    memory: 'Project', globalMemory: 'Shared', botMemory: 'Bot', groupMemory: 'Group',
  }, 'bot');
  assert.ok(Object.values(changes).every((changed) => changed === false));
});

test('source links stay local and reject foreign or malformed targets', () => {
  const context = renderingContext();
  assert.equal(context.chatSourceTarget('/c/chat%20id?message=3').id, 'chat id');
  assert.equal(context.chatSourceTarget('/c/chat%20id?message=3').message, 3);
  for (const href of ['https://evil.example/c/chat?message=3', '//evil.example/c/chat', 'javascript:alert(1)', '/c/%ZZ', '/api/chats']) {
    assert.equal(context.chatSourceTarget(href), null);
  }
  assert.equal(context.chatSourceTarget('/c/chat?message=-1').message, null);
  assert.equal(context.citeFaviconUrl('/c/chat'), '');
});

test('activity shows titles, roles, excerpts, continuation, and safe source links', () => {
  const context = renderingContext();
  const result = JSON.stringify({ scope: 'current project', next_cursor: 2, results: [{
    chat_id: 'past', url: '/c/past?message=1', title: '<img onerror="bad">',
    role: 'assistant', content: '<script>bad()</script>', truncated: true,
  }] });
  const html = context.agentStepResultHtml(result, 'read_chat');
  assert.match(html, /href="\/c\/past\?message=1"/);
  assert.match(html, /Assistant/);
  assert.match(html, /View retrieved text/);
  assert.match(html, /&lt;script>/);
  assert.match(html, /Partial message/);
  assert.match(html, /More results available/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(context.agentStepResultHtml('{"results":[]}', 'search_chats'), /No matching messages/);
  assert.match(context.agentStepResultHtml('Search is disabled', 'search_chats'), /Search is disabled/);
  assert.equal(context.skillLabel('search_chats'), 'Search past chats');
  assert.equal(context.skillLiveVerb('read_chat'), 'Reading past chat');
});

test('source navigation highlights and focuses the cited message', () => {
  let scrolled = false;
  let focused = false;
  const classes = new Set();
  const row = { scrollIntoView() { scrolled = true; }, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }, setAttribute() {}, focus() { focused = true; } };
  const context = vm.createContext({
    stickToBottom: true, userScrollOverride: false,
    chatThread: { querySelector: (selector) => selector === '.msg[data-msg-index="3"]' ? row : null },
    requestAnimationFrame: (fn) => fn(), window: { setTimeout() {} },
  });
  load(context, render, 'scrollToChatSource');
  context.scrollToChatSource(3);
  assert.equal(scrolled && focused, true);
  assert.equal(context.stickToBottom, false);
  assert.equal(classes.has('is-chat-source'), true);
});
