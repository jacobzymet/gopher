/** Mutable outcome of finalizing a turn: whether the next queued message should be sent afterwards. */
interface SseFlow { queueAfter: boolean }

/** Stopped by the user (or a stopped bot run): keep any useful partial reply, never an empty "No response." row. */
function sseStoppedByUser(turn: SseTurn) {
  return turn.stream.cancelled || (typeof isBotsOutboundStopped === 'function' && isBotsOutboundStopped(turn.convo.id));
}

function sseFinalStats(turn: SseTurn, endedAt: number): FinalTurnStats | null {
  const { remote, stream, fallbackTurnModel } = turn;
  const finalStats: FinalTurnStats | null = finalizeTurnStats(turn.usageStats, turn.firstTokenAt, endedAt);
  if (finalStats) {
    const contextWindowTokens = Number(remote?.context_length);
    finalStats.contextWindowTokens = Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
      ? contextWindowTokens
      : null;
    finalStats.contextModel = String(
      remote?.model || stream.turnModel || fallbackTurnModel || ''
    ).trim() || null;
  }
  return finalStats;
}

/** Close live tool and clarify cards, recording a duration for tools that never reported one. */
function sseCloseLiveParts(stream: ActiveStream) {
  stream.timeline.forEach((part) => {
    if (part.type === 'tool') {
      if (part.live && part.startedAt && !Number.isFinite(part.durationMs)) {
        part.endedAt = Date.now();
        part.durationMs = Math.max(0, part.endedAt - part.startedAt);
      }
      part.live = false;
    } else if (part.type === 'clarify') {
      part.live = false;
    }
  });
}

/** The timeline as it is saved with the message (only the fields that survive a reload). */
function ssePersistedParts(stream: ActiveStream) {
  if (!stream.timeline.length) return null;
  return stream.timeline.map((part) => (
    part.type === 'tool'
      ? {
        type: 'tool',
        name: part.name,
        detail: part.detail,
        result: part.result,
        ...(typeof part.ok === 'boolean' ? { ok: part.ok } : {}),
        ...(part.commandSessionId ? { commandSessionId: part.commandSessionId, running: !!part.running } : {}),
        ...(part.approval === 'denied' ? { approval: 'denied' } : {}),
        ...(part.note ? { note: part.note } : {}),
        ...(part.kind ? { kind: part.kind } : {}),
        ...(Number.isFinite(part.durationMs) ? { durationMs: Math.round(part.durationMs!) } : {}),
        ...(part.image ? { image: part.image } : {}),
        live: false,
      }
      : part.type === 'clarify'
        ? {
          type: 'clarify',
          id: part.id,
          questions: part.questions || [],
          answers: part.answers || null,
          summary: part.summary || '',
          live: false,
        }
      : part.type === 'notice'
        ? {
          type: 'notice',
          content: part.content,
          ...(part.tone ? { tone: part.tone } : {}),
          ...(part.kind ? { kind: part.kind } : {}),
        }
        : { type: part.type, content: part.content }
  ));
}

const sseErrorHtml = (message: string) => '<span class="msg-error">' + escapeHtml(message) + '</span>';

/** Paint the settled reply (or its error) into the visible row and stop its activity indicators. */
function ssePaintFinal(turn: SseTurn, initialDom: ActiveStream['dom'], assistantText: string, visibleAnswer: string) {
  const { convo, stream } = turn;
  let dom = initialDom!;
  const savedClarify = preserveClarifyHost(dom.answerEl);
  if (stream.errorMessage && !visibleAnswer) {
    const errHtml = sseErrorHtml(stream.errorMessage);
    dom.answerEl.innerHTML = isDesktopTraceLayout()
      ? errHtml
      : (renderCommittedParts(stream.timeline) + errHtml);
  } else if (stream.errorMessage) {
    paintStreamIntoView(convo, stream, assistantText, false);
    dom = stream.dom!;
    if (dom) dom.answerEl.insertAdjacentHTML('beforeend', sseErrorHtml(stream.errorMessage));
  } else if (!visibleAnswer) {
    if (!stream.errorMessage) stream.errorMessage = 'No response.';
    const errHtml = sseErrorHtml(stream.errorMessage);
    if (isDesktopTraceLayout()) {
      dom.answerEl.innerHTML = errHtml;
    } else {
      const committed = renderCommittedParts(stream.timeline);
      dom.answerEl.innerHTML = committed ? committed + errHtml : errHtml;
    }
  } else {
    paintStreamIntoView(convo, stream, assistantText, false);
    dom = stream.dom!;
  }
  if (dom) {
    restoreClarifyHost(dom.answerEl, savedClarify || dom.clarifyHost);
    const doneClarify = stream.timeline.find((part) => part.type === 'clarify');
    if (doneClarify) mountClarifyForm(stream, doneClarify);
    dom.thinkingOrb.stop();
    dom.statusEl.classList.add('is-hidden');
    delete dom.row.dataset.streamId;
  }
  return dom;
}

function sseApplyStats(message: ChatMessage, finalStats: FinalTurnStats | null) {
  if (finalStats?.tokensPerSec != null) message.tokensPerSec = finalStats.tokensPerSec;
  if (finalStats?.completionTokens != null) message.completionTokens = finalStats.completionTokens;
  if (finalStats?.promptTokens != null) message.promptTokens = finalStats.promptTokens;
  if (finalStats?.contextPromptTokens != null) message.contextPromptTokens = finalStats.contextPromptTokens;
  if (finalStats?.contextCompletionTokens != null) message.contextCompletionTokens = finalStats.contextCompletionTokens;
  if (finalStats?.contextTokens != null) message.contextTokens = finalStats.contextTokens;
  if (finalStats?.contextWindowTokens != null) message.contextWindowTokens = finalStats.contextWindowTokens;
  if (finalStats?.contextModel) message.contextModel = finalStats.contextModel;
}

interface SseReply {
  assistantText: string; visibleAnswer: string; persistedParts: ReturnType<typeof ssePersistedParts>;
  memoryNotices: ReturnType<typeof memoryNoticeLabels>; finalStats: FinalTurnStats | null;
  speakerBot: ReturnType<typeof getBot> | null;
}

/** The assistant message to save, with its speaker, loop phase, timeline, images, memory chips and usage. */
function sseAssistantMessage(turn: SseTurn, reply: SseReply): ChatMessage {
  const { stream, fallbackTurnModel } = turn;
  const { assistantText, visibleAnswer, persistedParts, memoryNotices, finalStats, speakerBot } = reply;
  const message: ChatMessage = {
    role: 'assistant',
    content: visibleAnswer ? assistantText : '',
    model: stream.turnModel
      || finalStats?.upstreamModel
      || fallbackTurnModel
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
  if (persistedParts) message.parts = persistedParts;
  if (stream.images && Object.keys(stream.images).length) {
    message.images = { ...stream.images };
  }
  if (memoryNotices.length) message.memoryNotices = memoryNotices;
  if (stream.errorMessage && !visibleAnswer) {
    message.error = stream.errorMessage;
    if (!message.content) message.content = stream.errorMessage;
  }
  sseApplyStats(message, finalStats);
  return message;
}

/** Save the message, settle its row, notify, and select it in the trace sidebar. */
function sseCommitMessage(turn: SseTurn, message: ChatMessage, dom: ActiveStream['dom'],
  speakerBot: SseReply['speakerBot'], botActions: unknown, endedAt: number) {
  const { convo, stream } = turn;
  const committedMessage = commitLiveAssistant(convo, message, stream.turnId);
  if (typeof applyBotActions === 'function' && speakerBot) {
    applyBotActions(convo, speakerBot, botActions as Parameters<typeof applyBotActions>[2]);
  }
  const msgIndex = convo.messages.indexOf(committedMessage);
  if (dom && dom.row.isConnected) {
    dom.row.dataset.msgIndex = String(msgIndex);
    dom.row.dataset.raw = committedMessage.content || '';
    syncMessageSpeaker(dom.row, committedMessage);
    settleAssistantRow(dom.row, committedMessage, { animateCollapse: true });
  }
  convo.updatedAt = Date.now();
  if (typeof recordConversationNotification === 'function') {
    recordConversationNotification(convo, {
      kind: stream.errorMessage ? 'error' : 'complete',
      at: endedAt,
    });
  }
  if (convo.projectId) {
    const project = getProject(convo.projectId);
    if (project) project.updatedAt = Date.now();
  }
  saveConversations({ immediate: true });
  if (activeId === convo.id) {
    selectTraceMessage(msgIndex, {
      animate: true,
      ensureOpen: false,
    });
    if (messageHasActivity(committedMessage)) maybeAutoOpenTraceSidebar(convo.id);
  }
}

/**
 * Turn the finished stream into a saved assistant message: extract memory updates, settle the
 * timeline, paint the final answer or error, and save. Clears `flow.queueAfter` when the next
 * queued message must not be sent (the stream was replaced or stopped).
 */
function finalizeSseTurn(turn: SseTurn, flow: SseFlow) {
  const { convo, stream, typer } = turn;
  if (stream.settled || stream.replaced || activeStreams.get(convo.id) !== stream) {
    flow.queueAfter = false;
    return;
  }
  typer.flush();
  if (!conversations.some((item) => item.id === convo.id)) return;
  if (sseStoppedByUser(turn)) {
    flow.queueAfter = false;
    settleStoppedLiveStream(convo, stream, typer.target);
    return;
  }
  const endedAt = Date.now();
  const finalStats = sseFinalStats(turn, endedAt);
  const speakerBotId = stream.speakerBotId || null;
  const speakerBot = speakerBotId && typeof getBot === 'function' ? getBot(speakerBotId, convo) : null;
  const extracted = collectTurnMemoryExtraction(stream, typer.target);
  const memoryChanges = applyExtractedMemories(convo, extracted, speakerBotId);
  const memoryNotices = memoryNoticeLabels(memoryChanges);
  // Memory chips live on the message; do not also push tone:ok notices into the
  // timeline (those were deferred to the bottom and duplicated the chips).
  let assistantText = extracted.cleaned;
  if (!assistantText && !stream.errorMessage) {
    assistantText = memoryOnlyAssistantFallback(extracted);
  }
  const visibleAnswer = streamingAnswerText(assistantText).trim();
  const silentNoReply = typeof isSilentNoReply === 'function'
    && (isSilentNoReply(visibleAnswer) || isSilentNoReply(assistantText));
  if (silentNoReply) {
    discardLiveStreamRow(stream);
    return;
  }
  // Think-only finals used to persist a blank desktop bubble while Activity looked fine.
  if (!visibleAnswer && !stream.errorMessage && stream.timeline.length) {
    stream.errorMessage = 'No user-visible answer after tools. Try again.';
  }
  // If Stop won the race after we left the cancel branch, still refuse placeholder spam.
  if (sseStoppedByUser(turn)) {
    flow.queueAfter = false;
    settleStoppedLiveStream(convo, stream, typer.target);
    return;
  }
  sseCloseLiveParts(stream);
  // Seal any leftover buffer so a final think/answer round joins the timeline
  // only as live content (not duplicated into parts).
  const viewing = activeId === convo.id;
  let dom = viewing ? ensureStreamDom(convo, stream) : stream.dom;
  const persistedParts = ssePersistedParts(stream);
  if (viewing && dom) dom = ssePaintFinal(turn, dom, assistantText, visibleAnswer);
  if (assistantText || persistedParts || memoryNotices.length || stream.errorMessage) {
    const reply = { assistantText, visibleAnswer, persistedParts, memoryNotices, finalStats, speakerBot };
    sseCommitMessage(turn, sseAssistantMessage(turn, reply), dom, speakerBot, extracted.botActions, endedAt);
  } else {
    discardLiveStreamRow(stream);
  }
  sseRefocusThread(convo, dom);
}

/** If we finished while away and came back to a thread without the row, re-render. */
function sseRefocusThread(convo: Conversation, dom: StreamDom | null | undefined) {
  if (activeId !== convo.id) return;
  if (!dom || !dom.row.isConnected) {
    renderThread(convo);
  }
  composerInput.focus();
}
