import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Shell selection, process-group termination and command screening shared by terminals and agent commands. */

export const TERMINATE_GRACE_MS = 500;
export const EXIT_DRAIN_MS = 1000;
export const TERMINATE_EXIT_MS = 2000;

export const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** Poll `check` until it holds or the time runs out; returns its final value. */
export async function until(check: () => boolean, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (!check() && Date.now() < deadline) await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  return check();
}

export function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

/** SIGTERM the whole process group, SIGKILL whatever survives the grace period, then wait for exit. */
export async function stopUnixGroup(pid: number, exited: () => boolean): Promise<void> {
  if (groupExists(pid)) {
    signalGroup(pid, 'SIGTERM');
    if (!await until(() => !groupExists(pid), TERMINATE_GRACE_MS)) signalGroup(pid, 'SIGKILL');
  }
  if (!await until(exited, TERMINATE_EXIT_MS)) {
    throw new Error('The terminal process did not exit after forced termination. Retry stopping the session before continuing.');
  }
}

export function shell(): { file: string; args: string[] } {
  return process.platform === 'win32'
    ? { file: process.env.GOPHER_SHELL || 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }
    : { file: process.env.SHELL || '/bin/sh', args: ['-l'] };
}

/** Restore executable permissions on copied macOS PTY helpers. */
export async function ensureDarwinPtyHelpers(packageRoot?: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  const root = packageRoot || dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  let found = false;
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
    const helper = join(root, directory, 'spawn-helper');
    let stat;
    try { stat = await fs.lstat(helper); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('The installed macOS terminal helper is not a regular file. Reinstall Gopher dependencies.');
    }
    found = true;
    if ((stat.mode & 0o111) === 0o111) continue;
    try { await fs.chmod(helper, (stat.mode & 0o7777) | 0o111); }
    catch {
      throw new Error('The macOS terminal helper is not executable and its permissions could not be repaired. '
        + 'Reinstall Gopher dependencies in a writable folder.');
    }
  }
  if (!found) throw new Error('The installed macOS terminal helper is missing. Reinstall Gopher dependencies.');
}

/** Terminal dimensions, clamped to 2–500. */
export function size(value: unknown, fallback: number): number { return Math.max(2, Math.min(500, Number(value) || fallback)); }

const PROTECTED = new RegExp([
  'rm\\s+-[rf]+\\s+\\/(?:\\s|$|\\*)', '(?:del|rd)\\s+\\/s\\s+\\/q\\s+[a-z]:\\\\', 'format\\s+[a-z]:', 'mkfs\\.', '\\bdiskpart\\b',
  '\\bdd\\s+if=', '\\b(?:sudo|doas|runas)\\s', '(?:shutdown|restart-computer|stop-computer)\\b', '\\binvoke-expression\\b',
  '\\|\\s*(?:iex|sh|bash|powershell)\\b', ':\\(\\)\\{:\\|:&\\};',
].join('|'));

/** Refuse commands that wipe disks, escalate privileges, shut down, or pipe text into a shell. */
export function blockReason(command: string): string | null {
  return PROTECTED.test(command.toLowerCase().replace(/\s+/g, ' ')) ? 'Command performs a protected system operation' : null;
}
