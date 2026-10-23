const BOT_HANDLE_RE = /^[a-z][a-z0-9_]{1,31}$/;
const BOT_MENTION_RE = /@([a-z][a-z0-9_]{1,31}|everyone|user)\b/gi;
const BOT_COMPACT_CHARS = 28000;
const BOT_COMPACT_KEEP = 10;
const LOOP_AGENT_MIN = 2;
const LOOP_AGENT_MAX = 8;
const LOOP_ROLE_PRESETS = [
  { handle: 'solver', stage: 'explore', description: 'Propose a solution. Be concrete and show your work.' },
  { handle: 'critic', stage: 'challenge', description: 'Find errors, gaps, and weaker assumptions in the solution.' },
  { handle: 'verifier', stage: 'challenge', description: 'Independently check the result. Confirm or reject with evidence.' },
  { handle: 'analyst', stage: 'explore', description: 'Break the problem into parts and name what would change the answer.' },
  { handle: 'skeptic', stage: 'challenge', description: 'Ask what would have to be true for this to be wrong.' },
  { handle: 'synthesizer', stage: 'answer', description: 'Merge the strongest points into one answer the room can stand behind.' },
  { handle: 'redteam', stage: 'challenge', description: 'Try to break the current answer. Prefer a counterexample over vibes.' },
  { handle: 'auditor', stage: 'challenge', description: 'Check units, edge cases, citations, and whether the claim is actually supported.' },
];
const LOOP_REVIEW_ROLE_RE = /\b(critic|verifier|skeptic|red\s*team|redteam|auditor|review|check|challenge|risk)\b/i;
const LOOP_ANSWER_ROLE_RE = /\b(synthesi[sz]er|editor|decider|final answer|integrat)\b/i;
/** Bumped on Stop so in-flight group hop loops exit instead of spawning more turns. */
const botsOutboundEpoch: Map<string, number> = new Map();
/** Refcount: a group stays busy between hops, not only while a stream is live. */
const botsOutboundActive: Map<string, number> = new Map();

function isBotsOutboundActive(convoId: string | null | undefined) {
  return !!convoId && (botsOutboundActive.get(convoId) || 0) > 0;
}

function markBotsOutboundActive(convoId: string) {
  if (!convoId) return;
  botsOutboundActive.set(convoId, (botsOutboundActive.get(convoId) || 0) + 1);
  if (typeof syncComposerStreamUi === 'function') syncComposerStreamUi();
}

function clearBotsOutboundActive(convoId: string) {
  if (!convoId) return;
  const next = (botsOutboundActive.get(convoId) || 0) - 1;
  if (next <= 0) botsOutboundActive.delete(convoId);
  else botsOutboundActive.set(convoId, next);
  if (typeof syncComposerStreamUi === 'function') syncComposerStreamUi();
}

function bumpBotsOutboundEpoch(convoId: string | null | undefined) {
  if (!convoId) return 0;
  const next = (botsOutboundEpoch.get(convoId) || 0) + 1;
  botsOutboundEpoch.set(convoId, next);
  return next;
}

function botsOutboundEpochOf(convoId: string) {
  return botsOutboundEpoch.get(convoId) || 0;
}

function stopAllBotsOutbound() {
  for (const id of [...botsOutboundActive.keys()]) {
    if (typeof markBotsOutboundStopped === 'function') markBotsOutboundStopped(id);
    bumpBotsOutboundEpoch(id);
  }
}

/** True when the model used the silent skip token (not a real reply). */
function isSilentNoReply(text: string) {
  let raw = String(text || '');
  if (!raw.trim()) return false;
  raw = raw.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, ' ');
  raw = raw.replace(/<\/?(?:think|thinking)>/gi, ' ');
  raw = raw.replace(/<[^>]+>/g, ' ');
  raw = raw.replace(/[*_`~]+/g, '');
  raw = raw.replace(/^\s*[-*•>]+\s*/gm, '');
  raw = raw.replace(/["'“”‘’]/g, '');
  raw = raw.replace(/\s+/g, ' ').trim();
  return /^NO[_ -]?REPLY\.?$/i.test(raw);
}

function isBotsSurface() {
  return appSurface === 'bots';
}

function paintLoopModelHint() {
  if (!isBotsSurface() || !modelHintEl) return false;
  modelHintEl.classList.remove('is-hidden');
  const convo = conversations.find((item) => item.id === activeId);
  const members = convo && typeof participantBots === 'function' ? participantBots(convo) : [];
  if (!members.length) {
    modelHintEl.textContent = 'Several models, one problem — they debate until the answer holds.';
    return true;
  }
  const labels = members.map((bot) => {
    const model = loopAgentModelLabel(bot);
    return model ? ('@' + bot.handle + ' · ' + model) : ('@' + bot.handle);
  });
  modelHintEl.textContent = labels.length <= 3
    ? labels.join('  ·  ')
    : (members.length + ' agents, each with its own model');
  return true;
}

function convoSurfaceOf(convo: Conversation | null | undefined) {
  return convo && convo.surface === 'bots' ? 'bots' : 'chat';
}

function isBotsConvo(convo: Conversation | null | undefined): convo is BotsConversation {
  return convoSurfaceOf(convo) === 'bots';
}

function isBotGroup(convo: Conversation | null | undefined): convo is BotsGroupConversation {
  return !!(convo && convo.surface === 'bots' && convo.botKind === 'group');
}

function conversationsOnSurface(surface?: string) {
  const want = surface || appSurface;
  return conversations.filter((convo) => convoSurfaceOf(convo) === want);
}

function allLoopAgents() {
  const found: Bot[] = [];
  const seen = new Set();
  (conversations || []).forEach((convo) => {
    (Array.isArray(convo?.loopAgents) ? convo.loopAgents : []).forEach((bot) => {
      if (!bot || !bot.id || seen.has(bot.id)) return;
      seen.add(bot.id);
      found.push(bot);
    });
  });
  return found;
}

function getBot(id: string | null | undefined, convo?: Conversation | null) {
  if (!id) return null;
  const scoped = Array.isArray(convo?.loopAgents) ? convo.loopAgents : null;
  if (scoped) {
    const hit = scoped.find((bot) => bot.id === id);
    if (hit) return hit;
  }
  const fromLoop = allLoopAgents().find((bot) => bot.id === id);
  if (fromLoop) return fromLoop;
  return bots.find((bot) => bot.id === id) || null;
}

function botByHandle(handle: string, convo?: Conversation | null) {
  const key = String(handle || '').replace(/^@/, '').trim().toLowerCase();
  if (!key) return null;
  const scoped = convo ? participantBots(convo) : [];
  const inRoom = scoped.find((bot) => bot.handle === key);
  if (inRoom) return inRoom;
  const fromLoop = allLoopAgents().find((bot) => bot.handle === key);
  if (fromLoop) return fromLoop;
  return bots.find((bot) => bot.handle === key) || null;
}

function normalizeHandle(raw: unknown) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function normalizeBot(bot?: Partial<Bot> | null | undefined): Bot {
  const handle = normalizeHandle(bot && bot.handle);
  const safeHandle = BOT_HANDLE_RE.test(handle)
    ? handle
    : ('bot_' + String((bot && bot.id) || 'x').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase());
  const avatarSeed = typeof bot?.avatarSeed === 'string' && bot.avatarSeed.trim()
    ? bot.avatarSeed.trim().slice(0, 64)
    : (safeHandle || 'bot');
  return {
    id: (bot && bot.id) || newId('b'),
    handle: safeHandle || 'bot',
    name: typeof bot?.name === 'string' && bot.name.trim() ? bot.name.trim() : ('@' + (safeHandle || 'bot')),
    description: typeof bot?.description === 'string' ? bot.description : '',
    memory: typeof bot?.memory === 'string' ? bot.memory : '',
    avatarSeed,
    model: typeof bot?.model === 'string' ? bot.model.trim() : '',
    stage: ['auto', 'explore', 'challenge', 'answer'].includes(bot?.stage) ? bot.stage : 'auto',
    sessionId: typeof bot?.sessionId === 'string' ? bot.sessionId : null,
    createdAt: typeof bot?.createdAt === 'number' ? bot.createdAt : Date.now(),
    updatedAt: typeof bot?.updatedAt === 'number' ? bot.updatedAt : Date.now(),
  };
}

function hashAvatarSeed(seed: unknown) {
  let h = 2166136261;
  const text = String(seed || 'bot');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Curated hues — varied, readable on light/dark paper. */
const BOT_AVATAR_HUES = [18, 42, 72, 145, 175, 198, 222, 248, 312, 348];

function botAvatarSeed(botOrSeed: string | Partial<Bot> | null | undefined) {
  if (typeof botOrSeed === 'string') return botOrSeed.trim() || 'bot';
  if (botOrSeed && typeof botOrSeed.avatarSeed === 'string' && botOrSeed.avatarSeed.trim()) {
    return botOrSeed.avatarSeed.trim();
  }
  if (botOrSeed && botOrSeed.handle) return String(botOrSeed.handle);
  return 'bot';
}

function buildBotAvatarSvg(seedInput: string | Partial<Bot> | null | undefined) {
  const seed = botAvatarSeed(seedInput);
  const h = hashAvatarSeed(seed);
  const hue = BOT_AVATAR_HUES[h % BOT_AVATAR_HUES.length];
  const hue2 = BOT_AVATAR_HUES[(h >>> 5) % BOT_AVATAR_HUES.length];
  const bg = `oklch(0.78 0.11 ${hue})`;
  const mid = `oklch(0.62 0.14 ${hue2})`;
  const ink = `oklch(0.28 0.06 ${hue})`;
  const letter = (seed.replace(/^@/, '').charAt(0) || '?').toUpperCase();
  const cx = 18 + (h % 28);
  const cy = 14 + ((h >>> 8) % 24);
  const r = 10 + ((h >>> 12) % 14);
  const x2 = 8 + ((h >>> 16) % 36);
  const y2 = 30 + ((h >>> 20) % 18);
  const r2 = 6 + ((h >>> 24) % 12);
  const rot = (h >>> 3) % 360;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-hidden="true">' +
      '<rect width="64" height="64" rx="32" fill="' + bg + '"/>' +
      '<g opacity="0.88">' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + mid + '"/>' +
        '<circle cx="' + x2 + '" cy="' + y2 + '" r="' + r2 + '" fill="' + ink + '" opacity="0.22"/>' +
        '<rect x="28" y="8" width="22" height="22" rx="8" fill="' + ink + '" opacity="0.16" transform="rotate(' + rot + ' 39 19)"/>' +
      '</g>' +
      '<text x="32" y="38" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="26" font-weight="700" fill="' + ink + '">' +
        letter +
      '</text>' +
    '</svg>'
  );
}

function createBotAvatarEl(botOrSeed: string | Partial<Bot> | null | undefined, { className = 'convo-avatar' } = {}) {
  const el = (document.createElement('span') as HTMLElement);
  el.className = className;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = buildBotAvatarSvg(botOrSeed);
  return el;
}

function createConvoAvatarEl(convo: Conversation) {
  if (!isBotsConvo(convo)) return null;
  if (isBotGroup(convo)) {
    const members = participantBots(convo).slice(0, 2);
    const stack = (document.createElement('span') as HTMLElement);
    stack.className = 'convo-avatar convo-avatar-stack';
    stack.setAttribute('aria-hidden', 'true');
    if (!members.length) {
      stack.appendChild(createBotAvatarEl(convo.title || convo.id || 'group', { className: 'convo-avatar-piece' }));
    } else {
      members.forEach((bot) => {
        stack.appendChild(createBotAvatarEl(bot, { className: 'convo-avatar-piece' }));
      });
    }
    return stack;
  }
  const bot = convo.botId ? getBot(convo.botId) : null;
  return createBotAvatarEl(bot || { handle: 'bot' });
}

function participantBots(convo: Conversation | null | undefined): Bot[] {
  if (!isBotsConvo(convo)) return [];
  if (Array.isArray(convo.loopAgents) && convo.loopAgents.length) {
    return convo.loopAgents.slice();
  }
  if (convo.botKind === 'dm' && convo.botId) {
    const bot = getBot(convo.botId, convo);
    return bot ? [bot] : [];
  }
  return (Array.isArray(convo.participantBotIds) ? convo.participantBotIds : [])
    .map((id) => getBot(id, convo))
    .filter(Boolean);
}

function ensureLoopAgents(convo: Conversation | null | undefined) {
  if (!convo || !isBotsConvo(convo)) return [];
  if (Array.isArray(convo.loopAgents) && convo.loopAgents.length) {
    convo.participantBotIds = convo.loopAgents.map((bot) => bot.id);
    return convo.loopAgents;
  }
  const members = participantBots(convo).map((bot) => normalizeBot({
    ...bot,
    model: bot.model || (typeof selectedChatModel === 'string' ? selectedChatModel : ''),
  }));
  convo.loopAgents = members;
  convo.participantBotIds = members.map((bot) => bot.id);
  return members;
}

function botDisplayHandle(bot: Bot) {
  return bot ? '@' + bot.handle : '@bot';
}

function parseBotMentions(raw: unknown, convo: Conversation | null | undefined): BotMentionResult {
  const result: BotMentionResult = { everyone: false, user: false, handles: [], botIds: [] };
  const seen = new Set();
  String(raw || '').replace(BOT_MENTION_RE, (_: string, token: string) => {
    const key = String(token).toLowerCase();
    if (key === 'everyone') result.everyone = true;
    else if (key === 'user') result.user = true;
    else if (!seen.has(key)) {
      seen.add(key);
      result.handles.push(key);
      const bot = botByHandle(key, convo);
      if (bot) result.botIds.push(bot.id);
    }
    return _;
  });
  return result;
}

function persistBotMemory(botId: string, memoryText: string, convo?: Conversation | null) {
  const bot = getBot(botId, convo);
  if (!bot) return false;
  const next = String(memoryText || '');
  if ((bot.memory || '') === next) return false;
  bot.memory = next;
  bot.updatedAt = Date.now();
  saveStore();
  return true;
}

function persistGroupMemory(convo: Conversation | null | undefined, memoryText: string) {
  if (!convo) return false;
  const next = String(memoryText || '');
  if ((convo.groupMemory || '') === next) return false;
  convo.groupMemory = next;
  convo.updatedAt = Date.now();
  saveStore();
  return true;
}

