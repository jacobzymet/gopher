import { app, BrowserWindow, dialog, shell, nativeImage, Menu } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { serverRuntime, releaseElectronExecutable } from './runtime.js';

let window: BrowserWindow | null = null;
let server: ChildProcess | null = null;
let quitting = false;
let allowQuit = false;
let usingExistingServer = false;
const root = app.getAppPath();
const serverEntry = [join(root, 'dist/server/index.js'), join(root, 'server/index.js'), resolve(__dirname, '../server/index.js')].find(existsSync);
if (!serverEntry) throw new Error('The built server is missing. Run npm run build.');
const initialArgs = process.argv.slice(2);
const configArgument = initialArgs.find(arg => arg.startsWith('--config='))?.slice('--config='.length) || (initialArgs.includes('--config') ? initialArgs[initialArgs.indexOf('--config') + 1] : undefined);
if (configArgument) app.setPath('userData', join(app.getPath('userData'), 'instances', createHash('sha256').update(resolve(configArgument)).digest('hex').slice(0, 24)));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) { console.log('Gopher is already open — focusing its window.'); app.quit(); }
function focusWindow(): boolean {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus(); return true;
}
app.on('second-instance', focusWindow);

async function boot(): Promise<void> {
  const cli = process.argv.slice(2); const forwarded: string[] = [];
  for (let at = 0; at < cli.length; at++) {
    const arg = cli[at];
    if (arg === '--config' || arg === '--bind') { if (!cli[at + 1] || cli[at + 1].startsWith('--')) throw new Error(`${arg} requires a value.`); forwarded.push(arg, cli[++at]); }
    else if (arg.startsWith('--config=') || arg.startsWith('--bind=') || arg === '--update-restart') forwarded.push(arg);
  }
  const node = await serverRuntime();
  const environment: NodeJS.ProcessEnv = { ...process.env, GOPHER_NODE_EXECUTABLE: node };
  delete environment.ELECTRON_RUN_AS_NODE;
  server = spawn(node, [serverEntry!, '--headless', ...forwarded], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let opened = false;
  let logs = '';
  server.stdout?.on('data', data => {
    process.stdout.write(data);
    logs = (logs + String(data)).slice(-16000);
    const match = logs.match(/Gopher listening on (http:\/\/[^\s]+)/);
    if (match && !opened) { opened = true; createWindow(match[1]); }
  });
  server.stderr?.on('data', data => { process.stderr.write(data); logs = (logs + String(data)).slice(-16000); });
  server.on('error', error => { dialog.showErrorBox('Could not start Gopher', error.message); app.quit(); });
  server.on('exit', code => {
    server = null;
    if (!quitting && !(usingExistingServer && window && code === 0)) { if (code) dialog.showErrorBox('Gopher stopped', logs); app.quit(); }
  });
  server.on('message', async (raw: unknown) => {
    const message = raw as { type: string; id: string; action: string; value?: string; url?: string; focused?: boolean };
    if (message.type === 'existing-instance') {
      if (!message.focused && message.url && !opened) {
        opened = true; usingExistingServer = true; createWindow(message.url);
      }
      return;
    }
    if (message.type !== 'native-request') return;
    let value: unknown = null;
    try {
      if (message.action === 'pick-folder') {
        const options = { title: 'Choose workspace folder', properties: ['openDirectory'] as Array<'openDirectory'> };
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        value = result.canceled ? null : result.filePaths[0];
      } else if (message.action === 'open-path' && message.value) {
        const error = await shell.openPath(message.value); if (error) throw new Error(error);
      } else if (message.action === 'open-url' && message.value) {
        const url = new URL(message.value); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported link.');
        await shell.openExternal(url.href);
      } else if (message.action === 'focus') value = focusWindow();
      else if (message.action === 'restart') {
        server?.send({ type: 'native-response', id: message.id, value: true });
        if (message.value) {
          const restart = JSON.parse(message.value) as { checkout: string; configPath?: string; bind?: string };
          app.relaunch({ execPath: releaseElectronExecutable(restart.checkout), args: [restart.checkout, '--update-restart', ...(restart.configPath ? [`--config=${restart.configPath}`] : []), ...(restart.bind ? [`--bind=${restart.bind}`] : [])] });
        }
        else app.relaunch();
        app.quit(); return;
      }
      server?.send({ type: 'native-response', id: message.id, value });
    } catch (error) { server?.send({ type: 'native-response', id: message.id, error: String(error) }); }
  });
}

function createWindow(url: string): void {
  const icon = [join(root, 'assets/browser-favicon.png'), join(root, 'public/browser-favicon.png'), resolve(__dirname, '../public/browser-favicon.png')].find(existsSync);
  window = new BrowserWindow({ width: 1280, height: 840, useContentSize: true, minWidth: 720, minHeight: 520, title: 'Gopher', backgroundColor: '#16181e', ...(icon ? { icon: nativeImage.createFromPath(icon) } : {}), webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: true } });
  const origin = new URL(url).origin;
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== origin) { event.preventDefault(); if (/^https?:\/\//.test(target)) void shell.openExternal(target); } });
  const ownOrigin = (value: string) => { try { return new URL(value).origin === origin; } catch { return false; } };
  window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin) => Boolean(contents && ownOrigin(contents.getURL()) && ownOrigin(requestingOrigin) && ['media', 'clipboard-sanitized-write', 'clipboard-read'].includes(permission)));
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const local = ownOrigin(contents.getURL()) && (!details.requestingUrl || ownOrigin(details.requestingUrl));
    const audioOnly = permission === 'media' && 'mediaTypes' in details && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio');
    callback(local && (audioOnly || ['clipboard-sanitized-write', 'clipboard-read'].includes(permission)));
  });
  window.on('closed', () => { window = null; });
  void window.loadURL(url);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
}

app.whenReady().then(() => { if (primaryInstance) return boot(); }).catch(error => { dialog.showErrorBox('Could not start Gopher', String(error)); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (allowQuit || !server) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  const child = server;
  const timeout = setTimeout(() => { child.kill(); allowQuit = true; app.quit(); }, 7000);
  timeout.unref();
  child.once('exit', () => { clearTimeout(timeout); allowQuit = true; app.quit(); });
  if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
});
