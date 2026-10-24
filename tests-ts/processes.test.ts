import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Route } from 'playwright-core';
import { createApp } from '../server/http/app.js';
import { TerminalManager } from '../server/terminal.js';
import { findBrowserExecutable } from '../server/tools/browser.js';
import type { ProviderEvent } from '../server/providers.js';
import { executeTool } from '../server/tools/index.js';

declare const storageReady: boolean;
declare const activeId: string;

const quote = (value: string) => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (path: string) => `${process.platform === 'win32' ? '&' : 'exec'} ${quote(process.execPath)} ${quote(path)}`;
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(30); }
  assert.fail('Process did not reach the expected state');
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-processes-'));
  const app = await createApp({ configPath: join(directory, 'config.toml'), bind: '127.0.0.1:0' });
  await app.listen();
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const bootstrap = await fetch(origin);
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
  await bootstrap.body?.cancel();
  const call = (path: string, method = 'GET', data?: unknown) => fetch(origin + path, {
    method, headers: { cookie, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { directory, app, origin, call,
    cleanup: async () => { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } };
}

test('process inspection retains output across agent polls and freezes completed duration', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-process-output-'));
  const manager = new TerminalManager();
  const release = join(directory, 'release'), script = join(directory, 'process.cjs');
  await writeFile(script, `console.log('FIRST');setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(release)})){console.log('SECOND');process.exit(0)}},20);`);
  try {
    const started = await manager.command(directory, 'owner', { command: nodeCommand(script), yield_time_ms: 0 });
    const id = started.session_id;
    await eventually(() => manager.inspectCommand('owner', id).output!.includes('FIRST'));
    assert.equal(manager.listCommands('owner')[0]!.output, undefined, 'Lists must not download every transcript');
    assert.deepEqual(manager.listCommands('other'), []);
    assert.throws(() => manager.inspectCommand('other', id), /not found/);
    await assert.rejects(manager.stopCommand('other', id), /not found/);
    assert.match((await manager.wait('owner', { session_id: id, yield_time_ms: 0 })).output, /FIRST/);
    assert.match(manager.inspectCommand('owner', id).output!, /FIRST/);
    manager.inspectCommand('owner', id);
    assert.equal((await manager.wait('owner', { session_id: id, yield_time_ms: 0 })).output, '');
    await writeFile(release, 'finish');
    await eventually(() => manager.inspectCommand('owner', id).status === 'completed');
    const snapshot = manager.inspectCommand('owner', id);
    assert.match(snapshot.output!, /FIRST[\s\S]*SECOND/);
    assert.match((await manager.wait('owner', { session_id: id, yield_time_ms: 0 })).output, /SECOND/);
    await delay(35);
    assert.equal(manager.inspectCommand('owner', id).elapsed_ms, snapshot.elapsed_ms);
  } finally { await manager.closeAll(); await rm(directory, { recursive: true, force: true }); }
});

test('process transcripts stay bounded and preserve initial and final output', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-process-bounds-'));
  const manager = new TerminalManager();
  const script = join(directory, 'large.cjs');
  await writeFile(script, "process.stdout.write('FIRST\\n'+'你好'.repeat(100000)+'\\nLAST');");
  try {
    const started = await manager.command(directory, 'owner', { command: nodeCommand(script), yield_time_ms: 0 });
    await eventually(() => !manager.inspectCommand('owner', started.session_id).running);
    const result = manager.inspectCommand('owner', started.session_id);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.output!) <= 256_000);
    assert.match(result.output!, /^FIRST/); assert.match(result.output!, /LAST$/);
    assert.doesNotMatch(result.output!, /�/);
  } finally { await manager.closeAll(); await rm(directory, { recursive: true, force: true }); }
});

test('process HTTP APIs enforce ownership, stop real commands, and revoke access on lock', { timeout: 25_000 }, async () => {
  const f = await fixture();
  const script = join(f.directory, 'running.cjs'); await writeFile(script, "console.log('READY');setInterval(()=>{},1000);");
  try {
    assert.equal((await fetch(f.origin + '/api/processes?conversation_id=owner')).status, 401);
    const started = await f.app.terminals.command(f.directory, 'owner', { command: nodeCommand(script), yield_time_ms: 0 });
    const path = `/api/processes/${started.session_id}`;
    await eventually(() => f.app.terminals.inspectCommand('owner', started.session_id).output!.includes('READY'));
    assert.deepEqual((await (await f.call('/api/processes?conversation_id=other')).json()).processes, []);
    assert.equal((await f.call(path + '?conversation_id=other')).status, 400);
    assert.equal((await f.call(path + '/stop?conversation_id=other', 'POST')).status, 400);
    assert.equal(f.app.terminals.inspectCommand('owner', started.session_id).running, true);
    assert.match((await (await f.call(path + '?conversation_id=owner')).json()).output, /READY/);
    const stopped = await (await f.call(path + '/stop?conversation_id=owner', 'POST')).json();
    assert.equal(stopped.status, 'stopped'); assert.equal(stopped.running, false);
    assert.match(stopped.output, /READY/);
    assert.equal((await f.app.terminals.wait('owner', { session_id: started.session_id, yield_time_ms: 0 })).stopped, true);
    const outcome = await executeTool({ id: 'owner', skills: { terminal: true, workspace_root: f.directory },
      userSkills: [], signal: new AbortController().signal, history: new Map(), clarify: async () => null },
    { id: 'poll-stopped', name: 'wait_terminal', arguments: { session_id: started.session_id, yield_time_ms: 0 } });
    assert.equal(outcome.ok, false); assert.match(outcome.note!, /intentionally stopped/);
    const passphrase = 'isolated process test';
    assert.equal((await f.call('/api/data/encryption/enable', 'POST', { passphrase })).status, 200);
    assert.equal((await f.call('/api/data/encryption/lock', 'POST', {})).status, 200);
    for (const [endpoint, method] of [['/api/processes?conversation_id=owner', 'GET'], [path + '?conversation_id=owner', 'GET'], [path + '/stop?conversation_id=owner', 'POST']]) {
      assert.equal((await f.call(endpoint!, method)).status, 423);
    }
  } finally { await f.cleanup(); }
});

test('agent processes appear live, expand without agent polling, survive reload, stop, and clear on chat switch/lock', { timeout: 60_000 }, async t => {
  const executablePath = await findBrowserExecutable();
  if (!executablePath) { t.skip('No supported Chromium browser installed'); return; }
  const f = await fixture();
  const marker = join(f.directory, 'more'), script = join(f.directory, 'dev-server.cjs');
  await writeFile(script, `console.log('Listening on port 3000');let printed=false;setInterval(()=>{if(!printed&&require('fs').existsSync(${JSON.stringify(marker)})){console.log('Compiled successfully <img src=x onerror=alert(1)>');printed=true}},30);`);
  let round = 0;
  t.mock.method(f.app.providers, 'get', () => ({ id: 'fixture', name: 'Fixture', base: 'http://localhost/v1', token: '', api_style: 'openai', kind: 'custom', allow_insecure_tls: false } as const));
  t.mock.method(f.app.providers, 'catalog', async () => []);
  t.mock.method(f.app.providers, 'complete', async function* (): AsyncIterable<ProviderEvent> {
    if (round++ === 0) yield { type: 'tool', index: 0, id: 'start-server', name: 'run_terminal', arguments: JSON.stringify({ command: nodeCommand(script), yield_time_ms: 0 }) };
    else yield { type: 'text', text: 'Development server started.' };
  });
  await f.app.storage.saveChats({ version: 3, activeProfileId: 'personal', profiles: [{ id: 'personal', projects: [], bots: [], conversations: [
    { id: 'process-chat', title: 'Build the app', workspaceRoot: f.directory, messages: [{ role: 'user', content: 'Start the development server.' }] },
    { id: 'other-chat', title: 'Other chat', messages: [{ role: 'user', content: 'A separate task.' }] },
  ] }] });
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
    await page.goto(f.origin + '/c/process-chat');
    await page.waitForFunction(() => storageReady && activeId === 'process-chat');
    for await (const _frame of f.app.engine.start({ model: 'fixture', conversation_id: 'process-chat', agent: true,
      skills: { terminal: true, workspace_root: f.directory, approval_mode: 'auto_all', chat_retrieval: false },
      messages: [{ role: 'user', content: 'Start the development server.' }] })) { /* Drain the actual agent turn. */ }
    const dock = page.locator('#agentProcesses');
    await dock.waitFor({ state: 'visible' });
    assert.match(await page.locator('#agentProcessesCount').innerText(), /1 running/);
    await dock.locator(':scope > summary').click();
    const row = page.locator('.agent-process').first();
    await row.locator('summary').click();
    await page.waitForFunction(() => document.querySelector('.agent-process-output')?.textContent?.includes('Listening on port 3000'));
    await writeFile(marker, 'print more output');
    await page.waitForFunction(() => document.querySelector('.agent-process-output')?.textContent?.includes('Compiled successfully'));
    assert.equal(round, 2, 'The model must not poll the process to deliver live output');
    assert.equal(await row.locator('.agent-process-output img').count(), 0, 'Output must render as text, never executable markup');
    await mkdir(resolve('output'), { recursive: true });
    await page.screenshot({ path: resolve('output/processes-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve('output/processes-mobile.png'), fullPage: true });
    assert.ok((await dock.boundingBox())!.width <= 390);
    await row.getByRole('button', { name: 'Stop process' }).click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.agent-process')?.dataset.status === 'stopped');
    await page.reload(); await dock.waitFor({ state: 'visible' });
    await dock.locator(':scope > summary').click();
    await page.locator('.agent-process > summary').click();
    await page.waitForFunction(() => document.querySelector('.agent-process-output')?.textContent?.includes('Compiled successfully'));
    let releaseRead!: () => void, markReading!: () => void;
    const held = new Promise<void>(resolve => { releaseRead = resolve; });
    const reading = new Promise<void>(resolve => { markReading = resolve; });
    const processPath = /\/api\/processes\?conversation_id=process-chat(?:$|&)/;
    const staleProcess = { ...f.app.terminals.listCommands('process-chat')[0]!, command: 'PRIVATE_LATE_OUTPUT' };
    const delayedRead = async (route: Route) => {
      markReading(); await held;
      await route.fulfill({ json: { processes: [staleProcess] } }).catch(() => {});
    };
    await page.route(processPath, delayedRead);
    await page.evaluate('syncAgentProcesses()');
    await reading;
    await page.evaluate("selectConversation('other-chat')");
    releaseRead(); await delay(100);
    await page.unroute(processPath, delayedRead);
    assert.equal(await page.locator('#agentProcessesList').textContent(), '');
    assert.ok(!(await page.locator('body').textContent())!.includes('PRIVATE_LATE_OUTPUT'));
    assert.ok(await dock.evaluate(el => el.classList.contains('is-hidden')));
    await page.evaluate("selectConversation('process-chat')");
    await dock.waitFor({ state: 'visible' });
    let releaseLockRead!: () => void, markLockRead!: () => void;
    const heldOnLock = new Promise<void>(resolve => { releaseLockRead = resolve; });
    const readingOnLock = new Promise<void>(resolve => { markLockRead = resolve; });
    await page.route(processPath, async route => {
      markLockRead(); await heldOnLock;
      await route.fulfill({ json: { processes: [staleProcess] } }).catch(() => {});
    });
    await page.evaluate('syncAgentProcesses()'); await readingOnLock;
    await page.evaluate('clearMemoryAfterLock()');
    releaseLockRead(); await delay(100);
    assert.equal(await page.locator('#agentProcessesList').textContent(), '');
    assert.ok(await dock.evaluate(el => el.classList.contains('is-hidden')));
  } finally { await browser.close(); t.mock.restoreAll(); await f.cleanup(); }
});
