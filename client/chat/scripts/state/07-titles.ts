function provisionalTitle(text: string) {
  const src = String(text || '').replace(/\s+/g, ' ').trim() || 'New chat';
  return src.length > 48 ? src.slice(0, 48).trim() + '…' : src;
}

function branchConversationTitle(source: Conversation | undefined) {
  if (source?.incognito) return 'Ghost Chat';
  const base = String(source?.title || '').trim() || 'chat';
  return provisionalTitle('Branch · ' + base);
}

function cloneConversationMessages(messages: ChatMessage[]): ChatMessage[] {
  const list = Array.isArray(messages) ? messages : [];
  try {
    return structuredClone(list);
  } catch {
    return JSON.parse(JSON.stringify(list));
  }
}

function canBranchFromActiveConversation() {
  const convo = conversations.find((item) => item.id === activeId);
  return !!(convo && Array.isArray(convo.messages) && convo.messages.length > 0);
}

async function requestGeneratedTitle(userText: string, modelId?: string) {
  const body: Record<string, unknown> = { message: String(userText || '').trim() };
  const remote = selectedRemoteModel(latestState, modelId);
  if (!remote?.ready || !remote.model || (!remote.provider_id && !remote.base)) {
    const error = new Error('The chat model is unavailable for title generation');
    error.retryable = false;
    throw error;
  }
  body.remote_base = remote.base;
  if (remote.provider_id) body.provider_id = remote.provider_id;
  body.model = remote.model;
  const response = await fetch('/api/chat/title', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50000),
  });
  if (!response.ok) {
    const problem: { error?: string } = await response.json().catch(() => ({}));
    const error = new Error(problem.error || 'Could not generate title');
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }
  const payload: { title?: unknown } = await response.json();
  const title = String(payload.title || '').trim();
  if (!title) throw new Error('empty title');
  return title;
}

function firstUserText(convo: Conversation) {
  const msg = (convo?.messages || []).find((item) => item.role === 'user');
  if (!msg) return '';
  const fromContent = typeof msg.content === 'string'
    ? parseCapabilityMentions(msg.content).text.trim()
    : '';
  if (fromContent && fromContent !== '(attachment)') return fromContent;
  const fromDisplay = parseCapabilityMentions(String(msg.displayText || '')).text.trim();
  if (fromDisplay && fromDisplay !== '(attachment)') return fromDisplay;
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  return attachments
    .map((attachment) => {
      const name = String(attachment?.name || '').trim();
      const extracted = String(attachment?.extractedText || '').replace(/\s+/g, ' ').trim();
      return [name, extracted].filter(Boolean).join(': ');
    })
    .filter(Boolean)
    .join(' ')
    .trim();
}

function needsGeneratedTitle(convo: Conversation) {
  if (!convo || convo.incognito) return false;
  if (typeof isBotsConvo === 'function' && isBotsConvo(convo)) return false;
  if (convo.titleEdited || convo.titleStatus === 'edited') return false;
  if (convo.titleStatus === 'generated' || convo.titleStatus === 'fallback') return false;
  const userText = firstUserText(convo);
  if (!userText) return false;
  if (convo.titleStatus === 'pending') return true;
  const current = String(convo.title || '').trim();
  if (!current || current === 'New chat') return true;
  // Still the provisional first-message slug — replace with a model title.
  return current === provisionalTitle(userText)
    || current === provisionalTitle(String(
      (convo.messages || []).find((item) => item.role === 'user')?.content || ''
    ));
}

/** @type {Map<HTMLElement, number>} */
const titleTypeTimers = new Map<HTMLElement, number>();

function titleTypeHost(el: { querySelector: (arg0: string) => HTMLElement; }) {
  return (el?.querySelector?.(':scope > .convo-title-text') as HTMLElement) || el;
}

function stopTitleTyping(el: HTMLElement) {
  if (!el) return;
  const host = titleTypeHost(el);
  const timer = titleTypeTimers.get(host) || titleTypeTimers.get(el);
  if (timer) {
    clearTimeout(timer);
    titleTypeTimers.delete(host);
    titleTypeTimers.delete(el);
  }
  host.classList.remove('is-typing-title');
  el.classList.remove('is-typing-title');
  (host.querySelector('.title-typing-caret') as HTMLElement)?.remove();
}

function typeTitleInto(el: HTMLElement, fullText: string) {
  if (!el) return;
  const host = titleTypeHost(el);
  stopTitleTyping(el);
  const text = String(fullText || '');
  if (!text) {
    host.textContent = '';
    return;
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    host.textContent = text;
    return;
  }
  host.classList.add('is-typing-title');
  if (host !== el) el.classList.add('is-typing-title');
  host.textContent = '';
  const textNode = document.createTextNode('');
  const caret = (document.createElement('span') as HTMLElement);
  caret.className = 'title-typing-caret';
  caret.setAttribute('aria-hidden', 'true');
  host.append(textNode, caret);
  let i = 0;
  const tick = () => {
    i += 1;
    textNode.data = text.slice(0, i);
    if (i < text.length) {
      const delay = i === 1 ? 40 : 22 + Math.floor(Math.random() * 28);
      const id = window.setTimeout(tick, delay);
      titleTypeTimers.set(host, id);
    } else {
      titleTypeTimers.delete(host);
      titleTypeTimers.delete(el);
      host.classList.remove('is-typing-title');
      el.classList.remove('is-typing-title');
      caret.remove();
    }
  };
  tick();
}

function revealGeneratedTitle(convo: Conversation, title: string) {
  const sidebarLabel = title;
  let sidebarEl = (document.querySelector(
    '.convo-item[data-convo-id="' + CSS.escape(convo.id) + '"] .convo-title'
  ) as HTMLElement);
  if (!sidebarEl) {
    renderSidebar();
    sidebarEl = (document.querySelector(
      '.convo-item[data-convo-id="' + CSS.escape(convo.id) + '"] .convo-title'
    ) as HTMLElement);
  }
  if (sidebarEl) {
    setIdentityTitle(sidebarEl, title);
    const row = (sidebarEl.closest('.convo-item') as HTMLElement);
    if (row) setIdentityTitle(row, title);
    typeTitleInto(sidebarEl, sidebarLabel);
  } else renderSidebar();
  if (activeId === convo.id && convoTitleEl && !convo.incognito) {
    typeTitleInto(convoTitleEl, title);
  }
  if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
}

const TITLE_RETRY_DELAYS = [500, 2000, 8000];
/** @type {Map<string, number>} */
const titleRetryTimers = new Map<string, number>();

function clearConversationTitleTimer(convoId: string) {
  const timer = titleRetryTimers.get(convoId);
  if (timer) window.clearTimeout(timer);
  titleRetryTimers.delete(convoId);
}

function fallbackConversationTitle(convo: Conversation, userText: string) {
  let text = String(userText || firstUserText(convo) || '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*`_\-\s]+/, '')
    .trim();
  text = text.replace(/^please\s+/i, '');
  text = text.replace(
    /^(?:can you\s+|could you\s+|would you\s+|help me\s+|i (?:want|need) (?:you )?to\s+)/i,
    ''
  );
  const words = text.split(/\s+/).filter(Boolean).slice(0, 6);
  const title = words.join(' ')
    .replace(/[.,!?;:]+$/g, '')
    .trim();
  const bounded = Array.from(title || 'New chat').slice(0, 60).join('').trim();
  return bounded || 'New chat';
}

function conversationTitleProviderBusy(convo: Conversation) {
  if (!convo) return false;
  if (conversations.some((item) => item !== convo && item._titleBusy)) return true;
  if (typeof activeStreams !== 'undefined' && activeStreams.size > 0) return true;
  if (typeof outboundStarting !== 'undefined' && outboundStarting.size > 0) return true;
  if (typeof isConvoBusy === 'function' && isConvoBusy(convo.id)) return true;
  return false;
}

function maybeEnsureConversationTitle(convo: Conversation, { delay }: { delay?: number } = {}) {
  if (!needsGeneratedTitle(convo)) return;
  if (!convo.titleStatus) {
    convo.titleStatus = 'pending';
    convo.titleAttempts = 0;
    saveConversations();
  }
  if (convo._titleBusy || titleRetryTimers.has(convo.id)) return;
  const attempt = Math.max(0, Math.min(2, Number(convo.titleAttempts) || 0));
  const wait = Number.isFinite(delay) ? Math.max(0, delay as number) : TITLE_RETRY_DELAYS[attempt];
  const timer = window.setTimeout(() => {
    titleRetryTimers.delete(convo.id);
    if (!conversations.includes(convo)) return;
    if (!needsGeneratedTitle(convo)) return;
    if (conversationTitleProviderBusy(convo)) {
      maybeEnsureConversationTitle(convo, { delay: TITLE_RETRY_DELAYS[0] });
      return;
    }
    generateConversationTitle(convo, firstUserText(convo));
  }, wait);
  titleRetryTimers.set(convo.id, timer);
}

function resumePendingConversationTitles() {
  if (!storageReady || !serverReady || diskEncryptionLocked()) return;
  let offset = 0;
  for (const convo of conversations) {
    if (!needsGeneratedTitle(convo)) continue;
    maybeEnsureConversationTitle(convo, { delay: TITLE_RETRY_DELAYS[0] + offset });
    offset += 250;
  }
}

function generateConversationTitle(convo: Conversation, userText: string) {
  if (convo?.incognito) return;
  const text = String(userText || firstUserText(convo) || '').trim();
  if (!convo || !text) return;
  if (convo._titleBusy) {
    return;
  }
  const requestId = (convo._titleReq = (convo._titleReq || 0) + 1);
  convo._titleBusy = true;
  convo.titleStatus = 'pending';
  convo.titleAttempts = (convo.titleAttempts || 0) + 1;
  saveConversations();
  void (async () => {
    let retry = false;
    try {
      const title = await requestGeneratedTitle(text, conversationModelId(convo));
      if (convo._titleReq !== requestId) return;
      if (!conversations.includes(convo)) return;
      convo.title = title;
      convo.titleStatus = 'generated';
      saveConversations();
      revealGeneratedTitle(convo, title);
    } catch (error) {
      if (convo._titleReq !== requestId) return;
      if (!conversations.includes(convo)) return;
      if (typeof diagnosticMark === 'function') diagnosticMark('title.failed', {
        modelId: conversationModelId(convo), message: (error as Error | null)?.message || String(error),
        attempt: convo.titleAttempts,
      }, { convoId: convo.id });
      if ((error as Error | null)?.retryable === false || (convo.titleAttempts || 0) >= TITLE_RETRY_DELAYS.length) {
        const fallback = fallbackConversationTitle(convo, text);
        convo.title = fallback;
        convo.titleStatus = 'fallback';
        saveConversations();
        revealGeneratedTitle(convo, fallback);
      } else {
        saveConversations();
        retry = true;
      }
    } finally {
      if (convo._titleReq === requestId) convo._titleBusy = false;
      if (retry && convo._titleReq === requestId) maybeEnsureConversationTitle(convo);
    }
  })();
}

// null = draft: nothing is written to storage until the first message is sent,
// so opening the page does not litter the sidebar with empty conversations.
let activeId: string | null = null;
let draftIncognito = false;
/** Project context for drafts / New chat. null = general Recents. */
let activeProjectId: string | null = null;
/** 'chat' | 'projects' | 'notifications' */
let mainView = 'chat';
/** 'chat' | 'bots' — wordmark surface. Bots is shown as Loops. */
let appSurface = 'chat';
let suppressUrlSync = false;
let editingProjectId: string | null = null;
let creatingProject = false;
let openConvoMenu: HTMLElement | null = null;
let serverReady = false;
/**
 * In-flight assistant turns keyed by conversation id.
 * Multiple chats can stream at once; the composer Stop/Send chrome follows
 * whichever conversation is currently active.
 * @type {Map<string, {
 *   controller: AbortController,
 *   useAgent: boolean,
 *   partial: string,
 *   timeline: Array<
 *     | {type:'think', content:string}
 *     | {type:'text', content:string}
 *     | {type:'notice', content:string}
 *     | {type:'tool', name:string, detail:string, result:string, note?:string, live:boolean}
 *   >,
 *   errorMessage: string|null,
 *   startedAt: number,
 *   statusLabel: string,
 *   domMountCount: number,
 *   dom: null|{row:HTMLElement,statusEl:HTMLElement,thinkingLabel:HTMLElement,traceEl:HTMLElement,answerEl:HTMLElement,thinkingOrb:OrbController},
 * }>}
 */
const activeStreams: Map<string, ActiveStream> = new Map();
/** @type {Map<string, Array<{
 *   id: string,
 *   editText: string,
 *   displayText: string,
 *   apiText: string|object,
 *   attachments: Array<object>,
 *   turn: { useAgent: boolean, skills: object, deepResearch: boolean, deepResearchOutput: string, forceTools: string[] }
 * }>>} */
const outboundQueues: Map<string, OutboundItem[]> = new Map();
/** Queue item id currently open in the in-thread editor, if any. */
let editingQueueId: string | null = null;
/** Remember pin state per conversation across switches. */
const stickByConvo: Map<string, boolean> = new Map();

