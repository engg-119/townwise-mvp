// TownwiseAI (docs/portal/tuning-chat.md sections 1 to 5) against a scripted model (helpers/chat-model.ts): the
// GET shapes, author-only and per-location access, view-as, the event stream for answers, tool loops with the views
// each tool card shows (streamed, and again after a reload), proposals,
// the call and per-reply tool limits, refusals, cut-off replies and provider errors, disconnects, the live-turn claims
// (per conversation and per person), the caps, the budget and cost, byte-for-byte replay of thinking blocks, and audit
// events and logs free of message text.
import { randomUUID } from 'node:crypto';

import {
  AnthropicError, APIConnectionError, APIConnectionTimeoutError, APIError, AuthenticationError, BadRequestError,
  InternalServerError, RateLimitError,
} from '@anthropic-ai/sdk';
import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { SYSTEM_PROMPT } from '../src/chat/prompt.ts';
import { TOOLS } from '../src/chat/tools/registry.ts';
import type { ChatSummary, ConversationView } from '../src/handlers/chat.ts';
import {
  addChatTurn, addConversation, addGrant, addLocation, addNote, addSalesDay, addSeat, auditEvents, createOrg,
} from './helpers/fixtures.ts';
import {
  eventsOf, message, messagesOf, scriptedModel, text, thinking, toolUse, type ScriptedModel,
} from './helpers/chat-model.ts';
import { setupOrg } from './helpers/setup-org.ts';
import {
  call, limiterKey, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, type TestSession, type TownwiseTestServer,
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
    // A new conversation's first message is a root node, and the reply hangs under it.
    const { userNodeId, replyNodeId } = events[0]?.data as { userNodeId: string; replyNodeId: string };
    expect(events[0]?.data).toEqual({
      id, title: 'What changed in May?', userNodeId: expect.any(String) as unknown, replyNodeId: expect.any(String) as unknown, parentId: null,
      // resumable-chat-turns: the turn's id, for a reader that resumes it.
      turnId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
    expect(streamedText(events)).toBe('May was steady, with two busy Fridays.');
    // 1000 x $4 + 500 x $20 + 10,000 x $0.20 + 2000 x $5 per million tokens.
    expect(events.at(-1)?.data).toEqual({ stopReason: 'end_turn', costUsd: 0.026, leafId: replyNodeId, sources: [] });
    expect(await usedMicroUsd()).toBe(26_000);

    const params = model.calls[0]?.params;
    expect(params).toMatchObject({
      model: 'claude-opus-5-5', max_tokens: 16_000, output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'], fallbacks: 'default',
      cache_control: { type: 'ephemeral' }, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'What changed in May?' }],
    });
    expect(params).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    });
    expect(params?.tools?.map((tool) => ('name' in tool ? tool.name : null))).toEqual([
      'get_location_overview', 'get_sales_days', 'list_notes', 'get_town_profile', 'propose_note',
      'get_town_calendar', 'get_people_in_town', 'get_forecast', 'get_day', 'show_visual', 'suggest_next',
      'list_data_items', 'read_data_item', 'propose_data_item', 'start_calibration', 'get_calibration', 'compare_forecast_models',
      'get_owner_calendar',
      'get_order_board', 'get_order_line', 'get_order_setup', 'propose_order_change', 'propose_order_rule', 'propose_order_setup',
      'correct_calendar_event',
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
    expect(list.budget).toEqual({ month: '2026-06', usedUsd: 0.03, limitUsd: 20, exhausted: false, researchUsd: 0 });
    expect(list.conversations[0]).toEqual({ id, title: 'What changed in May?', updatedAt: server.clock.now().toISOString(), turnCount: 1, running: false });

    const view = await (await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: author.session })).json() as ConversationView;
    const at = server.clock.now().toISOString();
    expect(view).toEqual({
      id, title: 'What changed in May?', updatedAt: at, activeLeafId: replyNodeId,
      tree: [
        { id: userNodeId, parentId: null, role: 'user' },
        { id: replyNodeId, parentId: userNodeId, role: 'assistant' },
      ],
      messages: [
        { nodeId: userNodeId, role: 'user', text: 'What changed in May?', proposals: [], parts: [], feedback: null, next: null, at, endedAt: at, attachments: [], sources: [] },
        {
          nodeId: replyNodeId, role: 'assistant', text: 'May was steady, with two busy Fridays.', proposals: [],
          parts: [{ type: 'text', text: 'May was steady, with two busy Fridays.' }], feedback: null, next: null, at, endedAt: at,
          attachments: [], sources: [],
        },
      ],
      liveTurn: null,
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
    // With no parentId the turn continues the stored active leaf: the first turn's reply.
    expect(two.events[0]?.data).toMatchObject({ id, title: 'What notes do I have?', parentId: (one.events[0]?.data as { replyNodeId: string }).replyNodeId });

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
    const may = { from: '2026-05-01', to: '2026-05-31' };
    // The Your data items that hold May's days, by ref only (spec P25): addSalesDay writes each day as its own upload.
    const ref = expect.stringMatching(/^u_[0-9a-f]{24}$/) as unknown;
    const uploadRefs = [ref, ref];
    const town = { available: true, town: { name: 'Hanover', state: 'NH' }, sources: expect.any(Array) as unknown };
    const views = [
      { id: 't1', name: 'get_location_overview', input: null, result: { firstDate: '2026-05-01', lastDate: '2026-05-02', dayCount: 2, missingDays: 0, monthCount: 1 } },
      { id: 't2', name: 'get_sales_days', input: may, result: { ...may, dayCount: 2, guestsDayCount: 2, netSalesDayCount: 1, uploadRefs } },
      { id: 't3', name: 'list_notes', input: null, result: { count: 1 } },
      { id: 't4', name: 'get_town_profile', input: null, result: town },
    ];
    // Each call streams `running` with its input view, then `done` with its result view, or `error` with none.
    expect(eventData(events, 'tool')).toEqual([
      ...views.flatMap((view) => [{ ...view, state: 'running', result: null }, { ...view, state: 'done' }]),
      { id: 't5', name: 'get_sales_days', state: 'running', input: null, result: null },
      { id: 't5', name: 'get_sales_days', state: 'error', input: null, result: null },
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
      todayWeekday: 'Mon',
      timeZone: 'America/New_York',
      coverage: { firstDate: '2026-05-01', lastDate: '2026-05-02', dayCount: 2, guestsDayCount: 2, netSalesDayCount: 1, missingDays: 0 },
      calibration: 'not_calibrated',
      calibrationWords: null,
      townProfile: true,
      months: [{ month: '2026-05', days: 2, guests: 230, netSalesUsd: 5123.45 }],
    });
    expect(content(1)).toEqual({
      from: '2026-05-01', to: '2026-05-31',
      days: [{ date: '2026-05-01', guests: 140, netSalesUsd: 5123.45 }, { date: '2026-05-02', guests: 90, netSalesUsd: null }],
      uploadRefs,
    });
    expect(content(2)).toEqual({ notes: [{
      kind: 'closure', startDate: '2026-05-10', endDate: '2026-05-10', weekdays: null, startTime: null, endTime: null, effect: 'closed',
      expectedGuests: null, title: null, detail: 'Closed for the floor refinish',
    }] });
    expect(content(3)).toMatchObject({ profile: { townId: 'hanover-nh', name: 'Hanover', county: expect.any(String) as unknown } });

    // The frozen prefix holds no name, id or date.
    const system = JSON.stringify(model.calls[1]?.params.system);
    for (const value of ['Taproom', 'Hanover', 'Chat Tavern', orgId, locationId, '2026']) expect(system).not.toContain(value);
    expect(JSON.stringify(model.calls[0]?.params.tools)).toBe(JSON.stringify(TOOLS));

    // A reload shows the same cards, in order, then the reply's text.
    const view = await (await call(server, `/api/org/locations/${locationId}/chat/${conversationIdOf(events)}`, { session: author.session }))
      .json() as ConversationView;
    expect(view.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(view.messages[1]?.parts).toEqual([
      ...views.map((v) => ({ type: 'tool', ...v, state: 'done' })),
      { type: 'tool', id: 't5', name: 'get_sales_days', state: 'error', input: null, result: null },
      { type: 'text', text: 'Taproom had 230 guests over two days.' },
    ]);
  });

  it('with one location get_location_overview names it by the organization\'s name, never its stored name (D29)', async () => {
    const soloOrgId = await createOrg(server, { name: 'Solo Tavern Group' });
    const soloLocationId = await addLocation(server, { orgId: soloOrgId, name: 'Solo Tavern Group, Hanover' });
    const email = `solo-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId: soloOrgId, userId: session.userId, email, role: 'member' });
    model.script(
      { kind: 'message', message: message([toolUse('t1', 'get_location_overview', {})]) },
      { kind: 'message', message: message([text('Steady so far.')]) },
    );
    const { events } = await turn({ content: 'How are we doing?' }, { session, email }, soloLocationId);
    expect(events.at(-1)?.event).toBe('done');
    const [result] = toolResults(messagesOf(model.calls[1])[2]);
    expect(JSON.parse(result?.content as string)).toMatchObject({ location: { name: 'Solo Tavern Group', town: { name: 'Hanover', state: 'NH' } } });
    expect(JSON.stringify(model.calls[1]?.params.messages)).not.toContain('Solo Tavern Group, Hanover');
  });

  it('get_location_overview carries the model card’s updating sentence while a first forecast runs, in a result, never the prefix (D65)', async () => {
    const building = await addLocation(server, { orgId, name: 'Cellar' });
    await addSalesDay(server, { orgId, locationId: building, date: '2026-05-01', guests: 60, netSalesCents: null });
    await addSalesDay(server, { orgId, locationId: building, date: '2026-05-02', guests: 70, netSalesCents: null });
    const requestedAt = new Date(server.clock.now().getTime() - 6 * MINUTE);
    await server.ctx.stores.calibrations.insertQueued({ orgId } as OrgScope, {
      id: new Types.ObjectId().toHexString(), locationId: building, requestedBy: { userId: admin.session.userId, role: 'org_admin', via: 'chat' },
      regimeStart: null, championRunId: null, tokenExpiresAt: new Date(requestedAt.getTime() + 20 * MINUTE), now: requestedAt,
    });
    model.script(
      { kind: 'message', message: message([toolUse('t1', 'get_location_overview', {})]) },
      { kind: 'message', message: message([text('It’s being built now.')]) },
    );
    const { events } = await turn({ content: 'Is my forecast ready?' }, author, building);
    expect(events.at(-1)?.event).toBe('done');
    const [result] = toolResults(messagesOf(model.calls[1])[2]);
    const overview = JSON.parse(result?.content as string) as { calibration: string; calibrationWords: string };
    expect(overview.calibration).toBe('not_calibrated');
    // In the town's time (Eastern): the test clock's 12:00 UTC less 6 minutes, on the town's today.
    expect(overview.calibrationWords).toBe('Building your first forecast, started 7:54 AM.');
    expect(JSON.stringify(model.calls[1]?.params.system)).not.toContain('Building');
  });

  it('a valid propose_note streams a proposal, writes no note, and the proposal posts unchanged to the notes route', async () => {
    const notesBefore = await server.connection.collection('tw_notes').countDocuments({});
    model.script(
      { kind: 'message', message: message([toolUse('p1', 'propose_note', { ...PROPOSAL, weekdays: [6, 5] })]) },
      { kind: 'message', message: message([text('I proposed the dinner as a note.')]) },
    );
    const { events } = await turn({ content: 'We have a rehearsal dinner on June 20.' });
    expect(shape(events)).toEqual(['conversation', 'tool', 'proposal', 'tool', 'text', 'done']);
    const proposal = { ...PROPOSAL, weekdays: [5, 6], title: null, startTime: null, endTime: null };
    expect(eventData(events, 'proposal')).toEqual([{ id: 'p1', proposal }]);
    expect(eventData(events, 'tool')).toEqual([
      { id: 'p1', name: 'propose_note', state: 'running', input: null, result: null },
      { id: 'p1', name: 'propose_note', state: 'done', input: null, result: null },
    ]);
    expect(toolResults(messagesOf(model.calls[1])[2])).toEqual([{
      type: 'tool_result', tool_use_id: 'p1', content: 'Shown to the owner as a proposal. They decide whether to add it.',
    }]);
    expect(await server.connection.collection('tw_notes').countDocuments({})).toBe(notesBefore);

    const id = conversationIdOf(events);
    const view = await (await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: author.session })).json() as ConversationView;
    // One reply: its proposal card, then its text.
    expect(view.messages.map((m) => [m.role, m.text, m.proposals])).toEqual([
      ['user', 'We have a rehearsal dinner on June 20.', []],
      ['assistant', 'I proposed the dinner as a note.', [{ ...proposal, id: 'p1', status: 'open', noteId: null }]],
    ]);
    expect(view.messages[1]?.parts).toEqual([
      { type: 'proposal', proposal: { ...proposal, id: 'p1', status: 'open', noteId: null } },
      { type: 'text', text: 'I proposed the dinner as a note.' },
    ]);

    const added = await call(server, `/api/org/locations/${locationId}/notes`, { session: author.session, json: proposal });
    expect(added.status).toBe(201);
    expect((await added.json() as { note: unknown }).note).toMatchObject(proposal);
  });

  it('a streamed proposal can be acted on only after its turn’s done; one from a failed turn was never kept', async () => {
    const proposalPath = (conversationId: string, proposalId: string): string =>
      `/api/org/locations/${locationId}/chat/${conversationId}/proposals/${proposalId}`;
    const save = async (conversationId: string, proposalId: string): Promise<{ status: number; noteId?: string }> => {
      const res = await call(server, proposalPath(conversationId, proposalId), { session: author.session, json: { action: 'save' } });
      const body = await res.json() as { proposal?: { noteId: string } };
      return body.proposal === undefined ? { status: res.status } : { status: res.status, noteId: body.proposal.noteId };
    };
    model.script({ kind: 'message', message: message([text('Tell me about the dinner.')]) });
    const id = conversationIdOf((await turn({ content: 'A dinner is coming up.' })).events);

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.script(
      { kind: 'message', message: message([toolUse('p_live', 'propose_note', PROPOSAL)]) },
      { kind: 'message', message: message([text('Proposed.')]), gate },
    );
    const live = await call(server, turnsPath(), { session: author.session, json: { conversationId: id, content: 'It is June 20.' } });
    expect(live.status).toBe(200);
    // The second model call has started, so the proposal event was sent; the turn's messages are not stored yet.
    await until(() => Promise.resolve(model.calls.length === 2));
    expect(await save(id, 'p_live')).toEqual({ status: 404 });
    release();
    expect(shape(parseSse(await live.text()))).toEqual(['conversation', 'tool', 'proposal', 'tool', 'text', 'done']);
    const saved = await save(id, 'p_live');
    expect(saved.status).toBe(200);

    model.script(
      { kind: 'message', message: message([toolUse('p_failed', 'propose_note', { ...PROPOSAL, startDate: '2026-06-21', endDate: '2026-06-21' })]) },
      { kind: 'error', error: new InternalServerError(500, { type: 'error', error: { type: 'api_error', message: 'Down' } }, undefined, new Headers(), 'api_error') },
    );
    const failed = await turn({ conversationId: id, content: 'And June 21?' });
    expect(shape(failed.events)).toEqual(['conversation', 'tool', 'proposal', 'tool', 'error']);
    expect(await save(id, 'p_failed')).toEqual({ status: 404 });
    await server.connection.collection('tw_notes').deleteOne({ _id: new Types.ObjectId(saved.noteId) });
  });

  it('an invalid propose_note is an is_error result: a tool error event, no proposal, nothing shown later', async () => {
    model.script(
      { kind: 'message', message: message([toolUse('p2', 'propose_note', { ...PROPOSAL, endDate: '2026-06-19' })]) },
      { kind: 'message', message: message([text('That date range was wrong.')]) },
    );
    const { events } = await turn({ content: 'Add the dinner.' });
    expect(shape(events)).toEqual(['conversation', 'tool', 'tool', 'text', 'done']);
    expect(eventData(events, 'tool')).toEqual([
      { id: 'p2', name: 'propose_note', state: 'running', input: null, result: null },
      { id: 'p2', name: 'propose_note', state: 'error', input: null, result: null },
    ]);
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
    expect(events.at(-1)).toEqual({
      event: 'done', data: { stopReason: 'tool_limit', costUsd: expect.any(Number) as unknown, leafId: expect.any(String) as unknown, sources: [] },
    });
    expect(eventData(events, 'tool')).toHaveLength(16);
    const id = conversationIdOf(events);
    expect(await storedParams(id)).toHaveLength(17);

    model.script({ kind: 'message', message: message([text('Done checking.')]) });
    expect(shape((await turn({ conversationId: id, content: 'And?' })).events)).toEqual(['conversation', 'text', 'done']);
    const sent = messagesOf(model.calls[8]);
    expect(sent).toHaveLength(18);
    expect(toolResults(sent[16]).map((r) => r.tool_use_id)).toEqual(['loop8']);
  });

  it('runs at most 5 tool calls from one reply and answers the rest as not run, because it asked for too many at once', async () => {
    const asked = Array.from({ length: 7 }, (_, i) => toolUse(`cap${String(i + 1)}`, 'list_notes', {}));
    model.script(
      { kind: 'message', message: message(asked) },
      { kind: 'message', message: message([text('Five lookups were enough.')]) },
    );
    const { events } = await turn({ content: 'Check everything at once.' });
    expect(shape(events)).toEqual(['conversation', ...Array<string>(10).fill('tool'), 'text', 'done']);
    const results = toolResults(messagesOf(model.calls[1])[2]);
    expect(results.map((r) => [r.tool_use_id, r.is_error === true])).toEqual([
      ['cap1', false], ['cap2', false], ['cap3', false], ['cap4', false], ['cap5', false], ['cap6', true], ['cap7', true],
    ]);
    for (const result of results.slice(5)) expect(result.content).toMatch(/^Not run: the reply asked for too many tool calls at once\./);
    expect(await storedParams(conversationIdOf(events))).toHaveLength(4);
  });
});

describe('stop reasons', () => {
  it('a refused first turn ends with done refusal, records its cost, never runs its tool calls and deletes its conversation', async () => {
    model.script({ kind: 'message', message: message([text('I can’t help'), toolUse('r1', 'propose_note', PROPOSAL)], {
      stopReason: 'refusal', usage: { input: 1000, output: 500 },
    }) });
    const { events } = await turn({ content: 'Refuse me.' });
    expect(shape(events)).toEqual(['conversation', 'text', 'done']);
    // 1000 x $4 + 500 x $20 per million tokens.
    expect(events.at(-1)?.data).toEqual({ stopReason: 'refusal', costUsd: 0.014, leafId: null, sources: [] });
    expect(await usedMicroUsd()).toBe(14_000);
    expect(await conversationDoc(conversationIdOf(events))).toBeNull();
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
    expect(eventData(events, 'tool')).toEqual([
      { id: 't-kept', name: 'list_notes', state: 'running', input: null, result: null },
      { id: 't-kept', name: 'list_notes', state: 'done', input: null, result: { count: expect.any(Number) as unknown } },
    ]);

    const sent = messagesOf(model.calls[1]);
    expect(sent[1]).toEqual({ role: 'assistant', content: [
      text('Let me check. '), text('Checking your notes.'), toolUse('t-kept', 'list_notes', {}),
    ] });
    expect(toolResults(sent[2]).map((r) => r.tool_use_id)).toEqual(['t-kept']);
    const stored = await storedParams(conversationIdOf(events));
    expect(JSON.stringify(stored)).not.toContain('t-declined');
    expect(JSON.stringify(stored)).not.toContain('sig-declined');
  });

  it('a refusal after a tool step appends nothing to an existing conversation: no user message, partial reply or results', async () => {
    const id = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Older question' });
    const before = await conversationDoc(id);
    const history = await storedParams(id);
    model.script(
      { kind: 'message', message: message([text('Let me look. '), toolUse('r2', 'list_notes', {})]) },
      { kind: 'message', message: message([], { stopReason: 'refusal' }) },
    );
    const { events } = await turn({ conversationId: id, content: 'Refuse later.' });
    expect(shape(events)).toEqual(['conversation', 'text', 'aside', 'tool', 'tool', 'done']);
    expect(events.at(-1)?.data).toMatchObject({ stopReason: 'refusal' });
    expect(await conversationDoc(id)).toEqual(before);

    model.script({ kind: 'message', message: message([text('Here it is.')]) });
    expect(shape((await turn({ conversationId: id, content: 'Go on.' })).events)).toEqual(['conversation', 'text', 'done']);
    expect(messagesOf(model.calls[2])).toEqual([...history, { role: 'user', content: 'Go on.' }]);
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
      // message_start reported 2000 input tokens; the 7 characters streamed before the failure count as 3 output tokens.
      expect(await usedMicroUsd()).toBe(2000 * 4 + 3 * 20);
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
  // resumable-chat-turns: this used to abort the provider call and save nothing. Closing now only stops that listener;
  // the turn runs on and is saved once, as any turn (chat-resume.int.test.ts covers its record and the other endings).
  it('aborts nothing: the turn runs on and is saved once', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.script({ kind: 'message', message: message([text('An answer written while nobody watched.')]), gate });
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
    while (!received.includes('event: conversation')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    const id = conversationIdOf(parseSse(received));
    controller.abort();
    await reader.cancel().catch(() => undefined);
    release();

    await until(async () => (await conversationDoc(id))?.turnCount === 1);
    expect(model.calls[0]?.signal.aborted).toBe(false);
    expect((await storedParams(id)).map((m) => m.role)).toEqual(['user', 'assistant']);
    await until(async () => (await server.connection.collection('tw_chat_live_turns').countDocuments({})) === 0);
    await until(() => Promise.resolve(server.logs.some((line) => line.includes('"msg":"townwise.chat_turn"'))));
    expect(server.logs.join('\n')).not.toContain('townwise.chat_turn_aborted');
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

describe('one live turn per person', () => {
  it('of concurrent turns from one person, in any conversation or location, exactly one streams; the rest are 409 and create nothing', async () => {
    const snug = await addLocation(server, { orgId, name: 'Snug' });
    const existing = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Earlier' });
    const inSnug = await addConversation(server, { orgId, locationId: snug, userId: author.session.userId, text: 'Snug' });
    const conversations = server.connection.collection('tw_chat_conversations');
    const before = await conversations.countDocuments({});
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.script({ kind: 'message', message: message([text('Only one answer.')]), gate });

    const posts: [string, unknown][] = [
      [turnsPath(), { content: 'New one' }],
      [turnsPath(), { content: 'New two' }],
      [turnsPath(), { content: 'Existing', conversationId: existing }],
      [turnsPath(snug), { content: 'Other room' }],
      [turnsPath(snug), { content: 'Other room again', conversationId: inSnug }],
    ];
    const responses = await Promise.all(posts.map(([path, json]) => call(server, path, { session: author.session, json })));
    const streaming = responses.filter((res) => res.status === 200);
    expect(streaming).toHaveLength(1);
    for (const res of responses.filter((r) => r.status !== 200)) {
      expect(await errorOf(res)).toEqual({ status: 409, error: 'chat_turn_in_progress' });
    }

    release();
    const [winner] = streaming;
    if (winner === undefined) throw new Error('no turn streamed');
    const events = parseSse(await winner.text());
    expect(shape(events)).toEqual(['conversation', 'text', 'done']);
    expect(model.calls).toHaveLength(1);
    const id = conversationIdOf(events);
    expect(await conversations.countDocuments({})).toBe(before + ([existing, inSnug].includes(id) ? 0 : 1));
    expect(await server.connection.collection('tw_chat_live_turns').countDocuments({})).toBe(0);
  });

  it('two people in one organization each stream a turn at the same time', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.script(
      { kind: 'message', message: message([text('For one.')]), gate },
      { kind: 'message', message: message([text('For the other.')]), gate },
    );
    const responses = await Promise.all([author, colleague].map((who) => call(server, turnsPath(), {
      session: who.session, json: { content: 'At the same time' },
    })));
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    release();
    for (const res of responses) expect(shape(parseSse(await res.text()))).toEqual(['conversation', 'text', 'done']);
    expect(model.calls).toHaveLength(2);
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

  it('D66: the budget says what location research used of the month, in cents, inside usedUsd', async () => {
    const usage = server.connection.collection('tw_chat_usage');
    await usage.insertOne({
      orgId: new Types.ObjectId(orgId), month: '2026-06', costMicroUsd: 4_255_000, researchMicroUsd: 3_554_999, updatedAt: server.clock.now(),
    });
    const summary = await (await call(server, `/api/org/locations/${locationId}/chat`, { session: author.session })).json() as ChatSummary;
    expect(summary.budget).toEqual({ month: '2026-06', usedUsd: 4.26, limitUsd: 20, exhausted: false, researchUsd: 3.55 });
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
    expect(summary.budget).toEqual({ month: '2026-06', usedUsd: 20.03, limitUsd: 20, exhausted: true, researchUsd: 0 });
  });

  it('a budget spent during a turn ends it with budget after its last complete step, and makes no further call', async () => {
    const usage = server.connection.collection('tw_chat_usage');
    await usage.insertOne({ orgId: new Types.ObjectId(orgId), month: '2026-06', costMicroUsd: 19_990_000, updatedAt: server.clock.now() });
    model.script({ kind: 'message', message: message([text('Checking your notes. '), toolUse('b1', 'list_notes', {})], {
      usage: { input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 },
    }) });
    const { events } = await turn({ content: 'Spend the rest' });
    expect(model.calls).toHaveLength(1);
    expect(shape(events)).toEqual(['conversation', 'text', 'aside', 'tool', 'tool', 'done']);
    expect(events.at(-1)?.data).toMatchObject({ stopReason: 'budget', costUsd: 0.026 });
    expect(await usedMicroUsd()).toBe(19_990_000 + 26_000);

    // Saved, with every tool call answered, so the history is still a valid request.
    const id = conversationIdOf(events);
    const stored = await storedParams(id);
    expect(stored).toHaveLength(3);
    expect(toolResults(stored[2]).map((r) => [r.tool_use_id, r.is_error === true])).toEqual([['b1', false]]);
    expect(await conversationDoc(id)).toMatchObject({ turnCount: 1, liveTurn: null });
    const event = (await auditEvents(server)).find((e) => e.action === 'chat.turn_completed' && (e.target as { id: string }).id === id);
    expect(event?.details).toMatchObject({ calls: 1, stopReason: 'budget' });
  });

  it('prices a model outside the table at the most expensive row', async () => {
    model.script({ kind: 'message', message: message([text('From elsewhere.')], {
      model: 'claude-future-9', usage: { input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 },
    }) });
    const { events } = await turn({ content: 'Unknown model' });
    // 1000 x $5 + 500 x $25 + 10,000 x $0.50 + 2000 x $6.25 per million tokens.
    expect(events.at(-1)?.data).toMatchObject({ stopReason: 'end_turn', costUsd: 0.035 });
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
    // resumable-chat-turns: the conversation's turn records go with it, and another conversation's stay.
    const kept = await addConversation(server, { orgId, locationId, userId: author.session.userId, text: 'Keep me' });
    await addChatTurn(server, { orgId, locationId, conversationId: id, userId: author.session.userId });
    await addChatTurn(server, { orgId, locationId, conversationId: kept, userId: author.session.userId });
    const path = `/api/org/locations/${locationId}/chat/${id}`;
    expect((await call(server, path, { method: 'DELETE', session: author.session })).status).toBe(204);
    expect(await conversationDoc(id)).toBeNull();
    const turns = server.connection.collection('tw_chat_turns');
    expect(await turns.countDocuments({ conversationId: new Types.ObjectId(id) })).toBe(0);
    expect(await turns.countDocuments({ conversationId: new Types.ObjectId(kept) })).toBe(1);
    const event = (await auditEvents(server)).find((e) => (e.target as { id: string }).id === id);
    expect(event).toMatchObject({
      action: 'chat.conversation_deleted', actorUserId: author.session.userId, target: { type: 'conversation', id },
      details: { locationId, conversationId: id },
    });
    expect(await errorOf(await call(server, path, { method: 'DELETE', session: author.session }))).toEqual({ status: 404, error: 'not_found' });
  });

  it('deleting a location deletes its conversations and their turn records', async () => {
    const roomId = await addLocation(server, { orgId, name: 'Pop-up Room' });
    const id = await addConversation(server, { orgId, locationId: roomId, userId: author.session.userId, text: 'Pop-up question' });
    await addChatTurn(server, { orgId, locationId: roomId, conversationId: id, userId: author.session.userId });
    expect((await call(server, `/api/org/locations/${roomId}`, { method: 'DELETE', session: admin.session })).status).toBe(204);
    expect(await conversationDoc(id)).toBeNull();
    expect(await server.connection.collection('tw_chat_turns').countDocuments({ locationId: new Types.ObjectId(roomId) })).toBe(0);
  });
});

describe('audit events and logs', () => {
  it('streams a thinking summary as thinking events, shows it in the stored view, and never logs or audits it', async () => {
    server.logs.length = 0;
    model.script({ kind: 'message', message: message([thinking('sig-sum', 'Sentinel-thinking summary of the weekend.'), text('Answer.')]) });
    const { events } = await turn({ content: 'Hello' });
    expect([...new Set(shape(events))]).toEqual(['conversation', 'thinking', 'text', 'done']);
    expect(events.filter((e) => e.event === 'thinking').map((e) => (e.data as { delta: string }).delta).join(''))
      .toBe('Sentinel-thinking summary of the weekend.');
    expect(JSON.stringify(eventData(events, 'thinking'))).not.toContain('sig-sum');
    const id = conversationIdOf(events);
    const view = await (await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: author.session })).json() as ConversationView;
    expect(view.messages[1]?.parts).toEqual([
      { type: 'thinking', text: 'Sentinel-thinking summary of the weekend.' }, { type: 'text', text: 'Answer.' },
    ]);
    expect(view.messages[1]?.text).toBe('Answer.');
    expect(JSON.stringify(await auditEvents(server)) + server.logs.join('\n')).not.toContain('Sentinel-thinking');
  });

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

/** Staff open a new organization nobody has joined as its admin and add a location. */
async function openAsAdminOrg(): Promise<{ staff: TestSession; orgId: string; locationId: string }> {
  const staff = await signInStaff(server);
  const setup = await setupOrg(server, staff);
  const started = await call(server, `/api/admin/orgs/${setup.orgId}/open-as-admin`, { method: 'POST', session: staff });
  expect(started.status).toBe(201);
  const created = await call(server, '/api/org/locations', {
    session: staff, json: { name: 'Main Street', town: { townId: 'hanover-nh' }, orgId: setup.orgId },
  });
  expect(created.status).toBe(201);
  return { staff, orgId: setup.orgId, locationId: (await created.json() as { location: { id: string } }).location.id };
}

describe('open as admin', () => {
  const orgUsage = (id: string): Promise<Record<string, unknown> | null> =>
    server.connection.collection('tw_chat_usage').findOne({ orgId: new Types.ObjectId(id), month: '2026-06' });

  it('open as admin: a turn is charged to the organization’s budget and recorded as Townwise staff', async () => {
    const { staff, orgId: setupId, locationId: staffLocation } = await openAsAdminOrg();
    try {
      expect(await orgUsage(setupId)).toBeNull();
      model.script({ kind: 'message', message: message([text('Hello from the model.')], { usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 } }) });
      const res = await turn({ content: 'Set this up' }, { session: staff, email: STAFF_EMAIL }, staffLocation);
      expect(res.status).toBe(200);
      expect(Number((await orgUsage(setupId))?.costMicroUsd)).toBeGreaterThan(0);
      const event = (await auditEvents(server)).find((e) => e.action === 'chat.turn_completed' && String(e.orgId) === setupId);
      expect(event).toMatchObject({ actorRole: 'superadmin', actorEmail: STAFF_EMAIL, actorUserId: staff.userId });
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });

  it('open as admin: a used-up organization budget answers 409 chat_budget_exhausted', async () => {
    const { staff, orgId: setupId, locationId: staffLocation } = await openAsAdminOrg();
    try {
      await server.connection.collection('tw_chat_usage').insertOne({
        orgId: new Types.ObjectId(setupId), month: '2026-06', costMicroUsd: 20_000_000, updatedAt: server.clock.now(),
      });
      const refused = await turn({ content: 'Over budget' }, { session: staff, email: STAFF_EMAIL }, staffLocation);
      expect(refused).toMatchObject({ status: 409, error: 'chat_budget_exhausted' });
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });
});
