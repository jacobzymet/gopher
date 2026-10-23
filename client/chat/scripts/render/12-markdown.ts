function escapeHtml(text: unknown) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}

const CODE_COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="13" height="13" rx="2"></rect>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
  '</svg>';
const CODE_CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 6 9 17l-5-5"></path>' +
  '</svg>';

const MARKED_BASE_RENDERER = (window.marked && window.marked.Renderer)
  ? new window.marked.Renderer()
  : null;

function renderHighlightedCode(text: string, language: string) {
  const source = String(text || '');
  if (!window.hljs) return { html: escapeHtml(source), highlighted: false };
  try {
    const result: { value: string } | null = language
      ? (window.hljs.getLanguage(language)
          ? window.hljs.highlight(source, { language, ignoreIllegals: true })
          : null)
      : window.hljs.highlightAuto(source);
    if (!result) return { html: escapeHtml(source), highlighted: false };
    return { html: result.value, highlighted: true };
  } catch {
    // An incomplete stream or unknown alias must never prevent the code from rendering.
    return { html: escapeHtml(source), highlighted: false };
  }
}

if (window.marked) {
  window.marked.use({
    gfm: true,
    breaks: true,
    // GFM treats ~pair~ as strike; that false-positives on ~$725 / (~$875M/day).
    // Only ~~text~~ counts. Return undefined (not false) so marked does not fall back.
    tokenizer: {
      del(src) {
        const cap = /^~~(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))~~(?=[^~]|$)/.exec(src);
        if (!cap) return undefined;
        return {
          type: 'del',
          raw: cap[0],
          text: cap[1],
          tokens: this.lexer.inlineTokens(cap[1]),
        };
      },
    },
    renderer: {
      code({ text, lang }) {
        const language = ((lang || '').match(/^[\w+-]+/) || [''])[0].toLowerCase();
        const langClass = language ? (' language-' + language) : '';
        const rendered = renderHighlightedCode(text, language);
        const highlightedAttrs = rendered.highlighted
          ? ' hljs" data-highlighted="yes'
          : '';
        return (
          '<pre><code class="md-code-source' + langClass + highlightedAttrs + '"' +
            (language ? (' data-lang="' + language + '"') : '') +
          '>' + rendered.html + '</code></pre>\n'
        );
      },
      table(...args: Parameters<MarkdownRenderer["table"]>) {
        const html = MARKED_BASE_RENDERER
          ? MARKED_BASE_RENDERER.table.apply(this, args)
          : '';
        return '<div class="md-table-wrap">' +
          html.replace('<table>', '<table class="md-table">') +
          '</div>';
      },
      link({ href, title, tokens }) {
        const label = this.parser!.parseInline(tokens);
        if (!href || !/^(https?:|mailto:|\/|#)/i.test(href)) return label;
        const titleAttr = title ? (' title="' + escapeHtml(title) + '"') : '';
        if (chatSourceTarget(href)) {
          return '<a class="chat-source-link" href="' + escapeHtml(href) + '"' + titleAttr + '>' + label + '</a>';
        }
        const favicon = citeFaviconUrl(href);
        if (favicon) {
          return '<a class="md-cite" href="' + escapeHtml(href) + '"' + titleAttr +
            ' target="_blank" rel="noopener noreferrer">' +
            '<img class="md-cite-favicon" src="' + escapeHtml(favicon) + '"' +
            ' alt="" width="14" height="14" loading="lazy" decoding="async" referrerpolicy="no-referrer">' +
            '<span class="md-cite-text">' + label + '</span></a>';
        }
        return '<a href="' + escapeHtml(href) + '"' + titleAttr +
          ' target="_blank" rel="noopener noreferrer">' + label + '</a>';
      },
    },
  });
}

function citeFaviconUrl(href: string) {
  try {
    const url = new URL(String(href || ''), window.location.origin);
    if (url.origin === window.location.origin) return '';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    return 'https://www.google.com/s2/favicons?domain=' +
      encodeURIComponent(url.hostname) + '&sz=32';
  } catch {
    return '';
  }
}

if (window.DOMPurify) {
  window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      if (chatSourceTarget(node.getAttribute('href'))) {
        node.removeAttribute('target');
        node.setAttribute('rel', 'noopener noreferrer');
        return;
      }
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

const TEX_COMMANDS = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta',
  'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma',
  'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega',
  'bar', 'hat', 'vec', 'dot', 'ddot', 'tilde', 'overline', 'underline', 'breve', 'check',
  'frac', 'dfrac', 'tfrac', 'sum', 'prod', 'int', 'oint', 'lim', 'sqrt',
  'ldots', 'cdots', 'dots', 'vdots', 'ddots', 'infty',
  'leq', 'geq', 'neq', 'times', 'cdot', 'pm', 'mp', 'to', 'rightarrow', 'leftarrow',
  'partial', 'nabla', 'forall', 'exists', 'in', 'subset', 'supset', 'approx', 'equiv',
  'binom', 'text', 'mathrm', 'mathbf', 'mathit', 'operatorname', 'left', 'right',
  'langle', 'rangle', 'quad', 'qquad', 'displaystyle', 'limits', 'begin', 'end',
  'sin', 'cos', 'tan', 'log', 'ln', 'exp', 'max', 'min',
]);
const TEX_ACCENTS = new Set(['bar', 'hat', 'vec', 'dot', 'ddot', 'tilde', 'overline', 'underline', 'breve', 'check']);

function oddEscape(src: string, index: number) {
  let count = 0;
  for (let i = index - 1; i >= 0 && src.charAt(i) === '\\'; i -= 1) count += 1;
  return count % 2 === 1;
}

function atLineStart(src: string, index: number) {
  return index === 0 || src.charAt(index - 1) === '\n';
}

function readFencedCode(src: string, index: number) {
  if (!atLineStart(src, index)) return 0;
  const mark = src.charAt(index);
  if (mark !== '`' && mark !== '~') return 0;
  let width = 0;
  while (index + width < src.length && src.charAt(index + width) === mark) width += 1;
  if (width < 3) return 0;
  let cursor = index + width;
  while (cursor < src.length && src.charAt(cursor) !== '\n') cursor += 1;
  if (cursor < src.length) cursor += 1;
  const fence = new RegExp('^' + mark + '{' + width + ',}\\s*$');
  while (cursor < src.length) {
    const lineEnd = src.indexOf('\n', cursor);
    const end = lineEnd < 0 ? src.length : lineEnd;
    if (fence.test(src.slice(cursor, end))) return (lineEnd < 0 ? src.length : lineEnd + 1);
    if (lineEnd < 0) return src.length;
    cursor = lineEnd + 1;
  }
  return src.length;
}

function readInlineCode(src: string, index: number) {
  if (src.charAt(index) !== '`') return 0;
  let width = 0;
  while (index + width < src.length && src.charAt(index + width) === '`') width += 1;
  const close = src.indexOf('`'.repeat(width), index + width);
  if (close < 0) return 0;
  return close + width;
}

function readWrapped(src: string, index: number, open: string, close: string, multiline: boolean) {
  if (!src.startsWith(open, index) || oddEscape(src, index)) return null;
  const start = index + open.length;
  for (let cursor = start; cursor < src.length; cursor += 1) {
    if (!multiline && src.charAt(cursor) === '\n') return null;
    if (src.startsWith(close, cursor) && !oddEscape(src, cursor)) {
      const tex = src.slice(start, cursor);
      if (!tex.trim()) return null;
      return { tex, end: cursor + close.length, display: multiline };
    }
  }
  return null;
}

function readInlineDollar(src: string, index: number) {
  if (src.charAt(index) !== '$' || src.startsWith('$$', index) || oddEscape(src, index)) return null;
  if (index > 0 && /[0-9]/.test(src.charAt(index - 1))) return null;
  const next = src.charAt(index + 1);
  if (!next || next === '$' || /\s/.test(next)) return null;
  for (let cursor = index + 1; cursor < src.length && src.charAt(cursor) !== '\n'; cursor += 1) {
    if (src.charAt(cursor) !== '$' || oddEscape(src, cursor) || /\s/.test(src.charAt(cursor - 1))) continue;
    const after = src.charAt(cursor + 1);
    if (after && /[0-9]/.test(after)) continue;
    const tex = src.slice(index + 1, cursor);
    if (!tex.trim()) return null;
    return { tex, end: cursor + 1, display: false };
  }
  return null;
}

function closeBrace(src: string, index: number) {
  if (src.charAt(index) !== '{') return 0;
  let depth = 0;
  for (let cursor = index; cursor < src.length && src.charAt(cursor) !== '\n'; cursor += 1) {
    if (src.charAt(cursor) === '{') depth += 1;
    else if (src.charAt(cursor) === '}') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return 0;
}

function consumeTexTail(src: string, index: number) {
  let cursor = index;
  let grew = true;
  while (grew && cursor < src.length && src.charAt(cursor) !== '\n') {
    grew = false;
    if (src.charAt(cursor) === '{') {
      const end = closeBrace(src, cursor);
      if (!end) break;
      cursor = end;
      grew = true;
      continue;
    }
    if (src.charAt(cursor) === '_' || src.charAt(cursor) === '^') {
      const atom = src.charAt(cursor + 1);
      if (atom === '{') {
        const end = closeBrace(src, cursor + 1);
        if (!end) break;
        cursor = end;
        grew = true;
        continue;
      }
      if (atom && /[A-Za-z0-9]/.test(atom)) {
        cursor += 2;
        grew = true;
      }
    }
  }
  return cursor;
}

function readEnvironment(src: string, index: number) {
  if (!src.startsWith('\\begin{', index) || oddEscape(src, index)) return null;
  const name = /^\\begin\{([A-Za-z*]+)\}/.exec(src.slice(index));
  if (!name) return null;
  const endTag = '\\end{' + name[1] + '}';
  const at = src.indexOf(endTag, index + name[0].length);
  if (at < 0) return null;
  return { tex: src.slice(index, at + endTag.length), end: at + endTag.length, display: true };
}

function hasTexCommand(tex: string) {
  const commands = String(tex).matchAll(/\\([A-Za-z]+)/g);
  for (const command of commands) {
    if (TEX_COMMANDS.has(command[1])) return true;
  }
  return false;
}

function readParenTex(src: string, index: number) {
  if (src.charAt(index) !== '(' || (index > 0 && src.charAt(index - 1) === ']')) return null;
  const lineEnd = src.indexOf('\n', index);
  const limit = lineEnd < 0 ? src.length : lineEnd;
  let depth = 0;
  for (let cursor = index; cursor < limit; cursor += 1) {
    if (src.charAt(cursor) === '(') depth += 1;
    else if (src.charAt(cursor) === ')') {
      depth -= 1;
      if (depth === 0) {
        const tex = src.slice(index, cursor + 1);
        if (tex.length > 400 || !hasTexCommand(tex)) return null;
        return { tex, end: cursor + 1, display: false };
      }
    }
  }
  return null;
}

function readCommandTex(src: string, index: number) {
  if (src.charAt(index) !== '\\' || oddEscape(src, index)) return null;
  const head = /^\\([A-Za-z]+)/.exec(src.slice(index));
  if (!head || !TEX_COMMANDS.has(head[1])) return null;
  let cursor = index + head[0].length;
  cursor = consumeTexTail(src, cursor);
  if (TEX_ACCENTS.has(head[1])) {
    const spaced = /^\s+[A-Za-z0-9]/.exec(src.slice(cursor));
    if (spaced) cursor = consumeTexTail(src, cursor + spaced[0].length);
  }
  if (cursor <= index + 1) return null;
  return { tex: src.slice(index, cursor), end: cursor, display: false };
}

function closedMathAt(src: string, index: number) {
  return readWrapped(src, index, '$$', '$$', true)
    || readWrapped(src, index, '\\[', '\\]', true)
    || readWrapped(src, index, '\\(', '\\)', false)
    || readInlineDollar(src, index)
    || readEnvironment(src, index)
    || readParenTex(src, index)
    || readCommandTex(src, index);
}

function unclosedDisplayAt(src: string, index: number) {
  if (oddEscape(src, index)) return false;
  if (src.startsWith('$$', index) || src.startsWith('\\[', index) || src.startsWith('\\begin{', index)) {
    return !closedMathAt(src, index);
  }
  return false;
}

function skipProtectedSpan(src: string, index: number) {
  const math = closedMathAt(src, index);
  if (math) return math.end;
  if (unclosedDisplayAt(src, index)) return src.length;
  return index;
}

function shieldMarkdownMath(source: string) {
  const slots: MathSlot[] = [];
  const src = String(source);
  let out = '';
  let index = 0;
  const put = (slot: MathSlot) => {
    const id = slots.length;
    slots.push(slot);
    const token = 'GOPHERMATH' + id + 'END';
    return slot.display ? '\n\n' + token + '\n\n' : token;
  };
  while (index < src.length) {
    const fence = readFencedCode(src, index);
    if (fence) {
      out += src.slice(index, fence);
      index = fence;
      continue;
    }
    const code = readInlineCode(src, index);
    if (code) {
      out += src.slice(index, code);
      index = code;
      continue;
    }
    const math = closedMathAt(src, index);
    if (math) {
      out += put({ tex: math.tex.trim(), display: !!math.display });
      index = math.end;
      continue;
    }
    // An open display span stays source until its closer arrives, so a streaming
    // formula is not typeset one command at a time.
    if (unclosedDisplayAt(src, index)) {
      out += src.slice(index);
      break;
    }
    out += src.charAt(index);
    index += 1;
  }
  return { text: out, slots };
}

function renderTex(tex: unknown, display: unknown) {
  const source = String(tex || '').trim();
  if (!source) return '';
  if (!window.katex || typeof window.katex.renderToString !== 'function') {
    return '<span class="math-source">' + escapeHtml(source) + '</span>';
  }
  try {
    return window.katex.renderToString(source, {
      displayMode: !!display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml',
      errorColor: 'currentColor',
    });
  } catch {
    return '<span class="math-source">' + escapeHtml(source) + '</span>';
  }
}

function restoreMarkdownMath(html: string, slots: MathSlot[]) {
  if (!slots.length) return html;
  const unwrapped = html.replace(/<p>\s*(GOPHERMATH(\d+)END)\s*<\/p>/g, (all: string, _token: string, id: string) => {
    const slot = slots[Number(id)];
    return slot && slot.display ? 'GOPHERMATH' + id + 'END' : all;
  });
  return unwrapped.replace(/GOPHERMATH(\d+)END/g, (all: string, id: string) => {
    const slot = slots[Number(id)];
    if (!slot) return all;
    return renderTex(slot.tex, slot.display);
  });
}

function renderMarkdown(text: string) {
  if (!text) return '';
  const source = applyMarkdownImageRefs(String(text));
  if (!window.marked || !window.DOMPurify) {
    return '<p>' + escapeHtml(source).replace(/\n/g, '<br>') + '</p>';
  }
  const shielded = shieldMarkdownMath(source);
  const raw = window.marked.parse(shielded.text, { async: false });
  const clean = window.DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'base', 'link', 'meta'],
    FORBID_ATTR: ['style', 'id', 'name'],
    ADD_ATTR: ['target', 'align', 'loading', 'decoding', 'referrerpolicy'],
    ADD_DATA_URI_TAGS: ['img'],
  });
  return restoreMarkdownMath(clean, shielded.slots);
}

let markdownImages: Record<string, string> = Object.create(null);

function setMarkdownImages(map: Record<string, string> | null | undefined) {
  markdownImages = map && typeof map === 'object' ? map : Object.create(null);
}

function applyMarkdownImageRefs(text: string) {
  return String(text || '').replace(
    /!\[([^\]]*)\]\(\s*(img_\d+)(?:\s+"[^"]*")?\s*\)/gi,
    (all: string, alt: string, id: string) => {
      const src = markdownImages[id];
      if (!src || !/^data:image\//i.test(src)) return all;
      return '![' + alt + '](' + src + ')';
    }
  );
}

/** Hide broken citation favicons so the claim link still reads cleanly. */
function enhanceCiteFavicons(root: HTMLElement) {
  if (!root) return;
  (root.querySelectorAll('a.md-cite img.md-cite-favicon') as NodeListOf<HTMLImageElement>).forEach((img) => {
    if (img.dataset.citeBound) return;
    img.dataset.citeBound = '1';
    if (img.complete && img.naturalWidth === 0) {
      img.classList.add('is-missing');
      return;
    }
    img.addEventListener('error', () => {
      img.classList.add('is-missing');
    }, { once: true });
  });
}

/** Add column resizing without changing the message's Markdown. */
function enhanceMarkdownTables(root: HTMLElement) {
  if (!root) return;
  const targets = [...(root.querySelectorAll('table.md-table') as NodeListOf<HTMLTableElement>)]
    .filter((table) => !table._columnResizeReady && (table.closest('.msg-bubble') as HTMLElement));
  if (!targets.length) return;
  const owner = (root.closest('.msg') as HTMLElement) || (root.closest('.msg-bubble') as HTMLElement) || root;
  const states = owner._markdownTableWidths || (owner._markdownTableWidths = new Map<string, MarkdownColumnWidths>());
  const tables = [...(owner.querySelectorAll('table.md-table') as NodeListOf<HTMLTableElement>)];
  targets.forEach((table) => {
    const headers = [...(table.tHead?.rows[0]?.cells || [])];
    if (!headers.length || headers.some((cell) => cell.colSpan !== 1 || cell.rowSpan !== 1)) return;
    table._columnResizeReady = true;
    const labels = headers.map((cell, index) => cell.textContent.trim() || 'Column ' + (index + 1));
    const key = JSON.stringify([tables.indexOf(table), labels]);
    const saved = states.get(key);
    let widths = saved?.widths.slice() || null;
    let defaults = saved?.defaults.slice() || null;
    let group: HTMLElement | null = null;
    const handles: HTMLElement[] = [];
    const measure = () => headers.map((cell) => cell.getBoundingClientRect().width);
    const apply = (next: number[]) => {
      if (!group) {
        group = (document.createElement('colgroup') as HTMLElement);
        headers.forEach(() => group!.appendChild((document.createElement('col') as HTMLElement)));
        table.insertBefore(group, table.tHead);
      }
      widths = next.slice();
      [...group.children].forEach((col, index) => { (col as HTMLElement).style.width = widths![index] + 'px'; });
      table.style.width = widths.reduce((total, width) => total + width, 0) + 'px';
      table.classList.add('has-column-widths');
      handles.forEach((handle, index) => {
        handle.setAttribute('aria-valuemin', String(Math.min(48, Math.round(widths![index]))));
        handle.setAttribute('aria-valuenow', String(Math.round(widths![index])));
        handle.setAttribute('aria-valuetext', Math.round(widths![index]) + ' pixels wide');
      });
      states.set(key, { widths: widths.slice(), defaults: defaults!.slice() });
    };
    const resizeColumn = (index: number, width: number) => {
      const next = widths ? widths.slice() : measure();
      if (!defaults) defaults = next.slice();
      next[index] = Math.max(48, Math.min(2000, width));
      apply(next);
    };
    headers.forEach((cell, index) => {
      const handle = (document.createElement('span') as HTMLElement);
      handle.className = 'md-column-resize';
      handle.tabIndex = 0;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', 'Resize ' + labels[index] + ' column');
      handle.setAttribute('aria-valuemin', '48');
      handle.setAttribute('aria-valuemax', '2000');
      handle.title = 'Drag to resize column. Double-click to reset.';
      handles.push(handle);
      cell.appendChild(handle);
      let drag: MarkdownColumnDrag | null = null;
      const finish = (cancel = false) => {
        if (!drag) return;
        const previous = drag;
        drag = null;
        if (cancel) apply(previous.widths);
        table.classList.remove('is-resizing-column');
        handle.classList.remove('is-resizing');
        if (handle.hasPointerCapture(previous.pointerId)) handle.releasePointerCapture(previous.pointerId);
      };
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        const start = widths ? widths.slice() : measure();
        if (!defaults) defaults = start.slice();
        apply(start);
        drag = {
          pointerId: event.pointerId, x: event.clientX, widths: start,
          direction: getComputedStyle(table).direction === 'rtl' ? -1 : 1,
        };
        handle.focus({ preventScroll: true });
        handle.setPointerCapture(event.pointerId);
        table.classList.add('is-resizing-column');
        handle.classList.add('is-resizing');
      });
      handle.addEventListener('pointermove', (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        resizeColumn(index, drag.widths[index] + (event.clientX - drag.x) * drag.direction);
      });
      handle.addEventListener('pointerup', () => finish());
      handle.addEventListener('pointercancel', () => finish(true));
      handle.addEventListener('lostpointercapture', () => finish());
      handle.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (defaults) {
          const next = widths!.slice();
          next[index] = defaults[index];
          apply(next);
        }
      });
      handle.addEventListener('focus', () => {
        const width = (widths || measure())[index];
        handle.setAttribute('aria-valuemin', String(Math.min(48, Math.round(width))));
        handle.setAttribute('aria-valuenow', String(Math.round(width)));
        handle.setAttribute('aria-valuetext', Math.round(width) + ' pixels wide');
      });
      handle.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && drag) {
          event.preventDefault();
          finish(true);
          return;
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const direction = getComputedStyle(table).direction === 'rtl' ? -1 : 1;
        const step = (event.shiftKey ? 48 : 16) * (event.key === 'ArrowRight' ? 1 : -1) * direction;
        resizeColumn(index, (widths || measure())[index] + step);
      });
    });
    if (widths) apply(widths);
  });
}

/** Enhance Markdown tables, citations, and fenced code blocks. */
function enhanceCodeBlocks(root: HTMLElement) {
  if (!root) return;
  enhanceCiteFavicons(root);
  enhanceMarkdownTables(root);
  if (typeof decorateMentionTextNodes === 'function') decorateMentionTextNodes(root);
  (root.querySelectorAll('pre > code') as NodeListOf<HTMLElement>).forEach((codeEl) => {
    let block = (codeEl.closest('.md-code-block') as HTMLElement);
    if (!block) {
      const pre = codeEl.parentElement;
      if (!pre || pre.tagName !== 'PRE') return;
      const langMatch = (codeEl.className || '').match(/language-([\w+-]+)/i);
      const lang = (
        codeEl.getAttribute('data-lang') ||
        (langMatch && langMatch[1]) ||
        ''
      ).toLowerCase();
      block = (document.createElement('div') as HTMLElement);
      block.className = 'md-code-block';
      block.innerHTML =
        '<div class="md-code-header">' +
          '<span class="md-code-lang">' + escapeHtml(lang || 'code') + '</span>' +
          '<button type="button" class="md-code-copy" aria-label="Copy code" title="Copy">' +
            CODE_COPY_ICON +
          '</button>' +
        '</div>';
      pre.classList.add('md-code');
      codeEl.classList.add('md-code-source');
      pre.replaceWith(block);
      block.appendChild(pre);
    }
    if (!window.hljs || codeEl.dataset.highlighted === 'yes' || codeEl.dataset.highlighted === 'skip') return;
    try {
      window.hljs.highlightElement(codeEl);
    } catch {
      // Unknown language aliases — leave plain text.
    }
  });
}

function copyCodeBlock(btn: HTMLElement) {
  const block = (btn.closest('.md-code-block') as HTMLElement);
  const code = block && (block.querySelector('code.md-code-source') as HTMLElement);
  if (!code || !navigator.clipboard) return;
  const payload = code.textContent || '';
  navigator.clipboard.writeText(payload).then(() => {
    btn.classList.add('is-copied');
    btn.innerHTML = CODE_CHECK_ICON;
    btn.setAttribute('aria-label', 'Copied');
    btn.title = 'Copied';
    setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.innerHTML = CODE_COPY_ICON;
      btn.setAttribute('aria-label', 'Copy code');
      btn.title = 'Copy';
    }, 1400);
  }).catch(() => {});
}

