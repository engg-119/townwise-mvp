// What a research thread reserves (D66 design decision 7, task 1.5). The formula is recomputed here by hand, in
// micro-dollars at the most expensive model's list prices ($5 input, $25 output, $6.25 cache write per million tokens),
// for the town and location limits with and without fetch, so a change to either side shows. Continuations and the
// prompt's cache writes are counted. pricing.ts's ceiling gains cache writes without changing a caller that passes 0,
// and runningSpend (moved from chat/turn.ts) counts fetches beside searches.
import { describe, expect, it } from 'vitest';

import { ceilingCostMicroUsd, runningSpend } from '../src/chat/pricing.ts';
import {
  EXTRACT_FRAME_TOKENS, MAX_CONTINUATIONS, extractCallCeilingMicroUsd, extractCeiling, gatherCeiling, gatherIterations,
  gatherPromptChars, reserveMicroUsd, threadLimits, type ThreadLimits,
} from '../src/research/budget.ts';
import { buildLedger } from '../src/research/ledger.ts';
import { extractPrompt, type GatherPrompt } from '../src/research/prompt.ts';
import { LOCATION_MAX_SEARCHES, MAX_FETCHES, TOWN_MAX_SEARCHES, threadsFor } from '../src/research/threads.ts';
import { eventsOf, fetchError, fetchResult, message, text, webFetch, webResults, webSearch } from './helpers/chat-model.ts';

/** Micro-dollars per token, the most expensive row. */
const INPUT = 5;
const OUTPUT = 25;
const CACHE_WRITE = 6.25;
const SEARCH_FEE = 10_000;

/** The design's formula, written out. */
function byHand(s: number, f: number, p: number): number {
  const iterations = s + f + 1 + 2;
  const gatherOutput = 3 * 16_000;
  const gather = iterations * (s * 8_000 + f * 8_000) * INPUT + iterations * p * CACHE_WRITE + gatherOutput * OUTPUT;
  const extract = (gatherOutput + (s + f) * 4_000 + 1_500) * INPUT + 12_000 * OUTPUT;
  return Math.ceil(gather) + Math.ceil(extract) + s * SEARCH_FEE;
}

const prompt: GatherPrompt = { system: [{ type: 'text', text: 'x'.repeat(2_400) }], user: 'y'.repeat(600) };

describe('research budget', () => {
  it('a thread\'s limits come from its thread, the fetch switch and its prompt at 3 characters a token', () => {
    const [town] = threadsFor({ kind: 'town', townId: 'hanover-nh' }, { placesToAi: false });
    const [location] = threadsFor({ kind: 'location', townId: 'hanover-nh' }, { placesToAi: false });
    if (town === undefined || location === undefined) throw new Error('no thread');
    expect(gatherPromptChars(prompt)).toBe(3_000);
    expect(threadLimits(town, false, prompt)).toEqual({ searches: TOWN_MAX_SEARCHES, fetches: 0, promptTokens: 1_000 });
    expect(threadLimits(location, true, prompt)).toEqual({ searches: LOCATION_MAX_SEARCHES, fetches: MAX_FETCHES, promptTokens: 1_000 });
  });

  it('counts every search, every fetch, the last answer and each continuation as an iteration', () => {
    expect(MAX_CONTINUATIONS).toBe(2);
    expect(gatherIterations({ searches: 8, fetches: 0, promptTokens: 1 })).toBe(11);
    expect(gatherIterations({ searches: 5, fetches: 2, promptTokens: 1 })).toBe(10);
  });

  it.each([
    ['a town thread, fetch off', { searches: 8, fetches: 0, promptTokens: 1_000 }],
    ['a town thread, fetch on', { searches: 8, fetches: 2, promptTokens: 1_000 }],
    ['a location thread, fetch off', { searches: 5, fetches: 0, promptTokens: 1_500 }],
    ['a location thread, fetch on', { searches: 5, fetches: 2, promptTokens: 1_500 }],
  ] as const)('reserves the formula for %s', (_name, limits: ThreadLimits) => {
    expect(reserveMicroUsd(limits)).toBe(byHand(limits.searches, limits.fetches, limits.promptTokens));
  });

  it('pins the shipped config\'s ceilings: about $5.58 a town thread and $3.55 a location thread', () => {
    expect(reserveMicroUsd({ searches: 8, fetches: 0, promptTokens: 1_000 })).toBe(5_576_250);
    expect(reserveMicroUsd({ searches: 5, fetches: 0, promptTokens: 1_000 })).toBe(3_547_500);
  });

  it('prices the prompt as a cache write on every iteration, and continuations as resent conversations', () => {
    const limits = { searches: 5, fetches: 0, promptTokens: 2_000 };
    const gather = gatherCeiling(limits);
    expect(gather).toEqual({ input: 8 * 40_000, output: 48_000, cacheRead: 0, cacheWrite: 8 * 2_000 });
    // One more prompt token costs one cache write an iteration, rounded up.
    expect(reserveMicroUsd({ ...limits, promptTokens: 2_001 }) - reserveMicroUsd(limits)).toBe(Math.ceil(8 * CACHE_WRITE));
    expect(extractCeiling(limits)).toEqual({ input: 48_000 + 5 * 4_000 + 1_500, output: 12_000, cacheRead: 0, cacheWrite: 0 });
  });

  it('reserves the extract\'s frame above its real instructions and empty input', () => {
    const [thread] = threadsFor({ kind: 'location', townId: 'hanover-nh' }, { placesToAi: false });
    if (thread === undefined) throw new Error('no thread');
    const empty = extractPrompt({ messages: [], ledger: buildLedger([]), window: { from: '2026-11-19', to: '2027-05-18' }, thread, competitors: null });
    expect(Math.ceil((empty.system.length + empty.user.length) / 3)).toBeLessThan(EXTRACT_FRAME_TOKENS);
  });

  it('prices a known extract prompt at its own size', () => {
    expect(extractCallCeilingMicroUsd(30_000)).toBe(10_000 * INPUT + 12_000 * OUTPUT);
  });
});

describe('pricing ceilings', () => {
  it('counts cache writes at the most expensive cache-write price', () => {
    expect(ceilingCostMicroUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 })).toBe(6_250_000);
  });

  it('leaves a caller that passes no cache write where it was', () => {
    expect(ceilingCostMicroUsd({ input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 })).toBe(1_000 * INPUT + 100 * OUTPUT);
    // Cache reads are never counted: a ceiling prices every input token as fresh.
    expect(ceilingCostMicroUsd({ input: 1_000, output: 100, cacheRead: 9_999, cacheWrite: 0 })).toBe(1_000 * INPUT + 100 * OUTPUT);
  });
});

describe('runningSpend', () => {
  const now = (): Date => new Date('2026-11-19T12:00:00Z');

  it('counts fetches started that did not fail before the call reports its usage', () => {
    const final = message([
      webSearch('s1'), webResults('s1', ['https://a.example.org/']),
      webFetch('f1', 'https://a.example.org/'), fetchResult('f1', 'https://a.example.org/', 'page'),
      webFetch('f2', 'https://b.example.org/'), fetchError('f2'),
      text('done'),
    ], { usage: { searches: 1, fetches: 1 } });
    const spend = runningSpend(now, 16_000);
    const events = eventsOf(final);
    // Everything but message_delta and message_stop: the call failed before its usage.
    for (const event of events.slice(0, -2)) spend.observe(event);
    expect(spend.searches()).toBe(1);
    expect(spend.fetches()).toBe(1);
    // Then the usage the API reports stands.
    for (const event of events.slice(-2)) spend.observe(event);
    expect(spend.fetches()).toBe(1);
    expect(spend.searches()).toBe(1);
  });

  it('charges a search started in a stream that failed', () => {
    const final = message([webSearch('s1'), webResults('s1', ['https://a.example.org/']), webSearch('s2')], { usage: { input: 0, output: 0, searches: 2 } });
    const spend = runningSpend(now, 16_000);
    for (const event of eventsOf(final).slice(0, -2)) spend.observe(event);
    expect(spend.searches()).toBe(2);
    expect(spend.costMicroUsd()).toBeGreaterThanOrEqual(2 * SEARCH_FEE);
  });
});
