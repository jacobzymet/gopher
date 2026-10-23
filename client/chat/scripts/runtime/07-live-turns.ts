function dropLiveSubscriber(convoId: string, stream: ActiveStream) {
  if (activeStreams.get(convoId) !== stream) return;
  discardLiveStreamRow(stream);
  activeStreams.delete(convoId);
  renderSidebar();
  syncComposerStreamUi();
}

function finishLiveStream(convoId: string, stream: ActiveStream) {
  if (!stream || activeStreams.get(convoId) !== stream) return false;
  try { stream.dom?.thinkingOrb?.stop(); } catch { /* ignore */ }
  activeStreams.delete(convoId);
  reclaimUnappliedSteers(convoId, stream);
  renderSidebar();
  syncComposerStreamUi();
  const convo = conversations.find((item) => item.id === convoId);
  // Give single-slot providers time to release the completed generation
  // before starting the small title job.
  if (convo) maybeEnsureConversationTitle(convo, { delay: 500 });
  return true;
}

function commitLiveAssistant(convo: Conversation, message: ChatMessage, turnId?: string | null) {
  if (turnId) message.liveTurnId = turnId;
  const existing = turnId
    ? convo.messages.find(
      (item) => item.role === 'assistant' && item.liveTurnId === turnId
    )
    : null;
  if (existing) {
    Object.assign(existing, message);
    return existing;
  }
  const insertAt = liveTurnSlices(convo).followUpStart;
  if (insertAt < convo.messages.length) convo.messages.splice(insertAt, 0, message);
  else convo.messages.push(message);
  return message;
}

function liveTurnSlices(convo: Conversation) {
  const messages = convo.messages || [];
  let lastAsst = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant') lastAsst = i;
  }
  const rest = messages.slice(lastAsst + 1);
  const prompt = rest[0] || null;
  const afterPrompt = rest.slice(1);
  let steerCount = 0;
  while (steerCount < afterPrompt.length && afterPrompt[steerCount]?.steered) {
    steerCount += 1;
  }
  return {
    lastAsst,
    head: messages.slice(0, lastAsst + 1),
    prompt,
    promptIndex: lastAsst + 1,
    steers: afterPrompt.slice(0, steerCount),
    followUps: afterPrompt.slice(steerCount),
    followUpStart: lastAsst + 2 + steerCount,
  };
}

async function syncConvoFromStore(convoId: string) {
  try {
    const response = await fetch('/api/data/store');
    if (!response.ok) return conversations.find((item) => item.id === convoId) || null;
    const parsed = parseStorePayload(await response.json());
    const fresh = (parsed.conversations || []).find((item) => item.id === convoId);
    if (!fresh) return conversations.find((item) => item.id === convoId) || null;
    if (typeof adoptPersistedOutboundQueue === 'function') adoptPersistedOutboundQueue(fresh);
    const idx = conversations.findIndex((item) => item.id === convoId);
    if (idx >= 0) {
      const localUpdated = Number(conversations[idx]?.updatedAt) || 0;
      const freshUpdated = Number(fresh.updatedAt) || 0;
      if (freshUpdated >= localUpdated) conversations[idx] = fresh;
    } else {
      conversations.push(fresh);
    }
    return conversations.find((item) => item.id === convoId) || null;
  } catch {
    return conversations.find((item) => item.id === convoId) || null;
  }
}

async function resumeLiveTurns(list: AdvertisedLiveTurn[] | null | undefined, snapshotRequestedAt = performance.now()) {
  if (!Array.isArray(list) || diskEncryptionLocked() || !storageReady) return;
  const advertised = new Map<string, AdvertisedLiveTurn>();
  for (const info of list) {
    const convoId = String(info?.conversation_id || '').trim();
    const turnId = String(info?.turn_id || '').trim();
    if (convoId && turnId) advertised.set(convoId + '\0' + turnId, info);
  }

  // The server owns detached-turn lifetime. Reconcile the browser map to it
  // before attaching anything new; a known turn cannot remain locally busy
  // after the server has finished or forgotten it.
  const released = new Set<string>();
  for (const [convoId, stream] of activeStreams) {
    const turnId = String(stream?.turnId || '').trim();
    if (!turnId) continue; // Incognito turns are intentionally browser-owned.
    // Stop already aborted the client fetch. If the server still owns this
    // unfinished turn, leave it for the in-flight finalizer. If the server
    // has forgotten it, the SSE is dead — settle now so Processing cannot
    // occupy the composer until restart.
    if (stream.cancelled && !stream.hardStopped) {
      const info = advertised.get(convoId + '\0' + turnId);
      if (info && !info.finished) continue;
      if (typeof cancelLiveBodyReader === 'function') cancelLiveBodyReader(stream);
      try { stream.controller.abort(); } catch { /* ignore */ }
      const convo = conversations.find((item) => item.id === convoId);
      if (convo && typeof settleStoppedLiveStream === 'function') {
        settleStoppedLiveStream(convo, stream);
      } else {
        discardLiveStreamRow(stream);
        finishLiveStream(convoId, stream);
      }
      continue;
    }
    const info = advertised.get(convoId + '\0' + turnId);
    if (info && (!info.finished || stream.catchingUp)) continue;
    // The browser names a turn before the server registers it. A snapshot
    // requested before the server confirmed the turn cannot show it was forgotten.
    if (!info && !(stream.serverTurnSeenAt && stream.serverTurnSeenAt <= snapshotRequestedAt)) {
      continue;
    }
    stream.replaced = true;
    stream.skipQueue = true;
    try { stream.controller.abort(); } catch { /* ignore */ }
    discardLiveStreamRow(stream);
    finishLiveStream(convoId, stream);
    released.add(convoId);

    // A finished turn retains its complete replay buffer briefly. Reattach
    // once from that authoritative copy so a broken response body loses no data.
    if (info?.finished) {
      const convo = conversations.find((item) => item.id === convoId);
      if (convo) void attachLiveTurn(convo, info, { force: true });
    }
  }

  for (const info of list) {
    const id = info && String(info.conversation_id || '').trim();
    if (!id || activeStreams.has(id) || outboundStarting.has(id)) continue;
    if (typeof shouldSkipLiveTurnResume === 'function' && shouldSkipLiveTurnResume(info)) {
      continue;
    }
    let convo: Conversation | null | undefined = conversations.find((item) => item.id === id);
    if (!convo) convo = await syncConvoFromStore(id);
    if (!convo) continue;
    if (
      info.finished
      && info.turn_id
      && convo.messages.some(
        (message) => message.role === 'assistant' && message.liveTurnId === info.turn_id
      )
    ) {
      continue;
    }
    const viewing = activeId === convo.id;
    if (!viewing) {
      const synced = await syncConvoFromStore(id);
      if (synced) convo = synced;
    }
    if (viewing && emptyState && !emptyState.classList.contains('is-hidden')) {
      showThread(convo);
    }
    void attachLiveTurn(convo, info);
  }
  for (const convoId of released) {
    if (!activeStreams.has(convoId)) maybeSendNextQueued(convoId);
  }
}

async function attachLiveTurn(convo: Conversation, info: AdvertisedLiveTurn, { force = false } = {}) {
  if (!convo || activeStreams.has(convo.id) || outboundStarting.has(convo.id) || !serverReady) return;
  if (!force && typeof shouldSkipLiveTurnResume === 'function' && shouldSkipLiveTurnResume(info)) return;
  beginLiveStream(convo, {
    useAgent: !!info?.agent,
    deepResearch: !!info?.deep_research,
    deepResearchOutput: info?.deep_research_output === 'brief' ? 'brief' : 'long',
    turnSkills: {},
    turnForceTools: [],
    catchingUp: true,
    turnId: info?.turn_id || null,
    turnModel: info?.model || '',
  });
  const stream = activeStreams.get(convo.id);
  if (!stream) return;
  try {
    const response = await Promise.race([
      fetch('/api/chat/live/' + encodeURIComponent(convo.id), {
        signal: stream.controller.signal,
      }),
      whenAborted(stream.controller.signal).then(() => {
        const error = new Error('Aborted');
        (error as Error).name = 'AbortError';
        throw error;
      }),
    ]);
    if (!response.ok) {
      if (response.status === 404) {
        discardLiveStreamRow(stream);
        finishLiveStream(convo.id, stream);
        return;
      }
      const problem: ApiErrorResult | null = await response.json().catch(() => null);
      throw new Error((problem && problem.error) || ('Request failed with status ' + response.status));
    }
    await driveAssistantSse(convo, stream, response);
  } catch (error) {
    if ((error as Error).name === 'AbortError' && stream.cancelled) {
      await driveAssistantSse(convo, stream, null);
      return;
    }
    dropLiveSubscriber(convo.id, stream);
  }
}

function beginLiveStream(convo: Conversation, {
  useAgent,
  deepResearch,
  deepResearchOutput,
  turnSkills,
  turnForceTools,
  catchingUp = false,
  turnId = null,
  turnModel = '',
  speakerBotId = null,
  loopPhase = null,
  turnStartedAt = null,
}: StreamOptions = {}): ActiveStream {
  if (activeStreams.has(convo.id)) return activeStreams.get(convo.id)!;
  const requestedStartedAt = Number(turnStartedAt);
  const streamStartedAt = Number.isFinite(requestedStartedAt) && requestedStartedAt > 0
    ? requestedStartedAt : Date.now();
  const stream: ActiveStream = {
    controller: new AbortController(),
    useAgent,
    deepResearch,
    deepResearchOutput,
    turnSkills,
    turnForceTools,
    partial: '',
    timeline: [],
    images: Object.create(null),
    errorMessage: null,
    processNotesCollapsed: true,
    dom: null,
    steerId: null,
    pendingSteers: [],
    catchingUp: !!catchingUp,
    turnId: turnId || null,
    serverTurnSeenAt: catchingUp ? performance.now() : 0,
    turnModel: String(turnModel || ''),
    startedAt: streamStartedAt,
    statusLabel: 'Processing…',
    domMountCount: 0,
    speakerBotId: speakerBotId || null,
    loopPhase: loopPhase && typeof loopPhase === 'object' ? { ...loopPhase } : null,
    convoId: convo.id,
    cancelled: false,
    hardStopped: false,
    settled: false,
    usageStats: {
      completionTokens: 0,
      promptTokens: 0,
      contextPromptTokens: null,
      contextCompletionTokens: null,
      providerTokPerSec: null,
      upstreamModel: null,
    },
    contextRemote: null,
  };
  if (stream.turnId && typeof rememberHandledLiveTurn === 'function') {
    rememberHandledLiveTurn(stream.turnId);
  }
  activeStreams.set(convo.id, stream);
  renderSidebar();
  syncComposerStreamUi();
  if (activeId === convo.id) {
    ensureStreamDom(convo, stream);
    scrollToBottom({ force: true });
  }
  return stream;
}

function streamSpeakerBot(stream: ActiveStream | null | undefined) {
  if (!stream?.speakerBotId || typeof getBot !== 'function') return null;
  const convo = stream.convoId
    ? conversations.find((item) => item.id === stream.convoId)
    : null;
  return getBot(stream.speakerBotId, convo);
}

function streamStatusLabel(stream: ActiveStream | null | undefined, base: string) {
  const label = String(base || 'Processing…').trim() || 'Processing…';
  const bot = streamSpeakerBot(stream);
  return bot ? ('@' + bot.handle + ' · ' + label) : label;
}

function setStreamThinkingLabel(stream: ActiveStream | null | undefined, base: string) {
  if (!stream) return;
  const baseLabel = String(base || 'Processing…').trim() || 'Processing…';
  stream.statusLabel = baseLabel;
  if (!stream.dom?.thinkingLabel) return;
  stream.dom.thinkingLabel.dataset.base = baseLabel;
  const next = streamStatusLabel(stream, baseLabel);
  if (stream.dom.thinkingLabel.textContent !== next) {
    stream.dom.thinkingLabel.textContent = next;
  }
}

function promptProgressLabel(progress: PromptProgress | null | undefined) {
  if (!progress || typeof progress !== 'object') return '';
  const total = Number(progress.total);
  const processed = Number(progress.processed);
  const cached = Number(progress.cache);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(processed)) return '';
  const done = Math.max(0, Math.min(total, processed));
  const percent = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  const details = [`${Math.round(done).toLocaleString()}/${Math.round(total).toLocaleString()} tokens`];
  if (Number.isFinite(cached) && cached > 0) details.push(`${Math.round(cached).toLocaleString()} cached`);
  return `Processing prompt · ${percent}% · ${details.join(' · ')}`;
}

function syncStreamSpeakerChrome(convo: Conversation | null | undefined, stream: ActiveStream) {
  if (!stream?.dom?.row) return;
  const bot = streamSpeakerBot(stream);
  if (bot) {
    syncMessageSpeaker(stream.dom.row, {
      role: 'assistant',
      speakerId: bot.id,
      speakerHandle: bot.handle,
      loopPhaseLabel: stream.loopPhase?.label || '',
      loopPhaseIndex: stream.loopPhase?.index || null,
      loopPhaseTotal: stream.loopPhase?.total || null,
    });
    setStreamThinkingLabel(stream, stream.dom.thinkingLabel?.dataset?.base || 'Processing…');
  } else if (typeof isBotsConvo === 'function' && isBotsConvo(convo)) {
    syncMessageSpeaker(stream.dom.row, { role: 'assistant' });
  }
}

function discardLiveStreamRow(stream: ActiveStream) {
  const row = stream?.dom?.row;
  if (!row) return;
  try { stream.dom?.thinkingOrb?.stop(); } catch { /* ignore */ }
  if (row.isConnected) row.remove();
  stream.dom = null;
}

function settleStoppedLiveStream(convo: Conversation | null | undefined, stream: ActiveStream, rawText?: string | null) {
  if (!convo || !stream || stream.settled) return;
  stream.settled = true;
  stream.cancelled = true;
  const cancelledExtracted = typeof collectTurnMemoryExtraction === 'function'
    ? collectTurnMemoryExtraction(stream, rawText != null ? rawText : stream.partial)
    : { cleaned: String(rawText != null ? rawText : (stream.partial || '')).trim() };
  const cancelledText = String(cancelledExtracted.cleaned || '').trim();
  const cancelledVisible = (typeof streamingAnswerText === 'function'
    ? streamingAnswerText(cancelledText)
    : cancelledText).trim();
  const silentNoReply = typeof isSilentNoReply === 'function'
    && (isSilentNoReply(cancelledVisible) || isSilentNoReply(cancelledText));
  const speakerBotId = stream.speakerBotId || null;
  const speakerBot = speakerBotId && typeof getBot === 'function' ? getBot(speakerBotId, convo) : null;
  if (cancelledVisible && cancelledVisible !== 'No response.' && !silentNoReply) {
    const message: ChatMessage = {
      role: 'assistant',
      content: cancelledText,
      model: stream.turnModel
        || String(selectedChatModel || '').trim()
        || 'model',
    };
    const totalWorkMs = workDurationMs(stream.startedAt, Date.now());
    if (totalWorkMs != null) message.workDurationMs = totalWorkMs;
    if (speakerBot) {
      message.speakerId = speakerBot.id;
      message.speakerHandle = speakerBot.handle;
    }
    if (stream.loopPhase) {
      message.loopRunId = stream.loopPhase.runId || '';
      message.loopPhaseId = stream.loopPhase.id || '';
      message.loopPhaseLabel = stream.loopPhase.label || '';
      message.loopPhaseIndex = stream.loopPhase.index || null;
      message.loopPhaseTotal = stream.loopPhase.total || null;
    }
    const committedMessage = commitLiveAssistant(convo, message, stream.turnId);
    const msgIndex = convo.messages.indexOf(committedMessage);
    const viewing = activeId === convo.id;
    let dom = stream.dom && stream.dom.row && stream.dom.row.isConnected
      ? stream.dom
      : null;
    if (!dom && viewing && !stream.hardStopped) {
      dom = ensureStreamDom(convo, stream);
    }
    if (dom && dom.row.isConnected) {
      try { dom.thinkingOrb?.stop(); } catch { /* ignore */ }
      if (dom.statusEl) dom.statusEl.classList.add('is-hidden');
      delete dom.row.dataset.streamId;
      dom.row.dataset.msgIndex = String(msgIndex);
      dom.row.dataset.raw = committedMessage.content || '';
      if (typeof syncMessageSpeaker === 'function') syncMessageSpeaker(dom.row, committedMessage);
      if (typeof settleAssistantRow === 'function') {
        settleAssistantRow(dom.row, committedMessage, { animateCollapse: false });
      }
    }
    convo.updatedAt = Date.now();
    if (typeof saveConversations === 'function') saveConversations({ immediate: true });
  } else {
    discardLiveStreamRow(stream);
  }
  finishLiveStream(convo.id, stream);
}

