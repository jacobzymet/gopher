function clearAllChats() {
  if (!requireUnlockedData()) return;
  const chats = conversations.filter((convo) => !(typeof isBotsConvo === 'function' && isBotsConvo(convo)));
  if (chats.length === 0) return;
  const n = chats.length;
  if (!confirm('Delete all ' + n + ' chat' + (n === 1 ? '' : 's') + '? This cannot be undone.')) return;
  const keep = conversations.filter((convo) => typeof isBotsConvo === 'function' && isBotsConvo(convo));
  const dropIds = new Set(chats.map((convo) => convo.id));
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ conversationIds: [...dropIds], surface: 'chat' });
  for (const id of dropIds) {
    abortStream(id);
    outboundQueues.delete(id);
    stickByConvo.delete(id);
  }
  if (editingQueueId && dropIds.has(activeId!)) {
    editingQueueId = null;
    if (editingRow) {
      editingRow = null;
      mentionInput = composerInput;
      closeMentionMenu();
    }
  }
  conversations = keep;
  if (activeId && !conversations.some((item) => item.id === activeId)) activeId = null;
  saveStore();
  startDraft();
  renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  refreshSettingsDataSummary();
}

function clearAllLoops() {
  if (!requireUnlockedData()) return;
  const loops = conversations.filter((convo) => typeof isBotsConvo === 'function' && isBotsConvo(convo));
  if (loops.length === 0) return;
  const n = loops.length;
  if (!confirm('Delete all ' + n + ' loop' + (n === 1 ? '' : 's') + '? This cannot be undone.')) return;
  const dropIds = new Set(loops.map((convo) => convo.id));
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ conversationIds: [...dropIds], surface: 'bots' });
  for (const id of dropIds) {
    abortStream(id);
    outboundQueues.delete(id);
    stickByConvo.delete(id);
  }
  if (editingQueueId && dropIds.has(activeId!)) {
    editingQueueId = null;
    if (editingRow) {
      editingRow = null;
      mentionInput = composerInput;
      closeMentionMenu();
    }
  }
  conversations = conversations.filter((convo) => !dropIds.has(convo.id));
  const activeWasDeleted = !!activeId && dropIds.has(activeId);
  if (activeWasDeleted) activeId = null;
  saveStore();
  if (activeWasDeleted || (typeof isBotsSurface === 'function' && isBotsSurface())) startDraft();
  else renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  refreshSettingsDataSummary();
}

function clearAllProjects() {
  if (!requireUnlockedData()) return;
  if (projects.length === 0) return;
  const n = projects.length;
  if (!confirm('Delete all ' + n + ' project' + (n === 1 ? '' : 's') + '? Chats move back to Recents.')) return;
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ projectIds: projects.map((project) => project.id) });
  conversations.forEach((convo) => { convo.projectId = null; });
  projects = [];
  activeProjectId = null;
  if (!activeId && typeof restoreComposerDraft === 'function') restoreComposerDraft();
  saveStore();
  renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  else {
    showChatView();
    syncProjectChrome();
  }
  updateGreeting();
  refreshSettingsDataSummary();
}

function clearAllChatsAndProjects() {
  if (!requireUnlockedData()) return;
  if (conversations.length === 0 && projects.length === 0
      && !(typeof hasComposerDrafts === 'function' && hasComposerDrafts())) return;
  if (!confirm('Delete all chats, loops, projects, and drafts in this profile? This cannot be undone.')) return;
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ all: true });
  const dropIds = new Set(conversations.map((convo) => convo.id));
  for (const id of dropIds) {
    abortStream(id);
    outboundQueues.delete(id);
    stickByConvo.delete(id);
  }
  if (editingQueueId && dropIds.has(activeId!)) {
    editingQueueId = null;
    if (editingRow) {
      editingRow = null;
      mentionInput = composerInput;
      closeMentionMenu();
    }
  }
  conversations = [];
  projects = [];
  activeId = null;
  activeProjectId = null;
  saveStore();
  startDraft();
  renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  updateGreeting();
  refreshSettingsDataSummary();
}

let pendingChatBackgroundImage = '';
let pendingChatBackgroundImageName = '';

