interface ReplyTarget { speakerId: string; speakerHandle: string }
interface ComposerDraft {
  text: string; mentions: string[]; quote: string; replyTarget: ReplyTarget | null;
  modelId: string; workspaceRoot: string;
}
interface ComposerDraftCandidate {
  text?: unknown; mentions?: unknown; quote?: unknown; modelId?: unknown; workspaceRoot?: unknown;
  replyTarget?: { speakerId?: unknown; speakerHandle?: unknown } | null;
}
interface ComposerDraftContext { profileId: string; key: string; incognito: boolean }
interface Profile { composerDrafts?: Record<string, ComposerDraft> }
interface ThreadFindMatch { range: Range; row: HTMLElement }
interface MentionOption {
  id: string; label: string; description: string; section?: string; inline?: boolean;
}
interface MentionState { start: number; query: string; activeIndex: number; items: MentionOption[] }
interface UserSkill { id: string; name: string; description: string; content: string; enabled: boolean; content_chars?: number; source_filename?: string }
interface PlusMenuItem {
  id: string; iconClass: string; icon: string; title: string; desc: string; descHtml?: string;
  badge?: string; on: boolean; disabled: boolean; titleAttr?: string;
}
interface LiveCancelRequest { turnId: string | null; promise: Promise<void> }
interface MessageAttachment {
  _paintQueued?: boolean; reader?: FileReader | null; abort?: AbortController;
  sendMode?: string; extractedText?: string; apiText?: string;
  apiPart?: ApiImagePart | null;
}
type ApiImagePart = { type: string; image_url: { url: string } };
type ApiContentPart = { type: string; text: string } | ApiImagePart;
interface PendingSteer { posted?: boolean; posting?: boolean }
interface ModelOption { label?: string; thinking_control?: boolean | 'reasoning' | 'reasoning_effort' | 'chat_template'; thinking_efforts?: string[]; thinking_can_disable?: boolean }
interface AssistantTurnOptions {
  useAgent?: boolean; text: string | ApiContentPart[]; skills?: Partial<ReturnType<typeof resolveTurnSkills>['skills']>;
  deepResearch?: boolean; deepResearchOutput?: string; forceTools?: string[];
  dispatchedMessage?: ChatMessage | null; queueItem?: OutboundItem | null; previousTitle?: string;
  speakerBotId?: string | null; skipQueue?: boolean; replaceLive?: boolean;
  botMessageLimit?: number | null; loopTurnDirective?: string; loopPhase?: LoopPhaseContext | null;
}
interface OutboundItem { diagnosticTraceId?: string; diagnosticStartedAt?: number }
interface AdvertisedLiveTurn {
  conversation_id: string; turn_id: string; agent?: boolean; finished?: boolean; deep_research?: boolean;
  deep_research_output?: string; model?: string;
}
interface PromptProgress { total?: number; processed?: number; cache?: number }
interface AgentStreamEvent {
  phase: string; reasoning?: string; text?: string; name?: string; id?: string;
  result?: string; preview?: string; note?: string; command_session_id?: string; running?: boolean;
  ok?: boolean; image?: string; image_id?: string; questions?: ClarifyQuestion[];
  answers?: JsonObject; summary?: string; content?: string; client_id?: string;
  message?: string; detail?: string; args?: Record<string, unknown>;
}
type FinalTurnStats = NonNullable<ReturnType<typeof finalizeTurnStats>> & { contextWindowTokens?: number | null; contextModel?: string | null };
interface ActiveStream { diagnosticFirstreasoning?: boolean; diagnosticFirstcontent?: boolean }
interface SystemPromptOptions { excludeConvoId?: string }
interface ApiErrorResult { error?: string }
interface SkillApiResult extends Partial<UserSkill>, ApiErrorResult { skills?: UserSkill[] }
interface StreamDelta { content?: string; reasoning_content?: string; reasoning?: string }
interface BrowserCompletionFrame extends UsageFrame {
  choices?: Array<{ delta?: StreamDelta; message?: StreamDelta }>;
  prompt_progress?: PromptProgress;
}
