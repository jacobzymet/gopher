import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';

/** Characterization of routing, methods, limits and headers, so refactors keep the same contract. */

interface Reply { status: number; headers: IncomingHttpHeaders; text: string; body: any }
interface SendOptions { method?: string; raw?: string; data?: unknown; headers?: Record<string, string>; authenticated?: boolean; fresh?: boolean }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-routes-'));
  const publicDir = join(directory, 'public');
  await mkdir(join(publicDir, 'vendor', 'katex', 'fonts'), { recursive: true });
  await writeFile(join(publicDir, 'chat.html'), '<!doctype html><title>Gopher fixture</title>');
  await writeFile(join(publicDir, 'chat.js'), 'console.log(1)');
  await writeFile(join(publicDir, 'vendor', 'marked.min.js'), '/* marked */');
  await writeFile(join(publicDir, 'vendor', 'katex', 'fonts', 'KaTeX_Main-Regular.woff2'), 'font');
  await writeFile(join(directory, 'secret.txt'), 'outside');
  const app = await createApp({ configPath: join(directory, 'config.toml'), bind: '127.0.0.1:0', publicDir });
  await app.listen();
  const port = (app.server.address() as { port: number }).port;
  let cookie = '';
  const send = (path: string, options: SendOptions = {}): Promise<Reply> => new Promise((resolve, reject) => {
    const payload = options.raw ?? (options.data === undefined ? undefined : JSON.stringify(options.data));
    const headers: Record<string, string> = { ...(cookie && options.authenticated !== false ? { cookie } : {}), ...options.headers };
    if (payload !== undefined) { headers['content-type'] ??= 'application/json'; headers['content-length'] ??= String(Buffer.byteLength(payload)); }
    const req = request({ host: '127.0.0.1', port, path, method: options.method || 'GET', headers, ...(options.fresh ? { agent: false } : {}) }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let body: any; try { body = JSON.parse(text); } catch { body = null; }
        resolve({ status: response.statusCode || 0, headers: response.headers, text, body });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const bootstrap = await send('/', { authenticated: false });
  cookie = (bootstrap.headers['set-cookie']?.[0] || '').split(';')[0]!;
  return { send, bootstrap, port, cleanup: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('pages, redirects, assets and security headers keep their contract', async () => {
  const f = await fixture();
  try {
    const page = f.bootstrap;
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'.*script-src 'self' 'wasm-unsafe-eval'/);
    for (const path of ['/notifications', '/projects', '/ghost', '/loops', '/loops/c/x', '/bots', '/bots/c/x', '/c/abc', '/p/abc', '/p/abc/ghost']) {
      assert.equal((await f.send(path)).status, 200, path);
    }
    assert.equal((await f.send('/settings')).headers.location, '/?settings=providers');
    assert.equal((await f.send('/admin')).status, 307);
    assert.equal((await f.send('/chat')).headers.location, '/');
    assert.equal((await f.send('/unknown-page')).status, 404);
    assert.equal((await f.send('/c/a/b')).status, 404);
    assert.equal((await f.send('/', { method: 'POST' })).status, 405);
    const head = await f.send('/', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.text, '');
    assert.equal((await f.send('/chat.js')).headers['content-type'], 'application/javascript; charset=utf-8');
    assert.equal((await f.send('/marked.min.js')).text, '/* marked */');
    assert.equal((await f.send('/katex/fonts/KaTeX_Main-Regular.woff2')).headers['content-type'], 'font/woff2');
    for (const path of ['/katex/fonts/../../../secret.txt', '/katex/fonts/%2e%2e/%2e%2e/%2e%2e/secret.txt', '/ocr/..%5c..%5csecret.txt']) {
      const result = await f.send(path);
      assert.ok([400, 404].includes(result.status), `${path} returned ${result.status}`);
      assert.doesNotMatch(result.text, /outside/);
    }
    assert.equal((await f.send('/api%2fstate')).status, 400);
  } finally { await f.cleanup(); }
});

test('API routing, bodies and methods keep their status codes and messages', async () => {
  const f = await fixture();
  try {
    const state = await f.send('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.headers['cache-control'], 'no-store');
    assert.equal(state.headers['content-type'], 'application/json; charset=utf-8');
    const missing = await f.send('/api/nothing-here');
    assert.equal(missing.status, 404); assert.equal(missing.body.error, 'API endpoint not found.');
    assert.equal((await f.send('/api/state', { method: 'DELETE' })).status, 404);
    const invalid = await f.send('/api/data/preferences', { method: 'PUT', raw: '{not json' });
    assert.equal(invalid.status, 400); assert.equal(invalid.body.error, 'Request body must contain valid JSON.');
    const big = await f.send('/api/chat/title', { method: 'POST', raw: 'x', headers: { 'content-length': String(17 * 1024 * 1024) }, fresh: true });
    assert.equal(big.status, 413);
    const encryption = await f.send('/api/data/encryption/rotate', { method: 'POST', data: {} });
    assert.equal(encryption.status, 404); assert.equal(encryption.body.error, 'Unknown encryption operation.');
    const subscription = await f.send('/api/subscription/other', { method: 'POST', data: {} });
    assert.equal(subscription.status, 404);
    const providers = (await f.send('/api/providers')).body.providers as Array<{ id: string; kind: string }>;
    const builtin = providers.find(provider => provider.kind === 'openai-codex')!;
    const patch = await f.send(`/api/providers/${builtin.id}`, { method: 'PATCH', data: { name: 'x' } });
    assert.equal(patch.status, 405); assert.equal(patch.body.error, 'Method not allowed.');
    assert.equal((await f.send('/api/providers/missing-id', { method: 'DELETE' })).status, 404);
    const style = await f.send('/api/providers', { method: 'POST', data: { base: 'http://127.0.0.1:9/v1', api_style: 'grpc' } });
    assert.equal(style.status, 400); assert.equal(style.body.error, 'Invalid provider API style.');
    const theme = await f.send('/api/ui/appearance', { method: 'POST', data: { theme: 'neon' } });
    assert.equal(theme.status, 400); assert.equal(theme.body.error, 'Invalid theme.');
    const live = await f.send('/api/chat/live/bad%20id');
    assert.equal(live.status, 400); assert.equal(live.body.error, 'Invalid live turn identifier.');
    assert.equal((await f.send('/api/chat/live/nothing')).status, 404);
    const title = await f.send('/api/chat/title', { method: 'POST', data: { message: ' ' } });
    assert.equal(title.status, 400); assert.equal(title.body.error, 'Title generation requires a message, model and provider.');
    const diagnostics = await f.send('/api/diagnostics', { method: 'POST', data: { entries: 'x' } });
    assert.equal(diagnostics.status, 400);
    assert.equal((await f.send('/api/chat/approve', { method: 'POST', data: { id: 'nope', allow: true } })).body.expired, true);
    const cancel = await f.send('/api/chat/cancel', { method: 'POST', data: { conversation_id: 'idle' } });
    assert.deepEqual(cancel.body, { ok: true, cancelled: false, settled: true });
  } finally { await f.cleanup(); }
});
