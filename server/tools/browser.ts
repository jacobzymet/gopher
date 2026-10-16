import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { Workspace } from './filesystem.js';
import { defaultDataDirectory } from '../config.js';
import { abortable } from './abort.js';

export interface BrowserResult { text: string; image?: string; image_id?: string }
interface BrowserSession { browser: Browser; context: BrowserContext; page: Page; tail: Promise<unknown>; touched: number }
export function httpUrl(raw: string): string { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an absolute HTTP(S) URL without embedded credentials'); return url.toString(); }
export async function findBrowserExecutable(): Promise<string | undefined> {
  const env = process.env;
  const candidates = [env.GOPHER_BROWSER_PATH, env.CHROME_PATH, env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, ...(process.platform === 'win32' ? [path.join(env.PROGRAMFILES || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'), path.join(env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'), path.join(env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'])].filter(Boolean) as string[];
  for (const candidate of candidates) try { await fs.access(candidate); return candidate; } catch {}
  return undefined;
}
export class BrowserManager {
  private sessions = new Map<string, Promise<BrowserSession>>();
  private async session(id: string, signal?: AbortSignal): Promise<BrowserSession> {
    let pending = this.sessions.get(id);
    if (!pending) {
      if (this.sessions.size >= 16) throw new Error('Too many browser sessions; close one before continuing');
      pending = (async () => {
        const executablePath = await findBrowserExecutable(); signal?.throwIfAborted();
        const browser = await chromium.launch({ executablePath, headless: true, timeout: 40_000 });
        browser.on('disconnected',()=>{if(this.sessions.get(id)===pending)this.sessions.delete(id);});
        try {
          signal?.throwIfAborted(); const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); signal?.throwIfAborted();
          const page = await context.newPage(); signal?.throwIfAborted(); page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(45_000);
          return { browser, context, page, tail: Promise.resolve(), touched: Date.now() };
        } catch (error) { await browser.close().catch(() => {}); throw error; }
      })();
      this.sessions.set(id, pending); pending.catch(() => { if (this.sessions.get(id) === pending) this.sessions.delete(id); });
    }
    return pending;
  }
  async execute(id: string, workspace: string, name: string, args: any, signal?: AbortSignal): Promise<BrowserResult> {
    signal?.throwIfAborted();
    if (name === 'browser_close') { await this.close(id); return { text: 'Browser closed' }; }
    const session = await abortable(this.session(id, signal), signal); signal?.throwIfAborted();
    const expected = this.sessions.get(id);
    let closing: Promise<void> | undefined;
    const operation = session.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted(); session.touched = Date.now(); const page = session.page;
      const abort = () => { if (this.sessions.get(id) === expected) this.sessions.delete(id); closing ??= session.browser.close().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
      const locator = () => { if (!/^e\d+$/.test(args.ref || '')) throw new Error('Use an element ref from the latest browser snapshot'); return page.locator(`[data-gopher-ref="${args.ref}"]`).first(); };
      if (name === 'browser_navigate') { await page.goto(httpUrl(args.url), { waitUntil: 'domcontentloaded' }); }
      else if (name === 'browser_click') await locator().click();
      else if (name === 'browser_type') {if(typeof args.text!=='string'||Array.from(args.text).length>8000)throw new Error('Browser text must contain at most 8000 characters'); await locator().fill(args.text); signal?.throwIfAborted(); if (args.submit) await locator().press('Enter'); }
      else if (name === 'browser_select') await locator().selectOption(String(args.value));
      else if (name === 'browser_press') { if (typeof args.key !== 'string' || args.key.length > 80) throw new Error('Invalid browser key'); if (args.ref) await locator().press(args.key); else await page.keyboard.press(args.key); }
      else if (name === 'browser_wait') { if (args.selector) await page.locator(args.selector).first().waitFor({ state: 'visible', timeout: Math.min(30_000, Number(args.time_ms) || 15_000) }); else await page.waitForTimeout(Math.max(50, Math.min(30_000, Number(args.time_ms || args.milliseconds) || 1000))); }
      else if (name === 'browser_evaluate') { if (typeof args.expression !== 'string' || Array.from(args.expression).length > 8000) throw new Error('Browser expression must contain at most 8000 characters'); const value = await page.evaluate(args.expression); return { text: JSON.stringify({ url: page.url(), result: value }).slice(0, 32_000) }; }
      else if (name === 'browser_screenshot') {
        const bytes = await page.screenshot({ type: 'png', fullPage: false }); let saved: string | undefined;
        if (workspace) { const ws = await Workspace.open(workspace); saved = await ws.resolve(args.path || `screenshots/browser-${Date.now()}.png`); }else saved=path.join(defaultDataDirectory(),'browser-screenshots',`browser-${Date.now()}.png`);signal?.throwIfAborted();await fs.mkdir(path.dirname(saved),{recursive:true});signal?.throwIfAborted();await fs.writeFile(saved,bytes,{mode:0o600,signal});
        return { text: JSON.stringify({ url: page.url(), path: saved, bytes: bytes.length }), ...(bytes.length<=1_500_000?{image:`data:image/png;base64,${bytes.toString('base64')}`}:{}) };
      } else if (name !== 'browser_snapshot') throw new Error(`Unknown browser tool: ${name}`);
      signal?.throwIfAborted(); return { text: await this.snapshot(page) };
      } finally { signal?.removeEventListener('abort', abort); }
    });
    session.tail = operation;
    try { return await abortable(operation, signal); } finally { if (closing) await closing; }
  }
  private async snapshot(page: Page): Promise<string> {
    const snapshot = await page.evaluate(() => {
      document.querySelectorAll('[data-gopher-ref]').forEach(el => el.removeAttribute('data-gopher-ref'));
      const elements = Array.from(document.querySelectorAll('a,button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable="true"]')).filter(el => { const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; }).slice(0, 180);
      const refs = elements.map((el, index) => { const ref = `e${index + 1}`; el.setAttribute('data-gopher-ref', ref); const input = el as HTMLInputElement; return { ref, role: el.getAttribute('role') || el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') || el.textContent || input.placeholder || input.name || '').trim().replace(/\s+/g, ' ').slice(0, 160), type: input.type || undefined, value: input.type === 'password' ? '[hidden]' : input.value?.slice(0, 200), href: el.getAttribute('href') || undefined, disabled: input.disabled || undefined }; });
      return { title: document.title, text: document.body?.innerText.slice(0, 22_000) || '', elements: refs };
    });
    return JSON.stringify({ url: page.url(), ...snapshot });
  }
  async close(id: string): Promise<void> { const pending = this.sessions.get(id); this.sessions.delete(id); if (pending) try { const session = await pending; await session.context.close(); await session.browser.close(); } catch {} }
  async closeAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map(id => this.close(id))); }
}
export const browsers = new BrowserManager();
