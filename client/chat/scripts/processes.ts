/** Read-only process output is independent of the agent's run_terminal/wait_terminal cursor. */
interface AgentProcessView {
  session_id: string; conversation_id: string; command: string; cwd: string;
  status: 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';
  running: boolean; exit_code: number | null; started_at: number; elapsed_ms: number;
  output?: string; truncated?: boolean;
}
interface AgentProcessRow {
  root: HTMLDetailsElement; command: HTMLElement; status: HTMLElement; elapsed: HTMLElement;
  cwd: HTMLElement; output: HTMLElement; stop: HTMLButtonElement; error: HTMLElement;
  outputStatus?: AgentProcessView['status'];
}
const agentProcessDock = document.getElementById('agentProcesses') as HTMLDetailsElement | null;
const agentProcessRows = new Map<string, AgentProcessRow>();
const agentProcessStops = new Set<AbortController>();
let agentProcessScope = '';
let agentProcessTimer = 0;
let agentProcessRequest: AbortController | null = null;

function agentProcessContext() {
  if (!activeId || !storageReady || diskEncryptionLocked() || mainView !== 'chat') return null;
  return { id: activeId, key: JSON.stringify([activeProfileId, activeId]) };
}

function clearAgentProcessMemory() {
  window.clearTimeout(agentProcessTimer);
  agentProcessTimer = 0;
  agentProcessScope = '';
  agentProcessRequest?.abort();
  agentProcessRequest = null;
  for (const request of agentProcessStops) request.abort();
  agentProcessStops.clear();
  agentProcessRows.clear();
  document.getElementById('agentProcessesList')?.replaceChildren();
  const error = document.getElementById('agentProcessesError');
  if (error) { error.textContent = ''; error.classList.add('is-hidden'); }
  const count = document.getElementById('agentProcessesCount');
  if (count) count.textContent = '';
  if (agentProcessDock) { agentProcessDock.open = false; agentProcessDock.classList.add('is-hidden'); }
}

function agentProcessDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function agentProcessOutput(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}

function makeAgentProcessRow(process: AgentProcessView): AgentProcessRow {
  const root = document.createElement('details');
  root.className = 'agent-process';
  root.dataset.processId = process.session_id;
  root.setAttribute('name', 'agent-process-output');
  const summary = document.createElement('summary');
  summary.className = 'agent-process-summary';
  const command = document.createElement('code'); command.className = 'agent-process-command';
  const status = document.createElement('span'); status.className = 'agent-process-status';
  const elapsed = document.createElement('span'); elapsed.className = 'agent-process-elapsed';
  summary.append(command, status, elapsed);
  const body = document.createElement('div'); body.className = 'agent-process-body';
  const toolbar = document.createElement('div'); toolbar.className = 'agent-process-toolbar';
  const cwd = document.createElement('span'); cwd.className = 'agent-process-cwd';
  const stop = document.createElement('button');
  stop.type = 'button'; stop.className = 'btn btn-ghost agent-process-stop'; stop.textContent = 'Stop';
  stop.setAttribute('aria-label', 'Stop process');
  stop.addEventListener('click', () => { void stopAgentProcess(process.session_id); });
  toolbar.append(cwd, stop);
  const output = document.createElement('pre'); output.className = 'agent-process-output';
  output.tabIndex = 0; output.setAttribute('aria-label', 'Process output');
  const error = document.createElement('p'); error.className = 'agent-process-error'; error.setAttribute('role', 'alert');
  body.append(toolbar, output, error); root.append(summary, body);
  root.addEventListener('toggle', () => { if (root.open) syncAgentProcesses(); });
  return { root, command, status, elapsed, cwd, output, stop, error };
}

function paintAgentProcess(process: AgentProcessView, row: AgentProcessRow) {
  if (row.command.textContent !== process.command) row.command.textContent = process.command;
  row.command.title = process.command;
  row.root.dataset.status = process.status;
  row.status.textContent = process.status === 'failed' ? `Exit ${process.exit_code ?? '?'}`
    : ({ running: 'Running', stopping: 'Stopping…', stopped: 'Stopped', completed: 'Completed' })[process.status];
  row.elapsed.textContent = agentProcessDuration(process.elapsed_ms);
  row.cwd.textContent = process.cwd; row.cwd.title = process.cwd;
  row.stop.hidden = !process.running;
  row.stop.disabled = process.status === 'stopping';
  if (process.output === undefined) return;
  row.outputStatus = process.status;
  const text = agentProcessOutput(process.output) || (process.running ? 'Waiting for output…' : 'No output.');
  if (row.output.textContent !== text) {
    const follow = row.output.scrollHeight - row.output.clientHeight - row.output.scrollTop < 32;
    row.output.textContent = text;
    if (follow) row.output.scrollTop = row.output.scrollHeight;
  }
}

function paintAgentProcesses(processes: AgentProcessView[]) {
  const list = document.getElementById('agentProcessesList');
  if (!list || !agentProcessDock) return;
  const ids = new Set(processes.map(process => process.session_id));
  for (const [id, row] of agentProcessRows) if (!ids.has(id)) { row.root.remove(); agentProcessRows.delete(id); }
  for (const process of processes) {
    let row = agentProcessRows.get(process.session_id);
    if (!row) {
      row = makeAgentProcessRow(process); agentProcessRows.set(process.session_id, row); list.append(row.root);
    }
    paintAgentProcess(process, row);
  }
  const running = processes.filter(process => process.running).length;
  const count = document.getElementById('agentProcessesCount');
  if (count) count.textContent = running ? `${running} running / ${processes.length} total` : `${processes.length} finished`;
  agentProcessDock.classList.toggle('is-hidden', processes.length === 0);
}

function queueAgentProcessPoll(delay: number) {
  window.clearTimeout(agentProcessTimer);
  agentProcessTimer = window.setTimeout(() => { agentProcessTimer = 0; void refreshAgentProcesses(); }, delay);
}

function syncAgentProcesses() {
  if (!agentProcessDock) return;
  const context = agentProcessContext();
  if (!context) { clearAgentProcessMemory(); queueAgentProcessPoll(2500); return; }
  if (agentProcessScope !== context.key) { clearAgentProcessMemory(); agentProcessScope = context.key; }
  window.clearTimeout(agentProcessTimer);
  if (!agentProcessRequest) void refreshAgentProcesses();
}

async function refreshAgentProcesses() {
  if (!agentProcessDock) return;
  const context = agentProcessContext();
  if (!context) { clearAgentProcessMemory(); queueAgentProcessPoll(2500); return; }
  if (context.key !== agentProcessScope) { syncAgentProcesses(); return; }
  if (document.hidden || agentProcessRequest) return;
  const request = new AbortController(); agentProcessRequest = request;
  const timeout = window.setTimeout(() => request.abort(), 10_000);
  let running = false;
  const current = () => !request.signal.aborted && agentProcessScope === context.key && agentProcessContext()?.key === context.key;
  const query = '?conversation_id=' + encodeURIComponent(context.id);
  try {
    const response = await fetch('/api/processes' + query, { signal: request.signal });
    if (!response.ok) throw new Error('Could not load processes');
    const payload = await response.json() as { processes: AgentProcessView[] };
    if (!current()) return;
    const processes = payload.processes.filter(process => process.conversation_id === context.id);
    paintAgentProcesses(processes);
    running = processes.some(process => process.running);
    const error = document.getElementById('agentProcessesError');
    if (error) { error.textContent = ''; error.classList.add('is-hidden'); }
    const expanded = agentProcessDock.open && [...agentProcessRows].find(([, row]) => row.root.open);
    if (expanded) {
      const [id, row] = expanded;
      const summary = processes.find(process => process.session_id === id);
      if (summary && (summary.running || row.outputStatus !== summary.status)) {
        const detail = await fetch('/api/processes/' + encodeURIComponent(id) + query, { signal: request.signal });
        if (!detail.ok) throw new Error('Could not load process output');
        const process = await detail.json() as AgentProcessView;
        if (current() && process.conversation_id === context.id && process.session_id === id) paintAgentProcess(process, row);
      }
    }
  } catch {
    if (current()) {
      const error = document.getElementById('agentProcessesError');
      if (error) { error.textContent = 'Process status unavailable. Reconnecting…'; error.classList.remove('is-hidden'); }
    }
  } finally {
    window.clearTimeout(timeout);
    if (agentProcessRequest === request) agentProcessRequest = null;
    if (agentProcessScope === context.key && agentProcessContext()?.key === context.key) {
      queueAgentProcessPoll(running || activeStreams.has(context.id) ? 800 : 2500);
    }
  }
}

async function stopAgentProcess(id: string) {
  const context = agentProcessContext(), row = agentProcessRows.get(id);
  if (!context || !row) return;
  const request = new AbortController(); agentProcessStops.add(request);
  row.stop.disabled = true; row.error.textContent = '';
  try {
    const response = await fetch('/api/processes/' + encodeURIComponent(id) + '/stop?conversation_id=' + encodeURIComponent(context.id), {
      method: 'POST', signal: request.signal,
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not stop process');
    const process = await response.json() as AgentProcessView;
    if (!request.signal.aborted && agentProcessScope === context.key) paintAgentProcess(process, row);
  } catch (error) {
    if (!request.signal.aborted && agentProcessScope === context.key) {
      row.error.textContent = (error as Error).message; row.stop.disabled = false;
    }
  } finally { agentProcessStops.delete(request); }
}

if (agentProcessDock) {
  agentProcessDock.addEventListener('toggle', () => { if (agentProcessDock.open) syncAgentProcesses(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncAgentProcesses(); });
  syncAgentProcesses();
}
