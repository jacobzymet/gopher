/** Result filtering, de-duplication and ranking, ported from the original Rust search. */

export interface SearchResult { title: string; url: string; snippet: string }
export interface SourcedResults { source: string; results: SearchResult[] }

const NEWS_HOSTS = [
  'reuters.com', 'apnews.com', 'associatedpress.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com',
  'washingtonpost.com', 'wsj.com', 'bloomberg.com', 'ft.com', 'theguardian.com', 'npr.org',
  'cnbc.com', 'cnn.com', 'nbcnews.com', 'abcnews.go.com', 'theverge.com', 'arstechnica.com',
  'techcrunch.com', 'wired.com', 'axios.com', 'politico.com', 'forbes.com', 'aljazeera.com',
  'semafor.com', 'theinformation.com',
];
const TABLOID_HOSTS = [
  'hellomagazine.com', 'people.com', 'eonline.com', 'tmz.com', 'okmagazine.com', 'usmagazine.com',
  'popsugar.com', 'pagesix.com',
];
const LISTING_SEGMENTS = new Set([
  'tag', 'tags', 'topic', 'topics', 'category', 'categories', 'section', 'sections', 'label', 'labels',
]);
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'about', 'what', 'when', 'where',
  'which', 'have', 'has', 'was', 'were', 'are', 'latest', 'official',
]);
const SOURCE_WEIGHT: Record<string, number> = {
  parallel: 1.35, tinyfish: 1.35, searxng: 1.25, duckduckgo: 1.2, 'duckduckgo-post': 1.15,
  'duckduckgo-lite': 1.1,
};

const matchesDomain = (host: string, domains: string[]) =>
  domains.some(domain => host === domain || host.endsWith(`.${domain}`));

export function hostOf(url: string): string {
  const rest = url.split('://')[1] ?? url;
  return (rest.split('/')[0] ?? '').replace(/^www\./, '').toLowerCase();
}

function pathOf(url: string): string {
  const lower = url.toLowerCase();
  const rest = lower.split('://')[1] ?? lower;
  const slash = rest.indexOf('/');
  return slash < 0 ? '' : rest.slice(slash + 1);
}

/** Search-engine result, redirect and advertising pages. */
export function isSearchEngineUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const host = hostOf(lower);
  if (host.includes('duckduckgo.com') || host === 'bing.com' || host.endsWith('.bing.com')) return true;
  if (['search.yahoo.com', 'search.brave.com', 'news.google.com', 'news.yahoo.com'].includes(host)) return true;
  if (host.endsWith('.news.yahoo.com')) return true;
  return host.includes('google.') && ['/search', '/url?', '/aclk', '/topics', '/news'].some(part => lower.includes(part));
}

/** Search-engine, advertising and sign-in pages are never useful search results. */
export function isJunkUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const host = hostOf(lower);
  if (!host || isSearchEngineUrl(url)) return true;
  if (['accounts.', 'login.', 'auth.', 'signin.', 'signup.'].some(prefix => host.startsWith(prefix))) return true;
  const path = pathOf(lower);
  if (['sign-in', 'signin', 'login', 'signup', 'oauth'].some(part => path.includes(part))) return true;
  return lower.includes('/aclick') || lower.includes('/aclk');
}

/** Tag, topic and category index pages rarely answer a question. */
export function isListingUrl(url: string): boolean {
  const path = pathOf(url).split('?')[0] ?? '';
  return path.split('/').some(segment => LISTING_SEGMENTS.has(segment));
}

export const rejectResultUrl = (url: string) => isJunkUrl(url) || isListingUrl(url);

export function queryLooksLikeNews(query: string): boolean {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(word => ['how', 'tutorial', 'recipe'].includes(word))) return false;
  return words.some(word => ['news', 'headline', 'headlines', 'breaking', 'latest', 'today', 'tonight'].includes(word));
}

function isCjk(code: number): boolean {
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af);
}

export function distinctiveTokens(query: string): string[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token));
  const cjk = [...query].filter(char => isCjk(char.codePointAt(0)!));
  if (cjk.length >= 2) for (let index = 0; index + 1 < cjk.length; index++) tokens.push(cjk[index]! + cjk[index + 1]!);
  else if (cjk.length === 1) tokens.push(cjk[0]!);
  return tokens;
}

export function mostlyLatin(text: string): boolean {
  let letters = 0, latin = 0;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    letters++;
    if (/[A-Za-z]/.test(char)) latin++;
  }
  return letters === 0 || (latin * 100) / letters >= 60;
}

/** A comparison key that ignores scheme, `www.`, fragments and trailing slashes. */
export function canonicalUrl(url: string): string {
  const withoutFragment = url.trim().split('#')[0]!;
  const queryAt = withoutFragment.indexOf('?');
  const path = queryAt < 0 ? withoutFragment : withoutFragment.slice(0, queryAt);
  const query = queryAt < 0 ? '' : withoutFragment.slice(queryAt + 1);
  const value = path.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return query ? `${value}?${query}` : value;
}

const resultKey = (result: SearchResult) => canonicalUrl(result.url) || `title:${result.title.toLowerCase()}`;

function overlap(tokens: string[], result: SearchResult): number {
  const blob = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  return tokens.filter(token => blob.includes(token)).length;
}

function qualityBonus(query: string, result: SearchResult): number {
  const host = hostOf(result.url);
  let bonus = isListingUrl(result.url) ? -0.6 : 0;
  if (queryLooksLikeNews(query)) {
    if (matchesDomain(host, NEWS_HOSTS)) bonus += 0.25;
    if (matchesDomain(host, TABLOID_HOSTS)) bonus -= 0.3;
  }
  return bonus;
}

/** Order by query overlap, prefer reliable news hosts for news queries, and cap results per host. */
export function rankResults(results: SearchResult[], query: string, limit: number): SearchResult[] {
  const tokens = distinctiveTokens(query);
  let scored = results.map(result => ({ score: overlap(tokens, result), result }));
  if (tokens.length) {
    if (mostlyLatin(query)) {
      scored = scored.filter(item => item.score > 0 || mostlyLatin(item.result.title));
      const latin = scored.filter(item => mostlyLatin(item.result.title));
      if (latin.length) scored = latin;
    }
    const news = queryLooksLikeNews(query);
    if (news) {
      const articles = scored.filter(item => !isListingUrl(item.result.url)
        && !matchesDomain(hostOf(item.result.url), TABLOID_HOSTS));
      const notListing = scored.filter(item => !isListingUrl(item.result.url));
      if (articles.length >= 3) scored = articles;
      else if (notListing.length) scored = notListing;
    }
    const preferred = (result: SearchResult) => (news && matchesDomain(hostOf(result.url), NEWS_HOSTS) ? 1 : 0);
    scored.sort((a, b) => preferred(b.result) - preferred(a.result) || b.score - a.score
      || a.result.title.localeCompare(b.result.title));
  }
  const output: SearchResult[] = [];
  const perHost = new Map<string, number>();
  for (const { result } of scored) {
    const host = hostOf(result.url);
    const count = perHost.get(host) ?? 0;
    if (count >= 2) continue;
    perHost.set(host, count + 1);
    output.push(result);
    if (output.length >= limit) break;
  }
  return output;
}

/** Merge several engines' results, keeping the most detailed duplicate and weighting each engine. */
export function mergeResults(sources: SourcedResults[], query: string, limit: number): SearchResult[] {
  const merged = new Map<string, { score: number; result: SearchResult }>();
  for (const { source, results } of sources) {
    const weight = SOURCE_WEIGHT[source] ?? 0.9;
    results.forEach((result, rank) => {
      const key = resultKey(result);
      const existing = merged.get(key);
      if (existing) {
        if (result.snippet.length > existing.result.snippet.length) existing.result = result;
        return;
      }
      const tokens = distinctiveTokens(query);
      const score = weight / (20 + rank) + 0.08 * Math.min(4, overlap(tokens, result)) + qualityBonus(query, result);
      merged.set(key, { score, result });
    });
  }
  const ordered = [...merged.values()].sort((a, b) => b.score - a.score).map(item => item.result);
  return rankResults(ordered, query, limit);
}
