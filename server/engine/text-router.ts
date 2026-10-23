/**
 * Incremental tag routing keeps split thinking/tool tags out of visible replies. Text inside
 * <think>, <thinking> or <analysis> is reasoning; text inside <tool_call> is hidden (the engine
 * parses it separately); a possible partial tag at the end of a chunk is held back until the
 * next chunk decides it.
 */

type Mode = 'text' | 'think' | 'tool';
const HOLD_LIMIT = 40;

const PATTERNS: Record<Mode, RegExp> = {
  text: /<(think|thinking|analysis|tool_call)\s*>/i,
  think: /<\/(?:think|thinking|analysis)\s*>|<tool_call\s*>/i,
  tool: /<\/tool_call\s*>/i,
};

export class TextRouter {
  private pending = '';
  private mode: Mode = 'text';
  constructor(private emit: (text: string, reasoning: boolean) => void) {}

  private send(text: string): void { if (this.mode !== 'tool' && text) this.emit(text, this.mode === 'think'); }

  push(text: string, final = false): void {
    this.pending += text;
    while (this.pending) {
      const match = PATTERNS[this.mode].exec(this.pending);
      if (match) {
        this.send(this.pending.slice(0, match.index));
        this.pending = this.pending.slice(match.index + match[0].length);
        if (this.mode === 'text') this.mode = match[1]!.toLowerCase() === 'tool_call' ? 'tool' : 'think';
        else if (match[0].toLowerCase().startsWith('<tool_call')) this.mode = 'tool';
        else this.mode = 'text';
        continue;
      }
      if (final) { this.send(this.pending); this.pending = ''; break; }
      const last = this.pending.lastIndexOf('<');
      const tail = last >= 0 ? this.pending.slice(last) : '';
      const held = tail.length < HOLD_LIMIT && /^<\/?[a-z_\s]*$/i.test(tail) ? tail.length : 0;
      const end = this.pending.length - held;
      if (end) { this.send(this.pending.slice(0, end)); this.pending = this.pending.slice(end); }
      break;
    }
  }
}
