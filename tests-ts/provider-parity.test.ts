import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { sanitizeTitle } from '../server/titles.js';
import { classifyProviderError, describeNetworkError, chooseApiStyle } from '../server/provider-health.js';
import { Providers, type Provider, type ProviderEvent } from '../server/providers.js';
import { Engine } from '../server/engine.js';

async function serve<T>(listener: RequestListener, run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('titles lose quotes, prefixes, thinking and prompt echoes, and keep at most six words', () => {
  assert.equal(sanitizeTitle('"Solar Panel Basics"'), 'Solar Panel Basics');
  assert.equal(sanitizeTitle('Title: Fixing the Build.'), 'Fixing the Build');
  assert.equal(sanitizeTitle('<think>The user wants a short chat title</think>\nRust Lifetimes Explained'), 'Rust Lifetimes Explained');
  assert.equal(sanitizeTitle('<think>never closed'), undefined);
  assert.equal(sanitizeTitle('Write a title with no quotes'), undefined);
  assert.equal(sanitizeTitle('One two three four five six seven eight'), 'One two three four five six');
  assert.equal(sanitizeTitle('Here is a summary of what you asked about today, with details. Garden Planning Tips'), 'Garden Planning Tips');
});

test('title generation falls back to reasoning text and retries without thinking options on HTTP 400', async () => {
  const bodies: Record<string, unknown>[] = [];
  await serve(async (request, response) => {
    if (request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end('{"data":[{"id":"m"}]}'); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    bodies.push(body);
    response.setHeader('content-type', 'application/json');
    if ('reasoning_effort' in body) { response.statusCode = 400; response.end('{"error":"unknown field reasoning_effort"}'); return; }
    response.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Okay.\nTrip Budget Planner' } }] }));
  }, async base => {
    const provider: Provider = { id: 'p', name: 'P', base: `${base}/v1`, token: '', api_style: 'openai', kind: 'custom', allow_insecure_tls: false };
    const providers = new Providers({ getProviders: () => [provider] });
    assert.equal(await providers.title(provider, 'm', 'Help me plan a budget for a trip'), 'Trip Budget Planner');
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]!.reasoning_effort, 'none');
  assert.equal('reasoning_effort' in bodies[1]!, false);
  assert.equal('thinking_effort' in bodies[1]!, false);
});

test('a stopped local model server reports waiting with a readable reason', async () => {
  const closed = createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const provider: Provider = { id: 'down', name: 'Down', base: `http://127.0.0.1:${port}/v1`, token: '', api_style: 'openai', kind: 'custom', allow_insecure_tls: false };
  const { health } = await new Providers({ getProviders: () => [provider] }).probe(provider, true);
  assert.equal(health.kind, 'waiting');
  assert.match(health.message, new RegExp(`Connection refused at 127\\.0\\.0\\.1:${port}\\. Is the model server running\\?`));
  assert.equal(classifyProviderError('HTTP 401'), 'auth');
  assert.equal(classifyProviderError('The provider host name could not be resolved. Check the base URL.'), 'error');
  assert.equal(describeNetworkError(Object.assign(new TypeError('fetch failed'), { cause: new Error('socket hang up') })), 'socket hang up');
});

test('API style detection follows the chat route the server actually exposes', async () => {
  assert.equal(chooseApiStyle('http://host', '', { modelsOk: true, route: 'missing' }, { modelsOk: true, route: 'present' }), 'anthropic');
  assert.equal(chooseApiStyle('http://host', 'sk-ant-x', { modelsOk: false, route: 'unknown' }, { modelsOk: false, route: 'unknown' }), 'anthropic');
  await serve((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') { response.end('{"data":[{"id":"claude-like"}]}'); return; }
    if (request.url === '/v1/messages') { response.statusCode = 405; response.end('{}'); return; }
    response.statusCode = 404; response.end('{}');
  }, async base => {
    const provider: Provider = { id: 'x', name: 'X', base: `${base}/v1`, token: '', api_style: 'openai', kind: 'custom', allow_insecure_tls: false };
    const detection = await new Providers({ getProviders: () => [provider] }).detectApiStyle(provider, true);
    assert.equal(detection.style, 'anthropic');
    assert.equal(detection.probe.health.ok, true);
  });
});

test('read_skill is accepted as the activate_skill tool', async () => {
  const provider: Provider = { id: 't', name: 'T', base: 'http://127.0.0.1:9/v1', token: '', api_style: 'openai', kind: 'custom', allow_insecure_tls: false };
  let round = 0;
  const providers = {
    get: () => provider, catalog: async () => [],
    complete: async function* (): AsyncGenerator<ProviderEvent> {
      if (round++ === 0) yield { type: 'tool', index: 0, id: 'wire', name: 'read_skill', arguments: '{"name":"Haiku"}' };
      else yield { type: 'text', text: 'Done' };
    },
  } as unknown as Providers;
  const skill = { id: 'sk-0123456789abcdef', name: 'Haiku', description: '', enabled: true, content: 'Write in 5-7-5.', created_at: 1, updated_at: 1 };
  const engine = new Engine({ providers, getSkills: async () => [skill] });
  let output = '';
  for await (const frame of engine.start({ model: 'm', conversation_id: 'alias', agent: true, skills: { approval_mode: 'auto_safe' }, messages: [{ role: 'user', content: 'Use the skill' }] })) output += frame;
  assert.match(output, /"phase":"tool_result","id":"[^"]+","name":"activate_skill","ok":true/);
  assert.match(output, /Write in 5-7-5/);
  await engine.cancelAll();
});

test('a model list survives one dropped connection, and a refused completion is retried once', async () => {
  let connections = 0;
  await serve((request, response) => {
    connections++;
    if (connections === 1) { request.socket.destroy(); return; }
    response.setHeader('content-type', 'application/json');
    response.end('{"data":[{"id":"m"}]}');
  }, async base => {
    const provider: Provider = { id: 'flaky', name: 'F', base: `${base}/v1`, token: '', api_style: 'openai', kind: 'custom', allow_insecure_tls: false };
    const { health } = await new Providers({ getProviders: () => [provider] }).probe(provider, true);
    assert.equal(health.ok, true);
    assert.ok(connections >= 2);
  });
  const placeholder = createServer();
  placeholder.listen(0, '127.0.0.1');
  await once(placeholder, 'listening');
  const port = (placeholder.address() as AddressInfo).port;
  await new Promise<void>(resolve => placeholder.close(() => resolve()));
  const provider: Provider = { id: 'late', name: 'L', base: `http://127.0.0.1:${port}/v1`, token: '', api_style: 'openai', kind: 'custom', allow_insecure_tls: false };
  const late = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: 'Ready now' } }] }));
  });
  setTimeout(() => late.listen(port, '127.0.0.1'), 150);
  try {
    let text = '';
    for await (const event of new Providers({ getProviders: () => [provider] }).complete(provider, { model: 'm', messages: [{ role: 'user', content: 'Hi' }] }, AbortSignal.timeout(5000))) {
      if (event.type === 'text') text += event.text;
    }
    assert.equal(text, 'Ready now');
  } finally { late.closeAllConnections(); await new Promise<void>(resolve => late.close(() => resolve())); }
});
