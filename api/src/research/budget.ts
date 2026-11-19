// What a research thread reserves before its first call (D66 design decision 7). Pure. The reservation is the most the
// thread's two calls can cost on any model a refusal fallback may move them to (pricing.ts ceilingCostMicroUsd), plus
// every search it may make; a finished thread settles to what its messages cost, and the rest goes back.
//
//   iterations    = S + F + 1 + MAX_CONTINUATIONS   (each search, each fetch, the last answer, each resent pause)
//   gather input  = iterations x (S x SEARCH_TOKENS + F x FETCH_TOKENS) as input, and iterations x P as a cache write
//   gather output = (1 + MAX_CONTINUATIONS) x GATHER_MAX_TOKENS
//   extract input = gather output + (S + F) x LEDGER_TOKENS_PER_CALL + EXTRACT_FRAME_TOKENS, output EXTRACT_MAX_TOKENS
//   reserve       = ceiling(gather) + ceiling(extract) + S x SEARCH_MICRO_USD
//
// S and F are the thread's search and fetch limits (F is 0 while fetch is off), P the gather prompt's tokens at 3
// characters a token. Every iteration resends the whole conversation, so each is priced with every page the thread
// may read and the prompt written to the cache again. The probe (task 0.2) found every resent prefix read from the
// cache at a tenth of the input price, so this ceiling is far above a real thread's cost; SEARCH_TOKENS is calibrated
// by the live eval (task 10.1) from `usage.iterations`.
import { ceilingCostMicroUsd, SEARCH_MICRO_USD, type TokenCounts } from '../chat/pricing.ts';
import type { GatherPrompt } from './prompt.ts';
import { MAX_FETCHES, type ThreadDef } from './threads.ts';

export const CHARS_PER_TOKEN = 3;
/** Paused gather messages resent, at most (turn.ts's pause_turn pattern). */
export const MAX_CONTINUATIONS = 2;
export const GATHER_MAX_TOKENS = 16_000;
export const EXTRACT_MAX_TOKENS = 12_000;
/** One search's pages as the model reads them; the probe measured about 6,830 (design decision 7). */
export const SEARCH_TOKENS = 8_000;
/** One fetched page: the fetch tool's `max_content_tokens`. */
export const FETCH_TOKENS = 8_000;
/** The extract's source table rows and cited words that one search's or fetch's pages can add: about 10 rows and their quotes. */
export const LEDGER_TOKENS_PER_CALL = 4_000;
/** The extract's own instructions and its input's JSON keys (test/research-budget.test.ts pins it above the real prompt). */
export const EXTRACT_FRAME_TOKENS = 1_500;

export interface ThreadLimits {
  readonly searches: number;
  readonly fetches: number;
  /** The gather prompt's tokens, system and user message. */
  readonly promptTokens: number;
}

export function tokensOfChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The gather prompt's characters: its system text and its user message. */
export function gatherPromptChars(prompt: GatherPrompt): number {
  return prompt.system.reduce((sum, block) => sum + block.text.length, 0) + prompt.user.length;
}

/** A thread's limits: its own search limit, MAX_FETCHES while fetch is on, and its prompt's size. */
export function threadLimits(thread: Pick<ThreadDef, 'maxSearches'>, fetchOn: boolean, prompt: GatherPrompt): ThreadLimits {
  return { searches: thread.maxSearches, fetches: fetchOn ? MAX_FETCHES : 0, promptTokens: tokensOfChars(gatherPromptChars(prompt)) };
}

export function gatherIterations(limits: ThreadLimits): number {
  return limits.searches + limits.fetches + 1 + MAX_CONTINUATIONS;
}

const GATHER_OUTPUT = (1 + MAX_CONTINUATIONS) * GATHER_MAX_TOKENS;

export function gatherCeiling(limits: ThreadLimits): TokenCounts {
  const iterations = gatherIterations(limits);
  return {
    input: iterations * (limits.searches * SEARCH_TOKENS + limits.fetches * FETCH_TOKENS),
    output: GATHER_OUTPUT,
    cacheRead: 0,
    cacheWrite: iterations * limits.promptTokens,
  };
}

/** The extract's ceiling before the gather has run: every token the gather may write, and the ledger's text. */
export function extractCeiling(limits: ThreadLimits): TokenCounts {
  return {
    input: GATHER_OUTPUT + (limits.searches + limits.fetches) * LEDGER_TOKENS_PER_CALL + EXTRACT_FRAME_TOKENS,
    output: EXTRACT_MAX_TOKENS,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

/** What a thread reserves before its first call. */
export function reserveMicroUsd(limits: ThreadLimits): number {
  return ceilingCostMicroUsd(gatherCeiling(limits)) + ceilingCostMicroUsd(extractCeiling(limits)) + limits.searches * SEARCH_MICRO_USD;
}

/** The extract's ceiling once its prompt is known (call.ts decides from it whether a paused gather may continue). */
export function extractCallCeilingMicroUsd(promptChars: number): number {
  return ceilingCostMicroUsd({ input: tokensOfChars(promptChars), output: EXTRACT_MAX_TOKENS, cacheRead: 0, cacheWrite: 0 });
}
