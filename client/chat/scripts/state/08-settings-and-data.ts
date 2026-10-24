function normalizeSearxngUrl(raw: unknown) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const withScheme = /:\/\//.test(value)
      ? value
      : (/^(localhost|127\.|\[::1\]|\[::\])/i.test(value) ? 'http://' : 'https://') + value;
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    url.hash = '';
    url.search = '';
    let path = url.pathname.replace(/\/+$/, '');
    return url.origin + path;
  } catch {
    return '';
  }
}

function normalizeSettings(parsed: Record<string, unknown> | null | undefined): AppSettings {
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };
  const maxChars = Number(parsed.attachmentMaxChars);
  const fetchUrlMaxChars = Number(parsed.fetchUrlMaxChars);
  const webSearchPageMaxChars = Number(parsed.webSearchPageMaxChars);
  const searchResults = Number(parsed.webSearchResults);
  const searchRegion = String(parsed.webSearchRegion || '').trim().toLowerCase();
  const chatBackgroundOverlay = Number(parsed.chatBackgroundOverlay);
  return {
    name: typeof parsed.name === 'string' ? parsed.name : '',
    about: typeof parsed.about === 'string' ? parsed.about : '',
    instructions: typeof parsed.instructions === 'string' ? parsed.instructions : '',
    memory: typeof parsed.memory === 'string' ? parsed.memory : '',
    chatRetrieval: parsed.chatRetrieval !== false,
    thinking: ['collapsed', 'hidden', 'visible'].includes(parsed.thinking)
      ? parsed.thinking
      : 'collapsed',
    thinkingEffort: normalizeThinkingEffort(parsed.thinkingEffort),
    enterSends: parsed.enterSends !== false,
    skillWebSearch: parsed.skillWebSearch !== false,
    webSearchDepth: WEB_SEARCH_DEPTHS.includes(parsed.webSearchDepth)
      ? parsed.webSearchDepth
      : DEFAULT_SETTINGS.webSearchDepth,
    webSearchProvider: WEB_SEARCH_PROVIDERS.includes(parsed.webSearchProvider)
      ? parsed.webSearchProvider
      : DEFAULT_SETTINGS.webSearchProvider,
    webSearchSearxng: normalizeSearxngUrl(parsed.webSearchSearxng),
    webSearchParallelApiKey: typeof parsed.webSearchParallelApiKey === 'string'
      ? parsed.webSearchParallelApiKey.trim()
      : '',
    webSearchParallelMode: WEB_SEARCH_PARALLEL_MODES.includes(parsed.webSearchParallelMode)
      ? parsed.webSearchParallelMode
      : DEFAULT_SETTINGS.webSearchParallelMode,
    webSearchTinyfishApiKey: typeof parsed.webSearchTinyfishApiKey === 'string'
      ? parsed.webSearchTinyfishApiKey.trim()
      : '',
    webSearchResults: Number.isFinite(searchResults)
      ? Math.min(20, Math.max(1, Math.round(searchResults)))
      : DEFAULT_SETTINGS.webSearchResults,
    webSearchRegion: /^[a-z]{2}-[a-z]{2}$/.test(searchRegion)
      ? searchRegion
      : DEFAULT_SETTINGS.webSearchRegion,
    webSearchSafeSearch: WEB_SEARCH_SAFESEARCH.includes(parsed.webSearchSafeSearch)
      ? parsed.webSearchSafeSearch
      : DEFAULT_SETTINGS.webSearchSafeSearch,
    webSearchRecency: WEB_SEARCH_RECENCIES.includes(parsed.webSearchRecency)
      ? parsed.webSearchRecency
      : DEFAULT_SETTINGS.webSearchRecency,
    skillFetchUrl: parsed.skillFetchUrl !== false,
    fetchUrlMaxChars: Number.isFinite(fetchUrlMaxChars)
      ? Math.min(200000, Math.max(1000, Math.round(fetchUrlMaxChars)))
      : DEFAULT_SETTINGS.fetchUrlMaxChars,
    webSearchPageMaxChars: Number.isFinite(webSearchPageMaxChars)
      ? (Math.round(webSearchPageMaxChars) <= 0
        ? 0
        : Math.min(200000, Math.max(1000, Math.round(webSearchPageMaxChars))))
      : DEFAULT_SETTINGS.webSearchPageMaxChars,
    skillDeepResearch: false,
    approvalMode: APPROVAL_MODES.includes(parsed.approvalMode)
      ? parsed.approvalMode
      : DEFAULT_SETTINGS.approvalMode,
    diagnosticsEnabled: parsed.diagnosticsEnabled === true,
    skillFilesystem: parsed.skillFilesystem === true,
    skillTerminal: parsed.skillTerminal === true,
    skillBrowser: parsed.skillBrowser === true,
    terminalTimeoutSecs: (() => {
      const n = Number(parsed.terminalTimeoutSecs);
      if (!Number.isFinite(n)) return DEFAULT_SETTINGS.terminalTimeoutSecs;
      return Math.min(30, Math.max(5, Math.round(n)));
    })(),
    terminalHeightVh: (() => {
      const n = Number(parsed.terminalHeightVh);
      if (!Number.isFinite(n)) return DEFAULT_SETTINGS.terminalHeightVh;
      return Math.min(0.72, Math.max(0.16, n));
    })(),
    agentMode: parsed.agentMode !== false,
    deepResearch: 'off',
    attachmentsMode: ATTACHMENTS_MODES.includes(parsed.attachmentsMode)
      ? parsed.attachmentsMode
      : DEFAULT_SETTINGS.attachmentsMode,
    attachmentTextFallback: parsed.attachmentTextFallback === true,
    attachmentOcr: parsed.attachmentOcr === true,
    attachmentMaxChars: Number.isFinite(maxChars)
      ? Math.min(500000, Math.max(2000, Math.round(maxChars)))
      : DEFAULT_SETTINGS.attachmentMaxChars,
    chatBackgroundImage: normalizeChatBackgroundImage(parsed.chatBackgroundImage),
    chatBackgroundImageName: typeof parsed.chatBackgroundImageName === 'string'
      ? parsed.chatBackgroundImageName.slice(0, 255)
      : '',
    chatBackgroundPosition: CHAT_BACKGROUND_POSITIONS.includes(parsed.chatBackgroundPosition)
      ? parsed.chatBackgroundPosition
      : DEFAULT_SETTINGS.chatBackgroundPosition,
    chatBackgroundOverlay: Number.isFinite(chatBackgroundOverlay)
      ? Math.min(100, Math.max(0, Math.round(chatBackgroundOverlay)))
      : DEFAULT_SETTINGS.chatBackgroundOverlay,
    selectedChatModel: typeof parsed.selectedChatModel === 'string'
      ? parsed.selectedChatModel.trim()
      : '',
    recentModelIds: normalizeModelIds(parsed.recentModelIds, RECENT_MODELS_MAX),
    pinnedModelIds: normalizeModelIds(parsed.pinnedModelIds, PINNED_MODELS_MAX),
    collapsedModelProviders: normalizeModelIds(parsed.collapsedModelProviders, 64),
    sidebarCollapsed: parsed.sidebarCollapsed === true,
    privacyMode: parsed.privacyMode === true,
    appSurface: parsed.appSurface === 'bots' ? 'bots' : 'chat',
    traceActivityShare: (() => {
      const n = Number(parsed.traceActivityShare);
      if (!Number.isFinite(n)) return DEFAULT_SETTINGS.traceActivityShare;
      return Math.min(0.78, Math.max(0.22, n));
    })(),
    traceActivityFolded: parsed.traceActivityFolded === true,
    traceMembersFolded: parsed.traceMembersFolded === true,
    autoOpenTraceSidebar: parsed.autoOpenTraceSidebar !== false,
    updateDismissed: typeof parsed.updateDismissed === 'string'
      ? parsed.updateDismissed.trim()
      : '',
    browserMigrationVersion: Number.isInteger(parsed.browserMigrationVersion)
      ? parsed.browserMigrationVersion as number
      : 0,
  };
}

function enqueueSettingsWrite(snapshot: Partial<AppSettings>) {
  const epoch = storageWriteEpoch;
  settingsWriteChain = settingsWriteChain
    .catch(() => {})
    .then(() => putJsonWithRetry('/api/data/preferences', snapshot, {
      valid: () => epoch === storageWriteEpoch && !diskEncryptionLocked(),
    }));
  return settingsWriteChain;
}

function applySettingsInMemory(next: AppSettings) {
  settings = next;
  syncConversationModel();
  syncActiveProfileFromMemory({ touch: true });
  syncAccountProfileUi();
  applyChatBackground(settings);
  updateGreeting();
  updateComposerHint();
  syncAgentButton();
  syncResearchControls();
  syncAttachButton();
  if (typeof applyTerminalHeight === 'function') applyTerminalHeight();
  if (typeof syncDiagnosticsCapture === 'function') syncDiagnosticsCapture();
}

function saveSettings(next: AppSettings, { immediate = true } = {}) {
  if (!storageReady || diskEncryptionLocked()) return Promise.resolve(false);
  applySettingsInMemory(next);
  saveStore({ immediate });
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = null;
  if (immediate) {
    return enqueueSettingsWrite(preferencesPayload());
  }
  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    if (diskEncryptionLocked()) return;
    enqueueSettingsWrite(preferencesPayload());
  }, 120);
  return Promise.resolve(true);
}

let settings: AppSettings = { ...DEFAULT_SETTINGS };

function refreshLocalDataPane() {
  const lede = (document.getElementById('settingsDataLede') as HTMLElement);
  const pathEl = (document.getElementById('settingsDataPath') as HTMLElement);
  const filesEl = (document.getElementById('settingsDataFiles') as HTMLElement);
  const openBtn = (document.getElementById('btnOpenDataDir') as HTMLButtonElement);
  const personalizationLede = (document.querySelector(
    '.settings-pane[data-settings-pane="personalization"] .settings-pane-lede'
  ) as HTMLElement);

  if (lede) {
    lede.textContent = 'The app stores profiles, chats, projects, and settings in the operating system data folder.';
  }
  if (personalizationLede) {
    personalizationLede.textContent = 'The app stores this information with your local data. The app sends it as a system prompt with each message.';
  }
  if (pathEl) {
    pathEl.textContent = dataInfo?.data_dir || 'Not available';
  }
  if (filesEl) {
    if (dataInfo) {
      filesEl.textContent = dataInfo.encryption_enabled
        ? 'One passphrase encrypts all profiles, preferences, provider credentials, skills, and saved diagnostic logs. The config.toml file contains only startup configuration that is not sensitive.'
        : 'This folder contains config.toml, chats.json, preferences.json, and chat-skills/. The chats.json file contains the profile data.';
    } else {
      filesEl.textContent = 'Not available';
    }
  }
  if (openBtn) {
    openBtn.textContent = dataInfo?.open_label || 'Open folder';
    openBtn.disabled = !dataInfo?.data_dir;
  }
  refreshEncryptionPane();
  refreshEncryptionIndicator();
}

function refreshEncryptionIndicator() {
  if (!encryptionIndicator || !encryptionIndicatorLabel || !encryptionIndicatorDetail) return;
  const enabled = !!dataInfo?.encryption_enabled;
  encryptionIndicator.classList.toggle('is-hidden', !enabled);
  encryptionIndicator.classList.remove('is-locked', 'is-recovery', 'is-browser');
  const sidebarToggle = (document.getElementById('btnToggleSidebar') as HTMLButtonElement);
  if (!enabled) {
    if (sidebarToggle) delete sidebarToggle.dataset.encryptionDetail;
    if (typeof syncSidebarToggleUi === 'function') syncSidebarToggleUi();
    return;
  }

  let label = 'Encrypted';
  let shortDetail = 'At rest';
  let detail = 'Encrypted at rest · unlocked for this session';
  if (dataInfo!.encryption_transition_pending) {
    label = 'Recovery';
    shortDetail = 'Action needed';
    detail = 'Encryption recovery needed · enter your passphrase to finish safely';
    encryptionIndicator.classList.add('is-recovery');
  } else if (!dataInfo!.encryption_unlocked) {
    label = 'Locked';
    shortDetail = 'Session locked';
    detail = 'Encrypted at rest · locked for this session';
    encryptionIndicator.classList.add('is-locked');
  }
  encryptionIndicatorLabel.textContent = label;
  encryptionIndicatorDetail.textContent = shortDetail;
  encryptionIndicator.setAttribute('aria-label', detail + '. Open encryption settings');
  encryptionIndicator.title = detail + '. Open encryption settings';
  if (sidebarToggle) sidebarToggle.dataset.encryptionDetail = detail;
  if (typeof syncSidebarToggleUi === 'function') syncSidebarToggleUi();
}

function refreshEncryptionPane() {
  const statusEl = (document.getElementById('settingsEncryptionStatus') as HTMLElement);
  const enableEl = (document.getElementById('settingsEncryptionEnable') as HTMLElement);
  const unlockEl = (document.getElementById('settingsEncryptionUnlock') as HTMLElement);
  const activeEl = (document.getElementById('settingsEncryptionActive') as HTMLElement);
  const disableForm = (document.getElementById('settingsEncryptionDisable') as HTMLElement);
  if (!statusEl || !enableEl || !unlockEl || !activeEl) return;

  const enabled = !!(dataInfo && dataInfo.encryption_enabled);
  const unlocked = !!(dataInfo && dataInfo.encryption_unlocked);

  enableEl.classList.add('is-hidden');
  unlockEl.classList.add('is-hidden');
  activeEl.classList.add('is-hidden');
  if (disableForm) disableForm.classList.add('is-hidden');

  if (!enabled) {
    statusEl.textContent = 'Off. The app stores chats, settings, provider configuration, provider credentials, and skills without encryption.';
    enableEl.classList.remove('is-hidden');
    return;
  }

  if (!unlocked) {
    statusEl.textContent = 'Locked. Enter your passphrase to read and write encrypted data.';
    unlockEl.classList.remove('is-hidden');
    return;
  }

  statusEl.textContent = 'Unlocked. The app encrypts chats, settings, provider configuration, provider credentials, and skill contents on disk.';
  activeEl.classList.remove('is-hidden');
}

async function postEncryption(path: URL | RequestInfo, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const payload: DataInfo & { error?: string } = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Encryption request failed');
  }
  dataInfo = payload;
  refreshLocalDataPane();
  refreshSettingsDataSummary();
  return dataInfo;
}

