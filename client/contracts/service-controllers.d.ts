interface ProviderHealth {
  ok?: boolean; kind?: string; message?: string; model_count?: number;
  checked_at?: number; model?: string; status?: string; error?: string;
}
interface UiProvider {
  id: string; name: string; base: string; api_style: string; kind?: string;
  builtin?: boolean; active?: boolean; token_set?: boolean; token_masked?: string;
  allow_insecure_tls?: boolean; health?: ProviderHealth;
}
interface ProviderStateView {
  providers?: UiProvider[]; remotes?: UiProvider[];
  network?: { remotes?: UiProvider[]; active_remote_id?: string; remote_models?: ModelOption[] };
}
interface ProviderProbeResult {
  ok?: boolean; health?: ProviderHealth; api_style?: string; detected?: boolean; models?: number;
}
interface ProviderApiResult extends ProviderProbeResult, ProviderStateView {
  state?: AppState; error?: string; message?: string; code?: string;
  status?: string; user_code?: string; verification_url?: string;
}
interface ProviderTestRequest {
  base: string; token?: string; id?: string; api_style?: string; allow_insecure_tls?: boolean;
}
interface ProviderHealthLabel { text: string; chip: string; kind: string; hint?: string }
interface ProviderConnectionSummary { state: string; title: string; detail: string }
interface ProviderRequestError extends Error { code?: string }
interface TerminalTheme {
  background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string;
}
interface XtermDisposable { dispose(): void }
interface XtermAddon { activate(terminal: XtermTerminal): void; dispose(): void }
interface XtermFitAddon extends XtermAddon { fit(): void }
interface XtermOptions {
  cursorBlink: boolean; cursorStyle: 'bar'; fontSize: number; lineHeight: number;
  fontFamily: string; theme: TerminalTheme; scrollback: number; convertEol: boolean;
  windowsMode: boolean; allowTransparency: boolean;
}
interface XtermTerminal {
  cols: number; rows: number; options: { theme?: TerminalTheme };
  loadAddon(addon: XtermAddon): void; open(parent: HTMLElement): void;
  onData(listener: (data: string) => void): XtermDisposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): XtermDisposable;
  write(data: string | Uint8Array): void; focus(): void; dispose(): void;
}
type XtermFitConstructor = new () => XtermFitAddon;
interface Window {
  Terminal?: new (options: XtermOptions) => XtermTerminal;
  FitAddon?: XtermFitConstructor & { FitAddon?: XtermFitConstructor };
}
interface TerminalTab {
  id: string; title: string; cwd: string; term: XtermTerminal | null;
  fit: XtermFitAddon | null; ws: WebSocket | null; viewport: HTMLElement | null; encoder: TextEncoder;
}
interface TerminalHeightDrag { pointerId: number; startY: number; startHeight: number }
interface TerminalApiResult { error?: string; path?: string; id: string; title?: string; cwd?: string }
interface BrowserDiagnosticInput {
  timestamp?: number; level?: string; event: string; trace_id?: string; conversation_id?: string;
  elapsed_ms?: number | null; data?: unknown;
}
interface BrowserDiagnosticEntry {
  id: number; timestamp: number; level: string; source: string; event: string;
  trace_id: string; conversation_id: string; elapsed_ms: number | null;
  data: string; truncated_bytes?: number;
}
interface BrowserDiagnosticStatus {
  generation: number; enabled: boolean; persisted?: boolean; entries: BrowserDiagnosticEntry[];
  last_id: number; oldest_id?: number | null; dropped?: number; error?: string;
  timings?: BrowserDiagnosticEntry[];
}
interface DiagnosticContext { level?: string; traceId?: string | null; convoId?: string | null; startedAt?: number }
interface DiagnosticStreamContext {
  catchingUp?: boolean; diagnosticTraceId?: string; turnId?: string | null;
  diagnosticStartedAt?: number; startedAt: number;
}
