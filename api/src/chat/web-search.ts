// TownwiseAI's web search (docs/portal/tuning-chat.md section 4, spec D37): Anthropic's server tool. It runs inside the
// model call, so it is not in the registry and turn.ts never runs it; while TOWNWISE_CHAT_WEB_SEARCH is on, every
// request sends it after the registry's tools, always last. Its query and the pages it reads go between Anthropic and
// its search provider, never through Townwise. What the owner sees of a search is a count and source links, never its
// query; a log line or an audit event carries a count only, never a query, a URL, a title or a page's text.
import type {
  BetaContentBlockParam, BetaMessageParam, BetaWebSearchTool20260209, BetaWebSearchToolResultBlockContent,
  BetaWebSearchToolResultBlockParamContent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { ToolView } from './tools/registry.ts';

export const WEB_SEARCH = 'web_search';
/** D66: the page fetch tool's name. The chat never sends it; town research may (TOWNWISE_RESEARCH_WEB_FETCH). */
export const WEB_FETCH = 'web_fetch';

/**
 * Called directly: web_search_20260209 would otherwise run its searches from code execution (dynamic filtering), adding
 * code execution blocks to every stored reply. No user_location and no domain lists: the tool is part of the frozen
 * prefix. [CONFIRM: max_uses 3 a call and "three a reply" in the prompt]
 */
export const WEB_SEARCH_TOOL: BetaWebSearchTool20260209 = {
  type: 'web_search_20260209', name: WEB_SEARCH, max_uses: 3, allowed_callers: ['direct'],
};

/** At most this many links on a search's card, one a host. */
const MAX_CARD_SOURCES = 5;
/** At most this many links under a reply. */
const MAX_REPLY_SOURCES = 10;

export interface SourceLink { readonly host: string; readonly url: string }

/**
 * The https links among `urls`, in order, one for each distinct `key`, at most `max`; `host` is the URL's hostname.
 * Its own object type, not SourceLink, so a card's view (JSON) can hold it.
 */
function httpsLinks(urls: readonly string[], max: number, key: (link: SourceLink) => string): { host: string; url: string }[] {
  const links: { host: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (links.length === max) break;
    const parsed = URL.parse(url);
    if (parsed?.protocol !== 'https:') continue;
    const link = { host: parsed.hostname, url };
    if (seen.has(key(link))) continue;
    seen.add(key(link));
    links.push(link);
  }
  return links;
}

type SearchContent = BetaWebSearchToolResultBlockContent | BetaWebSearchToolResultBlockParamContent;

/**
 * A search's card, streamed and stored alike: `done` with `{ pages, sources }` (how many results it found, and the
 * first link of each of up to 5 distinct https hosts, in result order), or `error` with `{ code }`, the API's error
 * code (a failed search is a result block with an error, never a failed call).
 */
export function searchCard(content: SearchContent): { state: 'done' | 'error'; result: ToolView } {
  if (Array.isArray(content)) {
    return {
      state: 'done',
      result: { pages: content.length, sources: httpsLinks(content.map((page) => page.url), MAX_CARD_SOURCES, (link) => link.host) },
    };
  }
  return { state: 'error', result: { code: content.error_code } };
}

/**
 * The pages a reply's text cites from its searches (`web_search_result_location` citations), each distinct https URL
 * once, in order, at most 10. The client shows them under the reply.
 */
export function citedSources(blocks: readonly BetaContentBlockParam[]): SourceLink[] {
  const urls = blocks.flatMap((block) => (block.type === 'text' && Array.isArray(block.citations)
    ? block.citations.flatMap((citation) => (citation.type === 'web_search_result_location' ? [citation.url] : []))
    : []));
  return httpsLinks(urls, MAX_REPLY_SOURCES, (link) => link.url);
}

/**
 * Whether these messages carry a search's results. The API restores a stored result's pages into the model's context
 * on every later request (its encrypted_content), so a request that carries one carries web pages' text.
 */
export function carriesWebPages(messages: readonly BetaMessageParam[]): boolean {
  return messages.some((param) => param.role === 'assistant' && typeof param.content !== 'string'
    && param.content.some((block) => block.type === 'web_search_tool_result'));
}
