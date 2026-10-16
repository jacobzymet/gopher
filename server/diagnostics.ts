import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface DiagnosticInput { timestamp?: number; level?: string; event?: string; trace_id?: string; conversation_id?: string; elapsed_ms?: number | null; data?: unknown }
export interface DiagnosticEntry { id: number; timestamp: number; level: string; source: string; event: string; trace_id: string; conversation_id: string; elapsed_ms: number | null; data: string; truncated_bytes: number }
export const MAX_ENTRIES = 2000, MAX_BYTES = 8 * 1024 * 1024, MAX_ENTRY_BYTES = 128 * 1024;
const sensitiveKey = /^(authorization|token|access_token|refresh_token|id_token|password|passphrase|passphrase_confirm|cookie|set_cookie|secret|api_key|x_api_key)$|(?:api_key|apikey|secret)$/i;
export function redactText(raw: string): string {
  return raw.replace(/\b(?:bearer|basic)\s+[^\s"',]+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passphrase|token|cookie|gopher_session)["']?\s*[:=]\s*["']?)[^\s"',&}\r\n]+/gi, '$1[redacted]');
}
export function redactValue(value: unknown, depth = 0): any {
  if (depth > 100) return '[max depth]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(v => redactValue(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitiveKey.test(key.replace(/-/g, '_')) ? '[redacted]' : redactValue(child, depth + 1)]));
  return value ?? null;
}
const size = (entry: DiagnosticEntry): number => Buffer.byteLength(entry.data + entry.event + entry.trace_id + entry.conversation_id) + 256;
const isTiming = (event: string): boolean => /^(?:prompt\.prepare\.|cancel\.wait\.|store\.wait\.|provider\.prepare\.|retrieval\.prepare\.|server\.first_|browser\.first_)/.test(event) || ['turn.started', 'chat.received', 'chat.request.dispatch', 'provider.request', 'provider.headers', 'provider.first_byte', 'provider.stalled', 'provider.error', 'stream.finished', 'stream.cancelled'].includes(event);
export class Diagnostics {
  enabled = false;
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
    let data: string;
    try { data = JSON.stringify(redactValue(input.data), null, 2); } catch { data = '[unserializable]'; }
    const original = Buffer.byteLength(data);
    if (original > MAX_ENTRY_BYTES) { data = Buffer.from(data).subarray(0, MAX_ENTRY_BYTES).toString('utf8').replace(/\uFFFD$/, '') + '\n[Entry truncated; original byte count recorded]'; }
    const level = (input.level || '').toLowerCase();
    const entry: DiagnosticEntry = { id: ++this.lastId, timestamp: Number.isFinite(input.timestamp) ? input.timestamp! : Date.now(), level: ['error', 'warn', 'trace', 'debug'].includes(level) ? level : level === 'warning' ? 'warn' : 'info', source: source.slice(0, 80), event: (input.event || '').slice(0, 160), trace_id: (input.trace_id || '').slice(0, 128), conversation_id: (input.conversation_id || '').slice(0, 128), elapsed_ms: typeof input.elapsed_ms === 'number' && Number.isFinite(input.elapsed_ms) && input.elapsed_ms >= 0 ? input.elapsed_ms : null, data, truncated_bytes: Math.max(0, original - MAX_ENTRY_BYTES) };
    this.entries.push(entry); this.bytes += size(entry); this.revision++;
    if (isTiming(entry.event) && entry.trace_id && !this.timings.some(e => e.trace_id === entry.trace_id && e.event === entry.event)) { this.timings.push({ ...entry, data: '{}', truncated_bytes: 0 }); if (this.timings.length > 256) this.timings.shift(); }
    this.prune();
  }
  private prune(): void { while (this.entries.length > MAX_ENTRIES || this.bytes > MAX_BYTES) { this.bytes -= size(this.entries.shift()!); this.dropped++; } }
  view(after = 0) { return structuredClone({ enabled: this.enabled, generation: this.generation, entries: this.entries.filter(e => e.id > after), last_id: this.lastId, oldest_id: this.entries[0]?.id ?? null, dropped: this.dropped, bytes: this.bytes, error: this.failure, timings: this.timings, max_entries: MAX_ENTRIES, max_bytes: MAX_BYTES }); }
  stored() { return structuredClone({ version: 1, entries: this.entries, timings: this.timings, last_id: this.lastId, dropped: this.dropped }); }
  restore(value: any): void {
    if (value == null) return;
    const entries = value.entries ?? [], timings = value.timings ?? [];
    if (!Array.isArray(entries) || !Array.isArray(timings)) throw new Error('Could not read diagnostics.');
    const valid = (entry: any) => entry && Number.isSafeInteger(entry.id) && entry.id >= 0 && typeof entry.data === 'string' && typeof entry.event === 'string' && typeof entry.trace_id === 'string' && typeof entry.conversation_id === 'string';
    if (!entries.every(valid) || !timings.every(valid)) throw new Error('Could not read diagnostics entries.');
    this.entries = structuredClone(entries); this.timings = structuredClone(timings.slice(-256));
    this.lastId = entries.reduce((largest: number, entry: DiagnosticEntry) => Math.max(largest, entry.id), Number(value.last_id) || 0);
    this.bytes = this.entries.reduce((total, entry) => total + size(entry), 0); this.dropped = Number(value.dropped) || 0;
    this.failure = ''; this.restoreFailed = false; this.prune(); this.savedRevision = ++this.revision; this.generation++;
  }
  pending() { return this.restoreFailed || this.revision === this.savedRevision ? null : { revision: this.revision, value: this.stored() }; }
  saved(revision: number): void { this.savedRevision = revision; this.failure = ''; }
  error(error: unknown): void { this.failure = String(error instanceof Error ? error.message : error); }
  restoreError(error: unknown): void { this.error(error); this.restoreFailed = true; }
  clear(): void { this.entries = []; this.timings = []; this.bytes = 0; this.dropped = 0; this.failure = ''; this.restoreFailed = false; this.revision++; this.generation++; }
  suspend(): void { this.configure(false); this.clear(); }
}
export class DiagnosticTrace {
  readonly id: string;
  private started = performance.now();
  private generation: number;
  constructor(readonly hub: Diagnostics, readonly conversationId = '', id: string = randomUUID()) { this.id = id; this.generation = hub.generation; }
  record(event: string, data: unknown): void { this.hub.push('server', { event, data, trace_id: this.id, conversation_id: this.conversationId, elapsed_ms: performance.now() - this.started, level: /error|stalled$/.test(event) ? 'error' : 'debug' }, this.generation); }
}
export const diagnosticContext = new AsyncLocalStorage<DiagnosticTrace>();
export function record(event: string, data: unknown | (() => unknown)): void { const trace = diagnosticContext.getStore(); if (trace?.hub.enabled) trace.record(event, typeof data === 'function' ? data() : data); }
