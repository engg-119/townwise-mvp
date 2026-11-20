// What one model call cost, in whole micro-dollars (docs/portal/tuning-chat.md section 5). Prices are list prices
// in US dollars per million tokens, which is micro-dollars per token; they are kept as integer nano-dollars per token
// so the sum is exact before it is rounded up.
import type { BetaMessage, BetaRawContentBlockDelta, BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { WEB_FETCH, WEB_SEARCH } from './web-search.ts';

export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Nano-dollars per token. Cache writes use the 5-minute TTL, 1.25 times input; the chat never asks for 1 hour. */
interface Price { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }

function perMillion(input: number, output: number, cacheRead: number): Price {
  return { input: input * 1000, output: output * 1000, cacheRead: cacheRead * 1000, cacheWrite: input * 1250 };
}

/**
 * Keyed by the model that answered (`message.model`). claude-opus-5-5 is the chat's model; the other two are where
 * its server-side refusal fallback can send a request, priced at their own rates.
 */
const PRICES: ReadonlyMap<string, Price> = new Map([
  ['claude-opus-5-5', perMillion(4, 20, 0.2)],
  ['claude-opus-5', perMillion(5, 25, 0.5)],
  ['claude-opus-4-8', perMillion(5, 25, 0.5)],
]);

/** Any other or unknown model is priced at the most expensive row. */
const MOST_EXPENSIVE: Price = [...PRICES.values()].reduce((a, b) => (b.output > a.output || (b.output === a.output && b.input > a.input) ? b : a));

function nanoUsd(model: string, tokens: TokenCounts): number {
  const price = PRICES.get(model) ?? MOST_EXPENSIVE;
  return tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead
    + tokens.cacheWrite * price.cacheWrite;
}

/** The tokens of one call or attempt as its usage reports them. */
export function tokensOf(usage: {
  input_tokens: number | null; output_tokens: number;
  cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null;
}): TokenCounts {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * The most `tokens` can cost on any model a call may run on (the most expensive row: a refusal fallback can move a
 * call to a model priced above the one asked for), rounded up to a whole micro-dollar. A budget reserves this before a
 * call whose cost it cannot know yet. Cache writes count at that row's cache-write price (D66 research reserves its
 * prompt as one); every other caller passes 0. Cache reads are not counted: a ceiling prices input as fresh input.
 */
export function ceilingCostMicroUsd(tokens: TokenCounts): number {
  return Math.ceil((tokens.input * MOST_EXPENSIVE.input + tokens.output * MOST_EXPENSIVE.output
    + tokens.cacheWrite * MOST_EXPENSIVE.cacheWrite) / 1000);
}

/** One call's cost, rounded up to a whole micro-dollar. */
export function costMicroUsd(model: string, tokens: TokenCounts): number {
  return Math.ceil(nanoUsd(model, tokens) / 1000);
}

/** D37: a web search, $10 per 1,000 (list price), on top of its tokens. A search that fails is not billed. */
export const SEARCH_MICRO_USD = 10_000;

/**
 * A finished call's cost. When the server ran more than one attempt (a refusal fallback), `usage.iterations` holds
 * each attempt with the model that ran it and is the source of truth; top-level `usage` covers only the last one.
 * Web searches are counted once, from the call's top-level `usage.server_tool_use` (D37): its iterations carry none.
 */
export function messageCostMicroUsd(message: Pick<BetaMessage, 'model' | 'usage'>): number {
  const searches = (message.usage.server_tool_use?.web_search_requests ?? 0) * SEARCH_MICRO_USD;
  const iterations = message.usage.iterations ?? [];
  if (iterations.length === 0) return costMicroUsd(message.model, tokensOf(message.usage)) + searches;
  const nano = iterations.reduce((sum, entry) => {
    const model = 'model' in entry && entry.model !== null ? entry.model : message.model;
    return sum + nanoUsd(model, tokensOf(entry));
  }, 0);
  return Math.ceil(nano / 1000) + searches;
}

/** The characters a content delta streams: text, thinking and tool input. */
function streamedCharacters(delta: BetaRawContentBlockDelta): number {
  switch (delta.type) {
    case 'text_delta': return delta.text.length;
    case 'thinking_delta': return delta.thinking.length;
    case 'input_json_delta': return delta.partial_json.length;
    default: return 0;
  }
}

/** What one call has spent so far, from its stream's events. */
export interface RunningSpend {
  observe(event: BetaRawMessageStreamEvent): void;
  costMicroUsd(): number;
  searches(): number;
  /** D66: page fetches, a count only (a fetch adds tokens and has no fee of its own). The chat never fetches. */
  fetches(): number;
}

/**
 * What a call that never finished used so far, for its cost (the chat turn's and D66 research's one tally). Input
 * tokens come from message_start and output tokens only from message_delta. A call aborted or failed after
 * message_start but before message_delta is charged an output estimate instead of the token or so message_start reports:
 *
 *   min(maxTokens, max(ceil(streamed characters / 3), ceil(seconds since message_start x 150)))
 *
 * at the price of the model that was answering. Streamed characters are those of text, thinking and tool input
 * deltas; the time term covers thinking that is billed but not streamed (a summary is shorter than the thinking behind it).
 * Its web searches (D37) are charged as message_delta reports them, and before it does, one for each search the call
 * started that did not come back as an error (a failed search is not billed). Fetches are counted the same way.
 */
export function runningSpend(now: () => Date, maxTokens: number): RunningSpend {
  let model: string | null = null;
  let tokens: TokenCounts | null = null;
  let startedAt = 0;
  let characters = 0;
  let outputReported = false;
  let searchesStarted = 0;
  let searchesReported: number | null = null;
  let fetchesStarted = 0;
  let fetchesReported: number | null = null;
  const searches = (): number => searchesReported ?? Math.max(0, searchesStarted);
  return {
    observe(event) {
      if (event.type === 'message_start') {
        model = event.message.model;
        tokens = tokensOf(event.message.usage);
        startedAt = now().getTime();
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'server_tool_use' && block.name === WEB_SEARCH) searchesStarted += 1;
        if (block.type === 'web_search_tool_result' && !Array.isArray(block.content)) searchesStarted -= 1;
        if (block.type === 'server_tool_use' && block.name === WEB_FETCH) fetchesStarted += 1;
        if (block.type === 'web_fetch_tool_result' && block.content.type !== 'web_fetch_result') fetchesStarted -= 1;
      } else if (event.type === 'content_block_delta') {
        characters += streamedCharacters(event.delta);
      } else if (event.type === 'message_delta' && tokens !== null) {
        outputReported = true;
        searchesReported = event.usage.server_tool_use?.web_search_requests ?? searchesReported;
        fetchesReported = event.usage.server_tool_use?.web_fetch_requests ?? fetchesReported;
        tokens = {
          input: event.usage.input_tokens ?? tokens.input,
          output: event.usage.output_tokens,
          cacheRead: event.usage.cache_read_input_tokens ?? tokens.cacheRead,
          cacheWrite: event.usage.cache_creation_input_tokens ?? tokens.cacheWrite,
        };
      }
    },
    costMicroUsd() {
      if (model === null || tokens === null) return 0;
      const searched = searches() * SEARCH_MICRO_USD;
      if (outputReported) return costMicroUsd(model, tokens) + searched;
      const seconds = (now().getTime() - startedAt) / 1000;
      const output = Math.min(maxTokens, Math.max(Math.ceil(characters / 3), Math.ceil(seconds * 150)));
      return costMicroUsd(model, { ...tokens, output }) + searched;
    },
    searches,
    fetches: () => fetchesReported ?? Math.max(0, fetchesStarted),
  };
}
