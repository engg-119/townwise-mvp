// TownwiseAI's pricing, provider error codes, the cost of calls that never finished, the system prompt's rules and the
// history view of a stored conversation (docs/portal/tuning-chat.md sections 2, 4 and 5), without Docker.
import {
  AnthropicError, APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError,
  BadRequestError, InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError,
} from '@anthropic-ai/sdk';
import type {
  BetaContentBlock, BetaMessageParam, BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import { costMicroUsd, messageCostMicroUsd } from '../src/chat/pricing.ts';
import { SYSTEM_PROMPT } from '../src/chat/prompt.ts';
import { TOOLS, type ToolContext } from '../src/chat/tools/registry.ts';
import { echoable, failureCode, requestParams, runTurn, type TurnResult } from '../src/chat/turn.ts';
import { chatMessageViews } from '../src/chat/view.ts';
import { eventsOf, message, scriptedModel, text, thinking, toolUse, usage, type Step } from './helpers/chat-model.ts';

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

describe('pricing', () => {
  it('prices Claude Opus 5.5 at $4 and $20 per million tokens, cache reads at $0.20 and cache writes at 1.25 times input', () => {
    expect(costMicroUsd('claude-opus-5-5', tokens(1_000_000, 0))).toBe(4_000_000);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 1_000_000))).toBe(20_000_000);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 1_000_000))).toBe(200_000);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 0, 1_000_000))).toBe(5_000_000);
    expect(costMicroUsd('claude-opus-5-5', tokens(1000, 500, 10_000, 2000))).toBe(26_000);
  });

  it('rounds each call up to a whole micro-dollar, exactly', () => {
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 1))).toBe(1);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 5))).toBe(1);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 15))).toBe(3);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 16))).toBe(4);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 0, 0))).toBe(0);
  });

  it('prices the fallback models at their own rates, and any other or unknown model at the most expensive row', () => {
    for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-future-9', '']) {
      expect(costMicroUsd(model, tokens(1000, 500, 10_000, 2000))).toBe(5000 + 12_500 + 5000 + 12_500);
    }
  });

  it('prices a call by usage.iterations when the server ran more than one attempt, each by the model that ran it', () => {
    const fellBack = message([], {
      model: 'claude-opus-5',
      usage: {
        input: 1000, output: 200,
        iterations: [
          { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        ],
      },
    });
    expect(messageCostMicroUsd(fellBack)).toBe((1000 * 4 + 100 * 20) + (1000 * 5 + 200 * 25));
    expect(messageCostMicroUsd({ model: 'claude-opus-5-5', usage: usage({ input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 }) }))
      .toBe(26_000);
  });
});

describe('provider errors', () => {
  const body = (type: string) => ({ type: 'error', error: { type, message: 'no' } });
  const headers = new Headers();

  it('maps overloaded and rate limited to provider_overloaded, connection errors and 5xx to provider_unavailable, the rest to internal', () => {
    const cases: [unknown, string][] = [
      [new RateLimitError(429, body('rate_limit_error'), undefined, headers, 'rate_limit_error'), 'provider_overloaded'],
      [new InternalServerError(529, body('overloaded_error'), undefined, headers, 'overloaded_error'), 'provider_overloaded'],
      [new APIError(undefined, body('overloaded_error'), undefined, headers, 'overloaded_error'), 'provider_overloaded'],
      [new APIError(undefined, body('rate_limit_error'), undefined, headers, 'rate_limit_error'), 'provider_overloaded'],
      [new InternalServerError(500, body('api_error'), undefined, headers, 'api_error'), 'provider_unavailable'],
      [new InternalServerError(503, body('api_error'), undefined, headers, 'api_error'), 'provider_unavailable'],
      [new APIError(undefined, body('api_error'), undefined, headers, 'api_error'), 'provider_unavailable'],
      [new APIError(undefined, body('timeout_error'), undefined, headers, 'timeout_error'), 'provider_unavailable'],
      [new APIConnectionError({ message: 'Connection error.' }), 'provider_unavailable'],
      [new APIConnectionTimeoutError(), 'provider_unavailable'],
      [new BadRequestError(400, body('invalid_request_error'), undefined, headers, 'invalid_request_error'), 'internal'],
      [new AuthenticationError(401, body('authentication_error'), undefined, headers, 'authentication_error'), 'internal'],
      [new PermissionDeniedError(403, body('permission_error'), undefined, headers, 'permission_error'), 'internal'],
      [new NotFoundError(404, body('not_found_error'), undefined, headers, 'not_found_error'), 'internal'],
      [new APIUserAbortError(), 'internal'],
      [new AnthropicError('Unable to parse tool parameter JSON from model.'), 'internal'],
      [new TypeError('a bug'), 'internal'],
      ['a string', 'internal'],
    ];
    for (const [error, code] of cases) expect({ error: String(error), code: failureCode(error) }).toEqual({ error: String(error), code });
  });
});

describe('the request', () => {
  it('keeps one frozen prefix: the same system prompt and tools for every conversation, and no number in the prompt', () => {
    const one = requestParams([{ role: 'user', content: 'One' }]);
    const two = requestParams([{ role: 'user', content: 'Two' }, { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Three' }]);
    expect(JSON.stringify([one.system, one.tools])).toBe(JSON.stringify([two.system, two.tools]));
    expect(SYSTEM_PROMPT).not.toMatch(/\d/);
    expect(TOOLS.every((tool) => tool.eager_input_streaming === true)).toBe(true);
  });
});

describe('the system prompt', () => {
  it('names TownwiseAI, asks for a source for every figure, asks when data does not add up, and keeps guest names out', () => {
    for (const rule of [
      'You are TownwiseAI, Townwise\'s assistant.',
      'When you give a figure, say where it came from: their sales, their notes or public town data (the town profile, the town calendar or people in town).',
      'If something in the data doesn\'t add up, ask the owner instead of guessing.',
      'Never ask for, repeat or store guest names or other personal details about guests or staff.',
      'The owner sees the proposal as a card and decides whether to save it, so never say a note was saved.',
    ]) expect(SYSTEM_PROMPT).toContain(rule);
  });
});

describe('the system prompt, estimates (U13A)', () => {
  it('reads today in the town’s time zone, separates kinds of figures, says what is missing and never estimates on its own', () => {
    for (const rule of [
      'It gives the location\'s name, its town, today\'s date and weekday in the town\'s time zone, and how much sales history it has.',
      'Every date in tool results comes with its weekday; use it instead of working weekdays out yourself.',
      'get_town_calendar for the town\'s term dates, events and holidays with their sources, and get_people_in_town for who is likely in town each day',
      'Townwise\'s figures come in kinds. Say which kind each figure is: the owner\'s own history (get_sales_days, get_location_overview), public town data (get_town_profile, get_town_calendar, get_people_in_town), and, when it exists, Townwise\'s forecast.',
      'get_people_in_town gives a headcount range only where public counts support one. When it gives none, say so and describe what Townwise does know: the term, events, holidays and the season.',
      'Attendance at an event is not the number of extra people in town.',
      'When you say how the town affects this location, use the location\'s own history by term state from get_people_in_town, with its day counts.',
      'When an input is missing (no term dates for those days, no headcount, no sales for those days, or a town Townwise hasn\'t researched), say which input is missing instead of filling the gap.',
      'Never produce an estimate, range or headcount of your own.',
    ]) expect(SYSTEM_PROMPT).toContain(rule);
  });
});

describe('the system prompt, forecasts (U13B)', () => {
  it('reads the published forecast first, gives ranges never the middle alone, names the model and never makes one up', () => {
    for (const rule of [
      'Before discussing upcoming demand, call get_forecast. If it says no forecast is available, say Townwise has no forecast for those dates yet and answer from history and the town calendar. Never make up a forecast, a range or a headcount.',
      'Give a forecast as its range, low to high, and say that about eight in ten days land inside it. Never give the middle number alone. For a week, use the forecast\'s week rows; never add up daily ranges.',
      'A booked day in the forecast is a private buyout: it has no walk-in range, so don\'t give one.',
      'Say which model made the forecast and when, if the owner asks how it was made. Mention its accuracy, including misses, when the owner is deciding something with it.',
      'Only call a day busier or quieter than usual from the forecast when it gives vsBaselinePct; otherwise compare with the owner\'s history and say so.',
      'The forecast can\'t answer "what if" questions. Say so, and say what a note would let Townwise take into account.',
    ]) expect(SYSTEM_PROMPT).toContain(rule);
    expect(SYSTEM_PROMPT).not.toContain('Townwise has no forecast for this location yet.');
  });
});

describe('the system prompt, calibrations', () => {
  it('names the three tools and their rules', () => {
    for (const rule of [
      '- Call start_calibration only when an org admin asks to retrain or calibrate the forecast, and say it uses part of the monthly budget. If the owner describes a lasting change in their weekly pattern with a start date, pass that date as regimeStart.',
      '- After starting one, say it runs on Townwise’s servers and usually takes a few minutes; call get_calibration when they ask how it went. Never say a calibration is better or published unless get_calibration or compare_forecast_models says so, and give the reason it gives.',
      '- Calibration results come with charts and cards the app draws; describe what they show in a sentence or two instead of reading out every number.',
    ]) expect(SYSTEM_PROMPT).toContain(rule);
    expect(SYSTEM_PROMPT).toContain('compare_forecast_models');
    expect(SYSTEM_PROMPT).not.toMatch(/\d/);
  });
});

describe('the history view', () => {
  const at = new Date('2026-06-01T12:00:00.000Z');
  const later = new Date('2026-06-01T12:00:05.000Z');
  const stored = (params: BetaMessageParam[], when: Date[] = []) => params.map((param, i) => ({ at: when[i] ?? at, param: JSON.stringify(param) }));
  const result = (id: string, content: string, isError = false) => ({
    type: 'tool_result' as const, tool_use_id: id, content, ...(isError ? { is_error: true } : {}),
  });
  const note = {
    kind: 'closure', startDate: '2026-06-20', endDate: '2026-06-20', weekdays: null, effect: 'closed', expectedGuests: null,
    detail: null,
  } as const;

  it('folds a reply’s messages and tool results into one entry whose parts keep their order: text, tool, text, proposal', () => {
    const views = chatMessageViews(stored([
      { role: 'user', content: 'Were we closed?' },
      { role: 'assistant', content: [thinking('s1'), text('Let me '), text('look. '), toolUse('t1', 'list_notes', {})] },
      { role: 'user', content: [result('t1', JSON.stringify({ notes: [{}, {}] }))] },
      { role: 'assistant', content: [text('You have two notes.'), toolUse('p1', 'propose_note', note)] },
      { role: 'user', content: [result('p1', 'Shown to the owner as a proposal. They decide whether to add it.')] },
      { role: 'assistant', content: [text('I proposed it.')] },
      { role: 'user', content: 'Thanks' },
    ], [at, later, later, later, later, later, later]), '2026-06-01');
    expect(views).toEqual([
      { role: 'user', at: at.toISOString(), text: 'Were we closed?', proposals: [], parts: [] },
      {
        role: 'assistant', at: later.toISOString(), text: 'Let me look. \n\nYou have two notes.\n\nI proposed it.',
        proposals: [{ ...note, id: 'p1', status: 'open', noteId: null }],
        parts: [
          { type: 'text', text: 'Let me look. ' },
          { type: 'tool', id: 't1', name: 'list_notes', state: 'done', input: null, result: { count: 2 } },
          { type: 'text', text: 'You have two notes.' },
          { type: 'proposal', proposal: { ...note, id: 'p1', status: 'open', noteId: null } },
          { type: 'text', text: 'I proposed it.' },
        ],
      },
      { role: 'user', at: later.toISOString(), text: 'Thanks', proposals: [], parts: [] },
    ]);
  });

  it('leaves out calls that never ran and unknown tools, shows an error call as an error part, and an invalid proposal as one', () => {
    const [, reply] = chatMessageViews(stored([
      { role: 'user', content: 'Check' },
      { role: 'assistant', content: [
        toolUse('s1', 'get_sales_days', { from: '2026-05-01', to: '2026-12-31' }), toolUse('u1', 'get_weather', {}),
        toolUse('p2', 'propose_note', { ...note, endDate: '2026-06-19' }), toolUse('cap', 'list_notes', {}),
      ] },
      { role: 'user', content: [
        result('s1', 'Invalid input', true), result('u1', 'Unknown tool.', true), result('p2', 'Not a valid note', true),
        result('cap', 'Not run: the reply asked for too many tool calls at once.', true),
      ] },
      { role: 'assistant', content: [text('Cut off'), toolUse('m1', 'list_notes', {})] },
      { role: 'user', content: [result('m1', 'Not run: the reply stopped before this call could run.', true)] },
    ]), '2026-06-01');
    expect(reply?.parts).toEqual([
      { type: 'tool', id: 's1', name: 'get_sales_days', state: 'error', input: null, result: null },
      { type: 'tool', id: 'p2', name: 'propose_note', state: 'error', input: null, result: null },
      { type: 'text', text: 'Cut off' },
    ]);
    expect(reply?.proposals).toEqual([]);
  });

  it('says what became of each proposal through stateOf, by its call id', () => {
    const views = chatMessageViews(stored([
      { role: 'user', content: 'Two closures' },
      { role: 'assistant', content: [toolUse('p1', 'propose_note', note), toolUse('p2', 'propose_note', { ...note, startDate: '2026-06-21', endDate: '2026-06-21' })] },
      { role: 'user', content: [result('p1', 'Shown'), result('p2', 'Shown')] },
    ]), '2026-06-01', (proposal) => (proposal.id === 'p1' ? { status: 'saved', noteId: 'n1' } : { status: 'dismissed', noteId: null }));
    expect(views[1]?.proposals.map(({ id, status, noteId, startDate }) => ({ id, status, noteId, startDate }))).toEqual([
      { id: 'p1', status: 'saved', noteId: 'n1', startDate: '2026-06-20' },
      { id: 'p2', status: 'dismissed', noteId: null, startDate: '2026-06-21' },
    ]);
  });

  it('shows a reply of thinking only as nothing, and keeps a valid range’s input view', () => {
    const views = chatMessageViews(stored([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [thinking('s1')] },
      { role: 'user', content: 'May?' },
      { role: 'assistant', content: [toolUse('s2', 'get_sales_days', { from: '2026-05-01', to: '2026-05-31' })] },
      { role: 'user', content: [result('s2', JSON.stringify({ from: '2026-05-01', to: '2026-05-31', days: [{ date: '2026-05-01', guests: 3, netSalesUsd: null }] }))] },
    ]), '2026-06-01');
    expect(views.map((view) => view.role)).toEqual(['user', 'user', 'assistant']);
    expect(views[2]?.parts).toEqual([{
      type: 'tool', id: 's2', name: 'get_sales_days', state: 'done', input: { from: '2026-05-01', to: '2026-05-31' },
      result: { from: '2026-05-01', to: '2026-05-31', dayCount: 1, guestsDayCount: 1, netSalesDayCount: 0 },
    }]);
  });
});

describe('a mid-reply fallback', () => {
  const boundary = (from: string, to: string): BetaContentBlock => ({
    type: 'fallback', from: { model: from }, to: { model: to }, trigger: { type: 'refusal', category: 'cyber' },
  });

  it('echoes a reply without a fallback block unchanged', () => {
    const content = [thinking('s1'), text('Hi'), toolUse('t1', 'list_notes', {})];
    expect(echoable(content)).toEqual(content);
  });

  it('keeps only text before the last fallback block, drops the block, and keeps everything after it', () => {
    const content = [
      thinking('declined-1'), text('Partial '), toolUse('t-declined', 'list_notes', {}),
      boundary('claude-opus-5-5', 'claude-opus-5'),
      thinking('declined-2'), text('more '),
      boundary('claude-opus-5', 'claude-opus-4-8'),
      thinking('kept'), text('Final'), toolUse('t-kept', 'list_notes', {}),
    ];
    expect(echoable(content)).toEqual([
      text('Partial '), text('more '), thinking('kept'), text('Final'), toolUse('t-kept', 'list_notes', {}),
    ]);
  });
});

describe('a call that never finished', () => {
  // These calls make no tool call, so the turn never reads its tool context.
  const noTools = {} as unknown as ToolContext;

  /** The events of a reply up to, not including, message_delta: message_start reports 1000 input tokens. */
  function startedReply(value: string, model = 'claude-opus-5-5'): BetaRawMessageStreamEvent[] {
    const events = eventsOf(message([text(value)], { model, usage: { input: 1000, output: 900 } }));
    return events.slice(0, events.findIndex((event) => event.type === 'message_delta'));
  }

  /** Runs one turn of one call. On its first text delta the clock moves on `seconds`, and `abort` aborts the turn. */
  async function charged(step: Step, opts: { seconds?: number; abort?: boolean } = {}): Promise<{ result: TurnResult; costs: number[] }> {
    const model = scriptedModel();
    model.script(step);
    let clock = Date.parse('2026-06-01T12:00:00.000Z');
    const controller = new AbortController();
    let moved = false;
    const costs: number[] = [];
    const result = await runTurn({
      model, tools: noTools, history: [], userMessage: { role: 'user', content: 'Hello' }, signal: controller.signal,
      now: () => new Date(clock),
      emit: (event) => {
        if (event.type !== 'text' || moved) return;
        moved = true;
        clock += (opts.seconds ?? 0) * 1000;
        if (opts.abort === true) controller.abort();
      },
      charge: (cost) => {
        costs.push(cost);
        return Promise.resolve();
      },
      budgetSpent: () => Promise.resolve(false),
    });
    return { result, costs };
  }

  const connectionError = (): APIConnectionError => new APIConnectionError({ message: 'Connection error.' });

  it('a call that fails after message_start is charged ceil(streamed characters / 3) output tokens', async () => {
    // Three 7-character text deltas: 21 characters, 7 tokens, and no time passed.
    const before = startedReply('Partial reply here, then').slice(0, 5);
    expect(before.filter((event) => event.type === 'content_block_delta')).toHaveLength(3);
    const { result, costs } = await charged({ kind: 'error', error: connectionError(), before });
    expect(result).toMatchObject({ kind: 'failed', code: 'provider_unavailable' });
    expect(costs).toEqual([1000 * 4 + 7 * 20]);
  });

  it('an aborted call is charged ceil(seconds since message_start x 150) when that is more, up to max_tokens', async () => {
    const before = startedReply('A long answer that keeps going');
    const tenSeconds = await charged({ kind: 'hang', before }, { seconds: 10, abort: true });
    expect(tenSeconds.result).toMatchObject({ kind: 'aborted' });
    expect(tenSeconds.costs).toEqual([1000 * 4 + 1500 * 20]);
    const fractional = await charged({ kind: 'hang', before }, { seconds: 0.101, abort: true });
    expect(fractional.costs).toEqual([1000 * 4 + 16 * 20]);
    const long = await charged({ kind: 'hang', before }, { seconds: 200, abort: true });
    expect(long.costs).toEqual([1000 * 4 + 16_000 * 20]);
  });

  it('prices the estimate at the answering model’s output price, and a call past message_delta at its reported usage', async () => {
    const fallback = await charged({ kind: 'error', error: connectionError(), before: startedReply('Partial reply here, then', 'claude-opus-5').slice(0, 5) });
    expect(fallback.costs).toEqual([1000 * 5 + 7 * 25]);
    const events = eventsOf(message([text('Whole')], { usage: { input: 1000, output: 900 } }));
    const reported = await charged({ kind: 'error', error: connectionError(), before: events.slice(0, -1) }, { seconds: 10 });
    expect(reported.costs).toEqual([1000 * 4 + 900 * 20]);
  });
});
