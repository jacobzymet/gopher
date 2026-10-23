import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppRuntime } from './runtime.js';

/** A small ordered route table. Order matters: earlier routes win, exactly like the original if-chain. */

export interface RouteContext {
  readonly runtime: AppRuntime;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  /** The parsed JSON body, or undefined when the request had none. */
  readonly body: unknown;
  readonly url: URL;
  readonly path: string;
  readonly method: string;
  /** The session generation when the request began. */
  readonly generation: number;
  /** Throws 423 when the session locked or the response ended while the request was running. */
  assertActive(): void;
}
export type Handler = (context: RouteContext, match: RegExpExecArray | null) => Promise<void> | void;
export interface Route { method: string; path: string | RegExp | ((path: string) => boolean); handle: Handler }

export const route = (method: string, path: Route['path'], handle: Handler): Route => ({ method, path, handle });

/** Run the first route matching the method (`*` matches any) and path. Returns false when none matched. */
export async function dispatch(routes: readonly Route[], context: RouteContext): Promise<boolean> {
  for (const candidate of routes) {
    if (candidate.method !== '*' && candidate.method !== context.method) continue;
    let match: RegExpExecArray | null = null;
    if (typeof candidate.path === 'string') { if (candidate.path !== context.path) continue; }
    else if (typeof candidate.path === 'function') { if (!candidate.path(context.path)) continue; }
    else if (!(match = candidate.path.exec(context.path))) continue;
    await candidate.handle(context, match);
    return true;
  }
  return false;
}
