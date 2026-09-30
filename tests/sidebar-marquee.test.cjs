const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../src/ui/chat/scripts/render.js'), 'utf8');
const bind = source.match(/function bindConvoTitleMarquee\(\)[\s\S]*?\r?\n\}/)[0];

function fixture({ width = 240, textWidth = 300 } = {}) {
  const classes = new Set();
  const styles = new Map();
  const events = {};
  const observed = new Set();
  let notify;
  const item = {
    hovered: true,
    focused: false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    querySelector: () => title,
    closest: () => item,
    contains: (target) => target === item || target === title || target === text,
    matches: () => item.hovered || item.focused,
  };
  const padding = () => classes.has('can-marquee-title') ? 8 : 0;
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
    querySelector: () => text,
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ width: title.width }),
    closest: () => item,
  };
  const nav = {
    contains: (target) => target === item,
    addEventListener: (name, handler) => { events[name] = handler; },
  };
  const context = vm.createContext({
    document: { getElementById: () => nav },
    window: { matchMedia: () => ({ matches: false }) },
    getComputedStyle: () => ({ paddingInlineEnd: padding() + 'px' }),
    requestAnimationFrame: (callback) => callback(),
    ResizeObserver: class {
      constructor(callback) { notify = callback; }
      observe(target) { observed.add(target); }
      unobserve(target) { observed.delete(target); }
    },
  });
  vm.runInContext('let convoTitleMarqueeBound = false;\n' + bind, context);
  context.bindConvoTitleMarquee();
  return {
    item, title, classes, styles, observed,
    enter: () => events.pointerover({ target: item, relatedTarget: null }),
    leave: () => events.pointerout({ target: item, relatedTarget: null }),
    focus: () => events.focusin({ target: item }),
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
  state.leave();
  assert.equal(state.observed.has(state.title), true);
  state.focus();
  state.resize(218);
  assert.equal(state.styles.get('--marquee-distance'), '-90px');
  state.item.focused = false;
  state.leave();
  assert.equal(state.observed.size, 0);
});
