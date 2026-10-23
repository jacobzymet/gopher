import { asRecord, asString, isRecord, textContent, type ChatMessage, type CompletionPayload,
  type JsonRecord } from './types.js';

/** Converting internal (OpenAI chat) requests to each provider's wire format. */

const isInstruction = (message: ChatMessage) => message.role === 'system' || message.role === 'developer';
const instructions = (messages: ChatMessage[]) =>
  messages.filter(isInstruction).map(message => textContent(message.content));
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
const THINKING_BUDGETS: Record<string, number> = { low: 1024, medium: 4096, high: 10000, max: 10000 };
/** Request fields that steer Gopher itself and must never reach a provider. */
const INTERNAL_KEYS = [
  'agent', 'skills', 'force_tools', 'conversation_id', 'turn_id', 'deep_research', 'deep_research_output',
  'context_window_tokens', 'provider_id', 'remote_base',
];

function toolChoiceName(choice: unknown): string | undefined {
  const value = asRecord(choice);
  return asString(asRecord(value.function).name) || asString(value.name);
}

function parseArguments(raw: unknown): unknown {
  return typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
}

/** An image part as Anthropic expects it: inline base64 for data URLs, otherwise a URL source. */
function anthropicImage(part: JsonRecord): JsonRecord {
  const image = part.image_url;
  const url = asString(asRecord(image).url) || asString(image) || asString(part.url) || '';
  const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
  return { type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url',
    url } };
}

function anthropicContent(message: ChatMessage): JsonRecord[] {
  const content: JsonRecord[] = [];
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
  else if (Array.isArray(message.content)) {
    for (const raw of message.content) {
      const part = asRecord(raw);
      if (part.type === 'text') content.push(part);
      else if (part.type === 'image_url' || part.type === 'input_image' || (!part.type && (part.image_url
        || part.url))) {
        content.push(anthropicImage(part));
      }
    }
  }
  for (const call of message.tool_calls || []) {
    content.push({ type: 'tool_use', id: call.id, name: call.function.name,
      input: parseArguments(call.function.arguments) });
  }
  return content;
}

/** Anthropic prompt caching applies only to the official API with Claude models. */
function officialAnthropic(apiBase: string, payload: CompletionPayload): boolean {
  try {
    const url = new URL(apiBase);
    return url.protocol === 'https:' && url.hostname === 'api.anthropic.com'
      && String(payload.model).startsWith('claude-')
      && payload.stream !== false;
  } catch { return false; }
}

export function anthropicPayload(payload: CompletionPayload, apiBase = ''): JsonRecord {
  const system = instructions(payload.messages).join('\n\n');
  const messages: Array<{ role: string; content: JsonRecord[] }> = [];
  const push = (role: string, content: JsonRecord[]) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...content); else messages.push({ role, content });
  };
  for (const message of payload.messages) {
    if (isInstruction(message)) continue;
    if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: textContent(message.content) }]);
      continue;
    }
    const content = anthropicContent(message);
    if (content.length) push(message.role === 'assistant' ? 'assistant' : 'user', content);
  }
  if (!messages.length) throw new Error('messages must not be empty');
  // Anthropic conversations must start with a user turn.
  if (messages[0]!.role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text',
    text: '(continued)' }] });
  const maxTokens = Math.max(1, payload.max_tokens || payload.max_completion_tokens || DEFAULT_ANTHROPIC_MAX_TOKENS);
  const result: JsonRecord = { model: payload.model, ...(system ? { system } : {}), messages, max_tokens: maxTokens,
    stream: payload.stream !== false };
  if (payload.tools?.length) {
    const tools = payload.tools.map(tool => ({
      name: tool.function.name, description: tool.function.description || '',
      input_schema: tool.function.parameters || { type: 'object', properties: {} },
    }));
    result.tools = tools;
    const name = toolChoiceName(payload.tool_choice);
    const choice = payload.tool_choice;
    result.tool_choice = name ? { type: 'tool', name }
      : { type: choice === 'required' || choice === 'any' ? 'any' : choice === 'none' ? 'none' : 'auto' };
  }
  const budget = payload.thinking_budget_tokens || THINKING_BUDGETS[String(payload.reasoning_effort)];
  if (budget && budget > 0) result.thinking = { type: 'enabled', budget_tokens: Math.min(budget, maxTokens - 1) };
  else if (payload.temperature !== undefined) result.temperature = payload.temperature;
  if (officialAnthropic(apiBase, payload)) {
    result.cache_control = { type: 'ephemeral' };
    const parts = instructions(payload.messages).filter(Boolean);
    const cached = { cache_control: { type: 'ephemeral' } };
    const block = (text: string, index: number) => ({ type: 'text', text, ...(index === 0 ? cached : {}) });
    if (parts.length) result.system = parts.map(block);
    const tools = result.tools as JsonRecord[] | undefined;
    if (tools?.length) tools.at(-1)!.cache_control = { type: 'ephemeral' };
  }
  return result;
}

function responsesInput(message: ChatMessage): JsonRecord | undefined {
  if (!message.content) return undefined;
  if (message.role === 'assistant') return { role: 'assistant', content: textContent(message.content) };
  if (typeof message.content === 'string') return { role: 'user', content: message.content };
  const parts = message.content.map(raw => {
    const part = asRecord(raw);
    if (part.type === 'image_url') return { type: 'input_image', image_url: asString(asRecord(part.image_url).url) };
    return part.text ? { type: 'input_text', text: part.text } : null;
  }).filter(Boolean);
  return { role: 'user', content: parts };
}

export function responsesPayload(payload: CompletionPayload, builtin = false): JsonRecord {
  const instruction = instructions(payload.messages).join('\n\n');
  const input: JsonRecord[] = [];
  for (const message of payload.messages) {
    if (isInstruction(message)) continue;
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textContent(message.content) });
      continue;
    }
    for (const call of message.tool_calls || []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name,
        arguments: call.function.arguments });
    }
    const item = responsesInput(message);
    if (item) input.push(item);
  }
  // The ChatGPT backend requires instructions and must not store conversations.
  const result: JsonRecord = {
    model: payload.model, ...(instruction || builtin ? { instructions: instruction
      || 'You are a helpful assistant.' } : {}),
    input, stream: payload.stream !== false, ...(builtin ? { store: false } : {}),
  };
  if (payload.tools?.length) {
    result.tools = payload.tools.map(tool => ({ type: 'function', strict: false, description: '',
      parameters: { type: 'object', properties: {} }, ...tool.function }));
    const name = toolChoiceName(payload.tool_choice);
    const choice = payload.tool_choice;
    result.tool_choice = name ? { type: 'function', name } : choice === 'auto' || choice === 'none'
      || choice === 'required' ? choice : 'auto';
    result.parallel_tool_calls = payload.parallel_tool_calls !== false;
  }
  const reasoning = payload.reasoning;
  if (isRecord(reasoning) && Object.keys(reasoning).length && reasoning.effort !== '') result.reasoning = reasoning;
  else if (typeof payload.reasoning_effort === 'string'
    && payload.reasoning_effort.trim()) result.reasoning = { effort: payload.reasoning_effort.trim() };
  const maxTokens = payload.max_tokens || payload.max_completion_tokens || payload.max_output_tokens;
  if (!builtin && maxTokens) result.max_output_tokens = maxTokens;
  return result;
}

/**
 * OpenAI-compatible requests pass through with streaming usage enabled. Two plain leading system
 * messages are merged, because several local servers accept only one.
 */
export function openaiPayload(payload: CompletionPayload): JsonRecord {
  const stream = payload.stream !== false;
  const body: JsonRecord = { ...payload, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) };
  const messages = body.messages as ChatMessage[] | undefined;
  const plain = (message: ChatMessage | undefined) => message?.role === 'system' && Object.keys(message).length === 2
    && typeof message.content === 'string';
  if (messages) {
    const merged = [...messages];
    while (plain(merged[0]) && plain(merged[1])) merged.splice(0, 2, { role: 'system',
      content: `${merged[0]!.content}\n\n${merged[1]!.content}` });
    body.messages = merged;
  }
  return body;
}

/** Remove Gopher's own request fields before a payload leaves the app. */
export function stripInternalFields(body: JsonRecord): JsonRecord {
  for (const key of INTERNAL_KEYS) delete body[key];
  return body;
}
