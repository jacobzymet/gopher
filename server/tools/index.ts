import fs from 'node:fs/promises';
import type { StoreView } from './retrieval.js';
import { randomUUID } from 'node:crypto';
import { Workspace, executeFilesystem } from './filesystem.js';
import { browsers } from './browser.js';
import { searchWeb, fetchPublicUrl, safeFetch, PageCache, type SearchSettings } from './web.js';
import { terminals } from '../terminal.js';
import { findSkill, fullInstructions, type UserSkill } from '../skills.js';
import type { AgentSkills } from '../engine/request.js';
import type { HistoryArchive } from '../engine/context.js';
import type { JsonObject } from '../storage.js';
import { normalizeQuestions } from './questions.js';
import { retrieve } from './retrieval.js';

/** Running a tool call for the agent. Each tool checks that its capability is enabled for this turn. */

export { canonicalToolName, needsApproval, risk, toolDefinitions } from './definitions.js';
export { normalizeQuestions } from './questions.js';
export { retrievalScope, visibleText } from './retrieval.js';
export type { AgentSkills } from '../engine/request.js';

export type ToolArguments = Record<string, unknown>;
/** A tool call as the model sent it. Arguments are unvalidated JSON. */
export interface ToolCall { id: string; name: string; arguments: unknown; wire_id?: string }
export interface ToolOutcome {
  text: string; ok: boolean; running?: boolean; command_session_id?: string;
  image?: string; image_id?: string; note?: string;
}
export interface ToolContext {
  id: string;
  conversationId?: string;
  profileId?: string | null;
  skills: AgentSkills;
  userSkills: UserSkill[];
  signal: AbortSignal;
  history: HistoryArchive;
  pages?: PageCache;
  getStore?: () => Promise<Readonly<StoreView>>;
  getPreferences?: () => Promise<Readonly<JsonObject>>;
  clarify: (questions: unknown[]) => Promise<unknown>;
}

/** Arguments as an object; anything else reads as no arguments. */
export function toolArguments(value: unknown): ToolArguments {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ToolArguments : {};
}

const FILE_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'write_file', 'str_replace', 'delete_file',
  'apply_patch']);
const MAX_IMAGE_BYTES = 1_500_000;
const HISTORY_PAGE_BYTES = 12000;
const str = (value: unknown, fallback = '') => (typeof value === 'string' && value ? value : fallback);
const within = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Search settings from the turn's skills and the call's own recency. */
function searchSettings(skills: AgentSkills, args: ToolArguments): SearchSettings {
  const depth = String(skills.web_search_depth || 'standard');
  const provider = String(skills.web_search_provider || skills.web_search_backend || 'auto');
  const pageChars = { deep: 4800, light: 1600, standard: 3200 }[depth] ?? 2800;
  const pageCount = depth === 'off' ? 0 : ({ light: 2, deep: 6, standard: 4 }[depth] ?? 3);
  const safe = String(skills.web_search_safesearch);
  const recency = args.recency || skills.web_search_recency;
  return {
    searchProvider: ['duckduckgo', 'searxng', 'parallel', 'tinyfish'].includes(provider)
      ? provider as SearchSettings['searchProvider'] : 'auto',
    searchDepth: depth === 'deep' ? 'deep' : depth === 'off' ? 'fast' : 'balanced',
    searchPageCount: pageCount,
    searchPageMaxChars: within(Number(skills.web_search_page_max_chars) || pageChars, 1000, 200_000),
    searchResultCount: within(Number(skills.web_search_max_results) || 6, 1, 20),
    searchRegion: str(skills.web_search_region, 'us-en'),
    searchSafeSearch: safe === 'on' ? 'strict' : ['strict', 'moderate', 'off'].includes(safe)
      ? safe as SearchSettings['searchSafeSearch'] : 'moderate',
    searchRecency: ['day', 'week', 'month', 'year'].includes(String(recency))
      ? recency as SearchSettings['searchRecency'] : 'any',
    searxngUrl: str(skills.web_search_searxng),
    parallelMode: str(skills.web_search_parallel_mode, 'fast') as SearchSettings['parallelMode'],
  };
}

async function webSearch(context: ToolContext, args: ToolArguments): Promise<ToolOutcome> {
  const skills = context.skills;
  if (!skills.web_search) throw new Error('Web search is disabled');
  const query = String(args.query || '').trim();
  if (!query || query.length > 4096) throw new Error('Search query is missing or too long');
  const credentials = {
    parallel: str(skills.web_search_parallel_api_key) || process.env.PARALLEL_API_KEY,
    tinyfish: str(skills.web_search_tinyfish_api_key) || process.env.TINYFISH_API_KEY,
  };
  const result = await searchWeb(query, searchSettings(skills, args), context.signal, credentials, context.pages);
  return { ok: true, text: JSON.stringify(result), note: result.note };
}

/** A window of a fetched page, by character offset, with the offset to continue from. */
async function fetchUrl(context: ToolContext, args: ToolArguments): Promise<ToolOutcome> {
  if (!context.skills.fetch_url) throw new Error('Web fetching is disabled');
  const max = within(Number(args.max_chars || context.skills.fetch_url_max_chars) || 8000, 1000, 200_000);
  const offset = Math.max(0, Number(args.offset) || 0);
  const url = String(args.url ?? '');
  const fetcher = () => fetchPublicUrl(url, context.signal, 4_000_000);
  const result = await (context.pages ? context.pages.read(url, fetcher) : fetcher());
  const characters = Array.from(result.text);
  const text = characters.slice(offset, offset + max).join('');
  const end = offset + Array.from(text).length;
  const page = { ...result, text, offset, total_chars: characters.length, truncated: end < characters.length,
    next_offset: end < characters.length ? end : null };
  return { ok: true, text: JSON.stringify(page) };
}

/** List archived tool outputs, or read one in UTF-8-safe byte pages. */
function readToolHistory(context: ToolContext, args: ToolArguments): ToolOutcome {
  if (!args.id) {
    const records = [...context.history].map(([id, record]) => ({ id, name: record.name, arguments: record.arguments,
      bytes: Buffer.byteLength(record.text) }));
    const offset = Math.max(0, Number(args.offset) || 0), limit = within(Number(args.limit) || 10, 1, 20);
    return { ok: true,
      text: JSON.stringify({ results: records.slice(offset, offset + limit),
        next_offset: offset + limit < records.length ? offset + limit : null }) };
  }
  const record = context.history.get(String(args.id));
  if (!record) throw new Error('Tool history record was not found');
  const bytes = Buffer.from(record.text);
  const offset = Math.max(0, Number(args.byte_offset) || 0),
    max = within(Number(args.max_bytes) || HISTORY_PAGE_BYTES, 256, HISTORY_PAGE_BYTES);
  let end = Math.min(bytes.length, offset + max);
  while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
  const page = { id: args.id, name: record.name, content: bytes.subarray(offset, end).toString(),
    next_byte_offset: end < bytes.length ? end : null };
  return { ok: true, text: JSON.stringify(page) };
}

async function readImageUrl(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await safeFetch(url, signal);
  if (!response.body) throw new Error('Empty image response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 1.5 MB');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

/** The image type from its first bytes; only common web formats are shown. */
function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (bytes.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  return bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
}

async function showImage(context: ToolContext, args: ToolArguments): Promise<ToolOutcome> {
  if (Boolean(args.path) === Boolean(args.url)) throw new Error('Pass either a workspace path or an image URL');
  let bytes: Buffer;
  if (args.path) {
    const workspace = await Workspace.open(str(context.skills.workspace_root));
    const file = await workspace.resolve(String(args.path));
    const meta = await fs.stat(file);
    if (!meta.isFile()
      || meta.size > MAX_IMAGE_BYTES) throw new Error('Image must be a regular file smaller than 1.5 MB');
    bytes = await fs.readFile(file);
  } else bytes = await readImageUrl(String(args.url), context.signal);
  const mime = imageMime(bytes);
  if (!mime) throw new Error('Unsupported image format');
  const id = `image_${randomUUID()}`;
  return { ok: true, text: `Image ${id} is available to display.`,
    image: `data:${mime};base64,${bytes.toString('base64')}`, image_id: id };
}

async function terminalTool(context: ToolContext, name: string, args: ToolArguments): Promise<ToolOutcome> {
  const skills = context.skills;
  if (!skills.terminal) throw new Error('Terminal tools are disabled');
  const workspace = str(skills.workspace_root);
  const result = name === 'run_terminal'
    ? await terminals.command(workspace, context.id, args, Number(skills.terminal_timeout_secs) || 30, context.signal)
    : await terminals.wait(context.id, args, workspace, context.signal);
  return { ok: result.running || (!result.stopped && result.exit_code === 0), text: JSON.stringify(result), running: result.running,
    command_session_id: result.session_id,
    ...(result.stopped ? { note: 'Process intentionally stopped. Restart only if the user requests it.' } : {}) };
}

export async function executeTool(context: ToolContext, call: ToolCall): Promise<ToolOutcome> {
  const name = call.name, skills = context.skills, args = toolArguments(call.arguments);
  context.signal.throwIfAborted();
  if (FILE_TOOLS.has(name)) {
    if (!skills.filesystem) throw new Error('Filesystem tools are disabled');
    return { ok: true,
      text: await executeFilesystem(await Workspace.open(str(skills.workspace_root)), name, args, context.signal) };
  }
  if (name === 'run_terminal' || name === 'wait_terminal') return terminalTool(context, name, args);
  if (name.startsWith('browser_')) {
    if (!skills.browser) throw new Error('Browser tools are disabled');
    return { ok: true, ...await browsers.execute(context.id, str(skills.workspace_root), name, args, context.signal) };
  }
  if (name === 'web_search') return webSearch(context, args);
  if (name === 'fetch_url') return fetchUrl(context, args);
  if (name === 'list_chats' || name === 'search_chats' || name === 'read_chat') {
    if (skills.chat_retrieval === false) throw new Error('Chat retrieval is disabled');
    return { ok: true, text: await retrieve(context, name, args) };
  }
  if (name === 'activate_skill') {
    const skill = findSkill(context.userSkills, String(args.name || ''));
    if (!skill || !skill.enabled) throw new Error('Skill was not found');
    return { ok: true, text: fullInstructions(skill) };
  }
  if (name === 'ask_user') {
    // Questions may arrive in other shapes (even a bare array), so they are read from the raw arguments.
    const questions = normalizeQuestions(call.arguments);
    if (!questions.length) {
      throw new Error('Retry ask_user with 1–2 questions, each containing question text and 2–4 labeled options.');
    }
    const answers = await context.clarify(questions);
    return { ok: true, text: JSON.stringify({ questions, answers }) };
  }
  if (name === 'read_tool_history') return readToolHistory(context, args);
  if (name === 'show_image') return showImage(context, args);
  throw new Error(`Unknown or disabled tool: ${name}`);
}

