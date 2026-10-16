import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IPty } from 'node-pty';
import { ensureDarwinPtyHelpers } from '../server/terminal.js';

test('macOS repairs a non-executable published PTY helper and spawns a real shell', { skip: process.platform !== 'darwin', timeout: 20000 }, async () => {
  const require = createRequire(import.meta.url);
  const installed = dirname(require.resolve('node-pty/package.json'));
  const directory = await fs.mkdtemp(join(tmpdir(), 'gopher-macos-pty-'));
  const isolated = join(directory, 'node-pty'), nativeDirectory = `prebuilds/darwin-${process.arch}`;
  let terminal: IPty | undefined;
  try {
    await fs.mkdir(isolated);
    await Promise.all([
      fs.cp(join(installed, 'lib'), join(isolated, 'lib'), { recursive: true }),
      fs.cp(join(installed, nativeDirectory), join(isolated, nativeDirectory), { recursive: true }),
      fs.copyFile(join(installed, 'package.json'), join(isolated, 'package.json')),
    ]);
    const helper = join(isolated, nativeDirectory, 'spawn-helper'), original = await fs.readFile(helper);
    await fs.chmod(helper, 0o644);
    const pty = require(join(isolated, 'lib/index.js')) as typeof import('node-pty');
    const options = { cwd: directory, name: 'xterm-256color', env: { ...process.env } as Record<string, string> };
    assert.throws(() => pty.spawn('/bin/sh', ['-c', 'printf MAC_PTY_READY'], options), /posix_spawn(?:p)? failed/);
    await ensureDarwinPtyHelpers(isolated);
    assert.equal((await fs.stat(helper)).mode & 0o777, 0o755);
    assert.deepEqual(await fs.readFile(helper), original, 'Repair must preserve the packaged native executable bytes.');
    terminal = pty.spawn('/bin/sh', ['-c', 'printf MAC_PTY_READY'], options);
    let output = '';
    terminal.onData(data => { output += data; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The repaired macOS PTY did not exit')), 10000);
      terminal!.onExit(({ exitCode }) => { clearTimeout(timer); try { assert.equal(exitCode, 0); resolve(); } catch (error) { reject(error); } });
    });
    assert.match(output, /MAC_PTY_READY/);
    await ensureDarwinPtyHelpers(isolated);
    assert.equal((await fs.stat(helper)).mode & 0o777, 0o755, 'Repeated terminal launches must retain executable permissions.');
  } finally { try { terminal?.kill('SIGKILL'); } catch {} await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('macOS repeated real PTY launches release native descriptors after every closed shell', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
  await ensureDarwinPtyHelpers();
  const pty = await import('node-pty');
  async function runShell(): Promise<void> {
    const terminal = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cwd: tmpdir(), name: 'xterm-256color', env: { ...process.env } as Record<string, string> });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('PTY shell did not close')), 5000);
        terminal.onExit(({ exitCode }) => { clearTimeout(timer); try { assert.equal(exitCode, 0); resolve(); } catch (error) { reject(error); } });
      });
    } finally { try { terminal.kill('SIGKILL'); } catch {} }
  }
  for (let index = 0; index < 3; index++) await runShell();
  await new Promise(resolve => setTimeout(resolve, 100));
  const before = (await fs.readdir('/dev/fd')).length;
  for (let index = 0; index < 25; index++) await runShell();
  let after = Number.POSITIVE_INFINITY;
  const deadline = Date.now() + 2000;
  do {
    after = (await fs.readdir('/dev/fd')).length;
    if (after <= before + 4) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.ok(after <= before + 4, `Closed PTYs leaked native descriptors: before=${before}, after=${after}`);
});
