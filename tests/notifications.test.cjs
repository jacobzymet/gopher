// Run without compiling the app: node --test tests/notifications.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const render = readFileSync(join(root, 'src/ui/chat/scripts/render.js'), 'utf8').replace(/\r\n/g, '\n');
const controls = readFileSync(join(root, 'src/ui/chat/scripts/controls.js'), 'utf8').replace(/\r\n/g, '\n');

function declaration(name) {
  const match = render.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
  assert.ok(match, 'missing function ' + name);
  return match[0];
}

function context(overrides = {}) {
  const state = vm.createContext({
    activeId: null,
    mainView: 'chat',
    document: { visibilityState: 'visible' },
    activeStreams: new Map(),
    conversations: [],
    saveConversations() {},
    ...overrides,
  });
  for (const name of [
    'skillLabel',
    'notificationIsUnread',
    'markConversationNotificationRead',
    'recordConversationNotification',
    'pendingAttentionNotifications',
  ]) vm.runInContext(declaration(name), state);
  return state;
}

test('background completions become unread until the task is opened', () => {
  let saves = 0;
  let refreshes = 0;
  const state = context({
    saveConversations: () => { saves += 1; },
    refreshNotificationsUi: () => { refreshes += 1; },
  });
  const convo = { id: 'task-1' };
  state.recordConversationNotification(convo, { at: 200 });
  assert.equal(state.notificationIsUnread(convo), true);
  assert.equal(state.markConversationNotificationRead(convo), true);
  assert.equal(convo.notificationReadAt, 200);
  assert.equal(saves, 1);
  assert.equal(refreshes, 2);
});

test('notification state refreshes the badge immediately when a task completes', () => {
  let refreshes = 0;
  const convo = { id: 'task-2' };
  const state = context({
    activeId: 'another-task',
    refreshNotificationsUi: () => { refreshes += 1; },
  });
  state.recordConversationNotification(convo, { at: 500 });
  assert.equal(refreshes, 1);
  assert.equal(state.notificationIsUnread(convo), true);
});

test('a visible open task records its completion as already read', () => {
  const convo = { id: 'task-1' };
  const state = context({ activeId: convo.id });
  state.recordConversationNotification(convo, { at: 300 });
  assert.equal(convo.notificationReadAt, 300);
  assert.equal(state.notificationIsUnread(convo), false);
});

test('pending approvals and clarification questions are both attention items', () => {
  const convo = { id: 'task-1', title: 'Ship the release' };
  const state = context({
    conversations: [convo],
    activeStreams: new Map([[convo.id, { timeline: [
      { type: 'tool', live: true, approval: 'pending', name: 'run_terminal', detail: 'deploy', startedAt: 20 },
      { type: 'clarify', live: true, questions: [{}, {}], startedAt: 10 },
    ] }]]),
  });
  const items = state.pendingAttentionNotifications();
  assert.equal(items.map((item) => item.type).join(','), 'approval,input');
  assert.equal(items[0].detail, 'Terminal · deploy');
  assert.match(items[1].detail, /Answer 2 questions/);
});

test('the global inbox identifies each web search without assigning it to the visible chat', () => {
  const convo = { id: 'research', title: 'Research' };
  const state = context({
    activeId: 'other-chat',
    conversations: [convo, { id: 'other-chat', title: 'Other chat' }],
    activeStreams: new Map([[convo.id, { timeline: [
      { type: 'tool', live: true, approval: 'pending', name: 'web_search', detail: 'query', startedAt: 20 },
    ] }]]),
  });
  const [item] = state.pendingAttentionNotifications();
  assert.equal(item.convo.id, 'research');
  assert.equal(item.detail, 'Web search · query');
  state.activeId = 'research';
  assert.equal(state.pendingAttentionNotifications()[0].convo.id, 'research');
});

for (const flag of ['cancelled', 'replaced', 'settled', 'serverFinished', 'catchingUp']) {
  test(flag + ' streams cannot leave approval or question notifications', () => {
    const convo = { id: 'task' };
    const stream = { [flag]: true, timeline: [
      { type: 'tool', live: true, approval: 'pending', name: 'web_search' },
      { type: 'clarify', live: true, questions: [{}] },
    ] };
    const state = context({ conversations: [convo], activeStreams: new Map([[convo.id, stream]]) });
    assert.equal(state.pendingAttentionNotifications().length, 0);
    if (flag === 'catchingUp') {
      stream.catchingUp = false;
      assert.equal(state.pendingAttentionNotifications().length, 2);
    }
  });
}

test('settled tools and aborted requests cannot leave pending approvals', () => {
  const convo = { id: 'task' };
  const controller = new AbortController();
  const stream = { controller, timeline: [
    { type: 'tool', live: false, approval: 'pending', name: 'web_search' },
  ] };
  const state = context({ conversations: [convo], activeStreams: new Map([[convo.id, stream]]) });
  assert.equal(state.pendingAttentionNotifications().length, 0);
  stream.timeline[0].live = true;
  assert.equal(state.pendingAttentionNotifications().length, 1);
  controller.abort();
  assert.equal(state.pendingAttentionNotifications().length, 0);
});

test('Stop refreshes the approval inbox immediately while preserving partial text', () => {
  const convo = { id: 'task' };
  const stream = { controller: new AbortController(), timeline: [
    { type: 'tool', live: true, approval: 'pending', name: 'web_search' },
  ] };
  const refreshes = [];
  const state = context({
    conversations: [convo], activeStreams: new Map([[convo.id, stream]]),
    invalidateOutboundStart() {}, markBotsOutboundStopped() {}, rememberHandledLiveTurn() {},
    noteLiveTurnUserCancel() {}, syncComposerStreamUi() {}, scheduleCancel: () => Promise.resolve(),
    refreshNotificationsUi() { refreshes.push(state.pendingAttentionNotifications().length); },
  });
  for (const name of ['cancelLiveBodyReader', 'abortStream']) {
    const match = controls.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], state);
  }
  assert.equal(state.pendingAttentionNotifications().length, 1);
  state.abortStream(convo.id, { preservePartial: true });
  assert.equal(state.activeStreams.get(convo.id), stream);
  assert.deepEqual(refreshes, [0]);
});

for (const allow of [true, false]) {
  test('expired ' + (allow ? 'approval' : 'denial') + ' cannot restore a pending card', async () => {
    const convo = { id: 'task' };
    const part = { type: 'tool', id: 'call', live: true, approval: 'pending', name: 'web_search' };
    const stream = { timeline: [part] };
    let requests = 0;
    const state = context({
      conversations: [convo], activeStreams: new Map([[convo.id, stream]]),
      activeStream: () => stream, approvalInFlight: new Set(), CSS: { escape: value => value },
      document: { querySelectorAll: () => [] }, refreshNotificationsUi() {},
      fetch: async () => {
        requests += 1;
        return { ok: false, json: async () => ({ error: 'No pending tool approval for that id (it may have expired).' }) };
      },
    });
    vm.runInContext(declaration('submitToolApproval'), state);
    await state.submitToolApproval('call', allow);
    assert.equal(part.approval, 'expired');
    assert.equal(state.pendingAttentionNotifications().length, 0);
    assert.equal(state.approvalInFlight.size, 0);
    await state.submitToolApproval('call', allow);
    assert.equal(requests, 1);
  });
}

test('a temporary approval submission failure keeps the request actionable', async () => {
  const part = { type: 'tool', id: 'call', live: true, approval: 'pending', name: 'web_search' };
  const state = context({
    activeStream: () => ({ timeline: [part] }), approvalInFlight: new Set(), CSS: { escape: value => value },
    document: { querySelectorAll: () => [] }, refreshNotificationsUi() {},
    fetch: async () => { throw new Error('Network error'); },
  });
  vm.runInContext(declaration('submitToolApproval'), state);
  await state.submitToolApproval('call', false);
  assert.equal(part.approval, 'pending');
});

test('the expired approval protocol retires a pending card without an HTTP failure', async () => {
  const part = { type: 'tool', id: 'call', live: true, approval: 'pending' };
  const state = context({
    activeStream: () => ({ timeline: [part] }), approvalInFlight: new Set(), CSS: { escape: value => value },
    document: { querySelectorAll: () => [] }, refreshNotificationsUi() {},
    fetch: async () => ({ ok: true, json: async () => ({ ok: false, expired: true }) }),
  });
  vm.runInContext(declaration('submitToolApproval'), state);
  await state.submitToolApproval('call', true);
  assert.equal(part.approval, 'expired');
});

test('cancelled streams and saved cards cannot submit obsolete approvals', async () => {
  const part = { type: 'tool', id: 'call', live: true, approval: 'pending' };
  const stream = { timeline: [part], cancelled: true };
  const state = context({ activeStream: () => stream, approvalInFlight: new Set(), fetch: async () => { throw new Error('must not send'); } });
  vm.runInContext(declaration('submitToolApproval'), state);
  await state.submitToolApproval('call', true);
  stream.cancelled = false; part.live = false;
  await state.submitToolApproval('call', true);
  assert.equal(part.approval, 'pending');
});

test('notification excerpts render sanitized inline markdown', () => {
  let options = null;
  const state = vm.createContext({
    window: {
      marked: {
        parseInline: (source) => source.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'),
      },
      DOMPurify: {
        sanitize: (html, config) => {
          options = config;
          return html;
        },
      },
    },
    escapeHtml: (value) => value,
  });
  vm.runInContext(declaration('renderNotificationMarkdown'), state);
  const html = state.renderNotificationMarkdown('**Critique** with `code`');
  assert.match(html, /<strong>Critique<\/strong>/);
  assert.deepEqual(Array.from(options.ALLOWED_TAGS), ['strong', 'em', 'code', 'del', 'br']);
  assert.equal(options.ALLOWED_ATTR.length, 0);
});

test('the notification bell toggles a popover without replacing the current page', () => {
  const classes = new Set();
  const attributes = new Map();
  const state = vm.createContext({
    mainView: 'projects',
    notificationsView: {
      classList: {
        contains: (name) => classes.has(name),
        toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      },
      setAttribute: (name, value) => attributes.set('popover:' + name, value),
    },
    btnNotificationsNav: {
      classList: { toggle() {} },
      setAttribute: (name, value) => attributes.set(name, value),
      focus() {},
    },
    closeConvoMenu() {},
    refreshNotificationsUi() {},
  });
  for (const name of ['notificationsPopoverIsOpen', 'setNotificationsOpen', 'showNotificationsView']) {
    vm.runInContext(declaration(name), state);
  }

  state.showNotificationsView();
  assert.equal(classes.has('is-open'), true);
  assert.equal(attributes.get('aria-expanded'), 'true');
  assert.equal(attributes.get('popover:aria-hidden'), 'false');
  assert.equal(state.mainView, 'projects');

  state.showNotificationsView();
  assert.equal(classes.has('is-open'), false);
  assert.equal(attributes.get('aria-expanded'), 'false');
  assert.equal(attributes.get('popover:aria-hidden'), 'true');
  assert.equal(state.mainView, 'projects');
});

let chromium;
try { ({ chromium } = require('playwright')); } catch {}

test('real approval inbox follows live SSE, clears on Stop, and ignores finished replay', {
  skip: !process.env.GOPHER_TEST_BINARY || !chromium,
  timeout: 60000,
}, async () => {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { spawn } = require('node:child_process');
  const { resolve } = require('node:path');
  const { setTimeout: delay } = require('node:timers/promises');
  const dir = mkdtempSync(join(tmpdir(), 'gopher-notifications-'));
  writeFileSync(join(dir, 'config.toml'), '# Isolated notification regression\n');
  const child = spawn(resolve(process.env.GOPHER_TEST_BINARY), [
    '--headless', '--config', join(dir, 'config.toml'), '--bind', '127.0.0.1:0',
  ], { windowsHide: true, stdio: 'pipe' });
  let logs = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const exited = new Promise(resolve => child.once('close', resolve));
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
    browser = await chromium.launch({ headless: true, channel: process.env.SECURITY_BROWSER_CHANNEL || undefined });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => storageReady);
    await page.evaluate(() => {
      conversations.push(...['research', 'other'].map(id => normalizeConversation({
        id, title: id, titleEdited: true, messages: [],
      })));
      selectConversation('other');
      window.startNotificationFixture = finished => {
        const convo = conversations.find(item => item.id === 'research');
        const stream = beginLiveStream(convo, { useAgent: true, catchingUp: true });
        const body = new ReadableStream({ start(controller) { window.notificationWriter = controller; } });
        window.notificationRun = driveAssistantSse(convo, stream, new Response(body));
        window.pushNotificationEvent = (event, payload) => notificationWriter.enqueue(
          new TextEncoder().encode('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n')
        );
        pushNotificationEvent('meta', { finished });
        pushNotificationEvent('agent', {
          phase: 'tool_approval', id: 'search', name: 'web_search', risk: 'safe', arguments: { query: 'Example query' },
        });
      };
      startNotificationFixture(false);
    });
    await page.waitForFunction(() => activeStreams.get('research')?.timeline.some(part => part.id === 'search'));
    await page.locator('#btnNotificationsNav').click();
    assert.equal(await page.locator('.notifications-kicker').textContent(), 'All chats');
    assert.equal(await page.evaluate(() => sidebarNotificationBadge.hidden), true);
    await page.evaluate(() => pushNotificationEvent('live', {}));
    await page.waitForFunction(() => !sidebarNotificationBadge.hidden);
    assert.equal(await page.locator('#notificationsLede').textContent(), '1 request waiting across chats.');
    assert.equal(await page.locator('.notification-card-detail').textContent(), 'Web search · Example query');
    assert.equal(await page.locator('.notification-card-title').textContent(), 'research');
    await page.locator('.notification-card').click();
    assert.equal(await page.evaluate(() => activeId), 'research');
    await page.locator('#btnNotificationsNav').click();
    await page.evaluate(() => {
      abortStream('research', { preservePartial: true });
      if (!sidebarNotificationBadge.hidden) throw new Error('Stop must clear the badge immediately');
    });
    await page.evaluate(() => notificationRun);
    assert.equal(await page.locator('.notification-card.is-attention').count(), 0);
    await page.evaluate(() => {
      startNotificationFixture(true);
      pushNotificationEvent('live', {});
    });
    await page.waitForFunction(() => activeStreams.get('research')?.serverFinished && !activeStreams.get('research').catchingUp);
    assert.equal(await page.evaluate(() => sidebarNotificationBadge.hidden), true);
    assert.equal(await page.locator('.notification-card.is-attention').count(), 0);
    await page.evaluate(async () => { notificationWriter.close(); await notificationRun; });
    await page.evaluate(() => openSettings('agent-capabilities'));
    const manual = page.locator('#approvalModeToggle [data-approval-mode="manual"]');
    assert.equal(await manual.textContent(), 'Ask before every action');
    assert.equal(await manual.getAttribute('aria-selected'), 'true');
    await page.locator('#approvalModeToggle [data-approval-mode="auto_safe"]').click();
    await page.locator('#btnSettingsSave').click();
    await page.waitForFunction(() => settings.approvalMode === 'auto_safe');
    await page.evaluate(() => storeWriteChain);
    await page.reload();
    await page.waitForFunction(() => storageReady);
    assert.equal(await page.evaluate(() => settings.approvalMode), 'auto_safe');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && !spawnError) child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
