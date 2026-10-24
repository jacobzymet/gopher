import { randomBytes } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { isIP } from 'node:net';
import { parse, stringify } from 'smol-toml';

export type StorageMode = 'disk' | 'browser' | 'memory';
export type ApiStyle = 'openai' | 'anthropic' | 'responses';
export interface Provider {
  id: string; name: string; base: string; token: string; api_style: ApiStyle;
  kind: 'custom' | 'openai-codex'; allow_insecure_tls: boolean;
  default_model?: string;
}
export interface UiConfig {
  host: string; port: number; theme: 'dark' | 'light' | 'system';
  font_body: string; font_display: string; font_mono: string;
  font_scale: 'compact' | 'default' | 'large';
}
export interface AppConfig {
  ui: UiConfig; data: { storage: StorageMode }; providers: Provider[]; active_provider_id: string;
  max_tokens?: number; render_mode?: string; markdown?: boolean; save_sessions?: boolean;
}
export const FONT_BODY_IDS = ['inter', 'source-sans-3', 'ibm-plex-sans', 'atkinson-hyperlegible', 'literata'];
export const FONT_DISPLAY_IDS = ['space-grotesk', 'syne', 'dm-sans', 'fraunces', 'instrument-sans'];
export const FONT_MONO_IDS = ['jetbrains-mono', 'ibm-plex-mono', 'source-code-pro', 'fira-code'];
export const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
export const CODEX_PROVIDER_ID = 'builtin-openai-codex';
export function defaultConfig(): AppConfig {
  return { ui: { host: '127.0.0.1', port: 3930, theme: 'dark', font_body: 'inter', font_display: 'space-grotesk', font_mono: 'jetbrains-mono', font_scale: 'default' }, data: { storage: 'disk' }, providers: [], active_provider_id: '' };
}
export interface DefaultProfileOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  lstat?: (path: string) => Pick<Stats, 'isDirectory'>;
}
export function defaultDataDirectory(options: DefaultProfileOptions = {}): string {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env, home = options.home ?? homedir();
  if (platform === 'win32') {
    const root = win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'gopher');
    const original = win32.join(root, 'config'), inspect = options.lstat ?? lstatSync;
    const metadata = (path: string) => {
      try { return inspect(path); }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return undefined; throw error; }
    };
    const populated = (directory: string) => {
      const info = metadata(directory);
      if (!info) return false;
      if (!info.isDirectory()) throw new Error(`Gopher profile path is not a directory: ${directory}`);
      return ['config.toml', 'chats.json', 'preferences.json', 'encryption.json', 'encryption-transition.json', 'provider-tokens.json', 'diagnostics.json', 'chat-skills/skills.json', 'chat-skills/index.json'].some(file => Boolean(metadata(win32.join(directory, file))));
    };
    // Preserve the established TypeScript profile when both locations exist.
    // An older Rust profile may contain stale or inconsistent encryption files;
    // merely finding it must never switch an existing installation's history.
    if (populated(root)) return root;
    populated(original); // Validate the fallback path before selecting it.
    return original;
  }
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'gopher');
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'gopher');
}
export function defaultConfigPath(options: DefaultProfileOptions = {}): string { return (options.platform ?? process.platform) === 'win32' ? win32.join(defaultDataDirectory(options), 'config.toml') : posix.join(defaultDataDirectory(options), 'config.toml'); }
function namedProviderEntries(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Providers must be an array or named provider tables.');
  return Object.entries(value).map(([id, entry]) => {
    if (!id.trim() || id !== id.trim()) throw new Error('A named provider must have a nonempty ID without surrounding whitespace.');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) throw new Error(`Provider ${id} must be a table.`);
    const raw = entry as Record<string, unknown>;
    for (const field of ['id', 'base', 'base_url', 'token', 'api_key', 'kind']) if (raw[field] !== undefined && typeof raw[field] !== 'string') throw new Error(`Provider ${field} must be text.`);
    if (raw.id !== undefined && raw.id !== id) throw new Error(`Provider ${id} has an ID that does not match its table name.`);
    if (id === CODEX_PROVIDER_ID) throw new Error('The built-in ChatGPT provider ID cannot be used for a named custom provider.');
    if (typeof raw.base === 'string' && typeof raw.base_url === 'string' && raw.base.trim().replace(/\/+$/, '') !== raw.base_url.trim().replace(/\/+$/, '')) throw new Error(`Provider ${id} has conflicting base and base_url values.`);
    if (raw.token !== undefined && raw.api_key !== undefined && raw.token !== raw.api_key) throw new Error(`Provider ${id} has conflicting token and api_key values.`);
    const base = raw.base ?? raw.base_url;
    if (typeof base !== 'string' || !base.trim()) throw new Error(`Provider ${id} requires a nonempty base or base_url.`);
    const protocols = ['anthropic', 'openai', 'openrouter', 'gemini', 'google'];
    const kind = raw.kind === undefined ? (protocols.includes(id.toLowerCase()) ? id.toLowerCase() : 'custom') : String(raw.kind).trim().toLowerCase();
    if (kind !== 'custom' && !protocols.includes(kind)) throw new Error(`Invalid named provider kind: ${kind}`);
    const style = raw.api_style === undefined ? (kind === 'anthropic' ? 'anthropic' : 'openai') : raw.api_style;
    let endpoint = base;
    if (['gemini', 'google'].includes(kind) && ['openai', 'oai', 'compatible'].includes(String(style))) {
      try {
        const url = new URL(base);
        if (url.protocol === 'https:' && url.hostname === 'generativelanguage.googleapis.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && ['/', '/v1beta', '/v1beta/'].includes(url.pathname)) endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai';
      } catch {}
    }
    return { ...raw, id, kind: 'custom', base: endpoint, token: raw.token ?? raw.api_key ?? '', api_style: style };
  });
}
export function normalizeProviders(value: unknown, active = ''): { providers: Provider[]; active_provider_id: string } {
  const input = Array.isArray(value) ? value : namedProviderEntries(value);
  const ids = new Set<string>();
  const providers: Provider[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error('Each provider must be an object.');
    const raw = item as Record<string, unknown>;
    for (const field of ['id', 'name', 'base', 'token', 'kind', 'api_style', 'default_model']) if (raw[field] !== undefined && typeof raw[field] !== 'string') throw new Error(`Provider ${field} must be text.`);
    if (raw.allow_insecure_tls !== undefined && typeof raw.allow_insecure_tls !== 'boolean') throw new Error('Provider allow_insecure_tls must be a boolean.');
    const kind = raw.kind === 'codex' ? 'openai-codex' : raw.kind ?? 'custom';
    if (kind !== 'custom' && kind !== 'openai-codex') continue;
    let base = String(raw.base || '').trim().replace(/\/+$/, '');
    if (!base && kind !== 'openai-codex') continue;
    let id = String(raw.id || '').trim();
    if (kind === 'openai-codex') id = CODEX_PROVIDER_ID;
    if (ids.has(id) && kind === 'openai-codex') continue;
    if (!id || ids.has(id)) id = `provider-${randomBytes(8).toString('hex')}`;
    ids.add(id);
    let style = String(raw.api_style || 'openai');
    style = ({ oai: 'openai', compatible: 'openai', claude: 'anthropic', messages: 'anthropic', codex_responses: 'responses' } as Record<string, string>)[style] || style;
    if (!['openai', 'anthropic', 'responses'].includes(style)) throw new Error(`Invalid provider API style: ${style}`);
    base = base.replace(/\/(chat\/completions|messages|responses)$/, '');
    let name = String(raw.name || '').trim().slice(0, 80);
    if (kind === 'openai-codex') { base = CODEX_BASE; name = 'ChatGPT'; style = 'responses'; }
    if (!name) { try { name = new URL(base).hostname; } catch { name = base; } }
    providers.push({ id, name, base, token: String(raw.token || ''), kind, api_style: style as ApiStyle, allow_insecure_tls: kind === 'custom' && raw.allow_insecure_tls === true, ...(raw.default_model !== undefined ? { default_model: raw.default_model as string } : {}) });
  }
  if (!providers.some(p => p.kind === 'openai-codex')) providers.push({ id: CODEX_PROVIDER_ID, name: 'ChatGPT', base: CODEX_BASE, token: '', kind: 'openai-codex', api_style: 'responses', allow_insecure_tls: false });
  return { providers, active_provider_id: providers.some(p => p.id === active) ? active : (providers.find(p => p.kind === 'custom') || providers[0])?.id || '' };
}
export function normalizeConfig(raw: unknown, includeBuiltins = true): AppConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Configuration must be an object.');
  const input = raw as Record<string, any>;
  const config = defaultConfig();
  for (const field of ['ui', 'data']) if (input[field] !== undefined && (!input[field] || typeof input[field] !== 'object' || Array.isArray(input[field]))) throw new Error(`Configuration ${field} must be an object.`);
  for (const field of ['active_provider_id', 'active_remote_id', 'default_provider', 'render_mode']) if (input[field] !== undefined && typeof input[field] !== 'string') throw new Error(`Configuration ${field} must be text.`);
  if (input.max_tokens !== undefined) { if (typeof input.max_tokens !== 'number' || !Number.isFinite(input.max_tokens)) throw new Error('Configuration max_tokens must be a finite number.'); config.max_tokens = input.max_tokens; }
  for (const field of ['markdown', 'save_sessions'] as const) if (input[field] !== undefined) { if (typeof input[field] !== 'boolean') throw new Error(`Configuration ${field} must be a boolean.`); config[field] = input[field]; }
  if (input.render_mode !== undefined) config.render_mode = input.render_mode;
  const ui = input.ui || {};
  for (const field of ['host', 'theme', 'font_body', 'font_display', 'font_mono', 'font_scale']) if (ui[field] !== undefined && typeof ui[field] !== 'string') throw new Error(`UI ${field} must be text.`);
  if (ui.theme !== undefined && !['dark', 'light', 'system'].includes(ui.theme)) throw new Error('Invalid UI theme.');
  if (ui.font_scale !== undefined && !['compact', 'default', 'large'].includes(ui.font_scale)) throw new Error('Invalid UI font scale.');
  if (input.data?.storage !== undefined && !['disk', 'browser', 'memory'].includes(input.data.storage)) throw new Error('Invalid data storage mode.');
  config.ui = { ...config.ui, ...ui };
  if (!['dark', 'light', 'system'].includes(config.ui.theme)) config.ui.theme = 'dark';
  if (!['compact', 'default', 'large'].includes(config.ui.font_scale)) config.ui.font_scale = 'default';
  if (!FONT_BODY_IDS.includes(config.ui.font_body)) config.ui.font_body = 'inter';
  if (!FONT_DISPLAY_IDS.includes(config.ui.font_display)) config.ui.font_display = 'space-grotesk';
  if (!FONT_MONO_IDS.includes(config.ui.font_mono)) config.ui.font_mono = 'jetbrains-mono';
  config.ui.host = String(config.ui.host).replace(/^\[|\]$/g, '');
  if (config.ui.host === 'localhost') config.ui.host = '127.0.0.1';
  if (!isLoopback(config.ui.host)) config.ui.host = '127.0.0.1';
  if (!Number.isInteger(config.ui.port) || config.ui.port < 1 || config.ui.port > 65535) throw new Error('UI port must be between 1 and 65535.');
  // The persisted browser-localStorage marker resolves to disk storage so an
  // existing conversation store stays visible. Only explicit memory mode is
  // volatile.
  config.data.storage = input.data?.storage === 'memory' ? 'memory' : 'disk';
  const normalized = normalizeProviders(input.providers !== undefined ? input.providers : input.remotes !== undefined ? input.remotes : [], input.active_provider_id || input.active_remote_id || input.default_provider || '');
  config.providers = includeBuiltins ? normalized.providers : [];
  config.active_provider_id = includeBuiltins ? normalized.active_provider_id : '';
  return config;
}
export function parseConfig(raw: string): AppConfig { return normalizeConfig(parse(raw)); }
export function serializeConfig(config: AppConfig): string { return stringify(config as any); }
export function isLoopback(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
}
export function resolveBind(config: AppConfig, override = process.env.GOPHER_BIND): { host: string; port: number } {
  let { host, port } = config.ui;
  if (override?.trim()) {
    const match = override.trim().match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
    if (!match) throw new Error('Invalid bind address; use 127.0.0.1:3930 or [::1]:3930.');
    host = match[1] || match[2]!; port = Number(match[3]);
  }
  if (!isLoopback(host)) throw new Error('Gopher requires a loopback address.');
  if (!Number.isInteger(port) || port < (override?.trim() ? 0 : 1) || port > 65535) throw new Error('UI port must be between 1 and 65535 (or 0 for an ephemeral bind override).');
  return { host, port };
}
