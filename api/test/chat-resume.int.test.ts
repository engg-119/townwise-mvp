// Resumable TownwiseAI turns (openspec change resumable-chat-turns) against a scripted model: a turn runs on the
// replica's turn runner whatever its connection does, its numbered events are kept in tw_chat_turns as the POST streams
// them, and it ends the same way as before (saved, refused, timed out, out of budget or failed), now also on its record.
// A replica shutting down takes no new turn and settles its running ones as interrupted. A second instance on the same
// database stands for the other replica: it serves the reads, the tail and the stop of a turn running on the first, and
// runs the turns that a test holds open for longer.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { InternalServerError } from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ChatSummary, ConversationView } from '../src/handlers/chat.ts';
import { addChatTurn, addConversation, addGrant, addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { eventsOf, message, scriptedModel, text, toolUse, type ScriptedModel } from './helpers/chat-model.ts';
import {
  call, removeStaffFactor, sharedAuthKeys, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let model: ScriptedModel;
/** The other replica, on the same database, with its own model and a 10-second turn. */
let other: TownwiseTestServer;
let otherModel: ScriptedModel;
let orgId: string;
let locationId: string;
let session: TestSession;

beforeAll(async () => {
  model = scriptedModel();
  otherModel = scriptedModel();
  const env = sharedAuthKeys();
  // Long enough for every turn here to finish, short enough for the timeout case.
  server = await startTownwiseServer({ env, chat: model, chatTurnTimeLimitMs: 1500 });
  other = await startTownwiseServer({ env, keepData: true, chat: otherModel, chatTurnTimeLimitMs: 10_000 });
  orgId = await createOrg(server, { name: 'Resume Tavern' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
});
afterAll(async () => {
  await other.close();
  await server.close();
});
beforeEach(async () => {
  await server.redis.flushdb();
  await server.connection.collection('tw_chat_usage').deleteMany({});
  model.calls.length = 0;
  otherModel.calls.length = 0;
});
afterEach(() => {
  expect(model.remaining()).toBe(0);
  expect(otherModel.remaining()).toBe(0);
});

interface SseEvent { id: number | null; event: string; data: unknown }

function parseSse(body: string): SseEvent[] {
  return body.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
    const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return event === undefined || data === undefined ? [] : [{ id: id === undefined ? null : Number(id), event, data: JSON.parse(data) as unknown }];
  });
}

const turnsPath = (): string => `/api/org/locations/${locationId}/chat/turns`;

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error('condition not reached');
}

interface StoredTurn { state: string; turnId: string; eventCount: number; events: { seq: number; type: string; data: unknown }[]; [key: string]: unknown }

async function record(turnId: string): Promise<StoredTurn | null> {
  return server.connection.collection<StoredTurn>('tw_chat_turns').findOne({ turnId });
}

async function conversationDoc(id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_chat_conversations').findOne({ _id: new Types.ObjectId(id) });
}

/** A turn read to its end: its events, numbered. */
async function turn(json: unknown): Promise<SseEvent[]> {
  const res = await call(server, turnsPath(), { session, json });
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

const conversationOf = (events: SseEvent[]): { id: string; turnId: string } => events[0]?.data as { id: string; turnId: string };

/** The record's events as the stream shows them. */
const asStream = (stored: StoredTurn | null): SseEvent[] => (stored?.events ?? []).map((each) => ({ id: each.seq, event: each.type, data: each.data }));

const chatPath = (): string => `/api/org/locations/${locationId}/chat`;

async function getJson<T>(on: TownwiseTestServer, path: string, as: TestSession = session): Promise<T> {
  const res = await call(on, path, { session: as });
  expect(res.status).toBe(200);
  return await res.json() as T;
}

interface Nodes { userNodeId: string | null; replyNodeId: string }
const nodesOf = (events: SseEvent[]): Nodes => events[0]?.data as Nodes;

interface Held { turnId: string; conversationId: string; userNodeId: string | null; replyNodeId: string; release: () => void; body: Promise<SseEvent[]> }

/** A turn sent to the other instance and held at its model call until `release`: its record is in and running. */
async function holdTurn(json: unknown, reply: string): Promise<Held> {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // A later start than the conversation's earlier turns, whose records are still kept: the clocks are frozen otherwise.
  for (const each of [server, other]) each.clock.advance(1000);
  otherModel.script({ kind: 'message', message: message([text(reply)]), gate });
  const res = await call(other, turnsPath(), { session, json });
  expect(res.status).toBe(200);
  const body = res.text().then(parseSse);
  let found: StoredTurn | null = null;
  await until(async () => {
    found = await server.connection.collection<StoredTurn>('tw_chat_turns').findOne({ userId: session.userId, state: 'running' });
    return (found?.eventCount ?? 0) >= 1;
  });
  const held = found as unknown as StoredTurn & { conversationId: Types.ObjectId; userNodeId: string | null; replyNodeId: string };
  return {
    turnId: held.turnId, conversationId: held.conversationId.toHexString(), userNodeId: held.userNodeId, replyNodeId: held.replyNodeId,
    release, body,
  };
}

const tailPath = (conversationId: string, turnId: string, after?: string): string =>
  `${chatPath()}/${conversationId}/turns/${turnId}${after === undefined ? '' : `?after=${after}`}`;

/** A tail read to its end. */
async function tail(on: TownwiseTestServer, path: string, as: TestSession = session): Promise<SseEvent[]> {
  const res = await call(on, path, { session: as });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  return parseSse(await res.text());
}

async function statusOf(on: TownwiseTestServer, path: string, as: TestSession = session): Promise<{ status: number; error: unknown }> {
  const res = await call(on, path, { session: as });
  return { status: res.status, error: ((await res.json()) as { error?: unknown }).error };
}

/** A conversation of the author with a running record whose lease has passed, holding one stored event. */
async function lapsedTurn(): Promise<{ id: string; turnId: string }> {
  const id = await addConversation(server, { orgId, locationId, userId: session.userId, text: 'Earlier question' });
  const turnId = await addChatTurn(server, { orgId, locationId, conversationId: id, userId: session.userId });
  await server.connection.collection('tw_chat_turns').updateOne({ turnId }, { $set: { leaseUntil: new Date(server.clock.now().getTime() - 1000) } });
  return { id, turnId };
}

const liveTurns = (): Promise<number> => server.connection.collection('tw_chat_live_turns').countDocuments({ orgId: new Types.ObjectId(orgId) });

describe('a turn and its record', () => {
  it('numbers every event of the stream as its record stores it, and keeps the person’s message and the turn’s nodes', async () => {
    model.script({ kind: 'message', message: message([text('Saturday looks busy.')]) });
    const events = await turn({ content: 'How busy is Saturday?' });
    expect(events.map((each) => [each.id, each.event])).toEqual([[1, 'conversation'], [2, 'text'], [3, 'done']]);
    const { id, turnId } = conversationOf(events);
    const stored = await record(turnId);
    expect(stored).toMatchObject({
      state: 'done', eventCount: 3, stopRequested: false, userId: session.userId, conversationId: new Types.ObjectId(id),
      locationId: new Types.ObjectId(locationId), message: { text: 'How busy is Saturday?', attachments: [] },
      userNodeId: (events[0]?.data as { userNodeId: string }).userNodeId, replyNodeId: (events[0]?.data as { replyNodeId: string }).replyNodeId,
      parentId: null,
    });
    expect(stored?.endedAt).toBeInstanceOf(Date);
    expect(asStream(stored)).toEqual(events);
    expect(await conversationDoc(id)).toMatchObject({ turnCount: 1, liveTurn: null });
  });

  it('closing the POST mid-turn aborts nothing: the turn finishes, is saved once, and its record holds every event', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.script(
      { kind: 'message', message: message([text('Let me check. '), toolUse('r1', 'list_notes', {})]) },
      { kind: 'message', message: message([text('Nothing on the calendar.')]), gate },
    );
    const controller = new AbortController();
    const res = await fetch(new URL(turnsPath(), server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ content: 'Anything on Friday?' }),
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('event: tool')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    const seen = parseSse(received);
    const { id, turnId } = conversationOf(seen);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    release();

    await until(async () => (await record(turnId))?.state === 'done');
    const stored = await record(turnId);
    expect(stored?.events.map((each) => each.type)).toEqual(['conversation', 'text', 'tool', 'tool', 'text', 'done']);
    // What the closed stream had shown is the record's start, with the same numbers.
    expect(asStream(stored).slice(0, seen.length)).toEqual(seen);
    expect(model.calls.map((each) => each.signal.aborted)).toEqual([false, false]);
    expect(await conversationDoc(id)).toMatchObject({ turnCount: 1, liveTurn: null });
    expect(await liveTurns()).toBe(0);
  });

  it('a refusal ends as before, with done refusal, and saves nothing; its record is done', async () => {
    model.script({ kind: 'message', message: message([], { stopReason: 'refusal' }) });
    const events = await turn({ content: 'Refuse this.' });
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { stopReason: 'refusal', leafId: null } });
    const { id, turnId } = conversationOf(events);
    expect(await conversationDoc(id)).toBeNull();
    expect(asStream(await record(turnId))).toEqual(events);
    expect((await record(turnId))?.state).toBe('done');
  });

  it('a provider failure ends as before, with its error code, and saves nothing; its record is failed', async () => {
    const failure = new InternalServerError(500, { type: 'error', error: { type: 'api_error', message: 'no' } }, undefined, new Headers(), 'api_error');
    model.script({ kind: 'error', error: failure, before: eventsOf(message([text('Partial reply')], { usage: { input: 2000 } })).slice(0, 3) });
    const events = await turn({ content: 'Will this fail?' });
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'provider_unavailable' } });
    const { id, turnId } = conversationOf(events);
    expect(await conversationDoc(id)).toBeNull();
    const stored = await record(turnId);
    expect(stored?.state).toBe('failed');
    expect(asStream(stored)).toEqual(events);
  });

  it('a turn past its time limit ends as before, with error timeout, even with no connection open; its record is failed', async () => {
    model.script({ kind: 'hang', before: eventsOf(message([text('Still thinking it over')], { usage: { input: 1000 } })).slice(0, 3) });
    const controller = new AbortController();
    const res = await fetch(new URL(turnsPath(), server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ content: 'Take your time' }),
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    const first = new TextDecoder().decode((await reader.read()).value);
    const { id, turnId } = conversationOf(parseSse(first));
    controller.abort();
    await reader.cancel().catch(() => undefined);

    await until(async () => (await record(turnId))?.state === 'failed');
    expect((await record(turnId))?.events.at(-1)).toEqual({ seq: 3, type: 'error', data: { code: 'timeout' } });
    expect(model.calls[0]?.signal.aborted).toBe(true);
    expect(await conversationDoc(id)).toBeNull();
    expect(await liveTurns()).toBe(0);
    expect(server.logs.join('\n')).toContain('"code":"timeout"');
  });

  it('a budget spent mid-turn ends as before, with done budget, and the turn is saved; its record is done', async () => {
    await server.connection.collection('tw_chat_usage').insertOne({
      orgId: new Types.ObjectId(orgId), month: '2026-06', costMicroUsd: 19_990_000, updatedAt: server.clock.now(),
    });
    model.script({ kind: 'message', message: message([text('Checking your notes. '), toolUse('b1', 'list_notes', {})], {
      usage: { input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 },
    }) });
    const events = await turn({ content: 'Spend the rest' });
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { stopReason: 'budget' } });
    const { id, turnId } = conversationOf(events);
    expect(await conversationDoc(id)).toMatchObject({ turnCount: 1 });
    expect(asStream(await record(turnId))).toEqual(events);
    expect((await record(turnId))?.state).toBe('done');
  });
});

describe('reattaching: liveTurn on both GETs', () => {
  it('names the running turn on either instance, and shows an edit’s live branch with the person’s message', async () => {
    model.script({ kind: 'message', message: message([text('Saturday looks busy.')]) }, { kind: 'message', message: message([text('Sunday is quieter.')]) });
    const first = await turn({ content: 'How busy is Saturday?' });
    const { id } = conversationOf(first);
    const { replyNodeId: r1 } = nodesOf(first);
    const { userNodeId: u2 } = nodesOf(await turn({ conversationId: id, content: 'And Sunday?' }));
    const before = await getJson<ConversationView>(server, `${chatPath()}/${id}`);
    expect(before.liveTurn).toBeNull();
    expect((await getJson<ChatSummary>(server, chatPath())).liveTurn).toBeNull();

    // An edit of the second message: it hangs under the first reply.
    const held = await holdTurn({ conversationId: id, content: 'And Monday?', parentId: r1 }, 'Monday is quiet.');
    expect(held.conversationId).toBe(id);
    const at = other.clock.now().toISOString();
    const liveTurn = {
      turnId: held.turnId, state: 'running', startedAt: at, userNodeId: held.userNodeId, replyNodeId: held.replyNodeId, parentId: r1,
      message: {
        nodeId: held.userNodeId, role: 'user', text: 'And Monday?', proposals: [], parts: [], feedback: null, next: null, at, endedAt: at,
        attachments: [], sources: [],
      },
    };
    for (const on of [server, other]) {
      expect((await getJson<ChatSummary>(on, chatPath())).liveTurn).toEqual({ conversationId: id, turnId: held.turnId });
      const view = await getJson<ConversationView>(on, `${chatPath()}/${id}`);
      expect(view.messages.map((each) => each.nodeId)).toEqual(before.messages.slice(0, 2).map((each) => each.nodeId));
      expect(view.activeLeafId).toBe(r1);
      expect(view.liveTurn).toEqual(liveTurn);
    }
    // `?node=` still shows the version asked for, with the live turn beside it.
    const asked = await getJson<ConversationView>(server, `${chatPath()}/${id}?node=${String(u2)}`);
    expect(asked.messages.map((each) => each.nodeId)).toEqual(before.messages.map((each) => each.nodeId));
    expect(asked.liveTurn?.turnId).toBe(held.turnId);

    // View-as reads the target's live turn, as it reads their conversations.
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: session.userId, orgId });
      expect((await getJson<ChatSummary>(other, chatPath(), staff)).liveTurn).toEqual({ conversationId: id, turnId: held.turnId });
      expect((await getJson<ConversationView>(other, `${chatPath()}/${id}`, staff)).liveTurn).toEqual(liveTurn);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }

    held.release();
    expect((await held.body).at(-1)?.event).toBe('done');
    expect((await getJson<ChatSummary>(server, chatPath())).liveTurn).toBeNull();
    const saved = await getJson<ConversationView>(server, `${chatPath()}/${id}`);
    expect(saved.liveTurn).toBeNull();
    expect(saved.messages.map((each) => each.nodeId)).toEqual([...before.messages.slice(0, 2).map((each) => each.nodeId), held.userNodeId, held.replyNodeId]);
  });

  it('shows a regenerate’s live branch: the path to the person’s message, with no message of its own', async () => {
    model.script({ kind: 'message', message: message([text('Saturday looks busy.')]) });
    const first = await turn({ content: 'How busy is Saturday?' });
    const { id } = conversationOf(first);
    const { userNodeId: u1, replyNodeId: r1 } = nodesOf(first);

    const held = await holdTurn({ conversationId: id, replyTo: u1 }, 'Saturday will be busy.');
    const view = await getJson<ConversationView>(server, `${chatPath()}/${id}`);
    expect(view.messages.map((each) => each.nodeId)).toEqual([u1]);
    expect(view.liveTurn).toMatchObject({ turnId: held.turnId, state: 'running', userNodeId: null, parentId: u1, message: null });
    expect(held.replyNodeId).not.toBe(r1);

    held.release();
    expect((await held.body).at(-1)?.event).toBe('done');
    const saved = await getJson<ConversationView>(server, `${chatPath()}/${id}`);
    expect(saved.liveTurn).toBeNull();
    expect(saved.messages.map((each) => each.nodeId)).toEqual([u1, held.replyNodeId]);
  });

  it('a running record whose lease passed reads as interrupted, a settled one too, and an ended one not at all', async () => {
    const id = await addConversation(server, { orgId, locationId, userId: session.userId, text: 'Earlier question' });
    const turnId = await addChatTurn(server, { orgId, locationId, conversationId: id, userId: session.userId });
    const records = server.connection.collection('tw_chat_turns');
    try {
      await records.updateOne({ turnId }, { $set: { leaseUntil: new Date(server.clock.now().getTime() - 1000) } });
      expect((await getJson<ChatSummary>(server, chatPath())).liveTurn).toEqual({ conversationId: id, turnId });
      const lapsed = await getJson<ConversationView>(server, `${chatPath()}/${id}`);
      expect(lapsed.liveTurn).toMatchObject({ turnId, state: 'interrupted', parentId: null, message: { nodeId: 'user-node', text: 'Sentinel live message' } });
      // A live turn with no parent is a new first message: none of the saved ones is on its path.
      expect(lapsed.messages).toEqual([]);

      await records.updateOne({ turnId }, { $set: { state: 'interrupted', endedAt: server.clock.now() } });
      expect((await getJson<ChatSummary>(server, chatPath())).liveTurn).toBeNull();
      expect((await getJson<ConversationView>(server, `${chatPath()}/${id}`)).liveTurn).toMatchObject({ turnId, state: 'interrupted' });

      await records.updateOne({ turnId }, { $set: { state: 'done' } });
      const ended = await getJson<ConversationView>(server, `${chatPath()}/${id}`);
      expect(ended.liveTurn).toBeNull();
      expect(ended.messages).toHaveLength(2);
    } finally {
      await records.deleteMany({ turnId });
    }
  });
});

describe('reading a turn back', () => {
  it('the turn runs on one instance and its tail on the other: the same numbered events, to the same end; after=n resumes at n + 1', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    for (const each of [server, other]) each.clock.advance(1000);
    otherModel.script(
      { kind: 'message', message: message([text('Let me check. '), toolUse('t1', 'list_notes', {})]) },
      { kind: 'message', message: message([text('Nothing on the calendar.')]), gate },
    );
    const res = await call(other, turnsPath(), { session, json: { content: 'Anything on Friday?' } });
    expect(res.status).toBe(200);
    const posted = res.text().then(parseSse);
    let running: (StoredTurn & { conversationId: Types.ObjectId }) | null = null;
    await until(async () => {
      running = await server.connection.collection<StoredTurn & { conversationId: Types.ObjectId }>('tw_chat_turns')
        .findOne({ userId: session.userId, state: 'running' });
      return (running?.eventCount ?? 0) >= 4;
    });
    const { turnId, conversationId } = running as unknown as StoredTurn & { conversationId: Types.ObjectId };
    const id = conversationId.toHexString();
    // Read while the turn waits for its second model call: what is stored, then what comes.
    const tailed = tail(server, tailPath(id, turnId, '0'));
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    release();
    const all = await posted;
    expect(all.map((each) => each.event)).toEqual(['conversation', 'text', 'tool', 'tool', 'text', 'done']);
    expect(await tailed).toEqual(all);

    const resumed = await tail(server, tailPath(id, turnId, '2'));
    expect(resumed).toEqual(all.slice(2));
    expect(resumed[0]?.id).toBe(3);
    // No `after` is 0; a turn that ended at or before `after` sends nothing.
    expect(await tail(other, tailPath(id, turnId))).toEqual(all);
    expect(await tail(other, tailPath(id, turnId, String(all.length)))).toEqual([]);
  });

  it('a running record whose lease passed ends with error interrupted, numbered next, and nothing is written', async () => {
    const { id, turnId } = await lapsedTurn();
    try {
      expect(await tail(other, tailPath(id, turnId, '0'))).toEqual([
        { id: 1, event: 'text', data: { delta: 'Sentinel live reply' } },
        { id: 2, event: 'error', data: { code: 'interrupted' } },
      ]);
      expect(await record(turnId)).toMatchObject({ state: 'running', eventCount: 1 });
      expect((await record(turnId))?.events).toHaveLength(1);
    } finally {
      await server.connection.collection('tw_chat_turns').deleteMany({ turnId });
    }
  });

  it('404 for a colleague’s turn, another organization’s, another conversation’s or an unknown one; 400 for a malformed after; view-as reads it', async () => {
    const { id, turnId } = await lapsedTurn();
    const otherId = await addConversation(server, { orgId, locationId, userId: session.userId, text: 'Another question' });
    const colleagueEmail = `colleague-${randomUUID().slice(0, 8)}@example.test`;
    const colleague = await signIn(server, colleagueEmail);
    await addSeat(server, { orgId, userId: colleague.userId, email: colleagueEmail });
    const elsewhereOrg = await createOrg(server, { name: 'Elsewhere Inn' });
    const strangerEmail = `stranger-${randomUUID().slice(0, 8)}@example.test`;
    const stranger = await signIn(server, strangerEmail);
    await addSeat(server, { orgId: elsewhereOrg, userId: stranger.userId, email: strangerEmail });
    const strangerLocation = await addLocation(server, { orgId: elsewhereOrg, name: 'Elsewhere Bar' });
    try {
      const notFound = { status: 404, error: 'not_found' };
      expect(await statusOf(other, tailPath(id, turnId), colleague)).toEqual(notFound);
      expect(await statusOf(other, tailPath(id, turnId), stranger)).toEqual(notFound);
      expect(await statusOf(other, `/api/org/locations/${strangerLocation}/chat/${id}/turns/${turnId}`, stranger)).toEqual(notFound);
      expect(await statusOf(other, tailPath(otherId, turnId))).toEqual(notFound);
      expect(await statusOf(other, tailPath(id, randomUUID()))).toEqual(notFound);
      expect(await statusOf(other, tailPath(id, 'x'.repeat(65)))).toEqual(notFound);
      for (const after of ['abc', '-1', '01', '1.5', '']) {
        expect(await statusOf(other, tailPath(id, turnId, after))).toEqual({ status: 400, error: 'invalid_request' });
      }
      expect(await statusOf(other, `${tailPath(id, turnId, '0')}&from=1`)).toEqual({ status: 400, error: 'invalid_request' });

      const staff = await signInStaff(server);
      try {
        await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: session.userId, orgId });
        expect((await tail(other, tailPath(id, turnId), staff)).map((each) => each.event)).toEqual(['text', 'error']);
      } finally {
        await removeStaffFactor(server);
        await server.connection.collection('tw_view_as_grants').deleteMany({});
      }
    } finally {
      await server.connection.collection('tw_chat_turns').deleteMany({ turnId });
    }
  });
});

describe('shutdown', () => {
  it('main.ts builds one turn runner, hands it to every context, and closes it first, after the HTTP drain', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main.match(/\bcreateTurnRunner\(/g)).toHaveLength(1);
    expect(main).toMatch(/^const baseDeps = \{\n[^}]*\bturnRunner\b/m);
    expect(main).toMatch(/onShutdown: \[\n\s+turnRunner, \{ name: 'mail'/);
  });

  // Last in the file: the runner stays closed afterwards.
  it('settles a running turn as interrupted, releases its claims, deletes its new conversation and takes no new turn', async () => {
    model.script({ kind: 'hang', before: eventsOf(message([text('Sentinel-reply being written')], { usage: { input: 1000 } })).slice(0, 3) });
    const res = await call(server, turnsPath(), { session, json: { content: 'Sentinel-question asked before a deploy' } });
    expect(res.status).toBe(200);
    const body = res.text();
    let turnId = '';
    await until(async () => {
      const running = await server.connection.collection<StoredTurn>('tw_chat_turns').findOne({ state: 'running' });
      turnId = running?.turnId ?? '';
      return (running?.eventCount ?? 0) >= 2;
    });
    server.logs.length = 0;
    const started = Date.now();
    await server.turnRunner.close();
    expect(Date.now() - started).toBeLessThan(2000);

    const events = parseSse(await body);
    expect(events.at(-1)).toEqual({ id: 3, event: 'error', data: { code: 'interrupted' } });
    const stored = await record(turnId);
    expect(stored?.state).toBe('interrupted');
    expect(asStream(stored)).toEqual(events);
    expect(model.calls[0]?.signal.aborted).toBe(true);
    expect(await conversationDoc(conversationOf(events).id)).toBeNull();
    expect(await liveTurns()).toBe(0);
    const lines = server.logs.join('\n');
    expect(lines).toContain('"reason":"shutdown"');
    expect(lines).not.toContain('Sentinel');

    const refused = await call(server, turnsPath(), { session, json: { content: 'After the deploy' } });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: 'chat_unavailable' });
  });
});
