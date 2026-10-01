const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Browser coverage requires Playwright. */ }
const browserOptions = { skip: !chromium && 'Playwright is required for marquee browser tests' };
const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const render = read('src/ui/chat/scripts/render.js');
const state = read('src/ui/chat/scripts/state.js');
const extract = (source, name) => source.match(new RegExp('function ' + name + '\\([^]*?\\r?\\n\\}'))[0];
const html = read('src/ui/chat.html')
  .replace(/<script\b[^>]*>[^]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*>/gi, '');
const css = [...read('build.rs').matchAll(/"(src\/ui\/chat\/styles\/[^"]+)"/g)]
  .map((match) => read(match[1])).join('\n');
const longTitle = 'Remove Toilet Bowl Stains Without Brushing - A Complete Cleaning Guide';
let browser;

test.before(async () => {
  if (chromium) browser = await chromium.launch({
    headless: true,
    ...(process.env.MARQUEE_BROWSER_CHANNEL ? { channel: process.env.MARQUEE_BROWSER_CHANNEL } : {}),
  });
});
test.after(async () => { await browser?.close(); });

async function withSidebar(run, { viewport, fast = true, convo = {}, ...settings } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 1280, height: 800 } });
  try {
    await page.setContent(html);
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: [
      "const activeId = 'active'; const mainView = 'chat';",
      'let conversationSelectionMode = false;',
      'const selectedConversationIds = new Set();',
      'const convoBusyAnimationStartedAt = new Map(); const titleTypeTimers = new Map();',
      'const isConvoBusy = () => false;',
      'const notificationIsUnread = (convo) => !!convo.unread;',
      'const isBotsConvo = (convo) => !!convo.botId;',
      "const getBot = () => ({ handle: 'research' });",
      "const createConvoAvatarEl = () => { const avatar = document.createElement('span'); avatar.className = 'convo-avatar'; avatar.textContent = 'R'; return avatar; };",
      extract(render, 'createConvoItem'),
      ...['applyPrivacyMosaic', 'isPrivacyModeOn', 'setIdentityTitle', 'titleTypeHost', 'stopTitleTyping', 'typeTitleInto']
        .map((name) => extract(state, name)),
    ].join('\n') });
    await page.evaluate(({ convo, settings, longTitle }) => {
      document.documentElement.classList.add('ui-ready');
      document.documentElement.dataset.fontScale = settings.scale || 'default';
      if (settings.width) document.documentElement.style.setProperty('--sidebar-w', settings.width + 'px');
      if (settings.zoom) document.documentElement.style.zoom = settings.zoom;
      conversationSelectionMode = !!settings.bulk;
      document.getElementById('chatShell').classList.toggle('privacy-mode', !!settings.privacy);
      document.getElementById('chatShell').classList.add('sidebar-open');
      document.getElementById('convoList').appendChild(createConvoItem({
        id: 'marquee', title: longTitle, updatedAt: Date.now() - 4 * 3600000, ...convo,
      }, { nested: !!settings.nested }));
    }, { convo, settings, longTitle });
    if (fast) await page.addStyleTag({ content: '.convo-title-text { animation-duration: 900ms !important; }' });
    await run(page);
  } finally {
    await page.close();
  }
}

// Observe the actual first cycle. Seeking or pausing can hide stale compositor endpoints.
async function assertFirstCycleEnd(page) {
  await page.waitForFunction(() => {
    const title = document.querySelector('.convo-title');
    const text = title.firstElementChild;
    const animation = text.getAnimations().find((entry) => entry.animationName === 'convo-title-marquee');
    if (!animation) return false;
    const { delay, duration } = animation.effect.getTiming();
    const range = document.createRange();
    range.selectNodeContents(text);
    const inset = title.getBoundingClientRect().right - range.getBoundingClientRect().right;
    const scale = title.getBoundingClientRect().width / parseFloat(getComputedStyle(title).width);
    const padding = parseFloat(getComputedStyle(text).paddingInlineEnd) * scale;
    return animation.currentTime >= delay + duration * 0.86 &&
      animation.currentTime < delay + duration && Math.abs(inset - padding) < 1;
  }, null, { timeout: 6000, polling: 'raf' }).catch(async (error) => {
    error.message += '\n' + JSON.stringify(await page.locator('.convo-title-text').evaluate((text) => {
      const range = document.createRange();
      range.selectNodeContents(text);
      return {
        clip: text.parentElement.getBoundingClientRect().width,
        text: range.getBoundingClientRect().width,
        inset: text.parentElement.getBoundingClientRect().right - range.getBoundingClientRect().right,
        transform: getComputedStyle(text).transform,
        hovered: text.closest('.convo-item').matches(':hover'),
        animations: text.getAnimations().map((entry) => ({ name: entry.animationName, time: entry.currentTime })),
      };
    }));
    throw error;
  });
}

async function assertRenderedTail(page) {
  const clip = await page.locator('.convo-title').evaluate((title) => {
    const rect = title.getBoundingClientRect();
    return { x: rect.right - 64, y: rect.top, width: 64, height: rect.height };
  });
  const directory = process.env.MARQUEE_SCREENSHOT_DIR;
  if (directory) mkdirSync(directory, { recursive: true });
  const actual = await page.screenshot({ clip, ...(directory ? { path: join(directory, 'marquee-tail-animated.png') } : {}) });
  const reference = await page.addStyleTag({ content:
    '.convo-title-text { animation: none !important; margin-left: 100%; transform: translateX(-100%); }',
  });
  try {
    const expected = await page.screenshot({ clip, ...(directory ? { path: join(directory, 'marquee-tail-static.png') } : {}) });
    const difference = await page.evaluate(async ({ actual, expected }) => {
      const pixels = async (base64) => {
        const image = new Image();
        image.src = 'data:image/png;base64,' + base64;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [a, b] = await Promise.all([pixels(actual), pixels(expected)]);
      let difference = 0;
      for (let i = 0; i < a.length; i++) difference += Math.abs(a[i] - b[i]);
      return difference / (a.length * 255);
    }, { actual: actual.toString('base64'), expected: expected.toString('base64') });
    assert.ok(difference < 0.002, 'the first-cycle ending must match the static ending, allowing font antialiasing: ' + difference);
  } finally {
    await reference.evaluate((style) => style.remove());
  }
}

test('first and second hover reveal the same complete title in the production sidebar', browserOptions, async () => {
  await withSidebar(async (page) => {
    for (let pass = 0; pass < 2; pass++) {
      await page.locator('.convo-title').hover();
      await assertFirstCycleEnd(page);
      if (pass === 0 && process.env.MARQUEE_SCREENSHOT_DIR) {
        mkdirSync(process.env.MARQUEE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.MARQUEE_SCREENSHOT_DIR, 'sidebar-first-hover.png') });
      }
      await assertRenderedTail(page);
      await page.mouse.move(600, 400);
      assert.equal(await page.locator('.convo-title-text').evaluate((text) => getComputedStyle(text).textOverflow), 'ellipsis');
      assert.equal(await page.locator('.convo-title-text').evaluate((text) => text.getAnimations().length), 0);
    }
  }, { fast: false });
});

test('first hover accounts for sidebar sizes, font scales, zoom, and row adornments', browserOptions, async () => {
  const variants = [
    { width: 208, scale: 'compact', convo: { pinned: true, unread: true, incognito: true } },
    { width: 352, scale: 'large', convo: { id: 'active' } },
    { width: 284, zoom: 1.25, nested: true },
    { width: 284, zoom: 0.8, bulk: true },
    { viewport: { width: 390, height: 844 }, scale: 'large', convo: { botId: 'research', botKind: 'dm' }, privacy: true },
  ];
  for (const settings of variants) await withSidebar(async (page) => {
    await page.locator('.convo-title').hover();
    await assertFirstCycleEnd(page);
    if (settings.convo?.botId) assert.equal(await page.locator('.convo-handle').evaluate((handle) => getComputedStyle(handle).transform), 'none');
  }, settings);
});

test('live width, text, and font changes remain correct during the first cycle', browserOptions, async () => {
  await withSidebar(async (page) => {
    await page.locator('.convo-title').hover();
    await page.locator('.convo-title-text').evaluate((text) => {
      text.textContent += ' with Detailed Instructions';
      text.style.fontFamily = 'monospace';
      text.style.fontWeight = '700';
      document.documentElement.dataset.fontScale = 'large';
      document.documentElement.style.setProperty('--sidebar-w', '220px');
    });
    await assertFirstCycleEnd(page);
  });
});

test('short titles stay still and near-fit titles clear the expanding action button', browserOptions, async () => {
  await withSidebar(async (page) => {
    await page.locator('.convo-title').hover();
    await page.waitForTimeout(1150);
    assert.ok(await page.locator('.convo-title-text').evaluate((text) =>
      Math.abs(text.getBoundingClientRect().left - text.parentElement.getBoundingClientRect().left) < 0.5));
    await page.mouse.move(600, 400);
    await page.waitForTimeout(400);
    await page.locator('.convo-title-text').evaluate((text) => {
      text.textContent = 'A nearly full conversation title';
      const range = document.createRange();
      range.selectNodeContents(text);
      const sidebar = document.getElementById('chatSidebar');
      const clip = text.parentElement;
      document.documentElement.style.setProperty('--sidebar-w',
        sidebar.getBoundingClientRect().width + range.getBoundingClientRect().width + 10 - clip.getBoundingClientRect().width + 'px');
    });
    await page.waitForTimeout(400);
    await page.locator('.convo-title').hover();
    await assertFirstCycleEnd(page);
  }, { convo: { title: 'Short title' } });
});

test('generated titles begin their first complete cycle when actual typing finishes', browserOptions, async () => {
  await withSidebar(async (page) => {
    await page.locator('.convo-title').evaluate((title, text) => typeTitleInto(title, text), longTitle);
    await page.locator('.convo-title').hover();
    assert.equal(await page.locator('.convo-title-text').evaluate((text) => text.getAnimations().filter((animation) => animation.animationName === 'convo-title-marquee').length), 0);
    await page.waitForFunction(() => !document.querySelector('.convo-title').classList.contains('is-typing-title'));
    await assertFirstCycleEnd(page);
  });
});

test('a row redrawn beneath a stationary pointer starts its first complete cycle', browserOptions, async () => {
  await withSidebar(async (page) => {
    await page.locator('.convo-title').hover();
    await page.locator('.convo-item').evaluate((item, title) => {
      item.replaceWith(createConvoItem({ id: 'replacement', title, updatedAt: Date.now() }));
    }, longTitle);
    await assertFirstCycleEnd(page);
  });
});

test('keyboard focus scrolls without hover and keeps scrolling after the pointer leaves', browserOptions, async () => {
  await withSidebar(async (page) => {
    await page.locator('.convo-more').focus();
    await assertFirstCycleEnd(page);
    await page.locator('.convo-title').hover();
    await page.mouse.move(600, 400);
    assert.equal(await page.locator('.convo-title-text').evaluate((text) => text.getAnimations().length), 1);
    await page.locator('.convo-more').evaluate((button) => button.blur());
    assert.equal(await page.locator('.convo-title-text').evaluate((text) => text.getAnimations().filter((entry) => entry.animationName === 'convo-title-marquee').length), 0);
  });
});

test('reduced motion keeps ellipsis and responds to preference changes while hovered', browserOptions, async () => {
  await withSidebar(async (page) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.convo-title').hover();
    assert.equal(await page.locator('.convo-title-text').evaluate((text) => text.getAnimations().filter((entry) => entry.animationName === 'convo-title-marquee').length), 0);
    assert.equal(await page.locator('.convo-title-text').evaluate((text) => getComputedStyle(text).textOverflow), 'ellipsis');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await assertFirstCycleEnd(page);
  });
});
