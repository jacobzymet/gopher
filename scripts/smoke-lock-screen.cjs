// Hidden native Electron check against a temporary encrypted profile.
const { app } = require('electron');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = mkdtempSync(join(tmpdir(), 'gopher-lock-smoke-'));
const config = join(root, 'config.toml');
const node = process.env.GOPHER_NODE_EXECUTABLE || 'node';
const environment = { ...process.env, GOPHER_LOCK_SMOKE_CONFIG: config };
delete environment.ELECTRON_RUN_AS_NODE;
const setup = spawnSync(node, ['--import', 'tsx', '--input-type=module', '-e', `
  import { AppStorage } from './server/storage.ts';
  const storage = await AppStorage.open(process.env.GOPHER_LOCK_SMOKE_CONFIG);
  await storage.enableEncryption('native-lock-fixture-passphrase');
  await storage.close();
`], { env: environment, stdio: 'inherit', windowsHide: true });
if (setup.status !== 0) { console.error('Encrypted fixture setup failed', setup.error || setup.status); process.exit(1); }
app.setPath('userData', join(root, 'electron'));
process.argv.push('--config=' + config, '--bind=127.0.0.1:0');
const deadline = setTimeout(() => { console.error('Native lock-screen check timed out'); app.exit(1); }, 45000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await wait(50); }
  throw new Error('Native encryption window state did not settle');
}
let verified = false;
app.on('browser-window-created', (_event, window) => {
  window.on('show', () => window.hide());
  window.hide();
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load', async () => {
    try {
      // Hidden windows need not present animation frames; the server marks the gate before paint.
      await until(() => window.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-session-locked') && typeof unlockDiskEncryption === 'function' && dataInfo?.encryption_enabled`));
      await until(() => !window.isMinimizable());
      assert.equal(window.isFullScreen(), false);
      window.minimize(); await wait(200);
      assert.equal(window.isMinimized(), false);
      assert.equal(await window.webContents.executeJavaScript(`unlockDiskEncryption('incorrect-fixture-passphrase', null).then(() => false, () => true)`), true);
      assert.equal(window.isMinimizable(), false);
      await window.webContents.executeJavaScript(`unlockDiskEncryption('native-lock-fixture-passphrase', null)`);
      await until(() => !window.isFullScreen() && window.isMinimizable());
      await window.webContents.executeJavaScript(`postEncryption('/api/data/encryption/lock', {}).then(() => clearMemoryAfterLock())`);
      await until(() => !window.isMinimizable());
      assert.equal(window.isFullScreen(), false);
      verified = true;
      clearTimeout(deadline);
      app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
app.on('will-quit', () => {
  if (!verified) { app.exit(1); return; }
  mkdirSync(resolve('output/playwright'), { recursive: true });
  writeFileSync(resolve('output/playwright/lock-screen-desktop.json'), JSON.stringify({
    normal_window_preserved: true, minimize_blocked: true, wrong_passphrase_stays_locked: true,
    unlock_restores_window: true, relock_restores_gate: true, quit: true,
  }, null, 2));
  console.log('Native lock-screen checks passed.');
});
require('../dist/desktop/main.cjs');
