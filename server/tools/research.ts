import { toolArguments, type ToolCall, type ToolOutcome } from './index.js';

/**
 * Deep-research coverage. A final answer needs at least six distinct successful searches and four
 * pages read across three productive rounds; a budget (or four rounds without new evidence) forces
 * the model to stop searching and write up what it has.
 */

const MIN_SEARCHES = 6;
const MIN_PAGES = 4;
const MIN_ROUNDS = 3;
const MAX_CALLS = 64;
const MAX_TOOL_ROUNDS = 24;
const MAX_STALLED_ROUNDS = 4;

function searchHadResults(text: string): boolean {
  try { return Boolean((JSON.parse(text) as { results?: unknown[] }).results?.length); }
  catch { return !text.startsWith('No results found for '); }
}

function pageRead(url: unknown, text: string): string | undefined {
  try {
    const page = new URL(String(url));
    page.hash = '';
    const content = (JSON.parse(text) as { text?: unknown }).text;
    return typeof content === 'string' && content.trim().length ? page.toString() : undefined;
  } catch { return undefined; }
}

export class ResearchProgress {
  readonly queries = new Set<string>();
  readonly pages = new Set<string>();
  rounds = 0;
  calls = 0;
  toolRounds = 0;
  stalledRounds = 0;

  ready(): boolean {
    return this.queries.size >= MIN_SEARCHES && this.pages.size >= MIN_PAGES && this.rounds >= MIN_ROUNDS;
  }
  exhausted(): boolean {
    return this.calls >= MAX_CALLS || this.toolRounds >= MAX_TOOL_ROUNDS || this.stalledRounds >= MAX_STALLED_ROUNDS;
  }
  nextTool(): string { return this.queries.size >= 3 && this.pages.size < MIN_PAGES ? 'fetch_url' : 'web_search'; }

  record(results: { call: ToolCall; outcome: ToolOutcome }[]): void {
    this.toolRounds++;
    this.calls += results.length;
    const before = this.queries.size + this.pages.size;
    for (const { call, outcome } of results) {
      if (!outcome.ok || !outcome.text.trim()) continue;
      const args = toolArguments(call.arguments);
      if (call.name === 'web_search') {
        const query = String(args.query || '').trim().replace(/\s+/g, ' ').toLowerCase();
        if (query && searchHadResults(outcome.text)) this.queries.add(query);
      }
      if (call.name === 'fetch_url') {
        const page = pageRead(args.url, outcome.text);
        if (page) this.pages.add(page);
      }
    }
    if (this.queries.size + this.pages.size > before) { this.rounds++; this.stalledRounds = 0; }
    else this.stalledRounds++;
  }

  note(): string {
    const status = `Research evidence so far: ${this.queries.size} distinct successful searches, `
      + `${this.pages.size} pages read, ${this.rounds} research rounds.`;
    if (this.exhausted()) {
      return `${status} Research budget or progress limit reached. Stop tools and synthesize available evidence now. `
        + 'This does NOT establish that evidence is sufficient. Disclose access failures, unverified claims and '
        + 'unresolved gaps. Never invent sources.';
    }
    if (!this.ready()) {
      return `${status} Continue investigating before the final answer: at least 6 distinct successful searches `
        + `and 4 pages across 3 rounds. Next call ${this.nextTool()}. Follow new leads, read primary sources and test `
        + 'the strongest counterargument. Concise output requires the same research depth.';
    }
    return `${status} Minimum coverage reached. Audit evidence, resolve contradictions, and verify claims `
      + 'supported only by snippets before finishing.';
  }
}
