/**
 * One assistant SSE turn being read: the conversation, its live stream, the typewriter that paints
 * text, and the model details needed for errors and usage. Shared by the reader, the agent-event
 * handlers and the finalizer of driveAssistantSse.
 */
interface SseTurn {
  convo: Conversation;
  stream: ActiveStream;
  remote: ReturnType<typeof selectedRemoteModel>;
  fallbackTurnModel: string;
  usageStats: ActiveStream['usageStats'];
  typer: ReturnType<typeof createStreamTyper>;
  firstTokenAt: number | null;
}

/** The status label while text streams: reasoning, writing, or still processing. */
function sseWritingLabel(stream: ActiveStream, replyText: string) {
  if (isThinkingOpen(replyText)) return 'Reasoning…';
  if (stream.useAgent) {
    if (!stream.deepResearch) return 'Writing answer';
    return stream.deepResearchOutput === 'brief' ? 'Writing brief' : 'Writing report';
  }
  return (replyText && replyText.trim()) ? 'Writing…' : 'Processing…';
}

function createSseTurn(convo: Conversation, stream: ActiveStream): SseTurn {
  const remote = selectedRemoteModel(latestState, stream.speakerModelId);
  const fallbackTurnModel = String(
    stream.turnModel || remote?.model || latestState?.network?.remote_model || 'model'
  ).trim();
  stream.contextRemote = remote || null;
  const typer = createStreamTyper((replyText: string, streaming: boolean) => {
    setStreamThinkingLabel(stream, sseWritingLabel(stream, replyText));
    paintStreamIntoView(convo, stream, replyText, streaming);
  });
  return { convo, stream, remote, fallbackTurnModel, usageStats: stream.usageStats, typer, firstTokenAt: null };
}

/** Record the first token of each kind, once, for the timing diagnostics. */
function sseMarkFirstToken(turn: SseTurn, kind: 'reasoning' | 'content') {
  const { stream, convo } = turn;
  if (turn.firstTokenAt == null) turn.firstTokenAt = Date.now();
  if (kind && !stream['diagnosticFirst' + kind as 'diagnosticFirstreasoning' | 'diagnosticFirstcontent']) {
    stream['diagnosticFirst' + kind as 'diagnosticFirstreasoning' | 'diagnosticFirstcontent'] = true;
    if (typeof diagnosticStreamMark === 'function') diagnosticStreamMark(stream, convo, 'browser.first_' + kind + '_token');
  }
}

function sseRefreshNotifications() {
  if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
}

/** Seal the live buffer before a tool round, keeping earlier think/tool cards. */
function sseContentClear(turn: SseTurn, payload: AgentStreamEvent) {
  const { convo, stream, typer } = turn;
  // Keep prior think/tool cards — seal the live buffer, then apply any
  // authoritative preface the server resolved for this tool round.
  commitStreamBuffer(stream, typer);
  if (payload.reasoning != null) ensureSealedTimelineThink(stream, payload.reasoning);
  if (payload.text != null) ensureSealedTimelineText(stream, payload.text);
  if (stream.dom) stream.dom.row.dataset.raw = '';
  if (activeId === convo.id && stream.dom) {
    paintStreamIntoView(convo, stream, typer.shown || '', true);
  }
}

function sseToolPrepare(turn: SseTurn, payload: AgentStreamEvent) {
  const { convo, stream, typer } = turn;
  if (!stream.diagnosticFirstTool) {
    stream.diagnosticFirstTool = true;
    if (typeof diagnosticStreamMark === 'function') diagnosticStreamMark(stream, convo, 'browser.first_tool_token', { name: payload.name });
  }
  commitStreamBuffer(stream, typer);
  if (stream.dom) stream.dom.row.dataset.raw = '';
  upsertLiveToolPart(stream, payload);
  setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
}

function sseToolExecuting(turn: SseTurn, payload: AgentStreamEvent) {
  if (payload.name === 'run_terminal' && typeof syncAgentProcesses === 'function') syncAgentProcesses();
  const part = upsertLiveToolPart(turn.stream, payload);
  if (part) {
    part.approval = 'allowed';
    part.executing = true;
  }
  setStreamThinkingLabel(turn.stream, liveToolStatusLabel(turn.stream, payload));
  sseRefreshNotifications();
}

/** A finished terminal command also settles earlier cards that were still showing it as running. */
function sseSettleCommandSessions(stream: ActiveStream, payload: AgentStreamEvent, commandSessionId: string) {
  if (!commandSessionId || payload.running) return;
  const stopped = terminalResultStopped(payload.name, payload.result || payload.preview, payload.note);
  for (const part of stream.timeline) {
    if (part.type === 'tool' && part.commandSessionId === commandSessionId && part.running) {
      part.running = false;
      part.ok = payload.ok !== false;
      part.stopped = stopped;
      part.note = stopped ? 'Process intentionally stopped. See latest session result.'
        : payload.ok === false ? 'Process failed; see latest session result' : 'Process completed; see latest session result';
    }
  }
}

function sseRememberImage(stream: ActiveStream, imageId: string, image: string) {
  if (!stream.images) stream.images = Object.create(null);
  stream.images![imageId] = image;
}

/** Fill in the live tool card that this result belongs to. */
function sseApplyToolResult(stream: ActiveStream, last: TimelinePart, payload: AgentStreamEvent,
  resultText: string, note: string, commandSessionId: string) {
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
    if (last.image) sseRememberImage(stream, imageId, last.image);
  }
}

/** A result without a matching live card (for example after reconnecting) gets a card of its own. */
function sseAddToolResult(stream: ActiveStream, payload: AgentStreamEvent, id: string, resultText: string,
  note: string, commandSessionId: string) {
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

function sseToolResult(turn: SseTurn, payload: AgentStreamEvent) {
  const { stream } = turn;
  const resultText = payload.result
    ? String(payload.result).trim()
    : payload.preview
      ? String(payload.preview).trim()
      : 'Done';
  const note = payload.note ? String(payload.note).trim() : '';
  const name = payload.name || 'skill';
  const id = payload.id ? String(payload.id) : '';
  const commandSessionId = payload.command_session_id ? String(payload.command_session_id) : '';
  sseSettleCommandSessions(stream, payload, commandSessionId);
  const liveTools = stream.timeline.filter((part) => part.type === 'tool' && part.live);
  const last = (id && stream.timeline.find((part) => part.type === 'tool' && part.id === id))
    || (!id && (liveTools.find((part) => part.name === name && part.live) || liveTools[liveTools.length - 1]));
  if (last && (!id || last.id === id)) sseApplyToolResult(stream, last, payload, resultText, note, commandSessionId);
  else sseAddToolResult(stream, payload, id, resultText, note, commandSessionId);
  if (
    payload.image_id
    && payload.image
    && /^data:image\//i.test(String(payload.image))
  ) {
    sseRememberImage(stream, String(payload.image_id), String(payload.image));
  }
  setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
  sseRefreshNotifications();
}

function sseClarify(turn: SseTurn, payload: AgentStreamEvent) {
  const { stream, typer } = turn;
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
  sseRefreshNotifications();
}

function sseClarifyDone(turn: SseTurn, payload: AgentStreamEvent) {
  const part = findClarifyPart(turn.stream, String(payload.id || ''));
  if (part) {
    part.live = false;
    part.submitting = false;
    part.answers = payload.answers || {};
    part.summary = String(payload.summary || '').trim();
    mountClarifyForm(turn.stream, part);
  }
  setStreamThinkingLabel(turn.stream, 'Researching…');
  sseRefreshNotifications();
}

/** The server applied a steering message: match it to the pending entry it came from. */
function sseSteer(turn: SseTurn, payload: AgentStreamEvent) {
  const { convo, stream, typer } = turn;
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
}

/** A status line; "waiting for approval" only shows while a card is actually asking. */
function sseStatus(turn: SseTurn, payload: AgentStreamEvent) {
  const msg = String(payload.message);
  const waiting = /waiting for (your )?approval/i.test(msg);
  const canAsk = turn.stream.timeline.some((part) => part.type === 'tool' && part.approval === 'pending');
  if (!waiting || canAsk) {
    setStreamThinkingLabel(turn.stream, msg);
  }
}

function sseNotice(turn: SseTurn, payload: AgentStreamEvent) {
  const text = String(payload.message).trim();
  if (text && !turn.stream.timeline.some((part) => part.type === 'notice' && part.content === text)) {
    turn.stream.timeline.push({ type: 'notice', content: text });
  }
  if (text) setStreamThinkingLabel(turn.stream, text);
}

/** Apply one agent event (tool calls and results, clarifications, steering, status) and repaint. */
function sseAgentEvent(turn: SseTurn, payload: AgentStreamEvent) {
  const { convo, stream } = turn;
  const phase = payload.phase;
  if (phase === 'content_clear') sseContentClear(turn, payload);
  else if (phase === 'tool_prepare' || phase === 'tool_call') sseToolPrepare(turn, payload);
  else if (phase === 'tool_approval') {
    upsertLiveToolPart(stream, payload);
    setStreamThinkingLabel(stream, liveToolStatusLabel(stream, payload));
    sseRefreshNotifications();
  } else if (phase === 'tool_executing') sseToolExecuting(turn, payload);
  else if (phase === 'terminal') {
    if (typeof onAgentTerminalEvent === 'function') onAgentTerminalEvent(payload);
  } else if (phase === 'tool_result') sseToolResult(turn, payload);
  else if (phase === 'clarify') sseClarify(turn, payload);
  else if (phase === 'clarify_done') sseClarifyDone(turn, payload);
  else if (phase === 'steer_ready' && payload.id) {
    stream.steerId = String(payload.id);
    void flushPendingSteers(stream);
    if (activeId === convo.id) renderOutboundQueue(convo);
  } else if (phase === 'steer' && payload.content != null) sseSteer(turn, payload);
  else if (phase === 'status' && payload.message) sseStatus(turn, payload);
  else if (phase === 'notice' && payload.message) sseNotice(turn, payload);
  paintStreamIntoView(convo, stream, turn.typer.shown, true);
}
