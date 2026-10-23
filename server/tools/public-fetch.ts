import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { Agent } from 'undici';

/**
 * Public-internet HTTP for agent tools. Private, loopback and link-local targets
 * are blocked, every redirect is re-validated, and the connection is pinned to
 * the addresses that were validated (no DNS rebinding between check and use).
 */

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 4_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

function expandIpv6(value: string): number[] {
  let address = value;
  if (address.includes('.')) {
    const at = address.lastIndexOf(':');
    const bytes = address.slice(at + 1).split('.').map(Number);
    const high = ((bytes[0]! << 8) | bytes[1]!).toString(16), low = ((bytes[2]! << 8) | bytes[3]!).toString(16);
    address = `${address.slice(0, at)}:${high}:${low}`;
  }
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const zeros = Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map(word => parseInt(word, 16));
}

/** True for any address that is not a globally routable unicast address (and for non-IPs). */
export function privateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(value) === 6) {
    const words = expandIpv6(value);
    if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
      return privateAddress(`${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`);
    }
    return words.every(word => word === 0)
      || (words.slice(0, 7).every(word => word === 0) && words[7] === 1)
      || (words[0]! & 0xfe00) === 0xfc00
      || (words[0]! & 0xffc0) === 0xfe80
      || (words[0]! & 0xff00) === 0xff00;
  }
  if (isIP(value) !== 4) return true;
  const [a, b, c] = value.split('.').map(Number) as [number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function publicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid public URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('URL must be public HTTP(S) without embedded credentials');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const localSuffix = ['.localhost', '.local', '.internal'].some(suffix => hostname.endsWith(suffix));
  if (!hostname || hostname === 'localhost' || localSuffix) throw new Error('Local hosts are blocked');
  if (isIP(hostname) && privateAddress(hostname)) throw new Error('Private addresses are blocked');
  url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return url;
}

type PublicResolver = (hostname: string) => Promise<LookupAddress[]>;
const resolveAddresses: PublicResolver = hostname => lookup(hostname, { all: true });

async function resolvedPublicTarget(raw: string, resolve: PublicResolver) {
  const url = publicUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses: LookupAddress[] = family ? [{ address: hostname, family }] : await resolve(hostname);
  const invalid = (item: LookupAddress) =>
    ![4, 6].includes(item.family) || isIP(item.address) !== item.family || privateAddress(item.address);
  if (!addresses.length || addresses.some(invalid)) throw new Error('Host resolved to a private or invalid address');
  return { url, addresses };
}

/** A DNS lookup that only ever answers with the pre-validated addresses for one hostname. */
export function pinnedLookup(hostname: string, addresses: readonly LookupAddress[]): LookupFunction {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const pinned = addresses.map(item => ({ ...item }));
  return (requested, options, callback) => {
    if (requested.toLowerCase().replace(/^\[|\]$/g, '') !== host) {
      callback(new Error('Connection hostname differs from validated hostname'), '', 0);
      return;
    }
    const familyName = (family: number) => (family === 4 ? 'IPv4' : 'IPv6');
    const matches = pinned.filter(item =>
      !options.family || options.family === item.family || options.family === familyName(item.family));
    if (!matches.length) {
      callback(new Error('No validated address matches the requested family'), '', 0);
      return;
    }
    if (options.all) callback(null, matches.map(item => ({ ...item })));
    else callback(null, matches[0]!.address, matches[0]!.family);
  };
}

export async function assertPublicUrl(raw: string, resolveDns = true): Promise<URL> {
  return resolveDns ? (await resolvedPublicTarget(raw, resolveAddresses)).url : publicUrl(raw);
}

export interface PublicFetchDependencies {
  resolve?: PublicResolver;
  request?: typeof fetch;
  agent?: (lookup: LookupFunction) => Agent;
}
export type PublicFetch = (raw: string, signal: AbortSignal, init?: RequestInit, redirects?: number) => Promise<Response>;

export function createPublicFetch(dependencies: PublicFetchDependencies = {}): PublicFetch {
  const resolver = dependencies.resolve || resolveAddresses;
  const makeAgent = dependencies.agent || (lookup => new Agent({ connect: { lookup } }));
  return async function safeRequest(raw, signal, init = {}, redirects = 0) {
    const { url, addresses } = await resolvedPublicTarget(raw, resolver);
    const headers = new Headers(init.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', 'Gopher/0.1 web search');
    const agent = makeAgent(pinnedLookup(url.hostname, addresses));
    let response: Response;
    try {
      const options = {
        ...init, dispatcher: agent, headers, redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      };
      response = await (dependencies.request || fetch)(url, options as RequestInit);
    } finally { void agent.close().catch(() => {}); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (redirects >= MAX_REDIRECTS) throw new Error('Too many search redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Search redirect had no destination');
      const destination = publicUrl(new URL(location, url).toString());
      const credentialed = headers.has('authorization') || headers.has('x-api-key');
      if (destination.origin !== url.origin && credentialed) {
        throw new Error('Credentialed cross-origin search redirects are blocked');
      }
      return safeRequest(destination.toString(), signal, init, redirects + 1);
    }
    if (!response.ok) {
      const detail = (await boundedText(response, 32_000)).replace(/\s+/g, ' ').slice(0, 240);
      throw Object.assign(new Error(`Search request failed (${response.status})${detail ? `: ${detail}` : ''}`), {
        status: response.status,
      });
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error('Search response was unexpectedly large');
    }
    return response;
  };
}
export const safeFetch = createPublicFetch();

/** Read a response body as UTF-8 text, failing once it exceeds `maxBytes`. */
export async function boundedText(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error(`Search response exceeded ${maxBytes} bytes`);
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
  return text + decoder.decode();
}

export async function jsonBody<T>(response: Response): Promise<T> {
  return JSON.parse(await boundedText(response)) as T;
}
