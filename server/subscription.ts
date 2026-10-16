import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { thinkingCapability } from './tools/capabilities.js';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_CLIENT_VERSION = '0.163.0';
export async function codexClientVersion(cachePath = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'models_cache.json')): Promise<string> {
  try {
    const version = JSON.parse(await readFile(cachePath, 'utf8')).client_version;
    if (typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) {
      const candidate = version.split('.').map(Number), baseline = CODEX_CLIENT_VERSION.split('.').map(Number);
      for (let index = 0; index < candidate.length; index++) { if (candidate[index] > baseline[index]) return version; if (candidate[index] < baseline[index]) break; }
    }
  } catch {}
  return CODEX_CLIENT_VERSION;
}
export const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
export const CODEX_ID = 'builtin-openai-codex';
export interface CodexSecret { access_token: string; refresh_token: string; expires_at: number; refresh_dead?: boolean }
const refreshed = new Map<string, Promise<CodexSecret>>();
const refreshRequests=new Set<AbortController>();
export function clearSubscriptionCache():void{for(const controller of refreshRequests)controller.abort(new Error('Provider session was cleared'));refreshRequests.clear();refreshed.clear();}
function claims(token: string): any { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { return {}; } }
export function codexSecretFromTokens(tokens: any): string {
  if (!tokens.access_token) throw new Error('ChatGPT did not return an access token');
  return JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token || '', expires_at: tokens.expires_at || (tokens.expires_in ? Math.floor(Date.now() / 1000) + Number(tokens.expires_in) : claims(tokens.access_token).exp || 0) });
}
async function authPost(url: string, body: any, form = false,signal?:AbortSignal): Promise<any> {
  if (new URL(url).origin !== 'https://auth.openai.com') throw new Error('Unexpected authentication host');
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body), redirect: 'error', signal: signal?AbortSignal.any([signal,AbortSignal.timeout(25_000)]):AbortSignal.timeout(25_000) });
  const raw = await response.text(); let result: any; try { result = JSON.parse(raw); } catch { result = {}; }
  if (!response.ok) { const error = new Error(result.error_description || result.error?.message || result.message || `ChatGPT sign-in failed (${response.status})`); Object.assign(error, { status: response.status }); throw error; }
  return result;
}
export async function refreshCodexSecret(stored: string): Promise<{secret_json: string; changed: boolean}> {
  let secret: CodexSecret; try { secret = JSON.parse(stored); } catch { throw new Error('Sign in to ChatGPT to use Codex models.'); }
  if (secret.refresh_dead) throw new Error('Sign in to ChatGPT again.');
  const expiry = secret.expires_at || claims(secret.access_token).exp || 0;
  if (secret.access_token && (!expiry || expiry > Date.now() / 1000 + 120)) return { secret_json: stored, changed: false };
  if (!secret.refresh_token) return{secret_json:JSON.stringify({...secret,refresh_dead:true}),changed:true};
  let pending = refreshed.get(stored);
  if (!pending) {
    const controller=new AbortController();refreshRequests.add(controller);pending = authPost('https://auth.openai.com/oauth/token', { grant_type: 'refresh_token', refresh_token: secret.refresh_token, client_id: CODEX_CLIENT_ID }, true,controller.signal).then(tokens => JSON.parse(codexSecretFromTokens({ ...tokens,expires_in:tokens.expires_in??3600, refresh_token: tokens.refresh_token || secret.refresh_token })) as CodexSecret).catch(error=>{if((error as any).status>=400&&(error as any).status<500)return{...secret,refresh_dead:true};throw error;}).finally(()=>refreshRequests.delete(controller));
    refreshed.set(stored, pending); pending.catch(() => refreshed.delete(stored));
  }
  secret = await pending; return { secret_json: JSON.stringify(secret), changed: true };
}
export async function prepareCodex(stored: string): Promise<{token: string; headers: Record<string, string>; secret_json: string; changed: boolean}> {
  const result = await refreshCodexSecret(stored); const secret = JSON.parse(result.secret_json) as CodexSecret;
  if(secret.refresh_dead||!secret.access_token)throw new Error('Sign in to ChatGPT again.');
  const data = claims(secret.access_token); const auth = data['https://api.openai.com/auth'] || data;
  const headers: Record<string, string> = { originator: 'gopher', 'user-agent': 'gopher-typescript/1.0' };
  if (auth.chatgpt_account_id) headers['ChatGPT-Account-ID'] = auth.chatgpt_account_id;
  const residency = auth.chatgpt_data_residency || auth.chatgpt_compute_residency; if (residency) headers['x-openai-internal-codex-residency'] = residency;
  return { token: secret.access_token, headers, ...result };
}
export async function importCodexCliSecret(authPath = path.join(process.env.CODEX_HOME||path.join(homedir(), '.codex'), 'auth.json')): Promise<string> {
  const body = JSON.parse(await readFile(authPath, 'utf8')); const tokens = body.tokens || body;
  if(!tokens.access_token?.trim()||!tokens.refresh_token?.trim())throw new Error('Codex CLI credentials did not include a ChatGPT session.');
  return codexSecretFromTokens(tokens);
}
export async function localCodexModels():Promise<any[]>{
  const home=process.env.CODEX_HOME||path.join(homedir(),'.codex');let items:any[]=[];let preferred='';
  try{const body=JSON.parse(await readFile(path.join(home,'models_cache.json'),'utf8'));items=(body.models||[]).filter((item:any)=>item.slug&&!['hide','hidden'].includes(String(item.visibility||'').trim().toLowerCase())).sort((a:any,b:any)=>(a.priority??10000)-(b.priority??10000)||String(a.slug).localeCompare(String(b.slug)));}catch{}
  try{preferred=String(parse(await readFile(path.join(home,'config.toml'),'utf8')).model||'').trim();}catch{}
  const models=[...new Map(items.map(item=>[item.slug,{model:item.slug,name:item.display_name||item.slug,label:item.slug,...thinkingCapability(item,true),attachments_supported:false,prompt_progress_supported:false}])).values()];if(preferred){const found=models.findIndex(item=>item.model===preferred);if(found>=0)models.unshift(...models.splice(found,1));else models.unshift({model:preferred,name:preferred,label:preferred,...thinkingCapability({},true),attachments_supported:false,prompt_progress_supported:false});}return models;
}
export async function requestDeviceCode(): Promise<{user_code: string; verification_url: string; device_auth_id: string; interval_secs: number}> {
  const body = await authPost('https://auth.openai.com/api/accounts/deviceauth/usercode', { client_id: CODEX_CLIENT_ID });
  if (!body.user_code || !body.device_auth_id) throw new Error('ChatGPT returned an incomplete device code');
  return { user_code: body.user_code, verification_url: 'https://auth.openai.com/codex/device', device_auth_id: body.device_auth_id, interval_secs: Math.max(3, Number(body.interval) || 5) };
}
export async function pollDeviceCode(userCode: string, deviceAuthId: string): Promise<string | null> {
  if (!userCode || !deviceAuthId) throw new Error('Device code and authentication ID are required');
  let body: any; try { body = await authPost('https://auth.openai.com/api/accounts/deviceauth/token', { user_code: userCode, device_auth_id: deviceAuthId }); } catch (error) { if ([403, 404].includes((error as any).status)) return null; throw error; }
  if (!body.authorization_code || !body.code_verifier) return null;
  const tokens = await authPost('https://auth.openai.com/oauth/token', { grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID, code: body.authorization_code, code_verifier: body.code_verifier, redirect_uri: 'https://auth.openai.com/deviceauth/callback' }, true);
  return codexSecretFromTokens(tokens);
}
export interface CodexLogin { authorization_url: string; url: string; result: Promise<string>; cancel: () => void }
export async function beginCodexLogin(): Promise<CodexLogin> {
  const verifier = randomBytes(32).toString('base64url'); const state = randomBytes(24).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url');
  let resolveResult!: (secret: string) => void; let rejectResult!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const callback = 'http://localhost:1455/auth/callback';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', callback);
    if (url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
    const actual = Buffer.from(url.searchParams.get('state') || ''); const expected = Buffer.from(state);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(400).end('Invalid sign-in state'); return; }
    try {
      const code = url.searchParams.get('code'); if (!code) throw new Error(url.searchParams.get('error_description') || 'ChatGPT sign-in was cancelled');
      const tokens = await authPost('https://auth.openai.com/oauth/token', { grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID, code, code_verifier: verifier, redirect_uri: callback }, true);
      resolveResult(codexSecretFromTokens(tokens)); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><body style="font:18px system-ui;background:#111;color:#eee;padding:10vw"><h1>Connected to ChatGPT</h1><p>You can close this tab and return to Gopher.</p></body></html>');
    } catch (error) { rejectResult(error as Error); res.writeHead(400).end('Sign-in failed. Return to Gopher and try again.'); }
    finally { clearTimeout(timer); server.close(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(1455, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const timer = setTimeout(() => { rejectResult(new Error('ChatGPT sign-in timed out')); server.close(); }, 300_000); timer.unref();
  const url = new URL('https://auth.openai.com/oauth/authorize');
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: CODEX_CLIENT_ID, redirect_uri: callback, scope: 'openid profile email offline_access', code_challenge: challenge, code_challenge_method: 'S256', state, codex_cli_simplified_flow: 'true', originator: 'gopher' })) url.searchParams.set(key, value);
  return { authorization_url: url.toString(), url: url.toString(), result, cancel: () => { clearTimeout(timer); server.close(); rejectResult(new Error('Sign-in cancelled')); } };
}
