// One research thread's calls (D66 design decisions 4 to 6, task 1.6), against the scripted model: the requests'
// shape, paused gathers resent unchanged at most twice and only while the reservation holds the extract, refusals,
// the fetch fallback, the time limits, the caller's abort, and the cost of every message, a thrown stream's searches
// included. Synthetic pages and hosts only.
import { BadRequestError, InternalServerError, RateLimitError } from '@anthropic-ai/sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import { messageCostMicroUsd } from '../src/chat/pricing.ts';
import { createThreadTally, RESEARCH_REQUEST_MS, RESEARCH_THREAD_MS, runThread, type FetchSwitch, type RunThreadInput, type ThreadOutcome } from '../src/research/call.ts';
import type { GatherInput, PromptTown } from '../src/research/prompt.ts';
import { researchWindow, threadsFor, type ThreadDef } from '../src/research/threads.ts';
import { EXTRACT_FORMAT } from '../src/research/verify.ts';
import { citedQuotes, eventsOf, message, messagesOf, pause, scriptedModel, text, webResults, webSearch, type ScriptedModel } from './helpers/chat-model.ts';

const NOW = new Date('2026-11-19T15:00:00Z');
const TOWN: PromptTown = { name: 'Hanover', state: 'NH', timeZone: 'America/New_York' };
const WINDOW = researchWindow(NOW, TOWN.timeZone);
const A = 'https://calendar.sentinel-college.example.org/winter';
const B = 'https://www.sentinel-town.example.gov/events';
const QUOTE = 'Winter Carnival runs February 12, 2027 on the Green';
const BIG = 50_000_000;

function thread(subject: 'town' | 'location'): ThreadDef {
  const [first] = subject === 'town'
    ? threadsFor({ kind: 'town', townId: 'hanover-nh' }, { placesToAi: false })
    : threadsFor({ kind: 'location', townId: 'hanover-nh' }, { placesToAi: false });
  if (first === undefined) throw new Error('no thread');
  return first;
}

function gatherInput(subject: 'town' | 'location' = 'town'): GatherInput {
  return {
    thread: thread(subject), town: TOWN, today: WINDOW.from, window: WINDOW, known: [], seeds: [],
    restaurant: subject === 'location' ? { typed: true, name: 'Sentinel Diner' } : null, competitors: null,
  };
}

function run(model: ScriptedModel, over: Partial<RunThreadInput> = {}): Promise<ThreadOutcome> {
  return runThread({
    model, gather: gatherInput(), reservedMicroUsd: BIG, fetch: { on: false }, signal: new AbortController().signal, now: () => NOW,
    ...over,
  });
}

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Winter Carnival', kind: 'event', category: 'festival', startDate: '2027-02-12', endDate: '2027-02-14', weekdays: null,
    startTime: null, status: 'scheduled', venueRef: null, hostRef: null, competitor: null, sourceIds: ['S1'],
    dateQuote: 'February 12, 2027', confidence: 'high', ...over,
  };
}

function answer(events: Record<string, unknown>[] = [event()]): BetaMessage {
  return message([text(JSON.stringify({ events, entities: [] }))], { usage: { input: 900, output: 300 } });
}

/** A finished gather: one search with two pages, and a finding citing the first. */
function gathered(): BetaMessage {
  return message([
    webSearch('s1'), webResults('s1', [A, B]), citedQuotes('EVENT: Winter Carnival, February 12 to 14, 2027.', [{ url: A, quote: QUOTE }]),
  ], { usage: { input: 4_000, output: 600, searches: 1 } });
}

function recorded(outcome: ThreadOutcome): Extract<ThreadOutcome, { kind: 'recorded' }> {
  if (outcome.kind !== 'recorded') throw new Error(`not recorded: ${JSON.stringify(outcome.kind)}`);
  return outcome;
}

const badRequest = (detail: string): BadRequestError => new BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: detail } }, undefined, new Headers());

describe('research calls: requests', () => {
  it('gathers with direct web search from the town, the cached system prompt and no output format, then extracts with no tools', async () => {
    const model = scriptedModel();
    model.script({ kind: 'message', message: gathered() }, { kind: 'message', message: answer() });
    recorded(await run(model));
    const [gather, extract] = model.calls.map((call) => call.params);
    expect(gather?.tools).toEqual([{
      type: 'web_search_20260209', name: 'web_search', max_uses: 8, allowed_callers: ['direct'],
      user_location: { type: 'approximate', city: 'Hanover', region: 'NH', country: 'US', timezone: 'America/New_York' },
    }]);
    expect(gather?.output_config).toEqual({ effort: 'low' });
    expect(gather?.max_tokens).toBe(16_000);
    expect(gather?.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(gather?.fallbacks).toBe('default');
    expect(Array.isArray(gather?.system) ? gather.system[0]?.cache_control : null).toEqual({ type: 'ephemeral' });
    expect(gather?.messages).toHaveLength(1);
    expect(extract?.tools).toBeUndefined();
    expect(extract?.output_config).toEqual({ effort: 'low', format: EXTRACT_FORMAT });
    expect(extract?.max_tokens).toBe(12_000);
  });

  it('allows a location thread 5 searches, and sends the fetch tool only while fetch is on', async () => {
    const model = scriptedModel();
    model.script({ kind: 'message', message: gathered() }, { kind: 'message', message: answer() });
    recorded(await run(model, { gather: gatherInput('location'), fetch: { on: true } }));
    const tools = model.calls[0]?.params.tools ?? [];
    expect(tools.map((tool) => ('name' in tool ? tool.name : null))).toEqual(['web_search', 'web_fetch']);
    expect(tools[0]).toMatchObject({ max_uses: 5 });
    expect(tools[1]).toEqual({
      type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2, allowed_callers: ['direct'], max_content_tokens: 8_000, citations: { enabled: true },
    });
  });

  it('stores the ledger\'s URL for the id the extract cites: the model never types one', async () => {
    const model = scriptedModel();
    model.script({ kind: 'message', message: gathered() }, { kind: 'message', message: answer([event({ sourceIds: ['S2', 'S1'] })]) });
    const outcome = recorded(await run(model));
    expect(outcome.verified.events[0]?.sources.map((source) => source.url)).toEqual([B, A]);
    expect(outcome.sources).toBe(2);
    expect(JSON.stringify(model.calls[1]?.params.messages)).not.toContain(A);
  });
});

describe('research calls: paused gathers', () => {
  const first = (): BetaMessage => pause([webSearch('s1'), webResults('s1', [A])], { usage: { input: 2_000, output: 100, searches: 1 } });
  const second = (): BetaMessage => pause([webSearch('s2'), webResults('s2', [B])], { usage: { input: 3_000, output: 100, searches: 1 } });

  it('resends each paused message unchanged, and the ledger holds every message\'s sources', async () => {
    const model = scriptedModel();
    const one = first();
    const two = second();
    model.script(
      { kind: 'message', message: one }, { kind: 'message', message: two },
      { kind: 'message', message: message([citedQuotes('EVENT: Winter Carnival.', [{ url: A, quote: QUOTE }])]) },
      { kind: 'message', message: answer([event({ sourceIds: ['S2'], dateQuote: 'February 12, 2027' }), event({ title: 'Ice show', sourceIds: ['S1'] })]) },
    );
    const outcome = recorded(await run(model));
    expect(model.calls).toHaveLength(4);
    expect(messagesOf(model.calls[1]).slice(1)).toEqual([{ role: 'assistant', content: one.content }]);
    expect(messagesOf(model.calls[2]).slice(1)).toEqual([{ role: 'assistant', content: one.content }, { role: 'assistant', content: two.content }]);
    expect(outcome.continuations).toBe(2);
    expect(outcome.sources).toBe(2);
    expect(outcome.messages).toHaveLength(3);
    expect(outcome.searches).toBe(2);
  });

  it('continues at most twice, then extracts what the paused messages gathered', async () => {
    const model = scriptedModel();
    model.script(
      { kind: 'message', message: first() }, { kind: 'message', message: second() },
      { kind: 'message', message: pause([citedQuotes('EVENT: Winter Carnival.', [{ url: A, quote: QUOTE }])]) },
      { kind: 'message', message: answer() },
    );
    const outcome = recorded(await run(model));
    expect(model.calls).toHaveLength(4);
    expect(model.calls[3]?.params.output_config?.format).toEqual(EXTRACT_FORMAT);
    expect(outcome.continuations).toBe(2);
    expect(outcome.verified.events).toHaveLength(1);
  });

  it('stops continuing once the reservation left would not hold the extract\'s ceiling', async () => {
    const model = scriptedModel();
    model.script(
      { kind: 'message', message: pause([webSearch('s1'), webResults('s1', [A]), citedQuotes('EVENT: Winter Carnival.', [{ url: A, quote: QUOTE }])]) },
      { kind: 'message', message: answer() },
    );
    // The extract's ceiling (its 12,000 output tokens alone are $0.30) does not fit in what is left of $0.30.
    const outcome = recorded(await run(model, { reservedMicroUsd: 300_000 }));
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.params.output_config?.format).toEqual(EXTRACT_FORMAT);
    expect(outcome.continuations).toBe(0);
  });

  it('counts what the gather already spent against the reservation', async () => {
    const model = scriptedModel();
    // 100,000 input tokens at $4 a million: $0.40 spent, leaving $0.30 of $0.70, under the extract's ceiling.
    model.script(
      { kind: 'message', message: pause([webSearch('s1'), webResults('s1', [A]), citedQuotes('EVENT: Winter Carnival.', [{ url: A, quote: QUOTE }])], { usage: { input: 100_000, output: 0, searches: 1 } }) },
      { kind: 'message', message: answer() },
    );
    const outcome = recorded(await run(model, { reservedMicroUsd: 700_000 }));
    expect(model.calls).toHaveLength(2);
    expect(outcome.continuations).toBe(0);
  });

  it('extracts what a gather cut at max_tokens holds', async () => {
    const model = scriptedModel();
    model.script(
      { kind: 'message', message: message([webSearch('s1'), webResults('s1', [A]), citedQuotes('EVENT: Winter Carnival.', [{ url: A, quote: QUOTE }])], { stopReason: 'max_tokens' }) },
      { kind: 'message', message: answer() },
    );
    expect(recorded(await run(model)).verified.events).toHaveLength(1);
  });
});

describe('research calls: failures', () => {
  it('fails a request the API refuses at once, not to be retried', async () => {
    const model = scriptedModel();
    model.script({ kind: 'error', error: badRequest('messages: invalid') });
    const outcome = await run(model);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'request_refused', retry: false });
    expect(model.calls).toHaveLength(1);
  });

  it('retries an overloaded or unavailable API on the next attempt', async () => {
    const model = scriptedModel();
    model.script({ kind: 'error', error: new RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, undefined, new Headers(), 'rate_limit_error') });
    expect(await run(model)).toMatchObject({ kind: 'failed', code: 'provider_overloaded', retry: true });
  });

  it('a model refusal fails the thread, gather or extract', async () => {
    const refusing = scriptedModel();
    refusing.script({ kind: 'message', message: message([], { stopReason: 'refusal' }) });
    expect(await run(refusing)).toMatchObject({ kind: 'failed', code: 'refusal', retry: false });
    const late = scriptedModel();
    late.script({ kind: 'message', message: gathered() }, { kind: 'message', message: message([], { stopReason: 'refusal' }) });
    expect(await run(late)).toMatchObject({ kind: 'failed', code: 'refusal', retry: false });
  });

  it('fails an extract that is not the schema\'s JSON, or was cut at max_tokens, as a bad answer', async () => {
    const notJson = scriptedModel();
    notJson.script({ kind: 'message', message: gathered() }, { kind: 'message', message: message([text('not json')]) });
    expect(await run(notJson)).toMatchObject({ kind: 'failed', code: 'bad_answer', retry: true });
    const cut = scriptedModel();
    cut.script({ kind: 'message', message: gathered() }, { kind: 'message', message: message([text('{"events": [')], { stopReason: 'max_tokens' }) });
    expect(await run(cut)).toMatchObject({ kind: 'failed', code: 'bad_answer', retry: true });
  });

  it('a gather that returned no page ends empty without an extract', async () => {
    const model = scriptedModel();
    model.script({ kind: 'message', message: message([text('Nothing found.')]) });
    expect(await run(model)).toMatchObject({ kind: 'empty', code: 'no_sources' });
    expect(model.calls).toHaveLength(1);
  });
});

describe('research calls: the fetch fallback', () => {
  it('while fetch is on, retries a request refused for naming web fetch once without it, and turns fetch off for the process', async () => {
    const fetch: FetchSwitch = { on: true };
    let offs = 0;
    const model = scriptedModel();
    model.script(
      { kind: 'error', error: badRequest('tools.1: web_fetch is not enabled for this organization') },
      { kind: 'message', message: gathered() }, { kind: 'message', message: answer() },
    );
    recorded(await run(model, { fetch, onFetchOff: () => { offs += 1; } }));
    const names = (index: number): unknown[] => (model.calls[index]?.params.tools ?? []).map((tool) => ('name' in tool ? tool.name : null));
    expect(names(0)).toEqual(['web_search', 'web_fetch']);
    expect(names(1)).toEqual(['web_search']);
    expect(fetch.on).toBe(false);
    expect(offs).toBe(1);

    // The next thread of the process sends no fetch tool.
    const next = scriptedModel();
    next.script({ kind: 'message', message: gathered() }, { kind: 'message', message: answer() });
    recorded(await run(next, { fetch, onFetchOff: () => { offs += 1; } }));
    expect((next.calls[0]?.params.tools ?? []).map((tool) => ('name' in tool ? tool.name : null))).toEqual(['web_search']);
    expect(offs).toBe(1);
  });

  it('a thread fixes its tools at its start: another thread turning fetch off never drops the tool from its continuation', async () => {
    const fetch: FetchSwitch = { on: true };
    const scripted = scriptedModel();
    scripted.script(
      { kind: 'message', message: pause([webSearch('s1'), webResults('s1', [A])], { usage: { searches: 1 } }) },
      { kind: 'message', message: gathered() }, { kind: 'message', message: answer() },
    );
    // Another thread of the process turns fetch off while this one's first request runs.
    const model: ScriptedModel = { ...scripted, stream: (params, options) => { const stream = scripted.stream(params, options); fetch.on = false; return stream; } };
    recorded(await run(model, { fetch }));
    const names = (index: number): unknown[] => (scripted.calls[index]?.params.tools ?? []).map((tool) => ('name' in tool ? tool.name : null));
    expect(names(0)).toEqual(['web_search', 'web_fetch']);
    expect(names(1)).toEqual(['web_search', 'web_fetch']);
  });

  it('a thread refused after another already turned fetch off retries without it and logs nothing more', async () => {
    const fetch: FetchSwitch = { on: true };
    let offs = 0;
    const scripted = scriptedModel();
    scripted.script(
      { kind: 'error', error: badRequest('web_fetch is not enabled') }, { kind: 'message', message: gathered() }, { kind: 'message', message: answer() },
    );
    const model: ScriptedModel = { ...scripted, stream: (params, options) => { const stream = scripted.stream(params, options); fetch.on = false; return stream; } };
    recorded(await run(model, { fetch, onFetchOff: () => { offs += 1; } }));
    expect(scripted.calls).toHaveLength(3);
    expect(offs).toBe(0);
  });

  it('retries only once', async () => {
    const model = scriptedModel();
    model.script({ kind: 'error', error: badRequest('web_fetch is not enabled') }, { kind: 'error', error: badRequest('web fetch: still no') });
    expect(await run(model, { fetch: { on: true } })).toMatchObject({ kind: 'failed', code: 'request_refused' });
    expect(model.calls).toHaveLength(2);
  });

  it('while fetch is off, a refusal naming web fetch is an ordinary refusal', async () => {
    const model = scriptedModel();
    model.script({ kind: 'error', error: badRequest('web_fetch is not enabled') });
    expect(await run(model, { fetch: { on: false } })).toMatchObject({ kind: 'failed', code: 'request_refused' });
    expect(model.calls).toHaveLength(1);
  });
});

describe('research calls: time limits and aborts', () => {
  it('limits a request to 150 seconds and a thread to 360 by default', () => {
    expect(RESEARCH_REQUEST_MS).toBe(150_000);
    expect(RESEARCH_THREAD_MS).toBe(360_000);
  });

  it('a request past its time limit fails the thread as a timeout, to be retried', async () => {
    const model = scriptedModel();
    model.script({ kind: 'hang', before: [] });
    expect(await run(model, { limits: { requestMs: 20, threadMs: 10_000 } })).toMatchObject({ kind: 'failed', code: 'timeout', retry: true });
  });

  it('a thread past its time limit fails the same way, the extract included', async () => {
    const model = scriptedModel();
    model.script({ kind: 'message', message: gathered() }, { kind: 'hang', before: [] });
    expect(await run(model, { limits: { requestMs: 10_000, threadMs: 150 } })).toMatchObject({ kind: 'failed', code: 'timeout', retry: true });
  });

  it('the caller\'s abort answers aborted, with what the stream had spent visible to the heartbeat first', async () => {
    const model = scriptedModel();
    const started = eventsOf(message([webSearch('s1')], { usage: { input: 2_000, searches: 1 } })).slice(0, 4);
    model.script({ kind: 'hang', before: started });
    const controller = new AbortController();
    const tally = createThreadTally(() => NOW);
    let seen = { searches: 0, cost: 0 };
    setTimeout(() => {
      seen = { searches: tally.searches(), cost: tally.costMicroUsd() };
      controller.abort();
    }, 30);
    const outcome = await run(model, { signal: controller.signal, tally });
    expect(outcome.kind).toBe('aborted');
    expect(seen.searches).toBe(1);
    expect(seen.cost).toBeGreaterThanOrEqual(10_000);
    expect(outcome.costMicroUsd).toBe(tally.costMicroUsd());
  });
});

describe('research calls: cost', () => {
  it('charges every message: the gather\'s and the extract\'s', async () => {
    const model = scriptedModel();
    const gather = gathered();
    const extract = answer();
    model.script({ kind: 'message', message: gather }, { kind: 'message', message: extract });
    const tally = createThreadTally(() => NOW);
    const outcome = recorded(await run(model, { tally }));
    expect(outcome.costMicroUsd).toBe(messageCostMicroUsd(gather) + messageCostMicroUsd(extract));
    expect(outcome.searches).toBe(1);
    expect(tally.costMicroUsd()).toBe(outcome.costMicroUsd);
  });

  it('charges the searches a stream started before it threw', async () => {
    const model = scriptedModel();
    const before = eventsOf(message([webSearch('s1'), webResults('s1', [A]), webSearch('s2'), webResults('s2', [B])], { usage: { searches: 2 } })).slice(0, -2);
    model.script({ kind: 'error', error: new InternalServerError(500, { type: 'error', error: { type: 'api_error', message: 'down' } }, undefined, new Headers(), 'api_error'), before });
    const outcome = await run(model);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'provider_unavailable', retry: true, searches: 2 });
    expect(outcome.costMicroUsd).toBeGreaterThanOrEqual(20_000);
  });
});
