function getProject(id: string | null | undefined) {
  if (!id) return null;
  return projects.find((project) => project.id === id) || null;
}

/** Project for the active conversation, else the sidebar project context. */
function currentProjectId() {
  const convo = conversations.find((item) => item.id === activeId);
  if (convo && convo.projectId) return convo.projectId;
  return activeProjectId;
}

/** Local date and clock so the model knows the current time of day. */
function formatPromptToday(now = new Date()) {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'short' });
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const tzHours = String(Math.floor(abs / 60)).padStart(2, '0');
  const tzMinutes = String(abs % 60).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute} (${weekday}, UTC${sign}${tzHours}:${tzMinutes})`;
}

function buildTimePrompt() {
  const P = window.GOPHER_PROMPTS || {};
  const fill = window.fillPrompt || ((t) => t);
  return fill(P['chat.today'] || 'Now: {{today}}', { today: formatPromptToday() });
}

function buildSystemPrompt(projectIdOverride: string | null | undefined, opts: SystemPromptOptions = {}) {
  const convo = opts.convo || null;
  const temporary = convo ? !!convo.incognito
    : typeof isIncognitoContext === 'function' && isIncognitoContext();
  const speakerBot = opts.speakerBot || opts.speakerBot || null;
  const P = window.GOPHER_PROMPTS || {};
  const fill = window.fillPrompt || ((t) => t);
  const parts = [];
  const name = settings.name.trim();
  const about = settings.about.trim();
  const instructions = settings.instructions.trim();
  const globalMemory = typeof settings.memory === 'string' ? settings.memory.trim() : '';

  const project = getProject(
    projectIdOverride !== undefined ? projectIdOverride : currentProjectId()
  );
  const projectOnly = !!(project && project.memoryMode === 'project_only');

  if (name) parts.push(fill(P['chat.userName'], { name }));
  if (about) parts.push(fill(P['chat.userAbout'], { about }));

  // ChatGPT-style: project instructions override global custom instructions.
  if (project) {
    const projectInstructions = project.instructions.trim();
    if (projectInstructions) {
      parts.push(fill(P['chat.projectInstructions'], {
        name: project.name,
        instructions: projectInstructions,
      }));
    } else if (instructions) {
      parts.push(fill(P['chat.globalInstructions'], { instructions }));
    }
  } else if (instructions) {
    parts.push(fill(P['chat.globalInstructions'], { instructions }));
  }

  if (!temporary && !projectOnly) {
    parts.push(fill(P['chat.globalMemory'], {
      memory: globalMemory || '(empty)',
    }));
  }

  if (project && !temporary) {
    const memory = project.memory.trim();
    const scopeNote = projectOnly
      ? (P['chat.projectMemoryScopeProjectOnly'] || '')
      : (P['chat.projectMemoryScopeDefault'] || '');
    parts.push(fill(P['chat.projectMemory'], {
      name: project.name,
      scope_note: scopeNote,
      memory: memory || '(empty)',
    }));

  }

  if (convo && !temporary && typeof botSystemPromptParts === 'function') {
    botSystemPromptParts(convo, speakerBot).forEach((part) => {
      if (part) parts.push(part);
    });
  }

  const base = P['chat.base'] || 'You are a helpful assistant.';
  if (opts.includeTime !== false) parts.push(buildTimePrompt());
  return [base, ...parts].filter(Boolean).join('\n\n');
}

function messagePlainExcerpt(message: ChatMessage | undefined, maxChars: number) {
  if (!message) return '';
  let content = typeof message.content === 'string' ? message.content : '';
  if (!content && Array.isArray(message.content)) {
    content = message.content
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (part && typeof (part as { text?: unknown }).text === 'string') return (part as { text: string }).text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (message.role === 'assistant') {
    content = stripThinkingTags(content);
  }
  content = String(content || '')
    .replace(/<\/?(?:global_)?memory_update>/gi, '')
    .replace(/<\/?bot_(?:hold|resume|dm_user|group_post|memory_update)\b[^>]*>/gi, '')
    .replace(/<\/?group_memory_update>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!content) return '';
  if (content.length > maxChars) return content.slice(0, Math.max(0, maxChars - 1)) + '…';
  return content;
}

function emptyBotActions(): BotActions {
  return { hold: false, resume: false, dmUser: null, groupPost: null };
}

function mergeBotActions(into: BotActions, extra: Partial<BotActions> | null | undefined) {
  if (!extra) return into;
  if (extra.hold) into.hold = true;
  if (extra.resume) into.resume = true;
  if (extra.dmUser) into.dmUser = extra.dmUser;
  if (extra.groupPost) into.groupPost = extra.groupPost;
  return into;
}

function extractTaggedBlock(source: string, names: string[]) {
  const list = Array.isArray(names) ? names : [names];
  let cleaned = source;
  let captured: string | null = null;
  list.forEach((name) => {
    const re = new RegExp(
      '<' + name + '\\b[^>]*>\\s*([\\s\\S]*?)\\s*</' + name + '>',
      'gi'
    );
    cleaned = cleaned.replace(re, (_: string, body: string) => {
      const next = String(body || '').trim();
      if (next) captured = next;
      return '';
    });
    const wrap = new RegExp('\\[\\[' + name + '\\]\\]\\s*([\\s\\S]*?)\\s*\\[\\[/' + name + '\\]\\]', 'gi');
    cleaned = cleaned.replace(wrap, (_: string, body: string) => {
      const next = String(body || '').trim();
      if (next) captured = next;
      return '';
    });
  });
  return { cleaned, captured };
}

/**
 * Pull memory update blocks and bot coordination tags out of assistant text.
 * While streaming, hide an unclosed opener so the XML never flashes in the UI.
 */
function applyMemoryUpdateProtocol(text: string, { streaming = false } = {}): MemoryExtraction {
  let cleaned = text || '';
  let memory: string | null = null;
  let globalMemory: string | null = null;
  let botMemory: string | null = null;
  let groupMemory: string | null = null;
  const botActions = emptyBotActions();
  cleaned = cleaned.replace(/<global_memory_update>\s*([\s\S]*?)\s*<\/global_memory_update>/gi, (_: string, body: string) => {
    const next = String(body || '').trim();
    if (next) globalMemory = next;
    return '';
  });
  cleaned = cleaned.replace(/<memory_update>\s*([\s\S]*?)\s*<\/memory_update>/gi, (_: string, body: string) => {
    const next = String(body || '').trim();
    if (next) memory = next;
    return '';
  });
  cleaned = cleaned.replace(/<bot_memory_update>\s*([\s\S]*?)\s*<\/bot_memory_update>/gi, (_: string, body: string) => {
    const next = String(body || '').trim();
    if (next) botMemory = next;
    return '';
  });
  cleaned = cleaned.replace(/<group_memory_update>\s*([\s\S]*?)\s*<\/group_memory_update>/gi, (_: string, body: string) => {
    const next = String(body || '').trim();
    if (next) groupMemory = next;
    return '';
  });
  if (/<bot_hold\b[^>]*\/?\s*>|\[\[hold\]\]/i.test(cleaned)) botActions.hold = true;
  if (/<bot_resume\b[^>]*\/?\s*>|\[\[resume\]\]/i.test(cleaned)) botActions.resume = true;
  cleaned = cleaned.replace(/<bot_hold\b[^>]*\/?\s*>\s*(?:<\/bot_hold>)?/gi, '');
  cleaned = cleaned.replace(/<bot_resume\b[^>]*\/?\s*>\s*(?:<\/bot_resume>)?/gi, '');
  cleaned = cleaned.replace(/\[\[hold\]\]/gi, '');
  cleaned = cleaned.replace(/\[\[resume\]\]/gi, '');
  const dm = extractTaggedBlock(cleaned, ['bot_dm_user', 'dm_user']);
  cleaned = dm.cleaned;
  if (dm.captured) botActions.dmUser = dm.captured;
  const post = extractTaggedBlock(cleaned, ['bot_group_post', 'group_post']);
  cleaned = post.cleaned;
  if (post.captured) botActions.groupPost = post.captured;
  if (streaming) {
    const lower = cleaned.toLowerCase();
    const tags = [
      '<global_memory_update>',
      '<memory_update>',
      '<bot_memory_update>',
      '<group_memory_update>',
      '<bot_hold',
      '<bot_resume',
      '<bot_dm_user',
      '<bot_group_post',
      '[[hold]]',
      '[[resume]]',
      '[[dm_user]]',
      '[[group_post]]',
    ];
    let open = -1;
    tags.forEach((tag) => {
      const at = lower.lastIndexOf(tag);
      if (at > open) open = at;
    });
    if (open !== -1) cleaned = cleaned.slice(0, open);
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trimEnd();
  return { cleaned, memory, globalMemory, botMemory, groupMemory, botActions };
}

function projectIsProjectOnly(projectId: string | null | undefined) {
  const project = getProject(projectId);
  return !!(project && project.memoryMode === 'project_only');
}

function persistGlobalMemory(memoryText: string) {
  const next = String(memoryText || '');
  if ((settings.memory || '') === next) return false;
  saveSettings({ ...settings, memory: next });
  const el = (document.getElementById('settingMemory') as HTMLTextAreaElement);
  if (el) el.value = next;
  if (settingsModal && !settingsModal.classList.contains('is-hidden')) {
    syncSettingsSaveButton();
  }
  return true;
}

function persistProjectMemory(projectId: string, memoryText: string) {
  const project = getProject(projectId);
  if (!project) return false;
  if ((project.memory || '') === String(memoryText || '')) return false;
  project.memory = memoryText;
  project.updatedAt = Date.now();
  saveStore();
  if (editingProjectId === projectId && !projectModal.classList.contains('is-hidden')) {
    (document.getElementById('projectMemory') as HTMLTextAreaElement).value = memoryText;
  }
  if (mainView === 'projects') renderProjectsPage();
  return true;
}

function applyExtractedMemories(convo: Conversation, extracted: MemoryExtraction | null | undefined, speakerBotId: string | null = null) {
  const result = { globalUpdated: false, projectUpdated: false, botUpdated: false, groupUpdated: false };
  if (!extracted || convo?.incognito) return result;
  if (extracted.memory != null && convo.projectId) {
    result.projectUpdated = persistProjectMemory(convo.projectId, extracted.memory);
  }
  if (extracted.globalMemory != null && !projectIsProjectOnly(convo.projectId)) {
    result.globalUpdated = persistGlobalMemory(extracted.globalMemory);
  }
  if (extracted.botMemory != null && speakerBotId && typeof persistBotMemory === 'function') {
    result.botUpdated = persistBotMemory(speakerBotId, extracted.botMemory, convo);
  }
  if (extracted.groupMemory != null && typeof persistGroupMemory === 'function' && typeof isBotGroup === 'function' && isBotGroup(convo)) {
    result.groupUpdated = persistGroupMemory(convo, extracted.groupMemory);
  }
  return result;
}

function collectTurnMemoryExtraction(stream: ActiveStream | null | undefined, finalText: string) {
  const chunks = [];
  for (const part of stream?.timeline || []) {
    if (!part) continue;
    if (part.type === 'text' || part.type === 'think') {
      const content = String(part.content || '');
      if (content) chunks.push(content);
    }
  }
  if (finalText) chunks.push(String(finalText));
  const fromAll = applyMemoryUpdateProtocol(chunks.join('\n\n'), { streaming: false });
  for (const part of stream?.timeline || []) {
    if (!part || (part.type !== 'text' && part.type !== 'think')) continue;
    part.content = applyMemoryUpdateProtocol(String(part.content || ''), { streaming: false }).cleaned;
  }
  const fromFinal = applyMemoryUpdateProtocol(String(finalText || ''), { streaming: false });
  return {
    cleaned: fromFinal.cleaned,
    memory: fromAll.memory,
    globalMemory: fromAll.globalMemory,
    botMemory: fromAll.botMemory,
    groupMemory: fromAll.groupMemory,
    botActions: mergeBotActions(fromAll.botActions || emptyBotActions(), fromFinal.botActions),
  };
}

function memoryNoticeLabels(changes: Partial<MemoryChanges> | null | undefined) {
  const labels = [];
  if (changes?.globalUpdated) labels.push('Updated long-term memory');
  if (changes?.projectUpdated) labels.push('Updated project memory');
  if (changes?.botUpdated) labels.push('Updated bot memory');
  if (changes?.groupUpdated) labels.push('Updated group notes');
  return labels;
}

function memoryOnlyAssistantFallback(extracted: MemoryExtraction | null | undefined) {
  if (!extracted) return '';
  if (extracted.botActions?.dmUser) return 'Opened a private thread.';
  if (extracted.botActions?.groupPost) return 'Posted in the group.';
  if (extracted.botActions?.hold) return 'Holding the room.';
  if (extracted.botActions?.resume) return 'Resuming the room.';
  const projectHit = extracted.memory != null;
  const globalHit = extracted.globalMemory != null;
  const botHit = extracted.botMemory != null;
  const groupHit = extracted.groupMemory != null;
  if (projectHit && globalHit) return 'Updated memory.';
  if (projectHit) return 'Updated project memory.';
  if (globalHit) return 'Updated long-term memory.';
  if (botHit && groupHit) return 'Updated memory.';
  if (botHit) return 'Updated bot memory.';
  if (groupHit) return 'Updated group notes.';
  return '';
}

function mentionOptionById(id: string) {
  return MENTION_OPTIONS.find((item) => item.id === id) || null;
}

/** Strip capability mentions; returns { text, mentions: Set<string> }. */
function parseCapabilityMentions(raw: string) {
  const mentions = new Set<string>();
  const source = String(raw || '');
  source.replace(MENTION_TOKEN_RE, (token) => {
    const id = token.slice(1).toLowerCase();
    if (id === 'agent') {
      // Legacy @agent → treat as all built-in capabilities for this message.
      mentions.add('web_search');
      mentions.add('fetch_url');
    } else if (MENTION_IDS.includes(id)) {
      mentions.add(id);
    }
    return token;
  });
  const text = source
    .replace(/(^|\s)@(?:web_search|fetch_url|deep_research|agent)\b/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text: text || source.trim(), mentions };
}
