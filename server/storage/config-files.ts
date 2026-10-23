import { normalizeProviders, type AppConfig } from '../config.js';
import { StoreError } from './errors.js';
import { isObject } from './documents.js';
import { atomicWrite, readPrivate, removePrivate } from './secure-files.js';

/**
 * Provider settings live in plaintext `config.toml` without encryption, and in the encrypted
 * `provider-tokens.json` with it. Several files may change together; a failed write rolls back
 * the ones already written.
 */

export interface ProviderPayload {
  version: 2; provider_config: { providers: AppConfig['providers']; active_provider_id: string };
}

export function providerPayload(config: AppConfig): ProviderPayload {
  const { providers, active_provider_id } = config;
  return { version: 2, provider_config: { providers, active_provider_id } };
}

/**
 * Apply a decrypted provider payload. Current payloads carry the provider list; the oldest
 * payloads only map provider ids to tokens for providers already in the config.
 */
export function restoreProviderPayload(config: AppConfig, payload: unknown): void {
  if (isObject(payload) && payload.provider_config) {
    const raw = payload.provider_config;
    const list = isObject(raw) ? raw.providers ?? raw.items ?? raw.remotes : undefined;
    if (!isObject(raw) || !Array.isArray(list)) throw new StoreError('Invalid encrypted provider configuration.');
    const active = raw.active_provider_id ?? raw.active_remote_id ?? '';
    const normalized = normalizeProviders(list, typeof active === 'string' ? active : '');
    config.providers = normalized.providers;
    config.active_provider_id = normalized.active_provider_id;
    return;
  }
  if (!isObject(payload)) throw new StoreError('Invalid encrypted provider payload.');
  for (const provider of config.providers) {
    const token = payload[provider.id];
    if (!provider.token && typeof token === 'string') provider.token = token;
  }
}

export interface FileChange { path: string; before: string | null; after: string }

/** Thrown when a failed multi-file write could not be undone; the caller must lock the session. */
export class RollbackFailed extends Error {
  constructor(readonly original: unknown) {
    super('Configuration could not be saved or restored safely.');
  }
}

export async function commitChanges(changes: FileChange[]): Promise<void> {
  const attempted: FileChange[] = [];
  try {
    for (const change of changes) {
      attempted.push(change);
      await atomicWrite(change.path, change.after);
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const change of attempted.reverse()) {
      try {
        if (await readPrivate(change.path) === change.before) continue;
        if (change.before === null) await removePrivate(change.path);
        else await atomicWrite(change.path, change.before);
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new RollbackFailed(error);
    throw error;
  }
}
