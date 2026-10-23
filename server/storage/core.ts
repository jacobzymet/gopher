import { dirname, join, resolve } from 'node:path';
import { normalizeConfig, serializeConfig, type AppConfig, type Provider, type StorageMode } from '../config.js';
import { AAD, decryptValue, encryptValue, isEnvelope, type EncryptionMeta } from '../crypto.js';
import { Diagnostics } from '../diagnostics.js';
import { validateSkills, type UserSkill } from '../skills.js';
import { lockedError, StoreError } from './errors.js';
import { normalizeStore, objectValue, type ChatStore, type JsonObject } from './documents.js';
import { readJson, readPrivate, writeJson } from './secure-files.js';
import { readSkillFiles, writeSkillFiles } from './skill-files.js';
import { commitChanges, providerPayload, RollbackFailed, type FileChange } from './config-files.js';
import { DataLock } from './data-lock.js';
import { DocumentCache } from './document-cache.js';
import { releaseWindowsHelper, retainWindowsHelper, windowsHelperFailure } from './windows-helper.js';
import type { Transition } from './transition.js';

/**
 * Everything about the data folder except changing encryption (see app-storage.ts): reading and
 * writing chats, preferences, skills, configuration and diagnostics, the in-memory mode, the
 * decoded-document cache, locking and shutdown. All operations run one at a time in `serial`.
 */

const CONFIG_BYTES = 4 * 1024 * 1024;
const DIAGNOSTICS_BYTES = 32 * 1024 * 1024;
export interface LegacyProviders { providers: Provider[]; active_provider_id: string }

export class StorageCore {
  readonly root: string;
  readonly configPath: string;
  readonly diagnostics = new Diagnostics();
  config: AppConfig;
  protected key: Buffer | null = null;
  protected meta: EncryptionMeta | null = null;
  protected transition: Transition | null = null;
  protected securityError: Error | null = null;
  protected encryptionPresent = false;
  protected legacyProviders: LegacyProviders | null = null;
  protected memory = { chats: normalizeStore([]), preferences: {} as JsonObject, skills: [] as UserSkill[] };
  protected documents: DocumentCache;
  protected readonly dataLock: DataLock;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private helperLease = process.platform === 'win32';

  protected constructor(configPath: string, config: AppConfig) {
    this.configPath = resolve(configPath);
    this.root = dirname(this.configPath);
    this.config = config;
    this.dataLock = new DataLock(this.root);
    this.documents = new DocumentCache(this.root);
    if (this.helperLease) retainWindowsHelper();
  }

  get encrypted(): boolean { return this.encryptionPresent; }
  get unlocked(): boolean { return this.key !== null; }
  get transitionPending(): boolean { return this.transition !== null; }
  get storageMode(): StorageMode { return this.config.data.storage; }

  /** Release the data lock and this instance's share of the Windows helper. */
  protected async releaseResources(): Promise<void> {
    try { await this.dataLock.release(); }
    finally { if (this.helperLease) { this.helperLease = false; await releaseWindowsHelper(); } }
  }

  protected serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(() => {
      if (this.closed) throw new StoreError('Storage is closed.');
      return operation();
    });
    this.queue = work.catch(() => undefined);
    return work;
  }

  protected requireUnlocked(): void {
    const helperFailure = windowsHelperFailure();
    if (helperFailure) throw helperFailure;
    if (this.securityError) throw this.securityError;
    if (this.encrypted && (!this.key || this.transition)) throw lockedError();
  }

  /** Read a data file, decrypting it when it is an envelope. Encrypted folders refuse plaintext and missing files. */
  protected async decodeFile(name: string, aad: string, fallback: unknown, key = this.key,
    encrypted = this.encrypted): Promise<unknown> {
    if (encrypted && !key) throw lockedError();
    const value = await readJson(join(this.root, name));
    if (value === null) {
      if (encrypted) throw new StoreError(`Encrypted ${name} is missing. Restore the encrypted file from backup.`);
      return structuredClone(fallback);
    }
    if (isEnvelope(value)) { if (!key) throw lockedError(); return decryptValue(key, value, aad); }
    if (encrypted) {
      throw new StoreError(`Encrypted ${name} was replaced with plaintext. Restore the encrypted file from backup.`);
    }
    return value;
  }

  protected encodeFile(name: string, aad: string, value: unknown, key = this.key): Promise<void> {
    return writeJson(join(this.root, name), key ? encryptValue(key, value, aad) : value);
  }

  protected inMemory(): boolean { return this.storageMode !== 'disk'; }

  // ------------------------------------------------------------- chats and preferences

  private async sharedChats(): Promise<ChatStore> {
    this.requireUnlocked();
    if (this.inMemory()) return this.memory.chats;
    const empty = normalizeStore([]);
    const decode = async () => normalizeStore(await this.decodeFile('chats.json', AAD.chats, empty));
    return this.documents.read('chats.json', decode);
  }
  protected async chatsInternal(): Promise<ChatStore> { return structuredClone(await this.sharedChats()); }
  loadChats(): Promise<ChatStore> { return this.serial(() => this.chatsInternal()); }
  /** The current store without copying it; callers must treat the result as read-only. */
  readChats(): Promise<Readonly<ChatStore>> { return this.serial(() => this.sharedChats()); }

  async saveChats(value: unknown): Promise<void> {
    const normalized = normalizeStore(value);
    return this.serial(async () => {
      this.requireUnlocked();
      if (this.inMemory()) { this.memory.chats = normalized; return; }
      this.documents.forget('chats.json');
      await this.encodeFile('chats.json', AAD.chats, normalized);
      await this.documents.remember('chats.json', normalized);
    });
  }

  private async sharedPreferences(): Promise<JsonObject> {
    this.requireUnlocked();
    if (this.inMemory()) return this.memory.preferences;
    const decode = async () => objectValue(await this.decodeFile('preferences.json', AAD.preferences, {}));
    return this.documents.read('preferences.json', decode);
  }
  protected async preferencesInternal(): Promise<JsonObject> { return structuredClone(await this.sharedPreferences()); }
  loadPreferences(): Promise<JsonObject> { return this.serial(() => this.preferencesInternal()); }
  /** The current preferences without copying them; callers must treat the result as read-only. */
  readPreferences(): Promise<Readonly<JsonObject>> { return this.serial(() => this.sharedPreferences()); }

  async savePreferences(value: unknown): Promise<void> {
    const preferences = structuredClone(objectValue(value));
    return this.serial(async () => {
      this.requireUnlocked();
      if (this.inMemory()) this.memory.preferences = preferences;
      else {
        this.documents.forget('preferences.json');
        await this.encodeFile('preferences.json', AAD.preferences, preferences);
        await this.documents.remember('preferences.json', preferences);
      }
      this.diagnostics.configure(preferences.diagnosticsEnabled === true);
    });
  }

  // ------------------------------------------------------------- configuration

  /**
   * Write config.toml (and, when encrypted and unlocked, provider-tokens.json) for `config`.
   * Built-in OAuth credentials never reach plaintext. If a failed write cannot be rolled back the
   * session locks itself until restart, because the files may no longer agree.
   */
  protected async persistConfigInternal(config = this.config): Promise<void> {
    const publicConfig = structuredClone(config);
    const changes: FileChange[] = [];
    if (this.encrypted) {
      if (this.key && !this.transition) {
        const path = join(this.root, 'provider-tokens.json'), before = await readPrivate(path);
        const payload = providerPayload(config);
        const unchanged = before !== null
          && JSON.stringify(decryptValue(this.key, JSON.parse(before), AAD.providers)) === JSON.stringify(payload);
        const encrypted = `${JSON.stringify(encryptValue(this.key, payload, AAD.providers), null, 2)}\n`;
        if (!unchanged) changes.push({ path, before, after: encrypted });
        publicConfig.providers = [];
        publicConfig.active_provider_id = '';
      } else for (const provider of publicConfig.providers) provider.token = '';
    } else for (const provider of publicConfig.providers) if (provider.kind === 'openai-codex') provider.token = '';
    const before = await readPrivate(this.configPath, CONFIG_BYTES), after = serializeConfig(publicConfig);
    if (before !== after) changes.push({ path: this.configPath, before, after });
    try { await commitChanges(changes); }
    catch (error) {
      if (!(error instanceof RollbackFailed)) throw error;
      this.securityError = new StoreError('Configuration could not be saved or restored safely. Local data is '
        + 'locked. Restore access to the data directory, then restart Gopher before making further changes.',
        'config_recovery_required');
      this.lockInternal();
      throw this.securityError;
    }
  }

  async saveConfig(config = this.config): Promise<void> {
    const next = normalizeConfig(structuredClone(config));
    return this.serial(async () => {
      this.requireUnlocked();
      await this.persistConfigInternal(next);
      this.config = next;
    });
  }

  // ------------------------------------------------------------- skills

  protected async skillsInternal(key = this.key, encrypted = this.encrypted, useMemory = true): Promise<UserSkill[]> {
    if (encrypted && !key) throw lockedError();
    if (useMemory && this.inMemory()) return structuredClone(this.memory.skills);
    return readSkillFiles(this.root, key, encrypted);
  }

  protected async saveSkillsInternal(skills: UserSkill[], key = this.key): Promise<void> {
    validateSkills(skills);
    if (this.inMemory()) { this.memory.skills = structuredClone(skills); return; }
    await writeSkillFiles(this.root, skills, key);
  }

  // ------------------------------------------------------------- diagnostics

  /** Diagnostics are persisted only while encrypted; a failure to restore them never blocks startup. */
  protected async restoreDiagnostics(): Promise<void> {
    try {
      if (this.encrypted && !this.key) return;
      if (this.key) {
        const value = await readJson(join(this.root, 'diagnostics.json'), DIAGNOSTICS_BYTES);
        if (value !== null) {
          if (!isEnvelope(value)) throw new StoreError('Stored diagnostics must be encrypted.');
          this.diagnostics.restore(decryptValue(this.key, value, AAD.diagnostics));
        }
      }
      this.diagnostics.configure((await this.preferencesInternal()).diagnosticsEnabled === true);
    } catch (error) { this.diagnostics.restoreError(error); }
  }

  protected async flushDiagnosticsInternal(): Promise<void> {
    if (!this.key || this.transition || this.inMemory()) return;
    const pending = this.diagnostics.pending();
    if (!pending) return;
    try {
      await this.encodeFile('diagnostics.json', AAD.diagnostics, pending.value);
      this.diagnostics.saved(pending.revision);
    } catch (error) { this.diagnostics.error(error); throw error; }
  }

  // ------------------------------------------------------------- lock, storage mode, close

  /** Forget the key and every decrypted value; an encrypted session also drops provider settings. */
  protected lockInternal(): void {
    this.diagnostics.suspend();
    this.key?.fill(0);
    this.key = null;
    this.documents.clear();
    if (!this.encrypted) return;
    for (const provider of this.config.providers) provider.token = '';
    this.config.providers = [];
    this.config.active_provider_id = '';
    this.memory = { chats: normalizeStore([]), preferences: {}, skills: [] };
  }

  lock(): Promise<void> {
    return this.serial(async () => { try { await this.flushDiagnosticsInternal(); } finally { this.lockInternal(); } });
  }

  /** Switch between disk and memory-only storage, carrying the current data across. */
  setStorageMode(mode: StorageMode): Promise<void> {
    return this.serial(async () => {
      this.requireUnlocked();
      if (mode === 'browser') {
        throw new StoreError('Browser localStorage mode has been removed; local data is stored on disk.');
      }
      if (!['disk', 'memory'].includes(mode)) throw new StoreError('Invalid storage mode.');
      if (mode === this.storageMode) return;
      const chats = await this.chatsInternal();
      const preferences = await this.preferencesInternal();
      const skills = await this.skillsInternal();
      const previous = this.config.data.storage;
      this.documents.clear();
      this.config.data.storage = mode;
      try {
        if (mode === 'disk') {
          await this.encodeFile('chats.json', AAD.chats, chats);
          await this.encodeFile('preferences.json', AAD.preferences, preferences);
          await this.saveSkillsInternal(skills);
        } else this.memory = { chats, preferences, skills };
        await this.persistConfigInternal();
      } catch (error) { this.config.data.storage = previous; throw error; }
    });
  }

  dataInfo() {
    const visible = (path: string) => (this.encrypted && !this.unlocked ? '' : path);
    const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const openLabel = { windows: 'Open in File Explorer', macos: 'Open in Finder', linux: 'Open in Files' }[os];
    return {
      storage: this.storageMode, browser_storage: this.storageMode === 'browser', encryption_enabled: this.encrypted,
      encryption_unlocked: this.unlocked, encryption_transition_pending: this.transitionPending,
      data_dir: visible(this.root), config_path: visible(this.configPath),
      chats_path: visible(join(this.root, 'chats.json')),
      preferences_path: visible(join(this.root, 'preferences.json')),
      skills_dir: visible(join(this.root, 'chat-skills')),
      os, open_label: openLabel, error: (this.securityError || windowsHelperFailure())?.message || '',
    };
  }

  close(): Promise<void> {
    return this.serial(async () => {
      try { await this.flushDiagnosticsInternal(); }
      finally {
        this.lockInternal();
        this.legacyProviders = null;
        this.closed = true;
        await this.releaseResources();
      }
    });
  }
}
