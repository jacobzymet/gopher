const { readUiScript } = require('./helpers/ui-source.cjs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');

function source() {
  return readUiScript('render.js').replace(/\r\n/g, '\n');
}

function load(context, names) {
  const text = source();
  for (const name of names) {
    const match = text.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}

function harness({ maxChars = 1_000_000, maxSource = 1000 } = {}) {
  let parses = 0;
  const context = vm.createContext({
    window: {
      marked: { parse: (text) => { parses++; return '<p>' + text + '</p>'; } },
      DOMPurify: { sanitize: (html) => html },
    },
    markdownHtmlCache: new Map(), markdownHtmlCacheChars: 0,
    MARKDOWN_CACHE_MAX_CHARS: maxChars, MARKDOWN_CACHE_MAX_SOURCE: maxSource,
    applyMarkdownImageRefs: (text) => text,
    shieldMarkdownMath: (text) => ({ text, slots: [] }),
    restoreMarkdownMath: (html) => html,
    escapeHtml: (text) => text,
  });
  load(context, ['renderMarkdown', 'renderMarkdownSource', 'rememberMarkdownHtml', 'clearMarkdownCache']);
  return { context, parses: () => parses };
}

test('rendering the same Markdown again reuses the sanitized HTML', () => {
  const h = harness();
  const first = h.context.renderMarkdown('**hello**');
  assert.equal(h.context.renderMarkdown('**hello**'), first);
  assert.equal(h.parses(), 1);
  h.context.renderMarkdown('**other**');
  assert.equal(h.parses(), 2);
});

test('streaming text and oversized sources are never cached', () => {
  const h = harness({ maxSource: 10 });
  h.context.renderMarkdown('partial', { cache: false });
  h.context.renderMarkdown('partial', { cache: false });
  assert.equal(h.parses(), 2);
  h.context.renderMarkdown('x'.repeat(11));
  h.context.renderMarkdown('x'.repeat(11));
  assert.equal(h.parses(), 4);
  assert.equal(h.context.markdownHtmlCache.size, 0);
});

test('the cache stays within its character budget, dropping the least recently used', () => {
  const h = harness({ maxChars: 40 });
  h.context.renderMarkdown('aaaa'); // 4 + 11 chars
  h.context.renderMarkdown('bbbb');
  h.context.renderMarkdown('aaaa'); // refresh a
  h.context.renderMarkdown('cccc'); // over budget: b is oldest
  assert.deepEqual([...h.context.markdownHtmlCache.keys()], ['aaaa', 'cccc']);
  assert.ok(h.context.markdownHtmlCacheChars <= 40);
});

test('locking clears rendered chat text from memory', () => {
  const h = harness();
  h.context.renderMarkdown('secret reply');
  h.context.clearMarkdownCache();
  assert.equal(h.context.markdownHtmlCache.size, 0);
  assert.equal(h.context.markdownHtmlCacheChars, 0);
  const state = readUiScript('state.js').replace(/\r\n/g, '\n');
  const lock = state.match(/^function clearMemoryAfterLock\([\s\S]*?^\}$/m);
  assert.ok(lock && lock[0].includes('clearMarkdownCache()'), 'clearMemoryAfterLock must clear the Markdown cache');
});
