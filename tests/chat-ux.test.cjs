const { chromium, appTestsEnabled, spawnApp, browserLaunchOptions, stopApp, removeAppData, mockAppUpdates } = require('./helpers/app.cjs');
const { readUiScript } = require('./helpers/ui-source.cjs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const vm = require('node:vm');

function load(context, file, names) {
  const source = readUiScript(file).replace(/\r\n/g, '\n');
  for (const name of names) {
    const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}

function retryHarness(messages, busy = false) {
  const edits = [];
  const hints = [];
  const userRow = { dataset: { raw: 'original question' } };
  const context = vm.createContext({
    activeId: 'chat-1',
    conversations: [{ id: 'chat-1', messages }],
    isConvoBusy: () => busy,
    chatThread: { querySelector: (selector) => (selector.includes('data-msg-index="0"') ? userRow : null) },
    showComposerHint: (text) => hints.push(text),
    submitEditedMessage: (row, text) => { edits.push({ row, text }); return Promise.resolve(); },
  });
  load(context, 'render.js', ['retryableUserIndex', 'syncRetryAction', 'retryFailedReply']);
  return { context, edits, hints, userRow };
}

test('only a failed last reply that answers a user message can be retried', () => {
  const { context } = retryHarness([]);
  const user = { role: 'user', content: 'q' };
  const failed = { role: 'assistant', content: 'x', error: 'Provider request failed (500)' };
  const ok = { role: 'assistant', content: 'fine' };
  const convo = (messages) => ({ id: 'c', messages });
  assert.equal(context.retryableUserIndex(convo([user, failed]), 1), 0);
  assert.equal(context.retryableUserIndex(convo([user, ok]), 1), -1);
  assert.equal(context.retryableUserIndex(convo([user, failed, user, ok]), 1), -1, 'an older failure');
  assert.equal(context.retryableUserIndex(convo([failed]), 0), -1, 'no user message before it');
  assert.equal(context.retryableUserIndex(convo([user, failed]), Number.NaN), -1);
  assert.equal(context.retryableUserIndex(null, 1), -1);
});

test('Retry re-sends the user message through the unchanged-edit path', () => {
  const h = retryHarness([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'x', error: 'failed' }]);
  h.context.retryFailedReply({ dataset: { msgIndex: '1' } });
  assert.equal(h.edits.length, 1);
  assert.equal(h.edits[0].row, h.userRow);
  assert.equal(h.edits[0].text, 'original question');
});

test('Retry does nothing while a turn is running in the chat', () => {
  const h = retryHarness([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'x', error: 'failed' }], true);
  const row = { dataset: { msgIndex: '1' }, classList: { contains: () => true }, querySelector: () => null };
  h.context.retryFailedReply(row);
  assert.equal(h.edits.length, 0);
});

/** Run `fn(page)` against the app wired to a local provider whose streaming replies come from `stream`. */
async function withFixtureApp(stream, fn) {
  const provider = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    if (request.url !== '/v1/chat/completions') return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (!body.stream) return response.end(JSON.stringify({ choices: [{ message: { content: 'Fixture title' } }] }));
    return stream(response, body);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'gopher-chat-ux-'));
  writeFileSync(join(dir, 'config.toml'), [
    'active_provider_id = "fixture"', '[[providers]]', 'id = "fixture"', 'name = "Fixture"',
    `base = "http://127.0.0.1:${provider.address().port}/v1"`, 'api_style = "openai"', 'token = ""',
  ].join('\n'));
  const child = spawnApp(['--headless', '--config', join(dir, 'config.toml'), '--bind', '127.0.0.1:0'], { stdio: 'pipe' });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  let browser;
  try {
    let origin;
    for (let i = 0; i < 150 && !origin; i++) {
      const port = logs.match(/Gopher listening on http:\/\/gopher\.localhost:(\d+)/)?.[1];
      if (port && Number(port)) origin = `http://127.0.0.1:${port}`;
      else await delay(100);
    }
    assert.ok(origin, logs);
    browser = await chromium.launch(browserLaunchOptions());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    await mockAppUpdates(page, origin);
    await page.goto(origin);
    await page.waitForFunction(() => storageReady && latestState?.network?.remote_models?.some(model => model.ready));
    await page.evaluate(() => saveSettings({ ...settings, chatRetrieval: false }, { immediate: true }));
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await stopApp(child);
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await removeAppData(dir);
  }
}

const browserTest = { skip: !appTestsEnabled || !chromium, timeout: 60000 };
const answer = (response, text) => {
  response.setHeader('content-type', 'text/event-stream');
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
};

test('a failed reply offers Retry, which replaces it with the answer', browserTest, async () => {
  let streams = 0;
  await withFixtureApp((response) => {
    streams++;
    if (streams === 1) return response.writeHead(500).end(JSON.stringify({ error: { message: 'Temporary outage' } }));
    return answer(response, 'Recovered answer');
  }, async (page) => {
    await page.evaluate(async () => { composerInput.value = 'Please answer'; await sendMessage(); });
    const retry = page.getByRole('button', { name: 'Retry this reply' });
    await retry.waitFor({ timeout: 15000 });
    assert.match(await page.locator('.msg-role-assistant').last().innerText(), /Temporary outage/);
    await retry.click();
    await page.waitForFunction(() => {
      const convo = conversations.find(item => item.id === activeId);
      return !activeStreams.has(activeId) && convo?.messages?.at(-1)?.content === 'Recovered answer';
    }, null, { timeout: 15000 });
    const state = await page.evaluate(() => ({
      roles: conversations.find(item => item.id === activeId).messages.map(m => m.role + (m.error ? ':error' : '')),
      retryButtons: document.querySelectorAll('.msg-action-retry').length,
    }));
    assert.deepEqual(state, { roles: ['user', 'assistant'], retryButtons: 0 });
    assert.equal(streams, 2);
  });
});

test('a narrow chat column keeps the composer tools on one row', browserTest, async () => {
  await withFixtureApp((response) => answer(response, 'ok'), async (page) => {
    const rows = await page.evaluate(async () => {
      const shell = document.getElementById('composerShell');
      const measure = () => {
        const tools = document.querySelector('.composer-tools').getBoundingClientRect();
        const plus = document.getElementById('btnPlus').getBoundingClientRect();
        return { toolsRows: Math.round(tools.height / plus.height), label: getComputedStyle(document.querySelector('.btn-branch-label')).display };
      };
      const result = {};
      for (const width of [640, 320, 260]) {
        shell.style.width = width + 'px';
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        result[width] = measure();
      }
      return result;
    });
    assert.deepEqual(rows[640], { toolsRows: 1, label: 'block' });
    assert.deepEqual(rows[320], { toolsRows: 1, label: 'none' });
    assert.equal(rows[260].toolsRows, 1, 'the send group wraps instead of stacking the tools');
  });
});

test('a rejected unlock passphrase is selected so typing again replaces it', browserTest, async () => {
  await withFixtureApp((response) => answer(response, 'ok'), async (page) => {
    const passphrase = 'fixture-passphrase-1234';
    await page.evaluate(() => openSettings('data'));
    await page.fill('#encryptionPassphrase', passphrase);
    await page.fill('#encryptionPassphraseConfirm', passphrase);
    await page.click('#btnEnableEncryption');
    await page.locator('#btnLockEncryption').waitFor({ state: 'visible', timeout: 20000 });
    await page.click('#btnLockEncryption');
    const field = page.locator('#unlockModalPassphrase');
    await field.waitFor({ state: 'visible' });
    await field.fill('not-the-passphrase');
    await field.press('Enter');
    await page.locator('#unlockModalError').filter({ hasText: /passphrase/i }).waitFor({ timeout: 20000 });
    const selection = await field.evaluate(input => ({
      focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, length: input.value.length,
    }));
    assert.deepEqual(selection, { focused: true, start: 0, end: 'not-the-passphrase'.length, length: 'not-the-passphrase'.length });
    await page.keyboard.type(passphrase);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => storageReady && !diskEncryptionLocked(), null, { timeout: 20000 });
  });
});
