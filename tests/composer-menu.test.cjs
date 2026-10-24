const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readUiScript } = require('./helpers/ui-source.cjs');

const source = name => readUiScript(name).replace(/\r\n/g, '\n');
function load(context, script, name) {
  const match = script.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0], context);
}

test('composer + offers only attachments, terminal and working directory', () => {
  let items;
  const context = vm.createContext({
    plusMenu: { replaceChildren(...next) { items = next; } },
    plusMenuIcons: () => ({ attach: '', terminal: '', workspace: '' }),
    attachmentsUiEnabled: () => true, serverReady: true, diskEncryptionLocked: () => false,
    attachDisabledReason: () => '', sessionWorkspaceRoot: () => 'C:\\work', terminalOpen: false,
    renderPlusMenuItem: item => item,
  });
  load(context, source('controls'), 'renderPlusMenu');
  context.renderPlusMenu();
  assert.deepEqual(items.map(item => item.id), ['attach', 'terminal', 'workspace']);
  assert.equal(items[2].desc, 'C:\\work');
  assert.equal(items[2].disabled, false);
  context.serverReady = false;
  context.renderPlusMenu();
  assert.equal(items[2].disabled, false, 'Folder selection does not require a ready model');
  context.diskEncryptionLocked = () => true;
  context.renderPlusMenu();
  assert.equal(items[2].disabled, true);
});

test('working directory action closes the menu and uses the existing folder picker', () => {
  const events = [];
  const context = vm.createContext({
    setPlusMenuOpen: open => events.push(open), requireUnlockedData: () => true,
    pickSessionWorkspace: () => events.push('pick'),
  });
  load(context, source('controls'), 'handlePlusMenuAction');
  context.handlePlusMenuAction('workspace');
  assert.deepEqual(events, [false, 'pick']);
  context.requireUnlockedData = () => false;
  context.handlePlusMenuAction('workspace');
  assert.deepEqual(events, [false, 'pick', false]);
  for (const retired of ['agent', 'web_search', 'fetch_url', 'deep_research_long', 'deep_research_brief']) {
    context.handlePlusMenuAction(retired);
  }
  assert.deepEqual(events, [false, 'pick', false]);
});

test('saved research preferences and mentions cannot reactivate research mode', () => {
  const state = source('state');
  const context = vm.createContext({
    URL, RECENT_MODELS_MAX: 24, PINNED_MODELS_MAX: 24,
    normalizeChatBackgroundImage: () => '', normalizeModelIds: () => [],
    sessionWorkspaceRoot: () => '', userSkills: [],
  });
  vm.runInContext(state.slice(state.indexOf('const WEB_SEARCH_DEPTHS'), state.indexOf('const DEFAULT_SETTINGS')), context);
  vm.runInContext(state.match(/^const DEFAULT_SETTINGS = \{[\s\S]*?^\};/m)[0], context);
  for (const name of ['normalizeThinkingEffort', 'normalizeSearxngUrl', 'normalizeSettings']) load(context, state, name);
  for (const name of ['resolveTurnSkills', 'resolveForcedTools']) load(context, source('input'), name);
  for (const mode of ['long', 'brief']) {
    context.settings = context.normalizeSettings({ skillDeepResearch: true, deepResearch: mode, agentMode: false, chatRetrieval: false });
    assert.equal(context.settings.deepResearch, 'off');
    assert.equal(context.settings.skillDeepResearch, false);
    const turn = context.resolveTurnSkills(new Set(['deep_research']));
    assert.equal(turn.deepResearch, false);
    assert.equal(turn.useAgent, false);
    assert.equal(turn.skills.web_search, false);
    assert.equal(turn.skills.fetch_url, false);
  }
});

test('retired research flags on old queued turns are omitted from requests', () => {
  const context = vm.createContext({ thinkingEffortForModel: () => null });
  load(context, source('runtime'), 'turnRequestBody');
  const request = context.turnRequestBody({ id: 'chat' }, { base: 'https://example.test', model: 'model' }, {
    apiMessages: [], useAgent: true, turnSkills: { web_search: true }, turnForceTools: [],
    clientTurnId: 'turn', deepResearch: true, deepResearchOutput: 'brief',
  });
  assert.equal(request.agent, true);
  assert.equal(request.skills.web_search, true);
  assert.equal('deep_research' in request, false);
  assert.equal('deep_research_output' in request, false);
});
