// Run without compiling the app: node --test tests/model-menu-anchor.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const runtime = readFileSync(
  join(root, 'src/ui/chat/scripts/runtime.js'),
  'utf8'
).replace(/\r\n/g, '\n');
const state = readFileSync(
  join(root, 'src/ui/chat/scripts/state.js'),
  'utf8'
).replace(/\r\n/g, '\n');
const bots = readFileSync(
  join(root, 'src/ui/chat/scripts/bots.js'),
  'utf8'
).replace(/\r\n/g, '\n');
const render = readFileSync(
  join(root, 'src/ui/chat/scripts/render.js'),
  'utf8'
).replace(/\r\n/g, '\n');

function declaration(source, name) {
  const match = source.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
  assert.ok(match, 'missing function ' + name);
  return match[0];
}

test('unified model ordering is deduplicated and search ranks model names first', () => {
  const context = vm.createContext({
    modelMenuOptions: [
      { value: 'a', label: 'Other', provider: 'Nova' },
      { value: 'b', label: 'Nova fast', provider: 'Remote' },
      { value: 'c', label: 'Local model', provider: 'Desktop' },
    ],
    selectedChatModel: 'c', pinnedModelIds: ['a'], recentModelIds: ['b', 'a'],
    modelMenuFilter: '', modelMenuMatches: [],
    modelMenuSelectedId: () => 'c',
  });
  for (const name of [
    'modelFilterTerms',
    'orderedUnifiedModelOptions',
    'modelMenuSourceOptions',
    'computeModelMatches',
  ]) {
    vm.runInContext(declaration(runtime, name), context);
  }
  context.computeModelMatches();
  assert.equal(context.modelMenuMatches.map((item) => item.value).join(','), 'c,a,b');
  context.modelMenuFilter = 'nova';
  context.computeModelMatches();
  assert.equal(context.modelMenuMatches.map((item) => item.value).join(','), 'b,a');
});
test('unified sections keep priority groups and then identify the provider', () => {
  const context = vm.createContext({
    pinnedModelIds: ['pin'],
    recentModelIds: ['recent'],
    modelMenuSelectedId: () => 'current',
    isModelPinned: (value) => value === 'pin',
  });
  for (const name of ['modelProviderKey', 'modelProviderLabel', 'modelMenuSection']) {
    vm.runInContext(declaration(runtime, name), context);
  }
  assert.equal(context.modelMenuSection({ value: 'current', provider: 'OpenRouter' }), 'current');
  assert.equal(context.modelMenuSection({ value: 'pin', provider: 'OpenRouter' }), 'pinned');
  assert.equal(context.modelMenuSection({ value: 'recent', provider: 'OpenRouter' }), 'recent');
  assert.equal(
    context.modelMenuSection({ value: 'other', providerId: 'openrouter', provider: 'OpenRouter' }),
    'provider:openrouter'
  );
});

test('model rows use one cube marker and omit redundant cloud badges', () => {
  const renderer = declaration(runtime, 'renderModelOptionHtml');
  assert.match(renderer, /chat-model-option-icon/);
  assert.doesNotMatch(renderer, /chat-model-option-rail/);
  assert.doesNotMatch(renderer, /Cloud/);
  assert.match(renderer, /localityBadge/);
});

test('typing selects the first search result so Enter can choose it', () => {
  const context = vm.createContext({
    modelMenuActiveIndex: -1,
    visibleModelMenuOptions: () => [{ value: 'first' }, { value: 'selected' }],
    modelMenuSelectedId: () => 'selected', modelFilterTerms: () => ['first'],
    computeModelMatches() {}, renderModelMenuList() {}, paintModelMenuActive() {},
    modelMenuIsOpen: () => false,
  });
  vm.runInContext(declaration(runtime, 'applyModelFilter'), context);
  context.applyModelFilter();
  assert.equal(context.modelMenuActiveIndex, 0);
});

test('removing the last pin keeps the unified list open and reranks it', () => {
  let reranked = false;
  const context = vm.createContext({
    pinnedModelIds: ['only'],
    isModelPinned: (value) => value === 'only',
    savePinnedModelIds(ids) { context.pinnedModelIds = ids; },
    modelMenuIsOpen: () => true,
    applyModelFilter() { reranked = true; },
  });
  vm.runInContext(declaration(state, 'togglePinnedModel'), context);
  context.togglePinnedModel('only');
  assert.deepEqual([...context.pinnedModelIds], []);
  assert.equal(reranked, true);
});

test('the shared model menu rejects detached and hidden anchors', () => {
  const context = vm.createContext({});
  vm.runInContext(declaration(runtime, 'modelMenuAnchorIsUsable'), context);
  const visible = {
    isConnected: true,
    getBoundingClientRect() { return { top: 10, left: 20 }; },
    getClientRects() { return [{}]; },
  };
  assert.equal(context.modelMenuAnchorIsUsable(visible), true);
  assert.equal(context.modelMenuAnchorIsUsable({ ...visible, isConnected: false }), false);
  assert.equal(context.modelMenuAnchorIsUsable({
    ...visible,
    getClientRects() { return []; },
  }), false);
});

test('stream state does not invalidate an unchanged Loops member list', () => {
  const context = vm.createContext({
    loopModelTriggerLabel: (model) => 'Label for ' + model,
    JSON,
  });
  vm.runInContext(declaration(bots, 'traceMembersRenderSignature'), context);
  const members = [{
    id: 'agent-1',
    handle: 'reviewer',
    name: '@reviewer',
    model: 'provider/model-a',
    stage: 'challenge',
    description: 'Challenge assumptions',
  }];
  const before = context.traceMembersRenderSignature({ id: 'loop-1', loopRun: { phaseIndex: 0 } }, members);
  const during = context.traceMembersRenderSignature({ id: 'loop-1', loopRun: { phaseIndex: 2 } }, members);
  assert.equal(before, during);

  const changed = context.traceMembersRenderSignature(
    { id: 'loop-1' },
    [{ ...members[0], model: 'provider/model-b' }]
  );
  assert.notEqual(before, changed);
});

test('switching from Loops repaints the shared description with the Agent model', () => {
  let surface = 'bots';
  const modelHintEl = {
    textContent: '',
    classList: { remove() {} },
  };
  const context = vm.createContext({
    serverReady: true,
    modelHintEl,
    activeId: null,
    activeProjectId: null,
    selectedRemoteModel() {
      return { model: 'agent-model', provider_name: 'Agent Provider' };
    },
    paintLoopModelHint() {
      if (surface !== 'bots') return false;
      modelHintEl.textContent = '@solver · loop-model';
      return true;
    },
    inProjectChat: () => false,
    getProject: () => null,
    isIncognitoContext: () => false,
    setModelHintWithProvider(prefix, provider) {
      modelHintEl.textContent = prefix + ' via ' + provider;
    },
  });
  vm.runInContext(declaration(runtime, 'paintReadyInferenceModelHint'), context);

  context.paintReadyInferenceModelHint({ network: {} });
  assert.equal(modelHintEl.textContent, '@solver · loop-model');

  surface = 'chat';
  context.paintReadyInferenceModelHint({ network: {} });
  assert.equal(modelHintEl.textContent, 'Chatting with agent-model via Agent Provider');
  assert.match(render, /paintReadyInferenceModelHint\(latestState\)/);
});
