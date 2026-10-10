const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../src/ui/chat/scripts/state.js'), 'utf8');
const helpers = source.slice(source.indexOf('const backdropFocusStack = []'),
  source.indexOf('let confirmDangerResolver'));

function harness() {
  const callbacks = [];
  const paints = [];
  const document = { activeElement: null, body: {}, addEventListener() {} };
  const context = vm.createContext({
    document, getComputedStyle: (node) => ({ visibility: node.visibility || 'visible' }),
    window: { setTimeout: (fn) => callbacks.push(fn) },
    afterNextPaint: (fn) => paints.push(fn), prefersReducedMotion: () => false,
  });
  vm.runInContext(helpers, context);
  function element(id, parent = null) {
    const classes = new Set(['is-hidden']);
    const node = {
      id, parent, dataset: {}, inert: false, isConnected: true, tabIndex: 0,
      children: [], disabled: false, visible: true,
      classList: {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      contains(other) { return other === node || node.children.includes(other); },
      querySelectorAll: () => node.children,
      getClientRects: () => node.visible ? [{}] : [],
      matches: () => node.disabled,
      closest(selector) {
        if (selector.includes('[inert]') && (node.inert || parent?.inert)) return node;
        if (selector.includes('.is-hidden') && (classes.has('is-hidden')
            || parent?.classList.contains('is-hidden'))) return node;
        return null;
      },
      setAttribute() {}, addEventListener() {}, removeEventListener() {},
      focus() { document.activeElement = node; },
    };
    if (parent) { parent.children.push(node); classes.clear(); }
    return node;
  }
  function key(value, shiftKey = false, ctrlKey = false) {
    const event = { key: value, shiftKey, ctrlKey, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
    };
    context.handleBackdropKeydown(event);
    return event;
  }
  const trigger = element('trigger');
  trigger.classList.remove('is-hidden');
  trigger.focus();
  return { context, document, callbacks, paints, element, key, trigger };
}

test('Tab and Shift+Tab wrap around visible, enabled dialog controls', () => {
  const h = harness();
  const modal = h.element('settingsModal');
  const first = h.element('first', modal);
  const hidden = h.element('hidden', modal);
  hidden.visibility = 'hidden';
  const disabled = h.element('disabled', modal);
  disabled.disabled = true;
  const last = h.element('last', modal);
  h.context.openBackdrop(modal);
  h.paints.shift()();
  assert.equal(h.document.activeElement, first);
  last.focus();
  assert.equal(h.key('Tab').defaultPrevented, true);
  assert.equal(h.document.activeElement, first);
  h.key('Tab', true);
  assert.equal(h.document.activeElement, last);
  first.focus();
  assert.equal(h.key('Tab').defaultPrevented, false);
});

test('dialogs without enabled controls retain focus instead of escaping', () => {
  const h = harness();
  const modal = h.element('unlockModal');
  h.context.openBackdrop(modal);
  h.key('Tab');
  assert.equal(h.document.activeElement, modal);
});

test('Escape dismisses only the top confirmation and returns focus to Settings', () => {
  const h = harness();
  const settings = h.element('settingsModal');
  const deleteButton = h.element('delete', settings);
  const confirm = h.element('confirmModal');
  const cancel = h.element('cancel', confirm);
  h.context.openBackdrop(settings);
  deleteButton.focus();
  h.context.openBackdrop(confirm);
  cancel.focus();
  let result;
  h.context.settleConfirmDanger = (ok) => { result = ok; h.context.closeBackdrop(confirm); };
  assert.equal(h.key('Escape').stopped, true);
  assert.equal(result, false);
  assert.equal(h.document.activeElement, deleteButton);
  h.context.closeBackdrop(settings);
  assert.equal(h.document.activeElement, h.trigger);
});

test('closing a dialog preserves focus moved by navigation and prevents closing-animation races', () => {
  const h = harness();
  const modal = h.element('searchModal');
  const input = h.element('search', modal);
  const destination = h.element('composer');
  destination.classList.remove('is-hidden');
  h.context.openBackdrop(modal);
  input.focus();
  destination.focus();
  h.context.closeBackdrop(modal);
  assert.equal(h.document.activeElement, destination);
  assert.equal(modal.inert, true);
  h.context.openBackdrop(modal);
  h.callbacks.shift()();
  assert.equal(modal.classList.contains('is-hidden'), false);
  assert.equal(modal.inert, false);
});

test('search shortcuts cannot open another dialog over an active edit or confirmation', () => {
  const h = harness();
  h.context.openBackdrop(h.element('projectModal'));
  assert.equal(h.key('k', false, true).stopped, true);
});

test('removing an underlying dialog still restores its original trigger', () => {
  const h = harness();
  const settings = h.element('settingsModal');
  const control = h.element('control', settings);
  const confirm = h.element('confirmModal');
  const cancel = h.element('cancel', confirm);
  h.context.openBackdrop(settings);
  control.focus();
  h.context.openBackdrop(confirm);
  cancel.focus();
  h.context.closeBackdrop(settings);
  h.context.closeBackdrop(confirm);
  assert.equal(h.document.activeElement, h.trigger);
});
