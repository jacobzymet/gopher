function showSettingsPane(pane: string | undefined) {
  (document.querySelectorAll('.settings-nav-btn') as NodeListOf<HTMLElement>).forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.settingsPane === pane);
  });
  (document.querySelectorAll('.settings-pane') as NodeListOf<HTMLElement>).forEach((el) => {
    el.classList.toggle('is-active', el.dataset.settingsPane === pane);
  });
  const scroll = (document.getElementById('settingsScroll') as HTMLElement);
  (document.querySelector('.settings-main') as HTMLElement)?.classList.toggle('is-provider-pane', pane === 'providers');
  if (scroll) scroll.scrollTop = 0;
  if (typeof setProviderSettingsActive === 'function') {
    setProviderSettingsActive(pane === 'providers');
  }
  if (pane === 'data') {
    refreshLocalDataPane();
    refreshSettingsDataSummary();
  } else if (pane === 'profiles') {
    renderProfilesSettingsList();
  } else if (pane === 'app' && typeof refreshAppUpdatePane === 'function') {
    refreshAppUpdatePane();
  } else if (pane === 'logs' && typeof refreshDiagnostics === 'function') {
    if (typeof renderDiagnostics === 'function') renderDiagnostics();
    refreshDiagnostics();
  }
}

function refreshSettingsDataSummary() {
  const el = (document.getElementById('settingsDataSummary') as HTMLElement);
  if (!el) return;
  const chatCount = conversations.filter((convo) => !(typeof isBotsConvo === 'function' && isBotsConvo(convo))).length;
  const loopCount = conversations.filter((convo) => typeof isBotsConvo === 'function' && isBotsConvo(convo)).length;
  const projectCount = projects.length;
  const chatLabel = chatCount === 1 ? '1 chat' : chatCount + ' chats';
  const projectLabel = projectCount === 1 ? '1 project' : projectCount + ' projects';
  const loopLabel = loopCount === 1 ? '1 loop' : loopCount + ' loops';
  const profileLabel = activeProfile()?.name || 'Personal';
  el.textContent = profileLabel + ' profile. Stored on disk: '
    + chatLabel + ', ' + loopLabel + ', and ' + projectLabel + '.';
  const clearChats = (document.getElementById('btnClearChats') as HTMLButtonElement);
  const clearLoops = (document.getElementById('btnClearLoops') as HTMLButtonElement);
  const clearProjects = (document.getElementById('btnClearProjects') as HTMLButtonElement);
  const clearAll = (document.getElementById('btnClearAllData') as HTMLButtonElement);
  if (clearChats) clearChats.disabled = chatCount === 0;
  if (clearLoops) clearLoops.disabled = loopCount === 0;
  if (clearProjects) clearProjects.disabled = projectCount === 0;
  const hasDrafts = typeof hasComposerDrafts === 'function' && hasComposerDrafts();
  if (clearAll) clearAll.disabled = chatCount === 0 && loopCount === 0 && projectCount === 0 && !hasDrafts;
}

const outboundStarting = new Set<string>();
const outboundStartEpochs = new Map<string, number>();
const stoppedOutboundQueues = new Set<string>();

function isConvoBusy(convoId: string | null | undefined) {
  const botsRunning = typeof isBotsOutboundActive === 'function'
    && isBotsOutboundActive(convoId)
    && !(typeof isBotsOutboundStopped === 'function' && isBotsOutboundStopped(convoId));
  return !!convoId && (
    activeStreams.has(convoId!)
    || outboundStarting.has(convoId)
    || botsRunning
  );
}

function activeStream() {
  return activeId ? activeStreams.get(activeId) || null : null;
}

/** Hard stop for bot group hop loops — lives here so Stop works even before bots.js loads. */
const botsOutboundStopFlags = new Set<string>();
/** Turns this page already started or stopped — do not resume from linger. */
const handledLiveTurnIds = new Set<string>();
/** Conversations the user Stopped before a turn id arrived. */
const cancelledLiveConvoIds = new Set<string>();

function rememberHandledLiveTurn(turnId: string | null | undefined) {
  const id = String(turnId || '').trim();
  if (id) handledLiveTurnIds.add(id);
}

function shouldSkipLiveTurnResume(info: { conversation_id?: string; turn_id?: string }) {
  const convoId = String(info?.conversation_id || '').trim();
  const turnId = String(info?.turn_id || '').trim();
  if (turnId && handledLiveTurnIds.has(turnId)) return true;
  if (convoId && cancelledLiveConvoIds.has(convoId)) return true;
  return false;
}

function noteLiveTurnUserCancel(convoId: string | null | undefined, turnId: string | null | undefined) {
  if (convoId) cancelledLiveConvoIds.add(convoId);
  rememberHandledLiveTurn(turnId);
}

function clearLiveTurnUserCancel(convoId: string | null | undefined) {
  if (convoId) cancelledLiveConvoIds.delete(convoId);
}

function markBotsOutboundStopped(convoId: string | null | undefined) {
  if (convoId) botsOutboundStopFlags.add(convoId);
  if (typeof clearBotsInjects === 'function') clearBotsInjects(convoId);
}

function clearBotsOutboundStopped(convoId: string | null | undefined) {
  if (convoId) botsOutboundStopFlags.delete(convoId);
}

function isBotsOutboundStopped(convoId: string | null | undefined) {
  return !!convoId && botsOutboundStopFlags.has(convoId);
}

const cancelInFlight = new Map<string, Promise<boolean>>();

function markOutboundStarting(convoId: string | null | undefined) {
  if (!convoId) return 0;
  const epoch = (outboundStartEpochs.get(convoId) || 0) + 1;
  outboundStartEpochs.set(convoId, epoch);
  outboundStarting.add(convoId);
  if (typeof syncComposerStreamUi === 'function') syncComposerStreamUi();
  return epoch;
}

function outboundStartIsCurrent(convoId: string, epoch: number) {
  return !!convoId && !!epoch && outboundStartEpochs.get(convoId) === epoch;
}

function clearOutboundStarting(convoId: string | null | undefined, epoch: number | null = null) {
  if (!convoId) return;
  if (epoch != null && !outboundStartIsCurrent(convoId, epoch)) return;
  outboundStarting.delete(convoId);
  if (typeof syncComposerStreamUi === 'function') syncComposerStreamUi();
}

function invalidateOutboundStart(convoId: string | null | undefined) {
  if (!convoId) return;
  outboundStartEpochs.set(convoId, (outboundStartEpochs.get(convoId) || 0) + 1);
  outboundStarting.delete(convoId);
  if (typeof syncComposerStreamUi === 'function') syncComposerStreamUi();
}

function scheduleCancel(convoId: string, turnId: string | null | undefined) {
  if (!convoId) return Promise.resolve(true);
  const prev = cancelInFlight.get(convoId) || Promise.resolve(true);
  const next = prev.catch(() => false).then(async () => {
    const controller = new AbortController();
    let timeout: number | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, 6000);
    });
    try {
      const response = await Promise.race([
        fetch('/api/chat/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversation_id: convoId,
            ...(turnId ? { turn_id: turnId } : {}),
          }),
          signal: controller.signal,
        }),
        timedOut,
      ]);
      if (!response) return false;
      if (!response.ok) return false;
      const result: { settled?: boolean } | null = await response.json().catch(() => null);
      return result?.settled === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  });
  cancelInFlight.set(convoId, next);
  next.finally(() => {
    if (cancelInFlight.get(convoId) === next) cancelInFlight.delete(convoId);
  });
  return next;
}

function waitForCancel(convoId: string) {
  const pending = convoId ? cancelInFlight.get(convoId) : null;
  if (!pending) return Promise.resolve();
  // Always continue after the cancel HTTP finishes. A failed/unsettled
  // cancel must not freeze every later prompt on Processing.
  return pending.then(() => {}).catch(() => {});
}

function cancelLiveBodyReader(stream: ActiveStream) {
  const reader = stream?.bodyReader;
  if (!reader || typeof reader.cancel !== 'function') return;
  stream.bodyReader = null;
  try {
    const pending = reader.cancel();
    // cancel() returns a promise. AbortError from an already-aborted
    // BodyStreamBuffer is expected and must not become uncaught.
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch { /* ignore */ }
}

function abortStream(convoId: string | null | undefined, {
  cancelServer = true,
  soft = false,
  preservePartial = false,
} = {}) {
  if (!soft) invalidateOutboundStart(convoId);
  if (cancelServer && !soft) markBotsOutboundStopped(convoId);
  if (cancelServer && !soft && typeof bumpBotsOutboundEpoch === 'function') {
    bumpBotsOutboundEpoch(convoId!);
  }
  const stream = activeStreams.get(convoId!);
  if (stream) {
    if (cancelServer) stream.cancelled = true;
    if (cancelServer && !soft && !preservePartial) stream.hardStopped = true;
    rememberHandledLiveTurn(stream.turnId);
    if (cancelServer && !soft) noteLiveTurnUserCancel(convoId, stream.turnId);
    cancelLiveBodyReader(stream);
    try { stream.controller.abort(); } catch { /* ignore */ }
    if (cancelServer && !soft && !preservePartial) {
      if (typeof discardLiveStreamRow === 'function') discardLiveStreamRow(stream);
      else {
        try { stream.dom?.thinkingOrb?.stop(); } catch { /* ignore */ }
        stream.dom?.row?.remove();
        stream.dom = null;
      }
      if (activeStreams.get(convoId!) === stream) activeStreams.delete(convoId!);
    }
  } else if (cancelServer && !soft) {
    noteLiveTurnUserCancel(convoId, null);
  }
  const cancelDone = cancelServer && convoId
    ? scheduleCancel(convoId!, stream?.turnId || null)
    : Promise.resolve();
  if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
  syncComposerStreamUi();
  return cancelDone;
}

/** Abort the live hop without ending the bots outbound loop. */
function softAbortStream(convoId: string | null | undefined) {
  abortStream(convoId, { cancelServer: true, soft: true });
}

function abortAllStreams({ cancelServer = true } = {}) {
  const ids = new Set([...activeStreams.keys(), ...outboundStarting]);
  for (const id of ids) abortStream(id, { cancelServer });
  if (typeof stopAllBotsOutbound === 'function') stopAllBotsOutbound();
}

function syncComposerStreamUi() {
  const busy = isConvoBusy(activeId);
  // Keep Send visible while streaming so the next message can be queued.
  btnSend.classList.remove('is-hidden');
  btnSend.classList.toggle('is-queueing', busy);
  btnStop.classList.toggle('is-hidden', !busy);
  const botsBusy = busy
    && typeof isBotsConvo === 'function'
    && isBotsConvo(conversations.find((item) => item.id === activeId));
  btnSend.title = busy
    ? (botsBusy ? 'Queue for after this agent turn' : 'Queue message')
    : 'Send message';
  btnSend.setAttribute(
    'aria-label',
    busy
      ? (botsBusy ? 'Queue for after this agent turn' : 'Queue message')
      : 'Send message'
  );
  updateSendEnabled();
  updateComposerHint();
  // Steer appears only while an agent reply can accept mid-turn guidance.
  if (activeId) {
    const convo = conversations.find((c) => c.id === activeId);
    if (convo && getOutboundQueue(activeId).length) renderOutboundQueue(convo);
  }
  if (typeof syncSidebarBusyUi === 'function') syncSidebarBusyUi();
}

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

function clearAllChats() {
  if (!requireUnlockedData()) return;
  const chats = conversations.filter((convo) => !(typeof isBotsConvo === 'function' && isBotsConvo(convo)));
  if (chats.length === 0) return;
  const n = chats.length;
  if (!confirm('Delete all ' + n + ' chat' + (n === 1 ? '' : 's') + '? This cannot be undone.')) return;
  const keep = conversations.filter((convo) => typeof isBotsConvo === 'function' && isBotsConvo(convo));
  const dropIds = new Set(chats.map((convo) => convo.id));
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ conversationIds: [...dropIds], surface: 'chat' });
  for (const id of dropIds) {
    abortStream(id);
    outboundQueues.delete(id);
    stickByConvo.delete(id);
  }
  if (editingQueueId && dropIds.has(activeId!)) {
    editingQueueId = null;
    if (editingRow) {
      editingRow = null;
      mentionInput = composerInput;
      closeMentionMenu();
    }
  }
  conversations = keep;
  if (activeId && !conversations.some((item) => item.id === activeId)) activeId = null;
  saveStore();
  startDraft();
  renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  refreshSettingsDataSummary();
}

function clearAllLoops() {
  if (!requireUnlockedData()) return;
  const loops = conversations.filter((convo) => typeof isBotsConvo === 'function' && isBotsConvo(convo));
  if (loops.length === 0) return;
  const n = loops.length;
  if (!confirm('Delete all ' + n + ' loop' + (n === 1 ? '' : 's') + '? This cannot be undone.')) return;
  const dropIds = new Set(loops.map((convo) => convo.id));
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ conversationIds: [...dropIds], surface: 'bots' });
  for (const id of dropIds) {
    abortStream(id);
    outboundQueues.delete(id);
    stickByConvo.delete(id);
  }
  if (editingQueueId && dropIds.has(activeId!)) {
    editingQueueId = null;
    if (editingRow) {
      editingRow = null;
      mentionInput = composerInput;
      closeMentionMenu();
    }
  }
  conversations = conversations.filter((convo) => !dropIds.has(convo.id));
  const activeWasDeleted = !!activeId && dropIds.has(activeId);
  if (activeWasDeleted) activeId = null;
  saveStore();
  if (activeWasDeleted || (typeof isBotsSurface === 'function' && isBotsSurface())) startDraft();
  else renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  refreshSettingsDataSummary();
}

function clearAllProjects() {
  if (!requireUnlockedData()) return;
  if (projects.length === 0) return;
  const n = projects.length;
  if (!confirm('Delete all ' + n + ' project' + (n === 1 ? '' : 's') + '? Chats move back to Recents.')) return;
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ projectIds: projects.map((project) => project.id) });
  conversations.forEach((convo) => { convo.projectId = null; });
  projects = [];
  activeProjectId = null;
  if (!activeId && typeof restoreComposerDraft === 'function') restoreComposerDraft();
  saveStore();
  renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  else {
    showChatView();
    syncProjectChrome();
  }
  updateGreeting();
  refreshSettingsDataSummary();
}

function clearAllChatsAndProjects() {
  if (!requireUnlockedData()) return;
  if (conversations.length === 0 && projects.length === 0
      && !(typeof hasComposerDrafts === 'function' && hasComposerDrafts())) return;
  if (!confirm('Delete all chats, loops, projects, and drafts in this profile? This cannot be undone.')) return;
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ all: true });
  const dropIds = new Set(conversations.map((convo) => convo.id));
  for (const id of dropIds) {
    abortStream(id);
    outboundQueues.delete(id);
    stickByConvo.delete(id);
  }
  if (editingQueueId && dropIds.has(activeId!)) {
    editingQueueId = null;
    if (editingRow) {
      editingRow = null;
      mentionInput = composerInput;
      closeMentionMenu();
    }
  }
  conversations = [];
  projects = [];
  activeId = null;
  activeProjectId = null;
  saveStore();
  startDraft();
  renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  updateGreeting();
  refreshSettingsDataSummary();
}

let pendingChatBackgroundImage = '';
let pendingChatBackgroundImageName = '';

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
      || 'manual',
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
    : 'manual';
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

function syncThinkingEffortControls(effort: string) {
  const value = availableThinkingEfforts.has(effort!) ? effort! : 'auto';
  const setting = (document.getElementById('settingThinkingEffort') as HTMLSelectElement);
  if (setting && setting.value !== value) setting.value = value;

  const btn = (document.getElementById('btnThink') as HTMLButtonElement);
  const effortEl = (document.getElementById('btnThinkEffort') as HTMLElement);
  const menu = (document.getElementById('thinkMenu') as HTMLElement);
  const suffix = value === 'auto' ? '' : (value === 'medium' ? 'med' : value);
  if (effortEl) {
    if (suffix) {
      effortEl.textContent = suffix;
      effortEl.classList.remove('is-hidden');
      effortEl.classList.toggle('is-off', value === 'off');
    } else {
      effortEl.textContent = '';
      effortEl.classList.add('is-hidden');
      effortEl.classList.remove('is-off');
    }
  }
  if (btn) {
    btn.classList.toggle('is-active', value !== 'auto' && value !== 'off');
    btn.title = 'Thinking intensity: ' + value + ' — how hard reasoning models should think';
  }
  if (menu) {
    (menu.querySelectorAll('[data-effort]') as NodeListOf<HTMLElement>).forEach((item) => {
      item.classList.toggle('is-active', item.dataset.effort === value);
      item.setAttribute('aria-checked', item.dataset.effort === value ? 'true' : 'false');
    });
  }
}

function thinkMenuIsOpen() {
  const menu = (document.getElementById('thinkMenu') as HTMLElement);
  return !!(menu && !menu.classList.contains('is-hidden') && menu.classList.contains('is-open'));
}

function setThinkMenuOpen(open: boolean) {
  const menu = (document.getElementById('thinkMenu') as HTMLElement);
  const btn = (document.getElementById('btnThink') as HTMLButtonElement);
  if (!menu || !btn) return;
  if (thinkMenuCloseTimer) {
    window.clearTimeout(thinkMenuCloseTimer);
    thinkMenuCloseTimer = 0;
  }
  if (open) {
    setPlusMenuOpen(false);
    if (typeof setWordmarkMenuOpen === 'function') setWordmarkMenuOpen(false);
    menu.classList.remove('is-hidden');
    btn.setAttribute('aria-expanded', 'true');
    void menu.offsetWidth;
    afterNextPaint(() => {
      if (btn.getAttribute('aria-expanded') === 'true') menu.classList.add('is-open');
    });
    return;
  }
  menu.classList.remove('is-open');
  btn.setAttribute('aria-expanded', 'false');
  const finish = () => {
    menu.classList.add('is-hidden');
    thinkMenuCloseTimer = 0;
  };
  if (prefersReducedMotion()) {
    finish();
    return;
  }
  thinkMenuCloseTimer = window.setTimeout(finish, 180);
}

let plusMenuCloseTimer = 0;

const PLUS_CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function plusMenuIcons() {
  return {
    attach:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    search:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/><path d="M3 12h18"/><path d="M3.6 8h16.8"/><path d="M3.6 16h16.8"/></svg>',
    fetch:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    research:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10.5 14.5-6 6"/><path d="m14 6 4 4"/><path d="M15.2 4.8a2.2 2.2 0 0 1 3.1 3.1L10.5 15.7 7.3 12.5Z"/><path d="M4 20h5"/><path d="M6.5 17.5v5"/></svg>',
    agent:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>',
    terminal:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>',
  };
}

function renderPlusMenuItem({ id, iconClass, icon, title, desc, descHtml, badge, on, disabled, titleAttr }: PlusMenuItem) {
  const btn = (document.createElement('button') as HTMLButtonElement);
  btn.type = 'button';
  btn.className = 'plus-menu-item' + (on ? ' is-on' : '');
  btn.dataset.plusAction = id;
  btn.setAttribute('role', 'menuitem');
  if (disabled) btn.disabled = true;
  if (titleAttr) btn.title = titleAttr;
  const descPart = descHtml
    ? '<span class="plus-menu-desc">' + descHtml + '</span>'
    : (desc
      ? '<span class="plus-menu-desc">' + escapeHtml(desc) + '</span>'
      : '');
  const badgePart = badge
    ? '<span class="plus-menu-badge">' + escapeHtml(badge) + '</span>'
    : '';
  btn.innerHTML =
    '<span class="plus-menu-icon ' + iconClass + '" aria-hidden="true">' + icon + '</span>' +
    '<span class="plus-menu-copy">' +
      '<span class="plus-menu-title">' + escapeHtml(title) + '</span>' +
      descPart +
    '</span>' +
    '<span class="plus-menu-trail">' +
      badgePart +
      '<span class="plus-menu-check" aria-hidden="true">' + PLUS_CHECK_SVG + '</span>' +
    '</span>';
  return btn;
}

function renderPlusMenu() {
  if (!plusMenu) return;
  const icons = plusMenuIcons();
  const attachEnabled = attachmentsUiEnabled() && serverReady && !diskEncryptionLocked();
  const attachReason = attachDisabledReason();
  const researchAllowed = settings.skillDeepResearch !== false;
  const agentOn = !!settings.agentMode;

  plusMenu.innerHTML = '';
  plusMenu.appendChild(renderPlusMenuItem({
    id: 'agent',
    iconClass: 'is-agent',
    icon: icons.agent,
    title: 'Agent mode',
    desc: agentOn
      ? 'All agent skills available when needed'
      : 'Unlocks all agent skills when needed',
    badge: 'Recommended',
    on: agentOn,
    disabled: false,
  }));
  plusMenu.appendChild(renderPlusMenuItem({
    id: 'attach',
    iconClass: 'is-attach',
    icon: icons.attach,
    title: 'Add photos & files',
    desc: attachEnabled ? 'Upload from computer' : (attachReason || 'Configure in Settings'),
    on: false,
    disabled: false,
    titleAttr: attachEnabled ? 'Attach files' : (attachReason || 'Go to Settings → Attachments'),
  }));
  if (settings.skillWebSearch !== false) {
    plusMenu.appendChild(renderPlusMenuItem({
      id: 'web_search',
      iconClass: 'is-search',
      icon: icons.search,
      title: agentOn ? 'Require web search' : 'Web search',
      desc: agentOn
        ? 'Must search before answering'
        : 'Keep enabled for this chat',
      on: composerMentionIds.has('web_search'),
      disabled: false,
    }));
  }
  if (settings.skillFetchUrl !== false) {
    plusMenu.appendChild(renderPlusMenuItem({
      id: 'fetch_url',
      iconClass: 'is-fetch',
      icon: icons.fetch,
      title: agentOn ? 'Require fetch URL' : 'Fetch URL',
      desc: agentOn
        ? 'Must open a page before answering'
        : 'Keep enabled for this chat',
      on: composerMentionIds.has('fetch_url'),
      disabled: false,
    }));
  }
  if (researchAllowed) {
    plusMenu.appendChild(renderPlusMenuItem({
      id: 'deep_research_long',
      iconClass: 'is-research',
      icon: icons.research,
      title: 'Deep research · comprehensive',
      desc: 'Detailed report from many sources',
      on: settings.deepResearch === 'long',
      disabled: false,
    }));
    plusMenu.appendChild(renderPlusMenuItem({
      id: 'deep_research_brief',
      iconClass: 'is-research',
      icon: icons.research,
      title: 'Deep research · concise',
      desc: 'Brief answer from many sources',
      on: settings.deepResearch === 'brief',
      disabled: false,
    }));
  }
  plusMenu.appendChild(renderPlusMenuItem({
    id: 'terminal',
    iconClass: 'is-agent',
    icon: icons.terminal,
    title: 'Terminal',
    desc: 'Open a command panel under the chat box',
    on: !!terminalOpen,
    disabled: false,
  }));
}

function renderComposerModes() {
  if (!composerModes) return;
  composerModes.innerHTML = '';
  const researchOn = settings.skillDeepResearch !== false
    && (settings.deepResearch === 'long' || settings.deepResearch === 'brief');
  if (settings.agentMode) {
    const chip = (document.createElement('span') as HTMLElement);
    chip.className = 'composer-mode-chip is-agent-available';
    const forced = [];
    if (composerMentionIds.has('web_search')) forced.push('web_search');
    if (composerMentionIds.has('fetch_url')) forced.push('fetch_url');
    const label = forced.length
      ? 'Agent · required skills'
      : 'Agent · skills when needed';
    chip.innerHTML = '<span>' + escapeHtml(label) + '</span>';
    chip.title = forced.length
      ? 'Pinned skills are required this turn: ' + forced.join(', ')
      : 'Recommended — all agent skills are available; the model uses them when needed';
    const remove = (document.createElement('button') as HTMLButtonElement);
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Turn off agent mode');
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      if (!requireUnlockedData()) return;
      settings.agentMode = false;
      saveSettings({ ...settings });
    });
    chip.appendChild(remove);
    composerModes.appendChild(chip);
  }
  if (researchOn) {
    const chip = (document.createElement('span') as HTMLElement);
    chip.className = 'composer-mode-chip';
    const style = settings.deepResearch === 'brief' ? 'concise' : 'comprehensive';
    chip.innerHTML = '<span>Research · ' + escapeHtml(style) + '</span>';
    const remove = (document.createElement('button') as HTMLButtonElement);
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Turn off deep research');
    remove.textContent = '×';
    remove.addEventListener('click', () => setDeepResearch('off', true));
    chip.appendChild(remove);
    composerModes.appendChild(chip);
  }
  if (!settings.agentMode && !researchOn && composerMentionIds.size === 0) {
    const empty = (document.createElement('span') as HTMLElement);
    empty.className = 'composer-capabilities-empty';
    empty.textContent = 'No agent capabilities enabled';
    composerModes.appendChild(empty);
  }
}

function plusMenuIsOpen() {
  return !!(plusMenu && !plusMenu.classList.contains('is-hidden') && plusMenu.classList.contains('is-open'));
}

function placePlusMenu() {
  if (!plusMenu || !composerCard) return;
  plusMenu.classList.remove('is-above');
  plusMenu.style.maxHeight = '';
  const gap = 10;
  const cardRect = composerCard.getBoundingClientRect();
  const spaceBelow = Math.max(0, window.innerHeight - cardRect.bottom - gap);
  const spaceAbove = Math.max(0, cardRect.top - gap);
  const natural = plusMenu.scrollHeight;
  const cap = Math.min(22 * 16, window.innerHeight - gap * 2);
  const openAbove = spaceBelow < Math.min(natural, 12 * 16) && spaceAbove > spaceBelow;
  if (openAbove) {
    plusMenu.classList.add('is-above');
    plusMenu.style.maxHeight = Math.min(cap, spaceAbove) + 'px';
  } else {
    plusMenu.style.maxHeight = Math.min(cap, Math.max(spaceBelow, 8 * 16)) + 'px';
  }
}

function setPlusMenuOpen(open: boolean) {
  if (!plusMenu || !btnPlus) return;
  if (plusMenuCloseTimer) {
    window.clearTimeout(plusMenuCloseTimer);
    plusMenuCloseTimer = 0;
  }
  if (open) {
    if (thinkMenuIsOpen()) setThinkMenuOpen(false);
    if (typeof setWordmarkMenuOpen === 'function') setWordmarkMenuOpen(false);
    renderPlusMenu();
    plusMenu.classList.remove('is-hidden');
    placePlusMenu();
    btnPlus.setAttribute('aria-expanded', 'true');
    btnPlus.title = 'Close';
    btnPlus.setAttribute('aria-label', 'Close');
    void plusMenu.offsetWidth;
    afterNextPaint(() => {
      if (btnPlus.getAttribute('aria-expanded') === 'true') plusMenu.classList.add('is-open');
    });
    return;
  }
  plusMenu.classList.remove('is-open');
  btnPlus.setAttribute('aria-expanded', 'false');
  btnPlus.title = 'Add files and capabilities';
  btnPlus.setAttribute('aria-label', 'Add files and capabilities');
  const finish = () => {
    plusMenu.classList.add('is-hidden');
    plusMenu.classList.remove('is-above');
    plusMenu.style.maxHeight = '';
    plusMenuCloseTimer = 0;
  };
  if (prefersReducedMotion()) {
    finish();
    return;
  }
  plusMenuCloseTimer = window.setTimeout(finish, 180);
}

function toggleComposerMention(id: string) {
  if (composerMentionIds.has(id)) composerMentionIds.delete(id);
  else composerMentionIds.add(id);
  renderComposerMentions();
  renderComposerModes();
  syncPlusButton();
  renderPlusMenu();
  composerInput.focus();
}

function handlePlusMenuAction(action: string | undefined) {
  if (action === 'attach') {
    const enabled = attachmentsUiEnabled() && serverReady && !diskEncryptionLocked();
    setPlusMenuOpen(false);
    if (!enabled) {
      openSettings();
      showSettingsPane('attachments');
      return;
    }
    attachFileInput.click();
    return;
  }
  if (action === 'web_search') {
    if (settings.skillWebSearch === false) return;
    toggleComposerMention('web_search');
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'fetch_url') {
    if (settings.skillFetchUrl === false) return;
    toggleComposerMention('fetch_url');
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'deep_research_long') {
    if (settings.skillDeepResearch === false) return;
    setDeepResearch(settings.deepResearch === 'long' ? 'off' : 'long', true);
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'deep_research_brief') {
    if (settings.skillDeepResearch === false) return;
    setDeepResearch(settings.deepResearch === 'brief' ? 'off' : 'brief', true);
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'agent') {
    if (!requireUnlockedData()) return;
    settings.agentMode = !settings.agentMode;
    saveSettings({ ...settings });
    setPlusMenuOpen(false);
    return;
  }
  if (action === 'terminal') {
    setPlusMenuOpen(false);
    if (typeof toggleTerminalPanel === 'function') toggleTerminalPanel();
  }
}

function syncResearchControls() {
  const allowed = settings.skillDeepResearch !== false;
  if (!allowed && settings.deepResearch !== 'off') {
    settings.deepResearch = 'off';
  }
  renderComposerModes();
  renderPlusMenu();
  syncPlusButton();
}

function setDeepResearch(mode: string, persist: boolean) {
  if (settings.skillDeepResearch === false && mode !== 'off') return;
  const value = DEEP_RESEARCH_MODES.includes(mode) ? mode : 'off';
  settings.deepResearch = value;
  syncResearchControls();
  updateComposerHint();
  if (persist) {
    saveSettings({
      ...settings,
      deepResearch: value,
    });
  }
}

let thinkingSupported = false;
let activeThinkingEffort = 'auto';
let availableThinkingEfforts = new Set(['auto']);

function modelExposesThinkingControl(model: ModelOption | null | undefined): model is ModelOption {
  if (!model || !model.thinking_control) return false;
  const efforts = Array.isArray(model.thinking_efforts) ? model.thinking_efforts : [];
  return efforts.length > 0 || !!model.thinking_can_disable;
}

function thinkingEffortForModel(model: ModelOption | null | undefined) {
  if (!modelExposesThinkingControl(model)) return null;
  const efforts = Array.isArray(model.thinking_efforts) ? model.thinking_efforts : [];
  const canDisable = !!model.thinking_can_disable;
  const wanted = String(settings.thinkingEffort || activeThinkingEffort || 'auto');
  if (wanted === 'auto') return null;
  if (wanted === 'off') return canDisable ? 'off' : null;
  return efforts.includes(wanted) ? wanted : null;
}

function renderThinkingEffortOptions(values: string[]) {
  // Presentation order only: the catalog still determines which values exist.
  // Provider-specific tiers retain their catalog order after the familiar levels.
  const displayOrder = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const rank = (value: string) => {
    const index = displayOrder.indexOf(value.toLowerCase());
    return index < 0 ? displayOrder.length : index;
  };
  values = [...values].sort((left, right) => rank(left) - rank(right));
  const signature = JSON.stringify(values);
  const menu = (document.getElementById('thinkMenu') as HTMLElement);
  const setting = (document.getElementById('settingThinkingEffort') as HTMLSelectElement);
  for (const container of [menu, setting]) {
    if (!container || container.dataset.efforts === signature) continue;
    container.dataset.efforts = signature;
    const items: HTMLElement[] = values.map((value: string) => {
      const item = (document.createElement(container === menu ? 'button' : 'option') as HTMLButtonElement | HTMLOptionElement);
      item.textContent = value === 'auto' && container === setting
        ? 'Auto (model default)'
        : value.charAt(0).toUpperCase() + value.slice(1);
      if (container === menu) {
        (item as HTMLButtonElement).type = 'button';
        item.setAttribute('role', 'menuitemradio');
        item.dataset.effort = value;
      } else {
        item.value = value;
      }
      return item;
    });
    if (container === menu) {
      const label = (document.createElement('div') as HTMLElement);
      label.className = 'think-menu-label';
      label.textContent = 'Intensity';
      items.unshift(label);
    }
    container.replaceChildren(...items);
  }
}

function syncComposerThinkVisibility(model: ModelOption | null | undefined) {
  const efforts = Array.isArray(model?.thinking_efforts) ? model.thinking_efforts : [];
  const canDisable = !!model?.thinking_can_disable;
  thinkingSupported = modelExposesThinkingControl(model);
  const onLoop = typeof isBotsSurface === 'function' && isBotsSurface();
  availableThinkingEfforts = new Set([
    'auto',
    ...(thinkingSupported && canDisable ? ['off'] : []),
    ...(thinkingSupported ? efforts : []),
  ]);
  activeThinkingEffort = availableThinkingEfforts.has(settings.thinkingEffort) ? settings.thinkingEffort : 'auto';
  renderThinkingEffortOptions([...availableThinkingEfforts]);
  const wrap = (document.getElementById('composerThinkWrap') as HTMLElement);
  if (!wrap) return;
  wrap.classList.toggle('is-hidden', onLoop || !thinkingSupported);
  if (onLoop || !thinkingSupported) setThinkMenuOpen(false);
  const effort = (document.getElementById('settingThinkingEffort') as HTMLSelectElement);
  const effortRow = effort && (effort.closest('.settings-row') as HTMLElement);
  if (effort) {
    effort.disabled = !thinkingSupported;
    if (effortRow) {
      effortRow.style.opacity = thinkingSupported ? '' : '0.55';
      effortRow.title = thinkingSupported
        ? ''
        : 'Current model does not expose controllable thinking.';
    }
  }
  syncThinkingEffortControls(activeThinkingEffort);
}

function setThinkingEffort(effort: string | undefined, persist = true) {
  const value = availableThinkingEfforts.has(effort!) ? effort! : 'auto';
  activeThinkingEffort = value;
  syncThinkingEffortControls(value);
  if (persist) {
    if (!requireUnlockedData()) {
      syncThinkingEffortControls(settings.thinkingEffort);
      return;
    }
    saveSettings({ ...settings, thinkingEffort: value });
  }
}

async function commitSettings() {
  if (!requireUnlockedData()) return;
  const backgroundUrl = (document.getElementById('settingChatBackgroundUrl') as HTMLInputElement);
  if (pendingChatBackgroundImage && !normalizeChatBackgroundImage(pendingChatBackgroundImage)) {
    backgroundUrl?.reportValidity();
    backgroundUrl?.focus();
    return;
  }
  if (!settingsFormIsDirty()) {
    syncSettingsSaveButton({ saved: true });
    return;
  }
  const next = readSettingsForm();
  if (!next.skillDeepResearch) {
    next.deepResearch = 'off';
  }
  const previous = settings;
  syncSettingsSaveButton({ saving: true });
  const saved = await saveSettings(next, { immediate: true });
  if (!saved) {
    if (!diskEncryptionLocked()) {
      applySettingsInMemory(previous);
      syncSettingsSaveButton({ failed: true });
    }
    return;
  }
  if (typeof hydrateModelPickerState === 'function') hydrateModelPickerState();
  if (next.selectedChatModel) {
    rememberRecentModel(next.selectedChatModel);
  }
  if (latestState && typeof syncModelSelector === 'function') syncModelSelector(latestState);
  syncThinkingEffortControls(settings.thinkingEffort);
  syncResearchControls();
  syncAttachButton();
  syncSettingsSaveButton({ saved: true });
  const convo = conversations.find((item) => item.id === activeId);
  if (convo) renderThread(convo);
}
