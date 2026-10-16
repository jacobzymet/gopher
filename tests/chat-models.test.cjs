const { chromium, appTestsEnabled, spawnApp, browserLaunchOptions, stopApp, removeAppData } = require('./helpers/app.cjs');
const { readUiScript } = require('./helpers/ui-source.cjs');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function load(context, file, names) {
  const source = readUiScript(file).replace(/\r\n/g, '\n');
  for (const name of names) {
    const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}

function harness() {
  let saves = 0;
  const context = vm.createContext({
    settings: { selectedChatModel: 'provider|default', recentModelIds: [], pinnedModelIds: [] },
    conversations: [{ id: 'a', messages: [] }, { id: 'b', messages: [] }],
    activeId: 'a', draftModelId: '', selectedChatModel: '', selectedRemoteModelId: '',
    modelMenuOptions: [], recentModelIds: [], pinnedModelIds: [], modelMenuContext: null,
    chatModelSelect: { textContent: '' }, settingsModal: null, latestState: null,
    requireUnlockedData: () => true, saveConversations: () => { saves++; },
    saveSettings(next) { context.settings = next; },
    rememberRecentModel() {}, closeModelMenu() {}, setIdentityTitle() {}, syncModelOriginPill() {},
    normalizeLoopRun: () => null, newId: () => 'new',
  });
  load(context, 'state.js', ['conversationModelId', 'syncConversationModel', 'setChatModelSelection', 'persistModelPickerState', 'normalizeConversation']);
  load(context, 'runtime.js', ['resolveSavedModelId', 'modelIdLabel', 'chooseModelOption']);
  return { context, saves: () => saves };
}

test('manual picks belong only to their chat and never overwrite the default', () => {
  const h = harness();
  h.context.chooseModelOption('provider|alpha');
  assert.equal(h.context.conversations[0].modelId, 'provider|alpha');
  assert.equal(h.context.settings.selectedChatModel, 'provider|default');
  h.context.activeId = 'b';
  h.context.syncConversationModel();
  assert.equal(h.context.selectedChatModel, 'provider|default');
  h.context.chooseModelOption('provider|beta');
  h.context.activeId = 'a';
  h.context.syncConversationModel();
  assert.equal(h.context.selectedChatModel, 'provider|alpha');
  assert.equal(h.context.conversations[1].modelId, 'provider|beta');
  assert.equal(h.saves(), 2);
});

test('inherited chats follow future defaults and manual chats stay fixed', () => {
  const { context: s } = harness();
  s.chooseModelOption('provider|alpha');
  s.settings.selectedChatModel = 'provider|new-default';
  assert.equal(s.conversationModelId(s.conversations[0]), 'provider|alpha');
  assert.equal(s.conversationModelId(s.conversations[1]), 'provider|new-default');
  s.chooseModelOption('@default');
  assert.equal(s.conversations[0].modelId, undefined);
  assert.equal(s.selectedChatModel, 'provider|new-default');
  s.settings.selectedChatModel = 'provider|next-default';
  s.syncConversationModel();
  assert.equal(s.selectedChatModel, 'provider|next-default');
});

test('explicitly choosing the current default still records a manual choice', () => {
  const { context: s } = harness();
  s.syncConversationModel();
  s.chooseModelOption(s.selectedChatModel);
  s.settings.selectedChatModel = 'provider|next-default';
  s.syncConversationModel();
  assert.equal(s.selectedChatModel, 'provider|default');
});

test('recents and pins cannot persist the active chat model as the default', () => {
  const { context: s } = harness();
  s.chooseModelOption('provider|alpha');
  s.recentModelIds = ['provider|alpha'];
  s.pinnedModelIds = ['provider|beta'];
  s.persistModelPickerState();
  assert.equal(s.settings.selectedChatModel, 'provider|default');
  assert.equal(s.settings.recentModelIds[0], 'provider|alpha');
  assert.equal(s.settings.pinnedModelIds[0], 'provider|beta');
});

test('chat choices survive normalization and reload; legacy chats inherit the default', () => {
  const { context: s } = harness();
  s.chooseModelOption('provider|alpha');
  s.conversations = JSON.parse(JSON.stringify(s.conversations)).map(s.normalizeConversation);
  s.syncConversationModel();
  assert.equal(s.selectedChatModel, 'provider|alpha');
  assert.equal(s.conversationModelId(s.conversations[1]), 'provider|default');
  assert.equal(s.normalizeConversation({ modelId: 123 }).modelId, '');
});

test('draft choices are separate from saved chats and global defaults', () => {
  const { context: s } = harness();
  s.activeId = null;
  s.chooseModelOption('provider|draft');
  assert.equal(s.draftModelId, 'provider|draft');
  assert.equal(s.settings.selectedChatModel, 'provider|default');
  s.activeId = 'a';
  s.syncConversationModel();
  assert.equal(s.selectedChatModel, 'provider|default');
});

test('Loop agent picker callbacks cannot change the chat choice or default', () => {
  const { context: s } = harness();
  let agentModel;
  s.modelMenuContext = { onPick(value) { agentModel = value; } };
  s.chooseModelOption('provider|agent');
  assert.equal(agentModel, 'provider|agent');
  assert.equal(s.conversations[0].modelId, undefined);
  assert.equal(s.settings.selectedChatModel, 'provider|default');
});

test('a temporary catalog absence preserves a manual model rather than falling back', () => {
  const { context: s } = harness();
  s.conversations[0].modelId = 'provider|missing';
  s.modelMenuOptions = [{ value: 'provider|default', label: 'default' }];
  s.syncConversationModel();
  assert.equal(s.selectedChatModel, 'provider|missing');
  assert.equal(s.settings.selectedChatModel, 'provider|default');
});

test('saved provider identities never migrate to a different provider with the same model', () => {
  const { context: s } = harness();
  const options = [{ value: 'remote|nvidia|https://nvidia.invalid/v1|shared', providerId: 'nvidia', base: 'https://nvidia.invalid/v1', label: 'shared' }];
  assert.equal(s.resolveSavedModelId('remote|chosen|https://chosen.invalid/v1|shared', options), 'remote|chosen|https://chosen.invalid/v1|shared');
  assert.equal(s.resolveSavedModelId('chosen|shared', options), 'chosen|shared');
  assert.equal(s.resolveSavedModelId('shared', options), options[0].value);
  assert.equal(s.resolveSavedModelId('remote|https://nvidia.invalid/v1|shared', options), options[0].value);
});

test('an explicit empty background selection cannot inherit the visible chat model', () => {
  const { context: s } = harness();
  load(s, 'runtime.js', ['catalogOptionFromRemote', 'modelCatalogIsComplete', 'selectedRemoteModel']);
  s.selectedChatModel = s.selectedRemoteModelId = 'visible';
  const data = { network: { remote_saved: true, remote_models: [{ id: 'visible', model: 'visible', ready: true }] } };
  assert.equal(s.selectedRemoteModel(data, ''), null);
  assert.equal(s.selectedRemoteModel(data).id, 'visible');
});

test('a legacy model alias waits for the complete provider catalog before resolving', () => {
  const { context: s } = harness();
  load(s, 'runtime.js', ['catalogOptionFromRemote', 'modelCatalogIsComplete', 'selectedRemoteModel']);
  const model = { id: 'remote|nvidia|https://nvidia.invalid/v1|shared', provider_id: 'nvidia', model: 'shared', ready: true };
  const data = { network: { remote_saved: true, remote_checking: true, remote_models: [model] } };
  assert.equal(s.selectedRemoteModel(data, 'shared'), null);
  assert.equal(s.selectedRemoteModel(data, model.id).id, model.id);
  assert.equal(s.resolveSavedModelId('shared', [s.catalogOptionFromRemote(model)], false), 'shared');
  data.network.remote_checking = false;
  assert.equal(s.selectedRemoteModel(data, 'shared').id, model.id);
});

test('Loop compaction cannot send a request without its selected provider', async () => {
  const state = vm.createContext({ latestState: {}, selectedRemoteModel: () => null, fetch: async () => { throw new Error('must not send'); } });
  load(state, 'bots.js', ['collectCompletionText']);
  await assert.rejects(state.collectCompletionText([], 'missing'), /selected Loop model is unavailable/);
});


test('real chat model picks survive switching, default changes, reload, and background sends', {
  skip: !appTestsEnabled || !chromium,
  timeout: 60000,
}, async () => {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { spawn } = require('node:child_process');
  const { resolve } = require('node:path');
  const { createServer } = require('node:http');
  const { setTimeout: delay } = require('node:timers/promises');
  const sentModels = [];
  const provider = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: ['alpha', 'beta', 'gamma'].map(id => ({ id })) }));
    } else if (request.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      sentModels.push(payload.model);
      response.setHeader('content-type', 'text/event-stream');
      response.end('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n');
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'gopher-chat-models-'));
  writeFileSync(join(dir, 'config.toml'), [
    'active_provider_id = "fixture"', '[[providers]]', 'id = "fixture"',
    'name = "Fixture"', `base = "http://127.0.0.1:${provider.address().port}/v1"`,
    'api_style = "openai"', 'token = ""',
  ].join('\n'));
  const child = spawnApp([
    '--headless', '--config', join(dir, 'config.toml'), '--bind', '127.0.0.1:0',
  ], { windowsHide: true, stdio: 'pipe' });
  let logs = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  let browser;
  try {
    let origin;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(logs);
      const port = logs.match(/Gopher listening on http:\/\/gopher\.localhost:(\d+)/)?.[1];
      if (port && Number(port) > 0) { origin = `http://127.0.0.1:${port}`; break; }
      await delay(100);
    }
    assert.ok(origin, logs);
    browser = await chromium.launch(browserLaunchOptions(process.env.SECURITY_BROWSER_CHANNEL));
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => storageReady && modelMenuOptions.filter(model => !model.connectKind).length === 3);
    const ids = await page.evaluate(async () => {
      const ids = Object.fromEntries(modelMenuOptions.filter(model => !model.connectKind).map(model => [model.label, model.value]));
      await saveSettings({ ...settings, selectedChatModel: ids.alpha, chatRetrieval: false }, { immediate: true });
      conversations.push(...['a', 'b'].map(id => normalizeConversation({ id, title: id, titleEdited: true, messages: [] })));
      saveConversations({ immediate: true });
      await storeWriteChain;
      selectConversation('a');
      return ids;
    });
    await page.locator('#chatModelSelect').click();
    await page.locator('#chatModelSearch').fill('beta');
    await page.locator('[data-model-pick]').filter({ hasText: 'beta' }).click();
    assert.equal(await page.evaluate(() => settings.selectedChatModel), ids.alpha);
    await page.evaluate(() => selectConversation('b'));
    assert.equal(await page.locator('#chatModelSelect').textContent(), 'alpha');
    await page.evaluate(async defaultId => {
      await saveSettings({ ...settings, selectedChatModel: defaultId }, { immediate: true });
      syncModelSelector(latestState);
    }, ids.gamma);
    assert.equal(await page.locator('#chatModelSelect').textContent(), 'gamma');
    await page.locator('#chatModelSelect').click();
    await page.locator('#chatModelSearch').fill('alpha');
    await page.locator('[data-model-pick]').filter({ hasText: 'alpha' }).click();
    await page.evaluate(() => selectConversation('a'));
    assert.equal(await page.locator('#chatModelSelect').textContent(), 'beta');
    await page.evaluate(() => fillDefaultModelSetting());
    assert.equal(await page.locator('#settingDefaultModel').inputValue(), ids.gamma);
    await page.evaluate(async () => { saveConversations({ immediate: true }); await storeWriteChain; });
    await page.reload();
    await page.waitForFunction(() => storageReady && modelMenuOptions.filter(model => !model.connectKind).length === 3);
    await page.evaluate(() => selectConversation('b'));
    assert.equal(await page.locator('#chatModelSelect').textContent(), 'alpha');
    await page.evaluate(async () => {
      const convo = conversations.find(item => item.id === 'a');
      const message = { role: 'user', content: 'Background send' };
      convo.messages.push(message);
      await runAssistantTurn(convo, { useAgent: false, text: message.content, skills: {}, dispatchedMessage: message });
    });
    assert.equal(sentModels.at(-1), 'beta');
    assert.equal(await page.locator('#chatModelSelect').textContent(), 'alpha');
    await page.evaluate(() => selectConversation('a'));
    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator('#chatModelSelect').click();
    const resetFits = await page.locator('#btnModelUseDefault').evaluate(button => {
      const menu = button.closest('.chat-model-menu').getBoundingClientRect();
      const bounds = button.getBoundingClientRect();
      return bounds.left >= menu.left && bounds.right <= menu.right;
    });
    assert.ok(resetFits, 'Use default should fit the narrow model menu');
    await page.locator('#btnModelUseDefault').click();
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await page.locator('#chatModelSelect').textContent(), 'gamma');
    await page.evaluate(() => startDraft());
    await page.locator('#chatModelSelect').click();
    await page.locator('#chatModelSearch').fill('beta');
    await page.locator('[data-model-pick]').filter({ hasText: 'beta' }).click();
    await page.evaluate(async () => { composerInput.value = 'Draft with beta'; await sendMessage(); });
    await page.waitForFunction(() => activeId && !activeStreams.has(activeId));
    assert.equal(sentModels.at(-1), 'beta');
    assert.equal(await page.evaluate(() => conversations.find(item => item.id === activeId).modelId), ids.beta);
    const sourceId = await page.evaluate(() => activeId);
    await page.evaluate(async () => { composerInput.value = 'Branch with beta'; await sendMessage({ branch: true }); });
    await page.waitForFunction(() => activeId && !activeStreams.has(activeId));
    assert.notEqual(await page.evaluate(() => activeId), sourceId);
    assert.equal(await page.evaluate(() => conversations.find(item => item.id === activeId).modelId), ids.beta);
    await page.evaluate(() => startDraft());
    assert.equal(await page.locator('#chatModelSelect').textContent(), 'gamma');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await stopApp(child);
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await removeAppData(dir);
  }
});
