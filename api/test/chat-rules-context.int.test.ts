// Business rules reach TownwiseAI (spec 10.16, docs/portal/tuning-chat.md section 3) against a scripted model
// (helpers/chat-model.ts): the person's message carries a business_rules block only when the location's rules differ from
// the last block on the turn's path. With no rules nothing is added, so the request is byte for byte what it was before
// rules existed. The block is stored with the message, never shown back as the person's text.
import { randomUUID } from 'node:crypto';

import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { rulesBlock } from '../src/chat/user-message.ts';
import type { ConversationView } from '../src/handlers/chat.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { message, messagesOf, scriptedModel, text, type ScriptedModel } from './helpers/chat-model.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
let model: ScriptedModel;
let orgId: string;
let author: TestSession;
let locationId: string;

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model });
  orgId = await createOrg(server, { name: 'Rules Context Tavern' });
  const email = `author-${randomUUID().slice(0, 8)}@example.test`;
  author = await signIn(server, email);
  await addSeat(server, { orgId, userId: author.userId, email, role: 'member' });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.connection.collection('tw_chat_usage').deleteMany({});
  model.calls.length = 0;
  // Each case starts at its own location, with no rules.
  locationId = await addLocation(server, { orgId, name: `Taproom ${randomUUID().slice(0, 8)}` });
});
afterEach(() => {
  expect(model.remaining()).toBe(0);
});

interface Turn { id: string; userNodeId: string | null; replyNodeId: string }

function parseSse(body: string): { event: string; data: unknown }[] {
  return body.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return event === undefined || data === undefined ? [] : [{ event, data: JSON.parse(data) as unknown }];
  });
}

/** One turn answered "Noted.": its conversation event. */
async function turn(json: unknown): Promise<Turn> {
  model.script({ kind: 'message', message: message([text('Noted.')]) });
  const res = await call(server, `/api/org/locations/${locationId}/chat/turns`, { session: author, json });
  expect(res.status).toBe(200);
  const events = parseSse(await res.text());
  expect(events.at(-1)?.event).toBe('done');
  return events.find((e) => e.event === 'conversation')?.data as Turn;
}

/** The person's message in the last request. */
function sentUserMessage(): BetaMessageParam | undefined {
  return messagesOf(model.calls.at(-1)).at(-1);
}

async function addRule(ruleText: string): Promise<string> {
  const res = await call(server, `/api/org/locations/${locationId}/rules`, { session: author, json: { text: ruleText } });
  expect(res.status).toBe(201);
  return (await res.json() as { rule: { id: string } }).rule.id;
}

async function rawParams(id: string): Promise<string[]> {
  const doc = await server.connection.collection('tw_chat_conversations').findOne({ _id: new Types.ObjectId(id) });
  return (doc?.messages as { param: string }[]).map((m) => m.param);
}

const withBlock = (rules: readonly string[], content: string): BetaMessageParam => ({
  role: 'user', content: [{ type: 'text', text: rulesBlock(rules) }, { type: 'text', text: content }],
});

describe('business rules in the person\'s message', () => {
  it('with no rules, the request\'s person message is the plain string, as before', async () => {
    const first = await turn({ content: 'Are we busy Friday?' });
    expect(messagesOf(model.calls.at(-1))).toEqual([{ role: 'user', content: 'Are we busy Friday?' }]);
    await turn({ conversationId: first.id, content: 'And Saturday?' });
    expect(sentUserMessage()).toEqual({ role: 'user', content: 'And Saturday?' });
    expect((await rawParams(first.id)).join('')).not.toContain('business_rules');
  });

  it('the first message of a conversation carries the rules block, and the next message with unchanged rules carries none', async () => {
    await addRule('Closed Mondays');
    await addRule('Patio opens in May');
    const first = await turn({ content: 'Are we open Monday?' });
    expect(messagesOf(model.calls.at(-1))).toEqual([withBlock(['Closed Mondays', 'Patio opens in May'], 'Are we open Monday?')]);
    await turn({ conversationId: first.id, content: 'And the patio?' });
    expect(sentUserMessage()).toEqual({ role: 'user', content: 'And the patio?' });
    // The stored first message keeps its block, so the next request's prefix is the same.
    expect(messagesOf(model.calls.at(-1))[0]).toEqual(withBlock(['Closed Mondays', 'Patio opens in May'], 'Are we open Monday?'));
  });

  it('after a rule is edited, the next message carries the new list, and the stored history before it is byte for byte unchanged', async () => {
    const ruleId = await addRule('Closed Mondays');
    const first = await turn({ content: 'Are we open Monday?' });
    const before = await rawParams(first.id);
    const res = await call(server, `/api/org/locations/${locationId}/rules/${ruleId}`, {
      method: 'PATCH', session: author, json: { text: 'Closed Mondays and Tuesdays' },
    });
    expect(res.status).toBe(200);
    await turn({ conversationId: first.id, content: 'And Tuesday?' });
    const sent = messagesOf(model.calls.at(-1));
    expect(sent.at(-1)).toEqual(withBlock(['Closed Mondays and Tuesdays'], 'And Tuesday?'));
    expect(sent.slice(0, before.length).map((param) => JSON.stringify(param))).toEqual(before);
    expect((await rawParams(first.id)).slice(0, before.length)).toEqual(before);
  });

  it('deleting every rule sends the \'no business rules now\' block once', async () => {
    const ruleId = await addRule('Closed Mondays');
    const first = await turn({ content: 'Are we open Monday?' });
    const res = await call(server, `/api/org/locations/${locationId}/rules/${ruleId}`, { method: 'DELETE', session: author });
    expect(res.status).toBe(204);
    await turn({ conversationId: first.id, content: 'What about now?' });
    expect(sentUserMessage()).toEqual(withBlock([], 'What about now?'));
    expect(rulesBlock([])).toContain('There are no business rules for this location now.');
    await turn({ conversationId: first.id, content: 'And now?' });
    expect(sentUserMessage()).toEqual({ role: 'user', content: 'And now?' });
  });

  it('a regenerate resends the stored message with its block and adds none', async () => {
    await addRule('Closed Mondays');
    const first = await turn({ content: 'Are we open Monday?' });
    await addRule('Brunch only on weekends');
    if (first.userNodeId === null) throw new Error('no user node');
    await turn({ conversationId: first.id, replyTo: first.userNodeId });
    expect(messagesOf(model.calls.at(-1))).toEqual([withBlock(['Closed Mondays'], 'Are we open Monday?')]);
  });

  it('GET .../chat/:conversationId shows the person\'s text without the block', async () => {
    await addRule('Closed Mondays');
    const first = await turn({ content: 'Are we open Monday?' });
    const res = await call(server, `/api/org/locations/${locationId}/chat/${first.id}`, { session: author });
    expect(res.status).toBe(200);
    const view = await res.json() as ConversationView;
    expect(view.messages.map((m) => m.text)).toEqual(['Are we open Monday?', 'Noted.']);
    expect(view.title).toBe('Are we open Monday?');
    expect(JSON.stringify(view)).not.toContain('Closed Mondays');
  });
});
