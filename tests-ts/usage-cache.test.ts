import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage } from '../server/providers/usage.js';

const cached = (usage: ReturnType<typeof normalizeUsage>) =>
  (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens;

test('OpenAI chat usage keeps its cached prompt tokens', () => {
  const usage = normalizeUsage({ prompt_tokens: 1200, completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 1024 } });
  assert.equal(usage.prompt_tokens, 1200);
  assert.equal(cached(usage), 1024);
  assert.equal(usage.total_tokens, 1240);
});

test('OpenAI Responses usage reports cache hits under input_tokens_details', () => {
  const usage = normalizeUsage({ input_tokens: 900, output_tokens: 10, input_tokens_details: { cached_tokens: 768 } });
  assert.deepEqual([usage.prompt_tokens, usage.completion_tokens, cached(usage)], [900, 10, 768]);
});

test('Anthropic prompt size includes cache reads and writes', () => {
  const usage = normalizeUsage({ input_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 200,
    output_tokens: 1 });
  assert.equal(usage.prompt_tokens, 4250);
  assert.equal(cached(usage), 4000);
});

test('DeepSeek and llama.cpp cache counts are recognized', () => {
  assert.equal(cached(normalizeUsage({ prompt_tokens: 300, prompt_cache_hit_tokens: 256 })), 256);
  const llama = normalizeUsage({ prompt_tokens: 520, completion_tokens: 9 }, { cache_n: 500, prompt_n: 20 });
  assert.equal(cached(llama), 500);
  const timingsOnly = normalizeUsage({ completion_tokens: 9 }, { cache_n: 480, prompt_n: 40 });
  assert.deepEqual([timingsOnly.prompt_tokens, cached(timingsOnly)], [520, 480]);
});

test('providers that say nothing about caching get no cached count', () => {
  const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 5 });
  assert.equal(usage.prompt_tokens_details, undefined);
});

test('normalizing twice changes nothing and cached never exceeds the prompt', () => {
  const once = normalizeUsage({ input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 3 });
  assert.deepEqual(normalizeUsage(once), once);
  assert.equal(cached(normalizeUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } })), 10);
});
