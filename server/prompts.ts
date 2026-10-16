import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const chatPrompts = ['base', 'today', 'user-name', 'user-about', 'global-instructions', 'project-instructions', 'global-memory', 'project-memory', 'project-memory-scope-project-only', 'project-memory-scope-default', 'bot-identity', 'bot-memory', 'bot-group', 'bot-group-memory', 'bot-dm', 'bot-hold', 'bot-compact', 'bot-compact-group'];
export async function frontendPrompts(root: string): Promise<string> {
  const entries = await Promise.all(chatPrompts.map(async name => [
    `chat.${name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`,
    (await readFile(join(root, 'chat', `${name}.md`), 'utf8')).trimEnd(),
  ]));
  return `window.GOPHER_PROMPTS=${JSON.stringify(Object.fromEntries(entries))};\nwindow.fillPrompt=function(template,vars){vars=vars||{};return String(template||'').replace(/\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g,function(_,key){return Object.prototype.hasOwnProperty.call(vars,key)?String(vars[key]):''})};`;
}
