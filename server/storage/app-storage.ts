import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultConfigPath, normalizeConfig, parseConfig, serializeConfig } from '../config.js';
import {
  AAD, createEncryption, decryptValue, deriveKey, encryptBytes, encryptValue, isEnvelope, validateMeta,
  validatePassphrase, verifyKey, type EncryptionMeta,
} from '../crypto.js';
import { validateSkills, type UserSkill } from '../skills.js';
import { StoreError } from './errors.js';
import { normalizeStore, objectValue } from './documents.js';
import {
  atomicWrite, inspect, protectDirectory, readJson, readPrivate, removePrivate, writeJson,
} from './secure-files.js';
import { providerPayload, restoreProviderPayload } from './config-files.js';
import {
  parseTransition, parseTransitionPayload, transitionAad, type Snapshot, type Transition, type TransitionOperation,
} from './transition.js';
import { windowsHelperFailure } from './windows-helper.js';
import { StorageRecords } from './records.js';

/**
 * The data folder, including the encryption lifecycle: Argon2id key derivation, unlock, the
 * journaled enable/disable transitions, and migration of folders encrypted by older versions
 * (which had no key verifier and could keep provider credentials in config.toml).
 */

const CONFIG_BYTES = 4 * 1024 * 1024;
const TRANSITION_BYTES = 64 * 1024 * 1024;
const META_BYTES = 64 * 1024;
const VERIFIER_TEXT = 'gopher-ok';

export class AppStorage extends StorageRecords {
  static async open(configPath = defaultConfigPath()): Promise<AppStorage> {
    const path = resolve(configPath);
    // Acquire the lease before loading configuration, so no concurrent writer can
    // race the read or security-state migration.
    const storage = new AppStorage(path, normalizeConfig({}));
    try {
      await protectDirectory(storage.root);
      await storage.dataLock.acquire();
      const raw = await readPrivate(path, CONFIG_BYTES);
      storage.config = raw === null ? normalizeConfig({}) : parseConfig(raw);
      storage.encryptionPresent = Boolean(await inspect(join(storage.root, 'encryption.json'))
        || await inspect(join(storage.root, 'encryption-transition.json')));
      if (storage.encryptionPresent) await storage.loadEncryptionState();
      else {
        await storage.persistConfigInternal();
        await storage.restoreDiagnostics();
      }
      return storage;
    } catch (error) {
      await storage.releaseResources();
      throw error;
    }
  }

  private async loadEncryptionState(): Promise<void> {
    this.legacyProviders = {
      providers: structuredClone(this.config.providers), active_provider_id: this.config.active_provider_id,
    };
    try {
      const record = await readJson(join(this.root, 'encryption-transition.json'), TRANSITION_BYTES);
      if (record) this.transition = parseTransition(record);
      const meta = await readJson(join(this.root, 'encryption.json'), META_BYTES);
      this.meta = meta ? validateMeta(meta) : null;
      if (!this.meta && !this.transition) throw new StoreError('Encryption metadata is missing.');
    } catch (error) { this.securityError = error instanceof Error ? error : new Error(String(error)); }
    // A credential may exist only in the private config until the first
    // verified unlock durably encrypts it. Preserve that recovery copy
    // across restarts and keep provider details out of the locked session.
    this.config.providers = [];
    this.config.active_provider_id = '';
  }

  /** Derive the key and prove it is right: by the verifier, or for old folders by decrypting a data file. */
  private async keyFor(passphrase: string, meta: EncryptionMeta): Promise<Buffer> {
    const key = await deriveKey(passphrase, meta);
    try {
      if (meta.verifier) verifyKey(key, meta);
      else {
        let proven = false;
        for (const [filename, aad] of [['chats.json', AAD.chats], ['preferences.json', AAD.preferences]] as const) {
          const value = await readJson(join(this.root, filename));
          if (isEnvelope(value)) { decryptValue(key, value, aad); proven = true; break; }
        }
        if (!proven) {
          throw new StoreError('Encrypted data has no key verifier and no authenticated encrypted files. '
            + 'Restore a backup.');
        }
      }
      return key;
    } catch (error) { key.fill(0); throw error; }
  }

  /** Finish a journaled transition left by a crash. Returns false when none is pending. */
  private async resumePending(passphrase: string, expected?: TransitionOperation): Promise<boolean> {
    if (!this.transition) return false;
    const record = this.transition;
    if (expected && record.operation !== expected) {
      throw new StoreError(`A pending ${record.operation} encryption transition must be recovered first.`);
    }
    const key = await deriveKey(passphrase, record.meta);
    try {
      verifyKey(key, record.meta);
      const payload = parseTransitionPayload(decryptValue<unknown>(key, record.payload, transitionAad(record)), record);
      await this.applyTransition(record, payload.snapshot, key);
      return true;
    } catch (error) { key.fill(0); this.lockInternal(); throw error; }
  }

  private restoreLegacyProviders(): void {
    if (!this.legacyProviders || this.config.providers.some(provider => provider.kind === 'custom')) return;
    this.config.providers = structuredClone(this.legacyProviders.providers);
    this.config.active_provider_id = this.legacyProviders.active_provider_id;
  }

  unlock(passphrase: string): Promise<void> {
    return this.serial(async () => {
      const helperFailure = windowsHelperFailure();
      if (helperFailure) throw helperFailure;
      if (this.securityError) throw this.securityError;
      try {
        if (await this.resumePending(passphrase)) return;
        if (!this.meta) throw new StoreError('Disk encryption is not enabled.');
        const meta = this.meta;
        const key = await this.keyFor(passphrase, meta);
        try { await this.completeUnlock(key, meta); } catch (error) { key.fill(0); throw error; }
      } catch (error) { this.lockInternal(); throw error; }
    });
  }

  private async completeUnlock(key: Buffer, meta: EncryptionMeta): Promise<void> {
    // Validating the key decrypts both documents; keep them so the first reads are instant.
    this.documents.clear();
    await this.documents.decode('chats.json',
      async () => normalizeStore(await this.decodeFile('chats.json', AAD.chats, null, key, true)));
    await this.documents.decode('preferences.json',
      async () => objectValue(await this.decodeFile('preferences.json', AAD.preferences, null, key, true)));
    const legacy = !meta.verifier;
    this.restoreLegacyProviders();
    let payload = await readJson(join(this.root, 'provider-tokens.json'));
    if (payload === null && legacy) payload = providerPayload(this.config);
    else {
      if (!isEnvelope(payload)) throw new StoreError('Encrypted provider configuration is missing or invalid.');
      payload = decryptValue(key, payload, AAD.providers);
    }
    restoreProviderPayload(this.config, payload);
    let skills: UserSkill[];
    try { skills = await this.skillsInternal(key, true); }
    catch (error) { if (!legacy) throw error; skills = await this.skillsInternal(null, false); }
    await this.saveSkillsInternal(skills, key);
    // Commit recovered provider credentials before adding a verifier. A
    // crash during migration must retain the legacy recovery allowance
    // until every required encrypted file exists durably.
    await this.encodeFile('provider-tokens.json', AAD.providers, providerPayload(this.config), key);
    if (legacy) {
      this.meta = { ...meta, version: 2, verifier: encryptBytes(key, Buffer.from(VERIFIER_TEXT), AAD.verifier) };
      await writeJson(join(this.root, 'encryption.json'), this.meta);
    }
    this.key?.fill(0);
    this.key = key;
    await this.persistConfigInternal();
    this.legacyProviders = null;
    await this.restoreDiagnostics();
  }

  /** Journal the complete new state, then apply it. */
  private async stage(operation: TransitionOperation, meta: EncryptionMeta, key: Buffer,
    snapshot: Snapshot): Promise<void> {
    if (this.transition) throw new StoreError('An encryption transition is already pending.');
    verifyKey(key, meta);
    const transactionId = randomBytes(16).toString('base64url');
    const record: Transition = { version: 1, transaction_id: transactionId, operation, meta, payload: null };
    record.payload = encryptValue(key, { transaction_id: transactionId, operation, snapshot }, transitionAad(record));
    const raw = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(raw) > TRANSITION_BYTES) {
      throw new StoreError('Encryption transition is too large to stage safely.');
    }
    await atomicWrite(join(this.root, 'encryption-transition.json'), raw + '\n');
    this.transition = record;
    // Enabling protection is an authenticated transition within the existing
    // session. Keep that session unlocked while its durable snapshot applies;
    // otherwise a concurrent state poll incorrectly revokes the browser's live
    // state between writing the journal and completing the protected files.
    // The pending journal still gates operations, and serial() queues all data
    // access until this transaction finishes. A separate copy is wiped when the
    // committed key replaces it or when applyTransition fails.
    if (operation === 'enable') { this.key?.fill(0); this.key = Buffer.from(key); }
    this.encryptionPresent = true;
    await this.applyTransition(record, snapshot, key, false);
  }

  private async applyTransition(record: Transition, snapshot: Snapshot, key: Buffer,
    restoreDiagnostics = true): Promise<void> {
    this.documents.clear();
    try {
      const chats = normalizeStore(snapshot.chats), preferences = objectValue(snapshot.preferences);
      const skills = validateSkills(snapshot.skills);
      restoreProviderPayload(this.config, snapshot.provider_tokens);
      // Transitions always commit a durable disk snapshot, even from memory mode.
      this.config.data.storage = 'disk';
      if (record.operation === 'enable') await this.writeEncrypted(record, snapshot, key, chats, preferences, skills);
      else await this.writePlaintext(chats, preferences, skills, key);
      // A local toggle retains the live buffer and its generation. Replacing it
      // would discard entries produced during key derivation and invalidate the
      // browser's incremental diagnostics cursor despite retaining the same IDs.
      if (restoreDiagnostics) {
        try { this.diagnostics.restore(snapshot.diagnostics ?? null); }
        catch (error) { this.diagnostics.restoreError(error); this.diagnostics.configure(false); return; }
      }
      this.diagnostics.configure(preferences.diagnosticsEnabled === true);
    } catch (error) { key.fill(0); this.lockInternal(); throw error; }
  }

  private async writeEncrypted(record: Transition, snapshot: Snapshot, key: Buffer, chats: unknown,
    preferences: unknown, skills: UserSkill[]): Promise<void> {
    const publicConfig = { ...this.config, providers: [], active_provider_id: '' };
    await atomicWrite(this.configPath, serializeConfig(publicConfig));
    await this.encodeFile('chats.json', AAD.chats, chats, key);
    await this.encodeFile('preferences.json', AAD.preferences, preferences, key);
    await this.encodeFile('diagnostics.json', AAD.diagnostics, snapshot.diagnostics ?? null, key);
    await this.encodeFile('provider-tokens.json', AAD.providers, snapshot.provider_tokens, key);
    await this.saveSkillsInternal(skills, key);
    await writeJson(join(this.root, 'encryption.json'), record.meta);
    await removePrivate(join(this.root, 'encryption-transition.json'));
    this.meta = record.meta;
    this.transition = null;
    this.key?.fill(0);
    this.key = key;
    this.encryptionPresent = true;
  }

  private async writePlaintext(chats: unknown, preferences: unknown, skills: UserSkill[], key: Buffer): Promise<void> {
    await this.encodeFile('chats.json', AAD.chats, chats, null);
    await this.encodeFile('preferences.json', AAD.preferences, preferences, null);
    await removePrivate(join(this.root, 'diagnostics.json'));
    await this.saveSkillsInternal(skills, null);
    // Built-in OAuth credentials require encryption and must never be copied
    // into plaintext config when protection is disabled.
    for (const provider of this.config.providers) if (provider.kind === 'openai-codex') provider.token = '';
    await atomicWrite(this.configPath, serializeConfig(this.config));
    await removePrivate(join(this.root, 'provider-tokens.json'));
    await removePrivate(join(this.root, 'encryption.json'));
    await removePrivate(join(this.root, 'encryption-transition.json'));
    this.meta = null;
    this.transition = null;
    this.key?.fill(0);
    this.key = null;
    key.fill(0);
    this.encryptionPresent = false;
  }

  enableEncryption(passphrase: string, confirm = passphrase): Promise<void> {
    return this.serial(async () => {
      if (passphrase !== confirm) throw new StoreError('Passphrases do not match.');
      validatePassphrase(passphrase);
      if (this.securityError) throw this.securityError;
      if (await this.resumePending(passphrase, 'enable')) return;
      if (this.encrypted) throw new StoreError('Disk encryption is already enabled.');
      const snapshot: Snapshot = {
        chats: await this.chatsInternal(), preferences: await this.preferencesInternal(),
        provider_tokens: providerPayload(this.config), skills: await this.skillsInternal(),
        diagnostics: this.diagnostics.stored(),
      };
      const { key, meta } = await createEncryption(passphrase);
      try { await this.stage('enable', meta, key, snapshot); } catch (error) { key.fill(0); throw error; }
    });
  }

  disableEncryption(passphrase: string): Promise<void> {
    return this.serial(async () => {
      if (this.securityError) throw this.securityError;
      if (await this.resumePending(passphrase, 'disable')) return;
      if (!this.meta) throw new StoreError('Disk encryption is not enabled.');
      const meta = this.meta;
      const key = await this.keyFor(passphrase, meta);
      try {
        const legacy = !meta.verifier;
        this.restoreLegacyProviders();
        let providers: unknown;
        const tokensMissing = !(await inspect(join(this.root, 'provider-tokens.json')));
        if (legacy && tokensMissing) providers = providerPayload(this.config);
        else providers = await this.decodeFile('provider-tokens.json', AAD.providers, null, key, true);
        const useLiveData = this.unlocked;
        let skills: UserSkill[];
        try { skills = await this.skillsInternal(key, true, useLiveData); }
        catch (error) { if (!legacy) throw error; skills = await this.skillsInternal(null, false, useLiveData); }
        // An unlocked memory session owns the current edits. A locked session has
        // cleared that volatile state and must recover the authenticated disk copy.
        const chats = useLiveData ? await this.chatsInternal()
          : normalizeStore(await this.decodeFile('chats.json', AAD.chats, null, key, true));
        const preferences = useLiveData ? await this.preferencesInternal()
          : objectValue(await this.decodeFile('preferences.json', AAD.preferences, null, key, true));
        const diagnostics = this.diagnostics.stored();
        const snapshot: Snapshot = { chats, preferences, provider_tokens: providers, skills, diagnostics };
        const verifier = () => encryptBytes(key, Buffer.from(VERIFIER_TEXT), AAD.verifier);
        const staged = legacy ? { ...meta, version: 2, verifier: verifier() } : meta;
        await this.stage('disable', staged, key, snapshot);
        this.legacyProviders = null;
      } catch (error) { key.fill(0); throw error; }
    });
  }
}
