import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Workspace, executeFilesystem } from './filesystem.js';
import { browsers } from './browser.js';
import { searchWeb, fetchPublicUrl, safeFetch, PageCache, type SearchSettings } from './web.js';
import { terminals } from '../terminal.js';
import { findSkill, fullInstructions, type UserSkill } from '../skills.js';

export type AgentSkills = Record<string, any>;
export interface ToolCall { id: string; name: string; arguments: Record<string, any>; wire_id?: string }
export interface ToolOutcome { text: string; ok: boolean; running?: boolean; command_session_id?: string; image?: string; image_id?: string; note?: string }
export interface ToolContext { id: string; conversationId?: string; profileId?: string | null; skills: AgentSkills; userSkills: UserSkill[]; signal: AbortSignal; history: Map<string, {name: string; arguments: any; text: string}>; pages?:PageCache;getStore?: () => Promise<any>; getPreferences?: () => Promise<any>; clarify: (questions: any[]) => Promise<any> }
const S = { type: 'string' }, N = { type: 'integer' }, B = { type: 'boolean' };
const FILE_TOOLS = new Set(['read_file','list_dir','glob','grep','write_file','str_replace','delete_file','apply_patch']);
export function risk(name: string): string { return ['write_file','str_replace','delete_file','apply_patch'].includes(name) ? 'write' : name === 'run_terminal' ? 'terminal' : name.startsWith('browser_') ? 'browser' : 'safe'; }
export function needsApproval(name: string, mode: string): boolean { return !['ask_user','wait_terminal','read_tool_history','list_chats','search_chats','read_chat'].includes(name) && (mode !== 'auto_safe' || ['write','terminal'].includes(risk(name))); }
function tool(name: string, description: string, properties: any = {}, required: string[] = []): any { return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }; }
export function toolDefinitions(skills: AgentSkills, userSkills: UserSkill[], deepResearch: boolean, retrieval: boolean): any[] {
  const definitions: any[] = [];
  if (deepResearch) definitions.push(tool('ask_user','Ask 1–2 concise multiple-choice questions to clarify the research goal before researching.', { questions: { type: 'array', minItems: 1, maxItems: 2, items: { type:'object', properties: { header:S, question:S, options:{type:'array',minItems:2,maxItems:4,items:{type:'object',properties:{label:S,description:S},required:['label']}}, multiSelect:B }, required:['question','options'] } } }, ['questions']));
  if (skills.web_search) definitions.push(tool('web_search','Search the web for current information. Returns sources and excerpts; cite useful sources using Markdown links.',{query:S,recency:{type:'string',enum:['any','day','week','month','year']}},['query']));
  if (skills.fetch_url) definitions.push(tool('fetch_url','Read bounded text from a public HTTP(S) web page. Use offset to continue reading long pages.',{url:S,offset:N,max_chars:N},['url']));
  definitions.push(tool('read_tool_history','Recover full tool outputs archived from context. Omit id to list records.',{id:S,offset:N,limit:N,byte_offset:N,max_bytes:N}));
  if (retrieval) {
    const paging={cursor:N,limit:N}; definitions.push(tool('list_chats','List previous chats in the current profile and project scope.',paging));
    definitions.push(tool('search_chats','Search visible messages in previous chats. All query keywords must match.',{...paging,query:S},['query']));
    definitions.push(tool('read_chat','Read messages from a chat returned by list_chats or search_chats.',{...paging,chat_id:S,char_offset:N},['chat_id']));
  }
  if (skills.filesystem && skills.workspace_root) definitions.push(
    tool('read_file','Read a bounded file page. Offset is a 0-based line number; byte_offset resumes exact pages. Preserve unseen content when editing.',{path:S,offset:N,limit:N,byte_offset:N,max_bytes:N},['path']),
    tool('list_dir','List files and directories in the workspace.',{path:S}),
    tool('glob','Find files by a glob. Skips dependency and generated directories.',{pattern:S,path:S},['pattern']),
    tool('grep','Search workspace files with a regular expression and bounded context.',{query:S,path:S,glob:S,output_mode:{type:'string',enum:['content','files','count']},head_limit:N,case_insensitive:B,context:N},['query']),
    tool('write_file','Create a complete text file. Existing files require explicit overwrite:true; use str_replace or apply_patch for partial edits.',{path:S,content:S,overwrite:B},['path','content']),
    tool('str_replace','Replace an exact string. Must be unique unless replace_all is true.',{path:S,old_string:S,new_string:S,replace_all:B},['path','old_string','new_string']),
    tool('delete_file','Delete a regular file inside the workspace.',{path:S},['path']),
    tool('apply_patch','Apply an atomic *** Begin Patch / *** End Patch block with Add File, Update File, Delete File, and optional Move to operations. Update context uses space, additions +, deletions -.',{patch:S},['patch']));
  if (skills.terminal && skills.workspace_root) definitions.push(tool('run_terminal',`Run a command in the chat workspace using ${process.platform === 'win32' ? 'PowerShell' : 'the system shell'}. Running commands return a session_id; use wait_terminal to continue.`,{command:S,cwd:S,yield_time_ms:N},['command']), tool('wait_terminal','Read new output or terminate a previously authorized command session in this conversation.',{session_id:S,yield_time_ms:N,terminate:B},['session_id']));
  if (skills.browser) definitions.push(
    tool('browser_navigate','Navigate the conversation browser to an HTTP(S) URL.',{url:S},['url']),
    tool('browser_snapshot','Read visible page text and element refs from the current page.'),
    tool('browser_click','Click a ref returned by the latest snapshot.',{ref:S},['ref']),
    tool('browser_type','Fill an editable element by ref; optionally submit with Enter.',{ref:S,text:S,submit:B},['ref','text']),
    tool('browser_press','Press a keyboard key or shortcut, optionally on a ref.',{key:S,ref:S},['key']),
    tool('browser_select','Select an option from a select element by ref and value.',{ref:S,value:S},['ref','value']),
    tool('browser_wait','Wait for a selector or a bounded duration.',{time_ms:N,selector:S}),
    tool('browser_screenshot','Take a viewport screenshot; optionally save inside the workspace.',{path:S}),
    tool('browser_evaluate','Evaluate JavaScript in the current browser page.',{expression:S},['expression']),
    tool('browser_close','Close the browser for this conversation.'));
  definitions.push(tool('show_image','Display a PNG, JPEG, GIF, or WebP image from a workspace path or public image URL.',{path:S,url:S}));
  if (userSkills.length) definitions.push(tool('activate_skill','Read a user skill’s full instructions by name or id.',{name:S},['name']));
  return definitions;
}

export function visibleText(message: any): string {
  if (!['user','assistant'].includes(message?.role)) return '';
  const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((p: any) => ['text','input_text','output_text'].includes(p.type)).map((p: any) => p.text).join('\n') : '';
  const tags = /<\s*(\/?)(think|thinking|analysis|global_memory_update|memory_update|bot_memory_update|group_memory_update|bot_hold|bot_resume|bot_dm_user|bot_group_post)\b[^>]*>|\[\[\s*(\/?)(think|thinking|analysis|global_memory_update|memory_update|bot_memory_update|group_memory_update|hold|resume|dm_user|group_post)\s*\]\]/gi;
  let output = '', cursor = 0; const stack: string[] = []; let match: RegExpExecArray | null;
  while ((match = tags.exec(content))) { if (!stack.length) output += content.slice(cursor, match.index); const name = (match[2] || match[4]).toLowerCase(); if ((match[1] || match[3]) === '/') { if (stack.at(-1) === name) stack.pop(); } else if (!['bot_hold','bot_resume','hold','resume'].includes(name) && !match[0].endsWith('/>')) stack.push(name); cursor = tags.lastIndex; }
  if (!stack.length) output += content.slice(cursor); return output.trim();
}
export async function retrievalScope(context: Pick<ToolContext,'conversationId'|'profileId'|'getStore'|'getPreferences'>): Promise<{chats:any[];scope:string;profileId:string|null} | null> {
  if (!context.conversationId || !context.getStore) return null;
  if ((await context.getPreferences?.())?.chatRetrieval === false) return null;
  const store = await context.getStore(); const profileId = Array.isArray(store.profiles) ? store.activeProfileId : null;
  if (context.profileId !== undefined && context.profileId !== profileId) return null;
  const profile = profileId === null ? store : store.profiles.find((item:any) => item.id === profileId); if (!profile) return null;
  const source = profile.conversations?.find((chat:any) => chat.id === context.conversationId && !chat.incognito); if (!source) return null;
  const project = source.projectId || null;
  const chats = profile.conversations.filter((chat:any) => /^[a-zA-Z0-9_.-]{1,128}$/.test(chat.id) && chat.id !== source.id && !chat.incognito && (chat.projectId || null) === project).sort((a:any,b:any) => Number(b.updatedAt || 0)-Number(a.updatedAt || 0));
  return { chats, scope: project ? 'current project' : 'non-project chats in current profile', profileId };
}
async function retrieve(context: ToolContext, name: string, args: any): Promise<string> {
  const scoped = await retrievalScope(context); if (!scoped) throw new Error('Chat retrieval is disabled or this conversation’s scope is no longer available');
  const cursor = Math.max(0,Number(args.cursor)||0), limit = Math.max(1,Math.min(20,Number(args.limit)|| (name === 'list_chats'?10:5)));
  const metadata = (chat:any,index?:number) => ({ chat_id:chat.id,title:String(chat.title||'Untitled chat').replace(/[\x00-\x1f]/g,'').slice(0,60),updated_at:chat.updatedAt||0,message_index:index,url:`/c/${encodeURIComponent(chat.id)}${index!==undefined?`?message=${index}`:''}` });
  let results:any[]=[]; let total=0; let nextCharOffset:number|null=null;
  if (name === 'list_chats') { total=scoped.chats.length; results=scoped.chats.slice(cursor,cursor+limit).map(chat=>metadata(chat)); }
  else if(name==='search_chats') {
    const query=String(args.query||'').trim().toLowerCase(); if(!query||Buffer.byteLength(query)>500) throw new Error('Query must contain 1–500 bytes'); const terms=query.split(/\s+/); const hits:any[]=[];
    for(const chat of scoped.chats) for(const [index,message] of (chat.messages||[]).entries()) {const text=visibleText(message),lower=text.toLowerCase(),title=String(chat.title||'').toLowerCase(); if(text&&terms.every(term=>lower.includes(term)||title.includes(term))) {const positions=terms.map(term=>lower.indexOf(term)).filter((n:number)=>n>=0);const offset=Math.max(0,(positions.length?Math.min(...positions):0)-80);hits.push({...metadata(chat,index),role:message.role,excerpt:text.slice(offset,offset+600),score:(lower.includes(query)?4:0)+terms.filter(term=>lower.includes(term)).length});} }
    hits.sort((a,b)=>b.score-a.score);total=hits.length; results=hits.slice(cursor,cursor+limit).map(({score,...hit})=>hit);
  } else {
    const chat=scoped.chats.find(item=>item.id===args.chat_id);if(!chat)throw new Error('Chat was not found within the current scope');const messages=chat.messages||[];let offset=Math.max(0,Number(args.char_offset)||0);const page:any={scope:scoped.scope,results,next_cursor:null};
    for(let index=cursor;index<messages.length;index++){const message=messages[index],text=visibleText(message);if(!text){offset=0;continue;}const characters=Array.from(text);if(offset>=characters.length){offset=0;continue;}const item={...metadata(chat,index),role:message.role,char_offset:offset,content:'',truncated:false};const capacity=Math.min(1600,Math.max(0,Math.floor((12_000-Buffer.byteLength(JSON.stringify(page))-Buffer.byteLength(JSON.stringify(item))-128)/6)));if(!capacity){page.next_cursor=index;page.next_char_offset=offset;return JSON.stringify(page);}item.content=characters.slice(offset,offset+capacity).join('');const end=offset+Array.from(item.content).length;item.truncated=end<characters.length;results.push(item);if(item.truncated){page.next_cursor=index;page.next_char_offset=end;return JSON.stringify(page);}offset=0;if(results.length>=limit){if(index+1<messages.length)page.next_cursor=index+1;break;}}
    return JSON.stringify(page);
  }
  return JSON.stringify({scope:scoped.scope,results,next_cursor:nextCharOffset!==null?cursor+results.length-1:cursor+results.length<total?cursor+results.length:null,next_char_offset:nextCharOffset});
}
export function normalizeQuestions(args:any):any[]{
  if(typeof args==='string'){try{args=JSON.parse(args);}catch{return[];}}
  if(Array.isArray(args))args={questions:args};if(!args||typeof args!=='object')return[];if(!args.questions&&(args.question||args.prompt||args.text))args={questions:[args]};if(typeof args.questions==='string'){try{args.questions=JSON.parse(args.questions);}catch{return[];}}
  const raw=Array.isArray(args.questions)?args.questions:args.questions&&typeof args.questions==='object'?[args.questions]:[];
  const first=(item:any,keys:string[])=>keys.map(key=>item?.[key]).find(value=>typeof value==='string'&&value.trim())?.trim();
  return raw.slice(0,2).flatMap((item:any)=>{const question=first(item,['question','prompt','text','q']);const rawOptions=['options','choices','answers','choices_list'].map(key=>item[key]).find(Array.isArray);if(!question||!rawOptions)return[];const options=rawOptions.flatMap((option:any)=>{const label=typeof option==='string'?option.trim():first(option,['label','text','name','title','value']);return label?[{label,description:typeof option==='object'?first(option,['description','desc','detail','subtitle'])||'':''}]:[];}).slice(0,4);return options.length>=2?[{header:Array.from(first(item,['header','title','label','id'])||'Question').slice(0,12).join(''),question,options,multiSelect:Boolean(item.multiSelect??item.multi_select??item.allow_multiple)}]:[];});
}
function searchSettings(skills: AgentSkills, args:any): SearchSettings {
  const depth = String(skills.web_search_depth || 'standard'); const provider = String(skills.web_search_provider || skills.web_search_backend || 'auto');
  return { searchProvider: ['duckduckgo','searxng','parallel','tinyfish'].includes(provider)?provider as SearchSettings['searchProvider']:'auto',searchDepth:depth==='deep'?'deep':depth==='off'?'fast':'balanced',searchPageCount:depth==='off'?0:depth==='light'?2:depth==='deep'?6:depth==='standard'?4:3,searchPageMaxChars:Math.max(1000,Math.min(200_000,Number(skills.web_search_page_max_chars)||(depth==='deep'?4800:depth==='light'?1600:depth==='standard'?3200:2800))),searchResultCount:Math.max(1,Math.min(20,Number(skills.web_search_max_results)||6)),searchRegion:skills.web_search_region||'us-en',searchSafeSearch:skills.web_search_safesearch==='on'?'strict':['strict','moderate','off'].includes(skills.web_search_safesearch)?skills.web_search_safesearch:'moderate',searchRecency:['day','week','month','year'].includes(args.recency||skills.web_search_recency)?args.recency||skills.web_search_recency:'any',searxngUrl:skills.web_search_searxng||'',parallelMode:skills.web_search_parallel_mode||'fast'};
}
export async function executeTool(context: ToolContext, call: ToolCall): Promise<ToolOutcome> {
  const args=call.arguments,name=call.name,skills=context.skills;context.signal.throwIfAborted();
  if(FILE_TOOLS.has(name)){if(!skills.filesystem)throw new Error('Filesystem tools are disabled');return {ok:true,text:await executeFilesystem(await Workspace.open(skills.workspace_root),name,args,context.signal)};}
  if(name==='run_terminal'||name==='wait_terminal'){if(!skills.terminal)throw new Error('Terminal tools are disabled');const result=name==='run_terminal'?await terminals.command(skills.workspace_root,context.id,args,Number(skills.terminal_timeout_secs)||30,context.signal):await terminals.wait(context.id,args,skills.workspace_root,context.signal);return{ok:result.running||result.exit_code===0,text:JSON.stringify(result),running:result.running,command_session_id:result.session_id};}
  if(name.startsWith('browser_')){if(!skills.browser)throw new Error('Browser tools are disabled');const result=await browsers.execute(context.id,skills.workspace_root||'',name,args,context.signal);return{ok:true,...result};}
  if(name==='web_search'){if(!skills.web_search)throw new Error('Web search is disabled');const query=String(args.query||'').trim();if(!query||query.length>4096)throw new Error('Search query is missing or too long');const result=await searchWeb(query,searchSettings(skills,args),context.signal,{parallel:skills.web_search_parallel_api_key||process.env.PARALLEL_API_KEY,tinyfish:skills.web_search_tinyfish_api_key||process.env.TINYFISH_API_KEY},context.pages);return{ok:true,text:JSON.stringify(result),note:result.note};}
  if(name==='fetch_url'){if(!skills.fetch_url)throw new Error('Web fetching is disabled');const max=Math.max(1000,Math.min(200_000,Number(args.max_chars||skills.fetch_url_max_chars)||8000));const offset=Math.max(0,Number(args.offset)||0);const result=await(context.pages?context.pages.read(args.url,()=>fetchPublicUrl(args.url,context.signal,4_000_000)):fetchPublicUrl(args.url,context.signal,4_000_000));const characters=Array.from(result.text);const text=characters.slice(offset,offset+max).join('');return{ok:true,text:JSON.stringify({...result,text,offset,total_chars:characters.length,truncated:offset+Array.from(text).length<characters.length,next_offset:offset+Array.from(text).length<characters.length?offset+Array.from(text).length:null})};}
  if(['list_chats','search_chats','read_chat'].includes(name)){if(skills.chat_retrieval===false)throw new Error('Chat retrieval is disabled');return{ok:true,text:await retrieve(context,name,args)};}
  if(name==='activate_skill'){const skill=findSkill(context.userSkills,String(args.name||''));if(!skill||!skill.enabled)throw new Error('Skill was not found');return{ok:true,text:fullInstructions(skill)};}
  if(name==='ask_user'){const questions=normalizeQuestions(args);if(!questions.length)throw new Error('Retry ask_user with 1–2 questions, each containing question text and 2–4 labeled options.');const answers=await context.clarify(questions);return{ok:true,text:JSON.stringify({questions,answers})};}
  if(name==='read_tool_history'){
    if(!args.id){const records=[...context.history].map(([id,record])=>({id,name:record.name,arguments:record.arguments,bytes:Buffer.byteLength(record.text)}));const offset=Math.max(0,Number(args.offset)||0),limit=Math.max(1,Math.min(20,Number(args.limit)||10));return{ok:true,text:JSON.stringify({results:records.slice(offset,offset+limit),next_offset:offset+limit<records.length?offset+limit:null})};}
    const record=context.history.get(args.id);if(!record)throw new Error('Tool history record was not found');const bytes=Buffer.from(record.text);const offset=Math.max(0,Number(args.byte_offset)||0),max=Math.max(256,Math.min(12000,Number(args.max_bytes)||12000));let end=Math.min(bytes.length,offset+max);while(end<bytes.length&&end>offset&&(bytes[end]&0xc0)===0x80)end--;return{ok:true,text:JSON.stringify({id:args.id,name:record.name,content:bytes.subarray(offset,end).toString(),next_byte_offset:end<bytes.length?end:null})};
  }
  if(name==='show_image'){
    if(Boolean(args.path)===Boolean(args.url))throw new Error('Pass either a workspace path or an image URL');let bytes:Buffer;
    if(args.path){const ws=await Workspace.open(skills.workspace_root);const file=await ws.resolve(args.path);const meta=await fs.stat(file);if(!meta.isFile()||meta.size>1_500_000)throw new Error('Image must be a regular file smaller than 1.5 MB');bytes=await fs.readFile(file);}
    else{const response=await safeFetch(args.url,context.signal);if(!response.body)throw new Error('Empty image response');const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;try{while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>1_500_000)throw new Error('Image exceeds 1.5 MB');chunks.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});}bytes=Buffer.concat(chunks);}
    const mime=bytes.subarray(0,4).equals(Buffer.from([137,80,78,71]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.subarray(0,3).toString()==='GIF'?'image/gif':bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;if(!mime)throw new Error('Unsupported image format');const id=`image_${randomUUID()}`;return{ok:true,text:`Image ${id} is available to display.`,image:`data:${mime};base64,${bytes.toString('base64')}`,image_id:id};
  }
  throw new Error(`Unknown or disabled tool: ${name}`);
}
