import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.js';

interface Reply { status: number; headers: IncomingHttpHeaders; text: string; body: any }
interface SendOptions { method?: string; data?: unknown; raw?: string; headers?: Record<string, string>; authenticated?: boolean }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-http-'));
  const publicDir = join(directory, 'public'); await mkdir(publicDir);
  await writeFile(join(publicDir, 'chat.html'), '<!doctype html><title>Gopher fixture</title>');
  let app = await createApp({ configPath: join(directory, 'config.toml'), bind: '127.0.0.1:0', publicDir });
  await app.listen();
  let port = (app.server.address() as { port: number }).port;
  let cookie = '';
  const send = (path: string, options: SendOptions = {}): Promise<Reply> => new Promise((resolve, reject) => {
    const payload = options.raw ?? (options.data === undefined ? undefined : JSON.stringify(options.data));
    const req = request({ host: '127.0.0.1', port, path, method: options.method || 'GET', headers: { ...(cookie && options.authenticated !== false ? { cookie } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }), ...options.headers } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let body: any; try { body = JSON.parse(text); } catch { body = null; } resolve({ status: response.statusCode || 0, headers: response.headers, text, body }); });
      response.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('HTTP test timed out'))); req.end(payload);
  });
  const bootstrap = await send('/', { authenticated: false });
  cookie = (bootstrap.headers['set-cookie']?.[0] || '').split(';')[0]!;
  return { get app() { return app; }, directory, get port() { return port; }, get cookie() { return cookie; }, bootstrap, send,
    restart: async () => { await app.close(); app = await createApp({ configPath: join(directory, 'config.toml'), bind: '127.0.0.1:0', publicDir }); await app.listen(); port = (app.server.address() as { port: number }).port; const next = await send('/', { authenticated: false }); cookie = (next.headers['set-cookie']?.[0] || '').split(';')[0]!; },
    cleanup: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function mockProvider(hold = false) {
  const calls: { path: string; token: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body: any; try { body = JSON.parse(raw); } catch { body = null; }
    calls.push({ path: req.url || '', token: req.headers.authorization || '', body });
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-model', context_length: 32768 }] })); return; }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Model answer' }, finish_reason: null }] })}\n\n`);
      if (!hold) res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { calls, base: `http://127.0.0.1:${port}/v1`, cleanup: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('HTTP bootstrap establishes a strict cookie and API checks token, Host, Origin and fetch metadata', async () => {
  const f = await fixture();
  try {
    assert.equal(f.bootstrap.status, 200);
    assert.match(f.cookie, /^gopher_session=[A-Za-z0-9_-]{40,}$/);
    assert.match(f.bootstrap.headers['set-cookie']![0]!, /HttpOnly; SameSite=Strict/);
    assert.equal(f.bootstrap.headers['x-frame-options'], 'DENY');
    assert.equal((await f.send('/api/state', { authenticated: false })).status, 401);
    assert.equal((await f.send('/api/state', { authenticated: false, headers: { 'x-gopher-token': 'wrong' } })).status, 401);
    assert.equal((await f.send('/api/state', { headers: { host: 'attacker.example' } })).status, 421);
    assert.equal((await f.send('/api/state', { headers: { origin: 'https://attacker.example' } })).status, 401);
    assert.equal((await f.send('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 401);
    assert.equal((await f.send('/api/state', { headers: { origin: `http://127.0.0.1:${f.port}` } })).status, 200);
    const token = f.cookie.slice('gopher_session='.length);
    assert.equal((await f.send('/api/state', { authenticated: false, headers: { 'x-gopher-token': token } })).status, 200);
    for (const path of ['/api%2Fdata%2Fstore', '/x/../api/data/store', '/api/%2e%2e/api/data/store']) {
      const result = await f.send(path, { authenticated: false });
      assert.ok([400, 401, 404].includes(result.status), `${path} bypassed authorization with ${result.status}`);
    }
  } finally { await f.cleanup(); }
});

test('HTTP data and skills persist, and malformed writes preserve existing records', async () => {
  const f = await fixture();
  try {
    const stored = { profiles: [{ id: 'profile', projects: [], conversations: [{ id: 'c1', title: 'Saved' }], bots: [] }], activeProfileId: 'profile' };
    assert.equal((await f.send('/api/data/store', { method: 'PUT', data: stored })).status, 204);
    assert.equal((await f.send('/api/data/store')).body.profiles[0].conversations[0].title, 'Saved');
    assert.equal((await f.send('/api/data/store', { method: 'PUT', data: { profiles: false } })).status, 400);
    assert.equal((await f.send('/api/data/store', { method: 'PUT', raw: '{broken' })).status, 400);
    assert.equal((await f.send('/api/data/store')).body.profiles[0].conversations[0].id, 'c1');
    const preferences = { name: 'Ada', diagnosticsEnabled: true, selectedChatModel: 'mock-model' };
    assert.equal((await f.send('/api/data/preferences', { method: 'PUT', data: preferences })).status, 200);
    assert.deepEqual((await f.send('/api/data/preferences')).body, preferences);
    const imported = await f.send('/api/skills/import', { method: 'POST', data: { filename: '../review.md', content: '---\nname: Review\n---\nRead carefully.' } });
    assert.equal(imported.status, 200); assert.equal(imported.body.source_filename, 'review.md');
    assert.equal((await f.send(`/api/skills/${imported.body.id}`, { method: 'PATCH', data: { enabled: false } })).body.enabled, false);
    assert.equal((await f.send('/api/skills')).body.skills.length, 1);
    assert.equal((await f.send(`/api/skills/${imported.body.id}`, { method: 'DELETE' })).body.skills.length, 0);
    const disk = JSON.parse(await readFile(join(f.directory, 'chats.json'), 'utf8'));
    assert.equal(disk.profiles[0].conversations[0].title, 'Saved');
  } finally { await f.cleanup(); }
});

test('HTTP provider CRUD, credential masking, model probing and streaming use a real local mock endpoint', async () => {
  const mock = await mockProvider(), f = await fixture();
  try {
    const created = await f.send('/api/providers', { method: 'POST', data: { name: 'Mock inference', base: mock.base, token: 'mock-secret', api_style: 'openai' } });
    assert.equal(created.status, 200);
    const provider = created.body.providers.find((p: any) => p.name === 'Mock inference');
    assert.ok(provider); assert.equal(provider.token_set, true); assert.equal(provider.token, undefined);
    assert.equal(JSON.stringify(created.body).includes('mock-secret'), false);
    const probe = await f.send('/api/providers/test', { method: 'POST', data: { id: provider.id } });
    assert.equal(probe.status, 200); assert.equal(probe.body.ok, true); assert.equal(probe.body.models, 1);
    assert.ok(mock.calls.some(call => call.path === '/v1/models' && call.token === 'Bearer mock-secret'));
    assert.equal((await f.send(`/api/providers/${provider.id}`, { method: 'PATCH', data: { name: 'Renamed' } })).status, 200);
    assert.equal((await f.send(`/api/providers/${provider.id}/activate`, { method: 'POST' })).status, 200);
    const stream = await f.send('/api/chat/completions', { method: 'POST', data: { provider_id: provider.id, model: 'mock-model', conversation_id: 'mock-conversation', skills: { chat_retrieval: false }, messages: [{ role: 'user', content: 'Hello' }] } });
    assert.equal(stream.status, 200); assert.match(stream.text, /Model answer/); assert.match(stream.text, /\[DONE\]/);
    const call = mock.calls.find(entry => entry.path === '/v1/chat/completions');
    assert.equal(call?.token, 'Bearer mock-secret'); assert.equal(call?.body.model, 'mock-model');
    const removed = await f.send(`/api/providers/${provider.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200); assert.equal(removed.body.providers.some((p: any) => p.id === provider.id), false);
  } finally { await f.cleanup(); await mock.cleanup(); }
});

test('HTTP encryption gates protected endpoints, clears provider metadata, and unlock restores data', async () => {
  const f = await fixture();
  try {
    await f.send('/api/data/store', { method: 'PUT', data: [{ id: 'private', title: 'Secret title' }] });
    assert.equal((await f.send('/api/data/encryption/enable', { method: 'POST', data: { passphrase: 'password', passphrase_confirm: 'mismatch' } })).status, 400);
    assert.equal((await f.send('/api/data/encryption/enable', { method: 'POST', data: { passphrase: 'password', passphrase_confirm: 'password' } })).body.encryption_unlocked, true);
    const locked = await f.send('/api/data/encryption/lock', { method: 'POST' });
    assert.equal(locked.status, 200); assert.equal(locked.body.encryption_unlocked, false);
    const state = await f.send('/api/state'); assert.deepEqual(state.body.providers, []); assert.equal(state.body.config_path, '');
    assert.equal((await f.send('/api/data')).body.data_dir, '');
    for (const path of ['/api/data/store', '/api/data/preferences', '/api/providers', '/api/skills', '/api/diagnostics']) assert.equal((await f.send(path)).status, 423);
    assert.equal((await f.send('/api/data/encryption/unlock', { method: 'POST', data: { passphrase: 'incorrect' } })).status, 400);
    assert.equal((await f.send('/api/data/store')).status, 423);
    assert.equal((await f.send('/api/data/encryption/unlock', { method: 'POST', data: { passphrase: 'password' } })).status, 200);
    assert.equal((await f.send('/api/data/store')).body.conversations[0].title, 'Secret title');
    assert.equal((await f.send('/api/data/encryption/disable', { method: 'POST', data: { passphrase: 'password' } })).body.encryption_enabled, false);
  } finally { await f.cleanup(); }
});

test('locking encryption revokes an active model stream and terminal WebSocket', async () => {
  const mock = await mockProvider(true), f = await fixture();
  let socket: WebSocket | undefined;
  try {
    const created = await f.send('/api/providers', { method: 'POST', data: { name: 'Holding model', base: mock.base, token: 'secret', api_style: 'openai' } });
    const provider = created.body.providers.find((p: any) => p.name === 'Holding model');
    await f.send('/api/data/encryption/enable', { method: 'POST', data: { passphrase: 'password', passphrase_confirm: 'password' } });
    const terminal = await f.send('/api/terminal/open', { method: 'POST', data: { workspace: f.directory } });
    assert.equal(terminal.status, 200, terminal.text);
    socket = new WebSocket(`ws://127.0.0.1:${f.port}/api/terminal/ws/${terminal.body.id}`, { headers: { cookie: f.cookie, origin: `http://127.0.0.1:${f.port}` } });
    await once(socket, 'open');
    const socketClosed = once(socket, 'close');
    let firstResolve!: () => void;
    const firstText = new Promise<void>(resolve => { firstResolve = resolve; });
    const payload = JSON.stringify({ provider_id: provider.id, model: 'mock-model', conversation_id: 'held-conversation', skills: { chat_retrieval: false }, messages: [{ role: 'user', content: 'Hello' }] });
    let text = '';
    const ended = new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: f.port, path: '/api/chat/completions', method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
        response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; if (text.includes('Model answer')) firstResolve(); });
        response.on('end', resolve); response.on('error', reject);
      });
      req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('Stream revocation timed out'))); req.end(payload);
    });
    await Promise.race([firstText, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('No model output arrived')), 10000); timer.unref(); })]);
    assert.equal((await f.send('/api/data/encryption/lock', { method: 'POST' })).status, 200);
    await Promise.all([ended, socketClosed]);
    assert.equal(f.app.engine.liveTurns().length, 0);
    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.equal((await f.send(`/api/chat/live/held-conversation`)).status, 423);
  } finally { socket?.terminate(); await f.cleanup(); await mock.cleanup(); }
});

test('a protected request whose body finishes after lock cannot start a terminal', async () => {
  const f = await fixture();
  const manager = f.app.terminals;
  const original = manager.open;
  let opens = 0;
  manager.open = async function (...args: Parameters<typeof original>) { opens++; return original.apply(this, args); };
  try {
    await f.send('/api/data/encryption/enable', { method: 'POST', data: { passphrase: 'password', passphrase_confirm: 'password' } });
    const payload = JSON.stringify({ workspace: f.directory });
    let outgoing!: ReturnType<typeof request>;
    const response = new Promise<number>((resolve, reject) => {
      outgoing = request({ host: '127.0.0.1', port: f.port, path: '/api/terminal/open', method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, reply => { reply.resume(); reply.on('end', () => resolve(reply.statusCode || 0)); });
      outgoing.on('error', reject); outgoing.write(payload.slice(0, 1));
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await f.send('/api/data/encryption/lock', { method: 'POST' })).status, 200);
    outgoing.end(payload.slice(1));
    assert.equal(await response, 423);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(opens, 0, 'A request revoked during body upload opened a shell after lock.');
  } finally { manager.open = original; await f.cleanup(); }
});

test('ChatGPT browser, device and CLI import flows require encrypted storage before starting', async () => {
  const f = await fixture();
  try {
    for (const action of ['login', 'device', 'import']) {
      const result = await f.send(`/api/subscription/codex/${action}`, { method: 'POST', data: { confirm: true } });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /encryption/i);
    }
    const status = await f.send('/api/subscription/codex/device');
    assert.equal(status.body.status, 'idle');
    assert.equal(f.app.storage.config.providers.find(provider => provider.kind === 'openai-codex')?.token, '');
  } finally { await f.cleanup(); }
});

test('occupied Codex callback port returns the client fallback code for device sign-in', async () => {
  const occupied = createServer();
  const ownsPort = await new Promise<boolean>((resolve, reject) => {
    occupied.once('error', error => { if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') resolve(false); else reject(error); });
    occupied.listen(1455, '127.0.0.1', () => resolve(true));
  });
  const f = await fixture();
  try {
    await f.send('/api/data/encryption/enable', { method: 'POST', data: { passphrase: 'password', passphrase_confirm: 'password' } });
    const result = await f.send('/api/subscription/codex/login', { method: 'POST', data: {} });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'codex_browser_port_busy');
    assert.match(result.body.error, /1455/);
  } finally { await f.cleanup(); if (ownsPort) await new Promise<void>(resolve => occupied.close(() => resolve())); }
});

test('profile settings, appearance, clearing history and profile deletion persist through HTTP restarts', async () => {
  const f = await fixture();
  try {
    const profiles = [{ id: 'personal', name: 'Personal', projects: [{ id: 'personal-project' }], conversations: [{ id: 'personal-chat', messages: [{ role: 'user', content: 'Keep this' }] }], bots: [], settings: { name: 'Personal name', memory: 'Personal memory' }, notifications: [] }, { id: 'work', name: 'Work', projects: [{ id: 'work-project' }], conversations: [{ id: 'work-chat', loop: true, messages: [] }], bots: [{ id: 'work-bot', memory: 'Preserve bot memory' }], settings: { instructions: 'Work instructions', memory: 'Work memory' }, notifications: [{ id: 'notification', text: 'Keep notification' }] }];
    await f.send('/api/data/store', { method: 'PUT', data: { version: 3, activeProfileId: 'work', profiles } });
    const preferences = { name: 'Work name', pinnedModelIds: ['provider|model'], profileSettings: { personal: { name: 'Personal name' }, work: { name: 'Work name', memory: 'Work memory' } } };
    await f.send('/api/data/preferences', { method: 'PUT', data: preferences });
    await f.send('/api/ui/appearance', { method: 'POST', data: { theme: 'light', font_body: 'literata', font_display: 'fraunces', font_mono: 'fira-code', font_scale: 'large' } });
    await f.restart();
    assert.deepEqual((await f.send('/api/data/store')).body.profiles, profiles);
    assert.deepEqual((await f.send('/api/data/preferences')).body, preferences);
    const appearance = (await f.send('/api/state')).body;
    assert.equal(appearance.theme, 'light'); assert.equal(appearance.font_body, 'literata'); assert.equal(appearance.font_scale, 'large');
    const current = (await f.send('/api/data/store')).body;
    const work = current.profiles.find((profile: any) => profile.id === 'work'); work.projects = []; work.conversations = [];
    await f.send('/api/data/store', { method: 'PUT', data: current });
    await f.restart();
    const cleared = (await f.send('/api/data/store')).body;
    assert.equal(cleared.profiles.find((profile: any) => profile.id === 'personal').conversations[0].id, 'personal-chat');
    assert.equal(cleared.profiles.find((profile: any) => profile.id === 'work').bots[0].memory, 'Preserve bot memory');
    assert.equal(cleared.profiles.find((profile: any) => profile.id === 'work').notifications[0].id, 'notification');
    cleared.profiles = cleared.profiles.filter((profile: any) => profile.id === 'work');
    await f.send('/api/data/store', { method: 'PUT', data: cleared });
    await f.restart();
    const deleted = (await f.send('/api/data/store')).body;
    assert.equal(deleted.activeProfileId, 'work'); assert.equal(deleted.profiles.length, 1); assert.equal(deleted.profiles[0].settings.memory, 'Work memory');
  } finally { await f.cleanup(); }
});

test('diagnostic batches redact credentials, persist only encrypted, reject stale generations and clear durably', async () => {
  const f = await fixture();
  try {
    await f.send('/api/data/preferences', { method: 'PUT', data: { diagnosticsEnabled: true } });
    let view = (await f.send('/api/diagnostics')).body;
    await f.send('/api/diagnostics', { method: 'POST', data: { generation: view.generation, entries: [{ event: 'secret-regression', trace_id: 'diagnostic-trace', data: { authorization: 'Bearer never-store-this', access_token: 'oauth-private', nested: { 'CF-Access-Client-Secret': 'access-private' }, text: 'api_key=text-private' } }] } });
    view = (await f.send('/api/diagnostics')).body;
    const entry = view.entries.find((item: any) => item.event === 'secret-regression');
    for (const secret of ['never-store-this', 'oauth-private', 'access-private', 'text-private']) assert.equal(entry.data.includes(secret), false);
    await f.app.storage.flushDiagnostics();
    await assert.rejects(readFile(join(f.directory, 'diagnostics.json')), /ENOENT/);
    await f.send('/api/data/encryption/enable', { method: 'POST', data: { passphrase: 'diagnostic-password', passphrase_confirm: 'diagnostic-password' } });
    await f.app.storage.flushDiagnostics();
    assert.equal(JSON.parse(await readFile(join(f.directory, 'diagnostics.json'), 'utf8')).gopher_crypto, 2);
    await f.restart();
    assert.equal((await f.send('/api/diagnostics')).status, 423);
    await f.send('/api/data/encryption/unlock', { method: 'POST', data: { passphrase: 'diagnostic-password' } });
    view = (await f.send('/api/diagnostics')).body;
    assert.equal(view.persisted, true); assert.ok(view.entries.some((item: any) => item.event === 'secret-regression'));
    const generation = view.generation;
    await f.send('/api/diagnostics', { method: 'DELETE' });
    assert.equal((await f.send('/api/diagnostics', { method: 'POST', data: { generation, entries: [{ event: 'late-secret-entry' }] } })).status, 409);
    await f.restart(); await f.send('/api/data/encryption/unlock', { method: 'POST', data: { passphrase: 'diagnostic-password' } });
    view = (await f.send('/api/diagnostics')).body;
    assert.equal(view.entries.some((item: any) => ['secret-regression', 'late-secret-entry'].includes(item.event)), false);
  } finally { await f.cleanup(); }
});

test('provider upserts retain identity, preserve omitted tokens, clear explicit tokens, and enforce 32 custom endpoints', async () => {
  const mock = await mockProvider(), f = await fixture();
  try {
    const first = await f.send('/api/providers', { method: 'POST', data: { name: 'Original', base: mock.base, token: 'original-secret', api_style: 'openai' } });
    const original = first.body.providers.find((provider: any) => provider.kind === 'custom');
    const duplicate = await f.send('/api/providers', { method: 'POST', data: { name: 'Updated', base: `${mock.base}/`, api_style: 'openai' } });
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.providers.filter((provider: any) => provider.kind === 'custom').length, 1);
    assert.equal(duplicate.body.providers.find((provider: any) => provider.kind === 'custom').id, original.id);
    assert.equal(f.app.storage.config.providers.find(provider => provider.id === original.id)?.token, 'original-secret');
    const renamed = await f.send(`/api/providers/${original.id}`, { method: 'PATCH', data: { name: 'A'.repeat(90), token: '' } });
    const updated = renamed.body.providers.find((provider: any) => provider.id === original.id);
    assert.equal(updated.name.length, 64); assert.equal(updated.token_set, false);
    for (let index = 1; index < 32; index++) {
      const result = await f.send('/api/providers', { method: 'POST', data: { name: `Endpoint ${index}`, base: `${mock.base}/endpoint-${index}/v1`, api_style: 'openai' } });
      assert.equal(result.status, 200, result.text);
    }
    const limit = await f.send('/api/providers', { method: 'POST', data: { name: 'Over limit', base: `${mock.base}/over-limit/v1`, api_style: 'openai' } });
    assert.equal(limit.status, 400); assert.match(limit.body.error, /32/);
    const existingAtLimit = await f.send('/api/providers', { method: 'POST', data: { name: 'Updated at limit', base: mock.base, api_style: 'openai' } });
    assert.equal(existingAtLimit.status, 200);
    assert.equal(existingAtLimit.body.providers.filter((provider: any) => provider.kind === 'custom').length, 32);
    assert.equal(existingAtLimit.body.providers.find((provider: any) => provider.name === 'Updated at limit').id, original.id);
  } finally { await f.cleanup(); await mock.cleanup(); }
});

test('invalid provider batches and failed config saves leave providers and appearance unchanged', async () => {
  const mock = await mockProvider(), f = await fixture();
  try {
    const created = await f.send('/api/providers', { method: 'POST', data: { name: 'Keep this name', base: mock.base, token: 'keep-this-secret', api_style: 'openai' } });
    const provider = created.body.providers.find((item: any) => item.kind === 'custom');
    const before = structuredClone(f.app.storage.config);
    const invalid = await f.send(`/api/providers/${provider.id}`, { method: 'PATCH', data: { name: 'Discard this name', token: 'discard-this-secret', api_style: 'invalid-style' } });
    assert.equal(invalid.status, 400); assert.deepEqual(f.app.storage.config, before);
    const save = f.app.storage.saveConfig;
    f.app.storage.saveConfig = async () => { throw new Error('Simulated configuration commit failure'); };
    try {
      const failedProvider = await f.send(`/api/providers/${provider.id}`, { method: 'PATCH', data: { name: 'Uncommitted provider', token: 'uncommitted-secret' } });
      assert.equal(failedProvider.status, 400); assert.deepEqual(f.app.storage.config, before);
      const failedAppearance = await f.send('/api/ui/appearance', { method: 'POST', data: { theme: 'light', font_body: 'literata' } });
      assert.equal(failedAppearance.status, 400); assert.deepEqual(f.app.storage.config, before);
    } finally { f.app.storage.saveConfig = save; }
    const disk = await readFile(join(f.directory, 'config.toml'), 'utf8');
    assert.ok(disk.includes('keep-this-secret')); assert.equal(disk.includes('discard-this-secret'), false); assert.equal(disk.includes('uncommitted-secret'), false);
    await f.restart(); assert.equal(f.app.storage.config.providers.find(item => item.id === provider.id)?.name, 'Keep this name');
  } finally { await f.cleanup(); await mock.cleanup(); }
});

test('state polling stays unlocked throughout a live encryption transaction while data reads wait for commit', async () => {
  const f = await fixture();
  const internal = f.app.storage as unknown as { encodeFile: (name: string, ...args: any[]) => Promise<void> };
  const encode = internal.encodeFile;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reachedWrite = new Promise<void>(resolve => { entered = resolve; });
  let hold = true;
  internal.encodeFile = async function (name, ...args) { if (name === 'chats.json' && hold) { hold = false; entered(); await blocked; } return encode.call(f.app.storage, name, ...args); };
  try {
    await f.send('/api/data/preferences', { method: 'PUT', data: { diagnosticsEnabled: true } });
    f.app.storage.diagnostics.push('browser', { event: 'retain-across-live-enable' });
    const generation = f.app.storage.diagnostics.generation;
    const enabling = f.send('/api/data/encryption/enable', { method: 'POST', data: { passphrase: 'password', passphrase_confirm: 'password' } });
    await reachedWrite;
    const state = await f.send('/api/state');
    assert.equal(state.body.encryption_enabled, true); assert.equal(state.body.encryption_unlocked, true);
    const info = await f.send('/api/data'); assert.equal(info.body.encryption_transition_pending, true); assert.equal(info.body.encryption_unlocked, true);
    let readFinished = false;
    const data = f.send('/api/data/store').then(result => { readFinished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(readFinished, false);
    release(); assert.equal((await enabling).status, 200); assert.equal((await data).status, 200);
    assert.equal(f.app.storage.diagnostics.generation, generation);
    assert.ok(f.app.storage.diagnostics.view().entries.some(entry => entry.event === 'retain-across-live-enable'));
  } finally { release(); internal.encodeFile = encode; await f.cleanup(); }
});

test('failed enable writes lock the live session and the authenticated journal recovers it', async () => {
  const f = await fixture();
  const internal = f.app.storage as unknown as { encodeFile: (name: string, ...args: any[]) => Promise<void> };
  const encode = internal.encodeFile;
  let release!: () => void, entered!: () => void;
  let recoveryRelease = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reachedWrite = new Promise<void>(resolve => { entered = resolve; });
  internal.encodeFile = async function (name, ...args) { if (name === 'preferences.json') { entered(); await blocked; throw new Error('Simulated transition commit failure'); } return encode.call(f.app.storage, name, ...args); };
  try {
    await f.send('/api/data/store', { method: 'PUT', data: [{ id: 'recover-this-chat' }] });
    const enabling = f.send('/api/data/encryption/enable', { method: 'POST', data: { passphrase: 'password', passphrase_confirm: 'password' } });
    await reachedWrite;
    assert.equal((await f.send('/api/state')).body.encryption_unlocked, true);
    release(); assert.equal((await enabling).status, 400);
    const failed = await f.send('/api/state'); assert.equal(failed.body.encryption_enabled, true); assert.equal(failed.body.encryption_unlocked, false);
    assert.equal((await f.send('/api/data/store')).status, 423);
    let recoveryEntered!: () => void;
    const recoveryBlocked = new Promise<void>(resolve => { recoveryRelease = resolve; });
    const recoveryWrite = new Promise<void>(resolve => { recoveryEntered = resolve; });
    internal.encodeFile = async function (name, ...args) { if (name === 'chats.json') { recoveryEntered(); await recoveryBlocked; } return encode.call(f.app.storage, name, ...args); };
    const recovering = f.send('/api/data/encryption/unlock', { method: 'POST', data: { passphrase: 'password' } });
    await recoveryWrite;
    const recoveringState = (await f.send('/api/state')).body;
    assert.equal(recoveringState.encryption_enabled, true); assert.equal(recoveringState.encryption_unlocked, false);
    assert.equal((await f.send('/api/data/store')).status, 423);
    recoveryRelease(); assert.equal((await recovering).status, 200);
    internal.encodeFile = encode;
    assert.equal((await f.send('/api/data/store')).body.conversations[0].id, 'recover-this-chat');
    assert.equal((await f.send('/api/data')).body.encryption_transition_pending, false);
  } finally { release(); recoveryRelease(); internal.encodeFile = encode; await f.cleanup(); }
});

test('state polling remains authenticated until a live disable transaction commits', async () => {
  const f = await fixture();
  const internal = f.app.storage as unknown as { encodeFile: (name: string, ...args: any[]) => Promise<void> };
  const encode = internal.encodeFile;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reachedWrite = new Promise<void>(resolve => { entered = resolve; });
  try {
    await f.send('/api/data/store', { method: 'PUT', data: [{ id: 'disable-retains-data' }] });
    await f.send('/api/data/encryption/enable', { method: 'POST', data: { passphrase: 'password', passphrase_confirm: 'password' } });
    internal.encodeFile = async function (name, ...args) { if (name === 'preferences.json') { entered(); await blocked; } return encode.call(f.app.storage, name, ...args); };
    const disabling = f.send('/api/data/encryption/disable', { method: 'POST', data: { passphrase: 'password' } });
    await reachedWrite;
    const during = (await f.send('/api/state')).body;
    assert.equal(during.encryption_enabled, true); assert.equal(during.encryption_unlocked, true);
    release(); assert.equal((await disabling).status, 200);
    const after = (await f.send('/api/state')).body;
    assert.equal(after.encryption_enabled, false);
    assert.equal((await f.send('/api/data/store')).body.conversations[0].id, 'disable-retains-data');
  } finally { release(); internal.encodeFile = encode; await f.cleanup(); }
});
