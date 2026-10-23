/**
 * ask_user arguments, accepted in the many shapes models produce: a JSON string, a bare array,
 * a single question object, or `questions` as a string. Each question needs text and 2–4 options.
 */

export interface QuestionOption { label: string; description: string }
export interface Question { header: string; question: string; options: QuestionOption[]; multiSelect: boolean }
type Loose = Record<string, unknown>;

const MAX_QUESTIONS = 2;
const MAX_OPTIONS = 4;
const HEADER_CHARS = 12;
const OPTION_KEYS = ['options', 'choices', 'answers', 'choices_list'];
const LABEL_KEYS = ['label', 'text', 'name', 'title', 'value'];
const DESCRIPTION_KEYS = ['description', 'desc', 'detail', 'subtitle'];
const HEADER_KEYS = ['header', 'title', 'label', 'id'];

const isRecord = (value: unknown): value is Loose =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

/** The first nonempty string among the given keys. */
function first(item: unknown, keys: string[]): string | undefined {
  if (!isRecord(item)) return undefined;
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function questionList(args: unknown): unknown[] {
  let value = parse(args);
  if (value === undefined) return [];
  if (Array.isArray(value)) value = { questions: value };
  if (!isRecord(value)) return [];
  if (!value.questions && (value.question || value.prompt || value.text)) value = { questions: [value] };
  const record = value as Loose;
  if (typeof record.questions === 'string') {
    record.questions = parse(record.questions);
    if (record.questions === undefined) return [];
  }
  if (Array.isArray(record.questions)) return record.questions;
  return isRecord(record.questions) ? [record.questions] : [];
}

function options(item: Loose): QuestionOption[] {
  const raw = OPTION_KEYS.map(key => item[key]).find(Array.isArray) as unknown[] | undefined;
  if (!raw) return [];
  return raw.flatMap(option => {
    const label = typeof option === 'string' ? option.trim() : first(option, LABEL_KEYS);
    if (!label) return [];
    const description = typeof option === 'object' ? first(option, DESCRIPTION_KEYS) || '' : '';
    return [{ label, description }];
  }).slice(0, MAX_OPTIONS);
}

export function normalizeQuestions(args: unknown): Question[] {
  return questionList(args).slice(0, MAX_QUESTIONS).flatMap(raw => {
    const item = isRecord(raw) ? raw : {};
    const question = first(item, ['question', 'prompt', 'text', 'q']);
    const hasOptions = OPTION_KEYS.some(key => Array.isArray(item[key]));
    if (!question || !hasOptions) return [];
    const choices = options(item);
    if (choices.length < 2) return [];
    const header = Array.from(first(item, HEADER_KEYS) || 'Question').slice(0, HEADER_CHARS).join('');
    const multiSelect = Boolean(item.multiSelect ?? item.multi_select ?? item.allow_multiple);
    return [{ header, question, options: choices, multiSelect }];
  });
}
