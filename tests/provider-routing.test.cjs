const { chromium, appTestsEnabled, spawnApp, browserLaunchOptions, stopApp, removeAppData } = require('./helpers/app.cjs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

test('chat and title requests use the selected provider even when another provider is active', {
  skip: !appTestsEnabled || !chromium, timeout: 60000,
}, async () => {
  const seen = [[], []];
  const providers = seen.map(requests => createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'shared-model' }] }));
    if (request.url !== '/v1/chat/completions') return response.writeHead(404).end();
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (!body.stream) return response.end(JSON.stringify({ choices: [{ message: { content: 'Correct provider title' } }] }));
    response.setHeader('content-type', 'text/event-stream');
    response.end('data: {"choices":[{"delta":{"content":"Correct provider answer"}}]}\n\ndata: [DONE]\n\n');
  }));
  await Promise.all(providers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const dir = mkdtempSync(join(tmpdir(), 'gopher-provider-routing-'));
  writeFileSync(join(dir, 'config.toml'), [
    'active_provider_id = "nvidia-fixture"',
    ...providers.flatMap((server, i) => ['[[providers]]', `id = "${i ? 'chosen' : 'nvidia-fixture'}"`,
      `name = "${i ? 'Chosen' : 'Inactive NVIDIA fixture'}"`, `base = "http://127.0.0.1:${server.address().port}/v1"`,
      'api_style = "openai"', 'token = ""']),
  ].join('\n'));
  const child = spawnApp(['--headless', '--config', join(dir, 'config.toml'), '--bind', '127.0.0.1:0'], { windowsHide: true, stdio: 'pipe' });
  let logs = ''; let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  let browser;
  try {
    let origin;
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      const port = logs.match(/Gopher listening on http:\/\/gopher\.localhost:(\d+)/)?.[1];
      if (port && Number(port)) { origin = `http://127.0.0.1:${port}`; break; }
      await delay(100);
    }
    assert.ok(origin, logs);
    browser = await chromium.launch(browserLaunchOptions(process.env.SECURITY_BROWSER_CHANNEL));
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => storageReady && latestState?.network && !latestState.network.remote_catalog_pending && latestState.network.remote_models.some(model => model.provider_id === 'chosen' && model.ready));
    await page.evaluate(async () => {
      const chosen = latestState.network.remote_models.find(model => model.provider_id === 'chosen');
      await saveSettings({ ...settings, selectedChatModel: chosen.id, chatRetrieval: false }, { immediate: true });
      const convo = normalizeConversation({ id: 'chosen-chat', title: 'Chosen', titleEdited: true, modelId: chosen.id, messages: [] });
      conversations.push(convo); selectConversation(convo.id);
      composerInput.value = 'Verify correct provider'; await sendMessage();
    });
    await page.waitForFunction(() => !activeStreams.has('chosen-chat'));
    const result = await page.evaluate(async () => {
      const chosen = conversationModelId(conversations.find(item => item.id === 'chosen-chat'));
      const title = await requestGeneratedTitle('Verify correct provider', chosen);
      const missing = await fetch('/api/chat/title', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Must not use active provider' }) });
      const expired = await fetch('/api/chat/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'obsolete-approval', allow: true }) });
      const snapshot = latestState;
      latestState = { ...snapshot, network: { ...snapshot.network, remote_models: snapshot.network.remote_models.filter(model => model.provider_id !== 'chosen') } };
      let blocked = false;
      try { await requestGeneratedTitle('No accidental provider switch', chosen); } catch (error) { blocked = error.retryable === false; }
      latestState = snapshot;
      return { title, missing: missing.status, expiredStatus: expired.status, expired: await expired.json(), blocked };
    });
    assert.deepEqual(result, { title: 'Correct provider title', missing: 400, expiredStatus: 200, expired: { ok: false, expired: true }, blocked: true });
    assert.equal(seen[0].length, 0, 'the active NVIDIA fixture must receive no completion or title requests');
    assert.equal(seen[1].filter(body => body.stream).length, 1);
    assert.equal(seen[1].filter(body => !body.stream).length, 1);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await stopApp(child);
    await Promise.all(providers.map(server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }));
    await removeAppData(dir);
  }
});
