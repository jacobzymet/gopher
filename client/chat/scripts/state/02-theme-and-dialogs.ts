function normalizeThemePref(theme: string) {
  if (theme === 'light' || theme === 'system') return theme;
  return 'dark';
}

function resolveTheme(pref: string) {
  if (pref === 'light') return 'light';
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Run a visual state change after the browser has presented the current one.
 * This keeps entry transitions reliable when an engine coalesces style and
 * visibility changes into the same paint.
 */
function afterNextPaint(callback: FrameRequestCallback) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function motionEnter(el: HTMLElement, { y = 14, duration = 220, delay = 0 } = {}) {
  if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return null;
  el.classList.add('motion-enter');
  const anim = el.animate(
    [
      { opacity: 0, transform: 'translateY(' + y + 'px)' },
      { opacity: 1, transform: 'none' },
    ],
    {
      duration,
      delay,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'backwards',
    }
  );
  const clear = () => {
    el.classList.remove('motion-enter');
    try { anim.cancel(); } catch { /* ignore */ }
  };
  anim.finished.then(clear).catch(clear);
  return anim;
}

const backdropFocusStack: BackdropFocus[] = [];

function backdropFocusableElements(el: HTMLElement) {
  return Array.from((el.querySelectorAll(
    'button, a[href], input, select, textarea, [contenteditable="true"], [tabindex]'
  ) as NodeListOf<HTMLElement>)).filter((node) => node.tabIndex >= 0 && !node.matches(':disabled')
    && !(node.closest('[inert]') as HTMLElement) && node.getClientRects().length > 0
    && getComputedStyle(node).visibility !== 'hidden');
}

function handleBackdropKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  const modal = backdropFocusStack.at(-1)?.el;
  if (!modal || event.defaultPrevented) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'
      && modal.id !== 'searchModal') {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (event.key === 'Escape') {
    // Dismiss only the top dialog, including confirmations over Settings.
    event.preventDefault();
    event.stopImmediatePropagation();
    switch (modal.id) {
      case 'confirmModal': settleConfirmDanger(false); break;
      case 'unlockModal': if (!unlockModalBusy) hideUnlockSession(); break;
      case 'searchModal': closeSearchModal(); break;
      case 'settingsModal': closeSettings(); break;
      case 'profileModal': closeProfileModal(); break;
      case 'projectModal': closeProjectSettings(); break;
      case 'groupModal': closeGroupDialog(); break;
    }
    return;
  }
  if (event.key !== 'Tab') return;
  const items = backdropFocusableElements(modal);
  const first = items[0] || modal;
  const last = items.at(-1) || modal;
  const active = document.activeElement;
  if (!items.includes(active)
      || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

document.addEventListener('keydown', handleBackdropKeydown);

function openBackdrop(el: HTMLElement) {
  if (!el) return;
  if (!backdropFocusStack.some((entry) => entry.el === el)) {
    backdropFocusStack.push({ el, previousFocus: document.activeElement });
  }
  el.setAttribute('tabindex', '-1');
  el.inert = false;
  el.classList.remove('is-hidden');
  el.dataset.opening = 'true';
  // Establish the closed style before scheduling the visible state.
  void el.offsetWidth;
  afterNextPaint(() => {
    if (el.dataset.opening !== 'true') return;
    delete el.dataset.opening;
    el.classList.add('is-open');
    if (backdropFocusStack.at(-1)?.el === el && !el.contains(document.activeElement)) {
      (backdropFocusableElements(el)[0] || el).focus();
    }
  });
}

function closeBackdrop(el: HTMLElement) {
  if (!el) return;
  const index = backdropFocusStack.findIndex((entry) => entry.el === el);
  if (index !== -1) {
    const wasTop = index === backdropFocusStack.length - 1;
    const [entry] = backdropFocusStack.splice(index, 1);
    backdropFocusStack.forEach((nested) => {
      if (el.contains(nested.previousFocus)) nested.previousFocus = entry.previousFocus;
    });
    if (wasTop && (el.contains(document.activeElement) || document.activeElement === document.body)) {
      const parent = backdropFocusStack.at(-1)?.el;
      const target = parent && !parent.contains(entry.previousFocus)
        ? backdropFocusableElements(parent)[0] || parent : entry.previousFocus;
      if (target?.isConnected && !(target.closest('[inert], .is-hidden') as HTMLElement)) {
        (target as HTMLElement).focus({ preventScroll: true });
      }
    }
  }
  el.inert = true;
  delete el.dataset.opening;
  el.classList.remove('is-open');
  if (prefersReducedMotion() || el.classList.contains('is-hidden')) {
    el.classList.add('is-hidden');
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (el.inert) el.classList.add('is-hidden');
    el.removeEventListener('transitionend', onEnd);
  };
  const onEnd = (event: TransitionEvent) => {
    if (event.target === el && event.propertyName === 'opacity') finish();
  };
  el.addEventListener('transitionend', onEnd);
  window.setTimeout(finish, 360);
}

let confirmDangerResolver: ((value: boolean) => void) | null = null;

function settleConfirmDanger(ok: boolean) {
  const resolve = confirmDangerResolver;
  confirmDangerResolver = null;
  const modal = (document.getElementById('confirmModal') as HTMLElement);
  if (modal) closeBackdrop(modal);
  if (resolve) resolve(!!ok);
}

function confirmDanger({ title, body, confirmLabel = 'Delete' }: {title?: string; body?: string; confirmLabel?: string} = {}): Promise<boolean> {
  const modal = (document.getElementById('confirmModal') as HTMLElement);
  if (!modal) return Promise.resolve(window.confirm(body || title || 'Are you sure?'));
  if (confirmDangerResolver) settleConfirmDanger(false);
  const titleEl = (document.getElementById('confirmModalTitle') as HTMLElement);
  const bodyEl = (document.getElementById('confirmModalBody') as HTMLElement);
  const okBtn = (document.getElementById('btnConfirmModalOk') as HTMLButtonElement);
  if (titleEl) titleEl.textContent = title || 'Are you sure?';
  if (bodyEl) {
    bodyEl.textContent = body || '';
    bodyEl.classList.toggle('is-hidden', !body);
  }
  if (okBtn) okBtn.textContent = confirmLabel;
  return new Promise<boolean>((resolve) => {
    confirmDangerResolver = resolve;
    openBackdrop(modal);
    window.requestAnimationFrame(() => (document.getElementById('btnConfirmModalCancel') as HTMLButtonElement)?.focus());
  });
}

function applyTheme(theme: string) {
  const pref = normalizeThemePref(theme);
  const resolved = resolveTheme(pref);
  const prevResolved = document.documentElement.dataset.theme;
  currentTheme = pref;
  const paint = () => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePref = pref;
    (document.querySelectorAll('[data-theme-choice]') as NodeListOf<HTMLElement>).forEach((btn) => {
      const active = btn.dataset.themeChoice === pref;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (prevResolved !== resolved && typeof repaintStarfield === 'function') {
      repaintStarfield();
    }
    if (typeof refreshTerminalThemes === 'function') refreshTerminalThemes();
    if (prevResolved !== resolved && typeof repaintEmptyOrb === 'function') {
      repaintEmptyOrb();
    }
    if (prevResolved !== resolved && settings?.chatBackgroundImage) {
      applyChatBackground(settings);
    }
  };
  if (
    prevResolved
    && prevResolved !== resolved
    && !prefersReducedMotion()
    && typeof document.startViewTransition === 'function'
  ) {
    document.startViewTransition(paint);
  } else {
    paint();
  }
}

if (window.matchMedia) {
  const systemThemeMq = window.matchMedia('(prefers-color-scheme: light)');
  const onSystemTheme = () => {
    if (currentTheme === 'system') applyTheme('system');
  };
  if (systemThemeMq.addEventListener) systemThemeMq.addEventListener('change', onSystemTheme);
  else if (systemThemeMq.addListener) systemThemeMq.addListener(onSystemTheme);
}

function applyFonts(appearance: Partial<AppState>) {
  const body = (FONT_BODY_STACKS[appearance.font_body as string] ? appearance.font_body : 'inter') as string;
  const display = (FONT_DISPLAY_STACKS[appearance.font_display as string]
    ? appearance.font_display
    : 'space-grotesk') as string;
  const scale = ['compact', 'default', 'large'].includes(appearance.font_scale)
    ? appearance.font_scale
    : 'default';
  currentFonts = { font_body: body, font_display: display, font_scale: scale };
  const root = document.documentElement;
  root.style.setProperty('--font-body', FONT_BODY_STACKS[body]);
  root.style.setProperty('--font-display', FONT_DISPLAY_STACKS[display]);
  // No monospace anywhere — code, chips, and labels use the body face.
  root.style.setProperty('--font-mono', FONT_BODY_STACKS[body]);
  root.style.setProperty('--font-logo', '"Syne", ' + FONT_DISPLAY_STACKS[display]);
  if (scale === 'default') delete root.dataset.fontScale;
  else root.dataset.fontScale = scale;
  const bodySelect = (document.getElementById('settingFontBody') as HTMLSelectElement);
  const displaySelect = (document.getElementById('settingFontDisplay') as HTMLSelectElement);
  if (bodySelect) bodySelect.value = body;
  if (displaySelect) displaySelect.value = display;
  (document.querySelectorAll('[data-font-scale]') as NodeListOf<HTMLElement>).forEach((btn) => {
    const active = btn.dataset.fontScale === scale;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function applyAppearance(data: AppState | null | undefined) {
  if (!data) return;
  if (data.theme) applyTheme(data.theme);
  applyFonts({
    font_body: data.font_body || currentFonts.font_body,
    font_display: data.font_display || currentFonts.font_display,
    font_scale: data.font_scale || currentFonts.font_scale,
  });
}

async function patchAppearance(patch: Partial<AppState>) {
  applyAppearance({ ...currentFonts, theme: currentTheme, ...patch });
  try {
    const response = await fetch('/api/ui/appearance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) return;
    applyAppearance(await response.json());
  } catch {
    // keep local appearance; next poll will reconcile
  }
}

async function setTheme(theme: string | undefined) {
  await patchAppearance({ theme });
}

async function resetAppearance() {
  try {
    const response = await fetch('/api/ui/appearance/reset', { method: 'POST' });
    if (!response.ok) return;
    applyAppearance(await response.json());
  } catch {
    // ignore
  }
}

const MENTION_OPTIONS: MentionOption[] = [
  {
    id: 'web_search',
    label: 'web_search',
    description: 'Search the web (stays on until you remove it)',
  },
  {
    id: 'fetch_url',
    label: 'fetch_url',
    description: 'Open a URL (stays on until you remove it)',
  },
  {
    id: 'deep_research',
    label: 'deep_research',
    description: 'Investigate across many sources for this message',
  },
];
const MENTION_IDS = MENTION_OPTIONS.map((item) => item.id);
const MENTION_TOKEN_RE = /@(?:web_search|fetch_url|deep_research|agent)\b/gi;
let mentionState: MentionState | null = null; // { start, query, activeIndex, items }
/** Active composer mentions shown as chips (not as literal text in the textarea). */
const composerMentionIds: Set<string> = new Set();
/** Textarea currently driving the @mention menu (composer or message edit). */
let mentionInput = composerInput;
const convoTitleEl = (document.getElementById('convoTitle') as HTMLElement);
const topbarBotRoster = (document.getElementById('topbarBotRoster') as HTMLElement);
const btnTopbarGroupEdit = (document.getElementById('btnTopbarGroupEdit') as HTMLButtonElement);
const greetingEl = (document.getElementById('greeting') as HTMLElement);
const modelHintEl = (document.getElementById('modelHint') as HTMLElement);

