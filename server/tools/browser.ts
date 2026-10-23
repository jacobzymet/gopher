import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { Workspace } from './workspace.js';
import { defaultDataDirectory } from '../config.js';
import { abortable } from './abort.js';

/**
 * A headless browser per conversation for the browser_* tools. Operations on one session run in
 * order; cancelling a turn closes its browser; a crashed page is replaced on the next call.
 */

export interface BrowserResult { text: string; image?: string; image_id?: string }
interface BrowserSession { browser: Browser; context: BrowserContext; page: Page; tail: Promise<unknown>; touched: number }
type Args = Record<string, unknown>;

const MAX_SESSIONS = 16;
const LAUNCH_TIMEOUT_MS = 40_000;
const ACTION_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const MAX_WAIT_MS = 30_000;
const MAX_TEXT_CHARS = 8000;
const MAX_RESULT_CHARS = 32_000;
const MAX_INLINE_SCREENSHOT = 1_500_000;
const VIEWPORT = { width: 1440, height: 1000 };

export function httpUrl(raw: unknown): string {
  const url = new URL(String(raw));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an absolute HTTP(S) URL without embedded credentials');
  }
  return url.toString();
}

export async function findBrowserExecutable(): Promise<string | undefined> {
  const env = process.env;
  const platform = process.platform === 'win32' ? [
    path.join(env.PROGRAMFILES || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  const candidates = [env.GOPHER_BROWSER_PATH, env.CHROME_PATH, env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, ...platform].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch { /* Try the next candidate. */ }
  }
  return undefined;
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || Array.from(value).length > MAX_TEXT_CHARS) throw new Error(`Browser ${label} must contain at most 8000 characters`);
  return value;
}

/**
 * Visible text and numbered interactive elements; refs are written into the page for later clicks.
 * The callback runs inside the page, so it must not define named functions: transpilers wrap
 * those in helpers that do not exist there.
 */
async function snapshot(page: Page): Promise<string> {
  const content = await page.evaluate(() => {
    document.querySelectorAll('[data-gopher-ref]').forEach(element => element.removeAttribute('data-gopher-ref'));
    const selector = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable="true"]';
    const elements = Array.from(document.querySelectorAll(selector)).filter(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }).slice(0, 180);
    const refs = elements.map((element, index) => {
      const ref = `e${index + 1}`;
      element.setAttribute('data-gopher-ref', ref);
      const input = element as HTMLInputElement;
      const name = (element.getAttribute('aria-label') || element.textContent || input.placeholder || input.name || '').trim().replace(/\s+/g, ' ').slice(0, 160);
      return {
        ref, role: element.getAttribute('role') || element.tagName.toLowerCase(), name, type: input.type || undefined,
        value: input.type === 'password' ? '[hidden]' : input.value?.slice(0, 200), href: element.getAttribute('href') || undefined,
        disabled: input.disabled || undefined,
      };
    });
    return { title: document.title, text: document.body?.innerText.slice(0, 22_000) || '', elements: refs };
  });
  return JSON.stringify({ url: page.url(), ...content });
}

async function screenshot(page: Page, workspace: string, args: Args, signal?: AbortSignal): Promise<BrowserResult> {
  const bytes = await page.screenshot({ type: 'png', fullPage: false });
  const name = `browser-${Date.now()}.png`;
  const saved = workspace ? await (await Workspace.open(workspace)).resolve(args.path || `screenshots/${name}`)
    : path.join(defaultDataDirectory(), 'browser-screenshots', name);
  signal?.throwIfAborted();
  await fs.mkdir(path.dirname(saved), { recursive: true });
  signal?.throwIfAborted();
  await fs.writeFile(saved, bytes, { mode: 0o600, signal });
  const inline = bytes.length <= MAX_INLINE_SCREENSHOT ? { image: `data:image/png;base64,${bytes.toString('base64')}` } : {};
  return { text: JSON.stringify({ url: page.url(), path: saved, bytes: bytes.length }), ...inline };
}

/** One browser action; most return a fresh snapshot of the page afterwards. */
async function act(page: Page, name: string, workspace: string, args: Args, signal?: AbortSignal): Promise<BrowserResult> {
  const locator = () => {
    if (typeof args.ref !== 'string' || !/^e\d+$/.test(args.ref)) {
      throw new Error('Use an element ref from the latest browser snapshot');
    }
    return page.locator(`[data-gopher-ref="${args.ref}"]`).first();
  };
  if (name === 'browser_navigate') await page.goto(httpUrl(args.url), { waitUntil: 'domcontentloaded' });
  else if (name === 'browser_click') await locator().click();
  else if (name === 'browser_type') {
    await locator().fill(boundedText(args.text, 'text'));
    signal?.throwIfAborted();
    if (args.submit) await locator().press('Enter');
  } else if (name === 'browser_select') await locator().selectOption(String(args.value));
  else if (name === 'browser_press') {
    if (typeof args.key !== 'string' || args.key.length > 80) throw new Error('Invalid browser key');
    if (args.ref) await locator().press(args.key); else await page.keyboard.press(args.key);
  } else if (name === 'browser_wait') {
    if (args.selector) await page.locator(String(args.selector)).first().waitFor({ state: 'visible', timeout: Math.min(MAX_WAIT_MS, Number(args.time_ms) || 15_000) });
    else await page.waitForTimeout(Math.max(50, Math.min(MAX_WAIT_MS, Number(args.time_ms || args.milliseconds) || 1000)));
  } else if (name === 'browser_evaluate') {
    const value: unknown = await page.evaluate(boundedText(args.expression, 'expression'));
    return { text: JSON.stringify({ url: page.url(), result: value }).slice(0, MAX_RESULT_CHARS) };
  } else if (name === 'browser_screenshot') return screenshot(page, workspace, args, signal);
  else if (name !== 'browser_snapshot') throw new Error(`Unknown browser tool: ${name}`);
  signal?.throwIfAborted();
  return { text: await snapshot(page) };
}

export class BrowserManager {
  private sessions = new Map<string, Promise<BrowserSession>>();

  private launch(id: string, signal?: AbortSignal): Promise<BrowserSession> {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('Too many browser sessions; close one before continuing');
    const pending: Promise<BrowserSession> = (async () => {
      const executablePath = await findBrowserExecutable();
      signal?.throwIfAborted();
      const browser = await chromium.launch({ executablePath, headless: true, timeout: LAUNCH_TIMEOUT_MS });
      browser.on('disconnected', () => { if (this.sessions.get(id) === pending) this.sessions.delete(id); });
      try {
        signal?.throwIfAborted();
        const context = await browser.newContext({ viewport: VIEWPORT });
        signal?.throwIfAborted();
        const page = await context.newPage();
        signal?.throwIfAborted();
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
        return { browser, context, page, tail: Promise.resolve(), touched: Date.now() };
      } catch (error) { await browser.close().catch(() => {}); throw error; }
    })();
    this.sessions.set(id, pending);
    pending.catch(() => { if (this.sessions.get(id) === pending) this.sessions.delete(id); });
    return pending;
  }

  /** The conversation's session; a closed (crashed) page or a disconnected browser is replaced. */
  private async session(id: string, signal?: AbortSignal): Promise<BrowserSession> {
    const pending = this.sessions.get(id);
    if (!pending) return this.launch(id, signal);
    const session = await pending;
    if (!session.page.isClosed() && session.browser.isConnected()) return session;
    if (this.sessions.get(id) === pending) this.sessions.delete(id);
    await session.browser.close().catch(() => {});
    return this.launch(id, signal);
  }

  async execute(id: string, workspace: string, name: string, args: Args, signal?: AbortSignal): Promise<BrowserResult> {
    signal?.throwIfAborted();
    if (name === 'browser_close') { await this.close(id); return { text: 'Browser closed' }; }
    const session = await abortable(this.session(id, signal), signal);
    signal?.throwIfAborted();
    const expected = this.sessions.get(id);
    let closing: Promise<void> | undefined;
    const operation = session.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      session.touched = Date.now();
      // Cancelling mid-action closes the browser, which is the only reliable way to stop Playwright.
      const abort = () => {
        if (this.sessions.get(id) === expected) this.sessions.delete(id);
        closing ??= session.browser.close().catch(() => {});
      };
      signal?.addEventListener('abort', abort, { once: true });
      try { return await act(session.page, name, workspace, args, signal); }
      finally { signal?.removeEventListener('abort', abort); }
    });
    session.tail = operation;
    try { return await abortable(operation, signal); } finally { if (closing) await closing; }
  }

  async close(id: string): Promise<void> {
    const pending = this.sessions.get(id);
    this.sessions.delete(id);
    if (!pending) return;
    try {
      const session = await pending;
      await session.context.close();
      await session.browser.close();
    } catch { /* A browser that failed to launch or already exited has nothing left to close. */ }
  }

  async closeAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map(id => this.close(id))); }
}

export const browsers = new BrowserManager();
