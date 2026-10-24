import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from '../server/terminal.js';
import { Workspace } from '../server/tools/filesystem.js';
import { CommandSessions } from '../server/terminal/commands.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test('concurrent commands enforce both per-conversation and global process limits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-command-limit-'));
  try {
    for (const owners of [Array<string>(24).fill('one-chat'), Array.from({ length: 72 }, (_, index) => `chat-${Math.floor(index / 8)}`)]) {
      const sessions = new CommandSessions();
      const children: EventEmitter[] = [];
      t.mock.method(sessions as any, 'spawnCommand', () => {
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
        children.push(child); return child;
      });
      try {
        const outcomes = await Promise.allSettled(owners.map(owner => sessions.command(directory, owner, { command: 'fixture', yield_time_ms: 0 })));
        const expected = owners[0] === 'one-chat' ? 8 : 64;
        assert.equal(children.length, expected);
        assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, expected);
        for (const outcome of outcomes) if (outcome.status === 'rejected') assert.match(outcome.reason.message, /Too many agent commands/);
      } finally {
        for (const child of children) { child.emit('exit', 0); child.emit('close', 0); }
        await Promise.all(sessions.closeAll());
      }
    }
  } finally { t.mock.restoreAll(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent terminal opens cannot exceed the terminal limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-terminal-limit-'));
  const manager = new TerminalManager();
  const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
  let spawns = 0;
  t.mock.method(pty, 'spawn', () => { spawns++; return { onData() {}, onExit() {} }; });
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 24 }, () => manager.open(directory)));
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 16);
    assert.equal(spawns, 16, 'The limit must be checked after asynchronous setup and before native spawn');
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.match(outcome.reason.message, /Close an existing terminal/);
  } finally {
    // These entries are inert stubs; no native process was created to terminate.
    (manager as any).terminals.clear();
    t.mock.restoreAll();
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test('revoking terminals during workspace setup prevents a later native PTY spawn', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-terminal-open-'));
  const manager = new TerminalManager();
  const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
  let spawns = 0;
  t.mock.method(pty, 'spawn', () => { spawns++; throw new Error('A revoked terminal attempted to spawn.'); });
  // Observe the same CJS export that the manager's lazy ESM import consumes.
  assert.equal((await import('node-pty')).spawn, pty.spawn);
  const originalOpen = Workspace.open;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(Workspace, 'open', async (...args: Parameters<typeof Workspace.open>) => {
    const workspace = await originalOpen.apply(Workspace, args);
    entered(); await gate; return workspace;
  });
  try {
    const opening = manager.open(directory);
    const rejected = assert.rejects(opening, /cancelled.*session changed/i);
    await reached;
    await manager.closeAll();
    release();
    await rejected;
    assert.equal(spawns, 0, 'Revocation must prevent the process from starting, before any HTTP post-open cleanup.');
  } finally {
    release();
    t.mock.restoreAll();
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});
