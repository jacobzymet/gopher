/**
 * Model capabilities read from catalog entries: whether and how thinking can be controlled,
 * image input, and context length. Each provider family describes these differently.
 */

type Entry = Record<string, unknown>;
export interface ThinkingCapability {
  thinking_supported: boolean; thinking_control?: string; thinking_efforts: string[]; thinking_can_disable: boolean;
  reasoning_summary?: string; reasoning_context?: string;
}
/** The catalog fields applyThinkingControl reads. */
export interface ThinkingModel { thinking_control?: string; thinking_efforts?: string[]; thinking_can_disable?: boolean;
  reasoning_summary?: string; reasoning_context?: string }

const asEntry = (value: unknown): Entry => (value && typeof value === 'object' && !Array.isArray(value)
  ? value as Entry : {});
const THINKING_PARAMETERS = ['reasoning_effort', 'reasoning', 'include_reasoning', 'thinking', 'thinking_budget'];
const CONTEXT_KEYS = ['context_length', 'context_window', 'context_window_tokens', 'max_model_len',
  'max_context_length', 'n_ctx', 'n_ctx_train'];

/** Unique, trimmed effort names from strings or `{ effort }` objects. */
export function normalizeEfforts(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const names = values.map(item => (typeof item === 'string' ? item : asEntry(item).effort))
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim());
  return [...new Set(names)];
}

function codexThinking(item: Entry): ThinkingCapability {
  const efforts = normalizeEfforts(item.supported_reasoning_levels);
  const supported = efforts.length > 0;
  return {
    thinking_supported: supported, thinking_control: supported ? 'reasoning' : undefined,
    thinking_efforts: efforts.filter(value => value !== 'none'), thinking_can_disable: efforts.includes('none'),
    reasoning_summary: supported && item.supports_reasoning_summary_parameter !== false ? 'detailed' : undefined,
    reasoning_context: supported && item.use_responses_lite ? 'all_turns' : undefined,
  };
}

export function thinkingCapability(raw: unknown, codex = false): ThinkingCapability {
  const item = asEntry(raw);
  const none: ThinkingCapability = { thinking_supported: false, thinking_efforts: [], thinking_can_disable: false };
  if (codex) return codexThinking(item);
  const descriptor = item.reasoning;
  if (descriptor && typeof descriptor === 'object') {
    const entry = asEntry(descriptor);
    const efforts = entry.supported_efforts === null
      ? ['low', 'medium', 'high'] : normalizeEfforts(entry.supported_efforts);
    const disabled = entry.mandatory !== true && (entry.mandatory === false || efforts.includes('none'));
    return {
      thinking_supported: true, thinking_control: efforts.length || disabled ? 'reasoning' : undefined,
      thinking_efforts: efforts.filter(value => value !== 'none'), thinking_can_disable: disabled,
    };
  }
  const capabilities = asEntry(item.capabilities);
  const capability = capabilities.reasoning;
  if (capability && typeof capability === 'object') {
    const efforts = normalizeEfforts(asEntry(capability).allowed_options);
    return {
      thinking_supported: true, thinking_control: efforts.length ? 'reasoning_effort' : undefined,
      thinking_efforts: efforts.filter(value => value !== 'none'), thinking_can_disable: efforts.includes('none'),
    };
  }
  if (typeof capability === 'boolean') return { ...none, thinking_supported: capability };
  if (capabilities.thinking === true) return { ...none, thinking_supported: true };
  if (typeof descriptor === 'boolean') return { ...none, thinking_supported: descriptor };
  const parameters = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
  if (parameters.some(parameter => THINKING_PARAMETERS.includes(parameter as string))) return { ...none,
    thinking_supported: true };
  return none;
}

/** llama.cpp exposes its chat template; its controls reveal whether thinking can be toggled or tuned. */
export function thinkingFromProps(raw: unknown): ThinkingCapability {
  const props = asEntry(raw);
  const template = String(props.chat_template || '');
  const caps = asEntry(props.chat_template_caps);
  const effort = caps.supports_reasoning_effort === true || /\breasoning_effort\b/.test(template);
  const disabled = caps.supports_enable_thinking === true || /\benable_thinking\b/.test(template);
  const mentionsThinking = /<think>|<thinking>|reasoning_content|redacted_thinking|\bthinking_budget\b|channel.{0,10}(analysis|thought)/i;
  return {
    thinking_supported: effort || disabled || caps.supports_thinking === true
      || caps.supports_preserve_reasoning === true
      || mentionsThinking.test(template),
    thinking_control: effort || disabled ? 'chat_template' : undefined,
    thinking_efforts: effort ? ['low', 'medium', 'high'] : [], thinking_can_disable: disabled,
  };
}

export function visionCapability(raw: unknown, style = 'openai'): boolean | undefined {
  const item = asEntry(raw), capabilities = item.capabilities;
  for (const key of ['vision', 'image', 'multimodal']) {
    const value = asEntry(capabilities)[key];
    if (typeof value === 'boolean') return value;
  }
  const imageName = (value: unknown) => typeof value === 'string' && /^(vision|image|images|multimodal)$/i.test(value);
  if (Array.isArray(capabilities) && capabilities.some(imageName)) return true;
  const hasImage = (value: unknown): boolean => (Array.isArray(value)
    ? value.some(hasImage) : typeof value === 'string' && /image|vision/i.test(value));
  const architecture = asEntry(item.architecture);
  const modalities = [item.input_modalities, item.modalities, item.modality, architecture.input_modalities,
    architecture.modality, architecture.modalities];
  if (modalities.some(hasImage)) return true;
  return style === 'anthropic' ? true : undefined;
}

export function contextCapability(raw: unknown): number | undefined {
  const item = asEntry(raw);
  for (const object of [item, asEntry(item.meta), asEntry(item.metadata), asEntry(item.architecture)]) {
    for (const key of CONTEXT_KEYS) {
      const value = object[key];
      if (typeof value === 'number' && value > 0) return value;
    }
  }
  return undefined;
}

/**
 * Translate the client's thinking choice into the control the model advertises, and remove the
 * client field. Unsupported choices are dropped rather than sent.
 */
export function applyThinkingControl(payload: Record<string, unknown>, model?: ThinkingModel): void {
  const requested = payload.thinking_effort;
  delete payload.thinking_effort;
  if (typeof requested !== 'string' || !model) return;
  const effort = requested === 'off' && model.thinking_can_disable
    ? 'none' : model.thinking_efforts?.includes(requested) ? requested : undefined;
  if (!effort) return;
  const on = effort !== 'none';
  if (model.thinking_control === 'reasoning') {
    payload.reasoning = {
      effort, ...(on && model.reasoning_summary ? { summary: model.reasoning_summary } : {}),
      ...(on && model.reasoning_context ? { context: model.reasoning_context } : {}),
    };
  } else if (model.thinking_control === 'reasoning_effort') payload.reasoning_effort = effort;
  else if (model.thinking_control === 'chat_template') {
    const existing = asEntry(payload.chat_template_kwargs);
    payload.chat_template_kwargs = { ...existing, enable_thinking: on, ...(on ? { reasoning_effort: effort } : {}) };
  }
}
