// A research thread's source ledger (D66 design decision 5): every page the gather call's own messages returned, paused
// messages included, each with an id S1..Sn the extract cites instead of a URL. A stored finding's source is always a
// ledger URL, so the model never types one. Pure.
//
// A URL enters the ledger only from a web search result, a web fetch result or a citation of these messages: https
// only, without its fragment, normalized by URL.parse, each distinct URL once, in order of first appearance. A result
// some other caller made (code execution, `caller` not direct) and a failed search or fetch add nothing. A search
// finding cites `web_search_result_location` with its URL; a fetched page's finding cites `char_location` with no URL,
// so it is mapped to the page by `document_index`, the position of that page among the fetch results (task 0.2's probe;
// task 10.1 checks it with two fetches). Grounding (verify.ts) reads the cited words and the fetched text kept here.
import type { BetaContentBlock, BetaMessage, BetaTextCitation } from '@anthropic-ai/sdk/resources/beta/messages/messages';

export interface LedgerSource {
  /** 'S1', 'S2', ... */
  readonly id: string;
  readonly url: string;
  /** The URL's hostname without www. */
  readonly host: string;
  /** The page's title as the search or fetch result gave it (page text, never logged); null when none did. */
  readonly title: string | null;
  /** The search result's `page_age` ("3 days ago", "May 2, 2025"); null when unknown or fetched only. */
  readonly pageAge: string | null;
  /** The words the gather's citations quoted from this page. */
  readonly quotes: readonly string[];
  /** The fetched page's text; null when the page was not fetched (search results carry no readable text). */
  readonly fetchedText: string | null;
}

export interface Ledger {
  readonly sources: readonly LedgerSource[];
  /** A source by id, or undefined for an id the ledger does not hold. */
  byId(id: string): LedgerSource | undefined;
  /** The id a citation points at, or null when its page is not in the ledger. */
  idOfCitation(citation: BetaTextCitation): string | null;
}

/** The URL as the ledger keys it: https only, no fragment. Null for anything else. */
export function normalizeUrl(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== 'https:' || parsed.hostname === '') return null;
  parsed.hash = '';
  return parsed.href;
}

/** Whether a server tool's result was returned to the model directly (not through code execution). */
function direct(block: { caller?: { type: string } }): boolean {
  return block.caller === undefined || block.caller.type === 'direct';
}

interface Draft { id: string; url: string; host: string; title: string | null; pageAge: string | null; quotes: string[]; fetchedText: string | null }

export function buildLedger(messages: readonly BetaMessage[]): Ledger {
  const drafts: Draft[] = [];
  const byUrl = new Map<string, Draft>();
  /** Each successful direct fetch result in order: its ledger entry, or null when its URL was not https. */
  const documents: (Draft | null)[] = [];

  const add = (rawUrl: string, from: { title?: string | null; pageAge?: string | null; fetchedText?: string | null }): Draft | null => {
    const url = normalizeUrl(rawUrl);
    if (url === null) return null;
    let draft = byUrl.get(url);
    if (draft === undefined) {
      draft = {
        id: `S${String(drafts.length + 1)}`, url, host: new URL(url).hostname.replace(/^www\./, ''),
        title: null, pageAge: null, quotes: [], fetchedText: null,
      };
      drafts.push(draft);
      byUrl.set(url, draft);
    }
    draft.title ??= from.title ?? null;
    draft.pageAge ??= from.pageAge ?? null;
    draft.fetchedText ??= from.fetchedText ?? null;
    return draft;
  };

  const blocks: BetaContentBlock[] = messages.flatMap((message) => message.content);
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' && direct(block) && Array.isArray(block.content)) {
      for (const result of block.content) add(result.url, { title: result.title, pageAge: result.page_age });
    } else if (block.type === 'web_fetch_tool_result' && direct(block) && block.content.type === 'web_fetch_result') {
      const document = block.content.content;
      const fetchedText = document.source.type === 'text' ? document.source.data : null;
      documents.push(add(block.content.url, { title: document.title, fetchedText }));
    }
  }

  const draftOf = (citation: BetaTextCitation): Draft | null => {
    if (citation.type === 'web_search_result_location') return add(citation.url, { title: citation.title });
    if (citation.type === 'char_location') return documents[citation.document_index] ?? null;
    return null;
  };
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const citation of block.citations ?? []) {
      const draft = draftOf(citation);
      if (draft !== null && citation.cited_text !== '' && !draft.quotes.includes(citation.cited_text)) draft.quotes.push(citation.cited_text);
    }
  }

  const sources: LedgerSource[] = drafts;
  const ids = new Map(sources.map((source) => [source.id, source]));
  return {
    sources,
    byId: (id) => ids.get(id),
    idOfCitation: (citation) => {
      if (citation.type === 'web_search_result_location') {
        const url = normalizeUrl(citation.url);
        return url === null ? null : byUrl.get(url)?.id ?? null;
      }
      if (citation.type === 'char_location') return documents[citation.document_index]?.id ?? null;
      return null;
    },
  };
}
