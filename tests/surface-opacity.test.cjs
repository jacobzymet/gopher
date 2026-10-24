const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, appTestsEnabled, browserLaunchOptions } = require('./helpers/app.cjs');
const { readUiStyles } = require('./helpers/ui-source.cjs');

test('cards and popup surfaces stay opaque over wallpaper in both themes, including hover and opening', {
  skip: !appTestsEnabled || !chromium, timeout: 30000,
}, async () => {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage();
    for (const theme of ['dark', 'light']) {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.setContent(`<html data-theme="${theme}"><style>${readUiStyles()}
          .chat-main { background: repeating-conic-gradient(magenta 0% 25%, lime 0% 50%) 0 / 40px 40px; }
          [data-surface] { min-width: 100px; min-height: 40px; }
        </style><main class="chat-main">
          <button class="welcome-starter" data-surface>Understand something</button>
          <div class="welcome-connect" data-surface>Connect a model</div>
          <div class="chat-topbar" data-surface>Toolbar</div>
          <div class="composer-card" data-surface>Composer</div>
          <div class="composer-model-tab" data-surface>Model tab</div>
          <div class="agent-step-card" data-surface>Activity card</div>
          <div class="clarify-card is-done" data-surface>Answered question</div>
          <div class="chat-model-menu is-open" data-surface data-popup>Model picker</div>
          <div class="plus-menu is-open" data-surface data-popup>Attachments</div>
          <div class="think-menu is-open" data-surface data-popup>Thinking</div>
          <div class="convo-menu is-open" data-surface data-popup>Chat actions</div>
          <div class="sidebar-profile-menu is-open" data-surface data-popup>Profiles</div>
          <div id="notificationsView" class="is-open" data-surface data-popup>Notifications</div>
          <div class="dialog-backdrop is-open"><div class="dialog settings-dialog" data-surface>Settings</div></div>
        </main></html>`);
        const inspect = () => page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          return [...document.querySelectorAll('[data-surface]')].map(element => {
            const style = getComputedStyle(element);
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = style.backgroundColor;
            context.fillRect(0, 0, 1, 1);
            let opacity = 1;
            for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
              opacity *= Number(getComputedStyle(ancestor).opacity);
            }
            return { name: element.className, alpha: context.getImageData(0, 0, 1, 1).data[3], opacity };
          });
        });
        const check = async () => {
          for (const surface of await inspect()) {
            assert.equal(surface.alpha, 255, `${theme}/${width}: ${surface.name} background`);
            assert.equal(surface.opacity, 1, `${theme}/${width}: ${surface.name} opacity`);
          }
        };
        await check();
        // Check the shared hover fill even where another popup covers the starter.
        await page.evaluate(() => {
          document.querySelector('.welcome-starter').style.background = 'var(--accent-wash)';
        });
        await check();
        await page.evaluate(async () => {
          const popups = document.querySelectorAll('[data-popup]');
          popups.forEach(element => element.classList.remove('is-open'));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          popups.forEach(element => element.classList.add('is-open'));
          await new Promise(requestAnimationFrame);
        });
        await check();
      }
    }
  } finally { await browser.close(); }
});
