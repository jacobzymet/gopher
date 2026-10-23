import { assertPublicUrl, boundedText, safeFetch, type PublicFetch } from './public-fetch.js';
import { htmlToText, inlineText } from './html-text.js';
import { isSearchEngineUrl } from './search-ranking.js';

/** Fetching public web pages as readable text for fetch_url and search enrichment. */

export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,'
  + 'image/avif,image/webp,image/apng,*/*;q=0.8';
const PAGE_BYTES = 4_000_000;

export function browserHeaders(acceptLanguage = 'en-US,en;q=0.9', accept = BROWSER_ACCEPT): Record<string, string> {
  return {
    'user-agent': BROWSER_USER_AGENT, accept, 'accept-language': acceptLanguage,
    'upgrade-insecure-requests': '1',
  };
}

/** `us-en` → `en-US,en;q=0.9`; other regions also accept English as a fallback. */
export function acceptLanguage(region: string): string {
  const [country = '', language = ''] = region.trim().toLowerCase().split('-');
  if (!/^[a-z]{2}$/.test(country) || !/^[a-z]{2}$/.test(language) || country === 'wt' || language === 'wt') {
    return 'en-US,en;q=0.9';
  }
  const code = country.toUpperCase();
  if (language === 'en' && code === 'US') return 'en-US,en;q=0.9';
  return `${language}-${code},${language};q=0.9,en;q=0.5`;
}

const BINARY_EXTENSIONS = [
  '.pdf', '.zip', '.gz', '.tgz', '.rar', '.7z', '.exe', '.dmg', '.apk', '.mp3', '.mp4', '.mov',
  '.avi', '.mkv', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.css', '.js', '.mjs',
  '.woff', '.woff2', '.ttf',
];

/** fetch_url reads web pages, not downloads, media or search-engine result pages. */
export function scrapeableUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  if (isSearchEngineUrl(url)) return false;
  const path = lower.split(/[?#]/)[0]!;
  return !BINARY_EXTENSIONS.some(extension => path.endsWith(extension));
}

type BodyKind = 'html' | 'json' | 'text';

function kindFromUrl(url: string): BodyKind | undefined {
  const path = url.split(/[?#]/)[0]!.toLowerCase();
  if (path.endsWith('.json') || path.endsWith('.jsonl')) return 'json';
  if (['.md', '.markdown', '.mdown', '.txt'].some(extension => path.endsWith(extension))) return 'text';
  return undefined;
}

export function bodyKind(contentType: string, url: string): BodyKind | undefined {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (!type || type === 'application/octet-stream') return kindFromUrl(url) ?? 'html';
  if (type.includes('json')) return 'json';
  if (type.includes('markdown')) return 'text';
  if (type.includes('text/html') || type.includes('application/xhtml')) return 'html';
  if (type.startsWith('text/') || type.includes('xml')) return 'text';
  return kindFromUrl(url);
}

function prettyJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

export interface FetchedPage { url: string; title: string; contentType: string; text: string; truncated: boolean }

/** Turn a fetched body into readable text according to its type. */
export function readableBody(body: string, contentType: string, url: string): { title: string; text: string } {
  const kind = bodyKind(contentType, url);
  if (kind === 'json') return { title: '', text: prettyJson(body.trim()) };
  if (kind === 'text') return { title: '', text: body.replace(/\u0000/g, '').trim() };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  return { title: title ? inlineText(title[1]!).slice(0, 300) : '', text: htmlToText(body) };
}

function status(error: unknown): number | undefined {
  const value = (error as { status?: unknown })?.status;
  return typeof value === 'number' ? value : undefined;
}

/** Fetch a public page; some news stacks reject the first request, so 403/406 retries once with a looser Accept. */
export async function fetchPublicUrl(raw: string, signal: AbortSignal, maxChars = 16_000,
  request: PublicFetch = safeFetch): Promise<FetchedPage> {
  if (!scrapeableUrl(raw)) throw new Error('fetch_url only reads web pages, not files such as PDFs, images or archives.');
  let response: Response;
  try {
    response = await request(raw, signal, { headers: browserHeaders() });
  } catch (error) {
    if (![403, 406].includes(status(error) ?? 0)) throw error;
    response = await request(raw, signal, { headers: browserHeaders(undefined, '*/*') });
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!bodyKind(contentType, raw)) {
    await response.body?.cancel();
    throw new Error(`URL returned unsupported content type: ${contentType || 'unknown'}`);
  }
  const body = await boundedText(response, PAGE_BYTES);
  const { title, text } = readableBody(body, contentType, response.url || raw);
  return {
    url: response.url || (await assertPublicUrl(raw, false)).toString(),
    title, contentType, text: text.slice(0, maxChars), truncated: text.length > maxChars,
  };
}

/** Per-turn cache so search enrichment and fetch_url never download the same page twice. */
export class PageCache {
  private entries = new Map<string, Promise<FetchedPage>>();
  async read(raw: string, fetcher: () => Promise<FetchedPage>): Promise<FetchedPage> {
    const url = new URL(raw);
    url.hash = '';
    const key = url.toString();
    let pending = this.entries.get(key);
    if (pending) this.entries.delete(key);
    else {
      pending = fetcher();
      pending.catch(() => { if (this.entries.get(key) === pending) this.entries.delete(key); });
    }
    this.entries.set(key, pending);
    while (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value!);
    return pending;
  }
  clear(): void { this.entries.clear(); }
}
