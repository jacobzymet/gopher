import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Agent } from 'undici';
import { WebSocket } from 'ws';
import { createApp } from '../server/http/app.js';
import { MAX_TERMINAL_MESSAGE_BYTES } from '../server/terminal.js';
import { browsers, findBrowserExecutable } from '../server/tools/browser.js';
import { createPublicFetch, privateAddress } from '../server/tools/public-fetch.js';
import { beginCodexLogin } from '../server/subscription.js';

test('public fetch blocks IPv6 translation, tunnelling and special-purpose targets before transport', async () => {
  const blocked = ['::', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '64:ff9b::7f00:1',
    '64:ff9b:1::a00:1', '100::1', '100:0:0:1::1', '2001::1', '2001:2::1', '2001:db8::1',
    '2002:7f00:1::1', '3fff::1', '3fff:fff:ffff::1', '5f00::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1'];
  const publicHosts = ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:93.184.216.34', '93.184.216.34'];
  for (const address of publicHosts) assert.equal(privateAddress(address), false, address);
  let requests = 0;
  for (const address of blocked) {
    assert.equal(privateAddress(address), true, address);
    const fetcher = createPublicFetch({
      resolve: async () => [{ address, family: 6 }],
      agent: () => ({ close: async () => {} }) as unknown as Agent,
      request: async () => { requests++; return new Response('must never reach here'); },
    });
    await assert.rejects(fetcher('https://untrusted.example/', AbortSignal.timeout(1000)), /private/);
  }
  assert.equal(requests, 0);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-security-boundaries-'));
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'chat.html'), '<!doctype html><title>Gopher</title>');
  const app = await createApp({ configPath: join(directory, 'config.toml'), publicDir, bind: '127.0.0.1:0' });
  await app.listen();
  const port = (app.server.address() as AddressInfo).port;
  return { app, directory, port, origin: `http://127.0.0.1:${port}`,
    close: async () => { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } };
}

test('terminal WebSockets reject oversized frames before delivering them to the terminal', { timeout: 30_000 }, async () => {
  const f = await fixture();
  const has = f.app.terminals.has, attach = f.app.terminals.attach;
  let delivered = 0;
  f.app.terminals.has = id => id === 'fixture';
  f.app.terminals.attach = (_id, ws) => {
    ws.on('error', () => {});
    ws.on('message', () => { delivered++; });
    return true;
  };
  let socket: WebSocket | undefined;
  try {
    const bootstrap = await fetch(f.origin);
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    socket = new WebSocket(`ws://127.0.0.1:${f.port}/api/terminal/ws/fixture`, { headers: { cookie } });
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send(Buffer.alloc(MAX_TERMINAL_MESSAGE_BYTES + 1));
    assert.equal((await closed)[0], 1009);
    assert.equal(delivered, 0);
  } finally {
    socket?.terminate();
    f.app.terminals.has = has; f.app.terminals.attach = attach;
    await f.close();
  }
});

test('agent browser cannot bootstrap Gopher through navigation, fetch, frames, popups or redirects', { timeout: 60_000 }, async context => {
  if (!await findBrowserExecutable()) { context.skip('No supported Chromium browser installed'); return; }
  const f = await fixture();
  const appResponses: { status: number; cookie: unknown }[] = [];
  f.app.server.on('request', (_request, response) => {
    response.on('finish', () => appResponses.push({ status: response.statusCode, cookie: response.getHeader('set-cookie') }));
  });
  const dev = createServer((req, res) => {
    if (req.url === '/redirect') res.writeHead(302, { location: f.origin });
    else res.setHeader('content-type', 'text/html');
    res.end('<title>Development site</title>');
  });
  dev.listen(0, '127.0.0.1'); await once(dev, 'listening');
  const devOrigin = `http://127.0.0.1:${(dev.address() as AddressInfo).port}`;
  try {
    await assert.rejects(browsers.execute('security', '', 'browser_navigate', { url: f.origin }), /cannot access Gopher/);
    await browsers.execute('security', '', 'browser_navigate', { url: devOrigin });
    const origins = [f.origin, `http://localhost:${f.port}`, `http://gopher.localhost:${f.port}`];
    const result = await browsers.execute('security', '', 'browser_evaluate', {
      expression: `Promise.all(${JSON.stringify(origins)}.map(url => fetch(url, {mode:'no-cors'}).then(() => 'allowed', () => 'blocked')))`,
    });
    assert.deepEqual(JSON.parse(result.text).result, ['blocked', 'blocked', 'blocked']);
    await browsers.execute('security', '', 'browser_evaluate', {
      expression: `(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(f.origin)}; document.body.append(frame); window.open(${JSON.stringify(f.origin)}); })()`,
    });
    await browsers.execute('security', '', 'browser_wait', { time_ms: 250 });
    assert.equal(appResponses.length, 0, 'Direct navigation, subresources and popups must be blocked before transport');
    const redirected = await browsers.execute('security', '', 'browser_navigate', { url: `${devOrigin}/redirect` });
    assert.match(JSON.parse(redirected.text).text, /cannot access Gopher/);
    assert.ok(appResponses.length > 0, 'Exercise the redirect that bypasses Playwright routing');
    assert.ok(appResponses.every(response => response.status === 403 && response.cookie === undefined),
      'Redirected requests must never bootstrap a session or reach authenticated endpoints');
    const sessions = (browsers as any).sessions;
    const session = await sessions.get('security');
    await session.page.goto('chrome://version/');
    const commandLine = await session.page.locator('#command_line').innerText();
    assert.ok(!commandLine.includes('--no-sandbox'), 'Untrusted pages must run with Chromium sandboxing enabled');
  } finally {
    dev.closeAllConnections(); await new Promise<void>(resolve => dev.close(() => resolve()));
    await f.close();
  }
});

test('malformed OAuth callback URLs are refused without stopping the callback server', { timeout: 10_000 }, async () => {
  const login = await beginCodexLogin();
  const rejected = assert.rejects(login.result, /cancelled/);
  const send = (path: string) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 1455, path }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await send('http://['), 400);
    assert.equal(await send('/auth/callback?state=wrong'), 400);
  } finally { login.cancel(); await rejected; }
});
