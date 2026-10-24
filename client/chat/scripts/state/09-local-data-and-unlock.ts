function normalizeLoadedStore(store: ParsedStore, rawPreferences: Record<string, unknown> | null | undefined): LoadedData {
  const preferences = normalizeSettings(
    rawPreferences && typeof rawPreferences === 'object' ? rawPreferences : {}
  );
  const selectedProfile = store.profiles.find((profile) => profile.id === store.activeProfileId)
    || store.profiles[0];
  if (selectedProfile && (!selectedProfile._contextPresent || store.migratedFromLegacy)) {
    selectedProfile.personalization = profileContextFromSettings(preferences);
    selectedProfile._contextPresent = true;
  }
  return {
    store,
    preferences: settingsForProfile(preferences, selectedProfile),
  };
}

function adoptLoadedData(loaded: LoadedData) {
  profiles = loaded.store.profiles;
  profiles._migratedFromLegacy = !!loaded.store.migratedFromLegacy;
  activeProfileId = loaded.store.activeProfileId;
  bindActiveProfile(activeProfile());
  settings = loaded.preferences;
}

async function fetchLocalDataJson<Path extends keyof LocalDataResponses>(path: Path): Promise<LocalDataResponses[Path] | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok) {
        const problem: { error?: string; code?: string } = await response.json().catch(() => ({}));
        const error = new Error(problem.error || 'Could not load saved data (' + response.status + ')');
        error.code = problem.code;
        error.status = response.status;
        throw error;
      }
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object'
          || (Array.isArray(value) && path !== '/api/data/store')) {
        throw new Error('Saved data response is invalid');
      }
      return value as LocalDataResponses[Path];
    } catch (error) {
      if ((error as Error).code === 'encrypted_locked' || ((error as Error).status && (error as Error).status! < 500)
          || attempt === 2) throw error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise<unknown>((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
}

function showLocalDataLoadError(message: string) {
  localDataLoadError = message;
  const banner = (document.getElementById('localDataError') as HTMLElement);
  const detail = (document.getElementById('localDataErrorDetail') as HTMLElement);
  if (banner) banner.classList.toggle('is-hidden', !message);
  if (detail) detail.textContent = message;
  if (typeof updateSendEnabled === 'function') updateSendEnabled();
}

async function initLocalData() {
  storageReady = false;
  showLocalDataLoadError('');
  try {
    dataInfo = (await fetchLocalDataJson('/api/data'))!;
  } catch (error) {
    showLocalDataLoadError((error as Error).message || 'Could not load local data');
    return;
  }
  if (dataInfo?.browser_storage) {
    try {
      const response = await fetch('/api/data', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ browser_storage: false }),
      });
      if (response.ok) dataInfo = await response.json();
    } catch {
      /* Disk is the only storage mode; ignore a failed rewrite of an old flag. */
    }
  }

  if (dataInfo!.encryption_enabled && !dataInfo!.encryption_unlocked) {
    profiles = [];
    activeProfileId = DEFAULT_PROFILE_ID;
    projects = [];
    conversations = [];
    bots = [];
    settings = { ...DEFAULT_SETTINGS };
    // Stay on disk mode but wait for unlock before reading encrypted files.
  } else {
    try {
      const store = parseStorePayload(await fetchLocalDataJson('/api/data/store'));
      const rawPrefs = await fetchLocalDataJson('/api/data/preferences');
      const loaded = normalizeLoadedStore(store, rawPrefs);
      adoptLoadedData(loaded);
    } catch (error) {
      if ((error as Error).code === 'encrypted_locked') {
        profiles = [];
        activeProfileId = DEFAULT_PROFILE_ID;
        projects = [];
        conversations = [];
        bots = [];
        settings = { ...DEFAULT_SETTINGS };
        dataInfo!.encryption_enabled = true;
        dataInfo!.encryption_unlocked = false;
      } else {
        showLocalDataLoadError((error as Error).message || 'Could not load saved chats and settings');
        return;
      }
    }
  }

  if (!profiles.length && !diskEncryptionLocked()) {
    const profile = normalizeProfile({ id: DEFAULT_PROFILE_ID, name: 'Personal' });
    profiles = [profile];
    activeProfileId = profile.id;
    bindActiveProfile(profile);
  }

  hydrateModelPickerState();
  restoreOutboundQueues(conversations);
  storageReady = !diskEncryptionLocked();
  if (typeof restoreAppSurface === 'function') restoreAppSurface();
  if (typeof loadTraceSplitPrefs === 'function') loadTraceSplitPrefs();
  if (profiles.some((profile) => profile.conversations._sortOrderMigrated)) {
    profiles.forEach((profile) => { delete profile.conversations._sortOrderMigrated; });
    saveStore();
  }
  if (!diskEncryptionLocked() && (
    profiles._migratedFromLegacy
    || profiles.some((profile) => profile._contextPresent === false)
  )) {
    delete profiles._migratedFromLegacy;
    saveStore();
    enqueueSettingsWrite(preferencesPayload());
  }
  refreshLocalDataPane();
  syncAccountProfileUi();
  syncAgentButton();
  syncResearchControls();
  if (diskEncryptionLocked()) promptUnlockSession();
}

function setUnlockModalError(message: string) {
  const el = (document.getElementById('unlockModalError') as HTMLElement);
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('is-hidden', !message);
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function focusUnlockPassphrase() {
  const modal = (document.getElementById('unlockModal') as HTMLElement);
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  if (!modal || !input || modal.classList.contains('is-hidden')) return;
  requestAnimationFrame(() => {
    if (!modal.classList.contains('is-hidden')) input.focus({ preventScroll: true });
  });
}

let unlockHideGeneration = 0;

function promptUnlockSession() {
  const modal = (document.getElementById('unlockModal') as HTMLElement);
  if (!modal) return;
  if (typeof unlockModalIsBusy === 'function' && unlockModalIsBusy()) return;
  unlockHideGeneration += 1;
  closeSettings();
  setUnlockModalError('');
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  if (input) input.value = '';
  if (typeof setUnlockPassphraseRevealed === 'function') setUnlockPassphraseRevealed(false);
  openBackdrop(modal);
  focusUnlockPassphrase();
}

function hideUnlockSession() {
  const modal = (document.getElementById('unlockModal') as HTMLElement);
  if (!modal) return;
  const generation = ++unlockHideGeneration;
  closeBackdrop(modal);
  const finish = () => {
    if (generation !== unlockHideGeneration) return;
    setUnlockModalError('');
    const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
    if (input) input.value = '';
    if (typeof setUnlockPassphraseRevealed === 'function') setUnlockPassphraseRevealed(false);
    if (typeof setUnlockModalLoading === 'function') setUnlockModalLoading(false);
  };
  if (modal.classList.contains('is-hidden')) {
    finish();
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    modal.removeEventListener('transitionend', onEnd);
    finish();
  };
  const onEnd = (event: TransitionEvent) => {
    if (event.target === modal && event.propertyName === 'opacity') once();
  };
  modal.addEventListener('transitionend', onEnd);
  window.setTimeout(once, 360);
}

function refreshUiFromMemoryStore() {
  applyChatBackground(settings);
  updateGreeting();
  syncAccountProfileUi();
  updateComposerHint();
  syncAgentButton();
  syncResearchControls();
  if (settingsModal && !settingsModal.classList.contains('is-hidden')) {
    fillSettingsFormFromState();
  }
  applyLocationRoute();
  refreshSettingsDataSummary();
}

function clearMemoryAfterLock() {
  if (typeof clearAgentProcessMemory === 'function') clearAgentProcessMemory();
  if (typeof clearComposerDraftMemory === 'function') clearComposerDraftMemory();
  if (typeof clearDiagnosticsMemory === 'function') clearDiagnosticsMemory();
  storageReady = false;
  if (typeof cancelOcrWorkers === 'function') cancelOcrWorkers();
  storageWriteEpoch += 1;
  pendingStoreWrite?.waiters.forEach((done) => done(false));
  pendingStoreWrite = null;
  clearTimeout(saveStoreTimer);
  saveStoreTimer = null;
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = null;
  abortAllStreams({ cancelServer: false });
  activeStreams.clear();
  if (typeof clearTerminalMemory === 'function') clearTerminalMemory();
  if (typeof setTerminalOpen === 'function') setTerminalOpen(false);
  if (typeof stopVoiceInput === 'function') stopVoiceInput({ silent: true });
  if (typeof cancelMessageEdit === 'function') cancelMessageEdit({ resumeQueue: false });
  composerInput.value = '';
  clearPendingAttachments();
  clearPendingReplyQuote();
  composerMentionIds.clear();
  if (typeof setMarkdownImages === 'function') setMarkdownImages(null);
  // Rendered replies are decrypted chat text; drop them with everything else.
  if (typeof clearMarkdownCache === 'function') clearMarkdownCache();
  if (typeof latestState !== 'undefined') latestState = null;
  chatThread.replaceChildren();
  if (typeof traceSidebarBody !== 'undefined') traceSidebarBody?.replaceChildren();
  activeId = null;
  draftWorkspaceRoot = '';
  outboundQueues.clear();
  editingQueueId = null;
  stickByConvo.clear();
  selectedChatModel = '';
  selectedRemoteModelId = '';
  draftModelId = '';
  recentModelIds = [];
  pinnedModelIds = [];
  modelMenuOptions = [];
  modelMenuMatches = [];
  profiles = [];
  activeProfileId = DEFAULT_PROFILE_ID;
  projects = [];
  conversations = [];
  bots = [];
  activeProjectId = null;
  settings = { ...DEFAULT_SETTINGS };
  refreshUiFromMemoryStore();
  promptUnlockSession();
}

async function loadDiskDataAfterUnlock() {
  storageReady = false;
  const store = parseStorePayload(await fetchLocalDataJson('/api/data/store'));
  const rawPrefs = await fetchLocalDataJson('/api/data/preferences');
  const loaded = normalizeLoadedStore(store, rawPrefs);
  adoptLoadedData(loaded);
  storageReady = true;
  showLocalDataLoadError('');
  hydrateModelPickerState();
  restoreOutboundQueues(conversations);
  if (typeof restoreAppSurface === 'function') restoreAppSurface();
  if (typeof loadTraceSplitPrefs === 'function') loadTraceSplitPrefs();
  hideUnlockSession();
  if (typeof pollState === 'function') await pollState();
  refreshUiFromMemoryStore();
}

async function unlockDiskEncryption(passphrase: string, buttonEl: HTMLButtonElement | null) {
  if (buttonEl) buttonEl.disabled = true;
  try {
    await postEncryption('/api/data/encryption/unlock', { passphrase });
    setUnlockModalError('');
    await loadDiskDataAfterUnlock();
    const settingsInput = (document.getElementById('encryptionUnlockPassphrase') as HTMLInputElement);
    if (settingsInput) settingsInput.value = '';
  } finally {
    if (buttonEl) buttonEl.disabled = false;
  }
}

function syncAgentButton() {
  renderPlusMenu();
  renderComposerModes();
  renderComposerMentions();
  syncPlusButton();
}

function syncPlusButton() {
  if (!btnPlus) return;
  btnPlus.classList.remove('is-active');
}

