function openSettings(pane = 'personalization') {
  fillSettingsFormFromState();
  renderProfilesSettingsList();
  setCapabilityAdvancedOpen(
    (document.getElementById('btnWebSearchAdvanced') as HTMLButtonElement),
    (document.getElementById('webSearchOptions') as HTMLElement),
    false
  );
  setCapabilityAdvancedOpen(
    (document.getElementById('btnFetchUrlAdvanced') as HTMLButtonElement),
    (document.getElementById('fetchUrlOptions') as HTMLElement),
    false
  );
  refreshLocalDataPane();
  showSettingsPane(pane);
  openBackdrop(settingsModal);
  syncSettingsSaveButton();
  if (pane === 'personalization') (document.getElementById('settingName') as HTMLInputElement).focus();
  else (document.querySelector(`.settings-nav-btn[data-settings-pane="${pane}"]`) as HTMLElement)?.focus();
  loadUserSkills();
}

function setCapabilityAdvancedOpen(toggle: HTMLButtonElement, panel: HTMLElement, open: boolean) {
  if (!toggle || !panel) return;
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  panel.classList.toggle('is-collapsed', !open);
  panel.hidden = !open;
}

function syncWebSearchControls() {
  const enabled = (document.getElementById('settingSkillWebSearch') as HTMLInputElement).checked;
  const options = (document.getElementById('webSearchOptions') as HTMLElement);
  const toggle = (document.getElementById('btnWebSearchAdvanced') as HTMLButtonElement);
  const provider = (document.getElementById('settingWebSearchProvider') as HTMLSelectElement)?.value || 'auto';
  const parallelKey = ((document.getElementById('settingWebSearchParallelApiKey') as HTMLInputElement)?.value || '').trim();
  const depth = (document.getElementById('settingWebSearchDepth') as HTMLSelectElement)?.value || 'off';
  const moreToggle = (document.getElementById('btnWebSearchMore') as HTMLButtonElement);
  if (toggle) toggle.disabled = !enabled;
  if (moreToggle) moreToggle.disabled = !enabled;
  if (!options) return;
  (options.querySelectorAll('input, select') as NodeListOf<HTMLSelectElement>).forEach((control) => {
    control.disabled = !enabled;
  });
  (options.querySelectorAll('[data-web-search-provider]') as NodeListOf<HTMLElement>).forEach((el) => {
    const tokens = String(el.dataset.webSearchProvider || '')
      .split(/\s+/)
      .filter(Boolean);
    el.hidden = !tokens.includes(provider);
  });
  (options.querySelectorAll('[data-web-search-when]') as NodeListOf<HTMLElement>).forEach((el) => {
    if (el.hidden) return;
    const when = el.dataset.webSearchWhen;
    if (when === 'parallel-keyed') {
      el.hidden = provider !== 'parallel' || !parallelKey;
    } else if (when === 'safesearch') {
      el.hidden = provider === 'parallel' || provider === 'tinyfish';
    } else if (when === 'page-chars') {
      el.hidden = depth === 'off';
    }
  });
  options.style.opacity = enabled ? '' : '0.55';
}

function syncFetchUrlControls() {
  const enabled = (document.getElementById('settingSkillFetchUrl') as HTMLInputElement).checked;
  const options = (document.getElementById('fetchUrlOptions') as HTMLElement);
  const toggle = (document.getElementById('btnFetchUrlAdvanced') as HTMLButtonElement);
  if (toggle) toggle.disabled = !enabled;
  if (!options) return;
  (options.querySelectorAll('input, select') as NodeListOf<HTMLSelectElement>).forEach((control) => {
    control.disabled = !enabled;
  });
  options.style.opacity = enabled ? '' : '0.55';
}

function syncTerminalSkillControls() {
  const enabled = (document.getElementById('settingSkillTerminal') as HTMLInputElement).checked;
  const options = (document.getElementById('terminalOptions') as HTMLElement);
  const toggle = (document.getElementById('btnTerminalAdvanced') as HTMLButtonElement);
  if (toggle) toggle.disabled = !enabled;
  if (!options) return;
  (options.querySelectorAll('input, select') as NodeListOf<HTMLSelectElement>).forEach((control) => {
    control.disabled = !enabled;
  });
  options.style.opacity = enabled ? '' : '0.55';
}

function syncApprovalModeControls() {
  const mode = APPROVAL_MODES.includes(settings.approvalMode)
    ? settings.approvalMode
    : DEFAULT_SETTINGS.approvalMode;
  (document.querySelectorAll('#approvalModeToggle [data-approval-mode]') as NodeListOf<HTMLElement>).forEach((btn) => {
    const on = btn.dataset.approvalMode === mode;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function syncAttachmentFallbackControls() {
  const fallback = (document.getElementById('settingAttachmentTextFallback') as HTMLInputElement);
  const ocr = (document.getElementById('settingAttachmentOcr') as HTMLInputElement);
  const maxChars = (document.getElementById('settingAttachmentMaxChars') as HTMLInputElement);
  const enabled = !!(fallback && fallback.checked);
  if (ocr) ocr.disabled = !enabled;
  if (maxChars) maxChars.disabled = !enabled;
  if (ocr) (ocr.closest('.field-check') as HTMLElement).style.opacity = enabled ? '' : '0.55';
  if (maxChars) {
    const row = (maxChars.closest('.settings-row') as HTMLElement);
    if (row) row.style.opacity = enabled ? '' : '0.55';
  }
}

function closeSettings() {
  if (typeof setProviderSettingsActive === 'function') setProviderSettingsActive(false);
  closeBackdrop(settingsModal);
  hideSkillEditor();
}

function showSkillsError(error: unknown) {
  const el = (document.getElementById('skillsError') as HTMLElement);
  if (!el) return;
  el.textContent = (error as Error)?.message || String(error || '');
  el.classList.toggle('is-hidden', !el.textContent);
}

function hideSkillEditor() {
  const editor = (document.getElementById('skillEditor') as HTMLElement);
  if (!editor) return;
  editor.classList.add('is-hidden');
  (document.getElementById('skillEditId') as HTMLInputElement).value = '';
  showSkillsError('');
}

function openSkillEditor(skill?: Partial<UserSkill>) {
  const editor = (document.getElementById('skillEditor') as HTMLElement);
  editor.classList.remove('is-hidden');
  (document.getElementById('skillEditorTitle') as HTMLElement).textContent = skill?.id ? 'Edit skill' : 'New skill';
  (document.getElementById('skillEditId') as HTMLInputElement).value = skill?.id || '';
  (document.getElementById('skillEditName') as HTMLInputElement).value = skill?.name || '';
  (document.getElementById('skillEditDescription') as HTMLInputElement).value = skill?.description || '';
  (document.getElementById('skillEditContent') as HTMLTextAreaElement).value = skill?.content || '';
  (document.getElementById('skillEditEnabled') as HTMLInputElement).checked = skill?.enabled !== false;
  showSkillsError('');
  (document.getElementById('skillEditName') as HTMLInputElement).focus();
  editor.scrollIntoView({ block: 'nearest' });
}

function renderUserSkills() {
  const list = (document.getElementById('skillsList') as HTMLElement);
  const empty = (document.getElementById('skillsEmpty') as HTMLElement);
  if (!list || !empty) return;
  empty.classList.toggle('is-hidden', userSkills.length > 0);
  list.innerHTML = userSkills.map((skill) => `
    <li data-skill-id="${escapeHtml(skill.id)}">
      <div class="skill-head">
        <div>
          <div class="skill-title">${escapeHtml(skill.name)}</div>
          <p class="skill-desc">${escapeHtml(skill.description || 'No description')}</p>
        </div>
        <label class="field-check" style="margin:0">
          <input type="checkbox" data-skill-enabled ${skill.enabled ? 'checked' : ''}>
          <span style="font-size:var(--text-xs)">On</span>
        </label>
      </div>
      <div class="skill-meta">${skill.content_chars || 0} chars${skill.source_filename ? ' · ' + escapeHtml(skill.source_filename) : ''}</div>
      <div class="skill-actions">
        <button type="button" class="btn btn-outline" data-skill-edit>Edit</button>
        <button type="button" class="btn btn-outline" data-skill-delete>Delete</button>
      </div>
    </li>
  `).join('');
}

async function loadUserSkills() {
  try {
    const data = await fetch('/api/skills').then(async (response) => {
      const body: SkillApiResult = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Could not load skills');
      return body;
    });
    userSkills = data.skills || [];
    renderUserSkills();
  } catch (error) {
    userSkills = [];
    renderUserSkills();
    showSkillsError(error);
  }
}

async function withBusyControl<T>(el: HTMLButtonElement, busyLabel: string | null, work: () => Promise<T>, opts: { restore?: boolean } = {}) {
  if (!el || el.dataset.busy === '1') return;
  const restore = opts.restore !== false;
  const prevText = el.textContent;
  const prevDisabled = el.disabled;
  el.dataset.busy = '1';
  el.disabled = true;
  if (busyLabel != null) el.textContent = busyLabel;
  el.setAttribute('aria-busy', 'true');
  try {
    return await work();
  } finally {
    if (!el.isConnected) return;
    delete el.dataset.busy;
    el.removeAttribute('aria-busy');
    el.disabled = prevDisabled;
    if (busyLabel != null && restore) el.textContent = prevText;
  }
}

async function saveSkillFromEditor() {
  const id = (document.getElementById('skillEditId') as HTMLInputElement).value.trim();
  const payload = {
    name: (document.getElementById('skillEditName') as HTMLInputElement).value.trim(),
    description: (document.getElementById('skillEditDescription') as HTMLInputElement).value.trim(),
    content: (document.getElementById('skillEditContent') as HTMLTextAreaElement).value,
    enabled: (document.getElementById('skillEditEnabled') as HTMLInputElement).checked,
  };
  const btn = (document.getElementById('btnSkillSave') as HTMLButtonElement);
  await withBusyControl(btn, 'Saving…', async () => {
    try {
      showSkillsError('');
      const response = await fetch(id ? '/api/skills/' + encodeURIComponent(id) : '/api/skills', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body: SkillApiResult = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Could not save skill');
      hideSkillEditor();
      await loadUserSkills();
    } catch (error) {
      showSkillsError(error);
    }
  });
}

async function importSkillFile(file: File) {
  const content = await file.text();
  const response = await fetch('/api/skills/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, filename: file.name }),
  });
  const body: SkillApiResult = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Could not import skill');
  await loadUserSkills();
  openSkillEditor(body);
}

let thinkMenuCloseTimer = 0;

