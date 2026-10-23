/** Shared persisted application contracts. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type ConversationRole = 'system' | 'user' | 'assistant' | 'tool';
type ApplicationSurface = 'chat' | 'bots';
type ThemePreference = 'dark' | 'light' | 'system';
interface MessageAttachment {
  id: string; name: string; type?: string; mime?: string; kind?: 'image' | 'file'; size: number;
  dataUrl?: string; previewUrl?: string; text?: string; file?: File | null;
  status?: string; error?: string; progress?: number; readyPromise?: Promise<MessageAttachment>;
}
interface ChatMessage {
  id?: string; role: ConversationRole; content: string; modelId?: string; createdAt?: number; displayText?: string;
  attachments?: MessageAttachment[]; replyQuote?: string; replyToSpeakerId?: string;
  replyToSpeakerHandle?: string; speakerId?: string | null; speakerHandle?: string | null;
  speakerName?: string; speakerKind?: string; timeline?: TimelinePart[]; stats?: TurnStats;
  interrupted?: boolean; error?: string; apiContent?: JsonValue;
  images?: Record<string, string>; memoryNotices?: string[]; parts?: TimelinePart[];
  model?: string; contextModel?: string; completionTokens?: number; promptTokens?: number;
  contextCompletionTokens?: number | null; contextPromptTokens?: number | null;
  contextTokens?: number; contextWindowTokens?: number; tokensPerSec?: number;
  workDurationMs?: number; compact?: boolean; cachedTokens?: number; cachedPromptTokens?: number; liveTurnId?: string; status?: string;
  steered?: boolean; loopRunId?: string; loopPhaseId?: string; loopPhaseLabel?: string;
  loopPhaseIndex?: number | null; loopPhaseTotal?: number | null;
}
interface TimelinePart {
  type: string; content?: string; name?: string; detail?: string; result?: string;
  note?: string; live?: boolean; id?: string; uid?: string; tone?: string; kind?: string;
  executing?: boolean; approval?: string; justSettled?: boolean; ok?: boolean;
  running?: boolean; startedAt?: number; endedAt?: number; durationMs?: number;
  image?: string; imageId?: string; body?: string; args?: JsonObject; summary?: string;
  settleTimer?: number; questions?: ClarifyQuestion[]; draft?: Record<number, ClarifyDraft>;
  answers?: JsonObject | null; submitting?: boolean;
}
interface TurnStats {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
  contextTokens?: number; contextLimit?: number; durationMs?: number;
  firstTokenMs?: number; tokensPerSecond?: number;
}
interface LoopPhase { id: string; label: string; description: string; agentIds: string[]; completedAgentIds: string[] }
interface LoopRun { id: string; status: string; phaseIndex: number; activeAgentId: string | null; phases: LoopPhase[]; startedAt: number; updatedAt: number }
interface OutboundTurn { useAgent: boolean; skills: Partial<ReturnType<typeof resolveTurnSkills>['skills']>; deepResearch: boolean; deepResearchOutput: string; forceTools: string[] }
interface OutboundItem {
  id: string; editText: string; displayText: string; apiText: string | ApiContentPart[];
  attachments?: MessageAttachment[]; replyQuote?: string; replyToSpeakerId?: string;
  replyToSpeakerHandle?: string; turn: OutboundTurn; diagnosticTraceId?: string; diagnosticStartedAt?: number;
}
interface Conversation {
  id: string; title: string; messages: ChatMessage[]; updatedAt: number;
  titleEdited?: boolean; titleStatus?: string | null; titleAttempts?: number;
  profileId?: string; projectId?: string | null; modelId?: string; pinned?: boolean;
  pinnedAt?: number | null; createdAt?: number; sortOrder?: number | null;
  incognito?: boolean; surface?: string; botKind?: string | null; botId?: string | null;
  participantBotIds?: string[]; loopAgents?: Bot[]; groupMemory?: string;
  botsHeldBy?: string | null; loopRun?: LoopRun | null; sideThreadOf?: string | null;
  workspaceRoot?: string; outboundQueue?: OutboundItem[];
  notificationAt?: number | null; notificationReadAt?: number | null; notificationKind?: string;
  _titleReq?: number; _titleBusy?: boolean;
}
interface Project {
  id: string; name: string; instructions: string; memory: string; memoryMode: string;
  createdAt: number; updatedAt: number; description?: string; profileId?: string;
}
interface Profile {
  id: string; name: string; createdAt?: number; updatedAt?: number;
  projects: Project[]; conversations: ConversationCollection; bots: Bot[];
  personalization: { about: string; instructions: string; memory: string };
  _contextPresent?: boolean;
}
interface Bot { id: string; name: string; handle: string; model: string; avatarSeed: string; stage: string; sessionId: string | null; description: string; memory: string; instructions?: string; createdAt: number; updatedAt: number }
type ProfileCollection = Profile[] & { _migratedFromLegacy?: boolean };
interface OrbController { play(): void; pause(): void; paint(): void; stop(): void }
interface OrbOptions { autoplay?: boolean; mode?: 'orbits' | 'globe'; ink?: string | (() => string) }
interface Array<T> {
  filter(predicate: BooleanConstructor): NonNullable<T>[];
  includes(searchElement: unknown, fromIndex?: number): searchElement is T;
}
type AppSettings = typeof DEFAULT_SETTINGS;
interface DataInfo {
  data_dir?: string; open_label?: string; browser_storage?: boolean;
  encryption_enabled?: boolean; encryption_unlocked?: boolean; encryption_transition_pending?: boolean;
}
interface PendingStoreWrite { epoch: number; body: string; waiters: Array<(value: boolean) => void> }
interface BackdropFocus { el: HTMLElement; previousFocus: Element | null }
interface Error { code?: string; status?: number; retryable?: boolean }
declare function clearTimeout(id: number | null | undefined): void;
declare function clearInterval(id: number | null | undefined): void;
type ConversationCollection = Conversation[] & { _sortOrderMigrated?: boolean };
interface StoreInput { profiles?: Partial<Profile>[]; activeProfileId?: string; projects?: Project[]; conversations?: Conversation[]; bots?: Bot[] }
interface ParsedStore { profiles: ProfileCollection; activeProfileId: string; projects: Project[]; conversations: ConversationCollection; bots: Bot[]; migratedFromLegacy: boolean }
interface LoadedData { store: ParsedStore; preferences: AppSettings }
interface PersistenceOptions { attempts?: number; valid?: () => boolean; timeoutMs?: number; body?: string }
interface BotActions { hold: boolean; resume: boolean; dmUser: string | null; groupPost: string | null }
interface MemoryExtraction { cleaned: string; memory: string | null; globalMemory: string | null; botMemory: string | null; groupMemory: string | null; botActions: BotActions }
interface MemoryChanges { globalUpdated: boolean; projectUpdated: boolean; botUpdated: boolean; groupUpdated: boolean }
interface SystemPromptOptions { convo?: Conversation | null; speakerBot?: Bot | null; includeTime?: boolean }
interface LocalDataResponses {
  '/api/data': DataInfo;
  '/api/data/store': StoreInput | Conversation[];
  '/api/data/preferences': Record<string, unknown>;
}
interface ClarifyQuestion { header?: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean }
interface ClarifyDraft { labels: string[]; custom: string; useCustom: boolean }
interface ModelOption {
  id: string; model: string; provider_id?: string; provider_name?: string; provider_base?: string;
  base?: string; ready?: boolean; attachments_supported?: boolean; images_supported?: boolean;
  reasoning_supported?: boolean; thinking_supported?: boolean; thinking_levels?: string[];
  context_length?: number; connect_kind?: string; connect_label?: string;
}
interface ModelMenuOption {
  value: string; label: string; provider: string; providerId?: string; providerBase?: string;
  connectKind?: string; model?: ModelOption;
}
interface AppNetwork extends NonNullable<ProviderStateView['network']> {
  via_remote?: boolean; remote_base?: string; remote_label?: string; remote_name?: string;
  remote_count?: number; remote_saved?: boolean; remote_ok?: boolean; remote_checking?: boolean;
  remote_catalog_pending?: boolean; remote_kind?: string | null; remote_error?: string | null;
  remote_model?: string | null; remote_status?: string | null; inference_mode?: string;
}
interface LiveTurnSummary extends AdvertisedLiveTurn { started_at?: number; status?: string; profile_id?: string }
interface AppState extends ProviderStateView {
  version?: string; theme?: string; font_body?: string; font_display?: string; font_mono?: string;
  font_scale?: string; thinking_supported?: boolean; encryption_enabled?: boolean;
  encryption_unlocked?: boolean; config_path?: string; live_turns?: LiveTurnSummary[]; network?: AppNetwork;
}
interface StreamDom {
  row: HTMLElement; statusEl: HTMLElement; thinkingLabel: HTMLElement; traceEl: HTMLElement;
  answerEl: HTMLElement; thinkingOrb: OrbController; enteredSteps: number;
}
interface StreamUsage {
  completionTokens: number; promptTokens: number; contextPromptTokens: number | null;
  contextCompletionTokens: number | null; providerTokPerSec: number | null; upstreamModel: string | null;
  /** Prompt tokens the provider served from its cache, and the prompt tokens of those same reports. */
  cachedTokens?: number | null; cachedPromptTokens?: number | null;
}
interface LoopPhaseContext { runId?: string; id?: string; label?: string; index?: number; total?: number }
interface PendingSteer { item: OutboundItem; text: string; applied?: boolean }
interface StreamOptions {
  useAgent?: boolean; deepResearch?: boolean; deepResearchOutput?: string; turnSkills?: Partial<ReturnType<typeof resolveTurnSkills>['skills']>;
  turnForceTools?: string[]; catchingUp?: boolean; turnId?: string | null; turnModel?: string;
  speakerBotId?: string | null; loopPhase?: LoopPhaseContext | null; turnStartedAt?: number | null;
}
interface ActiveStream extends StreamOptions {
  controller: AbortController; partial: string; timeline: TimelinePart[]; images: Record<string, string>;
  errorMessage: string | null; processNotesCollapsed: boolean; dom: StreamDom | null;
  steerId: string | null; pendingSteers: PendingSteer[]; serverTurnSeenAt: number;
  startedAt: number; statusLabel: string; domMountCount: number; convoId: string;
  cancelled: boolean; hardStopped: boolean; settled: boolean; usageStats: StreamUsage;
  contextRemote: ModelOption | null; _partSeq?: number; bodyReader?: ReadableStreamDefaultReader<Uint8Array> | null;
  diagnosticFirstByte?: boolean; diagnosticFirstTool?: boolean; diagnosticStartedAt?: number;
  diagnosticTraceId?: string; enteredSteps?: number; replaced?: boolean; serverFinished?: boolean;
  skipQueue?: boolean; speakerModelId?: string; steerFlushing?: boolean;
}
