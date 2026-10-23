function syncThinkingEffortControls(effort: string) {
  const value = availableThinkingEfforts.has(effort!) ? effort! : 'auto';
  const setting = (document.getElementById('settingThinkingEffort') as HTMLSelectElement);
  if (setting && setting.value !== value) setting.value = value;

  const btn = (document.getElementById('btnThink') as HTMLButtonElement);
  const effortEl = (document.getElementById('btnThinkEffort') as HTMLElement);
  const menu = (document.getElementById('thinkMenu') as HTMLElement);
  const suffix = value === 'auto' ? '' : (value === 'medium' ? 'med' : value);
  if (effortEl) {
    if (suffix) {
      effortEl.textContent = suffix;
      effortEl.classList.remove('is-hidden');
      effortEl.classList.toggle('is-off', value === 'off');
    } else {
      effortEl.textContent = '';
      effortEl.classList.add('is-hidden');
      effortEl.classList.remove('is-off');
    }
  }
  if (btn) {
    btn.classList.toggle('is-active', value !== 'auto' && value !== 'off');
    btn.title = 'Thinking intensity: ' + value + ' — how hard reasoning models should think';
  }
  if (menu) {
    (menu.querySelectorAll('[data-effort]') as NodeListOf<HTMLElement>).forEach((item) => {
      item.classList.toggle('is-active', item.dataset.effort === value);
      item.setAttribute('aria-checked', item.dataset.effort === value ? 'true' : 'false');
    });
  }
}

function thinkMenuIsOpen() {
  const menu = (document.getElementById('thinkMenu') as HTMLElement);
  return !!(menu && !menu.classList.contains('is-hidden') && menu.classList.contains('is-open'));
}

function setThinkMenuOpen(open: boolean) {
  const menu = (document.getElementById('thinkMenu') as HTMLElement);
  const btn = (document.getElementById('btnThink') as HTMLButtonElement);
  if (!menu || !btn) return;
  if (thinkMenuCloseTimer) {
    window.clearTimeout(thinkMenuCloseTimer);
    thinkMenuCloseTimer = 0;
  }
  if (open) {
    setPlusMenuOpen(false);
    if (typeof setWordmarkMenuOpen === 'function') setWordmarkMenuOpen(false);
    menu.classList.remove('is-hidden');
    btn.setAttribute('aria-expanded', 'true');
    void menu.offsetWidth;
    afterNextPaint(() => {
      if (btn.getAttribute('aria-expanded') === 'true') menu.classList.add('is-open');
    });
    return;
  }
  menu.classList.remove('is-open');
  btn.setAttribute('aria-expanded', 'false');
  const finish = () => {
    menu.classList.add('is-hidden');
    thinkMenuCloseTimer = 0;
  };
  if (prefersReducedMotion()) {
    finish();
    return;
  }
  thinkMenuCloseTimer = window.setTimeout(finish, 180);
}

let plusMenuCloseTimer = 0;

const PLUS_CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function plusMenuIcons() {
  return {
    attach:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    search:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/><path d="M3 12h18"/><path d="M3.6 8h16.8"/><path d="M3.6 16h16.8"/></svg>',
    fetch:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    research:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10.5 14.5-6 6"/><path d="m14 6 4 4"/><path d="M15.2 4.8a2.2 2.2 0 0 1 3.1 3.1L10.5 15.7 7.3 12.5Z"/><path d="M4 20h5"/><path d="M6.5 17.5v5"/></svg>',
    agent:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>',
    terminal:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>',
  };
}

function renderPlusMenuItem({ id, iconClass, icon, title, desc, descHtml, badge, on, disabled, titleAttr }: PlusMenuItem) {
  const btn = (document.createElement('button') as HTMLButtonElement);
  btn.type = 'button';
  btn.className = 'plus-menu-item' + (on ? ' is-on' : '');
  btn.dataset.plusAction = id;
  btn.setAttribute('role', 'menuitem');
  if (disabled) btn.disabled = true;
  if (titleAttr) btn.title = titleAttr;
  const descPart = descHtml
    ? '<span class="plus-menu-desc">' + descHtml + '</span>'
    : (desc
      ? '<span class="plus-menu-desc">' + escapeHtml(desc) + '</span>'
      : '');
  const badgePart = badge
    ? '<span class="plus-menu-badge">' + escapeHtml(badge) + '</span>'
    : '';
  btn.innerHTML =
    '<span class="plus-menu-icon ' + iconClass + '" aria-hidden="true">' + icon + '</span>' +
    '<span class="plus-menu-copy">' +
      '<span class="plus-menu-title">' + escapeHtml(title) + '</span>' +
      descPart +
    '</span>' +
    '<span class="plus-menu-trail">' +
      badgePart +
      '<span class="plus-menu-check" aria-hidden="true">' + PLUS_CHECK_SVG + '</span>' +
    '</span>';
  return btn;
}

function renderPlusMenu() {
  if (!plusMenu) return;
  const icons = plusMenuIcons();
  const attachEnabled = attachmentsUiEnabled() && serverReady && !diskEncryptionLocked();
  const attachReason = attachDisabledReason();
  const researchAllowed = settings.skillDeepResearch !== false;
  const agentOn = !!settings.agentMode;

  plusMenu.innerHTML = '';
  plusMenu.appendChild(renderPlusMenuItem({
    id: 'agent',
    iconClass: 'is-agent',
    icon: icons.agent,
    title: 'Agent mode',
    desc: agentOn
      ? 'All agent skills available when needed'
      : 'Unlocks all agent skills when needed',
    badge: 'Recommended',
    on: agentOn,
    disabled: false,
  }));
  plusMenu.appendChild(renderPlusMenuItem({
    id: 'attach',
    iconClass: 'is-attach',
    icon: icons.attach,
    title: 'Add photos & files',
    desc: attachEnabled ? 'Upload from computer' : (attachReason || 'Configure in Settings'),
    on: false,
    disabled: false,
    titleAttr: attachEnabled ? 'Attach files' : (attachReason || 'Go to Settings → Attachments'),
  }));
  if (settings.skillWebSearch !== false) {
    plusMenu.appendChild(renderPlusMenuItem({
      id: 'web_search',
      iconClass: 'is-search',
      icon: icons.search,
      title: agentOn ? 'Require web search' : 'Web search',
      desc: agentOn
        ? 'Must search before answering'
        : 'Keep enabled for this chat',
      on: composerMentionIds.has('web_search'),
      disabled: false,
    }));
  }
  if (settings.skillFetchUrl !== false) {
    plusMenu.appendChild(renderPlusMenuItem({
      id: 'fetch_url',
      iconClass: 'is-fetch',
      icon: icons.fetch,
      title: agentOn ? 'Require fetch URL' : 'Fetch URL',
      desc: agentOn
        ? 'Must open a page before answering'
        : 'Keep enabled for this chat',
      on: composerMentionIds.has('fetch_url'),
      disabled: false,
    }));
  }
  if (researchAllowed) {
    plusMenu.appendChild(renderPlusMenuItem({
      id: 'deep_research_long',
      iconClass: 'is-research',
      icon: icons.research,
      title: 'Deep research · comprehensive',
      desc: 'Detailed report from many sources',
      on: settings.deepResearch === 'long',
      disabled: false,
    }));
    plusMenu.appendChild(renderPlusMenuItem({
      id: 'deep_research_brief',
      iconClass: 'is-research',
      icon: icons.research,
      title: 'Deep research · concise',
      desc: 'Brief answer from many sources',
      on: settings.deepResearch === 'brief',
      disabled: false,
    }));
  }
  plusMenu.appendChild(renderPlusMenuItem({
    id: 'terminal',
    iconClass: 'is-agent',
    icon: icons.terminal,
    title: 'Terminal',
    desc: 'Open a command panel under the chat box',
    on: !!terminalOpen,
    disabled: false,
  }));
}

function renderComposerModes() {
  if (!composerModes) return;
  composerModes.innerHTML = '';
  const researchOn = settings.skillDeepResearch !== false
    && (settings.deepResearch === 'long' || settings.deepResearch === 'brief');
  if (settings.agentMode) {
    const chip = (document.createElement('span') as HTMLElement);
    chip.className = 'composer-mode-chip is-agent-available';
    const forced = [];
    if (composerMentionIds.has('web_search')) forced.push('web_search');
    if (composerMentionIds.has('fetch_url')) forced.push('fetch_url');
    const label = forced.length
      ? 'Agent · required skills'
      : 'Agent · skills when needed';
    chip.innerHTML = '<span>' + escapeHtml(label) + '</span>';
    chip.title = forced.length
      ? 'Pinned skills are required this turn: ' + forced.join(', ')
      : 'Recommended — all agent skills are available; the model uses them when needed';
    const remove = (document.createElement('button') as HTMLButtonElement);
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Turn off agent mode');
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      if (!requireUnlockedData()) return;
      settings.agentMode = false;
      saveSettings({ ...settings });
    });
    chip.appendChild(remove);
    composerModes.appendChild(chip);
  }
  if (researchOn) {
    const chip = (document.createElement('span') as HTMLElement);
    chip.className = 'composer-mode-chip';
    const style = settings.deepResearch === 'brief' ? 'concise' : 'comprehensive';
    chip.innerHTML = '<span>Research · ' + escapeHtml(style) + '</span>';
    const remove = (document.createElement('button') as HTMLButtonElement);
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Turn off deep research');
    remove.textContent = '×';
    remove.addEventListener('click', () => setDeepResearch('off', true));
    chip.appendChild(remove);
    composerModes.appendChild(chip);
  }
  if (!settings.agentMode && !researchOn && composerMentionIds.size === 0) {
    const empty = (document.createElement('span') as HTMLElement);
    empty.className = 'composer-capabilities-empty';
    empty.textContent = 'No agent capabilities enabled';
    composerModes.appendChild(empty);
  }
}

function plusMenuIsOpen() {
  return !!(plusMenu && !plusMenu.classList.contains('is-hidden') && plusMenu.classList.contains('is-open'));
}

function placePlusMenu() {
  if (!plusMenu || !composerCard) return;
  plusMenu.classList.remove('is-above');
  plusMenu.style.maxHeight = '';
  const gap = 10;
  const cardRect = composerCard.getBoundingClientRect();
  const spaceBelow = Math.max(0, window.innerHeight - cardRect.bottom - gap);
  const spaceAbove = Math.max(0, cardRect.top - gap);
  const natural = plusMenu.scrollHeight;
  const cap = Math.min(22 * 16, window.innerHeight - gap * 2);
  const openAbove = spaceBelow < Math.min(natural, 12 * 16) && spaceAbove > spaceBelow;
  if (openAbove) {
    plusMenu.classList.add('is-above');
    plusMenu.style.maxHeight = Math.min(cap, spaceAbove) + 'px';
  } else {
    plusMenu.style.maxHeight = Math.min(cap, Math.max(spaceBelow, 8 * 16)) + 'px';
  }
}

function setPlusMenuOpen(open: boolean) {
  if (!plusMenu || !btnPlus) return;
  if (plusMenuCloseTimer) {
    window.clearTimeout(plusMenuCloseTimer);
    plusMenuCloseTimer = 0;
  }
  if (open) {
    if (thinkMenuIsOpen()) setThinkMenuOpen(false);
    if (typeof setWordmarkMenuOpen === 'function') setWordmarkMenuOpen(false);
    renderPlusMenu();
    plusMenu.classList.remove('is-hidden');
    placePlusMenu();
    btnPlus.setAttribute('aria-expanded', 'true');
    btnPlus.title = 'Close';
    btnPlus.setAttribute('aria-label', 'Close');
    void plusMenu.offsetWidth;
    afterNextPaint(() => {
      if (btnPlus.getAttribute('aria-expanded') === 'true') plusMenu.classList.add('is-open');
    });
    return;
  }
  plusMenu.classList.remove('is-open');
  btnPlus.setAttribute('aria-expanded', 'false');
  btnPlus.title = 'Add files and capabilities';
  btnPlus.setAttribute('aria-label', 'Add files and capabilities');
  const finish = () => {
    plusMenu.classList.add('is-hidden');
    plusMenu.classList.remove('is-above');
    plusMenu.style.maxHeight = '';
    plusMenuCloseTimer = 0;
  };
  if (prefersReducedMotion()) {
    finish();
    return;
  }
  plusMenuCloseTimer = window.setTimeout(finish, 180);
}

function toggleComposerMention(id: string) {
  if (composerMentionIds.has(id)) composerMentionIds.delete(id);
  else composerMentionIds.add(id);
  renderComposerMentions();
  renderComposerModes();
  syncPlusButton();
  renderPlusMenu();
  composerInput.focus();
}

function handlePlusMenuAction(action: string | undefined) {
  if (action === 'attach') {
    const enabled = attachmentsUiEnabled() && serverReady && !diskEncryptionLocked();
    setPlusMenuOpen(false);
    if (!enabled) {
      openSettings();
      showSettingsPane('attachments');
      return;
    }
    attachFileInput.click();
    return;
  }
  if (action === 'web_search') {
    if (settings.skillWebSearch === false) return;
    toggleComposerMention('web_search');
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'fetch_url') {
    if (settings.skillFetchUrl === false) return;
    toggleComposerMention('fetch_url');
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'deep_research_long') {
    if (settings.skillDeepResearch === false) return;
    setDeepResearch(settings.deepResearch === 'long' ? 'off' : 'long', true);
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'deep_research_brief') {
    if (settings.skillDeepResearch === false) return;
    setDeepResearch(settings.deepResearch === 'brief' ? 'off' : 'brief', true);
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'agent') {
    if (!requireUnlockedData()) return;
    settings.agentMode = !settings.agentMode;
    saveSettings({ ...settings });
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'terminal') {
    setPlusMenuOpen(false);
    if (typeof toggleTerminalPanel === 'function') toggleTerminalPanel();
  }
}

function syncResearchControls() {
  const allowed = settings.skillDeepResearch !== false;
  if (!allowed && settings.deepResearch !== 'off') {
    settings.deepResearch = 'off';
  }
  renderComposerModes();
  renderPlusMenu();
  syncPlusButton();
}

function setDeepResearch(mode: string, persist: boolean) {
  if (settings.skillDeepResearch === false && mode !== 'off') return;
  const value = DEEP_RESEARCH_MODES.includes(mode) ? mode : 'off';
  settings.deepResearch = value;
  syncResearchControls();
  updateComposerHint();
  if (persist) {
    saveSettings({
      ...settings,
      deepResearch: value,
    });
  }
}

let thinkingSupported = false;
let activeThinkingEffort = 'auto';
let availableThinkingEfforts = new Set(['auto']);

function modelExposesThinkingControl(model: ModelOption | null | undefined): model is ModelOption {
  if (!model || !model.thinking_control) return false;
  const efforts = Array.isArray(model.thinking_efforts) ? model.thinking_efforts : [];
  return efforts.length > 0 || !!model.thinking_can_disable;
}

function thinkingEffortForModel(model: ModelOption | null | undefined) {
  if (!modelExposesThinkingControl(model)) return null;
  const efforts = Array.isArray(model.thinking_efforts) ? model.thinking_efforts : [];
  const canDisable = !!model.thinking_can_disable;
  const wanted = String(settings.thinkingEffort || activeThinkingEffort || 'auto');
  if (wanted === 'auto') return null;
  if (wanted === 'off') return canDisable ? 'off' : null;
  return efforts.includes(wanted) ? wanted : null;
}

function renderThinkingEffortOptions(values: string[]) {
  // Presentation order only: the catalog still determines which values exist.
  // Provider-specific tiers retain their catalog order after the familiar levels.
  const displayOrder = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const rank = (value: string) => {
    const index = displayOrder.indexOf(value.toLowerCase());
    return index < 0 ? displayOrder.length : index;
  };
  values = [...values].sort((left, right) => rank(left) - rank(right));
  const signature = JSON.stringify(values);
  const menu = (document.getElementById('thinkMenu') as HTMLElement);
  const setting = (document.getElementById('settingThinkingEffort') as HTMLSelectElement);
  for (const container of [menu, setting]) {
    if (!container || container.dataset.efforts === signature) continue;
    container.dataset.efforts = signature;
    const items: HTMLElement[] = values.map((value: string) => {
      const item = (document.createElement(container === menu ? 'button' : 'option') as HTMLButtonElement | HTMLOptionElement);
      item.textContent = value === 'auto' && container === setting
        ? 'Auto (model default)'
        : value.charAt(0).toUpperCase() + value.slice(1);
      if (container === menu) {
        (item as HTMLButtonElement).type = 'button';
        item.setAttribute('role', 'menuitemradio');
        item.dataset.effort = value;
      } else {
        item.value = value;
      }
      return item;
    });
    if (container === menu) {
      const label = (document.createElement('div') as HTMLElement);
      label.className = 'think-menu-label';
      label.textContent = 'Intensity';
      items.unshift(label);
    }
    container.replaceChildren(...items);
  }
}

function syncComposerThinkVisibility(model: ModelOption | null | undefined) {
  const efforts = Array.isArray(model?.thinking_efforts) ? model.thinking_efforts : [];
  const canDisable = !!model?.thinking_can_disable;
  thinkingSupported = modelExposesThinkingControl(model);
  const onLoop = typeof isBotsSurface === 'function' && isBotsSurface();
  availableThinkingEfforts = new Set([
    'auto',
    ...(thinkingSupported && canDisable ? ['off'] : []),
    ...(thinkingSupported ? efforts : []),
  ]);
  activeThinkingEffort = availableThinkingEfforts.has(settings.thinkingEffort) ? settings.thinkingEffort : 'auto';
  renderThinkingEffortOptions([...availableThinkingEfforts]);
  const wrap = (document.getElementById('composerThinkWrap') as HTMLElement);
  if (!wrap) return;
  wrap.classList.toggle('is-hidden', onLoop || !thinkingSupported);
  if (onLoop || !thinkingSupported) setThinkMenuOpen(false);
  const effort = (document.getElementById('settingThinkingEffort') as HTMLSelectElement);
  const effortRow = effort && (effort.closest('.settings-row') as HTMLElement);
  if (effort) {
    effort.disabled = !thinkingSupported;
    if (effortRow) {
      effortRow.style.opacity = thinkingSupported ? '' : '0.55';
      effortRow.title = thinkingSupported
        ? ''
        : 'Current model does not expose controllable thinking.';
    }
  }
  syncThinkingEffortControls(activeThinkingEffort);
}

function setThinkingEffort(effort: string | undefined, persist = true) {
  const value = availableThinkingEfforts.has(effort!) ? effort! : 'auto';
  activeThinkingEffort = value;
  syncThinkingEffortControls(value);
  if (persist) {
    if (!requireUnlockedData()) {
      syncThinkingEffortControls(settings.thinkingEffort);
      return;
    }
    saveSettings({ ...settings, thinkingEffort: value });
  }
}

async function commitSettings() {
  if (!requireUnlockedData()) return;
  const backgroundUrl = (document.getElementById('settingChatBackgroundUrl') as HTMLInputElement);
  if (pendingChatBackgroundImage && !normalizeChatBackgroundImage(pendingChatBackgroundImage)) {
    backgroundUrl?.reportValidity();
    backgroundUrl?.focus();
    return;
  }
  if (!settingsFormIsDirty()) {
    syncSettingsSaveButton({ saved: true });
    return;
  }
  const next = readSettingsForm();
  if (!next.skillDeepResearch) {
    next.deepResearch = 'off';
  }
  const previous = settings;
  syncSettingsSaveButton({ saving: true });
  const saved = await saveSettings(next, { immediate: true });
  if (!saved) {
    if (!diskEncryptionLocked()) {
      applySettingsInMemory(previous);
      syncSettingsSaveButton({ failed: true });
    }
    return;
  }
  if (typeof hydrateModelPickerState === 'function') hydrateModelPickerState();
  if (next.selectedChatModel) {
    rememberRecentModel(next.selectedChatModel);
  }
  if (latestState && typeof syncModelSelector === 'function') syncModelSelector(latestState);
  syncThinkingEffortControls(settings.thinkingEffort);
  syncResearchControls();
  syncAttachButton();
  syncSettingsSaveButton({ saved: true });
  const convo = conversations.find((item) => item.id === activeId);
  if (convo) renderThread(convo);
}
