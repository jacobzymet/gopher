import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isMissing, StoreError } from './errors.js';
import { forgetSecuredFile, protectWindowsFile, windowsPrivateOperation } from './windows-helper.js';

/**
 * Owner-only file access for the data directory. Symlinked paths and hard-linked files are
 * refused, reads verify that the opened file is the inspected one, and writes go to a private
 * temporary file that is fsynced and atomically renamed over the target.
 */

export const MAX_FILE_BYTES = 256 * 1024 * 1024;

export async function inspect(path: string) {
  try { return await lstat(path); } catch (error) { if (isMissing(error)) return null; throw error; }
}

/** Refuse a symlinked path; on Windows every ancestor is checked too (junctions included). */
export async function rejectLinks(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const info = await inspect(current);
    if (info?.isSymbolicLink()) throw new StoreError(`Refusing linked data path: ${current}`);
    if (process.platform !== 'win32' || dirname(current) === current) break;
    current = dirname(current);
  }
}

export async function protectDirectory(path: string): Promise<void> {
  await rejectLinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreError(`Unsafe data directory: ${path}`);
  if (process.platform !== 'win32') { await chmod(path, 0o700); return; }
  await windowsPrivateOperation('protect-directory', path);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Read a private UTF-8 file, or null when it does not exist. */
export async function readPrivate(path: string, limit = MAX_FILE_BYTES): Promise<string | null> {
  await rejectLinks(dirname(path));
  await rejectLinks(path);
  const before = await inspect(path);
  if (!before) return null;
  const unsafe = !before.isFile() || before.isSymbolicLink() || before.nlink !== 1;
  if (unsafe) throw new StoreError(`Unsafe data file: ${path}`);
  await protectWindowsFile(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual = await handle.stat();
    const swapped = actual.dev !== before.dev || actual.ino !== before.ino || actual.nlink !== 1;
    if (swapped || actual.size > limit) throw new StoreError(`Unsafe or oversized data file: ${path}`);
    if (process.platform !== 'win32') await handle.chmod(0o600);
    const buffer = Buffer.alloc(Math.min(actual.size, limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit || length > actual.size) {
      throw new StoreError(`Data file changed or exceeds its size limit: ${path}`);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw new StoreError(`Data file is not valid UTF-8: ${path}`); }
    finally { buffer.fill(0); }
  } finally { await handle.close(); }
}

async function assertDestination(path: string): Promise<void> {
  await rejectLinks(path);
  const info = await inspect(path);
  const unsafe = info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1);
  if (unsafe) throw new StoreError(`Unsafe data file: ${path}`);
}
export { assertDestination };

/** Durably replace `path` with `raw`; on failure the temporary file is removed and the original is untouched. */
export async function atomicWrite(path: string, raw: string): Promise<void> {
  const directory = dirname(path);
  await rejectLinks(directory);
  if (!(await inspect(directory))) await protectDirectory(directory);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory()) throw new StoreError(`Unsafe destination directory: ${directory}`);
  await assertDestination(path);
  const temporary = join(directory, `.${randomBytes(16).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await protectWindowsFile(temporary);
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDestination(path);
    if (process.platform === 'win32') await windowsPrivateOperation('replace', path, temporary);
    else await rename(temporary, path);
    forgetSecuredFile(temporary);
    forgetSecuredFile(path);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function removePrivate(path: string): Promise<void> {
  await assertDestination(path);
  try { await unlink(path); await syncDirectory(dirname(path)); } catch (error) { if (!isMissing(error)) throw error; }
}

/** Parse a private JSON file, or null when it does not exist. Empty files and `null` documents are errors. */
export async function readJson(path: string, limit?: number): Promise<unknown> {
  const raw = await readPrivate(path, limit);
  if (raw === null) return null;
  if (!raw.trim()) throw new StoreError(`Empty JSON file: ${path}`);
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null) throw new Error('Unexpected null document.');
    return value;
  } catch { throw new StoreError(`Invalid JSON file: ${path}`); }
}

export const writeJson = (path: string, value: unknown) => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
