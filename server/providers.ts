import type { Provider } from './config.js';
import { prepareCodex, refreshCodexSecret, clearSubscriptionCache, codexClientVersion } from './subscription.js';
import { record } from './diagnostics.js';
import { isIP } from 'node:net';
import { thinkingCapability, thinkingFromProps, visionCapability, contextCapability } from './tools/capabilities.js';
import { localCodexModels } from './subscription.js';
import { promptText } from './tools/prompts.js';

export type { Provider } from './config.js';
export interface ModelOption { model: string; name: string; provider_id: string; provider_name: string; base: string; api_style: string; context_length?: number; thinking_supported?: boolean; reasoning_supported?: boolean; vision?: boolean; connect_kind?: string; [key: string]: unknown }
export interface ProviderEvent { type: 'text' | 'reasoning' | 'tool' | 'usage' | 'progress' | 'done'; text?: string; index?: number; id?: string; name?: string; arguments?: string; usage?: any; data?: any }
export interface ProvidersOptions { getProviders: () => Provider[]; getActiveProviderId?: () => string; saveProvider?: (provider: Provider) => Promise<void> }
export interface ProviderHealth { ok: boolean; kind: 'ready' | 'empty' | 'waiting' | 'auth' | 'unreachable' | 'error'; message: string; model_count: number; checked_at: number; model?: string; status?: string; error?: string }

function privateIpv4(host:string):boolean{
  const [a,b,c,d]=host.split('.').map(Number);
  return a===0||a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===192&&b===0&&c===0)||(a===192&&b===0&&c===2)||(a===198&&(b===18||b===19))||(a===198&&b===51&&c===100)||(a===203&&b===0&&c===113)||a>=224||(a===255&&b===255&&c===255&&d===255);
}
export function providerHostIsLocal(hostname:string):boolean{
  const host=hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local'))return true;
  if(isIP(host)===4)return privateIpv4(host);
  if(isIP(host)===6){if(host==='::'||host==='::1'||/^(fc|fd|fe[89ab]|ff)/.test(host))return true;const mapped=host.match(/^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/);if(mapped){if(mapped[3])return privateIpv4(mapped[3]);const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);return privateIpv4(`${high>>8}.${high&255}.${low>>8}.${low&255}`);}}
  return false;
}
export function normalizeBase(value: string, _style = 'openai'): string {
  const raw=value.trim();if(!raw)throw new Error('Provider URL must not be empty');const url = new URL(raw.includes('://')?raw:`http://${raw}`);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#')) throw new Error('Provider URL must use HTTP or HTTPS without credentials, query, or fragment');
  if(url.protocol==='http:'&&!providerHostIsLocal(url.hostname))url.protocol='https:';
  const pathname=url.pathname.replace(/\/+$/,'');url.pathname=pathname.endsWith('/v1')?pathname:`${pathname}/v1`;
  return url.toString().replace(/\/+$/, '');
}
export function providerAuthHeaders(style:string,rawToken:string):Record<string,string>{
  const token=rawToken.trim();const headers:Record<string,string>={};if(style==='anthropic')headers['anthropic-version']='2023-06-01';
  if(token.startsWith('cf-access:')){const credentials=token.slice(10);const colon=credentials.indexOf(':');if(colon>=0){const id=credentials.slice(0,colon).trim(),secret=credentials.slice(colon+1).trim();if(id&&secret){headers['CF-Access-Client-Id']=id;headers['CF-Access-Client-Secret']=secret;return headers;}}}
  if(token)headers[style==='anthropic'?'x-api-key':'authorization']=style==='anthropic'?token:`Bearer ${token}`;return headers;
}

const dispatchers = new Map<string, any>();
export async function providerFetch(provider: Provider, suffix: string, init: RequestInit = {}): Promise<Response> {
  const builtin = provider.kind === 'openai-codex';
  const base = builtin ? 'https://chatgpt.com/backend-api/codex' : normalizeBase(provider.base, provider.api_style);
  const headers = new Headers(init.headers);
  headers.set('accept', suffix.includes('models') ? 'application/json' : 'text/event-stream, application/json');
  let token = provider.token || '';
  if (builtin) {
    const prepared = await prepareCodex(token);
    token = prepared.token;
    for (const [key, value] of Object.entries(prepared.headers)) headers.set(key, value);
  }
  for(const[key,value]of Object.entries(providerAuthHeaders(provider.api_style,token)))headers.set(key,value);
  let dispatcher: any;
  if (provider.allow_insecure_tls && !builtin) {
    const origin = new URL(base).origin;
    dispatcher = dispatchers.get(origin);
    if (!dispatcher) { const { Agent } = await import('undici'); dispatcher = new Agent({ connect: { rejectUnauthorized: false } }); dispatchers.set(origin, dispatcher); }
  }
  const url=`${base}/${suffix.replace(/^\//, '')}`;const started=performance.now();record('provider.request',()=>({url,method:init.method||'GET',headers:Object.fromEntries(headers),body:typeof init.body==='string'?(()=>{try{return JSON.parse(init.body);}catch{return init.body;}})():undefined}));
  const headerAbort=new AbortController();const headerTimer=setTimeout(()=>headerAbort.abort(Object.assign(new Error('The model service stalled before returning headers.'),{code:'provider_stalled'})),300_000);headerTimer.unref();
  try{const response=await fetch(url, { ...init,signal:init.signal?AbortSignal.any([init.signal,headerAbort.signal]):headerAbort.signal, headers, redirect: 'error', ...(dispatcher ? { dispatcher } : {}) } as RequestInit);record('provider.headers',{status:response.status,request_elapsed_ms:performance.now()-started,headers:Object.fromEntries(response.headers)});if(!response.ok){let safe=await readBounded(response,32_000);const secrets=[provider.token,token,headers.get('CF-Access-Client-Secret')||'',headers.get('CF-Access-Client-Id')||''];for(const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length))safe=safe.split(secret).join('[redacted]');return new Response(safe,{status:response.status,statusText:response.statusText,headers:response.headers});}return response;}catch(error){record('provider.error',{error:(error as Error).message,request_elapsed_ms:performance.now()-started});throw error;}finally{clearTimeout(headerTimer);}
}

export async function readBounded(response: Response, max = 8 * 1024 * 1024): Promise<string> {
  if (Number(response.headers.get('content-length')) > max) throw new Error('Provider response exceeds the size limit');
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > max) throw new Error('Provider response exceeds the size limit'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function* parseSSE(response: Response,idleTimeoutMs=300_000): AsyncGenerator<{event: string; data: string}> {
  if (!response.ok) {
    const raw = await readBounded(response, 32_000); let message = raw;
    try { const body = JSON.parse(raw); message = typeof body.error === 'string' ? body.error : body.error?.message || body.message || raw; } catch {}
    throw new Error(`Provider request failed (${response.status}): ${message.slice(0, 1800)}`);
  }
  if (!response.body) throw new Error('Provider returned an empty response');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let ended = false;let first=true;
  try {
    while (!ended) {
      let timer:NodeJS.Timeout|undefined;const next = await Promise.race([reader.read(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{record('provider.stalled',{stage:'stream'});reject(Object.assign(new Error('The model stream stalled. Try again.'),{code:'provider_stalled'}));},idleTimeoutMs);timer.unref();})]).finally(()=>clearTimeout(timer)); ended = next.done;const decoded=decoder.decode(next.value, { stream: !ended });if(next.value?.length){if(first){record('provider.first_byte',{bytes:next.value.length});first=false;}record('provider.raw_chunk',()=>({bytes:next.value?.length,text:decoded}));}buffer += decoded;
      if (buffer.length > 2_000_000) throw new Error('Provider stream frame exceeded 2 MB');
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0 || (ended && buffer.length)) {
        if (boundary < 0) boundary = buffer.length;
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const lines = block.split('\n'); const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
        if (data) { yield { event, data }; if (data === '[DONE]') return; }
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function textContent(content: any): string { return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text || '').join('\n') : ''; }

export function anthropicPayload(payload: any,apiBase=''): any {
  const system = payload.messages.filter((m: any) => ['system', 'developer'].includes(m.role)).map((m: any) => textContent(m.content)).join('\n\n');
  const messages: any[] = [];
  const push = (role: string, content: any[]) => { const last = messages.at(-1); if (last?.role === role) last.content.push(...content); else messages.push({ role, content }); };
  for (const message of payload.messages) {
    if (['system', 'developer'].includes(message.role)) continue;
    if (message.role === 'tool') { push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: textContent(message.content) }]); continue; }
    const content: any[] = [];
    if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
    else if (Array.isArray(message.content)) for (const part of message.content) {
      if (part.type === 'text') content.push(part);
      else if (part.type === 'image_url'||part.type==='input_image'||(!part.type&&(part.image_url||part.url))) {
        const url = part.image_url?.url || part.image_url || part.url || ''; const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
        content.push({ type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } });
      }
    }
    for (const call of message.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments });
    if (content.length) push(message.role === 'assistant' ? 'assistant' : 'user', content);
  }
  if(!messages.length)throw new Error('messages must not be empty');if(messages[0].role!=='user')messages.unshift({role:'user',content:[{type:'text',text:'(continued)'}]});
  const result: any = { model: payload.model, ...(system?{system}:{}), messages, max_tokens: Math.max(1,payload.max_tokens || payload.max_completion_tokens || 8192), stream: payload.stream!==false };
  if (payload.tools?.length) { result.tools = payload.tools.map((t: any) => ({ name: t.function.name, description: t.function.description||'', input_schema: t.function.parameters||{type:'object',properties:{}} })); const name=payload.tool_choice?.function?.name||payload.tool_choice?.name;result.tool_choice = name ? { type: 'tool', name } : { type: ['required','any'].includes(payload.tool_choice) ? 'any' : payload.tool_choice==='none'?'none':'auto' }; }
  const budget = payload.thinking_budget_tokens||({low:1024,medium:4096,high:10000,max:10000}as Record<string,number>)[payload.reasoning_effort];
  if (budget > 0) { result.thinking = { type: 'enabled', budget_tokens: Math.min(budget, result.max_tokens - 1) }; delete result.temperature; }
  else if (payload.temperature !== undefined) result.temperature = payload.temperature;
  let official=false;try{const url=new URL(apiBase);official=url.protocol==='https:'&&url.hostname==='api.anthropic.com'&&String(payload.model).startsWith('claude-')&&payload.stream!==false;}catch{}
  if(official){result.cache_control={type:'ephemeral'};const parts=payload.messages.filter((message:any)=>['system','developer'].includes(message.role)).map((message:any)=>textContent(message.content)).filter(Boolean);if(parts.length)result.system=parts.map((text:string,index:number)=>({type:'text',text,...(index===0?{cache_control:{type:'ephemeral'}}:{})}));if(result.tools?.length)result.tools.at(-1).cache_control={type:'ephemeral'};}
  return result;
}

export function responsesPayload(payload: any, builtin = false): any {
  const instructions = payload.messages.filter((m: any) => ['system', 'developer'].includes(m.role)).map((m: any) => textContent(m.content)).join('\n\n');
  const input: any[] = [];
  for (const message of payload.messages) {
    if (['system', 'developer'].includes(message.role)) continue;
    if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textContent(message.content) }); continue; }
    for (const call of message.tool_calls || []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    if (message.content) input.push({ role: message.role==='assistant'?'assistant':'user', content: message.role==='assistant'?textContent(message.content):typeof message.content === 'string' ? message.content : message.content.map((p: any) => p.type === 'image_url' ? { type: 'input_image', image_url: p.image_url.url } : p.text?{ type: 'input_text', text: p.text }:null).filter(Boolean) });
  }
  const result: any = { model: payload.model, ...(instructions||builtin?{instructions:instructions||'You are a helpful assistant.'}:{}), input, stream: payload.stream!==false,...(builtin?{store:false}:{}) };
  if (payload.tools?.length) { result.tools = payload.tools.map((t: any) => ({ type: 'function', strict:false,description:'',parameters:{type:'object',properties:{}}, ...t.function })); result.tool_choice = payload.tool_choice?.function||payload.tool_choice?.name ? { type: 'function', name: payload.tool_choice.function?.name||payload.tool_choice.name } : ['auto','none','required'].includes(payload.tool_choice)?payload.tool_choice:'auto';result.parallel_tool_calls=payload.parallel_tool_calls!==false; }
  if (payload.reasoning&&typeof payload.reasoning==='object'&&Object.keys(payload.reasoning).length&&payload.reasoning.effort!=='') result.reasoning = payload.reasoning;
  else if(typeof payload.reasoning_effort==='string'&&payload.reasoning_effort.trim())result.reasoning={effort:payload.reasoning_effort.trim()};
  if (!builtin && (payload.max_tokens || payload.max_completion_tokens||payload.max_output_tokens)) result.max_output_tokens = payload.max_tokens ||payload.max_completion_tokens||payload.max_output_tokens;
  return result;
}

export class Providers {
  private cache = new Map<string, { at: number; health: ProviderHealth; models: ModelOption[] }>();
  private health = new Map<string, ProviderHealth>();
  private generation=0;
  constructor(private options: ProvidersOptions) {}
  clear(): void { this.generation++;this.cache.clear(); this.health.clear();clearSubscriptionCache(); }
  list(): Provider[] { return this.options.getProviders(); }
  private async refresh(provider:Provider):Promise<void>{if(provider.kind==='openai-codex'&&provider.token){const generation=this.generation;const result=await refreshCodexSecret(provider.token);if(generation!==this.generation)throw new Error('Provider session was cleared');if(result.changed){const updated={...provider,token:result.secret_json};await this.options.saveProvider?.(updated);if(generation!==this.generation)throw new Error('Provider session was cleared');provider.token=updated.token;}}}
  get(id?: string, base?: string): Provider {
    const providers = this.list(); const provider = id ? providers.find(p => p.id === id) : base ? providers.find(p => normalizeBase(p.base, p.api_style) === normalizeBase(base, p.api_style)) : providers.find(p => p.id === this.options.getActiveProviderId?.()) || providers[0];
    if (!provider) throw new Error('No provider configured. Add one in Settings > Providers.');
    return provider;
  }
  async probe(provider: Provider, force = false): Promise<{health: ProviderHealth; models: ModelOption[]}> {
    const generation=this.generation;let refreshError:unknown;if(provider.kind==='openai-codex'&&provider.token)try{await this.refresh(provider);}catch(error){refreshError=error;}
    const key = `${provider.id}:${provider.base}:${provider.token}:${provider.api_style}`; const cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.at < 30_000) return cached;
    let health: ProviderHealth; let models: ModelOption[] = [];
    try {
      if(refreshError)throw refreshError;if(generation!==this.generation)throw new Error('Provider session was cleared');
      const response = await providerFetch(provider, provider.kind === 'openai-codex' ? `models?client_version=${await codexClientVersion()}` : 'models', { signal: AbortSignal.timeout(6000) });
      if (!response.ok) { await response.body?.cancel(); health = { ok: false, kind: response.status === 401 || response.status === 403 ? 'auth' : 'error', message: `HTTP ${response.status}`, error: `HTTP ${response.status}`, model_count: 0, checked_at: Date.now() }; }
      else {
        const body = JSON.parse(await readBounded(response));
        const canonicalBase=provider.kind==='openai-codex'?'https://chatgpt.com/backend-api/codex':normalizeBase(provider.base,provider.api_style);
        let items = Array.isArray(body) ? body : body.data || body.models || [];
        if(provider.kind==='openai-codex')items=items.filter((item:any)=>!['hide','hidden'].includes(String(item.visibility||'').trim().toLowerCase())).sort((a:any,b:any)=>(a.priority??10000)-(b.priority??10000)||String(a.slug).localeCompare(String(b.slug)));
        models = items.map((item: any) => {
          const model = typeof item === 'string' ? item : item.id || item.slug || item.name || item.model;
          if (!model || typeof model !== 'string') return null;
          const context=contextCapability(item),vision=visionCapability(item,provider.api_style)??false;const thinking=thinkingCapability(item,provider.kind==='openai-codex');
          return { id: `remote|${provider.id}|${canonicalBase}|${model}`, model, name: item.display_name || item.name || model, label: model, ready: true, port: Number(new URL(canonicalBase).port) || (canonicalBase.startsWith('https:')?443:80), provider_id: provider.id, provider_name: provider.name, base: canonicalBase, api_style: provider.api_style, request_style: provider.api_style, context_length: context,...thinking, attachments_supported: vision, prompt_progress_supported: Boolean(item.prompt_progress_supported||String(item.owned_by).toLowerCase()==='llamacpp'), vision };
        }).filter(Boolean);
        models=[...new Map(models.map(model=>[model.model,model])).values()];if(provider.api_style==='openai'&&providerHostIsLocal(new URL(canonicalBase).hostname))await this.enrichLocal(provider,models);
        health = { ok: Boolean(models.length), kind: models.length ? 'ready' : 'empty', model: models[0]?.model, message: models.length ? `${models.length} models available` : 'Connected; no models returned', model_count: models.length, checked_at: Date.now() };
      }
    } catch (error) { health = { ok: false, kind: provider.kind === 'openai-codex' && !provider.token ? 'auth' : 'unreachable', message: (error as Error).message, error: (error as Error).message, model_count: 0, checked_at: Date.now() }; }
    if (!models.length && cached?.models.length && health.kind === 'unreachable') models = cached.models;
    if(!models.length&&provider.kind==='openai-codex'&&provider.token&&!['auth','empty'].includes(health.kind))models=(await localCodexModels()).map(item=>({...item,id:`remote|${provider.id}|${provider.base}|${item.model}`,provider_id:provider.id,provider_name:provider.name,base:provider.base,api_style:provider.api_style,request_style:provider.api_style,ready:true,port:443}));
    const result = { at: Date.now(), health, models }; if(generation===this.generation){this.cache.set(key, result); this.health.set(provider.id, health);}return result;
  }
  async catalog(force = false): Promise<ModelOption[]> { return (await Promise.all(this.list().map(async p => { const result = await this.probe(p, force); return result.models.length ? result.models : p.kind === 'openai-codex' && !p.token ? [{ id: `${p.id}:connect`, model: '', name: 'Connect ChatGPT', label: 'Connect ChatGPT', base: p.base, api_style: p.api_style, request_style: p.api_style, provider_id: p.id, provider_name: p.name, ready: false, connect_kind: 'openai-codex', port: 0 }] : []; }))).flat(); }
  cachedHealth(id: string): ProviderHealth | null { return this.health.get(id) || null; }
  private async enrichLocal(provider:Provider,models:ModelOption[]):Promise<void>{
    const json=async(suffix:string,body?:any)=>{try{const response=await providerFetch(provider,suffix,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(1200)});if(!response.ok){await response.body?.cancel();return null;}return JSON.parse(await readBounded(response));}catch{return null;}};
    const[rawProps,native,rawTags]=await Promise.all([json('../props'),json('../api/v1/models'),json('../api/tags')]);const props=rawProps&&(rawProps.chat_template||rawProps.chat_template_caps||rawProps.default_generation_settings)?rawProps:null;const tags=Array.isArray(rawTags?.models)?rawTags:null;const nativeModels=native?.models||native?.data||[];
    for(let start=0;start<models.length;start+=8)await Promise.all(models.slice(start,start+8).map(async model=>{
      const entry=nativeModels.find((entry:any)=>{const id=entry.key||entry.id||entry.name;return id===model.model||id?.split('/').at(-1)===model.model.split('/').at(-1);});if(entry){const capability=thinkingCapability(entry);if(capability.thinking_supported)Object.assign(model,capability);const vision=visionCapability(entry);if(vision!==undefined)model.attachments_supported=model.vision=vision;model.context_length=contextCapability(entry)||model.context_length;}
      if(tags){const show=await json('../api/show',{model:model.model});if(show?.capabilities){model.attachments_supported=model.vision=show.capabilities.includes('vision');if(show.capabilities.includes('thinking'))model.thinking_supported=true;}}
      const modelProps=props?(models.length===1?props:await json(`../props?model=${encodeURIComponent(model.model)}&autoload=false`)||props):null;if(modelProps){model.prompt_progress_supported=true;const capabilities=thinkingFromProps(modelProps);if(capabilities.thinking_supported)Object.assign(model,capabilities);model.context_length=Number(modelProps.default_generation_settings?.n_ctx)||contextCapability(modelProps)||model.context_length;}
    }));
  }
  async *complete(provider: Provider, payload: any, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    signal.throwIfAborted();await this.refresh(provider);signal.throwIfAborted();
    const style = provider.api_style || 'openai';
    const body = style === 'anthropic' ? anthropicPayload(payload,provider.base) : style === 'responses' ? responsesPayload(payload, provider.kind === 'openai-codex') : { ...payload, stream: payload.stream!==false,...(payload.stream!==false?{stream_options: { include_usage: true }}:{}) };
    if(style==='openai')while(body.messages?.[0]?.role==='system'&&body.messages?.[1]?.role==='system'&&body.messages.slice(0,2).every((message:any)=>Object.keys(message).length===2&&typeof message.content==='string'))body.messages.splice(0,2,{role:'system',content:`${body.messages[0].content}\n\n${body.messages[1].content}`});
    for (const key of ['agent', 'skills', 'force_tools', 'conversation_id', 'turn_id', 'deep_research', 'deep_research_output', 'context_window_tokens', 'provider_id', 'remote_base']) delete body[key];
    const response = await providerFetch(provider, style === 'anthropic' ? 'messages' : style === 'responses' ? 'responses' : 'chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (response.headers.get('content-type')?.includes('application/json')) {
      if (!response.ok) { for await (const _ of parseSSE(response)) {} return; }
      const result = JSON.parse(await readBounded(response));
      if (result.error) throw new Error(result.error.message || String(result.error));
      if (style === 'anthropic') for (const block of result.content || []) { if (block.type === 'text') yield { type: 'text', text: block.text }; if (block.type === 'thinking') yield { type: 'reasoning', text: block.thinking }; if (block.type === 'tool_use') yield { type: 'tool', index: result.content.indexOf(block), id: block.id, name: block.name, arguments: JSON.stringify(block.input) }; }
      else if (style === 'responses'){if(result.output_text)yield{type:'text',text:result.output_text};else for (const item of result.output || []) { if (item.type === 'function_call') yield { type: 'tool', index: result.output.indexOf(item), id: item.call_id, name: item.name, arguments: item.arguments }; for (const part of item.content || []) if (part.text) yield { type: 'text', text: part.text }; }}
      else { const message = result.choices?.[0]?.message || {}; if (message.content) yield { type: 'text', text: message.content }; if (message.reasoning_content) yield { type: 'reasoning', text: message.reasoning_content }; for (const [index, call] of (message.tool_calls || []).entries()) yield { type: 'tool', index, id: call.id, name: call.function.name, arguments: call.function.arguments }; }
      if (result.usage) yield { type: 'usage', usage: result.usage }; yield { type: 'done' }; return;
    }
    const responseTools = new Map<string, number>(); let nextTool = 0;
    for await (const frame of parseSSE(response)) {
      if (frame.data === '[DONE]') break;
      let item: any; try { item = JSON.parse(frame.data); } catch { continue; }
      if(!item.type&&frame.event!=='message')item.type=frame.event;
      if (item.error || item.type === 'error') throw new Error(item.error?.message || item.message || String(item.error));
      if (style === 'anthropic') {
        if (item.type === 'content_block_start') {
          const block = item.content_block;
          if (block?.type === 'tool_use') yield { type: 'tool', index: item.index, id: block.id, name: block.name, arguments: Object.keys(block.input || {}).length ? JSON.stringify(block.input) : '' };
          if (block?.type === 'text' && block.text) yield { type: 'text', text: block.text };
          if (block?.type === 'thinking' && block.thinking) yield { type: 'reasoning', text: block.thinking };
        }
        if (item.type === 'content_block_delta') { const delta = item.delta || {}; if (delta.type === 'text_delta') yield { type: 'text', text: delta.text }; if (delta.type === 'thinking_delta') yield { type: 'reasoning', text: delta.thinking }; if (delta.type === 'input_json_delta') yield { type: 'tool', index: item.index, arguments: delta.partial_json }; }
        if (item.usage || item.message?.usage) yield { type: 'usage', usage: item.usage || item.message.usage };
        if (item.type === 'message_stop') break;
      } else if (style === 'responses') {
        if (item.type === 'response.output_text.delta') yield { type: 'text', text: item.delta };
        if (item.type === 'response.reasoning_summary_text.delta' || item.type === 'response.reasoning_text.delta') yield { type: 'reasoning', text: item.delta };
        if (item.type === 'response.output_item.added' && item.item?.type === 'function_call') { const index = nextTool++; responseTools.set(item.item.id, index);if(item.item.call_id)responseTools.set(item.item.call_id,index); yield { type: 'tool', index, id: item.item.call_id || item.item.id, name: item.item.name, arguments: item.item.arguments || '' }; }
        if (item.type === 'response.function_call_arguments.delta') yield { type: 'tool', index: responseTools.get(item.item_id||item.call_id) ?? Math.max(0,nextTool-1), arguments: item.delta };
        if (item.type === 'response.failed' || item.type === 'response.incomplete') throw new Error(item.response?.error?.message || item.response?.incomplete_details?.reason || 'Provider response was incomplete');
        if (item.type === 'response.completed') { if (item.response?.usage) yield { type: 'usage', usage: item.response.usage }; break; }
      } else {
        const delta = item.choices?.[0]?.delta || item.choices?.[0]?.message || {};
        if (delta.content) yield { type: 'text', text: delta.content };
        if (delta.reasoning_content || delta.reasoning) yield { type: 'reasoning', text: delta.reasoning_content || delta.reasoning };
        for (const call of delta.tool_calls || []) { if (!Number.isInteger(call.index || 0) || call.index > 128) throw new Error('Invalid provider tool index'); yield { type: 'tool', index: call.index || 0, id: call.id, name: call.function?.name || call.name, arguments: typeof call.function?.arguments === 'object' ? JSON.stringify(call.function.arguments) : call.function?.arguments || call.arguments }; }
        if (item.usage) yield { type: 'usage', usage: item.usage };
        if (item.progress || item.prompt_progress) yield { type: 'progress', data: item.progress || item.prompt_progress };
      }
    }
    yield { type: 'done' };
  }
  async title(provider: Provider, model: string, message: string): Promise<string> {
    let text = '';
    const system=await promptText('title.system'),user=await promptText('title.user',{snippet:message.slice(0,12_000)});
    for await (const part of this.complete(provider, { model, stream:false,messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 100 }, AbortSignal.timeout(25_000))) if (part.type === 'text') text += part.text;
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 160) || 'New conversation';
  }
}

export async function probeProvider(provider: Provider) { return new Providers({ getProviders: () => [provider] }).probe(provider, true); }
