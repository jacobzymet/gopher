const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../src/ui/chat/scripts/state.js'), 'utf8');
const runtime = readFileSync(join(__dirname, '../src/ui/chat/scripts/runtime.js'), 'utf8');
function declaration(text, name) {
  const match = text.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(match, 'missing ' + name);
  return match[0];
}

function harness(fetch) {
  const restored = { selectedChatModel: 'deepseek-v4-flash-0731', chatBackgroundImage: 'saved-photo' };
  const profile = { id: 'personal', conversations: [], _contextPresent: true };
  const node = { classList: { toggle() {} }, textContent: '' };
  const calls = [];
  const state = vm.createContext({
    fetch, AbortController,
    setTimeout(fn, ms) { if (ms < 15000) queueMicrotask(fn); return 1; }, clearTimeout() {},
    settings: restored, storageReady: false, localDataLoadError: '', dataInfo: null,
    profiles: [], activeProfileId: 'personal', conversations: [], projects: [], bots: [],
    DEFAULT_PROFILE_ID: 'personal', DEFAULT_SETTINGS: {},
    document: { getElementById: () => node, documentElement: { classList: { add() {} } } },
    diskEncryptionLocked() { return !!(state.dataInfo?.encryption_enabled && !state.dataInfo.encryption_unlocked); },
    parseStorePayload: () => ({ profiles: [profile], activeProfileId: profile.id }),
    normalizeLoadedStore: (store, preferences) => ({ store, preferences }),
    bindActiveProfile() {}, activeProfile: () => profile, normalizeProfile: () => profile,
    hydrateModelPickerState() { calls.push('hydrate'); }, restoreOutboundQueues() {},
    refreshLocalDataPane() {}, syncAccountProfileUi() {}, syncAgentButton() {}, syncResearchControls() {},
    saveStore() { calls.push('save-store'); },
    enqueueSettingsWrite() { calls.push('save-preferences'); }, preferencesPayload() {},
    promptUnlockSession() { calls.push('unlock'); }, updateSendEnabled() {},
    hideUnlockSession() { calls.push('hide-unlock'); }, refreshUiFromMemoryStore() {},
    applySettingsInMemory() { calls.push('apply-settings'); },
  });
  for (const name of ['fetchLocalDataJson', 'showLocalDataLoadError', 'adoptLoadedData',
    'initLocalData', 'loadDiskDataAfterUnlock', 'saveSettings']) {
    vm.runInContext(declaration(source, name), state);
  }
  return { state, restored, calls };
}

function response(value, status = 200) {
  return { ok: status === 200, status, json: async () => value };
}

test('failed preference reads preserve existing memory and keep saving disabled', async () => {
  let attempts = 0;
  const h = harness(async (path) => {
    if (path === '/api/data/preferences') {
      attempts++;
      return response({ error: 'Could not decrypt preferences' }, 500);
    }
    return response({ encryption_enabled: false });
  });
  await h.state.initLocalData();
  assert.equal(attempts, 3);
  assert.equal(h.state.settings, h.restored);
  assert.equal(h.state.storageReady, false);
  assert.equal(h.state.localDataLoadError, 'Could not decrypt preferences');
  assert.deepEqual(h.calls, []);
  assert.equal(await h.state.saveSettings({ selectedChatModel: 'alphabetical-first' }), false);
  assert.deepEqual(h.calls, []);
});

test('transient preference errors retry and restore the saved model and background together', async () => {
  let attempts = 0;
  const saved = { selectedChatModel: 'deepseek-v4-flash-0731', chatBackgroundImage: 'personalized-photo' };
  const h = harness(async (path) => {
    if (path === '/api/data/preferences') {
      if (++attempts === 1) throw new Error('Connection interrupted');
      return response(saved);
    }
    return response({ encryption_enabled: false });
  });
  await h.state.initLocalData();
  assert.equal(attempts, 2);
  assert.equal(h.state.settings, saved);
  assert.equal(h.state.storageReady, true);
  assert.equal(h.state.localDataLoadError, '');
  assert.deepEqual(h.calls, ['hydrate']);
});

test('a session locked during startup prompts for unlock without adopting empty preferences', async () => {
  const h = harness(async (path) => path === '/api/data'
    ? response({ encryption_enabled: false })
    : response({ code: 'encrypted_locked', error: 'Locked' }, 423));
  await h.state.initLocalData();
  assert.equal(h.state.dataInfo.encryption_unlocked, false);
  assert.equal(h.state.storageReady, false);
  assert.ok(h.calls.includes('unlock'));
  assert.equal(h.calls.includes('save-preferences'), false);
});

test('failed reads after unlock cannot enable saving or dismiss the unlock dialog', async () => {
  const h = harness(async (path) => path === '/api/data/preferences'
    ? response({ error: 'Settings unreadable' }, 500) : response({}));
  h.state.storageReady = true;
  await assert.rejects(h.state.loadDiskDataAfterUnlock(), /Settings unreadable/);
  assert.equal(h.state.storageReady, false);
  assert.equal(h.state.settings, h.restored);
  assert.deepEqual(h.calls, []);
});

test('catalog polling cannot select or persist a fallback when local data failed to load', async () => {
  const h = harness(async () => { throw new Error('Server unavailable'); });
  await h.state.initLocalData();
  vm.runInContext(declaration(runtime, 'syncModelSelector'), h.state);
  h.state.syncModelSelector({ network: { remote_models: [{ id: 'alphabetical-first' }] } });
  assert.equal(h.state.storageReady, false);
  assert.equal(h.state.settings.selectedChatModel, h.restored.selectedChatModel);
  assert.deepEqual(h.calls, []);
});
