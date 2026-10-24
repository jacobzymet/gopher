import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { thinkingCapability, type ThinkingCapability } from './tools/capabilities.js';

/**
 * Using a ChatGPT subscription for Codex models: OAuth sign-in (browser with PKCE, or device code),
 * importing the Codex CLI's session, refreshing access tokens, and the CLI's cached model list.
 * Credentials are stored as a JSON "secret" in the built-in provider's token (encrypted at rest).
 */

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_CLIENT_VERSION = '0.163.0';
export const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
export const CODEX_ID = 'builtin-openai-codex';
const AUTH_ORIGIN = 'https://auth.openai.com';
const AUTH_TIMEOUT_MS = 25_000;
const REFRESH_MARGIN_SECONDS = 120;
const LOGIN_PORT = 1455;
const LOGIN_TIMEOUT_MS = 300_000;
const codexHome = () => process.env.CODEX_HOME || path.join(homedir(), '.codex');

export interface CodexSecret { access_token: string; refresh_token: string; expires_at: number; refresh_dead?: boolean }
type Json = Record<string, unknown>;
const asJson = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value)
  ? value as Json : {});
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** A newer client version from the Codex CLI's cache, so the model list matches what the CLI sees. */
export async function codexClientVersion(cachePath = path.join(codexHome(), 'models_cache.json')): Promise<string> {
  try {
    const version = asJson(JSON.parse(await readFile(cachePath, 'utf8'))).client_version;
    if (typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) {
      const candidate = version.split('.').map(Number), baseline = CODEX_CLIENT_VERSION.split('.').map(Number);
      for (let index = 0; index < candidate.length; index++) {
        if (candidate[index]! > baseline[index]!) return version;
        if (candidate[index]! < baseline[index]!) break;
      }
    }
  } catch { /* No usable CLI cache. */ }
  return CODEX_CLIENT_VERSION;
}

const refreshed = new Map<string, Promise<CodexSecret>>();
const refreshRequests = new Set<AbortController>();

/** Abort refreshes in flight and forget their results (on lock). */
export function clearSubscriptionCache(): void {
  for (const controller of refreshRequests) controller.abort(new Error('Provider session was cleared'));
  refreshRequests.clear();
  refreshed.clear();
}

/** The (unverified) payload of a JWT access token, for its expiry and account claims. */
function claims(token: string): Json {
  try { return asJson(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())); } catch { return {}; }
}

export function codexSecretFromTokens(raw: unknown): string {
  const tokens = asJson(raw);
  const access = text(tokens.access_token);
  if (!access) throw new Error('ChatGPT did not return an access token');
  const expiresIn = Number(tokens.expires_in);
  const expiry = Number(tokens.expires_at)
    || (expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : Number(claims(access).exp) || 0);
  return JSON.stringify({ access_token: access, refresh_token: text(tokens.refresh_token), expires_at: expiry });
}

async function authPost(url: string, body: Record<string, string>, form = false, signal?: AbortSignal): Promise<Json> {
  if (new URL(url).origin !== AUTH_ORIGIN) throw new Error('Unexpected authentication host');
  const timeout = AbortSignal.timeout(AUTH_TIMEOUT_MS);
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const raw = await response.text();
  let result: Json;
  try { result = asJson(JSON.parse(raw)); } catch { result = {}; }
  if (!response.ok) {
    const message = text(result.error_description) || text(asJson(result.error).message) || text(result.message)
      || `ChatGPT sign-in failed (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return result;
}

/**
 * Refresh an access token that expires within two minutes. Concurrent refreshes of the same
 * secret share one request. A refresh token the server rejects marks the secret dead, so the
 * user is asked to sign in again instead of retrying forever.
 */
export async function refreshCodexSecret(stored: string): Promise<{ secret_json: string; changed: boolean }> {
  let secret: CodexSecret;
  try { secret = JSON.parse(stored) as CodexSecret; } catch { throw new Error('Sign in to ChatGPT to use Codex models.'); }
  if (secret.refresh_dead) throw new Error('Sign in to ChatGPT again.');
  const expiry = secret.expires_at || Number(claims(secret.access_token).exp) || 0;
  if (secret.access_token
    && (!expiry || expiry > Date.now() / 1000 + REFRESH_MARGIN_SECONDS)) return { secret_json: stored, changed: false };
  if (!secret.refresh_token) return { secret_json: JSON.stringify({ ...secret, refresh_dead: true }), changed: true };
  let pending = refreshed.get(stored);
  if (!pending) {
    const controller = new AbortController();
    refreshRequests.add(controller);
    const request = { grant_type: 'refresh_token', refresh_token: secret.refresh_token, client_id: CODEX_CLIENT_ID };
    const current = secret;
    pending = authPost(`${AUTH_ORIGIN}/oauth/token`, request, true, controller.signal)
      .then(tokens => JSON.parse(codexSecretFromTokens({
        ...tokens, expires_in: tokens.expires_in ?? 3600, refresh_token: tokens.refresh_token || current.refresh_token,
      })) as CodexSecret)
      .catch(error => {
        const status = (error as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500) return { ...current, refresh_dead: true };
        throw error;
      })
      .finally(() => refreshRequests.delete(controller));
    refreshed.set(stored, pending);
    pending.catch(() => refreshed.delete(stored));
  }
  secret = await pending;
  return { secret_json: JSON.stringify(secret), changed: true };
}

/** A current access token and the ChatGPT account headers the Codex backend expects. */
export async function prepareCodex(stored: string): Promise<{ token: string; headers: Record<string,
  string>; secret_json: string; changed: boolean }> {
  const result = await refreshCodexSecret(stored);
  const secret = JSON.parse(result.secret_json) as CodexSecret;
  if (secret.refresh_dead || !secret.access_token) throw new Error('Sign in to ChatGPT again.');
  const data = claims(secret.access_token);
  const auth = asJson(data['https://api.openai.com/auth'] ?? data);
  const headers: Record<string, string> = { originator: 'gopher', 'user-agent': 'gopher-typescript/1.0' };
  const account = text(auth.chatgpt_account_id);
  if (account) headers['ChatGPT-Account-ID'] = account;
  const residency = text(auth.chatgpt_data_residency) || text(auth.chatgpt_compute_residency);
  if (residency) headers['x-openai-internal-codex-residency'] = residency;
  return { token: secret.access_token, headers, ...result };
}

export async function importCodexCliSecret(authPath = path.join(codexHome(), 'auth.json')): Promise<string> {
  const body = asJson(JSON.parse(await readFile(authPath, 'utf8')));
  const tokens = body.tokens ? asJson(body.tokens) : body;
  if (!text(tokens.access_token).trim() || !text(tokens.refresh_token).trim()) {
    throw new Error('Codex CLI credentials did not include a ChatGPT session.');
  }
  return codexSecretFromTokens(tokens);
}

export interface LocalCodexModel extends ThinkingCapability {
  model: string; name: string; label: string; attachments_supported: boolean; prompt_progress_supported: boolean;
}

/** The Codex CLI's cached model list, with its configured default model first. */
export async function localCodexModels(): Promise<LocalCodexModel[]> {
  let items: Json[] = [], preferred = '';
  try {
    const body = asJson(JSON.parse(await readFile(path.join(codexHome(), 'models_cache.json'), 'utf8')));
    const priority = (item: Json) => (typeof item.priority === 'number' ? item.priority : 10000);
    const hidden = (item: Json) => ['hide', 'hidden'].includes(String(item.visibility || '').trim().toLowerCase());
    items = (Array.isArray(body.models) ? body.models : []).map(asJson).filter(item => item.slug && !hidden(item))
      .sort((a, b) => priority(a) - priority(b) || String(a.slug).localeCompare(String(b.slug)));
  } catch { /* No cached models. */ }
  try { preferred = String(parse(await readFile(path.join(codexHome(), 'config.toml'), 'utf8')).model
    || '').trim(); } catch { /* No CLI config. */ }
  const entry = (model: string, name: string, item: Json = {}): LocalCodexModel => ({
    model, name, label: model, ...thinkingCapability(item, true), attachments_supported: false,
      prompt_progress_supported: false,
  });
  const models = [...new Map(items.map(item => [String(item.slug),
    entry(String(item.slug), text(item.display_name) || String(item.slug), item)])).values()];
  if (preferred) {
    const found = models.findIndex(item => item.model === preferred);
    if (found >= 0) models.unshift(...models.splice(found, 1));
    else models.unshift(entry(preferred, preferred));
  }
  return models;
}

export async function requestDeviceCode(): Promise<{ user_code: string; verification_url: string; device_auth_id: string; interval_secs: number }> {
  const body = await authPost(`${AUTH_ORIGIN}/api/accounts/deviceauth/usercode`, { client_id: CODEX_CLIENT_ID });
  const userCode = text(body.user_code), deviceAuthId = text(body.device_auth_id);
  if (!userCode || !deviceAuthId) throw new Error('ChatGPT returned an incomplete device code');
  return { user_code: userCode, verification_url: `${AUTH_ORIGIN}/codex/device`, device_auth_id: deviceAuthId,
    interval_secs: Math.max(3, Number(body.interval) || 5) };
}

/** One poll of a device code: the secret once the user approved, or null while still waiting. */
export async function pollDeviceCode(userCode: string, deviceAuthId: string): Promise<string | null> {
  if (!userCode || !deviceAuthId) throw new Error('Device code and authentication ID are required');
  let body: Json;
  try { body = await authPost(`${AUTH_ORIGIN}/api/accounts/deviceauth/token`,
    { user_code: userCode, device_auth_id: deviceAuthId }); }
  catch (error) { if ([403, 404].includes((error as { status?: number }).status ?? 0)) return null; throw error; }
  const code = text(body.authorization_code), verifier = text(body.code_verifier);
  if (!code || !verifier) return null;
  const tokens = await authPost(`${AUTH_ORIGIN}/oauth/token`, {
    grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID, code, code_verifier: verifier,
    redirect_uri: `${AUTH_ORIGIN}/deviceauth/callback`,
  }, true);
  return codexSecretFromTokens(tokens);
}

export interface CodexLogin { authorization_url: string; url: string; result: Promise<string>; cancel: () => void }

const CONNECTED_PAGE = '<html><body style="font:18px system-ui;background:#111;color:#eee;padding:10vw"><h1>Connected to ChatGPT</h1>'
  + '<p>You can close this tab and return to Gopher.</p></body></html>';

/**
 * Browser sign-in with PKCE. A one-shot callback server on localhost:1455 (the port registered
 * for this client) accepts only the expected state, exchanges the code, and closes.
 */
export async function beginCodexLogin(): Promise<CodexLogin> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let resolveResult!: (secret: string) => void, rejectResult!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const callback = `http://localhost:${LOGIN_PORT}/auth/callback`;
  const server = createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url || '/', callback); }
    catch { res.writeHead(400).end('Invalid callback URL'); return; }
    if (url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
    const actual = Buffer.from(url.searchParams.get('state') || ''), expected = Buffer.from(state);
    if (actual.length !== expected.length
      || !timingSafeEqual(actual, expected)) { res.writeHead(400).end('Invalid sign-in state'); return; }
    try {
      const code = url.searchParams.get('code');
      if (!code) throw new Error(url.searchParams.get('error_description') || 'ChatGPT sign-in was cancelled');
      const tokens = await authPost(`${AUTH_ORIGIN}/oauth/token`, {
        grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID, code, code_verifier: verifier,
          redirect_uri: callback,
      }, true);
      resolveResult(codexSecretFromTokens(tokens));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CONNECTED_PAGE);
    } catch (error) {
      rejectResult(error as Error);
      res.writeHead(400).end('Sign-in failed. Return to Gopher and try again.');
    } finally { clearTimeout(timer); server.close(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(LOGIN_PORT, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const timer = setTimeout(() => { rejectResult(new Error('ChatGPT sign-in timed out')); server.close(); },
    LOGIN_TIMEOUT_MS);
  timer.unref();
  const url = new URL(`${AUTH_ORIGIN}/oauth/authorize`);
  const parameters = {
    response_type: 'code', client_id: CODEX_CLIENT_ID, redirect_uri: callback,
      scope: 'openid profile email offline_access',
    code_challenge: challenge, code_challenge_method: 'S256', state, codex_cli_simplified_flow: 'true',
      originator: 'gopher',
  };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  const cancel = () => { clearTimeout(timer); server.close(); rejectResult(new Error('Sign-in cancelled')); };
  return { authorization_url: url.toString(), url: url.toString(), result, cancel };
}
