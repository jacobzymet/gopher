import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function launch(config: string, bind: string, restart = false, options: { ipc?: boolean; focused?: boolean; browser?: boolean } = {}) {
  const child = spawn(process.execPath, [resolve('dist/server/index.js'), '--headless', '--config', config, '--bind', bind, ...(restart ? ['--update-restart'] : []), ...(options.browser ? ['--browser'] : [])], { windowsHide: true, stdio: options.ipc === false ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout!.on('data', data => { logs += data; }); child.stderr!.on('data', data => { logs += data; });
  const messages: any[] = [];
  child.on('message', (message: any) => { messages.push(message); if (message?.type === 'native-request' && child.connected) child.send({ type: 'native-response', id: message.id, value: message.action === 'focus' ? options.focused !== false : null }); });
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  async function ready() {
    for (let attempt = 0; attempt < 150; attempt++) {
      const match = logs.match(/Gopher listening on http:\/\/gopher\.localhost:(\d+)/); if (match) return Number(match[1]);
      if (child.exitCode !== null) throw new Error(logs || `Child exited ${child.exitCode}`);
      await delay(100);
    }
    throw new Error('Startup timed out: ' + logs);
  }
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) { await exited; return; }
    const timeout = setTimeout(() => child.kill(), 7000); timeout.unref();
    try { if (child.connected) child.send({ type: 'shutdown' }); else child.kill(); await exited; }
    finally { clearTimeout(timeout); }
  }
  return { child, ready, stop, exited, messages, logs: () => logs };
}

test('a second desktop IPC launch focuses the running instance and exits without claiming its data', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-cli-focus-')); const config = join(directory, 'config.toml');
  const first = launch(config, '127.0.0.1:0'); let second: ReturnType<typeof launch> | undefined;
  try {
    const port = await first.ready(); second = launch(config, `127.0.0.1:${port}`);
    assert.equal(await second.exited, 0, second.logs()); assert.match(second.logs(), /already running/);
    assert.match(second.logs(), /focused the open window/);
    assert.deepEqual(second.messages, [{ type: 'existing-instance', url: `http://127.0.0.1:${port}`, focused: true }]);
    assert.equal(second.child.connected, false, 'The redundant desktop child must release its IPC channel.');
    assert.equal(first.child.exitCode, null);
  } finally { await first.stop(); await second?.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('desktop IPC launch reuses a real headless server and reports that a window still needs to open', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-cli-headless-')); const config = join(directory, 'config.toml');
  const first = launch(config, '127.0.0.1:0', false, { ipc: false }); let second: ReturnType<typeof launch> | undefined;
  try {
    const port = await first.ready(); second = launch(config, `127.0.0.1:${port}`);
    assert.equal(await second.exited, 0, second.logs());
    assert.deepEqual(second.messages, [{ type: 'existing-instance', url: `http://127.0.0.1:${port}`, focused: false }]);
    assert.match(second.logs(), /using the existing server/);
    assert.doesNotMatch(second.logs(), /focusing|focused the open window/);
    assert.equal(second.child.connected, false);
    assert.equal(first.child.exitCode, null, 'Attaching a window must not stop or take the existing server’s data lease.');
    const response = await fetch(`http://127.0.0.1:${port}/`); await response.body?.cancel(); assert.equal(response.status, 200);
  } finally { await first.stop(); await second?.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('native IPC availability does not claim successful focus when the desktop has no window', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-cli-no-window-')); const config = join(directory, 'config.toml');
  const first = launch(config, '127.0.0.1:0', false, { focused: false }); let second: ReturnType<typeof launch> | undefined;
  try {
    const port = await first.ready(); second = launch(config, `127.0.0.1:${port}`);
    assert.equal(await second.exited, 0, second.logs());
    assert.deepEqual(second.messages, [{ type: 'existing-instance', url: `http://127.0.0.1:${port}`, focused: false }]);
    assert.equal(first.messages.some(message => message.type === 'native-request' && message.action === 'focus'), true);
    assert.equal(first.child.exitCode, null);
  } finally { await first.stop(); await second?.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('explicit browser launch opens the existing unfocused server before the IPC probe exits', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-cli-existing-browser-')); const config = join(directory, 'config.toml');
  const first = launch(config, '127.0.0.1:0', false, { ipc: false }); let second: ReturnType<typeof launch> | undefined;
  try {
    const port = await first.ready(); second = launch(config, `127.0.0.1:${port}`, false, { browser: true });
    assert.equal(await second.exited, 0, second.logs());
    assert.equal(second.messages[0].type, 'existing-instance');
    assert.equal(second.messages[0].focused, false);
    assert.equal(second.messages[1].type, 'native-request');
    assert.equal(second.messages[1].action, 'open-url');
    assert.equal(second.messages[1].value, `http://127.0.0.1:${port}`);
    assert.equal(first.child.exitCode, null);
  } finally { await first.stop(); await second?.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('update restart waits for both the previous data lease and listen socket', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-cli-restart-')); const config = join(directory, 'config.toml');
  const first = launch(config, '127.0.0.1:0'); let replacement: ReturnType<typeof launch> | undefined;
  try {
    const port = await first.ready(); replacement = launch(config, `127.0.0.1:${port}`, true);
    await delay(600); assert.equal(replacement.child.exitCode, null, replacement.logs());
    await first.stop(); assert.equal(await replacement.ready(), port);
  } finally { await first.stop(); await replacement?.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});
