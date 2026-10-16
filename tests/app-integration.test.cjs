const { appTestsEnabled, spawnApp, stopApp, removeAppData } = require('./helpers/app.cjs');
// Set GOPHER_E2E=1 to test the TypeScript CLI. Every test uses isolated data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

test('ephemeral bind reports its actual port and relative config keeps data beside it', {
  skip: !appTestsEnabled,
  timeout: 30000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gopher-config-path-'));
  writeFileSync(join(dir, 'config.toml'), '');
  let origin;
  const child = spawnApp([
    '--headless', '--config', 'config.toml', '--bind', '127.0.0.1:0',
  ], { cwd: dir, windowsHide: true, stdio: 'pipe' });
  let logs = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  try {
    let bootstrap;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(logs);
      const port = logs.match(/Gopher listening on http:\/\/gopher\.localhost:(\d+)/)?.[1];
      if (port && Number(port) > 0) {
        origin = `http://127.0.0.1:${port}`;
        try { bootstrap = await fetch(origin, { signal: AbortSignal.timeout(1000) }); } catch {}
      }
      if (bootstrap?.ok) break;
      await delay(100);
    }
    assert.ok(bootstrap?.ok, logs);
    await bootstrap.body.cancel();
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const call = async (path, method = 'GET', body) => {
      const response = await fetch(origin + path, {
        method, headers: { cookie, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const info = await call('/api/data');
    assert.equal(info.status, 200);
    assert.equal(resolve(info.body.data_dir), dir);
    assert.equal(resolve(info.body.config_path), join(dir, 'config.toml'));
    assert.equal((await call('/api/data/store', 'PUT', { conversations: [{ id: 'example', messages: [] }] })).status, 204);
    assert.equal((await call('/api/data/preferences', 'PUT', { name: 'Example' })).status, 200);
    assert.equal((await call('/api/skills', 'POST', { name: 'Example', content: 'Test instructions.' })).status, 200);
    assert.equal(JSON.parse(readFileSync(join(dir, 'chats.json'))).conversations[0].id, 'example');
    assert.equal(JSON.parse(readFileSync(join(dir, 'preferences.json'))).name, 'Example');
    assert.equal(JSON.parse(readFileSync(join(dir, 'chat-skills', 'skills.json')))[0].name, 'Example');
    writeFileSync(join(dir, 'chats.json'), '');
    const corrupt = await call('/api/data/store');
    assert.ok(corrupt.status >= 400);
    assert.match(corrupt.body.error, /empty JSON file/i);
  } finally {
    await stopApp(child);
    await removeAppData(dir);
  }
});
