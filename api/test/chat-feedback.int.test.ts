// Rating TownwiseAI replies (docs/portal/tuning-chat.md sections 2 and 5): POST .../feedback/:nodeId stores an enum
// and a time on the author's conversation, shows in the conversation view, logs the aggregate and nothing else.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ConversationView } from '../src/handlers/chat.ts';
import { addConversation, addGrant, addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { message, scriptedModel, text, type ScriptedModel } from './helpers/chat-model.ts';
import {
  call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let model: ScriptedModel;
let orgId: string;
let locationId: string;
let author: TestSession;
let colleague: TestSession;
let admin: TestSession;

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model });
  orgId = await createOrg(server, { name: 'Feedback Tavern' });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
  const person = async (name: string, role: 'org_admin' | 'member'): Promise<TestSession> => {
    const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId, userId: session.userId, email, role });
    return session;
  };
  author = await person('author', 'member');
  colleague = await person('colleague', 'member');
  admin = await person('admin', 'org_admin');
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

const turnsPath = (): string => `/api/org/locations/${locationId}/chat/turns`;
const conversationPath = (id: string): string => `/api/org/locations/${locationId}/chat/${id}`;

interface Ids { id: string; user: string; reply: string }

/** Streams one scripted turn and reads its node ids from the `conversation` event. */
async function turn(json: unknown, answer: string): Promise<Ids> {
  model.script({ kind: 'message', message: message([text(answer)]) });
  const res = await call(server, turnsPath(), { session: author, json });
  expect(res.status).toBe(200);
  const body = await res.text();
  const data = body.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n');
    return lines.includes('event: conversation') ? [lines.find((l) => l.startsWith('data: '))?.slice(6) ?? ''] : [];
  })[0] ?? '{}';
  const event = JSON.parse(data) as { id: string; userNodeId: string | null; replyNodeId: string };
  return { id: event.id, user: event.userNodeId ?? '', reply: event.replyNodeId };
}

function rate(id: string, nodeId: string, json: unknown, session = author): Promise<Response> {
  return call(server, `${conversationPath(id)}/feedback/${nodeId}`, { session, json });
}

async function view(id: string, session = author, query = ''): Promise<ConversationView> {
  const res = await call(server, `${conversationPath(id)}${query}`, { session });
  expect(res.status).toBe(200);
  return await res.json() as ConversationView;
}

const feedbackOf = async (id: string, nodeId: string, session = author): Promise<unknown> =>
  (await view(id, session, `?node=${nodeId}`)).messages.find((m) => m.nodeId === nodeId)?.feedback;

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

async function doc(id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_chat_conversations').findOne({ _id: new Types.ObjectId(id) });
}

describe('rating a reply', () => {
  it('rates a reply, changes the rating, adds a reason to a down rating, and clears it with null', async () => {
    const { id, user, reply } = await turn({ content: 'first' }, 'reply 1');
    const updatedAt = (await doc(id))?.updatedAt;
    const send = async (json: unknown): Promise<unknown> => {
      const res = await rate(id, reply, json);
      expect(res.status).toBe(200);
      return await res.json();
    };
    expect((await view(id)).messages.map((m) => m.feedback)).toEqual([null, null]);
    expect(await send({ rating: 'up' })).toEqual({ nodeId: reply, rating: 'up', reason: null });
    expect(await feedbackOf(id, reply)).toEqual({ rating: 'up', reason: null });
    expect(await send({ rating: 'down', reason: 'made_up' })).toEqual({ nodeId: reply, rating: 'down', reason: 'made_up' });
    const messages = (await view(id)).messages;
    expect(messages.find((m) => m.nodeId === reply)?.feedback).toEqual({ rating: 'down', reason: 'made_up' });
    expect(messages.find((m) => m.nodeId === user)?.feedback).toBeNull();
    expect(await send({ rating: 'down' })).toEqual({ nodeId: reply, rating: 'down', reason: null });
    expect(await send({ rating: null })).toEqual({ nodeId: reply, rating: null, reason: null });
    expect(await feedbackOf(id, reply)).toBeNull();
    expect((await doc(id))?.feedback).toEqual({});
    // Display state: the conversation keeps its place in the list.
    expect((await doc(id))?.updatedAt).toEqual(updatedAt);
  });

  it('refuses a reason with up (400), free text in place of a reason (400), an unknown reason (400), a user node (404) and an unknown node (404)', async () => {
    const { id, user, reply } = await turn({ content: 'first' }, 'reply 1');
    expect(await errorOf(await rate(id, reply, { rating: 'up', reason: 'made_up' }))).toMatchObject({ status: 400 });
    expect(await errorOf(await rate(id, reply, { rating: null, reason: 'made_up' }))).toMatchObject({ status: 400 });
    expect(await errorOf(await rate(id, reply, { rating: 'down', reason: 'The owner typed this' }))).toMatchObject({ status: 400 });
    expect(await errorOf(await rate(id, reply, { rating: 'down', reason: 'nope' }))).toMatchObject({ status: 400 });
    expect(await errorOf(await rate(id, reply, { rating: 'sideways' }))).toMatchObject({ status: 400 });
    expect(await errorOf(await rate(id, reply, {}))).toMatchObject({ status: 400 });
    expect(await errorOf(await rate(id, reply, { rating: 'up', extra: 1 }))).toMatchObject({ status: 400 });
    const gone = { status: 404, error: 'not_found' };
    expect(await errorOf(await rate(id, user, { rating: 'up' }))).toEqual(gone);
    expect(await errorOf(await rate(id, 'no-such-node', { rating: 'up' }))).toEqual(gone);
    expect(await errorOf(await rate(new Types.ObjectId().toHexString(), reply, { rating: 'up' }))).toEqual(gone);
    expect((await doc(id))?.feedback).toEqual({});
  });

  it('rates a reply on a branch that is not shown', async () => {
    const first = await turn({ content: 'first' }, 'reply 1');
    const regenerated = await turn({ conversationId: first.id, replyTo: first.user }, 'reply 1b');
    expect((await view(first.id)).messages.map((m) => m.nodeId)).toEqual([first.user, regenerated.reply]);
    expect((await rate(first.id, first.reply, { rating: 'down', reason: 'too_long' })).status).toBe(200);
    expect(await feedbackOf(first.id, first.reply)).toEqual({ rating: 'down', reason: 'too_long' });
    expect((await view(first.id)).messages.map((m) => m.feedback)).toEqual([null, null]);
  });

  it('is private: another member’s rating of the author’s reply is 404; view-as is 403 view_as_read_only and reads the ratings', async () => {
    const { id, reply } = await turn({ content: 'first' }, 'reply 1');
    expect(await errorOf(await rate(id, reply, { rating: 'up' }, colleague))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await rate(id, reply, { rating: 'up' }, admin))).toEqual({ status: 404, error: 'not_found' });
    expect((await rate(id, reply, { rating: 'up' })).status).toBe(200);
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: author.userId, orgId });
      expect(await feedbackOf(id, reply, staff)).toEqual({ rating: 'up', reason: null });
      expect(await errorOf(await rate(id, reply, { rating: 'down' }, staff))).toEqual({ status: 403, error: 'view_as_read_only' });
      expect(await feedbackOf(id, reply, staff)).toEqual({ rating: 'up', reason: null });
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });

  it('logs townwise.chat_feedback with the organization, rating and reason only, and records no audit event', async () => {
    const { id, reply } = await turn({ content: 'Sentinel-feedback-question' }, 'Sentinel-feedback-answer');
    const eventsBefore = (await auditEvents(server)).length;
    server.logs.length = 0;
    await rate(id, reply, { rating: 'down', reason: 'wrong_figures' });
    await rate(id, reply, { rating: null });
    const lines = server.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === 'townwise.chat_feedback');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 30, orgId, rating: 'down', reason: 'wrong_figures' });
    expect(lines[1]).toMatchObject({ orgId, rating: null, reason: null });
    for (const line of lines) expect(Object.keys(line).filter((k) => !['hostname', 'level', 'msg', 'pid', 'time'].includes(k)).sort()).toEqual(['orgId', 'rating', 'reason']);
    const everything = server.logs.join('\n');
    for (const sentinel of ['Sentinel-feedback-question', 'Sentinel-feedback-answer']) expect(everything).not.toContain(sentinel);
    expect((await auditEvents(server)).length).toBe(eventsBefore);
  });

  it('goes with its conversation when the conversation or the location is deleted', async () => {
    const { id, reply } = await turn({ content: 'first' }, 'reply 1');
    await rate(id, reply, { rating: 'up' });
    expect((await call(server, conversationPath(id), { method: 'DELETE', session: author })).status).toBe(204);
    expect(await doc(id)).toBeNull();
    // A conversation written before trees reads as legacy-{index}; its reply is legacy-1.
    const roomId = await addLocation(server, { orgId, name: 'Pop-up Room' });
    const legacy = await addConversation(server, { orgId, locationId: roomId, userId: author.userId, text: 'Pop-up question' });
    const res = await call(server, `/api/org/locations/${roomId}/chat/${legacy}/feedback/legacy-1`, { session: author, json: { rating: 'up' } });
    expect(res.status).toBe(200);
    expect(((await doc(legacy))?.feedback as Record<string, unknown>)['legacy-1']).toMatchObject({ rating: 'up', reason: null });
    expect((await call(server, `/api/org/locations/${roomId}`, { method: 'DELETE', session: admin })).status).toBe(204);
    expect(await doc(legacy)).toBeNull();
  });
});
