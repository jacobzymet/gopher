function getOutboundQueue(convoId: string | null | undefined) {
  if (!convoId) return [];
  let queue = outboundQueues.get(convoId);
  if (!queue) {
    queue = [];
    outboundQueues.set(convoId!, queue);
  }
  return queue;
}

function clearOutboundQueue(convoId: string | null | undefined) {
  if (!convoId) return;
  if (editingQueueId && getOutboundQueue(convoId).some((item) => item.id === editingQueueId)) {
    editingQueueId = null;
  }
  outboundQueues.delete(convoId);
  stoppedOutboundQueues.delete(convoId!);
  if (activeId === convoId) renderOutboundQueue(conversations.find((c) => c.id === convoId));
  persistOutboundQueues();
}

function pauseOutboundQueueAfterStop(convoId: string | null | undefined) {
  if (!convoId || !getOutboundQueue(convoId).length) return;
  stoppedOutboundQueues.add(convoId);
  if (activeId === convoId) updateComposerHint();
}

function resumeOutboundQueue(convoId: string | null | undefined) {
  if (convoId) stoppedOutboundQueues.delete(convoId!);
}

function isOutboundQueueStopped(convoId: string | null | undefined) {
  return !!convoId && stoppedOutboundQueues.has(convoId);
}

function canSteerLiveStream(stream: ActiveStream | null | undefined = activeStream()): stream is ActiveStream {
  return !!(stream && stream.useAgent);
}

function steerTextFromItem(item: OutboundItem) {
  if (!item) return '';
  const text = String(item.editText || item.displayText || '').trim();
  if (text && text !== '(attachment)') return text;
  if (item.attachments?.length) {
    const names = item.attachments
      .map((file) => file.name || 'attachment')
      .filter(Boolean);
    return names.length
      ? 'Please account for the attached file(s): ' + names.join(', ')
      : '';
  }
  return '';
}

function findQueuedItem(convoId: string, queueId: string) {
  return getOutboundQueue(convoId).find((item) => item.id === queueId) || null;
}

function isQueuePausedForEdit(convoId: string | null | undefined) {
  if (!convoId || !editingQueueId) return false;
  const head = getOutboundQueue(convoId)[0];
  return !!(head && head.id === editingQueueId);
}

function refreshQueuedBubble(row: HTMLElement | null, item: OutboundItem, { paused = false, canSteer = false } = {}) {
  if (!row || !item) return;
  row.dataset.raw = item.editText || item.displayText || '';
  const bubble = (row.querySelector('.msg-bubble') as HTMLElement);
  if (bubble && !row.classList.contains('is-editing')) {
    bubble.innerHTML = formatUserMessageHtml({
      content: item.displayText,
      attachments: item.attachments,
      replyQuote: item.replyQuote,
      replyToSpeakerHandle: item.replyToSpeakerHandle,
    });
  }
  const label = (row.querySelector('.msg-queued-label') as HTMLElement);
  if (label) {
    label.textContent = paused ? 'Paused · editing' : 'Queued';
    label.classList.toggle('is-paused', !!paused);
  }
  const meta = (row.querySelector('.msg-queued-meta') as HTMLElement);
  if (meta) {
    meta.innerHTML = queuedMetaActionsHtml(item.id, { paused, canSteer });
  }
}

function queuedMetaActionsHtml(queueId: string, { paused = false, canSteer = false } = {}) {
  const id = escapeHtml(queueId);
  return (
    '<span class="msg-queued-label' + (paused ? ' is-paused' : '') + '">' +
      (paused ? 'Paused · editing' : 'Queued') +
    '</span>' +
    (canSteer
      ? '<button type="button" class="msg-queued-action" data-queue-steer="' + id +
        '" title="Guide the current reply without stopping it" aria-label="Steer current activity">Steer</button>'
      : '') +
    '<button type="button" class="msg-queued-action" data-queue-edit="' + id +
      '" aria-label="Edit queued message">Edit</button>' +
    '<button type="button" class="msg-queued-action" data-queue-remove="' + id +
      '" aria-label="Remove queued message">Remove</button>'
  );
}

function buildQueuedBubble(item: OutboundItem, { paused = false, canSteer = false } = {}) {
  const row = (document.createElement('div') as HTMLElement);
  row.className = 'msg msg-role-user msg-queued';
  row.dataset.queueId = item.id;
  row.dataset.raw = item.editText || item.displayText || '';
  const bubble = (document.createElement('div') as HTMLElement);
  bubble.className = 'msg-bubble';
    bubble.innerHTML = formatUserMessageHtml({
      content: item.displayText,
      attachments: item.attachments,
      replyQuote: item.replyQuote,
      replyToSpeakerHandle: item.replyToSpeakerHandle,
    });
  const meta = (document.createElement('div') as HTMLElement);
  meta.className = 'msg-queued-meta';
  meta.innerHTML = queuedMetaActionsHtml(item.id, { paused, canSteer });
  row.appendChild(bubble);
  row.appendChild(meta);
  return row;
}

function liveStreamRow() {
  if (!activeId || !chatThread) return null;
  const row = activeStreams.get(activeId)?.dom?.row;
  return row && chatThread.contains(row) ? row : null;
}

function lastRowBeforeQueue() {
  const queued = (chatThread.querySelector(':scope > .msg-queued:not(.msg-steering)') as HTMLElement);
  const streamRow = liveStreamRow();
  let node = streamRow || chatThread.firstElementChild;
  if (!node) return null;
  let last = streamRow;
  while (node) {
    if (node === queued) break;
    last = node as HTMLElement;
    node = node.nextElementSibling;
  }
  return last;
}

function insertAfterLiveReply(row: HTMLElement) {
  if (!chatThread || !row) return;
  const queued = (chatThread.querySelector(':scope > .msg-queued:not(.msg-steering)') as HTMLElement);
  if (queued) {
    chatThread.insertBefore(row, queued);
    return;
  }
  const anchor = lastRowBeforeQueue();
  if (anchor) anchor.after(row);
  else chatThread.appendChild(row);
}

function insertBeforeLiveReply(row: HTMLElement) {
  if (!chatThread || !row) return;
  const streamRow = liveStreamRow();
  if (streamRow) {
    streamRow.before(row);
    return;
  }
  insertAfterLiveReply(row);
}

function placeLiveAssistantRow(stream: ActiveStream) {
  const row = stream?.dom?.row;
  if (!row || !chatThread || !row.isConnected) return;
  const queued = (chatThread.querySelector(':scope > .msg-queued:not(.msg-steering)') as HTMLElement);
  if (queued) {
    if (queued !== row && row.nextElementSibling !== queued) {
      chatThread.insertBefore(row, queued);
    }
    return;
  }
  if (row !== chatThread.lastElementChild) chatThread.appendChild(row);
}

function appendQueuedBubble(row: HTMLElement) {
  if (!chatThread || !row) return;
  const queued = (chatThread.querySelectorAll(':scope > .msg-queued:not(.msg-steering)') as NodeListOf<HTMLElement>);
  if (queued.length) {
    queued[queued.length - 1].after(row);
    return;
  }
  insertAfterLiveReply(row);
}

function renderOutboundQueue(convo: Conversation | undefined) {
  if (!chatThread) return;
  const keepEditing = editingRow
    && editingRow.classList.contains('msg-queued')
    && editingRow.isConnected
    && chatThread.contains(editingRow)
    ? editingRow
    : null;
  const keepId = keepEditing?.dataset.queueId || null;
  (chatThread.querySelectorAll('.msg-queued:not(.msg-steering)') as NodeListOf<HTMLElement>).forEach((el) => {
    if (keepId && el.dataset.queueId === keepId) return;
    el.remove();
  });
  if (!convo || activeId !== convo.id) return;
  const queue = getOutboundQueue(convo.id);
  const pausedHead = isQueuePausedForEdit(convo.id);
  const canSteer = canSteerLiveStream() && !pausedHead;
  for (const item of queue) {
    if (keepId && item.id === keepId) {
      refreshQueuedBubble(keepEditing, item, {
        paused: pausedHead && item.id === editingQueueId,
        canSteer: canSteer && item.id !== editingQueueId,
      });
      appendQueuedBubble(keepEditing!);
      continue;
    }
    appendQueuedBubble(buildQueuedBubble(item, {
      paused: pausedHead && item.id === editingQueueId,
      canSteer,
    }));
  }
}

function enqueueOutbound(convo: Conversation, item: OutboundItem) {
  getOutboundQueue(convo.id).push(item);
  if (activeId === convo.id) {
    showThread(convo);
    const canSteer = canSteerLiveStream() && !isQueuePausedForEdit(convo.id);
    const row = buildQueuedBubble(item, { canSteer });
    appendQueuedBubble(row);
    queueMicrotask(() => motionEnter(row, { y: 10 }));
    scrollToBottom({ force: true });
  }
  updateComposerHint();
  syncComposerStreamUi();
  persistOutboundQueues();
}

function removeQueuedOutbound(convoId: string | null | undefined, queueId: string | undefined) {
  const queue = getOutboundQueue(convoId);
  const next = queue.filter((item) => item.id !== queueId);
  outboundQueues.set(convoId!, next);
  if (!next.length) stoppedOutboundQueues.delete(convoId!);
  if (editingQueueId === queueId) {
    if (editingRow?.dataset.queueId === queueId) {
      editingRow = null;
      mentionInput = composerInput;
      closeMentionMenu();
    }
    editingQueueId = null;
  }
  if (activeId === convoId) {
    const row = [...(chatThread.querySelectorAll('.msg-queued') as NodeListOf<HTMLElement>)]
      .find((el) => el.dataset.queueId === queueId);
    if (row) row.remove();
  }
  updateComposerHint();
  persistOutboundQueues();
  maybeSendNextQueued(convoId);
}

/**
 * Mid-turn steer (Copilot/Claude pattern): keep the live agent turn running and
 * inject this message before the next LLM call (usually after the current tool
 * round). Does not abort. If the turn ends first, the message is re-queued.
 */
function steerQueuedOutbound(convoId: string | null | undefined, queueId: string | undefined) {
  if (!convoId || !queueId) return;
  const stream = activeStreams.get(convoId!);
  if (!canSteerLiveStream(stream)) {
    showAttachHint('Steer is available while an agent reply is in progress.');
    return;
  }
  const queue = getOutboundQueue(convoId);
  const idx = queue.findIndex((item) => item.id === queueId);
  if (idx < 0) return;
  const [item] = queue.splice(idx, 1);
  outboundQueues.set(convoId!, queue);
  if (editingQueueId === queueId) {
    if (editingRow?.dataset.queueId === queueId) {
      cancelMessageEdit({ resumeQueue: false });
    } else {
      editingQueueId = null;
    }
  }
  if (activeId === convoId) {
    const row = [...(chatThread.querySelectorAll('.msg-queued') as NodeListOf<HTMLElement>)]
      .find((el) => el.dataset.queueId === queueId);
    if (row) row.remove();
    const convo = conversations.find((c) => c.id === convoId);
    if (convo) renderOutboundQueue(convo);
  }
  updateComposerHint();
  const text = steerTextFromItem(item);
  if (!text) {
    queue.unshift(item);
    outboundQueues.set(convoId!, queue);
    persistOutboundQueues();
    if (activeId === convoId) {
      const convo = conversations.find((c) => c.id === convoId);
      if (convo) renderOutboundQueue(convo);
    }
    showAttachHint('Nothing to steer with — add text first.');
    updateComposerHint();
    return;
  }
  if (!stream.pendingSteers) stream.pendingSteers = [];
  const entry = { item, text, posted: false, applied: false };
  stream.pendingSteers.push(entry);
  persistOutboundQueues();
  renderPendingSteerBubble(convoId, entry);
  void flushPendingSteers(stream);
}

function renderPendingSteerBubble(convoId: string | null | undefined, entry: PendingSteer) {
  if (activeId !== convoId || !chatThread || !entry?.item) return;
  const existing = (chatThread.querySelector(
    '.msg-steering[data-steer-queue-id="' + CSS.escape(entry.item.id) + '"]'
  ) as HTMLElement);
  if (existing) return;
  const row = (document.createElement('div') as HTMLElement);
  row.className = 'msg msg-role-user msg-queued msg-steering';
  row.dataset.steerQueueId = entry.item.id;
  row.dataset.raw = entry.text;
  const bubble = (document.createElement('div') as HTMLElement);
  bubble.className = 'msg-bubble';
  bubble.innerHTML = formatUserMessageHtml({
    content: entry.item.displayText || entry.text,
    attachments: entry.item.attachments,
  });
  const meta = (document.createElement('div') as HTMLElement);
  meta.className = 'msg-queued-meta';
  meta.innerHTML =
    '<span class="msg-queued-label is-steering">Steering…</span>' +
    '<button type="button" class="msg-queued-action" data-steer-cancel="' +
      escapeHtml(entry.item.id) +
      '" aria-label="Cancel steer">Cancel</button>';
  row.appendChild(bubble);
  row.appendChild(meta);
  insertBeforeLiveReply(row);
  queueMicrotask(() => motionEnter(row, { y: 8 }));
  scrollToBottom({ force: true });
}

async function postSteerToAgent(stream: ActiveStream, entry: PendingSteer) {
  const response = await fetch('/api/chat/steer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: stream.steerId,
      text: entry.text,
      client_id: entry.item?.id || undefined,
    }),
  });
  if (!response.ok) {
    const problem: ApiErrorResult | null = await response.json().catch(() => null);
    throw new Error((problem && problem.error) || 'Could not steer this turn');
  }
}

async function flushPendingSteers(stream: ActiveStream) {
  if (!stream?.steerId || !Array.isArray(stream.pendingSteers) || stream.steerFlushing) return;
  stream.steerFlushing = true;
  try {
    for (;;) {
      const entry = stream.pendingSteers.find((entry) => !entry.posted && !entry.applied && !entry.posting);
      if (!entry) break;
      entry.posting = true;
      try {
        await postSteerToAgent(stream, entry);
        entry.posted = true;
      } catch (error) {
        entry.posted = false;
        showAttachHint((error as Error)?.message || 'Could not steer this turn');
        if (!entry.applied && stream.pendingSteers.includes(entry)) restoreSteerToQueue(stream, entry);
      } finally {
        entry.posting = false;
      }
    }
  } finally {
    stream.steerFlushing = false;
  }
}

function restoreSteerToQueue(stream: ActiveStream, entry: PendingSteer) {
  if (!stream?.pendingSteers || !entry?.item) return;
  const idx = stream.pendingSteers.indexOf(entry);
  if (idx >= 0) stream.pendingSteers.splice(idx, 1);
  const convoId = [...activeStreams.entries()].find(([, live]) => live === stream)?.[0];
  if (!convoId) return;
  const row = (chatThread?.querySelector(
    '.msg-steering[data-steer-queue-id="' + CSS.escape(entry.item.id) + '"]'
  ) as HTMLElement);
  if (row) row.remove();
  getOutboundQueue(convoId).unshift(entry.item);
  persistOutboundQueues();
  const convo = conversations.find((c) => c.id === convoId);
  if (convo && activeId === convoId) renderOutboundQueue(convo);
  updateComposerHint();
}

function cancelPendingSteer(convoId: string | null | undefined, queueId: string) {
  const stream = activeStreams.get(convoId!);
  if (!stream?.pendingSteers) return;
  const idx = stream.pendingSteers.findIndex((entry) => entry.item?.id === queueId);
  if (idx < 0) return;
  const [entry] = stream.pendingSteers.splice(idx, 1);
  if (activeId === convoId) {
    const row = (chatThread.querySelector(
      '.msg-steering[data-steer-queue-id="' + CSS.escape(queueId) + '"]'
    ) as HTMLElement);
    if (row) row.remove();
  }
  if (entry?.item && !entry.applied && !entry.posted) {
    getOutboundQueue(convoId).unshift(entry.item);
    persistOutboundQueues();
    const convo = conversations.find((c) => c.id === convoId);
    if (convo && activeId === convoId) renderOutboundQueue(convo);
  } else if (entry?.posted && !entry.applied) {
    showAttachHint('That steer already reached this turn.');
  }
  updateComposerHint();
}

function applySteeredEntry(convo: Conversation, stream: ActiveStream, text: string, entry?: PendingSteer | null) {
  const content = String(text || entry?.text || '').trim();
  if (!content) return;
  if (entry) entry.applied = true;
  const userMessage: ChatMessage = {
    role: 'user',
    content: entry?.item?.displayText || content,
    steered: true,
  };
  if (entry?.item?.attachments?.length) {
    userMessage.attachments = entry.item.attachments;
  }
  convo.messages.push(userMessage);
  convo.updatedAt = Date.now();
  saveConversations();
  if (stream.dom?.row) {
    stream.dom.row.dataset.msgIndex = String(liveTurnSlices(convo).followUpStart);
    if (activeId === convo.id) {
      selectTraceMessage(liveTurnSlices(convo).followUpStart, { animate: false, ensureOpen: false });
    }
  }
  if (stream.timeline) {
    stream.timeline.push({
      type: 'notice',
      content: 'Steered: ' + content,
      tone: 'ok',
      kind: 'steer',
    });
  }
  if (activeId === convo.id) {
    const pendingRow = entry?.item?.id
      ? (chatThread.querySelector(
        '.msg-steering[data-steer-queue-id="' + CSS.escape(entry.item.id) + '"]'
      ) as HTMLElement)
      : null;
    const idx = convo.messages.length - 1;
    const row = buildBubble('user', userMessage.content, idx, userMessage, { animate: true });
    if (pendingRow) pendingRow.replaceWith(row);
    else insertBeforeLiveReply(row);
    placeLiveAssistantRow(stream);
  }
}

function reclaimUnappliedSteers(convoId: string | null | undefined, stream: ActiveStream) {
  const pending = stream?.pendingSteers;
  if (!pending?.length) return;
  const queue = getOutboundQueue(convoId);
  const failed = !!(stream.cancelled || stream.hardStopped || stream.errorMessage);
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const entry = pending[i];
    if (entry.applied || !entry.item) continue;
    // Posted steers on a finished turn were consumed server-side; re-queueing
    // them would send a duplicate user turn. Reclaim only if they never left
    // or the turn died before the model could use them.
    if (entry.posted && !failed) continue;
    queue.unshift(entry.item);
  }
  stream.pendingSteers = [];
  persistOutboundQueues();
  if (activeId === convoId) {
    (chatThread.querySelectorAll('.msg-steering') as NodeListOf<HTMLElement>).forEach((el) => el.remove());
    const convo = conversations.find((c) => c.id === convoId);
    if (convo) renderOutboundQueue(convo);
  }
}

function beginQueuedMessageEdit(row: HTMLElement) {
  if (!row?.classList.contains('msg-queued') || row.classList.contains('is-editing')) return;
  const queueId = row.dataset.queueId;
  if (!queueId || !activeId) return;
  const item = findQueuedItem(activeId, queueId);
  if (!item) return;
  if (editingRow && editingRow !== row) cancelMessageEdit();

  const raw = item.editText || item.displayText || '';
  const bubble = (row.querySelector('.msg-bubble') as HTMLElement);
  if (!bubble) return;

  const editor = (document.createElement('div') as HTMLElement);
  editor.className = 'msg-edit';
  const input = (document.createElement('textarea') as HTMLTextAreaElement);
  input.className = 'msg-edit-input';
  input.value = raw === '(attachment)' ? '' : raw;
  input.setAttribute('aria-label', 'Edit queued message');
  input.placeholder = 'Edit queued message… Type @ to mention';
  const bar = (document.createElement('div') as HTMLElement);
  bar.className = 'msg-edit-bar';
  const btnCancel = (document.createElement('button') as HTMLButtonElement);
  btnCancel.type = 'button';
  btnCancel.className = 'btn btn-ghost';
  btnCancel.textContent = 'Cancel';
  const btnSave = (document.createElement('button') as HTMLButtonElement);
  btnSave.type = 'button';
  btnSave.className = 'btn btn-primary';
  btnSave.textContent = 'Save';
  bar.appendChild(btnCancel);
  bar.appendChild(btnSave);
  editor.appendChild(input);
  editor.appendChild(bar);

  bubble.replaceWith(editor);
  row.classList.add('is-editing');
  editingRow = row;
  editingQueueId = queueId;
  mentionInput = input;
  refreshQueuedBubble(row, item, { paused: isQueuePausedForEdit(activeId) });
  updateComposerHint();

  const commit = () => {
    const next = input.value.trim();
    if (!next && !(item.attachments && item.attachments.length)) return;
    closeMentionMenu();
    mentionInput = composerInput;
    saveQueuedMessageEdit(row, next);
  };
  btnCancel.addEventListener('click', () => cancelMessageEdit());
  btnSave.addEventListener('click', commit);
  input.addEventListener('input', () => {
    autoResize(input);
    updateMentionMenu(input);
  });
  input.addEventListener('click', () => updateMentionMenu(input));
  input.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      updateMentionMenu(input);
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== input) closeMentionMenu();
    }, 120);
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (handleMentionKeydown(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelMessageEdit();
      return;
    }
    if (event.key !== 'Enter') return;
    if (settings.enterSends) {
      if (!event.shiftKey) {
        event.preventDefault();
        commit();
      }
    } else if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      commit();
    }
  });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autoResize(input);
  // If this item is already at the head, pause drain until save/cancel.
  if (isQueuePausedForEdit(activeId)) updateComposerHint();
}

function saveQueuedMessageEdit(row: HTMLElement, rawText: string) {
  const queueId = row?.dataset.queueId;
  if (!queueId || !activeId) return;
  const item = findQueuedItem(activeId, queueId);
  if (!item) return;

  const mentioned = parseCapabilityMentions(rawText);
  const text = mentioned.text;
  const mentionIds = new Set(mentioned.mentions);
  mentionIds.delete('agent');
  const turn = resolveTurnSkills(mentionIds);
  const displayText = displayTextWithMentions(text, mentioned.mentions)
    || (item.attachments?.length ? '(attachment)' : '');
  item.editText = rawText.trim() || displayText;
  item.displayText = displayText;
  item.apiText = userMessageApiContent({
    content: displayText,
    attachments: item.attachments || [],
    replyQuote: item.replyQuote,
    replyToSpeakerHandle: item.replyToSpeakerHandle,
  });
  item.turn = {
    useAgent: turn.useAgent,
    skills: turn.skills,
    deepResearch: turn.deepResearch,
    deepResearchOutput: turn.deepResearchOutput,
    forceTools: turn.forceTools,
  };

  const editor = (row.querySelector('.msg-edit') as HTMLElement);
  const nextBubble = (document.createElement('div') as HTMLElement);
  nextBubble.className = 'msg-bubble';
  nextBubble.innerHTML = formatUserMessageHtml({
    content: item.displayText,
    attachments: item.attachments,
    replyQuote: item.replyQuote,
    replyToSpeakerHandle: item.replyToSpeakerHandle,
  });
  if (editor) editor.replaceWith(nextBubble);
  row.classList.remove('is-editing');
  row.dataset.raw = item.editText;
  editingRow = null;
  editingQueueId = null;
  mentionInput = composerInput;
  closeMentionMenu();
  refreshQueuedBubble(row, item, { paused: false });
  updateComposerHint();
  persistOutboundQueues();
  resumeOutboundQueue(activeId);
  maybeSendNextQueued(activeId);
  focusComposer();
}

function dispatchOutboundTurn(convo: Conversation, item: OutboundItem) {
  const previousTitle = convo.title;
  const userMessage: ChatMessage = {
    role: 'user',
    content: item.displayText || (item.attachments?.length ? '(attachment)' : ''),
  };
  if (item.attachments?.length) userMessage.attachments = item.attachments;
  if (item.replyQuote) userMessage.replyQuote = item.replyQuote;
  if (item.replyToSpeakerId) {
    userMessage.replyToSpeakerId = item.replyToSpeakerId;
    if (item.replyToSpeakerHandle) userMessage.replyToSpeakerHandle = item.replyToSpeakerHandle;
  }
  convo.messages.push(userMessage);
  if (convo.messages.length === 1 && !convo.titleEdited && !(typeof isBotsConvo === 'function' && isBotsConvo(convo))) {
    convo.title = provisionalTitle(
      item.displayText || (item.attachments?.[0]?.name || 'Attachment')
    );
    if (!convo.incognito) {
      convo.titleStatus = 'pending';
      convo.titleAttempts = 0;
    }
  }
  convo.updatedAt = Date.now();
  saveConversations({ immediate: true });
  renderSidebar();
  if (activeId === convo.id) {
    showThread(convo);
    // Drop the matching queued ghost if still present, then append the real bubble.
    const ghost = [...(chatThread.querySelectorAll('.msg-queued') as NodeListOf<HTMLElement>)]
      .find((row) => row.dataset.queueId === item.id);
    if (ghost) ghost.remove();
    chatThread.appendChild(
      buildBubble('user', userMessage.content, convo.messages.length - 1, userMessage, { animate: true })
    );
    scrollToBottom({ force: true });
  }
  if (typeof isBotsConvo === 'function' && isBotsConvo(convo) && typeof runBotsOutbound === 'function') {
    void runBotsOutbound(convo, item, userMessage, previousTitle);
    return;
  }
  void runAssistantTurn(convo, {
    useAgent: item.turn.useAgent,
    text: item.apiText,
    skills: item.turn.skills,
    deepResearch: item.turn.deepResearch,
    deepResearchOutput: item.turn.deepResearchOutput,
    forceTools: item.turn.forceTools,
    dispatchedMessage: userMessage,
    queueItem: item,
    previousTitle,
  });
}

function maybeSendNextQueued(convoId: string | null | undefined) {
  if (!convoId || isConvoBusy(convoId)) return;
  const queue = getOutboundQueue(convoId);
  if (!queue.length) {
    stoppedOutboundQueues.delete(convoId!);
    updateComposerHint();
    return;
  }
  if (isOutboundQueueStopped(convoId)) {
    updateComposerHint();
    return;
  }
  if (isQueuePausedForEdit(convoId)) {
    const convo = conversations.find((item) => item.id === convoId);
    if (convo && activeId === convoId) renderOutboundQueue(convo);
    updateComposerHint();
    return;
  }
  const convo = conversations.find((item) => item.id === convoId);
  if (!convo) {
    outboundQueues.delete(convoId);
    persistOutboundQueues();
    return;
  }
  const next = queue.shift();
  outboundQueues.set(convoId!, queue);
  persistOutboundQueues();
  dispatchOutboundTurn(convo, next!);
  if (activeId === convoId) renderOutboundQueue(convo);
  updateComposerHint();
}

