/**
 * Readable text from untrusted HTML without a DOM.
 *
 * A single linear tokenizer pass keeps a stack of open elements, drops page
 * chrome (navigation, headers, footers, forms, scripts) and collects text for
 * the whole body and for each main-content container. The longest container
 * with real content wins; otherwise the body text is used. This mirrors the
 * scraper fallback of the original Rust extractor.
 */

const ENTITIES: Record<string, string> = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, key: string) => {
    if (key[0] !== '#') return ENTITIES[key.toLowerCase()] ?? match;
    const code = key[1] === 'x' || key[1] === 'X' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Text with tags removed and whitespace collapsed, for short fragments such as titles. */
export function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const CHROME = new Set([
  'nav', 'footer', 'header', 'aside', 'form', 'script', 'style', 'noscript', 'svg',
  'template', 'iframe', 'button', 'select', 'textarea', 'dialog', 'menu',
]);
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr',
]);
const BLOCK = new Set([
  'address', 'article', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'br', 'body', 'caption', 'summary',
  'details',
]);
/** Elements whose raw text must not be tokenized as markup. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'svg']);
const MIN_CONTENT_CHARS = 80;

interface OpenElement { name: string; chrome: boolean; candidate: Collector | null }

/** Accumulates one line per block element; preformatted text keeps its own lines and indentation. */
class Collector {
  private lines: string[] = [];
  private current = '';
  private preformatted = false;
  text(value: string, preformatted: boolean): void {
    if (preformatted) {
      const parts = value.split(/\r?\n/);
      for (let index = 0; index < parts.length; index++) {
        if (index > 0) { this.lines.push(this.current.trimEnd()); this.current = ''; }
        this.current += parts[index];
      }
      this.preformatted = true;
      return;
    }
    const collapsed = value.replace(/\s+/g, ' ');
    if (!collapsed.trim() && !this.current) return;
    this.current += collapsed;
  }
  prefix(marker: string): void { this.break(); this.current = marker; }
  break(): void {
    const line = this.preformatted ? this.current.trimEnd() : this.current.trim();
    if (line.trim() && line !== '-') this.lines.push(line);
    this.current = '';
    this.preformatted = false;
  }
  result(): string {
    this.break();
    while (this.lines.length && !this.lines[0]!.trim()) this.lines.shift();
    return this.lines.join('\n');
  }
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').toLowerCase();
}

function isCandidate(name: string, tag: string): boolean {
  return name === 'article' || name === 'main' || attribute(tag, 'role') === 'main';
}

/** Extract the main readable text of an HTML document. */
export function htmlToText(html: string): string {
  const body = new Collector();
  const candidates: Collector[] = [];
  const stack: OpenElement[] = [];
  let chromeDepth = 0, preDepth = 0;
  const closers = new Map<string, RegExp>();
  const active = () => [body, ...stack.flatMap(item => (item.candidate ? [item.candidate] : []))];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][\w:-]*)[^>]*>|[^<]+|</g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html))) {
    const token = match[0];
    const name = match[1]?.toLowerCase();
    if (!name) {
      if (token.startsWith('<!') || token.startsWith('<?')) continue;
      if (chromeDepth) continue;
      const text = decodeEntities(token);
      for (const collector of active()) collector.text(text, preDepth > 0);
      continue;
    }
    const closing = token[1] === '/';
    if (!closing && RAW_TEXT.has(name) && !token.endsWith('/>')) {
      let closer = closers.get(name);
      if (!closer) closers.set(name, closer = new RegExp(`</${name}[^>]*>`, 'gi'));
      closer.lastIndex = tokens.lastIndex;
      tokens.lastIndex = closer.exec(html) ? closer.lastIndex : html.length;
      continue;
    }
    if (closing) {
      const index = stack.map(item => item.name).lastIndexOf(name);
      if (index < 0) continue;
      for (const item of stack.splice(index)) {
        if (item.chrome) chromeDepth--;
        if (item.name === 'pre') preDepth--;
      }
      if (BLOCK.has(name) && !chromeDepth) for (const collector of active()) collector.break();
      continue;
    }
    if (BLOCK.has(name) && !chromeDepth) for (const collector of active()) collector.break();
    if (name === 'li' && !chromeDepth) for (const collector of active()) collector.prefix('- ');
    if (VOID.has(name) || token.endsWith('/>')) continue;
    const chrome = CHROME.has(name);
    const candidate = !chromeDepth && isCandidate(name, token) ? new Collector() : null;
    if (candidate) candidates.push(candidate);
    stack.push({ name, chrome, candidate });
    if (chrome) chromeDepth++;
    if (name === 'pre') preDepth++;
  }
  let best = '';
  for (const candidate of candidates) {
    const text = candidate.result();
    if (text.length > best.length) best = text;
  }
  return best.length >= MIN_CONTENT_CHARS ? best : body.result() || best;
}
