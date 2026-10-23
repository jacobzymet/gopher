const { readUiScript } = require('./helpers/ui-source.cjs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');

function load(context, file, names) {
  const source = readUiScript(file).replace(/\r\n/g, '\n');
  for (const name of names) {
    const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}

test('the clock is added to the newest user message, never to earlier history', () => {
  const context = vm.createContext({});
  load(context, 'runtime.js', ['appendTurnClock']);
  const messages = [
    { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'now?' },
  ];
  assert.equal(context.appendTurnClock(messages, 'Now: 12:01'), true);
  assert.deepEqual(messages.map((m) => m.content), ['earlier', 'reply', 'now?\n\nNow: 12:01']);

  const image = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }];
  const withImage = [{ role: 'user', content: image }];
  assert.equal(context.appendTurnClock(withImage, 'Now: 12:02'), true);
  assert.equal(JSON.stringify(withImage[0].content), JSON.stringify([...image, { type: 'text', text: 'Now: 12:02' }]));
  assert.equal(image.length, 1, 'the stored message parts are not mutated');

  assert.equal(context.appendTurnClock([{ role: 'assistant', content: 'loop turn' }], 'Now'), false);
  assert.equal(context.appendTurnClock([], 'Now'), false);
});

function usageHarness() {
  const context = vm.createContext({});
  load(context, 'render.js', ['ingestStreamUsage', 'finalizeTurnStats']);
  const stats = { completionTokens: 0, promptTokens: 0, contextPromptTokens: null, contextCompletionTokens: null,
    providerTokPerSec: null, upstreamModel: null };
  return { context, stats };
}

test('cached prompt tokens add up across the rounds of one turn', () => {
  const { context, stats } = usageHarness();
  context.ingestStreamUsage(stats, { usage: { prompt_tokens: 1000, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 900 } } });
  context.ingestStreamUsage(stats, { usage: { prompt_tokens: 1100, completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 1050 } } });
  assert.equal(stats.cachedTokens, 1950);
  assert.equal(stats.cachedPromptTokens, 2100);
  const final = context.finalizeTurnStats(stats, 0, 1000);
  assert.equal(final.cachedTokens, 1950);
  assert.equal(final.cachedPromptTokens, 2100);
});

test('a provider that never reports caching leaves the cache rate unknown', () => {
  const { context, stats } = usageHarness();
  context.ingestStreamUsage(stats, { usage: { prompt_tokens: 500, completion_tokens: 5 } });
  assert.equal(stats.cachedTokens, undefined);
  const final = context.finalizeTurnStats(stats, 0, 1000);
  assert.equal(final.cachedTokens, null);
  assert.equal(final.cachedPromptTokens, null);
});

function labelHarness() {
  const element = () => {
    const classes = new Set(['is-hidden']);
    return { textContent: '', title: '', classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name),
    } };
  };
  const elements = { contextCacheRate: element(), contextUsageCache: element(), contextCacheDetail: element() };
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] || null },
  });
  load(context, 'input.js', ['exactContextTokenCount', 'formatContextTokenCount', 'contextCacheSnapshot',
    'syncContextCacheRate']);
  return { context, elements };
}

test('the context tooltip shows prompt reuse for the running turn, else the latest reply from the model', () => {
  const { context, elements } = labelHarness();
  const convo = { messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a', contextModel: 'm', promptTokens: 1000,
      cachedTokens: 750, cachedPromptTokens: 1000 },
  ] };
  context.syncContextCacheRate(context.contextCacheSnapshot(convo, 'm', null));
  assert.equal(elements.contextCacheRate.textContent, '75% reused');
  assert.equal(elements.contextUsageCache.classList.contains('is-hidden'), false);
  assert.equal(elements.contextCacheDetail.textContent, '750 / 1,000 prompt tokens · latest turn');

  const live = { cachedTokens: 1900, cachedPromptTokens: 2000 };
  context.syncContextCacheRate(context.contextCacheSnapshot(convo, 'm', live));
  assert.equal(elements.contextCacheRate.textContent, '95% reused');

  // A newer reply without cache data hides the label instead of showing a stale rate.
  convo.messages.push({ role: 'assistant', content: 'b', contextModel: 'm', promptTokens: 1200 });
  context.syncContextCacheRate(context.contextCacheSnapshot(convo, 'm', null));
  assert.equal(elements.contextUsageCache.classList.contains('is-hidden'), true);
  assert.equal(elements.contextCacheRate.textContent, '');
  assert.equal(elements.contextCacheDetail.textContent, '');
});
