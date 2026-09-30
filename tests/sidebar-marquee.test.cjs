const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../src/ui/chat/scripts/render.js'), 'utf8');
const bind = source.match(/function bindConvoTitleMarquee\(\)[\s\S]*?\r?\n\}/)[0];

function fixture({ width = 240, textWidth = 300, fontSize = 16 } = {}) {
  const classes = new Set();
  const styles = new Map();
  const events = {};
  const observed = new Set();
  const activations = [];
  const frames = [];
  const html = {};
  let notify;
  let mutate;
  const item = {
    hovered: true,
    focused: false,
    classList: {
      add: (name) => {
        activations.push({ distance: styles.get('--marquee-distance'), duration: styles.get('--marquee-duration') });
        classes.add(name);
      },
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    querySelector: () => title,
    closest: () => item,
    contains: (target) => target === item || target === title || target === text,
    matches: () => item.hovered || item.focused,
  };
  const padding = () => classes.has('can-marquee-title') ? fontSize / 2 : 0;
  const text = {
    get scrollWidth() { return Math.max(textWidth + padding(), title.width); },
    getBoundingClientRect: () => ({ width: textWidth + padding() }),
    style: {
      setProperty: (name, value) => styles.set(name, value),
      removeProperty: (name) => styles.delete(name),
    },
  };
  const title = {
    width,
    typing: false,
    querySelector: () => text,
    classList: { contains: () => title.typing },
    getBoundingClientRect: () => ({ width: title.width }),
    closest: () => item,
    matches: () => true,
  };
  const nav = {
    contains: (target) => target === item,
    querySelectorAll: () => item.hovered || item.focused ? [item] : [],
    addEventListener: (name, handler) => { events[name] = handler; },
  };
  const context = vm.createContext({
    document: { getElementById: () => nav, documentElement: html },
    window: { matchMedia: () => ({ matches: false }) },
    getComputedStyle: (target) => target === html
      ? { fontSize: fontSize + 'px' }
      : { paddingInlineEnd: padding() + 'px' },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    ResizeObserver: class {
      constructor(callback) { notify = callback; }
      observe(target) { observed.add(target); }
      unobserve(target) { observed.delete(target); }
    },
    MutationObserver: class {
      constructor(callback) { mutate = callback; }
      observe() {}
    },
  });
  vm.runInContext('let convoTitleMarqueeBound = false;\n' + bind, context);
  context.bindConvoTitleMarquee();
  return {
    item, title, classes, styles, observed, activations,
    enter: () => events.pointerover({ target: item, relatedTarget: null }),
    leave: () => events.pointerout({ target: item, relatedTarget: null }),
    focus: () => events.focusin({ target: item }),
    blur: () => events.focusout({ target: item, relatedTarget: null }),
    flushFrame: () => frames.splice(0).forEach((callback) => callback()),
    finishTyping: () => {
      title.typing = false;
      mutate([{ type: 'attributes', target: title }]);
    },
    updateText: (width) => {
      textWidth = width;
      mutate([{ type: 'characterData', target: text }]);
    },
    resize: (nextWidth) => {
      title.width = nextWidth;
      notify([{ target: title }]);
    },
  };
}

test('marquee endpoint follows the clip width as hover controls expand and the sidebar resizes', () => {
  const state = fixture();
  state.enter();
  assert.equal(state.styles.get('--marquee-distance'), '-68px');
  state.resize(218.4);
  assert.equal(state.styles.get('--marquee-distance'), '-90px');
  state.resize(170);
  assert.equal(state.styles.get('--marquee-distance'), '-138px');
});

test('a title that fits before hover starts scrolling after controls consume its remaining space', () => {
  const state = fixture({ width: 310 });
  state.enter();
  assert.equal(state.classes.has('can-marquee-title'), false);
  assert.equal(state.observed.has(state.title), true);
  state.resize(288.4);
  assert.equal(state.classes.has('can-marquee-title'), true);
  assert.equal(state.styles.get('--marquee-distance'), '-20px');
  state.resize(340);
  assert.equal(state.classes.has('can-marquee-title'), false);
  assert.equal(state.styles.has('--marquee-distance'), false);
});

test('title observation survives keyboard focus and stops when the row is inactive', () => {
  const state = fixture();
  state.enter();
  state.item.hovered = false;
  state.item.focused = true;
  state.focus();
  state.leave();
  assert.equal(state.observed.has(state.title), true);
  state.resize(218);
  assert.equal(state.styles.get('--marquee-distance'), '-90px');
  state.item.focused = false;
  state.blur();
  assert.equal(state.observed.size, 0);
});

test('the first hover configures the distance before starting the animation', () => {
  const state = fixture();
  state.enter();
  assert.equal(state.activations[0].distance, '-68px');
  assert.match(state.activations[0].duration, /^\d+\.\d+s$/);
});

test('the first resize stays armed even before the native hover selector updates', () => {
  const state = fixture();
  state.item.hovered = false;
  state.enter();
  state.resize(218.4);
  assert.equal(state.observed.has(state.title), true);
  assert.equal(state.styles.get('--marquee-distance'), '-90px');
});

test('hovering during title generation starts the marquee when typing finishes without another hover', () => {
  const state = fixture();
  state.title.typing = true;
  state.enter();
  state.flushFrame();
  assert.equal(state.observed.has(state.title), true);
  assert.equal(state.classes.has('can-marquee-title'), false);
  state.finishTyping();
  state.flushFrame();
  assert.equal(state.classes.has('can-marquee-title'), true);
  assert.equal(state.styles.get('--marquee-distance'), '-68px');
});

test('a title changed under a stationary pointer is remeasured without a viewport resize', () => {
  const state = fixture({ textWidth: 200 });
  state.enter();
  state.flushFrame();
  assert.equal(state.classes.has('can-marquee-title'), false);
  state.updateText(360);
  state.flushFrame();
  assert.equal(state.classes.has('can-marquee-title'), true);
  assert.equal(state.styles.get('--marquee-distance'), '-128px');
});

test('the tail inset follows the selected font scale on the first hover', () => {
  const state = fixture({ fontSize: 20 });
  state.enter();
  assert.equal(state.activations[0].distance, '-70px');
});

// NODE_PATH can point to an installed Playwright package for real hover coverage.
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Report missing browser coverage. */ }
const browserOptions = { skip: !chromium && 'Playwright is required for hover browser tests' };
const rowHtml = '<div class="convo-item"><span class="convo-title"><span class="convo-title-text">' +
  'Remove Toilet Bowl Stains Without Brushing — A Complete Cleaning Guide</span></span>' +
  '<time class="convo-age">4h</time><button class="convo-more" aria-label="Conversation actions">…</button></div>';
async function withSidebar(run) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.MARQUEE_BROWSER_CHANNEL ? { channel: process.env.MARQUEE_BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="sidebarNav" style="width:252px;margin:30px">' + rowHtml + '</div>');
    await page.addStyleTag({ path: join(__dirname, '../src/ui/chat/styles/base.css') });
    await page.addScriptTag({ content: 'let convoTitleMarqueeBound = false;\n' + bind + '\nbindConvoTitleMarquee();' });
    await run(page);
  } finally {
    await browser.close();
  }
}
async function assertMoving(page) {
  await page.waitForFunction(() => {
    const text = document.querySelector('.convo-title-text');
    return new DOMMatrixReadOnly(getComputedStyle(text).transform).m41 < -1;
  }, null, { timeout: 1000 });
}

test('a fresh first hover visibly moves within one second and clears the final glyph', browserOptions, async () => {
  await withSidebar(async (page) => {
    await page.locator('.convo-title').hover();
    await assertMoving(page);
    const endpoint = await page.evaluate(() => {
      const title = document.querySelector('.convo-title');
      const text = title.firstElementChild;
      const animation = text.getAnimations()[0];
      animation.pause();
      animation.currentTime = animation.effect.getTiming().delay + animation.effect.getTiming().duration;
      const range = document.createRange();
      range.selectNodeContents(text);
      return {
        inset: title.getBoundingClientRect().right - range.getBoundingClientRect().right,
        textWidth: range.getBoundingClientRect().width,
        viewport: title.getBoundingClientRect().width,
        distance: text.style.getPropertyValue('--marquee-distance'),
        transform: getComputedStyle(text).transform,
      };
    });
    assert.ok(endpoint.inset >= 7, 'the trailing glyph should clear the clip boundary: ' + JSON.stringify(endpoint));
  });
});

test('a title that finishes typing under the pointer starts moving without another hover', browserOptions, async () => {
  await withSidebar(async (page) => {
    await page.locator('.convo-title').evaluate((title) => title.classList.add('is-typing-title'));
    await page.locator('.convo-title').hover();
    assert.equal(await page.locator('.convo-title-text').evaluate((text) => text.getAnimations().length), 0);
    await page.locator('.convo-title').evaluate((title) => title.classList.remove('is-typing-title'));
    await assertMoving(page);
  });
});

test('a sidebar row replaced beneath a stationary pointer restarts without leaving and reentering', browserOptions, async () => {
  await withSidebar(async (page) => {
    await page.locator('.convo-title').hover();
    await assertMoving(page);
    await page.locator('#sidebarNav').evaluate((nav, html) => { nav.innerHTML = html; }, rowHtml);
    await assertMoving(page);
    assert.equal(await page.locator('.convo-item').evaluate((item) => item.classList.contains('can-marquee-title')), true);
  });
});
