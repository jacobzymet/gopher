import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { type AppConfig, type Provider, type StorageMode, defaultConfigPath, normalizeConfig, normalizeProviders, parseConfig, serializeConfig } from './config.js';
import { AAD, createEncryption, decryptValue, deriveKey, encryptBytes, encryptValue, isEnvelope, validateMeta, validatePassphrase, verifyKey, type EncryptionMeta } from './crypto.js';
import { Diagnostics } from './diagnostics.js';
import { isSafeSkillId, MAX_SKILLS, parseSkillMarkdown, upsertSkill, validateSkills, type SkillUpsert, type UserSkill } from './skills.js';

export type JsonObject = Record<string, any>;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
type WindowsOperation = 'protect-directory' | 'protect-file' | 'replace' | 'acquire-lock' | 'release-lock';
interface WindowsRequest { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
let windowsHelper: ChildProcessWithoutNullStreams | undefined;
let windowsHelperUsers = 0;
let windowsHelperFailure: Error | null = null;
let windowsHelperId = 0;
const windowsRequests = new Map<number, WindowsRequest>();
const privateWindowsFiles = new Map<string, string>();
const windowsScript = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GopherPrivateFiles { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool MoveFileExW(string source,string destination,int flags); }'
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$locks=@{}
try {
while($null -ne ($line=[Console]::ReadLine())) {
  $request=$null
  try {
    $request=ConvertFrom-Json -InputObject $line
    if($request.operation -eq 'acquire-lock') {
      $locks[$request.source]=[IO.File]::Open($request.path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    } elseif($request.operation -eq 'release-lock') {
      if($locks.ContainsKey($request.source)){$locks[$request.source].Dispose();$locks.Remove($request.source)}
    } elseif($request.operation -eq 'replace') {
      if(-not [GopherPrivateFiles]::MoveFileExW($request.source,$request.path,9)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
    } else {
      if($request.operation -eq 'protect-directory') {
        $acl=[Security.AccessControl.DirectorySecurity]::new()
        foreach($sid in @($user,$system)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
        $item=[IO.DirectoryInfo]::new($request.path)
      } elseif($request.operation -eq 'protect-file') {
        $acl=[Security.AccessControl.FileSecurity]::new()
        foreach($sid in @($user,$system)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))}
        $item=[IO.FileInfo]::new($request.path)
      } else {throw 'Unknown filesystem operation'}
      $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($user);$item.SetAccessControl($acl)
    }
    [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{id=$request.id;ok=$true}))
  } catch { [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{id=$request.id;ok=$false})) }
}
} finally { foreach($handle in $locks.Values){$handle.Dispose()};$locks.Clear() }`;
function windowsPrivateOperation(operation: WindowsOperation, path: string, source?: string): Promise<void> {
  if (windowsHelperFailure) return Promise.reject(windowsHelperFailure);
  if (!windowsHelper) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') } });
    windowsHelper = helper;
    let output = '';
    const fail = () => {
      if (windowsHelper !== helper) return;
      windowsHelper = undefined;
      windowsHelperFailure = new StoreError('The private Windows filesystem helper stopped. Restart Gopher before accessing local data.');
      for (const pending of windowsRequests.values()) { clearTimeout(pending.timer); pending.reject(windowsHelperFailure); }
      windowsRequests.clear(); privateWindowsFiles.clear(); helper.kill();
    };
    helper.on('error', fail); helper.on('exit', fail); helper.stdin.on('error', fail);
    helper.stderr.resume();
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk: string) => {
      output += chunk;
      let boundary: number;
      while ((boundary = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, boundary).trim(); output = output.slice(boundary + 1);
        let reply: { id: number; ok: boolean };
        try { reply = JSON.parse(line); } catch { continue; }
        const pending = windowsRequests.get(reply.id); if (!pending) continue;
        windowsRequests.delete(reply.id); clearTimeout(pending.timer);
        if (reply.ok) pending.resolve(); else pending.reject(new StoreError('Could not secure or durably replace local data. Choose a directory owned by your Windows user, or restore its permissions.'));
      }
      if (!windowsRequests.size) {
        helper.unref();
        for (const pipe of [helper.stdin, helper.stdout, helper.stderr]) (pipe as unknown as { unref?: () => void }).unref?.();
      }
    });
  }
  const helper = windowsHelper;
  helper.ref();
  for (const pipe of [helper.stdin, helper.stdout, helper.stderr]) (pipe as unknown as { ref?: () => void }).ref?.();
  return new Promise<void>((resolve, reject) => {
    const id = ++windowsHelperId;
    const timer = setTimeout(() => { if (windowsRequests.has(id)) { helper.kill(); } }, 15000);
    windowsRequests.set(id, { resolve, reject, timer });
    helper.stdin.write(JSON.stringify({ id, operation, path, source }) + '\n');
  });
}
async function protectWindowsFile(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const info = await lstat(path), stamp = `${info.dev}:${info.ino}:${info.ctimeMs}`;
  if (privateWindowsFiles.get(path) === stamp) return;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new StoreError('Refusing unsafe file permissions change.');
  await windowsPrivateOperation('protect-file', path);
  const secured = await lstat(path);
  privateWindowsFiles.set(path, `${secured.dev}:${secured.ino}:${secured.ctimeMs}`);
}
async function releaseWindowsHelper(): Promise<void> {
  if (process.platform !== 'win32' || --windowsHelperUsers > 0) return;
  windowsHelperFailure = null;
  if (!windowsHelper) return;
  const helper = windowsHelper; windowsHelper = undefined; privateWindowsFiles.clear();
  helper.ref();
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { helper.kill(); resolve(); }, 3000); timer.unref();
    helper.once('exit', () => { clearTimeout(timer); resolve(); });
    helper.stdin.end();
  });
}
type NativeFlock = (fd: number, operation: 'exnb', callback: (error: NodeJS.ErrnoException | null) => void) => void;
let nativeFlock: NativeFlock | undefined;
function flockExclusive(fd: number): Promise<void> {
  if (!nativeFlock) {
    try { nativeFlock = (createRequire(import.meta.url)('fs-ext') as { flock: NativeFlock }).flock; }
    catch { throw new StoreError('The native fs-ext addon is required for safe data locking on Linux and macOS. Install your platform build tools, then run npm rebuild fs-ext (or reinstall dependencies with optional dependencies enabled).'); }
    if (typeof nativeFlock !== 'function') throw new StoreError('The native fs-ext addon is incompatible. Reinstall fs-ext before starting Gopher.');
  }
  return new Promise<void>((resolve, reject) => nativeFlock!(fd, 'exnb', error => error ? reject(error) : resolve()));
}
export class StoreError extends Error {
  constructor(message: string, readonly code = 'store_error') { super(message); this.name = 'StoreError'; }
}
const locked = () => new StoreError('Local data is encrypted. Unlock with your passphrase to continue.', 'encrypted_locked');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function inspect(path: string) { try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; } }
async function rejectLinks(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const info = await inspect(current);
    if (info?.isSymbolicLink()) throw new StoreError(`Refusing linked data path: ${current}`);
    if (process.platform !== 'win32' || dirname(current) === current) break;
    current = dirname(current);
  }
}
async function protectDirectory(path: string): Promise<void> {
  await rejectLinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreError(`Unsafe data directory: ${path}`);
  if (process.platform !== 'win32') { await chmod(path, 0o700); return; }
  await windowsPrivateOperation('protect-directory', path);
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function readPrivate(path: string, limit = MAX_FILE_BYTES): Promise<string | null> {
  await rejectLinks(dirname(path));
  await rejectLinks(path);
  const before = await inspect(path);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new StoreError(`Unsafe data file: ${path}`);
  await protectWindowsFile(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual = await handle.stat();
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.nlink !== 1 || actual.size > limit) throw new StoreError(`Unsafe or oversized data file: ${path}`);
    if (process.platform !== 'win32') await handle.chmod(0o600);
    const buffer = Buffer.alloc(Math.min(actual.size, limit) + 1);
    let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > limit || length > actual.size) throw new StoreError(`Data file changed or exceeds its size limit: ${path}`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw new StoreError(`Data file is not valid UTF-8: ${path}`); }
    finally { buffer.fill(0); }
  } finally { await handle.close(); }
}
async function assertDestination(path: string): Promise<void> {
  await rejectLinks(path);
  const info = await inspect(path);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new StoreError(`Unsafe data file: ${path}`);
}
export async function atomicWrite(path: string, raw: string): Promise<void> {
  const directory = dirname(path);
  await rejectLinks(directory);
  if (!(await inspect(directory))) await protectDirectory(directory);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory()) throw new StoreError(`Unsafe destination directory: ${directory}`);
  await assertDestination(path);
  const temporary = join(directory, `.${randomBytes(16).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await protectWindowsFile(temporary);
    await handle.writeFile(raw, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    await assertDestination(path);
    if (process.platform === 'win32') await windowsPrivateOperation('replace', path, temporary);
    else await rename(temporary, path);
    privateWindowsFiles.delete(temporary); privateWindowsFiles.delete(path);
    await syncDirectory(directory);
  } catch (error) { await handle?.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); throw error; }
}
async function removePrivate(path: string): Promise<void> {
  await assertDestination(path);
  try { await unlink(path); await syncDirectory(dirname(path)); } catch (error) { if (!missing(error)) throw error; }
}
async function readJson(path: string, limit?: number): Promise<any | null> {
  const raw = await readPrivate(path, limit);
  if (raw === null) return null;
  if (!raw.trim()) throw new StoreError(`Empty JSON file: ${path}`);
  try { const value = JSON.parse(raw); if (value === null) throw new Error('Unexpected null document.'); return value; }
  catch { throw new StoreError(`Invalid JSON file: ${path}`); }
}
const writeJson = (path: string, value: unknown) => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
export function normalizeStore(raw: unknown): JsonObject {
  let value: JsonObject;
  if (Array.isArray(raw)) value = { version: 2, projects: [], conversations: raw, bots: [] };
  else if (raw && typeof raw === 'object') value = structuredClone(raw as JsonObject);
  else throw new StoreError('Store must be a JSON object or a legacy conversations array.');
  const normalizeArrays = (container: JsonObject) => {
    for (const name of ['projects', 'conversations', 'bots']) {
      if (container[name] === undefined) container[name] = [];
      if (!Array.isArray(container[name])) throw new StoreError('Store must include projects, conversations, and bots arrays.');
    }
  };
  if ('profiles' in value) {
    if (!Array.isArray(value.profiles)) throw new StoreError('Profiles must be a JSON array.');
    for (const profile of value.profiles) { if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new StoreError('Each profile must be a JSON object.'); normalizeArrays(profile); }
    value.version = 3;
  } else { normalizeArrays(value); value.version ??= 2; }
  return value;
}
const objectValue = (value: unknown): JsonObject => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('Preferences must be a JSON object.'); return value as JsonObject; };
interface Snapshot { chats: JsonObject; preferences: JsonObject; provider_tokens: unknown; skills: UserSkill[]; diagnostics?: unknown }
interface Transition { version: number; transaction_id: string; operation: 'enable' | 'disable'; meta: EncryptionMeta; payload: unknown }
const transitionAad = (record: Transition) => `${AAD.transition}:${record.operation}:${record.transaction_id}`;

export class AppStorage {
  readonly root: string;
  readonly configPath: string;
  readonly diagnostics = new Diagnostics();
  config: AppConfig;
  private key: Buffer | null = null;
  private meta: EncryptionMeta | null = null;
  private transition: Transition | null = null;
  private securityError: Error | null = null;
  private encryptionPresent = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lockHandle: FileHandle | null = null;
  private lockToken = randomBytes(16).toString('hex');
  private windowsLock = false;
  private closed = false;
  private helperLease = process.platform === 'win32';
  private memory = { chats: normalizeStore([]), preferences: {} as JsonObject, skills: [] as UserSkill[] };
  private legacyProviders: { providers: Provider[]; active_provider_id: string } | null = null;
  private constructor(configPath: string, config: AppConfig) { this.configPath = resolve(configPath); this.root = dirname(this.configPath); this.config = config; if (this.helperLease) windowsHelperUsers++; }
  static async open(configPath = defaultConfigPath()): Promise<AppStorage> {
    const path = resolve(configPath);
    // Acquire the lease before loading configuration, so no concurrent writer can
    // race the read or security-state migration.
    const storage = new AppStorage(path, normalizeConfig({}));
    try {
      await protectDirectory(dirname(path));
      await storage.acquire();
      const raw = await readPrivate(path, 4 * 1024 * 1024);
      storage.config = raw === null ? normalizeConfig({}) : parseConfig(raw);
      storage.encryptionPresent = !!await inspect(join(storage.root, 'encryption.json')) || !!await inspect(join(storage.root, 'encryption-transition.json'));
      if (storage.encryptionPresent) {
        storage.legacyProviders = { providers: structuredClone(storage.config.providers), active_provider_id: storage.config.active_provider_id };
        try {
          const record = await readJson(join(storage.root, 'encryption-transition.json'), 64 * 1024 * 1024);
          if (record) {
            if (record.version !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(record.transaction_id) || !['enable', 'disable'].includes(record.operation)) throw new StoreError('Invalid encryption transition.');
            record.meta = validateMeta(record.meta); storage.transition = record;
          }
          const meta = await readJson(join(storage.root, 'encryption.json'), 64 * 1024);
          storage.meta = meta ? validateMeta(meta) : null;
          if (!storage.meta && !storage.transition) throw new StoreError('Encryption metadata is missing.');
        } catch (error) { storage.securityError = error instanceof Error ? error : new Error(String(error)); }
        // A credential may exist only in the private config until the first
        // verified unlock durably encrypts it. Preserve that recovery copy
        // across restarts and keep provider details out of the locked session.
        storage.config.providers = []; storage.config.active_provider_id = '';
      } else {
        await storage.persistConfigInternal();
        await storage.restoreDiagnostics();
      }
      return storage;
    } catch (error) { try { await storage.release(); } finally { if (storage.helperLease) { storage.helperLease = false; await releaseWindowsHelper(); } } throw error; }
  }
  get encrypted(): boolean { return this.encryptionPresent; }
  get unlocked(): boolean { return this.key !== null; }
  get transitionPending(): boolean { return this.transition !== null; }
  get storageMode(): StorageMode { return this.config.data.storage; }
  private async acquire(): Promise<void> {
    const lockPath = join(this.root, '.gopher.lock');
    try {
      await assertDestination(lockPath);
      if (process.platform === 'win32') {
        await windowsPrivateOperation('acquire-lock', lockPath, this.lockToken);
        this.windowsLock = true;
      } else {
        this.lockHandle = await open(lockPath, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
        await this.lockHandle.chmod(0o600);
        await flockExclusive(this.lockHandle.fd);
        const opened = await this.lockHandle.stat(), linked = await lstat(lockPath);
        if (linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || opened.nlink !== 1) throw new StoreError('The data lock file was replaced or linked. Restore a regular .gopher.lock file before starting Gopher.');
      }
    } catch (error) {
      await this.release();
      if (error instanceof StoreError && /fs-ext|replaced or linked|Unsafe data file|linked data path/.test(error.message)) throw error;
      throw new StoreError('This data folder is already in use by another Gopher process, or its lock file is inaccessible.');
    }
  }
  private async release(): Promise<void> {
    if (this.windowsLock) { if (!windowsHelperFailure) await windowsPrivateOperation('release-lock', join(this.root, '.gopher.lock'), this.lockToken); this.windowsLock = false; }
    await this.lockHandle?.close(); this.lockHandle = null;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(() => { if (this.closed) throw new StoreError('Storage is closed.'); return operation(); });
    this.queue = work.catch(() => undefined); return work;
  }
  private requireUnlocked(): void { if (windowsHelperFailure) throw windowsHelperFailure; if (this.securityError) throw this.securityError; if (this.encrypted && (!this.key || this.transition)) throw locked(); }
  private async decodeFile(name: string, aad: string, fallback: unknown, key = this.key, encrypted = this.encrypted): Promise<any> {
    if (encrypted && !key) throw locked();
    const value = await readJson(join(this.root, name));
    if (value === null) { if (encrypted) throw new StoreError(`Encrypted ${name} is missing. Restore the encrypted file from backup.`); return structuredClone(fallback); }
    if (isEnvelope(value)) { if (!key) throw locked(); return decryptValue(key, value, aad); }
    if (encrypted) throw new StoreError(`Encrypted ${name} was replaced with plaintext. Restore the encrypted file from backup.`);
    return value;
  }
  private encodeFile(name: string, aad: string, value: unknown, key = this.key): Promise<void> { return writeJson(join(this.root, name), key ? encryptValue(key, value, aad) : value); }
  private inMemory(): boolean { return this.storageMode !== 'disk'; }
  private async chatsInternal(): Promise<JsonObject> { this.requireUnlocked(); return this.inMemory() ? structuredClone(this.memory.chats) : normalizeStore(await this.decodeFile('chats.json', AAD.chats, normalizeStore([]))); }
  loadChats(): Promise<JsonObject> { return this.serial(() => this.chatsInternal()); }
  async saveChats(value: unknown): Promise<void> {
    const normalized = normalizeStore(value);
    return this.serial(async () => { this.requireUnlocked(); if (this.inMemory()) this.memory.chats = normalized; else await this.encodeFile('chats.json', AAD.chats, normalized); });
  }
  private async preferencesInternal(): Promise<JsonObject> { this.requireUnlocked(); return this.inMemory() ? structuredClone(this.memory.preferences) : objectValue(await this.decodeFile('preferences.json', AAD.preferences, {})); }
  loadPreferences(): Promise<JsonObject> { return this.serial(() => this.preferencesInternal()); }
  async savePreferences(value: unknown): Promise<void> {
    const preferences = structuredClone(objectValue(value));
    return this.serial(async () => { this.requireUnlocked(); if (this.inMemory()) this.memory.preferences = preferences; else await this.encodeFile('preferences.json', AAD.preferences, preferences); this.diagnostics.configure(preferences.diagnosticsEnabled === true); });
  }
  private providerPayload(config = this.config) { return { version: 2, provider_config: { providers: config.providers, active_provider_id: config.active_provider_id } }; }
  private restoreProviders(payload: any): void {
    if (payload?.provider_config) {
      const raw = payload.provider_config;
      if (!Array.isArray(raw.providers ?? raw.items ?? raw.remotes)) throw new StoreError('Invalid encrypted provider configuration.');
      const normalized = normalizeProviders(raw.providers ?? raw.items ?? raw.remotes, raw.active_provider_id ?? raw.active_remote_id ?? '');
      this.config.providers = normalized.providers; this.config.active_provider_id = normalized.active_provider_id;
    } else {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new StoreError('Invalid encrypted provider payload.');
      for (const provider of this.config.providers) if (!provider.token && typeof payload[provider.id] === 'string') provider.token = payload[provider.id];
    }
  }
  private async persistConfigInternal(config = this.config): Promise<void> {
    const publicConfig = structuredClone(config);
    const changes: Array<{ path: string; before: string | null; after: string }> = [];
    if (this.encrypted) {
      if (this.key && !this.transition) {
        const path = join(this.root, 'provider-tokens.json'), before = await readPrivate(path);
        const payload = this.providerPayload(config);
        if (before === null || JSON.stringify(decryptValue(this.key, JSON.parse(before), AAD.providers)) !== JSON.stringify(payload)) {
          changes.push({ path, before, after: `${JSON.stringify(encryptValue(this.key, payload, AAD.providers), null, 2)}\n` });
        }
        publicConfig.providers = []; publicConfig.active_provider_id = '';
      } else { for (const provider of publicConfig.providers) provider.token = ''; }
    } else { for (const provider of publicConfig.providers) if (provider.kind === 'openai-codex') provider.token = ''; }
    const before = await readPrivate(this.configPath, 4 * 1024 * 1024), after = serializeConfig(publicConfig);
    if (before !== after) changes.push({ path: this.configPath, before, after });
    const attempted: typeof changes = [];
    try {
      for (const change of changes) { attempted.push(change); await atomicWrite(change.path, change.after); }
    } catch (error) {
      let rollbackFailed = false;
      for (const change of attempted.reverse()) {
        try {
          if (await readPrivate(change.path) === change.before) continue;
          if (change.before === null) await removePrivate(change.path); else await atomicWrite(change.path, change.before);
        }
        catch { rollbackFailed = true; }
      }
      if (rollbackFailed) {
        this.securityError = new StoreError('Configuration could not be saved or restored safely. Local data is locked. Restore access to the data directory, then restart Gopher before making further changes.', 'config_recovery_required');
        this.lockInternal();
        throw this.securityError;
      }
      throw error;
    }
  }
  async saveConfig(config = this.config): Promise<void> {
    const next = normalizeConfig(structuredClone(config));
    return this.serial(async () => { this.requireUnlocked(); await this.persistConfigInternal(next); this.config = next; });
  }
  private async skillsInternal(key = this.key, encrypted = this.encrypted): Promise<UserSkill[]> {
    if (encrypted && !key) throw locked();
    if (this.inMemory()) return structuredClone(this.memory.skills);
    const directory = join(this.root, 'chat-skills');
    const snapshot = await readJson(join(directory, 'skills.json'));
    const decode = (value: unknown, aad: string) => {
      if (isEnvelope(value)) { if (!key) throw locked(); return decryptValue(key, value, aad); }
      if (encrypted) throw new StoreError('Encrypted skills were replaced with plaintext.');
      return value;
    };
    if (snapshot !== null) return validateSkills(decode(snapshot, AAD.skills));
    const indexRaw = await readJson(join(directory, 'index.json'));
    if (indexRaw === null) return [];
    const index = decode(indexRaw, AAD.skillIndex) as any;
    if (!Array.isArray(index?.skills)) throw new StoreError('Invalid skill index.');
    const skills: UserSkill[] = [];
    for (const meta of index.skills) {
      if (!isSafeSkillId(meta.id)) throw new StoreError('Invalid skill id in local store.');
      const raw = await readPrivate(join(directory, `${meta.id}.md`), 128 * 1024);
      if (raw === null) throw new StoreError(`Skill content is missing: ${meta.id}`);
      let content: unknown = raw;
      if (encrypted) { let envelope; try { envelope = JSON.parse(raw); } catch { throw new StoreError('Invalid encrypted skill content.'); } content = decode(envelope, `${AAD.skillContent}:${meta.id}`); }
      skills.push({ ...meta, content });
    }
    return validateSkills(skills);
  }
  private async saveSkillsInternal(skills: UserSkill[], key = this.key): Promise<void> {
    validateSkills(skills);
    if (this.inMemory()) { this.memory.skills = structuredClone(skills); return; }
    const directory = join(this.root, 'chat-skills');
    if (!(await inspect(directory))) await protectDirectory(directory);
    await writeJson(join(directory, 'skills.json'), key ? encryptValue(key, skills, AAD.skills) : skills);
    await removePrivate(join(directory, 'index.json'));
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.name.endsWith('.md') && isSafeSkillId(entry.name.slice(0, -3))) await removePrivate(join(directory, entry.name));
  }
  listSkills(): Promise<UserSkill[]> { return this.serial(async () => { this.requireUnlocked(); return this.skillsInternal(); }); }
  createSkill(input: SkillUpsert): Promise<UserSkill> {
    return this.serial(async () => { this.requireUnlocked(); const skills = await this.skillsInternal(); if (skills.length >= MAX_SKILLS) throw new StoreError(`At most ${MAX_SKILLS} skills are allowed.`); const skill = upsertSkill(input); skills.push(skill); await this.saveSkillsInternal(skills); return skill; });
  }
  async importSkill(filename: string | undefined, content: string): Promise<UserSkill> { return this.createSkill(parseSkillMarkdown(content, filename)); }
  updateSkill(id: string, input: SkillUpsert): Promise<UserSkill> {
    return this.serial(async () => { this.requireUnlocked(); const skills = await this.skillsInternal(); const index = skills.findIndex(skill => skill.id === id); if (index < 0) throw new StoreError(`Unknown skill id: ${id}`); const skill = upsertSkill(input, skills[index]); skills[index] = skill; await this.saveSkillsInternal(skills); return skill; });
  }
  deleteSkill(id: string): Promise<void> {
    return this.serial(async () => { this.requireUnlocked(); const skills = await this.skillsInternal(); const remaining = skills.filter(skill => skill.id !== id); if (remaining.length === skills.length) throw new StoreError(`Unknown skill id: ${id}`); await this.saveSkillsInternal(remaining); });
  }
  private async restoreDiagnostics(): Promise<void> {
    try {
      if (this.encrypted && !this.key) return;
      if (this.key) {
        const value = await readJson(join(this.root, 'diagnostics.json'), 32 * 1024 * 1024);
        if (value !== null) { if (!isEnvelope(value)) throw new StoreError('Stored diagnostics must be encrypted.'); this.diagnostics.restore(decryptValue(this.key, value, AAD.diagnostics)); }
      }
      this.diagnostics.configure((await this.preferencesInternal()).diagnosticsEnabled === true);
    } catch (error) { this.diagnostics.restoreError(error); }
  }
  private async flushDiagnosticsInternal(): Promise<void> {
    if (!this.key || this.transition || this.inMemory()) return;
    const pending = this.diagnostics.pending();
    if (pending) { try { await this.encodeFile('diagnostics.json', AAD.diagnostics, pending.value); this.diagnostics.saved(pending.revision); } catch (error) { this.diagnostics.error(error); throw error; } }
  }
  flushDiagnostics(): Promise<void> { return this.serial(() => this.flushDiagnosticsInternal()); }
  clearDiagnostics(): Promise<void> { return this.serial(async () => { this.requireUnlocked(); await removePrivate(join(this.root, 'diagnostics.json')); this.diagnostics.clear(); this.diagnostics.configure((await this.preferencesInternal()).diagnosticsEnabled === true); await this.flushDiagnosticsInternal(); }); }
  private lockInternal(): void {
    this.diagnostics.suspend(); this.key?.fill(0); this.key = null;
    if (this.encrypted) { for (const provider of this.config.providers) provider.token = ''; this.config.providers = []; this.config.active_provider_id = ''; this.memory = { chats: normalizeStore([]), preferences: {}, skills: [] }; }
  }
  lock(): Promise<void> { return this.serial(async () => { try { await this.flushDiagnosticsInternal(); } finally { this.lockInternal(); } }); }
  private async keyFor(passphrase: string, meta: EncryptionMeta): Promise<Buffer> {
    const key = await deriveKey(passphrase, meta);
    try {
      if (meta.verifier) verifyKey(key, meta);
      else {
        let proven = false;
        for (const [filename, aad] of [['chats.json', AAD.chats], ['preferences.json', AAD.preferences]]) {
          const value = await readJson(join(this.root, filename!));
          if (isEnvelope(value)) { decryptValue(key, value, aad!); proven = true; break; }
        }
        if (!proven) throw new StoreError('Encrypted data has no key verifier and no authenticated encrypted files. Restore a backup.');
      }
      return key;
    } catch (error) { key.fill(0); throw error; }
  }
  private async resumePending(passphrase: string, expected?: 'enable' | 'disable'): Promise<boolean> {
    if (!this.transition) return false;
    const record = this.transition;
    if (expected && record.operation !== expected) throw new StoreError(`A pending ${record.operation} encryption transition must be recovered first.`);
    const key = await deriveKey(passphrase, record.meta);
    try {
      verifyKey(key, record.meta);
      const payload = decryptValue<any>(key, record.payload, transitionAad(record));
      if (payload.transaction_id !== record.transaction_id || payload.operation !== record.operation) throw new StoreError('Encryption transition identity mismatch.');
      await this.applyTransition(record, payload.snapshot, key); return true;
    } catch (error) { key.fill(0); this.lockInternal(); throw error; }
  }
  unlock(passphrase: string): Promise<void> {
    return this.serial(async () => {
      if (windowsHelperFailure) throw windowsHelperFailure;
      if (this.securityError) throw this.securityError;
      try {
        if (await this.resumePending(passphrase)) return;
        if (!this.meta) throw new StoreError('Disk encryption is not enabled.');
        const key = await this.keyFor(passphrase, this.meta);
        try {
          normalizeStore(await this.decodeFile('chats.json', AAD.chats, null, key, true));
          objectValue(await this.decodeFile('preferences.json', AAD.preferences, null, key, true));
          const legacy = !this.meta.verifier;
          if (this.legacyProviders && !this.config.providers.some(provider => provider.kind === 'custom')) {
            this.config.providers = structuredClone(this.legacyProviders.providers);
            this.config.active_provider_id = this.legacyProviders.active_provider_id;
          }
          let payload = await readJson(join(this.root, 'provider-tokens.json'));
          if (payload === null && legacy) payload = this.providerPayload();
          else { if (!isEnvelope(payload)) throw new StoreError('Encrypted provider configuration is missing or invalid.'); payload = decryptValue(key, payload, AAD.providers); }
          this.restoreProviders(payload);
          let skills: UserSkill[];
          try { skills = await this.skillsInternal(key, true); }
          catch (error) { if (!legacy) throw error; skills = await this.skillsInternal(null, false); }
          await this.saveSkillsInternal(skills, key);
          // Commit recovered provider credentials before adding a verifier. A
          // crash during migration must retain the legacy recovery allowance
          // until every required encrypted file exists durably.
          await this.encodeFile('provider-tokens.json', AAD.providers, this.providerPayload(), key);
          if (legacy) { this.meta = { ...this.meta, version: 2, verifier: encryptBytes(key, Buffer.from('gopher-ok'), AAD.verifier) }; await writeJson(join(this.root, 'encryption.json'), this.meta); }
          this.key?.fill(0); this.key = key;
          await this.persistConfigInternal(); this.legacyProviders = null; await this.restoreDiagnostics();
        } catch (error) { key.fill(0); throw error; }
      } catch (error) { this.lockInternal(); throw error; }
    });
  }
  private async stage(operation: 'enable' | 'disable', meta: EncryptionMeta, key: Buffer, snapshot: Snapshot): Promise<void> {
    if (this.transition) throw new StoreError('An encryption transition is already pending.');
    verifyKey(key, meta);
    const record: Transition = { version: 1, transaction_id: randomBytes(16).toString('base64url'), operation, meta, payload: null };
    record.payload = encryptValue(key, { transaction_id: record.transaction_id, operation, snapshot }, transitionAad(record));
    const raw = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw new StoreError('Encryption transition is too large to stage safely.');
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
  private async applyTransition(record: Transition, snapshot: Snapshot, key: Buffer, restoreDiagnostics = true): Promise<void> {
    try {
      const chats = normalizeStore(snapshot.chats), preferences = objectValue(snapshot.preferences), skills = validateSkills(snapshot.skills);
      this.restoreProviders(snapshot.provider_tokens);
      // Transitions always commit a durable disk snapshot, even from memory mode.
      this.config.data.storage = 'disk';
      if (record.operation === 'enable') {
        const publicConfig = { ...this.config, providers: [], active_provider_id: '' };
        await atomicWrite(this.configPath, serializeConfig(publicConfig));
        await this.encodeFile('chats.json', AAD.chats, chats, key);
        await this.encodeFile('preferences.json', AAD.preferences, preferences, key);
        await this.encodeFile('diagnostics.json', AAD.diagnostics, snapshot.diagnostics ?? null, key);
        await this.encodeFile('provider-tokens.json', AAD.providers, snapshot.provider_tokens, key);
        await this.saveSkillsInternal(skills, key);
        await writeJson(join(this.root, 'encryption.json'), record.meta);
        await removePrivate(join(this.root, 'encryption-transition.json'));
        this.meta = record.meta; this.transition = null; this.key?.fill(0); this.key = key; this.encryptionPresent = true;
      } else {
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
        this.meta = null; this.transition = null; this.key?.fill(0); this.key = null; key.fill(0); this.encryptionPresent = false;
      }
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
  enableEncryption(passphrase: string, confirm = passphrase): Promise<void> {
    return this.serial(async () => {
      if (passphrase !== confirm) throw new StoreError('Passphrases do not match.');
      validatePassphrase(passphrase);
      if (this.securityError) throw this.securityError;
      if (await this.resumePending(passphrase, 'enable')) return;
      if (this.encrypted) throw new StoreError('Disk encryption is already enabled.');
      const snapshot: Snapshot = { chats: await this.chatsInternal(), preferences: await this.preferencesInternal(), provider_tokens: this.providerPayload(), skills: await this.skillsInternal(), diagnostics: this.diagnostics.stored() };
      const { key, meta } = await createEncryption(passphrase);
      try { await this.stage('enable', meta, key, snapshot); } catch (error) { key.fill(0); throw error; }
    });
  }
  disableEncryption(passphrase: string): Promise<void> {
    return this.serial(async () => {
      if (this.securityError) throw this.securityError;
      if (await this.resumePending(passphrase, 'disable')) return;
      if (!this.meta) throw new StoreError('Disk encryption is not enabled.');
      const key = await this.keyFor(passphrase, this.meta);
      try {
        const legacy = !this.meta.verifier;
        if (this.legacyProviders && !this.config.providers.some(provider => provider.kind === 'custom')) {
          this.config.providers = structuredClone(this.legacyProviders.providers);
          this.config.active_provider_id = this.legacyProviders.active_provider_id;
        }
        let providers: unknown;
        if (legacy && !(await inspect(join(this.root, 'provider-tokens.json')))) providers = this.providerPayload();
        else providers = await this.decodeFile('provider-tokens.json', AAD.providers, null, key, true);
        let skills: UserSkill[];
        try { skills = await this.skillsInternal(key, true); } catch (error) { if (!legacy) throw error; skills = await this.skillsInternal(null, false); }
        const snapshot: Snapshot = { chats: normalizeStore(await this.decodeFile('chats.json', AAD.chats, null, key, true)), preferences: objectValue(await this.decodeFile('preferences.json', AAD.preferences, null, key, true)), provider_tokens: providers, skills, diagnostics: this.diagnostics.stored() };
        const meta = legacy ? { ...this.meta, version: 2, verifier: encryptBytes(key, Buffer.from('gopher-ok'), AAD.verifier) } : this.meta;
        await this.stage('disable', meta, key, snapshot); this.legacyProviders = null;
      } catch (error) { key.fill(0); throw error; }
    });
  }
  setStorageMode(mode: StorageMode): Promise<void> {
    return this.serial(async () => {
      this.requireUnlocked();
      if (mode === 'browser') throw new StoreError('Browser localStorage mode has been removed; local data is stored on disk.');
      if (!['disk', 'memory'].includes(mode)) throw new StoreError('Invalid storage mode.');
      if (mode === this.storageMode) return;
      const chats = await this.chatsInternal(), preferences = await this.preferencesInternal(), skills = await this.skillsInternal();
      const previous = this.config.data.storage;
      this.config.data.storage = mode;
      try {
        if (mode === 'disk') { await this.encodeFile('chats.json', AAD.chats, chats); await this.encodeFile('preferences.json', AAD.preferences, preferences); await this.saveSkillsInternal(skills); }
        else this.memory = { chats, preferences, skills };
        await this.persistConfigInternal();
      } catch (error) { this.config.data.storage = previous; throw error; }
    });
  }
  dataInfo() {
    const visible = (path: string) => this.encrypted && !this.unlocked ? '' : path;
    return { storage: this.storageMode, browser_storage: this.storageMode === 'browser', encryption_enabled: this.encrypted, encryption_unlocked: this.unlocked, encryption_transition_pending: this.transitionPending, data_dir: visible(this.root), config_path: visible(this.configPath), chats_path: visible(join(this.root, 'chats.json')), preferences_path: visible(join(this.root, 'preferences.json')), skills_dir: visible(join(this.root, 'chat-skills')), os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', open_label: process.platform === 'win32' ? 'Open in File Explorer' : process.platform === 'darwin' ? 'Open in Finder' : 'Open in Files', error: (this.securityError || windowsHelperFailure)?.message || '' };
  }
  close(): Promise<void> { return this.serial(async () => { try { await this.flushDiagnosticsInternal(); } finally { this.lockInternal(); this.legacyProviders = null; this.closed = true; try { await this.release(); } finally { if (this.helperLease) { this.helperLease = false; await releaseWindowsHelper(); } } } }); }
}
