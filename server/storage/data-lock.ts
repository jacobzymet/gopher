import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StoreError } from './errors.js';
import { assertDestination } from './secure-files.js';
import { windowsHelperFailure, windowsPrivateOperation } from './windows-helper.js';

/**
 * One Gopher process per data folder. Unix uses a non-blocking exclusive flock (compatible with
 * the original application); Windows holds the lock file open with no sharing through the helper.
 */

type NativeFlock = (fd: number, operation: 'exnb', callback: (error: NodeJS.ErrnoException | null) => void) => void;
let nativeFlock: NativeFlock | undefined;

function flockExclusive(fd: number): Promise<void> {
  if (!nativeFlock) {
    try { nativeFlock = (createRequire(import.meta.url)('fs-ext') as { flock: NativeFlock }).flock; }
    catch {
      throw new StoreError('The native fs-ext addon is required for safe data locking on Linux and macOS. '
        + 'Install your platform build tools, then run npm rebuild fs-ext (or reinstall dependencies with '
        + 'optional dependencies enabled).');
    }
    if (typeof nativeFlock !== 'function') {
      throw new StoreError('The native fs-ext addon is incompatible. Reinstall fs-ext before starting Gopher.');
    }
  }
  const flock = nativeFlock;
  return new Promise<void>((resolve, reject) => flock(fd, 'exnb', error => (error ? reject(error) : resolve())));
}

/** Messages that describe an unsafe lock file rather than a busy folder, and are shown as they are. */
const SPECIFIC = /fs-ext|replaced or linked|Unsafe data file|linked data path/;

export class DataLock {
  private handle: FileHandle | null = null;
  private windowsHeld = false;
  private readonly token = randomBytes(16).toString('hex');
  constructor(private readonly root: string) {}
  private get path(): string { return join(this.root, '.gopher.lock'); }

  async acquire(): Promise<void> {
    try {
      await assertDestination(this.path);
      if (process.platform === 'win32') {
        await windowsPrivateOperation('acquire-lock', this.path, this.token);
        this.windowsHeld = true;
        return;
      }
      this.handle = await open(this.path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
      await this.handle.chmod(0o600);
      await flockExclusive(this.handle.fd);
      const opened = await this.handle.stat(), linked = await lstat(this.path);
      const replaced = opened.dev !== linked.dev || opened.ino !== linked.ino || opened.nlink !== 1;
      if (linked.isSymbolicLink() || !linked.isFile() || replaced) {
        throw new StoreError('The data lock file was replaced or linked. '
          + 'Restore a regular .gopher.lock file before starting Gopher.');
      }
    } catch (error) {
      await this.release();
      if (error instanceof StoreError && SPECIFIC.test(error.message)) throw error;
      throw new StoreError('This data folder is already in use by another Gopher process, '
        + 'or its lock file is inaccessible.');
    }
  }

  async release(): Promise<void> {
    if (this.windowsHeld) {
      if (!windowsHelperFailure()) await windowsPrivateOperation('release-lock', this.path, this.token);
      this.windowsHeld = false;
    }
    await this.handle?.close();
    this.handle = null;
  }
}
