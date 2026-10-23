import type { JsonRecord, Usage } from './types.js';

/**
 * Token usage in one shape whatever the provider reported: prompt, completion and total tokens, plus
 * `prompt_tokens_details.cached_tokens` when the provider says how much of the prompt came from its
 * prompt cache. Providers that say nothing about caching get no cached count (not zero).
 */

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const record = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};

export function normalizeUsage(usage: Usage, timings?: unknown): Usage {
  // Anthropic counts cache reads and writes outside input_tokens; the prompt is all three.
  const read = count(usage.cache_read_input_tokens), written = count(usage.cache_creation_input_tokens);
  const input = count(usage.input_tokens);
  const anthropic = read !== undefined || written !== undefined;
  const llama = record(timings);
  const llamaCached = count(llama.cache_n), llamaFresh = count(llama.prompt_n);
  let prompt = count(usage.prompt_tokens)
    ?? (input !== undefined && anthropic ? input + (read ?? 0) + (written ?? 0) : input);
  if (prompt === undefined && llamaCached !== undefined && llamaFresh !== undefined) prompt = llamaCached + llamaFresh;
  const completion = count(usage.completion_tokens) ?? count(usage.output_tokens);
  const details = record(usage.prompt_tokens_details);
  const cached = count(details.cached_tokens)            // OpenAI chat, OpenRouter, recent llama.cpp
    ?? count(record(usage.input_tokens_details).cached_tokens) // OpenAI Responses
    ?? read                                              // Anthropic
    ?? count(usage.prompt_cache_hit_tokens)              // DeepSeek
    ?? llamaCached;                                      // llama.cpp timings
  const total = count(usage.total_tokens) ?? ((prompt ?? 0) + (completion ?? 0));
  const result: Usage = { ...usage, prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  if (cached !== undefined) {
    result.prompt_tokens_details = { ...details, cached_tokens: Math.min(cached, prompt ?? cached) };
  }
  return result;
}
