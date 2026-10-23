function closeTraceMembersPicker() {
  if (!traceMembersPicker) return;
  traceMembersPicker.classList.add('is-hidden');
  traceMembersPicker.hidden = true;
  traceMembersPicker.innerHTML = '';
  btnTraceMemberAdd?.setAttribute('aria-expanded', 'false');
}

function addAgentToActiveLoop() {
  if (!requireUnlockedData()) return;
  const convo = conversations.find((item) => item.id === activeId);
  if (!isBotGroup(convo)) return;
  const members = ensureLoopAgents(convo);
  if (members.length >= LOOP_AGENT_MAX) return;
  const index = members.length;
  const preset = loopRolePreset(index);
  const used = new Set(members.map((bot) => bot.handle));
  const handle = uniqueLoopHandle(used, preset.handle, index);
  const agent = normalizeBot({
    id: newId('b'),
    handle,
    name: '@' + handle,
    description: preset.description,
    model: defaultLoopModelId(index),
    avatarSeed: handle,
  });
  convo.loopAgents!.push(agent);
  convo.participantBotIds = convo.loopAgents!.map((bot) => bot.id);
  convo.updatedAt = Date.now();
  saveStore({ immediate: true });
  renderSidebar();
  if (typeof syncProjectChrome === 'function') syncProjectChrome();
}

function kickBotFromActiveGroup(botId: string | undefined) {
  if (!requireUnlockedData()) return;
  const convo = conversations.find((item) => item.id === activeId);
  if (!isBotGroup(convo)) return;
  const members = ensureLoopAgents(convo);
  if (members.length <= LOOP_AGENT_MIN) return;
  persistGroupParticipants(convo, members.map((bot) => bot.id).filter((id) => id !== botId));
}

const TRACE_ACTIVITY_SHARE_DEFAULT = 0.6;
const TRACE_ACTIVITY_SHARE_MIN = 0.22;
const TRACE_ACTIVITY_SHARE_MAX = 0.78;

let traceActivityShare = TRACE_ACTIVITY_SHARE_DEFAULT;
let traceActivityFolded = false;
let traceMembersFolded = false;
let traceSplitDrag: {pointerId: number} | null = null;

function clampTraceActivityShare(value: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return TRACE_ACTIVITY_SHARE_DEFAULT;
  return Math.min(TRACE_ACTIVITY_SHARE_MAX, Math.max(TRACE_ACTIVITY_SHARE_MIN, n));
}

function loadTraceSplitPrefs() {
  traceActivityShare = clampTraceActivityShare(settings.traceActivityShare);
  traceActivityFolded = !!settings.traceActivityFolded;
  traceMembersFolded = !!settings.traceMembersFolded;
  if (typeof applyTraceSplitLayout === 'function') applyTraceSplitLayout();
}

function saveTraceSplitPrefs() {
  if (!storageReady) return;
  if (
    settings.traceActivityShare === traceActivityShare
    && !!settings.traceActivityFolded === !!traceActivityFolded
    && !!settings.traceMembersFolded === !!traceMembersFolded
  ) {
    return;
  }
  saveSettings({
    ...settings,
    traceActivityShare,
    traceActivityFolded,
    traceMembersFolded,
  }, { immediate: false });
}

function applyTraceSplitLayout() {
  const show = !!(traceSidebar && traceSidebar.classList.contains('has-members'));
  if (btnTraceActivityFold) {
    btnTraceActivityFold.hidden = !show;
    btnTraceActivityFold.setAttribute('aria-hidden', show ? 'false' : 'true');
  }
  if (traceSplitHandle) {
    traceSplitHandle.hidden = !show;
    traceSplitHandle.setAttribute('aria-valuenow', String(Math.round(traceActivityShare * 100)));
    traceSplitHandle.setAttribute(
      'aria-disabled',
      (!show || traceActivityFolded || traceMembersFolded) ? 'true' : 'false'
    );
  }
  if (!traceSidebar) return;
  if (!show) {
    traceSidebar.classList.remove('activity-folded', 'members-folded', 'is-resizing');
    traceSidebarSplit?.style.removeProperty('--trace-activity-share');
    traceSidebarSplit?.style.removeProperty('--trace-members-share');
    return;
  }
  traceSidebar.classList.toggle('activity-folded', traceActivityFolded);
  traceSidebar.classList.toggle('members-folded', traceMembersFolded);
  traceSidebarSplit?.style.setProperty('--trace-activity-share', traceActivityShare + 'fr');
  traceSidebarSplit?.style.setProperty('--trace-members-share', (1 - traceActivityShare) + 'fr');
  if (btnTraceActivityFold) {
    const expanded = !traceActivityFolded;
    btnTraceActivityFold.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btnTraceActivityFold.title = expanded ? 'Collapse live activity' : 'Show live activity';
    btnTraceActivityFold.setAttribute(
      'aria-label',
      expanded ? 'Collapse live activity' : 'Show live activity'
    );
  }
  if (btnTraceMembersFold) {
    const expanded = !traceMembersFolded;
    btnTraceMembersFold.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btnTraceMembersFold.title = expanded ? 'Collapse members' : 'Show members';
    btnTraceMembersFold.setAttribute(
      'aria-label',
      expanded ? 'Collapse members' : 'Show members'
    );
  }
}

function setTraceActivityFolded(next: boolean) {
  traceActivityFolded = !!next;
  saveTraceSplitPrefs();
  applyTraceSplitLayout();
}

function setTraceMembersFolded(next: boolean) {
  traceMembersFolded = !!next;
  if (traceMembersFolded) closeTraceMembersPicker();
  saveTraceSplitPrefs();
  applyTraceSplitLayout();
}

function setTraceActivityShare(next: number, { persist = true } = {}) {
  traceActivityShare = clampTraceActivityShare(next);
  applyTraceSplitLayout();
  if (persist) saveTraceSplitPrefs();
}

function beginTraceSplitDrag(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (!traceSidebar?.classList.contains('has-members')) return;
  if (traceActivityFolded || traceMembersFolded) return;
  if (!traceSidebarSplit || !traceSplitHandle) return;
  event.preventDefault();
  traceSplitDrag = { pointerId: event.pointerId };
  traceSidebar.classList.add('is-resizing');
  try { traceSplitHandle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  window.addEventListener('pointermove', moveTraceSplitDrag);
  window.addEventListener('pointerup', endTraceSplitDrag);
  window.addEventListener('pointercancel', endTraceSplitDrag);
  moveTraceSplitDrag(event);
}

function moveTraceSplitDrag(event: PointerEvent) {
  if (!traceSplitDrag || !traceSidebarSplit) return;
  const rect = traceSidebarSplit.getBoundingClientRect();
  const handleH = traceSplitHandle ? traceSplitHandle.getBoundingClientRect().height : 8;
  const available = Math.max(1, rect.height - handleH);
  const y = event.clientY - rect.top - handleH / 2;
  setTraceActivityShare(y / available, { persist: false });
}

function endTraceSplitDrag(event: PointerEvent) {
  if (!traceSplitDrag) return;
  if (event && event.pointerId != null && traceSplitHandle) {
    try { traceSplitHandle.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  }
  traceSplitDrag = null;
  window.removeEventListener('pointermove', moveTraceSplitDrag);
  window.removeEventListener('pointerup', endTraceSplitDrag);
  window.removeEventListener('pointercancel', endTraceSplitDrag);
  traceSidebar?.classList.remove('is-resizing');
  saveTraceSplitPrefs();
}

function bindTraceSplitChrome() {
  loadTraceSplitPrefs();
  applyTraceSplitLayout();
  btnTraceActivityFold?.addEventListener('click', (event) => {
    event.stopPropagation();
    setTraceActivityFolded(!traceActivityFolded);
  });
  btnTraceMembersFold?.addEventListener('click', (event) => {
    event.stopPropagation();
    setTraceMembersFolded(!traceMembersFolded);
  });
  if (!traceSplitHandle) return;
  traceSplitHandle.addEventListener('pointerdown', beginTraceSplitDrag);
  traceSplitHandle.addEventListener('pointermove', moveTraceSplitDrag);
  traceSplitHandle.addEventListener('pointerup', endTraceSplitDrag);
  traceSplitHandle.addEventListener('pointercancel', endTraceSplitDrag);
  traceSplitHandle.addEventListener('dblclick', (event) => {
    event.preventDefault();
    setTraceActivityShare(TRACE_ACTIVITY_SHARE_DEFAULT);
  });
  traceSplitHandle.addEventListener('keydown', (event) => {
    if (traceActivityFolded || traceMembersFolded) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? -0.04 : 0.04;
      setTraceActivityShare(traceActivityShare + delta);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setTraceActivityShare(TRACE_ACTIVITY_SHARE_DEFAULT);
    }
  });
}

function traceMembersRenderSignature(convo: Conversation | null | undefined, members: Bot[]) {
  return JSON.stringify({
    convoId: convo?.id || '',
    members: (members || []).map((bot) => ({
      id: bot.id || '',
      handle: bot.handle || '',
      name: bot.name || '',
      model: bot.model || '',
      modelLabel: loopModelTriggerLabel(bot.model),
      stage: bot.stage || 'auto',
      description: bot.description || '',
    })),
  });
}

function renderTraceMembers() {
  if (!traceSidebar || !traceMembers) return;
  const convo = conversations.find((item) => item.id === activeId);
  const show = isBotsSurface() && isBotGroup(convo);
  traceSidebar.classList.toggle('has-members', show);
  traceMembers.hidden = !show;
  if (!show) {
    closeTraceMembersPicker();
    if (traceMembersList) {
      traceMembersList.replaceChildren();
      delete traceMembersList.dataset.renderSignature;
    }
    applyTraceSplitLayout();
    renderLoopFlow(convo);
    return;
  }
  const members = ensureLoopAgents(convo);
  const title = (document.getElementById('traceMembersTitle') as HTMLElement);
  if (title) title.textContent = 'Agents · ' + members.length;
  const canAdd = members.length < LOOP_AGENT_MAX;
  if (btnTraceMemberAdd) {
    btnTraceMemberAdd.disabled = !canAdd;
    btnTraceMemberAdd.title = canAdd ? 'Add an agent' : 'This loop already has ' + LOOP_AGENT_MAX + ' agents';
    btnTraceMemberAdd.setAttribute('aria-label', btnTraceMemberAdd.title);
  }
  if (!traceMembersList) {
    applyTraceSplitLayout();
    return;
  }
  const renderSignature = traceMembersRenderSignature(convo, members);
  if (
    traceMembersList.dataset.renderSignature === renderSignature
    && traceMembersList.childElementCount === members.length
  ) {
    applyTraceSplitLayout();
    renderLoopFlow(convo);
    return;
  }
  traceMembersList.replaceChildren();
  traceMembersList.dataset.renderSignature = renderSignature;
  const canKick = members.length > LOOP_AGENT_MIN;
  members.forEach((bot) => {
    const row = (document.createElement('div') as HTMLElement);
    row.className = 'trace-member';
    const avatar = createBotAvatarEl(bot, { className: 'trace-member-avatar' });
    applyPrivacyMosaic(avatar, 'bot-avatar:' + bot.id, { dense: true });
    row.appendChild(avatar);
    const copy = (document.createElement('div') as HTMLElement);
    copy.className = 'trace-member-copy';
    const handle = (document.createElement('span') as HTMLElement);
    handle.className = 'trace-member-handle';
    handle.textContent = botDisplayHandle(bot);
    applyPrivacyMosaic(handle, 'bot-handle:' + bot.id);
    setIdentityTitle(handle, botDisplayHandle(bot));
    const model = createLoopModelPicker(bot.model, {
      ariaLabel: 'Model for ' + botDisplayHandle(bot),
      className: 'is-compact',
      hiddenClass: 'trace-member-model',
      onPick: (value) => persistAgentModel(convo, bot.id, value),
    });
    const stage = createLoopStageSelect(
      bot.stage || 'auto',
      'Stage for ' + botDisplayHandle(bot),
      'is-compact'
    );
    stage.addEventListener('change', () => persistAgentStage(convo, bot.id, stage.value));
    const desc = (document.createElement('textarea') as HTMLTextAreaElement);
    desc.className = 'field-textarea trace-member-desc';
    desc.rows = 2;
    desc.maxLength = 400;
    desc.placeholder = 'What this agent should do…';
    desc.value = bot.description || '';
    desc.setAttribute('aria-label', 'Description for ' + botDisplayHandle(bot));
    desc.addEventListener('change', () => persistAgentDescription(convo, bot.id, desc.value));
    desc.addEventListener('blur', () => persistAgentDescription(convo, bot.id, desc.value));
    copy.appendChild(handle);
    copy.appendChild(model);
    copy.appendChild(stage);
    copy.appendChild(desc);
    row.appendChild(copy);
    const kick = (document.createElement('button') as HTMLButtonElement);
    kick.type = 'button';
    kick.className = 'btn btn-ghost btn-icon trace-member-kick';
    kick.dataset.botId = bot.id;
    kick.setAttribute('aria-label', 'Remove ' + botDisplayHandle(bot) + ' from this loop');
    kick.title = canKick ? 'Remove from loop' : 'Loops need at least two agents';
    kick.disabled = !canKick;
    kick.textContent = '×';
    row.appendChild(kick);
    traceMembersList.appendChild(row);
  });
  closeTraceMembersPicker();
  applyTraceSplitLayout();
  renderLoopFlow(convo);
}

function bindBotChrome() {
  (document.getElementById('btnNewGroup') as HTMLButtonElement)?.addEventListener('click', () => openGroupDialog(null));
  (document.getElementById('btnGroupCancel') as HTMLButtonElement)?.addEventListener('click', closeGroupDialog);
  (document.getElementById('btnGroupClose') as HTMLButtonElement)?.addEventListener('click', closeGroupDialog);
  (document.getElementById('btnGroupSave') as HTMLButtonElement)?.addEventListener('click', saveGroupFromDialog);
  (document.getElementById('btnLoopCountDown') as HTMLButtonElement)?.addEventListener('click', () => {
    setLoopDraftCount(loopDraftAgents.length - 1);
  });
  (document.getElementById('btnLoopCountUp') as HTMLButtonElement)?.addEventListener('click', () => {
    setLoopDraftCount(loopDraftAgents.length + 1);
  });
  (document.getElementById('groupModal') as HTMLElement)?.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).id === 'groupModal') closeGroupDialog();
  });
  btnTraceMemberAdd?.addEventListener('click', (event) => {
    event.stopPropagation();
    addAgentToActiveLoop();
  });
  traceMembersList?.addEventListener('click', (event) => {
    const kick = ((event.target as HTMLElement).closest('.trace-member-kick') as HTMLButtonElement);
    if (!kick || kick.disabled) return;
    kickBotFromActiveGroup(kick.dataset.botId);
  });
  topbarLoopPhase?.addEventListener('click', () => {
    if (typeof setTraceSidebarOpen === 'function') setTraceSidebarOpen(true, { fromUser: true });
  });
  bindTraceSplitChrome();
}

bindBotChrome();
