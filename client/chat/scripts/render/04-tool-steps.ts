function skillLabel(name: string | undefined, args: unknown) {
  if (name === 'list_chats') return 'List past chats';
  if (name === 'search_chats') return 'Search past chats';
  if (name === 'read_chat') return 'Read past chat';
  if (name === 'web_search') return 'Web search';
  if (name === 'fetch_url') return 'Fetch URL';
  if (name === 'ask_user') return 'Clarifying questions';
  if (name === 'activate_skill' || name === 'read_skill') return 'Activate skill';
  if (name === 'read_file') return 'Read file';
  if (name === 'read_tool_history') return 'Read tool history';
  if (name === 'apply_patch') return 'Apply patch';
  if (name === 'list_dir') return 'List folder';
  if (name === 'glob') return 'Find files';
  if (name === 'grep') return 'Search files';
  if (name === 'write_file') return 'Write file';
  if (name === 'str_replace') return 'Edit file';
  if (name === 'delete_file') return 'Delete file';
  if (name === 'run_terminal') return 'Terminal';
  if (name === 'wait_terminal') return 'Command session';
  if (name === 'browser_navigate') return 'Open page';
  if (name === 'browser_snapshot') return 'Page snapshot';
  if (name === 'browser_click') return 'Click';
  if (name === 'browser_type') return 'Type in page';
  if (name === 'browser_press') return 'Press key';
  if (name === 'browser_wait') return 'Wait';
  if (name === 'browser_screenshot') return 'Screenshot';
  if (name === 'browser_evaluate') return 'Run in page';
  if (name === 'browser_close') return 'Close browser';
  if (name === 'show_image') return 'Show image';
  return name || 'Skill';
}

function toolBodyFromArgs(name: string | undefined, args: JsonObject | null | undefined) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'apply_patch') return String(a.patch || '');
  if (name === 'write_file') return String(a.content || '');
  if (name === 'str_replace') {
    const oldText = String(a.old_string || a.old || '');
    const newText = String(a.new_string || a.new || '');
    if (!oldText && !newText) return '';
    return (oldText ? ('- ' + oldText) : '') + (oldText && newText ? '\n\n' : '') + (newText ? ('+ ' + newText) : '');
  }
  if (name === 'run_terminal') return String(a.command || '');
  if (name === 'wait_terminal') return a.terminate ? 'Terminate session ' + String(a.session_id || '') : '';
  if (name === 'browser_evaluate') return String(a.expression || '');
  if (name === 'browser_type') return String(a.text || '');
  return '';
}

function skillLiveVerb(name: string | undefined, args: ToolStatusArgs | null | undefined) {
  if (name === 'list_chats') return 'Listing past chats';
  if (name === 'search_chats') return 'Searching past chats';
  if (name === 'read_chat') return 'Reading past chat';
  const approval = args && args.approval;
  const executing = !!(args && args.executing);
  if (name === 'web_search') return 'Searching';
  if (name === 'fetch_url') return 'Fetching';
  if (name === 'ask_user') return 'Waiting';
  if (name === 'activate_skill' || name === 'read_skill') return 'Loading skill';
  if (name === 'read_file' || name === 'read_tool_history') return 'Reading';
  if (name === 'list_dir' || name === 'glob' || name === 'grep') return 'Scanning';
  if (name === 'write_file' || name === 'str_replace' || name === 'apply_patch' || name === 'delete_file') {
    if (executing) {
      if (name === 'delete_file') return 'Deleting';
      if (name === 'str_replace' || name === 'apply_patch') return 'Editing';
      return 'Writing';
    }
    if (approval === 'allowed') return 'Queued';
    return 'Drafting';
  }
  if (name === 'run_terminal' || name === 'wait_terminal') {
    if (executing) return 'Running';
    if (approval === 'allowed') return 'Queued';
    return 'Drafting';
  }
  if (String(name || '').startsWith('browser_')) {
    if (executing) {
      if (name === 'browser_navigate') return 'Opening';
      if (name === 'browser_snapshot') return 'Reading page';
      if (name === 'browser_click') return 'Clicking';
      if (name === 'browser_type') return 'Typing';
      if (name === 'browser_screenshot') return 'Capturing';
      if (name === 'browser_close') return 'Closing';
      return 'Browsing';
    }
    if (approval === 'allowed') return 'Queued';
    return 'Drafting';
  }
  if (name === 'show_image') {
    if (executing) return 'Loading image';
    if (approval === 'allowed') return 'Queued';
    return 'Drafting';
  }
  return 'Running';
}

function liveToolStatusText(part: TimelinePart | null | undefined) {
  if (!part) return '';
  const verb = skillLiveVerb(part.name, part);
  const detail = String(part.detail || '').trim();
  return detail ? (verb + ' ' + detail + '…') : (verb + '…');
}

function liveToolStatusLabel(stream: ActiveStream | null | undefined, payload: LiveToolPayload | null | undefined) {
  const tools = (stream && stream.timeline ? stream.timeline : []).filter((part) => part && part.type === 'tool' && part.live);
  const running = tools.find((part) => part.executing);
  if (running) return liveToolStatusText(running);
  const pending = tools.filter((part) => part.approval === 'pending').length;
  if (pending) {
    return pending === 1 ? 'Waiting for your approval…' : ('Waiting for approval · ' + pending + ' files');
  }
  const live = tools[tools.length - 1];
  if (live) return liveToolStatusText(live);
  if (payload && payload.name) return skillLiveVerb(payload.name, payload.arguments || {}) + '…';
  return 'Processing…';
}

function skillToolIcon(name: string | undefined, args: unknown) {
  if (name === 'web_search' || name === 'search_chats') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  }
  if (name === 'fetch_url') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/><path d="M3 12h18"/></svg>';
  }
  if (name === 'activate_skill' || name === 'read_skill') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><path d="m6.8 6.8 2.1 2.1"/><path d="M3 12h3"/><path d="m6.8 17.2 2.1-2.1"/><path d="M12 18v3"/><path d="m17.2 17.2-2.1-2.1"/><path d="M18 12h3"/><path d="m17.2 6.8-2.1 2.1"/><circle cx="12" cy="12" r="2.2"/></svg>';
  }
  if (name === 'ask_user') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>';
  }
  if (name === 'run_terminal' || name === 'wait_terminal') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>';
  }
  if (name === 'show_image') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-4.5-4.5L9 18"/></svg>';
  }
  if (String(name || '').startsWith('browser_')) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/><circle cx="7" cy="6" r="0.6" fill="currentColor"/><circle cx="9.5" cy="6" r="0.6" fill="currentColor"/></svg>';
  }
  if (name === 'read_tool_history' || name === 'apply_patch' || name === 'read_file' || name === 'write_file' || name === 'str_replace' || name === 'delete_file' || name === 'list_dir' || name === 'glob' || name === 'grep') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>';
}

function formatToolElapsed(ms: number) {
  const sec = Math.max(0, Number(ms) || 0) / 1000;
  if (sec < 9.95) return sec.toFixed(1) + 's';
  return Math.round(sec) + 's';
}

function toolDurationMs(part: Partial<TimelinePart> | null | undefined, now = Date.now()) {
  if (!part) return 0;
  if (part.live && part.startedAt) return Math.max(0, now - Number(part.startedAt));
  if (Number.isFinite(part.durationMs) && part.durationMs! >= 0) return part.durationMs!;
  if (part.startedAt && part.endedAt) return Math.max(0, Number(part.endedAt) - Number(part.startedAt));
  return 0;
}

let toolClockTimer = 0;
let toolClockRoot: HTMLElement | null = null;

function tickLiveToolClocks(root: { querySelectorAll: (arg0: string) => NodeListOf<HTMLElement>; }) {
  if (!root) return 0;
  const now = Date.now();
  const nodes = (root.querySelectorAll('.agent-step.is-live[data-tool-started] .agent-step-elapsed') as NodeListOf<HTMLElement>);
  nodes.forEach((el) => {
    const step = (el.closest('.agent-step') as HTMLElement);
    const started = Number(step && step.dataset.toolStarted);
    if (!started) return;
    const next = formatToolElapsed(now - started);
    if (el.textContent !== next) el.textContent = next;
  });
  return nodes.length;
}

function stopLiveToolClocks() {
  if (toolClockTimer) {
    window.clearTimeout(toolClockTimer);
    toolClockTimer = 0;
  }
  toolClockRoot = null;
}

function syncLiveToolClocks(root: HTMLElement) {
  if (!root || !tickLiveToolClocks(root)) {
    if (!root || toolClockRoot === root) stopLiveToolClocks();
    return;
  }
  toolClockRoot = root;
  if (toolClockTimer) return;
  const tick = () => {
    if (!toolClockRoot || !tickLiveToolClocks(toolClockRoot)) {
      stopLiveToolClocks();
      return;
    }
    toolClockTimer = window.setTimeout(tick, prefersReducedMotion() ? 400 : 90);
  };
  toolClockTimer = window.setTimeout(tick, prefersReducedMotion() ? 400 : 90);
}

function scheduleJustSettledClear(part: TimelinePart | null | undefined) {
  if (!part || part.settleTimer) return;
  part.settleTimer = window.setTimeout(() => {
    part.justSettled = false;
    part.settleTimer = 0;
  }, 450);
}

const liveMotionRetryByRoot: WeakMap<HTMLElement, number> = new WeakMap();

function liveToolElVisible(el: HTMLElement) {
  if (!el || !el.isConnected) return false;
  const sidebar = (el.closest('.trace-sidebar') as HTMLElement);
  if (sidebar) {
    if (typeof chatShell !== 'undefined' && chatShell?.classList.contains('trace-collapsed')) return false;
    const pane = sidebar.getBoundingClientRect();
    if (pane.width < 8) return false;
    const opacity = Number.parseFloat(window.getComputedStyle(sidebar).opacity);
    if (Number.isFinite(opacity) && opacity < 0.2) return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 1 && rect.height > 0.5;
}

function cssAttrValue(value: string) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findTimelineToolStep(root: HTMLElement | null | undefined, part: TimelinePart | null | undefined) {
  if (!root || !part) return null;
  if (part.id) {
    const byId = (root.querySelector('.agent-step[data-tool-id="' + cssAttrValue(part.id) + '"]') as HTMLElement);
    if (byId) return byId;
  }
  const key = timelinePartKey(part);
  if (key) {
    const byKey = (root.querySelector('.agent-step[data-timeline-key="' + cssAttrValue(key) + '"]') as HTMLElement);
    if (byKey) return byKey;
  }
  const name = part.name || '';
  const started = part.startedAt ? String(part.startedAt) : '';
  if (name && started) {
    const matches = (root.querySelectorAll(
      '.agent-step[data-tool-name="' + cssAttrValue(name) + '"][data-tool-started="' + cssAttrValue(started) + '"]'
    ) as NodeListOf<HTMLElement>);
    if (matches.length === 1) return matches[0];
  }
  if (name) {
    const matches = (root.querySelectorAll('.agent-step.is-live[data-tool-name="' + cssAttrValue(name) + '"]') as NodeListOf<HTMLElement>);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function findLiveToolStep(root: HTMLElement | null | undefined, part: TimelinePart | null | undefined) {
  return findTimelineToolStep(root, part);
}

/** Update draft text in place so the rail spinner is not rebuilt every token. */
function patchLiveToolBodies(root: HTMLElement, parts: TimelinePart[] | null | undefined) {
  if (!root) return;
  (parts || []).forEach((part) => {
    if (!part || part.type !== 'tool' || !part.live) return;
    const step = findTimelineToolStep(root, part);
    const card = step && (step.querySelector('.agent-step-card') as HTMLElement);
    if (!card) return;
    const detail = String(part.detail || '');
    let detailValue = (step.querySelector(':scope > .agent-step-card .agent-step-detail-value') as HTMLElement);
    if (detail) {
      if (!detailValue) {
        const wrap = (document.createElement('div') as HTMLElement);
        wrap.className = 'agent-step-detail';
        wrap.innerHTML = '<em>' + escapeHtml(skillDetailLabel(part.name)) + '</em>'
          + '<span class="agent-step-detail-value"></span>';
        const head = (card.querySelector('.agent-step-head') as HTMLElement);
        if (head && head.nextSibling) card.insertBefore(wrap, head.nextSibling);
        else card.appendChild(wrap);
        detailValue = (wrap.querySelector('.agent-step-detail-value') as HTMLElement);
      }
      if (detailValue && detailValue.textContent !== detail) detailValue.textContent = detail;
    }
    const fullBody = String(part.body || toolBodyFromArgs(part.name, part.args) || '');
    const bodyText = part.approval === 'pending' ? fullBody : fullBody.length > 20000 ? fullBody.slice(0, 20000) + '\n[Preview truncated]' : fullBody;
    let bodyWrap = (step.querySelector(':scope > .agent-step-card .agent-step-body') as HTMLElement);
    let streamEl = bodyWrap && (bodyWrap.querySelector('.agent-step-body-stream') as HTMLElement);
    if (!bodyText) {
      if (bodyWrap) bodyWrap.remove();
      return;
    }
    if (!streamEl) {
      bodyWrap = (document.createElement('div') as HTMLElement);
      bodyWrap.className = 'agent-step-body is-live';
      streamEl = (document.createElement('pre') as HTMLElement);
      streamEl.className = 'agent-step-body-stream';
      bodyWrap.appendChild(streamEl);
      const before = (card.querySelector('.agent-step-await, .agent-step-result, .agent-step-shot') as HTMLElement);
      if (before) card.insertBefore(bodyWrap, before);
      else card.appendChild(bodyWrap);
    }
    if (streamEl.textContent !== bodyText) {
      streamEl.textContent = bodyText;
      streamEl.scrollTop = streamEl.scrollHeight;
    }
  });
}

function kickLiveToolMotion(root: HTMLElement) {
  if (!root || prefersReducedMotion()) return;
  const jobs: Array<[string, Keyframe[], { duration: number; easing: string }]> = [
    [
      '.agent-step.is-live .agent-step-spinner',
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 750, easing: 'linear' },
    ],
    [
      '.agent-step.is-live .agent-step-scan',
      [{ transform: 'translate3d(-120%, 0, 0)' }, { transform: 'translate3d(120%, 0, 0)' }],
      { duration: 2400, easing: 'ease-in-out' },
    ],
    [
      '.agent-step.is-live .agent-step-await-bar',
      [{ transform: 'translate3d(-130%, 0, 0)' }, { transform: 'translate3d(340%, 0, 0)' }],
      { duration: 1150, easing: 'ease-in-out' },
    ],
  ];
  const apply = () => {
    if (!root.isConnected) return false;
    let waitingForLayout = false;
    jobs.forEach(([selector, frames, timing]) => {
      (root.querySelectorAll(selector) as NodeListOf<HTMLElement>).forEach((el) => {
        if (!liveToolElVisible(el)) {
          waitingForLayout = true;
          return;
        }
        const step = (el.closest('.agent-step') as HTMLElement);
        const gen = String((step && step.dataset.toolStarted) || 'live');
        const running = typeof el.getAnimations === 'function'
          && el.getAnimations().some((anim) => anim.playState === 'running');
        if (running) {
          el.dataset.motionGen = gen;
          el.dataset.motionOn = '1';
          return;
        }
        el.dataset.motionGen = gen;
        el.dataset.motionOn = '1';
        if (typeof el.animate === 'function') {
          el.animate(frames, {
            duration: timing.duration,
            easing: timing.easing,
            iterations: Infinity,
            composite: 'replace',
          });
        }
      });
    });
    return waitingForLayout;
  };
  const scheduleRetry = () => {
    const tries = (liveMotionRetryByRoot.get(root) || 0) + 1;
    if (tries > 24) {
      liveMotionRetryByRoot.delete(root);
      return;
    }
    liveMotionRetryByRoot.set(root, tries);
    window.setTimeout(() => kickLiveToolMotion(root), 70);
  };
  if (apply()) {
    scheduleRetry();
    return;
  }
  window.requestAnimationFrame(() => {
    if (apply()) scheduleRetry();
    else liveMotionRetryByRoot.delete(root);
  });
}

function afterTraceTimelinePaint({ live = false, rebuilt = false, entered = [] }: { live?: boolean; rebuilt?: boolean; entered?: HTMLElement[] } = {}) {
  if (!traceSidebarBody) return;
  if (live) {
    const paintKey = 'live:' + String(selectedTraceMsgIndex);
    if (traceSidebarBody.dataset.paintKey !== paintKey) {
      delete traceSidebarBody.dataset.liveStepCount;
      traceSidebarBody.dataset.paintKey = paintKey;
    }
    const prev = Number(traceSidebarBody.dataset.liveStepCount || 0);
    const steps = (traceSidebarBody.querySelectorAll(':scope > .agent-step') as NodeListOf<HTMLElement>);
    const toEnter = Array.isArray(entered) && entered.length
      ? entered
      : (rebuilt ? Array.from(steps).slice(prev) : []);
    toEnter.forEach((el, index) => {
      if (!el || el.classList.contains('is-live') || el.classList.contains('is-live-think')) return;
      motionEnter(el, {
        y: 10,
        duration: 240,
        delay: Math.min(index, 5) * 28,
      });
    });
    traceSidebarBody.dataset.liveStepCount = String(steps.length);
    syncLiveToolClocks(traceSidebarBody);
    kickLiveToolMotion(traceSidebarBody);
  } else {
    delete traceSidebarBody.dataset.liveStepCount;
    delete traceSidebarBody.dataset.paintKey;
    stopLiveToolClocks();
  }
}

