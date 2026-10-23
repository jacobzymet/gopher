/** Bounding command output by bytes without splitting UTF-8 characters. */

const isContinuation = (byte: number) => (byte & 0xc0) === 0x80;

/** At most `length` bytes from the start, ending on a character boundary. */
function utf8Prefix(bytes: Buffer, length: number): Buffer {
  let end = Math.min(bytes.length, length);
  if (end < bytes.length) {
    while (end > 0 && isContinuation(bytes[end]!)) end--;
  } else if (end) {
    // The whole buffer fits; still drop a trailing character whose bytes are incomplete.
    let start = end - 1;
    while (start > 0 && isContinuation(bytes[start]!)) start--;
    const lead = bytes[start]!;
    const needed = lead >= 240 ? 4 : lead >= 224 ? 3 : lead >= 192 ? 2 : 1;
    if (start + needed > end) end = start;
  }
  return bytes.subarray(0, end);
}

/** At most `length` bytes from the end, starting on a character boundary. */
function utf8Suffix(bytes: Buffer, length: number): Buffer {
  let start = Math.max(0, bytes.length - length);
  while (start < bytes.length && isContinuation(bytes[start]!)) start++;
  return bytes.subarray(start);
}

/** Keep the beginning and the end of a long text, joined by an "output omitted" marker. */
export function truncateText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const marker = Buffer.from('\n… output omitted …\n');
  if (maxBytes < marker.length) return '[truncated]'.slice(0, maxBytes);
  const available = maxBytes - marker.length, head = Math.floor(available / 2);
  return Buffer.concat([utf8Prefix(bytes, head), marker, utf8Suffix(bytes, available - head)]).toString();
}

/** A bounded per-poll output buffer, preserving initial context and final errors. */
export class BoundedOutput {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private total = 0;
  constructor(readonly limit = 32_000) {}

  private get headLimit(): number { return Math.floor(this.limit / 2); }
  private get tailLimit(): number { return this.limit - this.headLimit; }

  push(value: string | Buffer): void {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    this.total += bytes.length;
    const take = Math.min(bytes.length, Math.max(0, this.headLimit - this.head.length));
    if (take) this.head = Buffer.concat([this.head, bytes.subarray(0, take)]);
    this.tail = Buffer.concat([this.tail, bytes.subarray(take)]);
    if (this.tail.length > this.tailLimit) this.tail = this.tail.subarray(-this.tailLimit);
  }

  get empty(): boolean { return this.total === 0; }
  get truncated(): boolean { return this.total > this.limit; }

  render(): string {
    if (this.total <= this.limit) return Buffer.concat([this.head, this.tail]).toString();
    const marker = Buffer.from(`\n… ${this.total - this.limit} bytes omitted …\n`);
    const joined = Buffer.concat([utf8Prefix(this.head, this.head.length), marker, utf8Suffix(this.tail, this.tail.length)]);
    return truncateText(joined.toString(), this.limit);
  }

  /** Render and clear, for output delivered while the command is still running. */
  take(): string {
    const result = this.render();
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.total = 0;
    return result;
  }
}
