const { chromium, appTestsEnabled, spawnApp, browserLaunchOptions, stopApp, removeAppData, mockAppUpdates } = require('./helpers/app.cjs');
const { readUiScript } = require('./helpers/ui-source.cjs');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readUiScript("workspace");
function load(context, names) {
  for (const name of names) {
    const match = source.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}
function harness(overrides = {}) {
  const context = vm.createContext({
    projects: [{ id: 'p', name: 'Garden', instructions: 'Grow tomatoes', memory: '' }],
    conversations: [], activeProfileId: 'personal', appSurface: 'chat', activeProjectId: null,
    activeId: null, draftIncognito: false, latestState: null, profiles: [{ id: 'personal', conversations: [], composerDrafts: {} }],
    composerInput: { value: '' }, composerMentionIds: new Set(), pendingAttachments: [],
    pendingReplyQuote: '', pendingReplyTarget: null, draftModelId: '', draftWorkspaceRoot: '',
    composerDraftContext: null, transientComposerDrafts: new Map(), composerDraftTimer: null,
    diskEncryptionLocked: () => false, isIncognitoContext() { return context.draftIncognito; },
    getProject: (id) => context.projects.find((project) => project.id === id),
    isBotsSurface: () => false, conversationsOnSurface: () => context.conversations,
    conversationsForProject: () => [],
    escapeHtml: (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    syncConversationModel() {}, renderComposerMentions() {}, renderComposerReply() {},
    renderPendingAttachments() {}, autoResize() {}, updateSendEnabled() {},
    clearTimeout() {},
    ...overrides,
  });
  load(context, ['messageSearchText', 'searchTerms', 'searchExcerpt', 'searchWorkspace',
    'highlightedSearchHtml', 'conversationMarkdown', 'normalizeComposerDraft',
    'currentComposerDraftContext', 'composerDraftMemoryKey', 'captureComposerDraft',
    'restoreComposerDraft', 'discardSentComposerDraft', 'composerDraftsForStore', 'isComposingKey']);
  return context;
}

test('workspace search finds late messages, shows relevant excerpts, and points to the matching message', () => {
  const h = harness();
  h.conversations = [{ id: 'a', title: 'Planning', messages: [
    ...Array.from({ length: 20 }, () => ({ role: 'user', content: 'Earlier message' })),
    { role: 'assistant', content: 'x '.repeat(100) + 'The orchid needs indirect sunlight.' },
  ] }];
  const [result] = h.searchWorkspace('orchid sunlight');
  assert.equal(result.id, 'a');
  assert.equal(result.messageIndex, 20);
  assert.match(result.meta, /orchid needs indirect sunlight/);
});

test('search ranks exact titles first and honors phrases, scopes, and temporary-chat privacy', () => {
  const h = harness();
  h.conversations = [
    { id: 'body', title: 'Plants', updatedAt: 100, messages: [{ role: 'user', content: 'Grow tomatoes indoors' }] },
    { id: 'title', title: 'Grow tomatoes', updatedAt: 1, messages: [] },
    { id: 'ghost', title: 'Grow tomatoes', incognito: true, messages: [] },
  ];
  assert.deepEqual(Array.from(h.searchWorkspace('"Grow tomatoes"'), (result) => result.id), ['title', 'body', 'p']);
  assert.equal(h.searchWorkspace('"tomatoes Grow"').length, 0);
  assert.equal(h.searchWorkspace('tomatoes', 'projects')[0].kind, 'project');
  assert.equal(h.searchWorkspace('tomatoes', 'chats').length, 2);
});

test('search handles text blocks and never indexes hidden system messages', () => {
  const h = harness();
  h.conversations = [{ id: 'a', title: 'Chat', messages: [
    { role: 'system', content: 'hidden-secret' },
    { role: 'assistant', content: [{ type: 'text', text: 'Visible answer' }, { type: 'image_url', image_url: { url: 'private-image' } }] },
  ] }];
  assert.equal(h.searchWorkspace('Visible answer').length, 1);
  assert.equal(h.searchWorkspace('hidden-secret').length, 0);
  assert.equal(h.searchWorkspace('private-image').length, 0);
});

test('highlighting escapes HTML and treats regular-expression characters literally', () => {
  const h = harness();
  assert.equal(h.highlightedSearchHtml('<img onerror="bad"> a+b [x]', ['a+b', '[x]']), '&lt;img onerror=&quot;bad&quot;&gt; <mark>a+b</mark> <mark>[x]</mark>');
});

test('drafts restore text, capabilities, reply context, model, workspace, and session attachments', () => {
  const h = harness();
  h.restoreComposerDraft();
  h.composerInput.value = 'Unfinished thought';
  h.composerMentionIds.add('web_search');
  h.pendingReplyQuote = 'Earlier answer';
  h.pendingReplyTarget = { speakerId: 'speaker', speakerHandle: 'analyst' };
  h.pendingAttachments = [{ id: 'file' }];
  h.draftModelId = 'model';
  h.draftWorkspaceRoot = 'C:/workspace';
  h.captureComposerDraft();
  h.composerInput.value = '';
  h.pendingAttachments = [];
  h.restoreComposerDraft();
  assert.equal(h.composerInput.value, 'Unfinished thought');
  assert.deepEqual([...h.composerMentionIds], ['web_search']);
  assert.equal(h.pendingReplyQuote, 'Earlier answer');
  assert.equal(h.pendingReplyTarget.speakerId, 'speaker');
  assert.equal(h.pendingAttachments[0].id, 'file');
  const stored = h.composerDraftsForStore({ ...h.profiles[0], projects: [] });
  assert.equal(stored['new:chat:'].text, 'Unfinished thought');
  assert.equal(stored['new:chat:'].modelId, 'model');
  assert.equal(Object.hasOwn(stored['new:chat:'], 'attachments'), false);
});

test('unchanged drafts and temporary drafts never schedule another full archive save', () => {
  const h = harness();
  h.restoreComposerDraft();
  assert.equal(h.captureComposerDraft(), false);
  h.composerInput.value = 'Changed draft';
  assert.equal(h.captureComposerDraft(), true);
  assert.equal(h.captureComposerDraft(), false);
  h.composerInput.value = '';
  assert.equal(h.captureComposerDraft(), true);
  assert.equal(h.captureComposerDraft(), false);
  h.draftIncognito = true;
  h.restoreComposerDraft();
  h.composerInput.value = 'Ghost secret';
  assert.equal(h.captureComposerDraft(), false);
});

test('normal, ghost, project, and profile drafts stay separate; ghost text never enters the store', () => {
  const h = harness();
  h.restoreComposerDraft();
  h.composerInput.value = 'Saved draft';
  h.captureComposerDraft();
  h.draftIncognito = true;
  h.restoreComposerDraft();
  assert.equal(h.composerInput.value, '');
  h.composerInput.value = 'Ghost secret';
  h.captureComposerDraft();
  assert.equal(JSON.stringify(h.profiles).includes('Ghost secret'), false);
  h.draftIncognito = false;
  h.activeProjectId = 'p';
  h.restoreComposerDraft();
  assert.equal(h.composerInput.value, '');
  h.activeProjectId = null;
  h.restoreComposerDraft();
  assert.equal(h.composerInput.value, 'Saved draft');
  h.profiles.push({ id: 'work', conversations: [], composerDrafts: {} });
  h.activeProfileId = 'work';
  h.restoreComposerDraft();
  assert.equal(h.composerInput.value, '');
});

test('sending removes the draft and deleted chats, ghost chats, and projects are excluded from saved drafts', () => {
  const h = harness();
  h.restoreComposerDraft();
  h.composerInput.value = 'Send me';
  h.captureComposerDraft();
  h.discardSentComposerDraft();
  assert.equal(Object.keys(h.profiles[0].composerDrafts).length, 0);
  assert.equal(h.transientComposerDrafts.size, 0);
  h.conversations = [{ id: 'saved' }, { id: 'ghost', incognito: true }];
  const stored = h.composerDraftsForStore({ id: 'personal', composerDrafts: {
    'chat:saved': { text: 'keep' }, 'chat:ghost': { text: 'secret' },
    'chat:deleted': { text: 'gone' }, 'new:chat:p': { text: 'project' },
    'new:chat:deleted': { text: 'gone' },
  } });
  assert.deepEqual(Object.keys(stored), ['chat:saved', 'new:chat:p']);
});

test('Markdown export preserves user-facing content and omits credentials, tool payloads, and image data', () => {
  const h = harness();
  const text = h.conversationMarkdown({ title: 'Example', providerToken: 'secret-key', messages: [
    { role: 'system', content: 'private-system' },
    { role: 'user', content: 'Explain **this**', replyQuote: 'Quoted\npassage', attachments: [{ name: 'notes.txt', data: 'secret-data' }] },
    { role: 'assistant', content: '```js\nconst x = 1;\n```', speakerHandle: 'analyst', timeline: [{ result: 'secret-tool' }] },
    { role: 'tool', content: 'secret-tool' },
  ] });
  assert.match(text, /^# Example/);
  assert.match(text, /## You\n\n> Quoted\n> passage/);
  assert.match(text, /Attachment: notes.txt/);
  assert.match(text, /## @analyst\n\n```js/);
  assert.doesNotMatch(text, /secret-|private-system/);
});

test('IME candidate confirmation is never treated as a send or shortcut', () => {
  const h = harness();
  assert.equal(h.isComposingKey({ isComposing: true, key: 'Enter' }), true);
  assert.equal(h.isComposingKey({ keyCode: 229, key: 'Enter' }), true);
  assert.equal(h.isComposingKey({ key: 'Enter' }), false);
});

test('connection feedback tolerates a transient failure and recovers after a successful poll', () => {
  const visible = [];
  let updates = 0;
  const h = harness({ workspaceConnectionFailures: 0, workspaceDisconnected: false,
    document: { getElementById: () => ({ classList: { toggle: (_, hidden) => visible.push(!hidden) } }) },
    updateSendEnabled: () => { updates++; },
  });
  load(h, ['noteWorkspaceConnection']);
  h.noteWorkspaceConnection(false);
  h.noteWorkspaceConnection(false);
  assert.equal(h.workspaceDisconnected, false);
  h.noteWorkspaceConnection(false);
  assert.equal(h.workspaceDisconnected, true);
  h.noteWorkspaceConnection(true);
  assert.equal(h.workspaceDisconnected, false);
  assert.deepEqual(visible, [true, false]);
  assert.equal(updates, 2);
});

function welcomeHarness() {
  const element = () => ({
    dataset: {}, children: [], classList: { toggle() {} },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); }, addEventListener() {},
  });
  const host = element();
  const state = harness({
    localDataLoadError: '', serverReady: false, modelMenuOptions: [],
    document: { getElementById: () => host, createElement: element },
    shortcutLabel: value => value,
  });
  load(state, ['renderWelcomeTools']);
  return { state, host };
}

test('welcome cards stay stable while the saved provider catalog loads and the picker catches up', () => {
  const { state, host } = welcomeHarness();
  let starters;
  for (const network of [
    null,
    { remote_saved: true, remote_checking: true, remote_catalog_pending: true, remote_models: [] },
    { remote_saved: true, remote_checking: true, remote_models: [] },
    { remote_saved: true, remote_catalog_pending: true, remote_models: [] },
    { remote_saved: true, remote_models: [{ id: 'saved-model', ready: false }] },
    { remote_saved: true, remote_models: [{ id: 'saved-model', ready: true }] },
  ]) {
    state.latestState = network ? { network } : null;
    state.renderWelcomeTools();
    assert.equal(host.dataset.mode, 'ready', JSON.stringify(network));
    assert.equal(host.children[0].className, 'welcome-starters');
    assert.equal(host.children[0].children.length, 3);
    if (starters) assert.equal(host.children[0], starters);
    starters = host.children[0];
  }
});

test('welcome setup appears only after discovery finishes without a configured model', () => {
  for (const network of [
    { remote_saved: false, remote_models: [] },
    { remote_saved: true, remote_models: [] },
    { remote_saved: true, remote_models: [{ id: 'sign-in', connect_kind: 'openai-codex' }] },
  ]) {
    const { state, host } = welcomeHarness();
    state.latestState = { network };
    state.renderWelcomeTools();
    assert.equal(host.dataset.mode, 'connect');
    assert.equal(host.children[0].className, 'welcome-connect');
  }
});

test('workspace browser flows preserve drafts across navigation and reload, search all messages, find formatted text, and export', {
  skip: !appTestsEnabled || !chromium, timeout: 90000,
}, async () => {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { resolve } = require('node:path');
  const { spawn } = require('node:child_process');
  const { setTimeout: delay } = require('node:timers/promises');
  const dir = mkdtempSync(join(tmpdir(), 'gopher-workspace-'));
  writeFileSync(join(dir, 'config.toml'), '');
  const child = spawnApp(['--headless', '--config', join(dir, 'config.toml'), '--bind', '127.0.0.1:0'], { windowsHide: true, stdio: 'pipe' });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  let browser;
  try {
    let origin;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode != null) throw new Error(logs);
      const port = logs.match(/Gopher listening on http:\/\/gopher\.localhost:(\d+)/)?.[1];
      if (port) { origin = 'http://127.0.0.1:' + port; break; }
      await delay(100);
    }
    assert.ok(origin, logs);
    browser = await chromium.launch(browserLaunchOptions(process.env.SECURITY_BROWSER_CHANNEL));
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await mockAppUpdates(page, origin);
    await page.goto(origin);
    await page.waitForFunction(() => storageReady && composerDraftContext);
    await page.locator('.welcome-connect').waitFor();
    await page.evaluate(() => {
      projects.push(normalizeProject({ id: 'garden', name: 'Garden' }));
      conversations.push(...['a', 'b'].map((id) => normalizeConversation({ id, title: 'Chat ' + id, titleEdited: true, messages: [
        ...Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Earlier message ' + index })),
        { role: 'assistant', content: 'An **orchid** needs sunlight. Orchid care includes water. İ Unicode example.' },
      ] })));
      selectConversation('a');
    });
    await page.locator('#composerInput').fill('Keep this draft');
    await page.evaluate(() => selectConversation('b'));
    assert.equal(await page.locator('#composerInput').inputValue(), '');
    await page.locator('#composerInput').fill('Second draft');
    await page.evaluate(() => openProject('garden'));
    assert.equal(await page.locator('#composerInput').inputValue(), '');
    await page.locator('#composerInput').fill('Project draft');
    await page.evaluate(() => startWorkspaceChat());
    assert.equal(await page.locator('#composerInput').inputValue(), '');
    await page.evaluate(() => openProject('garden'));
    assert.equal(await page.locator('#composerInput').inputValue(), 'Project draft');
    await page.evaluate(() => selectConversation('a'));
    assert.equal(await page.locator('#composerInput').inputValue(), 'Keep this draft');
    const sends = await page.evaluate(() => {
      const original = sendMessage;
      let sent = 0;
      try {
        sendMessage = () => { sent++; };
        btnSend.disabled = false;
        composerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
        composerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229 }));
      } finally { sendMessage = original; updateSendEnabled(); }
      return sent;
    });
    assert.equal(sends, 0);
    await page.evaluate(async () => { saveStore({ immediate: true }); await storeWriteChain; });
    await page.reload();
    await page.waitForFunction(() => storageReady && composerDraftContext);
    assert.equal(await page.locator('#composerInput').inputValue(), 'Keep this draft');
    await page.keyboard.press('Control+k');
    await page.locator('#searchModalInput').fill('orchid sunlight');
    await page.waitForFunction(() => searchResultItems.length === 2);
    assert.match(await page.locator('#searchModalResults').textContent(), /orchid.*sunlight/i);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => searchActiveIndex), 1);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => searchActiveIndex), 0);
    await page.keyboard.press('Enter');
    await page.locator('.is-chat-source').waitFor();
    assert.equal(await page.locator('.is-chat-source').getAttribute('data-msg-index'), '8');
    await page.keyboard.press('Control+f');
    await page.locator('#threadFindInput').fill('orchid');
    assert.equal(await page.locator('#threadFindCount').textContent(), '1 of 2');
    await page.evaluate(() => chatThread.querySelector('.msg:last-child .msg-bubble').insertAdjacentHTML('beforeend', '<p>Orchid roots.</p>'));
    await page.waitForFunction(() => document.getElementById('threadFindCount').textContent === '1 of 3');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#threadFindCount').textContent(), '2 of 3');
    await page.locator('#threadFindInput').fill('An orchid needs');
    assert.equal(await page.locator('#threadFindCount').textContent(), '1 of 1');
    await page.locator('#threadFindInput').fill('Unicode example');
    assert.equal(await page.locator('#threadFindCount').textContent(), '1 of 1');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#threadFind').isVisible(), false);
    await page.route('**/api/state', (route) => route.abort());
    await page.evaluate(async () => { await pollState(); await pollState(); await pollState(); });
    assert.equal(await page.locator('#workspaceConnection').isVisible(), true);
    await page.unroute('**/api/state');
    await page.evaluate(() => pollState());
    assert.equal(await page.locator('#workspaceConnection').isVisible(), false);
    await page.evaluate(() => startDraft({ incognito: true }));
    await page.locator('#composerInput').fill('Ghost secret');
    await page.evaluate(async () => { captureComposerDraft(); saveStore({ immediate: true }); await storeWriteChain; });
    assert.equal(readFileSync(join(dir, 'chats.json'), 'utf8').includes('Ghost secret'), false);
    const downloadEvent = page.waitForEvent('download');
    await page.evaluate(() => exportConversationMarkdown('a'));
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'Chat a.md');
    assert.match(readFileSync(await download.path(), 'utf8'), /An \*\*orchid\*\* needs sunlight/);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(() => { activeProjectId = null; startDraft(); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.keyboard.press('Control+k');
    await page.locator('#searchModalInput').fill('> export');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.evaluate(() => selectConversation('a'));
    await page.locator('#composerInput').fill('Encrypted draft');
    await page.evaluate(async () => {
      saveStore({ immediate: true });
      await storeWriteChain;
      await postEncryption('/api/data/encryption/enable', { passphrase: 'workspace-test-passphrase', passphrase_confirm: 'workspace-test-passphrase' });
    });
    assert.equal(readFileSync(join(dir, 'chats.json'), 'utf8').includes('Encrypted draft'), false);
    await page.evaluate(async () => {
      await postEncryption('/api/data/encryption/lock', {});
      clearMemoryAfterLock();
    });
    assert.equal(await page.locator('#composerInput').inputValue(), '');
    assert.equal(await page.evaluate(() => transientComposerDrafts.size), 0);
    assert.equal(await page.locator('#searchModalResults').textContent(), '');
    await page.evaluate(() => unlockDiskEncryption('workspace-test-passphrase'));
    await page.waitForFunction(() => storageReady && composerDraftContext);
    assert.equal(await page.locator('#composerInput').inputValue(), 'Encrypted draft');
    page.once('dialog', (dialog) => dialog.accept());
    await page.evaluate(async () => { clearAllChatsAndProjects(); await storeWriteChain; });
    assert.equal(await page.locator('#composerInput').inputValue(), '');
    assert.equal(await page.evaluate(() => Object.keys(activeProfile().composerDrafts).length), 0);
    assert.equal(await page.evaluate(() => transientComposerDrafts.size), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopApp(child);
    await removeAppData(dir);
  }
});
