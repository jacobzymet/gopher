import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const exec = promisify(execFile);
type NativeAction = 'pick-folder' | 'open-path' | 'open-url' | 'focus' | 'restart';
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
process.on('message', (message: unknown) => {
  const value = message as { type?: string; id?: string; error?: string; value?: unknown };
  if (value.type !== 'native-response' || !value.id) return;
  const request = pending.get(value.id);
  if (!request) return;
  pending.delete(value.id);
  if (value.error) request.reject(new Error(value.error)); else request.resolve(value.value);
});

async function native(action: NativeAction, value?: string): Promise<unknown> {
  if (!process.send) throw new Error('Native desktop is unavailable.');
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The desktop did not respond.')); }, 300_000);
    timer.unref();
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    process.send!({ type: 'native-request', id, action, value });
  });
}

export async function pickWorkspace(): Promise<string | null> {
  if (process.send) return await native('pick-folder') as string | null;
  if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Choose workspace folder'; if ($dialog.ShowDialog() -eq 'OK') { [Console]::Write($dialog.SelectedPath) }";
    const result = await exec('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    return result.stdout.trim() || null;
  }
  try {
    const result = process.platform === 'darwin'
      ? await exec('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose workspace folder")'])
      : await exec('zenity', ['--file-selection', '--directory', '--title=Choose workspace folder']);
    return result.stdout.trim() || null;
  } catch (error) { if ((error as { code?: number }).code === 1) return null; throw error; }
}

export async function openExternal(value: string, isPath = false): Promise<void> {
  if (!isPath) {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Only HTTP and HTTPS links can be opened.');
    }
  }
  if (process.send) { await native(isPath ? 'open-path' : 'open-url', value); return; }
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [value], { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}

export async function focus(): Promise<boolean> { return process.send ? (await native('focus')) === true : false; }
export async function requestRestart(): Promise<void> { if (process.send) await native('restart'); }
export async function restartFrom(checkout: string, configPath?: string, bind?: string): Promise<void> {
  if (process.send) { await native('restart', JSON.stringify({ checkout, configPath, bind })); return; }
  const args = [join(checkout, 'dist/server/index.js'), '--update-restart', ...(configPath ? ['--config', configPath] : []), ...(bind ? ['--bind', bind] : []), ...(process.argv.includes('--headless') ? ['--headless'] : ['--browser'])];
  const child = spawn(process.env.GOPHER_NODE_EXECUTABLE || process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore', env: process.env });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  process.emit('SIGTERM');
}
