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
