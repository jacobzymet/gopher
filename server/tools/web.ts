import { fetchPublicUrl, PageCache } from './page-fetch.js';
import { duckDuckGo, parallel, searxng, tinyfish, type EngineSettings } from './search-engines.js';
import { mergeResults, type SearchResult, type SourcedResults } from './search-ranking.js';
import { describeNetworkError } from '../network-errors.js';

/** Web search for agent tools: engine selection, fallback, ranking and optional page enrichment. */

export { assertPublicUrl, createPublicFetch, pinnedLookup, privateAddress, safeFetch } from './public-fetch.js';
export type { PublicFetchDependencies } from './public-fetch.js';
export { fetchPublicUrl, PageCache } from './page-fetch.js';
export type { FetchedPage } from './page-fetch.js';
export type { SearchResult } from './search-ranking.js';

export type SearchProvider = 'duckduckgo' | 'searxng' | 'parallel' | 'tinyfish';
export interface SearchSettings extends EngineSettings {
  searchProvider: 'auto' | SearchProvider;
  searchDepth: 'fast' | 'balanced' | 'deep';
  searchPageCount?: number;
  searchPageMaxChars?: number;
}
export interface SearchCredentials { parallel?: string; tinyfish?: string }
export interface SearchResponse { provider: string; results: SearchResult[]; note: string }

const LABELS: Record<SearchProvider, string> = {
  parallel: 'Parallel', tinyfish: 'TinyFish', searxng: 'SearXNG', duckduckgo: 'DuckDuckGo',
};

/** At balanced and deep settings, read the top result pages and append their text to the snippets. */
async function enrichForDepth(results: SearchResult[], settings: SearchSettings, signal: AbortSignal,
  cache?: PageCache) {
  if (settings.searchDepth === 'fast' || settings.searchPageCount === 0) {
    return results.map(item => ({ ...item, snippet: item.snippet.slice(0, 1200) }));
  }
  const pages = settings.searchPageCount ?? (settings.searchDepth === 'deep' ? 4 : 3);
  const chars = settings.searchPageMaxChars ?? (settings.searchDepth === 'deep' ? 5000 : 3000);
  return Promise.all(results.map(async (item, index) => {
    if (index >= pages) return item;
    try {
      const fetcher = () => fetchPublicUrl(item.url, signal, 4_000_000);
      const page = await (cache ? cache.read(item.url, fetcher) : fetcher());
      const snippet = [item.snippet, page.text.slice(0, chars)].filter(Boolean).join('\nFull-page context: ');
      return { ...item, snippet: snippet.slice(0, chars + 1200) };
    } catch { return item; }
  }));
}

function runEngine(provider: SearchProvider, query: string, settings: SearchSettings, signal: AbortSignal,
  credentials: SearchCredentials): Promise<SourcedResults[]> {
  if (provider === 'parallel') return parallel(query, settings, signal, credentials.parallel);
  if (provider === 'tinyfish') return tinyfish(query, settings, signal, credentials.tinyfish);
  if (provider === 'searxng') return searxng(query, settings, signal);
  return duckDuckGo(query, settings, signal);
}

export async function searchWeb(query: string, settings: SearchSettings, signal: AbortSignal,
  credentials: SearchCredentials = {}, cache?: PageCache): Promise<SearchResponse> {
  const run = async (provider: SearchProvider): Promise<SearchResponse> => {
    const sources = await runEngine(provider, query, settings, signal, credentials);
    const results = mergeResults(sources, query, settings.searchResultCount);
    if (!results.length) throw new Error(`${provider} returned no usable results`);
    const label = LABELS[provider];
    const mode = provider === 'parallel' ? ` · ${credentials.parallel ? settings.parallelMode : 'free MCP'}` : '';
    return { provider: label, results: await enrichForDepth(results, settings, signal, cache),
      note: `${label}${mode} · ${settings.searchDepth}` };
  };
  if (settings.searchProvider !== 'auto') return run(settings.searchProvider);
  const order: SearchProvider[] = settings.searxngUrl.trim() ? ['searxng', 'duckduckgo'] : ['duckduckgo'];
  const errors: string[] = [];
  for (const provider of order) {
    try {
      const result = await run(provider);
      return errors.length
        ? { ...result, note: `${result.note} · fallback after ${errors.join('; ').slice(0, 180)}` } : result;
    } catch (error) {
      if (signal.aborted) throw error;
      errors.push(`${provider}: ${describeNetworkError(error)}`);
    }
  }
  const hint = settings.searxngUrl.trim()
    ? '' : ' DuckDuckGo may be blocking automated searches; set a SearXNG instance '
    + 'or choose Parallel or TinyFish in Settings → Web search.';
  throw new Error(`Auto search failed. ${errors.join('; ').slice(0, 600)}${hint}`);
}
