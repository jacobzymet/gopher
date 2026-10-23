function formatProjectDate(ts: string | number | Date) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function notificationIsUnread(convo: Conversation) {
  const at = Number(convo?.notificationAt) || 0;
  const readAt = Number(convo?.notificationReadAt) || 0;
  return at > readAt;
}

function markConversationNotificationRead(convo: Conversation | undefined, { persist = true } = {}) {
  if (!convo || !notificationIsUnread(convo)) return false;
  convo.notificationReadAt = convo.notificationAt;
  if (persist && !convo.incognito) saveConversations({ immediate: true });
  if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
  return true;
}

function recordConversationNotification(convo: Conversation | null | undefined, { kind = 'complete', at = Date.now() } = {}) {
  if (!convo || convo.incognito) return;
  convo.notificationAt = at;
  convo.notificationKind = kind === 'error' ? 'error' : 'complete';
  if (activeId === convo.id && mainView === 'chat' && document.visibilityState === 'visible') {
    convo.notificationReadAt = at;
  }
  if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
}

function pendingAttentionNotifications() {
  const items = [];
  for (const [convoId, stream] of activeStreams.entries()) {
    if (!stream || stream.cancelled || stream.replaced || stream.settled || stream.serverFinished
        || stream.controller?.signal?.aborted || stream.catchingUp) continue;
    const convo = conversations.find((item) => item.id === convoId);
    if (!convo) continue;
    for (const part of stream.timeline || []) {
      if (part?.type === 'tool' && part.live && part.approval === 'pending') {
        const tool = skillLabel(part.name, part.args);
        items.push({
          type: 'approval',
          convo,
          at: Number(part.startedAt) || Date.now(),
          title: convo.title || 'New chat',
          label: 'Approval needed',
          detail: tool + ' · ' + (part.detail || 'Review this request to continue the task.'),
        });
      } else if (part?.type === 'clarify' && part.live) {
        const count = Array.isArray(part.questions) ? part.questions.length : 0;
        items.push({
          type: 'input',
          convo,
          at: Number(part.startedAt) || Date.now(),
          title: convo.title || 'New chat',
          label: 'Input needed',
          detail: count
            ? ('Answer ' + count + ' question' + (count === 1 ? '' : 's') + ' to continue the task.')
            : 'Answer a question to continue the task.',
        });
      }
    }
  }
  return items.sort((a, b) => b.at! - a.at!);
}

function completionNotifications() {
  return conversations
    .filter((convo) => Number(convo.notificationAt) > 0)
    .map((convo) => {
      const latestAssistant = [...(convo.messages || [])].reverse().find((message) => message?.role === 'assistant');
      const error = convo.notificationKind === 'error';
      return {
        type: error ? 'error' : 'complete',
        convo,
        at: convo.notificationAt,
        title: convo.title || 'New chat',
        label: error ? 'Task needs attention' : 'Task completed',
        detail: messagePlainExcerpt(latestAssistant, 180)
          || (error ? 'The task stopped before it produced a response.' : 'A new response is ready.'),
        unread: notificationIsUnread(convo),
      };
    })
    .sort((a, b) => b.at! - a.at!);
}

function formatNotificationTime(timestamp: string | number | Date | null | undefined) {
  const elapsed = Math.max(0, Date.now() - (Number(timestamp) || Date.now()));
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return Math.floor(elapsed / 60_000) + 'm ago';
  if (elapsed < 86_400_000) return Math.floor(elapsed / 3_600_000) + 'h ago';
  if (elapsed < 604_800_000) return Math.floor(elapsed / 86_400_000) + 'd ago';
  try {
    return new Date(timestamp as string | number | Date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function notificationIcon(type: string) {
  if (type === 'approval') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/></svg>';
  }
  if (type === 'error') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>';
  }
  if (type === 'input') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1.2.9-1.2 1.8"/><path d="M12 17h.01"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
}

function renderNotificationMarkdown(text: unknown) {
  const source = String(text || '');
  if (!window.marked?.parseInline || !window.DOMPurify) return escapeHtml(source);
  const raw = window.marked.parseInline(source, { async: false });
  return window.DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['strong', 'em', 'code', 'del', 'br'],
    ALLOWED_ATTR: [],
  });
}

function buildNotificationCard(item: ConversationNotification) {
  const card = (document.createElement('button') as HTMLButtonElement);
  card.type = 'button';
  card.className = 'notification-card';
  if (item.type === 'approval' || item.type === 'input') card.classList.add('is-attention', 'is-unread');
  if (item.type === 'error') card.classList.add('is-error');
  if (item.unread) card.classList.add('is-unread');
  card.innerHTML =
    '<span class="notification-mark">' + notificationIcon(item.type) + '</span>' +
    '<span class="notification-copy">' +
      '<span class="notification-overline"><strong></strong><span></span></span>' +
      '<span class="notification-card-title"></span>' +
      '<span class="notification-card-detail"></span>' +
    '</span>' +
    '<svg class="notification-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  (card.querySelector('.notification-overline strong') as HTMLElement).textContent = item.label;
  (card.querySelector('.notification-overline span') as HTMLElement).textContent = formatNotificationTime(item.at);
  const title = (card.querySelector('.notification-card-title') as HTMLElement);
  title.textContent = item.title;
  applyPrivacyMosaic(title, 'notification:' + item.convo.id);
  const detail = (card.querySelector('.notification-card-detail') as HTMLElement);
  detail.innerHTML = renderNotificationMarkdown(item.detail);
  applyPrivacyMosaic(detail, 'notification-detail:' + item.convo.id + ':' + item.type);
  card.setAttribute('aria-label', item.label + ': ' + item.title);
  card.addEventListener('click', () => selectConversation(item.convo.id));
  return card;
}

function appendNotificationGroup(label: string, items: ConversationNotification[]) {
  if (!notificationsFeed || !items.length) return;
  const section = (document.createElement('section') as HTMLElement);
  section.className = 'notification-group';
  const heading = (document.createElement('h2') as HTMLElement);
  heading.className = 'notification-group-heading';
  heading.appendChild(document.createTextNode(label + ' '));
  const count = (document.createElement('span') as HTMLElement);
  count.textContent = String(items.length);
  heading.appendChild(count);
  section.appendChild(heading);
  items.forEach((item) => section.appendChild(buildNotificationCard(item)));
  notificationsFeed.appendChild(section);
}

function refreshNotificationsUi() {
  const approvals = pendingAttentionNotifications();
  const completed = completionNotifications();
  const unreadCompleted = completed.filter((item) => item.unread).length;
  const unread = approvals.length + unreadCompleted;
  if (sidebarNotificationBadge) {
    sidebarNotificationBadge.hidden = unread === 0;
    sidebarNotificationBadge.textContent = unread > 99 ? '99+' : String(unread);
    sidebarNotificationBadge.setAttribute('aria-label', unread + ' unread notification' + (unread === 1 ? '' : 's'));
  }
  if (btnNotificationsNav) {
    btnNotificationsNav.classList.toggle('has-unread', unread > 0);
    btnNotificationsNav.setAttribute('aria-label', unread
      ? ('Notifications, ' + unread + ' unread')
      : 'Notifications');
  }
  if (btnNotificationsMarkRead) btnNotificationsMarkRead.disabled = unreadCompleted === 0;
  if (notificationsLede) {
    notificationsLede.textContent = approvals.length
      ? (approvals.length + ' request' + (approvals.length === 1 ? '' : 's') + ' waiting across chats.')
      : (unreadCompleted
        ? (unreadCompleted + ' unread response' + (unreadCompleted === 1 ? '' : 's') + '.')
        : 'Completed work and requests from all chats.');
  }
  if (!notificationsFeed || !notificationsPopoverIsOpen()) return;
  notificationsFeed.innerHTML = '';
  appendNotificationGroup('Needs attention', approvals);
  appendNotificationGroup('Recent', completed);
  if (!approvals.length && !completed.length) {
    const empty = (document.createElement('div') as HTMLElement);
    empty.className = 'notifications-empty';
    empty.innerHTML = '<p><strong>All caught up</strong>Completed tasks and approval requests will appear here.</p>';
    notificationsFeed.appendChild(empty);
  }
}

function notificationsPopoverIsOpen() {
  return !!notificationsView && notificationsView.classList.contains('is-open');
}

function setNotificationsOpen(open: boolean | undefined, { restoreFocus = false } = {}) {
  if (!notificationsView || !btnNotificationsNav) return;
  notificationsView.classList.toggle('is-open', open);
  notificationsView.setAttribute('aria-hidden', open ? 'false' : 'true');
  btnNotificationsNav.classList.toggle('is-active', open);
  btnNotificationsNav.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    refreshNotificationsUi();
  } else if (restoreFocus) {
    btnNotificationsNav.focus();
  }
}

function showNotificationsView() {
  const open = !notificationsPopoverIsOpen();
  closeConvoMenu();
  if (open && typeof setProfileMenuOpen === 'function') setProfileMenuOpen(false);
  setNotificationsOpen(open, { restoreFocus: !open });
}

