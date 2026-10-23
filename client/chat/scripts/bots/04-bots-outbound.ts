function defaultBotsTurn() {
  return {
    useAgent: !!settings.agentMode,
    skills: {
      web_search: !!settings.skillWebSearch,
      web_search_provider: WEB_SEARCH_PROVIDERS.includes(settings.webSearchProvider)
        ? settings.webSearchProvider
        : 'auto',
      web_search_searxng: typeof settings.webSearchSearxng === 'string'
        ? settings.webSearchSearxng.trim()
        : '',
      web_search_parallel_api_key: typeof settings.webSearchParallelApiKey === 'string'
        ? settings.webSearchParallelApiKey.trim()
        : '',
      web_search_parallel_mode: WEB_SEARCH_PARALLEL_MODES.includes(settings.webSearchParallelMode)
        ? settings.webSearchParallelMode
        : 'fast',
      web_search_tinyfish_api_key: typeof settings.webSearchTinyfishApiKey === 'string'
        ? settings.webSearchTinyfishApiKey.trim()
        : '',
      fetch_url: !!settings.skillFetchUrl,
      approval_mode: APPROVAL_MODES.includes(settings.approvalMode)
        ? settings.approvalMode
        : DEFAULT_SETTINGS.approvalMode,
      filesystem: !!settings.skillFilesystem,
      workspace_root: sessionWorkspaceRoot(),
      terminal: !!settings.skillTerminal,
      terminal_timeout_secs: Math.min(30, Math.max(5, Number(settings.terminalTimeoutSecs) || 30)),
      browser: !!settings.skillBrowser,
    },
    deepResearch: false,
    deepResearchOutput: 'long',
    forceTools: [],
  };
}

function applyBotActions(convo: Conversation, speakerBot: Bot | null, actions: BotActions) {
  if (!convo || !speakerBot || !actions) return;
  const hasAction = actions.hold || actions.resume || actions.dmUser || actions.groupPost;
  if (!hasAction) return;

  if (isBotGroup(convo)) {
    if (actions.hold) persistGroupHold(convo, speakerBot.id);
    if (actions.resume) persistGroupHold(convo, null);
  }

  if (actions.dmUser) {
    const sourceGroup = isBotGroup(convo) ? convo : findLinkedGroup(convo);
    const dm = ensureBotDm(speakerBot, { sideThreadOf: sourceGroup ? sourceGroup.id : null });
    if (dm) {
      appendBotSpokenMessage(dm, speakerBot, actions.dmUser);
      dm.updatedAt = Date.now();
      saveStore({ immediate: true });
      if (typeof renderSidebar === 'function') renderSidebar();
      requestBotNavigation(dm.id);
    }
  }

  if (actions.groupPost) {
    const group = isBotGroup(convo) ? convo : findLinkedGroup(convo);
    if (group && isBotGroup(convo)) {
      persistGroupHold(group, null);
    } else if (group) {
      persistGroupHold(group, null);
      appendBotSpokenMessage(group, speakerBot, actions.groupPost);
      group.updatedAt = Date.now();
      saveStore({ immediate: true });
      if (typeof renderSidebar === 'function') renderSidebar();
      if (activeId === group.id && typeof renderThread === 'function') renderThread(group);
      else requestBotNavigation(group.id);
      const item = {
        id: newId('q'),
        editText: actions.groupPost,
        displayText: actions.groupPost,
        apiText: actions.groupPost,
        fromBotId: speakerBot.id,
        alreadyPosted: true,
        turn: defaultBotsTurn(),
      };
      if (isConvoBusy(group.id)) {
        queueBotsInject(group.id, item);
      } else if (typeof runBotsOutbound === 'function') {
        void runBotsOutbound(group, item, null, group.title);
      }
    }
  }
}

/** Soft mid-turn injects while a bots hop is streaming (not a hard Stop). */
const botsPendingInjects: Map<string, OutboundItem[]> = new Map();

function queueBotsInject(convoId: string, item: OutboundItem) {
  if (!convoId || !item) return;
  const list = botsPendingInjects.get(convoId) || [];
  list.push(item);
  botsPendingInjects.set(convoId, list);
}

function drainBotsInjects(convoId: string) {
  const list = botsPendingInjects.get(convoId) || [];
  botsPendingInjects.delete(convoId);
  return list;
}

function clearBotsInjects(convoId: string | null | undefined) {
  if (convoId) botsPendingInjects.delete(convoId);
}

/**
 * While a bot turn is live: steer into the agent loop when possible; otherwise
 * soft-abort the current hop and inject the user message into the hop queue.
 */
function injectBotsOutbound(convo: Conversation, item: OutboundItem) {
  if (!convo || !item) return false;
  const stream = typeof activeStreams !== 'undefined' ? activeStreams.get(convo.id) : null;
  if (stream && typeof canSteerLiveStream === 'function' && canSteerLiveStream(stream)) {
    const text = typeof steerTextFromItem === 'function' ? steerTextFromItem(item) : '';
    if (!text) return false;
    if (!stream.pendingSteers) stream.pendingSteers = [];
    const entry = { item, text, posted: false, applied: false };
    stream.pendingSteers.push(entry);
    if (typeof renderPendingSteerBubble === 'function') renderPendingSteerBubble(convo.id, entry);
    if (typeof flushPendingSteers === 'function') void flushPendingSteers(stream);
    return true;
  }
  queueBotsInject(convo.id, item);
  if (typeof softAbortStream === 'function') softAbortStream(convo.id);
  else if (typeof abortStream === 'function') {
    abortStream(convo.id, { cancelServer: true, soft: true });
  }
  return true;
}

function appendBotsInjectMessage(convo: Conversation, item: OutboundItem) {
  const userMessage: ChatMessage = {
    role: 'user',
    content: item.displayText || (item.attachments?.length ? '(attachment)' : ''),
    steered: true,
  };
  if (item.attachments?.length) userMessage.attachments = item.attachments;
  if (item.replyQuote) userMessage.replyQuote = item.replyQuote;
  if (item.replyToSpeakerId) {
    userMessage.replyToSpeakerId = item.replyToSpeakerId;
    if (item.replyToSpeakerHandle) userMessage.replyToSpeakerHandle = item.replyToSpeakerHandle;
  }
  convo.messages.push(userMessage);
  convo.updatedAt = Date.now();
  saveConversations({ immediate: true });
  return userMessage;
}

async function runBotsOutbound(convo: Conversation, item: OutboundItem, userMessage: ChatMessage | null, previousTitle: string) {
  markBotsOutboundActive(convo.id);
  // Edit-resubmit marks outboundStarting so the composer stays busy during abort.
  // Hops must not see that flag or runAssistantTurn returns false immediately.
  if (typeof clearOutboundStarting === 'function') clearOutboundStarting(convo.id);
  let stopped = false;
  let messageCountAtStart = convo.messages.length;
  try {
    clearBotsOutboundStopped(convo.id);
    if (typeof clearLiveTurnUserCancel === 'function') clearLiveTurnUserCancel(convo.id);
    const epoch = bumpBotsOutboundEpoch(convo.id);
    const members = ensureLoopAgents(convo);
    const primary = members[0] || null;
    if (isBotsOutboundStopped(convo.id) || botsOutboundEpochOf(convo.id) !== epoch) {
      stopped = true;
    } else {
      await maybeCompactBotsConvo(convo, primary);
      if (isBotsOutboundStopped(convo.id) || botsOutboundEpochOf(convo.id) !== epoch) {
        stopped = true;
      }
    }
    if (!stopped) {
      clearBotsInjects(convo.id);
      messageCountAtStart = convo.messages.length;
      const workItems = [{ item, userMessage, previousTitle }];

      const collectInjectedWork = () => {
        const prepared = [];
        for (const inject of drainBotsInjects(convo.id)) {
          const injected = inject.alreadyPosted ? null : appendBotsInjectMessage(convo, inject);
          if (injected && activeId === convo.id) {
            chatThread.appendChild(
              buildBubble('user', injected.content, convo.messages.length - 1, injected, { animate: true })
            );
            scrollToBottom({ force: true });
          }
          prepared.push({
            item: inject,
            userMessage: injected,
            previousTitle: convo.title,
          });
        }
        if (prepared.length) workItems.unshift(...prepared);
        return prepared.length > 0;
      };

      while (workItems.length && !stopped) {
        const work = workItems.shift()!;
        const phases = buildLoopRunPhases(convo, work.item);
        if (!phases.length) continue;
        const run = startLoopRun(convo, phases);
        const frozenMessageLimit = convo.messages.length;
        let turnNumber = 0;
        let superseded = false;

        for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
          const phase = phases[phaseIndex];
          setLoopRunPosition(convo, phaseIndex, null);
          for (const agentId of phase.agentIds) {
            if (isBotsOutboundStopped(convo.id) || botsOutboundEpochOf(convo.id) !== epoch) {
              stopped = true;
              break;
            }
            if (collectInjectedWork()) {
              superseded = true;
              break;
            }
            const bot = getBot(agentId, convo);
            if (!bot) continue;
            turnNumber += 1;
            setLoopRunPosition(convo, phaseIndex, bot.id);
            const ran = await runAssistantTurn(convo, {
              useAgent: work.item.turn.useAgent,
              text: work.item.apiText,
              skills: work.item.turn.skills,
              deepResearch: work.item.turn.deepResearch,
              deepResearchOutput: work.item.turn.deepResearchOutput,
              forceTools: work.item.turn.forceTools,
              dispatchedMessage: turnNumber === 1 ? work.userMessage : null,
              queueItem: turnNumber === 1 ? work.item : null,
              previousTitle: work.previousTitle,
              speakerBotId: bot.id,
              skipQueue: true,
              botMessageLimit: phase.id === 'explore' ? frozenMessageLimit : null,
              loopTurnDirective: loopPhaseDirective(phase, bot),
              loopPhase: {
                runId: run.id,
                id: phase.id,
                label: phase.label,
                index: phaseIndex + 1,
                total: phases.length,
              },
            });
            if (!ran) {
              stopped = true;
              break;
            }
            completeLoopRunAgent(convo, phaseIndex, bot.id);
            if (isBotsOutboundStopped(convo.id) || botsOutboundEpochOf(convo.id) !== epoch) {
              stopped = true;
              break;
            }
            if (collectInjectedWork()) {
              superseded = true;
              break;
            }
          }
          if (stopped || superseded) break;
        }

        if (stopped) {
          finishLoopRun(convo, 'stopped');
          break;
        }
        if (superseded) {
          finishLoopRun(convo, 'stopped');
          continue;
        }
        finishLoopRun(convo, 'complete');
      }
    }
    if (stopped) {
      purgeTrailingNoResponseMessages(convo, messageCountAtStart);
      saveStore();
    }
  } finally {
    if (stopped && convo.loopRun?.status === 'running') finishLoopRun(convo, 'stopped');
    clearBotsOutboundActive(convo.id);
    renderLoopFlow(convo);
  }
  if (!stopped) maybeSendNextQueued(convo.id);
  if (activeId === convo.id) renderThread(convo);
  if (typeof renderSidebar === 'function') renderSidebar();
  if (typeof flushBotNavigation === 'function') flushBotNavigation();
}

function purgeTrailingNoResponseMessages(convo: Conversation | null | undefined, sinceIndex: number) {
  if (!convo || !Array.isArray(convo.messages)) return;
  const floor = Math.max(0, Number(sinceIndex) || 0);
  while (convo.messages.length > floor) {
    const last = convo.messages[convo.messages.length - 1];
    const text = String(last?.content || '').trim();
    if (last?.role === 'assistant' && (
      text === 'No response.'
      || last.error === 'No response.'
      || (typeof isSilentNoReply === 'function' && isSilentNoReply(last.content))
    )) {
      convo.messages.pop();
      continue;
    }
    break;
  }
}

function extraMentionItems(query: string, excluded: Set<string>) {
  if (!isBotsSurface()) return [];
  const convo = conversations.find((item) => item.id === activeId);
  const q = String(query || '').toLowerCase();
  const items: MentionOption[] = [];
  [
    { id: 'everyone', label: 'everyone', description: 'Notify every agent here', inline: true, section: 'Room' },
    { id: 'user', label: 'user', description: 'The human in this room', inline: true, section: 'Room' },
  ].forEach((item) => {
    if (item.label.startsWith(q) && !excluded.has(item.id)) items.push(item);
  });
  participantBots(convo).forEach((bot) => {
    if (q && !bot.handle.startsWith(q)) return;
    if (excluded.has(bot.handle)) return;
    items.push({
      id: bot.handle,
      label: bot.handle,
      description: loopAgentModelLabel(bot) || bot.description || 'Agent',
      inline: true,
      section: 'Agents',
    });
  });
  return items;
}

