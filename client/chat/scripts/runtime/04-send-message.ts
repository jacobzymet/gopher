/** The inline edit that Send submits instead of the composer draft, if one is open. */
function composerEditTarget(branch: boolean): HTMLElement | null {
  if (
    !branch
    && editingRow
    && !editingRow.classList.contains('msg-queued')
    && typeof submitEditedMessage === 'function'
  ) {
    return editingRow;
  }
  return null;
}

function composerReplyTarget() {
  return pendingReplyTarget && pendingReplyTarget.speakerId
    ? {
      speakerId: pendingReplyTarget.speakerId,
      speakerHandle: pendingReplyTarget.speakerHandle || '',
    }
    : null;
}

/** False (with a hint) while the server or the selected model is still connecting. */
function composerModelReady(): boolean {
  const selectedTurnRemote = selectedRemoteModel(latestState);
  if (serverReady && selectedTurnRemote?.ready) return true;
  const label = modelIdLabel(selectedChatModel);
  showComposerHint(
    label ? ('Still connecting to ' + label + '…') : 'Still loading models…'
  );
  return false;
}

/** Everything the send depends on, so async work can tell whether the draft changed meanwhile. */
function newComposerAttempt(queuedFiles: MessageAttachment[]): ComposerSendAttempt {
  return {
    convoId: activeId, projectId: activeProjectId, modelId: selectedChatModel,
    surface: appSurface, incognito: draftIncognito, workspace: draftWorkspaceRoot,
    input: composerInput.value, quote: pendingReplyQuote, replyTarget: pendingReplyTarget,
    attachments: queuedFiles, mentions: [...composerMentionIds],
    diagnosticTraceId: typeof diagnosticMark === 'function' && settings.diagnosticsEnabled ? newId('turn') : '',
    diagnosticStartedAt: Date.now(),
  };
}

function composerDiagnosticContext(attempt: ComposerSendAttempt) {
  return { traceId: attempt.diagnosticTraceId, convoId: attempt.convoId, startedAt: attempt.diagnosticStartedAt };
}

/** Prepared attachments, or null (with a hint) when preparation failed. */
async function prepareSendAttachments(attempt: ComposerSendAttempt, queuedFiles: MessageAttachment[]) {
  try {
    attachHintUntil = 0;
    showComposerHint('Preparing attachments…');
    return await prepareAttachmentsForSend(queuedFiles);
  } catch (error) {
    if (activeId === attempt.convoId) {
      showAttachHint((error as Error)?.message || 'Attachment prep failed');
      focusComposer();
    }
    return null;
  }
}

function branchConversation(source: Conversation): Conversation {
  const projectId = source.projectId || null;
  return {
    id: newId('c'),
    title: branchConversationTitle(source),
    titleEdited: false,
    messages: cloneConversationMessages(source.messages),
    modelId: source.modelId || '',
    updatedAt: Date.now(),
    projectId,
    sortOrder: nextTopSortOrder(projectId),
    incognito: !!source.incognito,
    pinned: false,
    pinnedAt: null,
    workspaceRoot: typeof source.workspaceRoot === 'string' ? source.workspaceRoot : '',
  };
}

/** Add a branched chat and switch to it. */
function openBranchConversation(convo: Conversation) {
  conversations.push(convo);
  if (activeId) stickByConvo.set(activeId, stickToBottom);
  activeId = convo.id;
  draftIncognito = !!convo.incognito;
  activeProjectId = convo.projectId || null;
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
}

/** A new chat for the draft, or null on the loops surface (which needs a loop first). */
function openDraftConversation(): Conversation | null {
  if (typeof isBotsSurface === 'function' && isBotsSurface()) {
    showComposerHint('Create a loop first.');
    if (typeof openGroupDialog === 'function') openGroupDialog(null);
    focusComposer();
    return null;
  }
  const id = newId('c');
  const convo: Conversation = {
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
  return convo;
}

function clearComposerAfterSend() {
  composerInput.value = '';
  clearPendingAttachments();
  clearPendingReplyQuote();
  autoResize(composerInput);
  renderComposerMentions();
  renderComposerModes();
  closeMentionMenu();
  if (typeof currentComposerDraftContext === 'function') composerDraftContext = currentComposerDraftContext();
}

type ComposerMessageParts = {
  typed: string;
  replyQuote: string;
  replyTarget: { speakerId: string; speakerHandle: string } | null;
  prepared: MessageAttachment[];
};

/** The outbound message (without its id): display text, API content, attachments and skills. */
function composerOutbound(attempt: ComposerSendAttempt, parts: ComposerMessageParts) {
  const { typed, replyQuote, replyTarget, prepared } = parts;
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
  return {
    id: '',
    diagnosticTraceId: attempt.diagnosticTraceId,
    diagnosticStartedAt: attempt.diagnosticStartedAt,
    editText: typed,
    displayText: displayText || (storedAttachments.length ? '(attachment)' : ''),
    apiText: buildUserApiContent(text, prepared, replyQuote, replyTarget?.speakerHandle),
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
}

/** Queue behind a running turn or earlier queued messages; otherwise start the turn now. */
function queueOrDispatch(convo: Conversation, outbound: ReturnType<typeof composerOutbound>, branch: boolean) {
  // Branch always starts a fresh turn on the new chat (never queue on the parent).
  const busy = !branch && isConvoBusy(convo.id);
  const hasQueued = !branch && getOutboundQueue(convo.id).length > 0;
  if (!branch && (busy || hasQueued)) {
    enqueueOutbound(convo, outbound);
    if (!busy) {
      if (typeof resumeOutboundQueue === 'function') resumeOutboundQueue(convo.id);
      maybeSendNextQueued(convo.id);
    }
  } else {
    dispatchOutboundTurn(convo, outbound);
  }
  focusComposer();
}

/** After attachments are ready: check the draft is unchanged, pick or create the chat, and send. */
function finishComposerSend(
  attempt: ComposerSendAttempt,
  parts: ComposerMessageParts,
  branch: boolean,
  sourceAtStart: Conversation | undefined
) {
  // Async attachment work must never send into another chat or erase a newer draft.
  if (typeof diagnosticMark === 'function') {
    const detail = { attachments: parts.prepared.length };
    diagnosticMark('prompt.prepare.finished', detail, composerDiagnosticContext(attempt));
  }
  if (!composerSendIsCurrent(attempt)) {
    if (activeId === attempt.convoId) showComposerHint('Draft changed during preparation. Review it and send again.');
    return;
  }
  if (!requireUnlockedData() || !serverReady || !selectedRemoteModel(latestState)?.ready) return;
  let source = sourceAtStart;
  if (branch) {
    source = (conversations.find((item) => item.id === source!.id) || source)!;
    if (!source.messages?.length) {
      focusComposer();
      return;
    }
  }
  const outbound = composerOutbound(attempt, parts);
  if ((branch || source || !isBotsSurface()) && typeof discardSentComposerDraft === 'function') {
    discardSentComposerDraft();
  }
  let convo = branch ? null : (conversations.find((item) => item.id === activeId) || null);
  if (branch) {
    convo = branchConversation(source!);
    openBranchConversation(convo);
  } else if (!convo) {
    convo = openDraftConversation();
    if (!convo) return;
  }
  clearComposerAfterSend();
  outbound.id = newId('q');
  queueOrDispatch(convo, outbound, branch);
}

async function sendMessage({ branch = false } = {}) {
  if (pendingComposerSend) return;
  const editRow = composerEditTarget(branch);
  if (editRow) {
    const input = (editRow.querySelector('.msg-edit-input') as HTMLTextAreaElement);
    const next = (input?.value || '').trim();
    if (next) {
      await submitEditedMessage(editRow, next);
    }
    return;
  }
  const typed = composerInput.value.trim();
  const queuedFiles = pendingAttachments.slice();
  const replyQuote = typeof pendingReplyQuote === 'string' ? pendingReplyQuote.trim() : '';
  const replyTarget = composerReplyTarget();
  if (!typed && !queuedFiles.length && !replyQuote) return;
  if (!composerModelReady()) return;
  if (!requireUnlockedData()) return;
  const source = conversations.find((item) => item.id === activeId);
  if (branch && (!source || !Array.isArray(source.messages) || !source.messages.length)) return;
  const attempt = newComposerAttempt(queuedFiles);
  if (typeof diagnosticMark === 'function') {
    const detail = { attachments: queuedFiles.length, model: selectedChatModel };
    diagnosticMark('prompt.prepare.started', detail, composerDiagnosticContext(attempt));
  }
  pendingComposerSend = attempt;
  updateSendEnabled();
  try {
    stopVoiceInput({ silent: true });
    cancelMessageEdit();
    showChatView();
    // No attachments: no await, so the whole send still happens in this tick.
    const prepared = queuedFiles.length ? await prepareSendAttachments(attempt, queuedFiles) : [];
    if (prepared) finishComposerSend(attempt, { typed, replyQuote, replyTarget, prepared }, branch, source);
  } finally {
    if (pendingComposerSend === attempt) pendingComposerSend = null;
    updateSendEnabled();
  }
}
