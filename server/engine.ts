import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Providers } from './providers.js';
import { terminals } from './terminal.js';
import { browsers } from './tools/browser.js';
import { skillsCatalog, type UserSkill } from './skills.js';
import { canonicalToolName, executeTool, needsApproval, retrievalScope, risk, toolDefinitions, type ToolCall, type ToolContext, type ToolOutcome } from './tools/index.js';
import { agentPrompt, applyToolDescriptions } from './tools/prompts.js';
import { ResearchProgress } from './tools/research.js';
import { record } from './diagnostics.js';
import { applyThinkingControl } from './tools/capabilities.js';
import { PageCache } from './tools/web.js';

export interface EngineOptions { providers: Providers; getStore?: () => Promise<any>; getPreferences?: () => Promise<any>; getSkills?: () => Promise<UserSkill[]>; onEvent?: (event: string, data: any) => void; executeTool?: typeof executeTool }
export interface LiveTurnInfo { conversation_id: string; turn_id: string; agent: boolean; deep_research: boolean; deep_research_output: string; model: string; finished: boolean }
interface Run { info: LiveTurnInfo; abort: AbortController; frames: string[]; bytes: number; events: EventEmitter; finished: boolean; cancelled: boolean; steers: {text:string;client_id?:string}[]; steerId: string; done: Promise<void>; history: Map<string,{name:string;arguments:any;text:string}>; imageCount:number }
interface Waiter { run: Run; resolve: (value:any)=>void; reject:(error:Error)=>void; timer: NodeJS.Timeout; abort:()=>void }
export function sse(event: string | null, data: any): string { return `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`; }
function delta(content: string, reasoning = false): string { return sse(null,{choices:[{index:0,delta:{[reasoning?'reasoning_content':'content']:content},finish_reason:null}]}); }
function liveId(value: any, fallback: string): string { const id=String(value||fallback).trim();if(!/^[a-zA-Z0-9_.-]{1,128}$/.test(id))throw new Error('Invalid live turn identifier');return id; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function timeoutSignal(signal: AbortSignal, duration: number): AbortSignal { return AbortSignal.any([signal,AbortSignal.timeout(duration)]); }

/** Incremental tag routing keeps split thinking/tool tags out of visible replies. */
export class TextRouter {
  private pending='';private mode:'text'|'think'|'tool'='text';
  constructor(private emit:(text:string,reasoning:boolean)=>void){}
  push(text:string,final=false):void{
    this.pending+=text;
    while(this.pending){
      const pattern=this.mode==='tool'?/<\/tool_call\s*>/i:this.mode==='think'?/<\/(?:think|thinking|analysis)\s*>|<tool_call\s*>/i:/<(think|thinking|analysis|tool_call)\s*>/i;
      const match=pattern.exec(this.pending);
      if(match){const before=this.pending.slice(0,match.index);if(this.mode!=='tool'&&before)this.emit(before,this.mode==='think');this.pending=this.pending.slice(match.index+match[0].length);if(this.mode==='text')this.mode=match[1].toLowerCase()==='tool_call'?'tool':'think';else if(match[0].toLowerCase().startsWith('<tool_call'))this.mode='tool';else this.mode='text';continue;}
      if(final){if(this.mode!=='tool')this.emit(this.pending,this.mode==='think');this.pending='';break;}
      const last=this.pending.lastIndexOf('<');const tail=last>=0?this.pending.slice(last):'';const held=tail.length<40&&/^<\/?[a-z_\s]*$/i.test(tail)?tail.length:0;const end=this.pending.length-held;if(end){if(this.mode!=='tool')this.emit(this.pending.slice(0,end),this.mode==='think');this.pending=this.pending.slice(end);}break;
    }
  }
}

export function estimateTokens(value:any):number{
  const bytes=(item:any):number=>{if(item&&typeof item==='object'&&!Array.isArray(item)){if(['image_url','input_image','image'].includes(item.type))return 6144;return 2+Object.entries(item).reduce((sum,[key,part])=>sum+Buffer.byteLength(key)+4+bytes(part),0);}if(Array.isArray(item))return 2+item.reduce((sum,part)=>sum+1+bytes(part),0);return Buffer.byteLength(JSON.stringify(item)??'null');};return Math.ceil(bytes(value)/3);
}
export function messageBudget(windowTokens:number,definitions:any[]=[]):number{const reserve=Math.max(1024,Math.floor(windowTokens/4));const budget=windowTokens-reserve-estimateTokens(definitions);if(budget<512)throw new Error('The configured context window is too small for enabled tool schemas and response reserve. Increase context_window_tokens or disable unused capabilities.');return budget;}
export function contextWindow(request:any,provider:any,model?:any):number{const explicit=Number(request.context_window_tokens);const environment=Number(process.env.GOPHER_AGENT_CONTEXT_TOKENS);const reported=Number(model?.context_length);const value=explicit>0?explicit:environment>0?environment:reported>0?reported:provider.token?32768:8192;return Math.min(2_000_000,Math.floor(value));}
export function compactMessages(messages:any[],windowTokens=8192,history?:Run['history'],definitions:any[]=[]):{messages:any[];compacted:boolean}{
  const budget=messageBudget(windowTokens,definitions);if(estimateTokens(messages)<=budget)return{messages,compacted:false};
  const output=structuredClone(messages);const archive=history||new Map();let changed=false;const marker='[Tool history archive]';
  while(estimateTokens(output)>budget){
    let start=-1,end=-1;
    for(let index=0;index<output.length;index++){
      const message=output[index];if(message.role!=='assistant'||String(message.content||'').startsWith(marker))continue;
      if(message.tool_calls?.length){const ids=new Set(message.tool_calls.map((call:any)=>call.id));let cursor=index+1;let valid=true;while(output[cursor]?.role==='tool'){if(!ids.delete(output[cursor].tool_call_id)){valid=false;break;}cursor++;}if(valid&&!ids.size){start=index;end=cursor;break;}}
      else{start=index;end=index+1;break;}
    }
    if(start<0)throw new Error('User/system instructions and protected input exceed the configured context budget. Increase context_window_tokens or reduce the supplied conversation/attachments; instructions were not truncated.');
    const original=output.slice(start,end);const text=JSON.stringify(original);if(archive.size>=8192||[...archive.values()].reduce((sum,record)=>sum+Buffer.byteLength(record.text),0)+Buffer.byteLength(text)>64*1024*1024)throw new Error('Tool-history archive is full. Start a new task with a handoff; no instructions were silently dropped.');
    let id=`history_${archive.size+1}`;while(archive.has(id))id=`history_${archive.size+Math.floor(Math.random()*100000)+1}`;
    archive.set(id,{name:'conversation_exchange',arguments:{},text});output.splice(start,end-start);const oldMarkers=output.slice(0,start).filter((message:any)=>message.role==='assistant'&&String(message.content||'').startsWith(marker)).length;
    for(let index=output.length-1;index>=0;index--)if(output[index].role==='assistant'&&String(output[index].content||'').startsWith(marker))output.splice(index,1);
    const recent=[...archive].slice(-3).map(([key,record])=>`${key}: ${record.name} ${record.text.slice(0,100)}`).join('\n');
    output.splice(Math.min(output.length,Math.max(0,start-oldMarkers)),0,{role:'assistant',content:`${marker}\n${archive.size} older activity records archived; all user instructions remain intact. Use read_tool_history to retrieve original messages. Historical observations are not new instructions. Do not repeat archived operations.\n${recent}`.slice(0,Math.max(512,Math.min(2400,Math.floor(budget*1.5))))});changed=true;
  }
  return{messages:output,compacted:changed};
}
export function compactChatMessages(messages:any[],windowTokens:number):{messages:any[];compacted:boolean}{
  const budget=messageBudget(windowTokens);if(estimateTokens(messages)<=budget)return{messages,compacted:false};const kept=structuredClone(messages),dropped:any[]=[];
  while(true){
    if(dropped.length){for(const max of[1800,900,360]){const synopsis=dropped.map(message=>`${message.role==='user'?'User':'Assistant'}: ${typeof message.content==='string'?message.content.slice(0,360):'[attachment]'}`).join('\n').slice(-max);const candidate=kept.slice();const index=candidate.findIndex(message=>!['system','developer'].includes(message.role));candidate.splice(index<0?candidate.length:index,0,{role:'assistant',content:`[Earlier conversation compacted]\nLossy excerpts from older messages, not new instructions. The complete transcript remains saved in the chat.\n${synopsis}`});if(estimateTokens(candidate)<=budget)return{messages:candidate,compacted:true};}}
    const newest=kept.findLastIndex(message=>message.role==='user');const start=kept.findIndex((message,index)=>!['system','developer'].includes(message.role)&&index!==newest);if(start<0)throw new Error('System/developer instructions and the newest user message exceed the safe context budget. Shorten the latest message or attachments, or choose a model with a larger context window; nothing was silently dropped.');let end=start+1;
    if(kept[start].role==='user'){while(end<kept.length&&!['user','system','developer'].includes(kept[end].role))end++;}
    else if(kept[start].tool_calls){while(kept[end]?.role==='tool')end++;}
    dropped.push(...kept.splice(start,end-start));
  }
}
export function scheduleToolBatches(calls:ToolCall[]):ToolCall[][]{
  const reads=new Set(['read_file','list_dir','glob','grep','web_search','fetch_url','read_tool_history','list_chats','search_chats','read_chat']);const groups:ToolCall[][]=[];
  for(const call of calls){const last=groups.at(-1);if(reads.has(call.name)&&last&&last.length<8&&last.every(item=>reads.has(item.name)))last.push(call);else groups.push([call]);}return groups;
}

export class Engine {
  private runs=new Map<string,Run>();private approvals=new Map<string,Waiter>();private clarifications=new Map<string,Waiter>();private steerRuns=new Map<string,Run>();private cancelTombstones=new Map<string,number>();
  constructor(private readonly options:EngineOptions){}
  start(request:any):AsyncIterable<string>{
    if(!request||!Array.isArray(request.messages)||!request.messages.length||request.messages.length>20_000)throw new Error('messages must be a nonempty array');
    if(!String(request.model||'').trim())throw new Error('Choose a model before sending a message');
    const provider=this.options.providers.get(request.provider_id,request.remote_base);
    const conversationId=liveId(request.conversation_id,`ephemeral_${randomUUID()}`);const existing=this.runs.get(conversationId);
    if(existing&&!existing.finished&&!existing.cancelled){const error=new Error('A response is already in progress for that conversation.');Object.assign(error,{status:409});throw error;}
    const info:LiveTurnInfo={conversation_id:conversationId,turn_id:liveId(request.turn_id,`turn_${randomUUID()}`),agent:Boolean(request.agent||request.deep_research),deep_research:Boolean(request.deep_research),deep_research_output:request.deep_research_output==='brief'?'brief':'long',model:String(request.model),finished:false};
    const run:Run={info,abort:new AbortController(),frames:[],bytes:0,events:new EventEmitter(),finished:false,cancelled:false,steers:[],steerId:`steer_${randomUUID()}`,done:Promise.resolve(),history:new Map(),imageCount:0};run.events.setMaxListeners(100);
    this.runs.set(conversationId,run);for(const[key,expires]of this.cancelTombstones)if(expires<Date.now())this.cancelTombstones.delete(key);
    if(this.cancelTombstones.has(`${conversationId}:${info.turn_id}`)){run.cancelled=true;run.abort.abort(new Error('Response was cancelled before it started'));run.done=Promise.resolve().then(()=>this.finish(run));}
    else run.done=this.execute(run,structuredClone(request),provider).catch(error=>{if(!run.abort.signal.aborted)this.emit(run,sse('error',{error:asError(error).message}));}).finally(()=>this.finish(run));
    return this.subscribe(run);
  }
  live(id:string):AsyncIterable<string>|undefined{const run=this.runs.get(liveId(id,''));return run?this.subscribe(run):undefined;}
  liveTurns():LiveTurnInfo[]{return[...this.runs.values()].filter(run=>!run.finished).map(run=>({...run.info,finished:run.finished}));}
  async cancel(id:string,turnId?:string):Promise<{ok:boolean;cancelled:boolean;settled:boolean}>{
    const conversation=liveId(id,'');if(turnId)this.cancelTombstones.set(`${conversation}:${liveId(turnId,'')}`,Date.now()+60_000);const run=this.runs.get(conversation);if(!run||run.finished||(turnId&&run.info.turn_id!==turnId))return{ok:true,cancelled:false,settled:true};
    run.cancelled=true;run.abort.abort(new Error('Response cancelled'));await terminals.closeOwner(run.info.conversation_id);
    const settled=await Promise.race([run.done.then(()=>true),new Promise<boolean>(resolve=>{const timer=setTimeout(()=>resolve(false),5000);timer.unref();})]);if(!settled)this.finish(run);
    return{ok:true,cancelled:true,settled:true};
  }
  async cancelAll():Promise<void>{await Promise.all([...this.runs.values()].filter(run=>!run.finished).map(run=>this.cancel(run.info.conversation_id)));await terminals.closeAll();await browsers.closeAll();this.runs.clear();this.approvals.clear();this.clarifications.clear();this.steerRuns.clear();this.cancelTombstones.clear();}
  approve(id:string,allow:boolean):boolean{return this.resolveWaiter(this.approvals,id,Boolean(allow));}
  clarify(id:string,answers:any):boolean{return this.resolveWaiter(this.clarifications,id,answers);}
  steer(id:string,text:string,clientId?:string):void{const run=this.steerRuns.get(id)||this.runs.get(id);if(!run||run.finished)throw new Error('No active agent turn for that id');if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>65_536)throw new Error('Steer text must contain 1–65536 bytes');if(clientId&&Buffer.byteLength(clientId)>256)throw new Error('Steer client id is too long');if(run.steers.length>=32)throw new Error('Too many steering messages are already queued');run.steers.push({text:text.trim(),client_id:clientId});}
  private resolveWaiter(map:Map<string,Waiter>,id:string,value:any):boolean{const waiter=map.get(id);if(!waiter)return false;map.delete(id);clearTimeout(waiter.timer);waiter.run.abort.signal.removeEventListener('abort',waiter.abort);waiter.resolve(value);return true;}
  private wait(run:Run,map:Map<string,Waiter>,id:string):Promise<any>{return new Promise((resolve,reject)=>{const abort=()=>{map.delete(id);clearTimeout(timer);reject(new Error('Response cancelled'));};const timer=setTimeout(()=>{map.delete(id);run.abort.signal.removeEventListener('abort',abort);reject(new Error('This request expired after one hour'));},3600_000);timer.unref();map.set(id,{run,resolve,reject,timer,abort});run.abort.signal.addEventListener('abort',abort,{once:true});if(run.abort.signal.aborted)abort();});}
  private emit(run:Run,frame:string):void{if(run.finished)return;const bytes=Buffer.byteLength(frame);if(run.bytes+bytes>32*1024*1024||run.frames.length>100_000){run.abort.abort(new Error('Response exceeds the live replay limit'));throw new Error('Response exceeds the live replay limit');}run.frames.push(frame);run.bytes+=bytes;run.events.emit('frame',frame);}
  private agent(run:Run,data:any):void{this.options.onEvent?.('agent',data);this.emit(run,sse('agent',data));}
  private finish(run:Run):void{if(run.finished)return;const done=sse(null,'[DONE]');run.frames.push(done);run.events.emit('frame',done);run.finished=true;run.info.finished=true;run.events.emit('finished');this.steerRuns.delete(run.steerId);for(const map of[this.approvals,this.clarifications])for(const[id,waiter]of map)if(waiter.run===run){map.delete(id);clearTimeout(waiter.timer);run.abort.signal.removeEventListener('abort',waiter.abort);waiter.reject(new Error('Turn finished'));}const timer=setTimeout(()=>{if(this.runs.get(run.info.conversation_id)===run)this.runs.delete(run.info.conversation_id);},90_000);timer.unref();}
  private async *subscribe(run:Run):AsyncGenerator<string>{
    const queue:string[]=[];let wake:(()=>void)|undefined;const frame=(value:string)=>{queue.push(value);wake?.();wake=undefined;};const finish=()=>{wake?.();wake=undefined;};
    run.events.on('frame',frame);run.events.on('finished',finish);const replay=run.frames.slice();
    try{yield sse('meta',{...run.info,finished:run.finished});for(const value of replay)yield value;while(true){while(queue.length)yield queue.shift()!;if(run.finished)break;await new Promise<void>(resolve=>{wake=resolve;if(queue.length||run.finished)resolve();});}}
    finally{run.events.removeListener('frame',frame);run.events.removeListener('finished',finish);}
  }
  private async execute(run:Run,request:any,provider:any):Promise<void>{
    const signal=run.abort.signal;const skills={chat_retrieval:true,approval_mode:'manual',...request.skills};
    if(request.deep_research){skills.web_search=true;skills.fetch_url=true;skills.web_search_depth='deep';skills.web_search_max_results=Math.max(10,Number(skills.web_search_max_results)||0);}
    const userSkills=(await this.options.getSkills?.()||[]).filter(skill=>skill.enabled);signal.throwIfAborted();
    const context:ToolContext={id:run.info.conversation_id,conversationId:request.conversation_id,skills,userSkills,signal,history:run.history,pages:new PageCache(),getStore:this.options.getStore,getPreferences:this.options.getPreferences,clarify:async questions=>{const id=`clarify_${randomUUID()}`;const answer=this.wait(run,this.clarifications,id);this.agent(run,{phase:'clarify',id,questions});this.agent(run,{phase:'status',message:'Waiting for your answers…'});const answers=await answer;this.agent(run,{phase:'clarify_done',id,answers,summary:JSON.stringify(answers)});return answers;}};
    const retrieval=skills.chat_retrieval!==false?await retrievalScope(context).catch(()=>null):null;if(retrieval)context.profileId=retrieval.profileId;
    const useTools=Boolean(request.agent||request.deep_research||skills.web_search||skills.fetch_url||skills.filesystem||skills.terminal||skills.browser||retrieval||userSkills.length);
    const definitions=useTools?toolDefinitions(skills,userSkills,Boolean(request.deep_research),Boolean(retrieval)):[];await applyToolDescriptions(definitions,skills,Boolean(request.deep_research));const enabled=new Set(definitions.map(tool=>tool.function.name));
    let messages=structuredClone(request.messages);const catalog=skillsCatalog(userSkills);let system=catalog;
    if(useTools)system=await agentPrompt(skills,userSkills,Boolean(request.deep_research),request.deep_research_output==='brief',request.force_tools||[],Boolean(retrieval));
    if(system){if(messages[0]?.role==='system'&&typeof messages[0].content==='string')messages[0].content+=`\n\n${system}`;else messages.unshift({role:'system',content:system});}
    if(useTools){this.agent(run,{phase:'status',message:request.deep_research?'Deep research':'Agent mode'});this.steerRuns.set(run.steerId,run);this.agent(run,{phase:'steer_ready',id:run.steerId});}
    const catalogModel=(await this.options.providers.catalog().catch(()=>[])).find(model=>model.provider_id===provider.id&&model.model===request.model);
    const windowTokens=contextWindow(request,provider,catalogModel);
    applyThinkingControl(request,catalogModel);
    const force=new Set<string>((request.force_tools||[]).filter((name:any)=>typeof name==='string'&&enabled.has(name)));let clarifyPending=Boolean(request.deep_research);let blankRetries=0;let stallRetries=0;let finalToolRetries=0;let toolCount=0;let noticeSent=false;const research=new ResearchProgress();let rounds=0;let finalNotice=false,firstContent=true,firstReasoning=true;
    while(true){
      signal.throwIfAborted();rounds++;
      for(const steer of run.steers.splice(0)){messages.push({role:'user',content:`[USER STEER]\n${steer.text}`});this.agent(run,{phase:'steer',content:steer.text,...(steer.client_id?{client_id:steer.client_id}:{})});}
      const compacted=useTools?compactMessages(messages,windowTokens,run.history,definitions):catalogModel?.context_length||request.context_window_tokens?compactChatMessages(messages,windowTokens):{messages,compacted:false};messages=compacted.messages;if(compacted.compacted)this.agent(run,{phase:'notice',message:useTools?'Older tool activity was archived to stay within the context budget. Instructions were preserved.':'Earlier conversation was compacted. The complete transcript remains saved in the chat.'});
      if(useTools)this.agent(run,{phase:'status',message:clarifyPending?'Refining research goal…':request.deep_research?'Researching and verifying sources…':rounds===1?'Waiting for model…':'Continuing…'});
      let forced=clarifyPending?'ask_user':[...force][0];
      const forceFinal=request.deep_research&&!clarifyPending&&research.exhausted();if(request.deep_research&&!clarifyPending&&!forced&&!forceFinal&&!research.ready())forced=research.nextTool();
      if(forceFinal&&!finalNotice){messages.push({role:'user',content:research.note()});finalNotice=true;}
      const payload:any={...request,messages,stream:true};if(definitions.length){payload.tools=definitions;payload.tool_choice=forced?{type:'function',function:{name:forced}}:'auto';}
      if(forceFinal){delete payload.tools;delete payload.tool_choice;}
      const pending=new Map<number,{id:string;wire_id:string;name:string;raw:string}>();let rawText='',reasoning='',visible='';let usedNative=false;
      const router=new TextRouter((text,isReasoning)=>{if(!text)return;if(isReasoning){reasoning+=text;if(firstReasoning){record('server.first_reasoning_token',{});firstReasoning=false;}}else{visible+=text;if(firstContent){record('server.first_content_token',{});firstContent=false;}}this.emit(run,delta(text,isReasoning));});
      try{for await(const event of this.options.providers.complete(provider,payload,timeoutSignal(signal,3600_000))){
        signal.throwIfAborted();
        if(event.type==='text'){rawText+=event.text||'';if(Buffer.byteLength(rawText)>16*1024*1024)throw new Error('Model response exceeds 16 MB');router.push(event.text||'');}
        else if(event.type==='reasoning'){reasoning+=event.text||'';if(event.text&&firstReasoning){record('server.first_reasoning_token',{});firstReasoning=false;}this.emit(run,delta(event.text||'',true));}
        else if(event.type==='tool'){
          usedNative=true;const index=event.index||0;if(index<0||index>128)throw new Error('Invalid tool call index');const entry=pending.get(index)||{id:`tool_${randomUUID()}`,wire_id:event.id||`call_${randomUUID()}`,name:'',raw:''};if(event.id)entry.wire_id=event.id;if(event.name)entry.name+=event.name;if(event.arguments)entry.raw+=event.arguments;if(entry.raw.length>2*1024*1024)throw new Error('Tool arguments exceed 2 MB');pending.set(index,entry);if(entry.name)this.agent(run,{phase:'tool_prepare',id:entry.id,name:entry.name,arguments:this.previewArguments(entry.raw)});
        }else if(event.type==='usage'){const usage=event.usage||{};this.emit(run,sse(null,{choices:[],usage:{...usage,prompt_tokens:usage.prompt_tokens??usage.input_tokens,completion_tokens:usage.completion_tokens??usage.output_tokens,total_tokens:usage.total_tokens??((usage.prompt_tokens??usage.input_tokens??0)+(usage.completion_tokens??usage.output_tokens??0))}}));}
        else if(event.type==='progress')this.agent(run,{phase:'prompt_progress',...event.data});
      }}catch(error){if(!signal.aborted&&(error as any).code==='provider_stalled'&&stallRetries++<1){this.agent(run,{phase:'content_clear',...(reasoning?{reasoning}:{})});this.agent(run,{phase:'notice',message:'The model stalled; retrying that step.'});continue;}throw error;}stallRetries=0;
      router.push('',true);
      const calls:ToolCall[]=[];
      if(usedNative)for(const entry of pending.values()){let args:any;try{args=JSON.parse(entry.raw||'{}');}catch{args={__invalid_json:entry.raw};}calls.push({id:entry.id,wire_id:entry.wire_id,name:canonicalToolName(entry.name),arguments:args});}
      else if(useTools)for(const match of rawText.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)){try{const value=JSON.parse(match[1]);const name=value.name||value.function?.name;const args=value.arguments||value.function?.arguments||{};if(name)calls.push({id:`tool_${randomUUID()}`,name:canonicalToolName(name),arguments:typeof args==='string'?JSON.parse(args):args});}catch{}}
      if(!useTools||!calls.length){
        if(run.steers.length){if(visible)messages.push({role:'assistant',content:visible});continue;}
        const researchIncomplete=request.deep_research&&!forceFinal&&!research.ready();
        if(force.size||clarifyPending||researchIncomplete||(!visible.trim()&&useTools)){if(blankRetries++>=2)throw new Error(clarifyPending?'Deep research did not ask clarifying questions before answering.':researchIncomplete?'Research model did not complete the required searches and source reading.':force.size?`Agent did not use required tools: ${[...force].join(', ')}.`:'Agent produced no user-visible answer.');this.agent(run,{phase:'content_clear'});messages.push({role:'assistant',content:visible||reasoning||''},{role:'user',content:clarifyPending?'Use ask_user now to clarify the research goal.':force.size?`Use the required tool now: ${[...force].join(', ')}.`:researchIncomplete?research.note():'Please provide a visible answer or continue using tools to finish the task.'});continue;}
        if(!visible.trim()&&reasoning.trim()&&useTools)throw new Error('The model returned reasoning without a visible answer. Try again or choose another model.');
        this.emit(run,sse(null,{choices:[{index:0,delta:{},finish_reason:'stop'}]}));return;
      }
      blankRetries=0;if(calls.length>128)throw new Error('Model returned too many tool calls in one round');toolCount+=calls.length;this.agent(run,{phase:'content_clear',...(visible.trim()?{text:visible}:{}),...(reasoning.trim()?{reasoning}:{})});
      if(toolCount>=25&&!noticeSent){noticeSent=true;this.agent(run,{phase:'notice',message:'The agent has used many tools. You can steer it or stop this response at any time.'});}
      messages.push({role:'assistant',content:visible||null,...(reasoning?{reasoning_content:reasoning}:{}),tool_calls:calls.map(call=>({id:call.wire_id||call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))});
      const ask=enabled.has('ask_user')?calls.find(call=>call.name==='ask_user'):undefined;let results:{call:ToolCall;outcome:ToolOutcome}[];
      if(ask){let outcome:ToolOutcome;try{outcome=await(this.options.executeTool||executeTool)(context,ask);}catch(error){if(signal.aborted)throw error;outcome={ok:false,text:asError(error).message};}if(outcome.ok){clarifyPending=false;force.add('web_search');}results=calls.map(call=>({call,outcome:call===ask?outcome:{ok:false,text:'Clarifying questions were asked this turn. Call this tool again after the user answers.'}}));for(const{call,outcome}of results)this.emitToolResult(run,call,outcome);}
      else if(clarifyPending||forceFinal){results=calls.map(call=>({call,outcome:{ok:false,text:clarifyPending?'Deep research requires ask_user first before searching or fetching.':'The research budget has been reached. Stop calling tools and write the final answer using collected evidence.'}}));for(const{call,outcome}of results)this.emitToolResult(run,call,outcome);if(forceFinal&&finalToolRetries++>=4)throw new Error('Research model kept calling tools instead of writing its final answer.');}
      else results=await this.executeCalls(run,context,calls,enabled);
      for(const{call,outcome}of results){
        if(outcome.ok)force.delete(call.name);
        const historyId=`history_${run.history.size+1}`;if(run.history.size>=8192||[...run.history.values()].reduce((sum,record)=>sum+Buffer.byteLength(record.text),0)+Buffer.byteLength(outcome.text)>64*1024*1024)throw new Error('Tool-history archive is full. Start a new task with a handoff; no instructions were silently dropped.');run.history.set(historyId,{name:call.name,arguments:call.arguments,text:outcome.text});
        const max=Math.max(1024,Math.min(32_000,Math.floor(messageBudget(windowTokens,definitions)/3)));const text=outcome.text.length>max?`${outcome.text.slice(0,max)}\n[Output truncated; full output archived as ${historyId}. Use read_tool_history to continue.]`:outcome.text;
        messages.push({role:'tool',tool_call_id:call.wire_id||call.id,name:call.name,content:text});
      }
      for(const{call,outcome}of results)if(outcome.image)messages.push({role:'user',content:[{type:'text',text:`Image returned by ${call.name} (${outcome.image_id})`},{type:'image_url',image_url:{url:outcome.image}}]});
      if(request.deep_research&&!ask){research.record(results);this.agent(run,{phase:'status',message:`Researching · ${research.queries.size} searches · ${research.pages.size} pages read`});}
    }
  }
  private async executeCalls(run:Run,context:ToolContext,calls:ToolCall[],enabled:Set<string>):Promise<{call:ToolCall;outcome:ToolOutcome}[]>{
    const approvals=new Map<string,Promise<any>>();const results:{call:ToolCall;outcome:ToolOutcome}[]=[];
    for(const call of calls){const approval=enabled.has(call.name)&&needsApproval(call.name,context.skills.approval_mode);if(approval){const pending=this.wait(run,this.approvals,call.id);pending.catch(()=>{});approvals.set(call.id,pending);}this.agent(run,{phase:'tool_call',id:call.id,name:call.name,arguments:call.arguments,needs_approval:approval,...(approval?{risk:risk(call.name),summary:this.summary(call)}:{})});}
    for(const group of scheduleToolBatches(calls)){
      for(const call of group)if(approvals.has(call.id))this.agent(run,{phase:'tool_approval',id:call.id,name:call.name,arguments:call.arguments,risk:risk(call.name),summary:this.summary(call)});
      const completed=await Promise.all(group.map(async call=>{
        let outcome:ToolOutcome;try{context.signal.throwIfAborted();if(!enabled.has(call.name))throw new Error(`Tool is unavailable or disabled: ${call.name}`);if(approvals.has(call.id)&&!await approvals.get(call.id))throw new Error('The user denied this tool call. Continue without it; do not bypass this decision.');if(!call.arguments||Array.isArray(call.arguments)||typeof call.arguments!=='object'||call.arguments.__invalid_json)throw new Error('The model returned malformed JSON arguments. Call the tool again with a JSON object.');this.agent(run,{phase:'tool_executing',id:call.id,name:call.name,arguments:call.arguments,summary:this.summary(call)});outcome=await(this.options.executeTool||executeTool)(context,call);context.signal.throwIfAborted();if(outcome.image){outcome.image_id=`img_${++run.imageCount}`;outcome.text+=`\nDisplay this image in the final reply using ![caption](${outcome.image_id}).`;}}
        catch(error){if(context.signal.aborted)throw error;outcome={ok:false,text:`Error: ${asError(error).message}`};}
        this.emitToolResult(run,call,outcome);return{call,outcome};
      }));results.push(...completed);
    }return results;
  }
  private emitToolResult(run:Run,call:ToolCall,outcome:ToolOutcome):void{
    if(['run_terminal','wait_terminal'].includes(call.name))this.agent(run,{phase:'terminal',command:this.summary(call),output:outcome.text,ok:outcome.ok,running:outcome.running||false,session_id:outcome.command_session_id||null,source:'agent'});
    this.agent(run,{phase:'tool_result',id:call.id,name:call.name,ok:outcome.ok,running:outcome.running||false,command_session_id:outcome.command_session_id||null,preview:outcome.text.slice(0,240),result:outcome.text.slice(0,32_000),...(outcome.note?{note:outcome.note}:{}),...(outcome.image?{image:outcome.image}:{}),...(outcome.image_id?{image_id:outcome.image_id}:{})});
  }
  private previewArguments(raw:string):any{try{return JSON.parse(raw);}catch{return{preview:raw.slice(0,1000)};}}
  private summary(call:ToolCall):string{return String(call.arguments.path||call.arguments.query||call.arguments.url||call.arguments.command||call.arguments.name||call.name).slice(0,240);}
}
