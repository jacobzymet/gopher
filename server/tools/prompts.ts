import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillsCatalog, type UserSkill } from '../skills.js';
import type { ToolDefinition } from '../providers.js';
import type { AgentSkills } from './index.js';

/**
 * The packaged prompt files (prompts/agent, prompts/tools, prompts/title). They are loaded once,
 * then the agent system prompt and tool descriptions are assembled for the enabled capabilities.
 */

type Variables = Record<string, unknown>;
const GROUPS = ['agent', 'tools', 'title'];
let loaded: Promise<Map<string, string>> | undefined;

async function loadFrom(root: string): Promise<Map<string, string>> {
  const files = await Promise.all(GROUPS.map(async group => (await readdir(join(root, group)))
    .filter(file => file.endsWith('.md')).map(file => ({ key: `${group}.${file.slice(0, -3)}`, file: join(root, group, file) }))));
  const entries = await Promise.all(files.flat().map(async item => [item.key, (await readFile(item.file, 'utf8')).trim()] as const));
  return new Map(entries);
}

/** Prompts from GOPHER_PROMPTS_DIR, or the prompts folder of the build or source tree. */
function promptLibrary(): Promise<Map<string, string>> {
  loaded ??= (async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.GOPHER_PROMPTS_DIR, resolve(directory, '../prompts'), resolve(directory, '../../prompts'),
      resolve(directory, '../../../prompts'), resolve(process.cwd(), 'prompts'),
    ].filter((value): value is string => Boolean(value));
    for (const root of candidates) {
      try { return await loadFrom(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    throw new Error('The agent prompt library is missing. Rebuild Gopher with the prompts directory included.');
  })();
  return loaded;
}

/** Replace `{{name}}` placeholders; missing values become empty. */
export function fillPrompt(template: string, variables: Variables = {}): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => String(variables[key] ?? ''));
}

export async function promptText(key: string, variables: Variables = {}): Promise<string> {
  const text = (await promptLibrary()).get(key);
  if (text === undefined) throw new Error(`Missing packaged prompt: ${key}`);
  return fillPrompt(text, variables);
}

/** Pages read and characters per page for each web search depth; `off` reads none. */
const SEARCH_PLANS: Record<string, [number, number]> = { deep: [6, 4800], standard: [4, 3200], auto: [3, 2800], light: [2, 1600] };

function webSearchSection(p: (key: string, variables?: Variables) => string, skills: AgentSkills): string {
  const depth = String(skills.web_search_depth || 'off');
  const plan = SEARCH_PLANS[depth];
  const depthNote = plan
    ? p('web-search-depth-on', { pages: plan[0], chars: skills.web_search_page_max_chars || plan[1], depth })
    : p('web-search-depth-off');
  const recency = skills.web_search_recency && skills.web_search_recency !== 'any' ? `past ${skills.web_search_recency}` : 'any date';
  const section = p('web-search', {
    region: skills.web_search_region || 'us-en', safesearch: skills.web_search_safesearch || 'moderate', recency,
    max_results: skills.web_search_max_results || 6, depth_note: depthNote,
  });
  return section + (skills.fetch_url ? ` ${p('web-search-follow-fetch')}` : '');
}

/** The agent system prompt: core rules, then one section per enabled capability. */
export async function agentPrompt(skills: AgentSkills, userSkills: UserSkill[], deep: boolean, brief: boolean,
  forceTools: string[], retrieval: boolean): Promise<string> {
  const library = await promptLibrary();
  const p = (key: string, variables?: Variables) => fillPrompt(library.get(`agent.${key}`) || '', variables);
  const lines = [p(deep ? 'intro-deep-research' : 'intro'), p('core'), p('steer'), p('images')];
  lines.push(forceTools.length ? p('required-tools', { tools: forceTools.join(', ') }) : p(deep ? 'policy-deep-research' : 'policy-optional'));
  if (skills.web_search) lines.push(webSearchSection(p, skills));
  if (skills.fetch_url) {
    const fetch = p('fetch-url', { max_chars: skills.fetch_url_max_chars || 8000 });
    lines.push(`${fetch} ${p(skills.web_search ? 'fetch-url-with-search' : 'fetch-url-alone')}`);
  }
  if (skills.web_search || skills.fetch_url) lines.push(p('citations'));
  if (retrieval) lines.push(p('chat-retrieval'));
  if (skills.filesystem) {
    lines.push(skills.workspace_root ? p('filesystem', { workspace: `Workspace folder: ${skills.workspace_root}.` }) : p('filesystem-no-workspace'));
  }
  if (skills.terminal) {
    const timeout = Math.max(1, Math.min(120, Number(skills.terminal_timeout_secs) || 30));
    lines.push(skills.workspace_root ? p('terminal', { timeout }) : p('terminal-no-workspace'));
  }
  if (skills.browser) lines.push(p('browser'));
  if (userSkills.length) lines.push(p('skills-activate'), skillsCatalog(userSkills));
  if (deep) lines.push(p('deep-research', { output_line: p(brief ? 'deep-research-output-brief' : 'deep-research-output-long') }));
  return lines.filter(Boolean).join('\n');
}

const SHELL_CONTEXT = process.platform === 'win32'
  ? 'Shell: PowerShell. Use PowerShell syntax and native path handling.'
  : 'Shell: the user’s system shell. Use shell syntax appropriate to this platform.';

/** Replace tool descriptions with their packaged prompt text where one exists. */
export async function applyToolDescriptions(definitions: ToolDefinition[], skills: AgentSkills, deep: boolean): Promise<void> {
  const library = await promptLibrary();
  for (const definition of definitions) {
    const name = definition.function.name;
    let key = name.replace(/_/g, '-');
    if (name === 'web_search' && deep) key = 'web-search-deep';
    if (name === 'fetch_url') key = skills.web_search ? 'fetch-url-with-search' : 'fetch-url';
    const source = library.get(`tools.${key}`);
    if (source) definition.function.description = fillPrompt(source, { max_chars: skills.fetch_url_max_chars || 8000, shell_context: SHELL_CONTEXT });
  }
}
