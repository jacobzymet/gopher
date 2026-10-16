import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { serializeConfig, normalizeConfig } from '../server/config.js';
import { localClient, localOrigin, validateLive, maskedInventory, validateIsolatedCodex } from '../scripts/validate-live.js';
import { CODEX_CLIENT_VERSION, codexClientVersion } from '../server/subscription.js';
import { Providers } from '../server/providers.js';
import type { Provider } from '../server/config.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-live-harness-'));
  let modelRequests = 0, cancelled = false, fail = false;
  const upstream = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      modelRequests++;
      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== 'Bearer secret-fixture-value') { response.writeHead(401); response.end('{"error":"bad credential"}'); return; }
      response.end('{"data":[{"id":"fixture-model"}]}'); return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); assert.ok(body.max_tokens <= 512);
    response.setHeader('content-type', 'text/event-stream');
    if (fail) { response.end('data: {"error":{"message":"secret-fixture-value"}}\n\n'); return; }
    const frame = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
    if (body.messages.at(-1).content.includes('LIVE_OK')) { response.end(frame('LIVE_') + frame('OK') + 'data: [DONE]\n\n'); return; }
    response.write(frame('1\n'));
    response.once('close', () => { cancelled = true; });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const configPath = join(directory, 'config.toml');
  const config = normalizeConfig({ providers: [{ id: 'fixture', name: 'Fixture', base: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, token: 'secret-fixture-value', kind: 'custom', api_style: 'openai' }], active_provider_id: 'fixture' });
  await writeFile(configPath, serializeConfig(config));
  const publicDir = join(directory, 'public'); await mkdir(publicDir); await writeFile(join(publicDir, 'chat.html'), '<!doctype html><title>Fixture</title>');
  const app = await createApp({ configPath, bind: '127.0.0.1:0', publicDir }); await app.listen();
  const origin = `http://127.0.0.1:${(app.server.address() as any).port}`; const client = await localClient(origin);
  await app.providers.catalog();
  return { app, client, origin, get modelRequests() { return modelRequests; }, get cancelled() { return cancelled; }, fail: () => { fail = true; }, cleanup: async () => { await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } };
}

test('live validation harness verifies streaming, upstream cancellation and replay without including credentials in reports', async () => {
  const f = await fixture();
  try {
    const inventory = await maskedInventory(f.origin);
    assert.equal(JSON.stringify(inventory).includes('secret-fixture-value'), false);
    const report = await validateLive({ origin: f.origin, providerId: 'fixture', model: 'fixture-model', source: 'protocol-fixture' });
    assert.equal(report.source, 'protocol-fixture', 'A fixture result must never be described as live account evidence.');
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.catalog.refreshed, true);
    assert.equal(report.cancellation.requested_after_first_delta, true);
    assert.equal(report.cancellation.acknowledged, true);
    assert.equal(report.stream.content_chunks, 2);
    assert.equal(report.oauth_rotation.status, 'not-tested');
    assert.equal(report.restart.status, 'not-tested');
    assert.equal(JSON.stringify(report).includes('secret-fixture-value'), false);
    for (let attempt = 0; attempt < 20 && !f.cancelled; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.cancelled, true, 'Stop must close the real upstream HTTP stream.');
  } finally { await f.cleanup(); }
});

test('forced provider testing bypasses catalog cache while changed credentials cannot reuse previous authentication health', async () => {
  const f = await fixture();
  try {
    await f.client.json('/api/providers/test', { id: 'fixture', api_style: 'openai' });
    const cached = f.modelRequests;
    await f.client.json('/api/providers/test', { id: 'fixture', api_style: 'openai' });
    assert.equal(f.modelRequests, cached);
    const refreshed = await f.client.json('/api/providers/test', { id: 'fixture', api_style: 'openai', force: true });
    assert.equal(refreshed.refreshed, true); assert.equal(f.modelRequests, cached + 1);
    const rejected = await f.client.json('/api/providers/test', { id: 'fixture', api_style: 'openai', token: 'different-invalid-credential' });
    assert.equal(rejected.ok, false); assert.equal(rejected.health.kind, 'auth'); assert.equal(f.modelRequests, cached + 2);
    assert.equal(f.app.storage.config.providers.find(provider => provider.id === 'fixture')!.token, 'secret-fixture-value');
  } finally { await f.cleanup(); }
});

test('harness failure reports exclude raw upstream error messages and never imply OAuth or restart coverage', async () => {
  const f = await fixture();
  try {
    f.fail();
    const report = await validateLive({ origin: f.origin, providerId: 'fixture', model: 'fixture-model', source: 'protocol-fixture' });
    assert.equal(report.passed, false);
    assert.ok(report.failures.includes('stream_provider_error'));
    assert.equal(JSON.stringify(report).includes('secret-fixture-value'), false);
    assert.equal(report.oauth_rotation.status, 'not-tested');
  } finally { await f.cleanup(); }
});

test('live tooling refuses non-loopback origins and credential-bearing URLs before making requests', () => {
  for (const origin of ['https://example.com', 'http://user:password@127.0.0.1:3930', 'http://127.0.0.1:3930/path', 'http://127.0.0.1:3930/?token=secret']) assert.throws(() => localOrigin(origin));
  assert.equal(localOrigin('http://127.0.0.1:3930/'), 'http://127.0.0.1:3930');
});

test('Codex model catalog uses a supported client version and accepts only validated newer CLI cache versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-codex-version-')); const cache = join(directory, 'models_cache.json');
  const originalHome = process.env.CODEX_HOME, originalFetch = globalThis.fetch;
  try {
    assert.equal(await codexClientVersion(cache), CODEX_CLIENT_VERSION);
    for (const version of ['0.111.0', '0.163.0&token=secret', '999999999.0.0', 123]) {
      await writeFile(cache, JSON.stringify({ client_version: version }));
      assert.equal(await codexClientVersion(cache), CODEX_CLIENT_VERSION);
    }
    await writeFile(cache, JSON.stringify({ client_version: '0.169.0' }));
    assert.equal(await codexClientVersion(cache), '0.169.0');
    process.env.CODEX_HOME = directory;
    let requested = '';
    globalThis.fetch = (async input => {
      requested = String(input); assert.equal(new URL(requested).searchParams.get('client_version'), '0.169.0');
      return new Response(JSON.stringify({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }, { slug: 'codex-auto-review', visibility: 'hide' }] }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const provider: Provider = { id: 'builtin-openai-codex', name: 'ChatGPT', base: 'https://chatgpt.com/backend-api/codex', token: JSON.stringify({ access_token: 'fixture-access', expires_at: Date.now() / 1000 + 3600 }), kind: 'openai-codex', api_style: 'responses', allow_insecure_tls: false };
    const result = await new Providers({ getProviders: () => [provider] }).probe(provider, true);
    assert.equal(result.health.ok, true); assert.deepEqual(result.models.map(model => model.model), ['gpt-6-luna']);
    assert.match(requested, /client_version=0\.169\.0$/);
  } finally { globalThis.fetch = originalFetch; if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('isolated live runner refuses a personal session that would require refresh and leaves the CLI file untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-codex-no-rotation-')); const authPath = join(directory, 'auth.json');
  const originalHome = process.env.CODEX_HOME, originalFetch = globalThis.fetch;
  const access = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')}.signature`;
  const original = JSON.stringify({ tokens: { access_token: access, refresh_token: 'personal-refresh-must-not-rotate' } });
  try {
    await writeFile(authPath, original); process.env.CODEX_HOME = directory;
    let requests = 0; globalThis.fetch = (async () => { requests++; throw new Error('Unexpected network request'); }) as typeof fetch;
    await assert.rejects(validateIsolatedCodex(), /will not rotate the personal refresh token/);
    assert.equal(requests, 0); assert.equal(await readFile(authPath, 'utf8'), original);
  } finally { globalThis.fetch = originalFetch; if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});
