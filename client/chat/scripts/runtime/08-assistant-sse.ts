async function driveAssistantSse(convo: Conversation, stream: ActiveStream, response: Response | null) {
  const remote = selectedRemoteModel(latestState, stream.speakerModelId);
  const fallbackTurnModel = String(
    stream.turnModel || remote?.model || latestState?.network?.remote_model || 'model'
  ).trim();
  const usageStats = stream.usageStats;
  stream.contextRemote = remote || null;
  let firstTokenAt: number | null = null;

  const typer = createStreamTyper((replyText: string, streaming: boolean) => {
    const nextLabel = isThinkingOpen(replyText)
      ? 'Reasoning…'
      : stream.useAgent
        ? (stream.deepResearch
          ? (stream.deepResearchOutput === 'brief' ? 'Writing brief' : 'Writing report')
          : 'Writing answer')
        : (replyText && replyText.trim())
          ? 'Writing…'
          : 'Processing…';
    setStreamThinkingLabel(stream, nextLabel);
    paintStreamIntoView(convo, stream, replyText, streaming);
  });
  const markFirstToken = (kind: 'reasoning' | 'content') => {
    if (firstTokenAt == null) firstTokenAt = Date.now();
    if (kind && !stream['diagnosticFirst' + kind as 'diagnosticFirstreasoning' | 'diagnosticFirstcontent']) {
      stream['diagnosticFirst' + kind as 'diagnosticFirstreasoning' | 'diagnosticFirstcontent'] = true;
      if (typeof diagnosticStreamMark === 'function') diagnosticStreamMark(stream, convo, 'browser.first_' + kind + '_token');
    }
  };
  const onAgentEvent = (payload: AgentStreamEvent) => {
    if (payload.phase === 'content_clear') {
      // Keep prior think/tool cards — seal the live buffer, then apply any
      // authoritative preface the server resolved for this tool round.
      commitStreamBuffer(stream, typer);
      if (payload.reasoning != null) ensureSealedTimelineThink(stream, payload.reasoning);
      if (payload.text != null) ensureSealedTimelineText(stream, payload.text);
      if (stream.dom) stream.dom.row.dataset.raw = '';
      if (activeId === convo.id && stream.dom) {
        paintStreamIntoView(convo, stream, typer.shown || '', true);
      }
    } else if (payload.phase === 'tool_prepare' || payload.phase === 'tool_call') {
      if (!stream.diagnosticFirstTool) {
        stream.diagnosticFirstTool = true;
        if (typeof diagnosticStreamMark === 'function') diagnosticStreamMark(stream, convo, 'browser.first_tool_token', { name: payload.name });
      }
      commitStreamBuffer(stream, typer);
      if (stream.dom) stream.dom.row.dataset.raw = '';
      const part = upsertLiveToolPart(stream, payload);
      setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
    } else if (payload.phase === 'tool_approval') {
      const part = upsertLiveToolPart(stream, payload);
      setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'tool_executing') {
      const part = upsertLiveToolPart(stream, payload);
      if (part) {
        part.approval = 'allowed';
        part.executing = true;
      }
      setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'terminal') {
      if (typeof onAgentTerminalEvent === 'function') onAgentTerminalEvent(payload);
    } else if (payload.phase === 'tool_result') {
      const resultText = payload.result
        ? String(payload.result).trim()
        : payload.preview
          ? String(payload.preview).trim()
          : 'Done';
      const note = payload.note ? String(payload.note).trim() : '';
      const name = payload.name || 'skill';
      const id = payload.id ? String(payload.id) : '';
      const commandSessionId = payload.command_session_id ? String(payload.command_session_id) : '';
      if (commandSessionId && !payload.running) {
        for (const part of stream.timeline) {
          if (part.type === 'tool' && part.commandSessionId === commandSessionId && part.running) {
            part.running = false;
            part.ok = payload.ok !== false;
            part.note = payload.ok === false ? 'Process failed; see latest session result' : 'Process completed; see latest session result';
          }
        }
      }
      const liveTools = stream.timeline.filter((part) => part.type === 'tool' && part.live);
      const last = (id && stream.timeline.find((part) => part.type === 'tool' && part.id === id))
        || (!id && (liveTools.find((part) => part.name === name && part.live) || liveTools[liveTools.length - 1]));
      if (last && (!id || last.id === id)) {
        last.live = false;
        last.executing = false;
        last.result = resultText;
        last.ok = payload.ok !== false;
        last.running = !!payload.running;
        last.commandSessionId = commandSessionId;
        last.endedAt = Date.now();
        last.durationMs = last.startedAt
          ? Math.max(0, last.endedAt - last.startedAt)
          : 0;
        last.justSettled = true;
        scheduleJustSettledClear(last);
        last.note = note;
        last.approval = payload.ok === false && /denied/i.test(resultText) ? 'denied' : '';
        if (payload.image && /^data:image\//i.test(String(payload.image))) {
          last.image = String(payload.image);
        }
        if (payload.image_id) {
          const imageId = String(payload.image_id);
          last.imageId = imageId;
          if (last.image) {
            if (!stream.images) stream.images = Object.create(null);
            stream.images[imageId] = last.image;
          }
        }
      } else {
        const added = {
          type: 'tool',
          id,
          name: payload.name || 'skill',
          detail: '',
          result: resultText,
          ok: payload.ok !== false,
          running: !!payload.running,
          commandSessionId,
          approval: payload.ok === false && /denied/i.test(resultText) ? 'denied' : '',
          note,
          ...(payload.image && /^data:image\//i.test(String(payload.image))
            ? { image: String(payload.image) }
            : {}),
          ...(payload.image_id ? { imageId: String(payload.image_id) } : {}),
          live: false,
          justSettled: true,
        };
        stream.timeline.push(added);
        stampTimelinePart(added, stream);
        scheduleJustSettledClear(added);
      }
      if (
        payload.image_id
        && payload.image
        && /^data:image\//i.test(String(payload.image))
      ) {
        if (!stream.images) stream.images = Object.create(null);
        stream.images[String(payload.image_id)] = String(payload.image);
      }
      setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'clarify') {
      commitStreamBuffer(stream, typer);
      if (stream.dom) stream.dom.row.dataset.raw = '';
      const clarifyPart = {
        type: 'clarify',
        id: String(payload.id || ''),
        startedAt: Date.now(),
        questions: Array.isArray(payload.questions) ? payload.questions : [],
        draft: {},
        answers: null,
        summary: '',
        live: true,
        submitting: false,
      };
      stream.timeline.push(clarifyPart);
      setStreamThinkingLabel(stream, 'Waiting for your answers…');
      if (stream.dom) {
        mountClarifyForm(stream, clarifyPart);
      }
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'clarify_done') {
      const part = findClarifyPart(stream, String(payload.id || ''));
      if (part) {
        part.live = false;
        part.submitting = false;
        part.answers = payload.answers || {};
        part.summary = String(payload.summary || '').trim();
        mountClarifyForm(stream, part);
      }
      setStreamThinkingLabel(stream, 'Researching…');
      if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
    } else if (payload.phase === 'steer_ready' && payload.id) {
      stream.steerId = String(payload.id);
      void flushPendingSteers(stream);
      if (activeId === convo.id) renderOutboundQueue(convo);
    } else if (payload.phase === 'steer' && payload.content != null) {
      if (typeof sealSteerThinkAndDiscardDraft === 'function') {
        sealSteerThinkAndDiscardDraft(stream, typer);
      } else {
        typer.clear();
        stream.partial = '';
      }
      const text = String(payload.content).trim();
      const clientId = payload.client_id != null ? String(payload.client_id) : '';
      const pending = stream.pendingSteers || [];
      let entryIdx = -1;
      if (clientId) {
        entryIdx = pending.findIndex(
          (entry) => !entry.applied && entry.item?.id === clientId
        );
      }
      if (entryIdx < 0) {
        entryIdx = pending.findIndex((entry) => entry.text === text && !entry.applied);
      }
      if (entryIdx < 0) {
        entryIdx = pending.findIndex((entry) => !entry.applied);
      }
      const entry = entryIdx >= 0 ? pending.splice(entryIdx, 1)[0] : null;
      if (entry) entry.applied = true;
      applySteeredEntry(convo, stream, text, entry);
      setStreamThinkingLabel(stream, 'Steering…');
      if (stream.dom) stream.dom.row.dataset.raw = '';
    } else if (payload.phase === 'status' && payload.message) {
      const msg = String(payload.message);
      const waiting = /waiting for (your )?approval/i.test(msg);
      const canAsk = stream.timeline.some((part) => part.type === 'tool' && part.approval === 'pending');
      if (!waiting || canAsk) {
        setStreamThinkingLabel(stream, msg);
      }
    } else if (payload.phase === 'notice' && payload.message) {
      const text = String(payload.message).trim();
      if (text && !stream.timeline.some((part) => part.type === 'notice' && part.content === text)) {
        stream.timeline.push({ type: 'notice', content: text });
      }
      if (text) setStreamThinkingLabel(stream, text);
    }
    paintStreamIntoView(convo, stream, typer.shown, true);
  };

  if (stream.catchingUp) typer.setCatchingUp(true);

  try {
    if (response && response.body) {
      const reader = response.body.getReader();
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
        for (const rawEvent of events) {
          const parsed = parseSseEvent(rawEvent);
          if (!parsed || parsed.data === '' || parsed.data === '[DONE]') continue;
          if (parsed.event === 'meta') {
            try {
              const meta: Partial<AdvertisedLiveTurn> = JSON.parse(parsed.data);
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
            continue;
          }
          if (parsed.event === 'live') {
            stream.catchingUp = false;
            typer.setCatchingUp(false);
            if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
            continue;
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
            continue;
          }
          if (parsed.event === 'agent') {
            try {
              onAgentEvent(JSON.parse(parsed.data));
            } catch {
              // ignore malformed agent frames
            }
            continue;
          }
          let json: BrowserCompletionFrame;
          try {
            json = JSON.parse(parsed.data);
          } catch {
            continue;
          }
          ingestStreamUsage(usageStats, json);
          if (activeId === convo.id) syncContextUsage(convo, usageStats, remote);
          const progressLabel = promptProgressLabel(json.prompt_progress);
          if (progressLabel && firstTokenAt == null) setStreamThinkingLabel(stream, progressLabel);
          const choice = json.choices && json.choices[0];
          const deltaObj = (choice && choice.delta) || {};
          const reasoning =
            deltaObj.reasoning_content ||
            deltaObj.reasoning ||
            (choice && choice.message && (choice.message.reasoning_content || choice.message.reasoning)) ||
            '';
          if (reasoning) {
            markFirstToken('reasoning');
            typer.pushReasoning(String(reasoning));
          }
          const delta = deltaObj.content || '';
          if (delta) {
            markFirstToken('content');
            typer.push(delta);
          }
        }
      }
      } finally {
        stream.bodyReader = null;
        try { await reader.cancel(); } catch { /* ignore */ }
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      if (stream.replaced) {
        dropLiveSubscriber(convo.id, stream);
        return;
      }
      if (!stream.cancelled) {
        dropLiveSubscriber(convo.id, stream);
        if (!stream.skipQueue) maybeSendNextQueued(convo.id);
        return;
      }
    } else {
      stream.errorMessage = contextualModelError(
        (error as Error).message,
        stream.turnModel || fallbackTurnModel
      );
    }
  }

  let queueAfter = !stream.skipQueue && !stream.replaced;
  try {
  if (stream.settled || stream.replaced || activeStreams.get(convo.id) !== stream) {
    queueAfter = false;
    return;
  }
  typer.flush();
  if (!conversations.some((item) => item.id === convo.id)) {
    return;
  }

  // Stop mid-turn: keep any useful partial reply; never spam empty "No response." rows.
  if (stream.cancelled || (typeof isBotsOutboundStopped === 'function' && isBotsOutboundStopped(convo.id))) {
    queueAfter = false;
    settleStoppedLiveStream(convo, stream, typer.target);
    return;
  }

  const endedAt = Date.now();
  const finalStats: FinalTurnStats | null = finalizeTurnStats(usageStats, firstTokenAt, endedAt);
  if (finalStats) {
    const contextWindowTokens = Number(remote?.context_length);
    finalStats.contextWindowTokens = Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
      ? contextWindowTokens
      : null;
    finalStats.contextModel = String(
      remote?.model || stream.turnModel || fallbackTurnModel || ''
    ).trim() || null;
  }
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
  if (
    stream.cancelled
    || (typeof isBotsOutboundStopped === 'function' && isBotsOutboundStopped(convo.id))
  ) {
    queueAfter = false;
    settleStoppedLiveStream(convo, stream, typer.target);
    return;
  }

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
  // Seal any leftover buffer so a final think/answer round joins the timeline
  // only as live content (not duplicated into parts).
  const viewing = activeId === convo.id;
  let dom = viewing ? ensureStreamDom(convo, stream) : stream.dom;
  const persistedParts = stream.timeline.length
    ? stream.timeline.map((part) => (
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
    ))
    : null;

  if (viewing && dom) {
    const savedClarify = preserveClarifyHost(dom.answerEl);
    if (stream.errorMessage && !visibleAnswer) {
      const errHtml = '<span class="msg-error">' + escapeHtml(stream.errorMessage) + '</span>';
      dom.answerEl.innerHTML = isDesktopTraceLayout()
        ? errHtml
        : (renderCommittedParts(stream.timeline) + errHtml);
    } else if (stream.errorMessage) {
      paintStreamIntoView(convo, stream, assistantText, false);
      dom = stream.dom;
      if (dom) {
        dom.answerEl.insertAdjacentHTML(
          'beforeend',
          '<span class="msg-error">' + escapeHtml(stream.errorMessage) + '</span>'
        );
      }
    } else if (!visibleAnswer) {
      if (!stream.errorMessage) stream.errorMessage = 'No response.';
      const errHtml = '<span class="msg-error">' + escapeHtml(stream.errorMessage) + '</span>';
      if (isDesktopTraceLayout()) {
        dom.answerEl.innerHTML = errHtml;
      } else {
        const committed = renderCommittedParts(stream.timeline);
        dom.answerEl.innerHTML = committed ? committed + errHtml : errHtml;
      }
    } else {
      paintStreamIntoView(convo, stream, assistantText, false);
      dom = stream.dom;
    }
    if (dom) {
      restoreClarifyHost(dom.answerEl, savedClarify || dom.clarifyHost);
      const doneClarify = stream.timeline.find((part) => part.type === 'clarify');
      if (doneClarify) mountClarifyForm(stream, doneClarify);
      dom.thinkingOrb.stop();
      dom.statusEl.classList.add('is-hidden');
      delete dom.row.dataset.streamId;
    }
  }

  if (assistantText || persistedParts || memoryNotices.length || stream.errorMessage) {
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
    if (finalStats?.tokensPerSec != null) message.tokensPerSec = finalStats.tokensPerSec;
    if (finalStats?.completionTokens != null) message.completionTokens = finalStats.completionTokens;
    if (finalStats?.promptTokens != null) message.promptTokens = finalStats.promptTokens;
    if (finalStats?.contextPromptTokens != null) message.contextPromptTokens = finalStats.contextPromptTokens;
    if (finalStats?.contextCompletionTokens != null) message.contextCompletionTokens = finalStats.contextCompletionTokens;
    if (finalStats?.contextTokens != null) message.contextTokens = finalStats.contextTokens;
    if (finalStats?.contextWindowTokens != null) message.contextWindowTokens = finalStats.contextWindowTokens;
    if (finalStats?.contextModel) message.contextModel = finalStats.contextModel;
    const committedMessage = commitLiveAssistant(convo, message, stream.turnId);
    if (typeof applyBotActions === 'function' && speakerBot) {
      applyBotActions(convo, speakerBot, extracted.botActions);
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
  } else {
    discardLiveStreamRow(stream);
  }

  if (activeId === convo.id) {
    // If we finished while away and came back to a thread without the row, re-render.
    if (!dom || !dom.row.isConnected) {
      renderThread(convo);
    }
    composerInput.focus();
  }
  } catch (error) {
    console.warn('Assistant turn finalize failed:', (error as Error)?.message || error);
    if (!stream.errorMessage) {
      stream.errorMessage = (error as Error)?.message || 'The request failed.';
    }
  } finally {
    const finished = activeStreams.get(convo.id) === stream && finishLiveStream(convo.id, stream);
    if (finished && queueAfter) {
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
