import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AppStorage } from '../server/storage.js';
import { normalizeBase, providerFetch } from '../server/providers.js';
import { parseConfig } from '../server/config.js';

const namedConfig = `default_provider = "openrouter"
max_tokens = 4096
render_mode = "markdown"
markdown = true
save_sessions = true

[providers.anthropic]
kind = "anthropic"
base_url = "https://api.anthropic.com/v1"
api_key = "anthropic-test-key"

[providers.gemini]
kind = "gemini"
base_url = "https://generativelanguage.googleapis.com/v1beta"

[providers.openai]
kind = "openai"
base_url = "https://api.openai.com/v1"

[providers.openrouter]
kind = "openai"
base_url = "https://openrouter.ai/api/v1"
default_model = "fixture/model"
`;

test('named provider tables preserve settings and saved data through startup and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-named-config-'));
  const path = join(directory, 'config.toml');
  let storage: AppStorage | undefined;
  try {
    await writeFile(path, namedConfig);
    await writeFile(join(directory, 'chats.json'), '[{"id":"kept-chat","messages":[{"role":"user","content":"kept"}]}]');
    await writeFile(join(directory, 'preferences.json'), '{"theme":"light"}');
    storage = await AppStorage.open(path);
    assert.equal(storage.config.active_provider_id, 'openrouter');
    assert.deepEqual(storage.config.providers.filter(provider => provider.kind === 'custom').map(provider => provider.id), ['anthropic', 'gemini', 'openai', 'openrouter']);
    assert.equal(storage.config.providers.find(provider => provider.id === 'anthropic')?.token, 'anthropic-test-key');
    assert.equal(storage.config.providers.find(provider => provider.id === 'anthropic')?.api_style, 'anthropic');
    assert.equal(storage.config.providers.find(provider => provider.id === 'gemini')?.base, 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(storage.config.providers.find(provider => provider.id === 'openrouter')?.default_model, 'fixture/model');
    assert.equal(storage.config.max_tokens, 4096);
    assert.equal(storage.config.render_mode, 'markdown');
    assert.equal(storage.config.markdown, true);
    assert.equal(storage.config.save_sessions, true);
    assert.equal((await storage.loadChats()).conversations?.[0]?.messages?.[0].content, 'kept');
    assert.equal((await storage.loadPreferences()).theme, 'light');
    const expected = structuredClone(storage.config);
    await storage.close();
    storage = await AppStorage.open(path);
    assert.deepEqual(storage.config, expected);
    const persisted = await readFile(path, 'utf8');
    assert.match(persisted, /\[\[providers\]\]/);
    assert.doesNotMatch(persisted, /api_key|default_provider\s*=/);
    await storage.enableEncryption('named-provider-passphrase');
    const protectedConfig = await readFile(path, 'utf8');
    for (const privateValue of ['anthropic-test-key', 'openrouter', 'fixture/model', 'api.anthropic.com']) assert.equal(protectedConfig.includes(privateValue), false);
    await storage.close();
    storage = await AppStorage.open(path);
    assert.equal(storage.encrypted, true);
    assert.equal(storage.unlocked, false);
    await storage.unlock('named-provider-passphrase');
    assert.deepEqual(storage.config, expected);
    assert.equal((await storage.loadChats()).conversations?.[0]?.id, 'kept-chat');
  } finally {
    await storage?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an invalid named provider table fails without overwriting its configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-invalid-named-config-'));
  const path = join(directory, 'config.toml');
  const invalid = '[providers.private]\nkind="openai"\napi_key="keep-this-key"\n';
  try {
    await writeFile(path, invalid);
    await assert.rejects(AppStorage.open(path), /base|URL/i);
    assert.equal(await readFile(path, 'utf8'), invalid);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Gemini compatibility requests preserve their endpoint prefix', async () => {
  assert.equal(normalizeBase('https://generativelanguage.googleapis.com/v1beta/openai/'), 'https://generativelanguage.googleapis.com/v1beta/openai');
  const urls: string[] = [];
  const server = createServer((request, response) => {
    urls.push(request.url || '');
    response.setHeader('content-type', 'application/json');
    response.end('{"data":[]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config = parseConfig(`[providers.gemini]\nkind="gemini"\nbase_url="http://127.0.0.1:${address.port}/v1beta/openai"\n`);
    const provider = config.providers.find(item => item.id === 'gemini');
    assert.ok(provider);
    const response = await providerFetch(provider, 'models');
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.deepEqual(urls, ['/v1beta/openai/models']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
