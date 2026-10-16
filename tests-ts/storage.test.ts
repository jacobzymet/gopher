import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, link, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { AppStorage, normalizeStore } from '../server/storage.js';
import { AAD, createEncryption, decryptValue, deriveKey, encryptValue, validateMeta } from '../server/crypto.js';
import { defaultConfig, normalizeProviders, resolveBind, serializeConfig } from '../server/config.js';
import { Diagnostics } from '../server/diagnostics.js';
const rustFixture = JSON.parse(await readFile(new URL('./fixtures/storage-rust.json', import.meta.url), 'utf8'));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-ts-store-'));
  const configPath = join(directory, 'config.toml');
  let storage: AppStorage | undefined;
  return { directory, configPath, open: async () => (storage = await AppStorage.open(configPath)), cleanup: async () => { await storage?.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }); } };
}

test('legacy conversation arrays and profile stores retain every record', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'chats.json'), JSON.stringify([{ id: 'original', messages: [{ content: 'kept' }] }]));
    const storage = await f.open();
    const store = await storage.loadChats();
    assert.equal(store.conversations[0].messages[0].content, 'kept');
    const profiles = { activeProfileId: 'work', profiles: [{ id: 'work', projects: [{ id: 'p1' }], conversations: store.conversations }] };
    await storage.saveChats(profiles);
    assert.deepEqual(await storage.loadChats(), { ...profiles, version: 3, profiles: [{ ...profiles.profiles[0], bots: [] }] });
    await assert.rejects(storage.saveChats({ profiles: null }), /Profiles/);
    assert.equal((await storage.loadChats()).profiles[0].id, 'work');
    assert.throws(() => normalizeStore({ projects: 'invalid' }), /arrays/);
  } finally { await f.cleanup(); }
});

test('a data directory has exactly one active writer and can reopen after close', async () => {
  const f = await fixture();
  try {
    const storage = await f.open();
    await assert.rejects(AppStorage.open(f.configPath), /already in use/);
    await storage.close();
    const reopened = await f.open();
    await reopened.saveChats([{ id: 'ok' }]);
    assert.equal((await reopened.loadChats()).conversations[0].id, 'ok');
  } finally { await f.cleanup(); }
});

test('encryption protects chats, preferences, provider topology, skills and diagnostics across restart', async () => {
  const f = await fixture();
  try {
    let storage = await f.open();
    storage.config.providers.push({ id: 'secret-provider', name: 'Secret deployment', base: 'https://hidden.example/v1', token: 'private-api-key', kind: 'custom', api_style: 'openai', allow_insecure_tls: false });
    storage.config.active_provider_id = 'secret-provider';
    await storage.saveConfig();
    await storage.saveChats([{ id: 'secret-chat', title: 'Private title' }]);
    await storage.savePreferences({ selectedChatModel: 'hidden-model', diagnosticsEnabled: true });
    const skill = await storage.createSkill({ name: 'Confidential skill', content: 'Internal workflow' });
    storage.diagnostics.push('test', { event: 'test', data: { token: 'do-not-log', message: 'diagnostic body' } });
    await storage.enableEncryption('correct horse battery', 'correct horse battery');
    assert.equal(storage.unlocked, true);
    for (const file of ['chats.json', 'preferences.json', 'provider-tokens.json', 'chat-skills/skills.json', 'diagnostics.json']) {
      const raw = await readFile(join(f.directory, file), 'utf8');
      assert.equal(JSON.parse(raw).gopher_crypto, 2);
      for (const secret of ['Private title', 'hidden-model', 'private-api-key', 'Internal workflow', 'diagnostic body']) assert.equal(raw.includes(secret), false);
    }
    const config = await readFile(f.configPath, 'utf8');
    assert.equal(config.includes('hidden.example'), false); assert.equal(config.includes('Secret deployment'), false);
    await storage.lock();
    assert.equal(storage.config.providers.length, 0);
    await assert.rejects(storage.loadChats(), /Unlock/);
    await assert.rejects(storage.unlock('wrong'), /Incorrect passphrase/);
    await storage.close();
    storage = await f.open();
    assert.equal(storage.encrypted, true); assert.equal(storage.unlocked, false);
    await storage.unlock('correct horse battery');
    assert.equal((await storage.loadChats()).conversations[0].title, 'Private title');
    assert.equal(storage.config.providers.find(p => p.id === 'secret-provider')?.token, 'private-api-key');
    assert.equal((await storage.listSkills())[0]?.id, skill.id);
    assert.equal(storage.diagnostics.view().entries[0]?.data.includes('do-not-log'), false);
    await storage.disableEncryption('correct horse battery');
    assert.equal(storage.encrypted, false);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'chats.json'), 'utf8')).conversations[0].title, 'Private title');
    await assert.rejects(readFile(join(f.directory, 'provider-tokens.json')), /ENOENT/);
    await assert.rejects(readFile(join(f.directory, 'diagnostics.json')), /ENOENT/);
    assert.equal((await storage.listSkills())[0]?.content, 'Internal workflow');
  } finally { await f.cleanup(); }
});

test('a plaintext substitution cannot bypass encryption and missing protected files fail closed', async () => {
  const f = await fixture();
  try {
    const storage = await f.open();
    await storage.enableEncryption('password'); await storage.lock();
    await writeFile(join(f.directory, 'preferences.json'), JSON.stringify({ name: 'injected' }));
    await assert.rejects(storage.unlock('password'), /plaintext/);
    assert.equal(storage.unlocked, false);
    await assert.rejects(storage.loadPreferences(), /Unlock/);
  } finally { await f.cleanup(); }
});

test('malformed encryption metadata remains locked without damaging chats', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'encryption.json'), ' ');
    await writeFile(join(f.directory, 'chats.json'), '[{"id":"untouched"}]');
    const storage = await f.open();
    assert.equal(storage.encrypted, true);
    await assert.rejects(storage.loadChats(), /Empty JSON/);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'chats.json'), 'utf8'))[0].id, 'untouched');
    assert.equal(storage.dataInfo().data_dir, '');
  } finally { await f.cleanup(); }
});

test('native Argon2 supports the original Rust parameters and AES-GCM v1 ciphertext layout', async () => {
  const meta = { version: 1, kdf: 'argon2id', salt: Buffer.alloc(32).toString('base64') };
  const key = await deriveKey('x', meta);
  try {
    assert.equal(key.toString('hex'), '5bb4470a22a9cfea935fb7c5abfb568dc5dfeedea3e383895a1df8a307234deb');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update('{"legacy":true}'), cipher.final(), cipher.getAuthTag()]);
    const envelope = { gopher_crypto: 1, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') };
    assert.deepEqual(decryptValue(key, envelope, AAD.chats), { legacy: true });
    const current = encryptValue(key, { purpose: 'chats' }, AAD.chats);
    assert.throws(() => decryptValue(key, current, AAD.preferences), /Incorrect passphrase/);
    assert.throws(() => validateMeta({ ...meta, kdf_memory_kib: 2 ** 30 }), /unsupported Argon2/);
  } finally { key.fill(0); }
});

test('legacy encrypted token maps and split skill files migrate without losing credentials', async () => {
  const f = await fixture();
  const { key, meta } = await createEncryption('legacy-password');
  try {
    const config = defaultConfig();
    config.providers = normalizeProviders([{ id: 'p1', name: 'Legacy', base: 'https://legacy.example/v1', token: 'newer-recovered-secret' }]).providers;
    config.active_provider_id = 'p1';
    await writeFile(f.configPath, serializeConfig(config));
    await writeFile(join(f.directory, 'chats.json'), JSON.stringify(encryptValue(key, [{ id: 'old-chat' }], AAD.chats)));
    await writeFile(join(f.directory, 'preferences.json'), JSON.stringify(encryptValue(key, {}, AAD.preferences)));
    await writeFile(join(f.directory, 'provider-tokens.json'), JSON.stringify(encryptValue(key, { p1: 'old-secret' }, AAD.providers)));
    await writeFile(join(f.directory, 'encryption.json'), JSON.stringify(meta));
    const skillId = 'sk-0123456789abcdef';
    await mkdir(join(f.directory, 'chat-skills'));
    await writeFile(join(f.directory, 'chat-skills', 'index.json'), JSON.stringify(encryptValue(key, { skills: [{ id: skillId, name: 'Legacy skill', description: '', enabled: true, created_at: 1, updated_at: 1 }] }, AAD.skillIndex)));
    await writeFile(join(f.directory, 'chat-skills', `${skillId}.md`), JSON.stringify(encryptValue(key, 'legacy instructions', `${AAD.skillContent}:${skillId}`)));
    const storage = await f.open();
    assert.equal((await readFile(f.configPath, 'utf8')).includes('newer-recovered-secret'), true);
    assert.equal(storage.config.providers.length, 0);
    await storage.unlock('legacy-password');
    assert.equal(storage.config.providers.find(p => p.id === 'p1')?.token, 'newer-recovered-secret');
    assert.equal((await readFile(f.configPath, 'utf8')).includes('newer-recovered-secret'), false);
    assert.equal((await storage.listSkills())[0]?.content, 'legacy instructions');
    await assert.rejects(readFile(join(f.directory, 'chat-skills', 'index.json')), /ENOENT/);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'chat-skills', 'skills.json'), 'utf8')).gopher_crypto, 2);
  } finally { key.fill(0); await f.cleanup(); }
});

test('an interrupted encryption transition resumes from its authenticated snapshot', async () => {
  const f = await fixture();
  const { key, meta } = await createEncryption('recovery-password');
  try {
    const transaction_id = randomBytes(16).toString('base64url'), operation = 'enable';
    const snapshot = { chats: { conversations: [{ id: 'recovered' }] }, preferences: { theme: 'light' }, provider_tokens: { version: 2, provider_config: { providers: [], active_provider_id: '' } }, skills: [], diagnostics: null };
    const payload = encryptValue(key, { transaction_id, operation, snapshot }, `${AAD.transition}:${operation}:${transaction_id}`);
    await writeFile(join(f.directory, 'encryption-transition.json'), JSON.stringify({ version: 1, transaction_id, operation, meta, payload }));
    const storage = await f.open();
    assert.equal(storage.transitionPending, true);
    await assert.rejects(storage.unlock('wrong'), /Incorrect passphrase/);
    assert.equal(storage.transitionPending, true);
    await storage.unlock('recovery-password');
    assert.equal(storage.transitionPending, false);
    assert.equal((await storage.loadChats()).conversations[0].id, 'recovered');
    assert.equal((await storage.loadPreferences()).theme, 'light');
  } finally { key.fill(0); await f.cleanup(); }
});

test('memory mode is volatile and returning to disk persists current edits', async () => {
  const f = await fixture();
  try {
    const storage = await f.open();
    await storage.saveChats([{ id: 'disk' }]);
    await storage.setStorageMode('memory');
    await storage.saveChats([{ id: 'memory' }]);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'chats.json'), 'utf8')).conversations[0].id, 'disk');
    await storage.setStorageMode('disk');
    assert.equal(JSON.parse(await readFile(join(f.directory, 'chats.json'), 'utf8')).conversations[0].id, 'memory');
  } finally { await f.cleanup(); }
});

test('skill import, limits, editing and deletion retain source metadata safely', async () => {
  const f = await fixture();
  try {
    const storage = await f.open();
    const skill = await storage.importSkill('../../review.md', '---\nname: Review\ndescription: "Careful checks"\n---\nRead every file.');
    assert.equal(skill.name, 'Review'); assert.equal(skill.content, 'Read every file.'); assert.equal(skill.source_filename, 'review.md');
    await storage.updateSkill(skill.id, { enabled: false, content: 'Updated' });
    assert.equal((await storage.listSkills())[0]?.enabled, false);
    await assert.rejects(storage.updateSkill(skill.id, { name: '' }), /cannot be empty/);
    await assert.rejects(storage.createSkill({ content: '界'.repeat(22000) }), /65536 bytes/);
    await storage.deleteSkill(skill.id);
    assert.deepEqual(await storage.listSkills(), []);
  } finally { await f.cleanup(); }
});

test('diagnostics redact secrets, discard stale generations, and enforce bounds', () => {
  const diagnostics = new Diagnostics(); diagnostics.configure(true);
  diagnostics.push('test', { event: 'auth', data: { authorization: 'Bearer private', nested: { api_key: 'private-key' }, text: 'token=private-cookie Bearer private-bearer' } });
  const first = diagnostics.view().entries[0]!;
  assert.equal(first.data.includes('private'), false);
  const generation = diagnostics.generation; diagnostics.clear(); diagnostics.push('late', { event: 'late' }, generation);
  assert.equal(diagnostics.view().entries.length, 0);
  for (let i = 0; i < 2010; i++) diagnostics.push('test', { event: 'bounded', data: { i } });
  assert.equal(diagnostics.view().entries.length, 2000); assert.equal(diagnostics.view().dropped, 10);
  diagnostics.suspend(); assert.equal(diagnostics.view().entries.length, 0); assert.equal(diagnostics.enabled, false);
});

test('bind overrides reject network exposure', () => {
  const config = defaultConfig();
  assert.deepEqual(resolveBind(config, '[::1]:4444'), { host: '::1', port: 4444 });
  assert.throws(() => resolveBind(config, '0.0.0.0:3930'), /loopback/);
  assert.throws(() => resolveBind(config, '127.0.0.1:65536'), /port/);
});

test('hard-linked and linked-directory store files are rejected without reading external data', async () => {
  const f = await fixture();
  const external = await mkdtemp(join(tmpdir(), 'gopher-external-'));
  try {
    const storage = await f.open();
    const externalFile = join(external, 'outside.json');
    await writeFile(externalFile, '[]');
    await link(externalFile, join(f.directory, 'chats.json'));
    await assert.rejects(storage.loadChats(), /Unsafe data file/);
    await assert.rejects(storage.saveChats([]), /Unsafe data file/);
    assert.equal(await readFile(externalFile, 'utf8'), '[]');
    await symlink(external, join(f.directory, 'chat-skills'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(storage.listSkills(), /linked data path/);
  } finally { await f.cleanup(); await rm(external, { recursive: true, force: true }); }
});

test('Unix data locks interoperate with the original flock-based application', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  type Flock = (fd: number, operation: string, callback: (error: Error | null) => void) => void;
  const { flock } = createRequire(import.meta.url)('fs-ext') as { flock: Flock };
  const acquire = (fd: number) => new Promise<void>((resolve, reject) => flock(fd, 'exnb', error => error ? reject(error) : resolve()));
  const external = await open(join(f.directory, '.gopher.lock'), 'a+', 0o600);
  try {
    await acquire(external.fd);
    await assert.rejects(AppStorage.open(f.configPath), /already in use/);
    await external.close();
    const storage = await f.open();
    const contender = await open(join(f.directory, '.gopher.lock'), 'r+');
    try { await assert.rejects(acquire(contender.fd)); } finally { await contender.close(); }
    await storage.close();
    const released = await open(join(f.directory, '.gopher.lock'), 'r+');
    try { await acquire(released.fd); } finally { await released.close(); }
  } finally { await external.close().catch(() => undefined); await f.cleanup(); }
});

test('independently generated original-Rust Argon2 keys and every protected file decrypt exactly', async () => {
  const key = await deriveKey(rustFixture.passphrase, rustFixture.meta);
  const legacy = await deriveKey(rustFixture.passphrase, rustFixture.legacy_meta);
  try {
    assert.equal(key.toString('hex'), rustFixture.key_hex);
    assert.equal(legacy.toString('hex'), rustFixture.legacy_key_hex);
    for (const [name, purpose, field] of [['chats', AAD.chats, 'chats'], ['preferences', AAD.preferences, 'preferences'], ['providers', AAD.providers, 'provider_tokens'], ['skills', AAD.skills, 'skills'], ['diagnostics', AAD.diagnostics, 'diagnostics']]) {
      assert.deepEqual(decryptValue(key, rustFixture.encrypted[name!], purpose!), rustFixture.snapshot[field!]);
    }
    for (const operation of ['enable', 'disable']) {
      const record = rustFixture[`${operation}_transition`];
      assert.deepEqual(decryptValue(key, record.payload, `${AAD.transition}:${operation}:${record.transaction_id}`), { transaction_id: record.transaction_id, operation, snapshot: rustFixture.snapshot });
    }
  } finally { key.fill(0); legacy.fill(0); }
});

test('an original Rust encrypted installation opens with profiles, credentials, skills and diagnostics intact', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'encryption.json'), JSON.stringify(rustFixture.meta));
    for (const [name, field] of [['chats.json', 'chats'], ['preferences.json', 'preferences'], ['provider-tokens.json', 'providers'], ['diagnostics.json', 'diagnostics']]) await writeFile(join(f.directory, name!), JSON.stringify(rustFixture.encrypted[field!]));
    await mkdir(join(f.directory, 'chat-skills'));
    await writeFile(join(f.directory, 'chat-skills', 'skills.json'), JSON.stringify(rustFixture.encrypted.skills));
    const storage = await f.open();
    await storage.unlock(rustFixture.passphrase);
    assert.deepEqual(await storage.loadChats(), rustFixture.snapshot.chats);
    assert.deepEqual(await storage.loadPreferences(), rustFixture.snapshot.preferences);
    assert.deepEqual(await storage.listSkills(), rustFixture.snapshot.skills);
    assert.equal(storage.config.providers.find(provider => provider.id === 'rust-provider')?.token, 'rust-provider-secret');
    assert.equal(storage.diagnostics.view().entries[0]?.data, rustFixture.snapshot.diagnostics.entries[0].data);
    await storage.close();
    const restarted = await f.open(); await restarted.unlock(rustFixture.passphrase);
    assert.deepEqual(await restarted.loadChats(), rustFixture.snapshot.chats);
  } finally { await f.cleanup(); }
});

for (const operation of ['enable', 'disable'] as const) test(`original Rust ${operation} transition journals recover after partially committed writes`, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'encryption-transition.json'), JSON.stringify(rustFixture[`${operation}_transition`]));
    await writeFile(join(f.directory, 'chats.json'), JSON.stringify(operation === 'enable' ? rustFixture.encrypted.chats : rustFixture.snapshot.chats));
    await writeFile(join(f.directory, 'preferences.json'), JSON.stringify(rustFixture.snapshot.preferences));
    if (operation === 'disable') await writeFile(join(f.directory, 'encryption.json'), JSON.stringify(rustFixture.meta));
    const storage = await f.open();
    assert.equal(storage.transitionPending, true);
    await storage.unlock(rustFixture.passphrase);
    assert.equal(storage.transitionPending, false); assert.equal(storage.encrypted, operation === 'enable');
    assert.deepEqual(await storage.loadChats(), rustFixture.snapshot.chats);
    assert.deepEqual(await storage.loadPreferences(), rustFixture.snapshot.preferences);
    assert.deepEqual(await storage.listSkills(), rustFixture.snapshot.skills);
    assert.equal(storage.config.providers.find(provider => provider.id === 'rust-provider')?.token, 'rust-provider-secret');
    await assert.rejects(readFile(join(f.directory, 'encryption-transition.json')), /ENOENT/);
    if (operation === 'disable') await assert.rejects(readFile(join(f.directory, 'encryption.json')), /ENOENT/);
  } finally { await f.cleanup(); }
});

test('tampered original-Rust journal identity is rejected without overwriting partially committed data', async () => {
  const f = await fixture();
  try {
    const record = structuredClone(rustFixture.enable_transition); record.operation = 'disable';
    await writeFile(join(f.directory, 'encryption-transition.json'), JSON.stringify(record));
    await writeFile(join(f.directory, 'chats.json'), '[{"id":"unchanged"}]');
    const storage = await f.open();
    await assert.rejects(storage.unlock(rustFixture.passphrase), /Incorrect passphrase/);
    assert.equal(storage.unlocked, false); assert.equal(storage.transitionPending, true);
    assert.equal(await readFile(join(f.directory, 'chats.json'), 'utf8'), '[{"id":"unchanged"}]');
  } finally { await f.cleanup(); }
});

test('invalid UTF-8 is rejected instead of silently replacing persisted text', async () => {
  const f = await fixture();
  try {
    const storage = await f.open();
    await writeFile(join(f.directory, 'chats.json'), Buffer.concat([Buffer.from('[{"id":"'), Buffer.from([0xff]), Buffer.from('"}]')]));
    await assert.rejects(storage.loadChats(), /not valid UTF-8/);
  } finally { await f.cleanup(); }
});

test('legacy verifier upgrade waits until recovered provider credentials are durably encrypted', async () => {
  const f = await fixture();
  try {
    const meta = { ...rustFixture.meta, version: 1, verifier: null };
    await writeFile(join(f.directory, 'encryption.json'), JSON.stringify(meta));
    await writeFile(join(f.directory, 'chats.json'), JSON.stringify(rustFixture.encrypted.chats));
    await writeFile(join(f.directory, 'preferences.json'), JSON.stringify(rustFixture.encrypted.preferences));
    const storage = await f.open();
    const internal = storage as unknown as { encodeFile: (name: string, ...args: any[]) => Promise<void> };
    const encode = internal.encodeFile;
    internal.encodeFile = async function (name, ...args) { if (name === 'provider-tokens.json') throw new Error('Simulated durable provider write failure'); return encode.call(storage, name, ...args); };
    await assert.rejects(storage.unlock(rustFixture.passphrase), /provider write failure/);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'encryption.json'), 'utf8')).verifier, null);
    internal.encodeFile = encode;
    await storage.unlock(rustFixture.passphrase);
    assert.ok(JSON.parse(await readFile(join(f.directory, 'encryption.json'), 'utf8')).verifier);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'provider-tokens.json'), 'utf8')).gopher_crypto, 2);
  } finally { await f.cleanup(); }
});

test('damaged diagnostic storage is preserved until explicit clearing and does not block chats', async () => {
  const f = await fixture();
  try {
    const storage = await f.open();
    await storage.savePreferences({ diagnosticsEnabled: true });
    await storage.enableEncryption('password'); await storage.lock();
    await writeFile(join(f.directory, 'diagnostics.json'), '{"plaintext":"damaged-log"}');
    await storage.unlock('password');
    assert.equal(storage.unlocked, true); assert.match(storage.diagnostics.view().error, /must be encrypted/);
    await storage.loadChats(); await storage.flushDiagnostics();
    assert.equal(await readFile(join(f.directory, 'diagnostics.json'), 'utf8'), '{"plaintext":"damaged-log"}');
    await storage.clearDiagnostics();
    assert.equal(storage.diagnostics.view().error, ''); assert.equal(storage.diagnostics.enabled, true);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'diagnostics.json'), 'utf8')).gopher_crypto, 2);
  } finally { await f.cleanup(); }
});

test('Windows reads repair pre-existing broad file ACLs and atomic replacements remain private', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  const run = promisify(execFile);
  const ps = async (script: string, file: string) => (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, GOPHER_ACL_TEST_FILE: file, PSModulePath: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') } })).stdout.trim();
  try {
    const storage = await f.open();
    await storage.saveChats([{ id: 'private' }]);
    const path = join(f.directory, 'chats.json');
    const inspectScript = `$f=[IO.FileInfo]::new($env:GOPHER_ACL_TEST_FILE);$acl=$f.GetAccessControl();[Console]::Write((ConvertTo-Json -Compress -InputObject @{protected=$acl.AreAccessRulesProtected;sids=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value})}))`;
    const broadenScript = `$f=[IO.FileInfo]::new($env:GOPHER_ACL_TEST_FILE);$acl=$f.GetAccessControl();$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'));$f.SetAccessControl($acl)`;
    await ps(broadenScript, path);
    assert.ok(JSON.parse(await ps(inspectScript, path)).sids.includes('S-1-1-0'));
    await storage.loadChats();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await storage.saveChats([{ id: 'replacement' }]);
      const acl = JSON.parse(await ps(inspectScript, path));
      assert.equal(acl.protected, true); assert.equal(acl.sids.length, 2);
      assert.ok(acl.sids.includes('S-1-5-18')); assert.equal(acl.sids.includes('S-1-1-0'), false);
    }
  } finally { await f.cleanup(); }
});

test('Windows data locks use native exclusive sharing and release their handle on close', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    const storage = await f.open();
    await assert.rejects(open(join(f.directory, '.gopher.lock'), 'r+'));
    await storage.close();
    const handle = await open(join(f.directory, '.gopher.lock'), 'r+'); await handle.close();
    await f.open();
  } finally { await f.cleanup(); }
});

test('abrupt process exit releases native data locks without stale PID leases', async () => {
  const f = await fixture();
  try {
    const source = `const { AppStorage } = await import(process.env.GOPHER_TEST_STORAGE_MODULE); await AppStorage.open(process.env.GOPHER_TEST_CONFIG); process.exit(0);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { windowsHide: true, env: { ...process.env, GOPHER_TEST_STORAGE_MODULE: new URL('../server/storage.ts', import.meta.url).href, GOPHER_TEST_CONFIG: f.configPath }, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += chunk; });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, error);
    let storage: AppStorage | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { storage = await f.open(); break; }
      catch (cause) { if (attempt === 19) throw cause; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(storage); await storage.saveChats([{ id: 'recovered-after-process-exit' }]);
    assert.equal((await storage.loadChats()).conversations[0].id, 'recovered-after-process-exit');
  } finally { await f.cleanup(); }
});

test('same-session encryption toggles preserve diagnostic generation and incremental cursors', async () => {
  const f = await fixture();
  try {
    const storage = await f.open(); await storage.savePreferences({ diagnosticsEnabled: true });
    storage.diagnostics.push('browser', { event: 'before-toggle', data: { message: 'Retain log' } });
    const before = storage.diagnostics.view();
    const enabling = storage.enableEncryption('password');
    await new Promise(resolve => setTimeout(resolve, 30));
    storage.diagnostics.push('browser', { event: 'during-toggle' });
    await enabling;
    const encrypted = storage.diagnostics.view(before.last_id);
    assert.equal(encrypted.generation, before.generation);
    assert.ok(encrypted.entries.some(entry => entry.event === 'during-toggle'));
    await storage.disableEncryption('password');
    assert.equal(storage.diagnostics.generation, before.generation);
    assert.ok(storage.diagnostics.view().entries.some(entry => entry.event === 'before-toggle'));
  } finally { await f.cleanup(); }
});

test('JSON null cannot masquerade as a missing data file or pending security journal', async () => {
  const f = await fixture();
  try {
    const storage = await f.open();
    for (const [file, load] of [['chats.json', () => storage.loadChats()], ['preferences.json', () => storage.loadPreferences()]] as const) {
      await writeFile(join(f.directory, file), 'null'); await assert.rejects(load(), /Invalid JSON file/);
    }
    await writeFile(join(f.directory, 'chats.json'), JSON.stringify(rustFixture.encrypted.chats));
    await writeFile(join(f.directory, 'preferences.json'), JSON.stringify(rustFixture.encrypted.preferences));
    await writeFile(join(f.directory, 'encryption.json'), JSON.stringify(rustFixture.meta));
    await writeFile(join(f.directory, 'encryption-transition.json'), 'null');
    await storage.close();
    const restarted = await f.open();
    assert.equal(restarted.encrypted, true); await assert.rejects(restarted.unlock(rustFixture.passphrase), /Invalid JSON file/);
    assert.equal(await readFile(join(f.directory, 'encryption-transition.json'), 'utf8'), 'null');
  } finally { await f.cleanup(); }
});

test('retired browser storage markers migrate to disk without hiding existing chat data', async () => {
  const f = await fixture();
  try {
    await writeFile(f.configPath, '[data]\nstorage="browser"\n');
    await writeFile(join(f.directory, 'chats.json'), '[{"id":"preserved-disk-history"}]');
    const storage = await f.open();
    assert.equal(storage.storageMode, 'disk'); assert.equal(storage.dataInfo().browser_storage, false);
    assert.equal((await storage.loadChats()).conversations[0].id, 'preserved-disk-history');
    await assert.rejects(storage.setStorageMode('browser'), /has been removed/);
    assert.match(await readFile(f.configPath, 'utf8'), /storage = "disk"/);
  } finally { await f.cleanup(); }
});

test('malformed configuration shapes fail without overwriting existing provider settings', async () => {
  const f = await fixture();
  try {
    for (const raw of ['providers="malformed"\n', 'ui="malformed"\n', '[ui]\ntheme="unknown-theme"\n', '[[providers]]\nid="existing"\nbase="https://example.com/v1"\ntoken=123\n']) {
      await writeFile(f.configPath, raw);
      await assert.rejects(f.open(), /Providers must|Configuration ui|Invalid UI theme|Provider token/);
      assert.equal(await readFile(f.configPath, 'utf8'), raw);
    }
  } finally { await f.cleanup(); }
});

test('legacy plaintext-only credentials survive closing before the first verified unlock', async () => {
  const f = await fixture();
  try {
    const config = defaultConfig();
    config.providers = normalizeProviders([{ id: 'legacy-only', base: 'https://legacy.example/v1', token: 'recover-this-only-copy' }]).providers;
    config.active_provider_id = 'legacy-only';
    await writeFile(f.configPath, serializeConfig(config));
    await writeFile(join(f.directory, 'encryption.json'), JSON.stringify({ ...rustFixture.meta, version: 1, verifier: null }));
    for (const name of ['chats', 'preferences']) await writeFile(join(f.directory, `${name}.json`), JSON.stringify(rustFixture.encrypted[name]));
    let storage = await f.open();
    assert.equal(storage.unlocked, false); assert.deepEqual(storage.config.providers, []);
    await assert.rejects(storage.unlock('incorrect-passphrase'), /Incorrect passphrase/);
    await storage.close();
    assert.match(await readFile(f.configPath, 'utf8'), /recover-this-only-copy/);
    storage = await f.open(); await storage.unlock(rustFixture.passphrase);
    assert.equal(storage.config.providers.find(provider => provider.id === 'legacy-only')?.token, 'recover-this-only-copy');
    assert.equal((await readFile(f.configPath, 'utf8')).includes('recover-this-only-copy'), false);
    await storage.close(); storage = await f.open(); await storage.unlock(rustFixture.passphrase);
    assert.equal(storage.config.providers.find(provider => provider.id === 'legacy-only')?.token, 'recover-this-only-copy');
  } finally { await f.cleanup(); }
});

test('an invalid config destination cannot partially persist an encrypted provider mutation', async () => {
  const f = await fixture();
  try {
    let storage = await f.open();
    const config = structuredClone(storage.config);
    config.providers.unshift({ id: 'before-provider', name: 'Before', base: 'https://before.example/v1', token: 'before-token', kind: 'custom', api_style: 'openai', allow_insecure_tls: false });
    await storage.saveConfig(config); await storage.enableEncryption('configuration-password');
    const publicBefore = await readFile(f.configPath, 'utf8'), encryptedBefore = await readFile(join(f.directory, 'provider-tokens.json'), 'utf8');
    const before = structuredClone(storage.config);
    await rm(f.configPath); await mkdir(f.configPath);
    const next = structuredClone(before); next.providers.find(provider => provider.id === 'before-provider')!.name = 'Rejected mutation';
    await assert.rejects(storage.saveConfig(next), /Unsafe data file/);
    assert.deepEqual(storage.config, before);
    assert.equal(await readFile(join(f.directory, 'provider-tokens.json'), 'utf8'), encryptedBefore);
    await rm(f.configPath, { recursive: true }); await writeFile(f.configPath, publicBefore);
    await storage.close(); storage = await f.open(); await storage.unlock('configuration-password');
    assert.equal(storage.config.providers.find(provider => provider.id === 'before-provider')?.name, 'Before');
  } finally { await f.cleanup(); }
});

test('a real Windows replacement failure rolls back the exact encrypted provider file', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); let holder: ReturnType<typeof spawn> | undefined;
  try {
    let storage = await f.open(); await storage.enableEncryption('configuration-password');
    const before = structuredClone(storage.config), publicBefore = await readFile(f.configPath, 'utf8'), encryptedBefore = await readFile(join(f.directory, 'provider-tokens.json'), 'utf8');
    const script = "$file=[IO.File]::Open($env:GOPHER_TEST_CONFIG,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $file.Dispose()";
    holder = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, GOPHER_TEST_CONFIG: f.configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    const [ready] = await once(holder.stdout!, 'data'); assert.match(String(ready), /locked/);
    const next = structuredClone(before); next.ui.theme = 'light'; next.providers.unshift({ id: 'uncommitted', name: 'Rejected', base: 'https://rejected.example/v1', token: 'rejected-token', kind: 'custom', api_style: 'openai', allow_insecure_tls: false });
    await assert.rejects(storage.saveConfig(next), /Could not secure or durably replace/);
    assert.deepEqual(storage.config, before); assert.equal(storage.unlocked, true);
    assert.equal(await readFile(f.configPath, 'utf8'), publicBefore);
    assert.equal(await readFile(join(f.directory, 'provider-tokens.json'), 'utf8'), encryptedBefore);
    const ended = once(holder, 'exit'); holder.stdin!.end('\n'); await ended; holder = undefined;
    await storage.close(); storage = await f.open(); await storage.unlock('configuration-password');
    assert.deepEqual(storage.config, before);
  } finally { holder?.kill(); if (holder) await once(holder, 'exit').catch(() => undefined); await f.cleanup(); }
});

test('appearance-only saves retain the exact encrypted provider file', async () => {
  const f = await fixture();
  try {
    const storage = await f.open(); await storage.enableEncryption('configuration-password');
    const before = await readFile(join(f.directory, 'provider-tokens.json'), 'utf8');
    const next = structuredClone(storage.config); next.ui.theme = 'light'; await storage.saveConfig(next);
    assert.equal(await readFile(join(f.directory, 'provider-tokens.json'), 'utf8'), before);
    assert.equal(storage.config.ui.theme, 'light');
  } finally { await f.cleanup(); }
});
