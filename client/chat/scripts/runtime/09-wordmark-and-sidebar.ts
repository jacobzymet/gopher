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

