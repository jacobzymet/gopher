function parseSseEvent(raw: string) {
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join('\n') };
}

function whenAborted(signal?: AbortSignal | null) {
  if (!signal) return new Promise<unknown>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<unknown>((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
}

async function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<StreamReadResult> {
  if (signal.aborted) return { aborted: true };
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read().then((chunk) => ({ chunk })),
      new Promise<StreamReadResult>((resolve) => {
        onAbort = () => resolve({ aborted: true });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Reveal streamed text a few code points per frame so chunks feel like a
 * typewriter. Catches up when backlog grows, and snap-flushes on end so
 * we never trail the network after the response finishes.
 */
function createStreamTyper(onPaint: (text: string, streaming: boolean) => void) {
  let target = '';
  let shown = '';
  let raf = 0;
  let inReasoning = false;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let catchingUp = false;

  function pending() {
    return target.length - shown.length;
  }

  function advance(step: number) {
    let i = shown.length;
    let taken = 0;
    while (i < target.length && taken < step) {
      const code = target.charCodeAt(i);
      // Keep surrogate pairs intact.
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < target.length) i += 2;
      else i += 1;
      taken += 1;
    }
    // Caught-up only: finish the word if a break is a few characters away.
    if (step <= 2 && i < target.length) {
      const limit = Math.min(target.length, i + 5);
      for (let j = i; j < limit; j++) {
        const ch = target.charCodeAt(j);
        if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
          i = j + 1;
          break;
        }
      }
    }
    shown = target.slice(0, i);
  }

  function tick() {
    raf = 0;
    const behind = pending();
    if (behind <= 0) return;
    // ~1–3 code points/frame when near real-time; sprint when buffered.
    let step = 1;
    if (behind > 96) step = Math.ceil(behind / 6);
    else if (behind > 32) step = 4;
    else if (behind > 10) step = 2;
    advance(step);
    onPaint(shown, true);
    if (pending() > 0) raf = requestAnimationFrame(tick);
  }

  function schedule() {
    if (reduceMotion || catchingUp) {
      shown = target;
      onPaint(shown, true);
      return;
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function closeReasoning() {
    if (!inReasoning) return;
    target += '</think>';
    inReasoning = false;
  }

  return {
    get target() { return target; },
    get shown() { return shown; },
    /** OpenAI / llama.cpp reasoning channel (separate from answer content). */
    pushReasoning(delta: string) {
      if (!delta) return;
      if (!inReasoning) {
        target += '<think>';
        inReasoning = true;
      }
      target += delta;
      schedule();
    },
    push(delta: string) {
      if (!delta) return;
      closeReasoning();
      target += delta;
      schedule();
    },
    clear() {
      target = '';
      shown = '';
      inReasoning = false;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    setCatchingUp(next: boolean) {
      catchingUp = !!next;
      if (catchingUp) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        shown = target;
        onPaint(shown, true);
      }
    },
    /** Instantly catch up — call when the SSE stream closes or aborts. */
    flush() {
      closeReasoning();
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      shown = target;
      onPaint(shown, false);
    },
  };
}

function selectedModelIsReady(data = latestState, modelId = selectedChatModel) {
  const remote = selectedRemoteModel(data, modelId);
  return !!(remote && remote.ready);
}

function updateSendEnabled() {
  const hasText = composerInput.value.trim() !== '';
  const hasFiles = pendingAttachments.length > 0;
  const hasQuote = !!(pendingReplyQuote && String(pendingReplyQuote).trim());
  const editingLive = !!(editingRow && !editingRow.classList.contains('msg-queued'));
  const submittingEdit = editingLive && editingRow!.dataset.editSubmitting === 'true';
  const botsDraft = typeof isBotsSurface === 'function' && isBotsSurface() && !activeId;
  const modelReady = selectedModelIsReady();
  const connectionReady = typeof workspaceDisconnected === 'undefined' || !workspaceDisconnected;
  const canCompose = storageReady && !diskEncryptionLocked()
    && connectionReady
    && serverReady
    && modelReady
    && !botsDraft
    && !submittingEdit
    && !(typeof pendingComposerSend !== 'undefined' && pendingComposerSend)
    && (hasText || hasFiles || hasQuote || editingLive);
  btnSend.disabled = !canCompose;
  const waitingLabel = selectedChatModel
    ? 'Waiting for ' + modelIdLabel(selectedChatModel)
    : 'Waiting for a model';
  const sendLabel = submittingEdit ? 'Restarting response…'
    : editingLive ? 'Send edit and restart response'
    : isConvoBusy(activeId) ? 'Queue message' : 'Send message';
  btnSend.classList.toggle('is-queueing', !editingLive && isConvoBusy(activeId));
  const label = !connectionReady ? 'Waiting for Gopher to reconnect' : modelReady ? sendLabel : waitingLabel;
  btnSend.title = label;
  btnSend.setAttribute('aria-label', label);
  if (btnBranch) {
    const botsConvo = typeof isBotsConvo === 'function'
      && isBotsConvo(conversations.find((item) => item.id === activeId));
    btnBranch.disabled = !canCompose || botsConvo || !canBranchFromActiveConversation();
  }
}

function syncModelOriginPill(visible: boolean, providerName?: string) {
  if (!chatModelOriginPill) return;
  const name = (providerName || '').trim();
  if (!visible || !name || chatModelSelectWrap.classList.contains('is-hidden')) {
    chatModelOriginPill.classList.add('is-hidden');
    chatModelOriginPill.setAttribute('aria-hidden', 'true');
    chatModelOriginPill.textContent = '';
    chatModelOriginPill.removeAttribute('title');
    return;
  }
  chatModelOriginPill.classList.remove('is-hidden');
  chatModelOriginPill.setAttribute('aria-hidden', 'false');
  chatModelOriginPill.textContent = name;
  applyPrivacyMosaic(chatModelOriginPill, 'model-origin-provider:' + name);
  setIdentityTitle(chatModelOriginPill, name);
}

function modelOptionTitle(label: unknown, provider?: unknown) {
  const model = String(label || '');
  const origin = String(provider || '').trim();
  return origin ? model + ' · ' + origin : model;
}

function hostLooksLocal(host: string) {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!value) return false;
  if (
    value === 'localhost'
    || value === '::1'
    || value === '0.0.0.0'
    || value.endsWith('.local')
  ) return true;
  if (
    value === '127.0.0.1'
    || value.startsWith('127.')
    || /^(?:fc|fd)[0-9a-f]{2}:/.test(value)
    || value.startsWith('fe80:')
  ) return true;
  if (value.startsWith('10.') || value.startsWith('192.168.') || value.startsWith('169.254.')) return true;
  const match = value.match(/^172\.(\d+)\./);
  if (!match) return false;
  const octet = Number(match[1]);
  return octet >= 16 && octet <= 31;
}

function modelLooksLocal(option?: Pick<ModelMenuOption, 'base'> | null) {
  const base = String(option?.base || '');
  if (!base) return false;
  try {
    const url = new URL(base.includes('://') ? base : 'http://' + base);
    return hostLooksLocal(url.hostname);
  } catch {
    return /localhost|127\.0\.0\.1|\.local/i.test(base);
  }
}

function modelProviderKey(option?: Partial<ModelMenuOption>) {
  return String(option?.providerId || option?.provider || option?.base || 'provider').trim() || 'provider';
}

function modelProviderLabel(option?: Pick<ModelMenuOption, 'provider'> | null) {
  return String(option?.provider || '').trim() || 'Provider';
}

function orderedUnifiedModelOptions() {
  const byValue = new Map(modelMenuOptions.map((option) => [option.value, option]));
  const ordered: ModelMenuOption[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const option = byValue.get(value);
    if (!option || seen.has(value)) return;
    seen.add(value);
    ordered.push(option);
  };
  add(modelMenuSelectedId());
  pinnedModelIds.forEach(add);
  recentModelIds.forEach(add);
  modelMenuOptions.forEach((option) => add(option.value));
  return ordered;
}

function modelMenuSection(option: ModelMenuOption) {
  if (option.value === modelMenuSelectedId()) return 'current';
  if (isModelPinned(option.value)) return 'pinned';
  if (recentModelIds.includes(option.value)) return 'recent';
  return 'provider:' + modelProviderKey(option);
}

function modelMenuSectionLabel(section: string, option: ModelMenuOption) {
  if (section === 'current') return 'Current';
  if (section === 'pinned') return 'Pinned';
  if (section === 'recent') return 'Recent';
  return modelProviderLabel(option);
}

/** User overrides for provider groups. Absent means "collapsed when the group has more than one model". */
const modelProviderFold = new Map<string | null, boolean>();

function modelMenuSectionCounts(options: ModelMenuOption[]) {
  const counts = new Map<string, number>();
  options.forEach((option) => {
    const section = modelMenuSection(option);
    counts.set(section, (counts.get(section) || 0) + 1);
  });
  return counts;
}

function providerFoldKey(section: string) {
  return section.startsWith('provider:') ? section.slice('provider:'.length) : '';
}

function providerSectionIsCollapsed(section: string, count: number) {
  const key = providerFoldKey(section);
  if (!key || modelFilterTerms().length) return false;
  if (modelProviderFold.has(key)) return modelProviderFold.get(key);
  return count > 1;
}

function visibleModelMenuOptions() {
  if (modelFilterTerms().length) return modelMenuMatches;
  const counts = modelMenuSectionCounts(modelMenuMatches);
  return modelMenuMatches.filter((option) => {
    const section = modelMenuSection(option);
    return !providerSectionIsCollapsed(section, counts.get(section) || 0);
  });
}

function modelMenuIsOpen() {
  return chatModelMenu && !chatModelMenu.classList.contains('is-hidden');
}

let modelMenuCloseTimer: number | null | undefined = null;

/** When set, the shared menu is picking a model for a loop agent instead of the chat. */
let modelMenuContext: ModelMenuContext | null = null;

function modelMenuSelectedId() {
  if (modelMenuContext && modelMenuContext.selectedId) return modelMenuContext.selectedId;
  return selectedChatModel;
}

function modelMenuAnchorEl() {
  return (modelMenuContext && modelMenuContext.anchor) || chatModelSelectWrap;
}

function modelMenuTriggerEl() {
  return (modelMenuContext && modelMenuContext.trigger) || chatModelSelect;
}

function modelMenuHasNetwork() {
  return !!(chatModelMenu?.querySelector('[data-model-tab="network"]') as HTMLElement);
}

function modelSearchEnabled() {
  return modelMenuOptions.length > 0;
}

function modelFilterTerms() {
  return modelMenuFilter.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function modelMenuSourceOptions() {
  return orderedUnifiedModelOptions();
}

function syncModelMenuSummary() {
  const convo = conversations.find((item) => item.id === activeId);
  const override = convo ? convo.modelId : draftModelId;
  const reset = (document.getElementById('btnModelUseDefault') as HTMLButtonElement);
  if (reset) {
    reset.classList.toggle('is-hidden', !!modelMenuContext || !override);
  }
  const selected = modelMenuOptions.find((option) => option.value === modelMenuSelectedId());
  if (chatModelSummary) {
    const prefix = modelMenuContext ? 'Selected' : (override ? 'This chat' : 'Default');
    chatModelSummary.textContent = selected
      ? prefix + ' · ' + selected.label + ' · ' + modelProviderLabel(selected)
      : 'Search every available model';
  }
  const providers = new Set(modelMenuOptions.map(modelProviderKey)).size;
  const local = modelMenuOptions.filter(modelLooksLocal).length;
  if (chatModelCatalogMeta) {
    chatModelCatalogMeta.textContent = modelMenuOptions.length + ' models · '
      + providers + (providers === 1 ? ' provider' : ' providers')
      + (local ? ' · ' + local + ' local' : '');
  }
  chatModelList?.setAttribute('aria-label', 'All available models');
}

/**
 * Every term must appear somewhere in "<label> <provider>". Ranked so
 * label-prefix hits float above mid-string ones; ties keep source order.
 */
function computeModelMatches() {
  const source = modelMenuSourceOptions();
  const terms = modelFilterTerms();
  if (!terms.length) {
    modelMenuMatches = source;
    return;
  }
  const scored: { option: ModelMenuOption; rank: number; index: number }[] = [];
  source.forEach((option, index) => {
    const label = String(option.label || '').toLowerCase();
    const haystack = (label + ' ' + String(option.provider || '')).toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) return;
    let rank = 2;
    if (label.startsWith(terms[0])) rank = 0;
    else if (label.includes(terms[0])) rank = 1;
    scored.push({ option, rank, index });
  });
  scored.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
  modelMenuMatches = scored.map((entry) => entry.option);
}

/** Escape, then wrap matched runs in <mark>. Overlapping terms merge. */
function highlightModelText(value: string, terms: string[]) {
  const raw = String(value || '');
  if (!terms.length || !raw) return escapeModelText(raw);
  const lower = raw.toLowerCase();
  const hit = new Array<boolean>(raw.length).fill(false);
  terms.forEach((term) => {
    if (!term) return;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at === -1) break;
      for (let i = at; i < at + term.length; i += 1) hit[i] = true;
      from = at + 1;
    }
  });
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const on = hit[i];
    let j = i;
    while (j < raw.length && hit[j] === on) j += 1;
    const chunk = escapeModelText(raw.slice(i, j));
    out += on ? '<mark class="chat-model-mark">' + chunk + '</mark>' : chunk;
    i = j;
  }
  return out;
}

function renderModelOptionHtml(option: ModelMenuOption, index: number, { terms }: { terms: string[]; }) {
  const isSelected = option.value === modelMenuSelectedId();
  const picking = !!modelMenuContext;
  const pinned = isModelPinned(option.value);
  const local = modelLooksLocal(option);
  const defaultBadge = !picking && option.value === resolveSavedModelId(settings.selectedChatModel, modelMenuOptions)
    ? '<span class="chat-model-default-pill" title="Default model">Default</span>'
    : '';
  const thinkingBadge = option.thinking
    ? '<span class="chat-model-capability">Reasoning</span>'
    : '';
  const localityBadge = local
    ? '<span class="chat-model-capability">Local</span>'
    : '';
  const prefix = picking
    ? (isSelected ? 'Selected · ' : '')
    : (isSelected ? 'Selected · ' : 'Use in this chat · ');
  const remoteBadge = /^ChatGPT\b/.test(String(option.provider || ''))
    ? '<span class="chat-model-capability">Leaves this computer</span>'
    : '';
  const connect = !!option.connectKind;
  const pinButton = connect
    ? ''
    : '<button type="button" class="chat-model-pin' + (pinned ? ' is-pinned' : '') + '"'
      + ' tabindex="-1" data-model-pin="' + escapeModelAttr(option.value) + '"'
      + ' aria-label="' + (pinned ? 'Unpin model' : 'Pin model') + '"'
      + ' aria-pressed="' + (pinned ? 'true' : 'false') + '"'
      + ' title="' + (pinned ? 'Unpin' : 'Pin') + '">'
      + MODEL_PIN_ICON
      + '</button>';
  return '<div class="chat-model-option' + (isSelected ? ' is-selected' : '')
    + (local ? ' is-local' : '') + (connect ? ' is-connect' : '') + '" role="option" id="chat-model-option-' + index + '"'
    + ' data-value="' + escapeModelAttr(option.value) + '"'
    + ' title="' + escapeModelAttr(prefix + modelOptionTitle(option.label, option.provider)) + '"'
    + ' aria-selected="' + (isSelected ? 'true' : 'false') + '" tabindex="-1">'
    + '<button type="button" class="chat-model-option-main" tabindex="-1" data-model-pick="'
    + escapeModelAttr(option.value) + '">'
    + '<span class="chat-model-option-icon" aria-hidden="true">'
    + MODEL_MARK_ICON + '</span>'
    + '<span class="chat-model-option-copy">'
    + '<span class="chat-model-option-name-row"><span class="chat-model-option-name">'
    + highlightModelText(option.label, terms) + '</span>' + defaultBadge + '</span>'
    + '<span class="chat-model-option-meta">'
    + '<span class="chat-model-provider">' + highlightModelText(modelProviderLabel(option), terms) + '</span>'
    + localityBadge
    + thinkingBadge
    + remoteBadge
    + '</span></span>'
    + '</button>'
    + pinButton
    + '</div>';
}

const MODEL_FOLD_ICON = '<svg class="chat-model-fold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function renderModelMenuList() {
  const terms = modelFilterTerms();
  const counts = modelMenuSectionCounts(modelMenuMatches);
  let previousSection = '';
  let html = '';
  modelMenuMatches.forEach((option, index) => {
    const section = terms.length ? 'results' : modelMenuSection(option);
    if (!terms.length && section !== previousSection) {
      const label = escapeModelText(modelMenuSectionLabel(section, option));
      const count = counts.get(section) || 0;
      const foldKey = providerFoldKey(section);
      if (foldKey) {
        const collapsed = providerSectionIsCollapsed(section, count);
        html += '<button type="button" class="chat-model-section-label'
          + (collapsed ? ' is-collapsed' : '') + '" data-provider-fold="'
          + escapeModelAttr(foldKey) + '" aria-expanded="' + (collapsed ? 'false' : 'true')
          + '" tabindex="-1">'
          + '<span class="chat-model-section-name">' + MODEL_FOLD_ICON
          + '<span>' + label + '</span></span>'
          + '<span>' + count + '</span></button>';
      } else {
        html += '<div class="chat-model-section-label" role="presentation">'
          + '<span>' + label + '</span>'
          + '<span>' + count + '</span></div>';
      }
      previousSection = section;
    }
    if (!terms.length && providerSectionIsCollapsed(section, counts.get(section) || 0)) return;
    html += renderModelOptionHtml(option, index, { terms });
  });
  chatModelList.innerHTML = html;
  (chatModelList.querySelectorAll('.chat-model-provider') as NodeListOf<HTMLElement>).forEach((label) => {
    applyPrivacyMosaic(label, 'model-menu-provider:' + label.textContent);
    setIdentityTitle(label, label.textContent);
  });
  (chatModelList.querySelectorAll('.chat-model-option') as NodeListOf<HTMLElement>).forEach((optionEl) => {
    const option = modelMenuOptions.find((item) => item.value === optionEl.dataset.value);
    const picking = !!modelMenuContext;
    const prefix = picking
      ? (optionEl.classList.contains('is-selected') ? 'Selected · ' : '')
      : (optionEl.classList.contains('is-selected') ? 'Selected · ' : 'Use in this chat · ');
    setIdentityTitle(optionEl, option ? prefix + modelOptionTitle(option.label, option.provider) : '');
  });

  const empty = !modelMenuMatches.length;
  chatModelMenu.classList.toggle('is-searching', !!terms.length);
  chatModelEmpty.classList.toggle('is-hidden', !empty);
  chatModelList.classList.toggle('is-hidden', empty);
  if (empty) {
    chatModelEmpty.textContent = terms.length
      ? 'No models match “' + modelMenuFilter.trim() + '”. Try a model or provider name.'
      : (latestState?.network?.remote_checking || latestState?.network?.remote_catalog_pending)
        ? 'Loading models…'
        : 'No models are available. Add or reconnect a provider in Settings.';
  }
  if (chatModelSearchCount) {
    chatModelSearchCount.textContent = terms.length
      ? modelMenuMatches.length + (modelMenuMatches.length === 1 ? ' result' : ' results')
      : modelMenuOptions.length + (modelMenuOptions.length === 1 ? ' model' : ' models');
    chatModelSearchCount.classList.toggle('is-hidden', false);
  }
  syncModelMenuSummary();
  chatModelList.setAttribute(
    'aria-label',
    terms.length ? 'Matching models' : (modelMenuHasNetwork() ? 'Network models' : 'All available models')
  );
}

/** Re-filter and repaint the open menu after the query changed. */
function applyModelFilter({ keepActive = false, keepScroll = false } = {}) {
  const visible = () => visibleModelMenuOptions();
  const previous = keepActive && modelMenuActiveIndex >= 0
    ? visible()[modelMenuActiveIndex]
    : null;
  computeModelMatches();
  renderModelMenuList();
  const options = visible();
  const restored = previous
    ? options.findIndex((option) => option.value === previous.value)
    : -1;
  if (restored >= 0) modelMenuActiveIndex = restored;
  else {
    modelMenuActiveIndex = options.findIndex((option) => option.value === modelMenuSelectedId());
    if (modelFilterTerms().length && options.length) modelMenuActiveIndex = 0;
  }
  paintModelMenuActive({ scroll: !keepScroll });
  if (modelMenuIsOpen()) positionModelMenu();
}

function toggleProviderFold(key: string | null) {
  const section = 'provider:' + key;
  const counts = modelMenuSectionCounts(modelMenuMatches);
  const collapsed = providerSectionIsCollapsed(section, counts.get(section) || 0);
  const scrollTop = chatModelList.scrollTop;
  modelProviderFold.set(key, !collapsed);
  applyModelFilter({ keepActive: true, keepScroll: true });
  chatModelList.scrollTop = scrollTop;
  const header = [...(chatModelList.querySelectorAll('[data-provider-fold]') as NodeListOf<HTMLElement>)]
    .find((node) => node.getAttribute('data-provider-fold') === key);
  if (!header) return;
  // Sticky headers report their stuck position; measure where it sits in the flow.
  header.style.position = 'static';
  const naturalTop = header.getBoundingClientRect().top
    - chatModelList.getBoundingClientRect().top
    + chatModelList.scrollTop;
  header.style.position = '';
  if (naturalTop < chatModelList.scrollTop) chatModelList.scrollTop = naturalTop;
}

function modelMenuViewport() {
  const view = window.visualViewport;
  if (view) {
    return {
      top: view.offsetTop,
      left: view.offsetLeft,
      width: view.width,
      height: view.height,
    };
  }
  return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
}

function modelMenuAnchorIsUsable(anchor?: HTMLElement | null) {
  if (!anchor || !anchor.isConnected || typeof anchor.getBoundingClientRect !== 'function') {
    return false;
  }
  return typeof anchor.getClientRects !== 'function' || anchor.getClientRects().length > 0;
}

function positionModelMenu() {
  const anchor = modelMenuAnchorEl();
  if (!chatModelMenu) return false;
  if (!modelMenuAnchorIsUsable(anchor)) {
    closeModelMenu();
    return false;
  }
  const view = modelMenuViewport();
  const pad = view.width < 560 ? 8 : 20;
  const width = Math.min(672, Math.max(0, view.width - pad * 2));
  const maxHeight = Math.min(680, Math.max(0, view.height - pad * 2));
  chatModelMenu.style.width = Math.round(width) + 'px';
  chatModelMenu.style.maxHeight = Math.round(maxHeight) + 'px';
  const height = Math.min(chatModelMenu.offsetHeight || maxHeight, maxHeight);
  chatModelMenu.style.left = Math.round(view.left + (view.width - width) / 2) + 'px';
  chatModelMenu.style.top = Math.round(view.top + Math.max(pad, (view.height - height) / 2)) + 'px';
  chatModelMenu.style.right = 'auto';
  chatModelMenu.style.transformOrigin = 'center center';
  return true;
}
function closeModelMenu({ restoreFocus = false } = {}) {
  const trigger = modelMenuTriggerEl();
  const customAnchor = modelMenuContext && modelMenuContext.anchor;
  modelMenuContext = null;
  if (customAnchor) customAnchor.classList.remove('is-open');
  chatModelSelectWrap?.classList.remove('is-open');
  chatModelSelect?.setAttribute('aria-expanded', 'false');
  if (trigger && trigger !== chatModelSelect) trigger.setAttribute('aria-expanded', 'false');
  modelMenuActiveIndex = -1;
  modelMenuFilter = '';
  if (chatModelSearch) chatModelSearch.value = '';
  if (restoreFocus) trigger?.focus();
  if (!chatModelMenu || chatModelMenu.classList.contains('is-hidden')) return;
  clearTimeout(modelMenuCloseTimer);
  modelMenuCloseTimer = null;
  chatModelMenu.classList.remove('is-open');
  chatModelBackdrop?.classList.remove('is-open');
  if (typeof hideBuiltinConnect === 'function') hideBuiltinConnect();
  const finish = () => {
    chatModelMenu.classList.add('is-hidden');
    chatModelBackdrop?.classList.add('is-hidden');
    chatModelMenu.style.maxHeight = '';
    if (chatModelBackdrop && chatModelBackdrop.parentElement !== chatModelSelectWrap) {
      chatModelSelectWrap.appendChild(chatModelBackdrop);
    }
    if (chatModelMenu.parentElement !== chatModelSelectWrap) {
      chatModelSelectWrap.appendChild(chatModelMenu);
    }
  };
  if (prefersReducedMotion()) {
    finish();
    return;
  }
  modelMenuCloseTimer = window.setTimeout(() => {
    modelMenuCloseTimer = null;
    finish();
  }, 180);
}

function paintModelMenuActive({ scroll = true } = {}) {
  const activeValue = visibleModelMenuOptions()[modelMenuActiveIndex]?.value || '';
  const nodes = (chatModelList.querySelectorAll('.chat-model-option') as NodeListOf<HTMLElement>);
  let active: HTMLElement | null = null;
  nodes.forEach((node) => {
    const isActive = !!activeValue && node.getAttribute('data-value') === activeValue;
    node.classList.toggle('is-active', isActive);
    if (isActive) active = node;
  });
  if (active && scroll) (active as HTMLElement).scrollIntoView({ block: 'nearest' });
  if (chatModelSearch) {
    if (active) chatModelSearch.setAttribute('aria-activedescendant', (active as HTMLElement).id);
    else chatModelSearch.removeAttribute('aria-activedescendant');
  }
}

function openModelMenu(opts?: ModelMenuContext) {
  if (!modelMenuOptions.length) return;
  const context = opts && typeof opts === 'object' ? opts : null;
  if (!context && chatModelSelectWrap.classList.contains('is-hidden')) return;
  clearTimeout(modelMenuCloseTimer);
  modelMenuCloseTimer = null;
  if (modelMenuContext && modelMenuContext.anchor && modelMenuContext.anchor !== context?.anchor) {
    modelMenuContext.anchor.classList.remove('is-open');
    modelMenuContext.trigger?.setAttribute('aria-expanded', 'false');
  }
  modelMenuContext = context;
  if (chatModelBackdrop && chatModelBackdrop.parentElement !== document.body) {
    document.body.appendChild(chatModelBackdrop);
  }
  if (chatModelMenu.parentElement !== document.body) {
    document.body.appendChild(chatModelMenu);
  }
  chatModelBackdrop?.classList.remove('is-hidden');
  const searchable = modelSearchEnabled();
  chatModelSearchWrap.classList.toggle('is-hidden', !searchable);
  modelMenuFilter = '';
  if (chatModelSearch) chatModelSearch.value = '';
  chatModelMenu.classList.remove('is-hidden');
  chatModelSelectWrap.classList.toggle('is-open', !context);
  chatModelSelect.setAttribute('aria-expanded', context ? 'false' : 'true');
  const trigger = modelMenuTriggerEl();
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  if (context?.anchor) context.anchor.classList.add('is-open');
  computeModelMatches();
  renderModelMenuList();
  modelMenuActiveIndex = visibleModelMenuOptions().findIndex((o) => o.value === modelMenuSelectedId());
  positionModelMenu();
  paintModelMenuActive();
  // Typing filters immediately when the field is there; otherwise the
  // trigger keeps focus and its own arrow-key handler stays in charge.
  if (searchable) chatModelSearch.focus();
  void chatModelMenu.offsetWidth;
  afterNextPaint(() => {
    if (chatModelMenu.classList.contains('is-hidden')) return;
    const currentTrigger = modelMenuTriggerEl();
    if (!currentTrigger || currentTrigger.getAttribute('aria-expanded') !== 'true') return;
    if (!positionModelMenu()) return;
    chatModelBackdrop?.classList.add('is-open');
    chatModelMenu.classList.add('is-open');
  });
}

function chooseModelOption(value: string) {
  if (!requireUnlockedData()) return;
  const inheritDefault = value === '@default';
  const picked = modelMenuOptions.find((item) => item.value === value);
  if (picked?.connectKind || String(value || '').startsWith('connect|')) {
    if (typeof openBuiltinConnect === 'function') openBuiltinConnect(picked?.connectKind || '');
    return;
  }
  if (!value) {
    closeModelMenu({ restoreFocus: true });
    return;
  }
  if (!inheritDefault) rememberRecentModel(value);
  if (modelMenuContext && typeof modelMenuContext.onPick === 'function') {
    modelMenuContext.selectedId = value;
    modelMenuContext.onPick(value);
    closeModelMenu({ restoreFocus: true });
    return;
  }
  setChatModelSelection(inheritDefault ? '' : value);
  const selected = modelMenuOptions.find((o) => o.value === selectedChatModel);
  chatModelSelect.textContent = selected ? selected.label : (modelIdLabel(selectedChatModel) || 'Model');
  setIdentityTitle(chatModelSelect, selected ? modelOptionTitle(selected.label, selected.provider) : '');
  syncModelOriginPill(true, selected && selected.provider);
  closeModelMenu({ restoreFocus: true });
  if (latestState) updateInferenceState(latestState);
  if (typeof updateSendEnabled === 'function') updateSendEnabled();
  if (typeof fillDefaultModelSetting === 'function'
    && settingsModal
    && !settingsModal.classList.contains('is-hidden')) {
    fillDefaultModelSetting();
    if (typeof syncSettingsSaveButton === 'function') syncSettingsSaveButton();
  }
}

function refreshStarfieldClearZone() {
  if (typeof repaintStarfield === 'function') repaintStarfield();
}

function escapeModelAttr(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeModelText(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;');
}

/** Map a saved picker id onto the current catalog without dropping unknown ids. */
function resolveSavedModelId(savedId: string, options: ModelMenuOption[], allowAliases = true) {
  const id = String(savedId || '').trim();
  if (!id || !options.length) return id;
  if (options.some((option) => option.value === id)) return id;
  if (!allowAliases) return id;
  const stripped = id.replace(/^remote\|/, '');
  const suffixHits = options.filter((option) => option.value.endsWith('|' + stripped));
  if (suffixHits.length === 1) return suffixHits[0].value;
  const parts = stripped.split('|');
  if (parts.length >= 2) {
    const model = parts[parts.length - 1];
    const base = parts.slice(0, -1).join('|');
    const baseHits = options.filter((option) => {
      if (option.label !== model) return false;
      // A provider-qualified id must never migrate to a different provider.
      if (parts.length >= 3 && option.providerId !== parts[0]
        && !option.value.startsWith('remote|' + parts[0] + '|')) return false;
      return option.base === base
        || option.value.includes('|' + base + '|')
        || option.value.endsWith('|' + base + '|' + model);
    });
    if (baseHits.length === 1) return baseHits[0].value;
  }
  return id;
}

function remapSavedModelIds(ids: string[], options: ModelMenuOption[], allowAliases = true) {
  const seen = new Set<string>();
  const next: string[] = [];
  (Array.isArray(ids) ? ids : []).forEach((id) => {
    const resolved = resolveSavedModelId(id, options, allowAliases);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    next.push(resolved);
  });
  return next;
}

function sameIdList(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function modelIdLabel(id: string) {
  const parts = String(id || '').split('|').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function catalogOptionFromRemote(model: ModelOption): ModelMenuOption {
  return {
    value: model.id,
    label: (model.model || model.label)!,
    provider: String(model.provider_name || '').trim(),
    providerId: String(model.provider_id || '').trim(),
    base: String(model.base || '').trim(),
    ready: !!model.ready,
    thinking: !!model.thinking_supported,
    connectKind: String(model.connect_kind || '').trim(),
  };
}

/**
 * A catalog is complete only after every configured provider has been probed.
 * The first host to answer must not look "done" — that used to overwrite the
 * saved default model with whatever happened to arrive first, then persist it.
 * An empty or failing catalog after a probe still counts as probed.
 */
function modelCatalogIsComplete(network: AppNetwork | null | undefined, options?: ModelMenuOption[]) {
  return !!network?.remote_saved
    && !network?.remote_checking
    && !network?.remote_catalog_pending;
}

function syncModelSelector(data: AppState) {
  // Never select or persist a fallback before saved preferences have loaded.
  if (!storageReady) return;
  syncConversationModel();
  const network = data.network || {};
  const remoteModels = network.remote_models || [];
  const wasHidden = chatModelSelectWrap.classList.contains('is-hidden');
  const menuOpen = modelMenuIsOpen();

  if (!remoteModels.length) {
    if (!menuOpen) closeModelMenu();
    // An open menu is anchored to this control while a new sign-in's catalog loads.
    if (selectedChatModel || menuOpen) {
      const restoring = !!network.remote_checking || !!network.remote_catalog_pending;
      chatModelSelectWrap.classList.remove('is-hidden');
      chatModelSelect.textContent = modelIdLabel(selectedChatModel) || 'Model';
      chatModelSelect.disabled = true;
      chatModelSelect.toggleAttribute('aria-busy', restoring);
      chatModelSelect.title = !selectedChatModel
        ? 'Loading models…'
        : restoring
          ? 'Restoring saved model…'
          : 'Saved model is unavailable';
    } else {
      chatModelSelectWrap.classList.add('is-hidden');
    }
    syncModelOriginPill(false);
    modelMenuOptions = [];
    if (!wasHidden) refreshStarfieldClearZone();
    return;
  }
  chatModelSelectWrap.classList.remove('is-hidden');
  chatModelSelect.disabled = false;
  chatModelSelect.removeAttribute('aria-busy');
  if (wasHidden) refreshStarfieldClearZone();

  const remoteOptions = remoteModels.map(catalogOptionFromRemote);
  const catalogComplete = modelCatalogIsComplete(network, remoteOptions);
  modelMenuOptions = remoteOptions;
  const remappedPins = remapSavedModelIds(pinnedModelIds, remoteOptions, catalogComplete);
  const remappedRecents = remapSavedModelIds(recentModelIds, remoteOptions, catalogComplete);
  let pickerChanged = !sameIdList(remappedPins, pinnedModelIds)
    || !sameIdList(remappedRecents, recentModelIds);
  pinnedModelIds = remappedPins;
  recentModelIds = remappedRecents;
  if (!recentModelIds.length && selectedChatModel && remoteOptions.some((o) => o.value === selectedChatModel)) {
    recentModelIds = [selectedChatModel];
    pickerChanged = true;
  }
  const savedDefault = String(settings.selectedChatModel || '').trim();
  let resolvedDefault = resolveSavedModelId(savedDefault, remoteOptions, catalogComplete);
  if (remoteOptions.some((option) => option.value === resolvedDefault && option.connectKind)) resolvedDefault = '';
  const selectable = remoteOptions.filter((option) => !option.connectKind);
  // Only invent a default when nothing is saved. A saved id that is not in
  // this snapshot stays selected so a later provider catalog can match it.
  if (!resolvedDefault && catalogComplete && !menuOpen && selectable.length) {
    resolvedDefault = selectable[0].value;
  }
  if (resolvedDefault !== savedDefault) {
    settings = { ...settings, selectedChatModel: resolvedDefault };
    pickerChanged = true;
  }
  syncConversationModel();
  if (pickerChanged) persistModelPickerState();

  const signature = [
    selectedChatModel,
    settings.selectedChatModel,
    ...remoteOptions.map((o) => o.value + '|' + o.label + '|' + o.provider),
  ].join(';');
  if (chatModelMenu.dataset.signature !== signature) {
    chatModelMenu.dataset.signature = signature;
    if (menuOpen) {
      // Only a changed catalog repaints an open menu, so polling does not
      // replace rows under the cursor. Keep the query, active row, and scroll.
      const scrollTop = chatModelList.scrollTop;
      applyModelFilter({ keepActive: true, keepScroll: true });
      chatModelList.scrollTop = scrollTop;
    } else {
      modelMenuFilter = '';
      computeModelMatches();
      renderModelMenuList();
    }
  }
  const selected = remoteOptions.find((o) => o.value === selectedChatModel);
  const selectionPending = !!selectedChatModel && !selected && !catalogComplete;
  chatModelSelect.textContent = selected
    ? selected.label
    : (modelIdLabel(selectedChatModel) || 'Model');
  if (selectionPending) {
    chatModelSelect.title = 'Restoring ' + modelIdLabel(selectedChatModel) + '…';
    chatModelSelect.setAttribute('aria-busy', 'true');
  } else {
    chatModelSelect.removeAttribute('aria-busy');
    setIdentityTitle(
      chatModelSelect,
      selected
        ? modelOptionTitle(selected.label, selected.provider)
        : (selectedChatModel ? modelIdLabel(selectedChatModel) : '')
    );
  }
  selectedRemoteModelId = selectedChatModel;
  syncModelOriginPill(true, selected && selected.provider);
  if (menuOpen) positionModelMenu();
  if (typeof fillDefaultModelSetting === 'function'
    && settingsModal
    && !settingsModal.classList.contains('is-hidden')) {
    fillDefaultModelSetting();
  }
  const loopModal = (document.getElementById('groupModal') as HTMLElement);
  if (loopModal && !loopModal.classList.contains('is-hidden') && typeof paintLoopModelPickerButtons === 'function') {
    paintLoopModelPickerButtons();
  }
  if (typeof renderTraceMembers === 'function') renderTraceMembers();
  if (typeof paintLoopModelHint === 'function') paintLoopModelHint();
}

function selectedRemoteModel(data: AppState | null | undefined, modelId?: string) {
  const models = data?.network?.remote_models || [];
  if (!models.length) return null;
  const options = modelMenuOptions.length ? modelMenuOptions : models.map(catalogOptionFromRemote);
  const saved = modelId === undefined ? (selectedRemoteModelId || selectedChatModel) : modelId;
  if (modelId !== undefined && !saved) return null;
  const resolved = resolveSavedModelId(saved, options, modelCatalogIsComplete(data?.network, options));
  const matched = models.find((model) => model.id === resolved)
    || models.find((model) => model.id === saved);
  if (matched) return matched;
  if (!modelCatalogIsComplete(data?.network, options)) return null;
  return saved ? null : (models[0] || null);
}

/** Paint the ready-state model line from source data, never from stale surface copy. */
function paintReadyInferenceModelHint(data: AppState | null | undefined) {
  if (!serverReady || !data || !modelHintEl) return false;
  if (typeof paintLoopModelHint === 'function' && paintLoopModelHint()) return true;

  const network = data.network || {};
  const remoteSelected = selectedRemoteModel(data);
  const modelName = remoteSelected?.model || network.remote_model || 'remote model';
  const providerLabel = remoteSelected?.provider_name
    || network.remote_name
    || network.remote_label
    || 'provider';
  const project = inProjectChat() ? getProject(activeProjectId) : null;

  modelHintEl.classList.remove('is-hidden');
  if (isIncognitoContext() && !activeId) {
    modelHintEl.textContent = 'Temporary session — stays in memory only until you close the tab.'
      + (project ? ' · Project: ' + project.name : '');
  } else if (project && !activeId) {
    setModelHintWithProvider('Shared instructions & memory apply · ' + modelName, providerLabel);
  } else {
    setModelHintWithProvider(
      project
        ? 'Chatting with ' + modelName + ' · Project: ' + project.name
        : 'Chatting with ' + modelName,
      providerLabel
    );
  }
  return true;
}

function updateInferenceState(data: AppState) {
  latestState = data;
  applyAppearance(data);
  syncModelSelector(data);
  const network = data.network || {};
  if (network.inference_mode === 'locked' || diskEncryptionLocked()) {
    serverReady = false;
    modelHintEl.textContent = '';
    modelHintEl.classList.add('is-hidden');
    hideComposerHint();
    syncComposerThinkVisibility(null);
    syncAttachButton();
    updateSendEnabled();
    return;
  }
  const remoteChecking = !!network.remote_checking
    || (!!network.remote_saved
      && !network.remote_ok
      && !network.remote_kind
      && !(network.remote_models || []).length);
  const remoteSelected = selectedRemoteModel(data);
  const catalogComplete = modelCatalogIsComplete(
    network,
    modelMenuOptions.length ? modelMenuOptions : (network.remote_models || []).map(catalogOptionFromRemote)
  );
  const selectionPending = !!network.remote_saved && !remoteSelected && !catalogComplete;
  const selectionMissing = !!selectedChatModel && !remoteSelected && catalogComplete;
  selectedModelMissingPolls = selectionMissing ? selectedModelMissingPolls + 1 : 0;
  const selectionRecovering = selectionMissing && selectedModelMissingPolls < 4;
  const selectionUnavailable = selectionMissing && !selectionRecovering;
  serverReady = !!remoteSelected?.ready;

  if (selectionPending || selectionRecovering || remoteChecking) {
    const label = modelIdLabel(selectedChatModel);
    const pendingText = label
      ? ((selectionRecovering ? 'Refreshing ' : 'Connecting to ') + label + '…')
      : 'Loading models…';
    modelHintEl.textContent = pendingText;
    modelHintEl.classList.remove('is-hidden');
    showComposerHint(pendingText);
  } else if (selectionUnavailable) {
    const unavailableText = modelIdLabel(selectedChatModel) + ' is unavailable. Choose another model.';
    modelHintEl.textContent = unavailableText;
    modelHintEl.classList.remove('is-hidden');
    showComposerHint(unavailableText, { warn: true });
  } else if (!serverReady) {
    modelHintEl.textContent = '';
    modelHintEl.classList.add('is-hidden');
    hideComposerHint();
  } else {
    paintReadyInferenceModelHint(data);
    updateComposerHint();
  }
  syncComposerThinkVisibility(remoteSelected);
  syncAttachButton();
  updateSendEnabled();
  if (typeof syncProviderSettingsFromState === 'function') {
    syncProviderSettingsFromState(data);
  }
  if (serverReady && typeof resumePendingConversationTitles === 'function') {
    resumePendingConversationTitles();
  }
  if (typeof renderWelcomeTools === 'function') renderWelcomeTools();
}

let encryptionStateSync: Promise<void> | null = null;

function syncExternalEncryptionState(data: AppState | null | undefined) {
  if (!dataInfo || typeof data?.encryption_enabled !== 'boolean') return;
  const serverEnabled = data.encryption_enabled;
  const serverUnlocked = data.encryption_unlocked === true;
  if (serverEnabled && !serverUnlocked) {
    if (!dataInfo.encryption_enabled || dataInfo.encryption_unlocked) {
      dataInfo.encryption_enabled = true;
      dataInfo.encryption_unlocked = false;
      clearMemoryAfterLock();
    }
    return;
  }
  if (
    dataInfo.encryption_enabled === serverEnabled
    && (!serverEnabled || dataInfo.encryption_unlocked)
  ) {
    return;
  }
  if (encryptionStateSync) return;
  encryptionStateSync = (async () => {
    const response = await fetch('/api/data');
    if (!response.ok) throw new Error('Could not refresh encryption state');
    dataInfo = await response.json() as DataInfo;
    await loadDiskDataAfterUnlock();
    refreshLocalDataPane();
    refreshSettingsDataSummary();
  })()
    .catch((error: unknown) => {
      console.warn('Could not synchronize encryption state', error);
      promptUnlockSession();
    })
    .finally(() => {
      encryptionStateSync = null;
    });
}

let statePollInFlight = false;

async function pollState() {
  if (statePollInFlight) return;
  statePollInFlight = true;
  const epoch = storageWriteEpoch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const requestedAt = performance.now();
    const response = await fetch('/api/state', { signal: controller.signal });
    if (!response.ok) {
      if (epoch === storageWriteEpoch && typeof noteWorkspaceConnection === 'function') noteWorkspaceConnection(false);
      return;
    }
    const data: AppState = await response.json();
    if (epoch !== storageWriteEpoch) return;
    if (typeof noteWorkspaceConnection === 'function') noteWorkspaceConnection(true);
    syncExternalEncryptionState(data);
    updateInferenceState(data);
    await resumeLiveTurns(data.live_turns, requestedAt);
  } catch {
    if (epoch === storageWriteEpoch && typeof noteWorkspaceConnection === 'function') noteWorkspaceConnection(false);
  } finally {
    clearTimeout(timer);
    statePollInFlight = false;
  }
}

let pendingComposerSend: ComposerSendAttempt | null = null;

function composerSendIsCurrent(attempt: ComposerSendAttempt) {
  return activeId === attempt.convoId
    && activeProjectId === attempt.projectId
    && appSurface === attempt.surface
    && draftIncognito === attempt.incognito
    && draftWorkspaceRoot === attempt.workspace
    && selectedChatModel === attempt.modelId
    && composerInput.value === attempt.input
    && pendingReplyQuote === attempt.quote
    && pendingReplyTarget === attempt.replyTarget
    && pendingAttachments.length === attempt.attachments.length
    && pendingAttachments.every((file, index) => file === attempt.attachments[index])
    && [...composerMentionIds].join('\0') === attempt.mentions.join('\0')
    && (!attempt.convoId || conversations.some((convo) => convo.id === attempt.convoId));
}

async function sendMessage({ branch = false } = {}) {
  if (pendingComposerSend) return;
  if (
    !branch
    && editingRow
    && !editingRow.classList.contains('msg-queued')
    && typeof submitEditedMessage === 'function'
  ) {
    const input = (editingRow.querySelector('.msg-edit-input') as HTMLTextAreaElement);
    const next = (input?.value || '').trim();
    if (next) {
      await submitEditedMessage(editingRow, next);
    }
    return;
  }
  const typed = composerInput.value.trim();
  const queuedFiles = pendingAttachments.slice();
  const replyQuote = typeof pendingReplyQuote === 'string' ? pendingReplyQuote.trim() : '';
  const replyTarget = pendingReplyTarget && pendingReplyTarget.speakerId
    ? {
      speakerId: pendingReplyTarget.speakerId,
      speakerHandle: pendingReplyTarget.speakerHandle || '',
    }
    : null;
  if (!typed && !queuedFiles.length && !replyQuote) return;
  const selectedTurnRemote = selectedRemoteModel(latestState);
  if (!serverReady || !selectedTurnRemote?.ready) {
    const label = modelIdLabel(selectedChatModel);
    showComposerHint(
      label ? ('Still connecting to ' + label + '…') : 'Still loading models…'
    );
    return;
  }
  if (!requireUnlockedData()) return;

  let source = conversations.find((item) => item.id === activeId);
  if (branch) {
    if (!source || !Array.isArray(source.messages) || !source.messages.length) return;
  }

  const attempt: ComposerSendAttempt = {
    convoId: activeId, projectId: activeProjectId, modelId: selectedChatModel,
    surface: appSurface, incognito: draftIncognito, workspace: draftWorkspaceRoot,
    input: composerInput.value, quote: pendingReplyQuote, replyTarget: pendingReplyTarget,
    attachments: queuedFiles, mentions: [...composerMentionIds],
    diagnosticTraceId: typeof diagnosticMark === 'function' && settings.diagnosticsEnabled ? newId('turn') : '',
    diagnosticStartedAt: Date.now(),
  };
  const diagnosticContext = { traceId: attempt.diagnosticTraceId, convoId: activeId, startedAt: attempt.diagnosticStartedAt };
  if (typeof diagnosticMark === 'function') diagnosticMark('prompt.prepare.started', { attachments: queuedFiles.length, model: selectedChatModel }, diagnosticContext);
  pendingComposerSend = attempt;
  updateSendEnabled();
  try {
  stopVoiceInput({ silent: true });
  cancelMessageEdit();
  showChatView();

  let prepared: MessageAttachment[];
  try {
    if (queuedFiles.length) {
      attachHintUntil = 0;
      showComposerHint('Preparing attachments…');
      prepared = await prepareAttachmentsForSend(queuedFiles);
    } else {
      prepared = [];
    }
  } catch (error) {
    if (activeId === attempt.convoId) {
      showAttachHint((error as Error)?.message || 'Attachment prep failed');
      focusComposer();
    }
    return;
  }

  // Async attachment work must never send into another chat or erase a newer draft.
  if (typeof diagnosticMark === 'function') diagnosticMark('prompt.prepare.finished', { attachments: prepared.length }, diagnosticContext);
  if (!composerSendIsCurrent(attempt)) {
    if (activeId === attempt.convoId) showComposerHint('Draft changed during preparation. Review it and send again.');
    return;
  }
  if (!requireUnlockedData() || !serverReady || !selectedRemoteModel(latestState)?.ready) return;

  if (branch) {
    source = (conversations.find((item) => item.id === source!.id) || source)!;
    if (!source.messages?.length) {
      focusComposer();
      return;
    }
  }

  const mentioned = parseCapabilityMentions(typed);
  const text = mentioned.text;
  const mentionIds = new Set([
    ...composerMentionIds,
    ...mentioned.mentions,
  ]);
  // Drop legacy chip id if somehow present.
  mentionIds.delete('agent');
  const turn = resolveTurnSkills(mentionIds);
  const displayText = displayTextWithMentions(text, mentioned.mentions);
  const storedAttachments = storedAttachmentsFromPrepared(prepared);
  const apiText = buildUserApiContent(text, prepared, replyQuote, replyTarget?.speakerHandle);

  if ((branch || source || !isBotsSurface()) && typeof discardSentComposerDraft === 'function') discardSentComposerDraft();
  let convo = branch
    ? null
    : conversations.find((item) => item.id === activeId);
  if (branch) {
    const projectId = source!.projectId || null;
    convo = {
      id: newId('c'),
      title: branchConversationTitle(source!),
      titleEdited: false,
      messages: cloneConversationMessages(source!.messages),
      modelId: source!.modelId || '',
      updatedAt: Date.now(),
      projectId,
      sortOrder: nextTopSortOrder(projectId),
      incognito: !!source!.incognito,
      pinned: false,
      pinnedAt: null,
      workspaceRoot: typeof source!.workspaceRoot === 'string' ? source!.workspaceRoot : '',
    };
    conversations.push(convo);
    if (activeId) stickByConvo.set(activeId, stickToBottom);
    activeId = convo.id;
    draftIncognito = !!convo.incognito;
    activeProjectId = projectId;
    stickToBottom = true;
    userScrollOverride = false;
    resumeBottomIntent = false;
    selectedTraceMsgIndex = null;
    resetTraceAutoOpenState();
    syncUrlFromState();
    showThread(convo);
    renderThread(convo);
    renderSidebar();
    syncComposerStreamUi();
  } else if (!convo) {
    if (typeof isBotsSurface === 'function' && isBotsSurface()) {
      showComposerHint('Create a loop first.');
      if (typeof openGroupDialog === 'function') openGroupDialog(null);
      focusComposer();
      return;
    }
    const id = newId('c');
    convo = {
      id,
      title: draftIncognito ? 'Ghost Chat' : 'New chat',
      titleEdited: false,
      messages: [],
      modelId: draftModelId,
      updatedAt: Date.now(),
      projectId: activeProjectId || null,
      sortOrder: nextTopSortOrder(activeProjectId || null),
      incognito: !!draftIncognito,
      pinned: false,
      pinnedAt: null,
      workspaceRoot: draftWorkspaceRoot,
    };
    conversations.push(convo);
    activeId = id;
    syncUrlFromState({ replace: true });
  }

  composerInput.value = '';
  clearPendingAttachments();
  clearPendingReplyQuote();
  autoResize(composerInput);
  renderComposerMentions();
  renderComposerModes();
  closeMentionMenu();

  if (typeof currentComposerDraftContext === 'function') composerDraftContext = currentComposerDraftContext();

  const outbound = {
    id: newId('q'),
    diagnosticTraceId: attempt.diagnosticTraceId,
    diagnosticStartedAt: attempt.diagnosticStartedAt,
    editText: typed,
    displayText: displayText || (storedAttachments.length ? '(attachment)' : ''),
    apiText,
    attachments: storedAttachments,
    replyQuote: replyQuote || '',
    replyToSpeakerId: replyTarget?.speakerId || '',
    replyToSpeakerHandle: replyTarget?.speakerHandle || '',
    turn: {
      useAgent: turn.useAgent,
      skills: turn.skills,
      deepResearch: turn.deepResearch,
      deepResearchOutput: turn.deepResearchOutput,
      forceTools: turn.forceTools,
    },
  };

  // Branch always starts a fresh turn on the new chat (never queue on the parent).
  const busy = !branch && isConvoBusy(convo.id);
  const hasQueued = !branch && getOutboundQueue(convo.id).length > 0;
  if (!branch && (busy || hasQueued)) {
    enqueueOutbound(convo, outbound);
    if (!busy) {
      if (typeof resumeOutboundQueue === 'function') resumeOutboundQueue(convo.id);
      maybeSendNextQueued(convo.id);
    }
    focusComposer();
    return;
  }

  dispatchOutboundTurn(convo, outbound);
  focusComposer();
  } finally {
    if (pendingComposerSend === attempt) pendingComposerSend = null;
    updateSendEnabled();
  }
}

function focusComposer() {
  if (!composerInput) return;
  // Defer so a clicked Send button does not steal focus back.
  queueMicrotask(() => {
    if (document.activeElement === composerInput) return;
    composerInput.focus({ preventScroll: true });
  });
}

function ensureStreamDom(convo: Conversation, stream: ActiveStream) {
  if (stream?.hardStopped) return null;
  if (activeId !== convo.id) return null;
  if (stream.dom && stream.dom.row.isConnected) return stream.dom;
  const priorMounts = Number(stream.domMountCount) || 0;

  const assistantRow = (document.createElement('div') as HTMLElement);
  assistantRow.className = 'msg msg-role-assistant';
  assistantRow.dataset.streamId = convo.id;
  assistantRow.dataset.msgIndex = String(liveTurnSlices(convo).followUpStart);
  const bubble = (document.createElement('div') as HTMLElement);
  bubble.className = 'msg-bubble';

  const statusEl = (document.createElement('div') as HTMLElement);
  statusEl.className = 'thinking';
  const orbCanvas = (document.createElement('canvas') as HTMLCanvasElement);
  orbCanvas.className = 'orb-sm';
  const thinkingLabel = (document.createElement('span') as HTMLElement);
  thinkingLabel.className = 'thinking-label';
  const statusBase = String(stream.statusLabel || 'Processing…').trim() || 'Processing…';
  thinkingLabel.dataset.base = statusBase;
  thinkingLabel.textContent = streamStatusLabel(stream, statusBase);
  const elapsed = Math.max(0, Date.now() - (Number(stream.startedAt) || Date.now()));
  thinkingLabel.style.animationDelay = '-' + (elapsed % 1500) + 'ms';
  statusEl.appendChild(orbCanvas);
  statusEl.appendChild(thinkingLabel);

  const traceEl = (document.createElement('div') as HTMLElement);
  traceEl.className = 'agent-trace is-hidden';
  const answerEl = (document.createElement('div') as HTMLElement);
  answerEl.className = 'agent-answer';

  bubble.appendChild(statusEl);
  bubble.appendChild(traceEl);
  bubble.appendChild(answerEl);
  assistantRow.appendChild(bubble);
  const speakerBot = streamSpeakerBot(stream);
  if (speakerBot) {
    syncMessageSpeaker(assistantRow, {
      role: 'assistant',
      speakerId: speakerBot.id,
      speakerHandle: speakerBot.handle,
    });
  } else if (typeof isBotsConvo === 'function' && isBotsConvo(convo)) {
    // DM fallback when speaker is known from the room, not the stream yet.
    syncMessageSpeaker(assistantRow, { role: 'assistant' });
  }
  attachMessageActions(assistantRow);
  const followUp = (chatThread.querySelector(':scope > .msg-queued:not(.msg-steering)') as HTMLElement);
  if (followUp) chatThread.insertBefore(assistantRow, followUp);
  else chatThread.appendChild(assistantRow);
  if (typeof placeLiveAssistantRow === 'function') placeLiveAssistantRow(stream);
  if (priorMounts === 0) {
    queueMicrotask(() => motionEnter(assistantRow, { y: 14 }));
  }
  const thinkingOrb = mountOrb(orbCanvas as HTMLCanvasElement, 20);
  stream.domMountCount = priorMounts + 1;
  stream.dom = {
    row: assistantRow,
    statusEl,
    thinkingLabel,
    traceEl,
    answerEl,
    thinkingOrb,
    enteredSteps: 0,
  };
  const liveClarify = stream.timeline.find((part) => part.type === 'clarify');
  if (liveClarify) mountClarifyForm(stream, liveClarify);
  return stream.dom;
}

/**
 * While an open <think> block is streaming alone, patch the existing
 * .think-stream markdown instead of rebuilding the whole answer tree every
 * typer frame (full rebuilds starve the canvas orb's rAF and reset CSS animations).
 */
function paintLiveThinkOnly(rootEl: HTMLElement, cleaned: string) {
  if (settings.thinking === 'hidden') {
    if (rootEl.innerHTML) rootEl.innerHTML = '';
    return true;
  }
  const segments = parseThinkSegments(cleaned);
  const openThink = segments.find((segment) => segment.type === 'think' && segment.open);
  if (!openThink) return false;
  const otherSegments = segments.filter((segment) => {
    if (segment === openThink) return false;
    return segment.type !== 'think' ? !!segment.content.trim() : (!segment.open && !!segment.content.trim());
  });
  const closedSig = otherSegments.map((s) => s.type + ':' + s.content).join('\0');
  let streamEl = (rootEl.querySelector(
    ':scope > .agent-step.is-live-think .think-stream, :scope > .agent-step.is-think .think-stream, :scope > .think-live > .think-stream, :scope > .think-block.is-streaming > .think-stream'
  ) as HTMLElement);
  if (!streamEl || rootEl.dataset.closedSig !== closedSig) {
    let prefixHtml = '';
    for (const seg of otherSegments) {
      if (seg.type === 'think') {
        prefixHtml += renderThinkBlock(seg.content, { open: false, streaming: false });
      } else {
        prefixHtml += renderMarkdown(seg.content);
      }
    }
    rootEl.innerHTML = prefixHtml + renderThinkBlock(openThink.content, { open: true, streaming: true });
    rootEl.dataset.closedSig = closedSig;
    const liveStep = (rootEl.querySelector(':scope > .agent-step:last-child') as HTMLElement);
    if (liveStep) liveStep.classList.add('is-live-think');
    streamEl = (rootEl.querySelector('.is-live-think .think-stream, .think-stream') as HTMLElement);
  }
  if (!streamEl) return false;
  if (streamEl.dataset.thinkRaw !== openThink.content) {
    streamEl.dataset.thinkRaw = openThink.content;
    streamEl.innerHTML = renderThinkMarkdown(openThink.content);
  }
  enhanceCodeBlocks(rootEl);
  streamEl.scrollTop = streamEl.scrollHeight;
  return true;
}

function toolDetailFromPayload(payload?: AgentToolPayload | null) {
  const args = payload && payload.arguments && typeof payload.arguments === 'object'
    ? payload.arguments
    : {};
  const name = payload && payload.name ? String(payload.name) : '';
  if (name === 'grep') return String(args.query || args.pattern || '').trim();
  if (name === 'glob') return String(args.pattern || args.glob || '').trim();
  if (args.command) return String(args.command);
  if (args.session_id) return String(args.session_id);
  if (args.patch) return (String(args.patch).match(/^\*\*\* (?:Add|Update|Delete|Move to)(?: File)?: .+$/gm) || []).map((line) => line.replace(/^\*\*\* [^:]+: /, '').trim()).join(', ');
  if (args.path) return String(args.path);
  if (args.pattern) return String(args.pattern);
  if (args.url) return String(args.url);
  if (args.ref) return String(args.ref);
  if (args.expression) return String(args.expression);
  if (args.key) return String(args.key);
  if (args.selector) return String(args.selector);
  if (args.query) return String(args.query);
  if (args.name) return String(args.name);
  if (args.id) return String(args.id);
  if (payload && payload.summary) return String(payload.summary);
  return '';
}

function upsertLiveToolPart(stream: ActiveStream, payload?: AgentToolPayload | null) {
  const id = payload && payload.id ? String(payload.id) : '';
  const args = payload && payload.arguments && typeof payload.arguments === 'object'
    ? payload.arguments
    : {};
  const detail = toolDetailFromPayload(payload);
  const body = toolBodyFromArgs((payload && payload.name) || '', args);
  let part: TimelinePart | null | undefined = id
    ? stream.timeline.find((item) => item.type === 'tool' && item.id === id)
    : null;
  if (!part && !id) {
    const liveTools = stream.timeline.filter((item) => item.type === 'tool' && item.live);
    part = liveTools.find((item) => payload && item.name === payload.name && !item.result && !item.id) || null;
  }
  if (!part) {
    part = {
      type: 'tool',
      id,
      name: (payload && payload.name) || 'skill',
      detail,
      kind: args.kind ? String(args.kind) : '',
      args: { ...args },
      body,
      result: '',
      note: '',
      live: true,
      executing: false,
      startedAt: Date.now(),
    };
    stream.timeline.push(part);
    stampTimelinePart(part, stream);
  } else {
    if (id) part.id = id;
    if (payload && payload.name) part.name = payload.name;
    if (detail) part.detail = detail;
    if (args.kind) part.kind = String(args.kind);
    if (Object.keys(args).length) part.args = { ...(part.args || {}), ...args };
    if (body) part.body = body;
    stampTimelinePart(part, stream);
  }
  if (payload && (payload.needs_approval || payload.phase === 'tool_approval')
    && part.live && !['allowed', 'denied', 'expired'].includes(part.approval)) {
    part.approval = 'pending';
    part.approvalRisk = payload.risk ? String(payload.risk) : (part.approvalRisk || 'write');
    part.executing = false;
  }
  if (payload && payload.phase === 'tool_executing' && part.live) {
    part.approval = 'allowed';
    part.executing = true;
  }
  return part;
}

function timelineOrderSignature(timeline?: TimelinePart[] | null) {
  return (timeline || []).map((part) => {
    if (!part) return '';
    if (part.type === 'tool') {
      return ['tool', part.id || '', part.uid || '', part.name || '', part.startedAt || ''].join('\0');
    }
    if (part.type === 'clarify') return ['clarify', part.id || ''].join('\0');
    if (part.type === 'notice') return ['notice', part.kind || '', part.content || ''].join('\0');
    return [part.type, part.uid || ''].join('\0');
  }).join('\n');
}

function timelineSignature(timeline?: TimelinePart[] | null) {
  return (timeline || []).map((part) => {
    if (!part) return '';
    if (part.type === 'tool') {
      return [
        'tool',
        part.id || '',
        part.name,
        part.detail,
        part.result,
        part.note || '',
        typeof part.ok === 'boolean' ? String(part.ok) : '',
        part.running ? '1' : '0',
        part.commandSessionId || '',
        part.live ? '1' : '0',
        part.approval || '',
        part.approvalRisk || '',
        part.executing ? '1' : '0',
        part.live ? '' : (part.body || ''),
        part.image ? String(part.image.length) : '',
      ].join('\0');
    }
    if (part.type === 'clarify') {
      return ['clarify', part.id || '', part.live ? '1' : '0', part.summary || ''].join('\0');
    }
    return [part.type, part.content || ''].join('\0');
  }).join('\n');
}

function streamingAnswerText(text: string) {
  if (!text) return '';
  let out = '';
  for (const segment of parseThinkSegments(text)) {
    if (segment.type === 'think') continue;
    out += segment.content || '';
  }
  return out;
}

function ensureLiveAnswerBox(liveRoot: HTMLElement) {
  let box = (liveRoot.querySelector(':scope > .agent-final-answer') as HTMLElement);
  if (!box) {
    liveRoot.innerHTML = '<div class="agent-final-answer"></div>';
    box = (liveRoot.querySelector(':scope > .agent-final-answer') as HTMLElement);
  }
  return box;
}

function paintLiveStreamingAnswer(host: HTMLElement, cleaned: string, { streaming = true, wrapFinal = false } = {}) {
  const liveText = streamingAnswerText(cleaned);
  if (wrapFinal) {
    paintIncrementalMarkdown(ensureLiveAnswerBox(host), liveText, { streaming });
    return;
  }
  paintIncrementalMarkdown(host, liveText, { streaming });
}

function paintStreamIntoView(convo: Conversation, stream: ActiveStream, replyText: string, streaming: boolean) {
  if (stream?.hardStopped) return;
  setMarkdownImages(stream.images);
  stream.partial = replyText;
  const extracted = applyMemoryUpdateProtocol(replyText, { streaming });
  const { cleaned } = extracted;
  if (typeof isSilentNoReply === 'function' && isSilentNoReply(cleaned)) {
    if (activeId === convo.id && stream.dom?.answerEl) {
      if (stream.dom.answerEl.innerHTML) stream.dom.answerEl.innerHTML = '';
    }
    return;
  }
  if (activeId !== convo.id) {
    // Background stream — keep state only; sidebar shows the live marker.
    return;
  }
  const dom = ensureStreamDom(convo, stream);
  if (!dom) return;
  const { row, statusEl, thinkingLabel, traceEl, answerEl, thinkingOrb } = dom;
  const savedClarifyHost = preserveClarifyHost(answerEl);
  if (traceEl) {
    traceEl.innerHTML = '';
    traceEl.classList.add('is-hidden');
  }
  const thinkingOpen = streaming && isThinkingOpen(cleaned);
  const hasTimeline = stream.timeline.length > 0;
  const desktop = isDesktopTraceLayout();
  const notesCollapsed = readProcessNotesCollapsed(
    answerEl,
    stream.processNotesCollapsed !== false
  );
  stream.processNotesCollapsed = notesCollapsed;
  const sealedAnswerHtml = renderSealedAnswerHtml(stream.timeline, { notesCollapsed });
  const liveText = streamingAnswerText(cleaned);
  const hasLiveAnswer = !!liveText.trim();
  const hasThinkFallback = !hasTimeline && !thinkingOpen && !!cleaned && !hasLiveAnswer;
  const hasVisibleAnswer = desktop
    ? !!(sealedAnswerHtml || hasLiveAnswer || hasThinkFallback)
    : !!(hasLiveAnswer || sealedAnswerHtml);

  if (desktop) {
    const hasContent = !!(sealedAnswerHtml || hasLiveAnswer || hasThinkFallback);
    if (!hasContent && !streaming) {
      if (answerEl.innerHTML) answerEl.innerHTML = '';
      delete answerEl.dataset.renderedHtml;
    } else if (hasContent || streaming) {
      let sealedRoot = (answerEl.querySelector(':scope > .agent-sealed') as HTMLElement);
      let liveRoot = (answerEl.querySelector(':scope > .agent-live') as HTMLElement);
      if (!sealedRoot || !liveRoot) {
        answerEl.innerHTML = '<div class="agent-sealed"></div><div class="agent-live"></div>';
        sealedRoot = (answerEl.querySelector(':scope > .agent-sealed') as HTMLElement);
        liveRoot = (answerEl.querySelector(':scope > .agent-live') as HTMLElement);
      }
      const sealedSig = sealedContentSignature(stream.timeline);
      if (sealedRoot.dataset.sealedSig !== sealedSig) {
        sealedRoot.innerHTML = sealedAnswerHtml;
        sealedRoot.dataset.sealedSig = sealedSig;
        enhanceCodeBlocks(sealedRoot);
      }
      if (hasThinkFallback) {
        const html = renderAssistantHtml(cleaned, { streaming });
        if (liveRoot.dataset.renderedHtml !== html) {
          liveRoot.innerHTML = html;
          liveRoot.dataset.renderedHtml = html;
          enhanceCodeBlocks(liveRoot);
        }
      } else {
        delete liveRoot.dataset.renderedHtml;
        paintLiveStreamingAnswer(liveRoot, cleaned, { streaming, wrapFinal: true });
      }
    }
    delete answerEl.dataset.committedSig;
    delete answerEl.dataset.renderedHtml;
    stream.enteredSteps = 0;
  } else if (cleaned || hasTimeline || sealedAnswerHtml) {
    const committedHtml = renderCommittedParts(stream.timeline);
    const orderSig = timelineOrderSignature(stream.timeline) + '\0' + sealedContentSignature(stream.timeline);
    const committedSig = timelineSignature(stream.timeline) + '\0' + sealedContentSignature(stream.timeline);
    const liveOnly =
      streaming &&
      thinkingOpen &&
      !hasTimeline &&
      !sealedAnswerHtml &&
      paintLiveThinkOnly(answerEl, cleaned);

    if (!liveOnly) {
      let liveRoot = (answerEl.querySelector(':scope > .agent-live') as HTMLElement);
      if ((hasTimeline || sealedAnswerHtml) && streaming) {
        if (
          answerEl.dataset.timelineOrderSig === orderSig
          && answerEl.dataset.committedSig
          && liveRoot
        ) {
          if (answerEl.dataset.committedSig !== committedSig) {
            patchTimelineToolChrome(answerEl, stream.timeline);
            answerEl.dataset.committedSig = committedSig;
          }
          patchLiveToolBodies(answerEl, stream.timeline);
        } else if (answerEl.dataset.committedSig !== committedSig || !liveRoot) {
          answerEl.innerHTML = committedHtml + sealedAnswerHtml + '<div class="agent-live"></div>';
          answerEl.dataset.committedSig = committedSig;
          answerEl.dataset.timelineOrderSig = orderSig;
          liveRoot = (answerEl.querySelector(':scope > .agent-live') as HTMLElement);
          stampTimelineKeysOnRoot(answerEl, stream.timeline);
          enhanceCodeBlocks(answerEl);
        }
        if (cleaned && liveRoot && !(thinkingOpen && paintLiveThinkOnly(liveRoot, cleaned))) {
          paintStreamingAssistant(liveRoot, cleaned, { streaming: true });
        }
      } else if (streaming && cleaned && !hasTimeline && !sealedAnswerHtml) {
        if (!(thinkingOpen && paintLiveThinkOnly(answerEl, cleaned))) {
          paintStreamingAssistant(answerEl, cleaned, { streaming: true });
        }
        answerEl.dataset.committedSig = committedSig;
      } else {
        answerEl.innerHTML = committedHtml + sealedAnswerHtml + (cleaned ? renderAssistantHtml(cleaned, { streaming }) : '');
        answerEl.dataset.committedSig = committedSig;
        answerEl.dataset.timelineOrderSig = orderSig;
        stampTimelineKeysOnRoot(answerEl, stream.timeline);
        enhanceCodeBlocks(answerEl);
      }
      scrollThinkStreams(answerEl);
      const steps = (answerEl.querySelectorAll(':scope > .agent-step') as NodeListOf<HTMLElement>);
      const seen = stream.enteredSteps || 0;
      steps.forEach((el, index) => {
        if (index < seen || el.classList.contains('is-live')) return;
        motionEnter(el, { y: 10, duration: 200, delay: Math.min(index - seen, 6) * 28 });
      });
      stream.enteredSteps = steps.length;
    }
  } else if (!streaming) {
    if (answerEl.innerHTML) answerEl.innerHTML = '';
    delete answerEl.dataset.committedSig;
    delete answerEl.dataset.timelineOrderSig;
    delete answerEl.dataset.renderedHtml;
    stream.enteredSteps = 0;
  }

  const toolLive = stream.timeline.some((part) => part.type === 'tool' && part.live);
  const clarifyLive = stream.timeline.some((part) => part.type === 'clarify' && part.live);
  restoreClarifyHost(answerEl, savedClarifyHost || stream.dom?.clarifyHost);
  // Agent turns keep the status chip for the whole stream — including the quiet
  // gap after a tool finishes and before the next think/answer tokens arrive.
  const agentStreaming = streaming && !!stream.useAgent;
  if (toolLive || clarifyLive || thinkingOpen || agentStreaming || (streaming && !cleaned && !hasTimeline)) {
    statusEl.classList.remove('is-hidden');
    thinkingOrb.play();
    if (toolLive) {
      // Label is set by the tool_call agent event.
    } else if (clarifyLive) {
      setStreamThinkingLabel(stream, 'Waiting for your answers…');
    } else if (thinkingOpen) {
      setStreamThinkingLabel(stream, 'Reasoning…');
    } else if (agentStreaming) {
      const base = String(thinkingLabel.dataset.base || '').trim();
      // After tools, never leave a blank/stale chip — fall back to Processing.
      if (!base || base === 'Reading results') {
        setStreamThinkingLabel(stream, 'Processing…');
      }
    }
  } else if (hasVisibleAnswer || (!streaming && (cleaned || hasTimeline))) {
    statusEl.classList.add('is-hidden');
    // Pause only — stop() is irreversible and a brief think/answer flicker
    // would leave a dead orb while the label shimmer keeps running.
    thinkingOrb.pause();
  }
  row.dataset.raw = cleaned;
  // Never force — respect user scroll-away while tokens arrive.
  scrollToBottom();
  if (desktop) {
    const idx = Number(row.dataset.msgIndex);
    const hasActivity = hasTimeline || thinkingOpen;
    // Open the pane before painting live cards. WebKit freezes CSS/WAAPI
    // animations that start while the sidebar is still width:0 / opacity:0.
    if (hasActivity) maybeAutoOpenTraceSidebar(convo.id);
    if (selectedTraceMsgIndex !== idx) {
      selectTraceMessage(idx, { animate: false, ensureOpen: false });
    } else {
      refreshTraceSidebar({ animate: false });
    }
  } else {
    syncLiveToolClocks(answerEl);
  }
  if (typeof kickLiveToolMotion === 'function' && (toolLive || clarifyLive)) {
    kickLiveToolMotion(answerEl);
    if (desktop && traceSidebarBody) kickLiveToolMotion(traceSidebarBody);
  }
}

/** Stream an assistant reply; safe to leave the conversation while it runs. */
async function runAssistantTurn(convo: Conversation, {
  useAgent,
  text,
  skills,
  deepResearch = false,
  deepResearchOutput = 'long',
  forceTools = [],
  dispatchedMessage = null,
  queueItem = null,
  previousTitle = '',
  speakerBotId = null,
  skipQueue = false,
  replaceLive = false,
  botMessageLimit = null,
  loopTurnDirective = '',
  loopPhase = null,
}: AssistantTurnOptions) {
  if (outboundStarting.has(convo.id) && !replaceLive) return false;
  if (activeStreams.has(convo.id)) {
    const live = activeStreams.get(convo.id);
    if (live && (live.cancelled || live.hardStopped || live.settled) && !replaceLive) {
      // A previous Stop left this conversation busy. Free it so the next
      // prompt can start instead of hanging on Processing.
      live.replaced = true;
      live.skipQueue = true;
      if (typeof cancelLiveBodyReader === 'function') cancelLiveBodyReader(live);
      try { live.controller.abort(); } catch { /* ignore */ }
      settleStoppedLiveStream(convo, live, live.partial || '');
    } else if (!replaceLive) {
      return false;
    } else if (live) {
      live.replaced = true;
      live.skipQueue = true;
      abortStream(convo.id, { cancelServer: true });
    }
  }
  const startEpoch = markOutboundStarting(convo.id);
  const workStartedAt = Date.now();
  const clientTurnId = convo.incognito ? null : (queueItem?.diagnosticTraceId || newId('turn'));
  const diagnosticTraceId = clientTurnId || queueItem?.diagnosticTraceId || '';
  const diagnosticStartedAt = queueItem?.diagnosticStartedAt || workStartedAt;
  const diagnosticContext = { traceId: diagnosticTraceId, convoId: convo.id, startedAt: diagnosticStartedAt };
  if (typeof diagnosticMark === 'function') diagnosticMark('turn.started', { queue_wait_ms: workStartedAt - diagnosticStartedAt }, diagnosticContext);
  let liveStarted = false;
  let startedStream: ActiveStream | null = null;
  try {
  if (typeof clearBotsOutboundStopped === 'function') clearBotsOutboundStopped(convo.id);
  if (typeof clearLiveTurnUserCancel === 'function') clearLiveTurnUserCancel(convo.id);
  if (typeof waitForCancel === 'function') {
    if (typeof diagnosticMark === 'function') diagnosticMark('cancel.wait.started', {}, diagnosticContext);
    await waitForCancel(convo.id);
    if (typeof diagnosticMark === 'function') diagnosticMark('cancel.wait.finished', {}, diagnosticContext);
  }
  if (typeof outboundStartIsCurrent === 'function'
    && !outboundStartIsCurrent(convo.id, startEpoch)) {
    return false;
  }
  const speakerBot = speakerBotId && typeof getBot === 'function' ? getBot(speakerBotId, convo) : null;
  const speakerModelId = speakerBot && speakerBot.model ? speakerBot.model : conversationModelId(convo);
  const remote = selectedRemoteModel(latestState, speakerModelId);
  if (!remote?.ready) {
    if (typeof showComposerHint === 'function') {
      const label = modelIdLabel(speakerModelId);
      showComposerHint(label ? ('Still connecting to ' + label + '…') : 'Model is not ready yet.');
    }
    return false;
  }
  resetTraceAutoOpenState();

  const turnSkills = { ...(skills || {
    web_search: !!settings.skillWebSearch,
    web_search_depth: WEB_SEARCH_DEPTHS.includes(settings.webSearchDepth)
      ? settings.webSearchDepth
      : DEFAULT_SETTINGS.webSearchDepth,
    web_search_provider: WEB_SEARCH_PROVIDERS.includes(settings.webSearchProvider)
      ? settings.webSearchProvider
      : DEFAULT_SETTINGS.webSearchProvider,
    web_search_searxng: typeof settings.webSearchSearxng === 'string'
      ? settings.webSearchSearxng.trim()
      : '',
    web_search_parallel_api_key: typeof settings.webSearchParallelApiKey === 'string'
      ? settings.webSearchParallelApiKey.trim()
      : '',
    web_search_parallel_mode: WEB_SEARCH_PARALLEL_MODES.includes(settings.webSearchParallelMode)
      ? settings.webSearchParallelMode
      : DEFAULT_SETTINGS.webSearchParallelMode,
    web_search_tinyfish_api_key: typeof settings.webSearchTinyfishApiKey === 'string'
      ? settings.webSearchTinyfishApiKey.trim()
      : '',
    web_search_max_results: Math.min(20, Math.max(1, Number(settings.webSearchResults) || 6)),
    web_search_region: /^[a-z]{2}-[a-z]{2}$/.test(settings.webSearchRegion)
      ? settings.webSearchRegion
      : 'us-en',
    web_search_safesearch: WEB_SEARCH_SAFESEARCH.includes(settings.webSearchSafeSearch)
      ? settings.webSearchSafeSearch
      : 'moderate',
    web_search_recency: WEB_SEARCH_RECENCIES.includes(settings.webSearchRecency)
      ? settings.webSearchRecency
      : 'any',
    fetch_url: !!settings.skillFetchUrl,
    fetch_url_max_chars: Math.min(
      200000,
      Math.max(1000, Number(settings.fetchUrlMaxChars) || 8000)
    ),
    web_search_page_max_chars: (() => {
      const raw = Number(settings.webSearchPageMaxChars);
      if (!Number.isFinite(raw) || raw <= 0) return 0;
      return Math.min(200000, Math.max(1000, Math.round(raw)));
    })(),
    approval_mode: APPROVAL_MODES.includes(settings.approvalMode)
      ? settings.approvalMode
      : 'manual',
    filesystem: !!settings.skillFilesystem,
    workspace_root: sessionWorkspaceRoot(),
    terminal: !!settings.skillTerminal,
    terminal_timeout_secs: Math.min(30, Math.max(5, Number(settings.terminalTimeoutSecs) || 30)),
    browser: !!settings.skillBrowser,
  }), chat_retrieval: settings.chatRetrieval !== false && !convo.incognito };
  if (turnSkills.chat_retrieval) useAgent = true;
  if (deepResearch) {
    useAgent = true;
    turnSkills.web_search = true;
    turnSkills.fetch_url = true;
    turnSkills.web_search_depth = 'deep';
    turnSkills.web_search_max_results = Math.max(turnSkills.web_search_max_results || 6, 10);
  }
  const turnForceTools = Array.isArray(forceTools)
    ? forceTools.filter((name) => name === 'web_search' || name === 'fetch_url')
    : [];
  if (deepResearch || !useAgent || !settings.agentMode) {
    turnForceTools.length = 0;
  } else {
    if (turnForceTools.includes('web_search')) turnSkills.web_search = true;
    if (turnForceTools.includes('fetch_url')) turnSkills.fetch_url = true;
  }

  const stream = beginLiveStream(convo, {
    useAgent,
    deepResearch,
    deepResearchOutput,
    turnSkills,
    turnForceTools,
    turnModel: remote.model,
    speakerBotId: speakerBotId || null,
    loopPhase,
    turnStartedAt: workStartedAt,
    turnId: clientTurnId,
  });
  liveStarted = true;
  startedStream = stream;
  stream.diagnosticTraceId = diagnosticTraceId;
  stream.diagnosticStartedAt = diagnosticStartedAt;
  clearOutboundStarting(convo.id, startEpoch);
  stream.speakerBotId = speakerBotId || null;
  stream.skipQueue = !!skipQueue;
  syncStreamSpeakerChrome(convo, stream);

  stream.speakerModelId = remote.id || speakerModelId;
  let apiMessages: Array<{ role: string; content: JsonValue | undefined }>;
  if (speakerBot && typeof botApiMessages === 'function') {
    apiMessages = botApiMessages(convo, speakerBot, dispatchedMessage ? text : null, {
      messageLimit: botMessageLimit,
    });
  } else {
    apiMessages = convo.messages.map((message) => {
      if (message.role !== 'user') {
        return { role: message.role, content: message.content };
      }
      return {
        role: 'user',
        content: userMessageApiContent(message),
      };
    });
    if (apiMessages.length > 0) {
      const last = apiMessages[apiMessages.length - 1];
      if (last.role === 'user') last.content = text;
    }
  }
  const systemPrompt = buildSystemPrompt(convo.projectId, {
    excludeConvoId: convo.id,
    convo,
    speakerBot,
    includeTime: false,
  });
  const systemParts = [systemPrompt, String(loopTurnDirective || '').trim()].filter(Boolean);
  if (systemParts.length) {
    // Keep the changing clock after the stable prompt and backend agent rules.
    apiMessages.unshift(
      { role: 'system', content: systemParts.join('\n\n') },
      { role: 'system', content: buildTimePrompt() },
    );
  }

  const speakerEffort = typeof thinkingEffortForModel === 'function'
    ? thinkingEffortForModel(remote)
    : (thinkingSupported && activeThinkingEffort !== 'auto' ? activeThinkingEffort : null);
  const requestBody: Record<string, unknown> = {
    messages: apiMessages,
    agent: useAgent,
    skills: turnSkills,
    force_tools: turnForceTools,
    ...(convo.incognito ? {} : {
      conversation_id: convo.id,
      turn_id: clientTurnId,
    }),
    ...(speakerEffort ? { thinking_effort: speakerEffort } : {}),
  };
  if (deepResearch) {
    requestBody.deep_research = true;
    requestBody.deep_research_output = deepResearchOutput === 'brief' ? 'brief' : 'long';
  }
  if (remote) {
    requestBody.remote_base = remote.base;
    if (remote.provider_id) requestBody.provider_id = remote.provider_id;
    requestBody.model = remote.model;
  }

  let response: Response | null = null;
  try {
    // New chats must be persisted before the server binds their retrieval scope.
    if (turnSkills.chat_retrieval && typeof saveStore === 'function') {
      setStreamThinkingLabel(stream, 'Saving chat…');
      if (typeof diagnosticMark === 'function') diagnosticMark('store.wait.started', {}, diagnosticContext);
      saveStore({ immediate: true });
      if (typeof storeWriteChain !== 'undefined') await storeWriteChain;
      if (!stream.cancelled && activeStreams.get(convo.id) === stream) setStreamThinkingLabel(stream, 'Connecting to model…');
      if (typeof diagnosticMark === 'function') diagnosticMark('store.wait.finished', {}, diagnosticContext);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (stream.controller.signal.aborted || stream.cancelled) break;
      if (typeof diagnosticMark === 'function') diagnosticMark('chat.request.dispatch', { attempt, messages: apiMessages.length, model: remote?.model }, diagnosticContext);
      response = await Promise.race([
        fetch('/api/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(diagnosticTraceId && settings.diagnosticsEnabled ? { 'x-gopher-request-id': diagnosticTraceId } : {}),
          },
          body: JSON.stringify(requestBody),
          signal: stream.controller.signal,
        }),
        whenAborted(stream.controller.signal).then(() => {
          const error = new Error('Aborted');
          (error as Error).name = 'AbortError';
          throw error;
        }),
      ]);
      if (stream.replaced || activeStreams.get(convo.id) !== stream) return false;
      if (stream.cancelled) break;
      if (response.ok || response.status !== 409 || attempt > 0) break;
      if (typeof scheduleCancel !== 'function') break;
      await scheduleCancel(convo.id, null);
      if (stream.replaced || stream.cancelled || activeStreams.get(convo.id) !== stream) {
        return false;
      }
    }
    if (stream.cancelled || !response) {
      await driveAssistantSse(convo, stream, response);
      return true;
    }
    if (!response.ok) {
      if (response.status === 409) {
        throw new Error('Could not start a new response because another is still stopping. Try again.');
      }
      const failed = response;
      response = null;
      const problem: ApiErrorResult | null = await failed.json().catch(() => null);
      throw new Error((problem && problem.error) || ('Request failed with status ' + failed.status));
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      if (stream.replaced) {
        dropLiveSubscriber(convo.id, stream);
        return;
      }
      if (!stream.cancelled) {
        dropLiveSubscriber(convo.id, stream);
        if (!stream.skipQueue) maybeSendNextQueued(convo.id);
        return;
      }
    } else {
      stream.errorMessage = contextualModelError((error as Error).message, stream.turnModel);
    }
  }
  await driveAssistantSse(convo, stream, response);
  return true;
  } catch (error) {
    if (startedStream && activeStreams.get(convo.id) === startedStream) {
      startedStream.controller.abort();
      discardLiveStreamRow(startedStream);
      finishLiveStream(convo.id, startedStream);
    }
    throw error;
  } finally {
    if (!liveStarted) clearOutboundStarting(convo.id, startEpoch);
  }
}

function dropLiveSubscriber(convoId: string, stream: ActiveStream) {
  if (activeStreams.get(convoId) !== stream) return;
  discardLiveStreamRow(stream);
  activeStreams.delete(convoId);
  renderSidebar();
  syncComposerStreamUi();
}

function finishLiveStream(convoId: string, stream: ActiveStream) {
  if (!stream || activeStreams.get(convoId) !== stream) return false;
  try { stream.dom?.thinkingOrb?.stop(); } catch { /* ignore */ }
  activeStreams.delete(convoId);
  reclaimUnappliedSteers(convoId, stream);
  renderSidebar();
  syncComposerStreamUi();
  const convo = conversations.find((item) => item.id === convoId);
  // Give single-slot providers time to release the completed generation
  // before starting the small title job.
  if (convo) maybeEnsureConversationTitle(convo, { delay: 500 });
  return true;
}

function commitLiveAssistant(convo: Conversation, message: ChatMessage, turnId?: string | null) {
  if (turnId) message.liveTurnId = turnId;
  const existing = turnId
    ? convo.messages.find(
      (item) => item.role === 'assistant' && item.liveTurnId === turnId
    )
    : null;
  if (existing) {
    Object.assign(existing, message);
    return existing;
  }
  const insertAt = liveTurnSlices(convo).followUpStart;
  if (insertAt < convo.messages.length) convo.messages.splice(insertAt, 0, message);
  else convo.messages.push(message);
  return message;
}

function liveTurnSlices(convo: Conversation) {
  const messages = convo.messages || [];
  let lastAsst = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant') lastAsst = i;
  }
  const rest = messages.slice(lastAsst + 1);
  const prompt = rest[0] || null;
  const afterPrompt = rest.slice(1);
  let steerCount = 0;
  while (steerCount < afterPrompt.length && afterPrompt[steerCount]?.steered) {
    steerCount += 1;
  }
  return {
    lastAsst,
    head: messages.slice(0, lastAsst + 1),
    prompt,
    promptIndex: lastAsst + 1,
    steers: afterPrompt.slice(0, steerCount),
    followUps: afterPrompt.slice(steerCount),
    followUpStart: lastAsst + 2 + steerCount,
  };
}

async function syncConvoFromStore(convoId: string) {
  try {
    const response = await fetch('/api/data/store');
    if (!response.ok) return conversations.find((item) => item.id === convoId) || null;
    const parsed = parseStorePayload(await response.json());
    const fresh = (parsed.conversations || []).find((item) => item.id === convoId);
    if (!fresh) return conversations.find((item) => item.id === convoId) || null;
    if (typeof adoptPersistedOutboundQueue === 'function') adoptPersistedOutboundQueue(fresh);
    const idx = conversations.findIndex((item) => item.id === convoId);
    if (idx >= 0) {
      const localUpdated = Number(conversations[idx]?.updatedAt) || 0;
      const freshUpdated = Number(fresh.updatedAt) || 0;
      if (freshUpdated >= localUpdated) conversations[idx] = fresh;
    } else {
      conversations.push(fresh);
    }
    return conversations.find((item) => item.id === convoId) || null;
  } catch {
    return conversations.find((item) => item.id === convoId) || null;
  }
}

async function resumeLiveTurns(list: AdvertisedLiveTurn[] | null | undefined, snapshotRequestedAt = performance.now()) {
  if (!Array.isArray(list) || diskEncryptionLocked() || !storageReady) return;
  const advertised = new Map<string, AdvertisedLiveTurn>();
  for (const info of list) {
    const convoId = String(info?.conversation_id || '').trim();
    const turnId = String(info?.turn_id || '').trim();
    if (convoId && turnId) advertised.set(convoId + '\0' + turnId, info);
  }

  // The server owns detached-turn lifetime. Reconcile the browser map to it
  // before attaching anything new; a known turn cannot remain locally busy
  // after the server has finished or forgotten it.
  const released = new Set<string>();
  for (const [convoId, stream] of activeStreams) {
    const turnId = String(stream?.turnId || '').trim();
    if (!turnId) continue; // Incognito turns are intentionally browser-owned.
    // Stop already aborted the client fetch. If the server still owns this
    // unfinished turn, leave it for the in-flight finalizer. If the server
    // has forgotten it, the SSE is dead — settle now so Processing cannot
    // occupy the composer until restart.
    if (stream.cancelled && !stream.hardStopped) {
      const info = advertised.get(convoId + '\0' + turnId);
      if (info && !info.finished) continue;
      if (typeof cancelLiveBodyReader === 'function') cancelLiveBodyReader(stream);
      try { stream.controller.abort(); } catch { /* ignore */ }
      const convo = conversations.find((item) => item.id === convoId);
      if (convo && typeof settleStoppedLiveStream === 'function') {
        settleStoppedLiveStream(convo, stream);
      } else {
        discardLiveStreamRow(stream);
        finishLiveStream(convoId, stream);
      }
      continue;
    }
    const info = advertised.get(convoId + '\0' + turnId);
    if (info && (!info.finished || stream.catchingUp)) continue;
    // The browser names a turn before the server registers it. A snapshot
    // requested before the server confirmed the turn cannot show it was forgotten.
    if (!info && !(stream.serverTurnSeenAt && stream.serverTurnSeenAt <= snapshotRequestedAt)) {
      continue;
    }
    stream.replaced = true;
    stream.skipQueue = true;
    try { stream.controller.abort(); } catch { /* ignore */ }
    discardLiveStreamRow(stream);
    finishLiveStream(convoId, stream);
    released.add(convoId);

    // A finished turn retains its complete replay buffer briefly. Reattach
    // once from that authoritative copy so a broken response body loses no data.
    if (info?.finished) {
      const convo = conversations.find((item) => item.id === convoId);
      if (convo) void attachLiveTurn(convo, info, { force: true });
    }
  }

  for (const info of list) {
    const id = info && String(info.conversation_id || '').trim();
    if (!id || activeStreams.has(id) || outboundStarting.has(id)) continue;
    if (typeof shouldSkipLiveTurnResume === 'function' && shouldSkipLiveTurnResume(info)) {
      continue;
    }
    let convo: Conversation | null | undefined = conversations.find((item) => item.id === id);
    if (!convo) convo = await syncConvoFromStore(id);
    if (!convo) continue;
    if (
      info.finished
      && info.turn_id
      && convo.messages.some(
        (message) => message.role === 'assistant' && message.liveTurnId === info.turn_id
      )
    ) {
      continue;
    }
    const viewing = activeId === convo.id;
    if (!viewing) {
      const synced = await syncConvoFromStore(id);
      if (synced) convo = synced;
    }
    if (viewing && emptyState && !emptyState.classList.contains('is-hidden')) {
      showThread(convo);
    }
    void attachLiveTurn(convo, info);
  }
  for (const convoId of released) {
    if (!activeStreams.has(convoId)) maybeSendNextQueued(convoId);
  }
}

async function attachLiveTurn(convo: Conversation, info: AdvertisedLiveTurn, { force = false } = {}) {
  if (!convo || activeStreams.has(convo.id) || outboundStarting.has(convo.id) || !serverReady) return;
  if (!force && typeof shouldSkipLiveTurnResume === 'function' && shouldSkipLiveTurnResume(info)) return;
  beginLiveStream(convo, {
    useAgent: !!info?.agent,
    deepResearch: !!info?.deep_research,
    deepResearchOutput: info?.deep_research_output === 'brief' ? 'brief' : 'long',
    turnSkills: {},
    turnForceTools: [],
    catchingUp: true,
    turnId: info?.turn_id || null,
    turnModel: info?.model || '',
  });
  const stream = activeStreams.get(convo.id);
  if (!stream) return;
  try {
    const response = await Promise.race([
      fetch('/api/chat/live/' + encodeURIComponent(convo.id), {
        signal: stream.controller.signal,
      }),
      whenAborted(stream.controller.signal).then(() => {
        const error = new Error('Aborted');
        (error as Error).name = 'AbortError';
        throw error;
      }),
    ]);
    if (!response.ok) {
      if (response.status === 404) {
        discardLiveStreamRow(stream);
        finishLiveStream(convo.id, stream);
        return;
      }
      const problem: ApiErrorResult | null = await response.json().catch(() => null);
      throw new Error((problem && problem.error) || ('Request failed with status ' + response.status));
    }
    await driveAssistantSse(convo, stream, response);
  } catch (error) {
    if ((error as Error).name === 'AbortError' && stream.cancelled) {
      await driveAssistantSse(convo, stream, null);
      return;
    }
    dropLiveSubscriber(convo.id, stream);
  }
}

function beginLiveStream(convo: Conversation, {
  useAgent,
  deepResearch,
  deepResearchOutput,
  turnSkills,
  turnForceTools,
  catchingUp = false,
  turnId = null,
  turnModel = '',
  speakerBotId = null,
  loopPhase = null,
  turnStartedAt = null,
}: StreamOptions = {}): ActiveStream {
  if (activeStreams.has(convo.id)) return activeStreams.get(convo.id)!;
  const requestedStartedAt = Number(turnStartedAt);
  const streamStartedAt = Number.isFinite(requestedStartedAt) && requestedStartedAt > 0
    ? requestedStartedAt : Date.now();
  const stream: ActiveStream = {
    controller: new AbortController(),
    useAgent,
    deepResearch,
    deepResearchOutput,
    turnSkills,
    turnForceTools,
    partial: '',
    timeline: [],
    images: Object.create(null),
    errorMessage: null,
    processNotesCollapsed: true,
    dom: null,
    steerId: null,
    pendingSteers: [],
    catchingUp: !!catchingUp,
    turnId: turnId || null,
    serverTurnSeenAt: catchingUp ? performance.now() : 0,
    turnModel: String(turnModel || ''),
    startedAt: streamStartedAt,
    statusLabel: 'Processing…',
    domMountCount: 0,
    speakerBotId: speakerBotId || null,
    loopPhase: loopPhase && typeof loopPhase === 'object' ? { ...loopPhase } : null,
    convoId: convo.id,
    cancelled: false,
    hardStopped: false,
    settled: false,
    usageStats: {
      completionTokens: 0,
      promptTokens: 0,
      contextPromptTokens: null,
      contextCompletionTokens: null,
      providerTokPerSec: null,
      upstreamModel: null,
    },
    contextRemote: null,
  };
  if (stream.turnId && typeof rememberHandledLiveTurn === 'function') {
    rememberHandledLiveTurn(stream.turnId);
  }
  activeStreams.set(convo.id, stream);
  renderSidebar();
  syncComposerStreamUi();
  if (activeId === convo.id) {
    ensureStreamDom(convo, stream);
    scrollToBottom({ force: true });
  }
  return stream;
}

function streamSpeakerBot(stream: ActiveStream | null | undefined) {
  if (!stream?.speakerBotId || typeof getBot !== 'function') return null;
  const convo = stream.convoId
    ? conversations.find((item) => item.id === stream.convoId)
    : null;
  return getBot(stream.speakerBotId, convo);
}

function streamStatusLabel(stream: ActiveStream | null | undefined, base: string) {
  const label = String(base || 'Processing…').trim() || 'Processing…';
  const bot = streamSpeakerBot(stream);
  return bot ? ('@' + bot.handle + ' · ' + label) : label;
}

function setStreamThinkingLabel(stream: ActiveStream | null | undefined, base: string) {
  if (!stream) return;
  const baseLabel = String(base || 'Processing…').trim() || 'Processing…';
  stream.statusLabel = baseLabel;
  if (!stream.dom?.thinkingLabel) return;
  stream.dom.thinkingLabel.dataset.base = baseLabel;
  const next = streamStatusLabel(stream, baseLabel);
  if (stream.dom.thinkingLabel.textContent !== next) {
    stream.dom.thinkingLabel.textContent = next;
  }
}

function promptProgressLabel(progress: PromptProgress | null | undefined) {
  if (!progress || typeof progress !== 'object') return '';
  const total = Number(progress.total);
  const processed = Number(progress.processed);
  const cached = Number(progress.cache);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(processed)) return '';
  const done = Math.max(0, Math.min(total, processed));
  const percent = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  const details = [`${Math.round(done).toLocaleString()}/${Math.round(total).toLocaleString()} tokens`];
  if (Number.isFinite(cached) && cached > 0) details.push(`${Math.round(cached).toLocaleString()} cached`);
  return `Processing prompt · ${percent}% · ${details.join(' · ')}`;
}

function syncStreamSpeakerChrome(convo: Conversation | null | undefined, stream: ActiveStream) {
  if (!stream?.dom?.row) return;
  const bot = streamSpeakerBot(stream);
  if (bot) {
    syncMessageSpeaker(stream.dom.row, {
      role: 'assistant',
      speakerId: bot.id,
      speakerHandle: bot.handle,
      loopPhaseLabel: stream.loopPhase?.label || '',
      loopPhaseIndex: stream.loopPhase?.index || null,
      loopPhaseTotal: stream.loopPhase?.total || null,
    });
    setStreamThinkingLabel(stream, stream.dom.thinkingLabel?.dataset?.base || 'Processing…');
  } else if (typeof isBotsConvo === 'function' && isBotsConvo(convo)) {
    syncMessageSpeaker(stream.dom.row, { role: 'assistant' });
  }
}

function discardLiveStreamRow(stream: ActiveStream) {
  const row = stream?.dom?.row;
  if (!row) return;
  try { stream.dom?.thinkingOrb?.stop(); } catch { /* ignore */ }
  if (row.isConnected) row.remove();
  stream.dom = null;
}

function settleStoppedLiveStream(convo: Conversation | null | undefined, stream: ActiveStream, rawText?: string | null) {
  if (!convo || !stream || stream.settled) return;
  stream.settled = true;
  stream.cancelled = true;
  const cancelledExtracted = typeof collectTurnMemoryExtraction === 'function'
    ? collectTurnMemoryExtraction(stream, rawText != null ? rawText : stream.partial)
    : { cleaned: String(rawText != null ? rawText : (stream.partial || '')).trim() };
  const cancelledText = String(cancelledExtracted.cleaned || '').trim();
  const cancelledVisible = (typeof streamingAnswerText === 'function'
    ? streamingAnswerText(cancelledText)
    : cancelledText).trim();
  const silentNoReply = typeof isSilentNoReply === 'function'
    && (isSilentNoReply(cancelledVisible) || isSilentNoReply(cancelledText));
  const speakerBotId = stream.speakerBotId || null;
  const speakerBot = speakerBotId && typeof getBot === 'function' ? getBot(speakerBotId, convo) : null;
  if (cancelledVisible && cancelledVisible !== 'No response.' && !silentNoReply) {
    const message: ChatMessage = {
      role: 'assistant',
      content: cancelledText,
      model: stream.turnModel
        || String(selectedChatModel || '').trim()
        || 'model',
    };
    const totalWorkMs = workDurationMs(stream.startedAt, Date.now());
    if (totalWorkMs != null) message.workDurationMs = totalWorkMs;
    if (speakerBot) {
      message.speakerId = speakerBot.id;
      message.speakerHandle = speakerBot.handle;
    }
    if (stream.loopPhase) {
      message.loopRunId = stream.loopPhase.runId || '';
      message.loopPhaseId = stream.loopPhase.id || '';
      message.loopPhaseLabel = stream.loopPhase.label || '';
      message.loopPhaseIndex = stream.loopPhase.index || null;
      message.loopPhaseTotal = stream.loopPhase.total || null;
    }
    const committedMessage = commitLiveAssistant(convo, message, stream.turnId);
    const msgIndex = convo.messages.indexOf(committedMessage);
    const viewing = activeId === convo.id;
    let dom = stream.dom && stream.dom.row && stream.dom.row.isConnected
      ? stream.dom
      : null;
    if (!dom && viewing && !stream.hardStopped) {
      dom = ensureStreamDom(convo, stream);
    }
    if (dom && dom.row.isConnected) {
      try { dom.thinkingOrb?.stop(); } catch { /* ignore */ }
      if (dom.statusEl) dom.statusEl.classList.add('is-hidden');
      delete dom.row.dataset.streamId;
      dom.row.dataset.msgIndex = String(msgIndex);
      dom.row.dataset.raw = committedMessage.content || '';
      if (typeof syncMessageSpeaker === 'function') syncMessageSpeaker(dom.row, committedMessage);
      if (typeof settleAssistantRow === 'function') {
        settleAssistantRow(dom.row, committedMessage, { animateCollapse: false });
      }
    }
    convo.updatedAt = Date.now();
    if (typeof saveConversations === 'function') saveConversations({ immediate: true });
  } else {
    discardLiveStreamRow(stream);
  }
  finishLiveStream(convo.id, stream);
}

async function driveAssistantSse(convo: Conversation, stream: ActiveStream, response: Response | null) {
  const remote = selectedRemoteModel(latestState, stream.speakerModelId);
  const fallbackTurnModel = String(
    stream.turnModel || remote?.model || latestState?.network?.remote_model || 'model'
  ).trim();
  const usageStats = stream.usageStats;
  stream.contextRemote = remote || null;
  let firstTokenAt: number | null = null;

  const typer = createStreamTyper((replyText: string, streaming: boolean) => {
    const nextLabel = isThinkingOpen(replyText)
      ? 'Reasoning…'
      : stream.useAgent
        ? (stream.deepResearch
          ? (stream.deepResearchOutput === 'brief' ? 'Writing brief' : 'Writing report')
          : 'Writing answer')
        : (replyText && replyText.trim())
          ? 'Writing…'
          : 'Processing…';
    setStreamThinkingLabel(stream, nextLabel);
    paintStreamIntoView(convo, stream, replyText, streaming);
  });
  const markFirstToken = (kind: 'reasoning' | 'content') => {
    if (firstTokenAt == null) firstTokenAt = Date.now();
    if (kind && !stream['diagnosticFirst' + kind as 'diagnosticFirstreasoning' | 'diagnosticFirstcontent']) {
      stream['diagnosticFirst' + kind as 'diagnosticFirstreasoning' | 'diagnosticFirstcontent'] = true;
      if (typeof diagnosticStreamMark === 'function') diagnosticStreamMark(stream, convo, 'browser.first_' + kind + '_token');
    }
  };
  const onAgentEvent = (payload: AgentStreamEvent) => {
    if (payload.phase === 'content_clear') {
      // Keep prior think/tool cards — seal the live buffer, then apply any
      // authoritative preface the server resolved for this tool round.
      commitStreamBuffer(stream, typer);
      if (payload.reasoning != null) ensureSealedTimelineThink(stream, payload.reasoning);
      if (payload.text != null) ensureSealedTimelineText(stream, payload.text);
      if (stream.dom) stream.dom.row.dataset.raw = '';
      if (activeId === convo.id && stream.dom) {
        paintStreamIntoView(convo, stream, typer.shown || '', true);
      }
    } else if (payload.phase === 'tool_prepare' || payload.phase === 'tool_call') {
      if (!stream.diagnosticFirstTool) {
        stream.diagnosticFirstTool = true;
        if (typeof diagnosticStreamMark === 'function') diagnosticStreamMark(stream, convo, 'browser.first_tool_token', { name: payload.name });
      }
      commitStreamBuffer(stream, typer);
      if (stream.dom) stream.dom.row.dataset.raw = '';
      const part = upsertLiveToolPart(stream, payload);
      setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
    } else if (payload.phase === 'tool_approval') {
      const part = upsertLiveToolPart(stream, payload);
      setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'tool_executing') {
      const part = upsertLiveToolPart(stream, payload);
      if (part) {
        part.approval = 'allowed';
        part.executing = true;
      }
      setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'terminal') {
      if (typeof onAgentTerminalEvent === 'function') onAgentTerminalEvent(payload);
    } else if (payload.phase === 'tool_result') {
      const resultText = payload.result
        ? String(payload.result).trim()
        : payload.preview
          ? String(payload.preview).trim()
          : 'Done';
      const note = payload.note ? String(payload.note).trim() : '';
      const name = payload.name || 'skill';
      const id = payload.id ? String(payload.id) : '';
      const commandSessionId = payload.command_session_id ? String(payload.command_session_id) : '';
      if (commandSessionId && !payload.running) {
        for (const part of stream.timeline) {
          if (part.type === 'tool' && part.commandSessionId === commandSessionId && part.running) {
            part.running = false;
            part.ok = payload.ok !== false;
            part.note = payload.ok === false ? 'Process failed; see latest session result' : 'Process completed; see latest session result';
          }
        }
      }
      const liveTools = stream.timeline.filter((part) => part.type === 'tool' && part.live);
      const last = (id && stream.timeline.find((part) => part.type === 'tool' && part.id === id))
        || (!id && (liveTools.find((part) => part.name === name && part.live) || liveTools[liveTools.length - 1]));
      if (last && (!id || last.id === id)) {
        last.live = false;
        last.executing = false;
        last.result = resultText;
        last.ok = payload.ok !== false;
        last.running = !!payload.running;
        last.commandSessionId = commandSessionId;
        last.endedAt = Date.now();
        last.durationMs = last.startedAt
          ? Math.max(0, last.endedAt - last.startedAt)
          : 0;
        last.justSettled = true;
        scheduleJustSettledClear(last);
        last.note = note;
        last.approval = payload.ok === false && /denied/i.test(resultText) ? 'denied' : '';
        if (payload.image && /^data:image\//i.test(String(payload.image))) {
          last.image = String(payload.image);
        }
        if (payload.image_id) {
          const imageId = String(payload.image_id);
          last.imageId = imageId;
          if (last.image) {
            if (!stream.images) stream.images = Object.create(null);
            stream.images[imageId] = last.image;
          }
        }
      } else {
        const added = {
          type: 'tool',
          id,
          name: payload.name || 'skill',
          detail: '',
          result: resultText,
          ok: payload.ok !== false,
          running: !!payload.running,
          commandSessionId,
          approval: payload.ok === false && /denied/i.test(resultText) ? 'denied' : '',
          note,
          ...(payload.image && /^data:image\//i.test(String(payload.image))
            ? { image: String(payload.image) }
            : {}),
          ...(payload.image_id ? { imageId: String(payload.image_id) } : {}),
          live: false,
          justSettled: true,
        };
        stream.timeline.push(added);
        stampTimelinePart(added, stream);
        scheduleJustSettledClear(added);
      }
      if (
        payload.image_id
        && payload.image
        && /^data:image\//i.test(String(payload.image))
      ) {
        if (!stream.images) stream.images = Object.create(null);
        stream.images[String(payload.image_id)] = String(payload.image);
      }
      setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'clarify') {
      commitStreamBuffer(stream, typer);
      if (stream.dom) stream.dom.row.dataset.raw = '';
      const clarifyPart = {
        type: 'clarify',
        id: String(payload.id || ''),
        startedAt: Date.now(),
        questions: Array.isArray(payload.questions) ? payload.questions : [],
        draft: {},
        answers: null,
        summary: '',
        live: true,
        submitting: false,
      };
      stream.timeline.push(clarifyPart);
      setStreamThinkingLabel(stream, 'Waiting for your answers…');
      if (stream.dom) {
        mountClarifyForm(stream, clarifyPart);
      }
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'clarify_done') {
      const part = findClarifyPart(stream, String(payload.id || ''));
      if (part) {
        part.live = false;
        part.submitting = false;
        part.answers = payload.answers || {};
        part.summary = String(payload.summary || '').trim();
        mountClarifyForm(stream, part);
      }
      setStreamThinkingLabel(stream, 'Researching…');
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'steer_ready' && payload.id) {
      stream.steerId = String(payload.id);
      void flushPendingSteers(stream);
      if (activeId === convo.id) renderOutboundQueue(convo);
    } else if (payload.phase === 'steer' && payload.content != null) {
      if (typeof sealSteerThinkAndDiscardDraft === 'function') {
        sealSteerThinkAndDiscardDraft(stream, typer);
      } else {
        typer.clear();
        stream.partial = '';
      }
      const text = String(payload.content).trim();
      const clientId = payload.client_id != null ? String(payload.client_id) : '';
      const pending = stream.pendingSteers || [];
      let entryIdx = -1;
      if (clientId) {
        entryIdx = pending.findIndex(
          (entry) => !entry.applied && entry.item?.id === clientId
        );
      }
      if (entryIdx < 0) {
        entryIdx = pending.findIndex((entry) => entry.text === text && !entry.applied);
      }
      if (entryIdx < 0) {
        entryIdx = pending.findIndex((entry) => !entry.applied);
      }
      const entry = entryIdx >= 0 ? pending.splice(entryIdx, 1)[0] : null;
      if (entry) entry.applied = true;
      applySteeredEntry(convo, stream, text, entry);
      setStreamThinkingLabel(stream, 'Steering…');
      if (stream.dom) stream.dom.row.dataset.raw = '';
    } else if (payload.phase === 'status' && payload.message) {
      const msg = String(payload.message);
      const waiting = /waiting for (your )?approval/i.test(msg);
      const canAsk = stream.timeline.some((part) => part.type === 'tool' && part.approval === 'pending');
      if (!waiting || canAsk) {
        setStreamThinkingLabel(stream, msg);
      }
    } else if (payload.phase === 'notice' && payload.message) {
      const text = String(payload.message).trim();
      if (text && !stream.timeline.some((part) => part.type === 'notice' && part.content === text)) {
        stream.timeline.push({ type: 'notice', content: text });
      }
      if (text) setStreamThinkingLabel(stream, text);
    }
    paintStreamIntoView(convo, stream, typer.shown, true);
  };

  if (stream.catchingUp) typer.setCatchingUp(true);

  try {
    if (response && response.body) {
      const reader = response.body.getReader();
      stream.bodyReader = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      try {
      for (;;) {
        if (stream.cancelled || stream.replaced || stream.controller.signal.aborted) break;
        const next = await readStreamChunk(reader, stream.controller.signal);
        if (next.aborted || stream.cancelled || stream.replaced) break;
        const { value, done } = next.chunk;
        if (done) break;
        if (!stream.diagnosticFirstByte) {
          stream.diagnosticFirstByte = true;
          if (typeof diagnosticStreamMark === 'function') diagnosticStreamMark(stream, convo, 'browser.first_byte', { bytes: value.byteLength });
        }
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? '';
        for (const rawEvent of events) {
          const parsed = parseSseEvent(rawEvent);
          if (!parsed || parsed.data === '' || parsed.data === '[DONE]') continue;
          if (parsed.event === 'meta') {
            try {
              const meta: Partial<AdvertisedLiveTurn> = JSON.parse(parsed.data);
              if (meta.turn_id) {
                stream.turnId = String(meta.turn_id);
                stream.serverTurnSeenAt = performance.now();
                if (typeof rememberHandledLiveTurn === 'function') {
                  rememberHandledLiveTurn(stream.turnId);
                }
              }
              if (typeof meta.agent === 'boolean') stream.useAgent = meta.agent;
              if (typeof meta.deep_research === 'boolean') stream.deepResearch = meta.deep_research;
              if (meta.deep_research_output === 'brief' || meta.deep_research_output === 'long') {
                stream.deepResearchOutput = meta.deep_research_output;
              }
              if (meta.model) stream.turnModel = String(meta.model);
              if (typeof meta.finished === 'boolean') stream.serverFinished = meta.finished;
            } catch {
              // ignore malformed meta
            }
            continue;
          }
          if (parsed.event === 'live') {
            stream.catchingUp = false;
            typer.setCatchingUp(false);
            if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
            continue;
          }
          if (parsed.event === 'error') {
            try {
              stream.errorMessage = contextualModelError(
                JSON.parse(parsed.data).error || parsed.data,
                stream.turnModel || fallbackTurnModel
              );
            } catch {
              stream.errorMessage = contextualModelError(
                parsed.data,
                stream.turnModel || fallbackTurnModel
              );
            }
            continue;
          }
          if (parsed.event === 'agent') {
            try {
              onAgentEvent(JSON.parse(parsed.data));
            } catch {
              // ignore malformed agent frames
            }
            continue;
          }
          let json: BrowserCompletionFrame;
          try {
            json = JSON.parse(parsed.data);
          } catch {
            continue;
          }
          ingestStreamUsage(usageStats, json);
          if (activeId === convo.id) syncContextUsage(convo, usageStats, remote);
          const progressLabel = promptProgressLabel(json.prompt_progress);
          if (progressLabel && firstTokenAt == null) setStreamThinkingLabel(stream, progressLabel);
          const choice = json.choices && json.choices[0];
          const deltaObj = (choice && choice.delta) || {};
          const reasoning =
            deltaObj.reasoning_content ||
            deltaObj.reasoning ||
            (choice && choice.message && (choice.message.reasoning_content || choice.message.reasoning)) ||
            '';
          if (reasoning) {
            markFirstToken('reasoning');
            typer.pushReasoning(String(reasoning));
          }
          const delta = deltaObj.content || '';
          if (delta) {
            markFirstToken('content');
            typer.push(delta);
          }
        }
      }
      } finally {
        stream.bodyReader = null;
        try { await reader.cancel(); } catch { /* ignore */ }
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      if (stream.replaced) {
        dropLiveSubscriber(convo.id, stream);
        return;
      }
      if (!stream.cancelled) {
        dropLiveSubscriber(convo.id, stream);
        if (!stream.skipQueue) maybeSendNextQueued(convo.id);
        return;
      }
    } else {
      stream.errorMessage = contextualModelError(
        (error as Error).message,
        stream.turnModel || fallbackTurnModel
      );
    }
  }

  let queueAfter = !stream.skipQueue && !stream.replaced;
  try {
  if (stream.settled || stream.replaced || activeStreams.get(convo.id) !== stream) {
    queueAfter = false;
    return;
  }
  typer.flush();
  if (!conversations.some((item) => item.id === convo.id)) {
    return;
  }

  // Stop mid-turn: keep any useful partial reply; never spam empty "No response." rows.
  if (stream.cancelled || (typeof isBotsOutboundStopped === 'function' && isBotsOutboundStopped(convo.id))) {
    queueAfter = false;
    settleStoppedLiveStream(convo, stream, typer.target);
    return;
  }

  const endedAt = Date.now();
  const finalStats: FinalTurnStats | null = finalizeTurnStats(usageStats, firstTokenAt, endedAt);
  if (finalStats) {
    const contextWindowTokens = Number(remote?.context_length);
    finalStats.contextWindowTokens = Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
      ? contextWindowTokens
      : null;
    finalStats.contextModel = String(
      remote?.model || stream.turnModel || fallbackTurnModel || ''
    ).trim() || null;
  }
  const speakerBotId = stream.speakerBotId || null;
  const speakerBot = speakerBotId && typeof getBot === 'function' ? getBot(speakerBotId, convo) : null;
  const extracted = collectTurnMemoryExtraction(stream, typer.target);
  const memoryChanges = applyExtractedMemories(convo, extracted, speakerBotId);
  const memoryNotices = memoryNoticeLabels(memoryChanges);
  // Memory chips live on the message; do not also push tone:ok notices into the
  // timeline (those were deferred to the bottom and duplicated the chips).
  let assistantText = extracted.cleaned;
  if (!assistantText && !stream.errorMessage) {
    assistantText = memoryOnlyAssistantFallback(extracted);
  }
  const visibleAnswer = streamingAnswerText(assistantText).trim();
  const silentNoReply = typeof isSilentNoReply === 'function'
    && (isSilentNoReply(visibleAnswer) || isSilentNoReply(assistantText));
  if (silentNoReply) {
    discardLiveStreamRow(stream);
    return;
  }
  // Think-only finals used to persist a blank desktop bubble while Activity looked fine.
  if (!visibleAnswer && !stream.errorMessage && stream.timeline.length) {
    stream.errorMessage = 'No user-visible answer after tools. Try again.';
  }

  // If Stop won the race after we left the cancel branch, still refuse placeholder spam.
  if (
    stream.cancelled
    || (typeof isBotsOutboundStopped === 'function' && isBotsOutboundStopped(convo.id))
  ) {
    queueAfter = false;
    settleStoppedLiveStream(convo, stream, typer.target);
    return;
  }

  stream.timeline.forEach((part) => {
    if (part.type === 'tool') {
      if (part.live && part.startedAt && !Number.isFinite(part.durationMs)) {
        part.endedAt = Date.now();
        part.durationMs = Math.max(0, part.endedAt - part.startedAt);
      }
      part.live = false;
    } else if (part.type === 'clarify') {
      part.live = false;
    }
  });
  // Seal any leftover buffer so a final think/answer round joins the timeline
  // only as live content (not duplicated into parts).
  const viewing = activeId === convo.id;
  let dom = viewing ? ensureStreamDom(convo, stream) : stream.dom;
  const persistedParts = stream.timeline.length
    ? stream.timeline.map((part) => (
      part.type === 'tool'
        ? {
          type: 'tool',
          name: part.name,
          detail: part.detail,
          result: part.result,
          ...(typeof part.ok === 'boolean' ? { ok: part.ok } : {}),
          ...(part.commandSessionId ? { commandSessionId: part.commandSessionId, running: !!part.running } : {}),
          ...(part.approval === 'denied' ? { approval: 'denied' } : {}),
          ...(part.note ? { note: part.note } : {}),
          ...(part.kind ? { kind: part.kind } : {}),
          ...(Number.isFinite(part.durationMs) ? { durationMs: Math.round(part.durationMs!) } : {}),
          ...(part.image ? { image: part.image } : {}),
          live: false,
        }
        : part.type === 'clarify'
          ? {
            type: 'clarify',
            id: part.id,
            questions: part.questions || [],
            answers: part.answers || null,
            summary: part.summary || '',
            live: false,
          }
        : part.type === 'notice'
          ? {
            type: 'notice',
            content: part.content,
            ...(part.tone ? { tone: part.tone } : {}),
            ...(part.kind ? { kind: part.kind } : {}),
          }
          : { type: part.type, content: part.content }
    ))
    : null;

  if (viewing && dom) {
    const savedClarify = preserveClarifyHost(dom.answerEl);
    if (stream.errorMessage && !visibleAnswer) {
      const errHtml = '<span class="msg-error">' + escapeHtml(stream.errorMessage) + '</span>';
      dom.answerEl.innerHTML = isDesktopTraceLayout()
        ? errHtml
        : (renderCommittedParts(stream.timeline) + errHtml);
    } else if (stream.errorMessage) {
      paintStreamIntoView(convo, stream, assistantText, false);
      dom = stream.dom;
      if (dom) {
        dom.answerEl.insertAdjacentHTML(
          'beforeend',
          '<span class="msg-error">' + escapeHtml(stream.errorMessage) + '</span>'
        );
      }
    } else if (!visibleAnswer) {
      if (!stream.errorMessage) stream.errorMessage = 'No response.';
      const errHtml = '<span class="msg-error">' + escapeHtml(stream.errorMessage) + '</span>';
      if (isDesktopTraceLayout()) {
        dom.answerEl.innerHTML = errHtml;
      } else {
        const committed = renderCommittedParts(stream.timeline);
        dom.answerEl.innerHTML = committed ? committed + errHtml : errHtml;
      }
    } else {
      paintStreamIntoView(convo, stream, assistantText, false);
      dom = stream.dom;
    }
    if (dom) {
      restoreClarifyHost(dom.answerEl, savedClarify || dom.clarifyHost);
      const doneClarify = stream.timeline.find((part) => part.type === 'clarify');
      if (doneClarify) mountClarifyForm(stream, doneClarify);
      dom.thinkingOrb.stop();
      dom.statusEl.classList.add('is-hidden');
      delete dom.row.dataset.streamId;
    }
  }

  if (assistantText || persistedParts || memoryNotices.length || stream.errorMessage) {
    const message: ChatMessage = {
      role: 'assistant',
      content: visibleAnswer ? assistantText : '',
      model: stream.turnModel
        || finalStats?.upstreamModel
        || fallbackTurnModel
        || String(selectedChatModel || '').trim()
        || 'model',
    };
    const totalWorkMs = workDurationMs(stream.startedAt, Date.now());
    if (totalWorkMs != null) message.workDurationMs = totalWorkMs;
    if (speakerBot) {
      message.speakerId = speakerBot.id;
      message.speakerHandle = speakerBot.handle;
    }
    if (stream.loopPhase) {
      message.loopRunId = stream.loopPhase.runId || '';
      message.loopPhaseId = stream.loopPhase.id || '';
      message.loopPhaseLabel = stream.loopPhase.label || '';
      message.loopPhaseIndex = stream.loopPhase.index || null;
      message.loopPhaseTotal = stream.loopPhase.total || null;
    }
    if (persistedParts) message.parts = persistedParts;
    if (stream.images && Object.keys(stream.images).length) {
      message.images = { ...stream.images };
    }
    if (memoryNotices.length) message.memoryNotices = memoryNotices;
    if (stream.errorMessage && !visibleAnswer) {
      message.error = stream.errorMessage;
      if (!message.content) message.content = stream.errorMessage;
    }
    if (finalStats?.tokensPerSec != null) message.tokensPerSec = finalStats.tokensPerSec;
    if (finalStats?.completionTokens != null) message.completionTokens = finalStats.completionTokens;
    if (finalStats?.promptTokens != null) message.promptTokens = finalStats.promptTokens;
    if (finalStats?.contextPromptTokens != null) message.contextPromptTokens = finalStats.contextPromptTokens;
    if (finalStats?.contextCompletionTokens != null) message.contextCompletionTokens = finalStats.contextCompletionTokens;
    if (finalStats?.contextTokens != null) message.contextTokens = finalStats.contextTokens;
    if (finalStats?.contextWindowTokens != null) message.contextWindowTokens = finalStats.contextWindowTokens;
    if (finalStats?.contextModel) message.contextModel = finalStats.contextModel;
    const committedMessage = commitLiveAssistant(convo, message, stream.turnId);
    if (typeof applyBotActions === 'function' && speakerBot) {
      applyBotActions(convo, speakerBot, extracted.botActions);
    }
    const msgIndex = convo.messages.indexOf(committedMessage);
    if (dom && dom.row.isConnected) {
      dom.row.dataset.msgIndex = String(msgIndex);
      dom.row.dataset.raw = committedMessage.content || '';
      syncMessageSpeaker(dom.row, committedMessage);
      settleAssistantRow(dom.row, committedMessage, { animateCollapse: true });
    }
    convo.updatedAt = Date.now();
    if (typeof recordConversationNotification === 'function') {
      recordConversationNotification(convo, {
        kind: stream.errorMessage ? 'error' : 'complete',
        at: endedAt,
      });
    }
    if (convo.projectId) {
      const project = getProject(convo.projectId);
      if (project) project.updatedAt = Date.now();
    }
    saveConversations({ immediate: true });
    if (activeId === convo.id) {
      selectTraceMessage(msgIndex, {
        animate: true,
        ensureOpen: false,
      });
      if (messageHasActivity(committedMessage)) maybeAutoOpenTraceSidebar(convo.id);
    }
  } else {
    discardLiveStreamRow(stream);
  }

  if (activeId === convo.id) {
    // If we finished while away and came back to a thread without the row, re-render.
    if (!dom || !dom.row.isConnected) {
      renderThread(convo);
    }
    composerInput.focus();
  }
  } catch (error) {
    console.warn('Assistant turn finalize failed:', (error as Error)?.message || error);
    if (!stream.errorMessage) {
      stream.errorMessage = (error as Error)?.message || 'The request failed.';
    }
  } finally {
    const finished = activeStreams.get(convo.id) === stream && finishLiveStream(convo.id, stream);
    if (finished && queueAfter) {
      maybeSendNextQueued(convo.id);
    }
    if (!stream.skipQueue && typeof flushBotNavigation === 'function') {
      flushBotNavigation();
    }
  }
}

chatThread.addEventListener('click', (event) => {
  const queueSteer = ((event.target as Element).closest('[data-queue-steer]') as HTMLElement);
  if (queueSteer && chatThread.contains(queueSteer)) {
    event.preventDefault();
    const queueId = queueSteer.getAttribute('data-queue-steer');
    if (activeId && queueId) steerQueuedOutbound(activeId, queueId);
    return;
  }
  const steerCancel = ((event.target as Element).closest('[data-steer-cancel]') as HTMLElement);
  if (steerCancel && chatThread.contains(steerCancel)) {
    event.preventDefault();
    const queueId = steerCancel.getAttribute('data-steer-cancel');
    if (activeId && queueId) cancelPendingSteer(activeId, queueId);
    return;
  }
  const queueRemove = ((event.target as Element).closest('[data-queue-remove]') as HTMLElement);
  if (queueRemove && chatThread.contains(queueRemove)) {
    event.preventDefault();
    const queueId = queueRemove.getAttribute('data-queue-remove');
    if (activeId && queueId) removeQueuedOutbound(activeId, queueId);
    return;
  }
  const queueEdit = ((event.target as Element).closest('[data-queue-edit]') as HTMLElement);
  if (queueEdit && chatThread.contains(queueEdit)) {
    event.preventDefault();
    const queueId = queueEdit.getAttribute('data-queue-edit');
    const row = queueId
      ? [...(chatThread.querySelectorAll('.msg-queued') as NodeListOf<HTMLElement>)].find((el) => el.dataset.queueId === queueId)
      : null;
    if (row) beginQueuedMessageEdit(row);
    return;
  }
  const clarifySubmit = ((event.target as Element).closest('[data-clarify-submit]') as HTMLElement);
  if (clarifySubmit && chatThread.contains(clarifySubmit)) {
    event.preventDefault();
    const clarifyId = clarifySubmit.getAttribute('data-clarify-submit');
    const stream = activeStream();
    if (stream && clarifyId) void submitClarifyForm(stream, clarifyId);
    return;
  }
  const allowBtn = ((event.target as Element).closest('[data-tool-allow]') as HTMLElement);
  const denyBtn = ((event.target as Element).closest('[data-tool-deny]') as HTMLElement);
  if ((allowBtn || denyBtn) && chatThread.contains(allowBtn || denyBtn)) {
    event.preventDefault();
    const id = (allowBtn || denyBtn)!.getAttribute(allowBtn ? 'data-tool-allow' : 'data-tool-deny');
    if (id) void submitToolApproval(id, !!allowBtn);
    return;
  }
  const foldToggle = ((event.target as Element).closest('.agent-timeline-fold-toggle') as HTMLElement);
  if (foldToggle && chatThread.contains(foldToggle)) {
    event.preventDefault();
    const fold = (foldToggle.closest('.agent-timeline-fold') as HTMLElement);
    if (!fold) return;
    const collapsed = fold.classList.toggle('is-collapsed');
    foldToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (fold.classList.contains('agent-process-notes')) {
      const row = (fold.closest('.msg-role-assistant') as HTMLElement);
      const live = row && activeId ? activeStreams.get(activeId) : null;
      if (live && live.dom?.row === row) live.processNotesCollapsed = collapsed;
    }
    return;
  }
  const btn = ((event.target as Element).closest('.md-code-copy') as HTMLElement);
  if (btn && chatThread.contains(btn)) {
    event.preventDefault();
    copyCodeBlock(btn);
    return;
  }
  if (((event.target as Element).closest('.msg-action, a, button, summary, details, input, textarea, .clarify-card, #selectionReplyBar') as HTMLElement)) {
    return;
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && String(sel.toString() || '').trim()) {
    // Don't steal focus from a text selection / Reply affordance.
    return;
  }
  const row = ((event.target as Element).closest('.msg-role-assistant') as HTMLElement);
  if (!row || !chatThread.contains(row)) return;
  const index = Number(row.dataset.msgIndex);
  if (!Number.isFinite(index)) return;
  selectTraceMessage(index, { animate: true, ensureOpen: false });
});

document.addEventListener('click', (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = ((event.target as Element).closest?.('a[href]') as HTMLAnchorElement);
  const source = link && chatSourceTarget(link.getAttribute('href'));
  if (!source) return;
  event.preventDefault();
  event.stopPropagation();
  if (!conversations.some((chat) => chat.id === source.id) || diskEncryptionLocked()) {
    alert('This source chat is no longer available in the current profile.');
    return;
  }
  selectConversation(source.id);
  scrollToChatSource(source.message);
}, true);

document.addEventListener('click', (event) => {
  const allowBtn = ((event.target as Element).closest('[data-tool-allow]') as HTMLElement);
  const denyBtn = ((event.target as Element).closest('[data-tool-deny]') as HTMLElement);
  if (!allowBtn && !denyBtn) return;
  if (chatThread.contains(allowBtn || denyBtn)) return;
  event.preventDefault();
  const id = (allowBtn || denyBtn)!.getAttribute(allowBtn ? 'data-tool-allow' : 'data-tool-deny');
  if (id) void submitToolApproval(id, !!allowBtn);
});

chatThread.addEventListener('change', (event) => {
  const input = ((event.target as Element).closest('.clarify-card input') as HTMLInputElement);
  if (!input || !chatThread.contains(input)) return;
  const card = (input.closest('.clarify-card') as HTMLElement);
  const host = (card?.closest('.clarify-host') as HTMLElement);
  const clarifyId = card?.dataset.clarifyId;
  const stream = activeStream();
  const part = stream && clarifyId ? findClarifyPart(stream, clarifyId) : null;
  if (!part || !part.live) return;
  const qi = Number(input.dataset.clarifyQ);
  if (!Number.isFinite(qi)) return;
  if (!part.draft) part.draft = {};
  const qEl = (card.querySelector('.clarify-q[data-clarify-q="' + qi + '"]') as HTMLElement);
  const multi = !!part.questions?.[qi]?.multiSelect;
  if (input.dataset.clarifyOther) {
    if (input.checked) {
      if (!multi) {
        qEl?.querySelectorAll<HTMLInputElement>('input[data-clarify-opt]').forEach((el) => { el.checked = false; });
      }
      part.draft[qi] = {
        labels: [],
        custom: String((qEl?.querySelector('[data-clarify-custom]') as HTMLInputElement)?.value || ''),
        useCustom: true,
      };
    }
  } else if (input.dataset.clarifyOpt != null) {
    const other = (qEl?.querySelector('input[data-clarify-other]') as HTMLInputElement);
    if (other && !multi) other.checked = false;
    const labels = [...((qEl?.querySelectorAll('input[data-clarify-opt]:checked') as NodeListOf<HTMLInputElement>) || [])].map((el) => el.value);
    part.draft[qi] = {
      labels,
      custom: String(part.draft[qi]?.custom || ''),
      useCustom: false,
    };
  }
  mountClarifyForm(stream!, part);
  const custom = (host?.querySelector('.clarify-q[data-clarify-q="' + qi + '"] [data-clarify-custom]') as HTMLInputElement);
  if (part.draft[qi]?.useCustom && custom) {
    custom.focus();
    custom.selectionStart = custom.value.length;
  }
});

chatThread.addEventListener('input', (event) => {
  const custom = ((event.target as Element).closest('[data-clarify-custom]') as HTMLInputElement);
  if (!custom || !chatThread.contains(custom)) return;
  const card = (custom.closest('.clarify-card') as HTMLElement);
  const host = (card?.closest('.clarify-host') as HTMLElement);
  const clarifyId = card?.dataset.clarifyId;
  const stream = activeStream();
  const part = stream && clarifyId ? findClarifyPart(stream, clarifyId) : null;
  if (!part || !part.live) return;
  const qi = Number(custom.dataset.clarifyQ);
  if (!Number.isFinite(qi)) return;
  if (!part.draft) part.draft = {};
  part.draft[qi] = {
    labels: [],
    custom: custom.value,
    useCustom: true,
  };
  syncClarifySubmitEnabled(host);
});

btnSend.addEventListener('click', () => { void sendMessage(); });
btnBranch?.addEventListener('click', () => { void sendMessage({ branch: true }); });
btnSelectionReply?.addEventListener('mousedown', (event) => {
  // Keep the selection until we capture it in the click handler.
  event.preventDefault();
});
btnSelectionReply?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const quote = assistantSelectionQuote();
  if (quote) {
    const index = Number(quote.row?.dataset.msgIndex);
    const convo = conversations.find((item) => item.id === activeId);
    const message = Number.isInteger(index) ? convo?.messages?.[index] : null;
    setPendingReply(quote.text, resolveReplySpeaker(convo, quote.row, message));
  } else {
    hideSelectionReplyBar();
  }
});
document.addEventListener('selectionchange', () => {
  // Defer so mouseup can finish updating the range first.
  queueMicrotask(syncSelectionReplyBar);
});
document.addEventListener('mouseup', () => {
  queueMicrotask(syncSelectionReplyBar);
});
chatViewport?.addEventListener('scroll', hideSelectionReplyBar, { passive: true });
window.addEventListener('scroll', hideSelectionReplyBar, true);
window.addEventListener('resize', hideSelectionReplyBar);
function kickVisibleLiveToolMotion() {
  if (typeof kickLiveToolMotion !== 'function') return;
  if (traceSidebarBody) kickLiveToolMotion(traceSidebarBody);
  if (chatThread) kickLiveToolMotion(chatThread);
}
window.addEventListener('focus', kickVisibleLiveToolMotion);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') kickVisibleLiveToolMotion();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideSelectionReplyBar();
});
btnStop.addEventListener('click', () => {
  if (!activeId) return;
  const stoppedId = activeId;
  if (typeof pauseOutboundQueueAfterStop === 'function') pauseOutboundQueueAfterStop(stoppedId);
  // The stream finalizer owns its accumulated text. Keep it registered so the
  // AbortError path can commit the partial assistant message before teardown.
  void abortStream(stoppedId, { preservePartial: true });
  syncComposerStreamUi();
  renderSidebar();
  updateComposerHint();
});
btnPlus?.addEventListener('click', (event) => {
  event.stopPropagation();
  setPlusMenuOpen(!plusMenuIsOpen());
});
plusMenu?.addEventListener('click', (event) => {
  const item = ((event.target as Element).closest('[data-plus-action]') as HTMLButtonElement);
  if (!item || item.disabled) return;
  handlePlusMenuAction(item.dataset.plusAction);
});
btnMic?.addEventListener('click', () => {
  if (btnMic.getAttribute('aria-disabled') === 'true') {
    showVoiceHint(
      diskEncryptionLocked()
        ? 'Unlock local data to use voice input.'
        : 'Connect a provider before using voice input.'
    );
    return;
  }
  toggleVoiceInput();
});
attachFileInput.addEventListener('change', async (event) => {
  const files = Array.from((event.target as HTMLInputElement).files || []);
  (event.target as HTMLInputElement).value = '';
  if (files.length) await addFilesToPending(files);
});
composerAttachmentsEl.addEventListener('click', (event) => {
  const btn = ((event.target as Element).closest('[data-attach-remove]') as HTMLElement);
  if (!btn) return;
  removePendingAttachment(btn.getAttribute('data-attach-remove'));
});
;['dragenter', 'dragover'].forEach((type) => {
  composerCard.addEventListener(type, (event) => {
    if (!attachmentsUiEnabled()) return;
    event.preventDefault();
    composerCard.classList.add('is-dragover');
  });
});
;['dragleave', 'drop'].forEach((type) => {
  composerCard.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'dragleave' && composerCard.contains((event as DragEvent).relatedTarget as Node | null)) return;
    composerCard.classList.remove('is-dragover');
    if (type === 'drop' && (event as DragEvent).dataTransfer?.files?.length) {
      void addFilesToPending(Array.from((event as DragEvent).dataTransfer!.files));
    }
  });
});
composerInput.addEventListener('paste', (event) => {
  const items = event.clipboardData?.items;
  if (!items || !attachmentsUiEnabled()) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (!files.length) return;
  event.preventDefault();
  void addFilesToPending(files);
});
(document.getElementById('settingAttachmentTextFallback') as HTMLInputElement).addEventListener('change', syncAttachmentFallbackControls);

const APP_SURFACES = {
  chat: 'Agent',
  bots: 'Loops',
};
let wordmarkMenuCloseTimer = 0;
let wordmarkLabelTimer = 0;

function wordmarkMenuIsOpen() {
  const wrap = (document.getElementById('wordmarkSwitch') as HTMLElement);
  const menu = (document.getElementById('wordmarkMenu') as HTMLElement);
  return !!(wrap && menu && wrap.classList.contains('is-open') && !menu.classList.contains('is-hidden'));
}

function setWordmarkMenuOpen(open: boolean) {
  const wrap = (document.getElementById('wordmarkSwitch') as HTMLElement);
  const menu = (document.getElementById('wordmarkMenu') as HTMLElement);
  const btn = (document.getElementById('btnWordmarkSurface') as HTMLButtonElement);
  if (!wrap || !menu || !btn) return;
  if (wordmarkMenuCloseTimer) {
    window.clearTimeout(wordmarkMenuCloseTimer);
    wordmarkMenuCloseTimer = 0;
  }
  if (open) {
    setThinkMenuOpen(false);
    setPlusMenuOpen(false);
    closeConvoMenu();
    menu.classList.remove('is-hidden');
    btn.setAttribute('aria-expanded', 'true');
    void menu.offsetWidth;
    afterNextPaint(() => {
      if (btn.getAttribute('aria-expanded') === 'true') wrap.classList.add('is-open');
    });
    return;
  }
  wrap.classList.remove('is-open');
  btn.setAttribute('aria-expanded', 'false');
  const finish = () => {
    menu.classList.add('is-hidden');
    wordmarkMenuCloseTimer = 0;
  };
  if (prefersReducedMotion()) {
    finish();
    return;
  }
  wordmarkMenuCloseTimer = window.setTimeout(finish, 220);
}

function paintWordmarkSurface(id: string | undefined) {
  const next = APP_SURFACES[id as ApplicationSurface] ? id as ApplicationSurface : 'chat';
  const label = APP_SURFACES[next];
  const btn = (document.getElementById('btnWordmarkSurface') as HTMLButtonElement);
  const labelEl = (document.getElementById('wordmarkSurfaceLabel') as HTMLElement);
  const menu = (document.getElementById('wordmarkMenu') as HTMLElement);
  const changed = appSurface !== next;
  appSurface = next;
  (document.getElementById('chatShell') as HTMLElement)?.setAttribute('data-surface', next);
  document.title = 'Gopher | ' + label;
  if (btn) btn.setAttribute('aria-label', 'Surface: ' + label + '. Switch surface');
  menu?.querySelectorAll<HTMLElement>('[data-surface]').forEach((item) => {
    const on = item.dataset.surface === next;
    item.classList.toggle('is-active', on);
    item.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  if (!labelEl || labelEl.textContent === label) return;
  if (!changed || prefersReducedMotion()) {
    labelEl.classList.remove('is-exit', 'is-enter');
    labelEl.textContent = label;
    return;
  }
  if (wordmarkLabelTimer) window.clearTimeout(wordmarkLabelTimer);
  labelEl.classList.remove('is-enter');
  labelEl.classList.add('is-exit');
  wordmarkLabelTimer = window.setTimeout(() => {
    labelEl.textContent = label;
    labelEl.classList.add('is-enter');
    labelEl.classList.remove('is-exit');
    void labelEl.offsetWidth;
    labelEl.classList.remove('is-enter');
    wordmarkLabelTimer = 0;
  }, 160);
}

function wordmarkMenuItems() {
  const menu = (document.getElementById('wordmarkMenu') as HTMLElement);
  return menu ? [...(menu.querySelectorAll('[data-surface]') as NodeListOf<HTMLElement>)] : [];
}

function focusWordmarkMenuItem(index: number) {
  const items = wordmarkMenuItems();
  if (!items.length) return;
  const next = (index + items.length) % items.length;
  items[next]?.focus();
}

(document.getElementById('btnWordmarkSurface') as HTMLButtonElement)?.addEventListener('click', (event) => {
  event.stopPropagation();
  setWordmarkMenuOpen(!wordmarkMenuIsOpen());
});
(document.getElementById('btnWordmarkSurface') as HTMLButtonElement)?.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  setWordmarkMenuOpen(true);
  const items = wordmarkMenuItems();
  focusWordmarkMenuItem(event.key === 'ArrowUp' ? items.length - 1 : 0);
});
(document.getElementById('wordmarkMenu') as HTMLElement)?.addEventListener('click', (event) => {
  const item = ((event.target as Element).closest('[data-surface]') as HTMLElement);
  if (!item) return;
  if (typeof applyAppSurface === 'function') applyAppSurface(item.dataset.surface);
  else paintWordmarkSurface(item.dataset.surface);
  setWordmarkMenuOpen(false);
  (document.getElementById('btnWordmarkSurface') as HTMLButtonElement)?.focus();
});
(document.getElementById('wordmarkMenu') as HTMLElement)?.addEventListener('keydown', (event) => {
  const items = wordmarkMenuItems();
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusWordmarkMenuItem(index + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    focusWordmarkMenuItem(index < 0 ? items.length - 1 : index - 1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    focusWordmarkMenuItem(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    focusWordmarkMenuItem(items.length - 1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    setWordmarkMenuOpen(false);
    (document.getElementById('btnWordmarkSurface') as HTMLButtonElement)?.focus();
  }
});
paintWordmarkSurface(appSurface);

(document.getElementById('btnThink') as HTMLButtonElement).addEventListener('click', (event) => {
  event.stopPropagation();
  setThinkMenuOpen(!thinkMenuIsOpen());
});
(document.getElementById('thinkMenu') as HTMLElement).addEventListener('click', (event) => {
  const item = ((event.target as Element).closest('[data-effort]') as HTMLElement);
  if (!item) return;
  setThinkingEffort(item.dataset.effort, true);
  setThinkMenuOpen(false);
});
document.addEventListener('click', (event) => {
  const thinkWrap = (document.getElementById('composerThinkWrap') as HTMLElement);
  const plusWrap = (document.getElementById('composerPlusWrap') as HTMLElement);
  const wordmarkWrap = (document.getElementById('wordmarkSwitch') as HTMLElement);
  if (thinkWrap && !thinkWrap.contains(event.target as Node) && thinkMenuIsOpen()) {
    setThinkMenuOpen(false);
  }
  const clickedPlus = (plusWrap && plusWrap.contains(event.target as Node))
    || (plusMenu && plusMenu.contains(event.target as Node));
  if (!clickedPlus && plusMenuIsOpen()) {
    setPlusMenuOpen(false);
  }
  if (wordmarkWrap && !wordmarkWrap.contains(event.target as Node) && wordmarkMenuIsOpen()) {
    setWordmarkMenuOpen(false);
  }
});
(document.getElementById('settingThinkingEffort') as HTMLSelectElement).addEventListener('change', (event) => {
  setThinkingEffort((event.target as HTMLInputElement).value, true);
});
syncThinkingEffortControls(settings.thinkingEffort);
syncResearchControls();
renderPlusMenu();
syncComposerThinkVisibility(null);
syncAttachButton();
syncMicButton();
syncAttachmentFallbackControls();
(document.getElementById('btnNewChat') as HTMLButtonElement).addEventListener('click', () => {
  // New chat stays in the current project context when one is active.
  startDraft({ incognito: false });
});
btnNewIncognitoChat?.addEventListener('click', () => {
  startDraft({ incognito: true });
});
btnProjectsNav.addEventListener('click', showProjectsView);
btnNotificationsNav.addEventListener('click', showNotificationsView);
btnNotificationsMarkRead.addEventListener('click', () => {
  let changed = false;
  for (const convo of conversations) {
    changed = markConversationNotificationRead(convo, { persist: false }) || changed;
  }
  if (changed) saveConversations({ immediate: true });
  refreshNotificationsUi();
  renderSidebar();
});
btnManageConvos?.addEventListener('click', () => {
  setConversationSelectionMode(!conversationSelectionMode);
});
btnBulkPinConvos?.addEventListener('click', bulkSetSelectedConversationsPinned);
btnBulkDeleteConvos?.addEventListener('click', () => {
  void bulkDeleteSelectedConversations();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || mainView !== 'chat' || !activeId) return;
  const convo = conversations.find((item) => item.id === activeId);
  if (!markConversationNotificationRead(convo)) return;
  renderSidebar();
});
(document.getElementById('btnNewProject') as HTMLButtonElement).addEventListener('click', createProject);
projectsSearch.addEventListener('input', renderProjectsPage);
projectsSort.addEventListener('change', renderProjectsPage);
const btnToggleSidebar = (document.getElementById('btnToggleSidebar') as HTMLButtonElement);
const btnPrivacyMode = (document.getElementById('btnPrivacyMode') as HTMLButtonElement);
const sidebarMobileMq = window.matchMedia('(max-width: 820px)');

initTraceSidebarPreferred();
btnExpandTrace?.addEventListener('click', () => {
  const open = chatShell.classList.contains('trace-collapsed');
  stickTraceSidebar = open;
  setTraceSidebarOpen(open, { fromUser: true });
  if (open) scrollTraceSidebarToBottom({ force: true });
});
if (traceSidebarBody) {
  let lastTraceScrollTop = 0;
  traceSidebarBody.addEventListener('scroll', () => {
    const top = traceSidebarBody.scrollTop;
    const goingUp = top < lastTraceScrollTop - 1;
    lastTraceScrollTop = top;
    if (goingUp && !isTraceSidebarNearBottom()) {
      stickTraceSidebar = false;
    } else if (isTraceSidebarNearBottom()) {
      stickTraceSidebar = true;
    }
  }, { passive: true });
}
TRACE_DESKTOP_MQ.addEventListener('change', () => {
  const convo = conversations.find((item) => item.id === activeId);
  if (convo && !threadWrap.classList.contains('is-hidden')) {
    // Re-render so bubbles pick the desktop/mobile activity layout.
    const keep = selectedTraceMsgIndex;
    const wasLive = activeStreams.has(convo.id);
    renderThread(convo);
    // Live reattach already reselects the in-flight row.
    if (!wasLive && keep != null) selectTraceMessage(keep, { animate: false });
  } else {
    refreshTraceSidebar({ animate: false });
  }
});

function sidebarIsMobileDrawer() {
  return sidebarMobileMq.matches;
}

function sidebarIsOpen() {
  return sidebarIsMobileDrawer()
    ? chatShell.classList.contains('sidebar-open')
    : !chatShell.classList.contains('sidebar-collapsed');
}

function syncSidebarToggleUi() {
  const open = sidebarIsOpen();
  if (btnToggleSidebar) {
    const encryptionDetail = btnToggleSidebar.dataset.encryptionDetail;
    const action = open ? 'Hide sidebar' : 'Show sidebar';
    const label = action + (encryptionDetail ? ' · ' + encryptionDetail : '');
    btnToggleSidebar.classList.toggle('is-sidebar-open', open);
    btnToggleSidebar.setAttribute('aria-expanded', open ? 'true' : 'false');
    btnToggleSidebar.setAttribute('aria-pressed', open ? 'true' : 'false');
    btnToggleSidebar.setAttribute('aria-label', label);
    btnToggleSidebar.title = label;
  }
}

function setSidebarOpen(open: boolean | undefined) {
  if (sidebarIsMobileDrawer()) {
    chatShell.classList.toggle('sidebar-open', open);
  } else {
    chatShell.classList.toggle('sidebar-collapsed', !open);
    if (storageReady && settings.sidebarCollapsed === open) {
      saveSettings({ ...settings, sidebarCollapsed: !open });
    }
  }
  syncSidebarToggleUi();
}

function syncPrivacyModeUi(enabled: boolean) {
  chatShell.classList.toggle('privacy-mode', enabled);
  syncIdentityTitles(enabled);
  const selected = modelMenuOptions.find((option) => option.value === selectedChatModel);
  if (chatModelSelect) {
    setIdentityTitle(
      chatModelSelect,
      selected ? modelOptionTitle(selected.label, selected.provider) : ''
    );
  }
  if (chatModelOriginPill) {
    setIdentityTitle(chatModelOriginPill, chatModelOriginPill.textContent);
  }
  chatModelList?.querySelectorAll<HTMLElement>('.chat-model-option').forEach((optionEl) => {
    const option = modelMenuOptions.find((item) => item.value === optionEl.dataset.value);
    const picking = !!modelMenuContext;
    const prefix = picking
      ? (optionEl.classList.contains('is-selected') ? 'Selected · ' : '')
      : (optionEl.classList.contains('is-selected') ? 'Selected · ' : 'Use in this chat · ');
    setIdentityTitle(optionEl, option ? prefix + modelOptionTitle(option.label, option.provider) : '');
    const badge = (optionEl.querySelector('.chat-model-origin-pill') as HTMLElement);
    if (badge) setIdentityTitle(badge, badge.textContent);
  });
  if (!btnPrivacyMode) return;
  btnPrivacyMode.classList.toggle('is-active', enabled);
  btnPrivacyMode.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btnPrivacyMode.setAttribute('aria-label', enabled ? 'Turn off privacy mode' : 'Turn on privacy mode');
  btnPrivacyMode.title = enabled
    ? 'Privacy mode on — hover a surface to reveal it'
    : 'Turn on privacy mode';
}

function setPrivacyMode(enabled: boolean, { persist = true } = {}) {
  syncPrivacyModeUi(!!enabled);
  if (!persist) return;
  if (storageReady && settings.privacyMode !== !!enabled) {
    saveSettings({ ...settings, privacyMode: !!enabled });
  }
}

function applyStoredPrivacyMode() {
  setPrivacyMode(settings.privacyMode === true, { persist: false });
}

function closeMobileSidebar() {
  if (sidebarIsMobileDrawer()) setSidebarOpen(false);
  else syncSidebarToggleUi();
}

function applyStoredSidebarCollapsed() {
  if (sidebarIsMobileDrawer()) {
    syncSidebarToggleUi();
    return;
  }
  const collapsed = settings.sidebarCollapsed === true;
  chatShell.classList.toggle('sidebar-collapsed', collapsed);
  syncSidebarToggleUi();
}

btnToggleSidebar?.addEventListener('click', () => setSidebarOpen(!sidebarIsOpen()));
btnPrivacyMode?.addEventListener('click', () => {
  setPrivacyMode(!chatShell.classList.contains('privacy-mode'));
});
(document.getElementById('sidebarBackdrop') as HTMLElement)?.addEventListener('click', () => {
  closeMobileSidebar();
});
sidebarMobileMq.addEventListener?.('change', () => {
  if (!sidebarIsMobileDrawer()) {
    chatShell.classList.remove('sidebar-open');
    applyStoredSidebarCollapsed();
  } else {
    chatShell.classList.remove('sidebar-collapsed');
    syncSidebarToggleUi();
  }
});
// —— Search chats / projects ——
const searchModal = (document.getElementById('searchModal') as HTMLElement);
const searchModalInput = (document.getElementById('searchModalInput') as HTMLInputElement);
const searchModalResults = (document.getElementById('searchModalResults') as HTMLElement);
let searchScope = 'all';
let searchRenderTimer: number | null | undefined = null;
let searchActiveIndex = 0;
let searchResultItems: HTMLButtonElement[] = [];

function closeSearchModal() {
  if (!searchModal) return;
  clearTimeout(searchRenderTimer);
  searchRenderTimer = null;
  closeBackdrop(searchModal);
  searchModalResults?.replaceChildren();
  searchModalInput?.removeAttribute('aria-activedescendant');
  if (searchModalInput) searchModalInput.value = '';
  searchActiveIndex = 0;
  searchResultItems = [];
}

function openSearchModal() {
  if (!searchModal || !requireUnlockedData()) return;
  searchModal.classList.toggle('privacy-mode', isPrivacyModeOn());
  closeSettings();
  openBackdrop(searchModal);
  if (searchModalInput) {
    searchModalInput.value = '';
    queueMicrotask(() => searchModalInput.focus());
  }
  searchScope = 'all';
  (document.querySelectorAll('[data-search-scope]') as NodeListOf<HTMLElement>).forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.searchScope === searchScope ? 'true' : 'false');
  });
  renderSearchResults('');
}

function renderSearchResults(query: string) {
  if (!searchModalResults) return;
  const raw = String(query || '').trim();
  const actionsOnly = raw.startsWith('>') || searchScope === 'actions';
  const q = raw.replace(/^>\s*/, '');
  const terms = searchTerms(q);
  const matches = actionsOnly ? [] : searchWorkspace(q, searchScope);
  const actions = (actionsOnly || (!q && searchScope === 'all'))
    ? workspaceActions().filter((action) => terms.every((term) =>
      (action.title + ' ' + action.meta).toLocaleLowerCase().includes(term))) : [];
  searchModalResults.replaceChildren();
  searchResultItems = [];
  searchModalInput.removeAttribute('aria-activedescendant');
  searchActiveIndex = 0;
  if (!matches.length && !actions.length) {
    const empty = (document.createElement('p') as HTMLElement);
    empty.className = 'search-dialog-empty';
    empty.textContent = q ? 'No matches. Try fewer words or a different phrase.' : 'Your saved chats and projects will appear here.';
    empty.setAttribute('role', 'status');
    searchModalResults.appendChild(empty);
    return;
  }
  const group = (label: string | null, detail: string | null) => {
    const heading = (document.createElement('div') as HTMLElement);
    heading.className = 'search-dialog-group';
    heading.setAttribute('role', 'presentation');
    heading.textContent = label;
    const count = (document.createElement('span') as HTMLElement);
    count.textContent = detail;
    heading.appendChild(count);
    searchModalResults.appendChild(heading);
  };
  const pushItem = (kind: string | undefined, title: string, meta: string, onPick: (() => void) | (() => void), shortcut = '') => {
    const btn = (document.createElement('button') as HTMLButtonElement);
    btn.type = 'button';
    btn.className = 'search-dialog-item';
    btn.dataset.kind = kind;
    btn.id = 'workspace-result-' + searchResultItems.length;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');
    btn.tabIndex = -1;
    btn.innerHTML = '<span class="search-dialog-item-title">' + highlightedSearchHtml(title, terms) + '</span>'
      + '<span class="search-dialog-item-meta">' + highlightedSearchHtml(meta, terms) + '</span>'
      + '<span class="search-item-icon" aria-hidden="true">' + (kind === 'action' ? '↗' : kind === 'project' ? '▱' : '↵') + '</span>';
    if (kind !== 'action') {
      applyPrivacyMosaic((btn.querySelector('.search-dialog-item-title') as HTMLElement), 'search-title:' + btn.id);
      applyPrivacyMosaic((btn.querySelector('.search-dialog-item-meta') as HTMLElement), 'search-meta:' + btn.id);
    }
    if (shortcut) btn.setAttribute('aria-keyshortcuts', shortcut.replace('Mod', modifierLabel === '⌘' ? 'Meta' : 'Control'));
    btn.addEventListener('pointermove', () => {
      const index = searchResultItems.indexOf(btn);
      if (index !== searchActiveIndex) { searchActiveIndex = index; syncSearchActiveItem(false); }
    });
    btn.addEventListener('click', () => { closeSearchModal(); onPick(); });
    searchModalResults.appendChild(btn);
    searchResultItems.push(btn);
  };
  if (matches.length) {
    group(q ? 'Results' : 'Recent work', matches.length > 60 ? 'Showing 60 of ' + matches.length : String(matches.length));
    for (const result of matches.slice(0, 60)) {
      pushItem(result.kind, result.title, result.meta, () => {
        if (result.kind === 'project') openProject(result.id);
        else {
          selectConversation(result.id);
          if (result.messageIndex != null) scrollToChatSource(result.messageIndex);
        }
      });
    }
  }
  if (actions.length) {
    group('Quick actions', actionsOnly ? '' : 'Type > to filter actions');
    for (const action of actions) pushItem('action', action.title,
      action.meta + (action.shortcut ? ' · ' + shortcutLabel(action.shortcut) : ''), action.run, action.shortcut);
  }
  syncSearchActiveItem();
}

function syncSearchActiveItem(scroll = true) {
  searchResultItems.forEach((el, index) => {
    el.classList.toggle('is-active', index === searchActiveIndex);
    el.setAttribute('aria-selected', index === searchActiveIndex ? 'true' : 'false');
  });
  const active = searchResultItems[searchActiveIndex];
  if (active) {
    searchModalInput.setAttribute('aria-activedescendant', active.id);
    if (scroll) active.scrollIntoView({ block: 'nearest' });
  } else searchModalInput.removeAttribute('aria-activedescendant');
}

(document.getElementById('btnRetryLocalData') as HTMLButtonElement)?.addEventListener('click', () => window.location.reload());
(document.getElementById('btnSearchChats') as HTMLButtonElement)?.addEventListener('click', openSearchModal);
searchModalInput?.addEventListener('input', () => {
  clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(() => {
    searchRenderTimer = null;
    renderSearchResults(searchModalInput.value);
  }, 100);
});
(document.querySelectorAll('[data-search-scope]') as NodeListOf<HTMLElement>).forEach((button) => {
  button.addEventListener('click', () => {
    clearTimeout(searchRenderTimer);
    searchRenderTimer = null;
    searchScope = button.dataset.searchScope!;
    (document.querySelectorAll('[data-search-scope]') as NodeListOf<HTMLElement>).forEach((item) => item.setAttribute('aria-pressed', item === button ? 'true' : 'false'));
    renderSearchResults(searchModalInput.value);
    searchModalInput.focus();
  });
});
searchModalInput?.addEventListener('keydown', (event) => {
  if (isComposingKey(event)) return;
  if (searchRenderTimer && ['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
    clearTimeout(searchRenderTimer);
    searchRenderTimer = null;
    renderSearchResults(searchModalInput.value);
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (!searchResultItems.length) return;
    searchActiveIndex = (searchActiveIndex + 1) % searchResultItems.length;
    syncSearchActiveItem();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (!searchResultItems.length) return;
    searchActiveIndex =
      (searchActiveIndex - 1 + searchResultItems.length) % searchResultItems.length;
    syncSearchActiveItem();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    searchResultItems[searchActiveIndex]?.click();
  }
});
searchModal?.addEventListener('click', (event) => {
  if (event.target === searchModal) closeSearchModal();
});
(document.getElementById('btnSettings') as HTMLButtonElement).addEventListener('click', () => {
  setNotificationsOpen(false);
  openSettings();
});
btnProfileMenu?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (profileMenuIsOpen()) setProfileMenuOpen(false, { restoreFocus: true });
  else {
    setNotificationsOpen(false);
    syncAccountProfileUi();
    setProfileMenuOpen(true);
  }
});
(document.getElementById('btnProfileCreate') as HTMLButtonElement)?.addEventListener('click', () => {
  setProfileMenuOpen(false);
  openProfileModal();
});
(document.getElementById('btnProfileManage') as HTMLButtonElement)?.addEventListener('click', () => {
  setProfileMenuOpen(false);
  openSettings('profiles');
});
(document.getElementById('btnSettingsProfileCreate') as HTMLButtonElement)?.addEventListener('click', () => openProfileModal());
(document.getElementById('btnProfileModalCancel') as HTMLButtonElement)?.addEventListener('click', closeProfileModal);
(document.getElementById('btnProfileModalClose') as HTMLButtonElement)?.addEventListener('click', closeProfileModal);
(document.getElementById('btnProfileModalSave') as HTMLButtonElement)?.addEventListener('click', commitProfileModal);
(document.getElementById('profileNameInput') as HTMLInputElement)?.addEventListener('input', (event) => {
  (event.target as HTMLInputElement).setCustomValidity('');
  const mark = (document.getElementById('profileModalMark') as HTMLElement);
  if (mark) mark.textContent = profileInitials((event.target as HTMLInputElement).value || 'Profile');
});
(document.getElementById('profileNameInput') as HTMLInputElement)?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  commitProfileModal();
});
(document.getElementById('profileModal') as HTMLElement)?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeProfileModal();
});
encryptionIndicator?.addEventListener('click', () => {
  openSettings();
  showSettingsPane('data');
  (document.getElementById('settingsEncryptionSection') as HTMLElement)?.scrollIntoView({ block: 'start' });
});
(document.getElementById('btnSettingsCancel') as HTMLButtonElement).addEventListener('click', closeSettings);
(document.getElementById('btnSettingsClose') as HTMLButtonElement).addEventListener('click', closeSettings);
(document.getElementById('btnSettingsSave') as HTMLButtonElement).addEventListener('mousedown', (event) => {
  if (event.button === 0) event.preventDefault();
});
(document.getElementById('btnSettingsSave') as HTMLButtonElement).addEventListener('click', commitSettings);
(document.getElementById('settingChatBackgroundUrl') as HTMLInputElement)?.addEventListener('input', (event) => {
  pendingChatBackgroundImage = (event.target as HTMLInputElement).value.trim();
  pendingChatBackgroundImageName = '';
  syncChatBackgroundForm();
});
(document.getElementById('settingChatBackgroundOverlay') as HTMLInputElement)?.addEventListener('input', syncChatBackgroundForm);
(document.getElementById('btnChatBackgroundFile') as HTMLButtonElement)?.addEventListener('click', () => {
  (document.getElementById('settingChatBackgroundFile') as HTMLInputElement)?.click();
});
(document.getElementById('settingChatBackgroundFile') as HTMLInputElement)?.addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = '';
  if (!file) return;
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
  if (!allowed.includes(file.type)) {
    alert('Choose a PNG, JPEG, WebP, GIF, or AVIF image.');
    return;
  }
  if (file.size > CHAT_BACKGROUND_MAX_BYTES) {
    alert('Background images must be 1 MB or smaller.');
    return;
  }
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    pendingChatBackgroundImage = typeof reader.result === 'string' ? reader.result : '';
    pendingChatBackgroundImageName = file.name;
    syncChatBackgroundForm();
    syncSettingsSaveButton();
  });
  reader.addEventListener('error', () => alert('Could not read that image.'));
  reader.readAsDataURL(file);
});
(document.getElementById('btnChatBackgroundClear') as HTMLButtonElement)?.addEventListener('click', () => {
  pendingChatBackgroundImage = '';
  pendingChatBackgroundImageName = '';
  const urlInput = (document.getElementById('settingChatBackgroundUrl') as HTMLInputElement);
  if (urlInput) urlInput.value = '';
  syncChatBackgroundForm();
  syncSettingsSaveButton();
});
(document.querySelectorAll('[data-background-position]') as NodeListOf<HTMLElement>).forEach((button) => {
  button.addEventListener('click', () => {
    const positionInput = (document.getElementById('settingChatBackgroundPosition') as HTMLInputElement);
    if (!positionInput) return;
    positionInput.value = button.dataset.backgroundPosition!;
    syncChatBackgroundForm();
    syncSettingsSaveButton();
  });
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...(document.querySelectorAll('[data-background-position]') as NodeListOf<HTMLElement>)];
    const index = buttons.indexOf(button);
    const delta = event.key === 'ArrowLeft' ? -1
      : event.key === 'ArrowRight' ? 1
        : event.key === 'ArrowUp' ? -3 : 3;
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, index + delta))];
    next?.click();
    next?.focus();
  });
});
(settingsModal.querySelector('.settings-dialog') as HTMLElement)?.addEventListener('input', (event) => {
  if (!((event.target as Element).closest('input, textarea, select') as HTMLSelectElement)) return;
  syncWebSearchControls();
  syncFetchUrlControls();
  syncTerminalSkillControls();
  syncAttachmentFallbackControls();
  syncSettingsSaveButton();
});
(settingsModal.querySelector('.settings-dialog') as HTMLElement)?.addEventListener('change', (event) => {
  if (!((event.target as Element).closest('input, textarea, select') as HTMLSelectElement)) return;
  syncWebSearchControls();
  syncFetchUrlControls();
  syncTerminalSkillControls();
  syncAttachmentFallbackControls();
  syncSettingsSaveButton();
});
(document.getElementById('settingSkillWebSearch') as HTMLInputElement).addEventListener('change', syncWebSearchControls);
(document.getElementById('btnWebSearchAdvanced') as HTMLButtonElement)?.addEventListener('click', () => {
  const toggle = (document.getElementById('btnWebSearchAdvanced') as HTMLButtonElement);
  const panel = (document.getElementById('webSearchOptions') as HTMLElement);
  if (!toggle || toggle.disabled) return;
  setCapabilityAdvancedOpen(toggle, panel, toggle.getAttribute('aria-expanded') !== 'true');
});
(document.getElementById('btnWebSearchMore') as HTMLButtonElement)?.addEventListener('click', () => {
  const toggle = (document.getElementById('btnWebSearchMore') as HTMLButtonElement);
  const panel = (document.getElementById('webSearchMoreOptions') as HTMLElement);
  if (!toggle || toggle.disabled) return;
  setCapabilityAdvancedOpen(toggle, panel, toggle.getAttribute('aria-expanded') !== 'true');
});
(document.getElementById('settingSkillFetchUrl') as HTMLInputElement).addEventListener('change', syncFetchUrlControls);
(document.getElementById('btnFetchUrlAdvanced') as HTMLButtonElement)?.addEventListener('click', () => {
  const toggle = (document.getElementById('btnFetchUrlAdvanced') as HTMLButtonElement);
  const panel = (document.getElementById('fetchUrlOptions') as HTMLElement);
  if (!toggle || toggle.disabled) return;
  setCapabilityAdvancedOpen(toggle, panel, toggle.getAttribute('aria-expanded') !== 'true');
});
(document.getElementById('settingSkillTerminal') as HTMLInputElement)?.addEventListener('change', syncTerminalSkillControls);
(document.getElementById('btnTerminalAdvanced') as HTMLButtonElement)?.addEventListener('click', () => {
  const toggle = (document.getElementById('btnTerminalAdvanced') as HTMLButtonElement);
  const panel = (document.getElementById('terminalOptions') as HTMLElement);
  if (!toggle || toggle.disabled) return;
  setCapabilityAdvancedOpen(toggle, panel, toggle.getAttribute('aria-expanded') !== 'true');
});
(document.querySelectorAll('#approvalModeToggle [data-approval-mode]') as NodeListOf<HTMLElement>).forEach((btn) => {
  btn.addEventListener('click', () => {
    (document.querySelectorAll('#approvalModeToggle [data-approval-mode]') as NodeListOf<HTMLElement>).forEach((other) => {
      const on = other === btn;
      other.classList.toggle('is-active', on);
      other.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    syncSettingsSaveButton();
  });
});
(document.getElementById('btnSkillCreate') as HTMLButtonElement).addEventListener('click', () => {
  openSkillEditor({
    name: '',
    description: '',
    content: '# Skill\n\nDescribe what the model should do when this skill applies.\n',
    enabled: true,
  });
});
(document.getElementById('btnSkillUpload') as HTMLButtonElement).addEventListener('click', () => {
  (document.getElementById('skillFileInput') as HTMLInputElement).click();
});
(document.getElementById('skillFileInput') as HTMLInputElement).addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files && (event.target as HTMLInputElement).files![0];
  (event.target as HTMLInputElement).value = '';
  if (!file) return;
  const uploadBtn = (document.getElementById('btnSkillUpload') as HTMLButtonElement);
  await withBusyControl(uploadBtn, 'Importing…', async () => {
    try {
      showSkillsError('');
      await importSkillFile(file);
    } catch (error) {
      showSkillsError(error);
    }
  });
});
(document.getElementById('btnSkillSave') as HTMLButtonElement).addEventListener('click', () => {
  saveSkillFromEditor();
});
(document.getElementById('btnSkillCancelEdit') as HTMLButtonElement).addEventListener('click', hideSkillEditor);
(document.getElementById('skillsList') as HTMLElement).addEventListener('click', async (event) => {
  const row = ((event.target as Element).closest('[data-skill-id]') as HTMLElement);
  if (!row) return;
  const id = row.getAttribute('data-skill-id');
  const skill = userSkills.find((item) => item.id === id);
  if (!skill) return;
  if (((event.target as Element).closest('[data-skill-edit]') as HTMLElement)) {
    openSkillEditor(skill);
    return;
  }
  const deleteBtn = ((event.target as Element).closest('[data-skill-delete]') as HTMLButtonElement);
  if (deleteBtn) {
    if (!window.confirm('Delete skill “' + skill.name + '”?')) return;
    await withBusyControl(deleteBtn, 'Deleting…', async () => {
      try {
        const response = await fetch('/api/skills/' + encodeURIComponent(id!), { method: 'DELETE' });
        const body: RuntimeSkillsResponse = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Could not delete skill');
        userSkills = body.skills || [];
        hideSkillEditor();
        renderUserSkills();
      } catch (error) {
        showSkillsError(error);
      }
    }, { restore: false });
  }
});
(document.getElementById('skillsList') as HTMLElement).addEventListener('change', async (event) => {
  const toggle = ((event.target as Element).closest('[data-skill-enabled]') as HTMLInputElement);
  if (!toggle) return;
  const row = ((event.target as Element).closest('[data-skill-id]') as HTMLElement);
  if (!row) return;
  const id = row.getAttribute('data-skill-id');
  toggle.disabled = true;
  try {
    const response = await fetch('/api/skills/' + encodeURIComponent(id!), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !!toggle.checked }),
    });
    const body: RuntimeSkillResponse = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Could not update skill');
    const index = userSkills.findIndex((item) => item.id === id);
    if (index >= 0) userSkills[index] = body;
    renderUserSkills();
  } catch (error) {
    toggle.checked = !toggle.checked;
    toggle.disabled = false;
    showSkillsError(error);
  }
});
(document.getElementById('btnProjectCancel') as HTMLButtonElement).addEventListener('click', closeProjectSettings);
(document.getElementById('btnProjectClose') as HTMLButtonElement).addEventListener('click', closeProjectSettings);
(document.getElementById('btnProjectSave') as HTMLButtonElement).addEventListener('click', commitProjectSettings);
(document.getElementById('projectMemoryModeToggle') as HTMLElement)?.addEventListener('click', (event) => {
  const btn = ((event.target as Element).closest('[data-memory-mode]') as HTMLElement);
  if (!btn) return;
  syncProjectMemoryModeControls(btn.getAttribute('data-memory-mode'));
});
(document.getElementById('btnProjectDelete') as HTMLButtonElement).addEventListener('click', () => {
  if (editingProjectId) deleteProject(editingProjectId);
});
(document.querySelectorAll('.settings-nav-btn') as NodeListOf<HTMLElement>).forEach((btn) => {
  btn.addEventListener('click', () => showSettingsPane(btn.dataset.settingsPane));
});
(document.getElementById('btnClearChats') as HTMLButtonElement)?.addEventListener('click', clearAllChats);
(document.getElementById('btnClearLoops') as HTMLButtonElement)?.addEventListener('click', clearAllLoops);
(document.getElementById('btnClearProjects') as HTMLButtonElement)?.addEventListener('click', clearAllProjects);
(document.getElementById('btnClearAllData') as HTMLButtonElement)?.addEventListener('click', clearAllChatsAndProjects);
(document.getElementById('btnOpenDataDir') as HTMLButtonElement)?.addEventListener('click', async () => {
  const btn = (document.getElementById('btnOpenDataDir') as HTMLButtonElement);
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    const response = await fetch('/api/data/open', { method: 'POST' });
    if (!response.ok) {
      const body: RuntimeApiProblem = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Could not open folder');
    }
  } catch (error) {
    alert((error as Error).message || 'Could not open folder');
  } finally {
    refreshLocalDataPane();
  }
});
function syncEncryptionPassphraseWarning() {
  const passphraseInput = (document.getElementById('encryptionPassphrase') as HTMLInputElement);
  const confirmInput = (document.getElementById('encryptionPassphraseConfirm') as HTMLInputElement);
  const warning = (document.getElementById('encryptionPassphraseWarning') as HTMLElement);
  if (!passphraseInput || !confirmInput || !warning) return;

  const passphrase = passphraseInput.value;
  const confirm = confirmInput.value;
  const length = Array.from(passphrase).length;
  const messages = [];
  if (length > 0 && length < 16) {
    messages.push('This passphrase has ' + length + ' characters. Use at least 16 characters. You can continue with the current passphrase.');
  } else if (length > 1024) {
    messages.push('This passphrase has ' + length + ' characters. You can use it, but a shorter passphrase can be easier to enter correctly.');
  }
  if (confirm && passphrase !== confirm) {
    messages.push('The confirmation does not match.');
  }

  warning.textContent = messages.join(' ');
  warning.classList.toggle('is-hidden', messages.length === 0);
}

['encryptionPassphrase', 'encryptionPassphraseConfirm'].forEach((id) => {
  (document.getElementById(id) as HTMLElement)?.addEventListener('input', syncEncryptionPassphraseWarning);
});
(document.getElementById('btnEnableEncryption') as HTMLButtonElement)?.addEventListener('click', async () => {
  const passphrase = (document.getElementById('encryptionPassphrase') as HTMLInputElement)?.value || '';
  const confirm = (document.getElementById('encryptionPassphraseConfirm') as HTMLInputElement)?.value || '';
  const btn = (document.getElementById('btnEnableEncryption') as HTMLButtonElement);
  if (btn) btn.disabled = true;
  try {
    await postEncryption('/api/data/encryption/enable', {
      passphrase,
      passphrase_confirm: confirm,
    });
    (document.getElementById('encryptionPassphrase') as HTMLInputElement).value = '';
    (document.getElementById('encryptionPassphraseConfirm') as HTMLInputElement).value = '';
    syncEncryptionPassphraseWarning();
  } catch (error) {
    alert((error as Error).message || 'Could not enable encryption');
  } finally {
    if (btn) btn.disabled = false;
  }
});
(document.getElementById('btnUnlockEncryption') as HTMLButtonElement)?.addEventListener('click', async () => {
  const passphrase = (document.getElementById('encryptionUnlockPassphrase') as HTMLInputElement)?.value || '';
  const btn = (document.getElementById('btnUnlockEncryption') as HTMLButtonElement);
  try {
    await unlockDiskEncryption(passphrase, btn);
  } catch (error) {
    alert((error as Error).message || 'Could not unlock');
  }
});
(document.getElementById('encryptionUnlockPassphrase') as HTMLInputElement)?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    (document.getElementById('btnUnlockEncryption') as HTMLButtonElement)?.click();
  }
});
let unlockModalBusy = false;

function unlockModalIsBusy() {
  return unlockModalBusy;
}

function setUnlockPassphraseRevealed(revealed: boolean) {
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  const btn = (document.getElementById('btnUnlockModalReveal') as HTMLButtonElement);
  if (!input || !btn) return;
  const show = !!revealed;
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('is-revealed', show);
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase');
}

function setUnlockModalLoading(loading: boolean) {
  unlockModalBusy = loading;
  const btn = (document.getElementById('btnUnlockModalSubmit') as HTMLButtonElement);
  const label = (btn?.querySelector('.unlock-button-label') as HTMLElement);
  if (label) label.textContent = loading ? 'Unlocking' : 'Unlock';
  if (btn) {
    btn.disabled = loading;
    btn.classList.toggle('is-loading', loading);
    (btn.querySelector('.button-loading-spinner') as HTMLElement)?.classList.toggle('is-hidden', !loading);
    btn.toggleAttribute('aria-busy', loading);
    btn.setAttribute('aria-label', loading ? 'Unlocking' : 'Unlock');
  }
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  const shell = (document.getElementById('unlockPassphraseShell') as HTMLElement);
  if (input) {
    input.readOnly = loading;
    input.classList.toggle('is-sealed', loading);
  }
  shell?.classList.toggle('is-sealed', loading);
  const reveal = (document.getElementById('btnUnlockModalReveal') as HTMLButtonElement);
  if (reveal) reveal.disabled = loading;
  const dismiss = (document.getElementById('btnUnlockModalDismiss') as HTMLButtonElement);
  if (dismiss) dismiss.disabled = loading;
  const status = (document.getElementById('unlockModalStatus') as HTMLElement);
  if (status) {
    status.textContent = loading ? 'Decrypting chats and settings.' : '';
    status.classList.toggle('is-hidden', !loading);
  }
  if (loading) setUnlockModalError('');
}
(document.getElementById('btnUnlockModalSubmit') as HTMLButtonElement)?.addEventListener('click', async () => {
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  const passphrase = input?.value || '';
  if (unlockModalBusy) return;
  setUnlockModalLoading(true);
  try {
    await unlockDiskEncryption(passphrase, null);
  } catch (error) {
    setUnlockModalError((error as Error).message || 'Could not unlock');
    setUnlockModalLoading(false);
    input?.focus();
  }
});
(document.getElementById('unlockModalPassphrase') as HTMLInputElement)?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (unlockModalBusy) return;
    (document.getElementById('btnUnlockModalSubmit') as HTMLButtonElement)?.click();
  }
});
(document.getElementById('btnUnlockModalReveal') as HTMLButtonElement)?.addEventListener('click', () => {
  if (unlockModalBusy) return;
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  const revealed = input?.type !== 'text';
  setUnlockPassphraseRevealed(revealed);
  input?.focus();
});
(document.getElementById('btnUnlockModalDismiss') as HTMLButtonElement)?.addEventListener('click', () => {
  if (unlockModalBusy) return;
  hideUnlockSession();
});
(document.getElementById('btnLockEncryption') as HTMLButtonElement)?.addEventListener('click', async () => {
  try {
    captureComposerDraft();
    saveStore({ immediate: true });
    await storeWriteChain;
    await postEncryption('/api/data/encryption/lock', {});
    clearMemoryAfterLock();
  } catch (error) {
    alert((error as Error).message || 'Could not lock');
  }
});
(document.getElementById('btnDisableEncryption') as HTMLButtonElement)?.addEventListener('click', () => {
  (document.getElementById('settingsEncryptionDisable') as HTMLElement)?.classList.remove('is-hidden');
});
(document.getElementById('btnConfirmDisableEncryption') as HTMLButtonElement)?.addEventListener('click', async () => {
  const passphrase = (document.getElementById('encryptionDisablePassphrase') as HTMLInputElement)?.value || '';
  const btn = (document.getElementById('btnConfirmDisableEncryption') as HTMLButtonElement);
  if (btn) btn.disabled = true;
  try {
    await postEncryption('/api/data/encryption/disable', { passphrase });
    (document.getElementById('encryptionDisablePassphrase') as HTMLInputElement).value = '';
    (document.getElementById('settingsEncryptionDisable') as HTMLElement)?.classList.add('is-hidden');
  } catch (error) {
    alert((error as Error).message || 'Could not disable encryption');
  } finally {
    if (btn) btn.disabled = false;
  }
});
(document.querySelectorAll('#themeToggle [data-theme-choice]') as NodeListOf<HTMLElement>).forEach((btn) => {
  btn.addEventListener('click', () => setTheme(btn.dataset.themeChoice));
});
(document.querySelectorAll('#fontScaleToggle [data-font-scale]') as NodeListOf<HTMLElement>).forEach((btn) => {
  btn.addEventListener('click', () => patchAppearance({ font_scale: btn.dataset.fontScale }));
});
['settingFontBody', 'settingFontDisplay'].forEach((id) => {
  const el = (document.getElementById(id) as HTMLSelectElement);
  if (!el) return;
  el.addEventListener('change', () => {
    const key = id === 'settingFontBody' ? 'font_body' : 'font_display';
    patchAppearance({ [key]: el.value });
  });
});
(document.getElementById('btnAppearanceReset') as HTMLButtonElement).addEventListener('click', resetAppearance);
settingsModal.addEventListener('click', (event) => {
  if (event.target === settingsModal) closeSettings();
});
projectModal.addEventListener('click', (event) => {
  if (event.target === projectModal) closeProjectSettings();
});
document.addEventListener('click', (event) => {
  if (notificationsPopoverIsOpen()
      && !notificationsView.contains(event.target as Node | null)
      && !btnNotificationsNav.contains(event.target as Node | null)) {
    setNotificationsOpen(false);
  }
  if (profileMenuIsOpen() && !sidebarProfileMenu.contains(event.target as Node | null) && !btnProfileMenu.contains(event.target as Node | null)) {
    setProfileMenuOpen(false);
  }
  if (openConvoMenu && !openConvoMenu.contains(event.target as Node | null) && !((event.target as Element).closest('.convo-more') as HTMLElement)) {
    closeConvoMenu();
  }
});
(document.getElementById('btnConfirmModalCancel') as HTMLButtonElement)?.addEventListener('click', () => settleConfirmDanger(false));
(document.getElementById('btnConfirmModalOk') as HTMLButtonElement)?.addEventListener('click', () => settleConfirmDanger(true));
(document.getElementById('confirmModal') as HTMLElement)?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) settleConfirmDanger(false);
});
convoTitleEl.addEventListener('click', beginTopbarTitleEdit);
convoTitleEl.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !(convoTitleEl.querySelector('input') as HTMLInputElement)) {
    event.preventDefault();
    beginTopbarTitleEdit();
  }
});
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'k') {
    event.preventDefault();
    if (searchModal && !searchModal.classList.contains('is-hidden')) closeSearchModal();
    else openSearchModal();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    const field = event.target;
    const textField = field instanceof HTMLTextAreaElement
      || (field instanceof HTMLInputElement
        && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes((field.type || 'text').toLowerCase()));
    if (textField && (key === 'a' || key === 'c' || key === 'x')) {
      if (key === 'a') {
        event.preventDefault();
        field.select();
        return;
      }
      const start = field.selectionStart ?? 0;
      const end = field.selectionEnd ?? 0;
      if (end > start && navigator.clipboard?.writeText) {
        const selected = field.value.slice(start, end);
        event.preventDefault();
        void navigator.clipboard.writeText(selected).then(() => {
          if (key !== 'x') return;
          field.setRangeText('', start, end, 'start');
          field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        return;
      }
    }
  }
  if (event.key === 'Escape') {
    if (notificationsPopoverIsOpen()) {
      setNotificationsOpen(false, { restoreFocus: true });
      return;
    }
    if (profileMenuIsOpen()) {
      setProfileMenuOpen(false, { restoreFocus: true });
      return;
    }
    const profileModal = (document.getElementById('profileModal') as HTMLElement);
    if (profileModal && !profileModal.classList.contains('is-hidden')) {
      closeProfileModal();
      return;
    }
    if (voiceListening) {
      stopVoiceInput();
      return;
    }
    if (searchModal && !searchModal.classList.contains('is-hidden')) {
      closeSearchModal();
      return;
    }
    const confirmModal = (document.getElementById('confirmModal') as HTMLElement);
    if (confirmModal && !confirmModal.classList.contains('is-hidden')) {
      settleConfirmDanger(false);
      return;
    }
    const unlockModal = (document.getElementById('unlockModal') as HTMLElement);
    if (unlockModal && !unlockModal.classList.contains('is-hidden')) {
      if (unlockModalBusy) return;
      hideUnlockSession();
      return;
    }
    if (!projectModal.classList.contains('is-hidden')) {
      closeProjectSettings();
      return;
    }
    if (!settingsModal.classList.contains('is-hidden')) {
      closeSettings();
      return;
    }
    if (!chatModelMenu.classList.contains('is-hidden')) {
      closeModelMenu({ restoreFocus: true });
      return;
    }
    if (wordmarkMenuIsOpen()) {
      setWordmarkMenuOpen(false);
      (document.getElementById('btnWordmarkSurface') as HTMLButtonElement)?.focus();
      return;
    }
    closeConvoMenu();
  }
});

chatModelSelectWrap.addEventListener('click', (event) => {
  if (((event.target as Element).closest('.chat-model-menu') as HTMLElement)) return;
  event.preventDefault();
  event.stopPropagation();
  if (modelMenuIsOpen()) {
    closeModelMenu({ restoreFocus: true });
    return;
  }
  openModelMenu();
  // openModelMenu() puts focus in the filter field when it is shown;
  // don't yank it back to the trigger.
  if (!modelSearchEnabled()) chatModelSelect.focus();
});

/** Shared arrow/Enter/Escape handling for the trigger and the filter field. */
function handleModelMenuKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  const open = modelMenuIsOpen();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!open) {
      openModelMenu();
      return;
    }
    const count = visibleModelMenuOptions().length;
    if (!count) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const from = modelMenuActiveIndex < 0 ? (delta > 0 ? -1 : 0) : modelMenuActiveIndex;
    modelMenuActiveIndex = (from + delta + count) % count;
    paintModelMenuActive();
  } else if (event.key === 'Home' || event.key === 'End') {
    if (event.target === chatModelSearch) return;
    if (!open || !visibleModelMenuOptions().length) return;
    event.preventDefault();
    modelMenuActiveIndex = event.key === 'Home' ? 0 : visibleModelMenuOptions().length - 1;
    paintModelMenuActive();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (!open) {
      openModelMenu();
      return;
    }
    const choice = visibleModelMenuOptions()[modelMenuActiveIndex];
    if (choice) chooseModelOption(choice.value);
  } else if (event.key === ' ' && event.target === modelMenuTriggerEl()) {
    // Space only toggles from the button; inside the field it is a query character.
    event.preventDefault();
    if (!open) openModelMenu();
  } else if (event.key === 'Escape' && open) {
    event.preventDefault();
    event.stopPropagation();
    if (event.target === chatModelSearch && modelFilterTerms().length) {
      modelMenuFilter = '';
      chatModelSearch.value = '';
      applyModelFilter();
      return;
    }
    closeModelMenu({ restoreFocus: true });
  }
}

chatModelSelect.addEventListener('keydown', handleModelMenuKeydown);
chatModelSearch.addEventListener('keydown', handleModelMenuKeydown);
chatModelSearch.addEventListener('input', () => {
  modelMenuFilter = chatModelSearch.value;
  applyModelFilter();
});
// Clicking the field must not fall through to the wrap's toggle handler.
chatModelSearchWrap.addEventListener('click', (event) => {
  event.stopPropagation();
  chatModelSearch.focus();
});
chatModelBackdrop?.addEventListener('click', () => closeModelMenu({ restoreFocus: true }));
(document.getElementById('btnModelMenuClose') as HTMLButtonElement)?.addEventListener('click', () => closeModelMenu({ restoreFocus: true }));
(document.getElementById('btnModelUseDefault') as HTMLButtonElement)?.addEventListener('click', () => chooseModelOption('@default'));
(document.getElementById('btnModelClose') as HTMLButtonElement)?.addEventListener('click', () => closeModelMenu({ restoreFocus: true }));
(document.getElementById('btnModelProviders') as HTMLButtonElement)?.addEventListener('click', () => {
  closeModelMenu();
  openSettings('providers');
});
chatModelMenu.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const focusable = [...(chatModelMenu.querySelectorAll(
    'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"])'
  ) as NodeListOf<HTMLInputElement>)].filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

chatModelMenu.addEventListener('click', (event) => {
  const fold = ((event.target as Element).closest('[data-provider-fold]') as HTMLElement);
  if (fold) {
    event.preventDefault();
    event.stopPropagation();
    toggleProviderFold(fold.getAttribute('data-provider-fold') || '');
    return;
  }

  const pin = ((event.target as Element).closest('[data-model-pin]') as HTMLElement);
  if (pin) {
    event.preventDefault();
    event.stopPropagation();
    const value = pin.getAttribute('data-model-pin') || '';
    const before = [...(chatModelList.querySelectorAll('[data-model-pin]') as NodeListOf<HTMLElement>)];
    const index = before.indexOf(pin);
    togglePinnedModel(value);
    const after = [...(chatModelList.querySelectorAll('[data-model-pin]') as NodeListOf<HTMLElement>)];
    const same = after.find((item) => item.getAttribute('data-model-pin') === value);
        const fallback = chatModelSearch;
    (same || after[Math.min(Math.max(index, 0), after.length - 1)] || fallback)?.focus();
    return;
  }
  const pick = ((event.target as Element).closest('[data-model-pick]') as HTMLElement);
  const row = ((event.target as Element).closest('.chat-model-option') as HTMLElement);
  const value = pick?.getAttribute('data-model-pick')
    || row?.getAttribute('data-value')
    || '';
  if (!value) return;
  event.preventDefault();
  event.stopPropagation();
  chooseModelOption(value);
});
chatModelMenu.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeModelMenu({ restoreFocus: true });
});
document.addEventListener('click', (event) => {
  if (!modelMenuIsOpen()) return;
  if (chatModelSelectWrap.contains(event.target as Node | null)) return;
  if (modelMenuAnchorEl()?.contains(event.target as Node | null)) return;
  if (chatModelMenu.contains(event.target as Node | null)) return;
  // Confirmations raised from inside the menu sit above it.
  if (((event.target as Element).closest('#confirmModal') as HTMLElement)) return;
  closeModelMenu();
});
function repositionOpenModelMenu() {
  if (modelMenuIsOpen()) positionModelMenu();
}
window.addEventListener('resize', repositionOpenModelMenu);
document.addEventListener('scroll', repositionOpenModelMenu, true);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', repositionOpenModelMenu);
  window.visualViewport.addEventListener('scroll', repositionOpenModelMenu);
}
composerInput.addEventListener('input', () => {
  if (voiceListening) stopVoiceInput({ silent: true });
  mentionInput = composerInput;
  promoteTypedMentions();
  autoResize(composerInput);
  updateSendEnabled();
  updateMentionMenu(composerInput);
});
composerInput.addEventListener('click', () => updateMentionMenu(composerInput));
composerInput.addEventListener('keyup', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    updateMentionMenu(composerInput);
  }
});
composerInput.addEventListener('blur', () => {
  // Delay so mousedown on a menu option can fire first.
  setTimeout(() => {
    if (document.activeElement !== composerInput) closeMentionMenu();
  }, 120);
});
composerInput.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  mentionInput = composerInput;
  if (handleMentionKeydown(event)) return;

  if (event.key !== 'Enter') return;
  if (settings.enterSends) {
    if (!event.shiftKey) {
      event.preventDefault();
      if (!btnSend.disabled) sendMessage();
    }
  } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
    event.preventDefault();
    if (!btnSend.disabled) sendMessage();
  }
});

function mountStarfield(canvas: HTMLCanvasElement) {
  if (!canvas) return;
  const host = canvas.parentElement!;
  if (!host) return;

  function rand(seed: number) {
    let t = seed + 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function paint() {
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Dense field of tiny dim dots; seeded so resize doesn't reshuffle wildly.
    // Light mode keeps the field but uses dark ink so it reads on pale paper.
    const light = document.documentElement.dataset.theme === 'light';
    const ink = light ? '18, 22, 32' : '245, 248, 255';
    // Keep stars clear of the model selector so they don't look like UI glitches.
    const clearZones: { left: number; top: number; right: number; bottom: number; }[] = [];
    const modelWrap = (document.getElementById('chatModelSelectWrap') as HTMLElement);
    if (modelWrap && !modelWrap.classList.contains('is-hidden')) {
      const hostRect = host.getBoundingClientRect();
      const rect = modelWrap.getBoundingClientRect();
      const pad = 16;
      clearZones.push({
        left: rect.left - hostRect.left - pad,
        top: rect.top - hostRect.top - pad,
        right: rect.right - hostRect.left + pad,
        bottom: rect.bottom - hostRect.top + pad,
      });
    }
    const inClearZone = (x: number, y: number) => clearZones.some((zone) =>
      x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom
    );
    // Sparser and dimmer than a real starfield — this is texture on the
    // canvas, not a subject. The host's CSS mask fades it out before the
    // thread column, so density only has to read in the upper area.
    const count = Math.round((width * height) / 4200);
    for (let i = 0; i < count; i++) {
      const x = rand(i * 1289 + 17) * width;
      const y = rand(i * 2657 + 91) * height;
      if (inClearZone(x, y)) continue;
      const size = rand(i * 409 + 3) < 0.86 ? 0.5 : 0.85;
      const alpha = light
        ? 0.11 + rand(i * 733 + 11) * 0.18
        : 0.09 + rand(i * 733 + 11) * 0.2;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(' + ink + ', ' + alpha.toFixed(3) + ')';
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  repaintStarfield = paint;
  paint();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(paint);
    observer.observe(host);
  } else {
    window.addEventListener('resize', paint);
  }
}

const emptyStateOrb = mountOrb(document.getElementById('orbMark') as HTMLCanvasElement, 64, {
  ink: () => {
    const tone = chatMain.dataset.backgroundTone;
    if (tone === 'dark') return 'bright';
    if (tone === 'light') return 'dark';
    return 'auto';
  },
});
repaintEmptyOrb = () => emptyStateOrb.paint();
mountStarfield((document.getElementById('starfieldCanvas') as HTMLCanvasElement));

const updateToast = (document.getElementById('updateToast') as HTMLElement);
const updateToastTitle = (document.getElementById('updateToastTitle') as HTMLElement);
const updateToastBody = (document.getElementById('updateToastBody') as HTMLElement);
const btnUpdateView = (document.getElementById('btnUpdateView') as HTMLAnchorElement);
const btnUpdateLater = (document.getElementById('btnUpdateLater') as HTMLButtonElement);
const btnUpdateDismiss = (document.getElementById('btnUpdateDismiss') as HTMLButtonElement);
const btnUpdateInstall = (document.getElementById('btnUpdateInstall') as HTMLButtonElement);
const appUpdateCurrent = (document.getElementById('appUpdateCurrent') as HTMLElement);
const appUpdateStatus = (document.getElementById('appUpdateStatus') as HTMLElement);
const btnAppUpdateCheck = (document.getElementById('btnAppUpdateCheck') as HTMLButtonElement);
const btnAppUpdateInstall = (document.getElementById('btnAppUpdateInstall') as HTMLButtonElement);
const btnAppUpdateNotes = (document.getElementById('btnAppUpdateNotes') as HTMLAnchorElement);
let updateInstallInFlight = false;
let lastAppUpdateStatus: AppUpdateStatus | null = null;

function dismissedUpdateCommit() {
  return String(settings.updateDismissed || '');
}

function dismissUpdateNotice(commit: string | undefined) {
  if (updateInstallInFlight) return;
  const tag = String(commit || '').trim();
  if (tag && settings.updateDismissed !== tag) {
    saveSettings({ ...settings, updateDismissed: tag });
  }
  hideUpdateToast();
}

function hideUpdateToast() {
  if (!updateToast) return;
  updateToast.classList.remove('is-visible', 'is-busy');
  updateToast.removeAttribute('aria-busy');
  window.setTimeout(() => {
    if (!updateToast.classList.contains('is-visible')) {
      updateToast.classList.add('is-hidden');
      updateToast.hidden = true;
    }
  }, prefersReducedMotion() ? 0 : 220);
}

function commitLabel(value: unknown) {
  const text = String(value || '');
  return /^[0-9a-f]{40}$/i.test(text) ? ('master@' + text.slice(0, 12)) : (text || 'this source build');
}

function setUpdateInstallButtons(disabled: boolean, label: string | null) {
  [btnUpdateInstall, btnAppUpdateInstall].forEach((btn) => {
    if (!btn) return;
    btn.disabled = disabled;
    if (label) btn.textContent = label;
  });
  if (btnAppUpdateCheck) btnAppUpdateCheck.disabled = disabled;
  if (btnUpdateLater) btnUpdateLater.disabled = disabled;
  if (btnUpdateDismiss) btnUpdateDismiss.disabled = disabled;
}

function renderAppUpdatePane(status: AppUpdateStatus | null | undefined) {
  const currentRaw = String(status?.current || latestState?.version || '');
  const currentLabel = commitLabel(currentRaw);
  if (appUpdateCurrent) {
    appUpdateCurrent.textContent = currentRaw ? ('Gopher ' + currentLabel) : 'Gopher';
  }
  if (btnAppUpdateNotes) {
    btnAppUpdateNotes.href = status?.commit_url || 'https://github.com/jacobzymet/gopher/commits/master';
  }
  const canInstall = Boolean(status?.can_install && status?.update_available);
  if (btnAppUpdateInstall) {
    btnAppUpdateInstall.hidden = !canInstall;
    if (!updateInstallInFlight) {
      btnAppUpdateInstall.disabled = false;
      btnAppUpdateInstall.textContent = 'Build and restart';
    }
  }
  if (!appUpdateStatus) return;
  if (updateInstallInFlight) return;
  if (!status) {
    appUpdateStatus.textContent = 'Could not check master on GitHub.';
    return;
  }
  if (status.error) {
    appUpdateStatus.textContent = String(status.error);
    return;
  }
  const latestLabel = commitLabel(status.latest);
  if (status.update_available) {
    if (canInstall) {
      appUpdateStatus.textContent = 'You’re on ' + currentLabel + '. Build ' + latestLabel + ' locally with Node.js and restart Gopher.';
    } else if (status.install_blocked) {
      appUpdateStatus.textContent = 'You’re on ' + currentLabel + '. ' + latestLabel + ' is available. ' + String(status.install_blocked);
    } else {
      appUpdateStatus.textContent = 'You’re on ' + currentLabel + '. ' + latestLabel + ' is available on GitHub.';
    }
    return;
  }
  if (status.latest) {
    appUpdateStatus.textContent = 'You’re on the current master commit (' + latestLabel + ').';
    return;
  }
  appUpdateStatus.textContent = 'The master commit could not be determined.';
}

function showUpdateToast(status: AppUpdateStatus | null | undefined) {
  if (!updateToast || !status || !status.update_available || !status.latest) return;
  if (updateInstallInFlight) return;
  if (dismissedUpdateCommit() === String(status.latest)) return;
  const latestLabel = commitLabel(status.latest);
  const currentLabel = commitLabel(status.current);
  const canInstall = Boolean(status.can_install);
  if (updateToastTitle) {
    updateToastTitle.textContent = 'Gopher ' + latestLabel;
  }
  if (updateToastBody) {
    if (canInstall) {
      updateToastBody.textContent =
        'You’re on ' + currentLabel + '. Build ' + latestLabel + ' locally with Node.js and restart Gopher.';
    } else if (status.install_blocked) {
      updateToastBody.textContent =
        'You’re on ' + currentLabel + '. ' + latestLabel + ' is available. ' + String(status.install_blocked);
    } else {
      updateToastBody.textContent =
        'You’re on ' + currentLabel + '. ' + latestLabel + ' is available on GitHub.';
    }
  }
  if (btnUpdateView && status.commit_url) {
    btnUpdateView.href = status.commit_url;
    btnUpdateView.textContent = 'View commit';
    btnUpdateView.className = canInstall ? 'btn btn-ghost' : 'btn btn-primary';
    btnUpdateView.hidden = false;
  }
  if (btnUpdateInstall) {
    btnUpdateInstall.hidden = !canInstall;
    btnUpdateInstall.disabled = false;
    btnUpdateInstall.textContent = 'Build and restart';
  }
  if (btnUpdateLater) btnUpdateLater.disabled = false;
  if (btnUpdateDismiss) btnUpdateDismiss.disabled = false;
  updateToast.dataset.latest = String(status.latest);
  updateToast.hidden = false;
  updateToast.classList.remove('is-hidden', 'is-busy');
  updateToast.removeAttribute('aria-busy');
  void updateToast.offsetWidth;
  afterNextPaint(() => updateToast.classList.add('is-visible'));
}

async function checkForAppUpdate({ force = false } = {}) {
  if (updateInstallInFlight) return lastAppUpdateStatus;
  try {
    const response = await fetch('/api/updates/check' + (force ? '?force=1' : ''));
    if (!response.ok) {
      renderAppUpdatePane(null);
      return null;
    }
    const status: AppUpdateStatus = await response.json();
    lastAppUpdateStatus = status;
    renderAppUpdatePane(status);
    if (status && status.update_available) showUpdateToast(status);
    else if (updateToast) {
      updateToast.hidden = true;
      updateToast.classList.remove('is-visible');
    }
    return status;
  } catch {
    renderAppUpdatePane(null);
    return null;
  }
}

function refreshAppUpdatePane() {
  if (lastAppUpdateStatus) renderAppUpdatePane(lastAppUpdateStatus);
  checkForAppUpdate();
}

async function installAppUpdate() {
  if (updateInstallInFlight) return;
  const canInstall = Boolean(
    (btnUpdateInstall && !btnUpdateInstall.hidden)
    || (btnAppUpdateInstall && !btnAppUpdateInstall.hidden)
  );
  if (!canInstall) return;
  updateInstallInFlight = true;
  if (updateToast) {
    updateToast.classList.add('is-busy');
    updateToast.setAttribute('aria-busy', 'true');
  }
  const installingLabel = 'Building ' + commitLabel(lastAppUpdateStatus?.latest || updateToast?.dataset?.latest) + ' locally. This may take several minutes. Gopher will restart after a successful build.';
  if (updateToastBody) updateToastBody.textContent = installingLabel;
  if (appUpdateStatus) appUpdateStatus.textContent = installingLabel;
  setUpdateInstallButtons(true, 'Building…');
  try {
    const response = await fetch('/api/updates/apply', { method: 'POST' });
    const body: RuntimeApiProblem = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || 'Could not build the update');
    }
    if (updateToastBody) updateToastBody.textContent = 'Restarting Gopher…';
    if (appUpdateStatus) appUpdateStatus.textContent = 'Restarting Gopher…';
    setUpdateInstallButtons(true, 'Restarting…');
  } catch (error) {
    updateInstallInFlight = false;
    if (updateToast) {
      updateToast.classList.remove('is-busy');
      updateToast.removeAttribute('aria-busy');
    }
    const message = (error as Error | undefined)?.message || 'Could not build the update.';
    if (updateToastBody) updateToastBody.textContent = message;
    if (appUpdateStatus) appUpdateStatus.textContent = message;
    setUpdateInstallButtons(false, 'Build and restart');
  }
}

btnUpdateLater?.addEventListener('click', () => {
  dismissUpdateNotice(updateToast?.dataset?.latest);
});
btnUpdateDismiss?.addEventListener('click', () => {
  dismissUpdateNotice(updateToast?.dataset?.latest);
});
btnUpdateInstall?.addEventListener('click', () => {
  installAppUpdate();
});
btnAppUpdateInstall?.addEventListener('click', () => {
  installAppUpdate();
});
btnAppUpdateCheck?.addEventListener('click', () => {
  if (updateInstallInFlight) return;
  if (appUpdateStatus) appUpdateStatus.textContent = 'Checking master on GitHub…';
  checkForAppUpdate({ force: true });
});

(async () => {
  await initLocalData();
  applyStoredSidebarCollapsed();
  document.documentElement.classList.add('ui-ready');
  applyStoredPrivacyMode();
  applyChatBackground(settings);
  updateGreeting();
  syncAgentButton();
  syncResearchControls();
  renderSidebar();
  await pollState();
  applyLocationRoute();
  const startupUrl = new URL(window.location.href);
  if (startupUrl.searchParams.get('settings') === 'providers' && !diskEncryptionLocked()) {
    openSettings('providers');
    startupUrl.searchParams.delete('settings');
    history.replaceState(
      { gopher: 1 },
      '',
      startupUrl.pathname + startupUrl.search + startupUrl.hash
    );
  }
  // Route rendering focuses the composer. When encrypted data is locked, put
  // focus back in the blocking unlock field after that startup work completes.
  if (diskEncryptionLocked()) focusUnlockPassphrase();
  window.addEventListener('popstate', () => {
    applyLocationRoute();
  });
  setInterval(pollState, 2000);
  loadUserSkills();
  // Soft update check after the UI settles; GitHub answers are cached server-side.
  window.setTimeout(() => { checkForAppUpdate(); }, 2500);
  setInterval(() => { checkForAppUpdate(); }, 12 * 60 * 60 * 1000);
})();
