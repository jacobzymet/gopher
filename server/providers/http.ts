import { isIP } from 'node:net';
import type { Dispatcher } from 'undici';
import type { Provider } from '../config.js';
import { prepareCodex } from '../subscription.js';
import { record } from '../diagnostics.js';
import { asRecord, asString } from './types.js';

/** Talking to model providers over HTTP: addresses, credentials, timeouts, bounded reads and SSE. */

export const CODEX_API_BASE = 'https://chatgpt.com/backend-api/codex';
const HEADER_TIMEOUT_MS = 300_000;
const STREAM_IDLE_MS = 300_000;
const MAX_SSE_FRAME = 2_000_000;
const MAX_ERROR_BODY = 32_000;

function privateIpv4(host: string): boolean {
  const [a, b, c, d] = host.split('.').map(Number) as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51
      && c === 100)
    || (a === 203 && b === 0 && c === 113) || a >= 224 || (a === 255 && b === 255 && c === 255 && d === 255);
}

/** Hosts that may be reached over plain HTTP: loopback, private networks and `.local` names. */
export function providerHostIsLocal(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) === 4) return privateIpv4(host);
  if (isIP(host) !== 6) return false;
  if (host === '::' || host === '::1' || /^(fc|fd|fe[89ab]|ff)/.test(host)) return true;
  const mapped = host.match(/^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/);
  if (!mapped) return false;
  if (mapped[3]) return privateIpv4(mapped[3]);
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return privateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

/**
 * The canonical API base: HTTP(S) only, no credentials, query or fragment, public hosts upgraded
 * to HTTPS, and a `/v1` suffix unless the path is already versioned.
 */
export function normalizeBase(value: string, _style = 'openai'): string {
  const raw = value.trim();
  if (!raw) throw new Error('Provider URL must not be empty');
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const unsafe = !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.search || url.hash || raw.includes('?') || raw.includes('#');
  if (unsafe) throw new Error('Provider URL must use HTTP or HTTPS without credentials, query, or fragment');
  if (url.protocol === 'http:' && !providerHostIsLocal(url.hostname)) url.protocol = 'https:';
  const pathname = url.pathname.replace(/\/+$/, '');
  const versioned = pathname.endsWith('/v1') || /\/v1(?:beta)?\/openai$/.test(pathname);
  url.pathname = versioned ? pathname : `${pathname}/v1`;
  return url.toString().replace(/\/+$/, '');
}

/** Bearer or x-api-key auth; a `cf-access:ID:SECRET` token becomes Cloudflare Access service-token headers. */
export function providerAuthHeaders(style: string, rawToken: string): Record<string, string> {
  const token = rawToken.trim();
  const headers: Record<string, string> = {};
  if (style === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (token.startsWith('cf-access:')) {
    const credentials = token.slice(10);
    const colon = credentials.indexOf(':');
    const id = colon >= 0 ? credentials.slice(0, colon).trim() : '', secret = colon >= 0
      ? credentials.slice(colon + 1).trim() : '';
    if (id && secret) {
      headers['CF-Access-Client-Id'] = id;
      headers['CF-Access-Client-Secret'] = secret;
      return headers;
    }
  }
  if (token) headers[style === 'anthropic' ? 'x-api-key' : 'authorization'] = style === 'anthropic'
    ? token : `Bearer ${token}`;
  return headers;
}

/** Self-signed local servers opt out of certificate checks per provider; one dispatcher per origin. */
const insecureDispatchers = new Map<string, Dispatcher>();
async function insecureDispatcher(origin: string): Promise<Dispatcher> {
  let dispatcher = insecureDispatchers.get(origin);
  if (!dispatcher) {
    const { Agent } = await import('undici');
    dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    insecureDispatchers.set(origin, dispatcher);
  }
  return dispatcher;
}

function redact(text: string, secrets: string[]): string {
  let safe = text;
  for (const secret of secrets.filter(Boolean).sort((a,
    b) => b.length - a.length)) safe = safe.split(secret).join('[redacted]');
  return safe;
}

function bodyForLog(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') return undefined;
  try { return JSON.parse(body) as unknown; } catch { return body; }
}

/** A stalled provider, retried once by the engine. */
export const stalledError = (message: string) => Object.assign(new Error(message), { code: 'provider_stalled' });

/**
 * Request `suffix` under the provider's base. Redirects are refused (credentials must not follow),
 * headers must arrive within five minutes, and error bodies are returned with every credential
 * replaced by `[redacted]`.
 */
export async function providerFetch(provider: Provider, suffix: string, init: RequestInit = {}): Promise<Response> {
  const builtin = provider.kind === 'openai-codex';
  const base = builtin ? CODEX_API_BASE : normalizeBase(provider.base, provider.api_style);
  const headers = new Headers(init.headers);
  headers.set('accept', suffix.includes('models') ? 'application/json' : 'text/event-stream, application/json');
  let token = provider.token || '';
  if (builtin) {
    const prepared = await prepareCodex(token);
    token = prepared.token;
    for (const [key, value] of Object.entries(prepared.headers)) headers.set(key, value);
  }
  for (const [key, value] of Object.entries(providerAuthHeaders(provider.api_style, token))) headers.set(key, value);
  const dispatcher = provider.allow_insecure_tls && !builtin
    ? await insecureDispatcher(new URL(base).origin) : undefined;
  const url = `${base}/${suffix.replace(/^\//, '')}`;
  const started = performance.now();
  record('provider.request', () => ({ url, method: init.method || 'GET', headers: Object.fromEntries(headers),
    body: bodyForLog(init.body) }));
  const headerAbort = new AbortController();
  const stalled = () => headerAbort.abort(stalledError('The model service stalled before returning headers.'));
  const headerTimer = setTimeout(stalled, HEADER_TIMEOUT_MS);
  headerTimer.unref();
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, headerAbort.signal]) : headerAbort.signal;
    const options = { ...init, signal, headers, redirect: 'error', ...(dispatcher ? { dispatcher } : {}) };
    const response = await fetch(url, options as RequestInit);
    record('provider.headers', { status: response.status, request_elapsed_ms: performance.now() - started,
      headers: Object.fromEntries(response.headers) });
    if (response.ok) return response;
    const secrets = [provider.token, token, headers.get('CF-Access-Client-Secret') || '',
      headers.get('CF-Access-Client-Id') || ''];
    const safe = redact(await readBounded(response, MAX_ERROR_BODY), secrets);
    return new Response(safe, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    record('provider.error', { error: (error as Error).message, request_elapsed_ms: performance.now() - started });
    throw error;
  } finally { clearTimeout(headerTimer); }
}

/** A connection that never opened did not reach the server, so even a completion may be retried. */
export function connectionRefused(error: unknown): boolean {
  for (let current = error as { code?: unknown; cause?: unknown } | undefined, depth = 0; current
    && depth < 6; depth++) {
    if (current.code === 'ECONNREFUSED') return true;
    current = current.cause as typeof current;
  }
  return false;
}

export async function readBounded(response: Response, max = 8 * 1024 * 1024): Promise<string> {
  if (Number(response.headers.get('content-length')) > max) throw new Error('Provider response exceeds the size limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > max) throw new Error('Provider response exceeds the size limit');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

/** The message of a provider's JSON error body, or the raw text. */
function errorMessage(raw: string): string {
  try {
    const body = asRecord(JSON.parse(raw));
    return asString(body.error) || asString(asRecord(body.error).message) || asString(body.message) || raw;
  } catch { return raw; }
}

/** Read one chunk, failing as stalled if nothing arrives in time. */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, idleTimeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { record('provider.stalled',
      { stage: 'stream' }); reject(stalledError('The model stream stalled. Try again.')); }, idleTimeoutMs);
    timer.unref();
  });
  try { return await Promise.race([reader.read(), idle]); } finally { clearTimeout(timer); }
}

/** Server-sent events from a provider response. Throws the provider's error message for a failed response. */
export async function* parseSSE(response: Response,
  idleTimeoutMs = STREAM_IDLE_MS): AsyncGenerator<{ event: string; data: string }> {
  if (!response.ok) {
    const message = errorMessage(await readBounded(response, MAX_ERROR_BODY));
    throw new Error(`Provider request failed (${response.status}): ${message.slice(0, 1800)}`);
  }
  if (!response.body) throw new Error('Provider returned an empty response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', ended = false, first = true;
  try {
    while (!ended) {
      const next = await readWithin(reader, idleTimeoutMs);
      ended = Boolean(next.done);
      const decoded = decoder.decode(next.value, { stream: !ended });
      if (next.value?.length) {
        if (first) { record('provider.first_byte', { bytes: next.value.length }); first = false; }
        record('provider.raw_chunk', () => ({ bytes: next.value?.length, text: decoded }));
      }
      buffer += decoded;
      if (buffer.length > MAX_SSE_FRAME) throw new Error('Provider stream frame exceeded 2 MB');
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0 || (ended && buffer.length)) {
        if (boundary < 0) boundary = buffer.length;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = block.split('\n');
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
        if (!data) continue;
        yield { event, data };
        if (data === '[DONE]') return;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}
