import type { ServerResponse } from 'node:http';
import { extractAttachment, type ExtractRequest } from '../../attachments.js';
import { record } from '../../diagnostics.js';
import { HttpError, liveId, sendEventStream, sendJson } from '../protocol.js';
import { flag, objectBody, optionalNumber, optionalText, text } from '../guards.js';
import { route, type Route, type RouteContext } from '../router.js';
import type { AppRuntime } from '../runtime.js';

/** Chat turns (streamed), their live replay, approvals, clarifications, steering, titles and attachments. */

/** Aborts when the client goes away before the response finished. */
function clientSignal(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableFinished) controller.abort(new Error('The client disconnected.'));
  });
  return controller.signal;
}

async function stream(runtime: AppRuntime, response: ServerResponse, frames: AsyncIterable<string>): Promise<void> {
  runtime.streams.add(response);
  await sendEventStream(response, frames, () => runtime.streams.delete(response));
}

async function title({ runtime, body: raw, response }: RouteContext): Promise<void> {
  const body = objectBody(raw);
  const message = text(body, 'message'), model = optionalText(body, 'model');
  const providerId = optionalText(body, 'provider_id'), base = optionalText(body, 'remote_base');
  if (!message.trim() || !model || !(providerId || base)) {
    throw new HttpError(400, 'Title generation requires a message, model and provider.');
  }
  const provider = runtime.providers.get(providerId, base);
  sendJson(response, { title: await runtime.providers.title(provider, model, message, clientSignal(response)) });
}

async function completions({ runtime, body: raw, response }: RouteContext): Promise<void> {
  const body = objectBody(raw);
  record('chat.received', { body });
  // The turn keeps running if this request disconnects; the client reattaches through /api/chat/live.
  await stream(runtime, response, runtime.engine.start(body));
}

async function live({ runtime, response }: RouteContext, match: RegExpExecArray | null): Promise<void> {
  const frames = runtime.engine.live(liveId(match![1]));
  if (!frames) throw new HttpError(404, 'No live response for that conversation.');
  await stream(runtime, response, frames);
}

async function openTerminal({ runtime, body: raw, response, generation }: RouteContext): Promise<void> {
  const body = objectBody(raw);
  const size = [optionalNumber(body, 'cols'), optionalNumber(body, 'rows')] as const;
  const opened = await runtime.terminals.open(text(body, 'workspace'), ...size);
  // A terminal opened while the session locked must not survive the lock.
  if (generation !== runtime.generation || response.writableEnded) {
    await runtime.terminals.close(opened.id);
    throw new HttpError(423, 'Session changed while opening the terminal.', 'encrypted_locked');
  }
  sendJson(response, opened);
}

export const chatRoutes: Route[] = [
  route('POST', '/api/chat/title', title),
  route('POST', '/api/chat/completions', completions),
  route('GET', /^\/api\/chat\/live\/([^/]+)$/, live),
  route('POST', '/api/chat/cancel', async ({ runtime, body: raw, response }) => {
    const body = objectBody(raw);
    sendJson(response, await runtime.engine.cancel(liveId(body.conversation_id), optionalText(body, 'turn_id')));
  }),
  route('POST', '/api/chat/approve', ({ runtime, body: raw, response }) => {
    const body = objectBody(raw);
    const accepted = runtime.engine.approve(liveId(body.id), flag(body, 'allow'));
    sendJson(response, { ok: accepted, expired: !accepted });
  }),
  route('POST', '/api/chat/clarify', ({ runtime, body: raw, response }) => {
    const body = objectBody(raw);
    runtime.engine.clarify(liveId(body.id), body.answers);
    sendJson(response, { ok: true });
  }),
  route('POST', '/api/chat/steer', ({ runtime, body: raw, response }) => {
    const body = objectBody(raw);
    runtime.engine.steer(liveId(body.id), text(body, 'text'), optionalText(body, 'client_id'));
    sendJson(response, { ok: true });
  }),
  route('POST', '/api/attachments/extract', async ({ body: raw, response }) => {
    const body = objectBody(raw);
    const request: ExtractRequest = {
      filename: optionalText(body, 'filename'), mime: optionalText(body, 'mime'),
      content_base64: text(body, 'content_base64'),
    };
    sendJson(response, await extractAttachment(request));
  }),
  route('POST', '/api/terminal/open', openTerminal),
  route('POST', '/api/terminal/close', async ({ runtime, body, response }) => {
    await runtime.terminals.close(liveId(objectBody(body).id));
    sendJson(response, { ok: true });
  }),
  route('GET', '/api/processes', ({ runtime, url, response }) => {
    sendJson(response, { processes: runtime.terminals.listCommands(liveId(url.searchParams.get('conversation_id'))) });
  }),
  route('GET', /^\/api\/processes\/([\w.-]+)$/, ({ runtime, url, response }, match) => {
    sendJson(response, runtime.terminals.inspectCommand(liveId(url.searchParams.get('conversation_id')), liveId(match![1])));
  }),
  route('POST', /^\/api\/processes\/([\w.-]+)\/stop$/, async ({ runtime, url, response, assertActive }, match) => {
    const result = await runtime.terminals.stopCommand(liveId(url.searchParams.get('conversation_id')), liveId(match![1]));
    assertActive();
    sendJson(response, result);
  }),
];
