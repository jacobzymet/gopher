import type { Provider } from '../config.js';
import { contextCapability, thinkingCapability, thinkingFromProps, visionCapability } from '../tools/capabilities.js';
import { CODEX_API_BASE, normalizeBase, providerFetch, providerHostIsLocal, readBounded } from './http.js';
import { asArray, asRecord, asString, isRecord, type JsonRecord } from './types.js';

/** Turning a provider's model list into catalog entries, enriched with local-server capabilities. */

export interface ModelOption {
  id: string; model: string; name: string; label: string; ready: boolean; port: number;
  provider_id: string; provider_name: string; base: string; api_style: string; request_style: string;
  context_length?: number; thinking_supported?: boolean; reasoning_supported?: boolean; thinking_control?: string;
  thinking_efforts?: string[]; thinking_can_disable?: boolean; reasoning_summary?: string; reasoning_context?: string;
  attachments_supported?: boolean; prompt_progress_supported?: boolean; vision?: boolean; connect_kind?: string;
  [key: string]: unknown;
}

const LOCAL_PROBE_MS = 1200;
const LOCAL_PROBE_CONCURRENCY = 8;

export const canonicalBase = (provider: Provider) =>
  provider.kind === 'openai-codex' ? CODEX_API_BASE : normalizeBase(provider.base, provider.api_style);

const defaultPort = (base: string) => Number(new URL(base).port) || (base.startsWith('https:') ? 443 : 80);

/** The ChatGPT catalog lists hidden models and an explicit order. */
function visibleCodexModels(items: unknown[]): unknown[] {
  const visibility = (item: JsonRecord) => String(item.visibility || '').trim().toLowerCase();
  const priority = (item: JsonRecord) => (typeof item.priority === 'number' ? item.priority : 10000);
  return items.map(asRecord).filter(item => !['hide', 'hidden'].includes(visibility(item)))
    .sort((a, b) => priority(a) - priority(b) || String(a.slug).localeCompare(String(b.slug)));
}

/** Parse a `/models` body (an array, `{data}` or `{models}`) into unique catalog entries. */
export function modelsFromBody(provider: Provider, body: unknown): ModelOption[] {
  const base = canonicalBase(provider), codex = provider.kind === 'openai-codex';
  const record = asRecord(body);
  let items = Array.isArray(body) ? body : asArray(record.data ?? record.models);
  if (codex) items = visibleCodexModels(items);
  const models: ModelOption[] = [];
  for (const raw of items) {
    const item = isRecord(raw) ? raw : {};
    const model = typeof raw === 'string' ? raw : asString(item.id) || asString(item.slug) || asString(item.name)
      || asString(item.model);
    if (!model) continue;
    const vision = visionCapability(item, provider.api_style) ?? false;
    const progress = Boolean(item.prompt_progress_supported || String(item.owned_by).toLowerCase() === 'llamacpp');
    models.push({
      id: `remote|${provider.id}|${base}|${model}`, model, name: asString(item.display_name) || asString(item.name)
        || model,
      label: model, ready: true, port: defaultPort(base), provider_id: provider.id, provider_name: provider.name, base,
      api_style: provider.api_style, request_style: provider.api_style, context_length: contextCapability(item),
      ...thinkingCapability(item, codex), attachments_supported: vision, prompt_progress_supported: progress, vision,
    });
  }
  return [...new Map(models.map(model => [model.model, model])).values()];
}

async function localJson(provider: Provider, suffix: string, body?: JsonRecord): Promise<JsonRecord | null> {
  try {
    const init: RequestInit = { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(LOCAL_PROBE_MS) };
    if (body) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
    const response = await providerFetch(provider, suffix, init);
    if (!response.ok) { await response.body?.cancel(); return null; }
    return asRecord(JSON.parse(await readBounded(response)));
  } catch { return null; }
}

const sameModel = (id: unknown, model: string) =>
  typeof id === 'string' && (id === model || id.split('/').at(-1) === model.split('/').at(-1));

/**
 * Local OpenAI-compatible servers describe capabilities outside `/models`: llama.cpp in `/props`,
 * LM Studio in `/api/v1/models`, Ollama in `/api/tags` and `/api/show`. Each probe is optional.
 */
export async function enrichLocalModels(provider: Provider, models: ModelOption[]): Promise<void> {
  if (provider.api_style !== 'openai' || !providerHostIsLocal(new URL(canonicalBase(provider)).hostname)) return;
  const [rawProps, native, rawTags] = await Promise.all([
    localJson(provider, '../props'), localJson(provider, '../api/v1/models'), localJson(provider, '../api/tags'),
  ]);
  const props = rawProps && (rawProps.chat_template || rawProps.chat_template_caps
    || rawProps.default_generation_settings) ? rawProps : null;
  const ollama = Array.isArray(rawTags?.models);
  const nativeModels = asArray(native?.models ?? native?.data).map(asRecord);
  const enrich = async (model: ModelOption) => {
    const entry = nativeModels.find(item => sameModel(item.key || item.id || item.name, model.model));
    if (entry) {
      const capability = thinkingCapability(entry);
      if (capability.thinking_supported) Object.assign(model, capability);
      const vision = visionCapability(entry);
      if (vision !== undefined) model.attachments_supported = model.vision = vision;
      model.context_length = contextCapability(entry) || model.context_length;
    }
    if (ollama) {
      const capabilities = (await localJson(provider, '../api/show', { model: model.model }))?.capabilities;
      if (Array.isArray(capabilities)) {
        model.attachments_supported = model.vision = capabilities.includes('vision');
        if (capabilities.includes('thinking')) model.thinking_supported = true;
      }
    }
    const modelProps = props ? (models.length === 1 ? props
      : await localJson(provider, `../props?model=${encodeURIComponent(model.model)}&autoload=false`) || props) : null;
    if (modelProps) {
      model.prompt_progress_supported = true;
      const capabilities = thinkingFromProps(modelProps);
      if (capabilities.thinking_supported) Object.assign(model, capabilities);
      const runtime = Number(asRecord(modelProps.default_generation_settings).n_ctx);
      model.context_length = runtime || contextCapability(modelProps) || model.context_length;
    }
  };
  for (let start = 0; start < models.length; start += LOCAL_PROBE_CONCURRENCY) {
    await Promise.all(models.slice(start, start + LOCAL_PROBE_CONCURRENCY).map(enrich));
  }
}
