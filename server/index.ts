import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, join, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { AppStorage } from './storage.js';
import { Providers, normalizeBase } from './providers.js';
import { Engine } from './engine.js';
import { terminals } from './terminal.js';
import { extractAttachment } from './attachments.js';
import { beginCodexLogin, importCodexCliSecret, requestDeviceCode, pollDeviceCode } from './subscription.js';
import { resolveBind, defaultConfig, defaultConfigPath, parseConfig, FONT_BODY_IDS, FONT_DISPLAY_IDS, FONT_MONO_IDS, type Provider } from './config.js';
import { openExternal, pickWorkspace, focus } from './system.js';
import { checkUpdates, applyUpdate, buildVersion } from './updates.js';
import { frontendPrompts } from './prompts.js';
import { DiagnosticTrace, diagnosticContext, record } from './diagnostics.js';
import { parseCliArgs } from './cli.js';

type Body = Record<string, any>;
export class HttpError extends Error { constructor(readonly status: number, message: string, readonly code?: string) { super(message); } }
export interface ServerOptions { configPath?: string; bind?: string; publicDir?: string }
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = fileURLToPath(import.meta.url).endsWith('.ts') ? resolve(dirname(fileURLToPath(import.meta.url)), '..') : projectRoot;
const builtRuntime = !fileURLToPath(import.meta.url).endsWith('.ts');
const promptRoot = builtRuntime ? resolve(dirname(fileURLToPath(import.meta.url)), '../prompts') : join(sourceRoot, 'prompts');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.json': 'application/json' };

async function readBody(request: IncomingMessage): Promise<any> {
  const limit = request.url?.startsWith('/api/data/store') ? 64 * 1024 * 1024 : request.url?.startsWith('/api/data/preferences') ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
  if (Number(request.headers['content-length']) > limit) throw new HttpError(413, 'Request exceeds the size limit.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new HttpError(413, 'Request exceeds the size limit.'); chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Request body must contain valid JSON.'); }
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}
function equalSecret(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function requestPath(request: IncomingMessage): string {
  const path = new URL(request.url || '/', 'http://localhost').pathname;
  if (/%2f|%5c/i.test(path)) throw new HttpError(400, 'Encoded path separators are not allowed.');
  try { return decodeURIComponent(path); } catch { throw new HttpError(400, 'Invalid request path.'); }
}
function id(value: unknown): string { const result = String(value || '').trim(); if (!/^[\w.-]{1,128}$/.test(result)) throw new HttpError(400, 'Invalid live turn identifier.'); return result; }
function publicSkill(skill: any): Body { return { ...skill, content_chars: [...String(skill.content || '')].length }; }
function providerName(value: unknown, base: string): string { return [...String(value || '').replace(/\p{Cc}/gu, ' ').split(/\s+/).filter(Boolean).join(' ')].slice(0, 64).join('') || new URL(base).hostname; }

export async function createApp(options: ServerOptions = {}) {
  const storage = await AppStorage.open(options.configPath);
  let bind: ReturnType<typeof resolveBind>;
  try { bind = resolveBind(storage.config, options.bind); } catch (error) { await storage.close(); throw error; }
  const providers = new Providers({ getProviders: () => storage.config.providers, getActiveProviderId: () => storage.config.active_provider_id, saveProvider: async provider => {
    const next = structuredClone(storage.config);
    const index = next.providers.findIndex(p => p.id === provider.id);
    if (index < 0) throw new Error('Provider was removed while credentials refreshed.');
    next.providers[index] = provider;
    await storage.saveConfig(next);
    providerRevision++;
  } });
  const engine = new Engine({ providers, getStore: () => storage.loadChats(), getPreferences: () => storage.loadPreferences(), getSkills: () => storage.listSkills(), onEvent: (_event, data) => record('agent.event', data) });
  const token = randomBytes(32).toString('base64url');
  const sockets = new WebSocketServer({ noServer: true });
  const streams = new Set<ServerResponse>();
  const protectedResponses = new Set<ServerResponse>();
  let signInCancel: (() => void) | undefined;
  let deviceTimer: NodeJS.Timeout | undefined;
  let deviceStatus: Body = { status: 'idle' };
  let port = bind.port;
  let catalog: any[] = [];
  let catalogBusy = false;
  let warmAgain = false;
  let providerRevision = 0;
  let disposed = false;
  let catalogReady = false;
  let catalogAt = 0;
  let sessionGeneration = 0;
  const health = new Map<string, any>();
  const publicDir = options.publicDir || (builtRuntime ? resolve(dirname(fileURLToPath(import.meta.url)), '../public') : join(sourceRoot, 'dist/public'));
  const diagnosticTimer = setInterval(() => { if (!storage.encrypted || storage.unlocked) void storage.flushDiagnostics().catch(error => storage.diagnostics.error(error)); }, 2000); diagnosticTimer.unref();

  const warm = async (force = false) => {
    if (disposed || (storage.encrypted && !storage.unlocked)) return;
    if (force) { catalogAt = 0; catalogReady = false; }
    if (catalogBusy) { if (force) warmAgain = true; return; }
    if (!force && catalogAt && Date.now() - catalogAt < 60_000) return;
    catalogBusy = true;
    const generation = sessionGeneration;
    const revision = providerRevision;
    try {
      const refreshed = await providers.catalog(force);
      if (disposed || generation !== sessionGeneration || (storage.encrypted && !storage.unlocked)) return;
      if (revision !== providerRevision) { warmAgain = true; return; }
      catalog = refreshed;
      for (const provider of storage.config.providers) {
        const models = catalog.filter(m => m.provider_id === provider.id && !m.connect_kind);
        const previous = providers.cachedHealth(provider.id) || health.get(provider.id);
        if (models.length) health.set(provider.id, { ok: true, kind: 'ready', status: 'ready', model: models[0].model, models: models.length });
        else health.set(provider.id, previous || { ok: false, kind: provider.kind === 'openai-codex' && !provider.token ? 'disconnected' : 'empty', status: 'No models available' });
      }
      catalogAt = Date.now(); catalogReady = true;
    } catch (error) { storage.diagnostics.push('server', { level: 'error', event: 'models.refresh.error', data: { error: String(error) } }); }
    finally { catalogBusy = false; if (warmAgain && !disposed) { warmAgain = false; void warm(true); } }
  };
  function publicProviders(): Body[] {
    return storage.config.providers.map(provider => ({ id: provider.id, name: provider.name, base: provider.base, kind: provider.kind, builtin: provider.kind !== 'custom', api_style: provider.api_style, allow_insecure_tls: provider.allow_insecure_tls, active: provider.id === storage.config.active_provider_id, token_set: Boolean(provider.token), token_masked: provider.token ? '••••••••' : '', health: health.get(provider.id) || null }));
  }
  function state(): Body {
    const locked = storage.encrypted && !storage.unlocked;
    const remotes = locked ? [] : publicProviders();
    const active = locked ? undefined : storage.config.providers.find(p => p.id === storage.config.active_provider_id);
    const activeHealth = active ? health.get(active.id) : undefined;
    const models = locked ? [] : catalog;
    return {
      version: buildVersion(), ...(locked ? { theme: 'dark', font_body: 'inter', font_display: 'space-grotesk', font_mono: 'jetbrains-mono', font_scale: 'default' } : storage.config.ui),
      thinking_supported: models.some(m => m.thinking_supported || m.reasoning_supported), encryption_enabled: storage.encrypted, encryption_unlocked: storage.unlocked,
      config_path: locked ? '' : storage.configPath, providers: remotes, live_turns: locked ? [] : engine.liveTurns(),
      network: { via_remote: !locked && Boolean(active), remote_base: active?.base || '', remote_label: active?.base.replace(/^https?:\/\//, '') || '', remote_name: active?.name || '', active_remote_id: active?.id || '', remote_count: remotes.length, remote_saved: Boolean(active), remote_ok: Boolean(activeHealth?.ok || models.some(m => m.provider_id === active?.id && !m.connect_kind)), remote_checking: !locked && catalogBusy && !catalogReady, remote_catalog_pending: !locked && !catalogReady && catalogBusy, remote_kind: activeHealth?.kind || (catalogBusy ? 'checking' : null), remote_error: activeHealth?.error || null, remote_model: activeHealth?.model || models.find(m => !m.connect_kind)?.model || null, remote_status: activeHealth?.status || null, remote_models: models, remotes, inference_mode: locked ? 'locked' : active ? 'remote' : 'local' },
    };
  }
  const providerResponse = () => ({ providers: publicProviders(), state: state() });
  async function revoke(): Promise<void> {
    sessionGeneration++;
    providers.clear();
    signInCancel?.(); signInCancel = undefined;
    clearTimeout(deviceTimer); deviceTimer = undefined; deviceStatus = { status: 'idle' };
    for (const response of protectedResponses) {
      if (!response.headersSent) json(response, { error: 'Session was locked.', code: 'encrypted_locked' }, 423); else response.end();
    }
    protectedResponses.clear();
    await engine.cancelAll();
    await terminals.closeAll();
    for (const socket of sockets.clients) socket.close(1008, 'Session locked');
    for (const stream of streams) stream.end();
    streams.clear(); catalog = []; catalogAt = 0; catalogReady = false; health.clear();
  }
  function authorize(request: IncomingMessage): void {
    const address = bind.host.includes(':') ? `[${bind.host}]` : bind.host;
    const authorities = [`${address}:${port}`, `gopher.localhost:${port}`, `localhost:${port}`];
    if (!authorities.includes(String(request.headers.host).toLowerCase())) throw new HttpError(421, 'Invalid Host header.');
    const path = requestPath(request);
    if (!path.startsWith('/api/')) return;
    const origin = request.headers.origin;
    if (origin !== undefined && !authorities.some(host => origin === `http://${host}`)) throw new HttpError(401, 'Unauthorized local API request.');
    if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) throw new HttpError(401, 'Unauthorized local API request.');
    const supplied = request.headers['x-gopher-token'] || request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('gopher_session='))?.slice(15) || '';
    if (!equalSecret(String(supplied), token)) throw new HttpError(401, 'Unauthorized local API request.');
    if (storage.encrypted && !storage.unlocked && !((request.method === 'GET' && ['/api/state', '/api/data'].includes(path)) || (request.method === 'POST' && ['/api/data/encryption/unlock', '/api/focus', '/api/open-url'].includes(path)))) throw new HttpError(423, 'Encrypted local data is locked. Unlock it before using this API.', 'encrypted_locked');
  }
  async function sendStream(response: ServerResponse, stream: AsyncIterable<string>): Promise<void> {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    response.flushHeaders(); streams.add(response);
    const timer = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n'); }, 15_000); timer.unref();
    try { for await (const frame of stream) { if (response.destroyed || response.writableEnded) break; record('stream.frame', { text: frame }); if (!response.write(frame)) await Promise.race([once(response, 'drain'), once(response, 'close')]); } }
    catch (error) { if (!response.destroyed && !response.writableEnded) response.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\ndata: [DONE]\n\n`); }
    finally { clearInterval(timer); streams.delete(response); record('stream.finished', {}); response.end(); }
  }

  const server = createServer((request, response) => diagnosticContext.run(new DiagnosticTrace(storage.diagnostics, String(request.headers['x-gopher-conversation-id'] || ''), /^[\w.-]{1,128}$/.test(String(request.headers['x-gopher-request-id'] || '')) ? String(request.headers['x-gopher-request-id']) : undefined), async () => {
    response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('x-frame-options', 'DENY'); response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; script-src-attr 'none'");
    try {
      authorize(request);
      const url = new URL(request.url || '/', 'http://localhost'); const path = requestPath(request); const method = request.method || 'GET';
      if (path.startsWith('/api/') && path !== '/api/diagnostics') { const trace = diagnosticContext.getStore(); record('http.request', { method, path }); response.once('finish', () => trace?.record('http.response', { path, status: response.statusCode })); }
      if (path.startsWith('/api/')) {
        response.setHeader('cache-control', 'no-store');
        const requestGeneration = sessionGeneration;
        const assertActive = () => { if (requestGeneration !== sessionGeneration || response.writableEnded) throw new HttpError(423, 'Session changed while the request was running.', 'encrypted_locked'); };
        if (!path.startsWith('/api/data/encryption/') && !['/api/state', '/api/data', '/api/focus', '/api/open-url'].includes(path)) {
          protectedResponses.add(response);
          response.once('finish', () => protectedResponses.delete(response));
          response.once('close', () => protectedResponses.delete(response));
        }
        const body: Body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(request) : {};
        assertActive(); authorize(request);
        if (path === '/api/state' && method === 'GET') { void warm(); return json(response, state()); }
        if (path === '/api/focus' && method === 'POST') { const focused = await focus(); return json(response, { app: 'gopher', instance: 'gopher', version: buildVersion(), focused }); }
        if (path === '/api/open-url' && method === 'POST') { await openExternal(String(body.url)); return json(response, { ok: true }); }
        if (path === '/api/workspace/pick' && method === 'POST') return json(response, { ok: true, path: await pickWorkspace() });
        if (path === '/api/data' && method === 'GET') return json(response, storage.dataInfo());
        if (path === '/api/data' && method === 'POST') { await storage.setStorageMode(body.storage || (body.browser_storage ? 'browser' : 'disk')); return json(response, storage.dataInfo()); }
        if (path === '/api/data/open' && method === 'POST') { await openExternal(storage.root, true); return json(response, { ok: true }); }
        if (path === '/api/data/store' && method === 'GET') return json(response, await storage.loadChats());
        if (path === '/api/data/store' && method === 'PUT') { await storage.saveChats(body); return json(response, null, 204); }
        if (path === '/api/data/preferences' && method === 'GET') return json(response, await storage.loadPreferences());
        if (path === '/api/data/preferences' && method === 'PUT') { await storage.savePreferences(body); return json(response, await storage.loadPreferences()); }
        if (path.startsWith('/api/data/encryption/') && method === 'POST') {
          const operation = path.split('/').at(-1);
          if (operation === 'enable') { await revoke(); await storage.enableEncryption(String(body.passphrase || ''), body.passphrase_confirm); }
          else if (operation === 'unlock') { await storage.unlock(String(body.passphrase || '')); void warm(true); }
          else if (operation === 'lock') { await revoke(); await storage.lock(); }
          else if (operation === 'disable') { await revoke(); await storage.disableEncryption(String(body.passphrase || '')); }
          else throw new HttpError(404, 'Unknown encryption operation.');
          return json(response, storage.dataInfo());
        }
        if (['/api/ui/theme', '/api/ui/appearance', '/api/ui/appearance/reset'].includes(path) && method === 'POST') {
          const next = structuredClone(storage.config);
          if (path.endsWith('/reset')) Object.assign(next.ui, { theme: 'dark', font_body: 'inter', font_display: 'space-grotesk', font_mono: 'jetbrains-mono', font_scale: 'default' });
          else for (const key of ['theme', 'font_body', 'font_display', 'font_mono', 'font_scale'] as const) {
            if (body[key] === undefined) continue;
            const allowed: string[] = key === 'theme' ? ['dark', 'light', 'system'] : key === 'font_scale' ? ['compact', 'default', 'large'] : key === 'font_body' ? FONT_BODY_IDS : key === 'font_display' ? FONT_DISPLAY_IDS : FONT_MONO_IDS;
            if (!allowed.includes(body[key])) throw new HttpError(400, `Invalid ${key.replace(/_/g, ' ')}.`);
            (next.ui as unknown as Body)[key] = body[key];
          }
          await storage.saveConfig(next); return json(response, state());
        }
        if (path === '/api/providers/test' && method === 'POST') {
          const saved = storage.config.providers.find(p => p.id === body.id);
          if (String(body.token || '').trimStart().startsWith('{')) throw new HttpError(400, 'ChatGPT sessions cannot be sent to a custom URL.');
          const provider: Provider = { id: saved?.id || randomUUID(), kind: saved?.kind || 'custom', name: saved?.name || '', base: saved?.kind === 'openai-codex' ? saved.base : normalizeBase(String(body.base || saved?.base || '')), token: body.token || saved?.token || '', api_style: body.api_style || saved?.api_style || 'openai', allow_insecure_tls: body.allow_insecure_tls === true };
          const force = body.force === true;
          // A saved provider is tested with its saved style first; detection runs for new
          // providers set to Auto, or when the saved style no longer answers.
          let probe = saved || body.api_style ? await providers.probe(provider, force) : null; let detected = false;
          if (!body.api_style && provider.kind === 'custom' && !probe?.health.ok) {
            const detection = await providers.detectApiStyle(provider, force);
            if (!probe || detection.probe.health.ok) { provider.api_style = detection.style; probe = detection.probe; detected = provider.api_style !== saved?.api_style; }
          }
          probe ??= await providers.probe(provider, force);
          assertActive(); health.set(provider.id, probe.health); return json(response, { ok: Boolean(probe.health.ok || probe.models.length), base: provider.base, api_style: provider.api_style, detected, refreshed: force, models: probe.models.length, health: probe.health });
        }
        if (path === '/api/providers' && method === 'GET') return json(response, providerResponse());
        if (path === '/api/providers' && method === 'POST') {
          if (String(body.token || '').trimStart().startsWith('{')) throw new HttpError(400, 'Import ChatGPT sessions through the ChatGPT connection.');
          const base = normalizeBase(String(body.base || ''));
          let style = body.api_style || 'openai';
          if (!['openai', 'anthropic', 'responses'].includes(style)) throw new HttpError(400, 'Invalid provider API style.');
          const provider: Provider = { id: randomUUID(), name: providerName(body.name, base), base, token: String(body.token || '').trim(), api_style: style, kind: 'custom', allow_insecure_tls: body.allow_insecure_tls === true };
          if (!body.api_style) provider.api_style = (await providers.detectApiStyle(provider)).style;
          assertActive(); const next = structuredClone(storage.config);
          const existing = next.providers.findIndex(item => item.api_style === provider.api_style && normalizeBase(item.base, item.api_style) === base);
          if (existing >= 0) { if (next.providers[existing].kind !== 'custom') throw new HttpError(400, 'Built-in providers keep a fixed address. Use Connect or Disconnect.'); provider.id = next.providers[existing].id; if (body.token === undefined) provider.token = next.providers[existing].token; next.providers[existing] = provider; }
          else { if (next.providers.filter(item => item.kind === 'custom').length >= 32) throw new HttpError(400, 'Maximum of 32 providers reached.'); next.providers.push(provider); }
          if (body.activate !== false) next.active_provider_id = provider.id;
          await storage.saveConfig(next); providerRevision++; await warm(true); return json(response, providerResponse());
        }
        const providerRoute = /^\/api\/providers\/([^/]+)(\/activate)?$/.exec(path);
        if (providerRoute) {
          const next = structuredClone(storage.config);
          const provider = next.providers.find(p => p.id === providerRoute[1]); if (!provider) throw new HttpError(404, 'Provider not found.');
          if (method === 'POST' && providerRoute[2]) next.active_provider_id = provider.id;
          else if (method === 'DELETE') {
            if (provider.kind === 'custom') next.providers = next.providers.filter(p => p.id !== provider.id); else provider.token = '';
            if (next.active_provider_id === provider.id) next.active_provider_id = next.providers.find(p => p.kind === 'custom')?.id || next.providers[0]?.id || '';
          } else if (method === 'PATCH' && provider.kind === 'custom') {
            if (body.name !== undefined) provider.name = providerName(body.name, provider.base);
            if (body.base !== undefined) provider.base = normalizeBase(String(body.base));
            if (body.token !== undefined) { if (String(body.token).trimStart().startsWith('{')) throw new HttpError(400, 'Session tokens require the built-in provider.'); provider.token = String(body.token).trim(); }
            if (body.api_style !== undefined) { if (!['openai', 'anthropic', 'responses'].includes(body.api_style)) throw new HttpError(400, 'Invalid API style.'); provider.api_style = body.api_style; }
            if (body.allow_insecure_tls !== undefined) provider.allow_insecure_tls = body.allow_insecure_tls === true;
          } else throw new HttpError(405, 'Method not allowed.');
          await storage.saveConfig(next); providerRevision++; await warm(true); return json(response, providerResponse());
        }
        if (path === '/api/skills' && method === 'GET') return json(response, { skills: (await storage.listSkills()).map(publicSkill) });
        if (path === '/api/skills' && method === 'POST') return json(response, publicSkill(await storage.createSkill(body)));
        if (path === '/api/skills/import' && method === 'POST') return json(response, publicSkill(await storage.importSkill(body.filename, String(body.content || ''))));
        const skillRoute = /^\/api\/skills\/([^/]+)$/.exec(path);
        if (skillRoute && method === 'PATCH') return json(response, publicSkill(await storage.updateSkill(skillRoute[1], body)));
        if (skillRoute && method === 'DELETE') { await storage.deleteSkill(skillRoute[1]); return json(response, { skills: (await storage.listSkills()).map(publicSkill) }); }
        if (path === '/api/diagnostics' && method === 'GET') return json(response, { ...storage.diagnostics.view(Number(url.searchParams.get('after')) || 0), persisted: storage.encrypted && storage.unlocked });
        if (path === '/api/diagnostics' && method === 'POST') {
          if (!Array.isArray(body.entries) || body.entries.length > 64) throw new HttpError(400, 'At most 64 diagnostic entries per batch.');
          if (body.generation !== storage.diagnostics.generation) throw new HttpError(409, 'Diagnostics session changed.');
          for (const entry of body.entries) storage.diagnostics.push('browser', entry);
          return json(response, null, 204);
        }
        if (path === '/api/diagnostics' && method === 'DELETE') { await storage.clearDiagnostics(); return json(response, storage.diagnostics.view(0)); }
        if (path === '/api/chat/title' && method === 'POST') { if (!String(body.message || '').trim() || !body.model || !(body.provider_id || body.remote_base)) throw new HttpError(400, 'Title generation requires a message, model and provider.'); return json(response, { title: await providers.title(providers.get(body.provider_id, body.remote_base), body.model, body.message) }); }
        if (path === '/api/chat/completions' && method === 'POST') { record('chat.received', { body }); return await sendStream(response, engine.start(body)); }
        const liveRoute = /^\/api\/chat\/live\/([^/]+)$/.exec(path);
        if (liveRoute && method === 'GET') { const stream = engine.live(id(liveRoute[1])); if (!stream) throw new HttpError(404, 'No live response for that conversation.'); return await sendStream(response, stream); }
        if (path === '/api/chat/cancel' && method === 'POST') return json(response, await engine.cancel(id(body.conversation_id), body.turn_id));
        if (path === '/api/chat/approve' && method === 'POST') { const accepted = engine.approve(id(body.id), body.allow === true); return json(response, { ok: accepted, expired: !accepted }); }
        if (path === '/api/chat/clarify' && method === 'POST') { engine.clarify(id(body.id), body.answers); return json(response, { ok: true }); }
        if (path === '/api/chat/steer' && method === 'POST') { engine.steer(id(body.id), String(body.text || ''), body.client_id); return json(response, { ok: true }); }
        if (path === '/api/attachments/extract' && method === 'POST') return json(response, await extractAttachment(body as Parameters<typeof extractAttachment>[0]));
        if (path === '/api/terminal/open' && method === 'POST') {
          const opened = await terminals.open(body.workspace, body.cols, body.rows);
          if (requestGeneration !== sessionGeneration || response.writableEnded) { await terminals.close(opened.id); throw new HttpError(423, 'Session changed while opening the terminal.', 'encrypted_locked'); }
          return json(response, opened);
        }
        if (path === '/api/terminal/close' && method === 'POST') { await terminals.close(id(body.id)); return json(response, { ok: true }); }
        if (path.startsWith('/api/subscription/')) return await subscriptionRoute(path, method, body, response);
        if (path === '/api/updates/check' && method === 'GET') return json(response, await checkUpdates(url.searchParams.has('force')));
        if (path === '/api/updates/apply' && method === 'POST') return json(response, await applyUpdate(storage.configPath, `${bind.host.includes(':') ? `[${bind.host}]` : bind.host}:${port}`));
        throw new HttpError(404, 'API endpoint not found.');
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      response.setHeader('set-cookie', `gopher_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      if (path === '/settings' || path === '/admin') { response.writeHead(307, { location: '/?settings=providers' }); return response.end(); }
      if (path === '/chat') { response.writeHead(307, { location: '/' }); return response.end(); }
      let file: string;
      if (path === '/prompts.js') {
        response.writeHead(200, { 'content-type': mime['.js'] }); return response.end(await frontendPrompts(promptRoot));
      }
      const vendorMap: Record<string, string> = { '/marked.min.js': 'marked.min.js', '/purify.min.js': 'purify.min.js', '/highlight.min.js': 'highlight.min.js', '/katex.min.js': 'katex/katex.min.js', '/katex.min.css': 'katex/katex.min.css', '/xterm.min.js': 'xterm.min.js', '/xterm-addon-fit.min.js': 'xterm-addon-fit.min.js', '/xterm.css': 'xterm.css' };
      if (vendorMap[path] || path.startsWith('/katex/fonts/') || path.startsWith('/ocr/')) {
        const relative = vendorMap[path] || path.slice(1);
        const vendorRoot = join(publicDir, 'vendor'); file = resolve(vendorRoot, relative);
        if (!file.startsWith(resolve(vendorRoot) + sep)) throw new HttpError(404, 'Asset not found.');
      } else if (['/chat.js', '/chat.css', '/orb.js', '/optional-fonts.js'].includes(path)) file = join(publicDir, path.slice(1));
      else if (['/browser-favicon.png', '/favicon.ico', '/ti.png'].includes(path)) file = join(publicDir, 'browser-favicon.png');
      else if (/^\/(?:$|notifications$|projects$|ghost$|loops(?:\/c\/[^/]+)?$|bots(?:\/c\/[^/]+)?$|c\/[^/]+$|p\/[^/]+(?:\/ghost)?$)/.test(path)) {
        if (storage.encrypted && !storage.unlocked && path !== '/') { response.writeHead(307, { location: '/' }); return response.end(); }
        file = join(publicDir, 'chat.html');
      } else throw new HttpError(404, 'Page not found.');
      const content = await readFile(file); response.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const value = error as Error & { status?: number; code?: string };
      json(response, { error: value.message || 'Request failed.', ...(value.code ? { code: value.code } : {}) }, value.status || (/locked/i.test(value.message) ? 423 : 400));
    }
  }));

  async function subscriptionRoute(path: string, method: string, body: Body, response: ServerResponse): Promise<void> {
    if (method === 'POST' && ['/api/subscription/codex/login', '/api/subscription/codex/device', '/api/subscription/codex/import'].includes(path) && (!storage.encrypted || !storage.unlocked)) throw new HttpError(400, 'Enable and unlock local data encryption before connecting ChatGPT.');
    const generation = sessionGeneration;
    const save = async (secret: string) => {
      if (generation !== sessionGeneration || (storage.encrypted && !storage.unlocked)) throw new Error('Session was locked during sign-in.');
      const next = structuredClone(storage.config);
      const provider = next.providers.find(p => p.kind === 'openai-codex'); if (!provider) throw new Error('ChatGPT provider is missing.');
      provider.token = secret; next.active_provider_id = provider.id; await storage.saveConfig(next); providerRevision++; await warm(true);
    };
    if (path === '/api/subscription/codex/device' && method === 'GET') return json(response, deviceStatus);
    if (path === '/api/subscription/codex/device' && method === 'POST') {
      if (deviceStatus.status === 'pending') return json(response, deviceStatus);
      const code = await requestDeviceCode();
      if (generation !== sessionGeneration || (storage.encrypted && !storage.unlocked)) throw new HttpError(423, 'Session was locked during sign-in.', 'encrypted_locked');
      deviceStatus = { status: 'pending', user_code: code.user_code, verification_url: code.verification_url };
      const expires = Date.now() + 15 * 60_000;
      const poll = async () => {
        if (generation !== sessionGeneration) return;
        try {
          if (Date.now() > expires) throw new Error('The sign-in code expired. Start again.');
          const secret = await pollDeviceCode(code.user_code, code.device_auth_id);
          if (generation !== sessionGeneration) return;
          if (secret) { await save(secret); deviceStatus = { status: 'ready' }; return; }
          deviceTimer = setTimeout(() => { void poll(); }, code.interval_secs * 1000); deviceTimer.unref();
        } catch (error) { if (generation === sessionGeneration) deviceStatus = { status: 'error', error: (error as Error).message }; }
      };
      deviceTimer = setTimeout(() => { void poll(); }, code.interval_secs * 1000); deviceTimer.unref();
      return json(response, deviceStatus);
    }
    if (path === '/api/subscription/codex/login' && method === 'POST') {
      if (signInCancel) throw new HttpError(409, 'ChatGPT sign-in is already open.');
      let login: Awaited<ReturnType<typeof beginCodexLogin>>;
      try { login = await beginCodexLogin(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new HttpError(409, 'Port 1455 is already in use. Switching to device-code sign-in.', 'codex_browser_port_busy'); throw error; }
      if (generation !== sessionGeneration || (storage.encrypted && !storage.unlocked)) { login.result.catch(() => {}); login.cancel(); throw new HttpError(423, 'Session was locked during sign-in.', 'encrypted_locked'); }
      signInCancel = login.cancel;
      const result = login.result.then(save);
      result.catch(() => {});
      try { await openExternal(login.authorization_url); await result; } finally { signInCancel = undefined; login.cancel(); }
      return json(response, providerResponse());
    }
    if (path === '/api/subscription/codex/import' && method === 'POST') { if (!body.confirm) throw new HttpError(400, 'Confirm importing your local Codex session.'); await save(await importCodexCliSecret()); return json(response, providerResponse()); }
    if (path === '/api/subscription/disconnect' && method === 'POST') { const next = structuredClone(storage.config); const provider = next.providers.find(p => p.kind === body.kind); if (!provider || provider.kind === 'custom') throw new HttpError(400, 'Unknown built-in provider.'); provider.token = ''; await storage.saveConfig(next); providerRevision++; await warm(true); return json(response, providerResponse()); }
    throw new HttpError(404, 'Unknown subscription endpoint.');
  }
  server.on('upgrade', (request, socket, head) => {
    try { authorize(request); const match = /^\/api\/terminal\/ws\/([\w.-]+)$/.exec(request.url || ''); if (!match || !terminals.has(match[1])) throw new HttpError(404, 'Terminal not found.'); sockets.handleUpgrade(request, socket, head, ws => { try { terminals.attach(match[1], ws); } catch { ws.close(1008, 'Terminal not found.'); } }); }
    catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  async function listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(bind.port, bind.host, () => { server.off('error', reject); resolve(); }); });
    port = (server.address() as { port: number }).port;
    void warm();
    return `http://${bind.host === '127.0.0.1' ? 'gopher.localhost' : bind.host.includes(':') ? `[${bind.host}]` : bind.host}:${port}`;
  }
  async function close(): Promise<void> { disposed = true; clearInterval(diagnosticTimer); await revoke(); sockets.close(); server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await storage.close(); }
  return { server, storage, providers, engine, terminals, listen, close, state };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cli = parseCliArgs(args);
  if (cli.version) { console.log(buildVersion()); return; }
  if (cli.help) { console.log('Gopher — local AI workspace\n\n--headless  Run the local server\n--browser   Open in your browser\n--config PATH  Configuration file\n--bind ADDR    Loopback address (default 127.0.0.1:3930)'); return; }
  const configPath = cli.configPath || defaultConfigPath(); const bindOverride = cli.bind;
  let startupConfig = defaultConfig();
  try { startupConfig = parseConfig(await readFile(configPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bind = resolveBind(startupConfig, bindOverride);
  if (!args.includes('--update-restart') && bind.port) {
    const origin = `http://${bind.host.includes(':') ? `[${bind.host}]` : bind.host}:${bind.port}`;
    let existing: { focused: boolean } | undefined;
    try {
      const bootstrap = await fetch(origin, { signal: AbortSignal.timeout(1000), redirect: 'error' }); await bootstrap.body?.cancel();
      const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
      if (cookie) { const result = await fetch(origin + '/api/focus', { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(1500), redirect: 'error' }); const info = await result.json() as { app?: string; focused?: boolean }; if (result.ok && info.app === 'gopher') existing = { focused: info.focused === true }; }
    } catch { /* No authenticated Gopher instance is listening. */ }
    if (existing) {
      console.log(existing.focused ? 'Gopher is already running — focused the open window.' : `Gopher is already running — using the existing server at ${origin}.`);
      if (process.send) await new Promise<void>((resolve, reject) => process.send!({ type: 'existing-instance', url: origin, focused: existing.focused }, error => error ? reject(error) : resolve()));
      if (args.includes('--browser') || args.includes('--open') || (!args.includes('--headless') && !process.send && !existing.focused)) await openExternal(origin);
      if (process.connected) process.disconnect?.();
      return;
    }
  }
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let url = '';
  for (let attempt = 0; attempt < (args.includes('--update-restart') ? 60 : 1); attempt++) {
    try { app = await createApp({ configPath, bind: bindOverride }); url = await app.listen(); break; }
    catch (error) {
      if (app) await app.close(); app = undefined;
      const retryable = /already in use|another Gopher process|data.folder lock|EADDRINUSE/i.test((error as Error).message);
      if (!args.includes('--update-restart') || !retryable || attempt === 59) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!app) throw new Error('Could not start the local server.');
  const running = app;
  console.log(`Gopher listening on ${url}`);
  if (args.includes('--browser') || args.includes('--open') || (!args.includes('--headless') && !process.send)) await openExternal(url);
  let closing = false;
  const shutdown = () => { if (closing) return; closing = true; void running.close().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('disconnect', shutdown);
  process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') shutdown(); });
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
