async function sendMessage({ branch = false } = {}) {
  if (pendingComposerSend) return;
  if (
    !branch
    && editingRow
    && !editingRow.classList.contains('msg-queued')
    && typeof submitEditedMessage === 'function'
  ) {
    const input = (editingRow.querySelector('.msg-edit-input') as HTMLTextAreaElement);
    const next = (input?.value || '').trim();
    if (next) {
      await submitEditedMessage(editingRow, next);
    }
    return;
  }
  const typed = composerInput.value.trim();
  const queuedFiles = pendingAttachments.slice();
  const replyQuote = typeof pendingReplyQuote === 'string' ? pendingReplyQuote.trim() : '';
  const replyTarget = pendingReplyTarget && pendingReplyTarget.speakerId
    ? {
      speakerId: pendingReplyTarget.speakerId,
      speakerHandle: pendingReplyTarget.speakerHandle || '',
    }
    : null;
  if (!typed && !queuedFiles.length && !replyQuote) return;
  const selectedTurnRemote = selectedRemoteModel(latestState);
  if (!serverReady || !selectedTurnRemote?.ready) {
    const label = modelIdLabel(selectedChatModel);
    showComposerHint(
      label ? ('Still connecting to ' + label + '…') : 'Still loading models…'
    );
    return;
  }
  if (!requireUnlockedData()) return;

  let source = conversations.find((item) => item.id === activeId);
  if (branch) {
    if (!source || !Array.isArray(source.messages) || !source.messages.length) return;
  }

  const attempt: ComposerSendAttempt = {
    convoId: activeId, projectId: activeProjectId, modelId: selectedChatModel,
    surface: appSurface, incognito: draftIncognito, workspace: draftWorkspaceRoot,
    input: composerInput.value, quote: pendingReplyQuote, replyTarget: pendingReplyTarget,
    attachments: queuedFiles, mentions: [...composerMentionIds],
    diagnosticTraceId: typeof diagnosticMark === 'function' && settings.diagnosticsEnabled ? newId('turn') : '',
    diagnosticStartedAt: Date.now(),
  };
  const diagnosticContext = { traceId: attempt.diagnosticTraceId, convoId: activeId, startedAt: attempt.diagnosticStartedAt };
  if (typeof diagnosticMark === 'function') diagnosticMark('prompt.prepare.started', { attachments: queuedFiles.length, model: selectedChatModel }, diagnosticContext);
  pendingComposerSend = attempt;
  updateSendEnabled();
  try {
  stopVoiceInput({ silent: true });
  cancelMessageEdit();
  showChatView();

  let prepared: MessageAttachment[];
  try {
    if (queuedFiles.length) {
      attachHintUntil = 0;
      showComposerHint('Preparing attachments…');
      prepared = await prepareAttachmentsForSend(queuedFiles);
    } else {
      prepared = [];
    }
  } catch (error) {
    if (activeId === attempt.convoId) {
      showAttachHint((error as Error)?.message || 'Attachment prep failed');
      focusComposer();
    }
    return;
  }

  // Async attachment work must never send into another chat or erase a newer draft.
  if (typeof diagnosticMark === 'function') diagnosticMark('prompt.prepare.finished', { attachments: prepared.length }, diagnosticContext);
  if (!composerSendIsCurrent(attempt)) {
    if (activeId === attempt.convoId) showComposerHint('Draft changed during preparation. Review it and send again.');
    return;
  }
  if (!requireUnlockedData() || !serverReady || !selectedRemoteModel(latestState)?.ready) return;

  if (branch) {
    source = (conversations.find((item) => item.id === source!.id) || source)!;
    if (!source.messages?.length) {
      focusComposer();
      return;
    }
  }

  const mentioned = parseCapabilityMentions(typed);
  const text = mentioned.text;
  const mentionIds = new Set([
    ...composerMentionIds,
    ...mentioned.mentions,
  ]);
  // Drop legacy chip id if somehow present.
  mentionIds.delete('agent');
  const turn = resolveTurnSkills(mentionIds);
  const displayText = displayTextWithMentions(text, mentioned.mentions);
  const storedAttachments = storedAttachmentsFromPrepared(prepared);
  const apiText = buildUserApiContent(text, prepared, replyQuote, replyTarget?.speakerHandle);

  if ((branch || source || !isBotsSurface()) && typeof discardSentComposerDraft === 'function') discardSentComposerDraft();
  let convo = branch
    ? null
    : conversations.find((item) => item.id === activeId);
  if (branch) {
    const projectId = source!.projectId || null;
    convo = {
      id: newId('c'),
      title: branchConversationTitle(source!),
      titleEdited: false,
      messages: cloneConversationMessages(source!.messages),
      modelId: source!.modelId || '',
      updatedAt: Date.now(),
      projectId,
      sortOrder: nextTopSortOrder(projectId),
      incognito: !!source!.incognito,
      pinned: false,
      pinnedAt: null,
      workspaceRoot: typeof source!.workspaceRoot === 'string' ? source!.workspaceRoot : '',
    };
    conversations.push(convo);
    if (activeId) stickByConvo.set(activeId, stickToBottom);
    activeId = convo.id;
    draftIncognito = !!convo.incognito;
    activeProjectId = projectId;
    stickToBottom = true;
    userScrollOverride = false;
    resumeBottomIntent = false;
    selectedTraceMsgIndex = null;
    resetTraceAutoOpenState();
    syncUrlFromState();
    showThread(convo);
    renderThread(convo);
    renderSidebar();
    syncComposerStreamUi();
  } else if (!convo) {
    if (typeof isBotsSurface === 'function' && isBotsSurface()) {
      showComposerHint('Create a loop first.');
      if (typeof openGroupDialog === 'function') openGroupDialog(null);
      focusComposer();
      return;
    }
    const id = newId('c');
    convo = {
      id,
      title: draftIncognito ? 'Ghost Chat' : 'New chat',
      titleEdited: false,
      messages: [],
      modelId: draftModelId,
      updatedAt: Date.now(),
      projectId: activeProjectId || null,
      sortOrder: nextTopSortOrder(activeProjectId || null),
      incognito: !!draftIncognito,
      pinned: false,
      pinnedAt: null,
      workspaceRoot: draftWorkspaceRoot,
    };
    conversations.push(convo);
    activeId = id;
    syncUrlFromState({ replace: true });
  }

  composerInput.value = '';
  clearPendingAttachments();
  clearPendingReplyQuote();
  autoResize(composerInput);
  renderComposerMentions();
  renderComposerModes();
  closeMentionMenu();

  if (typeof currentComposerDraftContext === 'function') composerDraftContext = currentComposerDraftContext();

  const outbound = {
    id: newId('q'),
    diagnosticTraceId: attempt.diagnosticTraceId,
    diagnosticStartedAt: attempt.diagnosticStartedAt,
    editText: typed,
    displayText: displayText || (storedAttachments.length ? '(attachment)' : ''),
    apiText,
    attachments: storedAttachments,
    replyQuote: replyQuote || '',
    replyToSpeakerId: replyTarget?.speakerId || '',
    replyToSpeakerHandle: replyTarget?.speakerHandle || '',
    turn: {
      useAgent: turn.useAgent,
      skills: turn.skills,
      deepResearch: turn.deepResearch,
      deepResearchOutput: turn.deepResearchOutput,
      forceTools: turn.forceTools,
    },
  };

  // Branch always starts a fresh turn on the new chat (never queue on the parent).
  const busy = !branch && isConvoBusy(convo.id);
  const hasQueued = !branch && getOutboundQueue(convo.id).length > 0;
  if (!branch && (busy || hasQueued)) {
    enqueueOutbound(convo, outbound);
    if (!busy) {
      if (typeof resumeOutboundQueue === 'function') resumeOutboundQueue(convo.id);
      maybeSendNextQueued(convo.id);
    }
    focusComposer();
    return;
  }

  dispatchOutboundTurn(convo, outbound);
  focusComposer();
  } finally {
    if (pendingComposerSend === attempt) pendingComposerSend = null;
    updateSendEnabled();
  }
}

