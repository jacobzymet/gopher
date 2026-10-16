import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import type { LookupAddress } from 'node:dns';
import { Agent } from 'undici';

export interface SearchSettings {
  searchProvider: "auto" | "duckduckgo" | "searxng" | "parallel" | "tinyfish";
  searchDepth: "fast" | "balanced" | "deep";
  searchResultCount: number;
  searchRegion: string;
  searchSafeSearch: "strict" | "moderate" | "off";
  searchRecency: "any" | "day" | "week" | "month" | "year";
  searxngUrl: string;
  parallelMode: "turbo" | "fast" | "basic" | "advanced";
  searchPageCount?:number;searchPageMaxChars?:number;
}
export interface SearchCredentials { parallel?: string; tinyfish?: string }
export interface SearchResult { title: string; url: string; snippet: string }
export type FetchedPage=Awaited<ReturnType<typeof fetchPublicUrl>>;
export class PageCache{
  private entries=new Map<string,Promise<FetchedPage>>();
  async read(raw:string,fetcher:()=>Promise<FetchedPage>):Promise<FetchedPage>{const url=new URL(raw);url.hash='';const key=url.toString();let pending=this.entries.get(key);if(pending)this.entries.delete(key);else{pending=fetcher();pending.catch(()=>{if(this.entries.get(key)===pending)this.entries.delete(key);});}this.entries.set(key,pending);while(this.entries.size>16)this.entries.delete(this.entries.keys().next().value!);return pending;}
  clear():void{this.entries.clear();}
}

export function privateAddress(address: string): boolean {
  let value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(value) === 6) {
    if (value.includes('.')) { const at = value.lastIndexOf(':'); const bytes = value.slice(at + 1).split('.').map(Number); value = `${value.slice(0, at)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`; }
    const halves = value.split('::'); const left = halves[0] ? halves[0].split(':') : []; const right = halves[1] ? halves[1].split(':') : [];
    const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(word => parseInt(word, 16));
    if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) return privateAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    return words.every(word => word === 0) || (words.slice(0, 7).every(word => word === 0) && words[7] === 1) || (words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00;
  }
  if (isIP(value) !== 4) return true;
  const [a, b, c] = value.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113);
}

function publicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid public URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL must be public HTTP(S) without embedded credentials');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || ['.localhost', '.local', '.internal'].some(suffix => hostname.endsWith(suffix))) throw new Error('Local hosts are blocked');
  if (isIP(hostname) && privateAddress(hostname)) throw new Error('Private addresses are blocked');
  url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return url;
}
type PublicResolver = (hostname: string) => Promise<LookupAddress[]>;
const resolveAddresses: PublicResolver = hostname => lookup(hostname, { all: true });
async function resolvedPublicTarget(raw: string, resolve: PublicResolver): Promise<{ url: URL; addresses: LookupAddress[] }> {
  const url = publicUrl(raw); const hostname = url.hostname.replace(/^\[|\]$/g, ''); const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await resolve(hostname);
  if (!addresses.length || addresses.some(item => ![4, 6].includes(item.family) || isIP(item.address) !== item.family || privateAddress(item.address))) throw new Error('Host resolved to a private or invalid address');
  return { url, addresses };
}

export function pinnedLookup(hostname: string, addresses: readonly LookupAddress[]): LookupFunction {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ''); const pinned = addresses.map(item => ({ ...item }));
  return (requested, options, callback) => {
    if (requested.toLowerCase().replace(/^\[|\]$/g, '') !== host) { callback(new Error('Connection hostname differs from validated hostname'), '', 0); return; }
    const matches = pinned.filter(item => !options.family || options.family === item.family || options.family === (item.family === 4 ? 'IPv4' : 'IPv6'));
    if (!matches.length) { callback(new Error('No validated address matches the requested family'), '', 0); return; }
    if (options.all) callback(null, matches.map(item => ({ ...item })));
    else callback(null, matches[0].address, matches[0].family);
  };
}

export async function assertPublicUrl(raw: string, resolveDns = true) {
  return resolveDns ? (await resolvedPublicTarget(raw, resolveAddresses)).url : publicUrl(raw);
}

export interface PublicFetchDependencies { resolve?: PublicResolver; request?: typeof fetch; agent?: (lookup: LookupFunction) => Agent }
export function createPublicFetch(dependencies: PublicFetchDependencies = {}) {
return async function safeRequest(raw: string, signal: AbortSignal, init: RequestInit = {}, redirects = 0): Promise<Response> {
  const { url, addresses } = await resolvedPublicTarget(raw, dependencies.resolve || resolveAddresses);
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", "Gopher/0.1 web search");
  const agent = (dependencies.agent || (lookup => new Agent({ connect: { lookup } })))(pinnedLookup(url.hostname, addresses));
  let response: Response;
  try { response = await (dependencies.request || fetch)(url, { ...init, dispatcher: agent, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'manual' } as RequestInit); }
  finally { void agent.close().catch(() => {}); }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    if (redirects >= 3) throw new Error("Too many search redirects");
    const location = response.headers.get("location");
    if (!location) throw new Error("Search redirect had no destination");
    const destination = publicUrl(new URL(location, url).toString());
    if (destination.origin !== url.origin && (headers.has("authorization") || headers.has("x-api-key"))) throw new Error("Credentialed cross-origin search redirects are blocked");
    return safeRequest(destination.toString(), signal, init, redirects + 1);
  }
  if (!response.ok) {
    const detail = (await boundedText(response, 32_000)).replace(/\s+/g, " ").slice(0, 240);
    throw new Error(`Search request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 4_000_000) { await response.body?.cancel(); throw new Error("Search response was unexpectedly large"); }
  return response;
}
}
export const safeFetch = createPublicFetch();

async function boundedText(response: Response, maxBytes = 4_000_000) {
  if (!response.body) return "";
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = "", bytes = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > maxBytes) throw new Error(`Search response exceeded ${maxBytes} bytes`); text += decoder.decode(value, { stream: true }); } }
  finally { await reader.cancel().catch(() => {}); }
  return text + decoder.decode();
}
async function jsonBody<T>(response: Response) { return JSON.parse(await boundedText(response)) as T; }

function decode(value: string) {
  const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/<[^>]+>/g, " ").replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (_, key: string) => key.startsWith("#x") ? String.fromCodePoint(parseInt(key.slice(2), 16)) : key.startsWith("#") ? String.fromCodePoint(parseInt(key.slice(1), 10)) : entities[key.toLowerCase()] ?? `&${key};`).replace(/\s+/g, " ").trim();
}

export async function fetchPublicUrl(raw: string, signal: AbortSignal, maxChars = 16_000) {
  const response = await safeFetch(raw, signal);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("text/") && !["application/json", "application/ld+json", "application/xml", "application/xhtml+xml"].includes(contentType)) {
    await response.body?.cancel();
    throw new Error(`URL returned unsupported content type: ${contentType || "unknown"}`);
  }
  const body = await boundedText(response);
  const html = /html|xhtml/.test(contentType);
  const titleMatch = html ? body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) : undefined;
  const text = html
    ? decode(body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " "))
    : body.replace(/\u0000/g, "").trim();
  return {
    url: response.url || (await assertPublicUrl(raw, false)).toString(),
    title: titleMatch ? decode(titleMatch[1]).slice(0, 300) : "",
    contentType,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
function resultUrl(href: string) { try { const url = new URL(decode(href), "https://duckduckgo.com"); return url.searchParams.get("uddg") ?? url.toString(); } catch { return ""; } }
async function cleanResults(items: Array<{ title?: string | null; url?: string | null; snippet?: string; excerpts?: unknown; site_name?: string; date?: string }>, limit: number) {
  const results: SearchResult[] = [];
  for (const item of items) {
    if (results.length >= limit || !item.url) break;
    try { await assertPublicUrl(item.url, false); } catch { continue; }
    const excerpts = Array.isArray(item.excerpts) ? item.excerpts.filter((value): value is string => typeof value === "string").join(" … ") : "";
    const parts = [item.date, item.site_name, item.snippet || excerpts].filter(Boolean);
    results.push({ title: item.title?.trim() || item.url, url: item.url, snippet: parts.join(" · ").slice(0, 1_200) });
  }
  return results;
}

async function enrichForDepth(results: SearchResult[], settings: SearchSettings, signal: AbortSignal,cache?:PageCache) {
  if (settings.searchDepth === "fast"||settings.searchPageCount===0) return results.map((item) => ({ ...item, snippet: item.snippet.slice(0, 1200) }));
  const pages=settings.searchPageCount??(settings.searchDepth==='deep'?4:3);const chars=settings.searchPageMaxChars??(settings.searchDepth==='deep'?5000:3000);
  return Promise.all(results.map(async (item, index) => {
    if (index >= pages) return item;
    try {
      const page=await(cache?cache.read(item.url,()=>fetchPublicUrl(item.url,signal,4_000_000)):fetchPublicUrl(item.url,signal,4_000_000));const text=page.text.slice(0,chars);
      return { ...item, snippet: [item.snippet, text].filter(Boolean).join("\nFull-page context: ").slice(0, chars+1200) };
    } catch { return item; }
  }));
}

async function duckDuckGo(query: string, settings: SearchSettings, signal: AbortSignal) {
  const params = new URLSearchParams({ q: query, kl: settings.searchRegion || "us-en" });
  params.set("kp", settings.searchSafeSearch === "strict" ? "1" : settings.searchSafeSearch === "off" ? "-2" : "-1");
  const recency = { day: "d", week: "w", month: "m", year: "y" } as const;
  if (settings.searchRecency !== "any") params.set("df", recency[settings.searchRecency]);
  let lastError:unknown;for(const endpoint of['https://html.duckduckgo.com/html/','https://lite.duckduckgo.com/lite/'])try{const html=await boundedText(await safeFetch(`${endpoint}?${params}`,signal));const anchors=[...html.matchAll(/<a\b(?=[^>]*class=["'][^"']*(?:result__a|result-link)[^"']*["'])(?=[^>]*href=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/a>/gi)];const snippets=[...html.matchAll(/<(?:a|div|td)[^>]*class=["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)>/gi)];const results=await cleanResults(anchors.map((anchor,index)=>({title:decode(anchor[2]),url:resultUrl(anchor[1]),snippet:decode(snippets[index]?.[1]||'')})),settings.searchResultCount);if(results.length)return results;}catch(error){lastError=error;if(signal.aborted)throw error;}if(lastError)throw lastError;return[];
}

async function searxng(query: string, settings: SearchSettings, signal: AbortSignal) {
  if (!settings.searxngUrl.trim()) throw new Error("SearXNG is selected but no instance URL is configured in Settings");
  const raw=settings.searxngUrl.trim();if(raw.length>300)throw new Error('SearXNG URL is too long');const candidate=raw.includes('://')?raw:/^(localhost|127\.|\[::1\])/.test(raw)?`http://${raw}`:`https://${raw}`;const url=new URL(candidate);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('SearXNG URL must use HTTP(S) without credentials');
  url.pathname = url.pathname.replace(/\/$/, "");if(!url.pathname.endsWith('/search'))url.pathname+='/search'; url.search = "";url.hash='';
  const region=settings.searchRegion.toLowerCase().split('-');const language=/^[a-z]{2}$/.test(region[1]||'')?`${region[1]}-${region[0].toUpperCase()}`:'en-US';
  url.searchParams.set("q", query); url.searchParams.set("format", "json"); url.searchParams.set("language", language);
  url.searchParams.set("safesearch", settings.searchSafeSearch === "strict" ? "2" : settings.searchSafeSearch === "off" ? "0" : "1");
  if (settings.searchRecency !== "any") url.searchParams.set("time_range", settings.searchRecency);
  const request=async()=>{const response=await fetch(url,{headers:{'user-agent':'Gopher/1.0'},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});if(!response.ok)throw new Error(`SearXNG returned HTTP ${response.status}`);return response;};
  try{const body = await jsonBody<{ results?: Array<{ title?: string; url?: string; content?: string }> }>(await request());const results=await cleanResults((body.results??[]).map(item=>({...item,snippet:item.content})),settings.searchResultCount);if(results.length)return results;}catch(error){if(signal.aborted)throw error;}
  url.searchParams.delete('format');const html=await boundedText(await request());const entries=[...html.matchAll(/<h[234][^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];return cleanResults(entries.map(entry=>({url:decode(entry[1]),title:decode(entry[2])})),settings.searchResultCount);
}

function regionCountry(region: string) { const country = region.trim().toLowerCase().split("-")[0]; return /^[a-z]{2}$/.test(country) && country !== "wt" ? country : undefined; }
function recencyDays(recency: SearchSettings["searchRecency"]) { return ({ day: 1, week: 7, month: 30, year: 365 } as const)[recency as "day"] as number | undefined; }
function mcpJsonPayload(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  for (const line of trimmed.split(/\r?\n/)) {
    const data = line.trim().replace(/^data:\s*/, "");
    if (data.startsWith("{")) return data;
  }
  throw new Error("Parallel MCP response had no JSON payload");
}

async function parallelMcp(query: string, settings: SearchSettings, signal: AbortSignal) {
  const endpoint = "https://search.parallel.ai/mcp";
  const commonHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const initialized = await safeFetch(endpoint, signal, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gopher", version: "0.1.0" } } }),
  });
  const sessionId = initialized.headers.get("mcp-session-id");
  await boundedText(initialized);
  if (!sessionId) throw new Error("Parallel MCP did not return a session identifier");
  const headers = { ...commonHeaders, "Mcp-Session-Id": sessionId };
  try {
    const notice = await safeFetch(endpoint, signal, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    await boundedText(notice);
    const response = await safeFetch(endpoint, signal, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search", arguments: { objective: query, search_queries: [query] } } }),
    });
    const envelope = JSON.parse(mcpJsonPayload(await boundedText(response))) as { error?: { message?: string }; result?: { content?: Array<{ type?: string; text?: string }> } };
    if (envelope.error?.message) throw new Error(`Parallel MCP: ${envelope.error.message.slice(0, 240)}`);
    const text = envelope.result?.content?.find((item) => item.type === "text" && item.text)?.text;
    if (!text) throw new Error("Parallel MCP result did not include search data");
    const body = JSON.parse(text) as { results?: Array<{ title?: string | null; url?: string; excerpts?: string[] }> };
    return cleanResults(body.results ?? [], settings.searchResultCount);
  } finally {
    try { await boundedText(await safeFetch(endpoint, signal, { method: "DELETE", headers: { "Mcp-Session-Id": sessionId } })); } catch { /* Best-effort session cleanup. */ }
  }
}

async function parallel(query: string, settings: SearchSettings, signal: AbortSignal, apiKey?: string) {
  if (!apiKey) return parallelMcp(query, settings, signal);
  const advanced: Record<string, unknown> = { max_results: settings.searchResultCount };
  const country = regionCountry(settings.searchRegion); if (country) advanced.location = country;
  const days = recencyDays(settings.searchRecency); if (days) { const after = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10); advanced.source_policy = { after_date: after }; }
  const response = await safeFetch("https://api.parallel.ai/v1/search", signal, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey }, body: JSON.stringify({ objective: query, search_queries: [query], mode: settings.parallelMode, advanced_settings: advanced }) });
  const body = await jsonBody<{ results?: Array<{ title?: string | null; url?: string; excerpts?: string[] }> }>(response);
  return cleanResults(body.results ?? [], settings.searchResultCount);
}

async function tinyfish(query: string, settings: SearchSettings, signal: AbortSignal, apiKey?: string) {
  if (!apiKey) throw new Error("No API key is configured for TinyFish. Open Settings → Web search to add one.");
  const url = new URL("https://api.search.tinyfish.ai/"); url.searchParams.set("query", query);
  const parts = settings.searchRegion.toLowerCase().split("-");
  if (regionCountry(settings.searchRegion) && /^[a-z]{2}$/.test(parts[1] ?? "")) { url.searchParams.set("location", parts[0].toUpperCase()); url.searchParams.set("language", parts[1]); }
  if (settings.searchRecency !== "any") url.searchParams.set('recency_minutes',String((recencyDays(settings.searchRecency)||1)*24*60));
  const body = await jsonBody<{ results?: Array<{ title?: string; url?: string; snippet?: string; site_name?: string; date?: string }> }>(await safeFetch(url.toString(), signal, { headers: { "X-API-Key": apiKey } }));
  return cleanResults(body.results ?? [], settings.searchResultCount);
}

export async function searchWeb(query: string, settings: SearchSettings, signal: AbortSignal, credentials: SearchCredentials = {},cache?:PageCache) {
  const run = async (provider: Exclude<SearchSettings["searchProvider"], "auto">) => {
    const results = provider === "parallel" ? await parallel(query, settings, signal, credentials.parallel) : provider === "tinyfish" ? await tinyfish(query, settings, signal, credentials.tinyfish) : provider === "searxng" ? await searxng(query, settings, signal) : await duckDuckGo(query, settings, signal);
    if (!results.length) throw new Error(`${provider} returned no usable results`);
    const label = { parallel: "Parallel", tinyfish: "TinyFish", searxng: "SearXNG", duckduckgo: "DuckDuckGo" }[provider];
    return { provider: label, results: await enrichForDepth(results, settings, signal,cache), note: provider === "parallel" ? `Parallel · ${credentials.parallel ? settings.parallelMode : "free MCP"} · ${settings.searchDepth}` : `${label} · ${settings.searchDepth}` };
  };
  if (settings.searchProvider !== "auto") return run(settings.searchProvider);
  const order: Array<Exclude<SearchSettings["searchProvider"], "auto">> = [];
  if (settings.searxngUrl.trim()) order.push("searxng");
  order.push("duckduckgo");
  const errors: string[] = [];
  for (const provider of order) { try { const result = await run(provider); return { ...result, note: errors.length ? `${result.note} · fallback after ${errors.join("; ").slice(0, 180)}` : result.note }; } catch (error) { errors.push(`${provider}: ${error instanceof Error ? error.message : "failed"}`); } }
  throw new Error(`Auto search failed. ${errors.join("; ").slice(0, 600)}`);
}
