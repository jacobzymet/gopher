// Everyday workspace tools. All persisted drafts use the protected chat store.
let composerDraftContext = null;
let composerDraftTimer = null;
const transientComposerDrafts = new Map();
let workspaceConnectionFailures = 0;
let workspaceDisconnected = false;

function noteWorkspaceConnection(connected) {
  workspaceConnectionFailures = connected ? 0 : workspaceConnectionFailures + 1;
  const disconnected = workspaceConnectionFailures >= 3;
  if (disconnected === workspaceDisconnected) return;
  workspaceDisconnected = disconnected;
  document.getElementById('workspaceConnection')?.classList.toggle('is-hidden', !disconnected);
  updateSendEnabled();
}

function normalizeComposerDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const mentions = Array.isArray(raw.mentions)
    ? raw.mentions.filter((id) => typeof id === 'string').slice(0, 64) : [];
  const quote = typeof raw.quote === 'string' ? raw.quote : '';
  if (!text && !mentions.length && !quote && !raw.modelId && !raw.workspaceRoot) return null;
  return {
    text, mentions, quote,
    replyTarget: raw.replyTarget && typeof raw.replyTarget.speakerId === 'string'
      ? { speakerId: raw.replyTarget.speakerId, speakerHandle: String(raw.replyTarget.speakerHandle || '') } : null,
    modelId: typeof raw.modelId === 'string' ? raw.modelId : '',
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : '',
  };
}

function currentComposerDraftContext() {
  return {
    profileId: activeProfileId,
    key: activeId ? 'chat:' + activeId : 'new:' + appSurface + ':' + (activeProjectId || ''),
    incognito: isIncognitoContext(),
  };
}

function composerDraftMemoryKey(context) {
  return JSON.stringify([context.profileId, context.key, context.incognito]);
}

function captureComposerDraft() {
  const context = composerDraftContext;
  if (!context || diskEncryptionLocked()) return false;
  const profile = profiles.find((item) => item.id === context.profileId);
  if (!profile) return false;
  // A deleted chat or project must not leave a recoverable draft behind.
  const chatId = context.key.startsWith('chat:') ? context.key.slice(5) : null;
  if (chatId && !(profile.id === activeProfileId ? conversations : profile.conversations)
    .some((convo) => convo.id === chatId)) return false;
  const draft = normalizeComposerDraft({
    text: composerInput.value, mentions: [...composerMentionIds],
    quote: pendingReplyQuote, replyTarget: pendingReplyTarget,
    modelId: !activeId ? draftModelId : '',
    workspaceRoot: !activeId ? draftWorkspaceRoot : '',
  });
  const memoryKey = composerDraftMemoryKey(context);
  transientComposerDrafts.set(memoryKey, { draft, attachments: pendingAttachments.slice() });
  if (context.incognito) return false;
  if (!profile.composerDrafts) profile.composerDrafts = {};
  const previous = normalizeComposerDraft(profile.composerDrafts[context.key]);
  if (JSON.stringify(previous) === JSON.stringify(draft)) return false;
  if (draft) profile.composerDrafts[context.key] = draft;
  else delete profile.composerDrafts[context.key];
  return true;
}

function leaveComposerDraft() {
  if (typeof stopVoiceInput === 'function') stopVoiceInput({ silent: true });
  const changed = captureComposerDraft();
  clearTimeout(composerDraftTimer);
  composerDraftTimer = null;
  composerDraftContext = null;
  pendingAttachments = [];
  if (changed) saveStore({ immediate: false });
  closeThreadFind({ restoreFocus: false });
}

function restoreComposerDraft() {
  const context = currentComposerDraftContext();
  composerDraftContext = context;
  const memory = transientComposerDrafts.get(composerDraftMemoryKey(context));
  const profile = profiles.find((item) => item.id === context.profileId);
  const draft = normalizeComposerDraft(memory?.draft
    || (!context.incognito ? profile?.composerDrafts?.[context.key] : null));
  composerInput.value = draft?.text || '';
  pendingAttachments = memory?.attachments || [];
  composerMentionIds.clear();
  (draft?.mentions || []).forEach((id) => composerMentionIds.add(id));
  pendingReplyQuote = draft?.quote || '';
  pendingReplyTarget = draft?.replyTarget || null;
  if (!activeId && draft) {
    draftModelId = draft.modelId;
    draftWorkspaceRoot = draft.workspaceRoot;
    syncConversationModel();
    if (latestState && typeof updateInferenceState === 'function') updateInferenceState(latestState);
  }
  renderComposerMentions();
  renderComposerReply();
  renderPendingAttachments();
  autoResize(composerInput);
  if (typeof renderComposerModes === 'function') renderComposerModes();
  if (typeof paintWorkspaceField === 'function') paintWorkspaceField(workspaceRootValue(), { force: true });
  updateSendEnabled();
}

function discardSentComposerDraft() {
  clearTimeout(composerDraftTimer);
  composerDraftTimer = null;
  const context = composerDraftContext;
  if (!context) return;
  const profile = profiles.find((item) => item.id === context.profileId);
  if (profile?.composerDrafts) delete profile.composerDrafts[context.key];
  transientComposerDrafts.delete(composerDraftMemoryKey(context));
  composerDraftContext = null;
}

function scheduleComposerDraftSave() {
  clearTimeout(composerDraftTimer);
  if (!composerDraftContext || diskEncryptionLocked()) return;
  composerDraftTimer = setTimeout(() => {
    composerDraftTimer = null;
    if (captureComposerDraft()) saveStore({ immediate: false });
  }, 600);
}

function clearComposerDraftMemory() {
  clearTimeout(composerDraftTimer);
  composerDraftTimer = null;
  composerDraftContext = null;
  for (const { attachments } of transientComposerDrafts.values()) {
    attachments.forEach(disposePendingAttachment);
  }
  transientComposerDrafts.clear();
  closeThreadFind({ restoreFocus: false });
  if (typeof closeSearchModal === 'function') closeSearchModal();
  document.getElementById('searchModalResults')?.replaceChildren();
}

function removeComposerDrafts({ conversationIds = [], projectIds = [], surface = '', all = false } = {}) {
  const chats = new Set(conversationIds.map((id) => 'chat:' + id));
  const matches = (key) => all || chats.has(key)
    || (key.startsWith('new:') && (projectIds.includes(key.split(':').slice(2).join(':'))
      || (surface && key.startsWith('new:' + surface + ':'))));
  const profile = profiles.find((item) => item.id === activeProfileId);
  for (const key of Object.keys(profile?.composerDrafts || {})) {
    if (matches(key)) delete profile.composerDrafts[key];
  }
  for (const [key, memory] of transientComposerDrafts) {
    const [profileId, draftKey] = JSON.parse(key);
    if (profileId !== activeProfileId || !matches(draftKey)) continue;
    memory.attachments.forEach(disposePendingAttachment);
    transientComposerDrafts.delete(key);
  }
  if (composerDraftContext?.profileId === activeProfileId && matches(composerDraftContext.key)) {
    composerDraftContext = null;
    clearTimeout(composerDraftTimer);
    composerDraftTimer = null;
    composerInput.value = '';
    clearPendingAttachments();
    composerMentionIds.clear();
    clearPendingReplyQuote();
    autoResize(composerInput);
    renderComposerMentions();
  }
}

function hasComposerDrafts() {
  const profile = profiles.find((item) => item.id === activeProfileId);
  return !!(profile && Object.keys(composerDraftsForStore(profile)).length)
    || !!(composerDraftContext && (composerInput.value || pendingAttachments.length || pendingReplyQuote || composerMentionIds.size));
}

function composerDraftsForStore(profile) {
  const chats = new Set((profile.id === activeProfileId ? conversations : profile.conversations)
    .filter((convo) => !convo.incognito).map((convo) => 'chat:' + convo.id));
  const projectIds = new Set((profile.id === activeProfileId ? projects : profile.projects).map((project) => project.id));
  return Object.fromEntries(Object.entries(profile.composerDrafts || {}).flatMap(([key, raw]) => {
    const draft = normalizeComposerDraft(raw);
    const projectId = key.split(':').slice(2).join(':');
    const newDraft = /^new:(chat|bots):/.test(key) && (!projectId || projectIds.has(projectId));
    return draft && (chats.has(key) || newDraft) ? [[key, draft]] : [];
  }));
}

function messageSearchText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
}

function searchTerms(query) {
  return (String(query || '').match(/"[^"]+"|\S+/g) || [])
    .map((term) => term.replace(/^"|"$/g, '').toLocaleLowerCase()).filter(Boolean).slice(0, 16);
}

function searchExcerpt(text, terms, limit = 130) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const lower = value.toLocaleLowerCase();
  const indices = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const start = indices.length ? Math.max(0, Math.min(...indices) - 38) : 0;
  return (start ? '…' : '') + value.slice(start, start + limit) + (value.length > start + limit ? '…' : '');
}

function searchWorkspace(query, scope = 'all') {
  const terms = searchTerms(query);
  const matches = (value) => terms.every((term) => value.includes(term));
  const results = [];
  if (scope === 'all' || scope === 'projects') {
    for (const project of projects) {
      const title = project.name || 'Untitled project';
      const text = [title, project.instructions, project.memory].filter(Boolean).join('\n');
      if (!matches(text.toLocaleLowerCase())) continue;
      results.push({ kind: 'project', id: project.id, title,
        meta: terms.length ? searchExcerpt(text, terms) : conversationsForProject(project.id).length + ' chats',
        score: terms.length && matches(title.toLocaleLowerCase()) ? 100 : 15,
        updatedAt: project.updatedAt || 0 });
    }
  }
  if (scope === 'all' || scope === 'chats') {
    for (const convo of conversations) {
      if (convo.incognito) continue;
      const title = convo.title || 'New chat';
      const project = getProject(convo.projectId)?.name || '';
      const heading = (title + '\n' + project).toLocaleLowerCase();
      let messageIndex = null;
      let preview = '';
      // Search every message; take the best matching message instead of a giant joined transcript.
      for (let index = 0; index < (convo.messages || []).length; index += 1) {
        const message = convo.messages[index];
        if (!['user', 'assistant'].includes(message.role)) continue;
        const text = messageSearchText(message);
        if (!preview && message.role === 'user') preview = text;
        if (!terms.length && preview) break;
        if (terms.length && matches((heading + '\n' + text).toLocaleLowerCase())) {
          messageIndex = index;
          preview = text;
          if (matches(text.toLocaleLowerCase())) break;
        }
      }
      const titleMatch = matches(heading);
      if (terms.length && !titleMatch && messageIndex == null) continue;
      results.push({ kind: 'chat', id: convo.id, title, messageIndex: titleMatch ? null : messageIndex,
        meta: (convo.surface === 'bots' ? 'Loop · ' : '') + (project ? project + ' · ' : '') + searchExcerpt(preview || 'Empty chat', terms),
        score: terms.length ? (title.toLocaleLowerCase() === terms.join(' ') ? 130 : titleMatch ? 100 : 50) : 0,
        updatedAt: convo.updatedAt || 0 });
    }
  }
  return results.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
}

function highlightedSearchHtml(value, terms) {
  const text = String(value || '');
  if (!terms.length) return escapeHtml(text);
  const pattern = terms.slice().sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp(pattern, 'gi');
  let html = '';
  let offset = 0;
  for (const match of text.matchAll(regex)) {
    html += escapeHtml(text.slice(offset, match.index)) + '<mark>' + escapeHtml(match[0]) + '</mark>';
    offset = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(offset));
}

function startWorkspaceChat({ incognito = false } = {}) {
  leaveComposerDraft();
  persistAppSurface('chat');
  activeProjectId = null;
  startDraft({ incognito });
}

function workspaceActions() {
  const actions = [
    { id: 'new', title: 'New chat', meta: 'Start a conversation', shortcut: 'Mod+Shift+O', run: () => startWorkspaceChat() },
    { id: 'ghost', title: 'New ghost chat', meta: 'Temporary conversation, never saved', run: () => startWorkspaceChat({ incognito: true }) },
    { id: 'projects', title: 'Open projects', meta: 'Instructions, memory, and related chats', run: showProjectsView },
    { id: 'providers', title: 'Manage providers', meta: 'Connect a local or cloud model', run: () => openSettings('providers') },
    { id: 'settings', title: 'Open settings', meta: 'Personalize Gopher', shortcut: 'Mod+,', run: () => openSettings() },
  ];
  if (activeId) {
    actions.unshift({ id: 'find', title: 'Find in this chat', meta: 'Jump between matching passages', shortcut: 'Mod+F', run: openThreadFind });
    actions.push({ id: 'export', title: 'Export chat as Markdown', meta: 'Download this conversation', run: () => exportConversationMarkdown(activeId) });
  }
  return actions;
}

function conversationMarkdown(convo) {
  const title = String(convo.title || 'Chat').replace(/[\r\n]+/g, ' ');
  const sections = ['# ' + title];
  for (const message of convo.messages || []) {
    if (!['user', 'assistant'].includes(message.role)) continue;
    const speaker = message.role === 'user' ? 'You' : (message.speakerHandle ? '@' + message.speakerHandle : 'Gopher');
    sections.push('## ' + speaker.replace(/[\r\n]+/g, ' '));
    if (message.replyQuote) sections.push(String(message.replyQuote).split('\n').map((line) => '> ' + line).join('\n'));
    const content = messageSearchText(message);
    if (content) sections.push(content);
    for (const attachment of message.attachments || []) {
      const name = String(attachment.name || 'Attachment').replace(/[\r\n]+/g, ' ');
      sections.push('Attachment: ' + name);
    }
  }
  return sections.join('\n\n') + '\n';
}

function exportConversationMarkdown(id) {
  if (!requireUnlockedData()) return;
  const convo = conversations.find((item) => item.id === id);
  if (!convo) return;
  const url = URL.createObjectURL(new Blob([conversationMarkdown(convo)], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  const name = String(convo.title || 'chat').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 100) || 'chat';
  link.href = url;
  link.download = name + '.md';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

let threadFindMatches = [];
let threadFindIndex = -1;
let threadFindTimer = null;
let threadFindObserver = null;

function threadFindIsOpen() {
  const bar = document.getElementById('threadFind');
  return !!bar && !bar.classList.contains('is-hidden');
}

function clearThreadFindHighlights() {
  if (window.CSS?.highlights) {
    CSS.highlights.delete('gopher-find');
    CSS.highlights.delete('gopher-find-active');
  }
  chatThread.querySelectorAll('.is-find-match').forEach((row) => row.classList.remove('is-find-match'));
}

function closeThreadFind({ restoreFocus = true } = {}) {
  const bar = document.getElementById('threadFind');
  if (!bar) return;
  const hadFocus = bar.contains(document.activeElement);
  bar.classList.add('is-hidden');
  document.getElementById('btnFindInChat')?.setAttribute('aria-expanded', 'false');
  threadFindObserver?.disconnect();
  threadFindObserver = null;
  clearTimeout(threadFindTimer);
  threadFindTimer = null;
  clearThreadFindHighlights();
  threadFindMatches = [];
  threadFindIndex = -1;
  document.getElementById('threadFindInput').value = '';
  document.getElementById('threadFindCount').textContent = '';
  if (restoreFocus && hadFocus) composerInput.focus();
}

function openThreadFind() {
  if (!activeId || mainView !== 'chat' || !requireUnlockedData()) return;
  const bar = document.getElementById('threadFind');
  bar.classList.remove('is-hidden');
  document.getElementById('btnFindInChat')?.setAttribute('aria-expanded', 'true');
  const input = document.getElementById('threadFindInput');
  const selected = window.getSelection()?.toString().trim();
  if (selected && selected.length <= 200) input.value = selected;
  input.focus();
  input.select();
  refreshThreadFind();
  if (!threadFindObserver) {
    threadFindObserver = new MutationObserver(() => {
      if (threadFindTimer) return;
      threadFindTimer = setTimeout(() => {
        threadFindTimer = null;
        refreshThreadFind({ scroll: false });
      }, 180);
    });
    threadFindObserver.observe(chatThread, { childList: true, characterData: true, subtree: true });
  }
}

function refreshThreadFind({ scroll = true } = {}) {
  clearThreadFindHighlights();
  const query = document.getElementById('threadFindInput').value;
  const previousIndex = threadFindIndex;
  threadFindMatches = [];
  if (query) {
    for (const bubble of chatThread.querySelectorAll('.msg-bubble')) {
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement.closest('button, .think-block, .tool-block, .msg-attachments, [hidden], .is-hidden')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let text = '';
      while (walker.nextNode()) {
        nodes.push({ node: walker.currentNode, start: text.length });
        text += walker.currentNode.textContent;
      }
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      for (const found of text.matchAll(pattern)) {
        if (threadFindMatches.length >= 2000) break;
        const index = found.index;
        const start = nodes.findLast((item) => item.start <= index);
        const endOffset = index + found[0].length;
        const end = nodes.findLast((item) => item.start < endOffset);
        if (start && end) {
          const range = document.createRange();
          range.setStart(start.node, index - start.start);
          range.setEnd(end.node, endOffset - end.start);
          threadFindMatches.push({ range, row: bubble.closest('.msg') });
        }
      }
      if (threadFindMatches.length >= 2000) break;
    }
  }
  threadFindIndex = threadFindMatches.length ? Math.max(0, Math.min(previousIndex, threadFindMatches.length - 1)) : -1;
  if (window.CSS?.highlights && typeof Highlight !== 'undefined') {
    CSS.highlights.set('gopher-find', new Highlight(...threadFindMatches.map((match) => match.range)));
  }
  paintThreadFindMatch(scroll);
}

function paintThreadFindMatch(scroll = true) {
  chatThread.querySelectorAll('.is-find-match').forEach((row) => row.classList.remove('is-find-match'));
  const match = threadFindMatches[threadFindIndex];
  const count = threadFindMatches.length;
  const query = document.getElementById('threadFindInput').value;
  document.getElementById('threadFindCount').textContent = query
    ? (count ? (threadFindIndex + 1) + ' of ' + count + (count === 2000 ? '+' : '') : 'No matches') : '';
  document.getElementById('btnFindPrevious').disabled = !count;
  document.getElementById('btnFindNext').disabled = !count;
  if (window.CSS?.highlights && typeof Highlight !== 'undefined') {
    CSS.highlights.set('gopher-find-active', new Highlight(...(match ? [match.range] : [])));
  }
  if (!match) return;
  match.row?.classList.add('is-find-match');
  if (scroll) {
    stickToBottom = false;
    userScrollOverride = true;
    match.range.startContainer.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
    const bounds = match.range.getBoundingClientRect();
    const viewport = chatViewport.getBoundingClientRect();
    if (bounds.height) chatViewport.scrollBy({ top: bounds.top - viewport.top - viewport.height / 2, behavior: 'instant' });
  }
}

function stepThreadFind(direction) {
  if (!threadFindMatches.length) return;
  threadFindIndex = (threadFindIndex + direction + threadFindMatches.length) % threadFindMatches.length;
  paintThreadFindMatch();
}

function isComposingKey(event) {
  return !!(event.isComposing || event.keyCode === 229);
}

composerInput.addEventListener('input', scheduleComposerDraftSave);
composerCard.addEventListener('click', () => queueMicrotask(scheduleComposerDraftSave));
document.getElementById('btnFindInChat')?.addEventListener('click', () => {
  if (threadFindIsOpen()) closeThreadFind();
  else openThreadFind();
});
document.getElementById('threadFindInput')?.addEventListener('input', () => {
  threadFindIndex = -1;
  refreshThreadFind();
});
document.getElementById('threadFindInput')?.addEventListener('keydown', (event) => {
  if (isComposingKey(event)) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    stepThreadFind(event.shiftKey ? -1 : 1);
  }
});
document.getElementById('btnFindPrevious')?.addEventListener('click', () => stepThreadFind(-1));
document.getElementById('btnFindNext')?.addEventListener('click', () => stepThreadFind(1));
document.getElementById('btnFindClose')?.addEventListener('click', () => closeThreadFind());
document.getElementById('btnRetryConnection')?.addEventListener('click', () => pollState());

const modifierLabel = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
function shortcutLabel(value) {
  return String(value || '').replace('Mod', modifierLabel);
}
document.querySelector('#btnSearchChats kbd').textContent = shortcutLabel('Mod K');
document.getElementById('btnSearchChats').title = 'Search and quick actions (' + shortcutLabel('Mod+K') + ')';

function renderWelcomeTools() {
  const host = document.getElementById('welcomeTools');
  if (!host) return;
  const hidden = !!activeId || draftIncognito || isBotsSurface() || diskEncryptionLocked() || !!localDataLoadError;
  host.classList.toggle('is-hidden', hidden);
  if (hidden) return;
  const noModels = !!latestState && !serverReady && !modelMenuOptions.some((option) => !option.connectKind);
  const mode = noModels ? 'connect' : 'ready';
  if (host.dataset.mode === mode) return;
  host.dataset.mode = mode;
  host.replaceChildren();
  if (noModels) {
    const panel = document.createElement('div');
    panel.className = 'welcome-connect';
    panel.innerHTML = '<p>Choose a model to get started<span>Connect a local model or a provider you already use.</span></p>';
    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'btn btn-primary';
    connect.textContent = 'Connect a model';
    connect.addEventListener('click', () => openSettings('providers'));
    panel.appendChild(connect);
    host.appendChild(panel);
  } else {
    const starters = document.createElement('div');
    starters.className = 'welcome-starters';
    const paths = [
      '<path d="M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z"/>',
      '<path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-11-2 14"/>',
      '<path d="M9 5h11M9 12h11M9 19h11M3 5h.01M3 12h.01M3 19h.01"/>',
    ];
    [
      ['Understand something', 'Break down a complex idea', 'Help me understand a topic. First, ask what I want to learn and what I already know.'],
      ['Work through a problem', 'Find a practical way forward', 'Help me solve a problem. Ask me for the details, then work through possible approaches with me.'],
      ['Make a plan', 'Turn an idea into next steps', 'Help me turn a goal into a practical plan. Ask about the goal, constraints, and timeline first.'],
    ].forEach(([title, detail, prompt], index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'welcome-starter';
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + paths[index] + '</svg><strong>' + title + '</strong><span>' + detail + '</span>';
      button.addEventListener('click', () => {
        if (composerInput.value.trim()) composerInput.value += '\n\n' + prompt;
        else composerInput.value = prompt;
        composerInput.dispatchEvent(new Event('input', { bubbles: true }));
        composerInput.focus();
      });
      starters.appendChild(button);
    });
    host.appendChild(starters);
  }
  const shortcuts = document.createElement('p');
  shortcuts.className = 'welcome-shortcuts';
  const search = document.createElement('button');
  search.type = 'button';
  search.innerHTML = '<kbd>' + shortcutLabel('Mod K') + '</kbd> Search & quick actions';
  search.addEventListener('click', () => openSearchModal());
  shortcuts.appendChild(search);
  host.appendChild(shortcuts);
}

const welcomeTools = document.createElement('div');
welcomeTools.id = 'welcomeTools';
welcomeTools.className = 'welcome-tools is-hidden';
emptyStateInner.appendChild(welcomeTools);

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || isComposingKey(event) || backdropFocusStack.length) return;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && key === 'f' && activeId && mainView === 'chat') {
    event.preventDefault();
    openThreadFind();
  } else if (mod && event.shiftKey && !event.altKey && key === 'o') {
    event.preventDefault();
    if (requireUnlockedData()) startWorkspaceChat();
  } else if (mod && !event.shiftKey && !event.altKey && key === ',') {
    event.preventDefault();
    if (requireUnlockedData()) openSettings();
  } else if (event.key === 'Escape' && threadFindIsOpen()) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeThreadFind();
  }
});
