import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from '../server/terminal.js';
import { Workspace } from '../server/tools/filesystem.js';

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
