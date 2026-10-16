import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from '../server/terminal.js';
import { Workspace } from '../server/tools/filesystem.js';

const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const quote = (value: string) => process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'\\''`)}'`;
const nodeCommand = (path: string) => `${process.platform === 'win32' ? '&' : 'exec'} ${quote(process.execPath)} ${quote(path)}`;
async function eventually(check: () => Promise<boolean>, message: string, limit = 5000): Promise<void> {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  assert.fail(message);
}
async function active(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (/^\s*[ZX]\s/.test(status.slice(status.lastIndexOf(')') + 1))) return false;
    }
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || '')) return false; throw error; }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-terminal-lifecycle-'));
  const manager = new TerminalManager(); const pids = new Set<number>();
  return { directory, manager, pids, cleanup: async () => {
    try { await manager.closeAll(); }
    finally { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } await rm(directory, { recursive: true, force: true }); }
  } };
}
async function processTree(f: Awaited<ReturnType<typeof fixture>>, owner = 'owner', signal?: AbortSignal) {
  const pidPath = join(f.directory, `${owner}.json`), readyPath = join(f.directory, `${owner}.ready`);
  const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(readyPath)},'ready');setInterval(()=>{},1000);`;
  const source = `process.on('SIGTERM',()=>{});const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  const script = join(f.directory, `${owner}.cjs`); await writeFile(script, source);
  const result = await f.manager.command(f.directory, owner, { command: nodeCommand(script), yield_time_ms: 0 }, 30, signal);
  let ids: number[] = [];
  await eventually(async () => { try { ids = JSON.parse(await readFile(pidPath, 'utf8')); await readFile(readyPath); return true; } catch { return false; } }, 'Native command tree did not start');
  ids.forEach(pid => f.pids.add(pid));
  return { result, ids };
}

test('terminating a native command waits until its process tree stops', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const { result, ids } = await processTree(f);
    const ended = await f.manager.wait('owner', { session_id: result.session_id, terminate: true, yield_time_ms: 0 });
    assert.equal(ended.running, false);
    await eventually(async () => !(await Promise.all(ids.map(active))).some(Boolean), 'Terminate left a command descendant running');
  } finally { await f.cleanup(); }
});

test('Unix shutdown escalates beyond SIGTERM and retains command tracking until cleanup settles', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const { result, ids } = await processTree(f);
    const closing = f.manager.closeAll();
    assert.equal((await f.manager.wait('owner', { session_id: result.session_id, yield_time_ms: 0 })).running, true);
    await closing;
    await eventually(async () => !(await Promise.all(ids.map(active))).some(Boolean), 'Shutdown left a SIGTERM-ignoring process running');
    await assert.rejects(f.manager.wait('owner', { session_id: result.session_id }), /not found/);
  } finally { await f.cleanup(); }
});

test('conversation cancellation stops only its owned native command tree', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const stopped = await processTree(f, 'stopped'), retained = await processTree(f, 'retained');
    await f.manager.closeOwner('stopped');
    await eventually(async () => !(await Promise.all(stopped.ids.map(active))).some(Boolean), 'Conversation cancellation left descendants running');
    assert.ok((await Promise.all(retained.ids.map(active))).every(Boolean));
    await f.manager.closeAll();
    await eventually(async () => !(await Promise.all(retained.ids.map(active))).some(Boolean), 'Shutdown left the second conversation running');
  } finally { await f.cleanup(); }
});

test('aborting a running command terminates its native process tree without a later poll', { timeout: 15000 }, async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    const { result, ids } = await processTree(f, 'owner', controller.signal);
    controller.abort(new Error('turn stopped'));
    await eventually(async () => !(await Promise.all(ids.map(active))).some(Boolean), 'Abort left a command tree running');
    const ended = await f.manager.wait('owner', { session_id: result.session_id, yield_time_ms: 1000 });
    assert.equal(ended.running, false);
  } finally { await f.cleanup(); }
});

test('an exited shell finalizes after a bounded drain when a detached descendant holds stdout', { skip: process.platform === 'win32', timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    const pidPath = join(f.directory, 'detached.json');
    const source = `const child=require('node:child_process').spawn(process.execPath,['-e',"process.stdout.write('descendant output\\n');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(child.pid));process.stdout.write('shell completed\\n');process.exit(0);`;
    const script = join(f.directory, 'detached.cjs'); await writeFile(script, source);
    let result = await f.manager.command(f.directory, 'owner', { command: nodeCommand(script), yield_time_ms: 0 });
    await eventually(async () => { try { const pid = Number(await readFile(pidPath, 'utf8')); f.pids.add(pid); return true; } catch { return false; } }, 'Detached pipe holder did not start');
    const started = Date.now(); let output = result.output;
    while (result.running && Date.now() - started < 3500) { result = await f.manager.wait('owner', { session_id: result.session_id, yield_time_ms: 1000 }); output += result.output; }
    assert.equal(result.running, false, 'Shell completion must not wait for descendant pipe closure');
    assert.equal(result.exit_code, 0); assert.match(output, /shell completed/); assert.match(output, /descendant output/);
    assert.ok(Date.now() - started < 3000);
  } finally { await f.cleanup(); }
});

test('an abort during workspace resolution cannot spawn a command after cancellation', { timeout: 10000 }, async () => {
  const f = await fixture(), controller = new AbortController();
  const open = Workspace.open;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  Workspace.open = async (...args: Parameters<typeof Workspace.open>) => { const value = await open.apply(Workspace, args); entered(); await gate; return value; };
  try {
    const command = f.manager.command(f.directory, 'owner', { command: 'echo must-not-start', yield_time_ms: 0 }, 30, controller.signal);
    await reached; controller.abort(new Error('cancelled before spawn')); release();
    await assert.rejects(command, /cancelled before spawn/);
    assert.equal((f.manager as unknown as { commands: Map<string, unknown> }).commands.size, 0);
  } finally { release(); Workspace.open = open; await f.cleanup(); }
});
