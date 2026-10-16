import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { WebSocket } from 'ws';
import type { IPty } from 'node-pty';
import { Workspace } from './tools/filesystem.js';
import { BoundedOutput } from './tools/output.js';

const MAX_OUTPUT = 1024 * 1024;
const TERMINATE_GRACE_MS = 500, EXIT_DRAIN_MS = 1000, TERMINATE_EXIT_MS = 2000;
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
async function until(check: () => boolean, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (!check() && Date.now() < deadline) await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  return check();
}
function groupExists(pid: number): boolean { try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function stopUnixGroup(pid: number, exited: () => boolean): Promise<void> {
  if (groupExists(pid)) {
    signalGroup(pid, 'SIGTERM');
    if (!await until(() => !groupExists(pid), TERMINATE_GRACE_MS)) signalGroup(pid, 'SIGKILL');
  }
  if (!await until(exited, TERMINATE_EXIT_MS)) throw new Error('The terminal process did not exit after forced termination. Retry stopping the session before continuing.');
}
function shell(): { file: string; args: string[] } { return process.platform === 'win32' ? { file: process.env.GOPHER_SHELL || 'powershell.exe', args: ['-NoLogo', '-NoProfile'] } : { file: process.env.SHELL || '/bin/sh', args: ['-l'] }; }
function size(value: number | undefined, fallback: number): number { return Math.max(2, Math.min(500, Number(value) || fallback)); }
export function blockReason(command: string): string | null {
  const lower = command.toLowerCase().replace(/\s+/g, ' ');
  if (/rm\s+-[rf]+\s+\/(?:\s|$|\*)|(?:del|rd)\s+\/s\s+\/q\s+[a-z]:\\|format\s+[a-z]:|mkfs\.|\bdiskpart\b|\bdd\s+if=|\b(?:sudo|doas|runas)\s|(?:shutdown|restart-computer|stop-computer)\b|\binvoke-expression\b|\|\s*(?:iex|sh|bash|powershell)\b|:\(\)\{:\|:&\};/.test(lower)) return 'Command performs a protected system operation';
  return null;
}
interface LiveTerminal { id: string; cwd: string; title: string; pty: IPty; replay: string; sockets: Set<WebSocket>; exited: boolean; closing?: Promise<void> }
interface CommandSession { id: string; owner: string; workspace: string; cwd:string; process: ChildProcessWithoutNullStreams; command: string; output: BoundedOutput; delivered: boolean; code: number | null; ended: boolean; exited: boolean; expired: boolean; events: EventEmitter; started: number; touched: number; expiry:NodeJS.Timeout; drain?: NodeJS.Timeout; closing?: Promise<void>; groupGone: boolean; signal?: AbortSignal; abort?: () => void }
export interface CommandResult { session_id: string; command: string; cwd:string; output: string; exit_code: number | null; ok:boolean; timed_out:boolean; running: boolean; elapsed_ms: number; truncated: boolean }
export class TerminalManager {
  private terminals = new Map<string, LiveTerminal>();
  private commands = new Map<string, CommandSession>();
  constructor(private options:{idleLifetimeMs?:number}={}){}
  async open(workspace: string, cols?: number, rows?: number): Promise<{ok: boolean; id: string; cwd: string; title: string}> {
    if (this.terminals.size >= 16) throw new Error('Close an existing terminal before opening another');
    const ws = await Workspace.open(workspace); const spec = shell(); const { spawn: spawnPty } = await import('node-pty');
    const pty = spawnPty(spec.file, spec.args, { name: 'xterm-256color', cols: size(cols, 100), rows: size(rows, 28), cwd: ws.root, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>, useConpty: true });
    const id = `terminal_${randomUUID()}`; const title = spec.file.split(/[\\/]/).at(-1) || 'Terminal'; const terminal: LiveTerminal = { id, cwd: ws.root, title, pty, replay: '', sockets: new Set(), exited: false }; this.terminals.set(id, terminal);
    pty.onData(data => { terminal.replay = (terminal.replay + data).slice(-MAX_OUTPUT); for (const socket of terminal.sockets) if (socket.readyState === 1) socket.send(Buffer.from(data)); });
    pty.onExit(() => { terminal.exited = true; for (const socket of terminal.sockets) socket.close(1000, 'Shell exited'); if (!terminal.closing) this.terminals.delete(id); });
    return { ok: true, id, cwd: ws.root, title };
  }
  has(id: string): boolean { return Boolean(this.terminals.get(id) && !this.terminals.get(id)!.closing); }
  attach(id: string, socket: WebSocket): boolean {
    const terminal = this.terminals.get(id); if (!terminal || terminal.closing) { socket.close(1008, 'Terminal is not open'); return false; }
    terminal.sockets.add(socket); if (terminal.replay) socket.send(Buffer.from(terminal.replay));
    socket.on('message', (data, binary) => {
      if (data.toString().length > 128_000) { socket.close(1009); return; }
      const text = data.toString();
      if (!binary) { try { const control = JSON.parse(text); if (control.type === 'resize') terminal.pty.resize(size(control.cols, 100), size(control.rows, 28)); return; } catch {} }
      terminal.pty.write(text);
    });
    socket.on('close', () => terminal.sockets.delete(socket)); socket.on('error', () => terminal.sockets.delete(socket)); return true;
  }
  async close(id: string): Promise<void> {
    const terminal = this.terminals.get(id); if (!terminal) return;
    if (terminal.closing) return terminal.closing;
    for (const socket of terminal.sockets) socket.close();
    terminal.closing = (async () => {
      if (process.platform === 'win32') { terminal.pty.kill(); if (!await until(() => terminal.exited, TERMINATE_EXIT_MS)) throw new Error('The terminal did not exit after being closed. Retry closing it.'); }
      else await stopUnixGroup(terminal.pty.pid, () => terminal.exited);
      this.terminals.delete(id);
    })();
    try { await terminal.closing; } catch (error) { terminal.closing = undefined; throw error; }
  }
  async command(workspace: string, owner: string, args: any, timeout = 30, signal?: AbortSignal): Promise<CommandResult> {
    signal?.throwIfAborted();
    const command = String(args.command || '').trim(); if (!command || command.length > 32_768) throw new Error('Command must contain 1–32768 characters');
    const blocked = blockReason(command); if (blocked) throw new Error(blocked);
    const ws = await Workspace.open(workspace); const cwd = await ws.resolve(args.cwd || '.'); if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Command cwd must be a directory');
    this.prune();if(!owner)throw new Error('A conversation session is required to start a command');
    if(this.commands.size>=64){const oldest=[...this.commands.values()].filter(session=>session.ended&&session.delivered).sort((a,b)=>a.touched-b.touched)[0];if(oldest){clearTimeout(oldest.expiry);await this.kill(oldest);this.commands.delete(oldest.id);}}
    if(this.commands.size>=64||[...this.commands.values()].filter(session=>session.owner===owner&&!session.ended).length>=8)throw new Error('Too many agent commands. Poll or terminate an existing session first.');
    const spec = shell();
    const script=`$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$utf8 = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = $utf8\ntry { $stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8); $stdout.AutoFlush = $true; [Console]::SetOut($stdout) } catch {}\n${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }`;
    signal?.throwIfAborted();
    const child = spawn(spec.file, process.platform === 'win32' ? [...spec.args,'-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')] : ['-c', command], { cwd, env: process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });child.stdin.end();
    const id = `command_${randomUUID()}`; const expiry=setTimeout(()=>{const stale=this.commands.get(id);if(stale)void this.expire(stale);},this.options.idleLifetimeMs??30*60_000);expiry.unref();const session: CommandSession = { id, workspace: ws.root, cwd, owner, command, process: child, output: new BoundedOutput(), delivered: false, code: null, ended: false, exited: false, expired: false, groupGone: false, events: new EventEmitter(), started: Date.now(), touched: Date.now(),expiry, signal }; this.commands.set(id, session);
    const onData = (data:string|Buffer) => { session.output.push(data);session.events.emit('output'); };
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', error => { onData(error.message); session.exited = true; this.finish(session, -1); });
    child.on('exit', code => { session.exited = true; session.code = code; if (!session.ended) { session.drain = setTimeout(() => this.finish(session, code), EXIT_DRAIN_MS); session.drain.unref(); } });
    child.on('close', code => this.finish(session, code));
    session.abort = () => { void this.kill(session).catch(error => onData(`\n${String(error)}\n`)); };
    signal?.addEventListener('abort', session.abort, { once: true });
    return this.wait(owner, { yield_time_ms: Math.min(Math.max(1, timeout), 30) * 1000, ...args, session_id: id },ws.root,signal);
  }
  async wait(owner: string, args: any, workspace?:string, signal?: AbortSignal): Promise<CommandResult> {
    signal?.throwIfAborted();
    const session = this.commands.get(String(args.session_id)); if (!session || session.expired || session.owner !== owner) throw new Error('Command session was not found in this conversation');
    if(workspace&&(await Workspace.open(workspace)).root!==session.workspace)throw new Error('Command session belongs to another workspace');
    signal?.throwIfAborted();
    session.touched=Date.now();session.expiry.refresh();
    if (args.terminate) await this.kill(session);
    const duration = Math.max(0, Math.min(30_000, args.yield_time_ms===undefined?1000:Number(args.yield_time_ms)||0));
    if (!session.ended && session.output.empty && duration) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); session.events.removeListener('output', done); session.events.removeListener('exit', done); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, duration); session.events.once('output', done); session.events.once('exit', done);
      signal?.addEventListener('abort', done, { once: true });
    });
    // Allow a short burst to coalesce so readers receive useful chunks.
    if (!session.ended && !session.output.empty) await new Promise(resolve => setTimeout(resolve, 20));
    signal?.throwIfAborted();
    const truncated=session.output.truncated;const output=session.ended?session.output.render():session.output.take();if(session.ended)session.delivered=true;session.touched=Date.now();
    return { session_id: session.id, command: session.command,cwd:session.cwd, output, exit_code: session.code,ok:!session.ended||session.code===0,timed_out:false, running: !session.ended, elapsed_ms: Date.now() - session.started, truncated };
  }
  private finish(session: CommandSession, code: number | null): void {
    if (session.ended) return;
    clearTimeout(session.drain); session.process.stdout.destroy(); session.process.stderr.destroy();
    session.ended = true; session.code = code;
    if (process.platform !== 'win32' && session.process.pid && !groupExists(session.process.pid)) session.groupGone = true;
    session.signal?.removeEventListener('abort', session.abort!); session.events.emit('exit');
  }
  private async kill(session: CommandSession): Promise<void> {
    if (session.closing) return session.closing;
    session.closing = (async () => {
      const pid = session.process.pid;
      if (process.platform === 'win32' && pid && !session.exited) {
        const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { killer.kill(); session.process.kill(); resolve(); }, TERMINATE_EXIT_MS);
          const done = () => { clearTimeout(timer); resolve(); };
          killer.once('close', done); killer.once('error', () => { session.process.kill(); done(); });
        });
      } else if (process.platform !== 'win32' && pid && !session.groupGone) {
        await stopUnixGroup(pid, () => session.exited); session.groupGone = true;
      } else if (!pid && !session.exited) session.process.kill();
      if (!await until(() => session.exited, TERMINATE_EXIT_MS)) throw new Error('The command did not exit after forced termination. Retry stopping the session.');
      this.finish(session, session.code);
    })();
    try { await session.closing; } catch (error) { session.closing = undefined; throw error; }
  }
  async closeOwner(owner: string): Promise<void> { await Promise.all([...this.commands.values()].filter(session => session.owner === owner).map(session => this.kill(session))); }
  async closeAll(): Promise<void> {
    const sessions = [...this.commands.values()];
    const results = await Promise.allSettled([...this.terminals.keys()].map(id => this.close(id)).concat(sessions.map(async session => { clearTimeout(session.expiry); await this.kill(session); this.commands.delete(session.id); })));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Some terminal processes could not be stopped. Retry before continuing.');
  }
  private async expire(session: CommandSession): Promise<void> {
    session.expired = true; clearTimeout(session.expiry);
    try { await this.kill(session); this.commands.delete(session.id); }
    catch (error) { session.output.push(`\n${String(error)}\n`); session.events.emit('output'); }
  }
  private prune(): void { for (const session of this.commands.values()) if (Date.now() - session.touched > (this.options.idleLifetimeMs??30 * 60_000)) void this.expire(session); }
}
export const terminals = new TerminalManager();
