import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { StoreError } from '../storage/errors.js';
import { describeNetworkError } from '../network-errors.js';
import { record } from '../diagnostics.js';

/** Request parsing, JSON and SSE responses, and error-to-status mapping for the local API. */

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const MB = 1024 * 1024;
function bodyLimit(url = ''): number {
  if (url.startsWith('/api/data/store')) return 64 * MB;
  if (url.startsWith('/api/data/preferences')) return 4 * MB;
  return 16 * MB;
}

/**
 * Thrown when a body is refused before it was read. The connection must close, or the unread
 * rest of the body would be parsed as the next request.
 */
class BodyRejected extends HttpError {}

/** Parse a JSON request body. An empty body reads as `undefined`. */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const limit = bodyLimit(request.url);
  if (Number(request.headers['content-length']) > limit) throw new BodyRejected(413, 'Request exceeds the size limit.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new BodyRejected(413, 'Request exceeds the size limit.');
    chunks.push(chunk);
  }
  if (!size) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'Request body must contain valid JSON.'); }
}

export function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

export function equalSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The decoded request path. Encoded separators are refused so they cannot smuggle traversal past routing. */
export function requestPath(request: IncomingMessage): string {
  const path = new URL(request.url || '/', 'http://localhost').pathname;
  if (/%2f|%5c/i.test(path)) throw new HttpError(400, 'Encoded path separators are not allowed.');
  try { return decodeURIComponent(path); } catch { throw new HttpError(400, 'Invalid request path.'); }
}

/** Conversation, turn, approval and terminal identifiers share one safe format. */
export function liveId(value: unknown): string {
  const result = String(value || '').trim();
  if (!/^[\w.-]{1,128}$/.test(result)) throw new HttpError(400, 'Invalid live turn identifier.');
  return result;
}

const HEARTBEAT_MS = 15_000;

/**
 * Stream server-sent events, waiting for the socket to drain when the client reads slowly so a
 * long reply never buffers unboundedly in memory.
 */
export async function sendEventStream(response: ServerResponse, stream: AsyncIterable<string>,
  onEnd?: () => void): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
  const open = () => !response.destroyed && !response.writableEnded;
  const timer = setInterval(() => { if (open()) response.write(': heartbeat\n\n'); }, HEARTBEAT_MS);
  timer.unref();
  try {
    for await (const frame of stream) {
      if (response.destroyed || response.writableEnded) break;
      record('stream.frame', { text: frame });
      if (!response.write(frame)) await Promise.race([once(response, 'drain'), once(response, 'close')]);
    }
  } catch (error) {
    if (!response.destroyed && !response.writableEnded) {
      response.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\ndata: [DONE]\n\n`);
    }
  } finally {
    clearInterval(timer);
    onEnd?.();
    record('stream.finished', {});
    response.end();
  }
}

export interface ErrorReply { status: number; error: string; code?: string; closeConnection: boolean }

/** Bugs, as opposed to Node's coded validation errors (such as ERR_INVALID_URL) and network failures. */
function isProgrammingError(error: unknown): boolean {
  if (error instanceof ReferenceError) return true;
  if (!(error instanceof TypeError) && !(error instanceof RangeError)) return false;
  return !('code' in error) && !('cause' in error);
}

/** Map any thrown value to a status and a message that is safe and useful to show. */
export function errorReply(error: unknown): ErrorReply {
  const closeConnection = error instanceof BodyRejected;
  if (error instanceof HttpError) {
    return { status: error.status, error: error.message, code: error.code, closeConnection };
  }
  if (error instanceof StoreError) {
    const locked = ['encrypted_locked', 'config_recovery_required'].includes(error.code);
    return { status: locked ? 423 : 400, error: error.message, code: error.code, closeConnection };
  }
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return { status, error: (error as Error).message || 'Request failed.', closeConnection };
  }
  if (error instanceof TypeError && 'cause' in error) {
    return { status: 502, error: describeNetworkError(error), closeConnection };
  }
  if (isProgrammingError(error)) {
    record('http.internal_error', { error: String((error as Error)?.stack || error) });
    const message = 'Gopher hit an internal error. Details are in Settings → Logs when logging is enabled.';
    return { status: 500, error: message, closeConnection };
  }
  return { status: 400, error: (error as Error)?.message || 'Request failed.', closeConnection };
}
