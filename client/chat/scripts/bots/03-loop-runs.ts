function loopAgentStage(bot: Bot | null | undefined) {
  if (['explore', 'challenge', 'answer'].includes(bot?.stage)) return bot.stage;
  const role = [bot?.handle, bot?.description].filter(Boolean).join(' ');
  if (LOOP_ANSWER_ROLE_RE.test(role)) return 'answer';
  if (LOOP_REVIEW_ROLE_RE.test(role)) return 'challenge';
  return 'explore';
}

function uniqueLoopAgents(list: Bot[]) {
  const seen = new Set();
  return (list || []).filter((bot) => {
    if (!bot?.id || seen.has(bot.id)) return false;
    seen.add(bot.id);
    return true;
  });
}

function buildLoopRunPhases(convo: Conversation, item: Partial<OutboundItem> = {}) {
  const members = ensureLoopAgents(convo);
  if (!members.length) return [];
  const text = item.editText || item.displayText || '';
  const mentions = parseBotMentions(text, convo);
  const focused = !!(
    item.fromBotId
    || item.replyToSpeakerId
    || (mentions.botIds.length && !mentions.everyone)
  );
  if (focused) {
    const targets = botsToPing(convo, text, {
      fromBotId: item.fromBotId || null,
      replyToSpeakerId: item.replyToSpeakerId || null,
    });
    if (!targets.length) return [];
    return [{
      id: item.fromBotId ? 'handoff' : 'focus',
      label: item.fromBotId ? 'Handoff' : 'Focused reply',
      description: item.fromBotId
        ? 'The requested agents pick up the handoff.'
        : 'Only the agents you addressed respond.',
      agentIds: uniqueLoopAgents(targets).map((bot) => bot.id),
      completedAgentIds: [],
    }];
  }

  let explorers = members.filter((bot) => loopAgentStage(bot) === 'explore');
  let challengers = members.filter((bot) => loopAgentStage(bot) === 'challenge');
  const answerers = members.filter((bot) => loopAgentStage(bot) === 'answer');
  if (!explorers.length) explorers = members.slice(0, 1);
  if (!challengers.length && members.length > 1) {
    challengers = members.filter((bot) => bot.id !== explorers[0]?.id).slice(0, 1);
  }
  const finalAgent = answerers[0] || explorers[0] || members[0];
  const phases = [{
    id: 'explore',
    label: 'Explore',
    description: 'Independent takes from the same starting point.',
    agentIds: uniqueLoopAgents(explorers).map((bot) => bot.id),
    completedAgentIds: [],
  }];
  if (challengers.length) {
    phases.push({
      id: 'challenge',
      label: 'Challenge',
      description: 'Agents test the proposals and surface weak points.',
      agentIds: uniqueLoopAgents(challengers).map((bot) => bot.id),
      completedAgentIds: [],
    });
  }
  phases.push({
    id: 'answer',
    label: 'Answer',
    description: 'One agent turns the strongest work into a clear answer.',
    agentIds: finalAgent ? [finalAgent.id] : [],
    completedAgentIds: [],
  });
  return phases.filter((phase) => phase.agentIds.length);
}

function loopPhaseDirective(phase: LoopPhase, bot: Bot) {
  const handle = botDisplayHandle(bot);
  if (phase.id === 'explore') {
    return [
      'Loop stage: EXPLORE.',
      'Give an independent, concrete take on the user’s problem from your assigned role.',
      'You are intentionally seeing the shared starting point, not other opening takes. Do not recap or wait for other agents.',
      'State the important assumptions, proposed answer, and evidence or checks that would make it trustworthy.',
      'The app schedules the next agent; do not use @mentions to manage the sequence.',
    ].join('\n');
  }
  if (phase.id === 'challenge') {
    return [
      'Loop stage: CHALLENGE.',
      'Review the proposals already in the room. Focus on material errors, disagreements, missing evidence, and edge cases.',
      'Name what survives scrutiny and what must change. Do not restate an earlier answer just to agree.',
      'The app schedules the next agent; do not use @mentions to manage the sequence.',
    ].join('\n');
  }
  if (phase.id === 'answer') {
    return [
      'Loop stage: ANSWER.',
      'Act as the final editor. Resolve the challenges and give @user one cohesive, self-contained answer.',
      'Lead with the conclusion. Do not narrate the agent workflow or ask another agent to continue.',
      'If an important uncertainty remains, state it plainly and say what would resolve it.',
    ].join('\n');
  }
  return [
    'Loop stage: ' + phase.label.toUpperCase() + '.',
    '@user specifically routed this turn to ' + handle + '. Respond directly and stay within your role.',
    'The app controls the sequence; only request another specialist when it is essential.',
  ].join('\n');
}

function startLoopRun(convo: Conversation, phases: LoopPhase[]) {
  convo.loopRun = {
    id: newId('loop'),
    status: 'running',
    phaseIndex: 0,
    activeAgentId: null,
    phases: phases.map((phase) => ({
      ...phase,
      agentIds: [...phase.agentIds],
      completedAgentIds: [],
    })),
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveStore();
  renderLoopFlow(convo);
  if (typeof isDesktopTraceLayout === 'function' && isDesktopTraceLayout()) {
    setTraceSidebarOpen(true);
  }
  return convo.loopRun;
}

function setLoopRunPosition(convo: Conversation | null | undefined, phaseIndex: number, agentId: string | null = null) {
  const run = convo?.loopRun;
  if (!run) return;
  run.phaseIndex = Math.min(run.phases.length - 1, Math.max(0, phaseIndex));
  run.activeAgentId = agentId || null;
  run.updatedAt = Date.now();
  saveStore();
  renderLoopFlow(convo);
}

function completeLoopRunAgent(convo: Conversation | null | undefined, phaseIndex: number, agentId: string) {
  const run = convo?.loopRun;
  const phase = run?.phases?.[phaseIndex];
  if (!phase || !agentId) return;
  if (!phase.completedAgentIds.includes(agentId)) phase.completedAgentIds.push(agentId);
  run.activeAgentId = null;
  run.updatedAt = Date.now();
  saveStore();
  renderLoopFlow(convo);
}

function finishLoopRun(convo: Conversation | null | undefined, status = 'complete') {
  const run = convo?.loopRun;
  if (!run) return;
  run.status = status === 'complete' ? 'complete' : 'stopped';
  run.activeAgentId = null;
  if (run.status === 'complete') run.phaseIndex = Math.max(0, run.phases.length - 1);
  run.updatedAt = Date.now();
  saveStore({ immediate: true });
  renderLoopFlow(convo);
}

function renderLoopFlow(convo: Conversation | null | undefined = conversations.find((item) => item.id === activeId)) {
  const show = !!(convo && isBotsSurface() && isBotGroup(convo));
  if (loopFlow) loopFlow.classList.toggle('is-hidden', !show);
  if (topbarLoopPhase) topbarLoopPhase.classList.toggle('is-hidden', !show);
  if (!show || !loopFlow || !loopFlowRail || !loopFlowCurrent || !loopFlowAgents) return;

  const previewPhases = buildLoopRunPhases(convo, {});
  const run = convo.loopRun;
  const phases = run?.phases?.length ? run.phases : previewPhases;
  if (!phases.length) return;
  const rawRunning = run?.status === 'running';
  const liveRunning = rawRunning && (
    isBotsOutboundActive(convo.id)
    || (typeof activeStreams !== 'undefined' && activeStreams.has(convo.id))
  );
  const interrupted = rawRunning && !liveRunning;
  const phaseIndex = run
    ? Math.min(phases.length - 1, Math.max(0, run.phaseIndex || 0))
    : 0;
  const phase = phases[phaseIndex];
  const activeBot = run?.activeAgentId ? getBot(run.activeAgentId, convo) : null;
  let title = run ? phase.label : 'Ready for a problem';
  let detail = run ? phase.description : phases.map((item) => item.label).join(' → ');
  let chromeState = 'ready';
  if (liveRunning) {
    chromeState = 'running';
    if (activeBot) detail = botDisplayHandle(activeBot) + ' is working · ' + phase.description;
  } else if (run?.status === 'complete') {
    chromeState = 'complete';
    title = 'Answer ready';
    detail = 'The loop completed its review and synthesis.';
  } else if (run?.status === 'stopped' || interrupted) {
    chromeState = 'stopped';
    title = interrupted ? 'Pass interrupted' : 'Loop stopped';
    detail = 'Send a message to start a fresh pass.';
  }

  loopFlow.classList.toggle('is-running', chromeState === 'running');
  loopFlowCount.textContent = run ? ((phaseIndex + 1) + ' of ' + phases.length) : (phases.length + ' stages');
  loopFlowCurrent.replaceChildren();
  const baton = (document.createElement('span') as HTMLElement);
  baton.className = 'loop-flow-baton';
  baton.setAttribute('aria-hidden', 'true');
  // A deterministic 3×3 compute matrix: the non-linear phase order keeps the
  // activity from reading like another generic spinner or presence pulse.
  [0, 5, 2, 7, 3, 8, 1, 6, 4].forEach((phase) => {
    const cell = (document.createElement('span') as HTMLElement);
    cell.className = 'loop-flow-compute-cell';
    cell.style.setProperty('--compute-phase', String(phase));
    baton.appendChild(cell);
  });
  const copy = (document.createElement('span') as HTMLElement);
  copy.className = 'loop-flow-current-copy';
  const currentTitle = (document.createElement('strong') as HTMLElement);
  currentTitle.className = 'loop-flow-current-title';
  currentTitle.textContent = title;
  const currentDetail = (document.createElement('span') as HTMLElement);
  currentDetail.className = 'loop-flow-current-detail';
  currentDetail.textContent = detail;
  copy.append(currentTitle, currentDetail);
  loopFlowCurrent.append(baton, copy);

  loopFlowRail.style.setProperty('--loop-phase-count', String(phases.length));
  loopFlowRail.replaceChildren();
  phases.forEach((item, index) => {
    const step = (document.createElement('li') as HTMLElement);
    step.className = 'loop-flow-step';
    const done = run?.status === 'complete' || index < phaseIndex;
    if (done) step.classList.add('is-done');
    else if (index === phaseIndex && run) step.classList.add('is-active');
    const dot = (document.createElement('span') as HTMLElement);
    dot.className = 'loop-flow-step-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = (document.createElement('span') as HTMLElement);
    label.className = 'loop-flow-step-label';
    label.textContent = item.label;
    step.append(dot, label);
    loopFlowRail.appendChild(step);
  });

  loopFlowAgents.replaceChildren();
  const visiblePhase = phases[phaseIndex];
  (visiblePhase.agentIds || []).forEach((agentId) => {
    const bot = getBot(agentId, convo);
    if (!bot) return;
    const chip = (document.createElement('span') as HTMLElement);
    chip.className = 'loop-flow-agent';
    if (run?.activeAgentId === agentId && liveRunning) chip.classList.add('is-active');
    if ((visiblePhase.completedAgentIds || []).includes(agentId) || run?.status === 'complete') {
      chip.classList.add('is-done');
    }
    const avatar = createBotAvatarEl(bot, { className: 'loop-flow-agent-avatar' });
    applyPrivacyMosaic(avatar, 'loop-flow-avatar:' + bot.id, { dense: true });
    const name = (document.createElement('span') as HTMLElement);
    name.textContent = botDisplayHandle(bot);
    applyPrivacyMosaic(name, 'loop-flow-agent:' + bot.id);
    const state = (document.createElement('span') as HTMLElement);
    state.className = 'loop-flow-agent-state';
    state.setAttribute('aria-hidden', 'true');
    chip.append(avatar, name, state);
    loopFlowAgents.appendChild(chip);
  });

  if (topbarLoopPhase) {
    topbarLoopPhase.classList.toggle('is-complete', chromeState === 'complete');
    topbarLoopPhase.classList.toggle('is-stopped', chromeState === 'stopped');
    topbarLoopPhase.textContent = chromeState === 'complete'
      ? 'Answer ready'
      : chromeState === 'stopped'
        ? 'Pass stopped'
        : run
          ? (phase.label + ' · ' + (phaseIndex + 1) + '/' + phases.length)
          : 'Ready · ' + phases.length + ' stages';
  }
}

function findLinkedGroup(convo: Conversation) {
  if (!convo) return null;
  if (convo.sideThreadOf) {
    return conversations.find((item) => item.id === convo.sideThreadOf) || null;
  }
  if (!convo.botId) return null;
  return conversations
    .filter((item) => isBotGroup(item) && (item.participantBotIds || []).includes(convo.botId))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}

function ensureBotDm(bot: Bot, { sideThreadOf = null }: {sideThreadOf?: string | null} = {}) {
  if (!bot) return null;
  let dm = conversations.find((item) => (
    isBotsConvo(item) && item.botKind === 'dm' && item.botId === bot.id
  ));
  if (!dm) {
    dm = createBotSession(bot);
    bot.sessionId = dm.id;
  }
  if (sideThreadOf) dm.sideThreadOf = sideThreadOf;
  return dm;
}

function appendBotSpokenMessage(convo: Conversation, speakerBot: Bot, text: string): ChatMessage {
  const message: ChatMessage = {
    role: 'assistant',
    content: String(text || '').trim(),
    speakerId: speakerBot.id,
    speakerHandle: speakerBot.handle,
  };
  convo.messages.push(message);
  convo.updatedAt = Date.now();
  return message;
}

let pendingBotNavigation: string | null = null;

function requestBotNavigation(convoId: string) {
  if (convoId) pendingBotNavigation = convoId;
}

function flushBotNavigation() {
  const id = pendingBotNavigation;
  pendingBotNavigation = null;
  if (!id || id === activeId) return;
  selectConversation(id);
}

function persistGroupHold(convo: Conversation, botId: string | null) {
  if (!convo) return;
  const next = botId || null;
  if ((convo.botsHeldBy || null) === next) return;
  convo.botsHeldBy = next;
  convo.updatedAt = Date.now();
  saveStore();
  if (activeId === convo.id) {
    if (typeof syncProjectChrome === 'function') syncProjectChrome();
    if (typeof updateComposerHint === 'function') updateComposerHint();
  }
}

