import type { IncomingMessage, ServerResponse } from 'node:http';
import { equalSecret, HttpError, requestPath } from './protocol.js';
import type { AppRuntime } from './runtime.js';

/**
 * The local API only answers this app's own pages: the Host must be the loopback address the app
 * listens on (defeating DNS rebinding), cross-site requests are refused, and every API call must
 * carry the per-run session token. While encrypted data is locked only unlocking is allowed.
 */

const CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'; "
  + "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; script-src-attr 'none'";
const LOCKED_GET = ['/api/state', '/api/data'];
const LOCKED_POST = ['/api/data/encryption/unlock', '/api/focus', '/api/open-url'];

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
}

function sessionToken(request: IncomingMessage): string {
  const header = request.headers['x-gopher-token'];
  if (header) return String(header);
  const cookies = request.headers.cookie?.split(';').map(part => part.trim()) ?? [];
  const cookie = cookies.find(part => part.startsWith('gopher_session='));
  return cookie?.slice('gopher_session='.length) || '';
}

export function authorize(request: IncomingMessage, runtime: AppRuntime): void {
  const address = runtime.bind.host.includes(':') ? `[${runtime.bind.host}]` : runtime.bind.host;
  const authorities = [`${address}:${runtime.port}`, `gopher.localhost:${runtime.port}`, `localhost:${runtime.port}`];
  const host = String(request.headers.host).toLowerCase();
  if (!authorities.includes(host)) throw new HttpError(421, 'Invalid Host header.');
  const path = requestPath(request);
  if (!path.startsWith('/api/')) return;
  const unauthorized = () => new HttpError(401, 'Unauthorized local API request.');
  const origin = request.headers.origin;
  if (origin !== undefined && !authorities.some(host => origin === `http://${host}`)) throw unauthorized();
  const site = request.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(String(site))) throw unauthorized();
  if (!equalSecret(sessionToken(request), runtime.token)) throw unauthorized();
  const allowedWhileLocked = (request.method === 'GET' && LOCKED_GET.includes(path))
    || (request.method === 'POST' && LOCKED_POST.includes(path));
  if (runtime.locked && !allowedWhileLocked) {
    throw new HttpError(423, 'Encrypted local data is locked. Unlock it before using this API.', 'encrypted_locked');
  }
}
