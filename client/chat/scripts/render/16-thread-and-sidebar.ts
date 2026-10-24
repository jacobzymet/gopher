function renderThread(convo: Conversation, { drainQueue = true } = {}) {
  if (typeof syncAgentProcesses === 'function') syncAgentProcesses();
  cancelMessageEdit({ resumeQueue: false });
  if (typeof isBotsConvo === 'function' && isBotsConvo(convo) && typeof isSilentNoReply === 'function') {
    const kept = (convo.messages || []).filter((message) => (
      message?.role !== 'assistant' || !isSilentNoReply(message.content)
    ));
    if (kept.length !== convo.messages.length) {
      convo.messages = kept;
      saveStore();
    }
  }
  chatThread.innerHTML = '';
  for (const stream of activeStreams.values()) {
    try { stream.dom?.thinkingOrb?.stop(); } catch { /* ignore */ }
    stream.dom = null;
  }
  const liveStream = activeStreams.get(convo.id);
  const live = !!(liveStream && !liveStream.hardStopped);
  if (live) {
    const slices = liveTurnSlices(convo);
    slices.head.forEach((message, index) => {
      chatThread.appendChild(buildBubble(message.role, message.content, index, message));
    });
    if (slices.prompt) {
      chatThread.appendChild(
        buildBubble(slices.prompt.role, slices.prompt.content, slices.promptIndex, slices.prompt)
      );
    }
    (slices.steers || []).forEach((message, offset) => {
      chatThread.appendChild(
        buildBubble(message.role, message.content, slices.promptIndex + 1 + offset, message)
      );
    });
    reattachLiveStream(convo);
    slices.followUps.forEach((message, offset) => {
      chatThread.appendChild(
        buildBubble(message.role, message.content, slices.followUpStart + offset, message)
      );
    });
    for (const entry of liveStream.pendingSteers || []) {
      if (entry?.applied) continue;
      renderPendingSteerBubble(convo.id, entry);
    }
    renderOutboundQueue(convo);
    scrollToBottom({ force: stickToBottom });
    if (drainQueue) maybeSendNextQueued(convo.id);
    return;
  }
  convo.messages.forEach((message, index) => {
    chatThread.appendChild(buildBubble(message.role, message.content, index, message));
  });
  renderOutboundQueue(convo);
  if (reattachLiveStream(convo)) {
    scrollToBottom({ force: stickToBottom });
    if (drainQueue) maybeSendNextQueued(convo.id);
    return;
  }
  let pick: number | null = null;
  for (let i = convo.messages.length - 1; i >= 0; i -= 1) {
    if (convo.messages[i]?.role === 'assistant') {
      pick = i;
      if (messageHasActivity(convo.messages[i])) break;
    }
  }
  selectedTraceMsgIndex = pick;
  syncTraceSelectionClasses();
  refreshTraceSidebar({ animate: false });
  scrollToBottom({ force: stickToBottom });
  if (drainQueue) maybeSendNextQueued(convo.id);
}

function renderSidebar() {
  closeConvoMenu();
  for (const id of selectedConversationIds) {
    if (!conversations.some((convo) => convo.id === id)) selectedConversationIds.delete(id);
  }
  syncConversationBulkToolbar();
  const list = (document.getElementById('convoList') as HTMLElement);
  list.innerHTML = '';
  sidebarProjectContext.innerHTML = '';
  sidebarProjectContext.classList.add('is-hidden');
  btnProjectsNav.classList.toggle('is-active', mainView === 'projects');
  btnNotificationsNav.classList.toggle('is-active', notificationsPopoverIsOpen());
  refreshNotificationsUi();

  const pinned = pinnedConversations();
  sidebarPinnedSection.classList.toggle('is-hidden', pinned.length === 0);
  pinnedConvoList.innerHTML = '';
  for (const convo of pinned) {
    pinnedConvoList.appendChild(createConvoItem(convo));
  }

  const project = getProject(activeProjectId);
  if (project && mainView === 'chat') {
    sidebarProjectContext.classList.remove('is-hidden');
    const kicker = (document.createElement('p') as HTMLElement);
    kicker.className = 'sidebar-project-kicker';
    kicker.textContent = 'In project';
    const chip = (document.createElement('div') as HTMLElement);
    chip.className = 'sidebar-project-chip';
    const name = (document.createElement('span') as HTMLElement);
    name.className = 'sidebar-project-chip-name';
    name.textContent = project.name;
    applyPrivacyMosaic(name, 'project:' + project.id);
    setIdentityTitle(name, project.name);
    const settingsBtn = (document.createElement('button') as HTMLButtonElement);
    settingsBtn.type = 'button';
    settingsBtn.className = 'project-settings-btn';
    settingsBtn.setAttribute('aria-label', 'Project settings');
    settingsBtn.title = 'Project settings';
    settingsBtn.textContent = '⚙';
    settingsBtn.addEventListener('click', () => openProjectSettings(project.id));
    chip.appendChild(name);
    chip.appendChild(settingsBtn);
    const leave = (document.createElement('button') as HTMLButtonElement);
    leave.type = 'button';
    leave.className = 'sidebar-leave-project';
    leave.textContent = '← Back to general chats';
    leave.addEventListener('click', leaveProject);
    sidebarProjectContext.appendChild(kicker);
    sidebarProjectContext.appendChild(chip);
    sidebarProjectContext.appendChild(leave);
    sidebarConvoLabel.textContent = 'Project chats';
    const projectConvos = conversationsForProject(project.id).filter((convo) => !convo.pinned);
    if (projectConvos.length === 0) {
      const hint = (document.createElement('p') as HTMLElement);
      hint.className = 'convo-empty-hint';
      hint.textContent = 'No chats yet — send a message to start.';
      list.appendChild(hint);
    } else {
      appendConversationDateGroups(list, projectConvos);
    }
    return;
  }

  sidebarConvoLabel.textContent = (typeof isBotsSurface === 'function' && isBotsSurface()) ? 'Loops' : 'Recents';
  const recent = uncategorizedConversations();
  if (recent.length === 0) {
    const hint = (document.createElement('p') as HTMLElement);
    hint.className = 'convo-empty-hint';
    hint.textContent = (typeof isBotsSurface === 'function' && isBotsSurface())
      ? 'No loops yet — create one so several models can work the same problem.'
      : (projects.length ? 'No general chats yet.' : 'No conversations yet.');
    list.appendChild(hint);
  } else {
    appendConversationDateGroups(list, recent);
  }
}

function selectConversation(id: string) {
  const convo = conversations.find((item) => item.id === id);
  if (!convo) return;
  if (typeof leaveComposerDraft === 'function') leaveComposerDraft();
  markConversationNotificationRead(convo);
  if (typeof convoSurfaceOf === 'function') {
    const surface = convoSurfaceOf(convo);
    if (appSurface !== surface) {
      if (typeof persistAppSurface === 'function') persistAppSurface(surface);
      else {
        appSurface = surface;
        (document.getElementById('chatShell') as HTMLElement)?.setAttribute('data-surface', surface);
        if (typeof paintWordmarkSurface === 'function') paintWordmarkSurface(surface);
      }
    }
  }
  if (activeId) stickByConvo.set(activeId, stickToBottom);
  activeId = id;
  draftIncognito = !!convo.incognito;
  activeProjectId = convo.projectId || null;
  syncConversationModel();
  if (latestState) updateInferenceState(latestState);
  stickToBottom = stickByConvo.has(id) ? stickByConvo.get(id)! : true;
  userScrollOverride = !stickToBottom;
  resumeBottomIntent = false;
  selectedTraceMsgIndex = null;
  resetTraceAutoOpenState();
  showChatView();
  renderSidebar();
  showThread(convo);
  renderThread(convo);
  clearPendingReplyQuote();
  hideSelectionReplyBar();
  syncComposerStreamUi();
  syncContextUsage(convo);
  syncUrlFromState();
  closeMobileSidebar();
  if (typeof restoreComposerDraft === 'function') restoreComposerDraft();
  composerInput.focus();
  if (typeof bindTerminalToSession === 'function') bindTerminalToSession();
  if (typeof renderComposerModes === 'function') renderComposerModes();
  if (typeof renderPlusMenu === 'function') renderPlusMenu();
  if (typeof maybeEnsureConversationTitle === 'function') maybeEnsureConversationTitle(convo);
}

/** Return to the draft state — no conversation object until a message is sent. */
function startDraft({ incognito = false }: { incognito?: boolean; syncUrl?: boolean } = {}) {
  if (typeof leaveComposerDraft === 'function') leaveComposerDraft();
  if (typeof isBotsSurface === 'function' && isBotsSurface()) incognito = false;
  cancelMessageEdit({ resumeQueue: false });
  clearPendingReplyQuote();
  hideSelectionReplyBar();
  if (activeId) stickByConvo.set(activeId, stickToBottom);
  activeId = null;
  draftModelId = '';
  draftIncognito = !!incognito;
  stickToBottom = true;
  userScrollOverride = false;
  resumeBottomIntent = false;
  selectedTraceMsgIndex = null;
  resetTraceAutoOpenState();
  composerMentionIds.clear();
  renderComposerMentions();
  if (typeof resetDraftWorkspace === 'function') resetDraftWorkspace();
  syncConversationModel();
  if (latestState) updateInferenceState(latestState);
  renderComposerModes();
  showChatView();
  renderSidebar();
  showEmptyState();
  syncComposerStreamUi();
  syncContextUsage(null);
  refreshTraceSidebar({ animate: false });
  setTraceSidebarOpen(false);
  syncUrlFromState();
  closeMobileSidebar();
  if (typeof restoreComposerDraft === 'function') restoreComposerDraft();
  composerInput.focus();
  if (typeof bindTerminalToSession === 'function') bindTerminalToSession();
}

async function deleteConversation(id: string) {
  const ok = await confirmDanger({
    title: 'Delete this conversation?',
    body: 'This cannot be undone.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ conversationIds: [id] });
  abortStream(id);
  activeStreams.delete(id);
  const deletingEdit = editingQueueId
    && getOutboundQueue(id).some((item) => item.id === editingQueueId);
  outboundQueues.delete(id);
  if (deletingEdit) {
    editingQueueId = null;
    if (editingRow?.classList.contains('msg-queued')) {
      editingRow = null;
      mentionInput = composerInput;
      closeMentionMenu();
    }
  }
  stickByConvo.delete(id);
  conversations = conversations.filter((item) => item.id !== id);
  saveConversations();
  if (activeId === id) startDraft();
  else {
    renderSidebar();
    syncComposerStreamUi();
  }
}
