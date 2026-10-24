import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AAD, createEncryption, decryptValue, encryptValue } from '../server/crypto.js';
import { normalizeConfig, serializeConfig } from '../server/config.js';
import { AppStorage } from '../server/storage.js';

test('a 22 MB encrypted conversation archive unlocks and reopens with its background and every conversation intact', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-large-encrypted-'));
  const configPath = join(directory, 'config.toml');
  const passphrase = 'synthetic large archive fixture';
  const { key, meta } = await createEncryption(passphrase);
  const content = 'Synthetic conversation text. '.repeat(3300);
  const chats = { version: 3, activeProfileId: 'saved-profile', profiles: [{ id: 'saved-profile', projects: [], bots: [], conversations: Array.from({ length: 186 }, (_, index) => ({ id: `conversation-${index}`, messages: [{ role: 'user', content: `Question ${index}` }, { role: 'assistant', content: `${index}: ${content}` }] })) }] };
  const preferences = { activeProfileId: 'saved-profile', backgroundImage: `data:image/png;base64,${Buffer.alloc(800 * 1024, 0x61).toString('base64')}` };
  let storage: AppStorage | undefined;
  try {
    const rawChats = JSON.stringify(encryptValue(key, chats, AAD.chats));
    const rawPreferences = JSON.stringify(encryptValue(key, preferences, AAD.preferences));
    assert.ok(Buffer.byteLength(rawChats) > 22_000_000);
    assert.ok(Buffer.byteLength(rawPreferences) > 1_100_000);
    await writeFile(configPath, serializeConfig(normalizeConfig({})));
    await writeFile(join(directory, 'encryption.json'), JSON.stringify(meta));
    await writeFile(join(directory, 'chats.json'), rawChats);
    await writeFile(join(directory, 'preferences.json'), rawPreferences);
    await writeFile(join(directory, 'provider-tokens.json'), JSON.stringify(encryptValue(key, { version: 2, provider_config: { providers: [], active_provider_id: '' } }, AAD.providers)));
    await mkdir(join(directory, 'chat-skills'));
    await writeFile(join(directory, 'chat-skills', 'skills.json'), JSON.stringify(encryptValue(key, [], AAD.skills)));
    key.fill(0);
    storage = await AppStorage.open(configPath);
    assert.equal(storage.unlocked, false);
    await assert.rejects(storage.unlock('incorrect fixture passphrase'), /Incorrect passphrase/);
    assert.equal(storage.unlocked, false);
    await storage.unlock(passphrase);
    assert.deepEqual(await storage.loadChats(), chats);
    assert.deepEqual(await storage.loadPreferences(), preferences);
    await storage.close();
    storage = await AppStorage.open(configPath);
    await storage.unlock(passphrase);
    assert.deepEqual(await storage.loadChats(), chats);
    assert.deepEqual(await storage.loadPreferences(), preferences);
    assert.equal(await readFile(join(directory, 'chats.json'), 'utf8'), rawChats);
    assert.equal(await readFile(join(directory, 'preferences.json'), 'utf8'), rawPreferences);
  } finally {
    key.fill(0);
    await storage?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('base64 validation rejects invalid alphabets, lengths and padding while preserving encrypted-envelope authentication', () => {
  const key = randomBytes(32), value = { text: 'Saved content 你好' };
  try {
    const envelope = encryptValue(key, value, AAD.chats);
    for (const ciphertext of ['A', 'AAA', 'AAAA====', 'AA=A', 'AAAA\nAAAA', 'AAAA-AAA', 'AAAA_AAA', 'A===']) assert.throws(() => decryptValue(key, { ...envelope, ciphertext }, AAD.chats), /Invalid ciphertext\./);
    assert.deepEqual(decryptValue(key, { ...envelope, nonce: ` \n${envelope.nonce}\t`, ciphertext: `\n${envelope.ciphertext} ` }, AAD.chats), value);
    const tampered = Buffer.from(envelope.ciphertext, 'base64'); tampered[0] ^= 1;
    assert.throws(() => decryptValue(key, { ...envelope, ciphertext: tampered.toString('base64') }, AAD.chats), /Incorrect passphrase or corrupted encrypted data/);
    assert.throws(() => decryptValue(key, envelope, AAD.preferences), /Incorrect passphrase or corrupted encrypted data/);
  } finally { key.fill(0); }
});

test('invalid base64 near the end of a large ciphertext produces a validation error without overflowing the stack', () => {
  const key = randomBytes(32);
  try {
    const envelope = encryptValue(key, {}, AAD.chats);
    assert.throws(() => decryptValue(key, { ...envelope, ciphertext: 'A'.repeat(22 * 1024 * 1024) + 'AA!A' }, AAD.chats), /Invalid ciphertext\./);
  } finally { key.fill(0); }
});
