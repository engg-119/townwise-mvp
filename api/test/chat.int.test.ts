// The tuning chat (docs/portal/tuning-chat.md sections 1 to 5) against a scripted model (helpers/chat-model.ts): the
// GET shapes, author-only and per-location access, view-as, the event stream for answers, tool loops, proposals,
// the call limit, refusals, cut-off replies and provider errors, disconnects, the live-turn claim, the caps, the
// budget and cost, byte-for-byte replay of thinking blocks, and audit events and logs free of message text.
import { randomUUID } from 'node:crypto';

import {
  AnthropicError, APIConnectionError, APIConnectionTimeoutError, APIError, AuthenticationError, BadRequestError,
  InternalServerError, RateLimitError,
} from '@anthropic-ai/sdk';
import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SYSTEM_PROMPT, TOOLS } from '../src/chat/prompt.ts';
import type { ChatSummary, ConversationView } from '../src/handlers/chat.ts';
import {
  addConversation, addGrant, addLocation, addNote, addSalesDay, addSeat, auditEvents, createOrg,
} from './helpers/fixtures.ts';
import {
  eventsOf, message, messagesOf, scriptedModel, text, thinking, toolUse, type ScriptedModel,
} from './helpers/chat-model.ts';
import {
  call, limiterKey, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let model: ScriptedModel;

interface Person { session: TestSession; email: string }
let orgId: string;
let locationId: string;
let otherLocationId: string;
let admin: Person;
let author: Person;
let colleague: Person;

async function person(name: string, role: 'org_admin' | 'member'): Promise<Person> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return { session, email };
}

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model });
  orgId = await createOrg(server, { name: 'Chat Tavern' });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
  otherLocationId = await addLocation(server, { orgId, name: 'Patio' });
  admin = await person('admin', 'org_admin');
  author = await person('author', 'member');
  colleague = await person('colleague', 'member');
  await addSalesDay(server, { orgId, locationId, date: '2026-05-01', guests: 140, netSalesCents: 512_345 });
  await addSalesDay(server, { orgId, locationId, date: '2026-05-02', guests: 90, netSalesCents: null });
  await addNote(server, { orgId, locationId, detail: 'Closed for the floor refinish', startDate: '2026-05-10' });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.connection.collection('tw_chat_usage').deleteMany({});
  model.calls.length = 0;
});
afterEach(() => {
  // Every scripted step was used: no test leaves a model call unanswered or makes one it did not expect.
  expect(model.remaining()).toBe(0);
});

interface SseEvent { event: string; data: unknown }

function parseSse(body: string): SseEvent[] {
  return body.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return event === undefined || data === undefined ? [] : [{ event, data: JSON.parse(data) as unknown }];
  });
}

function turnsPath(location = locationId): string {
  return `/api/org/locations/${location}/chat/turns`;
}

/** A turn that finishes: its events, or its JSON error. */
async function turn(json: unknown, who = author, location = locationId): Promise<{ status: number; events: SseEvent[]; error?: string }> {
  const res = await call(server, turnsPath(location), { session: who.session, json });
  if (res.status !== 200) return { status: res.status, events: [], error: (await res.json() as { error: string }).error };
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-accel-buffering')).toBe('no');
  return { status: 200, events: parseSse(await res.text()) };
}

/** The event names in order, with the consecutive `text` events folded into one. */
function shape(events: SseEvent[]): string[] {
  return events.map((e) => e.event).filter((name, i, all) => name !== 'text' || all[i - 1] !== 'text');
}

function streamedText(events: SseEvent[]): string {
  return events.filter((e) => e.event === 'text').map((e) => (e.data as { delta: string }).delta).join('');
}

function eventData(events: SseEvent[], name: string): unknown[] {
  return events.filter((e) => e.event === name).map((e) => e.data);
}

function conversationIdOf(events: SseEvent[]): string {
  return (events[0]?.data as { id: string }).id;
}

async function conversationDoc(id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_chat_conversations').findOne({ _id: new Types.ObjectId(id) });
}

async function storedParams(id: string): Promise<BetaMessageParam[]> {
  const doc = await conversationDoc(id);
  return (doc?.messages as { param: string }[]).map((m) => JSON.parse(m.param) as BetaMessageParam);
}

async function usedMicroUsd(): Promise<number> {
  const doc = await server.connection.collection('tw_chat_usage').findOne({ orgId: new Types.ObjectId(orgId), month: '2026-06' });
  return (doc?.costMicroUsd as number | undefined) ?? 0;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function toolResults(param: BetaMessageParam | undefined): BetaToolResultBlockParam[] {
  if (param === undefined || param.role === 'system' || typeof param.content === 'string') return [];
  return param.content.filter((block): block is BetaToolResultBlockParam => block.type === 'tool_result');
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error('condition not reached');
}

const PROPOSAL = {
  kind: 'private_event', startDate: '2026-06-20', endDate: '2026-06-20', weekdays: null, effect: 'more_guests',
  expectedGuests: 120, detail: 'Rehearsal dinner for the Okafor wedding',
};

describe('a plain answer', () => {
  it('streams conversation, text and done; saves the turn; and sends the frozen request', async () => {
    model.script({ kind: 'message', message: message([thinking('sig-plain'), text('May was steady, with two busy Fridays.')], {
      usage: { input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 },
    }) });
    const { status, events } = await turn({ content: '  What changed in May?  ' });
    expect(status).toBe(200);
    expect(shape(events)).toEqual(['conversation', 'text', 'done']);
    const id = conversationIdOf(events);
    expect(events[0]?.data).toEqual({ id, title: 'What changed in May?' });
    expect(streamedText(events)).toBe('May was steady, with two busy Fridays.');
    // 1000 x $4 + 500 x $20 + 10,000 x $0.20 + 2000 x $5 per million tokens.
    expect(events.at(-1)?.data).toEqual({ stopReason: 'end_turn', costUsd: 0.026 });
    expect(await usedMicroUsd()).toBe(26_000);

    const params = model.calls[0]?.params;
    expect(params).toMatchObject({
      model: 'claude-opus-5-5', max_tokens: 16_000, output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', cache_control: { type: 'ephemeral' },
      system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'What changed in May?' }],
    });
    expect(params).not.toHaveProperty('thinking');
    expect(params?.tools?.map((tool) => ('name' in tool ? tool.name : null))).toEqual([
      'get_location_overview', 'get_sales_days', 'list_notes', 'get_town_profile', 'propose_note',
    ]);
    expect(params?.tools?.every((tool) => 'eager_input_streaming' in tool && tool.eager_input_streaming === true)).toBe(true);

    const doc = await conversationDoc(id);
    expect(doc).toMatchObject({ title: 'What changed in May?', turnCount: 1, liveTurn: null, userId: author.session.userId });
    expect(await storedParams(id)).toEqual([
      { role: 'user', content: 'What changed in May?' },
      { role: 'assistant', content: [thinking('sig-plain'), text('May was steady, with two busy Fridays.')] },
    ]);

    const list = await (await call(server, `/api/org/locations/${locationId}/chat`, { session: author.session })).json() as ChatSummary;
    expect(list.enabled).toBe(true);
    expect(list.budget).toEqual({ month: '2026-06', usedUsd: 0.03, limitUsd: 20, exhausted: false });
    expect(list.conversations[0]).toEqual({ id, title: 'What changed in May?', updatedAt: server.clock.now().toISOString(), turnCount: 1 });

    const view = await (await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: author.session })).json() as ConversationView;
    const at = server.clock.now().toISOString();
    expect(view).toEqual({
      id, title: 'What changed in May?', updatedAt: at,
      messages: [
        { role: 'user', text: 'What changed in May?', proposals: [], at },
        { role: 'assistant', text: 'May was steady, with two busy Fridays.', proposals: [], at },
      ],
    });
  });

  it('a title keeps the first 60 characters of the first message', async () => {
    model.script({ kind: 'message', message: message([text('Noted.')]) });
    const content = `${'a'.repeat(59)}bc and more`;
    const { events } = await turn({ content });
    expect((events[0]?.data as { title: string }).title).toBe(`${'a'.repeat(59)}b`);
  });
});

describe('history', () => {
  it('stores thinking blocks and every other block exactly as received, and sends them back unchanged on the next turn', async () => {
    const first = message([
      thinking('sig-1/opaque+bytes=='), { type: 'redacted_thinking', data: 'redacted-opaque-data' },
      toolUse('toolu_hist', 'list_notes', {}),
    ]);
    const second = message([thinking('sig-2'), text('You have one note.')]);
    model.script({ kind: 'message', message: first }, { kind: 'message', message: second });
    const one = await turn({ content: 'What notes do I have?' });
    expect(shape(one.events)).toEqual(['conversation', 'tool', 'tool', 'text', 'done']);
    const id = conversationIdOf(one.events);

    model.script({ kind: 'message', message: message([text('Anything else?')]) });
    const two = await turn({ conversationId: id, content: 'Thanks' });
    expect(shape(two.events)).toEqual(['conversation', 'text', 'done']);
    expect(two.events[0]?.data).toEqual({ id, title: 'What notes do I have?' });

    const sent = messagesOf(model.calls[2]);
    expect(sent).toHaveLength(5);
    expect(JSON.stringify(sent[1])).toBe(JSON.stringify({ role: 'assistant', content: first.content }));
    expect(JSON.stringify(sent[3])).toBe(JSON.stringify({ role: 'assistant', content: second.content }));
    expect(sent[4]).toEqual({ role: 'user', content: 'Thanks' });
    // What was stored is what was sent: every earlier message, byte for byte.
    const stored = (await conversationDoc(id))?.messages as { param: string }[];
    expect(stored.slice(0, 4).map((m) => m.param)).toEqual(sent.slice(0, 4).map((m) => JSON.stringify(m)));
    expect(stored).toHaveLength(6);
    expect((await conversationDoc(id))?.turnCount).toBe(2);
  });
});

describe('tools', () => {
  it('runs a tool loop: tool events around each call, results as data in the next request, the location only in the results', async () => {
    model.script(
      { kind: 'message', message: message([
        thinking('sig-tools'),
        toolUse('t1', 'get_location_overview', {}),
        toolUse('t2', 'get_sales_days', { from: '2026-05-01', to: '2026-05-31' }),
        toolUse('t3', 'list_notes', {}),
        toolUse('t4', 'get_town_profile', {}),
        toolUse('t5', 'get_sales_days', { from: '2026-01-01', to: '2026-04-03' }),
      ]) },
      { kind: 'message', message: message([text('Taproom had 230 guests over two days.')]) },
    );
    const { events } = await turn({ content: 'How did the Taproom do?' });
    expect(shape(events)).toEqual(['conversation', ...Array<string>(10).fill('tool'), 'text', 'done']);
    expect(eventData(events, 'tool')).toEqual([
      { name: 'get_location_overview', state: 'running' }, { name: 'get_location_overview', state: 'done' },
      { name: 'get_sales_days', state: 'running' }, { name: 'get_sales_days', state: 'done' },
      { name: 'list_notes', state: 'running' }, { name: 'list_notes', state: 'done' },
      { name: 'get_town_profile', state: 'running' }, { name: 'get_town_profile', state: 'done' },
      { name: 'get_sales_days', state: 'running' }, { name: 'get_sales_days', state: 'error' },
    ]);

    const sent = messagesOf(model.calls[1]);
    const results = toolResults(sent[2]);
    expect(results.map((r) => [r.tool_use_id, r.is_error === true])).toEqual([
      ['t1', false], ['t2', false], ['t3', false], ['t4', false], ['t5', true],
    ]);
    const content = (i: number): unknown => JSON.parse(results[i]?.content as string);
    expect(content(0)).toEqual({
      location: { name: 'Taproom', town: { name: 'Hanover', state: 'NH' } },
      today: '2026-06-01',
      coverage: { firstDate: '2026-05-01', lastDate: '2026-05-02', dayCount: 2, guestsDayCount: 2, netSalesDayCount: 1, missingDays: 0 },
      calibration: 'not_calibrated',
      townProfile: true,
      months: [{ month: '2026-05', days: 2, guests: 230, netSalesUsd: 5123.45 }],
    });
    expect(content(1)).toEqual({
      from: '2026-05-01', to: '2026-05-31',
      days: [{ date: '2026-05-01', guests: 140, netSalesUsd: 5123.45 }, { date: '2026-05-02', guests: 90, netSalesUsd: null }],
    });
    expect(content(2)).toEqual({ notes: [{
      kind: 'closure', startDate: '2026-05-10', endDate: '2026-05-10', weekdays: null, effect: 'closed', expectedGuests: null,
      detail: 'Closed for the floor refinish',
    }] });
    expect(content(3)).toMatchObject({ profile: { townId: 'hanover-nh', name: 'Hanover', county: expect.any(String) as unknown } });

    // The frozen prefix holds no name, id or date.
    const system = JSON.stringify(model.calls[1]?.params.system);
    for (const value of ['Taproom', 'Hanover', 'Chat Tavern', orgId, locationId, '2026']) expect(system).not.toContain(value);
    expect(JSON.stringify(model.calls[0]?.params.tools)).toBe(JSON.stringify(TOOLS));
  });

  it('a valid propose_note streams a proposal, writes no note, and the proposal posts unchanged to the notes route', async () => {
    const notesBefore = await server.connection.collection('tw_notes').countDocuments({});
    model.script(
      { kind: 'message', message: message([toolUse('p1', 'propose_note', { ...PROPOSAL, weekdays: [6, 5] })]) },
      { kind: 'message', message: message([text('I proposed the dinner as a note.')]) },
    );
    const { events } = await turn({ content: 'We have a rehearsal dinner on June 20.' });
    expect(shape(events)).toEqual(['conversation', 'tool', 'proposal', 'tool', 'text', 'done']);
    const proposal = { ...PROPOSAL, weekdays: [5, 6] };
    expect(eventData(events, 'proposal')).toEqual([{ proposal }]);
    expect(eventData(events, 'tool')).toEqual([{ name: 'propose_note', state: 'running' }, { name: 'propose_note', state: 'done' }]);
    expect(toolResults(messagesOf(model.calls[1])[2])).toEqual([{
      type: 'tool_result', tool_use_id: 'p1', content: 'Shown to the owner as a proposal. They decide whether to add it.',
    }]);
    expect(await server.connection.collection('tw_notes').countDocuments({})).toBe(notesBefore);

    const id = conversationIdOf(events);
    const view = await (await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: author.session })).json() as ConversationView;
    expect(view.messages.map((m) => [m.role, m.text, m.proposals])).toEqual([
      ['user', 'We have a rehearsal dinner on June 20.', []],
      ['assistant', '', [proposal]],
      ['assistant', 'I proposed the dinner as a note.', []],
    ]);

    const added = await call(server, `/api/org/locations/${locationId}/notes`, { session: author.session, json: proposal });
    expect(added.status).toBe(201);
    expect((await added.json() as { note: unknown }).note).toMatchObject(proposal);
  });

  it('an invalid propose_note is an is_error result: a tool error event, no proposal, nothing shown later', async () => {
    model.script(
      { kind: 'message', message: message([toolUse('p2', 'propose_note', { ...PROPOSAL, endDate: '2026-06-19' })]) },
      { kind: 'message', message: message([text('That date range was wrong.')]) },
    );
    const { events } = await turn({ content: 'Add the dinner.' });
    expect(shape(events)).toEqual(['conversation', 'tool', 'tool', 'text', 'done']);
    expect(eventData(events, 'tool')).toEqual([{ name: 'propose_note', state: 'running' }, { name: 'propose_note', state: 'error' }]);
    expect(toolResults(messagesOf(model.calls[1])[2])[0]).toMatchObject({ tool_use_id: 'p2', is_error: true });
    const view = await (await call(server, `/api/org/locations/${locationId}/chat/${conversationIdOf(events)}`, { session: author.session }))
      .json() as ConversationView;
    expect(view.messages.flatMap((m) => m.proposals)).toEqual([]);
  });

  it('stops after 8 model calls with tool_limit, and the saved history still makes a valid next request', async () => {
    for (let i = 1; i <= 8; i += 1) {
      model.script({ kind: 'message', message: message([toolUse(`loop${String(i)}`, 'list_notes', {})]) });
    }
    const { events } = await turn({ content: 'Keep checking.' });
    expect(model.calls).toHaveLength(8);
    expect(events.at(-1)).toEqual({ event: 'done', data: { stopReason: 'tool_limit', costUsd: expect.any(Number) as unknown } });
    expect(eventData(events, 'tool')).toHaveLength(16);
    const id = conversationIdOf(events);
    expect(await storedParams(id)).toHaveLength(17);

    model.script({ kind: 'message', message: message([text('Done checking.')]) });
    expect(shape((await turn({ conversationId: id, content: 'And?' })).events)).toEqual(['conversation', 'text', 'done']);
    const sent = messagesOf(model.calls[8]);
    expect(sent).toHaveLength(18);
    expect(toolResults(sent[16]).map((r) => r.tool_use_id)).toEqual(['loop8']);
  });
});

describe('stop reasons', () => {
  it('a refusal ends the turn with refusal and never runs that turn’s tool calls', async () => {
    model.script({ kind: 'message', message: message([text('I can’t help'), toolUse('r1', 'propose_note', PROPOSAL)], { stopReason: 'refusal' }) });
    const { events } = await turn({ content: 'Refuse me.' });
    expect(shape(events)).toEqual(['conversation', 'text', 'done']);
    expect(events.at(-1)?.data).toMatchObject({ stopReason: 'refusal' });
    const stored = await storedParams(conversationIdOf(events));
    expect(stored).toHaveLength(3);
    expect(toolResults(stored[2])).toEqual([expect.objectContaining({ tool_use_id: 'r1', is_error: true })]);
  });

  it('after a mid-reply fallback, the declined model’s tool call never runs and only its text is sent back', async () => {
    model.script(
      { kind: 'message', message: message([
        thinking('sig-declined'), text('Let me check. '), toolUse('t-declined', 'get_town_profile', {}),
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal', category: null } },
        text('Checking your notes.'), toolUse('t-kept', 'list_notes', {}),
      ], { model: 'claude-opus-5' }) },
      { kind: 'message', message: message([text('You have one closure recorded.')], { model: 'claude-opus-5' }) },
    );
    const { events } = await turn({ content: 'What have I recorded?' });
    expect(eventData(events, 'tool')).toEqual([{ name: 'list_notes', state: 'running' }, { name: 'list_notes', state: 'done' }]);

    const sent = messagesOf(model.calls[1]);
    expect(sent[1]).toEqual({ role: 'assistant', content: [
      text('Let me check. '), text('Checking your notes.'), toolUse('t-kept', 'list_notes', {}),
    ] });
    expect(toolResults(sent[2]).map((r) => r.tool_use_id)).toEqual(['t-kept']);
    const stored = await storedParams(conversationIdOf(events));
    expect(JSON.stringify(stored)).not.toContain('t-declined');
    expect(JSON.stringify(stored)).not.toContain('sig-declined');
  });

  it('a refusal before any output saves no empty assistant message', async () => {
    model.script({ kind: 'message', message: message([], { stopReason: 'refusal' }) });
    const { events } = await turn({ content: 'Refuse before output.' });
    expect(shape(events)).toEqual(['conversation', 'done']);
    expect(await storedParams(conversationIdOf(events))).toEqual([{ role: 'user', content: 'Refuse before output.' }]);
  });

  it('max_tokens with a tool_use ends with max_tokens and does not run the tool', async () => {
    model.script({ kind: 'message', message: message(
      [text('Let me look'), toolUse('m1', 'get_sales_days', { from: '2026-05-01', to: '2026-05-0' })],
      { stopReason: 'max_tokens' },
    ) });
    const { events } = await turn({ content: 'Cut off.' });
    expect(shape(events)).toEqual(['conversation', 'text', 'done']);
    expect(events.at(-1)?.data).toMatchObject({ stopReason: 'max_tokens' });
    const id = conversationIdOf(events);
    expect(toolResults((await storedParams(id))[2])).toEqual([expect.objectContaining({ tool_use_id: 'm1', is_error: true })]);

    model.script({ kind: 'message', message: message([text('Here it is.')]) });
    expect(shape((await turn({ conversationId: id, content: 'Go on.' })).events)).toEqual(['conversation', 'text', 'done']);
  });
});

describe('provider errors', () => {
  const body = (type: string): { type: 'error'; error: { type: string; message: string } } => ({ type: 'error', error: { type, message: 'Provider said no' } });
  const cases: [string, unknown, string][] = [
    ['RateLimitError', new RateLimitError(429, body('rate_limit_error'), undefined, new Headers(), 'rate_limit_error'), 'provider_overloaded'],
    ['529 overloaded', new InternalServerError(529, body('overloaded_error'), undefined, new Headers(), 'overloaded_error'), 'provider_overloaded'],
    ['overloaded mid-stream', new APIError(undefined, body('overloaded_error'), undefined, new Headers(), 'overloaded_error'), 'provider_overloaded'],
    ['500', new InternalServerError(500, body('api_error'), undefined, new Headers(), 'api_error'), 'provider_unavailable'],
    ['connection', new APIConnectionError({ message: 'Connection error.' }), 'provider_unavailable'],
    ['timeout', new APIConnectionTimeoutError(), 'provider_unavailable'],
    ['400', new BadRequestError(400, body('invalid_request_error'), undefined, new Headers(), 'invalid_request_error'), 'internal'],
    ['401', new AuthenticationError(401, body('authentication_error'), undefined, new Headers(), 'authentication_error'), 'internal'],
  ];

  for (const [name, error, code] of cases) {
    it(`${name} ends the stream with error ${code}, saves nothing, and records what the call used`, async () => {
      const partial = eventsOf(message([text('Partial reply')], { usage: { input: 2000 } })).slice(0, 3);
      model.script({ kind: 'error', error, before: partial });
      const { events } = await turn({ content: 'Will this fail?' });
      expect(shape(events)).toEqual(['conversation', 'text', 'error']);
      expect(events.at(-1)?.data).toEqual({ code });
      expect(await conversationDoc(conversationIdOf(events))).toBeNull();
      // message_start reported 2000 input tokens and 1 output token.
      expect(await usedMicroUsd()).toBe(2000 * 4 + 20);
    });
  }

  it('a failed turn on an existing conversation appends nothing and frees the conversation', async () => {
    const id = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Older question' });
    const before = await conversationDoc(id);
    model.script({ kind: 'error', error: new InternalServerError(500, body('api_error'), undefined, new Headers(), 'api_error') });
    const { events } = await turn({ conversationId: id, content: 'Try again' });
    expect(shape(events)).toEqual(['conversation', 'error']);
    expect(await conversationDoc(id)).toEqual(before);
  });

  it('a tool input the SDK cannot parse is re-issued at most twice; a third failure is internal; the input never reaches a log', async () => {
    const unparseable = (): AnthropicError => new AnthropicError(
      'Unable to parse tool parameter JSON from model. Error: Unexpected end. JSON: {"from": "Sentinel-json-input',
    );
    server.logs.length = 0;
    model.script(
      { kind: 'error', error: unparseable() }, { kind: 'error', error: unparseable() },
      { kind: 'message', message: message([text('Recovered.')]) },
    );
    expect(shape((await turn({ content: 'Parse twice.' })).events)).toEqual(['conversation', 'text', 'done']);
    expect(model.calls).toHaveLength(3);
    expect(JSON.stringify(model.calls[2]?.params.messages)).toBe(JSON.stringify(model.calls[0]?.params.messages));

    model.script({ kind: 'error', error: unparseable() }, { kind: 'error', error: unparseable() }, { kind: 'error', error: unparseable() });
    const failed = await turn({ content: 'Parse three times.' });
    expect(failed.events.at(-1)).toEqual({ event: 'error', data: { code: 'internal' } });
    expect(model.calls).toHaveLength(6);
    expect(server.logs.join('\n')).not.toContain('Sentinel-json-input');
  });
});

describe('closing the connection', () => {
  it('aborts the provider call and saves nothing but the cost', async () => {
    const partial = eventsOf(message([text('A long answer that keeps going and going')], { usage: { input: 1000 } })).slice(0, 4);
    model.script({ kind: 'hang', before: partial });
    const controller = new AbortController();
    const res = await fetch(new URL(turnsPath(), server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${author.session.accessToken}` },
      body: JSON.stringify({ content: 'Start, then I leave.' }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('event: text')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    const id = conversationIdOf(parseSse(received));
    controller.abort();
    await reader.cancel().catch(() => undefined);

    await until(() => Promise.resolve(model.calls[0]?.signal.aborted === true));
    await until(async () => (await conversationDoc(id)) === null);
    expect(await usedMicroUsd()).toBe(1000 * 4 + 20);
    await until(() => Promise.resolve(server.logs.some((line) => line.includes('townwise.chat_turn_aborted'))));
  });
});

describe('the live-turn claim', () => {
  it('a second turn on a conversation with a live turn is 409; after 3 minutes it takes over, and the first turn saves nothing', async () => {
    model.script({ kind: 'message', message: message([text('First question answered.')]) });
    const id = conversationIdOf((await turn({ content: 'First question' })).events);

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.script({ kind: 'message', message: message([text('Slow answer.')]), gate });
    const slow = await call(server, turnsPath(), { session: author.session, json: { conversationId: id, content: 'Slow one' } });
    expect(slow.status).toBe(200);

    const busy = await call(server, turnsPath(), { session: author.session, json: { conversationId: id, content: 'Too soon' } });
    expect(await errorOf(busy)).toEqual({ status: 409, error: 'chat_turn_in_progress' });

    server.clock.advance(3 * MINUTE + 1000);
    model.script({ kind: 'message', message: message([text('Took over.')]) });
    expect(shape((await turn({ conversationId: id, content: 'Taking over' })).events)).toEqual(['conversation', 'text', 'done']);

    release();
    const late = parseSse(await slow.text());
    expect(streamedText(late)).toBe('Slow answer.');
    expect(late.at(-1)).toEqual({ event: 'error', data: { code: 'internal' } });
    const stored = await storedParams(id);
    const firstText = (m: BetaMessageParam): string | undefined => {
      if (m.role === 'system') return undefined;
      return typeof m.content === 'string' ? m.content : (m.content[0] as { text?: string } | undefined)?.text;
    };
    expect(stored.map(firstText))
      .toEqual(['First question', 'First question answered.', 'Taking over', 'Took over.']);
    expect((await conversationDoc(id))?.turnCount).toBe(2);
  });
});

describe('caps, budget and limits', () => {
  it('a conversation with 40 turns, or 1.5 MB of messages, is 409 conversation_full; 39 small turns still take one more', async () => {
    const full = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Full', turnCount: 40 });
    expect((await turn({ conversationId: full, content: 'More?' })).error).toBe('conversation_full');

    const big = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Big' });
    await server.connection.collection('tw_chat_conversations').updateOne({ _id: new Types.ObjectId(big) }, {
      $push: { messages: { at: server.clock.now(), param: JSON.stringify({ role: 'user', content: 'x'.repeat(1_500_000) }) } },
    } as Record<string, unknown>);
    expect((await turn({ conversationId: big, content: 'More?' })).error).toBe('conversation_full');

    const almost = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Almost', turnCount: 39 });
    model.script({ kind: 'message', message: message([text('One more.')]) });
    expect((await turn({ conversationId: almost, content: 'Last one' })).status).toBe(200);
  });

  it('a spent budget is 409 chat_budget_exhausted before any model call; a turn under it may overrun by its own cost', async () => {
    const usage = server.connection.collection('tw_chat_usage');
    await usage.insertOne({ orgId: new Types.ObjectId(orgId), month: '2026-06', costMicroUsd: 19_999_999, updatedAt: server.clock.now() });
    model.script({ kind: 'message', message: message([text('Just in time.')], {
      usage: { input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 },
    }) });
    expect((await turn({ content: 'Under budget' })).status).toBe(200);
    expect(await usedMicroUsd()).toBe(19_999_999 + 26_000);

    const refused = await turn({ content: 'Over budget' });
    expect(refused).toMatchObject({ status: 409, error: 'chat_budget_exhausted' });
    const summary = await (await call(server, `/api/org/locations/${locationId}/chat`, { session: author.session })).json() as ChatSummary;
    expect(summary.budget).toEqual({ month: '2026-06', usedUsd: 20.03, limitUsd: 20, exhausted: true });
  });

  it('prices a model outside the table at the most expensive row', async () => {
    model.script({ kind: 'message', message: message([text('From elsewhere.')], {
      model: 'claude-future-9', usage: { input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 },
    }) });
    const { events } = await turn({ content: 'Unknown model' });
    // 1000 x $5 + 500 x $25 + 10,000 x $0.50 + 2000 x $6.25 per million tokens.
    expect(events.at(-1)?.data).toEqual({ stopReason: 'end_turn', costUsd: 0.035 });
    expect(await usedMicroUsd()).toBe(35_000);
  });

  it('the 61st turn in an hour is 429 before any model call', async () => {
    await server.redis.set(limiterKey('townwise:chat', author.session.userId), '60', 'EX', 3600);
    expect(await turn({ content: 'One too many' })).toMatchObject({ status: 429, error: 'rate_limited' });
  });

  it('refuses a missing, empty or too long message, and an unknown conversation, before any model call', async () => {
    for (const json of [{}, { content: '   ' }, { content: 'x'.repeat(4001) }, { content: 'Hi', conversationId: 'nope' }]) {
      expect(await turn(json)).toMatchObject({ status: 400, error: 'invalid_request' });
    }
    expect(await turn({ content: 'Hi', conversationId: new Types.ObjectId().toHexString() })).toMatchObject({ status: 404, error: 'not_found' });
    expect(await turn({ content: 'Hi' }, author, new Types.ObjectId().toHexString())).toMatchObject({ status: 404, error: 'not_found' });
  });
});

describe('who sees what', () => {
  it('conversations are private to their author and to their location: anyone else, or another location’s path, is 404', async () => {
    const id = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Private question' });
    const path = `/api/org/locations/${locationId}/chat/${id}`;
    for (const who of [colleague, admin]) {
      expect(await errorOf(await call(server, path, { session: who.session }))).toEqual({ status: 404, error: 'not_found' });
      expect(await errorOf(await call(server, path, { method: 'DELETE', session: who.session }))).toEqual({ status: 404, error: 'not_found' });
      expect(await turn({ conversationId: id, content: 'Mine now?' }, who)).toMatchObject({ status: 404, error: 'not_found' });
      const list = await (await call(server, `/api/org/locations/${locationId}/chat`, { session: who.session })).json() as ChatSummary;
      expect(list.conversations.map((c) => c.id)).not.toContain(id);
    }
    const elsewhere = `/api/org/locations/${otherLocationId}/chat/${id}`;
    expect(await errorOf(await call(server, elsewhere, { session: author.session }))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await call(server, elsewhere, { method: 'DELETE', session: author.session }))).toEqual({ status: 404, error: 'not_found' });
    expect(await turn({ conversationId: id, content: 'Wrong room' }, author, otherLocationId)).toMatchObject({ status: 404, error: 'not_found' });
    const other = await (await call(server, `/api/org/locations/${otherLocationId}/chat`, { session: author.session })).json() as ChatSummary;
    expect(other.conversations).toEqual([]);
    expect(await conversationDoc(id)).not.toBeNull();
  });

  it('staff in view-as read the target’s conversations and cannot send or delete', async () => {
    const id = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Seen by staff' });
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: author.session.userId, orgId });
      const list = await (await call(server, `/api/org/locations/${locationId}/chat`, { session: staff })).json() as ChatSummary;
      expect(list.conversations.map((c) => c.id)).toContain(id);
      const view = await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: staff });
      expect(view.status).toBe(200);
      expect((await view.json() as ConversationView).messages[0]).toMatchObject({ role: 'user', text: 'Seen by staff' });
      const send = await call(server, turnsPath(), { session: staff, json: { conversationId: id, content: 'As staff' } });
      expect(await errorOf(send)).toEqual({ status: 403, error: 'view_as_read_only' });
      const remove = await call(server, `/api/org/locations/${locationId}/chat/${id}`, { method: 'DELETE', session: staff });
      expect(await errorOf(remove)).toEqual({ status: 403, error: 'view_as_read_only' });
      expect(await conversationDoc(id)).not.toBeNull();
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });

  it('the author deletes a conversation: 204, recorded with ids only; a second delete is 404', async () => {
    const id = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Delete me' });
    const path = `/api/org/locations/${locationId}/chat/${id}`;
    expect((await call(server, path, { method: 'DELETE', session: author.session })).status).toBe(204);
    expect(await conversationDoc(id)).toBeNull();
    const event = (await auditEvents(server)).find((e) => (e.target as { id: string }).id === id);
    expect(event).toMatchObject({
      action: 'chat.conversation_deleted', actorUserId: author.session.userId, target: { type: 'conversation', id },
      details: { locationId, conversationId: id },
    });
    expect(await errorOf(await call(server, path, { method: 'DELETE', session: author.session }))).toEqual({ status: 404, error: 'not_found' });
  });

  it('deleting a location deletes its conversations', async () => {
    const roomId = await addLocation(server, { orgId, name: 'Pop-up Room' });
    const id = await addConversation(server, { orgId, locationId: roomId, userId: author.session.userId, text: 'Pop-up question' });
    expect((await call(server, `/api/org/locations/${roomId}`, { method: 'DELETE', session: admin.session })).status).toBe(204);
    expect(await conversationDoc(id)).toBeNull();
  });
});

describe('audit events and logs', () => {
  it('a saved turn records chat.turn_completed with allowlisted details only; no message, tool input or result text reaches an event or a log', async () => {
    server.logs.length = 0;
    model.script(
      { kind: 'message', message: message([toolUse('a1', 'propose_note', { ...PROPOSAL, detail: 'Sentinel-tool-input dinner' })], {
        usage: { input: 300, output: 40, cacheRead: 1000, cacheWrite: 200 },
      }) },
      { kind: 'message', message: message([text('Sentinel-assistant-text reply')], { usage: { input: 50, output: 10, cacheRead: 1300 } }) },
    );
    const { events } = await turn({ content: 'Sentinel-user-text question' });
    expect(shape(events)).toEqual(['conversation', 'tool', 'proposal', 'tool', 'text', 'done']);
    const id = conversationIdOf(events);
    const event = (await auditEvents(server)).find((e) => e.action === 'chat.turn_completed' && (e.target as { id: string }).id === id);
    expect(event).toMatchObject({ actorUserId: author.session.userId, actorRole: 'member', target: { type: 'conversation', id } });
    expect(event?.details).toEqual({
      locationId, conversationId: id, model: 'claude-opus-5-5', calls: 2, inputTokens: 300 + 1000 + 200 + 50 + 1300,
      outputTokens: 50, stopReason: 'end_turn',
    });
    const everything = JSON.stringify(await auditEvents(server)) + server.logs.join('\n');
    for (const sentinel of ['Sentinel-user-text', 'Sentinel-assistant-text', 'Sentinel-tool-input', 'Shown to the owner', 'Taproom']) {
      expect(everything).not.toContain(sentinel);
    }
    expect(server.logs.some((line) => line.includes('townwise.chat_turn'))).toBe(true);
  });
});
