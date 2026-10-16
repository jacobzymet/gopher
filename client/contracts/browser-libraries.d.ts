/** Browser library surfaces used by the application. */
interface MarkdownToken { type: string; raw: string; text?: string; tokens?: MarkdownToken[] }
interface MarkdownCodeToken { text: string; lang?: string }
interface MarkdownLinkToken { href: string; title?: string | null; tokens: MarkdownToken[] }
interface MarkdownTableCell { text: string; tokens: MarkdownToken[]; header: boolean; align?: string | null }
interface MarkdownTableToken { type: 'table'; raw: string; header: MarkdownTableCell[]; rows: MarkdownTableCell[][]; align: Array<string | null> }
interface MarkdownRenderer {
  parser: { parseInline(tokens: MarkdownToken[]): string };
  code?(token: MarkdownCodeToken): string;
  table(token: MarkdownTableToken): string;
  link?(token: MarkdownLinkToken): string;
}
interface MarkdownApi {
  Renderer: new () => MarkdownRenderer;
  parse(source: string, options: { async: false }): string;
  parseInline(source: string, options: { async: false }): string;
  use(options: { gfm?: boolean; breaks?: boolean; renderer?: Partial<MarkdownRenderer>; tokenizer?: { del(this: { lexer: { inlineTokens(text: string): MarkdownToken[] } }, source: string): MarkdownToken | undefined } }): void;
}
interface SanitizerApi {
  sanitize(source: string, options?: { [key: string]: boolean | string | string[] | { html?: boolean; svg?: boolean; svgFilters?: boolean; mathMl?: boolean } }): string;
  addHook(name: string, hook: (node: Element) => void): void;
}
interface HighlightApi {
  getLanguage(language: string): unknown;
  highlight(source: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
  highlightAuto(source: string): { value: string };
  highlightElement(element: HTMLElement): void;
}
interface MathApi { renderToString(source: string, options: { [key: string]: boolean | string | number }): string }
interface RecognitionResult { isFinal: boolean; length: number; [index: number]: { transcript: string; confidence: number } }
interface RecognitionEvent extends Event { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface RecognitionErrorEvent extends Event { error: string; message?: string }
interface BrowserRecognition {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null; onstart?: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
interface OcrResult { data: { text: string } }
interface OcrWorker { recognize(source: string): Promise<OcrResult>; terminate(): Promise<void> }
interface OcrApi { createWorker(language: string, mode: number, options: { workerPath: string; corePath: string; langPath: string; workerBlobURL: boolean; cacheMethod: string; logger: (event: { status: string; progress: number }) => void }): Promise<OcrWorker> }
interface Window {
  DOMPurify?: SanitizerApi; marked?: MarkdownApi; hljs?: HighlightApi; katex?: MathApi;
  SpeechRecognition?: new () => BrowserRecognition;
  webkitSpeechRecognition?: new () => BrowserRecognition;
  webkitAudioContext?: typeof AudioContext; Tesseract?: OcrApi;
  GOPHER_PROMPTS?: Record<string, string>;
  fillPrompt?: (template: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
}
declare const DOMPurify: SanitizerApi;
declare const marked: MarkdownApi;
declare const hljs: HighlightApi;
declare const katex: MathApi;
declare const SpeechRecognition: (new () => BrowserRecognition) | undefined;
declare const webkitSpeechRecognition: (new () => BrowserRecognition) | undefined;
declare const GOPHER_PROMPTS: Record<string, string>;
declare const fillPrompt: (template: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
