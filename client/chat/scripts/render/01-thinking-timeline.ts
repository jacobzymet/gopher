function stripThinkingTags(text: string) {
  return text
    .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, '')
    .replace(/<\/?(?:think|thinking)>/gi, '')
    .trim();
}

/** Split assistant text on <think>/<thinking> tags (incomplete open tags allowed while streaming). */
function parseThinkSegments(text: string) {
  const segments = [];
  const re = /<\/?(?:think|thinking)>/gi;
  let last = 0;
  let inThink = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const chunk = text.slice(last, match.index);
    if (chunk) segments.push({ type: inThink ? 'think' : 'text', content: chunk, open: false });
    inThink = !match[0].startsWith('</');
    last = match.index + match[0].length;
  }
  const tail = text.slice(last);
  if (tail || inThink) {
    segments.push({ type: inThink ? 'think' : 'text', content: tail, open: inThink });
  }
  return segments;
}

function renderThinkMarkdown(content: unknown, { cache = true } = {}) {
  return renderMarkdown(String(content || '').replace(/\s+$/, ''), { cache });
}

const THINK_CHEVRON =
  '<svg class="think-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function agentStepRailHtml() {
  return (
    '<div class="agent-step-rail">' +
      '<span class="agent-step-dot" aria-hidden="true">' +
        '<svg class="agent-step-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M20 6 9 17l-5-5"/>' +
        '</svg>' +
        '<svg class="agent-step-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round">' +
          '<path d="m7 7 10 10M17 7 7 17"/>' +
        '</svg>' +
        '<span class="agent-step-spinner"></span>' +
      '</span>' +
    '</div>'
  );
}

function wrapTimelineStep(innerHtml: string, {
  think = false,
  live = false,
  done = false,
  failed = false,
  running = false,
  justSettled = false,
  startedAt = 0,
  toolName = '',
  toolId = '',
} = {}) {
  const classes = ['agent-step'];
  if (think) classes.push('is-think');
  if (live) classes.push('is-live');
  if (done) classes.push('is-done');
  if (failed) classes.push('is-failed');
  if (running) classes.push('is-running');
  if (justSettled) classes.push('is-just-done');
  const attrs = [];
  if (toolId) attrs.push('data-tool-id="' + escapeHtml(toolId) + '"');
  if (toolName) attrs.push('data-tool-name="' + escapeHtml(toolName) + '"');
  if (startedAt) attrs.push('data-tool-started="' + String(startedAt) + '"');
  return (
    '<div class="' + classes.join(' ') + '"' + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' +
      agentStepRailHtml() +
      innerHtml +
    '</div>'
  );
}

function renderThinkBlock(content: unknown, { open, streaming, forceOpen = false }: { open?: boolean; streaming?: boolean; forceOpen?: boolean } = {}) {
  const mode = settings.thinking;
  if (mode === 'hidden') return '';
  const live = streaming && open;
  const md = renderThinkMarkdown(content, { cache: !live });
  // Live ticker stays chrome-less unless the sidebar forces a details shell.
  if (live && mode !== 'visible' && !forceOpen) {
    return wrapTimelineStep(
      '<div class="think-live" aria-label="Reasoning progress">' +
        '<div class="think-stream">' + md + '</div>' +
      '</div>',
      { think: true, live: true }
    );
  }
  // Sidebar prefers expanded reasoning; main bubble still respects collapse setting.
  const detailsOpen = forceOpen || mode === 'visible' || (mode === 'collapsed' && live);
  const summary = live
    ? '<span class="think-summary-label thinking-label">Reasoning</span>' + THINK_CHEVRON
    : '<span class="think-summary-label">Reasoning</span>' + THINK_CHEVRON;
  const body = live
    ? '<div class="think-stream">' + md + '</div>'
    : '<div class="think-body">' + md + '</div>';
  const details =
    '<details class="think-block' + (live ? ' is-streaming' : '') + '"' +
    (detailsOpen ? ' open' : '') + '>' +
    '<summary>' + summary + '</summary>' +
    body +
    '</details>';
  return wrapTimelineStep(details, { think: true, live, done: !live });
}

function committedPartHtml(part: TimelinePart | null | undefined, { forceOpenThinking = false } = {}) {
  if (!part) return '';
  if (part.type === 'think') {
    if (!String(part.content || '').trim()) return '';
    return renderThinkBlock(part.content, {
      open: false,
      streaming: false,
      forceOpen: forceOpenThinking,
    });
  }
  if (part.type === 'tool') return agentStepHtml(part);
  if (part.type === 'clarify') {
    const header = 'Clarifying questions';
    const detail = part.live
      ? 'Waiting for your answers'
      : (part.summary || 'Goal refined');
    return wrapTimelineStep(
      '<div class="agent-step-card">' +
        '<div class="agent-step-kind">' + escapeHtml(header) + '</div>' +
        '<div class="agent-step-detail">' + escapeHtml(detail) + '</div>' +
      '</div>',
      { live: !!part.live, done: !part.live }
    );
  }
  if (part.type === 'notice') {
    const text = String(part.content || '').trim();
    if (!text) return '';
    const toneClass = part.tone === 'ok' ? ' is-ok' : '';
    return (
      '<div class="agent-step is-notice is-done' + toneClass + '">' +
        agentStepRailHtml() +
        '<div class="agent-step-card"><div class="agent-step-notice">' +
          escapeHtml(text) +
        '</div></div>' +
      '</div>'
    );
  }
  return '';
}

function renderCommittedParts(parts: TimelinePart[] | null | undefined, { forceOpenThinking = false } = {}) {
  if (!parts || !parts.length) return '';
  let html = '';
  for (const part of parts) html += committedPartHtml(part, { forceOpenThinking });
  return html;
}

function splitSealedTextParts(parts: TimelinePart[] | null | undefined) {
  const list = Array.isArray(parts) ? parts : [];
  let lastToolIndex = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.type === 'tool') lastToolIndex = i;
  }
  const processNotes = [];
  const answerChunks = [];
  for (let i = 0; i < list.length; i++) {
    const part = list[i];
    if (!part || part.type !== 'text') continue;
    const chunk = String(part.content || '');
    if (!chunk.trim()) continue;
    if (lastToolIndex >= 0 && i < lastToolIndex) {
      processNotes.push(chunk);
    } else {
      answerChunks.push(chunk);
    }
  }
  return { processNotes, answerChunks };
}

function renderProcessNotesFold(notes: string[] | null | undefined, { collapsed = true } = {}) {
  if (!notes || !notes.length) return '';
  const label = notes.length === 1
    ? '1 note while working'
    : (notes.length + ' notes while working');
  const body = notes.map((note) => (
    '<div class="agent-process-note">' + renderMarkdown(note) + '</div>'
  )).join('');
  return (
    '<div class="agent-timeline-fold agent-process-notes' + (collapsed ? ' is-collapsed' : '') + '">' +
      '<button type="button" class="agent-timeline-fold-toggle" aria-expanded="' +
        (collapsed ? 'false' : 'true') + '">' +
        '<span>' + escapeHtml(label) + '</span>' +
        THINK_CHEVRON +
      '</button>' +
      '<div class="agent-timeline-fold-panel">' +
        '<div class="agent-timeline-fold-inner">' + body + '</div>' +
      '</div>' +
    '</div>'
  );
}

function readProcessNotesCollapsed(root: HTMLElement | null | undefined, fallback = true) {
  const fold = root && (root.querySelector('.agent-process-notes') as HTMLElement);
  if (!fold) return fallback;
  return fold.classList.contains('is-collapsed');
}

function sealedContentSignature(parts: TimelinePart[] | null | undefined) {
  const { processNotes, answerChunks } = splitSealedTextParts(parts);
  return processNotes.join('\0') + '\n' + answerChunks.join('\0');
}

function renderSealedAnswerHtml(parts: TimelinePart[] | null | undefined, { notesCollapsed = true } = {}) {
  const { processNotes, answerChunks } = splitSealedTextParts(parts);
  const notesHtml = renderProcessNotesFold(processNotes, { collapsed: notesCollapsed });
  let text = '';
  for (const chunk of answerChunks) {
    if (text) text += '\n\n';
    text += chunk;
  }
  const answerHtml = text.trim()
    ? '<div class="agent-final-answer">' + renderMarkdown(text) + '</div>'
    : '';
  return notesHtml + answerHtml;
}

/**
 * Authoritative content_clear snapshots can arrive after tool_prepare cards from
 * the same model round. They may extend content immediately before those still-
 * live tools, but must never reach backward across a completed tool.
 */
function sealedTimelineMergeTarget(stream: ActiveStream | null | undefined, type: string) {
  const parts = Array.isArray(stream?.timeline) ? stream.timeline : [];
  let index = parts.length - 1;
  while (index >= 0 && parts[index]?.type === 'tool' && parts[index]?.live) index -= 1;
  return parts[index]?.type === type ? parts[index] : null;
}

function trailingLiveToolIndex(parts: TimelinePart[] | null | undefined) {
  const list = Array.isArray(parts) ? parts : [];
  let index = list.length;
  while (index > 0 && list[index - 1]?.type === 'tool' && list[index - 1]?.live) {
    index -= 1;
  }
  return index;
}

function stampTimelinePart(part: TimelinePart, stream?: Pick<ActiveStream, "_partSeq"> | undefined) {
  if (!part || part.uid) return part;
  if (part.id) {
    part.uid = 'id:' + part.id;
    return part;
  }
  if (stream) {
    stream._partSeq = (Number(stream._partSeq) || 0) + 1;
    part.uid = 't' + stream._partSeq;
    return part;
  }
  part.uid = 't' + Math.random().toString(36).slice(2, 10);
  return part;
}

function timelinePartKey(part: TimelinePart | null | undefined) {
  if (!part) return '';
  if (part.type === 'tool') {
    if (part.id) return 'tool:' + part.id;
    if (part.uid) return 'tool:' + part.uid;
    return 'tool:' + (part.name || '') + ':' + (part.startedAt || '');
  }
  if (part.uid) return part.type + ':' + part.uid;
  if (part.type === 'clarify' && part.id) return 'clarify:' + part.id;
  return part.type + ':' + String(part.content || '').slice(0, 80);
}

function insertTimelinePartBeforeTrailingLiveTools(stream: ActiveStream, part: TimelinePart) {
  if (!stream.timeline) stream.timeline = [];
  stampTimelinePart(part, stream);
  stream.timeline.splice(trailingLiveToolIndex(stream.timeline), 0, part);
}

function ensureSealedTimelineText(stream: ActiveStream, text: unknown) {
  const sealed = String(text || '').trim();
  if (!sealed) return;
  const last = sealedTimelineMergeTarget(stream, 'text');
  if (last && String(last.content || '').trim() === sealed) return;
  if (last && sealed.startsWith(String(last.content || '').trim())) {
    last.content = sealed;
    return;
  }
  insertTimelinePartBeforeTrailingLiveTools(stream, { type: 'text', content: sealed });
}

function ensureSealedTimelineThink(stream: ActiveStream, reasoning: unknown) {
  const sealed = String(reasoning || '').trim();
  if (!sealed) return;
  const last = sealedTimelineMergeTarget(stream, 'think');
  if (last && String(last.content || '').trim() === sealed) return;
  if (last && sealed.startsWith(String(last.content || '').trim())) {
    last.content = sealed;
    return;
  }
  insertTimelinePartBeforeTrailingLiveTools(stream, { type: 'think', content: sealed });
}

/** Move the current typer buffer into stream.timeline, then clear the buffer. */
function commitStreamBuffer(stream: ActiveStream, typer: Pick<StreamTyper, "target" | "clear">) {
  let text = typer.target || '';
  if (!String(text).trim()) {
    typer.clear();
    stream.partial = '';
    return false;
  }
  if (isThinkingOpen(text)) text += '</think>';
  const { cleaned } = applyMemoryUpdateProtocol(text, { streaming: false });
  const segments = parseThinkSegments(cleaned || text);
  for (const segment of segments) {
    const content = String(segment.content || '');
    if (!content.trim()) continue;
    insertTimelinePartBeforeTrailingLiveTools(
      stream,
      { type: segment.type === 'think' ? 'think' : 'text', content }
    );
  }
  typer.clear();
  stream.partial = '';
  return true;
}

/** Keep reasoning/tools; drop the superseded draft so the steered reply can print. */
function sealSteerThinkAndDiscardDraft(stream: ActiveStream, typer: Pick<StreamTyper, "target" | "clear"> | null | undefined) {
  let text = typer?.target || stream?.partial || '';
  if (isThinkingOpen(text)) text += '</think>';
  const { cleaned } = applyMemoryUpdateProtocol(text, { streaming: false });
  for (const segment of parseThinkSegments(cleaned || text)) {
    const content = String(segment.content || '');
    if (!content.trim() || segment.type !== 'think') continue;
    if (!stream.timeline) stream.timeline = [];
    insertTimelinePartBeforeTrailingLiveTools(stream, { type: 'think', content });
  }
  if (typer && typeof typer.clear === 'function') typer.clear();
  if (stream) stream.partial = '';
}

