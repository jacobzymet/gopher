function loopModelOptions() {
  if (typeof modelMenuOptions !== 'undefined' && Array.isArray(modelMenuOptions) && modelMenuOptions.length) {
    return modelMenuOptions;
  }
  const models = latestState?.network?.remote_models || [];
  if (typeof catalogOptionFromRemote === 'function') return models.map(catalogOptionFromRemote);
  return models.map((model) => ({
    value: model.id,
    label: model.model || model.label || model.id,
    provider: String(model.provider_name || '').trim(),
  }));
}

function loopAgentModelLabel(bot: Pick<Bot,"model"> | null | undefined) {
  const id = typeof bot?.model === 'string' ? bot.model : '';
  if (!id) return '';
  const option = loopModelOptions().find((item) => item.value === id);
  if (option) {
    return option.provider ? (option.label + ' · ' + option.provider) : option.label;
  }
  return typeof modelIdLabel === 'function' ? (modelIdLabel(id) || id) : id;
}

function defaultLoopModelId(index: number) {
  const options = loopModelOptions();
  const preferred = [];
  if (typeof recentModelIds !== 'undefined' && Array.isArray(recentModelIds)) preferred.push(...recentModelIds);
  if (typeof pinnedModelIds !== 'undefined' && Array.isArray(pinnedModelIds)) preferred.push(...pinnedModelIds);
  if (typeof selectedChatModel === 'string' && selectedChatModel) preferred.push(selectedChatModel);
  const unique = [...new Set(preferred)].filter((id) => options.some((item) => item.value === id));
  if (unique.length) return unique[index % unique.length];
  if (options.length) return options[index % options.length].value;
  return '';
}

function loopRolePreset(index: number) {
  return LOOP_ROLE_PRESETS[index] || {
    handle: 'agent' + (index + 1),
    stage: 'explore',
    description: 'Independent take on the same problem.',
  };
}

function createLoopStageSelect(value: string, ariaLabel: string, className = '') {
  const select = (document.createElement('select') as HTMLSelectElement);
  select.className = ('loop-stage-select' + (className ? ' ' + className : '')).trim();
  select.setAttribute('aria-label', ariaLabel);
  [
    ['auto', 'Auto stage'],
    ['explore', 'Explore'],
    ['challenge', 'Challenge'],
    ['answer', 'Answer'],
  ].forEach(([id, label]) => {
    const option = (document.createElement('option') as HTMLOptionElement);
    option.value = id;
    option.textContent = label;
    select.appendChild(option);
  });
  select.value = ['auto', 'explore', 'challenge', 'answer'].includes(value) ? value : 'auto';
  return select;
}

function uniqueLoopHandle(used: Set<string>, raw: string, fallbackIndex: number) {
  const base = BOT_HANDLE_RE.test(normalizeHandle(raw))
    ? normalizeHandle(raw)
    : normalizeHandle(loopRolePreset(fallbackIndex).handle);
  let handle = base || ('agent' + (fallbackIndex + 1));
  let n = 2;
  while (used.has(handle)) {
    handle = (base || 'agent').slice(0, 28) + n;
    n += 1;
  }
  used.add(handle);
  return handle;
}

function loopModelTriggerLabel(modelId: string | null | undefined) {
  const options = loopModelOptions();
  const current = String(modelId || '').trim();
  if (!options.length) return 'No models yet';
  const resolved = (typeof resolveSavedModelId === 'function'
    ? resolveSavedModelId(current, options)
    : current) || defaultLoopModelId(0);
  const option = options.find((item) => item.value === resolved);
  if (option) return option.label;
  if (current) return (typeof modelIdLabel === 'function' ? modelIdLabel(current) : current) || 'Pick a model';
  return 'Pick a model';
}

function paintLoopModelPickerButton(btn: HTMLElement, modelId: string) {
  if (!btn) return;
  const label = loopModelTriggerLabel(modelId);
  const text = (btn.querySelector('.loop-model-picker-label') as HTMLElement);
  if (text) text.textContent = label;
  else btn.textContent = label;
  const title = loopAgentModelLabel({ model: modelId }) || label;
  if (typeof setIdentityTitle === 'function') setIdentityTitle(btn, title);
  else btn.title = title;
}

function paintLoopModelPickerButtons() {
  (document.querySelectorAll('.loop-model-picker') as NodeListOf<HTMLElement>).forEach((wrap) => {
    const hidden = (wrap.querySelector('.loop-agent-model, .trace-member-model') as HTMLInputElement);
    const btn = (wrap.querySelector('.loop-model-picker-btn') as HTMLButtonElement);
    if (!hidden || !btn) return;
    if (!hidden.value) hidden.value = defaultLoopModelId(0);
    paintLoopModelPickerButton(btn, hidden.value);
    btn.disabled = !loopModelOptions().length;
  });
}

function createLoopModelPicker(initialId: string, { ariaLabel, className = '', hiddenClass, onPick }: LoopModelPickerOptions = {}) {
  const wrap = (document.createElement('div') as HTMLElement);
  wrap.className = ('loop-model-picker' + (className ? ' ' + className : '')).trim();
  const btn = (document.createElement('button') as HTMLButtonElement);
  btn.type = 'button';
  btn.className = 'loop-model-picker-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', ariaLabel || 'Model');
  const label = (document.createElement('span') as HTMLElement);
  label.className = 'loop-model-picker-label';
  btn.appendChild(label);
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  caret.setAttribute('class', 'loop-model-picker-caret');
  caret.setAttribute('viewBox', '0 0 24 24');
  caret.setAttribute('fill', 'none');
  caret.setAttribute('stroke', 'currentColor');
  caret.setAttribute('stroke-width', '2.25');
  caret.setAttribute('stroke-linecap', 'round');
  caret.setAttribute('stroke-linejoin', 'round');
  caret.setAttribute('aria-hidden', 'true');
  const caretPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  caretPath.setAttribute('d', 'm6 9 6 6 6-6');
  caret.appendChild(caretPath);
  btn.appendChild(caret);
  const hidden = (document.createElement('input') as HTMLInputElement);
  hidden.type = 'hidden';
  hidden.className = hiddenClass || 'loop-agent-model';
  hidden.value = String(initialId || '').trim();
  if (!hidden.value) hidden.value = defaultLoopModelId(0);
  paintLoopModelPickerButton(btn, hidden.value);
  btn.disabled = !loopModelOptions().length;
  const openPicker = () => {
    if (typeof openModelMenu !== 'function') return;
    const open = typeof modelMenuIsOpen === 'function' && modelMenuIsOpen();
    if (open && modelMenuContext && modelMenuContext.trigger === btn) {
      closeModelMenu({ restoreFocus: true });
      return;
    }
    openModelMenu({
      anchor: wrap,
      trigger: btn,
      selectedId: hidden.value,
      onPick: (value: string) => {
        hidden.value = value;
        paintLoopModelPickerButton(btn, value);
        if (typeof onPick === 'function') onPick(value);
      },
    });
  };
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPicker();
  });
  btn.addEventListener('keydown', (event) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && typeof modelMenuIsOpen === 'function' && !modelMenuIsOpen()) {
      event.preventDefault();
      openPicker();
      return;
    }
    if (typeof handleModelMenuKeydown === 'function') handleModelMenuKeydown(event);
  });
  wrap.appendChild(btn);
  wrap.appendChild(hidden);
  return wrap;
}

function createBotSession(bot: Bot, { group = false, title = '', participantIds = [], loopAgents = [] }: BotSessionOptions = {}): Conversation {
  const agents = Array.isArray(loopAgents) && loopAgents.length
    ? loopAgents.map(normalizeBot)
    : [];
  const ids = agents.length
    ? agents.map((item) => item.id)
    : participantIds.slice();
  const convo = {
    id: newId('c'),
    title: title || botDisplayHandle(bot),
    titleEdited: !group,
    messages: [],
    updatedAt: Date.now(),
    projectId: null,
    sortOrder: nextTopSortOrder(null),
    incognito: false,
    pinned: false,
    pinnedAt: null,
    surface: 'bots',
    botKind: group ? 'group' : 'dm',
    botId: group ? null : bot.id,
    participantBotIds: group ? ids : (bot ? [bot.id] : []),
    loopAgents: group ? agents : [],
    groupMemory: '',
    botsHeldBy: null,
    loopRun: null,
    sideThreadOf: null,
    workspaceRoot: '',
  };
  conversations.push(convo);
  return convo;
}

let editingGroupId: string | null = null;
let loopDraftAgents: Bot[] = [];

function setGroupModalError(msg: string) {
  const err = (document.getElementById('groupModalError') as HTMLElement);
  if (!err) return;
  err.textContent = msg || '';
  err.classList.toggle('is-hidden', !msg);
}

function syncLoopCountChrome() {
  const label = (document.getElementById('loopCountLabel') as HTMLElement);
  const down = (document.getElementById('btnLoopCountDown') as HTMLButtonElement);
  const up = (document.getElementById('btnLoopCountUp') as HTMLButtonElement);
  if (label) label.textContent = String(loopDraftAgents.length);
  if (down) down.disabled = loopDraftAgents.length <= LOOP_AGENT_MIN;
  if (up) up.disabled = loopDraftAgents.length >= LOOP_AGENT_MAX;
}

function readLoopAgentRows() {
  const host = (document.getElementById('loopAgentRows') as HTMLElement);
  if (!host) return loopDraftAgents;
  const rows: HTMLElement[] = [...(host.querySelectorAll('.loop-agent-row') as NodeListOf<HTMLElement>)];
  loopDraftAgents = rows.map((row, index) => {
    const prev = loopDraftAgents[index] || {};
    const handle = normalizeHandle((row.querySelector('.loop-agent-handle') as HTMLInputElement)?.value)
      || prev.handle
      || loopRolePreset(index).handle;
    return normalizeBot({
      ...prev,
      id: prev.id || newId('b'),
      handle,
      name: '@' + handle,
      description: String((row.querySelector('.loop-agent-role') as HTMLTextAreaElement)?.value || '').trim(),
      model: String((row.querySelector('.loop-agent-model') as HTMLInputElement)?.value || '').trim(),
      stage: String((row.querySelector('.loop-stage-select') as HTMLSelectElement)?.value || 'auto'),
      avatarSeed: handle,
    });
  });
  return loopDraftAgents;
}

function renderLoopAgentRows() {
  const host = (document.getElementById('loopAgentRows') as HTMLElement);
  if (!host) return;
  if (typeof closeModelMenu === 'function' && typeof modelMenuIsOpen === 'function' && modelMenuIsOpen()) {
    const anchor = typeof modelMenuAnchorEl === 'function' ? modelMenuAnchorEl() : null;
    if (anchor && host.contains(anchor)) closeModelMenu();
  }
  host.innerHTML = '';
  loopDraftAgents.forEach((agent, index) => {
    const row = (document.createElement('div') as HTMLElement);
    row.className = 'loop-agent-row';
    row.appendChild(createBotAvatarEl(agent, { className: 'loop-agent-avatar' }));
    const body = (document.createElement('div') as HTMLElement);
    body.className = 'loop-agent-body';
    const top = (document.createElement('div') as HTMLElement);
    top.className = 'loop-agent-top';
    const prefix = (document.createElement('label') as HTMLElement);
    prefix.className = 'field-prefix loop-agent-handle-wrap';
    const at = (document.createElement('span') as HTMLElement);
    at.textContent = '@';
    const handle = (document.createElement('input') as HTMLInputElement);
    handle.className = 'field-input loop-agent-handle';
    handle.type = 'text';
    handle.maxLength = 32;
    handle.autocomplete = 'off';
    handle.spellcheck = false;
    handle.placeholder = loopRolePreset(index).handle;
    handle.value = agent.handle || '';
    handle.setAttribute('aria-label', 'Agent ' + (index + 1) + ' handle');
    prefix.appendChild(at);
    prefix.appendChild(handle);
    const model = createLoopModelPicker(agent.model, {
      ariaLabel: 'Agent ' + (index + 1) + ' model',
      hiddenClass: 'loop-agent-model',
      onPick: (value) => {
        agent.model = value;
      },
    });
    const stage = createLoopStageSelect(
      agent.stage || loopRolePreset(index).stage || 'auto',
      'Stage for agent ' + (index + 1)
    );
    top.appendChild(prefix);
    top.appendChild(model);
    top.appendChild(stage);
    const role = (document.createElement('textarea') as HTMLTextAreaElement);
    role.className = 'field-textarea loop-agent-role';
    role.rows = 2;
    role.maxLength = 400;
    role.placeholder = loopRolePreset(index).description;
    role.value = agent.description || '';
    role.setAttribute('aria-label', 'Agent ' + (index + 1) + ' description');
    body.appendChild(top);
    body.appendChild(role);
    row.appendChild(body);
    if (loopDraftAgents.length > LOOP_AGENT_MIN) {
      const remove = (document.createElement('button') as HTMLButtonElement);
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-icon loop-agent-remove';
      remove.setAttribute('aria-label', 'Remove @' + (agent.handle || 'agent'));
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        readLoopAgentRows();
        if (loopDraftAgents.length <= LOOP_AGENT_MIN) return;
        loopDraftAgents.splice(index, 1);
        renderLoopAgentRows();
        syncLoopCountChrome();
      });
      row.appendChild(remove);
    }
    host.appendChild(row);
  });
  syncLoopCountChrome();
}

function setLoopDraftCount(next: number) {
  readLoopAgentRows();
  const count = Math.min(LOOP_AGENT_MAX, Math.max(LOOP_AGENT_MIN, Number(next) || LOOP_AGENT_MIN));
  while (loopDraftAgents.length < count) {
    const index = loopDraftAgents.length;
    const preset = loopRolePreset(index);
    const used = new Set(loopDraftAgents.map((agent) => agent.handle));
    const handle = uniqueLoopHandle(used, preset.handle, index);
    loopDraftAgents.push(normalizeBot({
      id: newId('b'),
      handle,
      name: '@' + handle,
      description: preset.description,
      stage: preset.stage,
      model: defaultLoopModelId(index),
      avatarSeed: handle,
    }));
  }
  if (loopDraftAgents.length > count) loopDraftAgents = loopDraftAgents.slice(0, count);
  renderLoopAgentRows();
}

function openGroupDialog(convo: Conversation | null | undefined) {
  editingGroupId = convo ? convo.id : null;
  const modal = (document.getElementById('groupModal') as HTMLElement);
  const title = (document.getElementById('groupModalTitle') as HTMLElement);
  const name = (document.getElementById('groupName') as HTMLInputElement);
  const save = (document.getElementById('btnGroupSave') as HTMLButtonElement);
  if (!modal) return;
  if (title) title.textContent = convo ? 'Edit loop' : 'New loop';
  if (save) save.textContent = convo ? 'Save loop' : 'Create loop';
  if (name) name.value = convo ? (convo.title || '') : '';
  setGroupModalError('');
  if (convo) {
    const members = ensureLoopAgents(convo);
    loopDraftAgents = members.map((bot) => normalizeBot({ ...bot }));
    if (loopDraftAgents.length < LOOP_AGENT_MIN) setLoopDraftCount(LOOP_AGENT_MIN);
    else renderLoopAgentRows();
  } else {
    loopDraftAgents = [];
    const host = (document.getElementById('loopAgentRows') as HTMLElement);
    if (host) host.innerHTML = '';
    setLoopDraftCount(3);
  }
  openBackdrop(modal);
  queueMicrotask(() => name && name.focus());
}

function closeGroupDialog() {
  if (typeof closeModelMenu === 'function') closeModelMenu();
  closeBackdrop((document.getElementById('groupModal') as HTMLElement));
  editingGroupId = null;
  loopDraftAgents = [];
}

function saveGroupFromDialog() {
  if (!requireUnlockedData()) return;
  readLoopAgentRows();
  if (loopDraftAgents.length < LOOP_AGENT_MIN) {
    setGroupModalError('A loop needs at least two agents.');
    return;
  }
  const seenHandles = new Set();
  const agents = [];
  for (let i = 0; i < loopDraftAgents.length; i += 1) {
    const draft = loopDraftAgents[i];
    const handle = normalizeHandle(draft.handle);
    if (!BOT_HANDLE_RE.test(handle)) {
      setGroupModalError('Handles start with a letter — try solver or critic.');
      return;
    }
    if (seenHandles.has(handle)) {
      setGroupModalError('Each agent needs a unique @handle.');
      return;
    }
    seenHandles.add(handle);
    if (!String(draft.model || '').trim()) {
      setGroupModalError('Pick a model for @' + handle + '.');
      return;
    }
    agents.push(normalizeBot({
      ...draft,
      handle,
      name: '@' + handle,
      avatarSeed: handle,
    }));
  }
  const title = String((document.getElementById('groupName') as HTMLInputElement)?.value || '').trim()
    || agents.map((bot) => botDisplayHandle(bot)).join(', ');
  if (editingGroupId) {
    const convo = conversations.find((item) => item.id === editingGroupId);
    if (convo) {
      convo.title = title;
      convo.titleEdited = true;
      convo.botKind = 'group';
      convo.loopAgents = agents;
      convo.participantBotIds = agents.map((bot) => bot.id);
      if (convo.botsHeldBy && !convo.participantBotIds.includes(convo.botsHeldBy)) convo.botsHeldBy = null;
      convo.updatedAt = Date.now();
      saveStore({ immediate: true });
    }
    closeGroupDialog();
    renderSidebar();
    if (typeof syncProjectChrome === 'function') syncProjectChrome();
    return;
  }
  const convo = createBotSession(agents[0], {
    group: true,
    title,
    loopAgents: agents,
  });
  saveStore({ immediate: true });
  closeGroupDialog();
  selectConversation(convo.id);
}

function persistAgentFields(convo: Conversation | null | undefined, botId: string, fields: Partial<Bot>) {
  if (!convo || !botId || !fields) return;
  ensureLoopAgents(convo);
  const agent = (convo.loopAgents || []).find((bot) => bot.id === botId);
  if (!agent) return;
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(fields, 'model')) {
    const next = String(fields.model || '').trim();
    if (agent.model !== next) {
      agent.model = next;
      changed = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'description')) {
    const next = String(fields.description || '');
    if (agent.description !== next) {
      agent.description = next;
      changed = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'stage')) {
    const next = ['auto', 'explore', 'challenge', 'answer'].includes(fields.stage)
      ? fields.stage
      : 'auto';
    if (agent.stage !== next) {
      agent.stage = next;
      changed = true;
    }
  }
  if (!changed) return;
  agent.updatedAt = Date.now();
  convo.updatedAt = Date.now();
  saveStore({ immediate: true });
  if (typeof renderSidebar === 'function') renderSidebar();
  if (typeof paintLoopModelHint === 'function') paintLoopModelHint();
  renderLoopFlow(convo);
}

function persistAgentModel(convo: Conversation | null | undefined, botId: string, modelId: string) {
  persistAgentFields(convo, botId, { model: modelId });
}

function persistAgentDescription(convo: Conversation | null | undefined, botId: string, description: string) {
  persistAgentFields(convo, botId, { description });
}

function persistAgentStage(convo: Conversation | null | undefined, botId: string, stage: string) {
  persistAgentFields(convo, botId, { stage });
}

async function deleteBotAndSession(botId: string) {
  const bot = getBot(botId);
  if (!bot) return;
  const ok = await confirmDanger({
    title: 'Delete ' + botDisplayHandle(bot) + ' and its session?',
    body: 'This cannot be undone.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  abortStream(bot.sessionId);
  conversations = conversations.filter((convo) => convo.id !== bot.sessionId);
  conversations.forEach((convo) => {
    if (Array.isArray(convo.loopAgents)) {
      convo.loopAgents = convo.loopAgents.filter((item) => item.id !== botId);
    }
    if (!Array.isArray(convo.participantBotIds)) return;
    convo.participantBotIds = convo.participantBotIds.filter((id) => id !== botId);
  });
  bots = bots.filter((item) => item.id !== botId);
  saveStore({ immediate: true });
  if (activeId === bot.sessionId) startDraft();
  else {
    renderSidebar();
    if (typeof syncProjectChrome === 'function') syncProjectChrome();
  }
}

function persistAppSurface(next: string | undefined) {
  const surface = next === 'bots' ? 'bots' : 'chat';
  appSurface = surface;
  (document.getElementById('chatShell') as HTMLElement)?.setAttribute('data-surface', surface);
  if (typeof paintWordmarkSurface === 'function') paintWordmarkSurface(surface);
  if (storageReady && settings.appSurface !== surface) {
    saveSettings({ ...settings, appSurface: surface }, { immediate: false });
  }
}

function applyAppSurface(next: string | undefined, { skipRoute = false } = {}) {
  persistAppSurface(next);
  const surface = appSurface;
  if (surface === 'bots' && mainView === 'projects') {
    mainView = 'chat';
    (document.getElementById('projectsView') as HTMLElement)?.classList.add('is-hidden');
  }
  if (surface === 'bots') activeProjectId = null;
  const convo = conversations.find((item) => item.id === activeId);
  if (!convo || convoSurfaceOf(convo) !== surface) startDraft();
  syncProjectChrome();
  renderSidebar();
  if (typeof syncComposerThinkVisibility === 'function') {
    syncComposerThinkVisibility(
      typeof selectedRemoteModel === 'function' ? selectedRemoteModel(latestState) : null
    );
  }
  if (!skipRoute) syncUrlFromState({ replace: true });
}

function restoreAppSurface() {
  persistAppSurface(settings.appSurface === 'bots' ? 'bots' : 'chat');
}

function persistGroupParticipants(convo: Conversation, ids: string[]) {
  ensureLoopAgents(convo);
  const keep = new Set(ids);
  convo.loopAgents = (convo.loopAgents || []).filter((bot) => keep.has(bot.id));
  convo.participantBotIds = convo.loopAgents.map((bot) => bot.id);
  if (convo.botsHeldBy && !ids.includes(convo.botsHeldBy)) convo.botsHeldBy = null;
  convo.updatedAt = Date.now();
  saveStore({ immediate: true });
  renderSidebar();
  if (typeof syncProjectChrome === 'function') syncProjectChrome();
}

