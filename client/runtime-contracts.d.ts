type StreamReadResult = { aborted: true; chunk?: never } | { aborted?: false; chunk: ReadableStreamReadResult<Uint8Array> };
interface ModelMenuContext { anchor: HTMLElement; trigger: HTMLElement; selectedId: string; onPick: (value: string) => void }
interface ModelMenuOption { base?: string; ready?: boolean; thinking?: boolean }
interface ComposerSendAttempt {
  convoId: string | null; projectId: string | null; modelId: string; surface: string;
  incognito: boolean; workspace: string; input: string; quote: string | null;
  replyTarget: ReplyTarget | null; attachments: MessageAttachment[]; mentions: string[];
  diagnosticTraceId: string; diagnosticStartedAt: number;
}
interface AgentToolPayload { id?: string; name?: string; arguments?: JsonObject; summary?: string; phase?: string; risk?: string; needs_approval?: boolean }
interface TimelinePart { commandSessionId?: string }
