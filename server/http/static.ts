import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { frontendPrompts } from '../prompts.js';
import { HttpError } from './protocol.js';

/** The browser client: its page for every app route, its bundles and vendored libraries. */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/png', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.gz': 'application/gzip', '.json': 'application/json',
};
const VENDOR: Record<string, string> = {
  '/marked.min.js': 'marked.min.js', '/purify.min.js': 'purify.min.js', '/highlight.min.js': 'highlight.min.js',
  '/katex.min.js': 'katex/katex.min.js', '/katex.min.css': 'katex/katex.min.css', '/xterm.min.js': 'xterm.min.js',
  '/xterm-addon-fit.min.js': 'xterm-addon-fit.min.js', '/xterm.css': 'xterm.css',
};
const BUNDLES = ['/chat.js', '/chat.css', '/orb.js', '/optional-fonts.js'];
const ICONS = ['/browser-favicon.png', '/favicon.ico', '/ti.png'];
/** Client-side routes: home, notifications, projects, ghost, loops, bots, a chat, a project. */
const APP_PAGE = new RegExp('^/(?:$|notifications$|projects$|ghost$|loops(?:/c/[^/]+)?$|bots(?:/c/[^/]+)?$'
  + '|c/[^/]+$|p/[^/]+(?:/ghost)?$)');

export interface StaticOptions { publicDir: string; promptRoot: string; token: string; locked: boolean }

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(307, { location });
  response.end();
}

/** Resolve a vendored asset, refusing anything that would leave the vendor directory. */
function vendorFile(publicDir: string, path: string): string {
  const root = resolve(join(publicDir, 'vendor'));
  const file = resolve(root, VENDOR[path] || path.slice(1));
  if (!file.startsWith(root + sep)) throw new HttpError(404, 'Asset not found.');
  return file;
}

export async function serveStatic(response: ServerResponse, path: string, method: string,
  options: StaticOptions): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  // The page sets the session cookie; API requests must present it (or the token header).
  response.setHeader('set-cookie', `gopher_session=${options.token}; HttpOnly; SameSite=Strict; Path=/`);
  if (path === '/settings' || path === '/admin') return redirect(response, '/?settings=providers');
  if (path === '/chat') return redirect(response, '/');
  if (path === '/prompts.js') {
    response.writeHead(200, { 'content-type': MIME['.js']! });
    response.end(await frontendPrompts(options.promptRoot));
    return;
  }
  let file: string;
  const vendored = VENDOR[path] || path.startsWith('/katex/fonts/') || path.startsWith('/ocr/');
  if (vendored) file = vendorFile(options.publicDir, path);
  else if (BUNDLES.includes(path)) file = join(options.publicDir, path.slice(1));
  else if (ICONS.includes(path)) file = join(options.publicDir, 'browser-favicon.png');
  else if (APP_PAGE.test(path)) {
    // Deep links reveal which chats or projects exist, so a locked session only serves the root.
    if (options.locked && path !== '/') return redirect(response, '/');
    file = join(options.publicDir, 'chat.html');
  } else throw new HttpError(404, 'Page not found.');
  let content = await readFile(file);
  if (options.locked && APP_PAGE.test(path)) {
    // Cover and disable the workspace before scripts or decrypted preferences load.
    content = Buffer.from(content.toString('utf8')
      .replace('<html lang="en">', '<html lang="en" data-session-locked="true">')
      .replace('id="chatShell"', 'id="chatShell" inert aria-hidden="true"'));
  }
  response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  response.end(method === 'HEAD' ? undefined : content);
}
