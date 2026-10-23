function focusComposer() {
  if (!composerInput) return;
  // Defer so a clicked Send button does not steal focus back.
  queueMicrotask(() => {
    if (document.activeElement === composerInput) return;
    composerInput.focus({ preventScroll: true });
  });
}

function ensureStreamDom(convo: Conversation, stream: ActiveStream) {
  if (stream?.hardStopped) return null;
  if (activeId !== convo.id) return null;
  if (stream.dom && stream.dom.row.isConnected) return stream.dom;
  const priorMounts = Number(stream.domMountCount) || 0;

  const assistantRow = (document.createElement('div') as HTMLElement);
  assistantRow.className = 'msg msg-role-assistant';
  assistantRow.dataset.streamId = convo.id;
  assistantRow.dataset.msgIndex = String(liveTurnSlices(convo).followUpStart);
  const bubble = (document.createElement('div') as HTMLElement);
  bubble.className = 'msg-bubble';

  const statusEl = (document.createElement('div') as HTMLElement);
  statusEl.className = 'thinking';
  const orbCanvas = (document.createElement('canvas') as HTMLCanvasElement);
  orbCanvas.className = 'orb-sm';
  const thinkingLabel = (document.createElement('span') as HTMLElement);
  thinkingLabel.className = 'thinking-label';
  const statusBase = String(stream.statusLabel || 'Processing…').trim() || 'Processing…';
  thinkingLabel.dataset.base = statusBase;
  thinkingLabel.textContent = streamStatusLabel(stream, statusBase);
  const elapsed = Math.max(0, Date.now() - (Number(stream.startedAt) || Date.now()));
  thinkingLabel.style.animationDelay = '-' + (elapsed % 1500) + 'ms';
  statusEl.appendChild(orbCanvas);
  statusEl.appendChild(thinkingLabel);

  const traceEl = (document.createElement('div') as HTMLElement);
  traceEl.className = 'agent-trace is-hidden';
  const answerEl = (document.createElement('div') as HTMLElement);
  answerEl.className = 'agent-answer';

  bubble.appendChild(statusEl);
  bubble.appendChild(traceEl);
  bubble.appendChild(answerEl);
  assistantRow.appendChild(bubble);
  const speakerBot = streamSpeakerBot(stream);
  if (speakerBot) {
    syncMessageSpeaker(assistantRow, {
      role: 'assistant',
      speakerId: speakerBot.id,
      speakerHandle: speakerBot.handle,
    });
  } else if (typeof isBotsConvo === 'function' && isBotsConvo(convo)) {
    // DM fallback when speaker is known from the room, not the stream yet.
    syncMessageSpeaker(assistantRow, { role: 'assistant' });
  }
  attachMessageActions(assistantRow);
  const followUp = (chatThread.querySelector(':scope > .msg-queued:not(.msg-steering)') as HTMLElement);
  if (followUp) chatThread.insertBefore(assistantRow, followUp);
  else chatThread.appendChild(assistantRow);
  if (typeof placeLiveAssistantRow === 'function') placeLiveAssistantRow(stream);
  if (priorMounts === 0) {
    queueMicrotask(() => motionEnter(assistantRow, { y: 14 }));
  }
  const thinkingOrb = mountOrb(orbCanvas as HTMLCanvasElement, 20);
  stream.domMountCount = priorMounts + 1;
  stream.dom = {
    row: assistantRow,
    statusEl,
    thinkingLabel,
    traceEl,
    answerEl,
    thinkingOrb,
    enteredSteps: 0,
  };
  const liveClarify = stream.timeline.find((part) => part.type === 'clarify');
  if (liveClarify) mountClarifyForm(stream, liveClarify);
  return stream.dom;
}

/**
 * While an open <think> block is streaming alone, patch the existing
 * .think-stream markdown instead of rebuilding the whole answer tree every
 * typer frame (full rebuilds starve the canvas orb's rAF and reset CSS animations).
 */
function paintLiveThinkOnly(rootEl: HTMLElement, cleaned: string) {
  if (settings.thinking === 'hidden') {
    if (rootEl.innerHTML) rootEl.innerHTML = '';
    return true;
  }
  const segments = parseThinkSegments(cleaned);
  const openThink = segments.find((segment) => segment.type === 'think' && segment.open);
  if (!openThink) return false;
  const otherSegments = segments.filter((segment) => {
    if (segment === openThink) return false;
    return segment.type !== 'think' ? !!segment.content.trim() : (!segment.open && !!segment.content.trim());
  });
  const closedSig = otherSegments.map((s) => s.type + ':' + s.content).join('\0');
  let streamEl = (rootEl.querySelector(
    ':scope > .agent-step.is-live-think .think-stream, :scope > .agent-step.is-think .think-stream, :scope > .think-live > .think-stream, :scope > .think-block.is-streaming > .think-stream'
  ) as HTMLElement);
  if (!streamEl || rootEl.dataset.closedSig !== closedSig) {
    let prefixHtml = '';
    for (const seg of otherSegments) {
      if (seg.type === 'think') {
        prefixHtml += renderThinkBlock(seg.content, { open: false, streaming: false });
      } else {
        prefixHtml += renderMarkdown(seg.content);
      }
    }
    rootEl.innerHTML = prefixHtml + renderThinkBlock(openThink.content, { open: true, streaming: true });
    rootEl.dataset.closedSig = closedSig;
    const liveStep = (rootEl.querySelector(':scope > .agent-step:last-child') as HTMLElement);
    if (liveStep) liveStep.classList.add('is-live-think');
    streamEl = (rootEl.querySelector('.is-live-think .think-stream, .think-stream') as HTMLElement);
  }
  if (!streamEl) return false;
  if (streamEl.dataset.thinkRaw !== openThink.content) {
    streamEl.dataset.thinkRaw = openThink.content;
    streamEl.innerHTML = renderThinkMarkdown(openThink.content, { cache: false });
  }
  enhanceCodeBlocks(rootEl);
  streamEl.scrollTop = streamEl.scrollHeight;
  return true;
}

function toolDetailFromPayload(payload?: AgentToolPayload | null) {
  const args = payload && payload.arguments && typeof payload.arguments === 'object'
    ? payload.arguments
    : {};
  const name = payload && payload.name ? String(payload.name) : '';
  if (name === 'grep') return String(args.query || args.pattern || '').trim();
  if (name === 'glob') return String(args.pattern || args.glob || '').trim();
  if (args.command) return String(args.command);
  if (args.session_id) return String(args.session_id);
  if (args.patch) return (String(args.patch).match(/^\*\*\* (?:Add|Update|Delete|Move to)(?: File)?: .+$/gm) || []).map((line) => line.replace(/^\*\*\* [^:]+: /, '').trim()).join(', ');
  if (args.path) return String(args.path);
  if (args.pattern) return String(args.pattern);
  if (args.url) return String(args.url);
  if (args.ref) return String(args.ref);
  if (args.expression) return String(args.expression);
  if (args.key) return String(args.key);
  if (args.selector) return String(args.selector);
  if (args.query) return String(args.query);
  if (args.name) return String(args.name);
  if (args.id) return String(args.id);
  if (payload && payload.summary) return String(payload.summary);
  return '';
}

function upsertLiveToolPart(stream: ActiveStream, payload?: AgentToolPayload | null) {
  const id = payload && payload.id ? String(payload.id) : '';
  const args = payload && payload.arguments && typeof payload.arguments === 'object'
    ? payload.arguments
    : {};
  const detail = toolDetailFromPayload(payload);
  const body = toolBodyFromArgs((payload && payload.name) || '', args);
  let part: TimelinePart | null | undefined = id
    ? stream.timeline.find((item) => item.type === 'tool' && item.id === id)
    : null;
  if (!part && !id) {
    const liveTools = stream.timeline.filter((item) => item.type === 'tool' && item.live);
    part = liveTools.find((item) => payload && item.name === payload.name && !item.result && !item.id) || null;
  }
  if (!part) {
    part = {
      type: 'tool',
      id,
      name: (payload && payload.name) || 'skill',
      detail,
      kind: args.kind ? String(args.kind) : '',
      args: { ...args },
      body,
      result: '',
      note: '',
      live: true,
      executing: false,
      startedAt: Date.now(),
    };
    stream.timeline.push(part);
    stampTimelinePart(part, stream);
  } else {
    if (id) part.id = id;
    if (payload && payload.name) part.name = payload.name;
    if (detail) part.detail = detail;
    if (args.kind) part.kind = String(args.kind);
    if (Object.keys(args).length) part.args = { ...(part.args || {}), ...args };
    if (body) part.body = body;
    stampTimelinePart(part, stream);
  }
  if (payload && (payload.needs_approval || payload.phase === 'tool_approval')
    && part.live && !['allowed', 'denied', 'expired'].includes(part.approval)) {
    part.approval = 'pending';
    part.approvalRisk = payload.risk ? String(payload.risk) : (part.approvalRisk || 'write');
    part.executing = false;
  }
  if (payload && payload.phase === 'tool_executing' && part.live) {
    part.approval = 'allowed';
    part.executing = true;
  }
  return part;
}

function timelineOrderSignature(timeline?: TimelinePart[] | null) {
  return (timeline || []).map((part) => {
    if (!part) return '';
    if (part.type === 'tool') {
      return ['tool', part.id || '', part.uid || '', part.name || '', part.startedAt || ''].join('\0');
    }
    if (part.type === 'clarify') return ['clarify', part.id || ''].join('\0');
    if (part.type === 'notice') return ['notice', part.kind || '', part.content || ''].join('\0');
    return [part.type, part.uid || ''].join('\0');
  }).join('\n');
}

function timelineSignature(timeline?: TimelinePart[] | null) {
  return (timeline || []).map((part) => {
    if (!part) return '';
    if (part.type === 'tool') {
      return [
        'tool',
        part.id || '',
        part.name,
        part.detail,
        part.result,
        part.note || '',
        typeof part.ok === 'boolean' ? String(part.ok) : '',
        part.running ? '1' : '0',
        part.commandSessionId || '',
        part.live ? '1' : '0',
        part.approval || '',
        part.approvalRisk || '',
        part.executing ? '1' : '0',
        part.live ? '' : (part.body || ''),
        part.image ? String(part.image.length) : '',
      ].join('\0');
    }
    if (part.type === 'clarify') {
      return ['clarify', part.id || '', part.live ? '1' : '0', part.summary || ''].join('\0');
    }
    return [part.type, part.content || ''].join('\0');
  }).join('\n');
}

function streamingAnswerText(text: string) {
  if (!text) return '';
  let out = '';
  for (const segment of parseThinkSegments(text)) {
    if (segment.type === 'think') continue;
    out += segment.content || '';
  }
  return out;
}

function ensureLiveAnswerBox(liveRoot: HTMLElement) {
  let box = (liveRoot.querySelector(':scope > .agent-final-answer') as HTMLElement);
  if (!box) {
    liveRoot.innerHTML = '<div class="agent-final-answer"></div>';
    box = (liveRoot.querySelector(':scope > .agent-final-answer') as HTMLElement);
  }
  return box;
}

function paintLiveStreamingAnswer(host: HTMLElement, cleaned: string, { streaming = true, wrapFinal = false } = {}) {
  const liveText = streamingAnswerText(cleaned);
  if (wrapFinal) {
    paintIncrementalMarkdown(ensureLiveAnswerBox(host), liveText, { streaming });
    return;
  }
  paintIncrementalMarkdown(host, liveText, { streaming });
}

function paintStreamIntoView(convo: Conversation, stream: ActiveStream, replyText: string, streaming: boolean) {
  if (stream?.hardStopped) return;
  setMarkdownImages(stream.images);
  stream.partial = replyText;
  const extracted = applyMemoryUpdateProtocol(replyText, { streaming });
  const { cleaned } = extracted;
  if (typeof isSilentNoReply === 'function' && isSilentNoReply(cleaned)) {
    if (activeId === convo.id && stream.dom?.answerEl) {
      if (stream.dom.answerEl.innerHTML) stream.dom.answerEl.innerHTML = '';
    }
    return;
  }
  if (activeId !== convo.id) {
    // Background stream — keep state only; sidebar shows the live marker.
    return;
  }
  const dom = ensureStreamDom(convo, stream);
  if (!dom) return;
  const { row, statusEl, thinkingLabel, traceEl, answerEl, thinkingOrb } = dom;
  const savedClarifyHost = preserveClarifyHost(answerEl);
  if (traceEl) {
    traceEl.innerHTML = '';
    traceEl.classList.add('is-hidden');
  }
  const thinkingOpen = streaming && isThinkingOpen(cleaned);
  const hasTimeline = stream.timeline.length > 0;
  const desktop = isDesktopTraceLayout();
  const notesCollapsed = readProcessNotesCollapsed(
    answerEl,
    stream.processNotesCollapsed !== false
  );
  stream.processNotesCollapsed = notesCollapsed;
  const sealedAnswerHtml = renderSealedAnswerHtml(stream.timeline, { notesCollapsed });
  const liveText = streamingAnswerText(cleaned);
  const hasLiveAnswer = !!liveText.trim();
  const hasThinkFallback = !hasTimeline && !thinkingOpen && !!cleaned && !hasLiveAnswer;
  const hasVisibleAnswer = desktop
    ? !!(sealedAnswerHtml || hasLiveAnswer || hasThinkFallback)
    : !!(hasLiveAnswer || sealedAnswerHtml);

  if (desktop) {
    const hasContent = !!(sealedAnswerHtml || hasLiveAnswer || hasThinkFallback);
    if (!hasContent && !streaming) {
      if (answerEl.innerHTML) answerEl.innerHTML = '';
      delete answerEl.dataset.renderedHtml;
    } else if (hasContent || streaming) {
      let sealedRoot = (answerEl.querySelector(':scope > .agent-sealed') as HTMLElement);
      let liveRoot = (answerEl.querySelector(':scope > .agent-live') as HTMLElement);
      if (!sealedRoot || !liveRoot) {
        answerEl.innerHTML = '<div class="agent-sealed"></div><div class="agent-live"></div>';
        sealedRoot = (answerEl.querySelector(':scope > .agent-sealed') as HTMLElement);
        liveRoot = (answerEl.querySelector(':scope > .agent-live') as HTMLElement);
      }
      const sealedSig = sealedContentSignature(stream.timeline);
      if (sealedRoot.dataset.sealedSig !== sealedSig) {
        sealedRoot.innerHTML = sealedAnswerHtml;
        sealedRoot.dataset.sealedSig = sealedSig;
        enhanceCodeBlocks(sealedRoot);
      }
      if (hasThinkFallback) {
        const html = renderAssistantHtml(cleaned, { streaming });
        if (liveRoot.dataset.renderedHtml !== html) {
          liveRoot.innerHTML = html;
          liveRoot.dataset.renderedHtml = html;
          enhanceCodeBlocks(liveRoot);
        }
      } else {
        delete liveRoot.dataset.renderedHtml;
        paintLiveStreamingAnswer(liveRoot, cleaned, { streaming, wrapFinal: true });
      }
    }
    delete answerEl.dataset.committedSig;
    delete answerEl.dataset.renderedHtml;
    stream.enteredSteps = 0;
  } else if (cleaned || hasTimeline || sealedAnswerHtml) {
    const committedHtml = renderCommittedParts(stream.timeline);
    const orderSig = timelineOrderSignature(stream.timeline) + '\0' + sealedContentSignature(stream.timeline);
    const committedSig = timelineSignature(stream.timeline) + '\0' + sealedContentSignature(stream.timeline);
    const liveOnly =
      streaming &&
      thinkingOpen &&
      !hasTimeline &&
      !sealedAnswerHtml &&
      paintLiveThinkOnly(answerEl, cleaned);

    if (!liveOnly) {
      let liveRoot = (answerEl.querySelector(':scope > .agent-live') as HTMLElement);
      if ((hasTimeline || sealedAnswerHtml) && streaming) {
        if (
          answerEl.dataset.timelineOrderSig === orderSig
          && answerEl.dataset.committedSig
          && liveRoot
        ) {
          if (answerEl.dataset.committedSig !== committedSig) {
            patchTimelineToolChrome(answerEl, stream.timeline);
            answerEl.dataset.committedSig = committedSig;
          }
          patchLiveToolBodies(answerEl, stream.timeline);
        } else if (answerEl.dataset.committedSig !== committedSig || !liveRoot) {
          answerEl.innerHTML = committedHtml + sealedAnswerHtml + '<div class="agent-live"></div>';
          answerEl.dataset.committedSig = committedSig;
          answerEl.dataset.timelineOrderSig = orderSig;
          liveRoot = (answerEl.querySelector(':scope > .agent-live') as HTMLElement);
          stampTimelineKeysOnRoot(answerEl, stream.timeline);
          enhanceCodeBlocks(answerEl);
        }
        if (cleaned && liveRoot && !(thinkingOpen && paintLiveThinkOnly(liveRoot, cleaned))) {
          paintStreamingAssistant(liveRoot, cleaned, { streaming: true });
        }
      } else if (streaming && cleaned && !hasTimeline && !sealedAnswerHtml) {
        if (!(thinkingOpen && paintLiveThinkOnly(answerEl, cleaned))) {
          paintStreamingAssistant(answerEl, cleaned, { streaming: true });
        }
        answerEl.dataset.committedSig = committedSig;
      } else {
        answerEl.innerHTML = committedHtml + sealedAnswerHtml + (cleaned ? renderAssistantHtml(cleaned, { streaming }) : '');
        answerEl.dataset.committedSig = committedSig;
        answerEl.dataset.timelineOrderSig = orderSig;
        stampTimelineKeysOnRoot(answerEl, stream.timeline);
        enhanceCodeBlocks(answerEl);
      }
      scrollThinkStreams(answerEl);
      const steps = (answerEl.querySelectorAll(':scope > .agent-step') as NodeListOf<HTMLElement>);
      const seen = stream.enteredSteps || 0;
      steps.forEach((el, index) => {
        if (index < seen || el.classList.contains('is-live')) return;
        motionEnter(el, { y: 10, duration: 200, delay: Math.min(index - seen, 6) * 28 });
      });
      stream.enteredSteps = steps.length;
    }
  } else if (!streaming) {
    if (answerEl.innerHTML) answerEl.innerHTML = '';
    delete answerEl.dataset.committedSig;
    delete answerEl.dataset.timelineOrderSig;
    delete answerEl.dataset.renderedHtml;
    stream.enteredSteps = 0;
  }

  const toolLive = stream.timeline.some((part) => part.type === 'tool' && part.live);
  const clarifyLive = stream.timeline.some((part) => part.type === 'clarify' && part.live);
  restoreClarifyHost(answerEl, savedClarifyHost || stream.dom?.clarifyHost);
  // Agent turns keep the status chip for the whole stream — including the quiet
  // gap after a tool finishes and before the next think/answer tokens arrive.
  const agentStreaming = streaming && !!stream.useAgent;
  if (toolLive || clarifyLive || thinkingOpen || agentStreaming || (streaming && !cleaned && !hasTimeline)) {
    statusEl.classList.remove('is-hidden');
    thinkingOrb.play();
    if (toolLive) {
      // Label is set by the tool_call agent event.
    } else if (clarifyLive) {
      setStreamThinkingLabel(stream, 'Waiting for your answers…');
    } else if (thinkingOpen) {
      setStreamThinkingLabel(stream, 'Reasoning…');
    } else if (agentStreaming) {
      const base = String(thinkingLabel.dataset.base || '').trim();
      // After tools, never leave a blank/stale chip — fall back to Processing.
      if (!base || base === 'Reading results') {
        setStreamThinkingLabel(stream, 'Processing…');
      }
    }
  } else if (hasVisibleAnswer || (!streaming && (cleaned || hasTimeline))) {
    statusEl.classList.add('is-hidden');
    // Pause only — stop() is irreversible and a brief think/answer flicker
    // would leave a dead orb while the label shimmer keeps running.
    thinkingOrb.pause();
  }
  row.dataset.raw = cleaned;
  // Never force — respect user scroll-away while tokens arrive.
  scrollToBottom();
  if (desktop) {
    const idx = Number(row.dataset.msgIndex);
    const hasActivity = hasTimeline || thinkingOpen;
    // Open the pane before painting live cards. WebKit freezes CSS/WAAPI
    // animations that start while the sidebar is still width:0 / opacity:0.
    if (hasActivity) maybeAutoOpenTraceSidebar(convo.id);
    if (selectedTraceMsgIndex !== idx) {
      selectTraceMessage(idx, { animate: false, ensureOpen: false });
    } else {
      refreshTraceSidebar({ animate: false });
    }
  } else {
    syncLiveToolClocks(answerEl);
  }
  if (typeof kickLiveToolMotion === 'function' && (toolLive || clarifyLive)) {
    kickLiveToolMotion(answerEl);
    if (desktop && traceSidebarBody) kickLiveToolMotion(traceSidebarBody);
  }
}

