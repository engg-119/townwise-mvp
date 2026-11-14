// Claude's web search (docs/portal/tuning-chat.md section 4): a server tool that Anthropic runs inside the model call,
// so it is not in the registry and turn.ts never runs it. It is sent after the registry's tools on every request.
// Its query and the pages it reads go from Anthropic to its search provider, never through Townwise. What the owner
// sees of it, as of every tool: counts and source links only, never the query.
import type { BetaWebSearchTool20260318 } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { sourceLinks } from './tools/shared.ts';
import type { ToolView } from './tools/registry.ts';

export const WEB_SEARCH = 'web_search';

/** Searches per turn, across its model calls; one past it is an error result the model reads. */
export const MAX_SEARCHES_PER_TURN = 5;

/** Each search, $10 per 1,000 (list price), in micro-dollars; a failed search is not billed. */
export const SEARCH_MICRO_USD = 10_000;

/**
 * Called directly: the dynamic-filtering default runs the search from code execution, which would add code execution
 * blocks and a container to every stored reply.
 */
export const WEB_SEARCH_TOOL: BetaWebSearchTool20260318 = {
  type: 'web_search_20260318', name: WEB_SEARCH, max_uses: MAX_SEARCHES_PER_TURN, allowed_callers: ['direct'],
};

export interface SourceLink { readonly host: string; readonly url: string }

/** The urls of a search result's pages; null for a failed search (its content is one error object). */
function pagesOf(content: unknown): string[] | null {
  if (!Array.isArray(content)) return null;
  return content.flatMap((page: unknown) => {
    const url = typeof page === 'object' && page !== null ? (page as { url?: unknown }).url : undefined;
    return typeof url === 'string' ? [url] : [];
  });
}

/** Whether a web_search_tool_result's content is pages, not an error: only those are billed. */
export function searchFound(content: unknown): boolean {
  return pagesOf(content) !== null;
}

/** A search card's result view: how many pages it found and the first five https links; null for a failed one. */
export function searchResultView(content: unknown): ToolView | null {
  const pages = pagesOf(content);
  return pages === null ? null : { pages: pages.length, sources: sourceLinks(pages) };
}

/**
 * The pages a reply's text cites from its searches: each https page once, in order, all of them. Anthropic requires
 * them shown with the reply, so unlike a card's links they are not capped.
 */
export function citedSources(blocks: readonly unknown[]): SourceLink[] {
  const urls = blocks.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return [];
    const { type, citations } = block as { type?: unknown; citations?: unknown };
    if (type !== 'text' || !Array.isArray(citations)) return [];
    return citations.flatMap((citation: unknown) => {
      const { type: kind, url } = (citation ?? {}) as { type?: unknown; url?: unknown };
      return kind === 'web_search_result_location' && typeof url === 'string' ? [url] : [];
    });
  });
  return sourceLinks(urls, Infinity);
}
