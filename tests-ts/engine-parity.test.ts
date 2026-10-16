import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Providers, anthropicPayload, responsesPayload, parseSSE } from '../server/providers.js';
import type { Provider } from '../server/config.js';
import { thinkingCapability, visionCapability, applyThinkingControl } from '../server/tools/capabilities.js';
import { BrowserManager, findBrowserExecutable } from '../server/tools/browser.js';
import { extractAttachment } from '../server/attachments.js';
import { Workspace, executeFilesystem } from '../server/tools/filesystem.js';
import { localCodexModels, importCodexCliSecret,refreshCodexSecret,prepareCodex,clearSubscriptionCache,CODEX_CLIENT_ID } from '../server/subscription.js';
import { Diagnostics, DiagnosticTrace, diagnosticContext } from '../server/diagnostics.js';
import { PageCache,searchWeb,type SearchSettings } from '../server/tools/web.js';
import { executeTool,normalizeQuestions,type ToolContext } from '../server/tools/index.js';

const provider: Provider = { id: 'fixture', name: 'Fixture', base: '', token: '', api_style: 'openai', kind: 'custom', allow_insecure_tls: false };
async function temporary<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'gopher-parity-'));
  try { return await fn(directory); } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

test('catalog capabilities follow advertised metadata instead of guessing from model names', () => {
  assert.equal(thinkingCapability({ id: 'gpt-5-reasoner' }).thinking_supported, false);
  assert.equal(visionCapability({ id: 'vision-model' }), undefined);
  const structured = thinkingCapability({ reasoning: { supported_efforts: ['none', 'low', 'high', 'xhigh', 'high'], mandatory: false } });
  assert.deepEqual(structured.thinking_efforts, ['low', 'high', 'xhigh']);
  assert.equal(structured.thinking_control, 'reasoning');
  assert.equal(structured.thinking_can_disable, true);
  const nested = thinkingCapability({ capabilities: { reasoning: { allowed_options: ['none', 'minimal', 'high'] } } });
  assert.equal(nested.thinking_control, 'reasoning_effort');
  const request: any = { thinking_effort: 'xhigh' };
  applyThinkingControl(request, { ...structured, reasoning_summary: 'detailed', reasoning_context: 'all_turns' });
  assert.deepEqual(request.reasoning, { effort: 'xhigh', summary: 'detailed', context: 'all_turns' });
  const disabled: any = { thinking_effort: 'off', chat_template_kwargs: { preserve_reasoning: true } };
  applyThinkingControl(disabled, { thinking_control: 'chat_template', thinking_can_disable: true });
  assert.deepEqual(disabled.chat_template_kwargs, { preserve_reasoning: true, enable_thinking: false });
  const unsupported: any = { thinking_effort: 'max' };
  applyThinkingControl(unsupported, structured);
  assert.deepEqual(unsupported, {});
  assert.equal(visionCapability({ capabilities: { vision: false }, input_modalities: ['image'] }), false);
  assert.equal(visionCapability({ architecture: { modality: 'text+image->text' } }), true);
});

test('local llama, Ollama and LM Studio catalogs enrich reasoning, images and runtime context', async () => {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    seen.push(req.url || '');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'local/model', owned_by: 'llamacpp' }] }));
    if (req.url === '/props') return res.end(JSON.stringify({ chat_template: '{% if enable_thinking %} <think> {% endif %} {{ reasoning_effort }}', default_generation_settings: { n_ctx: 16384 } }));
    if (req.url === '/api/v1/models') return res.end(JSON.stringify({ models: [{ key: 'model', capabilities: { vision: true }, context_window: 32768 }] }));
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'local/model' }] }));
    if (req.url === '/api/show') { let raw = ''; for await (const chunk of req) raw += chunk; assert.equal(JSON.parse(raw).model, 'local/model'); return res.end(JSON.stringify({ capabilities: ['thinking', 'vision'] })); }
    res.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const p = { ...provider, base: `http://127.0.0.1:${(server.address() as any).port}/v1` };
    const catalog = await new Providers({ getProviders: () => [p] }).catalog();
    assert.equal(catalog[0].context_length, 16384, 'runtime n_ctx wins over training/native context');
    assert.equal(catalog[0].attachments_supported, true);
    assert.equal(catalog[0].thinking_control, 'chat_template');
    assert.deepEqual(catalog[0].thinking_efforts, ['low', 'medium', 'high']);
    assert.equal(catalog[0].thinking_can_disable, true);
    assert.equal(catalog[0].prompt_progress_supported, true);
    assert.ok(seen.includes('/api/show'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Anthropic and Responses conversion preserve their protocol-specific controls', () => {
  const messages = [{ role: 'system', content: 'Stable policy' }, { role: 'system', content: 'Current clock' }, { role: 'assistant', content: 'Earlier reply' }];
  const anthropic = anthropicPayload({ model: 'claude-fixture', messages, reasoning_effort: 'high', max_tokens: 16000, tools: [{ function: { name: 'read_file', parameters: { type: 'object' } } }], tool_choice: 'none' }, 'https://api.anthropic.com/v1');
  assert.equal(anthropic.messages[0].role, 'user');
  assert.equal(anthropic.thinking.budget_tokens, 10000);
  assert.deepEqual(anthropic.cache_control, { type: 'ephemeral' });
  assert.deepEqual(anthropic.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(anthropic.system[1].cache_control, undefined);
  assert.deepEqual(anthropic.tools[0].cache_control, { type: 'ephemeral' });
  assert.equal(anthropic.tool_choice.type, 'none');
  const custom = anthropicPayload({ model: 'claude-fixture', messages }, 'http://127.0.0.1/v1');
  assert.equal(custom.cache_control, undefined);
  assert.equal(typeof custom.system, 'string');
  const responses = responsesPayload({ model: 'fixture', messages: [{ role: 'user', content: 'Hello' }], max_output_tokens: 512, parallel_tool_calls: false, tools: [{ function: { name: 'read_file', strict: true } }], reasoning: { effort: 'none' } });
  assert.equal(responses.instructions, undefined);
  assert.equal(responses.store, undefined);
  assert.equal(responses.max_output_tokens, 512);
  assert.equal(responses.parallel_tool_calls, false);
  assert.equal(responses.tools[0].strict, true);
  assert.deepEqual(responses.reasoning, { effort: 'none' });
  const codex = responsesPayload({ model: 'fixture', messages: [], max_tokens: 256 }, true);
  assert.equal(codex.instructions, 'You are a helpful assistant.');
  assert.equal(codex.store, false);
  assert.equal(codex.max_output_tokens, undefined);
});

test('SSE idle timeouts release stalled readers and protocol completion stops before socket closure', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"hello":true}\n\n')); }, cancel() { cancelled = true; } }));
  const iterator = parseSSE(response, 25);
  assert.equal((await iterator.next()).value?.data, '{"hello":true}');
  await assert.rejects(iterator.next(), /stalled/);
  assert.equal(cancelled, true);
  let closed = false;
  const completed = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); }, cancel() { closed = true; } }));
  for await (const _ of parseSSE(completed, 100)) { /* terminal event */ }
  assert.equal(closed, true);
});

test('file replacement treats CRLF and LF context as equivalent without rewriting unrelated bytes', async () => temporary(async directory => {
  const ws = await Workspace.open(directory);
  const original = 'first\r\nunique old\r\nvalue\r\nlast\nkeep mixed ending\r\n';
  await fs.writeFile(path.join(directory, 'mixed.txt'), original);
  await executeFilesystem(ws, 'str_replace', { path: 'mixed.txt', old_string: 'unique old\nvalue', new_string: 'new\nreplacement' });
  assert.equal(await fs.readFile(path.join(directory, 'mixed.txt'), 'utf8'), 'first\r\nnew\r\nreplacement\r\nlast\nkeep mixed ending\r\n');
  await fs.writeFile(path.join(directory, 'unicode.txt'), '你好');
  await assert.rejects(executeFilesystem(ws, 'read_file', { path: 'unicode.txt', byte_offset: 1 }), /UTF-8 character/);
  await fs.writeFile(path.join(directory, 'bad.txt'), Buffer.from([255, 254, 0]));
  await assert.rejects(executeFilesystem(ws, 'str_replace', { path: 'bad.txt', old_string: 'x', new_string: 'y' }), /valid UTF-8/);
}));

function pdfFixture(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let source = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(source); source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source);
}

test('PDF attachments extract real document text and image extraction preserves the OCR contract', async () => {
  const pdf = await extractAttachment({ filename: 'fixture.pdf', mime: 'application/pdf', content_base64: pdfFixture('Actual PDF extraction verified').toString('base64') });
  assert.equal(pdf.kind, 'pdf'); assert.match(pdf.text, /Actual PDF extraction verified/);
  await assert.rejects(extractAttachment({ filename: 'broken.pdf', content_base64: Buffer.from('invalid pdf').toString('base64') }));
  await assert.rejects(extractAttachment({ filename: 'photo.png', mime: 'image/png', content_base64: 'iVBORw0KGgo=' }), /Enable OCR for images/);
});

test('Codex import and cached models honor CODEX_HOME and preserve declared reasoning options', async () => temporary(async directory => {
  const original = process.env.CODEX_HOME; process.env.CODEX_HOME = directory;
  try {
    await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({ tokens: { access_token: 'access', refresh_token: 'refresh' } }));
    assert.equal(JSON.parse(await importCodexCliSecret()).refresh_token, 'refresh');
    await fs.writeFile(path.join(directory, 'config.toml'), 'model = "preferred"\n');
    await fs.writeFile(path.join(directory, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'hidden', visibility: 'hide' }, { slug: 'preferred', priority: 4, supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }], use_responses_lite: true }, { slug: 'other', priority: 1 }] }));
    const models = await localCodexModels(); assert.deepEqual(models.map(model => model.model), ['preferred', 'other']);
    assert.deepEqual(models[0].thinking_efforts, ['high']); assert.equal(models[0].thinking_can_disable, true); assert.equal(models[0].reasoning_context, 'all_turns');
    await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({ access_token: 'api-key-only' }));
    await assert.rejects(importCodexCliSecret(), /ChatGPT session/);
  } finally { if (original === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = original; }
}));

test('Codex refresh deduplicates requests, rotates credentials and retires rejected refresh tokens',async()=>{
  const original=globalThis.fetch;let calls=0;let reject=false;clearSubscriptionCache();
  globalThis.fetch=async(input,init)=>{calls++;assert.equal(String(input),'https://auth.openai.com/oauth/token');assert.equal(init?.redirect,'error');const form=new URLSearchParams(String(init?.body));assert.equal(form.get('client_id'),CODEX_CLIENT_ID);assert.equal(form.get('grant_type'),'refresh_token');return new Response(JSON.stringify(reject?{error:'invalid_grant'}:{access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:3600}),{status:reject?401:200,headers:{'content-type':'application/json'}});};
  try{const secret=JSON.stringify({access_token:'expired',refresh_token:'refresh',expires_at:1});const[first,second]=await Promise.all([refreshCodexSecret(secret),refreshCodexSecret(secret)]);assert.equal(calls,1);assert.equal(first.secret_json,second.secret_json);assert.equal(JSON.parse(first.secret_json).refresh_token,'rotated-refresh');assert.equal((await prepareCodex(first.secret_json)).token,'rotated-access');clearSubscriptionCache();reject=true;const retired=await refreshCodexSecret(secret);assert.equal(JSON.parse(retired.secret_json).refresh_dead,true);await assert.rejects(prepareCodex(retired.secret_json),/Sign in/);const missing=await refreshCodexSecret(JSON.stringify({access_token:'expired',refresh_token:'',expires_at:1}));assert.equal(JSON.parse(missing.secret_json).refresh_dead,true);}finally{globalThis.fetch=original;clearSubscriptionCache();}
});

test('Codex refresh preserves the live credential when persistence fails',async()=>{
  const originalFetch=globalThis.fetch;clearSubscriptionCache();const originalToken=JSON.stringify({access_token:'expired',refresh_token:'original-refresh',expires_at:1});const p:Provider={...provider,kind:'openai-codex',api_style:'responses',base:'https://chatgpt.com/backend-api/codex',token:originalToken};let saved:Provider|undefined;
  globalThis.fetch=async(input)=>{assert.equal(String(input),'https://auth.openai.com/oauth/token');return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}),{headers:{'content-type':'application/json'}});};
  try{const providers=new Providers({getProviders:()=>[p],saveProvider:async updated=>{saved=updated;assert.notEqual(updated,p);assert.equal(p.token,originalToken);throw new Error('Simulated disk write failure');}});await assert.rejects(async()=>{for await(const _ of providers.complete(p,{model:'fixture',messages:[{role:'user',content:'hello'}]},AbortSignal.timeout(3000))){}},/disk write failure/);assert.equal(p.token,originalToken);assert.equal(JSON.parse(saved!.token).refresh_token,'new-refresh');}finally{globalThis.fetch=originalFetch;clearSubscriptionCache();}
});

test('web page cache deduplicates parallel reads and paginates cached Unicode without redownloading',async()=>{
  const cache=new PageCache();let downloads=0;const page={url:'https://cached.invalid/article',title:'Cached',contentType:'text/plain',text:'你🙂'.repeat(1000),truncated:false};const loader=async()=>{downloads++;await new Promise(resolve=>setTimeout(resolve,10));return page;};
  await Promise.all([cache.read(`${page.url}#first`,loader),cache.read(`${page.url}#second`,loader)]);assert.equal(downloads,1);
  const context:ToolContext={id:'cache',skills:{fetch_url:true},userSkills:[],history:new Map(),pages:cache,signal:new AbortController().signal,clarify:async()=>({})};const result=JSON.parse((await executeTool(context,{id:'fetch',name:'fetch_url',arguments:{url:page.url,offset:1000,max_chars:1000}})).text);assert.equal(Array.from(result.text).length,1000);assert.equal(result.text.startsWith('你🙂'),true);assert.equal(result.next_offset,null);assert.equal(downloads,1);
  let failures=0;await assert.rejects(cache.read('https://cached.invalid/fail',async()=>{failures++;throw new Error('offline');}));await cache.read('https://cached.invalid/fail',async()=>{failures++;return page;});assert.equal(failures,2);
});

test('clarification aliases normalize into the exact UI schema and retrieval cursors use original message indices',async()=>{
  const normalized=normalizeQuestions({questions:{title:'Very long scope title',prompt:'Which audience?',choices:['Experts',{text:'General',detail:'Broad readership'}],multi_select:true}});assert.equal(normalized[0].header,'Very long sc');assert.equal(normalized[0].question,'Which audience?');assert.equal(normalized[0].multiSelect,true);assert.deepEqual(normalized[0].options,[{label:'Experts',description:''},{label:'General',description:'Broad readership'}]);
  const store={conversations:[{id:'current'},{id:'older',messages:[{role:'system',content:'hidden policy'},{role:'assistant',content:'<think>private</think>'},{role:'user',content:'你🙂'.repeat(2000)},{role:'assistant',content:'Final visible answer'}]}]};const context:ToolContext={id:'current',conversationId:'current',profileId:null,skills:{chat_retrieval:true},userSkills:[],history:new Map(),signal:new AbortController().signal,getStore:async()=>store,clarify:async()=>({})};
  let cursor=0,offset=0,text='',last:any;for(let i=0;i<10;i++){last=JSON.parse((await executeTool(context,{id:'read',name:'read_chat',arguments:{chat_id:'older',cursor,char_offset:offset,limit:1}})).text);const result=last.results[0];if(result.message_index===3){assert.equal(result.content,'Final visible answer');break;}assert.equal(result.message_index,2);text+=result.content;cursor=last.next_cursor;offset=last.next_char_offset||0;}
  assert.equal(text,'你🙂'.repeat(2000));assert.equal(last.results[0].message_index,3);
});

test('self-hosted SearXNG supports JSON-disabled instances without sending API credentials',async()=>{
  const queries:URL[]=[];const server=createServer((req,res)=>{const url=new URL(req.url||'/','http://localhost');queries.push(url);assert.equal(req.headers.authorization,undefined);if(url.searchParams.get('format')==='json')return res.writeHead(403).end('JSON disabled');res.setHeader('content-type','text/html');res.end('<h3><a href="https://example.com/source">Original source</a></h3>');});server.listen(0,'127.0.0.1');await once(server,'listening');
  try{const settings:SearchSettings={searchProvider:'searxng',searchDepth:'fast',searchResultCount:5,searchRegion:'us-en',searchSafeSearch:'strict',searchRecency:'week',searxngUrl:`127.0.0.1:${(server.address()as any).port}`,parallelMode:'fast'};const result=await searchWeb('specific query',settings,AbortSignal.timeout(3000));assert.equal(result.results[0].url,'https://example.com/source');assert.equal(queries.length,2);assert.equal(queries[0].searchParams.get('language'),'en-US');assert.equal(queries[0].searchParams.get('safesearch'),'2');assert.equal(queries[0].searchParams.get('time_range'),'week');}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('provider diagnostics record timing and raw streams with credential redaction',async()=>{
  const server=createServer((_req,res)=>{res.setHeader('content-type','text/event-stream');res.end('data: {"choices":[{"delta":{"content":"Visible answer"}}]}\n\ndata: [DONE]\n\n');});server.listen(0,'127.0.0.1');await once(server,'listening');const hub=new Diagnostics();hub.configure(true);
  try{const p={...provider,base:`http://127.0.0.1:${(server.address()as any).port}/v1`,token:'private-api-token'};await diagnosticContext.run(new DiagnosticTrace(hub,'trace-chat'),async()=>{for await(const _ of new Providers({getProviders:()=>[p]}).complete(p,{model:'fixture',messages:[{role:'user',content:'Hello'}]},AbortSignal.timeout(3000))){}});const entries=hub.view().entries;for(const name of['provider.request','provider.headers','provider.first_byte','provider.raw_chunk'])assert.ok(entries.some(entry=>entry.event===name),name);assert.equal(JSON.stringify(entries).includes('private-api-token'),false);assert.ok(entries.every(entry=>entry.conversation_id==='trace-chat'));}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('actual browser tools navigate, click, fill, submit, select, evaluate and capture screenshots', { timeout: 60_000 }, async context => {
  const executable = await findBrowserExecutable(); if (!executable) { context.skip('No supported Chromium browser installed'); return; }
  await temporary(async directory => {
    const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Browser fixture</title><h1>Counter <span id="count">0</span></h1><button onclick="count.textContent=Number(count.textContent)+1">Increment</button><form onsubmit="event.preventDefault();document.querySelector(\'#status\').textContent=\'Hello \'+document.querySelector(\'#name\').value"><input id="name" aria-label="Name"><button>Submit</button></form><select aria-label="Choice" id="choice"><option value="a">First</option><option value="b">Second</option></select><p id="status">Ready</p>'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = new BrowserManager();
    try {
      const url = `http://127.0.0.1:${(server.address() as any).port}`;
      let snapshot = JSON.parse((await browser.execute('fixture', directory, 'browser_navigate', { url })).text);
      assert.match(snapshot.text, /Counter 0/);
      snapshot = JSON.parse((await browser.execute('fixture', directory, 'browser_click', { ref: snapshot.elements.find((element: any) => element.name === 'Increment').ref })).text);
      assert.match(snapshot.text, /Counter 1/);
      snapshot = JSON.parse((await browser.execute('fixture', directory, 'browser_type', { ref: snapshot.elements.find((element: any) => element.name === 'Name').ref, text: 'Ada', submit: true })).text);
      assert.match(snapshot.text, /Hello Ada/);
      await browser.execute('fixture', directory, 'browser_select', { ref: snapshot.elements.find((element: any) => element.name === 'Choice').ref, value: 'b' });
      const evaluated = JSON.parse((await browser.execute('fixture', directory, 'browser_evaluate', { expression: 'document.querySelector("#choice").value' })).text);
      assert.equal(evaluated.result, 'b');
      await browser.execute('fixture', directory, 'browser_wait', { selector: '#status', time_ms: 500 });
      await browser.execute('fixture', directory, 'browser_press', { key: 'Tab' });
      const screenshot = await browser.execute('fixture', directory, 'browser_screenshot', { path: 'captures/browser.png' });
      assert.match(screenshot.image!, /^data:image\/png;base64,/);
      assert.equal((await fs.readFile(path.join(directory, 'captures/browser.png'))).subarray(1, 4).toString(), 'PNG');
      const isolated = JSON.parse((await browser.execute('other', directory, 'browser_snapshot', {})).text);
      assert.equal(isolated.url, 'about:blank');
      await browser.execute('fixture', directory, 'browser_close', {});
    } finally { await browser.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
