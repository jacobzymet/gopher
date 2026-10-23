import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { StoreError } from './errors.js';

/**
 * Private files on Windows. One long-lived PowerShell helper sets owner-only ACLs, replaces files
 * atomically with MoveFileEx(REPLACE_EXISTING | WRITE_THROUGH), and holds the exclusive data lock.
 * If the helper dies, every later storage call fails until restart rather than continuing unprotected.
 */

export type WindowsOperation = 'protect-directory' | 'protect-file' | 'replace' | 'acquire-lock' | 'release-lock';
interface PendingRequest { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type UnrefPipe = { ref?: () => void; unref?: () => void };

const REQUEST_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
let helper: ChildProcessWithoutNullStreams | undefined;
let users = 0;
let failure: Error | null = null;
let nextId = 0;
const requests = new Map<number, PendingRequest>();
/** Files already secured, by path, with the dev:ino:ctime they had afterwards. */
const securedFiles = new Map<string, string>();

const windowsScript = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GopherPrivateFiles { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool MoveFileExW(string source,string destination,int flags); }'
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$locks=@{}
try {
while($null -ne ($line=[Console]::ReadLine())) {
  $request=$null
  try {
    $request=ConvertFrom-Json -InputObject $line
    if($request.operation -eq 'acquire-lock') {
      $locks[$request.source]=[IO.File]::Open($request.path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    } elseif($request.operation -eq 'release-lock') {
      if($locks.ContainsKey($request.source)){$locks[$request.source].Dispose();$locks.Remove($request.source)}
    } elseif($request.operation -eq 'replace') {
      if(-not [GopherPrivateFiles]::MoveFileExW($request.source,$request.path,9)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
    } else {
      if($request.operation -eq 'protect-directory') {
        $acl=[Security.AccessControl.DirectorySecurity]::new()
        foreach($sid in @($user,$system)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
        $item=[IO.DirectoryInfo]::new($request.path)
      } elseif($request.operation -eq 'protect-file') {
        $acl=[Security.AccessControl.FileSecurity]::new()
        foreach($sid in @($user,$system)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))}
        $item=[IO.FileInfo]::new($request.path)
      } else {throw 'Unknown filesystem operation'}
      $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($user);$item.SetAccessControl($acl)
    }
    [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{id=$request.id;ok=$true}))
  } catch { [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{id=$request.id;ok=$false})) }
}
} finally { foreach($handle in $locks.Values){$handle.Dispose()};$locks.Clear() }`;

export function windowsHelperFailure(): Error | null { return failure; }
export function retainWindowsHelper(): void { users++; }
export function forgetSecuredFile(path: string): void { securedFiles.delete(path); }

function startHelper(): ChildProcessWithoutNullStreams {
  const systemRoot = process.env.SystemRoot || 'C:\Windows';
  const powershellRoot = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  const encoded = Buffer.from(windowsScript, 'utf16le').toString('base64');
  const child = spawn(join(powershellRoot, 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PSModulePath: join(powershellRoot, 'Modules') },
  });
  let output = '';
  const fail = () => {
    if (helper !== child) return;
    helper = undefined;
    failure = new StoreError('The private Windows filesystem helper stopped. Restart Gopher before accessing local data.');
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(failure); }
    requests.clear();
    securedFiles.clear();
    child.kill();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    let boundary: number;
    while ((boundary = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, boundary).trim();
      output = output.slice(boundary + 1);
      let reply: { id: number; ok: boolean };
      try { reply = JSON.parse(line) as { id: number; ok: boolean }; } catch { continue; }
      const pending = requests.get(reply.id);
      if (!pending) continue;
      requests.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok) pending.resolve();
      else pending.reject(new StoreError('Could not secure or durably replace local data. Choose a directory owned by your Windows user, or restore its permissions.'));
    }
    // An idle helper must not keep the process alive.
    if (!requests.size) {
      child.unref();
      for (const pipe of [child.stdin, child.stdout, child.stderr]) (pipe as unknown as UnrefPipe).unref?.();
    }
  });
  return child;
}

export function windowsPrivateOperation(operation: WindowsOperation, path: string, source?: string): Promise<void> {
  if (failure) return Promise.reject(failure);
  const child = helper ??= startHelper();
  child.ref();
  for (const pipe of [child.stdin, child.stdout, child.stderr]) (pipe as unknown as UnrefPipe).ref?.();
  return new Promise<void>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { if (requests.has(id)) child.kill(); }, REQUEST_TIMEOUT_MS);
    requests.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, operation, path, source }) + '\n');
  });
}

/** Give a regular, single-link file an owner-only ACL, once per file identity. */
export async function protectWindowsFile(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const info = await lstat(path);
  if (securedFiles.get(path) === `${info.dev}:${info.ino}:${info.ctimeMs}`) return;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new StoreError('Refusing unsafe file permissions change.');
  await windowsPrivateOperation('protect-file', path);
  const secured = await lstat(path);
  securedFiles.set(path, `${secured.dev}:${secured.ino}:${secured.ctimeMs}`);
}

/** Drop one user of the helper; the last one shuts it down and clears a recorded failure. */
export async function releaseWindowsHelper(): Promise<void> {
  if (process.platform !== 'win32' || --users > 0) return;
  failure = null;
  if (!helper) return;
  const child = helper;
  helper = undefined;
  securedFiles.clear();
  child.ref();
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.stdin.end();
  });
}
