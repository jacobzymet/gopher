import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The opt-in diagnostics log (Settings → Logs). Entries from the server and the browser are
 * redacted before they are stored, bounded in count and size, and persisted only while data is
 * encrypted. Timing milestones are kept separately so they survive pruning.
 */

export interface DiagnosticInput {
  timestamp?: unknown; level?: unknown; event?: unknown; trace_id?: unknown; conversation_id?: unknown; elapsed_ms?: unknown; data?: unknown;
}
export interface DiagnosticEntry {
  id: number; timestamp: number; level: string; source: string; event: string; trace_id: string; conversation_id: string;
  elapsed_ms: number | null; data: string; truncated_bytes: number;
}
export const MAX_ENTRIES = 2000, MAX_BYTES = 1024 * 1024, MAX_ENTRY_BYTES = 128 * 1024;
const MAX_TIMINGS = 256;
const MAX_DEPTH = 100;

const SENSITIVE_KEY = new RegExp('^(authorization|token|access_token|refresh_token|id_token|password|passphrase|passphrase_confirm|'
  + 'cookie|set_cookie|secret|api_key|x_api_key)$|(?:api_key|apikey|secret)$', 'i');
const SENSITIVE_ASSIGNMENT = new RegExp('((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passphrase|token|'
  + 'cookie|gopher_session)["\']?\\s*[:=]\\s*["\']?)[^\\s"\',&}\\r\\n]+', 'gi');
const TIMING_PREFIX = /^(?:prompt\.prepare\.|cancel\.wait\.|store\.wait\.|provider\.prepare\.|retrieval\.prepare\.|server\.first_|browser\.first_)/;
const TIMING_EVENTS = new Set([
  'turn.started', 'chat.received', 'chat.request.dispatch', 'provider.request', 'provider.headers', 'provider.first_byte',
  'provider.stalled', 'provider.error', 'stream.finished', 'stream.cancelled',
]);

export function redactText(raw: string): string {
  return raw.replace(/\b(?:bearer|basic)\s+[^\s"',]+/gi, 'Bearer [redacted]').replace(SENSITIVE_ASSIGNMENT, '$1[redacted]');
}

/** A copy with credential-looking keys and values replaced by `[redacted]`. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max depth]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key, SENSITIVE_KEY.test(key.replace(/-/g, '_')) ? '[redacted]' : redactValue(child, depth + 1),
    ]));
  }
  return value ?? null;
}

const size = (entry: DiagnosticEntry): number => Buffer.byteLength(entry.data + entry.event + entry.trace_id + entry.conversation_id) + 256;
const isTiming = (event: string): boolean => TIMING_PREFIX.test(event) || TIMING_EVENTS.has(event);
const field = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

function serialize(data: unknown): { data: string; truncated: number } {
  let text: string;
  try { text = JSON.stringify(redactValue(data), null, 2); } catch { text = '[unserializable]'; }
  const original = Buffer.byteLength(text);
  if (original <= MAX_ENTRY_BYTES) return { data: text, truncated: 0 };
  const kept = Buffer.from(text).subarray(0, MAX_ENTRY_BYTES).toString('utf8').replace(/�$/, '');
  return { data: `${kept}\n[Entry truncated; original byte count recorded]`, truncated: original - MAX_ENTRY_BYTES };
}

function level(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (['error', 'warn', 'trace', 'debug'].includes(value)) return value;
  return value === 'warning' ? 'warn' : 'info';
}

const validEntry = (entry: unknown): entry is DiagnosticEntry => {
  const value = entry as Partial<DiagnosticEntry> | null;
  return Boolean(value) && Number.isSafeInteger(value!.id) && value!.id! >= 0 && typeof value!.data === 'string'
    && typeof value!.event === 'string' && typeof value!.trace_id === 'string' && typeof value!.conversation_id === 'string';
};

export class Diagnostics {
  enabled = false;
  /** Changes when the log is cleared or restored, so stale browser batches are refused. */
  generation = 0;
  private entries: DiagnosticEntry[] = [];
  private timings: DiagnosticEntry[] = [];
  private bytes = 0;
  private lastId = 0;
  private dropped = 0;
  private failure = '';
  private revision = 0;
  private savedRevision = 0;
  private restoreFailed = false;

  configure(enabled: boolean): void { this.enabled = enabled; }

  push(source: string, input: DiagnosticInput, generation = this.generation): void {
    if (!this.enabled || generation !== this.generation) return;
    const { data, truncated } = serialize(input.data);
    const elapsed = typeof input.elapsed_ms === 'number' && Number.isFinite(input.elapsed_ms) && input.elapsed_ms >= 0 ? input.elapsed_ms : null;
    const entry: DiagnosticEntry = {
      id: ++this.lastId, timestamp: typeof input.timestamp === 'number' && Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
      level: level(input.level), source: source.slice(0, 80), event: field(input.event, 160), trace_id: field(input.trace_id, 128),
      conversation_id: field(input.conversation_id, 128), elapsed_ms: elapsed, data, truncated_bytes: truncated,
    };
    this.entries.push(entry);
    this.bytes += size(entry);
    this.revision++;
    const seen = this.timings.some(timing => timing.trace_id === entry.trace_id && timing.event === entry.event);
    if (isTiming(entry.event) && entry.trace_id && !seen) {
      this.timings.push({ ...entry, data: '{}', truncated_bytes: 0 });
      if (this.timings.length > MAX_TIMINGS) this.timings.shift();
    }
    this.prune();
  }

  private prune(): void {
    while (this.entries.length > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      this.bytes -= size(this.entries.shift()!);
      this.dropped++;
    }
  }

  view(after = 0) {
    return structuredClone({
      enabled: this.enabled, generation: this.generation, entries: this.entries.filter(entry => entry.id > after),
      last_id: this.lastId, oldest_id: this.entries[0]?.id ?? null, dropped: this.dropped, bytes: this.bytes,
      error: this.failure, timings: this.timings, max_entries: MAX_ENTRIES, max_bytes: MAX_BYTES,
    });
  }

  stored() {
    return structuredClone({ version: 1, entries: this.entries, timings: this.timings, last_id: this.lastId, dropped: this.dropped });
  }

  restore(raw: unknown): void {
    if (raw == null) return;
    const value = raw as { entries?: unknown; timings?: unknown; last_id?: unknown; dropped?: unknown };
    const entries = value.entries ?? [], timings = value.timings ?? [];
    if (!Array.isArray(entries) || !Array.isArray(timings)) throw new Error('Could not read diagnostics.');
    if (!entries.every(validEntry) || !timings.every(validEntry)) {
      throw new Error('Could not read diagnostics entries.');
    }
    this.entries = structuredClone(entries);
    this.timings = structuredClone(timings.slice(-MAX_TIMINGS));
    this.lastId = entries.reduce((largest, entry) => Math.max(largest, entry.id), Number(value.last_id) || 0);
    this.bytes = this.entries.reduce((total, entry) => total + size(entry), 0);
    this.dropped = Number(value.dropped) || 0;
    this.failure = '';
    this.restoreFailed = false;
    this.prune();
    this.savedRevision = ++this.revision;
    this.generation++;
  }

  /** The log to persist, unless nothing changed or restoring failed (which must not overwrite the stored log). */
  pending() { return this.restoreFailed || this.revision === this.savedRevision ? null : { revision: this.revision, value: this.stored() }; }
  saved(revision: number): void { this.savedRevision = revision; this.failure = ''; }
  error(error: unknown): void { this.failure = String(error instanceof Error ? error.message : error); }
  restoreError(error: unknown): void { this.error(error); this.restoreFailed = true; }

  clear(): void {
    this.entries = [];
    this.timings = [];
    this.bytes = 0;
    this.dropped = 0;
    this.failure = '';
    this.restoreFailed = false;
    this.revision++;
    this.generation++;
  }

  suspend(): void { this.configure(false); this.clear(); }
}

/** One request's trace: entries share an id and record elapsed time since the request began. */
export class DiagnosticTrace {
  readonly id: string;
  private started = performance.now();
  private generation: number;
  constructor(readonly hub: Diagnostics, readonly conversationId = '', id: string = randomUUID()) {
    this.id = id;
    this.generation = hub.generation;
  }
  record(event: string, data: unknown): void {
    const entry = {
      event, data, trace_id: this.id, conversation_id: this.conversationId, elapsed_ms: performance.now() - this.started,
      level: /error|stalled$/.test(event) ? 'error' : 'debug',
    };
    this.hub.push('server', entry, this.generation);
  }
}

export const diagnosticContext = new AsyncLocalStorage<DiagnosticTrace>();

/** Record an event in the current request's trace. Pass a function to build expensive data only when logging is on. */
export function record(event: string, data: unknown | (() => unknown)): void {
  const trace = diagnosticContext.getStore();
  if (trace?.hub.enabled) trace.record(event, typeof data === 'function' ? data() : data);
}
