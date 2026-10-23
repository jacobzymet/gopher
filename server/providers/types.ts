/**
 * The internal chat format is OpenAI chat completions. Anthropic Messages and OpenAI Responses
 * providers are converted at the edge (see wire.ts) and their replies normalized to events.
 */

export type JsonRecord = Record<string, unknown>;

export interface TextPart { type: 'text'; text: string }
export interface ImagePart { type: 'image_url'; image_url: { url: string } | string }
export type ContentPart = TextPart | ImagePart | { type?: string; [key: string]: unknown };
export type MessageContent = string | ContentPart[] | null | undefined;

/** `type` is always 'function' when present; some clients and models omit it. */
export interface ToolCallWire { id: string; type?: 'function'; function: { name: string; arguments: string } }
export type Role = 'system' | 'developer' | 'user' | 'assistant' | 'tool';
export interface ChatMessage {
  role: Role | string;
  content?: MessageContent;
  tool_calls?: ToolCallWire[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
  [key: string]: unknown;
}

export interface ToolFunction { name: string; description?: string; parameters?: JsonRecord; [key: string]: unknown }
export interface ToolDefinition { type?: 'function'; function: ToolFunction }
export type ToolChoice = 'auto' | 'none' | 'required' | 'any'
  | { type: 'function'; function: { name: string } } | { name: string };

/** A completion request in the internal format. Unknown fields (temperature, top_p, …) pass through. */
export interface CompletionPayload {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  temperature?: number;
  reasoning?: JsonRecord;
  reasoning_effort?: string;
  thinking_budget_tokens?: number;
  parallel_tool_calls?: boolean;
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
  input_tokens?: number; output_tokens?: number; [key: string]: unknown;
}

/** What a provider stream yields, whatever its wire format. */
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'progress'; data: JsonRecord }
  | { type: 'done' };

export const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const asRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Text content of a message, ignoring images and other parts. */
export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => isRecord(part) && part.type === 'text').map(part => asString((part as JsonRecord).text)
    || '').join('\n');
}
