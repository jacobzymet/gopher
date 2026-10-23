import { beginCodexLogin, importCodexCliSecret, pollDeviceCode, requestDeviceCode } from '../../subscription.js';
import { openExternal } from '../../system.js';
import { applyUpdate, checkUpdates } from '../../updates.js';
import { HttpError, sendJson } from '../protocol.js';
import { objectBody } from '../guards.js';
import { route, type Route, type RouteContext } from '../router.js';
import type { AppRuntime } from '../runtime.js';

/** Connecting ChatGPT (browser, device code or Codex CLI import), disconnecting, and app updates. */

const DEVICE_CODE_LIFETIME_MS = 15 * 60_000;
const lockedDuringSignIn = () => new HttpError(423, 'Session was locked during sign-in.', 'encrypted_locked');

/** Store a ChatGPT credential, unless the session locked or changed since sign-in began. */
function credentialSaver(runtime: AppRuntime, generation: number) {
  return async (secret: string): Promise<void> => {
    if (generation !== runtime.generation || runtime.locked) throw lockedDuringSignIn();
    await runtime.updateConfig(next => {
      const provider = next.providers.find(item => item.kind === 'openai-codex');
      if (!provider) throw new Error('ChatGPT provider is missing.');
      provider.token = secret;
      next.active_provider_id = provider.id;
    });
  };
}

/** ChatGPT credentials are OAuth sessions, which are only ever stored encrypted. */
function requireEncryption({ runtime }: RouteContext): void {
  if (!runtime.storage.encrypted || !runtime.storage.unlocked) {
    throw new HttpError(400, 'Enable and unlock local data encryption before connecting ChatGPT.');
  }
}

async function startDeviceCode(context: RouteContext): Promise<void> {
  requireEncryption(context);
  const { runtime, response } = context;
  if (runtime.deviceStatus.status === 'pending') return sendJson(response, runtime.deviceStatus);
  const generation = runtime.generation, save = credentialSaver(runtime, generation);
  const code = await requestDeviceCode();
  if (generation !== runtime.generation || runtime.locked) throw lockedDuringSignIn();
  runtime.deviceStatus = { status: 'pending', user_code: code.user_code, verification_url: code.verification_url };
  const expires = Date.now() + DEVICE_CODE_LIFETIME_MS;
  const schedule = () => {
    runtime.deviceTimer = setTimeout(() => { void poll(); }, code.interval_secs * 1000);
    runtime.deviceTimer.unref();
  };
  const poll = async () => {
    if (generation !== runtime.generation) return;
    try {
      if (Date.now() > expires) throw new Error('The sign-in code expired. Start again.');
      const secret = await pollDeviceCode(code.user_code, code.device_auth_id);
      if (generation !== runtime.generation) return;
      if (secret) { await save(secret); runtime.deviceStatus = { status: 'ready' }; return; }
      schedule();
    } catch (error) {
      if (generation !== runtime.generation) return;
      runtime.deviceStatus = { status: 'error', error: (error as Error).message };
    }
  };
  schedule();
  sendJson(response, runtime.deviceStatus);
}

async function browserLogin(context: RouteContext): Promise<void> {
  requireEncryption(context);
  const { runtime, response } = context;
  if (runtime.signInCancel) throw new HttpError(409, 'ChatGPT sign-in is already open.');
  const generation = runtime.generation;
  let login: Awaited<ReturnType<typeof beginCodexLogin>>;
  try { login = await beginCodexLogin(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const message = 'Port 1455 is already in use. Switching to device-code sign-in.';
      throw new HttpError(409, message, 'codex_browser_port_busy');
    }
    throw error;
  }
  if (generation !== runtime.generation || runtime.locked) {
    login.result.catch(() => {});
    login.cancel();
    throw lockedDuringSignIn();
  }
  runtime.signInCancel = login.cancel;
  const result = login.result.then(credentialSaver(runtime, generation));
  result.catch(() => {});
  try {
    await openExternal(login.authorization_url);
    await result;
  } finally {
    runtime.signInCancel = undefined;
    login.cancel();
  }
  sendJson(response, runtime.providerResponse());
}

async function importCli(context: RouteContext): Promise<void> {
  requireEncryption(context);
  const { runtime, body, response } = context;
  if (!objectBody(body).confirm) throw new HttpError(400, 'Confirm importing your local Codex session.');
  await credentialSaver(runtime, runtime.generation)(await importCodexCliSecret());
  sendJson(response, runtime.providerResponse());
}

async function disconnect({ runtime, body, response }: RouteContext): Promise<void> {
  const kind = objectBody(body).kind;
  await runtime.updateConfig(next => {
    const provider = next.providers.find(item => item.kind === kind);
    if (!provider || provider.kind === 'custom') throw new HttpError(400, 'Unknown built-in provider.');
    provider.token = '';
  });
  sendJson(response, runtime.providerResponse());
}

export const accountRoutes: Route[] = [
  route('GET', '/api/subscription/codex/device', ({ runtime, response }) => sendJson(response, runtime.deviceStatus)),
  route('POST', '/api/subscription/codex/device', startDeviceCode),
  route('POST', '/api/subscription/codex/login', browserLogin),
  route('POST', '/api/subscription/codex/import', importCli),
  route('POST', '/api/subscription/disconnect', disconnect),
  route('*', path => path.startsWith('/api/subscription/'), () => {
    throw new HttpError(404, 'Unknown subscription endpoint.');
  }),
  route('GET', '/api/updates/check', async ({ url, response }) => {
    sendJson(response, await checkUpdates(url.searchParams.has('force')));
  }),
  route('POST', '/api/updates/apply', async ({ runtime, response }) => {
    sendJson(response, await applyUpdate(runtime.storage.configPath, runtime.authority));
  }),
];
