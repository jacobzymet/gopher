/** Cleaning up model-written chat titles (ported from the original Rust implementation). */

const QUOTES = /^["'`*#“”‘’]+|["'`*#“”‘’]+$/g;
const PREFIXES = ['Title:', 'title:', 'Chat title:', 'CHAT TITLE:'];
const ECHO_MARKERS = [
  'short chat title', 'at most 6', 'at most six', 'no quotes', 'no markdown', 'no explanation',
  'the user wants', 'write a title', 'title this chat', 'reply with', 'only the title', 'maximum 6',
];
const MAX_WORDS = 6;
const MAX_CHARS = 60;

/** Remove closed and unclosed thinking blocks emitted by local chat templates. */
export function stripThinking(raw: string): string {
  let output = raw;
  for (const tag of ['think', 'thinking', 'reason', 'reasoning']) {
    const open = `<${tag}>`, close = `</${tag}>`;
    let start: number;
    while ((start = output.indexOf(open)) >= 0) {
      const end = output.indexOf(close, start + open.length);
      output = end < 0 ? `${output.slice(0, start)} ` : `${output.slice(0, start)} ${output.slice(end + close.length)}`;
      if (end < 0) break;
    }
  }
  return output;
}

function looksLikePromptEcho(title: string): boolean {
  const lower = title.toLowerCase();
  return ECHO_MARKERS.some(marker => lower.includes(marker));
}

function cleanCandidate(raw: string): string {
  let title = raw.trim().replace(QUOTES, '').trim();
  for (const prefix of PREFIXES) if (title.startsWith(prefix)) title = title.slice(prefix.length).trim();
  return title.replace(/[.!?:;]+$/, '').trim();
}

const firstWords = (title: string) => title.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS).join(' ');

/** The last short sentence of prose, for models that explain before giving the title. */
function trailingFragment(text: string): string | undefined {
  const parts = text.replace(/[\r\n]+/g, ' ').split(/[.!?;]/).reverse();
  for (const part of parts) {
    const title = cleanCandidate(part);
    const words = title.split(/\s+/).filter(Boolean).length;
    if (title && !looksLikePromptEcho(title) && words > 0 && words <= 8) return title;
  }
  return undefined;
}

/** A short, clean title from raw model output, or undefined when nothing usable remains. */
export function sanitizeTitle(raw: string): string | undefined {
  const cleaned = stripThinking(raw);
  const candidates: string[] = [];
  for (const line of cleaned.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('<')) continue;
    const title = cleanCandidate(line);
    if (!title || looksLikePromptEcho(title)) continue;
    // Long prose lines are explanation, not a title; a long plain line is truncated instead.
    if (title.split(/\s+/).length > 8 && /[.!?;]/.test(title)) continue;
    candidates.push(firstWords(title));
  }
  if (!candidates.length) {
    const fragment = trailingFragment(cleaned);
    if (fragment) candidates.push(fragment);
  }
  // Models often put the title after leftover prose, so the last short line wins.
  const last = candidates.pop();
  if (!last) return undefined;
  const title = firstWords(last);
  const characters = [...title];
  return characters.length > MAX_CHARS ? `${characters.slice(0, MAX_CHARS).join('').trimEnd()}…` : title;
}
