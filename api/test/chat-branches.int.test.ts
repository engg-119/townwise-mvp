// Branch turns, version switches and renames (docs/portal/tuning-chat.md sections 2 and 3) against a scripted model
// (helpers/chat-model.ts): an edit is a send with `parentId`, a regenerate is `{ conversationId, replyTo }`, and a
// branch's request carries only its own path, byte for byte. POST .../active stores the version shown; PATCH renames.
import { randomUUID } from 'node:crypto';

import { InternalServerError } from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ChatSummary, ConversationView } from '../src/handlers/chat.ts';
import { addConversation, addGrant, addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { message, messagesOf, scriptedModel, text, thinking, type ScriptedModel } from './helpers/chat-model.ts';
import {
  call, limiterKey, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let model: ScriptedModel;
let orgId: string;
let locationId: string;
let author: TestSession;
let colleague: TestSession;

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model });
  orgId = await createOrg(server, { name: 'Branch Tavern' });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
  const person = async (name: string): Promise<TestSession> => {
    const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId, userId: session.userId, email, role: 'member' });
    return session;
  };
  author = await person('author');
  colleague = await person('colleague');
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.connection.collection('tw_chat_usage').deleteMany({});
  model.calls.length = 0;
});
afterEach(() => {
  expect(model.remaining()).toBe(0);
});

interface SseEvent { event: string; data: unknown }
interface ConversationEvent { id: string; title: string; userNodeId: string | null; replyNodeId: string; parentId: string | null }
interface DoneEvent { stopReason: string; costUsd: number; leafId: string | null }
interface Turn {
  status: number;
  error?: string;
  all: SseEvent[];
  conversation: ConversationEvent;
  done: DoneEvent;
}

function parseSse(body: string): SseEvent[] {
  return body.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return event === undefined || data === undefined ? [] : [{ event, data: JSON.parse(data) as unknown }];
  });
}

const turnsPath = (): string => `/api/org/locations/${locationId}/chat/turns`;
const conversationPath = (id: string): string => `/api/org/locations/${locationId}/chat/${id}`;

/** A turn: its `conversation` and `done` events when it streamed, else its JSON error. */
async function turn(json: unknown, who = author): Promise<Turn> {
  const res = await call(server, turnsPath(), { session: who, json });
  if (res.status !== 200) {
    const { error } = await res.json() as { error: string };
    return { status: res.status, error, all: [], conversation: {} as ConversationEvent, done: {} as DoneEvent };
  }
  const all = parseSse(await res.text());
  const of = (name: string): unknown => all.find((e) => e.event === name)?.data;
  return { status: 200, all, conversation: of('conversation') as ConversationEvent, done: of('done') as DoneEvent };
}

function reply(value: string): void {
  model.script({ kind: 'message', message: message([text(value)]) });
}

async function conversationDoc(id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_chat_conversations').findOne({ _id: new Types.ObjectId(id) });
}

interface RawMessage { at: Date; param: string; nodeId?: string; parentId?: string | null }

async function rawMessages(id: string): Promise<RawMessage[]> {
  return (await conversationDoc(id))?.messages as RawMessage[];
}

/** The stored params of these nodes, in stored order. */
async function storedParams(id: string, ...nodeIds: string[]): Promise<BetaMessageParam[]> {
  return (await rawMessages(id))
    .filter((m) => m.nodeId !== undefined && nodeIds.includes(m.nodeId))
    .map((m) => JSON.parse(m.param) as BetaMessageParam);
}

async function getConversation(id: string, query = '', session = author): Promise<ConversationView> {
  const res = await call(server, `${conversationPath(id)}${query}`, { session });
  expect(res.status).toBe(200);
  return await res.json() as ConversationView;
}

function showVersion(id: string, json: unknown, session = author): Promise<Response> {
  return call(server, `${conversationPath(id)}/active`, { session, json });
}

function rename(id: string, json: unknown, session = author): Promise<Response> {
  return call(server, conversationPath(id), { method: 'PATCH', session, json });
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

interface Three { id: string; u1: string; a1: string; u2: string; a2: string; u3: string; a3: string }

/** Three turns, u1 a1 u2 a2 u3 a3: "first", "reply 1", "second", "reply 2", "third", "reply 3". */
async function threeTurns(): Promise<Three> {
  reply('reply 1');
  const one = await turn({ content: 'first' });
  const id = one.conversation.id;
  reply('reply 2');
  const two = await turn({ conversationId: id, content: 'second' });
  reply('reply 3');
  const three = await turn({ conversationId: id, content: 'third' });
  const [u1 = '', a1 = '', u2 = '', a2 = '', u3 = '', a3 = ''] = [one, two, three]
    .flatMap((t) => [t.conversation.userNodeId ?? '', t.conversation.replyNodeId]);
  return { id, u1, a1, u2, a2, u3, a3 };
}

describe('branch turns', () => {
  it('a send with parentId forks: the request carries only that path, and the new nodes hang under it', async () => {
    const t = await threeTurns();
    reply('reply edited');
    const events = await turn({ conversationId: t.id, content: 'second, edited', parentId: t.a1 });
    expect(messagesOf(model.calls.at(-1))).toEqual([...await storedParams(t.id, t.u1, t.a1), { role: 'user', content: 'second, edited' }]);
    expect(events.conversation).toMatchObject({
      id: t.id, title: 'first', parentId: t.a1, userNodeId: expect.any(String) as unknown, replyNodeId: expect.any(String) as unknown,
    });
    expect(events.done).toMatchObject({ stopReason: 'end_turn', leafId: events.conversation.replyNodeId });
    const view = await getConversation(t.id);
    expect(view.messages.map((m) => m.text)).toEqual(['first', 'reply 1', 'second, edited', 'reply edited']);
    expect(view.activeLeafId).toBe(events.conversation.replyNodeId);
    expect(view.tree.filter((n) => n.parentId === t.a1).map((n) => n.role)).toEqual(['user', 'user']);
    // Every message the turn wrote carries its node and that node's parent.
    const written = (await rawMessages(t.id)).slice(6).map(({ nodeId, parentId }) => ({ nodeId, parentId }));
    expect(written).toEqual([
      { nodeId: events.conversation.userNodeId, parentId: t.a1 },
      { nodeId: events.conversation.replyNodeId, parentId: events.conversation.userNodeId },
    ]);
    expect((await conversationDoc(t.id))?.turnCount).toBe(4);
  });

  it('editing the first message sends parentId null and starts a second root', async () => {
    const t = await threeTurns();
    reply('reply 1b');
    const events = await turn({ conversationId: t.id, content: 'first, edited', parentId: null });
    expect(messagesOf(model.calls.at(-1))).toEqual([{ role: 'user', content: 'first, edited' }]);
    expect(events.conversation).toMatchObject({ id: t.id, title: 'first', parentId: null });
    const view = await getConversation(t.id);
    expect(view.messages.map((m) => m.text)).toEqual(['first, edited', 'reply 1b']);
    expect(view.tree.filter((n) => n.parentId === null).map((n) => n.id)).toEqual([t.u1, events.conversation.userNodeId]);
  });

  it('a regenerate adds a sibling reply under the same message and sends no new user message', async () => {
    const t = await threeTurns();
    const stored = await rawMessages(t.id);
    reply('reply 3b');
    const events = await turn({ conversationId: t.id, replyTo: t.u3 });
    expect(messagesOf(model.calls.at(-1))).toEqual(await storedParams(t.id, t.u1, t.a1, t.u2, t.a2, t.u3));
    expect(messagesOf(model.calls.at(-1)).at(-1)).toEqual((await storedParams(t.id, t.u3)).at(-1));
    expect(events.conversation).toMatchObject({ id: t.id, userNodeId: null, parentId: t.u3 });
    expect(events.done.leafId).toBe(events.conversation.replyNodeId);
    const view = await getConversation(t.id);
    expect(view.tree.filter((n) => n.parentId === t.u3)).toHaveLength(2);
    expect(view.messages.map((m) => m.text)).toEqual(['first', 'reply 1', 'second', 'reply 2', 'third', 'reply 3b']);
    // Only the reply was written.
    const after = await rawMessages(t.id);
    expect(after.slice(0, stored.length)).toEqual(stored);
    expect(after.slice(stored.length).map(({ nodeId, parentId }) => ({ nodeId, parentId })))
      .toEqual([{ nodeId: events.conversation.replyNodeId, parentId: t.u3 }]);
  });

  it('editing a legacy conversation’s second message sends the stored prefix byte for byte', async () => {
    const at = server.clock.now();
    const legacyId = new Types.ObjectId();
    const params: BetaMessageParam[] = [
      { role: 'user', content: 'Legacy first' },
      { role: 'assistant', content: [thinking('sig-legacy/opaque=='), text('Legacy reply')] },
      { role: 'user', content: 'Legacy second' },
      { role: 'assistant', content: [text('Legacy reply 2')] },
    ];
    await server.connection.collection('tw_chat_conversations').insertOne({
      _id: legacyId, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), userId: author.userId,
      title: 'Legacy first', messages: params.map((param) => ({ at, param: JSON.stringify(param) })),
      turnCount: 2, liveTurn: null, createdAt: at, updatedAt: at,
    });
    const id = legacyId.toHexString();
    // And the stored array only grows.
    const before = await rawMessages(id);
    reply('reply');
    const events = await turn({ conversationId: id, content: 'edited', parentId: 'legacy-1' });
    const sent = messagesOf(model.calls.at(-1));
    expect(JSON.stringify(sent.slice(0, 2))).toBe(JSON.stringify(before.slice(0, 2).map((m) => JSON.parse(m.param) as unknown)));
    expect(sent.slice(2)).toEqual([{ role: 'user', content: 'edited' }]);
    expect((await rawMessages(id)).slice(0, before.length)).toEqual(before);
    expect(events.conversation.parentId).toBe('legacy-1');
    const view = await getConversation(id);
    expect(view.messages.map((m) => m.text)).toEqual(['Legacy first', 'Legacy reply', 'edited', 'reply']);
    expect(view.tree.map((n) => [n.id, n.parentId])).toEqual([
      ['legacy-0', null], ['legacy-1', 'legacy-0'], ['legacy-2', 'legacy-1'], ['legacy-3', 'legacy-2'],
      [events.conversation.userNodeId, 'legacy-1'], [events.conversation.replyNodeId, events.conversation.userNodeId],
    ]);
  });

  it('a send without parentId appends to the stored active leaf, as an older client does', async () => {
    const t = await threeTurns();
    reply('reply edited');
    const edit = await turn({ conversationId: t.id, content: 'second, edited', parentId: t.a1 });
    const { userNodeId, replyNodeId } = edit.conversation;
    if (userNodeId === null) throw new Error('no user node');
    reply('reply 3 on the edit');
    const next = await turn({ conversationId: t.id, content: 'third, after the edit' });
    expect(messagesOf(model.calls.at(-1))).toEqual([
      ...await storedParams(t.id, t.u1, t.a1, userNodeId, replyNodeId), { role: 'user', content: 'third, after the edit' },
    ]);
    expect(next.conversation.parentId).toBe(replyNodeId);
    expect((await getConversation(t.id)).messages.map((m) => m.text))
      .toEqual(['first', 'reply 1', 'second, edited', 'reply edited', 'third, after the edit', 'reply 3 on the edit']);
  });

  it('a reply with no content stores the user node only; done.leafId is that node, and a regenerate under it works', async () => {
    model.script({ kind: 'message', message: message([]) });
    const silent = await turn({ content: 'Say nothing' });
    const { id, userNodeId } = silent.conversation;
    expect(userNodeId).toEqual(expect.any(String));
    expect(silent.done).toMatchObject({ stopReason: 'end_turn', leafId: userNodeId });
    expect((await rawMessages(id)).map(({ nodeId, parentId }) => ({ nodeId, parentId }))).toEqual([{ nodeId: userNodeId, parentId: null }]);
    expect((await getConversation(id)).activeLeafId).toBe(userNodeId);

    reply('Now something');
    const again = await turn({ conversationId: id, replyTo: userNodeId });
    expect(messagesOf(model.calls.at(-1))).toEqual([{ role: 'user', content: 'Say nothing' }]);
    expect(again.done.leafId).toBe(again.conversation.replyNodeId);
    const view = await getConversation(id);
    expect(view.messages.map((m) => m.text)).toEqual(['Say nothing', 'Now something']);
    expect(view.activeLeafId).toBe(again.conversation.replyNodeId);
  });

  it('refuses an unknown parentId or replyTo with 404, replyTo naming a reply with 404, and mixed bodies with 400, before any model call', async () => {
    const t = await threeTurns();
    const before = await conversationDoc(t.id);
    const callsBefore = model.calls.length;
    for (const json of [
      { conversationId: t.id, content: 'x', parentId: 'unknown-node' },
      { conversationId: t.id, replyTo: 'unknown-node' },
      { conversationId: t.id, replyTo: t.a1 },
      { conversationId: new Types.ObjectId().toHexString(), replyTo: t.u1 },
    ]) {
      expect(await turn(json)).toMatchObject({ status: 404, error: 'not_found' });
    }
    // Another person's conversation stays 404 whatever the body names.
    expect(await turn({ conversationId: t.id, replyTo: t.u1 }, colleague)).toMatchObject({ status: 404, error: 'not_found' });
    expect(await turn({ conversationId: t.id, content: 'x', parentId: t.a1 }, colleague)).toMatchObject({ status: 404, error: 'not_found' });
    for (const json of [
      { conversationId: t.id, content: 'x', replyTo: t.u1 },
      { content: 'x', parentId: t.a1 },
      { content: 'x', parentId: null },
      { replyTo: t.u1 },
      { conversationId: t.id, content: 'x', parentId: 'bad id' },
      { conversationId: t.id, replyTo: 'bad id' },
      { conversationId: t.id, content: 'x', parentId: 42 },
      { conversationId: t.id, content: 'x', extra: true },
    ]) {
      expect({ json, ...(await turn(json)) }).toMatchObject({ json, status: 400, error: 'invalid_request' });
    }
    expect(model.calls).toHaveLength(callsBefore);
    expect(await conversationDoc(t.id)).toEqual(before);
    expect(await server.connection.collection('tw_chat_live_turns').countDocuments({})).toBe(0);
  });

  it('edits and regenerates count as turns: 409 conversation_full at 40, 409 chat_budget_exhausted, 409 chat_turn_in_progress, the chat limiter', async () => {
    const full = await addConversation(server, { orgId, locationId, userId: author.userId, text: 'Full', turnCount: 40 });
    expect(await turn({ conversationId: full, content: 'x', parentId: 'legacy-1' })).toMatchObject({ status: 409, error: 'conversation_full' });
    expect(await turn({ conversationId: full, replyTo: 'legacy-0' })).toMatchObject({ status: 409, error: 'conversation_full' });

    // An edit is the 40th turn; the regenerate after it finds the conversation full.
    const almost = await addConversation(server, { orgId, locationId, userId: author.userId, text: 'Almost', turnCount: 39 });
    reply('The 40th.');
    expect((await turn({ conversationId: almost, content: 'Edited', parentId: null })).status).toBe(200);
    expect((await conversationDoc(almost))?.turnCount).toBe(40);
    expect(await turn({ conversationId: almost, replyTo: 'legacy-0' })).toMatchObject({ status: 409, error: 'conversation_full' });

    const open = await addConversation(server, { orgId, locationId, userId: author.userId, text: 'Open' });
    // The month's budget (20 dollars) is spent; the edit above already started the month's record.
    await server.connection.collection('tw_chat_usage').updateOne(
      { orgId: new Types.ObjectId(orgId), month: server.clock.now().toISOString().slice(0, 7) },
      { $set: { costMicroUsd: 20_000_000, updatedAt: server.clock.now() } },
      { upsert: true },
    );
    expect(await turn({ conversationId: open, content: 'x', parentId: 'legacy-1' })).toMatchObject({ status: 409, error: 'chat_budget_exhausted' });
    expect(await turn({ conversationId: open, replyTo: 'legacy-0' })).toMatchObject({ status: 409, error: 'chat_budget_exhausted' });
    await server.connection.collection('tw_chat_usage').deleteMany({});

    // One live turn per person, whichever kind.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.script({ kind: 'message', message: message([text('Slow.')]), gate });
    const slow = await call(server, turnsPath(), { session: author, json: { conversationId: open, content: 'Slow one' } });
    expect(slow.status).toBe(200);
    const other = await addConversation(server, { orgId, locationId, userId: author.userId, text: 'Other' });
    expect(await turn({ conversationId: open, replyTo: 'legacy-0' })).toMatchObject({ status: 409, error: 'chat_turn_in_progress' });
    expect(await turn({ conversationId: other, content: 'x', parentId: null })).toMatchObject({ status: 409, error: 'chat_turn_in_progress' });
    release();
    expect(parseSse(await slow.text()).at(-1)?.event).toBe('done');

    await server.redis.set(limiterKey('townwise:chat', author.userId), '60', 'EX', 3600);
    expect(await turn({ conversationId: open, content: 'x', parentId: 'legacy-1' })).toMatchObject({ status: 429, error: 'rate_limited' });
    expect(await turn({ conversationId: open, replyTo: 'legacy-0' })).toMatchObject({ status: 429, error: 'rate_limited' });
    expect(model.calls).toHaveLength(2);
  });

  it('a refused or failed branch saves nothing and leaves the active leaf as it was', async () => {
    const t = await threeTurns();
    const before = await conversationDoc(t.id);
    model.script({ kind: 'message', message: message([text('I can’t help')], { stopReason: 'refusal' }) });
    const refused = await turn({ conversationId: t.id, content: 'Refuse this edit', parentId: t.a1 });
    expect(refused.done).toMatchObject({ stopReason: 'refusal', leafId: null });
    expect(await conversationDoc(t.id)).toEqual(before);

    model.script({
      kind: 'error', error: new InternalServerError(500, { type: 'error', error: { type: 'api_error', message: 'Down' } }, undefined, new Headers(), 'api_error'),
    });
    const failed = await turn({ conversationId: t.id, replyTo: t.u3 });
    expect(failed.all.at(-1)).toEqual({ event: 'error', data: { code: 'provider_unavailable' } });
    expect(await conversationDoc(t.id)).toEqual(before);
    expect((await getConversation(t.id)).activeLeafId).toBe(t.a3);
  });
});

describe('POST .../chat/:conversationId/active', () => {
  it('stores the newest leaf under a node and answers its path; a turn’s finish later sets the leaf to its reply', async () => {
    const t = await threeTurns();
    reply('reply edited');
    const edit = await turn({ conversationId: t.id, content: 'second, edited', parentId: t.a1 });
    const updatedAt = (await getConversation(t.id)).updatedAt;
    // A switch is display state: it leaves updatedAt, so the conversation keeps its place in the list.
    server.clock.advance(MINUTE);

    const switched = await showVersion(t.id, { nodeId: t.u2 });
    expect(switched.status).toBe(200);
    const view = await switched.json() as ConversationView;
    expect(view).toMatchObject({ id: t.id, title: 'first', updatedAt, activeLeafId: t.a3 });
    expect(view.messages.map((m) => m.text)).toEqual(['first', 'reply 1', 'second', 'reply 2', 'third', 'reply 3']);
    expect(view).toEqual(await getConversation(t.id));
    expect((await conversationDoc(t.id))?.activeLeafId).toBe(t.a3);

    // From the root, each node's newest child: the edit.
    expect((await (await showVersion(t.id, { nodeId: t.u1 })).json() as ConversationView).activeLeafId).toBe(edit.conversation.replyNodeId);

    expect(await errorOf(await showVersion(t.id, { nodeId: 'unknown-node' }))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await showVersion(new Types.ObjectId().toHexString(), { nodeId: t.u1 }))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await showVersion(t.id, { nodeId: t.u2 }, colleague))).toEqual({ status: 404, error: 'not_found' });
    for (const json of [{}, { nodeId: 'bad id' }, { nodeId: t.u2, extra: 1 }, { nodeId: 7 }]) {
      expect(await errorOf(await showVersion(t.id, json))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await errorOf(await showVersion('nope', { nodeId: t.u2 }))).toEqual({ status: 400, error: 'invalid_request' });

    await showVersion(t.id, { nodeId: t.u2 });
    const list = await (await call(server, `/api/org/locations/${locationId}/chat`, { session: author })).json() as ChatSummary;
    expect(list.conversations.find((c) => c.id === t.id)?.updatedAt).toBe(updatedAt);

    reply('reply 3b');
    const regenerated = await turn({ conversationId: t.id, replyTo: t.u3 });
    expect((await getConversation(t.id)).activeLeafId).toBe(regenerated.conversation.replyNodeId);
  });
});

describe('PATCH .../chat/:conversationId', () => {
  it('PATCH renames without moving the conversation in the list; 1 to 60 characters; another person’s is 404', async () => {
    const older = await addConversation(server, { orgId, locationId, userId: author.userId, text: 'Older' });
    server.clock.advance(MINUTE);
    const newer = await addConversation(server, { orgId, locationId, userId: author.userId, text: 'Newer' });
    const listed = async (): Promise<ChatSummary['conversations']> =>
      (await (await call(server, `/api/org/locations/${locationId}/chat`, { session: author })).json() as ChatSummary).conversations
        .filter((c) => c.id === older || c.id === newer);
    const before = await listed();
    expect(before.map((c) => c.id)).toEqual([newer, older]);
    const eventsBefore = (await auditEvents(server)).length;
    server.clock.advance(MINUTE);

    const res = await rename(older, { title: '  Spring menu   ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: older, title: 'Spring menu' });
    expect(await listed()).toEqual(before.map((c) => (c.id === older ? { ...c, title: 'Spring menu' } : c)));
    expect((await getConversation(older)).title).toBe('Spring menu');
    expect((await auditEvents(server)).length).toBe(eventsBefore);

    // 60 code points, each two UTF-16 units, is fine; 61 is not.
    const sixty = '🍺'.repeat(60);
    expect(await (await rename(older, { title: sixty })).json()).toEqual({ id: older, title: sixty });
    for (const json of [
      { title: '🍺'.repeat(61) }, { title: '' }, { title: '   ' }, { title: 'Bell\u0007' }, { title: 'Two\nlines' }, { title: 'Tab\there' },
      { title: 'Delete\u007f' }, { title: 7 }, {}, { title: 'Fine', extra: true },
    ]) {
      expect({ json, ...(await errorOf(await rename(older, json))) }).toEqual({ json, status: 400, error: 'invalid_request' });
    }
    expect(await errorOf(await rename(older, { title: 'Mine now' }, colleague))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await rename(new Types.ObjectId().toHexString(), { title: 'Nobody' }))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await rename('nope', { title: 'Nope' }))).toEqual({ status: 400, error: 'invalid_request' });
    expect((await getConversation(older)).title).toBe(sixty);
  });
});

describe('view-as', () => {
  it('staff in view-as read ?node= versions and cannot switch, rename or branch (403 view_as_read_only)', async () => {
    const t = await threeTurns();
    reply('reply edited');
    const edit = await turn({ conversationId: t.id, content: 'second, edited', parentId: t.a1 });
    const before = await conversationDoc(t.id);
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: author.userId, orgId });
      const original = await getConversation(t.id, `?node=${t.u2}`, staff);
      expect(original.messages.map((m) => m.text)).toEqual(['first', 'reply 1', 'second', 'reply 2', 'third', 'reply 3']);
      expect((await getConversation(t.id, '', staff)).activeLeafId).toBe(edit.conversation.replyNodeId);
      const refused = { status: 403, error: 'view_as_read_only' };
      expect(await errorOf(await showVersion(t.id, { nodeId: t.u2 }, staff))).toEqual(refused);
      expect(await errorOf(await rename(t.id, { title: 'Staff title' }, staff))).toEqual(refused);
      expect(await turn({ conversationId: t.id, content: 'As staff', parentId: t.a1 }, staff)).toMatchObject(refused);
      expect(await turn({ conversationId: t.id, replyTo: t.u3 }, staff)).toMatchObject(refused);
      expect(await conversationDoc(t.id)).toEqual(before);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });
});

describe('logs and audit events', () => {
  it('no message text, title or node content reaches a log or an audit event', async () => {
    server.logs.length = 0;
    reply('Sentinel-reply-one');
    const first = await turn({ content: 'Sentinel-question-one' });
    const { id, userNodeId } = first.conversation;
    if (userNodeId === null) throw new Error('no user node');
    reply('Sentinel-reply-edit');
    await turn({ conversationId: id, content: 'Sentinel-question-edit', parentId: null });
    reply('Sentinel-reply-again');
    await turn({ conversationId: id, replyTo: userNodeId });
    expect((await showVersion(id, { nodeId: userNodeId })).status).toBe(200);
    expect((await rename(id, { title: 'Sentinel-title' })).status).toBe(200);

    const everything = JSON.stringify(await auditEvents(server)) + server.logs.join('\n');
    for (const sentinel of ['Sentinel-question', 'Sentinel-reply', 'Sentinel-title', 'Taproom']) expect(everything).not.toContain(sentinel);
    expect(server.logs.filter((line) => line.includes('townwise.chat_turn'))).toHaveLength(3);
  });
});
