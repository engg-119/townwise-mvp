// What one model call cost, in whole micro-dollars (docs/portal/tuning-chat.md section 5). Prices are list prices
// in US dollars per million tokens, which is micro-dollars per token; they are kept as integer nano-dollars per token
// so the sum is exact before it is rounded up.
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { SEARCH_MICRO_USD } from './web-search.ts';

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

/** One call's cost, rounded up to a whole micro-dollar. */
export function costMicroUsd(model: string, tokens: TokenCounts): number {
  return Math.ceil(nanoUsd(model, tokens) / 1000);
}

/** Web searches at their list price (web-search.ts): a whole number of micro-dollars each. */
export function searchCostMicroUsd(searches: number): number {
  return searches * SEARCH_MICRO_USD;
}

/**
 * A finished call's cost. When the server ran more than one attempt (a refusal fallback), `usage.iterations` holds
 * each attempt with the model that ran it and is the source of truth for tokens; top-level `usage` covers only the
 * last one. Web searches are counted only at the top level, for the whole call, and added on top.
 */
export function messageCostMicroUsd(message: Pick<BetaMessage, 'model' | 'usage'>): number {
  const searches = searchCostMicroUsd(message.usage.server_tool_use?.web_search_requests ?? 0);
  const iterations = message.usage.iterations ?? [];
  if (iterations.length === 0) return costMicroUsd(message.model, tokensOf(message.usage)) + searches;
  const nano = iterations.reduce((sum, entry) => {
    const model = 'model' in entry && entry.model !== null ? entry.model : message.model;
    return sum + nanoUsd(model, tokensOf(entry));
  }, 0);
  return Math.ceil(nano / 1000) + searches;
}
