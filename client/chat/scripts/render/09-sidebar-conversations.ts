function bySidebarOrder(list = conversations) {
  return [...list].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

function startOfLocalDay(timestamp: string | number | Date) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function conversationDateBucket(timestamp: number, now = Date.now()) {
  const today = startOfLocalDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const lastWeek = new Date(week);
  lastWeek.setDate(lastWeek.getDate() - 7);
  const value = Number(timestamp) || 0;
  if (value >= today) return { key: 'today', label: 'Today' };
  if (value >= yesterday.getTime()) return { key: 'yesterday', label: 'Yesterday' };
  if (value >= week.getTime()) return { key: 'this-week', label: 'Earlier this week' };
  if (value >= lastWeek.getTime()) return { key: 'last-week', label: 'Last week' };
  const date = new Date(value);
  const month = date.toLocaleString('en-US', { month: 'long' });
  const label = date.getFullYear() === new Date(now).getFullYear()
    ? month
    : month + ' ' + date.getFullYear();
  return { key: date.getFullYear() + '-' + date.getMonth(), label };
}

function conversationDateGroups(list: Conversation[] | undefined, now = Date.now()) {
  const groups: ConversationDateGroup[] = [];
  for (const convo of bySidebarOrder(list)) {
    const bucket = conversationDateBucket(convo.updatedAt, now);
    let group: ConversationDateGroup | undefined = groups[groups.length - 1];
    if (!group || group.key !== bucket.key) {
      group = { ...bucket, conversations: [] };
      groups.push(group);
    }
    group.conversations.push(convo);
  }
  return groups;
}

function appendConversationDateGroups(list: HTMLElement, conversations: Conversation[]) {
  for (const group of conversationDateGroups(conversations)) {
    const heading = (document.createElement('div') as HTMLElement);
    heading.className = 'convo-date-heading';
    heading.setAttribute('role', 'heading');
    heading.setAttribute('aria-level', '3');
    const label = (document.createElement('span') as HTMLElement);
    label.textContent = group.label;
    heading.appendChild(label);
    list.appendChild(heading);
    for (const convo of group.conversations) list.appendChild(createConvoItem(convo));
  }
}

function uncategorizedConversations() {
  const pool = typeof conversationsOnSurface === 'function' ? conversationsOnSurface() : conversations;
  return bySidebarOrder(pool.filter((convo) => !convo.projectId && !convo.pinned));
}

function pinnedConversations() {
  const pool = typeof conversationsOnSurface === 'function' ? conversationsOnSurface() : conversations;
  return pool
    .filter((convo) => convo.pinned && !convo.incognito)
    .sort((a, b) => (b.pinnedAt || b.updatedAt) - (a.pinnedAt || a.updatedAt));
}

function conversationsForProject(projectId: string | null | undefined) {
  return bySidebarOrder(conversations.filter((convo) => convo.projectId === projectId));
}

function nextTopSortOrder(projectId: string | null | undefined) {
  const peers = conversations.filter((convo) =>
    projectId ? convo.projectId === projectId : !convo.projectId
  );
  if (peers.length === 0) return 0;
  return Math.min(...peers.map((convo) => (
    typeof convo.sortOrder === 'number' ? convo.sortOrder : 0
  ))) - 1;
}

function applyConversationOrder(orderedIds: string[]) {
  orderedIds.forEach((id, index) => {
    const convo = conversations.find((item) => item.id === id);
    if (convo) convo.sortOrder = index;
  });
  saveStore();
  renderSidebar();
}

function closeConvoMenu() {
  if (!openConvoMenu) return;
  const menu = openConvoMenu;
  menu._anchor?.setAttribute('aria-expanded', 'false');
  openConvoMenu = null;
  menu.classList.remove('is-open');

  if (prefersReducedMotion()) {
    menu.remove();
    return;
  }

  const removeMenu = () => {
    window.clearTimeout(menu._closeTimer);
    menu.remove();
  };
  menu.addEventListener('transitionend', removeMenu, { once: true });
  menu._closeTimer = window.setTimeout(removeMenu, 200);
}

let draggingConvoId: string | null = null;
let convoDragMoved = false;
let conversationSelectionMode = false;
const selectedConversationIds: Set<string> = new Set();

function syncConversationBulkToolbar() {
  const selected = conversations.filter((convo) => selectedConversationIds.has(convo.id));
  const count = selected.length;
  sidebarBulkActions?.classList.toggle('is-hidden', !conversationSelectionMode);
  if (btnManageConvos) {
    btnManageConvos.textContent = conversationSelectionMode ? 'Done' : 'Select';
    btnManageConvos.setAttribute('aria-pressed', conversationSelectionMode ? 'true' : 'false');
  }
  if (sidebarBulkCount) sidebarBulkCount.textContent = count + ' selected';
  if (btnBulkDeleteConvos) btnBulkDeleteConvos.disabled = count === 0;
  if (btnBulkPinConvos) {
    const pinnable = selected.filter((convo) => !convo.incognito);
    const unpin = pinnable.length > 0 && pinnable.every((convo) => convo.pinned);
    btnBulkPinConvos.textContent = unpin ? 'Unpin' : 'Pin';
    btnBulkPinConvos.disabled = pinnable.length === 0;
  }
}

function setConversationSelectionMode(enabled: boolean) {
  conversationSelectionMode = !!enabled;
  if (!conversationSelectionMode) selectedConversationIds.clear();
  renderSidebar();
}

function toggleConversationSelection(convoId: string) {
  if (!conversationSelectionMode || !convoId) return;
  if (selectedConversationIds.has(convoId)) selectedConversationIds.delete(convoId);
  else selectedConversationIds.add(convoId);
  renderSidebar();
}

function bulkSetSelectedConversationsPinned() {
  const selected = conversations.filter((convo) => (
    selectedConversationIds.has(convo.id) && !convo.incognito
  ));
  if (!selected.length) return;
  const pin = !selected.every((convo) => convo.pinned);
  const now = Date.now();
  selected.forEach((convo, index) => {
    convo.pinned = pin;
    convo.pinnedAt = pin ? now - index : null;
  });
  saveConversations();
  setConversationSelectionMode(false);
}

async function bulkDeleteSelectedConversations() {
  const ids = [...selectedConversationIds].filter((id) => (
    conversations.some((convo) => convo.id === id)
  ));
  if (!ids.length) return;
  const ok = await confirmDanger({
    title: 'Delete ' + ids.length + (ids.length === 1 ? ' conversation?' : ' conversations?'),
    body: 'This cannot be undone.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;

  const deleting = new Set(ids);
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ conversationIds: ids });
  const deletingEdit = editingQueueId
    && ids.some((id) => getOutboundQueue(id).some((item) => item.id === editingQueueId));
  ids.forEach((id) => {
    abortStream(id);
    activeStreams.delete(id);
    outboundQueues.delete(id);
    stickByConvo.delete(id);
  });
  if (deletingEdit) {
    editingQueueId = null;
    if (editingRow?.classList.contains('msg-queued')) {
      editingRow = null;
      mentionInput = composerInput;
      closeMentionMenu();
    }
  }
  const deletedActive = !!activeId && deleting.has(activeId);
  conversations = conversations.filter((convo) => !deleting.has(convo.id));
  saveConversations();
  conversationSelectionMode = false;
  selectedConversationIds.clear();
  if (deletedActive) startDraft();
  else {
    renderSidebar();
    syncComposerStreamUi();
  }
}

function clearConvoDragMarkers(root: { querySelectorAll: (arg0: string) => NodeListOf<HTMLElement>; }) {
  if (!root) return;
  (root.querySelectorAll('.convo-item.is-drag-before, .convo-item.is-drag-after, .convo-item.is-dragging') as NodeListOf<HTMLElement>)
    .forEach((el) => {
      el.classList.remove('is-drag-before', 'is-drag-after', 'is-dragging');
    });
}

function bindConvoListReorder(listEl: { querySelectorAll: (arg0: string) => NodeListOf<HTMLElement>; }) {
  if (conversationSelectionMode) return;
  const items = [...(listEl.querySelectorAll('.convo-item[data-convo-id]') as NodeListOf<HTMLElement>)];
  if (items.length < 2) return;

  items.forEach((item) => {
    item.draggable = true;
    item.addEventListener('dragstart', (event) => {
      if (((event.target as Element).closest('button') as HTMLButtonElement)) {
        event.preventDefault();
        return;
      }
      draggingConvoId = item.dataset.convoId || null;
      convoDragMoved = false;
      item.classList.add('is-dragging');
      event.dataTransfer!.effectAllowed = 'move';
      event.dataTransfer!.setData('text/plain', draggingConvoId || '');
      try {
        event.dataTransfer!.setDragImage(item, 12, 12);
      } catch {
        // some browsers reject custom drag images
      }
    });
    item.addEventListener('dragend', () => {
      clearConvoDragMarkers(listEl);
      draggingConvoId = null;
    });
    item.addEventListener('dragover', (event) => {
      if (!draggingConvoId) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = 'move';
      const overId = item.dataset.convoId;
      if (!overId || overId === draggingConvoId) return;
      const rect = item.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      items.forEach((el) => el.classList.remove('is-drag-before', 'is-drag-after'));
      item.classList.add(before ? 'is-drag-before' : 'is-drag-after');
    });
    item.addEventListener('dragleave', (event) => {
      if (!item.contains(event.relatedTarget as Node | null)) {
        item.classList.remove('is-drag-before', 'is-drag-after');
      }
    });
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      const sourceId = draggingConvoId || event.dataTransfer!.getData('text/plain');
      const targetId = item.dataset.convoId;
      items.forEach((el) => el.classList.remove('is-drag-before', 'is-drag-after'));
      if (!sourceId || !targetId || sourceId === targetId) return;
      const rect = item.getBoundingClientRect();
      const placeBefore = event.clientY < rect.top + rect.height / 2;
      const order = items.map((el) => el.dataset.convoId).filter(Boolean);
      const from = order.indexOf(sourceId);
      let to = order.indexOf(targetId);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      to = order.indexOf(targetId);
      if (to < 0) return;
      order.splice(placeBefore ? to : to + 1, 0, sourceId);
      convoDragMoved = true;
      applyConversationOrder(order);
    });
  });
}

const CONVO_BUSY_CYCLE_MS = 1150;
const convoBusyAnimationStartedAt: Map<string, number> = new Map();

function syncConvoBusyRingPhase(ring: HTMLElement, convoId: string | undefined) {
  if (!ring || !convoId) return;
  let startedAt = convoBusyAnimationStartedAt.get(convoId);
  if (!startedAt) {
    startedAt = Number(activeStreams.get(convoId)?.startedAt) || Date.now();
    convoBusyAnimationStartedAt.set(convoId, startedAt);
  }
  const elapsed = Math.max(0, Date.now() - startedAt);
  ring.style.setProperty('--convo-busy-delay', '-' + (elapsed % CONVO_BUSY_CYCLE_MS) + 'ms');
}

function syncSidebarBusyUi() {
  (document.querySelectorAll('.convo-item[data-convo-id]') as NodeListOf<HTMLElement>).forEach((item) => {
    const convoId = item.dataset.convoId;
    const busy = typeof isConvoBusy === 'function' && isConvoBusy(convoId);
    item.classList.toggle('is-streaming', busy);
    if (busy) item.setAttribute('aria-busy', 'true');
    else {
      item.removeAttribute('aria-busy');
      convoBusyAnimationStartedAt.delete(convoId!);
    }
    let ring = (item.querySelector(':scope > .convo-busy-ring') as HTMLElement);
    if (busy && !ring) {
      ring = (document.createElement('span') as HTMLElement);
      ring.className = 'convo-busy-ring';
      ring.setAttribute('aria-hidden', 'true');
      item.prepend(ring);
    } else if (!busy && ring) {
      ring.remove();
    }
    if (busy && ring) syncConvoBusyRingPhase(ring, convoId);
  });
}

function createConvoItem(convo: Conversation, { nested = false } = {}) {
  const item = (document.createElement('div') as HTMLElement);
  item.className = 'convo-item' + (convo.id === activeId && mainView === 'chat' ? ' is-active' : '');
  if (convo.incognito) item.classList.add('is-incognito');
  if (convo.pinned) item.classList.add('is-pinned');
  if (notificationIsUnread(convo)) {
    item.classList.add('has-unread');
    item.setAttribute('aria-description', 'Unread response');
  }
  item.dataset.convoId = convo.id;
  if (conversationSelectionMode) {
    const selected = selectedConversationIds.has(convo.id);
    item.classList.toggle('is-bulk-selected', selected);
    item.setAttribute('role', 'checkbox');
    item.setAttribute('aria-checked', selected ? 'true' : 'false');
    const check = (document.createElement('span') as HTMLElement);
    check.className = 'convo-select-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>';
    item.appendChild(check);
  }
  if (nested) item.classList.add('is-nested');
  const busy = isConvoBusy(convo.id);
  if (busy) item.classList.add('is-streaming');
  else convoBusyAnimationStartedAt.delete(convo.id);
  const fullTitle = convo.title || (convo.incognito ? 'Ghost Chat' : 'New chat');
  const botsConvoItem = typeof isBotsConvo === 'function' && isBotsConvo(convo);
  if (busy) {
    const ring = (document.createElement('span') as HTMLElement);
    ring.className = 'convo-busy-ring';
    ring.setAttribute('aria-hidden', 'true');
    syncConvoBusyRingPhase(ring, convo.id);
    item.appendChild(ring);
    item.setAttribute('aria-busy', 'true');
  }
  if (botsConvoItem && typeof createConvoAvatarEl === 'function') {
    const avatar = createConvoAvatarEl(convo);
    if (avatar) {
      applyPrivacyMosaic(avatar, 'convo-avatar:' + convo.id, { dense: true });
      item.appendChild(avatar);
    }
  } else if (convo.incognito) {
    const mark = (document.createElement('span') as HTMLElement);
    mark.className = 'convo-incognito-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M9 10h.01"/><path d="M15 10h.01"/>' +
        '<path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>' +
      '</svg>';
    item.appendChild(mark);
  }
  const title = (document.createElement('span') as HTMLElement);
  title.className = 'convo-title';
  const titleText = (document.createElement('span') as HTMLElement);
  titleText.className = 'convo-title-text';
  titleText.textContent = fullTitle;
  title.appendChild(titleText);
  applyPrivacyMosaic(title, 'conversation:' + convo.id);
  const identityTitle = convo.incognito ? fullTitle + ' (temporary session — not saved)' : fullTitle;
  setIdentityTitle(title, identityTitle);
  setIdentityTitle(item, identityTitle);
  if (botsConvoItem && convo.botKind === 'dm' && convo.botId) {
    const bot = typeof getBot === 'function' ? getBot(convo.botId) : null;
    if (bot) {
      const handle = (document.createElement('span') as HTMLElement);
      handle.className = 'convo-handle';
      handle.textContent = '@' + bot.handle;
      applyPrivacyMosaic(handle, 'bot-handle:' + bot.id);
      title.appendChild(handle);
    }
  } else if (botsConvoItem && typeof isBotGroup === 'function' && isBotGroup(convo) && typeof participantBots === 'function') {
    const members = participantBots(convo);
    if (members.length) {
      const preview = (document.createElement('span') as HTMLElement);
      preview.className = 'convo-handle';
      preview.textContent = members.map((bot) => '@' + bot.handle).join(' · ');
      applyPrivacyMosaic(preview, 'bot-handles:' + convo.id);
      title.appendChild(preview);
    }
  }
  const more = (document.createElement('button') as HTMLButtonElement);
  more.type = 'button';
  more.className = 'convo-more';
  more.setAttribute('aria-label', 'Conversation actions');
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.title = 'More';
  more.draggable = false;
  more.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.45"/><circle cx="12" cy="12" r="1.45"/><circle cx="19" cy="12" r="1.45"/></svg>';
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    openConversationMenu(more, convo, item);
  });
  if (convo.pinned) {
    const pinnedMark = (document.createElement('span') as HTMLElement);
    pinnedMark.className = 'convo-pinned-mark';
    pinnedMark.setAttribute('aria-hidden', 'true');
    pinnedMark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M5 17h14"/><path d="m7 10 1-7h8l1 7 2 3H5z"/></svg>';
    item.appendChild(pinnedMark);
  }
  item.appendChild(title);
  const updatedAt = Number(convo.updatedAt) || 0;
  if (updatedAt) {
    const age = (document.createElement('time') as HTMLTimeElement);
    age.className = 'convo-age';
    age.dateTime = new Date(updatedAt).toISOString();
    age.title = new Date(updatedAt).toLocaleString();
    const minutes = Math.floor(Math.max(0, Date.now() - updatedAt) / 60000);
    age.textContent = minutes < 60
      ? Math.max(1, minutes) + 'm'
      : (minutes < 1440 ? Math.floor(minutes / 60) + 'h' : Math.floor(minutes / 1440) + 'd');
    item.appendChild(age);
  }
  if (!conversationSelectionMode) item.appendChild(more);
  item.addEventListener('click', () => {
    if (convoDragMoved) {
      convoDragMoved = false;
      return;
    }
    if (conversationSelectionMode) toggleConversationSelection(convo.id);
    else selectConversation(convo.id);
  });
  return item;
}

function convoMenuButton(label: string, icon: string, onClick: { (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): void; }, { danger = false } = {}) {
  const button = (document.createElement('button') as HTMLButtonElement);
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  if (danger) button.classList.add('is-danger');
  button.innerHTML = icon + '<span>' + escapeHtml(label) + '</span>';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  button.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  return button;
}

function openConversationMenu(anchor: HTMLButtonElement, convo: Conversation, row: HTMLElement) {
  if (openConvoMenu?._anchor === anchor) {
    closeConvoMenu();
    return;
  }
  closeConvoMenu();
  const menu = (document.createElement('div') as HTMLElement);
  menu.className = 'convo-menu';
  menu.setAttribute('role', 'menu');
  menu._anchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  const pinIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M5 17h14"/><path d="m7 10 1-7h8l1 7 2 3H5z"/></svg>';
  const renameIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z"/></svg>';
  const trashIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/></svg>';

  if (!convo.incognito) {
    menu.appendChild(convoMenuButton(convo.pinned ? 'Unpin' : 'Pin', pinIcon, () => {
      closeConvoMenu();
      togglePinnedConversation(convo.id);
    }));
  }
  menu.appendChild(convoMenuButton('Rename', renameIcon, () => {
    closeConvoMenu();
    beginSidebarTitleEdit(convo, row);
  }));
  const exportIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/></svg>';
  menu.appendChild(convoMenuButton('Export as Markdown', exportIcon, () => {
    closeConvoMenu();
    exportConversationMarkdown(convo.id);
  }));

  const botsConvo = typeof isBotsConvo === 'function' && isBotsConvo(convo);
  if (botsConvo && typeof isBotGroup === 'function' && isBotGroup(convo)) {
    menu.appendChild(convoMenuButton('Edit loop', folderIcon, () => {
      closeConvoMenu();
      openGroupDialog(convo);
    }));
  }

  const targets = botsConvo ? [] : projects.filter((project) => project.id !== convo.projectId);
  if (convo.projectId || targets.length) {
    const label = (document.createElement('div') as HTMLElement);
    label.className = 'convo-menu-label';
    label.textContent = 'Move to project';
    menu.appendChild(label);
  }

  if (convo.projectId) {
    menu.appendChild(convoMenuButton('Recents (no project)', folderIcon, () => {
      moveConversation(convo.id, null);
      closeConvoMenu();
    }));
  }

  for (const project of targets) {
    menu.appendChild(convoMenuButton(project.name, folderIcon, () => {
      moveConversation(convo.id, project.id);
      closeConvoMenu();
    }));
  }

  const separator = (document.createElement('div') as HTMLElement);
  separator.className = 'convo-menu-separator';
  separator.setAttribute('role', 'separator');
  menu.appendChild(separator);
  menu.appendChild(convoMenuButton(botsConvo && convo.botKind === 'dm' ? 'Delete bot' : (botsConvo ? 'Delete loop' : 'Delete'), trashIcon, () => {
    closeConvoMenu();
    if (botsConvo && convo.botKind === 'dm' && convo.botId && typeof deleteBotAndSession === 'function') {
      void deleteBotAndSession(convo.botId);
    } else {
      void deleteConversation(convo.id);
    }
  }, { danger: true }));

  document.body.appendChild(menu);
  menu.addEventListener('pointerdown', (event) => event.stopPropagation());
  menu.addEventListener('click', (event) => event.stopPropagation());
  openConvoMenu = menu;
  const rect = anchor.getBoundingClientRect();
  const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
  const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
  menu.style.top = Math.max(8, top) + 'px';
  menu.style.left = Math.max(8, left) + 'px';
  menu.classList.toggle('opens-above', top < rect.top);
  void menu.offsetWidth;
  afterNextPaint(() => {
    if (menu === openConvoMenu && menu.isConnected) menu.classList.add('is-open');
  });
}

function moveConversation(convoId: string, projectId: string | null | undefined) {
  const convo = conversations.find((item) => item.id === convoId);
  if (!convo) return;
  convo.projectId = projectId;
  convo.updatedAt = Date.now();
  convo.sortOrder = nextTopSortOrder(projectId);
  if (projectId) {
    activeProjectId = projectId!;
  }
  saveStore();
  renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  updateGreeting();
}

function togglePinnedConversation(convoId: string) {
  const convo = conversations.find((item) => item.id === convoId);
  if (!convo || convo.incognito) return;
  convo.pinned = !convo.pinned;
  convo.pinnedAt = convo.pinned ? Date.now() : null;
  saveStore();
  renderSidebar();
}

function commitConversationTitle(convo: Conversation, rawTitle: string) {
  if (!convo) return false;
  const next = String(rawTitle || '').trim().slice(0, 120);
  if (!next || next === convo.title) return false;
  convo.title = next;
  convo.titleEdited = true;
  convo.titleStatus = 'edited';
  convo.titleAttempts = 0;
  convo.updatedAt = Date.now();
  convo._titleReq = (convo._titleReq || 0) + 1;
  convo._titleBusy = false;
  if (typeof clearConversationTitleTimer === 'function') {
    clearConversationTitleTimer(convo.id);
  }
  saveConversations();
  renderSidebar();
  if (activeId === convo.id) convoTitleEl.textContent = next;
  return true;
}

function beginSidebarTitleEdit(convo: Conversation, row: HTMLElement) {
  if (!convo || !row?.isConnected) return;
  const title = (row.querySelector('.convo-title') as HTMLElement);
  if (!title) return;
  const input = (document.createElement('input') as HTMLInputElement);
  input.className = 'convo-title-input';
  input.type = 'text';
  input.maxLength = 120;
  input.value = convo.title || 'New chat';
  input.setAttribute('aria-label', 'Chat title');
  let cancelled = false;
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelled = true;
      renderSidebar();
    }
  });
  input.addEventListener('blur', () => {
    if (!cancelled) {
      commitConversationTitle(convo, input.value);
      if (input.isConnected) renderSidebar();
    }
  });
  title.replaceWith(input);
  input.focus();
  input.select();
}

function beginTopbarTitleEdit() {
  const convo = conversations.find((item) => item.id === activeId);
  if (!convo || convo.incognito || (convoTitleEl.querySelector('input') as HTMLInputElement)) return;
  stopTitleTyping(convoTitleEl);
  const original = convo.title || 'New chat';
  const input = (document.createElement('input') as HTMLInputElement);
  input.className = 'chat-title-input';
  input.type = 'text';
  input.maxLength = 120;
  input.value = original;
  input.setAttribute('aria-label', 'Chat title');
  let cancelled = false;
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelled = true;
      convoTitleEl.textContent = original;
      convoTitleEl.focus();
    }
  });
  input.addEventListener('blur', () => {
    if (cancelled) return;
    commitConversationTitle(convo, input.value);
    if (input.isConnected) convoTitleEl.textContent = convo.title || original;
  });
  convoTitleEl.textContent = '';
  convoTitleEl.appendChild(input);
  input.focus();
  input.select();
}

