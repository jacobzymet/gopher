import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { AppStorage } from '../server/storage.js';
import { createApp } from '../server/http/app.js';
import { findBrowserExecutable } from '../server/tools/browser.js';

test('encrypted workspaces start behind a full-screen, non-dismissible gate and open only after verified loading', { timeout: 60000 }, async t => {
  const executablePath = await findBrowserExecutable();
  if (!executablePath) { t.skip('Chromium unavailable'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'gopher-lock-screen-'));
  const configPath = join(directory, 'config.toml'), passphrase = 'lock-screen-fixture-passphrase';
  let storage: AppStorage | undefined, app: Awaited<ReturnType<typeof createApp>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    storage = await AppStorage.open(configPath);
    await storage.saveChats({ version: 3, activeProfileId: 'personal', profiles: [{ id: 'personal', conversations: [{ id: 'private-chat', title: 'Private conversation', messages: [] }] }] });
    await storage.enableEncryption(passphrase);
    await storage.close(); storage = undefined;
    app = await createApp({ configPath, bind: '127.0.0.1:0' }); await app.listen();
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const html = await (await fetch(origin)).text();
    assert.match(html, /<html[^>]+data-session-locked="true"/);
    assert.match(html, /id="chatShell" inert aria-hidden="true"/);
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    const gate = page.locator('#unlockModal');
    await page.locator('#unlockModal.is-open').waitFor();
    assert.equal(await page.locator('#btnUnlockModalDismiss').count(), 0);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await gate.boundingBox(); assert.ok(box);
      assert.deepEqual({ x: box.x, y: box.y, width: box.width, height: box.height }, { x: 0, y: 0, width, height: 900 });
      await page.keyboard.press('Escape'); await gate.click({ position: { x: 2, y: 2 } });
      await page.evaluate(() => { hideUnlockSession(); closeBackdrop(document.getElementById('unlockModal')!); });
      assert.equal(await page.locator('#chatShell').evaluate(element => (element as HTMLElement).inert), true);
      assert.equal(await page.locator('#chatShell').isVisible(), false);
      assert.equal(await gate.isVisible(), true);
      await mkdir(resolve('output'), { recursive: true });
      await page.screenshot({ path: resolve(`output/lock-screen-${width === 390 ? 'mobile' : 'desktop'}.png`) });
    }
    await page.locator('#unlockModalPassphrase').fill('incorrect-passphrase');
    await page.locator('#btnUnlockModalSubmit').click();
    await page.locator('#unlockModalError:not(.is-hidden)').waitFor();
    assert.equal(await gate.isVisible(), true);
    // Decryption alone must not reveal an empty workspace if preferences fail to load.
    await page.route(origin + '/api/data/preferences', route => route.fulfill({ status: 503, json: { error: 'Fixture read failure' } }));
    await page.locator('#unlockModalPassphrase').fill(passphrase); await page.locator('#btnUnlockModalSubmit').click();
    await page.locator('#unlockModalError').filter({ hasText: 'Fixture read failure' }).waitFor();
    assert.equal(await gate.isVisible(), true);
    assert.equal(await page.locator('#chatShell').isVisible(), false);
    await page.unroute(origin + '/api/data/preferences');
    await page.locator('#unlockModalPassphrase').fill(passphrase); await page.locator('#btnUnlockModalSubmit').click();
    await gate.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#chatShell').evaluate(element => (element as HTMLElement).inert), false);
    assert.equal(await page.locator('html').getAttribute('data-session-locked'), null);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await app?.close(); await storage?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

declare const hideUnlockSession: () => void;
declare const closeBackdrop: (element: HTMLElement) => void;
