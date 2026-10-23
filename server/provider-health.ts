/** Turning provider failures into clear health states and messages. */

export type HealthKind = 'ready' | 'empty' | 'waiting' | 'auth' | 'unreachable' | 'error';
export type ApiStyleName = 'openai' | 'anthropic' | 'responses';

export { describeNetworkError } from './network-errors.js';

/** Classify a probe failure the way the original application did. */
export function classifyProviderError(message: string): HealthKind {
  const text = message.toLowerCase();
  if (text.includes('no provider')) return 'error';
  if (/\b(401|403)\b/.test(text) || text.includes('unauthorized') || text.includes('forbidden')) return 'auth';
  if (text.includes('returned no models') || text.includes('no models')) return 'empty';
  if (text.includes('could not be resolved') || text.includes('getaddrinfo') || text.includes('not known')) return 'error';
  const waiting = ['timed out', 'timeout', 'connection refused', 'refused', 'connection was reset', 'reset',
    'unreachable', 'stopped responding', 'host is down', 'no route to host'];
  return waiting.some(marker => text.includes(marker)) ? 'waiting' : 'error';
}

/** A hint from well-known hosts and token formats when both API styles answer. */
export function styleHint(base: string, token: string): ApiStyleName | undefined {
  if (token.trim().toLowerCase().startsWith('sk-ant-')) return 'anthropic';
  const lower = base.toLowerCase();
  if (lower.includes('anthropic') || lower.includes('claude')) return 'anthropic';
  const openai = ['openai.com', 'openai.azure', 'ollama', 'groq.com', 'googleapis.com', 'openrouter.ai',
    'together.xyz', 'fireworks.ai', 'localhost', '127.0.0.1'];
  return openai.some(marker => lower.includes(marker)) ? 'openai' : undefined;
}

export type RouteSignal = 'present' | 'missing' | 'unknown';

/** What a GET on a chat route says about whether that API style exists on the server. */
export function routeSignal(status: number): RouteSignal {
  if (status === 404 || status === 410) return 'missing';
  if ((status >= 200 && status < 300) || [400, 401, 402, 403, 405, 415, 422, 429].includes(status)) return 'present';
  return 'unknown';
}

export interface StyleEvidence { modelsOk: boolean; route: RouteSignal }

/** Score each style from its /models probe and chat-route signal; exclusive route signals weigh most. */
export function chooseApiStyle(base: string, token: string, openai: StyleEvidence, anthropic: StyleEvidence): ApiStyleName {
  const hint = styleHint(base, token);
  const score = (style: ApiStyleName, evidence: StyleEvidence) => (evidence.modelsOk ? 4 : 0)
    + (evidence.route === 'present' ? 2 : evidence.route === 'missing' ? -2 : 0) + (hint === style ? 2 : 0);
  let openaiScore = score('openai', openai), anthropicScore = score('anthropic', anthropic);
  if (openai.route === 'present' && anthropic.route !== 'present') openaiScore += 3;
  if (anthropic.route === 'present' && openai.route !== 'present') anthropicScore += 3;
  const preferAnthropic = anthropicScore > openaiScore || (anthropicScore === openaiScore && hint === 'anthropic');
  return preferAnthropic ? 'anthropic' : 'openai';
}
