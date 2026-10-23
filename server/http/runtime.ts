import type { ServerResponse } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { AppStorage } from '../storage.js';
import type { Providers, ModelOption, ProviderHealth } from '../providers.js';
import type { Engine } from '../engine.js';
import type { TerminalManager } from '../terminal.js';
import type { AppConfig } from '../config.js';
import { buildVersion } from '../updates.js';
import { sendJson } from './protocol.js';

/**
 * State shared by every request of one running app: the model catalog and provider health, the
 * session generation that invalidates in-flight work when data locks, and the ChatGPT sign-in.
 */

const CATALOG_TTL_MS = 60_000;
const LOCKED_APPEARANCE = {
  theme: 'dark', font_body: 'inter', font_display: 'space-grotesk', font_mono: 'jetbrains-mono', font_scale: 'default',
};

export type HealthEntry = Omit<Partial<ProviderHealth>, 'kind'> & {
  ok: boolean; kind: string; status?: string; models?: number;
};
export type DeviceStatus = {
  status: 'idle' | 'pending' | 'ready' | 'error'; user_code?: string; verification_url?: string; error?: string;
};
export interface Bind { host: string; port: number }

export class AppRuntime {
  /** Incremented when data locks; requests and background work from an older generation must stop. */
  generation = 0;
  disposed = false;
  port: number;
  readonly streams = new Set<ServerResponse>();
  readonly protectedResponses = new Set<ServerResponse>();
  signInCancel: (() => void) | undefined;
  deviceTimer: NodeJS.Timeout | undefined;
  deviceStatus: DeviceStatus = { status: 'idle' };
  private catalog: ModelOption[] = [];
  private catalogBusy = false;
  private warmAgain = false;
  private catalogReady = false;
  private catalogAt = 0;
  /** Incremented whenever providers change, so a catalog fetched for old settings is discarded. */
  private providerRevision = 0;
  private readonly health = new Map<string, HealthEntry>();

  constructor(
    readonly storage: AppStorage, readonly providers: Providers, readonly engine: Engine,
    readonly terminals: TerminalManager, readonly sockets: WebSocketServer, readonly token: string, readonly bind: Bind,
  ) { this.port = bind.port; }

  get locked(): boolean { return this.storage.encrypted && !this.storage.unlocked; }
  /** The listening address as `host:port`, with IPv6 hosts bracketed. */
  get authority(): string {
    const host = this.bind.host.includes(':') ? `[${this.bind.host}]` : this.bind.host;
    return `${host}:${this.port}`;
  }

  providersChanged(): void { this.providerRevision++; }
  setHealth(id: string, health: HealthEntry): void { this.health.set(id, health); }

  /** Refresh the model catalog in the background; at most one refresh runs, and a forced one queues behind it. */
  async warm(force = false): Promise<void> {
    if (this.disposed || this.locked) return;
    if (force) { this.catalogAt = 0; this.catalogReady = false; }
    if (this.catalogBusy) { if (force) this.warmAgain = true; return; }
    if (!force && this.catalogAt && Date.now() - this.catalogAt < CATALOG_TTL_MS) return;
    this.catalogBusy = true;
    const generation = this.generation, revision = this.providerRevision;
    try {
      const refreshed = await this.providers.catalog(force);
      if (this.disposed || generation !== this.generation || this.locked) return;
      if (revision !== this.providerRevision) { this.warmAgain = true; return; }
      this.catalog = refreshed;
      for (const provider of this.storage.config.providers) {
        const models = this.catalog.filter(model => model.provider_id === provider.id && !model.connect_kind);
        const previous = this.providers.cachedHealth(provider.id) || this.health.get(provider.id);
        if (models.length) {
          const ready = { ok: true, kind: 'ready', status: 'ready', model: models[0]!.model, models: models.length };
          this.health.set(provider.id, ready);
        } else {
          const disconnected = provider.kind === 'openai-codex' && !provider.token;
          const empty = { ok: false, kind: disconnected ? 'disconnected' : 'empty', status: 'No models available' };
          this.health.set(provider.id, previous || empty);
        }
      }
      this.catalogAt = Date.now();
      this.catalogReady = true;
    } catch (error) {
      const entry = { level: 'error', event: 'models.refresh.error', data: { error: String(error) } };
      this.storage.diagnostics.push('server', entry);
    } finally {
      this.catalogBusy = false;
      if (this.warmAgain && !this.disposed) { this.warmAgain = false; void this.warm(true); }
    }
  }

  publicProviders() {
    const { providers, active_provider_id: active } = this.storage.config;
    return providers.map(provider => ({
      id: provider.id, name: provider.name, base: provider.base, kind: provider.kind,
      builtin: provider.kind !== 'custom', api_style: provider.api_style,
      allow_insecure_tls: provider.allow_insecure_tls, active: provider.id === active,
      token_set: Boolean(provider.token), token_masked: provider.token ? '••••••••' : '',
      health: this.health.get(provider.id) || null,
    }));
  }

  /** The client's view of the app. While locked it reveals nothing beyond the version and lock state. */
  state() {
    const locked = this.locked;
    const remotes = locked ? [] : this.publicProviders();
    const config = this.storage.config;
    const active = locked ? undefined : config.providers.find(provider => provider.id === config.active_provider_id);
    const activeHealth = active ? this.health.get(active.id) : undefined;
    const models = locked ? [] : this.catalog;
    const pending = !locked && !this.catalogReady && this.catalogBusy;
    return {
      version: buildVersion(), ...(locked ? LOCKED_APPEARANCE : config.ui),
      thinking_supported: models.some(model => model.thinking_supported || model.reasoning_supported),
      encryption_enabled: this.storage.encrypted, encryption_unlocked: this.storage.unlocked,
      config_path: locked ? '' : this.storage.configPath, providers: remotes,
      live_turns: locked ? [] : this.engine.liveTurns(),
      network: {
        via_remote: !locked && Boolean(active), remote_base: active?.base || '',
        remote_label: active?.base.replace(/^https?:\/\//, '') || '', remote_name: active?.name || '',
        active_remote_id: active?.id || '', remote_count: remotes.length, remote_saved: Boolean(active),
        remote_ok: Boolean(activeHealth?.ok
          || models.some(model => model.provider_id === active?.id && !model.connect_kind)),
        remote_checking: pending, remote_catalog_pending: pending,
        remote_kind: activeHealth?.kind || (this.catalogBusy ? 'checking' : null),
        remote_error: activeHealth?.error || null,
        remote_model: activeHealth?.model || models.find(model => !model.connect_kind)?.model || null,
        remote_status: activeHealth?.status || null, remote_models: models, remotes,
        inference_mode: locked ? 'locked' : active ? 'remote' : 'local',
      },
    };
  }

  providerResponse() { return { providers: this.publicProviders(), state: this.state() }; }

  /** Change the configuration through a copy, persist it, and refresh the catalog for the new providers. */
  async updateConfig(change: (next: AppConfig) => void, providers = true): Promise<void> {
    const next = structuredClone(this.storage.config);
    change(next);
    await this.storage.saveConfig(next);
    if (!providers) return;
    this.providersChanged();
    await this.warm(true);
  }

  /** End everything tied to the unlocked session: responses, live turns, terminals, sockets, sign-in. */
  async revoke(): Promise<void> {
    this.generation++;
    this.providers.clear();
    this.signInCancel?.();
    this.signInCancel = undefined;
    clearTimeout(this.deviceTimer);
    this.deviceTimer = undefined;
    this.deviceStatus = { status: 'idle' };
    for (const response of this.protectedResponses) {
      if (!response.headersSent) sendJson(response, { error: 'Session was locked.', code: 'encrypted_locked' }, 423);
      else response.end();
    }
    this.protectedResponses.clear();
    await this.engine.cancelAll();
    await this.terminals.closeAll();
    for (const socket of this.sockets.clients) socket.close(1008, 'Session locked');
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    this.catalog = [];
    this.catalogAt = 0;
    this.catalogReady = false;
    this.health.clear();
  }
}
