import { assertPublicUrl, boundedText, jsonBody, safeFetch } from './public-fetch.js';
import { decodeEntities, inlineText } from './html-text.js';
import { acceptLanguage, browserHeaders } from './page-fetch.js';
import { rejectResultUrl, type SearchResult, type SourcedResults } from './search-ranking.js';
import { describeNetworkError } from '../network-errors.js';

/** Individual web search backends. Each returns filtered results tagged with its source name. */

export interface EngineSettings {
  searchResultCount: number;
  searchRegion: string;
  searchSafeSearch: 'strict' | 'moderate' | 'off';
  searchRecency: 'any' | 'day' | 'week' | 'month' | 'year';
  searxngUrl: string;
  parallelMode: 'turbo' | 'fast' | 'basic' | 'advanced';
}
interface RawResult {
  title?: string | null; url?: string | null; snippet?: string; excerpts?: unknown; site_name?: string; date?: string;
}

/** Keep public, useful results only, joining any metadata into the snippet. */
export async function cleanResults(items: RawResult[], limit: number): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  for (const item of items) {
    if (results.length >= limit) break;
    const url = item.url?.trim();
    if (!url || rejectResultUrl(url)) continue;
    try { await assertPublicUrl(url, false); } catch { continue; }
    const excerpts = Array.isArray(item.excerpts)
      ? item.excerpts.filter((value): value is string => typeof value === 'string').join(' … ')
      : '';
    const parts = [item.date, item.site_name, item.snippet || excerpts].filter(Boolean);
    results.push({ title: item.title?.trim() || url, url, snippet: parts.join(' · ').slice(0, 1_200) });
  }
  return results;
}

// ---------------------------------------------------------------- DuckDuckGo

const DDG_HTML = 'https://html.duckduckgo.com/html/';
const DDG_LITE = 'https://lite.duckduckgo.com/lite/';

export function isDuckDuckGoChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  return ['anomaly.js', 'please complete the captcha', 'unfortunately, bots use duckduckgo',
    'select all squares containing a duck', 'error-lite+'].some(marker => lower.includes(marker));
}

function unwrapBing(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host !== 'bing.com' && !host.endsWith('.bing.com')) return url;
    const raw = parsed.searchParams.get('u');
    if (!raw) return url;
    const payload = raw.replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/');
    const text = Buffer.from(payload, 'base64').toString('utf8').trim();
    return /^https?:\/\//.test(text) ? text : url;
  } catch { return url; }
}

/** DuckDuckGo wraps destinations in `/l/?uddg=` redirects, sometimes around Bing click trackers. */
export function decodeResultHref(href: string): string {
  const value = decodeEntities(href);
  const full = value.startsWith('//') ? `https:${value}` : value;
  try {
    const url = new URL(full, 'https://duckduckgo.com');
    for (const key of ['uddg', 'uddg3']) {
      const destination = url.searchParams.get(key);
      if (destination && /^https?:\/\//.test(destination)) return unwrapBing(destination);
    }
    return unwrapBing(url.toString());
  } catch { return ''; }
}

/** Parse result links of the given class and the snippet that follows each link. */
export function parseDuckDuckGo(html: string, linkClass: string, snippetClass: string): RawResult[] {
  const anchor = new RegExp(`<a\\b(?=[^>]*class=["'][^"']*\\b${linkClass}\\b)[^>]*>([\\s\\S]*?)</a>`, 'gi');
  const snippet = new RegExp(`class=["'][^"']*\\b${snippetClass}\\b[^"']*["'][^>]*>([\\s\\S]*?)</(?:a|td|div)>`, 'i');
  const results: RawResult[] = [];
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html))) {
    const href = /href=["']([^"']+)["']/i.exec(match[0])?.[1];
    if (!href) continue;
    const window = html.slice(anchor.lastIndex, anchor.lastIndex + 1600);
    const nextLink = window.search(new RegExp(`class=["'][^"']*\\b${linkClass}\\b`, 'i'));
    const text = snippet.exec(nextLink < 0 ? window : window.slice(0, nextLink))?.[1] ?? '';
    results.push({ title: inlineText(match[1]!), url: decodeResultHref(href), snippet: inlineText(text) });
  }
  return results;
}

function duckDuckGoParams(query: string, settings: EngineSettings): URLSearchParams {
  const params = new URLSearchParams({ q: query, kl: settings.searchRegion || 'us-en' });
  params.set('kp', settings.searchSafeSearch === 'strict' ? '1' : settings.searchSafeSearch === 'off' ? '-2' : '-1');
  const recency = { day: 'd', week: 'w', month: 'm', year: 'y' } as const;
  if (settings.searchRecency !== 'any') params.set('df', recency[settings.searchRecency]);
  return params;
}

async function duckDuckGoPage(url: string, init: RequestInit, signal: AbortSignal): Promise<string> {
  const html = await boundedText(await safeFetch(url, signal, init));
  if (isDuckDuckGoChallenge(html)) throw new Error('DuckDuckGo challenged the search (captcha)');
  return html;
}

/** Query DuckDuckGo HTML (GET and POST) and Lite together; any endpoint that answers contributes. */
export async function duckDuckGo(query: string, settings: EngineSettings, signal: AbortSignal): Promise<SourcedResults[]> {
  const params = duckDuckGoParams(query, settings);
  const headers = browserHeaders(acceptLanguage(settings.searchRegion));
  const limit = settings.searchResultCount;
  const form = new URLSearchParams(params);
  form.set('b', '');
  const attempts: Array<[string, Promise<RawResult[]>]> = [
    ['duckduckgo-lite', duckDuckGoPage(`${DDG_LITE}?${params}`, { headers: { ...headers, referer: DDG_LITE } }, signal)
      .then(html => parseDuckDuckGo(html, 'result-link', 'result-snippet'))],
    ['duckduckgo', duckDuckGoPage(`${DDG_HTML}?${params}`, { headers: { ...headers, referer: DDG_HTML } }, signal)
      .then(html => parseDuckDuckGo(html, 'result__a', 'result__snippet'))],
    ['duckduckgo-post', duckDuckGoPage(DDG_HTML, {
      method: 'POST', body: form.toString(),
      headers: { ...headers, referer: DDG_HTML, 'content-type': 'application/x-www-form-urlencoded' },
    }, signal).then(html => parseDuckDuckGo(html, 'result__a', 'result__snippet'))],
  ];
  const settled = await Promise.allSettled(attempts.map(([, pending]) => pending));
  signal.throwIfAborted();
  const sources: SourcedResults[] = [];
  const errors: string[] = [];
  for (const [index, outcome] of settled.entries()) {
    const source = attempts[index]![0];
    if (outcome.status === 'rejected') {
      errors.push(`${source}: ${describeNetworkError(outcome.reason)}`);
      continue;
    }
    const results = await cleanResults(outcome.value, limit * 2);
    if (results.length) sources.push({ source, results });
  }
  if (!sources.length && errors.length) throw new Error(errors.join('; '));
  return sources;
}

// ---------------------------------------------------------------- SearXNG

export function searxngEndpoint(raw: string): URL {
  const value = raw.trim();
  if (!value) throw new Error('SearXNG is selected but no instance URL is configured in Settings');
  if (value.length > 300) throw new Error('SearXNG URL is too long');
  const local = /^(localhost|127\.|\[::1\])/.test(value);
  const url = new URL(value.includes('://') ? value : local ? `http://${value}` : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('SearXNG URL must use HTTP(S) without credentials');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  if (!url.pathname.endsWith('/search')) url.pathname += '/search';
  url.search = '';
  url.hash = '';
  return url;
}

/**
 * SearXNG is a user-chosen (often local) instance, so it is requested directly
 * rather than through the public-only fetch. JSON is tried first, then HTML.
 */
export async function searxng(query: string, settings: EngineSettings, signal: AbortSignal): Promise<SourcedResults[]> {
  const url = searxngEndpoint(settings.searxngUrl);
  const region = settings.searchRegion.toLowerCase().split('-');
  const language = /^[a-z]{2}$/.test(region[1] || '') ? `${region[1]}-${region[0]!.toUpperCase()}` : 'en-US';
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', language);
  const safe = settings.searchSafeSearch === 'strict' ? '2' : settings.searchSafeSearch === 'off' ? '0' : '1';
  url.searchParams.set('safesearch', safe);
  if (settings.searchRecency !== 'any') url.searchParams.set('time_range', settings.searchRecency);
  const request = async () => {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Gopher/1.0' }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
    return response;
  };
  const limit = settings.searchResultCount;
  try {
    type Body = { results?: Array<{ title?: string; url?: string; content?: string }> };
    const body = await jsonBody<Body>(await request());
    const results = await cleanResults((body.results ?? []).map(item => ({ ...item, snippet: item.content })), limit * 2);
    if (results.length) return [{ source: 'searxng', results }];
  } catch (error) { if (signal.aborted) throw error; }
  url.searchParams.delete('format');
  const html = await boundedText(await request());
  const entries = [...html.matchAll(/<h[234][^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const results = await cleanResults(entries.map(entry => ({ url: decodeEntities(entry[1]!), title: inlineText(entry[2]!) })), limit * 2);
  return results.length ? [{ source: 'searxng', results }] : [];
}

// ---------------------------------------------------------------- Parallel and TinyFish

function regionCountry(region: string): string | undefined {
  const country = region.trim().toLowerCase().split('-')[0]!;
  return /^[a-z]{2}$/.test(country) && country !== 'wt' ? country : undefined;
}
function recencyDays(recency: EngineSettings['searchRecency']): number | undefined {
  return recency === 'any' ? undefined : { day: 1, week: 7, month: 30, year: 365 }[recency];
}
function mcpJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  for (const line of trimmed.split(/\r?\n/)) {
    const data = line.trim().replace(/^data:\s*/, '');
    if (data.startsWith('{')) return data;
  }
  throw new Error('Parallel MCP response had no JSON payload');
}
type ParallelBody = { results?: Array<{ title?: string | null; url?: string; excerpts?: string[] }> };

async function parallelMcp(query: string, settings: EngineSettings, signal: AbortSignal): Promise<SearchResult[]> {
  const endpoint = 'https://search.parallel.ai/mcp';
  const common = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const initialize = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gopher', version: '0.1.0' } },
  };
  const initialized = await safeFetch(endpoint, signal, { method: 'POST', headers: common, body: JSON.stringify(initialize) });
  const sessionId = initialized.headers.get('mcp-session-id');
  await boundedText(initialized);
  if (!sessionId) throw new Error('Parallel MCP did not return a session identifier');
  const headers = { ...common, 'Mcp-Session-Id': sessionId };
  try {
    const notice = { jsonrpc: '2.0', method: 'notifications/initialized' };
    await boundedText(await safeFetch(endpoint, signal, { method: 'POST', headers, body: JSON.stringify(notice) }));
    const call = {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'web_search', arguments: { objective: query, search_queries: [query] } },
    };
    const response = await safeFetch(endpoint, signal, { method: 'POST', headers, body: JSON.stringify(call) });
    type Envelope = { error?: { message?: string }; result?: { content?: Array<{ type?: string; text?: string }> } };
    const envelope = JSON.parse(mcpJsonPayload(await boundedText(response))) as Envelope;
    if (envelope.error?.message) throw new Error(`Parallel MCP: ${envelope.error.message.slice(0, 240)}`);
    const text = envelope.result?.content?.find(item => item.type === 'text' && item.text)?.text;
    if (!text) throw new Error('Parallel MCP result did not include search data');
    return await cleanResults((JSON.parse(text) as ParallelBody).results ?? [], settings.searchResultCount);
  } finally {
    const close = { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } };
    try { await boundedText(await safeFetch(endpoint, signal, close)); } catch { /* Best-effort session cleanup. */ }
  }
}

export async function parallel(query: string, settings: EngineSettings, signal: AbortSignal, apiKey?: string): Promise<SourcedResults[]> {
  if (!apiKey) return [{ source: 'parallel', results: await parallelMcp(query, settings, signal) }];
  const advanced: Record<string, unknown> = { max_results: settings.searchResultCount };
  const country = regionCountry(settings.searchRegion);
  if (country) advanced.location = country;
  const days = recencyDays(settings.searchRecency);
  if (days) advanced.source_policy = { after_date: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) };
  const response = await safeFetch('https://api.parallel.ai/v1/search', signal, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ objective: query, search_queries: [query], mode: settings.parallelMode, advanced_settings: advanced }),
  });
  const body = await jsonBody<ParallelBody>(response);
  return [{ source: 'parallel', results: await cleanResults(body.results ?? [], settings.searchResultCount) }];
}

export async function tinyfish(query: string, settings: EngineSettings, signal: AbortSignal, apiKey?: string): Promise<SourcedResults[]> {
  if (!apiKey) throw new Error('No API key is configured for TinyFish. Open Settings → Web search to add one.');
  const url = new URL('https://api.search.tinyfish.ai/');
  url.searchParams.set('query', query);
  const parts = settings.searchRegion.toLowerCase().split('-');
  if (regionCountry(settings.searchRegion) && /^[a-z]{2}$/.test(parts[1] ?? '')) {
    url.searchParams.set('location', parts[0]!.toUpperCase());
    url.searchParams.set('language', parts[1]!);
  }
  if (settings.searchRecency !== 'any') {
    url.searchParams.set('recency_minutes', String((recencyDays(settings.searchRecency) || 1) * 24 * 60));
  }
  type Body = { results?: Array<{ title?: string; url?: string; snippet?: string; site_name?: string; date?: string }> };
  const body = await jsonBody<Body>(await safeFetch(url.toString(), signal, { headers: { 'X-API-Key': apiKey } }));
  return [{ source: 'tinyfish', results: await cleanResults(body.results ?? [], settings.searchResultCount) }];
}
