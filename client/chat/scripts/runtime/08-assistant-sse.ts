/** The server's turn metadata: its id (so the turn is not resumed twice) and its mode and model. */
function sseMeta(stream: ActiveStream, data: string) {
  try {
    const meta: Partial<AdvertisedLiveTurn> = JSON.parse(data);
    if (meta.turn_id) {
      stream.turnId = String(meta.turn_id);
      stream.serverTurnSeenAt = performance.now();
      if (typeof rememberHandledLiveTurn === 'function') {
        rememberHandledLiveTurn(stream.turnId);
      }
    }
    if (typeof meta.agent === 'boolean') stream.useAgent = meta.agent;
    if (typeof meta.deep_research === 'boolean') stream.deepResearch = meta.deep_research;
    if (meta.deep_research_output === 'brief' || meta.deep_research_output === 'long') {
      stream.deepResearchOutput = meta.deep_research_output;
    }
    if (meta.model) stream.turnModel = String(meta.model);
    if (typeof meta.finished === 'boolean') stream.serverFinished = meta.finished;
  } catch {
    // ignore malformed meta
  }
}

/** A chat-completions frame: usage, prompt progress, reasoning and visible text. */
function sseCompletionFrame(turn: SseTurn, data: string) {
  const { convo, stream, typer, usageStats, remote } = turn;
  let json: BrowserCompletionFrame;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }
  ingestStreamUsage(usageStats, json);
  if (activeId === convo.id) syncContextUsage(convo, usageStats, remote);
  const progressLabel = promptProgressLabel(json.prompt_progress);
  if (progressLabel && turn.firstTokenAt == null) setStreamThinkingLabel(stream, progressLabel);
  const choice = json.choices && json.choices[0];
  const deltaObj = (choice && choice.delta) || {};
  const reasoning =
    deltaObj.reasoning_content ||
    deltaObj.reasoning ||
    (choice && choice.message && (choice.message.reasoning_content || choice.message.reasoning)) ||
    '';
  if (reasoning) {
    sseMarkFirstToken(turn, 'reasoning');
    typer.pushReasoning(String(reasoning));
  }
  const delta = deltaObj.content || '';
  if (delta) {
    sseMarkFirstToken(turn, 'content');
    typer.push(delta);
  }
}

/** One SSE event: metadata, the end of a replay, an error, an agent event, or a completion frame. */
function handleSseFrame(turn: SseTurn, rawEvent: string) {
  const { stream, typer, fallbackTurnModel } = turn;
  const parsed = parseSseEvent(rawEvent);
  if (!parsed || parsed.data === '' || parsed.data === '[DONE]') return;
  if (parsed.event === 'meta') { sseMeta(stream, parsed.data); return; }
  if (parsed.event === 'live') {
    // Replay is over; the typer stops fast-forwarding.
    stream.catchingUp = false;
    typer.setCatchingUp(false);
    if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    return;
  }
  if (parsed.event === 'error') {
    try {
      stream.errorMessage = contextualModelError(
        JSON.parse(parsed.data).error || parsed.data,
        stream.turnModel || fallbackTurnModel
      );
    } catch {
      stream.errorMessage = contextualModelError(
        parsed.data,
        stream.turnModel || fallbackTurnModel
      );
    }
    return;
  }
  if (parsed.event === 'agent') {
    try {
      sseAgentEvent(turn, JSON.parse(parsed.data));
    } catch {
      // ignore malformed agent frames
    }
    return;
  }
  sseCompletionFrame(turn, parsed.data);
}

/** Read the response body until it ends or the stream is cancelled or replaced. */
async function readSseBody(turn: SseTurn, response: Response) {
  const { convo, stream } = turn;
  const reader = response.body!.getReader();
  stream.bodyReader = reader;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (stream.cancelled || stream.replaced || stream.controller.signal.aborted) break;
      const next = await readStreamChunk(reader, stream.controller.signal);
      if (next.aborted || stream.cancelled || stream.replaced) break;
      const { value, done } = next.chunk;
      if (done) break;
      if (!stream.diagnosticFirstByte) {
        stream.diagnosticFirstByte = true;
        if (typeof diagnosticStreamMark === 'function') diagnosticStreamMark(stream, convo, 'browser.first_byte', { bytes: value.byteLength });
      }
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const rawEvent of events) handleSseFrame(turn, rawEvent);
    }
  } finally {
    stream.bodyReader = null;
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

/**
 * A failed read. An abort from replacement or a non-user cancel ends the turn here (returns true);
 * any other failure becomes the turn's error message and the turn is finalized as usual.
 */
function sseReadFailed(turn: SseTurn, error: unknown): boolean {
  const { convo, stream, fallbackTurnModel } = turn;
  if ((error as Error).name === 'AbortError') {
    if (stream.replaced) {
      dropLiveSubscriber(convo.id, stream);
      return true;
    }
    if (!stream.cancelled) {
      dropLiveSubscriber(convo.id, stream);
      if (!stream.skipQueue) maybeSendNextQueued(convo.id);
      return true;
    }
  } else {
    stream.errorMessage = contextualModelError(
      (error as Error).message,
      stream.turnModel || fallbackTurnModel
    );
  }
  return false;
}

/** Stream one assistant reply into the conversation, then save it and send the next queued message. */
async function driveAssistantSse(convo: Conversation, stream: ActiveStream, response: Response | null) {
  const turn = createSseTurn(convo, stream);
  if (stream.catchingUp) turn.typer.setCatchingUp(true);
  try {
    if (response && response.body) await readSseBody(turn, response);
  } catch (error) {
    if (sseReadFailed(turn, error)) return;
  }
  const flow: SseFlow = { queueAfter: !stream.skipQueue && !stream.replaced };
  try {
    finalizeSseTurn(turn, flow);
  } catch (error) {
    console.warn('Assistant turn finalize failed:', (error as Error)?.message || error);
    if (!stream.errorMessage) {
      stream.errorMessage = (error as Error)?.message || 'The request failed.';
    }
  } finally {
    const finished = activeStreams.get(convo.id) === stream && finishLiveStream(convo.id, stream);
    if (finished && flow.queueAfter) {
      maybeSendNextQueued(convo.id);
    }
    if (!stream.skipQueue && typeof flushBotNavigation === 'function') {
      flushBotNavigation();
    }
  }
}


chatThread.addEventListener('click', (event) => {
  const queueSteer = ((event.target as Element).closest('[data-queue-steer]') as HTMLElement);
  if (queueSteer && chatThread.contains(queueSteer)) {
    event.preventDefault();
    const queueId = queueSteer.getAttribute('data-queue-steer');
    if (activeId && queueId) steerQueuedOutbound(activeId, queueId);
    return;
  }
  const steerCancel = ((event.target as Element).closest('[data-steer-cancel]') as HTMLElement);
  if (steerCancel && chatThread.contains(steerCancel)) {
    event.preventDefault();
    const queueId = steerCancel.getAttribute('data-steer-cancel');
    if (activeId && queueId) cancelPendingSteer(activeId, queueId);
    return;
  }
  const queueRemove = ((event.target as Element).closest('[data-queue-remove]') as HTMLElement);
  if (queueRemove && chatThread.contains(queueRemove)) {
    event.preventDefault();
    const queueId = queueRemove.getAttribute('data-queue-remove');
    if (activeId && queueId) removeQueuedOutbound(activeId, queueId);
    return;
  }
  const queueEdit = ((event.target as Element).closest('[data-queue-edit]') as HTMLElement);
  if (queueEdit && chatThread.contains(queueEdit)) {
    event.preventDefault();
    const queueId = queueEdit.getAttribute('data-queue-edit');
    const row = queueId
      ? [...(chatThread.querySelectorAll('.msg-queued') as NodeListOf<HTMLElement>)].find((el) => el.dataset.queueId === queueId)
      : null;
    if (row) beginQueuedMessageEdit(row);
    return;
  }
  const clarifySubmit = ((event.target as Element).closest('[data-clarify-submit]') as HTMLElement);
  if (clarifySubmit && chatThread.contains(clarifySubmit)) {
    event.preventDefault();
    const clarifyId = clarifySubmit.getAttribute('data-clarify-submit');
    const stream = activeStream();
    if (stream && clarifyId) void submitClarifyForm(stream, clarifyId);
    return;
  }
  const allowBtn = ((event.target as Element).closest('[data-tool-allow]') as HTMLElement);
  const denyBtn = ((event.target as Element).closest('[data-tool-deny]') as HTMLElement);
  if ((allowBtn || denyBtn) && chatThread.contains(allowBtn || denyBtn)) {
    event.preventDefault();
    const id = (allowBtn || denyBtn)!.getAttribute(allowBtn ? 'data-tool-allow' : 'data-tool-deny');
    if (id) void submitToolApproval(id, !!allowBtn);
    return;
  }
  const foldToggle = ((event.target as Element).closest('.agent-timeline-fold-toggle') as HTMLElement);
  if (foldToggle && chatThread.contains(foldToggle)) {
    event.preventDefault();
    const fold = (foldToggle.closest('.agent-timeline-fold') as HTMLElement);
    if (!fold) return;
    const collapsed = fold.classList.toggle('is-collapsed');
    foldToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (fold.classList.contains('agent-process-notes')) {
      const row = (fold.closest('.msg-role-assistant') as HTMLElement);
      const live = row && activeId ? activeStreams.get(activeId) : null;
      if (live && live.dom?.row === row) live.processNotesCollapsed = collapsed;
    }
    return;
  }
  const btn = ((event.target as Element).closest('.md-code-copy') as HTMLElement);
  if (btn && chatThread.contains(btn)) {
    event.preventDefault();
    copyCodeBlock(btn);
    return;
  }
  if (((event.target as Element).closest('.msg-action, a, button, summary, details, input, textarea, .clarify-card, #selectionReplyBar') as HTMLElement)) {
    return;
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && String(sel.toString() || '').trim()) {
    // Don't steal focus from a text selection / Reply affordance.
    return;
  }
  const row = ((event.target as Element).closest('.msg-role-assistant') as HTMLElement);
  if (!row || !chatThread.contains(row)) return;
  const index = Number(row.dataset.msgIndex);
  if (!Number.isFinite(index)) return;
  selectTraceMessage(index, { animate: true, ensureOpen: false });
});

document.addEventListener('click', (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = ((event.target as Element).closest?.('a[href]') as HTMLAnchorElement);
  const source = link && chatSourceTarget(link.getAttribute('href'));
  if (!source) return;
  event.preventDefault();
  event.stopPropagation();
  if (!conversations.some((chat) => chat.id === source.id) || diskEncryptionLocked()) {
    alert('This source chat is no longer available in the current profile.');
    return;
  }
  selectConversation(source.id);
  scrollToChatSource(source.message);
}, true);

document.addEventListener('click', (event) => {
  const allowBtn = ((event.target as Element).closest('[data-tool-allow]') as HTMLElement);
  const denyBtn = ((event.target as Element).closest('[data-tool-deny]') as HTMLElement);
  if (!allowBtn && !denyBtn) return;
  if (chatThread.contains(allowBtn || denyBtn)) return;
  event.preventDefault();
  const id = (allowBtn || denyBtn)!.getAttribute(allowBtn ? 'data-tool-allow' : 'data-tool-deny');
  if (id) void submitToolApproval(id, !!allowBtn);
});

chatThread.addEventListener('change', (event) => {
  const input = ((event.target as Element).closest('.clarify-card input') as HTMLInputElement);
  if (!input || !chatThread.contains(input)) return;
  const card = (input.closest('.clarify-card') as HTMLElement);
  const host = (card?.closest('.clarify-host') as HTMLElement);
  const clarifyId = card?.dataset.clarifyId;
  const stream = activeStream();
  const part = stream && clarifyId ? findClarifyPart(stream, clarifyId) : null;
  if (!part || !part.live) return;
  const qi = Number(input.dataset.clarifyQ);
  if (!Number.isFinite(qi)) return;
  if (!part.draft) part.draft = {};
  const qEl = (card.querySelector('.clarify-q[data-clarify-q="' + qi + '"]') as HTMLElement);
  const multi = !!part.questions?.[qi]?.multiSelect;
  if (input.dataset.clarifyOther) {
    if (input.checked) {
      if (!multi) {
        qEl?.querySelectorAll<HTMLInputElement>('input[data-clarify-opt]').forEach((el) => { el.checked = false; });
      }
      part.draft[qi] = {
        labels: [],
        custom: String((qEl?.querySelector('[data-clarify-custom]') as HTMLInputElement)?.value || ''),
        useCustom: true,
      };
    }
  } else if (input.dataset.clarifyOpt != null) {
    const other = (qEl?.querySelector('input[data-clarify-other]') as HTMLInputElement);
    if (other && !multi) other.checked = false;
    const labels = [...((qEl?.querySelectorAll('input[data-clarify-opt]:checked') as NodeListOf<HTMLInputElement>) || [])].map((el) => el.value);
    part.draft[qi] = {
      labels,
      custom: String(part.draft[qi]?.custom || ''),
      useCustom: false,
    };
  }
  mountClarifyForm(stream!, part);
  const custom = (host?.querySelector('.clarify-q[data-clarify-q="' + qi + '"] [data-clarify-custom]') as HTMLInputElement);
  if (part.draft[qi]?.useCustom && custom) {
    custom.focus();
    custom.selectionStart = custom.value.length;
  }
});

chatThread.addEventListener('input', (event) => {
  const custom = ((event.target as Element).closest('[data-clarify-custom]') as HTMLInputElement);
  if (!custom || !chatThread.contains(custom)) return;
  const card = (custom.closest('.clarify-card') as HTMLElement);
  const host = (card?.closest('.clarify-host') as HTMLElement);
  const clarifyId = card?.dataset.clarifyId;
  const stream = activeStream();
  const part = stream && clarifyId ? findClarifyPart(stream, clarifyId) : null;
  if (!part || !part.live) return;
  const qi = Number(custom.dataset.clarifyQ);
  if (!Number.isFinite(qi)) return;
  if (!part.draft) part.draft = {};
  part.draft[qi] = {
    labels: [],
    custom: custom.value,
    useCustom: true,
  };
  syncClarifySubmitEnabled(host);
});

btnSend.addEventListener('click', () => { void sendMessage(); });
btnBranch?.addEventListener('click', () => { void sendMessage({ branch: true }); });
btnSelectionReply?.addEventListener('mousedown', (event) => {
  // Keep the selection until we capture it in the click handler.
  event.preventDefault();
});
btnSelectionReply?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const quote = assistantSelectionQuote();
  if (quote) {
    const index = Number(quote.row?.dataset.msgIndex);
    const convo = conversations.find((item) => item.id === activeId);
    const message = Number.isInteger(index) ? convo?.messages?.[index] : null;
    setPendingReply(quote.text, resolveReplySpeaker(convo, quote.row, message));
  } else {
    hideSelectionReplyBar();
  }
});
document.addEventListener('selectionchange', () => {
  // Defer so mouseup can finish updating the range first.
  queueMicrotask(syncSelectionReplyBar);
});
document.addEventListener('mouseup', () => {
  queueMicrotask(syncSelectionReplyBar);
});
chatViewport?.addEventListener('scroll', hideSelectionReplyBar, { passive: true });
window.addEventListener('scroll', hideSelectionReplyBar, true);
window.addEventListener('resize', hideSelectionReplyBar);
