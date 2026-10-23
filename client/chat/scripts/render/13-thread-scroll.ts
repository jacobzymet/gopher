function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 224) + 'px';
}

/** When true, streaming/paint keeps the viewport pinned to the latest message. */
let stickToBottom = true;
/** Explicit upward input wins until the user intentionally returns downward. */
let userScrollOverride = false;
let resumeBottomIntent = false;
let lastViewportScrollTop = 0;
const STICK_BOTTOM_PX = 48;
const PROMPT_PIN_TOP_PX = 8;

function syncPinnedUserPrompt() {
  const rows = [...(chatThread.querySelectorAll('.msg.msg-role-user:not(.msg-queued)') as NodeListOf<HTMLElement>)];
  if (chatShell?.dataset?.surface === 'bots') {
    rows.forEach((row) => {
      row.classList.toggle('is-pinned-prompt', false);
      row.style.removeProperty('--prompt-layout-h');
      row.style.removeProperty('--prompt-exit-progress');
      row.style.removeProperty('--prompt-exit-opacity');
      row.style.removeProperty('--prompt-exit-shift');
      row.style.removeProperty('--prompt-exit-scale');
    });
    return;
  }
  const vis = chatViewport.clientHeight || 0;
  if (vis) chatThread.style.setProperty('--thread-visible-h', vis + 'px');
  const pinLine = chatViewport.getBoundingClientRect().top + PROMPT_PIN_TOP_PX;
  let active: HTMLElement | null = null;
  let activeIndex = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.getBoundingClientRect().top <= pinLine) active = row;
    else break;
    activeIndex = index;
  }
  rows.forEach((row) => {
    const pin = row === active;
    if (pin && !row.classList.contains('is-pinned-prompt')) {
      row.style.setProperty('--prompt-layout-h', row.offsetHeight + 'px');
    }
    if (!pin) row.style.removeProperty('--prompt-layout-h');
    row.classList.toggle('is-pinned-prompt', pin);
    row.style.removeProperty('--prompt-exit-progress');
    row.style.removeProperty('--prompt-exit-opacity');
    row.style.removeProperty('--prompt-exit-shift');
    row.style.removeProperty('--prompt-exit-scale');
  });

  const next = activeIndex >= 0 ? rows[activeIndex + 1] : null;
  if (!active || !next) return;
  const activeHeight = active.getBoundingClientRect().height || 0;
  const exitDistance = Math.max(72, Math.min(activeHeight, 180));
  const distance = next.getBoundingClientRect().top - pinLine;
  const progress = Math.max(0, Math.min(1, 1 - (distance / exitDistance)));
  active.style.setProperty('--prompt-exit-progress', progress.toFixed(3));
  active.style.setProperty('--prompt-exit-opacity', (1 - progress).toFixed(3));
  active.style.setProperty('--prompt-exit-shift', (-5.6 * progress).toFixed(2) + 'px');
  active.style.setProperty('--prompt-exit-scale', (1 - (0.012 * progress)).toFixed(4));
}

function isNearBottom() {
  const gap = chatViewport.scrollHeight - chatViewport.scrollTop - chatViewport.clientHeight;
  return gap <= STICK_BOTTOM_PX;
}

function scrollToBottom({ force = false } = {}) {
  if (!force && !stickToBottom) return;
  if (force) {
    stickToBottom = true;
    userScrollOverride = false;
    resumeBottomIntent = false;
  }
  chatViewport.scrollTop = chatViewport.scrollHeight;
  lastViewportScrollTop = chatViewport.scrollTop;
  syncPinnedUserPrompt();
}

function unpinFromBottom() {
  stickToBottom = false;
  userScrollOverride = true;
  resumeBottomIntent = false;
}

chatViewport.addEventListener('scroll', () => {
  syncPinnedUserPrompt();
  const currentTop = chatViewport.scrollTop;
  const movingDown = currentTop > lastViewportScrollTop + 0.5;
  const nearBottom = isNearBottom();

  if (userScrollOverride) {
    if (nearBottom && (resumeBottomIntent || movingDown)) {
      userScrollOverride = false;
      resumeBottomIntent = false;
      stickToBottom = true;
    } else {
      stickToBottom = false;
    }
  } else {
    stickToBottom = nearBottom;
  }

  lastViewportScrollTop = currentTop;
}, { passive: true });
// Keep overflowed pinned prompts scrolling locally instead of driving the thread.
chatViewport.addEventListener('wheel', (event) => {
  const pinBubble = ((event.target as Element).closest?.('#chatThread > .msg.msg-role-user.is-pinned-prompt > .msg-bubble') as HTMLElement);
  if (!pinBubble || pinBubble.scrollHeight <= pinBubble.clientHeight + 1) return;
  const goingUp = event.deltaY < 0;
  const atTop = pinBubble.scrollTop <= 0;
  const atBottom = pinBubble.scrollTop + pinBubble.clientHeight >= pinBubble.scrollHeight - 1;
  if ((goingUp && !atTop) || (!goingUp && !atBottom)) {
    pinBubble.scrollTop += event.deltaY;
    event.preventDefault();
    event.stopPropagation();
  }
}, { capture: true, passive: false });
// Unpin immediately on intentional upward scroll (don't wait for layout).
chatViewport.addEventListener('wheel', (event) => {
  if (event.deltaY < 0) unpinFromBottom();
  else if (event.deltaY > 0 && userScrollOverride) resumeBottomIntent = true;
}, { passive: true });

chatViewport.addEventListener('keydown', (event) => {
  if (event.key === 'PageUp' || event.key === 'Home' || event.key === 'ArrowUp') {
    unpinFromBottom();
  } else if (event.key === 'PageDown' || event.key === 'End' || event.key === 'ArrowDown') {
    resumeBottomIntent = true;
  }
});
let touchStickY: number | null = null;
chatViewport.addEventListener('touchstart', (event) => {
  touchStickY = event.touches[0] ? event.touches[0].clientY : null;
}, { passive: true });
chatViewport.addEventListener('touchmove', (event) => {
  if (touchStickY == null || !event.touches[0]) return;
  // Finger moving down → content scrolls up → user is reading earlier messages.
  const nextY = event.touches[0].clientY;
  const deltaY = nextY - touchStickY;
  if (deltaY > 8) {
    unpinFromBottom();
    touchStickY = nextY;
  } else if (deltaY < -8) {
    if (userScrollOverride) resumeBottomIntent = true;
    touchStickY = nextY;
  }
}, { passive: true });

function greetingForNow() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function showEmptyState() {
  emptyState.classList.remove('is-hidden');
  threadWrap.classList.add('is-hidden');
  chatTopbar.classList.remove('has-thread');
  chatShell.classList.remove('has-active-thread');
  convoTitleEl.removeAttribute('role');
  convoTitleEl.removeAttribute('tabindex');
  convoTitleEl.removeAttribute('title');
  // Drop the previous thread's nodes — sendMessage appends to whatever is
  // here, so leaving them would splice the old conversation into the new one.
  chatThread.innerHTML = '';
  if (composerShell.parentElement !== emptyStateInner) {
    emptyStateInner.appendChild(composerShell);
  }
  syncProjectChrome();
}

function showThread(convo: Conversation) {
  emptyState.classList.add('is-hidden');
  threadWrap.classList.remove('is-hidden');
  chatTopbar.classList.add('has-thread');
  chatShell.classList.add('has-active-thread');
  convoTitleEl.textContent = convo?.incognito ? '' : (convo.title || 'New chat');
  if (convo?.incognito) {
    convoTitleEl.removeAttribute('role');
    convoTitleEl.removeAttribute('tabindex');
    convoTitleEl.removeAttribute('title');
  } else {
    convoTitleEl.setAttribute('role', 'button');
    convoTitleEl.setAttribute('tabindex', '0');
    convoTitleEl.title = 'Rename chat';
  }
  if (composerShell.parentElement !== composerDock) {
    composerDock.appendChild(composerShell);
  }
  syncProjectChrome();
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="13" height="13" rx="2"></rect>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
  '</svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 6 9 17l-5-5"></path>' +
  '</svg>';
const EDIT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20h9"></path>' +
    '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>' +
  '</svg>';
const REPLY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m9 17-5-5 5-5"></path>' +
    '<path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>' +
  '</svg>';

let editingRow: HTMLElement | null = null;

