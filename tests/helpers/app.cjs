const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { resolve, sep, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const lifecycles = new WeakMap();

const appTestsEnabled = process.env.GOPHER_E2E === '1';
const browserTestsEnabled = appTestsEnabled || process.env.GOPHER_BROWSER_TESTS === '1';
let chromium;
if (browserTestsEnabled) ({ chromium } = require('playwright-core'));

/** All app integration tests exercise the TypeScript CLI with isolated data. */
function spawnApp(args, options = {}) {
  const entry = resolve(process.env.GOPHER_TEST_ENTRY || resolve(__dirname, '../../server/index.ts'));
  const child = spawn(process.execPath, [
    ...(entry.endsWith('.ts') ? ['--import', pathToFileURL(require.resolve('tsx')).href] : []), entry, ...args,
  ], { windowsHide: true, ...options, stdio: options.stdio === undefined || options.stdio === 'pipe' ? ['pipe', 'pipe', 'pipe', 'ipc'] : options.stdio });
  const lifecycle = { closed: false, completion: null };
  lifecycle.completion = new Promise(resolve => child.once('close', () => { lifecycle.closed = true; resolve(); }));
  lifecycles.set(child, lifecycle);
  return child;
}

/** Let the CLI release native terminal and private-file helpers before deletion. */
async function stopApp(child) {
  const lifecycle = lifecycles.get(child);
  if (!lifecycle) throw new Error('stopApp requires a child returned by spawnApp.');
  if (lifecycle.closed) return;
  if (child.connected) child.send({ type: 'shutdown' });
  else if (child.exitCode === null && child.signalCode === null) child.kill();
  const waitForClose = async milliseconds => {
    let timeout;
    try { return await Promise.race([lifecycle.completion.then(() => true), new Promise(resolve => { timeout = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timeout); }
  };
  if (await waitForClose(10_000)) return;
  child.kill('SIGKILL');
  await waitForClose(2_000);
  throw new Error('The test application did not shut down gracefully within 10 seconds.');
}

async function removeAppData(directory) {
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('gopher-')) {
    throw new Error('Refusing to remove a directory outside the test-created temporary workspace.');
  }
  // Windows antivirus and recently closed native handles can briefly retain files.
  await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

function browserLaunchOptions(channel) {
  const selected = channel || process.env.GOPHER_BROWSER_CHANNEL;
  if (selected) return { headless: true, channel: selected };
  const candidates = process.platform === 'win32' ? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ] : [];
  const executablePath = candidates.find(existsSync);
  return { headless: true, ...(executablePath ? { executablePath } : {}) };
}

module.exports = { appTestsEnabled, browserTestsEnabled, chromium, spawnApp, stopApp, removeAppData, browserLaunchOptions };
