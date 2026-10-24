function newId(prefix: string) {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : prefix + Date.now() + Math.random().toString(16).slice(2);
}

function normalizeProject(project: Partial<Project>): Project {
  return {
    id: project.id || newId('p'),
    name: typeof project.name === 'string' && project.name.trim()
      ? project.name.trim()
      : 'Untitled project',
    instructions: typeof project.instructions === 'string' ? project.instructions : '',
    memory: typeof project.memory === 'string' ? project.memory : '',
    memoryMode: PROJECT_MEMORY_MODES.includes(project.memoryMode)
      ? project.memoryMode
      : 'default',
    createdAt: typeof project.createdAt === 'number' ? project.createdAt : Date.now(),
    updatedAt: typeof project.updatedAt === 'number' ? project.updatedAt : Date.now(),
  };
}

function normalizeOutboundItem(raw: Partial<OutboundItem> | null | undefined): OutboundItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const displayText = String(raw.displayText || '').trim();
  const editText = String(raw.editText || displayText);
  if (!displayText && !editText && !attachments.length) return null;
  const turn: Partial<OutboundTurn> = raw.turn && typeof raw.turn === 'object' ? raw.turn : {};
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : newId('q'),
    editText,
    displayText: displayText || (attachments.length ? '(attachment)' : editText),
    apiText: raw.apiText != null ? raw.apiText : (displayText || editText),
    attachments,
    replyQuote: typeof raw.replyQuote === 'string' ? raw.replyQuote : '',
    replyToSpeakerId: typeof raw.replyToSpeakerId === 'string' ? raw.replyToSpeakerId : '',
    replyToSpeakerHandle: typeof raw.replyToSpeakerHandle === 'string' ? raw.replyToSpeakerHandle : '',
    turn: {
      useAgent: !!turn.useAgent,
      skills: turn.skills && typeof turn.skills === 'object' ? turn.skills : {},
      deepResearch: false,
      deepResearchOutput: turn.deepResearchOutput === 'brief' ? 'brief' : 'long',
      forceTools: Array.isArray(turn.forceTools) ? turn.forceTools : [],
    },
  };
}

function normalizeLoopRun(raw: Partial<LoopRun> | null | undefined): LoopRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const phases = Array.isArray(raw.phases) ? raw.phases.map((phase, index) => ({
    id: typeof phase?.id === 'string' ? phase.id : ('phase-' + index),
    label: typeof phase?.label === 'string' ? phase.label : 'Phase ' + (index + 1),
    description: typeof phase?.description === 'string' ? phase.description : '',
    agentIds: Array.isArray(phase?.agentIds)
      ? phase.agentIds.filter((id) => typeof id === 'string')
      : [],
    completedAgentIds: Array.isArray(phase?.completedAgentIds)
      ? phase.completedAgentIds.filter((id) => typeof id === 'string')
      : [],
  })) : [];
  if (!phases.length) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : newId('loop'),
    status: ['running', 'complete', 'stopped'].includes(raw.status) ? raw.status : 'stopped',
    phaseIndex: Math.min(phases.length - 1, Math.max(0, Number(raw.phaseIndex) || 0)),
    activeAgentId: typeof raw.activeAgentId === 'string' ? raw.activeAgentId : null,
    phases,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

function normalizeConversation(convo: Partial<Conversation>): Conversation {
  const normalizedTitleStatus = ['pending', 'generated', 'fallback', 'edited']
    .includes(convo.titleStatus)
    ? convo.titleStatus
    : null;
  return {
    id: convo.id || newId('c'),
    title: typeof convo.title === 'string' ? convo.title : 'New chat',
    titleEdited: !!convo.titleEdited,
    titleStatus: convo.titleEdited ? 'edited' : normalizedTitleStatus,
    titleAttempts: typeof convo.titleAttempts === 'number' && Number.isFinite(convo.titleAttempts)
      ? Math.max(0, Math.min(3, Math.floor(convo.titleAttempts)))
      : 0,
    messages: Array.isArray(convo.messages) ? convo.messages : [],
    modelId: typeof convo.modelId === 'string' ? convo.modelId.trim() : '',
    updatedAt: typeof convo.updatedAt === 'number' ? convo.updatedAt : Date.now(),
    projectId: typeof convo.projectId === 'string' ? convo.projectId : null,
    sortOrder: typeof convo.sortOrder === 'number' && Number.isFinite(convo.sortOrder)
      ? convo.sortOrder
      : null,
    incognito: !!convo.incognito,
    pinned: !!convo.pinned && !convo.incognito,
    pinnedAt: typeof convo.pinnedAt === 'number' && Number.isFinite(convo.pinnedAt)
      ? convo.pinnedAt
      : null,
    surface: convo.surface === 'bots' ? 'bots' : 'chat',
    botKind: convo.botKind === 'group' || convo.botKind === 'dm' ? convo.botKind : null,
    botId: typeof convo.botId === 'string' ? convo.botId : null,
    participantBotIds: Array.isArray(convo.participantBotIds)
      ? convo.participantBotIds.filter((id) => typeof id === 'string')
      : [],
    loopAgents: Array.isArray(convo.loopAgents)
      ? convo.loopAgents.map((bot) => (typeof normalizeBot === 'function' ? normalizeBot(bot) : bot))
      : [],
    groupMemory: typeof convo.groupMemory === 'string' ? convo.groupMemory : '',
    botsHeldBy: typeof convo.botsHeldBy === 'string' ? convo.botsHeldBy : null,
    loopRun: normalizeLoopRun(convo.loopRun),
    sideThreadOf: typeof convo.sideThreadOf === 'string' ? convo.sideThreadOf : null,
    workspaceRoot: typeof convo.workspaceRoot === 'string'
      ? convo.workspaceRoot.trim().slice(0, 512)
      : '',
    outboundQueue: Array.isArray(convo.outboundQueue)
      ? convo.outboundQueue.map(normalizeOutboundItem).filter(Boolean)
      : [],
    notificationAt: typeof convo.notificationAt === 'number' && Number.isFinite(convo.notificationAt)
      ? convo.notificationAt
      : null,
    notificationReadAt: typeof convo.notificationReadAt === 'number' && Number.isFinite(convo.notificationReadAt)
      ? convo.notificationReadAt
      : null,
    notificationKind: convo.notificationKind === 'error' ? 'error' : 'complete',
  };
}

/** Fill missing sortOrder so Recents keep a stable, draggable order. */
function ensureConversationSortOrders(list: ConversationCollection): ConversationCollection {
  let changed = false;
  const groups = new Map<string, Conversation[]>();
  for (const convo of list) {
    const key = convo.projectId || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(convo);
  }
  for (const group of groups.values()) {
    const missing = group.filter((convo) => typeof convo.sortOrder !== 'number');
    if (missing.length === 0) continue;
    changed = true;
    if (missing.length === group.length) {
      group
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .forEach((convo, index) => {
          convo.sortOrder = index;
        });
      continue;
    }
    const max = Math.max(
      ...group
        .filter((convo) => typeof convo.sortOrder === 'number')
        .map((convo) => convo.sortOrder as number)
    );
    missing
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .forEach((convo, index) => {
        convo.sortOrder = max + 1 + index;
      });
  }
  list._sortOrderMigrated = changed;
  return list;
}

function normalizeProfile(raw?: Partial<Profile> | null | undefined, { contextPresent = null }: {contextPresent?: boolean | null} = {}): Profile {
  const source = raw && typeof raw === 'object' ? raw : {};
  const personalization: Partial<Profile['personalization']> = source.personalization && typeof source.personalization === 'object'
    ? source.personalization
    : {};
  const hasContext = contextPresent == null
    ? !!(source.personalization && typeof source.personalization === 'object')
    : !!contextPresent;
  return {
    id: typeof source.id === 'string' && source.id.trim()
      ? source.id.trim().slice(0, 96)
      : newId('profile-'),
    name: typeof source.name === 'string' && source.name.trim()
      ? source.name.trim().slice(0, 48)
      : 'Personal',
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : Date.now(),
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : Date.now(),
    personalization: {
      about: typeof personalization.about === 'string' ? personalization.about : '',
      instructions: typeof personalization.instructions === 'string' ? personalization.instructions : '',
      memory: typeof personalization.memory === 'string' ? personalization.memory : '',
    },
    projects: Array.isArray(source.projects) ? source.projects.map(normalizeProject) : [],
    conversations: ensureConversationSortOrders(
      Array.isArray(source.conversations) ? source.conversations.map(normalizeConversation) : []
    ),
    bots: Array.isArray(source.bots) ? source.bots.map(normalizeBot) : [],
    composerDrafts: source.composerDrafts && typeof source.composerDrafts === 'object'
      && !Array.isArray(source.composerDrafts) ? { ...source.composerDrafts } : {},
    _contextPresent: hasContext,
  };
}

function activeProfile() {
  return profiles.find((profile) => profile.id === activeProfileId) || profiles[0] || null;
}

function profileContextFromSettings(source = settings) {
  return {
    about: typeof source?.about === 'string' ? source.about : '',
    instructions: typeof source?.instructions === 'string' ? source.instructions : '',
    memory: typeof source?.memory === 'string' ? source.memory : '',
  };
}

function settingsForProfile(shared: Partial<AppSettings>, profile: Profile | null | undefined) {
  return normalizeSettings({
    ...shared,
    ...(profile?.personalization || {}),
  });
}

function preferencesPayload(source = settings) {
  const payload = { ...source };
  PROFILE_CONTEXT_KEYS.forEach((key) => delete payload[key]);
  return payload;
}

function bindActiveProfile(profile: Profile) {
  const target = profile || activeProfile();
  if (!target) return;
  activeProfileId = target.id;
  projects = target.projects;
  conversations = target.conversations;
  bots = target.bots;
}

function syncActiveProfileFromMemory({ touch = false } = {}) {
  const profile = activeProfile();
  if (!profile) return;
  profile.projects = projects;
  profile.conversations = conversations;
  profile.bots = bots;
  profile.personalization = profileContextFromSettings();
  profile._contextPresent = true;
  if (touch) profile.updatedAt = Date.now();
}

function profileStoreRecord(profile: Profile) {
  const active = profile.id === activeProfileId;
  const sourceConversations = active ? conversations : profile.conversations;
  return {
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    personalization: active ? profileContextFromSettings() : profile.personalization,
    projects: active ? projects : profile.projects,
    conversations: sourceConversations
      .filter((convo) => !convo.incognito)
      .map(conversationStoreRecord),
    bots: active ? bots : profile.bots,
    composerDrafts: typeof composerDraftsForStore === 'function' ? composerDraftsForStore(profile) : {},
  };
}

function parseStorePayload(parsed: StoreInput | Conversation[] | null | undefined): ParsedStore {
  const legacyProfile = (projects: Project[], conversations: Conversation[], bots: Bot[]) => normalizeProfile({
    id: DEFAULT_PROFILE_ID,
    name: 'Personal',
    projects,
    conversations,
    bots,
  }, { contextPresent: false });
  if (Array.isArray(parsed)) {
    const profile = legacyProfile([], parsed, []);
    return {
      profiles: [profile],
      activeProfileId: profile.id,
      projects: profile.projects,
      conversations: profile.conversations,
      bots: profile.bots,
      migratedFromLegacy: true,
    };
  }
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.profiles) && parsed.profiles.length) {
      const seen = new Set();
      const parsedProfiles = parsed.profiles.map((raw) => {
        const profile = normalizeProfile(raw);
        while (seen.has(profile.id)) profile.id = newId('profile-');
        seen.add(profile.id);
        return profile;
      });
      const requested = typeof parsed.activeProfileId === 'string' ? parsed.activeProfileId : '';
      const active = parsedProfiles.find((profile) => profile.id === requested) || parsedProfiles[0];
      return {
        profiles: parsedProfiles,
        activeProfileId: active.id,
        projects: active.projects,
        conversations: active.conversations,
        bots: active.bots,
        migratedFromLegacy: false,
      };
    }
    const profile = legacyProfile(
      Array.isArray(parsed.projects) ? parsed.projects : [],
      Array.isArray(parsed.conversations) ? parsed.conversations : [],
      Array.isArray(parsed.bots) ? parsed.bots : []
    );
    return {
      profiles: [profile],
      activeProfileId: profile.id,
      projects: profile.projects,
      conversations: profile.conversations,
      bots: profile.bots,
      migratedFromLegacy: true,
    };
  }
  const profile = legacyProfile([], [], []);
  return {
    profiles: [profile],
    activeProfileId: profile.id,
    projects: profile.projects,
    conversations: profile.conversations,
    bots: profile.bots,
    migratedFromLegacy: true,
  };
}

let profiles: ProfileCollection = [];
let activeProfileId = DEFAULT_PROFILE_ID;
let projects: Project[] = [];
let conversations: Conversation[] = [];
let bots: Bot[] = [];
let dataInfo: DataInfo | null = null;
let storageReady = false;
let localDataLoadError = '';
let saveStoreTimer: number | null | undefined = null;
let saveSettingsTimer: number | null | undefined = null;
let settingsWriteChain: Promise<unknown> = Promise.resolve();
let storeWriteChain: Promise<boolean | void> = Promise.resolve();
let pendingStoreWrite: PendingStoreWrite | null = null;
let activeStoreWrite: PendingStoreWrite | null = null;
let storeWriteRunning = false;
let storageWriteEpoch = 0;
let persistenceWarningAt = 0;

