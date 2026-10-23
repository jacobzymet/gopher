import { randomUUID } from 'node:crypto';
import type { ApiStyle, Provider } from '../../config.js';
import { normalizeBase } from '../../providers.js';
import { HttpError, sendJson } from '../protocol.js';
import { flag, objectBody, oneOf, optionalText, text, type Body } from '../guards.js';
import { route, type Route, type RouteContext } from '../router.js';

/** Adding, testing, editing and removing model providers. */

const API_STYLES: readonly ApiStyle[] = ['openai', 'anthropic', 'responses'];
const MAX_CUSTOM_PROVIDERS = 32;

/** A display name: control characters removed, whitespace collapsed, at most 64 characters. */
export function providerName(value: unknown, base: string): string {
  const cleaned = String(value || '').replace(/\p{Cc}/gu, ' ').split(/\s+/).filter(Boolean).join(' ');
  return [...cleaned].slice(0, 64).join('') || new URL(base).hostname;
}

/** ChatGPT session JSON is only accepted through the built-in sign-in, never sent to a custom URL. */
function rejectSessionToken(token: string | undefined, message: string): void {
  if (token?.trimStart().startsWith('{')) throw new HttpError(400, message);
}

async function testProvider({ runtime, body: raw, response, assertActive }: RouteContext): Promise<void> {
  const body = objectBody(raw), providers = runtime.providers;
  const saved = runtime.storage.config.providers.find(provider => provider.id === body.id);
  const token = optionalText(body, 'token');
  rejectSessionToken(token, 'ChatGPT sessions cannot be sent to a custom URL.');
  const style = body.api_style === undefined ? undefined
    : oneOf(body.api_style, API_STYLES, 'Invalid provider API style.');
  const provider: Provider = {
    id: saved?.id || randomUUID(), kind: saved?.kind || 'custom', name: saved?.name || '',
    base: saved?.kind === 'openai-codex' ? saved.base : normalizeBase(text(body, 'base') || saved?.base || ''),
    token: token || saved?.token || '', api_style: style || saved?.api_style || 'openai',
    allow_insecure_tls: flag(body, 'allow_insecure_tls'),
  };
  const force = flag(body, 'force');
  // A saved provider is tested with its saved style first; detection runs for new
  // providers set to Auto, or when the saved style no longer answers.
  let probe = saved || style ? await providers.probe(provider, force) : null;
  let detected = false;
  if (!style && provider.kind === 'custom' && !probe?.health.ok) {
    const detection = await providers.detectApiStyle(provider, force);
    if (!probe || detection.probe.health.ok) {
      provider.api_style = detection.style;
      probe = detection.probe;
      detected = provider.api_style !== saved?.api_style;
    }
  }
  probe ??= await providers.probe(provider, force);
  assertActive();
  runtime.setHealth(provider.id, probe.health);
  sendJson(response, {
    ok: Boolean(probe.health.ok || probe.models.length), base: provider.base, api_style: provider.api_style, detected,
    refreshed: force, models: probe.models.length, health: probe.health,
  });
}

async function addProvider({ runtime, body: raw, response, assertActive }: RouteContext): Promise<void> {
  const body = objectBody(raw);
  const token = optionalText(body, 'token');
  rejectSessionToken(token, 'Import ChatGPT sessions through the ChatGPT connection.');
  const base = normalizeBase(text(body, 'base'));
  const style = oneOf(body.api_style || 'openai', API_STYLES, 'Invalid provider API style.');
  const provider: Provider = {
    id: randomUUID(), name: providerName(body.name, base), base, token: (token || '').trim(), api_style: style,
    kind: 'custom', allow_insecure_tls: flag(body, 'allow_insecure_tls'),
  };
  if (!body.api_style) provider.api_style = (await runtime.providers.detectApiStyle(provider)).style;
  assertActive();
  await runtime.updateConfig(next => {
    const existing = next.providers.findIndex(item => item.api_style === provider.api_style
      && normalizeBase(item.base, item.api_style) === base);
    if (existing >= 0) {
      const current = next.providers[existing]!;
      if (current.kind !== 'custom') {
        throw new HttpError(400, 'Built-in providers keep a fixed address. Use Connect or Disconnect.');
      }
      provider.id = current.id;
      // An omitted token keeps the saved one; an explicit empty token clears it.
      if (body.token === undefined) provider.token = current.token;
      next.providers[existing] = provider;
    } else {
      if (next.providers.filter(item => item.kind === 'custom').length >= MAX_CUSTOM_PROVIDERS) {
        throw new HttpError(400, `Maximum of ${MAX_CUSTOM_PROVIDERS} providers reached.`);
      }
      next.providers.push(provider);
    }
    if (body.activate !== false) next.active_provider_id = provider.id;
  });
  sendJson(response, runtime.providerResponse());
}

function editProvider(provider: Provider, body: Body): void {
  if (body.name !== undefined) provider.name = providerName(body.name, provider.base);
  if (body.base !== undefined) provider.base = normalizeBase(String(body.base));
  if (body.token !== undefined) {
    const token = String(body.token);
    rejectSessionToken(token, 'Session tokens require the built-in provider.');
    provider.token = token.trim();
  }
  if (body.api_style !== undefined) provider.api_style = oneOf(body.api_style, API_STYLES, 'Invalid API style.');
  if (body.allow_insecure_tls !== undefined) provider.allow_insecure_tls = body.allow_insecure_tls === true;
}

/** Activate (POST …/activate), remove or disconnect (DELETE), or edit a custom provider (PATCH). */
async function providerItem({ runtime, body: raw, method, response }: RouteContext,
  match: RegExpExecArray | null): Promise<void> {
  const id = match![1], activate = Boolean(match![2]);
  const body = objectBody(raw);
  await runtime.updateConfig(next => {
    const provider = next.providers.find(item => item.id === id);
    if (!provider) throw new HttpError(404, 'Provider not found.');
    if (method === 'POST' && activate) next.active_provider_id = provider.id;
    else if (method === 'DELETE') {
      // Built-in providers stay listed and only lose their credential.
      if (provider.kind === 'custom') next.providers = next.providers.filter(item => item.id !== provider.id);
      else provider.token = '';
      if (next.active_provider_id === provider.id) {
        const fallback = next.providers.find(item => item.kind === 'custom') || next.providers[0];
        next.active_provider_id = fallback?.id || '';
      }
    } else if (method === 'PATCH' && provider.kind === 'custom') editProvider(provider, body);
    else throw new HttpError(405, 'Method not allowed.');
  });
  sendJson(response, runtime.providerResponse());
}

export const providerRoutes: Route[] = [
  route('POST', '/api/providers/test', testProvider),
  route('GET', '/api/providers', ({ runtime, response }) => sendJson(response, runtime.providerResponse())),
  route('POST', '/api/providers', addProvider),
  route('*', /^\/api\/providers\/([^/]+)(\/activate)?$/, providerItem),
];
