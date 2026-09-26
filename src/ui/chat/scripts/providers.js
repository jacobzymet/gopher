let providerSettings = [];
let lastProviderSignature = '';

function providerSettingsEls() {
  return {
    list: document.getElementById('providerList'),
    empty: document.getElementById('providerEmpty'),
    error: document.getElementById('providerError'),
    hint: document.getElementById('providerFormHint'),
    test: document.getElementById('providerConnectionTest'),
    mark: document.getElementById('providerConnectionMark'),
    title: document.getElementById('providerConnectionTitle'),
    detail: document.getElementById('providerConnectionDetail'),
    save: document.getElementById('btnSaveProvider'),
    cancel: document.getElementById('btnCancelProviderEdit'),
  };
}

function showProviderError(message) {
  const { error } = providerSettingsEls();
  if (!error) return;
  error.textContent = message || 'Something went wrong.';
  error.classList.remove('is-hidden');
}

function clearProviderError() {
  const { error } = providerSettingsEls();
  if (!error) return;
  error.textContent = '';
  error.classList.add('is-hidden');
}

function setProviderFormHint(text, sticky) {
  const { hint } = providerSettingsEls();
  if (!hint) return;
  if (sticky) hint.dataset.sticky = '1';
  else delete hint.dataset.sticky;
  hint.textContent = text;
}

function hideProviderConnectionTest() {
  const { test } = providerSettingsEls();
  if (!test) return;
  test.classList.add('is-hidden');
  test.classList.remove('is-checking', 'is-ok', 'is-fail');
}

function showProviderConnectionTest(state, title, detail) {
  const els = providerSettingsEls();
  if (!els.test) return;
  els.test.classList.remove('is-hidden', 'is-checking', 'is-ok', 'is-fail');
  els.test.classList.add('is-' + state);
  els.mark.textContent = state === 'checking' ? '…' : (state === 'ok' ? '✓' : '!');
  els.title.textContent = title;
  els.detail.textContent = detail || '';
}

function describeConnectionHealth(result) {
  const health = result?.health || {};
  const kind = health.kind || (health.ok ? 'ready' : 'error');
  const style = result?.api_style;
  const styleBit = style
    ? ((result.detected ? 'Detected ' : '') + apiStyleLabel(style))
    : '';
  if (result?.ok || health.ok) {
    if (kind === 'empty') {
      return {
        state: 'ok',
        title: 'Connected',
        detail: [styleBit, 'The provider responded, but /models returned no models.']
          .filter(Boolean)
          .join(' · '),
      };
    }
    const count = Number(result?.models) || 0;
    const models = count
      ? count + (count === 1 ? ' model available' : ' models available')
      : 'Model list ok';
    return {
      state: 'ok',
      title: 'Connection successful',
      detail: [styleBit, models].filter(Boolean).join(' · '),
    };
  }
  if (kind === 'auth') {
    return {
      state: 'fail',
      title: 'Authentication failed',
      detail: [styleBit, health.error || 'Check the API token and try again.']
        .filter(Boolean)
        .join(' · '),
    };
  }
  return {
    state: 'fail',
    title: 'Connection failed',
    detail: [styleBit, health.error || 'Could not reach that base URL.']
      .filter(Boolean)
      .join(' · '),
  };
}

function selectedApiStyle() {
  const value = document.getElementById('providerApiStyle')?.value || 'auto';
  if (value === 'anthropic') return 'anthropic';
  if (value === 'openai') return 'openai';
  return 'auto';
}

function apiStyleLabel(style) {
  if (style === 'anthropic') return 'Anthropic Messages';
  if (style === 'openai') return 'OpenAI-compatible';
  return 'Auto-detect';
}

function apiStyleShort(style) {
  if (style === 'anthropic') return 'Anthropic';
  if (style === 'openai') return 'OpenAI';
  if (style === 'responses' || style === 'codex_responses') return 'Responses';
  return 'Auto';
}

function providerLeavesMachine(provider) {
  return !!provider?.builtin || /^ChatGPT\b/.test(String(provider?.name || ''));
}

function syncProviderStyleHints() {
  const style = selectedApiStyle();
  const base = document.getElementById('providerBase');
  const token = document.getElementById('providerToken');
  if (!base || !token) return;
  if (style === 'anthropic') {
    base.placeholder = 'https://api.anthropic.com/v1';
    if (!token.placeholder.startsWith('saved')) {
      token.placeholder = 'Anthropic token, or leave blank';
    }
  } else if (style === 'openai') {
    base.placeholder = 'https://api.openai.com/v1';
    if (!token.placeholder.startsWith('saved')) {
      token.placeholder = 'OpenAI token, or leave blank';
    }
  } else {
    base.placeholder = 'https://api.openai.com/v1 or https://api.anthropic.com/v1';
    if (!token.placeholder.startsWith('saved')) {
      token.placeholder = 'API token, or leave blank';
    }
  }
}

async function testProviderConnection({ base, token, id, api_style, allow_insecure_tls }) {
  const style = api_style || selectedApiStyle();
  const detecting = !style || style === 'auto';
  showProviderConnectionTest(
    'checking',
    detecting ? 'Detecting API style…' : 'Testing connection…',
    'Calling ' + base + '/models'
  );
  const body = { base, token: token || undefined, allow_insecure_tls: !!allow_insecure_tls };
  if (!detecting) body.api_style = style;
  if (id) body.id = id;
  const result = await providerApi('/api/providers/test', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (result?.api_style === 'openai' || result?.api_style === 'anthropic') {
    if (!detecting) {
      document.getElementById('providerApiStyle').value = result.api_style;
    }
    syncProviderStyleHints();
  }
  const summary = describeConnectionHealth(result);
  showProviderConnectionTest(summary.state, summary.title, summary.detail);
  return { result, summary };
}

function normalizeProviderBase(raw) {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (!base.includes('://')) base = 'https://' + base;
  if (!/\/v1$/i.test(base)) base += '/v1';
  return base;
}

function extractProviders(state) {
  if (!state) return [];
  if (Array.isArray(state.providers) && state.providers.length) return state.providers;
  const network = state.network || {};
  if (Array.isArray(network.remotes)) return network.remotes;
  if (Array.isArray(state.remotes)) return state.remotes;
  return [];
}

function providerHealthLabel(provider) {
  if (provider.builtin && !provider.token_set) {
    return {
      text: 'Not signed in',
      chip: 'warn',
      kind: 'auth',
      hint: 'Sign in to ChatGPT to list Codex models.',
    };
  }
  const health = provider.health || {};
  if (!provider.health) return { text: 'Checking…', chip: 'checking', kind: 'checking' };
  const kind = health.kind || (health.ok ? 'ready' : 'error');
  if (kind === 'ready' || health.ok) return { text: 'Ready', chip: 'ready', kind: 'ready' };
  if (kind === 'checking') return { text: 'Checking…', chip: 'checking', kind };
  if (kind === 'waiting') return { text: 'No model running', chip: 'warn', kind, hint: 'Start a model on the host.' };
  if (kind === 'empty') return { text: 'No models listed', chip: 'warn', kind, hint: 'The provider is available, but the endpoint returned an empty model list.' };
  if (kind === 'auth') return { text: 'Authentication failed', chip: 'failed', kind, hint: 'Check the API token.' };
  return { text: 'Unreachable', chip: 'failed', kind: 'error', hint: health.error || 'Check the base URL.' };
}

function providerModelCount(providerId) {
  const models = latestState?.network?.remote_models || [];
  return models.filter((m) => m.provider_id === providerId && !m.connect_kind).length;
}

function activeProvider() {
  const network = latestState?.network || {};
  const activeId = network.active_remote_id
    || providerSettings.find((p) => p.active)?.id
    || '';
  return providerSettings.find((p) => p.id === activeId)
    || providerSettings.find((p) => p.active)
    || null;
}

function providerCardMeta(provider, health) {
  const bits = [health.text];
  const count = providerModelCount(provider.id);
  if (count) bits.push(count + (count === 1 ? ' model' : ' models'));
  if (provider.kind === 'openai-codex') {
    if (provider.token_set) bits.push('Signed in');
  } else {
    bits.push(apiStyleShort(provider.api_style));
    bits.push(provider.token_set || provider.token_masked ? 'Token set' : 'No token');
  }
  if (providerLeavesMachine(provider)) bits.push('Leaves this computer');
  return bits.join(' · ');
}

function renderProviderSettings() {
  const { list, empty, hint } = providerSettingsEls();
  if (!list || !empty) return;
  empty.classList.toggle('is-hidden', providerSettings.length > 0);
  const signature = JSON.stringify(providerSettings.map((p) => [
    p.id, p.name, p.base, p.api_style, p.active, p.token_set, p.token_masked,
    p.health?.ok, p.health?.kind, p.health?.error, providerModelCount(p.id),
  ]));
  if (signature === lastProviderSignature) return;
  lastProviderSignature = signature;
  list.innerHTML = providerSettings.map((provider) => {
    const health = providerHealthLabel(provider);
    const builtin = !!provider.builtin;
    const needsSecret = provider.kind === 'openai-codex';
    const defaultMark = provider.active
      ? '<span class="profile-active-pill">Default</span>'
      : `<button type="button" class="btn btn-outline" data-provider-activate="${escapeHtml(provider.id)}" title="Use this provider when a request does not name a model">Make default</button>`;
    const connectMark = builtin && needsSecret && !provider.token_set
      ? `<button type="button" class="btn btn-outline" data-provider-connect="${escapeHtml(provider.kind)}">Connect</button>`
      : '';
    const editMark = builtin
      ? ''
      : `<button type="button" class="btn btn-outline" data-provider-edit="${escapeHtml(provider.id)}">Edit</button>`;
    const removeMark = builtin
      ? (needsSecret && provider.token_set
        ? `<button type="button" class="btn btn-outline" data-provider-delete="${escapeHtml(provider.id)}">Disconnect</button>`
        : '')
      : `<button type="button" class="btn btn-outline" data-provider-delete="${escapeHtml(provider.id)}">Remove</button>`;
    return `
      <li class="provider-card${provider.active ? ' is-active' : ''}" data-provider-id="${escapeHtml(provider.id)}">
        <div class="provider-card-head">
          <div class="provider-card-copy">
            <strong>${escapeHtml(provider.name || 'Provider')}</strong>
            <span>${escapeHtml(provider.base || '')}</span>
          </div>
          <div class="provider-card-actions">
            ${defaultMark}
            ${connectMark}
            ${editMark}
            ${removeMark}
          </div>
        </div>
        <p class="field-hint"${health.hint ? ` title="${escapeHtml(health.hint)}"` : ''}>${escapeHtml(providerCardMeta(provider, health))}</p>
      </li>`;
  }).join('');
  if (hint && !hint.dataset.sticky) {
    setProviderFormHint('Select Add to test the connection automatically.');
  }
}

function syncProviderSettingsFromState(state) {
  if (!state) return;
  providerSettings = extractProviders(state);
  renderProviderSettings();
}

function clearProviderForm() {
  const { save, cancel } = providerSettingsEls();
  document.getElementById('providerName').value = '';
  document.getElementById('providerApiStyle').value = 'auto';
  document.getElementById('providerBase').value = '';
  document.getElementById('providerToken').value = '';
  document.getElementById('providerToken').placeholder = 'API token, or leave blank';
  document.getElementById('providerAllowInsecureTls').checked = false;
  if (save) {
    delete save.dataset.editingId;
    save.textContent = 'Add';
  }
  cancel?.classList.add('is-hidden');
  document.getElementById('providerFormTitle').textContent = 'Add a provider';
  clearProviderError();
  hideProviderConnectionTest();
  syncProviderStyleHints();
  setProviderFormHint('The base URL must end in /v1. The app detects the API style unless you select a style. Select Add to test the connection automatically.');
}

function beginProviderEdit(provider) {
  const { save, cancel } = providerSettingsEls();
  document.getElementById('providerName').value = provider.name || '';
  document.getElementById('providerApiStyle').value = 'auto';
  document.getElementById('providerBase').value = provider.base || '';
  document.getElementById('providerToken').value = '';
  document.getElementById('providerToken').placeholder = provider.token_set || provider.token_masked
    ? ('saved · ' + (provider.token_masked || '••••'))
    : 'API token, or leave blank';
  document.getElementById('providerAllowInsecureTls').checked = !!provider.allow_insecure_tls;
  if (save) {
    save.dataset.editingId = provider.id;
    save.textContent = 'Save';
  }
  cancel?.classList.remove('is-hidden');
  document.getElementById('providerFormTitle').textContent = 'Edit provider';
  clearProviderError();
  hideProviderConnectionTest();
  syncProviderStyleHints();
  setProviderFormHint(
    provider.token_set || provider.token_masked
      ? 'Change the name or URL, or enter a new token. Leave the token blank to keep the saved token. Select Save to test the connection and detect the API style again.'
      : 'Enter a token if the provider requires authentication. Select Save to test the connection and detect the API style.',
    true
  );
  document.getElementById('providerToken').focus();
  document.getElementById('providerFormTitle')?.scrollIntoView({ block: 'nearest' });
}

async function providerApi(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let body = null;
  const text = await response.text();
  if (text) {
    try { body = JSON.parse(text); } catch { body = { error: text }; }
  }
  if (!response.ok) {
    const message = body?.error || body?.message || ('HTTP ' + response.status);
    const error = new Error(typeof message === 'string' ? message : 'Request failed');
    if (typeof body?.code === 'string') error.code = body.code;
    throw error;
  }
  return body;
}

async function withProviderBusy(button, label, work) {
  if (!button || button.dataset.busy === '1') return;
  const previous = button.textContent;
  button.dataset.busy = '1';
  button.disabled = true;
  button.textContent = label;
  try {
    await work();
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.textContent = previous;
  }
}

async function mutateProvider(path, options) {
  const result = await providerApi(path, options);
  if (result?.state && typeof updateInferenceState === 'function') {
    updateInferenceState(result.state);
  } else if (result?.network || result?.providers) {
    if (typeof updateInferenceState === 'function') {
      updateInferenceState({
        ...(latestState || {}),
        ...result,
        network: result.network || latestState?.network,
        providers: result.providers || latestState?.providers,
      });
    }
  } else if (typeof pollState === 'function') {
    await pollState();
  }
  syncProviderSettingsFromState(latestState);
  return result;
}

function setProviderSettingsActive(active) {
  if (active) syncProviderSettingsFromState(latestState);
}

function bindProviderSettings() {
  const { list, save, cancel, test } = providerSettingsEls();
  if (!list || !save) return;

  list.addEventListener('click', async (event) => {
    const activate = event.target.closest('[data-provider-activate]');
    if (activate && !activate.disabled) {
      const id = activate.getAttribute('data-provider-activate');
      await withProviderBusy(activate, 'Switching…', async () => {
        try {
          clearProviderError();
          await mutateProvider('/api/providers/' + encodeURIComponent(id) + '/activate', {
            method: 'POST',
          });
          setProviderFormHint('Chat now uses the selected provider as the default provider.', true);
        } catch (error) {
          showProviderError(error.message);
        }
      });
      return;
    }
    const edit = event.target.closest('[data-provider-edit]');
    if (edit) {
      const id = edit.getAttribute('data-provider-edit');
      const provider = providerSettings.find((p) => p.id === id);
      if (provider && !provider.builtin) beginProviderEdit(provider);
      return;
    }
    const connect = event.target.closest('[data-provider-connect]');
    if (connect) {
      openBuiltinConnect(connect.getAttribute('data-provider-connect') || '');
      return;
    }
    const remove = event.target.closest('[data-provider-delete]');
    if (remove) {
      const id = remove.getAttribute('data-provider-delete');
      const provider = providerSettings.find((p) => p.id === id);
      const isDefault = activeProvider()?.id === id;
      const builtin = !!provider?.builtin;
      const ok = await confirmDanger({
        title: builtin ? 'Disconnect?' : 'Remove provider?',
        body: builtin
          ? 'Remove the saved ' + (provider?.name || 'sign-in') + ' from this computer? The account itself is unchanged.'
          : 'Remove “' + (provider?.name || 'this provider') + '” from Gopher? The API host is unchanged.'
            + (isDefault ? ' Its models leave Chat’s picker, and another provider becomes the default.' : ''),
        confirmLabel: builtin ? 'Disconnect' : 'Remove',
      });
      if (!ok) return;
      try {
        await mutateProvider('/api/providers/' + encodeURIComponent(id), { method: 'DELETE' });
        clearProviderForm();
        setProviderFormHint(builtin ? 'Disconnected.' : 'Provider removed.', true);
      } catch (error) {
        showProviderError(error.message);
      }
    }
  });

  cancel?.addEventListener('click', () => clearProviderForm());

  save.addEventListener('click', async () => {
    clearProviderError();
    const name = document.getElementById('providerName').value.trim();
    const styleChoice = selectedApiStyle();
    const baseRaw = document.getElementById('providerBase').value.trim();
    const token = document.getElementById('providerToken').value.trim();
    const allow_insecure_tls = document.getElementById('providerAllowInsecureTls').checked;
    const editingId = save.dataset.editingId || '';
    if (!baseRaw) {
      hideProviderConnectionTest();
      showProviderError('Enter a base URL ending in /v1.');
      document.getElementById('providerBase').focus();
      return;
    }
    const base = normalizeProviderBase(baseRaw);
    document.getElementById('providerBase').value = base;

    await withProviderBusy(save, 'Testing…', async () => {
      try {
        const { result, summary } = await testProviderConnection({
          base,
          token,
          api_style: styleChoice,
          id: editingId || undefined,
          allow_insecure_tls,
        });
        if (summary.state !== 'ok') {
          showProviderError(summary.detail || summary.title);
          return;
        }
        const api_style = result?.api_style === 'anthropic' ? 'anthropic' : 'openai';

        save.textContent = editingId ? 'Saving…' : 'Adding…';
        if (editingId) {
          await mutateProvider('/api/providers/' + encodeURIComponent(editingId), {
            method: 'PATCH',
            body: JSON.stringify({
              name: name || undefined,
              base,
              token: token || undefined,
              api_style,
              allow_insecure_tls,
            }),
          });
          clearProviderForm();
          showProviderConnectionTest('ok', 'Provider updated', summary.detail);
          setProviderFormHint('Provider updated. Connection verified.', true);
        } else {
          await mutateProvider('/api/providers', {
            method: 'POST',
            body: JSON.stringify({
              name: name || undefined,
              base,
              token: token || undefined,
              api_style,
              allow_insecure_tls,
              activate: true,
            }),
          });
          clearProviderForm();
          showProviderConnectionTest('ok', 'Provider added', summary.detail);
          setProviderFormHint('Provider added. Chat now uses it as the default provider. Connection verified.', true);
        }
      } catch (error) {
        showProviderConnectionTest(
          'fail',
          'Connection test failed',
          error.message || 'Could not test that provider.'
        );
        showProviderError(error.message);
      }
    });
  });

  document.getElementById('providerApiStyle')?.addEventListener('change', () => {
    syncProviderStyleHints();
    if (!test?.classList.contains('is-checking')) {
      hideProviderConnectionTest();
      clearProviderError();
    }
  });

  ['providerName', 'providerBase', 'providerToken'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save.click();
      }
    });
    el.addEventListener('input', () => {
      if (!test?.classList.contains('is-checking')) {
        hideProviderConnectionTest();
        clearProviderError();
      }
    });
  });

  syncProviderStyleHints();
}

bindProviderSettings();

let builtinConnectKind = '';
let builtinDeviceTimer = 0;

function connectPanels() {
  return [...document.querySelectorAll('[data-connect-panel]')];
}

function setConnectStatus(message) {
  connectPanels().forEach((panel) => {
    const status = panel.querySelector('.builtin-connect-status');
    if (status) status.textContent = message || '';
  });
}

function hideBuiltinConnect() {
  window.clearInterval(builtinDeviceTimer);
  builtinDeviceTimer = 0;
  connectPanels().forEach((panel) => panel.classList.add('is-hidden'));
}

function openBuiltinConnect(kind) {
  builtinConnectKind = String(kind || '');
  window.clearInterval(builtinDeviceTimer);
  builtinDeviceTimer = 0;
  const codex = builtinConnectKind === 'openai-codex';
  connectPanels().forEach((panel) => {
    panel.classList.toggle('is-hidden', !codex);
    const text = panel.querySelector('.builtin-connect-text');
    if (text) {
      text.textContent = 'Your Codex sign-in stays on this computer until you disconnect. Model requests go to the Codex service.';
    }
    const device = panel.querySelector('.builtin-connect-device');
    if (device) {
      device.textContent = '';
      device.classList.add('is-hidden');
    }
    const status = panel.querySelector('.builtin-connect-status');
    if (status) status.textContent = '';
  });
}

async function refreshAfterSubscription(result) {
  if (result?.state && typeof updateInferenceState === 'function') {
    updateInferenceState(result.state);
  } else if (typeof pollState === 'function') {
    await pollState();
  }
  syncProviderSettingsFromState(latestState);
}

function builtinProviderModelsLoaded(kind) {
  const provider = extractProviders(latestState).find((item) => item.kind === kind);
  return !!provider && providerModelCount(provider.id) > 0;
}

/** Close the connect panel and keep refreshing until the provider's models are listed. */
async function finishBuiltinConnect(kind, result) {
  hideBuiltinConnect();
  await refreshAfterSubscription(result);
  const provider = extractProviders(latestState).find((item) => item.kind === kind);
  if (provider && typeof modelProviderFold !== 'undefined') {
    modelProviderFold.set(provider.id, false);
    if (typeof modelMenuIsOpen === 'function' && modelMenuIsOpen()) {
      applyModelFilter({ keepActive: true, keepScroll: true });
    }
  }
  const deadline = Date.now() + 30000;
  while (!builtinProviderModelsLoaded(kind) && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    if (typeof pollState === 'function') await pollState();
    syncProviderSettingsFromState(latestState);
  }
}

async function runConnectAction(action) {
  if (action.dataset.busy === '1') return;
  action.dataset.busy = '1';
  action.disabled = true;
  try {
    clearProviderError();
    if (action.getAttribute('data-connect-action') === 'codex-login') {
      setConnectStatus('Finish signing in in your browser…');
      let result;
      try {
        result = await providerApi('/api/subscription/codex/login', {
          method: 'POST',
          body: '{}',
        });
      } catch (error) {
        if (error.code !== 'codex_browser_port_busy') throw error;
        setConnectStatus(error.message);
        await startCodexDeviceLogin();
        return;
      }
      await finishBuiltinConnect('openai-codex', result);
      return;
    }
    if (action.getAttribute('data-connect-action') === 'codex-device') {
      await startCodexDeviceLogin();
      return;
    }
    if (action.getAttribute('data-connect-action') === 'codex-import') {
      const ok = await confirmDanger({
        title: 'Import Codex CLI session?',
        body: 'Gopher will read ~/.codex/auth.json and copy the session into encrypted storage. The Codex CLI file is left unchanged.',
        confirmLabel: 'Import',
      });
      if (!ok) return;
      const result = await providerApi('/api/subscription/codex/import', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      await finishBuiltinConnect('openai-codex', result);
    }
  } catch (error) {
    setConnectStatus(error.message);
    showProviderError(error.message);
  } finally {
    delete action.dataset.busy;
    action.disabled = false;
  }
}

async function startCodexDeviceLogin() {
  const started = await providerApi('/api/subscription/codex/device', {
    method: 'POST',
    body: '{}',
  });
  showDeviceCode(started);
  window.clearInterval(builtinDeviceTimer);
  builtinDeviceTimer = window.setInterval(async () => {
    try {
      const status = await providerApi('/api/subscription/codex/device');
      showDeviceCode(status);
      if (status.status === 'ready') {
        window.clearInterval(builtinDeviceTimer);
        builtinDeviceTimer = 0;
        await finishBuiltinConnect('openai-codex', null);
      } else if (status.status === 'error') {
        window.clearInterval(builtinDeviceTimer);
        builtinDeviceTimer = 0;
        setConnectStatus(status.error || 'ChatGPT sign-in failed.');
      }
    } catch (error) {
      window.clearInterval(builtinDeviceTimer);
      builtinDeviceTimer = 0;
      setConnectStatus(error.message);
    }
  }, 3000);
}

function showDeviceCode(status) {
  const code = status?.user_code || '';
  const url = status?.verification_url || '';
  connectPanels().forEach((panel) => {
    const device = panel.querySelector('.builtin-connect-device');
    if (!device) return;
    if (!code) {
      device.textContent = '';
      device.classList.add('is-hidden');
      return;
    }
    device.classList.remove('is-hidden');
    device.textContent = 'Enter ' + code + (url ? ' at ' + url : '') + '.';
  });
  if (status?.status === 'pending') setConnectStatus('Waiting for the device code…');
}

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-connect-action]');
  if (!action) return;
  event.preventDefault();
  void runConnectAction(action);
});
