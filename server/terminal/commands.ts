import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { Workspace } from '../tools/workspace.js';
import { BoundedOutput } from '../tools/output.js';
import { blockReason, EXIT_DRAIN_MS, groupExists, shell, stopUnixGroup, TERMINATE_EXIT_MS, until } from './process.js';

/**
 * Commands the agent runs (run_terminal / wait_terminal). Each runs in its own process group (a
 * job tree on Windows) so stopping it stops everything it started. Output is buffered between
 * polls; idle sessions expire; a conversation may run at most eight at once.
 */

const MAX_COMMAND_CHARS = 32_768;
const MAX_SESSIONS = 64;
const MAX_RUNNING_PER_OWNER = 8;
const DEFAULT_IDLE_MS = 30 * 60_000;
const MAX_YIELD_MS = 30_000;
const COALESCE_MS = 20;

interface CommandSession {
  id: string; owner: string; workspace: string; cwd: string; process: ChildProcessWithoutNullStreams; command: string;
  output: BoundedOutput; transcript: BoundedOutput; delivered: boolean; code: number | null; ended: boolean; exited: boolean; expired: boolean;
  events: EventEmitter; started: number; touched: number; expiry: NodeJS.Timeout; drain?: NodeJS.Timeout;
  closing?: Promise<void>; groupGone: boolean; signal?: AbortSignal; abort?: () => void;
  endedAt?: number; stopRequested?: boolean;
}
export interface CommandResult {
  session_id: string; command: string; cwd: string; output: string; exit_code: number | null; ok: boolean;
  timed_out: boolean; running: boolean; elapsed_ms: number; truncated: boolean;
  stopped?: boolean;
}
export interface CommandView {
  session_id: string; conversation_id: string; command: string; cwd: string;
  status: 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';
  running: boolean; exit_code: number | null; started_at: number; elapsed_ms: number;
  output?: string; truncated?: boolean;
}
type Args = Record<string, unknown>;

/** PowerShell wrapper: UTF-8 output, stop on errors, and a failing exit code when the last command failed. */
function powershellScript(command: string): string {
  return "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$utf8 = [System.Text.UTF8Encoding]::new($false)\n"
    + '$OutputEncoding = $utf8\ntry { $stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8); '
    + `$stdout.AutoFlush = $true; [Console]::SetOut($stdout) } catch {}\n${command}\n`
    + 'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }';
}

export class CommandSessions {
  private commands = new Map<string, CommandSession>();
  constructor(private readonly idleLifetimeMs = DEFAULT_IDLE_MS) {}

  /** Number of tracked sessions, running or finished. */
  get size(): number { return this.commands.size; }

  private view(session: CommandSession, output = false): CommandView {
    return {
      session_id: session.id, conversation_id: session.owner, command: session.command, cwd: session.cwd,
      status: session.ended ? session.stopRequested ? 'stopped' : session.code === 0 ? 'completed' : 'failed'
        : session.closing ? 'stopping' : 'running',
      running: !session.ended, exit_code: session.code, started_at: session.started,
      elapsed_ms: Math.max(0, (session.endedAt ?? Date.now()) - session.started),
      ...(output ? { output: session.transcript.render(), truncated: session.transcript.truncated } : {}),
    };
  }

  /** Human inspection never consumes the agent's pending output or refreshes its idle lease. */
  list(owner: string): CommandView[] {
    return [...this.commands.values()].filter(session => session.owner === owner && !session.expired)
      .sort((a, b) => a.started - b.started).map(session => this.view(session));
  }

  private owned(owner: string, id: string): CommandSession {
    const session = this.commands.get(id);
    if (!session || session.expired || session.owner !== owner) throw new Error('Command session was not found in this conversation');
    return session;
  }

  inspect(owner: string, id: string): CommandView { return this.view(this.owned(owner, id), true); }

  async stop(owner: string, id: string): Promise<CommandView> {
    const session = this.owned(owner, id);
    await this.kill(session);
    return this.view(session, true);
  }

  /** Make room by dropping the oldest finished, already-read session, then enforce the limits. */
  private async reserve(owner: string): Promise<void> {
    if (this.commands.size >= MAX_SESSIONS) {
      const oldest = [...this.commands.values()].filter(session => session.ended && session.delivered).sort((a, b) => a.touched - b.touched)[0];
      if (oldest) { clearTimeout(oldest.expiry); await this.kill(oldest); this.commands.delete(oldest.id); }
    }
    this.assertCapacity(owner);
  }

  private assertCapacity(owner: string): void {
    const running = [...this.commands.values()].filter(session => session.owner === owner && !session.ended).length;
    if (this.commands.size >= MAX_SESSIONS || running >= MAX_RUNNING_PER_OWNER) {
      throw new Error('Too many agent commands. Poll or terminate an existing session first.');
    }
  }

  private spawnCommand(command: string, cwd: string): ChildProcessWithoutNullStreams {
    const spec = shell();
    const args = process.platform === 'win32'
      ? [...spec.args, '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(powershellScript(command), 'utf16le').toString('base64')]
      : ['-c', command];
    const child = spawn(spec.file, args, { cwd, env: process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    return child;
  }

  private track(session: CommandSession): void {
    const { process: child } = session;
    const onData = (data: string | Buffer) => {
      session.output.push(data); session.transcript.push(data); session.events.emit('output');
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', error => { onData(error.message); session.exited = true; this.finish(session, -1); });
    // A descendant may keep the pipes open after the shell exits; finish after a short drain anyway.
    child.on('exit', code => {
      session.exited = true;
      session.code = code;
      if (session.ended) return;
      session.drain = setTimeout(() => this.finish(session, code), EXIT_DRAIN_MS);
      session.drain.unref();
    });
    child.on('close', code => this.finish(session, code));
    session.abort = () => { void this.kill(session).catch(error => onData(`\n${String(error)}\n`)); };
    session.signal?.addEventListener('abort', session.abort, { once: true });
  }

  async command(workspace: string, owner: string, args: Args, timeout = 30, signal?: AbortSignal): Promise<CommandResult> {
    signal?.throwIfAborted();
    const command = String(args.command || '').trim();
    if (!command || command.length > MAX_COMMAND_CHARS) throw new Error('Command must contain 1–32768 characters');
    const blocked = blockReason(command);
    if (blocked) throw new Error(blocked);
    const ws = await Workspace.open(workspace);
    const cwd = await ws.resolve(args.cwd || '.');
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Command cwd must be a directory');
    this.prune();
    if (!owner) throw new Error('A conversation session is required to start a command');
    await this.reserve(owner);
    signal?.throwIfAborted();
    this.assertCapacity(owner);
    const child = this.spawnCommand(command, cwd);
    const id = `command_${randomUUID()}`;
    const expiry = setTimeout(() => { const stale = this.commands.get(id); if (stale) void this.expire(stale); }, this.idleLifetimeMs);
    expiry.unref();
    const session: CommandSession = {
      id, workspace: ws.root, cwd, owner, command, process: child, output: new BoundedOutput(),
      transcript: new BoundedOutput(256_000), delivered: false, code: null,
      ended: false, exited: false, expired: false, groupGone: false, events: new EventEmitter(), started: Date.now(),
      touched: Date.now(), expiry, signal,
    };
    this.commands.set(id, session);
    this.track(session);
    return this.wait(owner, { yield_time_ms: Math.min(Math.max(1, timeout), 30) * 1000, ...args, session_id: id }, ws.root, signal);
  }

  /** Wait up to yield_time_ms for output or exit (optionally terminating first), then return what arrived. */
  async wait(owner: string, args: Args, workspace?: string, signal?: AbortSignal): Promise<CommandResult> {
    signal?.throwIfAborted();
    const session = this.commands.get(String(args.session_id));
    if (!session || session.expired || session.owner !== owner) {
      throw new Error('Command session was not found in this conversation');
    }
    if (workspace && (await Workspace.open(workspace)).root !== session.workspace) {
      throw new Error('Command session belongs to another workspace');
    }
    signal?.throwIfAborted();
    session.touched = Date.now();
    session.expiry.refresh();
    if (args.terminate) await this.kill(session);
    const duration = Math.max(0, Math.min(MAX_YIELD_MS, args.yield_time_ms === undefined ? 1000 : Number(args.yield_time_ms) || 0));
    if (!session.ended && session.output.empty && duration) await this.nextActivity(session, duration, signal);
    // Allow a short burst to coalesce so readers receive useful chunks.
    if (!session.ended && !session.output.empty) await new Promise(resolve => setTimeout(resolve, COALESCE_MS));
    signal?.throwIfAborted();
    const truncated = session.output.truncated;
    const output = session.ended ? session.output.render() : session.output.take();
    if (session.ended) session.delivered = true;
    session.touched = Date.now();
    return {
      session_id: session.id, command: session.command, cwd: session.cwd, output, exit_code: session.code,
      ok: !session.ended || session.code === 0, timed_out: false, running: !session.ended, elapsed_ms: Date.now() - session.started, truncated,
      ...(session.stopRequested ? { stopped: true } : {}),
    };
  }

  private nextActivity(session: CommandSession, duration: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        session.events.removeListener('output', done);
        session.events.removeListener('exit', done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, duration);
      session.events.once('output', done);
      session.events.once('exit', done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  private finish(session: CommandSession, code: number | null): void {
    if (session.ended) return;
    clearTimeout(session.drain);
    session.process.stdout.destroy();
    session.process.stderr.destroy();
    session.ended = true;
    session.endedAt = Date.now();
    session.code = code;
    if (process.platform !== 'win32' && session.process.pid && !groupExists(session.process.pid)) session.groupGone = true;
    if (session.abort) session.signal?.removeEventListener('abort', session.abort);
    session.events.emit('exit');
  }

  /** Windows: taskkill the whole tree, falling back to killing the shell. */
  private async killWindowsTree(session: CommandSession, pid: number): Promise<void> {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { killer.kill(); session.process.kill(); resolve(); }, TERMINATE_EXIT_MS);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('close', done);
      killer.once('error', () => { session.process.kill(); done(); });
    });
  }

  /** Stop a session and everything it started; concurrent calls share one attempt, and a failure can be retried. */
  private async kill(session: CommandSession): Promise<void> {
    if (session.closing) return session.closing;
    if (!session.exited) session.stopRequested = true;
    session.closing = (async () => {
      const pid = session.process.pid;
      if (process.platform === 'win32' && pid && !session.exited) await this.killWindowsTree(session, pid);
      else if (process.platform !== 'win32' && pid && !session.groupGone) {
        await stopUnixGroup(pid, () => session.exited);
        session.groupGone = true;
      } else if (!pid && !session.exited) session.process.kill();
      if (!await until(() => session.exited, TERMINATE_EXIT_MS)) {
        throw new Error('The command did not exit after forced termination. Retry stopping the session.');
      }
      this.finish(session, session.code);
    })();
    try { await session.closing; } catch (error) { session.closing = undefined; throw error; }
  }

  async closeOwner(owner: string): Promise<void> {
    await Promise.all([...this.commands.values()].filter(session => session.owner === owner).map(session => this.kill(session)));
  }

  /** Stop every session. Each one is attempted even if another fails. */
  closeAll(): Array<Promise<void>> {
    return [...this.commands.values()].map(async session => {
      clearTimeout(session.expiry);
      await this.kill(session);
      this.commands.delete(session.id);
    });
  }

  private async expire(session: CommandSession): Promise<void> {
    session.expired = true;
    clearTimeout(session.expiry);
    try { await this.kill(session); this.commands.delete(session.id); }
    catch (error) { session.output.push(`\n${String(error)}\n`); session.events.emit('output'); }
  }

  private prune(): void {
    for (const session of this.commands.values()) if (Date.now() - session.touched > this.idleLifetimeMs) void this.expire(session);
  }
}
