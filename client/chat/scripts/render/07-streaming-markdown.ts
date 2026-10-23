/** True when the last fenced code block in `text` is still open. */
function streamingFenceState(text: string) {
  const src = String(text || '');
  let open = false;
  let start = -1;
  let i = 0;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const lineEnd = nl < 0 ? src.length : nl;
    const line = src.slice(i, lineEnd);
    if (/^ {0,3}```/.test(line)) {
      if (!open) {
        open = true;
        start = i;
      } else {
        open = false;
        start = -1;
      }
    }
    if (nl < 0) break;
    i = nl + 1;
  }
  return { open, start };
}

/**
 * Split streaming markdown into finished blocks vs the block still being
 * written, so the painter can leave sealed DOM alone.
 */
function splitStreamingMarkdown(src: string) {
  const text = String(src || '');
  if (!text) return { sealed: '', tail: '' };
  const fence = streamingFenceState(text);
  if (fence.open && fence.start >= 0) {
    return { sealed: text.slice(0, fence.start), tail: text.slice(fence.start) };
  }
  let tailStart = 0;
  const blank = text.lastIndexOf('\n\n');
  if (blank >= 0) {
    tailStart = blank + 2;
    while (tailStart < text.length && text.charAt(tailStart) === '\n') tailStart += 1;
  }
  const headingRe = /\n(#{1,6} | {0,3}```)/g;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(text)) !== null) {
    const at = match.index + 1;
    if (at > tailStart) tailStart = at;
  }
  return { sealed: text.slice(0, tailStart), tail: text.slice(tailStart) };
}

function closeOpenMarkdownLink(src: string) {
  const idx = src.lastIndexOf('](');
  if (idx < 0) return src;
  if (src.indexOf(')', idx + 2) >= 0) return src;
  return src + ')';
}

function closeUnbalancedInlineTicks(src: string) {
  let i = 0;
  let open = 0;
  while (i < src.length) {
    if (src.charAt(i) === '\\') {
      i += 2;
      continue;
    }
    if (src.charAt(i) !== '`') {
      i += 1;
      continue;
    }
    let n = 1;
    while (i + n < src.length && src.charAt(i + n) === '`') n += 1;
    if (open && n === open) open = 0;
    else if (!open) open = n;
    i += n;
  }
  return open ? src + '`'.repeat(open) : src;
}

function closeUnbalancedEmphasis(src: string) {
  let i = 0;
  let inCode = false;
  let codeTicks = 0;
  let boldStars = 0;
  let italStars = 0;
  let boldUnder = 0;
  let italUnder = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (!inCode && (ch === '\\' || ch === '$')) {
      const next = skipProtectedSpan(src, i);
      if (next > i) {
        i = next;
        continue;
      }
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (i + n < src.length && src.charAt(i + n) === '`') n += 1;
      if (inCode && n === codeTicks) {
        inCode = false;
        codeTicks = 0;
      } else if (!inCode) {
        inCode = true;
        codeTicks = n;
      }
      i += n;
      continue;
    }
    if (inCode) {
      i += 1;
      continue;
    }
    const atLine = i === 0 || src.charAt(i - 1) === '\n';
    if (atLine && (ch === '*' || ch === '-' || ch === '+') && src.charAt(i + 1) === ' ') {
      i += 2;
      continue;
    }
    const prev = i > 0 ? src.charAt(i - 1) : '';
    const next = src.charAt(i + 1);
    const midWord = /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next);
    if (src.startsWith('**', i)) {
      boldStars ^= 1;
      i += 2;
      continue;
    }
    if (ch === '*') {
      if (!midWord) italStars ^= 1;
      i += 1;
      continue;
    }
    if (src.startsWith('__', i)) {
      const after = src.charAt(i + 2);
      const midDunder = /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(after);
      if (!midDunder) boldUnder ^= 1;
      i += 2;
      continue;
    }
    if (ch === '_') {
      if (!midWord) italUnder ^= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  let suffix = '';
  if (italStars) suffix += '*';
  if (boldStars) suffix += '**';
  if (italUnder) suffix += '_';
  if (boldUnder) suffix += '__';
  return suffix ? src + suffix : src;
}

/** Close half-written marks so live markdown paints as prose, not raw syntax. */
function stabilizeStreamingMarkdown(text: string) {
  let src = String(text || '');
  if (!src) return src;
  if (streamingFenceState(src).open) return src + '\n```';
  src = closeOpenMarkdownLink(src);
  src = closeUnbalancedInlineTicks(src);
  return closeUnbalancedEmphasis(src);
}

function lastStreamCaretHost(root: HTMLElement) {
  let node = root && root.lastElementChild;
  while (node) {
    if (node.classList.contains('stream-caret')) {
      node = node.previousElementSibling;
      continue;
    }
    const tag = node.tagName;
    if (tag === 'P' || tag === 'LI' || tag === 'TD' || tag === 'TH' || /^H[1-6]$/.test(tag)) {
      return node;
    }
    if (node.classList.contains('md-code-block') || tag === 'PRE' || tag === 'CODE') {
      const code = (node.querySelector('code') as HTMLElement) || (tag === 'CODE' ? node : null);
      return code || node;
    }
    if (tag === 'UL' || tag === 'OL' || tag === 'BLOCKQUOTE' || tag === 'TABLE' || tag === 'TBODY' || tag === 'THEAD' || tag === 'TR') {
      node = node.lastElementChild;
      continue;
    }
    if (node.lastElementChild) {
      node = node.lastElementChild;
      continue;
    }
    return node;
  }
  return root;
}

function removeStreamCarets(root: { querySelectorAll: (arg0: string) => NodeListOf<HTMLElement>; }) {
  if (!root) return;
  (root.querySelectorAll('.stream-caret') as NodeListOf<HTMLElement>).forEach((el) => el.remove());
}

function appendStreamCaret(root: HTMLElement) {
  if (!root || prefersReducedMotion()) return;
  removeStreamCarets(root);
  const caret = (document.createElement('span') as HTMLElement);
  caret.className = 'stream-caret';
  caret.setAttribute('aria-hidden', 'true');
  const host = lastStreamCaretHost(root);
  if (host) host.appendChild(caret);
}

function markStreamSettle(nodes: NodeListOf<HTMLElement> | HTMLCollection, fromIndex: number) {
  if (prefersReducedMotion()) return;
  const list = Array.from(nodes || []);
  const start = Math.max(0, fromIndex);
  for (let i = start; i < list.length; i++) {
    const el = list[i];
    if (!el || el.classList.contains('stream-caret')) continue;
    el.classList.add('stream-settle');
  }
}

/**
 * Paint markdown incrementally: finished blocks stay in the DOM; only the
 * live tail is rewritten. Used while tokens arrive.
 */
function paintIncrementalMarkdown(host: HTMLElement, markdown: string, { streaming = false } = {}) {
  if (!host) return;
  const text = String(markdown || '');
  if (!streaming) {
    const html = text.trim() ? renderMarkdown(text) : '';
    if (host.dataset.renderedMd !== text) {
      host.innerHTML = html;
      host.dataset.renderedMd = text;
      enhanceCodeBlocks(host);
    }
    host.classList.remove('is-streaming');
    delete host.dataset.sealedMd;
    delete host.dataset.tailMd;
    return;
  }

  delete host.dataset.renderedMd;
  host.classList.add('is-streaming');
  if (!text.trim()) {
    if (host.innerHTML) host.innerHTML = '';
    delete host.dataset.sealedMd;
    delete host.dataset.tailMd;
    return;
  }

  const { sealed, tail } = splitStreamingMarkdown(text);
  let sealedEl = (host.querySelector(':scope > .stream-sealed') as HTMLElement);
  let tailEl = (host.querySelector(':scope > .stream-tail') as HTMLElement);
  if (!sealedEl || !tailEl) {
    host.innerHTML = '<div class="stream-sealed"></div><div class="stream-tail"></div>';
    sealedEl = (host.querySelector(':scope > .stream-sealed') as HTMLElement);
    tailEl = (host.querySelector(':scope > .stream-tail') as HTMLElement);
  }

  const prevSealed = sealedEl.dataset.sealedMd || '';
  if (sealedEl.dataset.sealedMd !== sealed) {
    const sealedHtml = sealed.trim() ? renderMarkdown(sealed, { cache: false }) : '';
    sealedEl.innerHTML = sealedHtml;
    sealedEl.dataset.sealedMd = sealed;
    enhanceCodeBlocks(sealedEl);
    if (!prevSealed && sealedHtml) markStreamSettle(sealedEl.children, 0);
  }

  const tailKey = tail;
  const tailSource = stabilizeStreamingMarkdown(tail);
  const openFence = streamingFenceState(tail).open;
  const prevTailKids = (tailEl.querySelectorAll(':scope > :not(.stream-caret)') as NodeListOf<HTMLElement>).length;
  const sealedGrew = sealed.length > prevSealed.length;
  if (tailEl.dataset.tailMd !== tailKey) {
    tailEl.innerHTML = tailSource.trim() ? renderMarkdown(tailSource, { cache: false }) : '';
    tailEl.dataset.tailMd = tailKey;
    if (openFence) {
      (tailEl.querySelectorAll('pre > code') as NodeListOf<HTMLElement>).forEach((el) => {
        el.dataset.highlighted = 'skip';
      });
      enhanceCiteFavicons(tailEl);
      enhanceMarkdownTables(tailEl);
    } else {
      enhanceCodeBlocks(tailEl);
    }
    const kids = (tailEl.querySelectorAll(':scope > :not(.stream-caret)') as NodeListOf<HTMLElement>);
    if (sealedGrew || prevTailKids === 0) markStreamSettle(kids, 0);
    else if (kids.length > prevTailKids) markStreamSettle(kids, prevTailKids);
  }
  const caretRoot = tailEl.childElementCount ? tailEl : sealedEl;
  if (caretRoot && caretRoot.childElementCount && !(host.querySelector('.stream-caret') as HTMLElement)) {
    appendStreamCaret(caretRoot);
  }
}

/** Mobile / inline timeline: keep closed think cards, stream the answer tail. */
function paintStreamingAssistant(host: HTMLElement, text: string, { streaming = true } = {}) {
  if (!host) return;
  const cleaned = String(text || '');
  if (streaming && isThinkingOpen(cleaned) && paintLiveThinkOnly(host, cleaned)) return;
  const segments = parseThinkSegments(cleaned);
  let thinkHtml = '';
  let textBuf = '';
  for (const segment of segments) {
    if (segment.type === 'think') {
      if (!segment.content.trim() && !segment.open) continue;
      thinkHtml += renderThinkBlock(segment.content, { open: segment.open, streaming });
    } else {
      textBuf += segment.content || '';
    }
  }
  if (!thinkHtml) {
    paintIncrementalMarkdown(host, textBuf, { streaming });
    return;
  }
  let thinkRoot = (host.querySelector(':scope > .stream-think') as HTMLElement);
  let answerRoot = (host.querySelector(':scope > .stream-answer') as HTMLElement);
  if (!thinkRoot || !answerRoot) {
    host.innerHTML = '<div class="stream-think"></div><div class="stream-answer"></div>';
    thinkRoot = (host.querySelector(':scope > .stream-think') as HTMLElement);
    answerRoot = (host.querySelector(':scope > .stream-answer') as HTMLElement);
  }
  if (thinkRoot.dataset.thinkSig !== thinkHtml) {
    thinkRoot.innerHTML = thinkHtml;
    thinkRoot.dataset.thinkSig = thinkHtml;
    enhanceCodeBlocks(thinkRoot);
  }
  paintIncrementalMarkdown(answerRoot, textBuf, { streaming });
}

function renderAssistantHtml(text: string, { streaming = false } = {}) {
  const segments = parseThinkSegments(text);
  let html = '';
  let textBuf = '';
  const flushText = () => {
    if (textBuf) {
      const source = streaming ? stabilizeStreamingMarkdown(textBuf) : textBuf;
      html += renderMarkdown(source, { cache: !streaming });
      textBuf = '';
    }
  };
  for (const segment of segments) {
    if (segment.type === 'think') {
      flushText();
      if (!segment.content.trim() && !segment.open) continue;
      html += renderThinkBlock(segment.content, { open: segment.open, streaming });
    } else {
      textBuf += segment.content;
    }
  }
  flushText();
  if (html) return html;
  if (streaming) return '<span class="thinking-label">Processing…</span>';
  return '';
}

