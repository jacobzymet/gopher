function syncTraceSelectionClasses() {
  if (!chatThread) return;
  (chatThread.querySelectorAll('.msg-role-assistant') as NodeListOf<HTMLElement>).forEach((row) => {
    const idx = Number(row.dataset.msgIndex);
    row.classList.toggle(
      'is-trace-selected',
      selectedTraceMsgIndex != null && idx === selectedTraceMsgIndex
    );
  });
}

function isTraceSidebarNearBottom() {
  if (!traceSidebarBody) return true;
  const gap = traceSidebarBody.scrollHeight - traceSidebarBody.scrollTop - traceSidebarBody.clientHeight;
  return gap <= 48;
}

function scrollTraceSidebarToBottom({ force = false } = {}) {
  if (!traceSidebarBody) return;
  if (!force && !stickTraceSidebar) return;
  traceSidebarBody.scrollTop = traceSidebarBody.scrollHeight;
  scrollThinkStreams(traceSidebarBody);
}

function htmlToElement(html?: string): HTMLElement | null {
  const wrap = (document.createElement('div') as HTMLElement);
  wrap.innerHTML = String(html || '');
  return wrap.firstElementChild as HTMLElement | null;
}

function stepChromeSignature(part: TimelinePart | null | undefined) {
  if (!part) return '';
  if (part.type === 'tool') {
    if (part.live) {
      return ['live', part.executing ? '1' : '0', part.approval || '', part.justSettled ? '1' : '0'].join('\0');
    }
    return [
      'done',
      typeof part.ok === 'boolean' ? String(part.ok) : '',
      part.running ? '1' : '0',
      part.result || '',
      part.note || '',
      part.approval || '',
      part.justSettled ? '1' : '0',
      part.detail || '',
      part.image ? '1' : '0',
    ].join('\0');
  }
  if (part.type === 'think' || part.type === 'text' || part.type === 'notice') {
    return String(part.content || '');
  }
  if (part.type === 'clarify') {
    return [part.live ? '1' : '0', part.summary || ''].join('\0');
  }
  return '';
}

function copyStepChrome(step: HTMLElement, next: HTMLElement) {
  const keepKey = step.dataset.timelineKey;
  const keepChrome = step.dataset.stepChrome;
  step.className = next.className;
  const allowed = new Set(['class', 'data-timeline-key', 'data-step-chrome']);
  for (const attr of Array.from(next.attributes)) {
    if (attr.name === 'class') continue;
    step.setAttribute(attr.name, attr.value);
    allowed.add(attr.name);
  }
  for (const attr of Array.from(step.attributes)) {
    if (allowed.has(attr.name)) continue;
    if (attr.name.startsWith('data-')) step.removeAttribute(attr.name);
  }
  step.innerHTML = next.innerHTML;
  if (keepKey) step.dataset.timelineKey = keepKey;
  if (keepChrome) step.dataset.stepChrome = keepChrome;
}

function timelineItemsFromParts(parts: TimelinePart[] | null | undefined, { forceOpenThinking = false } = {}) {
  const items = [];
  for (const part of parts || []) {
    const html = committedPartHtml(part, { forceOpenThinking });
    if (!html) continue;
    stampTimelinePart(part);
    items.push({
      key: timelinePartKey(part),
      html,
      chrome: stepChromeSignature(part),
    });
  }
  return items;
}

function stampTimelineKeysOnRoot(root: HTMLElement, parts: TimelinePart[] | null | undefined, { forceOpenThinking = false } = {}) {
  if (!root) return;
  const steps = Array.from((root.querySelectorAll(':scope > .agent-step') as NodeListOf<HTMLElement>)).filter(
    (el) => !el.classList.contains('is-live-think')
  );
  const items = timelineItemsFromParts(parts, { forceOpenThinking });
  items.forEach((item, index) => {
    const step = steps[index];
    if (!step) return;
    step.dataset.timelineKey = item.key;
    step.dataset.stepChrome = item.chrome;
  });
}

function patchTimelineToolChrome(root: HTMLElement | null | undefined, parts: TimelinePart[] | null | undefined) {
  if (!root) return;
  (parts || []).forEach((part) => {
    if (!part || part.type !== 'tool') return;
    const step = findTimelineToolStep(root, part);
    if (!step) return;
    const chrome = stepChromeSignature(part);
    if (step.dataset.stepChrome === chrome) return;
    const next = htmlToElement(agentStepHtml(part));
    if (!next) return;
    step.dataset.stepChrome = chrome;
    copyStepChrome(step, next);
    step.dataset.timelineKey = timelinePartKey(stampTimelinePart(part));
    step.dataset.stepChrome = chrome;
    if (typeof enhanceCodeBlocks === 'function') enhanceCodeBlocks(step);
  });
}

function liveThinkStepHtml() {
  return wrapTimelineStep(
    '<details class="think-block is-streaming" open>' +
      '<summary>' +
        '<span class="think-summary-label thinking-label">Reasoning</span>' +
        THINK_CHEVRON +
      '</summary>' +
      '<div class="think-stream"></div>' +
    '</details>',
    { think: true, live: true }
  );
}

function reconcileTimelineSteps(root: HTMLElement, items: { key: string; html: string; chrome: string; }[], { liveThinkHtml = '' } = {}) {
  const inserted: HTMLElement[] = [];
  const patched: HTMLElement[] = [];
  const keyed = new Map<string, HTMLElement | null>();
  Array.from(root.children as HTMLCollectionOf<HTMLElement>).forEach((el) => {
    if (!el.classList?.contains('agent-step')) return;
    if (el.classList.contains('is-live-think')) return;
    const key = el.dataset.timelineKey;
    if (key && !keyed.has(key)) keyed.set(key, el);
  });
  const used = new Set();
  let node = root.firstElementChild;
  const skipNonSteps = () => {
    while (node && !(node.classList && node.classList.contains('agent-step'))) {
      const extra = node;
      node = node.nextElementSibling;
      extra.remove();
    }
  };
  for (const item of items) {
    skipNonSteps();
    let el = keyed.get(item.key);
    if (el && used.has(el)) el = null;
    if (!el) {
      el = htmlToElement(item.html);
      if (!el) continue;
      el.dataset.timelineKey = item.key;
      el.dataset.stepChrome = item.chrome;
      root.insertBefore(el, node);
      inserted.push(el);
    } else {
      if (el !== node) root.insertBefore(el, node);
      if (el.dataset.stepChrome !== item.chrome) {
        const next = htmlToElement(item.html);
        if (next) {
          el.dataset.stepChrome = item.chrome;
          copyStepChrome(el, next);
          el.dataset.timelineKey = item.key;
          el.dataset.stepChrome = item.chrome;
          patched.push(el);
        }
      }
    }
    used.add(el);
    node = el.nextElementSibling;
  }
  if (liveThinkHtml) {
    skipNonSteps();
    let liveThink = (root.querySelector(':scope > .agent-step.is-live-think') as HTMLElement | null);
    if (!liveThink) {
      liveThink = htmlToElement(liveThinkHtml);
      if (liveThink) {
        liveThink.classList.add('is-live-think');
        liveThink.dataset.timelineKey = 'live-think';
        root.insertBefore(liveThink, node);
        inserted.push(liveThink);
        node = liveThink.nextElementSibling;
        used.add(liveThink);
      }
    } else {
      if (liveThink !== node) root.insertBefore(liveThink, node);
      node = liveThink.nextElementSibling;
      used.add(liveThink);
    }
  }
  while (node) {
    const next = node.nextElementSibling;
    if (!used.has(node)) node.remove();
    node = next;
  }
  return { inserted, patched };
}

function paintTraceSidebarContent(message: RenderMessage | null | undefined, { live = false } = {}) {
  if (!traceSidebarBody) return;
  const wasNearBottom = isTraceSidebarNearBottom();
  const title = traceSidebarTitle;
  if (!message) {
    if (title && title.textContent !== 'Activity') title.textContent = 'Activity';
    if (!(traceSidebarBody.querySelector('.trace-sidebar-empty') as HTMLElement)) {
      traceSidebarBody.innerHTML =
        '<p class="trace-sidebar-empty">Select an assistant reply to inspect reasoning and tool steps.</p>';
    }
    traceSidebar?.classList.add('is-empty');
    delete traceSidebarBody.dataset.sidebarSig;
    afterTraceTimelinePaint({ live: false });
    return;
  }
  let timelineHtml = '';
  let stepCount = 0;
  if (live && Array.isArray(message.parts)) {
    // Memory notices land on the timeline at turn end; keep them after live reasoning.
    // Steer notices stay in chronological order.
    const earlyParts: TimelinePart[] = [];
    const deferredNotices: TimelinePart[] = [];
    for (const part of message.parts) {
      if (!part) continue;
      if (isDeferredMemoryNotice(part)) deferredNotices.push(part);
      else earlyParts.push(part);
    }
    stepCount = timelinePartCount(earlyParts);
    const liveSegments = message.content ? parseThinkSegments(message.content) : [];
    const openThink = liveSegments.find((seg) => seg.type === 'think' && seg.open);
    const closedThinks = liveSegments.filter(
      (seg) => seg.type === 'think' && !seg.open && String(seg.content || '').trim()
    );
    stepCount += closedThinks.length;
    if (deferredNotices.length) stepCount += timelinePartCount(deferredNotices);
    if (title) {
      const totalSteps = stepCount + (openThink ? 1 : 0);
      const nextTitle = live
        ? (totalSteps ? ('Live Activity · ' + totalSteps) : 'Live Activity')
        : (totalSteps ? ('Activity · ' + totalSteps) : 'Activity');
      if (title.textContent !== nextTitle) title.textContent = nextTitle;
    }
    if (!stepCount && !openThink) {
      if (!(traceSidebarBody.querySelector('.trace-sidebar-empty') as HTMLElement)) {
        traceSidebarBody.innerHTML =
          '<p class="trace-sidebar-empty">This reply has no reasoning or tool activity.</p>';
      }
      traceSidebar?.classList.add('is-empty');
      delete traceSidebarBody.dataset.sidebarSig;
      afterTraceTimelinePaint({ live: false });
      return;
    }
    traceSidebar?.classList.remove('is-empty');

    const items = timelineItemsFromParts(earlyParts, { forceOpenThinking: true });
    closedThinks.forEach((segment, index) => {
      const part = { type: 'think', uid: 'closed-' + index, content: segment.content };
      const html = committedPartHtml(part, { forceOpenThinking: true });
      if (!html) return;
      items.push({
        key: timelinePartKey(part),
        html,
        chrome: stepChromeSignature(part),
      });
    });
    items.push(...timelineItemsFromParts(deferredNotices, { forceOpenThinking: true }));
    const liveThinkHtml = openThink ? liveThinkStepHtml() : '';
    const { inserted, patched } = reconcileTimelineSteps(traceSidebarBody, items, { liveThinkHtml });
    inserted.concat(patched).forEach((el) => {
      if (typeof enhanceCodeBlocks !== 'function') return;
      enhanceCodeBlocks(el);
      (el.querySelectorAll('.think-body') as NodeListOf<HTMLElement>).forEach((node) => enhanceCodeBlocks(node));
    });
    traceSidebarBody.dataset.sidebarSig = 'live\0' + items.map((item) => item.key).join('\n');
    if (openThink) {
      const streamEl = (traceSidebarBody.querySelector(
        ':scope > .agent-step.is-live-think .think-stream, :scope > .agent-step.is-think.is-live .think-stream'
      ) as HTMLElement);
      if (streamEl) {
        if (streamEl.dataset.thinkRaw !== openThink.content) {
          streamEl.dataset.thinkRaw = openThink.content;
          streamEl.innerHTML = renderThinkMarkdown(openThink.content, { cache: false });
        }
        streamEl.scrollTop = streamEl.scrollHeight;
      }
    }
    patchLiveToolBodies(traceSidebarBody, earlyParts);
    afterTraceTimelinePaint({
      live: true,
      rebuilt: inserted.length > 0,
      entered: inserted,
    });
    if (stickTraceSidebar || wasNearBottom) {
      stickTraceSidebar = true;
      scrollTraceSidebarToBottom({ force: true });
    }
    return;
  } else {
    const collected = collectTimelineAndAnswer(message);
    timelineHtml = renderCommittedParts(collected.timelineParts, { forceOpenThinking: true });
    stepCount = collected.stepCount;
    if (title) {
      const nextTitle = stepCount ? ('Activity · ' + stepCount) : 'Activity';
      if (title.textContent !== nextTitle) title.textContent = nextTitle;
    }
    if (!timelineHtml.trim()) {
      if (!(traceSidebarBody.querySelector('.trace-sidebar-empty') as HTMLElement)) {
        traceSidebarBody.innerHTML =
          '<p class="trace-sidebar-empty">This reply has no reasoning or tool activity.</p>';
      }
      traceSidebar?.classList.add('is-empty');
      delete traceSidebarBody.dataset.sidebarSig;
      afterTraceTimelinePaint({ live: false });
      return;
    }
    traceSidebar?.classList.remove('is-empty');
    const staticSig = 'static\0' + timelineSignature(collected.timelineParts);
    if (traceSidebarBody.dataset.sidebarSig !== staticSig) {
      traceSidebarBody.innerHTML = timelineHtml;
      traceSidebarBody.dataset.sidebarSig = staticSig;
      enhanceCodeBlocks(traceSidebarBody);
      (traceSidebarBody.querySelectorAll('.think-body') as NodeListOf<HTMLElement>).forEach((el) => enhanceCodeBlocks(el));
    }
    afterTraceTimelinePaint({ live: false });
    if (stickTraceSidebar || wasNearBottom) {
      stickTraceSidebar = true;
      scrollTraceSidebarToBottom({ force: true });
    }
  }
}

function refreshTraceSidebar({ animate = false } = {}) {
  if (!isDesktopTraceLayout() || !traceSidebarBody) return;
  const convo = conversations.find((item) => item.id === activeId);
  let message: RenderMessage | null = null;
  let live = false;
  if (convo && selectedTraceMsgIndex != null) {
    const stream = activeStreams.get(convo.id);
    const streamingThis =
      stream
      && Number(stream.dom?.row?.dataset?.msgIndex) === selectedTraceMsgIndex;
    if (streamingThis) {
      live = true;
      message = {
        parts: stream.timeline,
        content: stream.partial || '',
      };
    } else {
      message = convo.messages[selectedTraceMsgIndex] || null;
      if (!message || message.role !== 'assistant') message = null;
    }
  }
  const paint = () => paintTraceSidebarContent(message, { live });
  if (!animate) {
    paint();
    return;
  }
  traceSidebarBody.classList.add('is-swap');
  window.clearTimeout(traceSidebarSwapTimer);
  traceSidebarSwapTimer = window.setTimeout(() => {
    paint();
    afterNextPaint(() => {
      traceSidebarBody.classList.remove('is-swap');
    });
  }, 140);
}

function selectTraceMessage(index: unknown, { animate = true, ensureOpen = false } = {}) {
  const next = Number.isFinite(index) ? Number(index) : null;
  const changed = selectedTraceMsgIndex !== next;
  selectedTraceMsgIndex = next;
  syncTraceSelectionClasses();
  if (changed) stickTraceSidebar = true;
  if (ensureOpen && isDesktopTraceLayout() && messageHasActivity(
    conversations.find((item) => item.id === activeId)?.messages?.[next!]
  )) {
    maybeAutoOpenTraceSidebar(activeId);
  }
  refreshTraceSidebar({ animate: animate && changed });
}

function setTraceSidebarOpen(open: boolean | undefined, { fromUser = false } = {}) {
  if (!chatShell) return;
  if (fromUser) {
    traceUserCollapsed = !open;
    if (open) traceAutoOpenedForStream = activeId;
  }
  chatShell.classList.toggle('trace-collapsed', !open);
  if (open) {
    window.requestAnimationFrame(() => {
      if (traceSidebarBody) kickLiveToolMotion(traceSidebarBody);
    });
  }
  if (btnExpandTrace) {
    btnExpandTrace.classList.toggle('is-active', open);
    btnExpandTrace.setAttribute('aria-pressed', open ? 'true' : 'false');
    btnExpandTrace.setAttribute('aria-expanded', open ? 'true' : 'false');
    btnExpandTrace.setAttribute('aria-label', open ? 'Hide activity sidebar' : 'Show activity sidebar');
    btnExpandTrace.title = open ? 'Hide activity' : 'Show activity';
  }
  if (open && stickTraceSidebar) {
    requestAnimationFrame(() => scrollTraceSidebarToBottom({ force: true }));
  }
}

function maybeAutoOpenTraceSidebar(convoId: string | null | undefined) {
  if (!isDesktopTraceLayout() || !convoId) return;
  if (settings.autoOpenTraceSidebar === false) return;
  if (traceUserCollapsed) return;
  if (traceAutoOpenedForStream === convoId) return;
  if (!chatShell.classList.contains('trace-collapsed')) {
    traceAutoOpenedForStream = convoId;
    return;
  }
  traceAutoOpenedForStream = convoId;
  stickTraceSidebar = true;
  setTraceSidebarOpen(true);
}

function resetTraceAutoOpenState() {
  traceAutoOpenedForStream = null;
  traceUserCollapsed = false;
  stickTraceSidebar = true;
}

function initTraceSidebarPreferred() {
  // Always start closed; open only when reasoning / tool activity begins.
  setTraceSidebarOpen(false);
}

function scrollThinkStreams(root: HTMLElement) {
  if (!root) return;
  (root.querySelectorAll('.think-stream, .agent-step-body.is-live .agent-step-body-stream') as NodeListOf<HTMLElement>).forEach((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

function isThinkingOpen(text: string) {
  if (!text) return false;
  return parseThinkSegments(text).some((segment) => segment.type === 'think' && segment.open);
}

