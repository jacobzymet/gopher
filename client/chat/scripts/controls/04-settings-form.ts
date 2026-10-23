function syncChatBackgroundForm() {
  const source = normalizeChatBackgroundImage(pendingChatBackgroundImage);
  const isLocal = source.startsWith('data:image/');
  const urlInput = (document.getElementById('settingChatBackgroundUrl') as HTMLInputElement);
  const hint = (document.getElementById('chatBackgroundFileHint') as HTMLElement);
  const clearButton = (document.getElementById('btnChatBackgroundClear') as HTMLButtonElement);
  const hasInvalidUrl = !!pendingChatBackgroundImage && !source;
  if (urlInput && document.activeElement !== urlInput) {
    urlInput.value = isLocal ? '' : source;
  }
  if (urlInput) {
    urlInput.setCustomValidity(hasInvalidUrl ? 'Enter a valid http:// or https:// image URL.' : '');
    urlInput.setAttribute('aria-invalid', hasInvalidUrl ? 'true' : 'false');
  }
  if (hint) {
    hint.textContent = hasInvalidUrl
      ? 'Enter a valid URL beginning with http:// or https://.'
      : (isLocal
        ? 'Local image: ' + (pendingChatBackgroundImageName || 'Selected image')
        : 'Enter a remote URL or choose a PNG, JPEG, WebP, GIF, or AVIF file up to 1 MB.');
  }
  if (clearButton) clearButton.disabled = !source && !pendingChatBackgroundImage;
  const positionInput = (document.getElementById('settingChatBackgroundPosition') as HTMLInputElement);
  const position = CHAT_BACKGROUND_POSITIONS.includes(positionInput?.value)
    ? positionInput.value
    : DEFAULT_SETTINGS.chatBackgroundPosition;
  (document.querySelectorAll('[data-background-position]') as NodeListOf<HTMLElement>).forEach((button) => {
    const selected = button.dataset.backgroundPosition === position;
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  });
  const preview = (document.getElementById('chatBackgroundPositionPreview') as HTMLElement);
  const previewImage = (document.getElementById('chatBackgroundPositionImage') as HTMLImageElement);
  if (preview && previewImage) {
    preview.classList.toggle('has-image', !!source);
    previewImage.style.objectPosition = position;
    if (source) previewImage.src = source;
    else previewImage.removeAttribute('src');
  }
  const range = (document.getElementById('settingChatBackgroundOverlay') as HTMLInputElement);
  const output = (document.getElementById('settingChatBackgroundOverlayValue') as HTMLOutputElement);
  if (range && output) {
    output.value = range.value + '%';
    const previewShade = (document.querySelector('.background-position-shade') as HTMLElement);
    if (previewShade) previewShade.style.opacity = String(Number(range.value) / 100);
  }
}

function fillDefaultModelSetting() {
  const select = (document.getElementById('settingDefaultModel') as HTMLSelectElement);
  if (!select) return;
  const options = (typeof modelMenuOptions !== 'undefined' && modelMenuOptions.length)
    ? modelMenuOptions
    : ((latestState?.network?.remote_models || []).map((model) => (
      typeof catalogOptionFromRemote === 'function'
        ? catalogOptionFromRemote(model)
        : {
          value: model.id,
          label: model.model || model.label || model.id,
          provider: String(model.provider_name || '').trim(),
        }
    )));
  const current = String(settings.selectedChatModel || '').trim();
  const previous = select.value;
  select.replaceChildren();
  if (!options.length) {
    select.disabled = true;
    const empty = (document.createElement('option') as HTMLOptionElement);
    empty.value = '';
    empty.textContent = 'No models available yet';
    select.appendChild(empty);
    return;
  }
  select.disabled = false;
  let hasCurrent = false;
  options.forEach((option: { value: string; provider: string; label: string | null; }) => {
    const opt = (document.createElement('option') as HTMLOptionElement);
    opt.value = option.value;
    opt.textContent = option.provider
      ? (option.label + ' · ' + option.provider)
      : option.label;
    if (option.value === current) {
      opt.selected = true;
      hasCurrent = true;
    }
    select.appendChild(opt);
  });
  if (current && !hasCurrent) {
    const opt = (document.createElement('option') as HTMLOptionElement);
    opt.value = current;
    opt.textContent = (typeof modelIdLabel === 'function' ? modelIdLabel(current) : '') || current;
    opt.selected = true;
    select.insertBefore(opt, select.firstChild);
  } else if (!current && select.options.length) {
    select.selectedIndex = 0;
  } else if (!hasCurrent && previous && [...select.options].some((opt) => opt.value === previous)) {
    select.value = previous;
  }
}

let editingProfileId: string | null = null;

function renderProfilesSettingsList() {
  const list = (document.getElementById('profilesSettingsList') as HTMLElement);
  if (!list) return;
  list.replaceChildren();
  profiles.forEach((profile) => {
    const row = (document.createElement('div') as HTMLElement);
    row.className = 'profile-settings-card';
    if (profile.id === activeProfileId) row.classList.add('is-active');

    const mark = (document.createElement('span') as HTMLElement);
    mark.className = 'profile-settings-mark';
    mark.textContent = profileInitials(profile.name);
    applyPrivacyMosaic(mark, 'profile-settings-avatar:' + profile.id, { dense: true });
    const copy = (document.createElement('span') as HTMLElement);
    copy.className = 'profile-settings-copy';
    const title = (document.createElement('strong') as HTMLElement);
    title.textContent = profile.name;
    applyPrivacyMosaic(title, 'profile-settings-name:' + profile.id);
    const meta = (document.createElement('span') as HTMLElement);
    const chatCount = profile.conversations.filter((convo) => convo.surface !== 'bots').length;
    const loopCount = profile.conversations.filter((convo) => convo.surface === 'bots').length;
    const projectCount = profile.projects.length;
    meta.textContent = chatCount + ' chat' + (chatCount === 1 ? '' : 's')
      + ' · ' + loopCount + ' loop' + (loopCount === 1 ? '' : 's')
      + ' · ' + projectCount + ' project' + (projectCount === 1 ? '' : 's');
    copy.append(title, meta);

    const actions = (document.createElement('span') as HTMLElement);
    actions.className = 'profile-settings-actions';
    if (profile.id === activeProfileId) {
      const active = (document.createElement('span') as HTMLElement);
      active.className = 'profile-active-pill';
      active.textContent = 'Active';
      actions.appendChild(active);
    } else {
      const use = (document.createElement('button') as HTMLButtonElement);
      use.type = 'button';
      use.className = 'btn btn-outline';
      use.textContent = 'Switch';
      use.addEventListener('click', () => switchProfile(profile.id));
      actions.appendChild(use);
    }
    const edit = (document.createElement('button') as HTMLButtonElement);
    edit.type = 'button';
    edit.className = 'btn btn-ghost btn-profile-edit';
    edit.textContent = 'Rename';
    edit.addEventListener('click', () => openProfileModal(profile));
    actions.appendChild(edit);
    const remove = (document.createElement('button') as HTMLButtonElement);
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-profile-delete';
    remove.textContent = 'Delete';
    remove.disabled = profiles.length === 1;
    remove.title = profiles.length === 1 ? 'Keep at least one profile' : 'Delete profile';
    remove.addEventListener('click', () => deleteProfile(profile.id));
    actions.appendChild(remove);

    row.append(mark, copy, actions);
    list.appendChild(row);
  });
}

function openProfileModal(profile: Profile | null = null) {
  if (!requireUnlockedData()) return;
  editingProfileId = profile?.id || null;
  const modal = (document.getElementById('profileModal') as HTMLElement);
  const title = (document.getElementById('profileModalTitle') as HTMLElement);
  const lede = (document.getElementById('profileModalLede') as HTMLElement);
  const input = (document.getElementById('profileNameInput') as HTMLInputElement);
  const mark = (document.getElementById('profileModalMark') as HTMLElement);
  const save = (document.getElementById('btnProfileModalSave') as HTMLButtonElement);
  if (!modal || !input) return;
  title.textContent = profile ? 'Rename profile' : 'New profile';
  lede.textContent = profile
    ? 'The profile name only changes how this space appears in the app.'
    : 'Create a separate space for its own chats, projects, Loops, notifications, instructions, and memory.';
  input.value = profile?.name || '';
  input.setCustomValidity('');
  mark.textContent = profileInitials(profile?.name || 'Profile');
  save.textContent = profile ? 'Save name' : 'Create profile';
  openBackdrop(modal);
  requestAnimationFrame(() => input.focus());
}

function closeProfileModal() {
  editingProfileId = null;
  const input = (document.getElementById('profileNameInput') as HTMLInputElement);
  if (input) input.setCustomValidity('');
  closeBackdrop((document.getElementById('profileModal') as HTMLElement));
}

function commitProfileModal() {
  const input = (document.getElementById('profileNameInput') as HTMLInputElement);
  if (!input) return;
  const name = input.value.trim();
  const duplicate = profiles.some((profile) =>
    profile.id !== editingProfileId && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  input.setCustomValidity(!name
    ? 'Enter a profile name.'
    : duplicate ? 'Use a different profile name.' : '');
  if (!input.reportValidity()) return;

  if (editingProfileId) {
    const profile = profiles.find((item) => item.id === editingProfileId);
    if (!profile) return;
    profile.name = name.slice(0, 48);
    profile.updatedAt = Date.now();
    saveStore({ immediate: true });
    closeProfileModal();
    syncAccountProfileUi();
    return;
  }

  const profile = normalizeProfile({ name });
  profiles.push(profile);
  closeProfileModal();
  switchProfile(profile.id);
}

async function deleteProfile(profileId: string) {
  if (profiles.length <= 1 || !requireUnlockedData()) return;
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) return;
  if (profile.id === activeProfileId && profileSwitchHasActiveWork()) {
    showComposerHint('Finish or stop active tasks before deleting this profile.', { warn: true });
    return;
  }
  const itemCount = profile.conversations.length + profile.projects.length + profile.bots.length;
  const ok = await confirmDanger({
    title: 'Delete “' + profile.name + '”?',
    body: itemCount
      ? 'This permanently deletes its chats, Loops, projects, notifications, instructions, and memory.'
      : 'This permanently deletes the profile.',
    confirmLabel: 'Delete profile',
  });
  if (!ok) return;

  profile.conversations.forEach((convo) => {
    if (typeof abortStream === 'function') abortStream(convo.id);
    outboundQueues.delete(convo.id);
    stickByConvo.delete(convo.id);
  });
  const wasActive = profile.id === activeProfileId;
  profiles = profiles.filter((item) => item.id !== profile.id);
  if (wasActive) {
    const next = profiles[0];
    activeProfileId = next.id;
    bindActiveProfile(next);
    settings = settingsForProfile(settings, next);
    restoreOutboundQueues(conversations, { clear: false });
    activeId = null;
    activeProjectId = null;
    if (typeof startDraft === 'function') startDraft();
    applySettingsInMemory(settings);
    if (settingsModal && !settingsModal.classList.contains('is-hidden')) {
      fillSettingsFormFromState();
      syncSettingsSaveButton();
    }
  }
  saveStore({ immediate: true });
  syncAccountProfileUi();
  renderSidebar();
  refreshSettingsDataSummary();
}

function fillSettingsFormFromState() {
  const profileTitle = (document.getElementById('personalizationProfileTitle') as HTMLElement);
  if (profileTitle) profileTitle.textContent = (activeProfile()?.name || 'Personal') + ' profile';
  (document.getElementById('settingName') as HTMLInputElement).value = settings.name;
  (document.getElementById('settingAbout') as HTMLTextAreaElement).value = settings.about;
  (document.getElementById('settingInstructions') as HTMLTextAreaElement).value = settings.instructions;
  (document.getElementById('settingMemory') as HTMLTextAreaElement).value = settings.memory || '';
  (document.getElementById('settingChatRetrieval') as HTMLInputElement).checked = settings.chatRetrieval !== false;
  (document.getElementById('settingThinking') as HTMLSelectElement).value = settings.thinking;
  (document.getElementById('settingThinkingEffort') as HTMLSelectElement).value = settings.thinkingEffort;
  (document.getElementById('settingAutoOpenTraceSidebar') as HTMLInputElement).checked = settings.autoOpenTraceSidebar !== false;
  (document.getElementById('settingEnterSends') as HTMLInputElement).checked = settings.enterSends;
  (document.getElementById('settingDiagnosticsEnabled') as HTMLInputElement).checked = !!settings.diagnosticsEnabled;
  (document.getElementById('settingSkillWebSearch') as HTMLInputElement).checked = settings.skillWebSearch;
  (document.getElementById('settingWebSearchDepth') as HTMLSelectElement).value = settings.webSearchDepth || 'off';
  (document.getElementById('settingWebSearchProvider') as HTMLSelectElement).value = settings.webSearchProvider || 'auto';
  (document.getElementById('settingWebSearchSearxng') as HTMLInputElement).value = settings.webSearchSearxng || '';
  (document.getElementById('settingWebSearchParallelApiKey') as HTMLInputElement).value = settings.webSearchParallelApiKey || '';
  (document.getElementById('settingWebSearchParallelMode') as HTMLSelectElement).value = settings.webSearchParallelMode || 'fast';
  (document.getElementById('settingWebSearchTinyfishApiKey') as HTMLInputElement).value = settings.webSearchTinyfishApiKey || '';
  (document.getElementById('settingWebSearchResults') as HTMLInputElement).value = String(settings.webSearchResults || 6);
  (document.getElementById('settingWebSearchRegion') as HTMLInputElement).value = settings.webSearchRegion || 'us-en';
  (document.getElementById('settingWebSearchSafeSearch') as HTMLSelectElement).value = settings.webSearchSafeSearch || 'moderate';
  (document.getElementById('settingWebSearchRecency') as HTMLSelectElement).value = settings.webSearchRecency || 'any';
  (document.getElementById('settingSkillFetchUrl') as HTMLInputElement).checked = settings.skillFetchUrl;
  (document.getElementById('settingFetchUrlMaxChars') as HTMLInputElement).value = String(settings.fetchUrlMaxChars || 8000);
  (document.getElementById('settingWebSearchPageMaxChars') as HTMLInputElement).value = String(
    Number.isFinite(settings.webSearchPageMaxChars) ? settings.webSearchPageMaxChars : 0
  );
  (document.getElementById('settingSkillDeepResearch') as HTMLInputElement).checked = settings.skillDeepResearch !== false;
  (document.getElementById('settingSkillFilesystem') as HTMLInputElement).checked = !!settings.skillFilesystem;
  (document.getElementById('settingSkillTerminal') as HTMLInputElement).checked = !!settings.skillTerminal;
  (document.getElementById('settingSkillBrowser') as HTMLInputElement).checked = !!settings.skillBrowser;
  (document.getElementById('settingTerminalTimeout') as HTMLInputElement).value = String(settings.terminalTimeoutSecs || 30);
  syncApprovalModeControls();
  syncTerminalSkillControls();
  (document.getElementById('settingAttachmentsMode') as HTMLSelectElement).value = settings.attachmentsMode || 'auto';
  (document.getElementById('settingAttachmentTextFallback') as HTMLInputElement).checked = !!settings.attachmentTextFallback;
  (document.getElementById('settingAttachmentOcr') as HTMLInputElement).checked = !!settings.attachmentOcr;
  (document.getElementById('settingAttachmentMaxChars') as HTMLInputElement).value = String(settings.attachmentMaxChars || 48000);
  pendingChatBackgroundImage = settings.chatBackgroundImage || '';
  pendingChatBackgroundImageName = settings.chatBackgroundImageName || '';
  (document.getElementById('settingChatBackgroundPosition') as HTMLInputElement).value = settings.chatBackgroundPosition || 'center';
  (document.getElementById('settingChatBackgroundOverlay') as HTMLInputElement).value = String(settings.chatBackgroundOverlay ?? 72);
  syncChatBackgroundForm();
  syncWebSearchControls();
  syncFetchUrlControls();
  syncTerminalSkillControls();
  syncAttachmentFallbackControls();
  fillDefaultModelSetting();
}

function readSettingsForm() {
  const maxCharsRaw = Number((document.getElementById('settingAttachmentMaxChars') as HTMLInputElement).value);
  const fetchUrlMaxCharsRaw = Number((document.getElementById('settingFetchUrlMaxChars') as HTMLInputElement).value);
  const webSearchPageMaxCharsRaw = Number((document.getElementById('settingWebSearchPageMaxChars') as HTMLInputElement).value);
  const searchResultsRaw = Number((document.getElementById('settingWebSearchResults') as HTMLInputElement).value);
  const searchRegionRaw = (document.getElementById('settingWebSearchRegion') as HTMLInputElement).value.trim().toLowerCase();
  const defaultModel = String((document.getElementById('settingDefaultModel') as HTMLSelectElement)?.value || '').trim();
  return normalizeSettings({
    ...settings,
    name: (document.getElementById('settingName') as HTMLInputElement).value.trim(),
    about: (document.getElementById('settingAbout') as HTMLTextAreaElement).value,
    instructions: (document.getElementById('settingInstructions') as HTMLTextAreaElement).value,
    memory: (document.getElementById('settingMemory') as HTMLTextAreaElement).value,
    chatRetrieval: (document.getElementById('settingChatRetrieval') as HTMLInputElement).checked,
    thinking: (document.getElementById('settingThinking') as HTMLSelectElement).value,
    thinkingEffort: (document.getElementById('settingThinkingEffort') as HTMLSelectElement).value,
    autoOpenTraceSidebar: (document.getElementById('settingAutoOpenTraceSidebar') as HTMLInputElement).checked,
    enterSends: (document.getElementById('settingEnterSends') as HTMLInputElement).checked,
    skillWebSearch: (document.getElementById('settingSkillWebSearch') as HTMLInputElement).checked,
    webSearchDepth: (document.getElementById('settingWebSearchDepth') as HTMLSelectElement).value,
    webSearchProvider: (document.getElementById('settingWebSearchProvider') as HTMLSelectElement).value,
    webSearchSearxng: (document.getElementById('settingWebSearchSearxng') as HTMLInputElement).value.trim(),
    webSearchParallelApiKey: (document.getElementById('settingWebSearchParallelApiKey') as HTMLInputElement).value.trim(),
    webSearchParallelMode: (document.getElementById('settingWebSearchParallelMode') as HTMLSelectElement).value,
    webSearchTinyfishApiKey: (document.getElementById('settingWebSearchTinyfishApiKey') as HTMLInputElement).value.trim(),
    webSearchResults: searchResultsRaw,
    webSearchRegion: searchRegionRaw,
    webSearchSafeSearch: (document.getElementById('settingWebSearchSafeSearch') as HTMLSelectElement).value,
    webSearchRecency: (document.getElementById('settingWebSearchRecency') as HTMLSelectElement).value,
    skillFetchUrl: (document.getElementById('settingSkillFetchUrl') as HTMLInputElement).checked,
    fetchUrlMaxChars: fetchUrlMaxCharsRaw,
    webSearchPageMaxChars: webSearchPageMaxCharsRaw,
    skillDeepResearch: (document.getElementById('settingSkillDeepResearch') as HTMLInputElement).checked,
    skillFilesystem: (document.getElementById('settingSkillFilesystem') as HTMLInputElement).checked,
    skillTerminal: (document.getElementById('settingSkillTerminal') as HTMLInputElement).checked,
    skillBrowser: (document.getElementById('settingSkillBrowser') as HTMLInputElement).checked,
    terminalTimeoutSecs: Number((document.getElementById('settingTerminalTimeout') as HTMLInputElement).value),
    diagnosticsEnabled: !!(document.getElementById('settingDiagnosticsEnabled') as HTMLInputElement)?.checked,
    approvalMode: (document.querySelector('#approvalModeToggle [data-approval-mode].is-active') as HTMLElement)?.dataset.approvalMode
      || settings.approvalMode
      || DEFAULT_SETTINGS.approvalMode,
    agentMode: settings.agentMode,
    deepResearch: settings.deepResearch,
    attachmentsMode: (document.getElementById('settingAttachmentsMode') as HTMLSelectElement).value,
    attachmentTextFallback: (document.getElementById('settingAttachmentTextFallback') as HTMLInputElement).checked,
    attachmentOcr: (document.getElementById('settingAttachmentOcr') as HTMLInputElement).checked,
    attachmentMaxChars: maxCharsRaw,
    chatBackgroundImage: pendingChatBackgroundImage,
    chatBackgroundImageName: pendingChatBackgroundImageName,
    chatBackgroundPosition: (document.getElementById('settingChatBackgroundPosition') as HTMLInputElement).value,
    chatBackgroundOverlay: Number((document.getElementById('settingChatBackgroundOverlay') as HTMLInputElement).value),
    selectedChatModel: defaultModel || settings.selectedChatModel || '',
  });
}

function settingsFormIsDirty() {
  const invalidBackgroundUrl = !!pendingChatBackgroundImage
    && !normalizeChatBackgroundImage(pendingChatBackgroundImage);
  return invalidBackgroundUrl
    || JSON.stringify(readSettingsForm()) !== JSON.stringify(normalizeSettings(settings));
}

function syncSettingsSaveButton({ saved = false, saving = false, failed = false } = {}) {
  const btn = (document.getElementById('btnSettingsSave') as HTMLButtonElement);
  const label = (document.getElementById('btnSettingsSaveLabel') as HTMLElement);
  if (!btn || !label) return;
  const check = (btn.querySelector('.settings-save-check') as HTMLElement);
  const dirty = settingsFormIsDirty();
  const mode = saving ? 'saving'
    : failed ? 'failed'
      : (saved && !dirty) ? 'saved'
        : dirty ? 'dirty' : 'idle';
  if (btn.dataset.saveMode === mode) return;
  btn.dataset.saveMode = mode;

  btn.classList.toggle('is-saved', mode === 'saved');
  check?.classList.toggle('is-hidden', mode !== 'saved');
  btn.disabled = mode === 'saving' || mode === 'saved' || mode === 'idle';
  if (mode === 'saving') {
    label.textContent = 'Saving…';
    btn.setAttribute('aria-label', 'Saving settings');
    return;
  }
  if (mode === 'failed') {
    label.textContent = 'Retry save';
    btn.setAttribute('aria-label', 'Settings could not be saved; retry');
    return;
  }
  if (mode === 'saved') {
    label.textContent = 'Saved';
    btn.setAttribute('aria-label', 'Settings saved');
    return;
  }
  label.textContent = 'Save';
  btn.setAttribute('aria-label', dirty ? 'Save settings' : 'No changes to save');
}

