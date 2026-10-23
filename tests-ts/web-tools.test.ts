import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../server/tools/html-text.js';
import { canonicalUrl, isJunkUrl, isListingUrl, mergeResults, rankResults } from '../server/tools/search-ranking.js';
import { decodeResultHref, isDuckDuckGoChallenge, parseDuckDuckGo } from '../server/tools/search-engines.js';
import { fetchPublicUrl, readableBody, scrapeableUrl } from '../server/tools/page-fetch.js';

test('page text keeps the article and drops navigation, footers, scripts and forms', () => {
  const html = `<!doctype html><html><head><title>Ignored</title><style>p{}</style></head><body>
    <header><nav><a href="/">Home</a><a href="/news">News</a></nav></header>
    <aside>Related links you should not see</aside>
    <article><h1>Solar panel efficiency</h1>
      <p>Modern panels convert about 22% of sunlight into electricity &amp; keep improving.</p>
      <ul><li>Monocrystalline cells</li><li>Perovskite tandems</li></ul>
      <script>window.track('<p>not text</p>')</script>
      <pre>  indented
    code</pre>
      <form><button>Subscribe</button></form>
    </article>
    <footer>Copyright 2024</footer></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /^Solar panel efficiency/);
  assert.match(text, /22% of sunlight into electricity & keep improving/);
  assert.match(text, /- Monocrystalline cells\n- Perovskite tandems/);
  assert.match(text, / {2}indented\n {4}code/);
  for (const hidden of ['Home', 'Related links', 'not text', 'Subscribe', 'Copyright', 'Ignored']) assert.doesNotMatch(text, new RegExp(hidden));
});

test('page text falls back to the body, tolerates broken markup and keeps Unicode offsets aligned', () => {
  const text = htmlToText('<div>İstanbul <b>bold<i>nested</b> text</div><SCRIPT>bad()</SCRIPT><p>Second &#x1F600; line</p></span>');
  assert.equal(text, 'İstanbul boldnested text\nSecond 😀 line');
  assert.equal(htmlToText('<main>short</main><p>Body text that is long enough to be the only real content on this page, honestly.</p>'),
    'short\nBody text that is long enough to be the only real content on this page, honestly.');
});

test('page text extraction stays linear on large pages', () => {
  const html = `<body>${'<div><script>x()</script><p>Paragraph with some words.</p></div>'.repeat(60_000)}</body>`;
  const started = performance.now();
  const text = htmlToText(html);
  assert.ok(performance.now() - started < 4000, 'a 3.5 MB page should extract in well under four seconds');
  assert.equal(text.split('\n').length, 60_000);
});

test('fetched bodies are decoded by type and binary links are refused before downloading', () => {
  assert.equal(readableBody('{"a":[1,2]}', 'application/json', 'https://example.com/x').text, '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.equal(readableBody('# Notes\n\ntext', 'text/markdown', 'https://example.com/a.md').text, '# Notes\n\ntext');
  assert.equal(readableBody('<title>T &amp; U</title><p>Hi</p>', '', 'https://example.com/page').title, 'T & U');
  assert.equal(scrapeableUrl('https://example.com/report.pdf'), false);
  assert.equal(scrapeableUrl('https://www.google.com/search?q=x'), false);
  assert.equal(scrapeableUrl('https://example.com/docs/oauth-login-guide'), true);
  assert.equal(scrapeableUrl('https://github.com/topics/rust'), true);
});

test('fetch_url retries a 403 once with a looser Accept header', async () => {
  const accepts: string[] = [];
  const request = async (_url: string, _signal: AbortSignal, init: RequestInit = {}) => {
    const accept = new Headers(init.headers).get('accept') || '';
    accepts.push(accept);
    if (accepts.length === 1) throw Object.assign(new Error('Search request failed (403)'), { status: 403 });
    return new Response('<article><p>Recovered page text that is clearly long enough to count as the article body.</p></article>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  const page = await fetchPublicUrl('https://example.com/story', AbortSignal.timeout(2000), 16_000, request);
  assert.match(page.text, /^Recovered page text/);
  assert.equal(accepts.length, 2);
  assert.match(accepts[0]!, /text\/html/);
  assert.equal(accepts[1], '*/*');
});

test('search results drop engine, sign-in and listing pages, merge duplicates and cap hosts', () => {
  assert.ok(isJunkUrl('https://duckduckgo.com/y.js?ad=1'));
  assert.ok(isJunkUrl('https://accounts.example.com/'));
  assert.ok(isJunkUrl('https://example.com/user/login'));
  assert.ok(isListingUrl('https://news.example.com/tag/solar'));
  assert.equal(canonicalUrl('HTTPS://www.Example.com/Page/#top'), 'example.com/page');
  const merged = mergeResults([
    { source: 'duckduckgo', results: [
      { title: 'Solar efficiency explained', url: 'https://a.example/solar', snippet: 'short' },
      { title: 'Solar one', url: 'https://same.example/1', snippet: 'solar efficiency' },
      { title: 'Solar two', url: 'https://same.example/2', snippet: 'solar efficiency' },
      { title: 'Solar three', url: 'https://same.example/3', snippet: 'solar efficiency' },
    ] },
    { source: 'duckduckgo-lite', results: [
      { title: 'Solar efficiency explained', url: 'http://www.a.example/solar/', snippet: 'a much longer snippet about solar efficiency' },
    ] },
  ], 'solar panel efficiency', 10);
  assert.equal(merged.filter(item => item.url.includes('a.example')).length, 1);
  assert.equal(merged.find(item => item.url.includes('a.example'))?.snippet, 'a much longer snippet about solar efficiency');
  assert.equal(merged.filter(item => item.url.includes('same.example')).length, 2);
});

test('news queries prefer reliable reporting over tabloids and tag pages', () => {
  const ranked = rankResults([
    { title: 'Election latest gossip', url: 'https://www.tmz.com/election', snippet: 'election news' },
    { title: 'Election news tag', url: 'https://site.example/tag/election', snippet: 'election news' },
    { title: 'Election results live', url: 'https://www.reuters.com/world/election', snippet: 'election news' },
    { title: 'Election analysis', url: 'https://blog.example/election', snippet: 'election news' },
    { title: 'Election explainer', url: 'https://other.example/election', snippet: 'election news' },
  ], 'election news today', 5);
  assert.equal(ranked[0]?.url, 'https://www.reuters.com/world/election');
  assert.ok(!ranked.some(item => item.url.includes('tmz.com') || item.url.includes('/tag/')));
});

test('DuckDuckGo results decode redirects, pair snippets with their own link and detect challenges', () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">First <b>result</b></a>
    <a class="result__snippet" href="#">First snippet</a></div>
    <div class="result"><a class="result__a" href="https://example.org/b">Second</a></div>
    <div class="result"><a class="result__a" href="https://example.net/c">Third</a><a class="result__snippet">Third snippet</a></div>`;
  const results = parseDuckDuckGo(html, 'result__a', 'result__snippet');
  assert.deepEqual(results.map(item => [item.title, item.url, item.snippet]), [
    ['First result', 'https://example.com/a', 'First snippet'],
    ['Second', 'https://example.org/b', ''],
    ['Third', 'https://example.net/c', 'Third snippet'],
  ]);
  const bing = `https://www.bing.com/ck/a?u=a1${Buffer.from('https://example.com/real').toString('base64url')}`;
  assert.equal(decodeResultHref(bing), 'https://example.com/real');
  assert.ok(isDuckDuckGoChallenge('<script src="/anomaly.js"></script>'));
  assert.ok(!isDuckDuckGoChallenge(html));
});
