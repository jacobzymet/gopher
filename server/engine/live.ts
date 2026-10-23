import { EventEmitter } from 'node:events';
import type { HistoryArchive } from './context.js';

/**
 * One running turn. Every SSE frame is kept so a client that reconnects (another tab, a reload)
 * replays the whole reply and then follows it live. Frames are capped so a runaway reply cannot
 * exhaust memory.
 */

export interface LiveTurnInfo {
  conversation_id: string; turn_id: string; agent: boolean; deep_research: boolean;
  deep_research_output: string; model: string; finished: boolean;
}
export interface Steer { text: string; client_id?: string }

const MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const MAX_REPLAY_FRAMES = 100_000;

export function sse(event: string | null, data: unknown): string {
  return `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}
/** A chat-completions delta carrying visible content or reasoning. */
export function delta(content: string, reasoning = false): string {
  const field = reasoning ? 'reasoning_content' : 'content';
  return sse(null, { choices: [{ index: 0, delta: { [field]: content }, finish_reason: null }] });
}

export class LiveRun {
  readonly abort = new AbortController();
  readonly history: HistoryArchive = new Map();
  readonly steers: Steer[] = [];
  readonly steerId: string;
  finished = false;
  cancelled = false;
  imageCount = 0;
  done: Promise<void> = Promise.resolve();
  private frames: string[] = [];
  private bytes = 0;
  private events = new EventEmitter();

  constructor(readonly info: LiveTurnInfo, steerId: string) {
    this.steerId = steerId;
    this.events.setMaxListeners(100);
  }

  get signal(): AbortSignal { return this.abort.signal; }

  /** Record and broadcast a frame; exceeding the replay limit aborts the turn. */
  emit(frame: string): void {
    if (this.finished) return;
    const size = Buffer.byteLength(frame);
    if (this.bytes + size > MAX_REPLAY_BYTES || this.frames.length > MAX_REPLAY_FRAMES) {
      this.abort.abort(new Error('Response exceeds the live replay limit'));
      throw new Error('Response exceeds the live replay limit');
    }
    this.frames.push(frame);
    this.bytes += size;
    this.events.emit('frame', frame);
  }

  /** Append the final [DONE] frame and release subscribers. Returns false if already finished. */
  finish(): boolean {
    if (this.finished) return false;
    const done = sse(null, '[DONE]');
    this.frames.push(done);
    this.events.emit('frame', done);
    this.finished = true;
    this.info.finished = true;
    this.events.emit('finished');
    return true;
  }

  /** A metadata frame, every frame so far, then live frames until the turn finishes. */
  async *subscribe(): AsyncGenerator<string> {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    const onFrame = (value: string) => { queue.push(value); wake?.(); wake = undefined; };
    const onFinish = () => { wake?.(); wake = undefined; };
    this.events.on('frame', onFrame);
    this.events.on('finished', onFinish);
    const replay = this.frames.slice();
    try {
      yield sse('meta', { ...this.info, finished: this.finished });
      for (const value of replay) yield value;
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (this.finished) break;
        await new Promise<void>(resolve => { wake = resolve; if (queue.length || this.finished) resolve(); });
      }
    } finally {
      this.events.removeListener('frame', onFrame);
      this.events.removeListener('finished', onFinish);
    }
  }
}
