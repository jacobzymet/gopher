// Run without compiling the app: node --test tests/model-refresh.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../src/ui/chat/scripts/providers.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function harness(providers, probe) {
  const calls = [];
  const status = { textContent: '', classList: { remove() {} } };
  const button = { dataset: {}, disabled: false, textContent: 'Refresh models' };
  const updated = { network: { remote_models: [{ id: 'new-model' }] } };
  let applied = null;
  const context = vm.createContext({
    document: { getElementById: () => status },
    latestState: null,
    async providerApi(path, options) {
      calls.push({ path, options });
      if (!options) return { providers, state: updated };
      return probe(JSON.parse(options.body));
    },
    updateInferenceState(state) { applied = state; context.latestState = state; },
    syncProviderSettingsFromState(state) { assert.equal(state, updated); },
  });
  for (const name of ['withProviderBusy', 'refreshModelCatalog']) {
    const declaration = source.match(new RegExp('^async function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
    assert.ok(declaration, 'missing function ' + name);
    vm.runInContext(declaration[0], context);
  }
  return { context, calls, status, button, updated, applied: () => applied };
}

test('refresh reloads every connected provider, including inactive and local providers', async () => {
  const providers = [
    { id: 'cloud', base: 'https://cloud.example/v1', api_style: 'anthropic', active: false },
    { id: 'local', base: 'http://localhost:8080/v1', api_style: 'openai', token_set: false, allow_insecure_tls: true },
    { id: 'codex', base: 'https://chatgpt.example', builtin: true, token_set: true, api_style: 'openai' },
    { id: 'unsigned', base: 'https://chatgpt.example', builtin: true, token_set: false },
  ];
  const h = harness(providers, async () => ({ ok: true }));
  await h.context.refreshModelCatalog(h.button);
  const requests = h.calls.filter((call) => call.options).map((call) => JSON.parse(call.options.body));
  assert.deepEqual(requests.map((body) => body.id), ['cloud', 'local', 'codex']);
  assert.equal(requests[0].api_style, 'anthropic');
  assert.equal(requests[1].allow_insecure_tls, true);
  assert.ok(requests.every((body) => !('token' in body)));
  assert.equal(h.applied(), h.updated);
  assert.equal(h.status.textContent, 'Models refreshed.');
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.textContent, 'Refresh models');
});

test('partial failures still apply the refreshed catalog and report the failed providers', async () => {
  const providers = ['ready', 'offline', 'broken'].map((id) => ({ id, base: 'https://example.com/v1' }));
  const h = harness(providers, async ({ id }) => {
    if (id === 'broken') throw new Error('unavailable');
    return { ok: id === 'ready' };
  });
  await h.context.refreshModelCatalog(h.button);
  assert.equal(h.applied(), h.updated);
  assert.match(h.status.textContent, /2 providers failed/);
  assert.equal(h.button.disabled, false);
});

test('refresh ignores repeated clicks while requests are pending', async () => {
  let release;
  const h = harness([{ id: 'local', base: 'http://localhost/v1' }], () =>
    new Promise((resolve) => { release = resolve; })
  );
  const first = h.context.refreshModelCatalog(h.button);
  await Promise.resolve();
  assert.equal(h.button.disabled, true);
  await h.context.refreshModelCatalog(h.button);
  assert.equal(h.calls.filter((call) => call.options).length, 1);
  release({ ok: true });
  await first;
  assert.equal(h.button.disabled, false);
});

test('request errors restore the button so refresh can be retried', async () => {
  const h = harness([], async () => ({ ok: true }));
  h.context.providerApi = async () => { throw new Error('server unavailable'); };
  await h.context.refreshModelCatalog(h.button);
  assert.equal(h.status.textContent, 'Could not refresh models: server unavailable');
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.textContent, 'Refresh models');
  assert.equal(h.button.dataset.busy, undefined);
});
