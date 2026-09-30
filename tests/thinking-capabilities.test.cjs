const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const controls = readFileSync(join(root, 'src/ui/chat/scripts/controls.js'), 'utf8').replace(/\r\n/g, '\n');
const state = readFileSync(join(root, 'src/ui/chat/scripts/state.js'), 'utf8').replace(/\r\n/g, '\n');

function declaration(source, name) {
  const match = source.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
  assert.ok(match, 'missing function ' + name);
  return match[0];
}

function element(tagName = 'div') {
  return {
    tagName, dataset: {}, attributes: {}, children: [], textContent: '', style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(...children) { this.children = children; this.replacements = (this.replacements || 0) + 1; },
    querySelectorAll(selector) { return this.children.filter((child) => selector === 'option' ? child.tagName === 'option' : child.dataset.effort); },
    closest() { return { style: {} }; },
  };
}

function harness(wanted = 'auto') {
  const elements = Object.fromEntries([
    'thinkMenu', 'settingThinkingEffort', 'composerThinkWrap', 'btnThink', 'btnThinkEffort',
  ].map((id) => [id, element()]));
  const context = vm.createContext({
    settings: { thinkingEffort: wanted },
    thinkingSupported: false, activeThinkingEffort: 'auto', availableThinkingEfforts: new Set(['auto']),
    document: { getElementById: (id) => elements[id], createElement: element },
    setThinkMenuOpen() {}, requireUnlockedData: () => true,
    saveSettings(next) { context.settings = { ...next, thinkingEffort: context.normalizeThinkingEffort(next.thinkingEffort) }; },
  });
  vm.runInContext(declaration(state, 'normalizeThinkingEffort'), context);
  for (const name of [
    'modelExposesThinkingControl', 'thinkingEffortForModel', 'renderThinkingEffortOptions',
    'syncThinkingEffortControls', 'syncComposerThinkVisibility', 'setThinkingEffort',
  ]) vm.runInContext(declaration(controls, name), context);
  return { context, elements };
}

test('composer and settings offer all advertised levels, including future provider values', () => {
  const { context, elements } = harness();
  const model = { thinking_control: 'reasoning', thinking_efforts: ['minimal', 'xhigh', 'provider-future-tier'], thinking_can_disable: true };
  context.syncComposerThinkVisibility(model);
  assert.deepEqual(elements.thinkMenu.children.filter((item) => item.dataset.effort).map((item) => item.dataset.effort),
    ['auto', 'off', 'minimal', 'xhigh', 'provider-future-tier']);
  assert.deepEqual(elements.settingThinkingEffort.children.map((item) => item.value),
    ['auto', 'off', 'minimal', 'xhigh', 'provider-future-tier']);
  context.setThinkingEffort('provider-future-tier');
  assert.equal(context.settings.thinkingEffort, 'provider-future-tier');
  assert.equal(elements.btnThinkEffort.textContent, 'provider-future-tier');
  assert.equal(context.thinkingEffortForModel(model), 'provider-future-tier');
  context.syncComposerThinkVisibility(model);
  assert.equal(elements.thinkMenu.replacements, 1, 'polling must not replace focused menu items');
});

test('switching models keeps the saved preference but never sends an unsupported level', () => {
  const { context, elements } = harness('xhigh');
  const powerful = { thinking_control: 'reasoning', thinking_efforts: ['high', 'xhigh'] };
  const limited = { thinking_control: 'reasoning_effort', thinking_efforts: ['low', 'high'] };
  context.syncComposerThinkVisibility(powerful);
  assert.equal(context.activeThinkingEffort, 'xhigh');
  context.syncComposerThinkVisibility(limited);
  assert.equal(context.activeThinkingEffort, 'auto');
  assert.equal(context.settings.thinkingEffort, 'xhigh');
  assert.equal(context.thinkingEffortForModel(limited), null);
  assert.deepEqual(elements.settingThinkingEffort.children.map((item) => item.value), ['auto', 'low', 'high']);
  context.syncComposerThinkVisibility(powerful);
  assert.equal(context.activeThinkingEffort, 'xhigh');
  assert.equal(context.thinkingEffortForModel(powerful), 'xhigh');
});

test('off is available only when explicitly allowed, and unknown capabilities do not invent levels', () => {
  const { context, elements } = harness('off');
  const mandatory = { thinking_control: 'reasoning', thinking_efforts: ['xhigh'], thinking_can_disable: false };
  context.syncComposerThinkVisibility(mandatory);
  assert.equal(context.availableThinkingEfforts.has('off'), false);
  assert.equal(context.thinkingEffortForModel(mandatory), null);
  const optional = { ...mandatory, thinking_can_disable: true };
  context.syncComposerThinkVisibility(optional);
  assert.equal(context.thinkingEffortForModel(optional), 'off');
  context.syncComposerThinkVisibility({ thinking_supported: true });
  assert.deepEqual(elements.settingThinkingEffort.children.map((item) => item.value), ['auto']);
  assert.equal(context.thinkingSupported, false);
});

test('provider effort labels are inserted as text, with wire spelling preserved', () => {
  const { context, elements } = harness();
  const value = '<img src=x onerror=alert(1)>';
  const model = { thinking_control: 'reasoning', thinking_efforts: [value] };
  context.syncComposerThinkVisibility(model);
  assert.equal(elements.settingThinkingEffort.children[1].textContent, value);
  assert.equal(elements.settingThinkingEffort.children[1].children.length, 0);
  context.setThinkingEffort(value);
  assert.equal(context.thinkingEffortForModel(model), value);
});

test('saved efforts survive normalization without a fixed list of known levels', () => {
  const { context } = harness();
  for (const effort of ['xhigh', 'minimal', 'provider-future-tier', 'ProviderCase']) {
    assert.equal(context.normalizeThinkingEffort(effort), effort);
  }
  assert.equal(context.normalizeThinkingEffort(' xhigh '), 'xhigh');
  for (const invalid of [null, undefined, 42, {}, '', '  ']) {
    assert.equal(context.normalizeThinkingEffort(invalid), 'auto');
  }
});
