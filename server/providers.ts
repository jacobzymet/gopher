import { createHash } from 'node:crypto';
import type { Provider } from './config.js';
import { clearSubscriptionCache, codexClientVersion, localCodexModels, refreshCodexSecret } from './subscription.js';
import { applyThinkingControl } from './tools/capabilities.js';
import { promptText } from './tools/prompts.js';
import { chooseApiStyle, classifyProviderError, routeSignal, type RouteSignal } from './provider-health.js';
import { describeNetworkError } from './network-errors.js';
import { sanitizeTitle } from './titles.js';
import { connectionRefused, normalizeBase, providerFetch, readBounded } from './providers/http.js';
import { canonicalBase, enrichLocalModels, modelsFromBody, type ModelOption } from './providers/catalog.js';
import { jsonEvents, streamEvents } from './providers/events.js';
import { anthropicPayload, openaiPayload, responsesPayload, stripInternalFields } from './providers/wire.js';
import type { CompletionPayload, ProviderEvent } from './providers/types.js';

/** Model providers: listing models and health, streaming completions, and short chat titles. */

export type { Provider } from './config.js';
export type { ModelOption } from './providers/catalog.js';
export type { ChatMessage, CompletionPayload, ProviderEvent, ToolDefinition } from './providers/types.js';
export { normalizeBase, parseSSE, providerAuthHeaders, providerFetch, providerHostIsLocal,
  readBounded } from './providers/http.js';
export { anthropicPayload, responsesPayload } from './providers/wire.js';

export interface ProvidersOptions {
  getProviders: () => Provider[];
  getActiveProviderId?: () => string;
  /** Persist a provider whose OAuth credential was refreshed. */
  saveProvider?: (provider: Provider) => Promise<void>;
}
export interface ProviderHealth {
  ok: boolean; kind: 'ready' | 'empty' | 'waiting' | 'auth' | 'unreachable' | 'error'; message: string;
  model_count: number; checked_at: number; model?: string; status?: string; error?: string;
}
export interface ProbeResult { at: number; health: ProviderHealth; models: ModelOption[] }

const PROBE_CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 6000;
const RETRY_DELAY_MS = 250;
const TITLE_TIMEOUT_MS = 25_000;
/** Titles only need the opening of a message. */
const TITLE_SNIPPET_CHARS = 1_000;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const cleared = () => new Error('Provider session was cleared');
const isTimeout = (error: unknown) => (error as { name?: string })?.name === 'TimeoutError';

function failedHealth(kind: ProviderHealth['kind'], message: string): ProviderHealth {
  return { ok: false, kind, message, error: message, model_count: 0, checked_at: Date.now() };
}

export class Providers {
  private cache = new Map<string, ProbeResult>();
  private health = new Map<string, ProviderHealth>();
  /** Incremented by clear(); work started before a lock must not write results after it. */
  private generation = 0;
  constructor(private options: ProvidersOptions) {}

  clear(): void {
    this.generation++;
    this.cache.clear();
    this.health.clear();
    clearSubscriptionCache();
  }

  list(): Provider[] { return this.options.getProviders(); }

  /** Refresh an expiring ChatGPT credential and persist it, unless the session was cleared meanwhile. */
  private async refresh(provider: Provider): Promise<void> {
    if (provider.kind !== 'openai-codex' || !provider.token) return;
    const generation = this.generation;
    const result = await refreshCodexSecret(provider.token);
    if (generation !== this.generation) throw cleared();
    if (!result.changed) return;
    const updated = { ...provider, token: result.secret_json };
    await this.options.saveProvider?.(updated);
    if (generation !== this.generation) throw cleared();
    provider.token = updated.token;
  }

  /** A provider by id, else by base URL, else the active one, else the first. */
  get(id?: string, base?: string): Provider {
    const providers = this.list();
    const provider = id ? providers.find(item => item.id === id)
      : base ? providers.find(item => normalizeBase(item.base, item.api_style) === normalizeBase(base, item.api_style))
        : providers.find(item => item.id === this.options.getActiveProviderId?.()) || providers[0];
    if (!provider) throw new Error('No provider configured. Add one in Settings > Providers.');
    return provider;
  }

  /** GET the model list, retrying once quickly when the connection failed (local servers often restart). */
  private async fetchModels(provider: Provider): Promise<Response> {
    const suffix = provider.kind === 'openai-codex' ? `models?client_version=${await codexClientVersion()}` : 'models';
    try { return await providerFetch(provider, suffix, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }); }
    catch (error) {
      if (isTimeout(error)) throw error;
      await delay(RETRY_DELAY_MS);
      return providerFetch(provider, suffix, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    }
  }

  private async listModels(provider: Provider): Promise<{ health: ProviderHealth; models: ModelOption[] }> {
    const response = await this.fetchModels(provider);
    if (!response.ok) {
      await response.body?.cancel();
      const kind = response.status === 401 || response.status === 403 ? 'auth' : 'error';
      return { health: failedHealth(kind, `HTTP ${response.status}`), models: [] };
    }
    const models = modelsFromBody(provider, JSON.parse(await readBounded(response)));
    await enrichLocalModels(provider, models);
    const health: ProviderHealth = {
      ok: Boolean(models.length), kind: models.length ? 'ready' : 'empty', model: models[0]?.model,
      message: models.length ? `${models.length} models available` : 'Connected; no models returned',
      model_count: models.length, checked_at: Date.now(),
    };
    return { health, models };
  }

  /** Health and models for one provider, cached for 30 seconds unless forced. */
  async probe(provider: Provider, force = false): Promise<ProbeResult> {
    const generation = this.generation;
    let refreshError: unknown;
    try { await this.refresh(provider); } catch (error) { refreshError = error; }
    // Cache keys identify a credential by digest so raw tokens are not retained as map keys.
    const credential = createHash('sha256').update(provider.token).digest('base64url');
    const key = `${provider.id}:${provider.base}:${credential}:${provider.api_style}`;
    const cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached;
    let health: ProviderHealth, models: ModelOption[] = [], networkFailure = false;
    try {
      if (refreshError) throw refreshError;
      if (generation !== this.generation) throw cleared();
      ({ health, models } = await this.listModels(provider));
    } catch (error) {
      const message = error instanceof SyntaxError
        ? 'The provider returned an invalid model list.' : describeNetworkError(error);
      health = failedHealth(provider.kind === 'openai-codex' && !provider.token
        ? 'auth' : classifyProviderError(message), message);
      networkFailure = true;
    }
    // A brief outage keeps the last good catalog so the model picker does not empty out.
    if (!models.length && cached?.models.length && networkFailure && health.kind !== 'auth') models = cached.models;
    // Without a reachable catalog, a signed-in ChatGPT account falls back to the Codex CLI's cached list.
    if (!models.length && provider.kind === 'openai-codex' && provider.token && !['auth',
      'empty'].includes(health.kind)) {
      models = (await localCodexModels()).map(item => ({
        ...item, id: `remote|${provider.id}|${provider.base}|${item.model}`, provider_id: provider.id,
          provider_name: provider.name,
        base: provider.base, api_style: provider.api_style, request_style: provider.api_style, ready: true, port: 443,
      }));
    }
    const result = { at: Date.now(), health, models };
    if (generation === this.generation) { this.cache.set(key, result); this.health.set(provider.id, health); }
    return result;
  }

  /** Models from every provider; a disconnected ChatGPT account contributes a "Connect ChatGPT" entry. */
  async catalog(force = false): Promise<ModelOption[]> {
    const lists = await Promise.all(this.list().map(async provider => {
      const result = await this.probe(provider, force);
      if (result.models.length) return result.models;
      if (provider.kind !== 'openai-codex' || provider.token) return [];
      const connect: ModelOption = {
        id: `${provider.id}:connect`, model: '', name: 'Connect ChatGPT', label: 'Connect ChatGPT', base: provider.base,
        api_style: provider.api_style, request_style: provider.api_style, provider_id: provider.id,
          provider_name: provider.name,
        ready: false, connect_kind: 'openai-codex', port: 0,
      };
      return [connect];
    }));
    return lists.flat();
  }

  cachedHealth(id: string): ProviderHealth | null { return this.health.get(id) || null; }

  /** A catalog entry from the probe cache, without triggering a new probe. */
  private cachedModel(provider: Provider, model: string): ModelOption | undefined {
    for (const entry of this.cache.values()) {
      const found = entry.models.find(item => item.provider_id === provider.id && item.model === model);
      if (found) return found;
    }
    return undefined;
  }

  /** POST a completion; a refused connection never reached the server, so it is retried once. */
  private async post(provider: Provider, path: string, body: Record<string, unknown>,
    signal: AbortSignal): Promise<Response> {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal };
    try { return await providerFetch(provider, path, init); }
    catch (error) {
      if (!connectionRefused(error) || signal.aborted) throw error;
      await delay(RETRY_DELAY_MS * 2);
      signal.throwIfAborted();
      return providerFetch(provider, path, init);
    }
  }

  async *complete(provider: Provider, payload: CompletionPayload, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    signal.throwIfAborted();
    await this.refresh(provider);
    signal.throwIfAborted();
    const style = provider.api_style || 'openai';
    const body = stripInternalFields(style === 'anthropic' ? anthropicPayload(payload, provider.base)
      : style === 'responses' ? responsesPayload(payload, provider.kind === 'openai-codex') : openaiPayload(payload));
    const path = style === 'anthropic' ? 'messages' : style === 'responses' ? 'responses' : 'chat/completions';
    const response = await this.post(provider, path, body, signal);
    if (response.headers.get('content-type')?.includes('application/json')) yield* jsonEvents(response, style);
    else yield* streamEvents(response, style);
  }

  async title(provider: Provider, model: string, message: string, signal?: AbortSignal): Promise<string> {
    const system = await promptText('title.system');
    const user = await promptText('title.user', { snippet: message.slice(0, TITLE_SNIPPET_CHARS) });
    const base: CompletionPayload = {
      model, stream: false, max_tokens: 100, thinking_effort: 'off',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    };
    applyThinkingControl(base, this.cachedModel(provider, model));
    // When the catalog has no exact control, still ask OpenAI-compatible servers not to think.
    const knobs = provider.api_style === 'openai' && !('reasoning' in base) && !('reasoning_effort' in base)
      && !('chat_template_kwargs' in base);
    const payload = knobs ? { ...base, reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false } } : base;
    const timeout = AbortSignal.timeout(TITLE_TIMEOUT_MS);
    const collect = async (body: CompletionPayload) => {
      let text = '', reasoning = '';
      for await (const part of this.complete(provider, body, signal ? AbortSignal.any([signal, timeout]) : timeout)) {
        if (part.type === 'text') text += part.text;
        if (part.type === 'reasoning') reasoning += part.text;
      }
      return sanitizeTitle(text) ?? sanitizeTitle(reasoning);
    };
    let title: string | undefined;
    try { title = await collect(payload); }
    catch (error) {
      // Strict OpenAI-compatible hosts reject unknown reasoning fields; retry the same small request without them.
      if (!knobs || !/\(400\)/.test(String((error as Error)?.message))) throw error;
      title = await collect(base);
    }
    return title || 'New conversation';
  }

  /** Probe both API styles at once and pick the one the server actually speaks. */
  async detectApiStyle(provider: Provider, force = false) {
    const routeFor = async (style: 'openai' | 'anthropic'): Promise<RouteSignal> => {
      try {
        const path = style === 'anthropic' ? 'messages' : 'chat/completions';
        const response = await providerFetch({ ...provider, api_style: style }, path,
          { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        await response.body?.cancel();
        return routeSignal(response.status);
      } catch { return 'unknown'; }
    };
    const [openai, anthropic, openaiRoute, anthropicRoute] = await Promise.all([
      this.probe({ ...provider, api_style: 'openai' }, force), this.probe({ ...provider, api_style: 'anthropic' },
        force),
      routeFor('openai'), routeFor('anthropic'),
    ]);
    const evidence = (probe: ProbeResult, route: RouteSignal) => ({ modelsOk: probe.models.length > 0, route });
    const style = chooseApiStyle(provider.base, provider.token, evidence(openai, openaiRoute), evidence(anthropic,
      anthropicRoute));
    const winner = style === 'anthropic' ? anthropic : openai, other = style === 'anthropic' ? openai : anthropic;
    return { style, probe: winner.health.ok || !other.health.ok ? winner : { ...winner, health: other.health } };
  }
}

export async function probeProvider(provider: Provider) {
  return new Providers({ getProviders: () => [provider] }).probe(provider, true);
}

export { canonicalBase };
