import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile, access, chmod, rename, unlink, lstat, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const nativeRuntimeProbe = `
const fail = message => { console.error(message); process.exit(1); };
const [major, minor] = process.versions.node.split('.').map(Number);
if (process.versions.electron || major < 24 || (major === 24 && minor < 7)) fail('Gopher requires a real Node.js 24.7 or later runtime.');
if (typeof require('node:crypto').argon2 !== 'function') fail('This Node.js runtime does not provide crypto.argon2. Install Node.js 24.7 or later with Argon2 support.');
for (const name of process.platform === 'win32' ? ['node-pty'] : ['node-pty', 'fs-ext']) {
  try { require(name); }
  catch (error) { fail('Required native dependency ' + name + ' could not load with this Node.js runtime. Install the platform build tools and run npm rebuild ' + name + '. ' + error.message); }
}
`;
export const SOURCE_REPOSITORY = 'https://github.com/jacobzymet/gopher';
export interface CommandOptions { cwd: string; windowsHide: boolean; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }
export type CommandRunner = (program: string, args: string[], options: CommandOptions) => Promise<{ stdout: string; stderr: string }>;
export interface ReleaseOptions {
  releasesDirectory: string;
  repository?: string;
  commit?: string;
  node?: string;
  npmCli?: string;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
}
export interface BuiltRelease { checkout: string; commit: string }

export function dataDirectory(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData/Roaming'), 'gopher');
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/gopher');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gopher');
}

export async function findNpm(node = process.env.GOPHER_NODE_EXECUTABLE || process.execPath): Promise<string> {
  const candidates = [process.env.npm_execpath, join(dirname(node), 'node_modules/npm/bin/npm-cli.js'), join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'), ...String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').map(folder => join(folder, 'node_modules/npm/bin/npm-cli.js'))].filter(Boolean) as string[];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw new Error('npm was not found. Install Node.js with npm, then retry.');
}

export async function atomicFile(path: string, content: string, mode = 0o600): Promise<void> {
  const temporary = path + '.new-' + randomUUID();
  try { await writeFile(temporary, content, { mode, flag: 'wx' }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

export async function buildRelease(input: ReleaseOptions): Promise<BuiltRelease> {
  const run: CommandRunner = input.run || ((program, args, options) => execute(program, args, options));
  const node = input.node || process.env.GOPHER_NODE_EXECUTABLE || process.execPath;
  const repository = input.repository || SOURCE_REPOSITORY;
  await mkdir(input.releasesDirectory, { recursive: true, mode: 0o700 });
  const options: CommandOptions = { cwd: input.releasesDirectory, windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024, env: input.env || process.env };
  const remote = input.commit || (await run('git', ['ls-remote', repository, 'refs/heads/master'], options)).stdout.split(/\s/)[0];
  if (!/^[a-f\d]{40}$/i.test(remote)) throw new Error('Git did not return a valid master commit.');
  const commit = remote.toLowerCase();
  const checkout = await mkdtemp(join(input.releasesDirectory, `${commit.slice(0, 12)}-`));
  options.cwd = checkout;
  for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', repository], ['fetch', '--depth', '1', 'origin', commit], ['checkout', '--detach', '--quiet', 'FETCH_HEAD']]) await run('git', args, options);
  const identity = await run('git', ['rev-parse', 'HEAD'], options);
  if (identity.stdout.trim().toLowerCase() !== commit) throw new Error('The downloaded commit did not match the requested update.');
  const manifest = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8')) as { name?: string; scripts?: { build?: string } };
  if (manifest.name !== 'gopher' || !manifest.scripts?.build) throw new Error('This commit does not contain a compatible Gopher application.');
  await readFile(join(checkout, 'package-lock.json'));
  const npm = input.npmCli || await findNpm(node);
  for (const args of [[npm, 'ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund'], ['--input-type=commonjs', '-e', nativeRuntimeProbe], [join(checkout, 'node_modules/electron/install.js')], [npm, 'run', 'build']]) {
    const result = await run(node, args, options); input.onOutput?.(result.stdout + result.stderr);
  }
  const built = JSON.parse(await readFile(join(checkout, 'dist/build.json'), 'utf8')) as { commit?: string };
  if (built.commit !== commit) throw new Error('The build does not identify the pinned commit.');
  await access(join(checkout, 'dist/server/index.js'));
  await access(join(checkout, 'dist/desktop/main.cjs'));
  return { checkout, commit };
}

export async function activateRelease(release: BuiltRelease, bin: string, node = process.execPath, pointer = join(dirname(release.checkout), 'current.json')): Promise<void> {
  const launch = join(dirname(pointer), 'launcher.ts');
  const launcherSource = await readFile(join(release.checkout, 'scripts/launcher.ts'), 'utf8');
  await mkdir(dirname(pointer), { recursive: true, mode: 0o700 }); await mkdir(bin, { recursive: true });
  await atomicFile(launch, launcherSource);
  let retiredExecutable: { file: string; backup: string } | undefined;
  if (process.platform === 'win32') {
    const cmdQuote = (value: string) => value.replace(/%/g, '%%');
    await atomicFile(join(bin, 'gopher.cmd'), `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${cmdQuote(node)}" "${cmdQuote(launch)}" %*\r\n`);
    const legacy = join(bin, 'gopher.exe');
    let existing;
    try { existing = await lstat(legacy); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      if (!existing.isFile()) throw new Error(`Legacy launcher is not a regular file: ${legacy}`);
      const backup = join(await mkdtemp(join(bin, 'gopher-legacy-')), 'gopher.exe');
      await rename(legacy, backup);
      retiredExecutable = { file: legacy, backup };
    }
  } else {
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    await atomicFile(join(bin, 'gopher'), `#!/bin/sh\nexec ${quote(node)} ${quote(launch)} "$@"\n`, 0o755);
    await chmod(join(bin, 'gopher'), 0o755);
  }
  // Last write commits the new release; failed builds/launcher writes keep the old pointer.
  try { await atomicFile(pointer, JSON.stringify(release)); }
  catch (error) {
    if (retiredExecutable) {
      try { await copyFile(retiredExecutable.backup, retiredExecutable.file, constants.COPYFILE_EXCL); }
      catch (restoreError) { throw new AggregateError([error, restoreError], `Release activation failed. The previous executable remains recoverable at ${retiredExecutable.backup}`); }
    }
    throw error;
  }
}

export async function install(args = process.argv.slice(2)): Promise<void> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 7)) throw new Error('Install Node.js 24.7 or later.');
  let bin = process.env.GOPHER_INSTALL_DIR || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'gopher/bin') : join(homedir(), '.local/bin'));
  for (let at = 0; at < args.length; at++) {
    if (args[at] === '--dir') { if (!args[++at] || args[at].startsWith('--')) throw new Error('--dir requires a directory.'); bin = args[at]; }
    else if (args[at] === '--help' || args[at] === '-h') { console.log('Usage: install [--dir DIRECTORY] [--no-path]\nRequires Node.js 24.7+, npm and Git.'); return; }
    else if (args[at] !== '--no-path') throw new Error(`Unknown option: ${args[at]}`);
  }
  bin = resolve(bin);
  const release = await buildRelease({ releasesDirectory: join(dataDirectory(), 'releases'), onOutput: text => process.stdout.write(text) });
  await activateRelease(release, bin);
  if (process.platform === 'win32' && !args.includes('--no-path')) {
    try { await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$folder=$env:GOPHER_INSTALL_BIN; $saved=[Environment]::GetEnvironmentVariable('Path','User'); if (($saved -split ';') -notcontains $folder) { [Environment]::SetEnvironmentVariable('Path',($folder+';'+$saved),'User') }"], { windowsHide: true, env: { ...process.env, GOPHER_INSTALL_BIN: bin } }); }
    catch { console.warn(`Add ${bin} to your user PATH to run gopher from any terminal.`); }
  }
  console.log(`Installed Gopher ${release.commit.slice(0, 12)} to ${bin}. Run gopher in a new terminal.`);
}

if (basename(process.argv[1] || '') === 'install.ts') install().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
