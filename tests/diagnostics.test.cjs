const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { test } = require('node:test');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const source = readFileSync(join(__dirname, '../src/ui/chat/scripts/diagnostics.js'), 'utf8');

function harness() {
  const calls = [];
  const state = vm.createContext({
    settings: { diagnosticsEnabled: false }, storageReady: true, diskEncryptionLocked: () => false,
    window: { fetch: async (url, init) => { calls.push({ url, init }); return new Response('{}'); }, addEventListener() {} },
    console: Object.fromEntries(['debug', 'log', 'info', 'warn', 'error', 'trace'].map(name => [name, () => {}])),
    document: { getElementById: () => null, querySelector: () => null },
    location: { origin: 'http://localhost', href: 'http://localhost/' },
    setInterval() {}, setTimeout() {}, URL, Headers, Request, Response, AbortSignal, TextEncoder, Error,
    performance, crypto: require('node:crypto').webcrypto,
  });
  vm.runInContext(source, state);
  const run = code => vm.runInContext(code, state);
  return { state, calls, run };
}

test('disabled diagnostics skip console capture, serialization, and diagnostic transport', async () => {
  const h = harness();
  h.run(`diagnosticMark('test', { get value() { throw new Error('must not inspect'); } }); console.warn('warning');`);
  assert.equal(h.run('diagnosticQueue.length'), 0);
  await h.state.flushDiagnostics();
  assert.equal(h.calls.length, 0);
  await h.state.window.fetch('/api/state');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init, undefined);
});

test('enabled browser logs carry timing context and redact nested credential fields', () => {
  const h = harness(); h.state.settings.diagnosticsEnabled = true;
  h.run(`diagnosticMark('test', { nested: { api_key: 'private', passphrase: 'private' }, prompt: 'visible' }, { traceId: 'turn', convoId: 'chat', startedAt: Date.now() - 20 });`);
  const entry = JSON.parse(h.run('JSON.stringify(diagnosticQueue[0])'));
  assert.equal(entry.trace_id, 'turn'); assert.equal(entry.conversation_id, 'chat');
  assert.ok(entry.elapsed_ms >= 20);
  assert.equal(entry.data.nested.api_key, '[redacted]');
  assert.equal(entry.data.prompt, 'visible');
});

test('instrumented fetch preserves request options and correlates the actual turn', async () => {
  const h = harness(); h.state.settings.diagnosticsEnabled = true;
  const controller = new AbortController();
  await h.state.window.fetch('/api/chat/completions', {
    method: 'POST', signal: controller.signal, credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turn_id: 'turn', conversation_id: 'chat' }),
  });
  const init = h.calls[0].init;
  assert.equal(init.signal, controller.signal); assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers.get('content-type'), 'application/json');
  assert.equal(init.headers.get('x-gopher-request-id'), 'turn');
  assert.equal(init.headers.get('x-gopher-conversation-id'), 'chat');
  assert.equal(h.run('diagnosticQueue.length'), 2);
});

test('a late failed log upload cannot restore private entries after lock', async () => {
  const h = harness(); h.state.settings.diagnosticsEnabled = true;
  let reject;
  // The capture transport is bound at initialization; create a second context with a deferred transport.
  const state = vm.createContext({ ...h.state, window: { fetch: () => new Promise((_, failure) => { reject = failure; }), addEventListener() {} } });
  vm.runInContext(source, state);
  vm.runInContext(`diagnosticGeneration = 1; diagnosticMark('test', { text: 'private' });`, state);
  const pending = state.flushDiagnostics();
  state.clearDiagnosticsMemory(); reject(new Error('late transport failure')); await pending;
  assert.equal(vm.runInContext('diagnosticQueue.length', state), 0);
});

test('a response from before lock cannot repopulate logs after a new session', async () => {
  const h = harness(); h.state.settings.diagnosticsEnabled = true;
  let finish;
  const state = vm.createContext({ ...h.state, window: { fetch: () => new Promise(resolve => { finish = resolve; }), addEventListener() {} } });
  vm.runInContext(source, state);
  const pending = state.window.fetch('/api/state');
  state.clearDiagnosticsMemory();
  finish(new Response('{"private":"old-response"}', { headers: { 'content-type': 'application/json' } }));
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('diagnosticQueue.length', state), 0);
});

let chromium;
try { ({ chromium } = require('playwright')); } catch {}

test('real Logs tab locates provider delay, redacts credentials, and persists only encrypted logs', {
  skip: !process.env.GOPHER_TEST_BINARY || !chromium,
  timeout: 90000,
}, async () => {
  const provider = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'diagnostic-model' }] })); return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (payload.stream === false) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'Fixture title' } }] })); return;
    }
    await delay(180);
    response.setHeader('content-type', 'text/event-stream'); response.flushHeaders();
    await delay(220);
    response.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    await delay(130);
    response.write('data: {"choices":[{"delta":{"reasoning_content":"Fixture reasoning"}}]}\n\n');
    await delay(170);
    response.end('data: {"choices":[{"delta":{"content":"Fixture answer"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'gopher-diagnostics-'));
  writeFileSync(join(dir, 'config.toml'), [
    'active_provider_id = "fixture"', '[[providers]]', 'id = "fixture"', 'name = "Fixture"',
    `base = "http://127.0.0.1:${provider.address().port}/v1"`, 'api_style = "openai"', 'token = "fixture-secret-token"',
  ].join('\n'));
  const child = spawn(resolve(process.env.GOPHER_TEST_BINARY), ['--headless', '--config', join(dir, 'config.toml'), '--bind', '127.0.0.1:0'], { windowsHide: true, stdio: 'pipe' });
  let logs = ''; let spawnError; let browser;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  const exited = new Promise(resolve => child.once('close', resolve));
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
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => storageReady && modelMenuOptions.some(model => model.label === 'diagnostic-model'));
    assert.equal(await page.evaluate(() => settings.diagnosticsEnabled), false);
    assert.equal(await page.evaluate(async () => (await (await diagnosticFetch('/api/diagnostics')).json()).entries.length), 0);
    await page.evaluate(() => openSettings('logs'));
    await page.locator('#settingDiagnosticsEnabled').check(); await page.locator('#btnSettingsSave').click();
    await page.waitForFunction(() => settings.diagnosticsEnabled);
    await page.evaluate(async () => {
      await settingsWriteChain;
      await saveSettings({ ...settings, chatRetrieval: false }, { immediate: true });
      const convo = normalizeConversation({ id: 'diagnostic-chat', title: 'Diagnostic chat', titleEdited: true, messages: [] });
      conversations.push(convo); selectConversation(convo.id); closeSettings();
      composerInput.value = 'Private diagnostic prompt'; await sendMessage();
      console.warn('fixture console warning', { api_key: 'console-secret' });
    });
    await page.waitForFunction(() => !activeStreams.has('diagnostic-chat') && conversations.find(item => item.id === 'diagnostic-chat')?.messages.some(message => message.role === 'assistant'));
    const data = await page.evaluate(async () => { await refreshDiagnostics(); await flushDiagnostics(); await refreshDiagnostics(); return diagnosticStatus; });
    const entries = data.entries;
    const all = await page.evaluate(() => diagnosticEntries);
    const event = name => all.find(entry => entry.event === name);
    for (const name of ['prompt.prepare.started', 'cancel.wait.finished', 'chat.request.dispatch', 'provider.request', 'provider.headers', 'provider.first_byte', 'provider.raw_chunk', 'server.first_reasoning_token', 'server.first_content_token', 'browser.first_reasoning_token', 'browser.first_content_token', 'console.warn']) assert.ok(event(name), name);
    assert.ok(event('provider.headers').elapsed_ms >= 150);
    assert.ok(event('provider.first_byte').elapsed_ms >= 350);
    assert.ok(event('server.first_reasoning_token').elapsed_ms >= 450);
    assert.ok(event('browser.first_content_token').elapsed_ms >= 600);
    assert.equal(event('provider.request').trace_id, event('chat.request.dispatch').trace_id);
    assert.match(JSON.stringify(all), /Private diagnostic prompt|Fixture reasoning/);
    assert.doesNotMatch(JSON.stringify(all), /fixture-secret-token|console-secret/);
    assert.equal(existsSync(join(dir, 'diagnostics.json')), false);
    await page.evaluate(() => openSettings('logs'));
    assert.match(await page.locator('#diagnosticsTimings').textContent(), /Upstream headers:|Browser first content:/);
    assert.match(await page.locator('#diagnosticsTimings').textContent(), /TTFT: \d+ ms/);
    await page.evaluate(async () => {
      console.log('<img src=x onerror="window.logXss=true">');
      await flushDiagnostics(); await refreshDiagnostics();
    });
    await page.locator('#diagnosticsSearch').fill('console.log');
    await page.locator('.diagnostic-entry').first().click();
    await page.waitForFunction(() => document.querySelector('.diagnostic-entry[open] pre')?.textContent.includes('<img'));
    assert.equal(await page.evaluate(() => window.logXss), undefined);
    await page.locator('#diagnosticsSearch').fill('provider.raw_chunk');
    await page.locator('.diagnostic-entry').first().click();
    await page.waitForFunction(() => document.querySelector('.diagnostic-entry[open] pre')?.textContent.length > 0);
    assert.match(await page.locator('.diagnostic-entry[open] pre').textContent(), /Fixture|choices/);
    await page.locator('#diagnosticsSearch').fill('');
    await page.screenshot({ path: resolve('target/diagnostics-ui.png') });
    await page.evaluate(async () => {
      for (let start = 0; start < 600; start += 60) {
        const response = await diagnosticFetch('/api/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          generation: diagnosticGeneration, entries: Array.from({ length: 60 }, (_, offset) => ({ event: 'fixture.history', level: 'info', data: { index: start + offset } })),
        }) });
        if (!response.ok) throw new Error('Could not seed retained history');
      }
      await refreshDiagnostics();
    });
    await page.locator('#diagnosticsSearch').fill('fixture.history');
    assert.equal(await page.locator('.diagnostic-entry').count(), 500);
    await page.getByRole('button', { name: 'Show 100 earlier entries', exact: true }).click();
    assert.equal(await page.locator('.diagnostic-entry').count(), 600);
    await page.locator('#diagnosticsSearch').fill('');
    await page.evaluate(async () => {
      await postEncryption('/api/data/encryption/enable', { passphrase: 'diagnostics fixture passphrase', passphrase_confirm: 'diagnostics fixture passphrase' });
      await refreshDiagnostics();
    });
    const disk = readFileSync(join(dir, 'diagnostics.json'), 'utf8');
    assert.doesNotMatch(disk, /Private diagnostic prompt|Fixture reasoning|console-secret/);
    assert.ok(JSON.parse(disk).ciphertext);
    const downloadReady = page.waitForEvent('download'); await page.locator('#btnDiagnosticsExport').click();
    const download = await downloadReady;
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.ok(exported.entries.length); assert.doesNotMatch(JSON.stringify(exported), /fixture-secret-token|console-secret/);
    await page.evaluate(async () => { await postEncryption('/api/data/encryption/lock', {}); clearMemoryAfterLock(); });
    assert.equal(await page.evaluate(() => diagnosticEntries.length), 0);
    assert.equal(await page.evaluate(async () => (await diagnosticFetch('/api/diagnostics')).status), 423);
    await page.evaluate(async () => {
      await unlockDiskEncryption('diagnostics fixture passphrase');
      await refreshDiagnostics(); openSettings('logs');
    });
    assert.ok(await page.evaluate(() => diagnosticEntries.some(entry => entry.event === 'provider.raw_chunk')));
    await page.locator('#btnDiagnosticsClear').click();
    await page.waitForFunction(() => diagnosticEntries.length === 0 && diagnosticGeneration != null);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && !spawnError) child.kill(); await exited;
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
