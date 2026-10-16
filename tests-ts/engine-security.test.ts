import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { LookupFunction } from 'node:net';
import type { Agent } from 'undici';
import { once } from 'node:events';
import { Engine } from '../server/engine.js';
import type { Providers, ProviderEvent } from '../server/providers.js';
import { RegexMatcher } from '../server/tools/regex.js';
import { BrowserManager, findBrowserExecutable } from '../server/tools/browser.js';
import { Workspace, applyPatch, executeFilesystem } from '../server/tools/filesystem.js';
import { createPublicFetch, privateAddress, assertPublicUrl } from '../server/tools/web.js';

async function temporary<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'gopher-engine-security-'));
  try { return await fn(directory); } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

test('grep isolates catastrophic regex work and leaves the main event loop responsive', { timeout: 5000 }, async () => temporary(async directory => {
  const ws = await Workspace.open(directory);
  await fs.writeFile(path.join(directory, 'input.txt'), 'a'.repeat(100));
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 30);
  const pending = executeFilesystem(ws, 'grep', { query: 'a+a+a+a+a+a+a+a+b' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(heartbeat, true, 'HTTP, cancellation and lock timers must remain responsive during regex execution');
  await assert.rejects(pending, /execution time limit/);
  clearTimeout(timer);
  await fs.writeFile(path.join(directory, 'input.txt'), 'prefix word word\nprefix one two\n');
  const result = JSON.parse(await executeFilesystem(ws, 'grep', { query: '(?<=prefix )([a-z]+)\\s+\\1' }));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].line, 1, 'Worker isolation must preserve backreferences and lookbehind');
}));

test('regex worker failures before first match and cancellation settle every pending request', { timeout: 5000 }, async () => {
  const dead = new RegexMatcher('a', false, 'content');
  const worker = (dead as any).worker;
  const exited = once(worker, 'exit');
  await worker.terminate(); await exited;
  await assert.rejects(dead.match(['a'], 1), /worker exited/);
  await dead.close();
  const matcher = new RegexMatcher('a+a+a+a+a+a+a+a+b', false, 'content');
  const signal = new AbortController();
  const first = assert.rejects(matcher.match(['a'.repeat(100)], 1, signal.signal), /cancelled/);
  const second = assert.rejects(matcher.match(['a'], 1), /cancelled/);
  signal.abort(new Error('Regex cancelled'));
  await Promise.all([first, second, matcher.close()]);
  await assert.rejects(matcher.match(['a'], 1), /cancelled/);
});

test('cancelled queued filesystem mutations never run after the workspace lock is released', async () => temporary(async directory => {
  const ws = await Workspace.open(directory);
  await fs.writeFile(path.join(directory, 'existing.txt'), 'keep');
  for (const [name, args] of [
    ['write_file', { path: 'new.txt', content: 'after stop' }],
    ['str_replace', { path: 'existing.txt', old_string: 'keep', new_string: 'changed' }],
    ['delete_file', { path: 'existing.txt' }],
    ['apply_patch', { patch: '*** Begin Patch\n*** Update File: existing.txt\n@@\n-keep\n+changed\n*** End Patch' }],
  ] as const) {
    let release!: () => void;
    const held = ws.transaction(() => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const controller = new AbortController();
    const pending = assert.rejects(executeFilesystem(ws, name, args, controller.signal), /Stopped/);
    controller.abort(new Error('Stopped'));
    await pending; release(); await held;
    // A following transaction proves all previously queued callbacks have drained.
    await ws.transaction(async () => {});
    assert.equal(await fs.readFile(path.join(directory, 'existing.txt'), 'utf8'), 'keep');
    await assert.rejects(fs.access(path.join(directory, 'new.txt')));
  }
}));

test('engine Stop cancels the real default filesystem executor while it waits for a workspace transaction', { timeout: 5000 }, async () => temporary(async directory => {
  const ws = await Workspace.open(directory);
  let release!: () => void;
  const held = ws.transaction(() => new Promise<void>(resolve => { release = resolve; }));
  let executing!: () => void;
  const started = new Promise<void>(resolve => { executing = resolve; });
  const provider = { id: 'fixture', name: 'Fixture', base: 'http://localhost/v1', token: '', api_style: 'openai', kind: 'custom', allow_insecure_tls: false };
  const providers = { get: () => provider, catalog: async () => [], complete: async function* (): AsyncIterable<ProviderEvent> { yield { type: 'tool', index: 0, id: 'call', name: 'write_file', arguments: '{"path":"after-stop.txt","content":"must not be written"}' }; } } as unknown as Providers;
  const engine = new Engine({ providers });
  let frames = '';
  const consume = (async () => { for await (const frame of engine.start({ model: 'model', conversation_id: 'cancel-fixture', agent: true, skills: { filesystem: true, workspace_root: directory, approval_mode: 'auto_safe' }, messages: [{ role: 'user', content: 'Write' }] })) {
    frames += frame;
    if (!frame.startsWith('event: agent')) continue;
    const event = JSON.parse(frame.split('data: ')[1]);
    if (event.phase === 'tool_approval') engine.approve(event.id, true);
    if (event.phase === 'tool_executing') executing();
  } })();
  try {
    await started;
    await new Promise(resolve => setTimeout(resolve, 30));
    await engine.cancel('cancel-fixture');
    release(); await held; await ws.transaction(async () => {}); await consume;
    await assert.rejects(fs.access(path.join(directory, 'after-stop.txt')));
    assert.match(frames, /\[DONE\]/);
  } finally { release(); await held; await engine.cancelAll(); }
}));

test('patch cancellation between file commits waits for rollback before settling', async () => temporary(async directory => {
  const ws = await Workspace.open(directory);
  await fs.writeFile(path.join(directory, 'one.txt'), 'one\n');
  await fs.writeFile(path.join(directory, 'two.txt'), 'two\n');
  const controller = new AbortController();
  const resolve = ws.resolve.bind(ws);
  ws.resolve = async raw => {
    const file = await resolve(raw);
    if (raw === path.join(ws.root, 'two.txt')) {
      assert.equal(await fs.readFile(path.join(directory, 'one.txt'), 'utf8'), 'changed\n');
      controller.abort(new Error('Stopped between commits'));
    }
    return file;
  };
  await assert.rejects(applyPatch(ws, '*** Begin Patch\n*** Update File: one.txt\n@@\n-one\n+changed\n*** Update File: two.txt\n@@\n-two\n+changed\n*** End Patch', controller.signal), /Stopped between commits/);
  assert.equal(await fs.readFile(path.join(directory, 'one.txt'), 'utf8'), 'one\n');
  assert.equal(await fs.readFile(path.join(directory, 'two.txt'), 'utf8'), 'two\n');
}));

test('browser cancellation prevents queued form mutations and interrupts active browser waits', { timeout: 60_000 }, async context => {
  if (!await findBrowserExecutable()) { context.skip('No supported Chromium browser installed'); return; }
  const browser = new BrowserManager();
  try {
    await browser.execute('cancellation', '', 'browser_evaluate', { expression: 'document.body.innerHTML = \'<input aria-label="Name">\'' });
    const snapshot = JSON.parse((await browser.execute('cancellation', '', 'browser_snapshot', {})).text);
    const first = browser.execute('cancellation', '', 'browser_wait', { time_ms: 150 });
    const controller = new AbortController();
    const queued = browser.execute('cancellation', '', 'browser_type', { ref: snapshot.elements[0].ref, text: 'after Stop' }, controller.signal);
    const rejected = assert.rejects(queued, /Stopped/);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('Stopped'));
    await rejected; await first;
    const value = JSON.parse((await browser.execute('cancellation', '', 'browser_evaluate', { expression: 'document.querySelector("input").value' })).text);
    assert.equal(value.result, '');
    const active = new AbortController();
    const wait = assert.rejects(browser.execute('cancellation', '', 'browser_wait', { time_ms: 30_000 }, active.signal), /Stopped/);
    await new Promise(resolve => setTimeout(resolve, 30)); active.abort(new Error('Stopped'));
    await wait;
    const fresh = JSON.parse((await browser.execute('cancellation', '', 'browser_snapshot', {})).text);
    assert.equal(fresh.url, 'about:blank');
  } finally { await browser.closeAll(); }
});

test('patch rejects substring and ambiguous context without changing any prepared target', async () => temporary(async directory => {
  const ws = await Workspace.open(directory);
  await fs.writeFile(path.join(directory, 'one.txt'), 'first\n');
  await fs.writeFile(path.join(directory, 'two.txt'), 'database\nkeep\n');
  await assert.rejects(applyPatch(ws, '*** Begin Patch\n*** Update File: one.txt\n@@\n-first\n+changed\n*** Update File: two.txt\n@@\n-base\n+replacement\n*** End Patch'), /complete lines/);
  assert.equal(await fs.readFile(path.join(directory, 'one.txt'), 'utf8'), 'first\n');
  assert.equal(await fs.readFile(path.join(directory, 'two.txt'), 'utf8'), 'database\nkeep\n');
  await fs.writeFile(path.join(directory, 'two.txt'), 'same\nother\nsame\n');
  await assert.rejects(applyPatch(ws, '*** Begin Patch\n*** Update File: two.txt\n@@\n-same\n+changed\n*** End Patch'), /ambiguous/);
  assert.equal(await fs.readFile(path.join(directory, 'two.txt'), 'utf8'), 'same\nother\nsame\n');
}));

test('patch deletes complete lines and preserves mixed CRLF and trailing newline state', async () => temporary(async directory => {
  const ws = await Workspace.open(directory);
  await fs.writeFile(path.join(directory, 'file.txt'), 'alpha\nbeta\ngamma\n');
  await applyPatch(ws, '*** Begin Patch\n*** Update File: file.txt\n@@\n-beta\n*** End Patch');
  assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'alpha\ngamma\n');
  await fs.writeFile(path.join(directory, 'file.txt'), 'alpha\r\nbeta\r\ngamma\nlast');
  await applyPatch(ws, '*** Begin Patch\n*** Update File: file.txt\n@@\n-beta\n+replacement\n*** End Patch');
  assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'alpha\r\nreplacement\r\ngamma\nlast');
  await applyPatch(ws, '*** Begin Patch\n*** Update File: file.txt\n@@ -4,1 +4,1 @@\n-last\n+final\n*** End Patch');
  assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'alpha\r\nreplacement\r\ngamma\nfinal');
  await assert.rejects(applyPatch(ws, '*** Begin Patch\n*** Update File: file.txt\n@@ -99,1 +99,1 @@\n-final\n+wrong\n*** End Patch'), /offset/);
  await assert.rejects(applyPatch(ws, '*** Begin Patch\n*** Update File: file.txt\n@@\n-alpha\n+wrong\n*** End of File\n*** End Patch'), /complete lines/);
  assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'alpha\r\nreplacement\r\ngamma\nfinal');
}));

function connectAddress(lookup: LookupFunction, hostname: string): Promise<string> {
  return new Promise((resolve, reject) => lookup(hostname, { all: true }, (error, addresses) => {
    if (error) { reject(error); return; }
    resolve(typeof addresses === 'string' ? addresses : addresses[0].address);
  }));
}

test('public fetch pins validated DNS addresses instead of performing a second DNS lookup', async () => {
  let resolutions = 0, closes = 0;
  let transportLookup: LookupFunction | undefined;
  const request = createPublicFetch({
    resolve: async hostname => { assert.equal(hostname, 'rebind.example'); return [{ address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]; },
    agent: lookup => { transportLookup = lookup; return { close: async () => { closes++; } } as Agent; },
    request: async (input, init) => {
      assert.equal(String(input), 'https://rebind.example/article');
      assert.ok((init as RequestInit & { dispatcher: unknown }).dispatcher);
      assert.equal(await connectAddress(transportLookup!, 'rebind.example'), '93.184.216.34');
      assert.equal(await connectAddress(transportLookup!, 'rebind.example'), '93.184.216.34');
      await assert.rejects(connectAddress(transportLookup!, 'different.example'), /hostname/);
      return new Response('public response', { headers: { 'content-type': 'text/plain' } });
    },
  });
  assert.equal(await (await request('https://rebind.example/article', new AbortController().signal)).text(), 'public response');
  assert.equal(resolutions, 1);
  assert.equal(closes, 1);
});

test('public fetch rejects any private DNS answer and revalidates every redirect hop', async () => {
  let requests = 0;
  const request = createPublicFetch({
    resolve: async hostname => hostname === 'public.example' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:7f00:1', family: 6 }],
    agent: () => ({ close: async () => {} }) as unknown as Agent,
    request: async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://mixed.example/private' } }); },
  });
  await assert.rejects(request('https://public.example/start', new AbortController().signal), /private/);
  assert.equal(requests, 1, 'The redirected private destination must never reach the transport');
  await assert.rejects(request('https://mixed.example/start', new AbortController().signal), /private/);
  assert.equal(requests, 1);
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.1.2', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']) assert.equal(privateAddress(address), true, address);
  assert.equal(privateAddress('2606:4700:4700::1111'), false);
  assert.equal(privateAddress('93.184.216.34'), false);
  await assert.rejects(assertPublicUrl('http://[::ffff:127.0.0.1]/', false), /Private/);
});
