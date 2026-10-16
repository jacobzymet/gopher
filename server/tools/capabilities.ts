export interface ThinkingCapability { thinking_supported:boolean;thinking_control?:string;thinking_efforts:string[];thinking_can_disable:boolean;reasoning_summary?:string;reasoning_context?:string }
export function normalizeEfforts(values:any):string[]{return Array.isArray(values)?[...new Set(values.map(item=>typeof item==='string'?item:item?.effort).filter((item):item is string=>typeof item==='string'&&Boolean(item.trim())).map(item=>item.trim()))]:[];}
export function thinkingCapability(item:any,codex=false):ThinkingCapability{
  const result:ThinkingCapability={thinking_supported:false,thinking_efforts:[],thinking_can_disable:false};
  if(codex){const efforts=normalizeEfforts(item.supported_reasoning_levels);return{thinking_supported:Boolean(efforts.length),thinking_control:efforts.length?'reasoning':undefined,thinking_efforts:efforts.filter(value=>value!=='none'),thinking_can_disable:efforts.includes('none'),reasoning_summary:efforts.length&&item.supports_reasoning_summary_parameter!==false?'detailed':undefined,reasoning_context:efforts.length&&item.use_responses_lite?'all_turns':undefined};}
  const descriptor=item.reasoning;
  if(descriptor&&typeof descriptor==='object'){const efforts=descriptor.supported_efforts===null?['low','medium','high']:normalizeEfforts(descriptor.supported_efforts);const disabled=descriptor.mandatory!==true&&(descriptor.mandatory===false||efforts.includes('none'));return{thinking_supported:true,thinking_control:efforts.length||disabled?'reasoning':undefined,thinking_efforts:efforts.filter(value=>value!=='none'),thinking_can_disable:disabled};}
  const capability=item.capabilities?.reasoning;if(capability&&typeof capability==='object'){const efforts=normalizeEfforts(capability.allowed_options);return{thinking_supported:true,thinking_control:efforts.length?'reasoning_effort':undefined,thinking_efforts:efforts.filter(value=>value!=='none'),thinking_can_disable:efforts.includes('none')};}
  if(typeof capability==='boolean')return{...result,thinking_supported:capability};
  if(item.capabilities?.thinking===true)return{...result,thinking_supported:true};
  if(typeof descriptor==='boolean')return{...result,thinking_supported:descriptor};
  if(item.supported_parameters?.some((parameter:any)=>['reasoning_effort','reasoning','include_reasoning','thinking','thinking_budget'].includes(parameter)))return{...result,thinking_supported:true};
  return result;
}
export function thinkingFromProps(props:any):ThinkingCapability{
  const template=String(props.chat_template||'');const caps=props.chat_template_caps||{};const effort=caps.supports_reasoning_effort===true||/\breasoning_effort\b/.test(template);const disabled=caps.supports_enable_thinking===true||/\benable_thinking\b/.test(template);
  return{thinking_supported:effort||disabled||caps.supports_thinking===true||caps.supports_preserve_reasoning===true||/<think>|<thinking>|reasoning_content|redacted_thinking|\bthinking_budget\b|channel.{0,10}(analysis|thought)/i.test(template),thinking_control:effort||disabled?'chat_template':undefined,thinking_efforts:effort?['low','medium','high']:[],thinking_can_disable:disabled};
}
export function visionCapability(item:any,style='openai'):boolean|undefined{
  for(const key of['vision','image','multimodal'])if(typeof item.capabilities?.[key]==='boolean')return item.capabilities[key];
  if(Array.isArray(item.capabilities)&&item.capabilities.some((value:any)=>typeof value==='string'&&/^(vision|image|images|multimodal)$/i.test(value)))return true;
  const hasImage=(value:any):boolean=>Array.isArray(value)?value.some(hasImage):typeof value==='string'&&/image|vision/i.test(value);
  if([item.input_modalities,item.modalities,item.modality,item.architecture?.input_modalities,item.architecture?.modality,item.architecture?.modalities].some(hasImage))return true;
  return style==='anthropic'?true:undefined;
}
export function contextCapability(item:any):number|undefined{
  for(const object of[item,item.meta,item.metadata,item.architecture])for(const key of['context_length','context_window','context_window_tokens','max_model_len','max_context_length','n_ctx','n_ctx_train']){const value=object?.[key];if(typeof value==='number'&&value>0)return value;}return undefined;
}
export function applyThinkingControl(payload:any,model?:any):void{
  const requested=payload.thinking_effort;delete payload.thinking_effort;if(typeof requested!=='string'||!model)return;
  const effort=requested==='off'&&model.thinking_can_disable?'none':model.thinking_efforts?.includes(requested)?requested:undefined;if(!effort)return;
  if(model.thinking_control==='reasoning'){payload.reasoning={effort,...(effort!=='none'&&model.reasoning_summary?{summary:model.reasoning_summary}:{}),...(effort!=='none'&&model.reasoning_context?{context:model.reasoning_context}:{})};}
  else if(model.thinking_control==='reasoning_effort')payload.reasoning_effort=effort;
  else if(model.thinking_control==='chat_template'){payload.chat_template_kwargs={...(payload.chat_template_kwargs||{}),enable_thinking:effort!=='none',...(effort!=='none'?{reasoning_effort:effort}:{})};}
}
