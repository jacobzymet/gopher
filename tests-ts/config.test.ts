import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_PROVIDER_ID, normalizeConfig, normalizeProviders, parseConfig, serializeConfig } from '../server/config.js';

const namedConfig = `default_provider = "openrouter"
max_tokens = 8192
render_mode = "markdown"
markdown = true
save_sessions = true

[providers.anthropic]
kind = "anthropic"
base_url = "https://api.anthropic.com/v1"

[providers.gemini]
kind = "gemini"
base_url = "https://generativelanguage.googleapis.com/v1beta"

[providers.openai]
kind = "openai"
base_url = "https://api.openai.com/v1"

[providers.openrouter]
kind = "openrouter"
base_url = "https://openrouter.ai/api/v1"
default_model = "openai/gpt-4.1"
`;

test('named provider tables preserve provider identities and protocol kinds', () => {
  const config = parseConfig(namedConfig);
  assert.equal(config.active_provider_id, 'openrouter');
  const providers = config.providers.filter(provider => provider.kind === 'custom');
  assert.deepEqual(providers.map(provider => provider.id), ['anthropic', 'gemini', 'openai', 'openrouter']);
  assert.deepEqual(providers.map(provider => provider.api_style), ['anthropic', 'openai', 'openai', 'openai']);
  assert.equal(providers[1].base, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(providers[3].default_model, 'openai/gpt-4.1');
  assert.ok(config.providers.some(provider => provider.id === CODEX_PROVIDER_ID));
});

test('named provider aliases become canonical fields without losing credentials or optional settings', () => {
  const config = parseConfig(namedConfig.replace('[providers.anthropic]', '[providers.anthropic]\napi_key = "fixture-api-secret"'));
  const serialized = serializeConfig(config);
  assert.equal(config.providers.find(provider => provider.id === 'anthropic')?.token, 'fixture-api-secret');
  assert.equal(config.max_tokens, 8192); assert.equal(config.render_mode, 'markdown');
  assert.equal(config.markdown, true); assert.equal(config.save_sessions, true);
  assert.equal(normalizeConfig({ max_tokens: 0, render_mode: 'custom-renderer' }).max_tokens, 0);
  assert.equal(normalizeConfig({ max_tokens: 0, render_mode: 'custom-renderer' }).render_mode, 'custom-renderer');
  assert.doesNotMatch(serialized, /\b(?:api_key|base_url|default_provider)\s*=/);
  assert.match(serialized, /\[\[providers\]\]/);
  assert.deepEqual(parseConfig(serialized), config);
  for (const provider of config.providers) {
    assert.equal(Object.hasOwn(provider, 'api_key'), false);
    assert.equal(Object.hasOwn(provider, 'base_url'), false);
  }
});

test('Google and Gemini official native roots use OpenAI compatibility URLs while custom endpoints remain intact', () => {
  for (const kind of ['gemini', 'google']) for (const base of ['https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta/', 'https://generativelanguage.googleapis.com/v1beta/openai']) {
    const config = normalizeConfig({ providers: { selected: { kind, base_url: base } }, default_provider: 'selected' });
    assert.equal(config.providers[0].base, 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(config.providers[0].api_style, 'openai');
  }
  for (const base of ['https://gemini.example/proxy/v1beta', 'http://127.0.0.1:9000/gemini', 'https://generativelanguage.googleapis.com.evil.example/v1beta']) {
    assert.equal(normalizeConfig({ providers: { custom: { kind: 'gemini', base_url: base } } }).providers[0].base, base);
  }
  const explicit = normalizeConfig({ providers: { custom: { kind: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', api_style: 'anthropic' } } });
  assert.equal(explicit.providers[0].base, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(explicit.providers[0].api_style, 'anthropic');
  assert.equal(normalizeConfig({ providers: { claude: { kind: ' ANTHROPIC ', base_url: 'https://api.anthropic.com/v1' } } }).providers[0].api_style, 'anthropic');
});

test('empty named provider maps are valid and active aliases have deterministic precedence', () => {
  const empty = parseConfig('[providers]\n');
  assert.deepEqual(empty.providers.map(provider => provider.id), [CODEX_PROVIDER_ID]);
  const providers = { first: { base_url: 'https://first.example/v1' }, second: { base_url: 'https://second.example/v1' } };
  assert.equal(normalizeConfig({ providers, default_provider: 'second' }).active_provider_id, 'second');
  assert.equal(normalizeConfig({ providers, default_provider: 'second', active_provider_id: 'first' }).active_provider_id, 'first');
});

test('invalid named provider maps fail instead of discarding entries or credentials', () => {
  for (const providers of [null, 'invalid', 123, { bad: null }, { bad: [] }, { bad: 'https://example.com' }, { bad: {} }, { bad: { kind: 'unknown', base_url: 'https://example.com', api_key: 'keep-me' } }, { bad: { base_url: 123 } }, { bad: { base_url: 'https://example.com', api_key: 123 } }, { bad: { base_url: 'https://example.com', api_style: null } }, { bad: { base_url: 'https://example.com', default_model: 123 } }, { bad: { id: 'different', base_url: 'https://example.com' } }, { bad: { base: 'https://first.example', base_url: 'https://second.example' } }, { bad: { base_url: 'https://example.com', token: 'first', api_key: 'second' } }]) {
    assert.throws(() => normalizeProviders(providers), Error);
  }
  for (const extra of [{ default_provider: 1 }, { max_tokens: '8192' }, { render_mode: false }, { markdown: 'yes' }, { save_sessions: 1 }]) assert.throws(() => normalizeConfig(extra), Error);
});

test('provider arrays retain their validation and builtin normalization', () => {
  const result = normalizeProviders([{ id: 'p', base: 'https://example.com/v1', token: 'secret', api_style: 'messages', default_model: 'claude-fixture' }], 'p');
  assert.equal(result.active_provider_id, 'p');
  assert.equal(result.providers[0].api_style, 'anthropic');
  assert.equal(result.providers[0].default_model, 'claude-fixture');
  assert.equal(result.providers.filter(provider => provider.kind === 'openai-codex').length, 1);
  assert.throws(() => normalizeProviders([{ id: 'p', base: 'https://example.com', token: 123 }]), /token must be text/);
  assert.throws(() => normalizeProviders([{ id: 'p', base: 'https://example.com', api_style: 'unsupported' }]), /Invalid provider API style/);
  assert.equal(normalizeProviders([{ id: 'retired', kind: 'retired', base: 'https://example.com' }]).providers.length, 1);
});
