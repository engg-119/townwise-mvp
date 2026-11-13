// TownwiseAI's visuals and next questions (docs/portal/tuning-chat.md sections 2 to 4) against a scripted model
// (helpers/chat-model.ts): show_visual streams a `visual` event drawn from the location's stored days and its published
// forecast, and a reload replays it as a part; suggest_next streams a `suggestions` event and replays as the reply's
// `next`, and a message that calls only it ends the turn without another model call once text was written (before, its
// result asks for the answer); and neither a visual's figures nor a suggestion's text reaches a log or an audit event.
// Synthetic data only.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ConversationView } from '../src/handlers/chat.ts';
import { addLocation, addSalesDay, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { message, messagesOf, scriptedModel, text, thinking, toolUse, type ScriptedModel } from './helpers/chat-model.ts';
import { call, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

/** A published run (staff import, then publish): guests 80 to 120 on every open day from 2026-05-01 to 2026-05-14. */
const FORECAST = JSON.parse(readFileSync(new URL('fixtures/forecast-run.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const SHOWN = 'Shown to the owner under your reply. Describe it in a sentence or two; don’t repeat every figure.';
const SUGGESTED = 'Shown to the owner as three buttons.';
const UNANSWERED = 'Shown to the owner as three buttons. The owner has not seen an answer yet: they see only text you write, never your thinking. Write your answer to the owner now, as text.';
const THREE = ['Sentinel-next-one: how did Monday go?', 'Sentinel-next-two: any events soon?', 'Sentinel-next-three: show May'];

let server: TownwiseTestServer;
let model: ScriptedModel;
let orgId: string;
let locationId: string;
let author: TestSession;

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model });
  // G1 (#59): staff publish only for an organization whose forecasts are switched on.
  orgId = await createOrg(server, { name: 'Visual Tavern', forecastsOn: true });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
  const email = `author-${randomUUID().slice(0, 8)}@example.test`;
  author = await signIn(server, email);
  await addSeat(server, { orgId, userId: author.userId, email, role: 'member' });
  // Today in the town is 2026-06-01. May 3 has no row; May 4 is a closed day in the forecast.
  await addSalesDay(server, { orgId, locationId, date: '2026-05-01', guests: 137, netSalesCents: 482_913 });
  await addSalesDay(server, { orgId, locationId, date: '2026-05-02', guests: 151, netSalesCents: null });
  await addSalesDay(server, { orgId, locationId, date: '2026-05-05', guests: 98, netSalesCents: 251_077 });
  const staff = await signInStaff(server);
  const imported = await call(server, `/api/admin/orgs/${orgId}/locations/${locationId}/forecast-runs`, { session: staff, json: FORECAST });
  expect(imported.status).toBe(201);
  const { run } = await imported.json() as { run: { id: string } };
  expect((await call(server, `/api/admin/orgs/${orgId}/forecast-runs/${run.id}/publish`, { session: staff, json: {} })).status).toBe(200);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
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

async function turn(json: unknown): Promise<SseEvent[]> {
  const res = await call(server, `/api/org/locations/${locationId}/chat/turns`, { session: author, json });
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

/** The event names in order, with the consecutive `text` events folded into one. */
function shape(events: SseEvent[]): string[] {
  return events.map((e) => e.event).filter((name, i, all) => name !== 'text' || all[i - 1] !== 'text');
}

function eventData(events: SseEvent[], name: string): unknown[] {
  return events.filter((e) => e.event === name).map((e) => e.data);
}

function conversationIdOf(events: SseEvent[]): string {
  return (events[0]?.data as { id: string }).id;
}

async function view(id: string): Promise<ConversationView> {
  return await (await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: author })).json() as ConversationView;
}

async function storedParams(id: string): Promise<BetaMessageParam[]> {
  const doc = await server.connection.collection('tw_chat_conversations').findOne({ _id: new Types.ObjectId(id) });
  return (doc?.messages as { param: string }[]).map((m) => JSON.parse(m.param) as BetaMessageParam);
}

function toolResults(param: BetaMessageParam | undefined): BetaToolResultBlockParam[] {
  if (param === undefined || param.role === 'system' || typeof param.content === 'string') return [];
  return param.content.filter((block): block is BetaToolResultBlockParam => block.type === 'tool_result');
}

const MAY = { kind: 'daily', metric: 'guests', from: '2026-05-01', to: '2026-05-05', by: null, compare: null };
const band = { low: 80, high: 120 };
const MAY_GUESTS = {
  kind: 'daily', metric: 'guests', from: '2026-05-01', to: '2026-05-05',
  forecast: { model: 'Townwise demand model v9', madeAt: '2026-05-01' },
  days: [
    { date: '2026-05-01', value: 137, ...band }, { date: '2026-05-02', value: 151, ...band }, { date: '2026-05-03', value: null, ...band },
    { date: '2026-05-04', value: null, low: null, high: null }, { date: '2026-05-05', value: 98, ...band },
  ],
};

describe('show_visual', () => {
  it('show_visual streams a visual event with server figures, tool events with null views, and GET replays it as a part in order', async () => {
    model.script(
      { kind: 'message', message: message([thinking('sig-v'), text('Here is early May. '), toolUse('toolu_v1', 'show_visual', MAY)]) },
      { kind: 'message', message: message([text('The second was the busiest day.')]) },
    );
    const events = await turn({ content: 'How did early May go?' });
    expect(shape(events)).toEqual(['conversation', 'text', 'tool', 'visual', 'tool', 'text', 'done']);
    expect(eventData(events, 'visual')).toEqual([{ id: 'toolu_v1', visual: MAY_GUESTS }]);
    expect(eventData(events, 'tool')).toEqual([
      { id: 'toolu_v1', name: 'show_visual', state: 'running', input: null, result: null },
      { id: 'toolu_v1', name: 'show_visual', state: 'done', input: null, result: null },
    ]);
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { stopReason: 'end_turn' } });
    // The model reads the same figures, and what to do with them.
    const [result] = toolResults(messagesOf(model.calls[1]).at(-1));
    expect(result?.is_error).toBeUndefined();
    expect(JSON.parse(result?.content as string)).toEqual({ shown: SHOWN, visual: MAY_GUESTS });

    const { messages } = await view(conversationIdOf(events));
    expect(messages.at(-1)?.parts.map((p) => p.type)).toEqual(['text', 'visual', 'text']);
    expect(messages.at(-1)?.parts[1]).toEqual({ type: 'visual', id: 'toolu_v1', visual: MAY_GUESTS });
    expect(messages.at(-1)?.next).toBeNull();
  });

  it('a range with no sales shows nothing: no visual event, the model told why, a tool part with no views on reload', async () => {
    model.script(
      { kind: 'message', message: message([toolUse('toolu_v2', 'show_visual', { ...MAY, from: '2026-05-03', to: '2026-05-04' })]) },
      { kind: 'message', message: message([text('There are no sales for those days.')]) },
    );
    const events = await turn({ content: 'Show May 3 and 4.' });
    expect(shape(events)).toEqual(['conversation', 'tool', 'tool', 'text', 'done']);
    expect(JSON.parse(toolResults(messagesOf(model.calls[1]).at(-1))[0]?.content as string))
      .toEqual({ available: false, reason: 'No sales in this range, so nothing was shown.' });
    expect((await view(conversationIdOf(events))).messages.at(-1)?.parts).toEqual([
      { type: 'tool', id: 'toolu_v2', name: 'show_visual', state: 'done', input: null, result: null },
      { type: 'text', text: 'There are no sales for those days.' },
    ]);
  });

  it('an input past its kind’s limit is an is_error result the model can correct, with no visual', async () => {
    model.script(
      { kind: 'message', message: message([toolUse('toolu_v3', 'show_visual', { ...MAY, kind: 'days_table', metric: null, to: '2026-06-02' })]) },
      { kind: 'message', message: message([text('That range ends after today.')]) },
    );
    const events = await turn({ content: 'Show my days.' });
    expect(eventData(events, 'visual')).toEqual([]);
    expect(eventData(events, 'tool').map((e) => (e as { state: string }).state)).toEqual(['running', 'error']);
    expect(toolResults(messagesOf(model.calls[1]).at(-1))[0]).toMatchObject({ tool_use_id: 'toolu_v3', is_error: true });
  });
});

describe('suggest_next', () => {
  it('a reply whose last step is suggest_next alone ends without another model call; the prompts stream and replay as next', async () => {
    // Call 1: text and get_sales_days; call 2: text and suggest_next only; no call 3.
    model.script(
      { kind: 'message', message: message([text('Let me look. '), toolUse('toolu_s1', 'get_sales_days', { from: '2026-05-01', to: '2026-05-05' })]) },
      { kind: 'message', message: message([text('May started strong.'), toolUse('toolu_n1', 'suggest_next', { prompts: THREE })]) },
    );
    const events = await turn({ content: 'How did May start?' });
    expect(model.calls).toHaveLength(2);
    expect(shape(events)).toEqual(['conversation', 'text', 'tool', 'tool', 'text', 'tool', 'suggestions', 'tool', 'done']);
    expect(events.find((e) => e.event === 'suggestions')?.data).toEqual({ id: 'toolu_n1', prompts: THREE });
    expect(eventData(events, 'tool').slice(2)).toEqual([
      { id: 'toolu_n1', name: 'suggest_next', state: 'running', input: null, result: null },
      { id: 'toolu_n1', name: 'suggest_next', state: 'done', input: null, result: null },
    ]);
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { stopReason: 'end_turn' } });

    // The saved reply ends with suggest_next's result, so the stored history stays a valid request.
    const id = conversationIdOf(events);
    const stored = await storedParams(id);
    expect(stored).toHaveLength(5);
    expect(toolResults(stored[4])).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_n1', content: SUGGESTED }]);

    const { messages } = await view(id);
    expect(messages.at(-1)?.next).toEqual(THREE);
    expect(messages.at(0)?.next).toBeNull();
    expect(messages.at(-1)?.parts.map((p) => p.type)).toEqual(['text', 'tool', 'text']);
  });

  it('suggest_next alone before the turn wrote any text asks for the answer and the loop continues until it is written', async () => {
    // Call 1: get_sales_days; call 2: thinking and suggest_next only, no text; call 3: the answer.
    model.script(
      { kind: 'message', message: message([toolUse('toolu_u1', 'get_sales_days', { from: '2026-05-01', to: '2026-05-05' })]) },
      { kind: 'message', message: message([thinking('May started strong.'), toolUse('toolu_n8', 'suggest_next', { prompts: THREE })]) },
      { kind: 'message', message: message([text('May started strong.')]) },
    );
    const events = await turn({ content: 'How did May start?' });
    expect(model.calls).toHaveLength(3);
    expect(toolResults(messagesOf(model.calls[2]).at(-1))).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_n8', content: UNANSWERED }]);
    expect(eventData(events, 'suggestions')).toEqual([{ id: 'toolu_n8', prompts: THREE }]);
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { stopReason: 'end_turn' } });

    const id = conversationIdOf(events);
    const stored = await storedParams(id);
    expect(stored).toHaveLength(6);
    expect(stored[5]).toEqual({ role: 'assistant', content: [text('May started strong.')] });
    const { messages } = await view(id);
    expect(messages.at(-1)?.next).toEqual(THREE);
    expect(messages.at(-1)?.parts.at(-1)).toMatchObject({ type: 'text', text: 'May started strong.' });
  });

  it('suggest_next beside another tool runs both and the loop continues; an invalid suggest_next is an is_error result and no event', async () => {
    model.script(
      { kind: 'message', message: message([toolUse('toolu_n2', 'suggest_next', { prompts: THREE }), toolUse('toolu_l1', 'list_notes', {})]) },
      { kind: 'message', message: message([text('You have no notes yet.')]) },
    );
    const beside = await turn({ content: 'Any notes?' });
    expect(model.calls).toHaveLength(2);
    expect(eventData(beside, 'suggestions')).toEqual([{ id: 'toolu_n2', prompts: THREE }]);
    expect(toolResults(messagesOf(model.calls[1]).at(-1)).map((r) => [r.tool_use_id, r.is_error === true])).toEqual([
      ['toolu_n2', false], ['toolu_l1', false],
    ]);
    expect(beside.at(-1)).toMatchObject({ event: 'done', data: { stopReason: 'end_turn' } });
    expect((await view(conversationIdOf(beside))).messages.at(-1)?.next).toEqual(THREE);

    // Alone and invalid: an is_error result, no suggestions event, and still the reply's last step.
    model.calls.length = 0;
    model.script({ kind: 'message', message: message([text('Here you go.'), toolUse('toolu_n3', 'suggest_next', { prompts: ['Two?', 'Only?'] })]) });
    const invalid = await turn({ content: 'Thanks.' });
    expect(model.calls).toHaveLength(1);
    expect(eventData(invalid, 'suggestions')).toEqual([]);
    expect(eventData(invalid, 'tool')).toEqual([
      { id: 'toolu_n3', name: 'suggest_next', state: 'running', input: null, result: null },
      { id: 'toolu_n3', name: 'suggest_next', state: 'error', input: null, result: null },
    ]);
    expect(invalid.at(-1)).toMatchObject({ event: 'done', data: { stopReason: 'end_turn' } });
    const id = conversationIdOf(invalid);
    expect(toolResults((await storedParams(id)).at(-1))[0]).toMatchObject({ tool_use_id: 'toolu_n3', is_error: true });
    expect((await view(id)).messages.at(-1)?.next).toBeNull();
  });

  it('the next turn after a terminal suggest_next is a valid request: tool results, then the new message', async () => {
    model.script({ kind: 'message', message: message([text('Here is a start.'), toolUse('toolu_n4', 'suggest_next', { prompts: THREE })]) });
    const first = await turn({ content: 'Help me plan.' });
    const id = conversationIdOf(first);
    model.script({ kind: 'message', message: message([text('Monday was quiet.'), toolUse('toolu_n5', 'suggest_next', { prompts: THREE })]) });
    const second = await turn({ conversationId: id, content: THREE[0] });
    expect(second.at(-1)).toMatchObject({ event: 'done', data: { stopReason: 'end_turn' } });

    const sent = messagesOf(model.calls[1]);
    expect(sent).toHaveLength(4);
    expect(sent[1]).toEqual({ role: 'assistant', content: [text('Here is a start.'), toolUse('toolu_n4', 'suggest_next', { prompts: THREE })] });
    expect(sent[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_n4', content: SUGGESTED }] });
    expect(sent[3]).toEqual({ role: 'user', content: THREE[0] });
    // Each reply keeps its own next questions.
    expect((await view(id)).messages.map((m) => m.next)).toEqual([null, THREE, null, THREE]);
  });
});

describe('logs and audit events', () => {
  it('no figure from a visual and no suggestion text reaches a log or an audit event', async () => {
    server.logs.length = 0;
    const auditBefore = (await auditEvents(server)).length;
    model.script(
      { kind: 'message', message: message([
        toolUse('toolu_v5', 'show_visual', { kind: 'metrics', metric: 'net_sales', from: '2026-05-01', to: '2026-05-05', by: null, compare: 'previous_period' }),
        toolUse('toolu_v6', 'show_visual', { kind: 'days_table', metric: null, from: '2026-05-01', to: '2026-05-05', by: null, compare: null }),
      ]) },
      { kind: 'message', message: message([text('Net sales were steady.'), toolUse('toolu_n6', 'suggest_next', { prompts: THREE })]) },
    );
    const events = await turn({ content: 'What were my totals?' });
    // Net sales: $4,829.13 and $2,510.77, $7,339.90 in all.
    expect(eventData(events, 'visual')[0]).toMatchObject({ id: 'toolu_v5', visual: { total: 7339.9, dayCount: 2, dailyAverage: 3669.95 } });
    expect(eventData(events, 'suggestions')).toHaveLength(1);
    const audit = (await auditEvents(server)).slice(auditBefore);
    expect(audit.map((e) => e.action)).toEqual(['chat.turn_completed']);
    const everything = JSON.stringify(audit) + server.logs.join('\n');
    for (const secret of ['4829.13', '2510.77', '7339.9', '3669.95', '482913', '251077', 'Sentinel-next', 'shown to the owner', 'Shown to the owner']) {
      expect({ secret, found: everything.includes(secret) }).toEqual({ secret, found: false });
    }
    expect(server.logs.some((line) => line.includes('townwise.chat_turn'))).toBe(true);
  });
});
