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

