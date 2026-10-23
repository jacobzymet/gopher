import type { ChatMessage } from '../providers.js';

/**
 * A chat turn as the client sends it: OpenAI-style messages and parameters, plus Gopher fields
 * (agent mode, deep research, skills). Parameters Gopher does not know pass through to the provider.
 */

export type ApprovalMode = 'manual' | 'auto_safe' | 'auto_all';

/** Agent capabilities and their settings. Flags are enabled by any truthy value, as before. */
export interface AgentSkills {
  chat_retrieval?: unknown; approval_mode?: unknown; web_search?: unknown; fetch_url?: unknown; filesystem?: unknown;
  terminal?: unknown; browser?: unknown; workspace_root?: unknown; web_search_depth?: unknown;
  web_search_max_results?: unknown; web_search_provider?: unknown; web_search_backend?: unknown;
  web_search_page_max_chars?: unknown; web_search_region?: unknown; web_search_safesearch?: unknown;
  web_search_recency?: unknown; web_search_searxng?: unknown; web_search_parallel_mode?: unknown;
  web_search_parallel_api_key?: unknown; web_search_tinyfish_api_key?: unknown; fetch_url_max_chars?: unknown;
  terminal_timeout_secs?: unknown; [key: string]: unknown;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  provider_id?: string;
  remote_base?: string;
  conversation_id?: string;
  turn_id?: string;
  agent?: boolean;
  deep_research?: boolean;
  deep_research_output?: string;
  skills?: AgentSkills;
  force_tools?: string[];
  context_window_tokens?: number;
  thinking_effort?: string;
  [key: string]: unknown;
}

const MAX_MESSAGES = 20_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  return value;
};

/** Validate a turn's outer shape; message contents are checked where they are used. */
export function parseChatRequest(raw: unknown): ChatRequest {
  if (!isRecord(raw) || !Array.isArray(raw.messages) || !raw.messages.length || raw.messages.length > MAX_MESSAGES) {
    throw new Error('messages must be a nonempty array');
  }
  for (const message of raw.messages) {
    if (!isRecord(message) || typeof message.role !== 'string') throw new Error('Each message needs a role');
  }
  if (typeof raw.model !== 'string' || !raw.model.trim()) throw new Error('Choose a model before sending a message');
  const skills = raw.skills;
  if (skills !== undefined && skills !== null && !isRecord(skills)) throw new Error('skills must be an object');
  const forceTools = Array.isArray(raw.force_tools)
    ? raw.force_tools.filter((name): name is string => typeof name === 'string') : undefined;
  const textFields = ['provider_id', 'remote_base', 'deep_research_output', 'thinking_effort'];
  for (const key of textFields) optionalString(raw[key], key);
  return {
    ...raw, messages: raw.messages as ChatMessage[], model: raw.model,
    ...(raw.skills ? { skills: raw.skills as AgentSkills } : {}), ...(forceTools ? { force_tools: forceTools } : {}),
  } as ChatRequest;
}

// Typed reads of skill settings.
export const enabled = (value: unknown) => Boolean(value);
export const text = (value: unknown, fallback = '') => (typeof value === 'string' && value ? value : fallback);
export const count = (value: unknown, fallback: number) => Number(value) || fallback;
