import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';

async function desktop() {
  const entry = resolve('dist/desktop/main.cjs'); const require = createRequire(entry);
  const app = Object.assign(new EventEmitter(), {
    getAppPath: () => resolve('.'), getPath: () => resolve('output/desktop-test'),
    setPath: () => {}, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), quit: () => { quits++; },
  });
  let quits = 0, resolveStarted!: () => void;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const sent: any[] = [], errors: string[] = [], windows: Window[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), connected: true,
    send: (message: any) => { sent.push(message); }, kill: () => {},
  });
  class Window extends EventEmitter {
    url = ''; minimized = false; restored = false; shown = false; focused = false;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => {},
      session: { setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {} },
    });
    constructor() { super(); windows.push(this); }
    isDestroyed() { return false; }
    isMinimized() { return this.minimized; }
    restore() { this.restored = true; this.minimized = false; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    loadURL(url: string) { this.url = url; return Promise.resolve(); }
  }
  const electron = { app, BrowserWindow: Window, dialog: { showErrorBox: (_title: string, message: string) => errors.push(message) }, shell: {}, nativeImage: { createFromPath: () => ({}) }, Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => [] } };
  runInNewContext(await readFile(entry, 'utf8'), {
    require: (name: string) => name === 'electron' ? electron : name === 'node:child_process' ? { ...require(name), spawn: () => { resolveStarted(); return child; } } : require(name),
    module: { exports: {} }, exports: {}, __dirname: dirname(entry), console,
    process: { argv: ['electron', '.'], execPath: process.execPath, env: { ...process.env, GOPHER_NODE_EXECUTABLE: process.execPath }, stdout: { write: () => {} }, stderr: { write: () => {} }, platform: process.platform },
    setTimeout, clearTimeout, URL, Buffer,
  });
  await started;
  return { app, child, sent, errors, windows, quits: () => quits };
}

test('desktop opens an existing headless server and survives its startup probe exiting', { timeout: 10000 }, async () => {
  const d = await desktop();
  d.child.emit('message', { type: 'existing-instance', url: 'http://127.0.0.1:3930', focused: false });
  assert.equal(d.windows.length, 1); assert.equal(d.windows[0].url, 'http://127.0.0.1:3930');
  d.child.emit('exit', 0); assert.equal(d.quits(), 0); assert.deepEqual(d.errors, []);
  let prevented = false;
  d.app.emit('before-quit', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false); assert.deepEqual(d.sent, [], 'Closing this window must leave the external server running.');
  d.windows[0].emit('closed'); d.app.emit('window-all-closed'); assert.equal(d.quits(), 1);
});

test('desktop quits a redundant probe after an existing native window was focused', { timeout: 10000 }, async () => {
  const d = await desktop();
  d.child.emit('message', { type: 'existing-instance', url: 'http://127.0.0.1:3930', focused: true });
  d.child.emit('exit', 0); assert.equal(d.windows.length, 0); assert.equal(d.quits(), 1);
});

test('desktop focus restores a minimized window and acknowledges that it exists', { timeout: 10000 }, async () => {
  const d = await desktop();
  d.child.stdout.emit('data', Buffer.from('Gopher listening on http://gopher.localhost:3930\n'));
  const window = d.windows[0]; assert.ok(window); window.minimized = true;
  d.child.emit('message', { type: 'native-request', id: 'focus', action: 'focus' });
  assert.equal(window.restored, true); assert.equal(window.shown, true); assert.equal(window.focused, true);
  assert.equal(d.sent.at(-1).value, true);
  d.child.emit('exit', 1); assert.equal(d.quits(), 1); assert.equal(d.errors.length, 1);
});
