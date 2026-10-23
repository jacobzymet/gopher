function isDesktopTraceLayout() {
  return TRACE_DESKTOP_MQ.matches;
}

function timelinePartCount(parts: TimelinePart[] | null | undefined) {
  if (!Array.isArray(parts)) return 0;
  return parts.reduce((count, part) => {
    if (!part) return count;
    if (part.type === 'think' || part.type === 'tool' || part.type === 'clarify' || part.type === 'notice') return count + 1;
    return count;
  }, 0);
}

function isDeferredMemoryNotice(part: TimelinePart | null | undefined) {
  // Memory notices are stamped at turn end; steer notices must stay in-sequence.
  if (!part || part.type !== 'notice') return false;
  if (part.kind === 'steer') return false;
  if (part.kind === 'memory') return true;
  // Legacy saves: tone:ok without kind, excluding old "Steered:" rows.
  if (part.tone === 'ok' && !/^steered:/i.test(String(part.content || '').trim())) return true;
  return false;
}

function collectTimelineAndAnswer(message: RenderMessage | null | undefined, { notesCollapsed = true } = {}) {
  const timelineParts: TimelinePart[] = [];
  const deferredNotices: TimelinePart[] = [];
  let answerText = '';
  const pushAnswer = (chunk: string) => {
    const text = String(chunk || '');
    if (!text.trim()) return;
    if (answerText) answerText += '\n\n';
    answerText += text;
  };
  const { processNotes, answerChunks } = splitSealedTextParts(message?.parts);
  for (const part of message?.parts || []) {
    if (!part) continue;
    if (isDeferredMemoryNotice(part)) {
      deferredNotices.push(part);
      continue;
    }
    if (part.type === 'think' || part.type === 'tool' || part.type === 'clarify' || part.type === 'notice') {
      timelineParts.push(part);
    }
  }
  for (const chunk of answerChunks) pushAnswer(chunk);
  const content = typeof message?.content === 'string' ? message.content : '';
  if (content) {
    for (const segment of parseThinkSegments(content)) {
      if (segment.type === 'think') {
        if (String(segment.content || '').trim()) {
          timelineParts.push({ type: 'think', content: segment.content });
        }
      } else {
        pushAnswer(segment.content);
      }
    }
  }
  for (const notice of deferredNotices) timelineParts.push(notice);
  return {
    timelineParts,
    processNotes,
    processNotesHtml: renderProcessNotesFold(processNotes, { collapsed: notesCollapsed }),
    answerText,
    answerHtml: answerText ? renderMarkdown(answerText) : '',
    stepCount: timelinePartCount(timelineParts),
  };
}

function messageHasActivity(message: RenderMessage | null | undefined) {
  return collectTimelineAndAnswer(message).stepCount > 0;
}

function renderTimelineFold(timelineHtml: string, stepCount: string | number, { collapsed = true } = {}) {
  const label = stepCount === 1
    ? '1 activity step'
    : (stepCount + ' activity steps');
  return (
    '<div class="agent-timeline-fold' + (collapsed ? ' is-collapsed' : '') + '">' +
      '<button type="button" class="agent-timeline-fold-toggle" aria-expanded="' +
        (collapsed ? 'false' : 'true') + '">' +
        '<span>' + escapeHtml(label) + '</span>' +
        THINK_CHEVRON +
      '</button>' +
      '<div class="agent-timeline-fold-panel">' +
        '<div class="agent-timeline-fold-inner">' + timelineHtml + '</div>' +
      '</div>' +
    '</div>'
  );
}

function renderMemoryNoticesHtml(message: RenderMessage | null | undefined) {
  const notices = Array.isArray(message?.memoryNotices)
    ? message.memoryNotices.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!notices.length) return '';
  return (
    '<div class="msg-memory-notices">' +
      notices.map((label) => (
        '<div class="msg-memory-notice">' + escapeHtml(label) + '</div>'
      )).join('') +
    '</div>'
  );
}

function contextualModelError(message: string, model: unknown) {
  const detail = String(message || 'The request failed.').trim();
  if (!/\b404\b|not found/i.test(detail)) return detail;
  const label = String(model || '').trim() || 'the selected model';
  return 'The provider returned 404 for ' + label
    + '. Check its Base URL and model ID in Settings > Providers.';
}

function renderAssistantMessage(message: RenderMessage, { streaming = false, collapseTimeline = null, notesCollapsed = true }: { streaming?: boolean; collapseTimeline?: boolean | null; notesCollapsed?: boolean } = {}) {
  const previousImages = markdownImages;
  setMarkdownImages(message && message.images);
  try {
    const memoryHtml = renderMemoryNoticesHtml(message);
    if (streaming) {
      const partsHtml = renderCommittedParts(message.parts);
      const sealedHtml = renderSealedAnswerHtml(message.parts, { notesCollapsed });
      const bodyHtml = message.content
        ? renderAssistantHtml(message.content, { streaming: true })
        : '';
      return partsHtml + sealedHtml + bodyHtml + memoryHtml;
    }

    const { timelineParts, answerHtml, stepCount, processNotesHtml } =
      collectTimelineAndAnswer(message, { notesCollapsed });
    const timelineHtml = renderCommittedParts(timelineParts);
    const answerBlock = answerHtml
      ? '<div class="agent-final-answer">' + answerHtml + '</div>'
      : '';
    const finalHtml = (processNotesHtml || '') + answerBlock + memoryHtml;

    if (!timelineHtml) {
      if (processNotesHtml || memoryHtml) return finalHtml;
      if (message?.error) {
        const error = contextualModelError(message.error, message.model);
        return '<div class="agent-final-answer msg-error">' + escapeHtml(error) + '</div>';
      }
      return message.content
        ? renderAssistantHtml(message.content, { streaming: false }) + memoryHtml
        : finalHtml;
    }

    if (isDesktopTraceLayout()) {
      if (finalHtml) return finalHtml;
      if (message?.error) {
        const error = contextualModelError(message.error, message.model);
        return '<div class="agent-final-answer msg-error">' + escapeHtml(error) + '</div>';
      }
      return '<div class="agent-final-answer msg-error">No response.</div>';
    }

    const collapsed = collapseTimeline !== null ? !!collapseTimeline : true;
    return renderTimelineFold(timelineHtml, stepCount, { collapsed }) + finalHtml;
  } finally {
    markdownImages = previousImages;
  }
}

function settleAssistantRow(row: HTMLElement | null | undefined, message: RenderMessage, { animateCollapse = false } = {}) {
  if (!row || !message) return;
  const bubble = (row.querySelector('.msg-bubble') as HTMLElement);
  if (!bubble) return;
  syncMessageSpeaker(row, message);
  const collapseTimeline = animateCollapse ? false : null;
  const notesCollapsed = readProcessNotesCollapsed(row, true);
  bubble.innerHTML = renderAssistantMessage(message, {
    streaming: false,
    collapseTimeline,
    notesCollapsed,
  });
  enhanceCodeBlocks(bubble);
  (bubble.querySelectorAll('.think-body, .agent-timeline-fold-inner') as NodeListOf<HTMLElement>).forEach((el) => {
    enhanceCodeBlocks(el);
  });
  if (animateCollapse && !isDesktopTraceLayout()) {
    const fold = (bubble.querySelector('.agent-timeline-fold') as HTMLElement);
    if (fold) {
      fold.classList.remove('is-collapsed');
      const toggle = (fold.querySelector('.agent-timeline-fold-toggle') as HTMLElement);
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fold.classList.add('is-collapsed');
          if (toggle) toggle.setAttribute('aria-expanded', 'false');
        });
      });
    }
  }
  attachMessageMeta(row, message);
}

