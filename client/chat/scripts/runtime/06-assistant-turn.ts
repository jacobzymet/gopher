/** Stream an assistant reply; safe to leave the conversation while it runs. */
async function runAssistantTurn(convo: Conversation, {
  useAgent,
  text,
  skills,
  deepResearch = false,
  deepResearchOutput = 'long',
  forceTools = [],
  dispatchedMessage = null,
  queueItem = null,
  previousTitle = '',
  speakerBotId = null,
  skipQueue = false,
  replaceLive = false,
  botMessageLimit = null,
  loopTurnDirective = '',
  loopPhase = null,
}: AssistantTurnOptions) {
  if (outboundStarting.has(convo.id) && !replaceLive) return false;
  if (activeStreams.has(convo.id)) {
    const live = activeStreams.get(convo.id);
    if (live && (live.cancelled || live.hardStopped || live.settled) && !replaceLive) {
      // A previous Stop left this conversation busy. Free it so the next
      // prompt can start instead of hanging on Processing.
      live.replaced = true;
      live.skipQueue = true;
      if (typeof cancelLiveBodyReader === 'function') cancelLiveBodyReader(live);
      try { live.controller.abort(); } catch { /* ignore */ }
      settleStoppedLiveStream(convo, live, live.partial || '');
    } else if (!replaceLive) {
      return false;
    } else if (live) {
      live.replaced = true;
      live.skipQueue = true;
      abortStream(convo.id, { cancelServer: true });
    }
  }
  const startEpoch = markOutboundStarting(convo.id);
  const workStartedAt = Date.now();
  const clientTurnId = convo.incognito ? null : (queueItem?.diagnosticTraceId || newId('turn'));
  const diagnosticTraceId = clientTurnId || queueItem?.diagnosticTraceId || '';
  const diagnosticStartedAt = queueItem?.diagnosticStartedAt || workStartedAt;
  const diagnosticContext = { traceId: diagnosticTraceId, convoId: convo.id, startedAt: diagnosticStartedAt };
  if (typeof diagnosticMark === 'function') diagnosticMark('turn.started', { queue_wait_ms: workStartedAt - diagnosticStartedAt }, diagnosticContext);
  let liveStarted = false;
  let startedStream: ActiveStream | null = null;
  try {
  if (typeof clearBotsOutboundStopped === 'function') clearBotsOutboundStopped(convo.id);
  if (typeof clearLiveTurnUserCancel === 'function') clearLiveTurnUserCancel(convo.id);
  if (typeof waitForCancel === 'function') {
    if (typeof diagnosticMark === 'function') diagnosticMark('cancel.wait.started', {}, diagnosticContext);
    await waitForCancel(convo.id);
    if (typeof diagnosticMark === 'function') diagnosticMark('cancel.wait.finished', {}, diagnosticContext);
  }
  if (typeof outboundStartIsCurrent === 'function'
    && !outboundStartIsCurrent(convo.id, startEpoch)) {
    return false;
  }
  const speakerBot = speakerBotId && typeof getBot === 'function' ? getBot(speakerBotId, convo) : null;
  const speakerModelId = speakerBot && speakerBot.model ? speakerBot.model : conversationModelId(convo);
  const remote = selectedRemoteModel(latestState, speakerModelId);
  if (!remote?.ready) {
    if (typeof showComposerHint === 'function') {
      const label = modelIdLabel(speakerModelId);
      showComposerHint(label ? ('Still connecting to ' + label + '…') : 'Model is not ready yet.');
    }
    return false;
  }
  resetTraceAutoOpenState();

  const turnSkills = { ...(skills || {
    web_search: !!settings.skillWebSearch,
    web_search_depth: WEB_SEARCH_DEPTHS.includes(settings.webSearchDepth)
      ? settings.webSearchDepth
      : DEFAULT_SETTINGS.webSearchDepth,
    web_search_provider: WEB_SEARCH_PROVIDERS.includes(settings.webSearchProvider)
      ? settings.webSearchProvider
      : DEFAULT_SETTINGS.webSearchProvider,
    web_search_searxng: typeof settings.webSearchSearxng === 'string'
      ? settings.webSearchSearxng.trim()
      : '',
    web_search_parallel_api_key: typeof settings.webSearchParallelApiKey === 'string'
      ? settings.webSearchParallelApiKey.trim()
      : '',
    web_search_parallel_mode: WEB_SEARCH_PARALLEL_MODES.includes(settings.webSearchParallelMode)
      ? settings.webSearchParallelMode
      : DEFAULT_SETTINGS.webSearchParallelMode,
    web_search_tinyfish_api_key: typeof settings.webSearchTinyfishApiKey === 'string'
      ? settings.webSearchTinyfishApiKey.trim()
      : '',
    web_search_max_results: Math.min(20, Math.max(1, Number(settings.webSearchResults) || 6)),
    web_search_region: /^[a-z]{2}-[a-z]{2}$/.test(settings.webSearchRegion)
      ? settings.webSearchRegion
      : 'us-en',
    web_search_safesearch: WEB_SEARCH_SAFESEARCH.includes(settings.webSearchSafeSearch)
      ? settings.webSearchSafeSearch
      : 'moderate',
    web_search_recency: WEB_SEARCH_RECENCIES.includes(settings.webSearchRecency)
      ? settings.webSearchRecency
      : 'any',
    fetch_url: !!settings.skillFetchUrl,
    fetch_url_max_chars: Math.min(
      200000,
      Math.max(1000, Number(settings.fetchUrlMaxChars) || 8000)
    ),
    web_search_page_max_chars: (() => {
      const raw = Number(settings.webSearchPageMaxChars);
      if (!Number.isFinite(raw) || raw <= 0) return 0;
      return Math.min(200000, Math.max(1000, Math.round(raw)));
    })(),
    approval_mode: APPROVAL_MODES.includes(settings.approvalMode)
      ? settings.approvalMode
      : 'manual',
    filesystem: !!settings.skillFilesystem,
    workspace_root: sessionWorkspaceRoot(),
    terminal: !!settings.skillTerminal,
    terminal_timeout_secs: Math.min(30, Math.max(5, Number(settings.terminalTimeoutSecs) || 30)),
    browser: !!settings.skillBrowser,
  }), chat_retrieval: settings.chatRetrieval !== false && !convo.incognito };
  if (turnSkills.chat_retrieval) useAgent = true;
  if (deepResearch) {
    useAgent = true;
    turnSkills.web_search = true;
    turnSkills.fetch_url = true;
    turnSkills.web_search_depth = 'deep';
    turnSkills.web_search_max_results = Math.max(turnSkills.web_search_max_results || 6, 10);
  }
  const turnForceTools = Array.isArray(forceTools)
    ? forceTools.filter((name) => name === 'web_search' || name === 'fetch_url')
    : [];
  if (deepResearch || !useAgent || !settings.agentMode) {
    turnForceTools.length = 0;
  } else {
    if (turnForceTools.includes('web_search')) turnSkills.web_search = true;
    if (turnForceTools.includes('fetch_url')) turnSkills.fetch_url = true;
  }

  const stream = beginLiveStream(convo, {
    useAgent,
    deepResearch,
    deepResearchOutput,
    turnSkills,
    turnForceTools,
    turnModel: remote.model,
    speakerBotId: speakerBotId || null,
    loopPhase,
    turnStartedAt: workStartedAt,
    turnId: clientTurnId,
  });
  liveStarted = true;
  startedStream = stream;
  stream.diagnosticTraceId = diagnosticTraceId;
  stream.diagnosticStartedAt = diagnosticStartedAt;
  clearOutboundStarting(convo.id, startEpoch);
  stream.speakerBotId = speakerBotId || null;
  stream.skipQueue = !!skipQueue;
  syncStreamSpeakerChrome(convo, stream);

  stream.speakerModelId = remote.id || speakerModelId;
  let apiMessages: Array<{ role: string; content: JsonValue | undefined }>;
  if (speakerBot && typeof botApiMessages === 'function') {
    apiMessages = botApiMessages(convo, speakerBot, dispatchedMessage ? text : null, {
      messageLimit: botMessageLimit,
    });
  } else {
    apiMessages = convo.messages.map((message) => {
      if (message.role !== 'user') {
        return { role: message.role, content: message.content };
      }
      return {
        role: 'user',
        content: userMessageApiContent(message),
      };
    });
    if (apiMessages.length > 0) {
      const last = apiMessages[apiMessages.length - 1];
      if (last.role === 'user') last.content = text;
    }
  }
  const systemPrompt = buildSystemPrompt(convo.projectId, {
    excludeConvoId: convo.id,
    convo,
    speakerBot,
    includeTime: false,
  });
  const systemParts = [systemPrompt, String(loopTurnDirective || '').trim()].filter(Boolean);
  if (systemParts.length) {
    // Keep the changing clock after the stable prompt and backend agent rules.
    apiMessages.unshift(
      { role: 'system', content: systemParts.join('\n\n') },
      { role: 'system', content: buildTimePrompt() },
    );
  }

  const speakerEffort = typeof thinkingEffortForModel === 'function'
    ? thinkingEffortForModel(remote)
    : (thinkingSupported && activeThinkingEffort !== 'auto' ? activeThinkingEffort : null);
  const requestBody: Record<string, unknown> = {
    messages: apiMessages,
    agent: useAgent,
    skills: turnSkills,
    force_tools: turnForceTools,
    ...(convo.incognito ? {} : {
      conversation_id: convo.id,
      turn_id: clientTurnId,
    }),
    ...(speakerEffort ? { thinking_effort: speakerEffort } : {}),
  };
  if (deepResearch) {
    requestBody.deep_research = true;
    requestBody.deep_research_output = deepResearchOutput === 'brief' ? 'brief' : 'long';
  }
  if (remote) {
    requestBody.remote_base = remote.base;
    if (remote.provider_id) requestBody.provider_id = remote.provider_id;
    requestBody.model = remote.model;
  }

  let response: Response | null = null;
  try {
    // New chats must be persisted before the server binds their retrieval scope.
    if (turnSkills.chat_retrieval && typeof saveStore === 'function') {
      setStreamThinkingLabel(stream, 'Saving chat…');
      if (typeof diagnosticMark === 'function') diagnosticMark('store.wait.started', {}, diagnosticContext);
      saveStore({ immediate: true });
      if (typeof storeWriteChain !== 'undefined') await storeWriteChain;
      if (!stream.cancelled && activeStreams.get(convo.id) === stream) setStreamThinkingLabel(stream, 'Connecting to model…');
      if (typeof diagnosticMark === 'function') diagnosticMark('store.wait.finished', {}, diagnosticContext);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (stream.controller.signal.aborted || stream.cancelled) break;
      if (typeof diagnosticMark === 'function') diagnosticMark('chat.request.dispatch', { attempt, messages: apiMessages.length, model: remote?.model }, diagnosticContext);
      response = await Promise.race([
        fetch('/api/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(diagnosticTraceId && settings.diagnosticsEnabled ? { 'x-gopher-request-id': diagnosticTraceId } : {}),
          },
          body: JSON.stringify(requestBody),
          signal: stream.controller.signal,
        }),
        whenAborted(stream.controller.signal).then(() => {
          const error = new Error('Aborted');
          (error as Error).name = 'AbortError';
          throw error;
        }),
      ]);
      if (stream.replaced || activeStreams.get(convo.id) !== stream) return false;
      if (stream.cancelled) break;
      if (response.ok || response.status !== 409 || attempt > 0) break;
      if (typeof scheduleCancel !== 'function') break;
      await scheduleCancel(convo.id, null);
      if (stream.replaced || stream.cancelled || activeStreams.get(convo.id) !== stream) {
        return false;
      }
    }
    if (stream.cancelled || !response) {
      await driveAssistantSse(convo, stream, response);
      return true;
    }
    if (!response.ok) {
      if (response.status === 409) {
        throw new Error('Could not start a new response because another is still stopping. Try again.');
      }
      const failed = response;
      response = null;
      const problem: ApiErrorResult | null = await failed.json().catch(() => null);
      throw new Error((problem && problem.error) || ('Request failed with status ' + failed.status));
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
      stream.errorMessage = contextualModelError((error as Error).message, stream.turnModel);
    }
  }
  await driveAssistantSse(convo, stream, response);
  return true;
  } catch (error) {
    if (startedStream && activeStreams.get(convo.id) === startedStream) {
      startedStream.controller.abort();
      discardLiveStreamRow(startedStream);
      finishLiveStream(convo.id, startedStream);
    }
    throw error;
  } finally {
    if (!liveStarted) clearOutboundStarting(convo.id, startEpoch);
  }
}

