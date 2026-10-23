import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStorage } from '../server/storage.js';

async function withStorage(run: (storage: AppStorage, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-cache-'));
  const storage = await AppStorage.open(join(directory, 'config.toml'));
  try { await run(storage, directory); }
  finally { await storage.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const store = (title: string, text = 'hello') => ({
  version: 2, projects: [], bots: [], conversations: [{ id: 'c1', title, messages: [{ role: 'user', content: text }] }],
});

test('decoded stores are reused until the file changes, including external edits', async () => {
  await withStorage(async (storage, directory) => {
    await storage.saveChats(store('First'));
    const first = await storage.readChats();
    assert.equal(await storage.readChats(), first, 'an unchanged file returns the same decoded object');
    const copy = await storage.loadChats();
    copy.conversations[0].title = 'Mutated copy';
    assert.equal((await storage.readChats()).conversations[0].title, 'First', 'loadChats hands out an independent copy');
    await new Promise(resolve => setTimeout(resolve, 20));
    await writeFile(join(directory, 'chats.json'), JSON.stringify(store('Edited outside')));
    assert.equal((await storage.readChats()).conversations[0].title, 'Edited outside');
    await storage.savePreferences({ theme: 'light' });
    assert.equal((await storage.readPreferences()).theme, 'light');
  });
});

test('an encrypted store is decrypted once per change and forgotten on lock', async () => {
  await withStorage(async storage => {
    const text = 'Synthetic conversation text. '.repeat(250_000);
    await storage.saveChats(store('Large', text));
    await storage.enableEncryption('cache passphrase');
    await storage.lock();
    await assert.rejects(storage.readChats(), /encrypted/i);
    await storage.unlock('cache passphrase');
    let started = performance.now();
    const unlocked = await storage.readChats();
    const firstRead = performance.now() - started;
    assert.equal(unlocked.conversations[0].messages[0].content.length, text.length);
    started = performance.now();
    for (let index = 0; index < 20; index++) assert.equal(await storage.readChats(), unlocked);
    const repeated = (performance.now() - started) / 20;
    assert.ok(repeated < 20, `cached reads should not decrypt again (took ${repeated.toFixed(1)} ms each)`);
    assert.ok(firstRead < 200, `the first read after unlock reuses the unlock check (took ${firstRead.toFixed(1)} ms)`);
    await storage.saveChats(store('Changed'));
    assert.equal((await storage.readChats()).conversations[0].title, 'Changed');
    await storage.lock();
    await assert.rejects(storage.readChats(), /encrypted/i);
  });
});

test('a permission change on a cached file still triggers the private-mode repair', { skip: process.platform === 'win32' }, async () => {
  const { chmod, stat } = await import('node:fs/promises');
  await withStorage(async (storage, directory) => {
    await storage.saveChats(store('Private'));
    await storage.readChats();
    await chmod(join(directory, 'chats.json'), 0o644);
    await storage.readChats();
    assert.equal((await stat(join(directory, 'chats.json'))).mode & 0o777, 0o600);
  });
});
