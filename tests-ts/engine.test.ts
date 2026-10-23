import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { Engine, TextRouter, compactMessages, estimateTokens, messageBudget, contextWindow, scheduleToolBatches } from '../server/engine.js';
import { Providers, parseSSE, anthropicPayload, responsesPayload, normalizeBase, providerAuthHeaders, type CompletionPayload, type ProviderEvent } from '../server/providers.js';
import { Workspace, executeFilesystem, applyPatch } from '../server/tools/filesystem.js';
import { executeTool, retrievalScope, visibleText, type ToolContext } from '../server/tools/index.js';
import { TerminalManager } from '../server/terminal.js';
import { extractAttachment } from '../server/attachments.js';
import type { Provider } from '../server/config.js';
import { BoundedOutput } from '../server/tools/output.js';
import { ResearchProgress } from '../server/tools/research.js';

/** Read a nested value from untyped JSON in assertions. */
const dig = (value: unknown, ...path: Array<string | number>): unknown => path.reduce<unknown>((current, key) => (current as Record<string | number, unknown> | undefined)?.[key], value);


const provider:Provider={id:'test',name:'Test',base:'http://127.0.0.1:1234/v1',token:'',api_style:'openai',kind:'custom',allow_insecure_tls:false};
async function temporary<T>(fn:(directory:string)=>Promise<T>):Promise<T>{const directory=await fs.mkdtemp(path.join(tmpdir(),'gopher-engine-'));try{return await fn(directory);}finally{await fs.rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:50});}}
function mockProviders(handler:(payload:any,signal:AbortSignal)=>AsyncIterable<ProviderEvent>):Providers{return{get:()=>provider,catalog:async()=>[],complete:(_provider:any,payload:any,signal:AbortSignal)=>handler(payload,signal)}as unknown as Providers;}
async function collect(stream:AsyncIterable<string>,onFrame?:(frame:string)=>void):Promise<string>{let output='';for await(const frame of stream){output+=frame;onFrame?.(frame);}return output;}
async function serve<T>(listener:RequestListener,fn:(base:string)=>Promise<T>):Promise<T>{const server=createServer(listener);server.listen(0,'127.0.0.1');await once(server,'listening');try{return await fn(`http://127.0.0.1:${(server.address() as any).port}/v1`);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}}

test('provider URLs preserve local HTTP, upgrade public hosts and reject credential-bearing URL components',()=>{
  const cases=[['localhost:11434','http://localhost:11434/v1'],['https://example.com/api/','https://example.com/api/v1'],['api.example.com/v1','https://api.example.com/v1'],['http://api.example.com/v1','https://api.example.com/v1'],['10.0.0.8:11434','http://10.0.0.8:11434/v1'],['http://host.local/api','http://host.local/api/v1'],['http://[::1]:11434','http://[::1]:11434/v1'],['http://[fc00::1]:8000','http://[fc00::1]:8000/v1'],['http://[::ffff:127.0.0.1]/v1','http://[::ffff:7f00:1]/v1'],['http://[2606:4700:4700::1111]/v1','https://[2606:4700:4700::1111]/v1']];
  for(const[input,expected]of cases)for(const style of['openai','anthropic','responses'])assert.equal(normalizeBase(input,style),expected);
  for(const input of['','file:///tmp/provider','https://user:secret@example.com','https://example.com/v1?token=secret','https://example.com/v1#fragment','https://example.com/v1?','not a host'])assert.throws(()=>normalizeBase(input));
});

test('Cloudflare Access service credentials reach probes, chats and titles as dedicated headers',async()=>{
  for(const style of['openai','anthropic','responses']as const){
    const access=providerAuthHeaders(style,' cf-access: client.access : secret:with:colons ');assert.equal(access['CF-Access-Client-Id'],'client.access');assert.equal(access['CF-Access-Client-Secret'],'secret:with:colons');assert.equal(access.authorization,undefined);assert.equal(access['x-api-key'],undefined);assert.equal(access['anthropic-version'],style==='anthropic'?'2023-06-01':undefined);
    const requests:string[]=[];await serve(async(req,res)=>{requests.push(`${req.method} ${req.url}`);assert.equal(req.headers['cf-access-client-id'],'client.access');assert.equal(req.headers['cf-access-client-secret'],'secret:with:colons');assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-api-key'],undefined);if(style==='anthropic')assert.equal(req.headers['anthropic-version'],'2023-06-01');if(req.method==='GET'){res.setHeader('content-type','application/json');res.end('{"data":[{"id":"model"}]}');return;}for await(const _chunk of req){}res.setHeader('content-type','application/json');res.end(JSON.stringify(style==='anthropic'?{content:[{type:'text',text:'Title'}]}:style==='responses'?{output:[{content:[{type:'output_text',text:'Title'}]}]}:{choices:[{message:{content:'Title'}}]}));},async base=>{const p={...provider,base:base.replace(/^http:\/\//,''),api_style:style,token:'cf-access:client.access:secret:with:colons'};const providers=new Providers({getProviders:()=>[p]});assert.equal((await providers.catalog())[0].model,'model');const events=[];for await(const event of providers.complete(p,{model:'model',messages:[{role:'user',content:'Hello'}]},AbortSignal.timeout(3000)))events.push(event);assert.equal(events.find(event=>event.type==='text')?.text,'Title');assert.equal(await providers.title(p,'model','Hello'),'Title');});assert.equal(requests.length,style==='openai'?6:3);
  }
  assert.deepEqual(providerAuthHeaders('openai',' api-key '),{authorization:'Bearer api-key'});assert.deepEqual(providerAuthHeaders('anthropic',' api-key '),{'anthropic-version':'2023-06-01','x-api-key':'api-key'});
});

test('stream parser preserves split UTF-8, multiline data, and an unterminated final frame',async()=>{
  const bytes=Buffer.from('event: hello\r\ndata: {"text":"你好"}\r\n\r\ndata: first\ndata: second\n\ndata: [DONE]');
  const response=new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.subarray(i,i+3));controller.close();}}));
  const frames=[];for await(const frame of parseSSE(response))frames.push(frame);
  assert.deepEqual(frames,[{event:'hello',data:'{"text":"你好"}'},{event:'message',data:'first\nsecond'},{event:'message',data:'[DONE]'}]);
});

test('providers translate OpenAI, Anthropic and Responses requests and streaming tools',async()=>{
  for(const style of ['openai','anthropic','responses']as const)await serve(async(req,res)=>{
    if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'model',context_length:32768}]}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);assert.equal(payload.model,'model');assert.equal(payload.stream,true);
    res.writeHead(200,{'content-type':'text/event-stream'});
    const frames=style==='openai'?[{choices:[{delta:{reasoning_content:'plan'}}]},{choices:[{delta:{content:'Answer 你好'}}]},{choices:[{delta:{tool_calls:[{index:0,id:'call1',function:{name:'read_file',arguments:'{"path":"a.txt"}'}}]}}]}]:style==='anthropic'?[{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'plan'}},{type:'content_block_delta',delta:{type:'text_delta',text:'Answer 你好'}},{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'call1',name:'read_file',input:{}}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"path":"a.txt"}'}},{type:'message_stop'}]:[{type:'response.reasoning_summary_text.delta',delta:'plan'},{type:'response.output_text.delta',delta:'Answer 你好'},{type:'response.output_item.added',item:{type:'function_call',id:'item1',call_id:'call1',name:'read_file'}},{type:'response.function_call_arguments.delta',item_id:'item1',delta:'{"path":"a.txt"}'},{type:'response.completed',response:{usage:{input_tokens:5,output_tokens:7}}}];
    for(const frame of frames)res.write(`data: ${JSON.stringify(frame)}\n\n`);res.end('data: [DONE]\n\n');
  },async base=>{
    const p={...provider,base,api_style:style};const providers=new Providers({getProviders:()=>[p]});const models=await providers.catalog();assert.equal(models[0].ready,true);assert.equal(models[0].context_length,32768);const events=[];for await(const event of providers.complete(p,{model:'model',messages:[{role:'user',content:'Hello'}]},AbortSignal.timeout(3000)))events.push(event);assert.equal(events.find(event=>event.type==='text')?.text,'Answer 你好');assert.equal(events.find(event=>event.type==='reasoning')?.text,'plan');assert.equal(events.filter(event=>event.type==='tool').map(event=>event.arguments||'').join(''),'{"path":"a.txt"}');
  });
});

test('provider translation preserves tools, system instructions and image inputs',()=>{
  const payload:CompletionPayload={model:'model',messages:[{role:'system',content:'Policy'},{role:'user',content:[{type:'text',text:'See this'},{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]},{role:'assistant',content:null,tool_calls:[{id:'call',function:{name:'read_file',arguments:'{"path":"a"}'}}]},{role:'tool',tool_call_id:'call',content:'file'}],tools:[{type:'function',function:{name:'read_file',description:'Read',parameters:{type:'object',properties:{}}}}]};
  const anthropic=anthropicPayload(payload);assert.equal(dig(anthropic, 'system'),'Policy');assert.equal(dig(anthropic, 'messages', 0, 'content', 1, 'source', 'type'),'base64');assert.equal(dig(anthropic, 'messages', 2, 'content', 0, 'tool_use_id'),'call');
  const responses=responsesPayload(payload);assert.equal(dig(responses, 'instructions'),'Policy');assert.equal(dig(responses, 'input', 1, 'type'),'function_call');assert.equal(dig(responses, 'input', 2, 'call_id'),'call');
});

test('workspace filesystem pagination, exact replacement, atomic patch and confinement',async()=>temporary(async directory=>{
  const ws=await Workspace.open(directory);await executeFilesystem(ws,'write_file',{path:'a.txt',content:'alpha\nbeta\n你好\n'});
  const page=JSON.parse(await executeFilesystem(ws,'read_file',{path:'a.txt',offset:1,limit:1}));assert.equal(page.content,'beta\n');assert.equal(page.next_byte_offset,11);
  await assert.rejects(ws.resolve('../escape.txt'),/outside/);
  await assert.rejects(executeFilesystem(ws,'write_file',{path:'a.txt',content:'oops'}),/already exists/);
  await executeFilesystem(ws,'str_replace',{path:'a.txt',old_string:'beta',new_string:'gamma'});
  await applyPatch(ws,'*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n-gamma\n+delta\n 你好\n*** Add File: folder/new.md\n+created\n*** End Patch');
  assert.equal(await fs.readFile(path.join(directory,'a.txt'),'utf8'),'alpha\ndelta\n你好\n');
  await assert.rejects(applyPatch(ws,'*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+should not commit\n*** Update File: absent.txt\n@@\n-no\n+yes\n*** End Patch'),/does not exist/);
  assert.equal((await fs.readFile(path.join(directory,'a.txt'),'utf8')).split('\n')[0],'alpha');
  const matches=JSON.parse(await executeFilesystem(ws,'glob',{pattern:'*.md'}));assert.deepEqual(matches.matches,['folder/new.md']);
  const grep=JSON.parse(await executeFilesystem(ws,'grep',{query:'delta'}));assert.equal(grep.results[0].line,2);
}));

test('read_file resumes multibyte UTF-8 without corrupting characters',async()=>temporary(async directory=>{
  const ws=await Workspace.open(directory);const text='你'.repeat(1500);await fs.writeFile(path.join(directory,'text.txt'),text);let offset=0,combined='';
  while(true){const page=JSON.parse(await executeFilesystem(ws,'read_file',{path:'text.txt',byte_offset:offset,max_bytes:256,limit:2000}));assert.equal(page.content.includes('�'),false);combined+=page.content;if(page.next_byte_offset===null)break;offset=page.next_byte_offset;}
  assert.equal(combined,text);
}));

test('chat retrieval remains within project/profile and excludes hidden reasoning',async()=>{
  let active='profile';let enabled=true;const store={profiles:[{id:'profile',conversations:[{id:'current',projectId:'p'},{id:'allowed',projectId:'p',title:'Notes',messages:[{role:'assistant',content:'<think>secret</think>Visible answer'}]},{id:'private',projectId:'p',incognito:true},{id:'elsewhere',projectId:'q',messages:[]}]}],get activeProfileId(){return active;}};
  const context={id:'current',conversationId:'current',skills:{chat_retrieval:true},profileId:'profile',userSkills:[],signal:new AbortController().signal,history:new Map(),getStore:async()=>store,getPreferences:async()=>({chatRetrieval:enabled}),clarify:async()=>({})}as ToolContext;
  assert.deepEqual((await retrievalScope(context))?.chats.map(chat=>chat.id),['allowed']);assert.equal(visibleText({role:'assistant',content:'Before<think>hidden'}),'Before');
  const read=await executeTool(context,{id:'tool',name:'read_chat',arguments:{chat_id:'allowed'}});assert.match(read.text,/Visible answer/);assert.doesNotMatch(read.text,/secret/);
  await assert.rejects(executeTool(context,{id:'tool',name:'read_chat',arguments:{chat_id:'elsewhere'}}),/scope/);active='other';assert.equal(await retrievalScope(context),null);active='profile';enabled=false;assert.equal(await retrievalScope(context),null);
});

test('engine completes approved filesystem tools, steers between rounds, and replays detached turns',async()=>temporary(async directory=>{
  let round=0;let sawSteer=false;const providers=mockProviders(async function*(payload){round++;if(round===1){yield{type:'tool',index:0,id:'wire1',name:'write_file',arguments:'{"path":"result.txt","content":"done"}'};}else{sawSteer=payload.messages.some((message:any)=>message.content==='[USER STEER]\nBe concise');assert.equal(payload.messages.find((message:any)=>message.role==='tool').tool_call_id,'wire1');yield{type:'text',text:'Completed'};}});
  const engine=new Engine({providers});const stream=engine.start({model:'model',conversation_id:'chat',agent:true,skills:{filesystem:true,workspace_root:directory,approval_mode:'auto_safe'},messages:[{role:'user',content:'Write a file'}]});
  let steer='';const text=await collect(stream,frame=>{if(!frame.startsWith('event: agent'))return;const event=JSON.parse(frame.split('data: ')[1]);if(event.phase==='steer_ready')steer=event.id;if(event.phase==='tool_approval'){engine.steer(steer,'Be concise','client');assert.equal(engine.approve(event.id,true),true);assert.equal(engine.approve(event.id,true),false);}});
  assert.equal(await fs.readFile(path.join(directory,'result.txt'),'utf8'),'done');assert.equal(sawSteer,true);assert.match(text,/Completed/);assert.match(text,/tool_result/);assert.match(text,/\[DONE\]/);const replay=await collect(engine.live('chat')!);assert.match(replay,/Completed/);assert.match(replay,/"finished":true/);await engine.cancelAll();
}));

test('engine denies unapproved tools and prevents duplicate turns',async()=>temporary(async directory=>{
  let round=0;const providers=mockProviders(async function*(){if(round++===0)yield{type:'tool',index:0,id:'wire',name:'write_file',arguments:'{"path":"denied.txt","content":"no"}'};else yield{type:'text',text:'Denied'};});const engine=new Engine({providers});const stream=engine.start({model:'model',conversation_id:'dup',agent:true,skills:{filesystem:true,workspace_root:directory},messages:[{role:'user',content:'write'}]});assert.throws(()=>engine.start({model:'model',conversation_id:'dup',messages:[{role:'user',content:'again'}]}),/already in progress/);
  const output=await collect(stream,frame=>{if(frame.includes('"phase":"tool_approval"'))engine.approve(JSON.parse(frame.split('data: ')[1]).id,false);});assert.match(output,/user denied this tool call/);assert.match(output,/do not bypass this decision/);await assert.rejects(fs.access(path.join(directory,'denied.txt')));await engine.cancelAll();
}));

test('engine cancellation releases pending clarification and finishes live subscribers',async()=>{
  const engine=new Engine({providers:mockProviders(async function*(){yield{type:'tool',index:0,id:'ask',name:'ask_user',arguments:JSON.stringify({questions:[{question:'Audience?',options:[{label:'Experts'},{label:'General'}]}]})};})});
  const output=await collect(engine.start({model:'model',conversation_id:'research',deep_research:true,messages:[{role:'user',content:'research'}]}),frame=>{if(frame.includes('"phase":"clarify"'))void engine.cancel('research');});assert.match(output,/"phase":"clarify"/);assert.match(output,/\[DONE\]/);assert.equal(engine.liveTurns().length,0);await engine.cancelAll();
});

test('cancel-before-start prevents a delayed turn from calling the model without blocking a newer turn',async()=>{
  let calls=0;const engine=new Engine({providers:mockProviders(async function*(){calls++;yield{type:'text',text:'New turn answered'};})});await engine.cancel('queued','old_turn');const stopped=await collect(engine.start({model:'model',conversation_id:'queued',turn_id:'old_turn',messages:[{role:'user',content:'Delayed old request'}]}));assert.match(stopped,/\[DONE\]/);assert.equal(calls,0);const fresh=await collect(engine.start({model:'model',conversation_id:'queued',turn_id:'new_turn',messages:[{role:'user',content:'New request'}]}));assert.match(fresh,/New turn answered/);assert.equal(calls,1);await engine.cancelAll();
});

test('context compaction archives complete tool exchanges without losing protected instructions',()=>{
  const history=new Map();const system={role:'system',content:'Policy'},user={role:'user',content:'Implement every requirement'};const messages:any[]=[system,user];
  for(let i=0;i<40;i++)messages.push({role:'assistant',tool_calls:[{id:`call_${i}`,function:{name:'read_file',arguments:'{"path":"file.txt"}'}}]},{role:'tool',tool_call_id:`call_${i}`,name:'read_file',content:`START_${i} ${'data'.repeat(2000)} END_${i}`});
  const result=compactMessages(messages,4096,history);assert.equal(result.compacted,true);assert.ok(estimateTokens(result.messages)<=messageBudget(4096));assert.deepEqual(result.messages[0],system);assert.deepEqual(result.messages[1],user);assert.match(history.get('history_1').text,/START_0/);assert.match(history.get('history_1').text,/END_0/);
  for(let i=0;i<result.messages.length;i++)if(result.messages[i].role==='tool')assert.equal(result.messages[i-1].tool_calls?.[0]?.id,result.messages[i].tool_call_id);
  assert.equal(messages.length,82,'provider compaction must not mutate the saved transcript');
});

test('context budgeting honors overrides and refuses to discard oversized user inputs',()=>{
  const before=process.env.GOPHER_AGENT_CONTEXT_TOKENS;delete process.env.GOPHER_AGENT_CONTEXT_TOKENS;
  try{assert.equal(contextWindow({},provider),8192);assert.equal(contextWindow({},{...provider,token:'secret'}),32768);process.env.GOPHER_AGENT_CONTEXT_TOKENS='12345';assert.equal(contextWindow({},provider,{context_length:99999}),12345);assert.equal(contextWindow({context_window_tokens:40000},provider),40000);assert.throws(()=>messageBudget(2048,[{description:'x'.repeat(10000)}]),/tool schemas/);const messages=[{role:'system',content:'Keep policy'},{role:'user',content:'requirement '.repeat(5000)}];const copy=structuredClone(messages);assert.throws(()=>compactMessages(messages,4096,new Map()),/instructions were not truncated/);assert.deepEqual(messages,copy);assert.ok(estimateTokens({type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(2_000_000)}})<3000);}finally{if(before===undefined)delete process.env.GOPHER_AGENT_CONTEXT_TOKENS;else process.env.GOPHER_AGENT_CONTEXT_TOKENS=before;}
});

test('tool scheduling batches eight independent reads and preserves mutation boundaries',()=>{
  const call=(name:string,index:number)=>({id:String(index),name,arguments:{}});const calls=[...Array.from({length:10},(_,i)=>call('read_file',i)),call('write_file',10),call('grep',11),call('web_search',12),call('run_terminal',13),call('fetch_url',14)];
  const groups=scheduleToolBatches(calls);assert.deepEqual(groups.map(group=>group.length),[8,2,1,2,1,1]);assert.deepEqual(groups.flat(),calls);
});

test('engine executes independent reads concurrently while mutations remain ordered',async()=>{
  let round=0,running=0,maxRunning=0;const log:string[]=[];
  const engine=new Engine({providers:mockProviders(async function*(){if(round++===0){for(const[index,name]of ['read_file','grep','write_file','read_file'].entries())yield{type:'tool',index,id:`wire_${index}`,name,arguments:JSON.stringify({path:`${index}.txt`,query:'x'})};}else yield{type:'text',text:'done'};}),executeTool:async(_context,call)=>{log.push(`start_${call.id}`);maxRunning=Math.max(maxRunning,++running);await new Promise(resolve=>setTimeout(resolve,25));running--;log.push(`end_${call.id}`);return{ok:true,text:'ok'};}});
  await collect(engine.start({model:'model',agent:true,skills:{filesystem:true,workspace_root:process.cwd(),approval_mode:'auto_safe'},messages:[{role:'user',content:'execute'}]}),frame=>{if(frame.includes('"phase":"tool_approval"'))engine.approve(JSON.parse(frame.split('data: ')[1]).id,true);});assert.equal(maxRunning,2);assert.equal(log.length,8);assert.equal(log[2].startsWith('end_'),true,'two reads must start before either finishes');assert.equal(log[4].startsWith('start_'),true);await engine.cancelAll();
});

test('research depth requires distinct searches, substantive page reads, and follow-up rounds',()=>{
  const progress=new ResearchProgress();const result=(name:string,value:string)=>({call:{id:value,name,arguments:name==='web_search'?{query:value}:{url:value}},outcome:{ok:true,text:JSON.stringify(name==='web_search'?{results:[{url:'https://example.com'}]}:{text:'Substantive page content'})}});
  progress.record(Array.from({length:6},(_,i)=>result('web_search',`angle ${i}`)));assert.equal(progress.ready(),false);assert.equal(progress.nextTool(),'fetch_url');progress.record(Array.from({length:4},(_,i)=>result('fetch_url',`https://example.com/${i}`)));assert.equal(progress.ready(),false);progress.record([result('web_search','counterargument')]);assert.equal(progress.ready(),true);for(let i=0;i<4;i++)progress.record([result('web_search','counterargument')]);assert.equal(progress.exhausted(),true);assert.match(progress.note(),/does NOT establish/);
});

test('bounded terminal output preserves the initial context, final errors and UTF-8',()=>{
  const output=new BoundedOutput(1024);output.push('START\n');for(let i=0;i<1000;i++)output.push('你好'.repeat(50));output.push('\nFINAL ERROR');const text=output.take();assert.match(text,/^START/);assert.match(text,/FINAL ERROR$/);assert.equal(text.includes('�'),false);assert.ok(Buffer.byteLength(text)<=1024);assert.equal(output.empty,true);const unicode=new BoundedOutput(32);const bytes=Buffer.from('你好🙂 exact');for(let i=0;i<bytes.length;i++)unicode.push(bytes.subarray(i,i+1));assert.equal(unicode.render(),'你好🙂 exact');
});

test('incremental reasoning router handles split tags without visible leakage',()=>{
  let text='',reasoning='';const router=new TextRouter((part,thinking)=>{if(thinking)reasoning+=part;else text+=part;});for(const part of ['<thi','nk>private','</think>Hi <tool_','call>{"secret":true}</tool_call> there'])router.push(part);router.push('',true);assert.equal(text,'Hi  there');assert.equal(reasoning,'private');
});

test('attachment extraction validates base64 and normalizes UTF-8 text',async()=>{
  const extracted=await extractAttachment({filename:'notes.md',content_base64:Buffer.from('hello\r\nworld  \r\n').toString('base64')});assert.equal(extracted.kind,'text');assert.equal(extracted.text,'hello\nworld');await assert.rejects(extractAttachment({filename:'a.md',content_base64:'!!!'}),/base64/);await assert.rejects(extractAttachment({filename:'binary.exe',content_base64:'YQ=='}),/Unsupported/);
});

test('terminal commands return resumable output and enforce conversation ownership',async()=>temporary(async directory=>{
  const manager=new TerminalManager();try{const result=await manager.command(directory,'owner',{command:'echo engine-test',yield_time_ms:1});await assert.rejects(manager.wait('other',{session_id:result.session_id}),/conversation/);let output=result.output;let next=result;for(let i=0;i<8&&next.running;i++){next=await manager.wait('owner',{session_id:result.session_id,yield_time_ms:1000});output+=next.output;}assert.match(output,/engine-test/);assert.equal(next.exit_code,0);}finally{manager.closeAll();}
}));

test('terminal running sessions expire after the idle lifetime and reject stale polls',async()=>temporary(async directory=>{
  const manager=new TerminalManager({idleLifetimeMs:100});try{const result=await manager.command(directory,'owner',{command:process.platform==='win32'?'Start-Sleep -Seconds 30':'sleep 30',yield_time_ms:0});assert.equal(result.running,true);await new Promise(resolve=>setTimeout(resolve,160));await assert.rejects(manager.wait('owner',{session_id:result.session_id}),/not found/);}finally{manager.closeAll();}
}));
