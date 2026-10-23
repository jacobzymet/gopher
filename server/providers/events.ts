import { parseSSE, readBounded } from './http.js';
import { asArray, asRecord, asString, type JsonRecord, type ProviderEvent, type Usage } from './types.js';

/** Normalizing provider replies (single JSON bodies and SSE streams, in all three styles) to events. */

const MAX_TOOL_INDEX = 128;
type Style = 'openai' | 'anthropic' | 'responses';

function providerError(item: JsonRecord): Error {
  const error = item.error;
  return new Error(asString(asRecord(error).message) || asString(item.message) || String(error));
}

function* anthropicJson(result: JsonRecord): Generator<ProviderEvent> {
  const content = asArray(result.content);
  for (const [index, raw] of content.entries()) {
    const block = asRecord(raw);
    if (block.type === 'text') yield { type: 'text', text: asString(block.text) || '' };
    if (block.type === 'thinking') yield { type: 'reasoning', text: asString(block.thinking) || '' };
    if (block.type === 'tool_use') {
      yield { type: 'tool', index, id: asString(block.id), name: asString(block.name),
        arguments: JSON.stringify(block.input) };
    }
  }
}

function* responsesJson(result: JsonRecord): Generator<ProviderEvent> {
  const outputText = asString(result.output_text);
  if (outputText) { yield { type: 'text', text: outputText }; return; }
  const output = asArray(result.output);
  for (const [index, raw] of output.entries()) {
    const item = asRecord(raw);
    if (item.type === 'function_call') {
      yield { type: 'tool', index, id: asString(item.call_id), name: asString(item.name),
        arguments: asString(item.arguments) };
    }
    for (const part of asArray(item.content)) {
      const text = asString(asRecord(part).text);
      if (text) yield { type: 'text', text };
    }
  }
}

function* openaiJson(result: JsonRecord): Generator<ProviderEvent> {
  const message = asRecord(asRecord(asArray(result.choices)[0]).message);
  const content = asString(message.content), reasoning = asString(message.reasoning_content);
  if (content) yield { type: 'text', text: content };
  if (reasoning) yield { type: 'reasoning', text: reasoning };
  for (const [index, raw] of asArray(message.tool_calls).entries()) {
    const call = asRecord(raw), fn = asRecord(call.function);
    yield { type: 'tool', index, id: asString(call.id), name: asString(fn.name), arguments: asString(fn.arguments) };
  }
}

/** A complete (non-streamed) JSON reply. */
export async function* jsonEvents(response: Response, style: Style): AsyncGenerator<ProviderEvent> {
  if (!response.ok) {
    for await (const _ of parseSSE(response)) { /* parseSSE throws the provider's error. */ }
    return;
  }
  const result = asRecord(JSON.parse(await readBounded(response)));
  if (result.error) throw providerError(result);
  if (style === 'anthropic') yield* anthropicJson(result);
  else if (style === 'responses') yield* responsesJson(result);
  else yield* openaiJson(result);
  if (result.usage) yield { type: 'usage', usage: result.usage as Usage };
  yield { type: 'done' };
}

/** Anthropic stream events; returns true at message_stop. */
function anthropicEvent(item: JsonRecord, events: ProviderEvent[]): boolean {
  const index = typeof item.index === 'number' ? item.index : 0;
  if (item.type === 'content_block_start') {
    const block = asRecord(item.content_block);
    if (block.type === 'tool_use') {
      const input = asRecord(block.input);
      events.push({ type: 'tool', index, id: asString(block.id), name: asString(block.name),
        arguments: Object.keys(input).length ? JSON.stringify(input) : '' });
    }
    if (block.type === 'text' && block.text) events.push({ type: 'text', text: String(block.text) });
    if (block.type === 'thinking' && block.thinking) events.push({ type: 'reasoning', text: String(block.thinking) });
  }
  if (item.type === 'content_block_delta') {
    const delta = asRecord(item.delta);
    if (delta.type === 'text_delta') events.push({ type: 'text', text: asString(delta.text) || '' });
    if (delta.type === 'thinking_delta') events.push({ type: 'reasoning', text: asString(delta.thinking) || '' });
    if (delta.type === 'input_json_delta') events.push({ type: 'tool', index,
      arguments: asString(delta.partial_json) });
  }
  const usage = item.usage || asRecord(item.message).usage;
  if (usage) events.push({ type: 'usage', usage: usage as Usage });
  return item.type === 'message_stop';
}

/** Responses API stream events; returns true when the response completed. */
function responsesEvent(item: JsonRecord, events: ProviderEvent[], tools: Map<string, number>,
  counter: { next: number }): boolean {
  const type = item.type;
  if (type === 'response.output_text.delta') events.push({ type: 'text', text: asString(item.delta) || '' });
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    events.push({ type: 'reasoning', text: asString(item.delta) || '' });
  }
  const added = asRecord(item.item);
  if (type === 'response.output_item.added' && added.type === 'function_call') {
    const index = counter.next++;
    if (typeof added.id === 'string') tools.set(added.id, index);
    if (typeof added.call_id === 'string') tools.set(added.call_id, index);
    events.push({ type: 'tool', index, id: asString(added.call_id) || asString(added.id), name: asString(added.name),
      arguments: asString(added.arguments) || '' });
  }
  if (type === 'response.function_call_arguments.delta') {
    const key = asString(item.item_id) || asString(item.call_id) || '';
    events.push({ type: 'tool', index: tools.get(key) ?? Math.max(0, counter.next - 1),
      arguments: asString(item.delta) });
  }
  const response = asRecord(item.response);
  if (type === 'response.failed' || type === 'response.incomplete') {
    const reason = asString(asRecord(response.error).message) || asString(asRecord(response.incomplete_details).reason);
    throw new Error(reason || 'Provider response was incomplete');
  }
  if (type === 'response.completed') {
    if (response.usage) events.push({ type: 'usage', usage: response.usage as Usage });
    return true;
  }
  return false;
}

function openaiEvent(item: JsonRecord, events: ProviderEvent[]): void {
  const choice = asRecord(asArray(item.choices)[0]);
  const delta = asRecord(choice.delta ?? choice.message);
  const content = asString(delta.content), reasoning = asString(delta.reasoning_content) || asString(delta.reasoning);
  if (content) events.push({ type: 'text', text: content });
  if (reasoning) events.push({ type: 'reasoning', text: reasoning });
  for (const raw of asArray(delta.tool_calls)) {
    const call = asRecord(raw), fn = asRecord(call.function);
    const index = call.index ?? 0;
    if (typeof index !== 'number' || !Number.isInteger(index)
      || index > MAX_TOOL_INDEX) throw new Error('Invalid provider tool index');
    const args = typeof fn.arguments === 'object' && fn.arguments !== null
      ? JSON.stringify(fn.arguments) : asString(fn.arguments) || asString(call.arguments);
    events.push({ type: 'tool', index, id: asString(call.id), name: asString(fn.name) || asString(call.name),
      arguments: args });
  }
  if (item.usage) events.push({ type: 'usage', usage: item.usage as Usage });
  const progress = item.progress || item.prompt_progress;
  if (progress) events.push({ type: 'progress', data: asRecord(progress) });
}

/** A streamed SSE reply. */
export async function* streamEvents(response: Response, style: Style): AsyncGenerator<ProviderEvent> {
  const tools = new Map<string, number>(), counter = { next: 0 };
  for await (const frame of parseSSE(response)) {
    if (frame.data === '[DONE]') break;
    let item: JsonRecord;
    try { item = asRecord(JSON.parse(frame.data)); } catch { continue; }
    if (!item.type && frame.event !== 'message') item.type = frame.event;
    if (item.error || item.type === 'error') throw providerError(item);
    const events: ProviderEvent[] = [];
    let finished = false;
    if (style === 'anthropic') finished = anthropicEvent(item, events);
    else if (style === 'responses') finished = responsesEvent(item, events, tools, counter);
    else openaiEvent(item, events);
    yield* events;
    if (finished) break;
  }
  yield { type: 'done' };
}
