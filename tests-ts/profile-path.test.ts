import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { defaultConfigPath, defaultDataDirectory } from '../server/config.js';
import { parseCliArgs } from '../server/cli.js';

const absent = (code = 'ENOENT'): never => { throw Object.assign(new Error(code), { code }); };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-profile-path-'));
  const diskRoot = join(directory, 'gopher'), root = win32.join(directory, 'gopher');
  const options = { platform: 'win32' as const, env: { APPDATA: directory }, home: directory, lstat: (path: string) => {
    const relative = win32.relative(root, path);
    assert.ok(!relative.startsWith('..') && !win32.isAbsolute(relative));
    return lstatSync(join(diskRoot, ...relative.split('\\')));
  } };
  async function put(relative: string, content: string) {
    const target = join(diskRoot, ...relative.split('/'));
    await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content);
  }
  async function snapshot(): Promise<Record<string, Buffer>> {
    const result: Record<string, Buffer> = {};
    for (const name of await readdir(diskRoot, { recursive: true })) {
      const path = join(diskRoot, name);
      if (lstatSync(path).isFile()) result[name] = await readFile(path);
    }
    return result;
  }
  return { directory, diskRoot, root, options, put, snapshot, cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) };
}

test('fresh Windows defaults retain the original config directory with APPDATA and home fallback', () => {
  const inspect = () => absent();
  assert.equal(defaultDataDirectory({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Example\\Roaming' }, home: 'C:\\Users\\Example', lstat: inspect }), 'C:\\Users\\Example\\Roaming\\gopher\\config');
  assert.equal(defaultConfigPath({ platform: 'win32', env: {}, home: 'C:\\Users\\Example', lstat: inspect }), 'C:\\Users\\Example\\AppData\\Roaming\\gopher\\config\\config.toml');
});

test('the original Windows profile wins when both locations contain histories, without changing either', async () => {
  const f = await fixture();
  try {
    await f.put('config/config.toml', 'original config bytes that must not be parsed by the resolver');
    await f.put('config/chats.json', '{"conversations":[{"id":"original-history"}]}');
    await f.put('config/preferences.json', '{"background":"original-background"}');
    await f.put('config/encryption.json', 'original encrypted-profile metadata');
    await f.put('config.toml', 'root config bytes');
    await f.put('chats.json', '{"conversations":[{"id":"root-history"}]}');
    await f.put('preferences.json', '{"background":"root-background"}');
    const before = await f.snapshot();
    assert.equal(defaultDataDirectory(f.options), win32.join(f.root, 'config'));
    assert.equal(defaultConfigPath(f.options), win32.join(f.root, 'config', 'config.toml'));
    assert.deepEqual(await f.snapshot(), before);
    const explicit = win32.join(f.root, 'config', 'config.toml');
    const cli = parseCliArgs([`--config=${explicit}`]);
    assert.equal(cli.configPath || defaultConfigPath({ ...f.options, lstat: () => { throw new Error('Explicit config must not invoke default detection'); } }), explicit);
  } finally { await f.cleanup(); }
});

test('root Windows profiles remain available when the original is absent, empty or contains only cache', async () => {
  const f = await fixture();
  try {
    await f.put('chats.json', '{"conversations":[{"id":"root-history"}]}');
    await f.put('preferences.json', '{"background":"root-background"}');
    assert.equal(defaultDataDirectory(f.options), f.root);
    await mkdir(join(f.diskRoot, 'config'));
    assert.equal(defaultDataDirectory(f.options), f.root);
    await f.put('config/Cache/cache-entry', 'cache bytes');
    const before = await f.snapshot();
    assert.equal(defaultDataDirectory(f.options), f.root);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.cleanup(); }
});

test('saved original data selects the original profile even without a config file; Electron cache alone is not a profile', async () => {
  const f = await fixture();
  try {
    await f.put('Cache/cache-entry', 'cache bytes');
    assert.equal(defaultDataDirectory(f.options), win32.join(f.root, 'config'));
    assert.equal((await readdir(f.diskRoot)).includes('config'), false, 'Detection must not create the selected directory.');
    await f.put('config/chats.json', '{"conversations":[{"id":"original-history"}]}');
    const before = await f.snapshot();
    assert.equal(defaultDataDirectory(f.options), win32.join(f.root, 'config'));
    assert.deepEqual(await f.snapshot(), before);
    await f.put('config.toml', 'established root configuration');
    assert.equal(defaultDataDirectory(f.options), win32.join(f.root, 'config'), 'A newly created root configuration must not hide the original archive.');
  } finally { await f.cleanup(); }
});

test('profile metadata errors propagate instead of silently selecting another Windows profile', () => {
  const root = 'C:\\Example\\gopher';
  for (const denied of [win32.join(root, 'config'), win32.join(root, 'config', 'chats.json'), win32.join(root, 'chats.json')]) {
    const failure = Object.assign(new Error('Profile metadata denied'), { code: 'EACCES' });
    assert.throws(() => defaultDataDirectory({ platform: 'win32', env: { APPDATA: 'C:\\Example' }, home: 'C:\\Home', lstat: path => {
      if (path === denied) throw failure;
      if (path === root || path === win32.join(root, 'config')) return { isDirectory: () => true };
      return absent();
    } }), error => error === failure);
  }
  for (const code of ['ENOENT', 'ENOTDIR']) assert.equal(defaultDataDirectory({ platform: 'win32', env: { APPDATA: 'C:\\Example' }, home: 'C:\\Home', lstat: () => absent(code) }), win32.join(root, 'config'));
});

test('Linux and macOS default paths remain unchanged and do not inspect Windows profile candidates', () => {
  const inspect = () => { throw new Error('Unexpected filesystem inspection'); };
  assert.equal(defaultDataDirectory({ platform: 'linux', env: {}, home: '/home/example', lstat: inspect }), '/home/example/.config/gopher');
  assert.equal(defaultConfigPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/custom/config' }, home: '/home/example', lstat: inspect }), '/custom/config/gopher/config.toml');
  assert.equal(defaultDataDirectory({ platform: 'darwin', env: { XDG_CONFIG_HOME: '/ignored' }, home: '/Users/example', lstat: inspect }), posix.join('/Users/example', 'Library', 'Application Support', 'gopher'));
});
