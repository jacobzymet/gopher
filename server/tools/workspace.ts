import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The chat's workspace folder. Every tool path is resolved inside it; symlinked components are
 * refused (so a link cannot point outside), and writes to one workspace run one at a time.
 */

const locks = new Map<string, Promise<unknown>>();

export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export class Workspace {
  private constructor(public readonly root: string) {}

  static async open(raw: string): Promise<Workspace> {
    if (!raw || !path.isAbsolute(raw)) throw new Error('Choose an absolute workspace folder for this chat.');
    const meta = await fs.lstat(raw);
    if (!meta.isDirectory()
      || meta.isSymbolicLink()) throw new Error('Workspace must be a directory, and cannot be a symlink.');
    return new Workspace(await fs.realpath(raw));
  }

  /** An absolute path inside the workspace; existing components must not be symlinks or resolve outside. */
  async resolve(raw: unknown = '.'): Promise<string> {
    if (typeof raw !== 'string' || raw.includes('\0')) throw new Error('Invalid workspace path');
    const target = path.resolve(this.root, raw);
    if (!within(this.root, target)) throw new Error('Path is outside the workspace');
    let cursor = this.root;
    for (const component of path.relative(this.root, target).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      try {
        const meta = await fs.lstat(cursor);
        if (meta.isSymbolicLink()) throw new Error('Symlinks are not permitted in workspace tool paths');
        if (!within(this.root, await fs.realpath(cursor))) throw new Error('Path resolves outside the workspace');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return target;
  }

  relative(target: string): string { return path.relative(this.root, target).split(path.sep).join('/') || '.'; }

  /** Run `fn` after every earlier transaction on this workspace. A queued call can still be cancelled. */
  async transaction<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = locks.get(this.root) || Promise.resolve();
    let started = false;
    const current = previous.catch(() => {}).then(() => { signal?.throwIfAborted(); started = true; return fn(); })
      .finally(() => { if (locks.get(this.root) === current) locks.delete(this.root); });
    locks.set(this.root, current);
    if (!signal) return current;
    return new Promise<T>((resolve, reject) => {
      // A queued call can settle immediately; an active transaction must finish cleanup/rollback first.
      const abort = () => { if (!started) reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      current.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
}

/** Clamp an integer argument, falling back when it is missing or not a number. */
export function limit(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? Math.floor(number) : fallback));
}

/** A regular UTF-8 text file no larger than `max` bytes. */
export async function readSmall(file: string, max: number): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Path is not a regular file');
  if (stat.size > max) throw new Error(`File exceeds the ${max} byte edit limit`);
  try { return new TextDecoder('utf8', { fatal: true }).decode(await fs.readFile(file)); }
  catch { throw new Error('File is not valid UTF-8 text'); }
}

/** Write a synced temporary file beside the target and return its path; the caller moves it into place. */
async function writeTemporary(file: string, content: string | Buffer, mode: number,
  signal?: AbortSignal): Promise<string> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', mode);
  try {
    await handle.writeFile(content, { signal });
    await handle.sync();
  } finally { await handle.close(); }
  return temporary;
}

/**
 * Replace (or create) a file atomically: the new content is written and synced to a temporary
 * file, then renamed over the target, so a crash leaves either the old or the new file. An
 * existing file keeps its permissions.
 */
export async function atomicWrite(file: string, content: string | Buffer, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await fs.mkdir(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = (await fs.stat(file)).mode; } catch { /* A new file. */ }
  let temporary: string | undefined;
  try {
    signal?.throwIfAborted();
    temporary = await writeTemporary(file, content, mode, signal);
    signal?.throwIfAborted();
    await fs.rename(temporary, file);
    temporary = undefined;
  } finally { if (temporary) await fs.rm(temporary, { force: true }).catch(() => {}); }
}

/**
 * Create a file that must not exist yet, atomically and without clobbering one created
 * concurrently: the synced temporary file is hard-linked to the target, which fails if it exists.
 * File systems without hard links fall back to an exclusive create.
 */
export async function atomicCreate(file: string, content: string | Buffer, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const exists = () => new Error('File already exists. Set overwrite only for a complete intentional replacement.');
  const temporary = await writeTemporary(file, content, 0o600, signal);
  try {
    signal?.throwIfAborted();
    try { await fs.link(temporary, file); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw exists();
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(code || '')) throw error;
      await fs.writeFile(file, content, { flag: 'wx', mode: 0o600, signal }).catch(failure => {
        throw (failure as NodeJS.ErrnoException).code === 'EEXIST' ? exists() : failure;
      });
    }
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
