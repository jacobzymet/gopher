import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AppStorage } from '../storage.js';
import { Providers } from '../providers.js';
import { Engine } from '../engine.js';
import { browsers } from '../tools/browser.js';
import { MAX_TERMINAL_MESSAGE_BYTES, terminals } from '../terminal.js';
import { resolveBind } from '../config.js';
import { DiagnosticTrace, diagnosticContext, record } from '../diagnostics.js';
import { errorReply, HttpError, readJsonBody, requestPath, sendJson } from './protocol.js';
import { applySecurityHeaders, authorize } from './auth.js';
import { serveStatic } from './static.js';
import { dispatch, type RouteContext } from './router.js';
import { AppRuntime } from './runtime.js';
import { dataRoutes } from './routes/data.js';
import { providerRoutes } from './routes/providers.js';
import { recordRoutes } from './routes/records.js';
import { chatRoutes } from './routes/chat.js';
import { accountRoutes } from './routes/account.js';

export { HttpError } from './protocol.js';

/** The local web app: storage, providers, the agent engine and the HTTP and WebSocket server. */

export interface ServerOptions { configPath?: string; bind?: string; publicDir?: string }

const ROUTES = [...dataRoutes, ...providerRoutes, ...recordRoutes, ...chatRoutes, ...accountRoutes];
/** Endpoints that are not cut off by locking; everything else is answered with 423 when data locks mid-request. */
const UNPROTECTED = ['/api/state', '/api/data', '/api/focus', '/api/open-url'];
// Each save encrypts and replaces the entire buffer. Batch disk writes; live viewing
// reads memory, and storage still flushes pending entries on lock and shutdown.
const DIAGNOSTICS_FLUSH_MS = 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const builtRuntime = !fileURLToPath(import.meta.url).endsWith('.ts');
const sourceRoot = resolve(here, '../..');
const promptRoot = builtRuntime ? resolve(here, '../prompts') : join(sourceRoot, 'prompts');

function trace(storage: AppStorage, request: IncomingMessage): DiagnosticTrace {
  const requestId = String(request.headers['x-gopher-request-id'] || '');
  const conversation = String(request.headers['x-gopher-conversation-id'] || '');
  const id = /^[\w.-]{1,128}$/.test(requestId) ? requestId : undefined;
  return new DiagnosticTrace(storage.diagnostics, conversation, id);
}

export async function createApp(options: ServerOptions = {}) {
  const storage = await AppStorage.open(options.configPath);
  let bind: ReturnType<typeof resolveBind>;
  try { bind = resolveBind(storage.config, options.bind); } catch (error) { await storage.close(); throw error; }
  let runtime: AppRuntime;
  const providers = new Providers({
    getProviders: () => storage.config.providers,
    getActiveProviderId: () => storage.config.active_provider_id,
    // Refreshed OAuth credentials are written back without a catalog refresh.
    saveProvider: async provider => {
      const next = structuredClone(storage.config);
      const index = next.providers.findIndex(item => item.id === provider.id);
      if (index < 0) throw new Error('Provider was removed while credentials refreshed.');
      next.providers[index] = provider;
      await storage.saveConfig(next);
      runtime.providersChanged();
    },
  });
  const engine = new Engine({
    providers, getStore: () => storage.readChats(), getPreferences: () => storage.readPreferences(),
    getSkills: () => storage.listSkills(), onEvent: (_event, data) => record('agent.event', data),
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_TERMINAL_MESSAGE_BYTES });
  runtime = new AppRuntime(storage, providers, engine, terminals, sockets, randomBytes(32).toString('base64url'), bind);
  const publicDir = options.publicDir || (builtRuntime ? resolve(here, '../public') : join(sourceRoot, 'dist/public'));
  let unprotectBrowserOrigins: (() => void) | undefined;
  let diagnosticFlushBusy = false;
  const diagnosticTimer = setInterval(() => {
    if (diagnosticFlushBusy) return;
    if (storage.encrypted && !storage.unlocked) return;
    diagnosticFlushBusy = true;
    void storage.flushDiagnostics().catch(error => storage.diagnostics.error(error))
      .finally(() => { diagnosticFlushBusy = false; });
  }, DIAGNOSTICS_FLUSH_MS);
  diagnosticTimer.unref();

  async function handleApi(request: IncomingMessage, response: ServerResponse, path: string, url: URL): Promise<void> {
    const method = request.method || 'GET';
    response.setHeader('cache-control', 'no-store');
    const generation = runtime.generation;
    const assertActive = () => {
      if (generation !== runtime.generation || response.writableEnded) {
        throw new HttpError(423, 'Session changed while the request was running.', 'encrypted_locked');
      }
    };
    if (!path.startsWith('/api/data/encryption/') && !UNPROTECTED.includes(path)) {
      runtime.protectedResponses.add(response);
      response.once('finish', () => runtime.protectedResponses.delete(response));
      response.once('close', () => runtime.protectedResponses.delete(response));
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJsonBody(request) : undefined;
    // The session may have locked while the body arrived.
    assertActive();
    authorize(request, runtime);
    const context: RouteContext = { runtime, request, response, body, url, path, method, generation, assertActive };
    if (!(await dispatch(ROUTES, context))) throw new HttpError(404, 'API endpoint not found.');
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response);
    try {
      authorize(request, runtime);
      const url = new URL(request.url || '/', 'http://localhost');
      const path = requestPath(request), method = request.method || 'GET';
      if (path.startsWith('/api/') && path !== '/api/diagnostics') {
        const current = diagnosticContext.getStore();
        record('http.request', { method, path });
        response.once('finish', () => current?.record('http.response', { path, status: response.statusCode }));
      }
      if (path.startsWith('/api/')) await handleApi(request, response, path, url);
      else {
        const page = { publicDir, promptRoot, token: runtime.token, locked: runtime.locked };
        await serveStatic(response, path, method, page);
      }
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const reply = errorReply(error);
      if (reply.closeConnection) response.setHeader('connection', 'close');
      sendJson(response, { error: reply.error, ...(reply.code ? { code: reply.code } : {}) }, reply.status);
    }
  }

  const server = createServer((request, response) => {
    void diagnosticContext.run(trace(storage, request), () => handle(request, response));
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      authorize(request, runtime);
      const match = /^\/api\/terminal\/ws\/([\w.-]+)$/.exec(request.url || '');
      if (!match || !terminals.has(match[1]!)) throw new HttpError(404, 'Terminal not found.');
      sockets.handleUpgrade(request, socket, head, ws => {
        try { terminals.attach(match[1]!, ws); } catch { ws.close(1008, 'Terminal not found.'); }
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  async function listen(): Promise<string> {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(bind.port, bind.host, () => { server.off('error', reject); resolveListen(); });
    });
    runtime.port = (server.address() as { port: number }).port;
    unprotectBrowserOrigins = browsers.protectOrigins([
      `http://${runtime.authority}`, `http://gopher.localhost:${runtime.port}`, `http://localhost:${runtime.port}`,
    ]);
    void runtime.warm();
    // The default loopback address is shown as gopher.localhost, which every browser resolves locally.
    return bind.host === '127.0.0.1' ? `http://gopher.localhost:${runtime.port}` : `http://${runtime.authority}`;
  }

  async function close(): Promise<void> {
    runtime.disposed = true;
    clearInterval(diagnosticTimer);
    await runtime.revoke();
    sockets.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    unprotectBrowserOrigins?.();
    await storage.close();
  }

  return { server, storage, providers, engine, terminals, listen, close, state: () => runtime.state() };
}
