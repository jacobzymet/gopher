import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { IPty } from 'node-pty';
import { Workspace } from './tools/workspace.js';
import { CommandSessions, type CommandResult } from './terminal/commands.js';
import { ensureDarwinPtyHelpers, shell, size, stopUnixGroup, TERMINATE_EXIT_MS, until } from './terminal/process.js';

/**
 * Interactive terminals (a PTY per terminal tab, streamed over a WebSocket) and the agent's
 * command sessions. Locking the data folder closes all of them before anything else proceeds.
 */

export { blockReason, ensureDarwinPtyHelpers } from './terminal/process.js';
export type { CommandResult } from './terminal/commands.js';

const MAX_TERMINALS = 16;
const MAX_REPLAY = 1024 * 1024;
const MAX_MESSAGE_CHARS = 128_000;

interface LiveTerminal {
  id: string; cwd: string; title: string; pty: IPty; replay: string; sockets: Set<WebSocket>; exited: boolean; closing?: Promise<void>;
}
type Args = Record<string, unknown>;

export class TerminalManager {
  private terminals = new Map<string, LiveTerminal>();
  private commands: CommandSessions;
  /** Incremented by closeAll(); a terminal still opening from an older epoch must not start. */
  private lifecycleEpoch = 0;
  constructor(options: { idleLifetimeMs?: number } = {}) { this.commands = new CommandSessions(options.idleLifetimeMs); }

  async open(workspace: string, cols?: number, rows?: number): Promise<{ ok: boolean; id: string; cwd: string; title: string }> {
    const epoch = this.lifecycleEpoch;
    if (this.terminals.size >= MAX_TERMINALS) throw new Error('Close an existing terminal before opening another');
    const ws = await Workspace.open(workspace);
    const spec = shell();
    const { spawn: spawnPty } = await import('node-pty');
    await ensureDarwinPtyHelpers();
    if (epoch !== this.lifecycleEpoch) throw new Error('Terminal opening was cancelled because the session changed.');
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
    const pty = spawnPty(spec.file, spec.args, { name: 'xterm-256color', cols: size(cols, 100), rows: size(rows, 28), cwd: ws.root, env, useConpty: true });
    const id = `terminal_${randomUUID()}`;
    const title = spec.file.split(/[\\/]/).at(-1) || 'Terminal';
    const terminal: LiveTerminal = { id, cwd: ws.root, title, pty, replay: '', sockets: new Set(), exited: false };
    this.terminals.set(id, terminal);
    pty.onData(data => {
      terminal.replay = (terminal.replay + data).slice(-MAX_REPLAY);
      for (const socket of terminal.sockets) if (socket.readyState === 1) socket.send(Buffer.from(data));
    });
    pty.onExit(() => {
      terminal.exited = true;
      for (const socket of terminal.sockets) socket.close(1000, 'Shell exited');
      if (!terminal.closing) this.terminals.delete(id);
    });
    return { ok: true, id, cwd: ws.root, title };
  }

  has(id: string): boolean {
    const terminal = this.terminals.get(id);
    return Boolean(terminal && !terminal.closing);
  }

  /** Connect a WebSocket: replay recent output, then forward keystrokes and JSON resize messages. */
  attach(id: string, socket: WebSocket): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.closing) { socket.close(1008, 'Terminal is not open'); return false; }
    terminal.sockets.add(socket);
    if (terminal.replay) socket.send(Buffer.from(terminal.replay));
    socket.on('message', (data, binary) => {
      const text = data.toString();
      if (text.length > MAX_MESSAGE_CHARS) { socket.close(1009); return; }
      if (!binary) {
        try {
          const control = JSON.parse(text) as { type?: unknown; cols?: unknown; rows?: unknown };
          if (control.type === 'resize') terminal.pty.resize(size(control.cols, 100), size(control.rows, 28));
          return;
        } catch { /* Not a control message; it is terminal input. */ }
      }
      terminal.pty.write(text);
    });
    socket.on('close', () => terminal.sockets.delete(socket));
    socket.on('error', () => terminal.sockets.delete(socket));
    return true;
  }

  /** Stop a terminal's shell and everything it started. A failed close can be retried. */
  async close(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    if (terminal.closing) return terminal.closing;
    for (const socket of terminal.sockets) socket.close();
    terminal.closing = (async () => {
      if (process.platform === 'win32') {
        terminal.pty.kill();
        if (!await until(() => terminal.exited, TERMINATE_EXIT_MS)) {
          throw new Error('The terminal did not exit after being closed. Retry closing it.');
        }
      } else await stopUnixGroup(terminal.pty.pid, () => terminal.exited);
      this.terminals.delete(id);
    })();
    try { await terminal.closing; } catch (error) { terminal.closing = undefined; throw error; }
  }

  command(workspace: string, owner: string, args: Args, timeout = 30, signal?: AbortSignal): Promise<CommandResult> {
    return this.commands.command(workspace, owner, args, timeout, signal);
  }

  wait(owner: string, args: Args, workspace?: string, signal?: AbortSignal): Promise<CommandResult> {
    return this.commands.wait(owner, args, workspace, signal);
  }

  closeOwner(owner: string): Promise<void> { return this.commands.closeOwner(owner); }

  /** Close every terminal and command; reports every failure after attempting all of them. */
  async closeAll(): Promise<void> {
    this.lifecycleEpoch++;
    const closing = [...this.terminals.keys()].map(id => this.close(id)).concat(this.commands.closeAll());
    const failures = (await Promise.allSettled(closing)).filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(failures.map(result => result.reason), 'Some terminal processes could not be stopped. Retry before continuing.');
    }
  }
}

export const terminals = new TerminalManager();
