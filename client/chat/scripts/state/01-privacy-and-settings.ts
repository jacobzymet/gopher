const TRACE_DESKTOP_MQ = window.matchMedia('(min-width: 821px)');

/**
 * Build a synthetic pixel mosaic from an opaque UI identifier. The pattern is
 * deliberately unrelated to the protected text, so it cannot be sharpened or
 * processed back into the original words.
 */
function applyPrivacyMosaic(el: HTMLElement, seed: string, { dense = false } = {}) {
  if (!el) return;
  let state = 2166136261;
  const source = String(seed || 'private-surface');
  for (let i = 0; i < source.length; i += 1) {
    state ^= source.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  const rows = dense ? 6 : 3;
  const columns = dense ? 6 : (15 + Math.floor(random() * 12));
  const shadows = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (dense) {
        const center = (columns - 1) / 2;
        const distance = Math.hypot(column - center, row - center);
        if (distance > 2.6) continue;
      }
      if (column > 0 && random() < 0.2) continue;
      const shade = 1 + Math.floor(random() * 4);
      const x = (column * 4).toFixed(1);
      const y = (row * 4).toFixed(1);
      shadows.push(x + 'px ' + y + 'px 0 var(--privacy-pixel-' + shade + ')');
    }
  }
  el.classList.add('privacy-mask');
  if (dense) el.classList.add('privacy-mask-dense');
  el.style.setProperty('--privacy-pixels', shadows.join(', '));
}

function isPrivacyModeOn() {
  return !!(document.getElementById('chatShell') as HTMLElement)?.classList.contains('privacy-mode');
}

/** Native `title` tooltips leak mosaiced identity; keep the value for when privacy turns off. */
function setIdentityTitle(el: HTMLElement | null | undefined, text: string | undefined) {
  if (!el) return;
  const value = String(text || '');
  if (value) el.dataset.identityTitle = value;
  else delete el.dataset.identityTitle;
  el.title = isPrivacyModeOn() ? '' : value;
}

function syncIdentityTitles(privacyOn: boolean) {
  (document.querySelectorAll('[data-identity-title]') as NodeListOf<HTMLElement>).forEach((el) => {
    el.title = privacyOn ? '' : (el.dataset.identityTitle || '');
  });
}

function normalizeThinkingEffort(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'auto';
}
const WEB_SEARCH_DEPTHS = ['auto', 'off', 'light', 'standard', 'deep'];
const WEB_SEARCH_PROVIDERS = ['auto', 'parallel', 'tinyfish', 'searxng', 'duckduckgo'];
const WEB_SEARCH_PARALLEL_MODES = ['turbo', 'fast', 'basic', 'advanced'];
const WEB_SEARCH_SAFESEARCH = ['on', 'moderate', 'off'];
const WEB_SEARCH_RECENCIES = ['any', 'day', 'week', 'month', 'year'];

const ATTACHMENTS_MODES = ['auto', 'on', 'off'];
const ATTACHMENT_MIN_CONTEXT = 16384;
const ATTACHMENT_MAX_FILES = 6;
const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const CHAT_BACKGROUND_MAX_BYTES = 1024 * 1024;
const CHAT_BACKGROUND_POSITIONS = [
  'center', 'top', 'bottom', 'left', 'right',
  'top left', 'top right', 'bottom left', 'bottom right',
];
const PROJECT_MEMORY_MODES = ['default', 'project_only'];
const APPROVAL_MODES = ['manual', 'auto_safe', 'auto_all'];
const DEFAULT_PROFILE_ID = 'personal';
const PROFILE_CONTEXT_KEYS: Array<'about' | 'instructions' | 'memory'> = ['about', 'instructions', 'memory'];
const DEFAULT_SETTINGS = {
  name: '',
  about: '',
  instructions: '',
  memory: '',
  chatRetrieval: true,
  thinking: 'collapsed', // collapsed | hidden | visible
  thinkingEffort: 'auto', // auto | off | a provider-advertised effort
  enterSends: true,
  skillWebSearch: true,
  webSearchDepth: 'off', // off | auto | light | standard | deep
  webSearchProvider: 'auto', // auto | parallel | tinyfish | searxng | duckduckgo
  webSearchSearxng: '',
  webSearchParallelApiKey: '',
  webSearchParallelMode: 'fast', // turbo | fast | basic | advanced
  webSearchTinyfishApiKey: '',
  webSearchResults: 6,
  webSearchRegion: 'us-en',
  webSearchSafeSearch: 'moderate',
  webSearchRecency: 'any',
  skillFetchUrl: true,
  fetchUrlMaxChars: 8000,
  webSearchPageMaxChars: 0,
  skillDeepResearch: false,
  approvalMode: 'auto_safe',
  diagnosticsEnabled: false,
  skillFilesystem: false,
  skillTerminal: false,
  skillBrowser: false,
  terminalTimeoutSecs: 30,
  terminalHeightVh: 0.25,
  agentMode: false,
  deepResearch: 'off', // Retired mode: retained for stored-preference compatibility.
  attachmentsMode: 'auto', // auto | on | off
  attachmentTextFallback: false,
  attachmentOcr: false,
  attachmentMaxChars: 48000,
  chatBackgroundImage: '',
  chatBackgroundImageName: '',
  chatBackgroundPosition: 'center',
  chatBackgroundOverlay: 72,
  selectedChatModel: '', // Default; manual chat choices live in conversation.modelId.
  recentModelIds: [] as string[],
  pinnedModelIds: [] as string[],
  collapsedModelProviders: [] as string[],
  sidebarCollapsed: false,
  privacyMode: false,
  appSurface: 'chat',
  traceActivityShare: 0.6,
  traceActivityFolded: false,
  traceMembersFolded: false,
  autoOpenTraceSidebar: true,
  updateDismissed: '',
  browserMigrationVersion: 1,
};

const chatShell = (document.getElementById('chatShell') as HTMLElement);
const chatMain = (document.querySelector('.chat-main') as HTMLElement);
const chatTopbar = (document.getElementById('chatTopbar') as HTMLElement);
const emptyState = (document.getElementById('emptyState') as HTMLElement);
const emptyStateInner = (document.getElementById('emptyStateInner') as HTMLElement);
const threadWrap = (document.getElementById('threadWrap') as HTMLElement);
const chatThread = (document.getElementById('chatThread') as HTMLElement);
const chatViewport = (document.getElementById('chatViewport') as HTMLElement);
const composerDock = (document.getElementById('composerDock') as HTMLElement);
const composerCard = (document.getElementById('composerCard') as HTMLElement);
const composerShell = (document.getElementById('composerShell') as HTMLElement);
const composerInput = (document.getElementById('composerInput') as HTMLTextAreaElement);
const composerHint = (document.getElementById('composerHint') as HTMLElement);
const composerMentions = (document.getElementById('composerMentions') as HTMLElement);
const composerReply = (document.getElementById('composerReply') as HTMLElement);
const selectionReplyBar = (document.getElementById('selectionReplyBar') as HTMLElement);
const btnSelectionReply = (document.getElementById('btnSelectionReply') as HTMLButtonElement);
const mentionMenu = (document.getElementById('mentionMenu') as HTMLElement);
const settingsModal = (document.getElementById('settingsModal') as HTMLElement);
const encryptionIndicator = (document.getElementById('encryptionIndicator') as HTMLButtonElement);
const encryptionIndicatorLabel = (document.getElementById('encryptionIndicatorLabel') as HTMLElement);
const encryptionIndicatorDetail = (document.getElementById('encryptionIndicatorDetail') as HTMLElement);
const projectModal = (document.getElementById('projectModal') as HTMLElement);
const projectsView = (document.getElementById('projectsView') as HTMLElement);
const projectsGrid = (document.getElementById('projectsGrid') as HTMLElement);
const projectsSearch = (document.getElementById('projectsSearch') as HTMLInputElement);
const projectsSort = (document.getElementById('projectsSort') as HTMLSelectElement);
const btnProjectsNav = (document.getElementById('btnProjectsNav') as HTMLButtonElement);
const notificationsView = (document.getElementById('notificationsView') as HTMLElement);
const notificationsFeed = (document.getElementById('notificationsFeed') as HTMLElement);
const notificationsLede = (document.getElementById('notificationsLede') as HTMLElement);
const btnNotificationsNav = (document.getElementById('btnNotificationsNav') as HTMLButtonElement);
const btnNotificationsMarkRead = (document.getElementById('btnNotificationsMarkRead') as HTMLButtonElement);
const sidebarNotificationBadge = (document.getElementById('sidebarNotificationBadge') as HTMLElement);
const sidebarProfileMenu = (document.getElementById('sidebarProfileMenu') as HTMLElement);
const sidebarProfileList = (document.getElementById('sidebarProfileList') as HTMLElement);
const btnProfileMenu = (document.getElementById('btnProfileMenu') as HTMLButtonElement);
const sidebarAccountAvatar = (document.getElementById('sidebarAccountAvatar') as HTMLElement);
const sidebarAccountName = (document.getElementById('sidebarAccountName') as HTMLElement);
const sidebarActiveProfileName = (document.getElementById('sidebarActiveProfileName') as HTMLElement);
const sidebarProjectContext = (document.getElementById('sidebarProjectContext') as HTMLElement);
const sidebarConvoLabel = (document.getElementById('sidebarConvoLabel') as HTMLElement);
const btnManageConvos = (document.getElementById('btnManageConvos') as HTMLButtonElement);
const sidebarBulkActions = (document.getElementById('sidebarBulkActions') as HTMLElement);
const sidebarBulkCount = (document.getElementById('sidebarBulkCount') as HTMLElement);
const btnBulkPinConvos = (document.getElementById('btnBulkPinConvos') as HTMLButtonElement);
const btnBulkDeleteConvos = (document.getElementById('btnBulkDeleteConvos') as HTMLButtonElement);
const sidebarPinnedSection = (document.getElementById('sidebarPinnedSection') as HTMLElement);
const pinnedConvoList = (document.getElementById('pinnedConvoList') as HTMLElement);
const topbarProject = (document.getElementById('topbarProject') as HTMLElement);
const emptyEyebrow = (document.getElementById('emptyEyebrow') as HTMLElement);
const btnNewChat = (document.getElementById('btnNewChat') as HTMLButtonElement);
const btnNewChatLabel = (document.getElementById('btnNewChatLabel') as HTMLElement);
const btnNewIncognitoChat = (document.getElementById('btnNewIncognitoChat') as HTMLButtonElement);
const topbarIncognito = (document.getElementById('topbarIncognito') as HTMLElement);
const topbarBotsHold = (document.getElementById('topbarBotsHold') as HTMLElement);
const topbarLoopPhase = (document.getElementById('topbarLoopPhase') as HTMLButtonElement);
const btnSend = (document.getElementById('btnSend') as HTMLButtonElement);
const btnBranch = (document.getElementById('btnBranch') as HTMLButtonElement);
const contextUsage = (document.getElementById('contextUsage') as HTMLElement);
const contextUsageTooltip = (document.getElementById('contextUsageTooltip') as HTMLElement);
const contextUsageTitle = (document.getElementById('contextUsageTitle') as HTMLElement);
const contextUsageSummary = (document.getElementById('contextUsageSummary') as HTMLElement);
const contextUsageDetail = (document.getElementById('contextUsageDetail') as HTMLElement);
const btnStop = (document.getElementById('btnStop') as HTMLButtonElement);
const btnPlus = (document.getElementById('btnPlus') as HTMLButtonElement);
const plusMenu = (document.getElementById('plusMenu') as HTMLElement);
const composerModes = (document.getElementById('composerModes') as HTMLElement);
const btnMic = (document.getElementById('btnMic') as HTMLButtonElement);
const attachFileInput = (document.getElementById('attachFileInput') as HTMLInputElement);
const composerAttachmentsEl = (document.getElementById('composerAttachments') as HTMLElement);
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let voiceRecognition: BrowserRecognition | null = null;
let voiceListening = false;
let voicePrefix = '';
let voiceSuffix = '';
let voiceFinal = '';
let voiceHintUntil = 0;
const traceSidebar = (document.getElementById('traceSidebar') as HTMLElement);
const traceSidebarBody = (document.getElementById('traceSidebarBody') as HTMLElement);
const traceSidebarTitle = (document.getElementById('traceSidebarTitle') as HTMLElement);
const traceSidebarSplit = (document.getElementById('traceSidebarSplit') as HTMLElement);
const loopFlow = (document.getElementById('loopFlow') as HTMLElement);
const loopFlowCount = (document.getElementById('loopFlowCount') as HTMLElement);
const loopFlowCurrent = (document.getElementById('loopFlowCurrent') as HTMLElement);
const loopFlowRail = (document.getElementById('loopFlowRail') as HTMLElement);
const loopFlowAgents = (document.getElementById('loopFlowAgents') as HTMLElement);
const traceSplitHandle = (document.getElementById('traceSplitHandle') as HTMLElement);
const traceMembers = (document.getElementById('traceMembers') as HTMLElement);
const traceMembersList = (document.getElementById('traceMembersList') as HTMLElement);
const traceMembersPicker = (document.getElementById('traceMembersPicker') as HTMLElement);
const btnTraceMemberAdd = (document.getElementById('btnTraceMemberAdd') as HTMLButtonElement);
const btnTraceActivityFold = (document.getElementById('btnTraceActivityFold') as HTMLButtonElement);
const btnTraceMembersFold = (document.getElementById('btnTraceMembersFold') as HTMLButtonElement);
const btnExpandTrace = (document.getElementById('btnExpandTrace') as HTMLButtonElement);

/** Selected assistant message index for the activity sidebar (desktop). */
let selectedTraceMsgIndex: number | null = null;
let traceSidebarSwapTimer = 0;
/** Convo id we already auto-opened the rail for during the current turn. */
let traceAutoOpenedForStream: string | null = null;
/** User manually hid the rail this turn — don't fight them with auto-open. */
let traceUserCollapsed = false;
/** Keep the activity rail pinned to the latest step unless the user scrolls up. */
let stickTraceSidebar = true;
let terminalOpen = false;
let draftWorkspaceRoot = '';
let currentFonts = {
  font_body: 'inter',
  font_display: 'space-grotesk',
  font_scale: 'default',
};
let currentTheme: ThemePreference = 'dark';
let repaintStarfield: (() => void) | null = null;
let repaintEmptyOrb: (() => void) | null = null;
let chatBackgroundApplyToken = 0;

function normalizeChatBackgroundImage(value: unknown) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return '';
  if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(source)) {
    const encoded = source.slice(source.indexOf(',') + 1);
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return '';
    const padding = encoded.endsWith('==') ? 2 : (encoded.endsWith('=') ? 1 : 0);
    const estimatedBytes = Math.floor(encoded.length * 3 / 4) - padding;
    return estimatedBytes <= CHAT_BACKGROUND_MAX_BYTES ? source : '';
  }
  if (source.length > 4096) return '';
  try {
    const url = new URL(source);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function chatBackgroundRelativeLuminance(red: number, green: number, blue: number) {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function setChatBackgroundTone(luminance: number, token: number) {
  if (token !== chatBackgroundApplyToken) return;
  // WCAG contrast curves cross at ~0.179: above it black is more legible,
  // below it white is more legible.
  chatMain.dataset.backgroundTone = luminance > 0.179 ? 'light' : 'dark';
  if (typeof repaintEmptyOrb === 'function') repaintEmptyOrb();
}

function fallbackChatBackgroundTone(overlayOpacity: number, token: number) {
  // Cross-origin images without CORS cannot be sampled. A mid-bright image is
  // a better neutral estimate than blindly following the UI theme.
  const visibleChannel = 255 * 0.62 * (1 - overlayOpacity);
  setChatBackgroundTone(
    chatBackgroundRelativeLuminance(visibleChannel, visibleChannel, visibleChannel),
    token
  );
}

function sampleChatBackgroundTone(sampleImage: CanvasImageSource, overlayOpacity: number, token: number) {
  if (token !== chatBackgroundApplyToken) return;
  try {
    const canvas = (document.createElement('canvas') as HTMLCanvasElement);
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(sampleImage, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const baseChannel = document.documentElement.dataset.theme === 'light' ? 245 : 30;
    const overlayFactor = 1 - overlayOpacity;
    let luminance = 0;
    let samples = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const imageAlpha = pixels[index + 3] / 255;
      const red = (pixels[index] * imageAlpha + baseChannel * (1 - imageAlpha)) * overlayFactor;
      const green = (pixels[index + 1] * imageAlpha + baseChannel * (1 - imageAlpha)) * overlayFactor;
      const blue = (pixels[index + 2] * imageAlpha + baseChannel * (1 - imageAlpha)) * overlayFactor;
      luminance += chatBackgroundRelativeLuminance(red, green, blue);
      samples += 1;
    }
    setChatBackgroundTone(luminance / Math.max(1, samples), token);
  } catch {
    fallbackChatBackgroundTone(overlayOpacity, token);
  }
}

function resolveChatBackgroundTone(image: HTMLImageElement, source: string, overlayOpacity: number, token: number) {
  let isSameOrigin = source.startsWith('data:');
  try {
    isSameOrigin = isSameOrigin || new URL(source, window.location.href).origin === window.location.origin;
  } catch {
    // normalizeChatBackgroundImage already rejects malformed sources.
  }
  if (isSameOrigin) {
    sampleChatBackgroundTone(image, overlayOpacity, token);
    return;
  }
  // Use a separate CORS request for analysis so servers without CORS still
  // display normally through the primary image element.
  const sampler = new Image();
  sampler.crossOrigin = 'anonymous';
  sampler.addEventListener('load', () => sampleChatBackgroundTone(sampler, overlayOpacity, token));
  sampler.addEventListener('error', () => fallbackChatBackgroundTone(overlayOpacity, token));
  sampler.src = source;
}

function applyChatBackground(appearance: Partial<AppSettings>) {
  const host = (document.getElementById('chatBackground') as HTMLElement);
  const image = (document.getElementById('chatBackgroundImage') as HTMLImageElement);
  const overlay = (document.getElementById('chatBackgroundOverlay') as HTMLElement);
  if (!host || !image || !overlay) return;
  const source = normalizeChatBackgroundImage(appearance?.chatBackgroundImage);
  const position = CHAT_BACKGROUND_POSITIONS.includes(appearance?.chatBackgroundPosition)
    ? appearance.chatBackgroundPosition
    : DEFAULT_SETTINGS.chatBackgroundPosition;
  const opacity = Number(appearance?.chatBackgroundOverlay);
  const normalizedOpacity = Number.isFinite(opacity)
    ? Math.min(100, Math.max(0, Math.round(opacity)))
    : DEFAULT_SETTINGS.chatBackgroundOverlay;
  const overlayOpacity = normalizedOpacity / 100;
  const token = ++chatBackgroundApplyToken;
  image.style.objectPosition = position;
  overlay.style.opacity = String(overlayOpacity);
  if (!source) {
    image.removeAttribute('src');
    host.classList.remove('has-image');
    delete chatMain.dataset.backgroundTone;
    if (typeof repaintEmptyOrb === 'function') repaintEmptyOrb();
    return;
  }
  image.onload = () => {
    if (token !== chatBackgroundApplyToken) return;
    host.classList.add('has-image');
    resolveChatBackgroundTone(image, source, overlayOpacity, token);
  };
  image.onerror = () => {
    if (token !== chatBackgroundApplyToken) return;
    host.classList.remove('has-image');
    delete chatMain.dataset.backgroundTone;
    if (typeof repaintEmptyOrb === 'function') repaintEmptyOrb();
  };
  image.src = source;
  if (image.complete && image.naturalWidth > 0) image.onload(new Event('load'));
}

const FONT_BODY_STACKS: Record<string, string> = {
  inter: '"Inter", system-ui, sans-serif',
  'source-sans-3': '"Source Sans 3", system-ui, sans-serif',
  'ibm-plex-sans': '"IBM Plex Sans", system-ui, sans-serif',
  'atkinson-hyperlegible': '"Atkinson Hyperlegible", system-ui, sans-serif',
  literata: '"Literata", Georgia, serif',
};
const FONT_DISPLAY_STACKS: Record<string, string> = {
  'space-grotesk': '"Space Grotesk", system-ui, sans-serif',
  syne: '"Syne", system-ui, sans-serif',
  'dm-sans': '"DM Sans", system-ui, sans-serif',
  'instrument-sans': '"Instrument Sans", system-ui, sans-serif',
  fraunces: '"Fraunces", Georgia, serif',
};

