'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const input = fs.readFileSync('src/ui/chat/scripts/input.js', 'utf8');
const inputStart = input.indexOf('function exactContextTokenCount(');
const inputEnd = input.indexOf('\nfunction syncContextUsage(', inputStart);
assert.ok(inputStart >= 0 && inputEnd > inputStart);

const render = fs.readFileSync('src/ui/chat/scripts/render.js', 'utf8');
const renderStart = render.indexOf('function ingestStreamUsage(');
const renderEnd = render.indexOf('\nfunction finalizeTurnStats(', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart);

const context = vm.createContext({});
vm.runInContext(
  input.slice(inputStart, inputEnd)
    + render.slice(renderStart, renderEnd)
    + '\nthis.contextUsageSnapshot = contextUsageSnapshot; this.ingestStreamUsage = ingestStreamUsage;',
  context
);

test('missing live usage never becomes a false zero or replaces saved usage', () => {
  const convo = {
    messages: [
      { role: 'assistant', contextTokens: 400, contextPromptTokens: 380, contextCompletionTokens: 20, contextModel: 'model' },
      { role: 'assistant', contextTokens: null, contextPromptTokens: null, contextCompletionTokens: null, contextModel: 'model' },
    ],
  };
  assert.deepEqual(
    { ...context.contextUsageSnapshot(convo, 'model', { contextPromptTokens: null, contextCompletionTokens: null }) },
    { used: 400, prompt: 380, completion: 20, model: 'model' }
  );
});

test('authoritative live usage replaces the previous completed turn', () => {
  const convo = { messages: [{ role: 'assistant', contextTokens: 400, contextModel: 'model' }] };
  assert.deepEqual(
    { ...context.contextUsageSnapshot(convo, 'model', { contextPromptTokens: 500, contextCompletionTokens: 12 }) },
    { used: 512, prompt: 500, completion: 12, model: 'model' }
  );
});

test('llama prompt progress supplies exact current prompt usage before final usage', () => {
  const stats = {
    contextPromptTokens: null,
    contextCompletionTokens: 99,
    promptTokens: 0,
    completionTokens: 0,
  };
  context.ingestStreamUsage(stats, { prompt_progress: { total: 2048, processed: 512, cache: 256 } });
  assert.equal(stats.contextPromptTokens, 2048);
  assert.equal(stats.contextCompletionTokens, null);
  context.ingestStreamUsage(stats, { usage: { prompt_tokens: 2048, completion_tokens: 32 } });
  assert.equal(stats.contextPromptTokens, 2048);
  assert.equal(stats.contextCompletionTokens, 32);
  context.ingestStreamUsage(stats, { usage: { prompt_tokens: null, completion_tokens: null } });
  assert.equal(stats.contextPromptTokens, 2048);
  assert.equal(stats.contextCompletionTokens, 32);
});
