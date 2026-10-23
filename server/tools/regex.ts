import { Worker } from 'node:worker_threads';

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
let expression, error;
try { expression = new RegExp(workerData.query, workerData.flags); }
catch (cause) { error = cause.message; }
parentPort.on('message', ({ id, lines, limit }) => {
  if (error) { parentPort.postMessage({ id, error }); return; }
  const matches = []; let count = 0;
  for (let index = 0; index < lines.length; index++) {
    expression.lastIndex = 0;
    if (expression.test(lines[index])) {
      count++; if (matches.length < limit) matches.push(index);
      if (workerData.mode !== 'count' && count >= limit) break;
    }
  }
  parentPort.postMessage({ id, matches, count });
});
`;

/** Keep untrusted regular expressions off the HTTP and cancellation event loop. */
interface MatchResult { matches: number[]; count: number }
interface PendingMatch { resolve: (result: MatchResult) => void; reject: (cause: Error) => void; cleanup: () => void }
export class RegexMatcher {
  private worker: Worker;
  private sequence = 0;
  private closed = false;
  private failure?: Error;
  private termination?: Promise<void>;
  private pending = new Map<number, PendingMatch>();
  constructor(query: string, caseInsensitive: boolean, mode: string, private timeoutMs = 1000) {
    this.worker = new Worker(workerSource, { eval: true, execArgv: [], workerData: { query, flags: caseInsensitive ? 'i' : '', mode }, resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 } });
    // Compilation can fail before filesystem scanning reaches the first match.
    this.worker.on('error', cause => this.fail(cause));
    this.worker.on('exit', code => { if (!this.closed) this.fail(new Error(`Regular expression worker exited (${code})`)); });
    this.worker.on('message', (result: MatchResult & { id: number; error?: string }) => {
      const job = this.pending.get(result.id); if (!job) return;
      job.cleanup();
      if (result.error) job.reject(new Error(`Invalid regular expression: ${result.error}`)); else job.resolve(result);
    });
  }
  private fail(cause: Error): void {
    this.failure ??= cause;
    for (const job of [...this.pending.values()]) { job.cleanup(); job.reject(this.failure); }
  }
  match(lines: string[], limit: number, signal?: AbortSignal): Promise<MatchResult> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.failure || this.closed) {
      return Promise.reject(this.failure || new Error('Regular expression worker is closed'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => { const cause = signal?.reason ?? new Error('Regular expression was cancelled'); this.fail(cause); void this.close(); };
      const timer = setTimeout(() => { this.fail(new Error('Regular expression exceeded the execution time limit. Use a simpler query or narrower path.')); void this.close(); }, this.timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { this.worker.postMessage({ id, lines, limit }); } catch (cause) { this.fail(cause as Error); void this.close(); }
    });
  }
  close(): Promise<void> {
    if (!this.termination) { this.closed = true; this.fail(new Error('Regular expression worker is closed')); this.termination = this.worker.terminate().then(() => {}); }
    return this.termination;
  }
}
