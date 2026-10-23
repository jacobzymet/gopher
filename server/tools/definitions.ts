import type { ToolDefinition } from '../providers.js';
import type { UserSkill } from '../skills.js';
import type { AgentSkills } from '../engine/request.js';

/**
 * Tool schemas offered to the model for the enabled capabilities, and which calls need the
 * user's approval. Descriptions here are fallbacks; packaged prompt files replace most of them.
 */

type Schema = Record<string, unknown>;
const S = { type: 'string' }, N = { type: 'integer' }, B = { type: 'boolean' };
const WRITE_TOOLS = ['write_file', 'str_replace', 'delete_file', 'apply_patch'];
/** Tools that only read conversation state or answer the user; they never need approval. */
const ALWAYS_ALLOWED = ['ask_user', 'wait_terminal', 'read_tool_history', 'list_chats', 'search_chats', 'read_chat'];

/** Models trained on other agents sometimes use a different name for the same tool. */
const TOOL_ALIASES: Record<string, string> = { read_skill: 'activate_skill' };
export function canonicalToolName(name: string): string { return TOOL_ALIASES[name] ?? name; }

export type Risk = 'write' | 'terminal' | 'browser' | 'safe';
export function risk(name: string): Risk {
  if (WRITE_TOOLS.includes(name)) return 'write';
  if (name === 'run_terminal') return 'terminal';
  return name.startsWith('browser_') ? 'browser' : 'safe';
}

/** Auto-all skips approval; auto-safe still asks for writes and terminal commands. */
export function needsApproval(name: string, mode: string): boolean {
  if (mode === 'auto_all' || ALWAYS_ALLOWED.includes(name)) return false;
  return mode !== 'auto_safe' || risk(name) === 'write' || risk(name) === 'terminal';
}

function tool(name: string, description: string, properties: Schema = {}, required: string[] = []): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const OPTION_SCHEMA = { type: 'object', properties: { label: S, description: S }, required: ['label'] };
const QUESTIONS_SCHEMA = {
  type: 'array', minItems: 1, maxItems: 2,
  items: {
    type: 'object',
    properties: { header: S, question: S, options: { type: 'array', minItems: 2, maxItems: 4, items: OPTION_SCHEMA },
      multiSelect: B },
    required: ['question', 'options'],
  },
};

function fileTools(): ToolDefinition[] {
  return [
    tool('read_file',
      'Read a bounded file page. Offset is a 0-based line number; byte_offset resumes exact pages. '
      + 'Preserve unseen content '
      + 'when editing.', { path: S, offset: N, limit: N, byte_offset: N, max_bytes: N }, ['path']),
    tool('list_dir', 'List files and directories in the workspace.', { path: S }),
    tool('glob', 'Find files by a glob. Skips dependency and generated directories.', { pattern: S, path: S },
      ['pattern']),
    tool('grep', 'Search workspace files with a regular expression and bounded context.', {
      query: S, path: S, glob: S, output_mode: { type: 'string', enum: ['content', 'files', 'count'] }, head_limit: N,
      case_insensitive: B, context: N,
    }, ['query']),
    tool('write_file',
      'Create a complete text file. Existing files require explicit overwrite:true; use str_replace or apply_patch '
      + 'for partial edits.', { path: S, content: S, overwrite: B }, ['path', 'content']),
    tool('str_replace', 'Replace an exact string. Must be unique unless replace_all is true.',
      { path: S, old_string: S, new_string: S, replace_all: B }, ['path', 'old_string', 'new_string']),
    tool('delete_file', 'Delete a regular file inside the workspace.', { path: S }, ['path']),
    tool('apply_patch',
      'Apply an atomic *** Begin Patch / *** End Patch block with Add File, Update File, Delete File, and optional '
      + 'Move to operations. Update context uses space, additions +, deletions -.', { patch: S }, ['patch']),
  ];
}

function terminalTools(): ToolDefinition[] {
  const shell = process.platform === 'win32' ? 'PowerShell' : 'the system shell';
  return [
    tool('run_terminal',
      `Run a command in the chat workspace using ${shell}. Running commands return a session_id; use wait_terminal `
      + 'to continue.', { command: S, cwd: S, yield_time_ms: N }, ['command']),
    tool('wait_terminal', 'Read new output or terminate a previously authorized command session in this conversation.',
      { session_id: S, yield_time_ms: N, terminate: B }, ['session_id']),
  ];
}

function browserTools(): ToolDefinition[] {
  return [
    tool('browser_navigate', 'Navigate the conversation browser to an HTTP(S) URL.', { url: S }, ['url']),
    tool('browser_snapshot', 'Read visible page text and element refs from the current page.'),
    tool('browser_click', 'Click a ref returned by the latest snapshot.', { ref: S }, ['ref']),
    tool('browser_type', 'Fill an editable element by ref; optionally submit with Enter.',
      { ref: S, text: S, submit: B }, ['ref', 'text']),
    tool('browser_press', 'Press a keyboard key or shortcut, optionally on a ref.', { key: S, ref: S }, ['key']),
    tool('browser_select', 'Select an option from a select element by ref and value.', { ref: S, value: S },
      ['ref', 'value']),
    tool('browser_wait', 'Wait for a selector or a bounded duration.', { time_ms: N, selector: S }),
    tool('browser_screenshot', 'Take a viewport screenshot; optionally save inside the workspace.', { path: S }),
    tool('browser_evaluate', 'Evaluate JavaScript in the current browser page.', { expression: S }, ['expression']),
    tool('browser_close', 'Close the browser for this conversation.'),
  ];
}

export function toolDefinitions(skills: AgentSkills, userSkills: UserSkill[], deepResearch: boolean,
  retrieval: boolean): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  if (deepResearch) {
    definitions.push(tool('ask_user',
      'Ask 1–2 concise multiple-choice questions to clarify the research goal before researching.',
        { questions: QUESTIONS_SCHEMA }, ['questions']));
  }
  if (skills.web_search) {
    definitions.push(tool('web_search',
      'Search the web for current information. Returns sources and excerpts; cite useful sources '
      + 'using Markdown links.',
        { query: S, recency: { type: 'string', enum: ['any', 'day', 'week', 'month', 'year'] } }, ['query']));
  }
  if (skills.fetch_url) {
    definitions.push(tool('fetch_url',
      'Read bounded text from a public HTTP(S) web page. Use offset to continue reading long pages.',
        { url: S, offset: N, max_chars: N }, ['url']));
  }
  definitions.push(tool('read_tool_history',
    'Recover full tool outputs archived from context. Omit id to list records.',
      { id: S, offset: N, limit: N, byte_offset: N, max_bytes: N }));
  if (retrieval) {
    const paging = { cursor: N, limit: N };
    definitions.push(
      tool('list_chats', 'List previous chats in the current profile and project scope.', paging),
      tool('search_chats', 'Search visible messages in previous chats. All query keywords must match.',
        { ...paging, query: S }, ['query']),
      tool('read_chat', 'Read messages from a chat returned by list_chats or search_chats.',
        { ...paging, chat_id: S, char_offset: N }, ['chat_id']));
  }
  if (skills.filesystem && skills.workspace_root) definitions.push(...fileTools());
  if (skills.terminal && skills.workspace_root) definitions.push(...terminalTools());
  if (skills.browser) definitions.push(...browserTools());
  definitions.push(tool('show_image',
    'Display a PNG, JPEG, GIF, or WebP image from a workspace path or public image URL.', { path: S, url: S }));
  if (userSkills.length) definitions.push(tool('activate_skill',
    'Read a user skill’s full instructions by name or id.', { name: S }, ['name']));
  return definitions;
}
