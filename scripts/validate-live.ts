import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseSSE } from '../server/providers.js';

export interface LiveOptions { origin: string; providerId: string; model: string; timeoutMs?: number; disableThinkingTemplate?: boolean; source?: 'live-service' | 'protocol-fixture' }
interface PublicProvider { id: string; name: string; kind: string; api_style: string; token_set: boolean }
export interface LiveReport {
  schema_version: 1; source: 'live-service' | 'protocol-fixture'; started_at: string; finished_at: string; app_version: string;
  provider: PublicProvider; model: string; thinking_template_disabled: boolean; passed: boolean;
  catalog: { passed: boolean; refreshed: boolean; models: number };
  stream: { passed: boolean; done: boolean; frames: number; content_chunks: number; reasoning_chunks: number; output_chars: number; expected_marker: boolean; first_token_ms: number | null; elapsed_ms: number };
  cancellation: { passed: boolean; requested_after_first_delta: boolean; acknowledged: boolean; done: boolean; elapsed_ms: number; stop_ms: number | null; still_active: boolean };
  replay: { passed: boolean; done: boolean; content_chars: number };
  oauth_rotation: { status: 'not-tested'; reason: string };
  restart: { status: 'not-tested'; reason: string };
  failures: string[];
}

export function localOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'gopher.localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Validation requires an HTTP loopback origin without credentials or a path.');
  return url.origin;
}

export async function localClient(raw: string, transport: typeof fetch = fetch) {
  const origin = localOrigin(raw);
  const bootstrap = await transport(origin, { signal: AbortSignal.timeout(5000), redirect: 'error' }); await bootstrap.body?.cancel();
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
  if (!bootstrap.ok || !cookie?.startsWith('gopher_session=')) throw new Error('Local application bootstrap failed.');
  const request = (path: string, body?: unknown, timeoutMs = 60_000) => transport(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  async function json(path: string, body?: unknown, timeoutMs?: number): Promise<any> {
    const response = await request(path, body, timeoutMs);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Local API ${path} returned HTTP ${response.status}.`); }
    return response.json();
  }
  return { origin, request, json };
}

export async function maskedInventory(origin: string, transport: typeof fetch = fetch) {
  const client = await localClient(origin, transport); const state = await client.json('/api/state');
  return { version: String(state.version || ''), locked: state.encryption_enabled && !state.encryption_unlocked,
    providers: (state.providers || []).map((provider: any) => ({ id: provider.id, name: provider.name, kind: provider.kind, api_style: provider.api_style, token_set: Boolean(provider.token_set), ready: provider.health?.ok === true, models: (state.network?.remote_models || []).filter((model: any) => model.provider_id === provider.id && model.ready).map((model: any) => model.model) })) };
}

interface StreamResult { done: boolean; frames: number; contentChunks: number; reasoningChunks: number; text: string; firstTokenMs: number | null; elapsedMs: number; providerError: boolean }
async function consume(response: Response, started: number, firstDelta?: () => Promise<void>): Promise<StreamResult> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`stream_http_${response.status}`); }
  const result: StreamResult = { done: false, frames: 0, contentChunks: 0, reasoningChunks: 0, text: '', firstTokenMs: null, elapsedMs: 0, providerError: false };
  for await (const frame of parseSSE(response)) {
    if (++result.frames > 10_000) throw new Error('stream_frame_limit');
    if (frame.data === '[DONE]') { result.done = true; break; }
    if (frame.event === 'error') { result.providerError = true; continue; }
    let item: any; try { item = JSON.parse(frame.data); } catch { continue; }
    for (const choice of item.choices || []) {
      const delta = choice.delta || {};
      if (delta.content) { result.contentChunks++; result.text += delta.content; }
      if (delta.reasoning_content) result.reasoningChunks++;
      if ((delta.content || delta.reasoning_content) && result.firstTokenMs === null) { result.firstTokenMs = Date.now() - started; await firstDelta?.(); }
      if (result.text.length > 100_000) throw new Error('stream_output_limit');
    }
  }
  result.elapsedMs = Date.now() - started; return result;
}

/** This opt-in runner uses only the local API; credentials and saved chats never enter its report. */
export async function validateLive(options: LiveOptions, transport: typeof fetch = fetch): Promise<LiveReport> {
  const client = await localClient(options.origin, transport); const state = await client.json('/api/state');
  if (state.encryption_enabled && !state.encryption_unlocked) throw new Error('Unlock the local test profile before validation.');
  const selected = (state.providers || []).find((provider: any) => provider.id === options.providerId);
  if (!selected) throw new Error('Configured provider was not found.');
  if (!(state.network?.remote_models || []).some((model: any) => model.provider_id === selected.id && model.model === options.model && model.ready)) throw new Error('Choose an advertised ready model from the configured provider.');
  const provider: PublicProvider = { id: String(selected.id), name: String(selected.name), kind: String(selected.kind), api_style: String(selected.api_style), token_set: Boolean(selected.token_set) };
  const report: LiveReport = { schema_version: 1, source: options.source || 'live-service', started_at: new Date().toISOString(), finished_at: '', app_version: String(state.version || ''), provider, model: options.model, thinking_template_disabled: Boolean(options.disableThinkingTemplate), passed: false,
    catalog: { passed: false, refreshed: false, models: 0 }, stream: { passed: false, done: false, frames: 0, content_chunks: 0, reasoning_chunks: 0, output_chars: 0, expected_marker: false, first_token_ms: null, elapsed_ms: 0 },
    cancellation: { passed: false, requested_after_first_delta: false, acknowledged: false, done: false, elapsed_ms: 0, stop_ms: null, still_active: true }, replay: { passed: false, done: false, content_chars: 0 },
    oauth_rotation: { status: 'not-tested', reason: provider.kind === 'openai-codex' ? 'Imported access token used without forcing refresh or modifying the original CLI session.' : 'This provider uses a configured API credential, not the built-in OAuth flow.' },
    restart: { status: 'not-tested', reason: 'This runner does not restart an existing user application. Use the isolated encrypted-profile runner for restart evidence.' }, failures: [] };
  const timeoutMs = Math.max(1000, Math.min(180_000, options.timeoutMs || 60_000));
  const base = { provider_id: provider.id, model: options.model, temperature: 0, skills: { chat_retrieval: false }, thinking_effort: 'low', ...(options.disableThinkingTemplate ? { chat_template_kwargs: { enable_thinking: false } } : {}) };
  try {
    const probe = await client.json('/api/providers/test', { id: provider.id, api_style: provider.api_style, force: true }, timeoutMs);
    report.catalog = { passed: probe.ok === true && probe.models > 0, refreshed: probe.refreshed === true, models: Number(probe.models) || 0 };
  } catch { report.failures.push('catalog_probe_failed'); }
  const streamId = `release_stream_${randomUUID()}`;
  try {
    const started = Date.now(); const response = await client.request('/api/chat/completions', { ...base, conversation_id: streamId, turn_id: 'release_stream', max_tokens: 128, messages: [{ role: 'user', content: 'Reply with exactly LIVE_OK and no other text. /no_think' }] }, timeoutMs);
    const result = await consume(response, started); const expected = result.text.trim() === 'LIVE_OK';
    report.stream = { passed: result.done && expected && !result.providerError, done: result.done, frames: result.frames, content_chunks: result.contentChunks, reasoning_chunks: result.reasoningChunks, output_chars: result.text.length, expected_marker: expected, first_token_ms: result.firstTokenMs, elapsed_ms: result.elapsedMs };
    if (result.providerError) report.failures.push('stream_provider_error');
  } catch { report.failures.push('stream_request_failed'); }
  finally { await client.json('/api/chat/cancel', { conversation_id: streamId }).catch(() => {}); }
  const cancelId = `release_cancel_${randomUUID()}`;
  try {
    const started = Date.now(); let stopMs: number | null = null, acknowledged = false, requested = false;
    const response = await client.request('/api/chat/completions', { ...base, conversation_id: cancelId, turn_id: 'release_cancel', max_tokens: 512, messages: [{ role: 'user', content: 'Write numbered lines from 1 through 200, one number per line. Start immediately with 1 and continue until 200. /no_think' }] }, timeoutMs);
    const result = await consume(response, started, async () => { requested = true; const stopping = Date.now(); const cancellation = await client.json('/api/chat/cancel', { conversation_id: cancelId, turn_id: 'release_cancel' }); stopMs = Date.now() - stopping; acknowledged = cancellation.cancelled === true && cancellation.settled === true; });
    const after = await client.json('/api/state'); const active = (after.live_turns || []).some((turn: any) => turn.conversation_id === cancelId);
    report.cancellation = { passed: requested && acknowledged && result.done && !active && !result.providerError, requested_after_first_delta: requested, acknowledged, done: result.done, elapsed_ms: result.elapsedMs, stop_ms: stopMs, still_active: active };
    const replay = await consume(await client.request(`/api/chat/live/${cancelId}`, undefined, timeoutMs), Date.now());
    report.replay = { passed: replay.done && replay.text === result.text, done: replay.done, content_chars: replay.text.length };
  } catch { report.failures.push('cancellation_or_replay_failed'); }
  finally { await client.json('/api/chat/cancel', { conversation_id: cancelId }).catch(() => {}); }
  report.passed = report.catalog.passed && report.stream.passed && report.cancellation.passed && report.replay.passed && !report.failures.length;
  report.finished_at = new Date().toISOString(); return report;
}

async function isolatedServer(config: string) {
  const child = spawn(process.execPath, [resolve('dist/server/index.js'), '--headless', '--config', config, '--bind', '127.0.0.1:0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout!.on('data', data => { logs = (logs + String(data)).slice(-16_000); }); child.stderr!.on('data', () => {});
  child.on('message', (message: any) => { if (message?.type === 'native-request' && child.connected) child.send({ type: 'native-response', id: message.id, error: 'Interactive native actions are disabled during isolated release validation.' }); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let spawnError = false; child.once('error', () => { spawnError = true; });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) { await exited; return; }
    const timeout = setTimeout(() => child.kill(), 7000); timeout.unref();
    try { if (child.connected) child.send({ type: 'shutdown' }); else child.kill(); await exited; } finally { clearTimeout(timeout); }
  }
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError || child.exitCode !== null) throw new Error('Isolated release server failed to start.');
      const match = /Gopher listening on http:\/\/gopher\.localhost:(\d+)/.exec(logs);
      if (match) return { origin: `http://127.0.0.1:${match[1]}`, stop };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Isolated release server startup timed out.');
  } catch (error) { await stop(); throw error; }
}

export interface IsolatedCodexReport { source: 'live-service'; imported: boolean; encrypted_at_rest: boolean; locked_metadata_hidden: boolean; locked_after_restart: boolean; credential_restored_after_unlock: boolean; catalog_health: { kind: string; http_status: number | null; ready_models: number } | null; stream_before_restart: LiveReport | null; stream_after_restart: LiveReport | null; cli_auth_unchanged: boolean; temporary_profile_removed: boolean; oauth_rotation: 'not-forced-to-preserve-personal-cli-session'; failures: string[]; passed: boolean }

/** Imports into a disposable encrypted profile without rotating an expiring personal credential. */
export async function validateIsolatedCodex(model?: string): Promise<IsolatedCodexReport> {
  const authPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  const original = await readFile(authPath); const auth = JSON.parse(original.toString('utf8')); const tokens = auth.tokens || auth;
  let expiry = 0; try { expiry = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8')).exp || 0; } catch {}
  if (!tokens.access_token || !tokens.refresh_token || expiry < Date.now() / 1000 + 1800) throw new Error('The personal CLI access token needs renewal soon. Use a separate test login; validation will not rotate the personal refresh token.');
  const directory = await mkdtemp(join(tmpdir(), 'gopher-live-codex-')); const config = join(directory, 'config.toml');
  let passphrase = randomBytes(32).toString('base64url');
  let server: Awaited<ReturnType<typeof isolatedServer>> | undefined;
  const report: IsolatedCodexReport = { source: 'live-service', imported: false, encrypted_at_rest: false, locked_metadata_hidden: false, locked_after_restart: false, credential_restored_after_unlock: false, catalog_health: null, stream_before_restart: null, stream_after_restart: null, cli_auth_unchanged: false, temporary_profile_removed: false, oauth_rotation: 'not-forced-to-preserve-personal-cli-session', failures: [], passed: false };
  let stage = 'startup';
  try {
    server = await isolatedServer(config); let client = await localClient(server.origin);
    stage = 'encryption'; await client.json('/api/data/encryption/enable', { passphrase, passphrase_confirm: passphrase });
    stage = 'import';
    await client.json('/api/subscription/codex/import', { confirm: true }, 60_000); report.imported = true;
    stage = 'catalog'; let state = await client.json('/api/state');
    for (let attempt = 0; attempt < 100 && !(state.network?.remote_models || []).some((item: any) => item.provider_id === 'builtin-openai-codex' && item.ready); attempt++) { await new Promise(resolve => setTimeout(resolve, 200)); state = await client.json('/api/state'); }
    const models = (state.network?.remote_models || []).filter((item: any) => item.provider_id === 'builtin-openai-codex' && item.ready);
    const health = state.providers.find((item: any) => item.id === 'builtin-openai-codex')?.health;
    report.catalog_health = { kind: String(health?.kind || 'unknown'), http_status: Number(/HTTP (\d{3})/.exec(String(health?.message || ''))?.[1]) || null, ready_models: models.length };
    const selected = model ? models.find((item: any) => item.model === model) : models.find((item: any) => /mini|flash|spark/.test(item.model)) || models[0];
    if (!selected) throw new Error('No requested ready Codex model was returned after the approved import.');
    const providerBytes = await readFile(join(directory, 'provider-tokens.json')); const publicConfig = await readFile(config);
    const envelope = JSON.parse(providerBytes.toString('utf8'));
    report.encrypted_at_rest = (envelope.gopher_crypto === 1 || envelope.gopher_crypto === 2) && typeof envelope.ciphertext === 'string' && !providerBytes.includes(tokens.access_token) && !providerBytes.includes(tokens.refresh_token) && !publicConfig.includes(tokens.access_token) && !publicConfig.includes(tokens.refresh_token) && !publicConfig.includes(passphrase);
    stage = 'before_restart'; report.stream_before_restart = await validateLive({ origin: server.origin, providerId: 'builtin-openai-codex', model: selected.model, timeoutMs: 120_000 });
    stage = 'lock';
    await client.json('/api/data/encryption/lock', {});
    state = await client.json('/api/state'); report.locked_metadata_hidden = !state.encryption_unlocked && state.providers.length === 0 && state.network.remote_models.length === 0;
    stage = 'restart'; await server.stop(); server = await isolatedServer(config); client = await localClient(server.origin);
    state = await client.json('/api/state'); report.locked_after_restart = state.encryption_enabled && !state.encryption_unlocked && state.providers.length === 0;
    stage = 'unlock'; await client.json('/api/data/encryption/unlock', { passphrase });
    for (let attempt = 0; attempt < 100; attempt++) { state = await client.json('/api/state'); if ((state.network?.remote_models || []).some((item: any) => item.provider_id === 'builtin-openai-codex' && item.model === selected.model && item.ready)) break; await new Promise(resolve => setTimeout(resolve, 200)); }
    report.credential_restored_after_unlock = state.providers.some((provider: any) => provider.id === 'builtin-openai-codex' && provider.token_set);
    stage = 'after_restart'; report.stream_after_restart = await validateLive({ origin: server.origin, providerId: 'builtin-openai-codex', model: selected.model, timeoutMs: 120_000 });
  } catch { report.failures.push(`${stage}_failed`); } finally {
    try {
      await server?.stop();
      report.cli_auth_unchanged = createHash('sha256').update(await readFile(authPath)).digest('hex') === createHash('sha256').update(original).digest('hex');
    } finally {
      passphrase = ''; original.fill(0);
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); report.temporary_profile_removed = true;
    }
  }
  report.passed = report.imported && report.encrypted_at_rest && report.locked_metadata_hidden && report.locked_after_restart && report.credential_restored_after_unlock && report.stream_before_restart?.passed === true && report.stream_after_restart?.passed === true && report.cli_auth_unchanged && report.temporary_profile_removed;
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const flag = (key: string) => { const at = args.indexOf(key); return at >= 0 ? args[at + 1] : undefined; };
  if (args.includes('--help')) { console.log('Live release validation (opt-in, may incur provider usage)\n\n--list [--origin URL]  Read masked configured-provider metadata\n--run --provider-id ID --model MODEL [--origin URL] [--output PATH]\n  Checks catalog, streaming, Stop after first delta, and replay.\n--template-thinking-off  Send enable_thinking:false only to a known compatible endpoint\n--run --import-local-codex [--model MODEL] [--output PATH]\n  Requires explicit approval to import the local session into a disposable encrypted\n  profile. Verifies lock, restart, unlock, and real inference; never forces refresh.'); return; }
  const origin = flag('--origin') || 'http://127.0.0.1:3930';
  if (args.includes('--list')) { console.log(JSON.stringify(await maskedInventory(origin), null, 2)); return; }
  if (args.includes('--run') && args.includes('--import-local-codex')) {
    const report = await validateIsolatedCodex(flag('--model')); const output = flag('--output');
    if (output) { const file = resolve(output); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
    console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1; return;
  }
  if (!args.includes('--run') || !flag('--provider-id') || !flag('--model')) throw new Error('Opt-in required: --run --provider-id ID --model MODEL [--origin URL] [--output PATH]. --list reads masked metadata only.');
  const report = await validateLive({ origin, providerId: flag('--provider-id')!, model: flag('--model')!, timeoutMs: Number(flag('--timeout-ms')) || undefined, disableThinkingTemplate: args.includes('--template-thinking-off') });
  const output = flag('--output');
  if (output) { const file = resolve(output); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Live validation failed. Check --help, the local application, and the selected model. No raw service or credential errors were printed.'); process.exitCode = 1; });
