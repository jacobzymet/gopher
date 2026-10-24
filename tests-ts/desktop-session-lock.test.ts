import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { sessionLockReader, windowSessionLock } from '../desktop/session-lock.js';

test('native encryption state uses only authenticated local responses and rejects invalid states', async () => {
  const urls: string[] = [];
  let enabled = true, unlocked = false, valid = true;
  const reader = sessionLockReader('http://gopher.localhost:3930', async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.redirect, 'error');
    if (String(url).endsWith('/api/data')) {
      assert.deepEqual(options?.headers, { cookie: 'gopher_session=fixture-token' });
      return Response.json(valid ? { encryption_enabled: enabled, encryption_unlocked: unlocked } : {});
    }
    return new Response('', { headers: { 'set-cookie': 'gopher_session=fixture-token; HttpOnly; Path=/' } });
  });
  assert.equal(await reader(), true);
  unlocked = true;
  assert.equal(await reader(), false);
  enabled = false; unlocked = false;
  assert.equal(await reader(), false);
  valid = false;
  await assert.rejects(reader, /Invalid local encryption state/);
  assert.deepEqual(urls, ['http://127.0.0.1:3930/', ...Array(4).fill('http://127.0.0.1:3930/api/data')]);
});

test('locking prevents minimizing without changing window fullscreen state', () => {
  const window = Object.assign(new EventEmitter(), {
    fullScreen: false, minimizable: true, minimized: false,
    isDestroyed: () => false,
    isFullScreen() { return this.fullScreen; },
    isMinimizable() { return this.minimizable; },
    isMinimized() { return this.minimized; },
    setFullScreen() { assert.fail('Locking must not change fullscreen state'); },
    setMinimizable(value: boolean) { this.minimizable = value; },
    restore() { this.minimized = false; },
  });
  const guard = windowSessionLock(window as unknown as BrowserWindow);
  for (const fullScreen of [false, true]) {
    window.fullScreen = fullScreen;
    guard.update(true);
    assert.equal(window.fullScreen, fullScreen);
    assert.equal(window.minimizable, false);
    window.minimized = true; window.emit('minimize');
    assert.equal(window.minimized, false);
    guard.update(false);
    assert.equal(window.fullScreen, fullScreen);
    assert.equal(window.minimizable, true);
  }
  guard.dispose();
  assert.equal(window.listenerCount('minimize'), 0);
});
