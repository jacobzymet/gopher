interface RenderMessage extends Partial<ChatMessage> {}
interface RenderApiProblem { error?: string }
interface RenderApprovalResult { expired?: boolean }
interface TimelineRenderItem { key: string; html: string; chrome: string }
type StreamTyper = ReturnType<typeof createStreamTyper>;
interface ToolStatusArgs { approval?: string; executing?: boolean; kind?: string }
interface LiveToolPayload { name?: string; arguments?: ToolStatusArgs }
interface ConversationNotification {
  type: string; convo: Conversation; at: number | null | undefined;
  title: string; label: string; detail: string; unread?: boolean;
}
interface UsageFrame {
  prompt_progress?: { total?: unknown };
  usage?: { completion_tokens?: unknown; prompt_tokens?: unknown };
  timings?: { predicted_per_second?: unknown; predicted_n?: unknown; predicted_ms?: unknown };
  model?: unknown;
}
interface MathSlot { tex: string; display: boolean }
interface TimelinePart { approvalRisk?: string }
interface StreamDom { clarifyHost?: HTMLElement | null }
interface MarkdownColumnWidths { widths: number[]; defaults: number[] }
interface MarkdownColumnDrag { pointerId: number; x: number; widths: number[]; direction: number }
interface ConversationDateGroup { key: string; label: string; conversations: Conversation[] }
interface ChatRetrievalResult {
  results?: Array<{ url: string; chat_id: string; excerpt?: string; content?: string; role?: string; title?: string; updated_at?: number; truncated?: boolean }>;
  scope?: string; next_cursor?: JsonValue;
}
type AppLocationRoute = { surface?: ApplicationSurface; incognito?: boolean } & (
  { kind: 'draft' } | { kind: 'convo'; id: string } | { kind: 'project'; id: string }
  | { kind: 'projects' } | { kind: 'notifications' }
);
interface HTMLElement {
  /** State owned by conversation menus and Markdown column resizing. */
  _anchor?: HTMLButtonElement | null;
  _closeTimer?: number;
  _markdownTableWidths?: Map<string, MarkdownColumnWidths>;
  _columnResizeReady?: boolean;
}
