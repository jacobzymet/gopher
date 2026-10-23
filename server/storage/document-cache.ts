import { join } from 'node:path';
import { inspect } from './secure-files.js';
import type { JsonObject } from './documents.js';

/**
 * Decrypting and parsing a large chats.json takes long enough to slow every turn and every
 * chat-retrieval tool call, so decoded documents are cached while their file is unchanged.
 * The owner clears the cache whenever the key changes or the session locks, so plaintext never
 * outlives the key. Cached values are shared and must not be mutated.
 */
export class DocumentCache {
  private entries = new Map<string, { stamp: string; value: JsonObject }>();
  constructor(private readonly root: string) {}

  /**
   * Identity of a data file. Any write (ours or external) changes it, and so does a permission
   * change (ctime), so a tampered ACL or mode falls through to readPrivate, which repairs it.
   */
  private async stamp(name: string): Promise<string | null> {
    const info = await inspect(join(this.root, name));
    return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` : null;
  }

  /**
   * Decode a document and cache it under the stamp observed after reading. Reading may repair the
   * file's permissions (changing only ctime); if its content identity changed during the read,
   * the result is returned but not cached.
   */
  async decode<T extends JsonObject>(name: string, decode: () => Promise<T>): Promise<T> {
    const contentPart = (stamp: string | null) => stamp && stamp.slice(0, stamp.lastIndexOf(':'));
    const before = await this.stamp(name);
    const value = await decode();
    const after = await this.stamp(name);
    if (after !== null && contentPart(after) === contentPart(before)) this.entries.set(name, { stamp: after, value });
    else this.entries.delete(name);
    return value;
  }

  /** The cached value while the file is unchanged, otherwise a fresh decode. */
  async read<T extends JsonObject>(name: string, decode: () => Promise<T>): Promise<T> {
    const stamp = await this.stamp(name);
    const cached = this.entries.get(name);
    if (cached && stamp !== null && cached.stamp === stamp) return cached.value as T;
    return this.decode(name, decode);
  }

  /** Record a value that was just written. */
  async remember(name: string, value: JsonObject): Promise<void> {
    const stamp = await this.stamp(name);
    if (stamp === null) this.entries.delete(name); else this.entries.set(name, { stamp, value });
  }

  forget(name: string): void { this.entries.delete(name); }
  clear(): void { this.entries.clear(); }
}
