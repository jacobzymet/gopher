function profileInitials(value: string) {
  const words = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'Y';
  const first = Array.from(words[0])[0] || '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] || '') : '';
  return (first + last).toLocaleUpperCase().slice(0, 2) || 'Y';
}

let profileMenuTransitionTimer: number | null | undefined = null;

function setProfileMenuOpen(open: boolean, { restoreFocus = false } = {}) {
  if (!sidebarProfileMenu || !btnProfileMenu) return;
  const next = !!open && !diskEncryptionLocked();
  clearTimeout(profileMenuTransitionTimer);
  profileMenuTransitionTimer = null;
  btnProfileMenu.setAttribute('aria-expanded', next ? 'true' : 'false');
  if (next) {
    sidebarProfileMenu.classList.remove('is-hidden');
    void sidebarProfileMenu.offsetWidth;
    afterNextPaint(() => {
      if (btnProfileMenu.getAttribute('aria-expanded') === 'true') {
        sidebarProfileMenu.classList.add('is-open');
      }
    });
    return;
  }

  sidebarProfileMenu.classList.remove('is-open');
  if (restoreFocus) btnProfileMenu.focus();
  const finish = () => {
    profileMenuTransitionTimer = null;
    if (btnProfileMenu.getAttribute('aria-expanded') === 'false') {
      sidebarProfileMenu.classList.add('is-hidden');
    }
  };
  if (prefersReducedMotion()) finish();
  else profileMenuTransitionTimer = window.setTimeout(finish, 220);
}

function profileMenuIsOpen() {
  return btnProfileMenu?.getAttribute('aria-expanded') === 'true';
}

function profileSwitchHasActiveWork() {
  if (activeStreams.size) return true;
  if (typeof outboundStarting !== 'undefined' && outboundStarting.size) return true;
  return typeof isBotsOutboundActive === 'function'
    && conversations.some((convo) => isBotsOutboundActive(convo.id));
}

function syncAccountProfileUi() {
  const profile = activeProfile();
  const accountName = String(settings?.name || '').trim() || 'You';
  const profileName = profile?.name || 'Personal';
  if (sidebarAccountName) {
    sidebarAccountName.textContent = accountName;
    applyPrivacyMosaic(sidebarAccountName, 'account-name:' + accountName);
  }
  if (sidebarAccountAvatar) {
    sidebarAccountAvatar.textContent = profileInitials(accountName);
    applyPrivacyMosaic(sidebarAccountAvatar, 'account-avatar:' + accountName, { dense: true });
  }
  if (sidebarActiveProfileName) {
    sidebarActiveProfileName.textContent = profileName;
    applyPrivacyMosaic(sidebarActiveProfileName, 'active-profile:' + (profile?.id || DEFAULT_PROFILE_ID));
  }
  const personalizationTitle = (document.getElementById('personalizationProfileTitle') as HTMLElement);
  if (personalizationTitle) personalizationTitle.textContent = profileName + ' profile';
  if (btnProfileMenu) {
    btnProfileMenu.disabled = diskEncryptionLocked();
    btnProfileMenu.setAttribute(
      'aria-label',
      'Account: ' + accountName + '. Active profile: ' + profileName + '. Switch profile'
    );
  }
  renderSidebarProfileList();
  if (typeof renderProfilesSettingsList === 'function') renderProfilesSettingsList();
}

function renderSidebarProfileList() {
  if (!sidebarProfileList) return;
  sidebarProfileList.replaceChildren();
  profiles.forEach((profile) => {
    const button = (document.createElement('button') as HTMLButtonElement);
    button.type = 'button';
    button.className = 'sidebar-profile-option';
    button.dataset.profileId = profile.id;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', profile.id === activeProfileId ? 'true' : 'false');
    if (profile.id === activeProfileId) button.classList.add('is-active');

    const mark = (document.createElement('span') as HTMLElement);
    mark.className = 'sidebar-profile-option-mark';
    mark.textContent = profileInitials(profile.name);
    applyPrivacyMosaic(mark, 'profile-menu-avatar:' + profile.id, { dense: true });
    const copy = (document.createElement('span') as HTMLElement);
    copy.className = 'sidebar-profile-option-copy';
    const name = (document.createElement('strong') as HTMLElement);
    name.textContent = profile.name;
    applyPrivacyMosaic(name, 'profile-menu-name:' + profile.id);
    const detail = (document.createElement('span') as HTMLElement);
    const chats = profile.conversations.filter((convo) => convo.surface !== 'bots').length;
    const loops = profile.conversations.filter((convo) => convo.surface === 'bots').length;
    detail.textContent = chats + ' chat' + (chats === 1 ? '' : 's')
      + (loops ? ' · ' + loops + ' loop' + (loops === 1 ? '' : 's') : '');
    copy.append(name, detail);
    button.append(mark, copy);
    if (profile.id === activeProfileId) {
      const check = (document.createElement('span') as HTMLElement);
      check.className = 'sidebar-profile-option-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      button.appendChild(check);
    }
    button.addEventListener('click', () => switchProfile(profile.id));
    sidebarProfileList.appendChild(button);
  });
}

function switchProfile(profileId: string) {
  if (!requireUnlockedData()) return false;
  const target = profiles.find((profile) => profile.id === profileId);
  if (!target) return false;
  setProfileMenuOpen(false);
  if (target.id === activeProfileId) return true;
  if (profileSwitchHasActiveWork()) {
    if (typeof showComposerHint === 'function') {
      showComposerHint('Finish or stop active tasks before switching profiles.', { warn: true });
    }
    return false;
  }

  if (
    settingsModal
    && !settingsModal.classList.contains('is-hidden')
    && typeof settingsFormIsDirty === 'function'
    && settingsFormIsDirty()
    && typeof readSettingsForm === 'function'
  ) {
    saveSettings(readSettingsForm(), { immediate: true });
  }

  if (typeof leaveComposerDraft === 'function') leaveComposerDraft();
  syncActiveProfileFromMemory();
  activeProfileId = target.id;
  bindActiveProfile(target);
  settings = settingsForProfile(settings, target);
  restoreOutboundQueues(conversations, { clear: false });
  activeId = null;
  activeProjectId = null;
  draftIncognito = false;
  resetDraftWorkspace();
  if (typeof cancelMessageEdit === 'function') cancelMessageEdit();
  if (typeof closeConvoMenu === 'function') closeConvoMenu();
  if (typeof hydrateModelPickerState === 'function') hydrateModelPickerState();
  if (typeof showChatView === 'function') showChatView();
  if (typeof startDraft === 'function') startDraft({ syncUrl: false });
  applySettingsInMemory(settings);
  saveStore({ immediate: true });
  if (settingsModal && !settingsModal.classList.contains('is-hidden') && typeof fillSettingsFormFromState === 'function') {
    fillSettingsFormFromState();
    if (typeof syncSettingsSaveButton === 'function') syncSettingsSaveButton();
  }
  syncAccountProfileUi();
  if (typeof refreshSettingsDataSummary === 'function') refreshSettingsDataSummary();
  if (typeof syncUrlFromState === 'function') syncUrlFromState({ replace: true });
  return true;
}

/** Best-effort flush when a tab is backgrounded; normal user actions save earlier. */
function flushPendingWrites() {
  if (!storageReady || diskEncryptionLocked()) return;
  if (typeof captureComposerDraft === 'function') {
    const changed = captureComposerDraft();
    clearTimeout(composerDraftTimer);
    composerDraftTimer = null;
    if (changed) saveStore({ immediate: false });
  }
  if (saveStoreTimer) {
    clearTimeout(saveStoreTimer);
    saveStoreTimer = null;
    enqueueStoreWrite(storePayload());
  }
  if (saveSettingsTimer) {
    clearTimeout(saveSettingsTimer);
    saveSettingsTimer = null;
    enqueueSettingsWrite(preferencesPayload());
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingWrites();
});
window.addEventListener('pagehide', flushPendingWrites);

