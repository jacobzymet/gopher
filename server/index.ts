import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './http/app.js';
import { defaultConfig, defaultConfigPath, parseConfig, resolveBind } from './config.js';
import { openExternal } from './system.js';
import { buildVersion } from './updates.js';
import { parseCliArgs } from './cli.js';

export { createApp, HttpError, type ServerOptions } from './http/app.js';

/** Command-line entry point: reuse a running instance, or start the server and open the app. */

const HELP = `Gopher — local AI workspace

--headless  Run the local server
--browser   Open in your browser
--config PATH  Configuration file
--bind ADDR    Loopback address (default 127.0.0.1:3930)`;
const UPDATE_RESTART_ATTEMPTS = 60;
const SHUTDOWN_DEADLINE_MS = 10_000;
type App = Awaited<ReturnType<typeof createApp>>;

/** Ask an already-running Gopher on this address to focus its window. Undefined when none answers. */
async function existingInstance(origin: string): Promise<{ focused: boolean } | undefined> {
  try {
    const bootstrap = await fetch(origin, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    await bootstrap.body?.cancel();
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) return undefined;
    const result = await fetch(`${origin}/api/focus`, {
      method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    const info = await result.json() as { app?: string; focused?: boolean };
    return result.ok && info.app === 'gopher' ? { focused: info.focused === true } : undefined;
  } catch { return undefined; /* No authenticated Gopher instance is listening. */ }
}

/** After an update the new process starts while the old one is still releasing its lock and port, so it retries. */
async function startApp(configPath: string, bind: string | undefined,
  updateRestart: boolean): Promise<{ app: App; url: string }> {
  const attempts = updateRestart ? UPDATE_RESTART_ATTEMPTS : 1;
  for (let attempt = 0; ; attempt++) {
    let app: App | undefined;
    try {
      app = await createApp({ configPath, bind });
      return { app, url: await app.listen() };
    } catch (error) {
      if (app) await app.close();
      const busy = /already in use|another Gopher process|data.folder lock|EADDRINUSE/i;
      const retryable = busy.test((error as Error).message);
      if (!updateRestart || !retryable || attempt >= attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

function handleShutdown(app: App): void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // Close cleanly (stop terminals and browsers, flush and release the data lock), but never hang.
    const deadline = setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    void app.close()
      .then(() => process.exit(0))
      .catch(error => {
        console.error(`Gopher did not shut down cleanly: ${(error as Error).message || error}`);
        process.exit(1);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('disconnect', shutdown);
  process.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') shutdown();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cli = parseCliArgs(args);
  if (cli.version) { console.log(buildVersion()); return; }
  if (cli.help) { console.log(HELP); return; }
  const configPath = cli.configPath || defaultConfigPath();
  let startupConfig = defaultConfig();
  try { startupConfig = parseConfig(await readFile(configPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bind = resolveBind(startupConfig, cli.bind);
  const openBrowser = args.includes('--browser') || args.includes('--open');
  if (!cli.updateRestart && bind.port) {
    const origin = `http://${bind.host.includes(':') ? `[${bind.host}]` : bind.host}:${bind.port}`;
    const existing = await existingInstance(origin);
    if (existing) {
      console.log(existing.focused ? 'Gopher is already running — focused the open window.'
        : `Gopher is already running — using the existing server at ${origin}.`);
      if (process.send) {
        const message = { type: 'existing-instance', url: origin, focused: existing.focused };
        await new Promise<void>((resolve, reject) => {
          process.send!(message, error => (error ? reject(error) : resolve()));
        });
      }
      if (openBrowser || (!cli.headless && !process.send && !existing.focused)) await openExternal(origin);
      if (process.connected) process.disconnect?.();
      return;
    }
  }
  const { app, url } = await startApp(configPath, cli.bind, cli.updateRestart);
  console.log(`Gopher listening on ${url}`);
  if (openBrowser || (!cli.headless && !process.send)) await openExternal(url);
  handleShutdown(app);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error((error as Error).message || error); process.exitCode = 1; });
}
