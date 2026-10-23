/**
 * Make room for a new turn in this conversation. A stopped turn that is still settling is freed;
 * a live one blocks the new turn unless `replaceLive` asks to replace it.
 */
function claimTurnSlot(convo: Conversation, replaceLive: boolean): boolean {
  if (outboundStarting.has(convo.id) && !replaceLive) return false;
  if (!activeStreams.has(convo.id)) return true;
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
  return true;
}

type TurnDiagnostics = { traceId: string; convoId: string; startedAt: number };

function turnMark(event: string, data: Record<string, unknown>, context: TurnDiagnostics) {
  if (typeof diagnosticMark === 'function') diagnosticMark(event, data, context);
}

function clearStopMarkers(convo: Conversation) {
  if (typeof clearBotsOutboundStopped === 'function') clearBotsOutboundStopped(convo.id);
  if (typeof clearLiveTurnUserCancel === 'function') clearLiveTurnUserCancel(convo.id);
}

/** Wait for a cancel of the previous turn to reach the server. */
async function waitForPreviousCancel(convo: Conversation, diagnostics: TurnDiagnostics) {
  turnMark('cancel.wait.started', {}, diagnostics);
  await waitForCancel(convo.id);
  turnMark('cancel.wait.finished', {}, diagnostics);
}

function trimmedSetting(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Agent capabilities for this turn from the settings (unless a caller passed its own). */
function turnSkillSettings(skills: AssistantTurnOptions['skills'], convo: Conversation) {
  return { ...(skills || {
    web_search: !!settings.skillWebSearch,
    web_search_depth: WEB_SEARCH_DEPTHS.includes(settings.webSearchDepth)
      ? settings.webSearchDepth
      : DEFAULT_SETTINGS.webSearchDepth,
    web_search_provider: WEB_SEARCH_PROVIDERS.includes(settings.webSearchProvider)
      ? settings.webSearchProvider
      : DEFAULT_SETTINGS.webSearchProvider,
    web_search_searxng: trimmedSetting(settings.webSearchSearxng),
    web_search_parallel_api_key: trimmedSetting(settings.webSearchParallelApiKey),
    web_search_parallel_mode: WEB_SEARCH_PARALLEL_MODES.includes(settings.webSearchParallelMode)
      ? settings.webSearchParallelMode
      : DEFAULT_SETTINGS.webSearchParallelMode,
    web_search_tinyfish_api_key: trimmedSetting(settings.webSearchTinyfishApiKey),
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
}

/**
 * Chat retrieval and deep research need agent mode; deep research also turns on deep search.
 * Forced tools apply only to normal agent turns, and enable the tool they force.
 */
function applyTurnMode(turnSkills: ReturnType<typeof turnSkillSettings>, useAgent: boolean | undefined, deepResearch: boolean,
  forceTools: AssistantTurnOptions['forceTools']) {
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
  return { useAgent, turnForceTools };
}

/** The conversation as API messages: the bot's view for bot turns, else every message with the new text last. */
function turnApiMessages(convo: Conversation, speakerBot: ReturnType<typeof getBot> | null, text: AssistantTurnOptions['text'],
  dispatchedMessage: AssistantTurnOptions['dispatchedMessage'], botMessageLimit: AssistantTurnOptions['botMessageLimit'],
  loopTurnDirective: string) {
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
    const clock = buildTimePrompt();
    // The clock rides on the newest user message, so the system prompt, tools and earlier
    // history stay byte-identical between turns and providers can serve them from cache.
    const clocked = appendTurnClock(apiMessages, clock);
    apiMessages.unshift({ role: 'system', content: systemParts.join('\n\n') });
    if (!clocked) apiMessages.splice(1, 0, { role: 'system', content: clock });
  }
  return apiMessages;
}

/** Add the clock to the trailing user message's API copy; false when the turn ends otherwise. */
function appendTurnClock(apiMessages: Array<{ role: string; content: JsonValue | undefined }>, clock: string) {
  const last = apiMessages[apiMessages.length - 1];
  if (!clock || !last || last.role !== 'user') return false;
  if (typeof last.content === 'string') {
    last.content = last.content ? last.content + '\n\n' + clock : clock;
    return true;
  }
  if (Array.isArray(last.content)) {
    last.content = [...last.content, { type: 'text', text: clock }];
    return true;
  }
  return false;
}

interface TurnRequest {
  apiMessages: ReturnType<typeof turnApiMessages>; useAgent: boolean | undefined; turnSkills: ReturnType<typeof turnSkillSettings>;
  turnForceTools: string[]; clientTurnId: string | null; deepResearch: boolean; deepResearchOutput: string;
}

function turnRequestBody(convo: Conversation, remote: NonNullable<ReturnType<typeof selectedRemoteModel>>, request: TurnRequest) {
  const speakerEffort = typeof thinkingEffortForModel === 'function'
    ? thinkingEffortForModel(remote)
    : (thinkingSupported && activeThinkingEffort !== 'auto' ? activeThinkingEffort : null);
  const requestBody: Record<string, unknown> = {
    messages: request.apiMessages,
    agent: request.useAgent,
    skills: request.turnSkills,
    force_tools: request.turnForceTools,
    ...(convo.incognito ? {} : {
      conversation_id: convo.id,
      turn_id: request.clientTurnId,
    }),
    ...(speakerEffort ? { thinking_effort: speakerEffort } : {}),
  };
  if (request.deepResearch) {
    requestBody.deep_research = true;
    requestBody.deep_research_output = request.deepResearchOutput === 'brief' ? 'brief' : 'long';
  }
  if (remote) {
    requestBody.remote_base = remote.base;
    if (remote.provider_id) requestBody.provider_id = remote.provider_id;
    requestBody.model = remote.model;
  }
  return requestBody;
}

/** New chats must be persisted before the server binds their retrieval scope. */
async function saveChatForRetrieval(convo: Conversation, stream: ActiveStream, diagnostics: TurnDiagnostics) {
  setStreamThinkingLabel(stream, 'Saving chat…');
  turnMark('store.wait.started', {}, diagnostics);
  saveStore({ immediate: true });
  if (typeof storeWriteChain !== 'undefined') await storeWriteChain;
  if (!stream.cancelled && activeStreams.get(convo.id) === stream) setStreamThinkingLabel(stream, 'Connecting to model…');
  turnMark('store.wait.finished', {}, diagnostics);
}

function postCompletion(stream: ActiveStream, requestBody: Record<string, unknown>, diagnosticTraceId: string) {
  return Promise.race([
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
}

/** Either the turn already ended with `value`, or its response is ready to be read. */
type TurnRequestOutcome = { done: true; value: boolean | undefined } | { done: false; response: Response | null };

/**
 * Send the request. A 409 means the previous turn is still stopping on the server: cancel it and
 * retry once. Errors become the stream's error message, except aborts, which end the turn here.
 */
async function sendTurnRequest(convo: Conversation, stream: ActiveStream, requestBody: Record<string, unknown>,
  diagnostics: TurnDiagnostics, model: string | undefined): Promise<TurnRequestOutcome> {
  let response: Response | null = null;
  try {
    if ((requestBody.skills as { chat_retrieval?: boolean }).chat_retrieval && typeof saveStore === 'function') {
      await saveChatForRetrieval(convo, stream, diagnostics);
    }
    const messages = (requestBody.messages as unknown[]).length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (stream.controller.signal.aborted || stream.cancelled) break;
      turnMark('chat.request.dispatch', { attempt, messages, model }, diagnostics);
      response = await postCompletion(stream, requestBody, diagnostics.traceId);
      if (stream.replaced || activeStreams.get(convo.id) !== stream) return { done: true, value: false };
      if (stream.cancelled) break;
      if (response.ok || response.status !== 409 || attempt > 0) break;
      if (typeof scheduleCancel !== 'function') break;
      await scheduleCancel(convo.id, null);
      if (stream.replaced || stream.cancelled || activeStreams.get(convo.id) !== stream) {
        return { done: true, value: false };
      }
    }
    if (stream.cancelled || !response) {
      await driveAssistantSse(convo, stream, response);
      return { done: true, value: true };
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
        return { done: true, value: undefined };
      }
      if (!stream.cancelled) {
        dropLiveSubscriber(convo.id, stream);
        if (!stream.skipQueue) maybeSendNextQueued(convo.id);
        return { done: true, value: undefined };
      }
    } else {
      stream.errorMessage = contextualModelError((error as Error).message, stream.turnModel);
    }
  }
  return { done: false, response };
}

/** Stream an assistant reply; safe to leave the conversation while it runs. */
/** The speaker's model when it is ready; otherwise null, with a hint. */
function readyTurnModel(speakerModelId: string) {
  const remote = selectedRemoteModel(latestState, speakerModelId);
  if (remote?.ready) return remote;
  if (typeof showComposerHint === 'function') {
    const label = modelIdLabel(speakerModelId);
    showComposerHint(label ? ('Still connecting to ' + label + '…') : 'Model is not ready yet.');
  }
  return null;
}

async function runAssistantTurn(convo: Conversation, options: AssistantTurnOptions) {
  const {
    text, skills, deepResearch = false, deepResearchOutput = 'long', forceTools = [], dispatchedMessage = null,
    queueItem = null, speakerBotId = null, skipQueue = false, replaceLive = false, botMessageLimit = null,
    loopTurnDirective = '', loopPhase = null,
  } = options;
  if (!claimTurnSlot(convo, replaceLive)) return false;
  const startEpoch = markOutboundStarting(convo.id);
  const workStartedAt = Date.now();
  const clientTurnId = convo.incognito ? null : (queueItem?.diagnosticTraceId || newId('turn'));
  const diagnosticTraceId = clientTurnId || queueItem?.diagnosticTraceId || '';
  const diagnosticStartedAt = queueItem?.diagnosticStartedAt || workStartedAt;
  const diagnostics: TurnDiagnostics = { traceId: diagnosticTraceId, convoId: convo.id, startedAt: diagnosticStartedAt };
  turnMark('turn.started', { queue_wait_ms: workStartedAt - diagnosticStartedAt }, diagnostics);
  let liveStarted = false;
  let startedStream: ActiveStream | null = null;
  try {
    clearStopMarkers(convo);
    // Only await when there is a cancel to wait for: the turn must start in the same tick otherwise,
    // so a replacement stream arriving meanwhile is not overwritten.
    if (typeof waitForCancel === 'function') await waitForPreviousCancel(convo, diagnostics);
    if (typeof outboundStartIsCurrent === 'function' && !outboundStartIsCurrent(convo.id, startEpoch)) return false;
    const speakerBot = speakerBotId && typeof getBot === 'function' ? getBot(speakerBotId, convo) : null;
    const speakerModelId = speakerBot && speakerBot.model ? speakerBot.model : conversationModelId(convo);
    const remote = readyTurnModel(speakerModelId);
    if (!remote) return false;
    resetTraceAutoOpenState();
    const turnSkills = turnSkillSettings(skills, convo);
    const { useAgent, turnForceTools } = applyTurnMode(turnSkills, options.useAgent, deepResearch, forceTools);
    const stream = beginLiveStream(convo, {
      useAgent, deepResearch, deepResearchOutput, turnSkills, turnForceTools, turnModel: remote.model,
      speakerBotId: speakerBotId || null, loopPhase, turnStartedAt: workStartedAt, turnId: clientTurnId,
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
    const apiMessages = turnApiMessages(convo, speakerBot, text, dispatchedMessage, botMessageLimit, loopTurnDirective);
    const requestBody = turnRequestBody(convo, remote, {
      apiMessages, useAgent, turnSkills, turnForceTools, clientTurnId, deepResearch, deepResearchOutput,
    });
    const outcome = await sendTurnRequest(convo, stream, requestBody, diagnostics, remote?.model);
    if (outcome.done) return outcome.value;
    await driveAssistantSse(convo, stream, outcome.response);
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

