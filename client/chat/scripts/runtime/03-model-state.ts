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

