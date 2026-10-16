import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCliArgs } from '../server/cli.js';

test('CLI accepts the supported modes and both configuration argument forms', () => {
  assert.deepEqual(parseCliArgs(['--headless', '--config', 'folder with spaces/config.toml', '--bind=127.0.0.1:0', '--update-restart']), {
    headless: true, browser: false, configPath: 'folder with spaces/config.toml', bind: '127.0.0.1:0', updateRestart: true, help: false, version: false,
  });
  assert.equal(parseCliArgs(['--config=other/config.toml', '--bind', '[::1]:3931', '--open']).browser, true);
  assert.equal(parseCliArgs(['--browser']).browser, true);
  for (const flag of ['--help', '-h']) assert.equal(parseCliArgs([flag]).help, true);
  for (const flag of ['--version', '-v']) assert.equal(parseCliArgs([flag]).version, true);
});

test('CLI rejects missing values, unknown flags, duplicate paths and invalid binds', () => {
  for (const args of [
    ['--config'], ['--config', '--headless'], ['--config', '-h'], ['--config='], ['--config', ' '], ['--config=x\0y'],
    ['--bind'], ['--bind', '--headless'], ['--bind='], ['--bind', '0.0.0.0:3930'], ['--bind', '127.0.0.1:65536'], ['--bind', '127.0.0.1:-1'],
    ['--confg', 'config.toml'], ['config.toml'], ['--headless=true'], ['--config', 'one', '--config=two'], ['--bind=127.0.0.1:1', '--bind=127.0.0.1:2'],
  ]) assert.throws(() => parseCliArgs(args), args.join(' '));
});

test('invalid CLI configuration arguments exit before creating any data files', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-invalid-cli-'));
  try {
    const execute = promisify(execFile);
    const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
    await assert.rejects(execute(process.execPath, ['--import', loader, resolve('server/index.ts'), '--headless', '--config', '--bind', '127.0.0.1:0'], {
      cwd: directory, windowsHide: true, timeout: 5000,
    }), (error: unknown) => {
      const result = error as Error & { code?: number; stderr?: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr || '', /--config requires a value/);
      return true;
    });
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});
