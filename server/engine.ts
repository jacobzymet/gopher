import { randomUUID } from 'node:crypto';
import type { StoreView } from './tools/retrieval.js';
import type { Provider, Providers } from './providers.js';
import { terminals } from './terminal.js';
import { browsers } from './tools/browser.js';
import type { UserSkill } from './skills.js';
import { executeTool } from './tools/index.js';
import type { JsonObject } from './storage.js';
import { LiveRun, sse, type LiveTurnInfo } from './engine/live.js';
import { parseChatRequest, type ChatRequest } from './engine/request.js';
import { AgentTurn } from './engine/turn.js';

/**
 * Runs chat and agent turns. Each conversation has at most one live turn; its frames are kept
 * for replay, it can be cancelled, steered, and paused on tool approvals and clarifying questions.
 */

export { TextRouter } from './engine/text-router.js';
export { compactChatMessages, compactMessages, contextWindow, estimateTokens,
  messageBudget } from './engine/context.js';
export { scheduleToolBatches } from './engine/tool-round.js';
export { sse } from './engine/live.js';
export type { LiveTurnInfo } from './engine/live.js';
export type { AgentSkills, ChatRequest } from './engine/request.js';

export interface EngineOptions {
  providers: Providers;
  getStore?: () => Promise<Readonly<StoreView>>;
  getPreferences?: () => Promise<Readonly<JsonObject>>;
  getSkills?: () => Promise<UserSkill[]>;
  onEvent?: (event: string, data: unknown) => void;
  executeTool?: typeof executeTool;
}
interface Waiter {
  run: LiveRun; resolve: (value: unknown) => void; reject: (error: Error) => void;
  timer: NodeJS.Timeout; abort: () => void;
}

const WAIT_TIMEOUT_MS = 3600_000;
const CANCEL_TOMBSTONE_MS = 60_000;
const CANCEL_SETTLE_MS = 5000;
const FINISHED_RETENTION_MS = 90_000;
const MAX_STEER_BYTES = 65_536;
const MAX_STEERS = 32;

function liveId(value: unknown, fallback: string): string {
  const id = String(value || fallback).trim();
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) throw new Error('Invalid live turn identifier');
  return id;
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Engine {
  private runs = new Map<string, LiveRun>();
  private approvals = new Map<string, Waiter>();
  private clarifications = new Map<string, Waiter>();
  private steerRuns = new Map<string, LiveRun>();
  /** A cancel can arrive before its turn starts; the turn is then cancelled on arrival. */
  private cancelTombstones = new Map<string, number>();
  constructor(private readonly options: EngineOptions) {}

  start(raw: unknown): AsyncIterable<string> {
    const request = parseChatRequest(raw);
    const provider = this.options.providers.get(request.provider_id, request.remote_base);
    const conversationId = liveId(request.conversation_id, `ephemeral_${randomUUID()}`);
    const existing = this.runs.get(conversationId);
    if (existing && !existing.finished && !existing.cancelled) {
      throw Object.assign(new Error('A response is already in progress for that conversation.'), { status: 409 });
    }
    const info: LiveTurnInfo = {
      conversation_id: conversationId, turn_id: liveId(request.turn_id, `turn_${randomUUID()}`),
      agent: Boolean(request.agent || request.deep_research), deep_research: Boolean(request.deep_research),
      deep_research_output: request.deep_research_output === 'brief' ? 'brief' : 'long', model: request.model,
        finished: false,
    };
    const run = new LiveRun(info, `steer_${randomUUID()}`);
    this.runs.set(conversationId, run);
    for (const [key, expires] of this.cancelTombstones) if (expires < Date.now()) this.cancelTombstones.delete(key);
    if (this.cancelTombstones.has(`${conversationId}:${info.turn_id}`)) {
      run.cancelled = true;
      run.abort.abort(new Error('Response was cancelled before it started'));
      run.done = Promise.resolve().then(() => this.finish(run));
    } else {
      run.done = this.execute(run, structuredClone(request), provider)
        .catch(error => { if (!run.signal.aborted) this.emit(run, sse('error', { error: errorMessage(error) })); })
        .finally(() => this.finish(run));
    }
    return run.subscribe();
  }

  live(id: string): AsyncIterable<string> | undefined {
    const run = this.runs.get(liveId(id, ''));
    return run ? run.subscribe() : undefined;
  }

  liveTurns(): LiveTurnInfo[] {
    return [...this.runs.values()].filter(run => !run.finished).map(run => ({ ...run.info, finished: run.finished }));
  }

  /** Cancel a conversation's turn (or, given a turn id, that turn even before it starts) and stop its commands. */
  async cancel(id: string, turnId?: string): Promise<{ ok: boolean; cancelled: boolean; settled: boolean }> {
    const conversation = liveId(id, '');
    if (turnId) this.cancelTombstones.set(`${conversation}:${liveId(turnId, '')}`, Date.now() + CANCEL_TOMBSTONE_MS);
    const run = this.runs.get(conversation);
    if (!run || run.finished || (turnId && run.info.turn_id !== turnId)) return { ok: true, cancelled: false,
      settled: true };
    run.cancelled = true;
    run.abort.abort(new Error('Response cancelled'));
    await terminals.closeOwner(run.info.conversation_id);
    const timeout = new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false),
      CANCEL_SETTLE_MS); timer.unref(); });
    const settled = await Promise.race([run.done.then(() => true), timeout]);
    if (!settled) this.finish(run);
    return { ok: true, cancelled: true, settled: true };
  }

  async cancelAll(): Promise<void> {
    const live = [...this.runs.values()].filter(run => !run.finished);
    await Promise.all(live.map(run => this.cancel(run.info.conversation_id)));
    await terminals.closeAll();
    await browsers.closeAll();
    this.runs.clear();
    this.approvals.clear();
    this.clarifications.clear();
    this.steerRuns.clear();
    this.cancelTombstones.clear();
  }

  approve(id: string, allow: boolean): boolean { return this.resolveWaiter(this.approvals, id, Boolean(allow)); }
  clarify(id: string, answers: unknown): boolean { return this.resolveWaiter(this.clarifications, id, answers); }

  steer(id: string, text: string, clientId?: string): void {
    const run = this.steerRuns.get(id) || this.runs.get(id);
    if (!run || run.finished) throw new Error('No active agent turn for that id');
    if (typeof text !== 'string' || !text.trim()
      || Buffer.byteLength(text) > MAX_STEER_BYTES) throw new Error('Steer text must contain 1–65536 bytes');
    if (clientId && Buffer.byteLength(clientId) > 256) throw new Error('Steer client id is too long');
    if (run.steers.length >= MAX_STEERS) throw new Error('Too many steering messages are already queued');
    run.steers.push({ text: text.trim(), client_id: clientId });
  }

  private resolveWaiter(map: Map<string, Waiter>, id: string, value: unknown): boolean {
    const waiter = map.get(id);
    if (!waiter) return false;
    map.delete(id);
    clearTimeout(waiter.timer);
    waiter.run.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve(value);
    return true;
  }

  /** Wait for the user's answer; cancelled with the turn, expired after an hour. */
  private wait(run: LiveRun, map: Map<string, Waiter>, id: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const abort = () => { map.delete(id); clearTimeout(timer); reject(new Error('Response cancelled')); };
      const timer = setTimeout(() => {
        map.delete(id);
        run.signal.removeEventListener('abort', abort);
        reject(new Error('This request expired after one hour'));
      }, WAIT_TIMEOUT_MS);
      timer.unref();
      map.set(id, { run, resolve, reject, timer, abort });
      run.signal.addEventListener('abort', abort, { once: true });
      if (run.signal.aborted) abort();
    });
  }

  private emit(run: LiveRun, frame: string): void { run.emit(frame); }

  private agent(run: LiveRun, data: Record<string, unknown>): void {
    this.options.onEvent?.('agent', data);
    this.emit(run, sse('agent', data));
  }

  private finish(run: LiveRun): void {
    if (!run.finish()) return;
    this.steerRuns.delete(run.steerId);
    for (const map of [this.approvals, this.clarifications]) {
      for (const [id, waiter] of map) {
        if (waiter.run !== run) continue;
        map.delete(id);
        clearTimeout(waiter.timer);
        run.signal.removeEventListener('abort', waiter.abort);
        waiter.reject(new Error('Turn finished'));
      }
    }
    // Keep a finished turn briefly so a client that reconnects can still replay it.
    const id = run.info.conversation_id;
    const timer = setTimeout(() => { if (this.runs.get(id) === run) this.runs.delete(id); }, FINISHED_RETENTION_MS);
    timer.unref();
  }

  private execute(run: LiveRun, request: ChatRequest, provider: Provider): Promise<void> {
    return new AgentTurn(run, request, provider, {
      providers: this.options.providers, getStore: this.options.getStore, getPreferences: this.options.getPreferences,
      getSkills: this.options.getSkills, execute: this.options.executeTool || executeTool,
      agent: data => this.agent(run, data), emit: frame => this.emit(run, frame),
      waitApproval: (target, id) => this.wait(target, this.approvals, id),
      waitClarification: (target, id) => this.wait(target, this.clarifications, id),
      registerSteer: () => this.steerRuns.set(run.steerId, run),
    }).execute();
  }
}
