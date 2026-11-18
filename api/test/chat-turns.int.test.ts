// tw_chat_turns (openspec change resumable-chat-turns, design decision 2): one record per TownwiseAI turn, its numbered
// events appended under a compare-and-set on the count stored and on the record still running, so a write that applied
// but reported an error is never doubled, and a write to a settled or deleted record matches nothing. Tenant scoped.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { createChatTurnStore, type ChatTurnStore, type NewChatTurn, type TurnRecordEvent } from '../src/stores/chat-turns.ts';
import { createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const SECOND = 1000;

let server: TownwiseTestServer;
let turns: ChatTurnStore;

beforeAll(async () => {
  server = await startTownwiseServer();
  turns = createChatTurnStore(server.connection);
});
afterAll(async () => { await server.close(); });

async function orgScope(): Promise<OrgScope> {
  return scopeForNewOrg(STAFF, await createOrg(server, { name: `Turn Tavern ${randomUUID().slice(0, 6)}` }));
}

function newTurn(over: Partial<NewChatTurn> = {}): NewChatTurn {
  const now = server.clock.now();
  return {
    locationId: new Types.ObjectId().toHexString(), conversationId: new Types.ObjectId().toHexString(), userId: 'user-0001',
    turnId: randomUUID(), userNodeId: randomUUID(), replyNodeId: randomUUID(), parentId: null,
    message: { text: 'How busy is Saturday?', attachments: [] }, startedAt: now, leaseUntil: new Date(now.getTime() + 30 * SECOND),
    ...over,
  };
}

function events(from: number, ...types: string[]): TurnRecordEvent[] {
  return types.map((type, index) => ({ seq: from + index + 1, type, data: type === 'text' ? { delta: `part ${String(from + index + 1)}` } : {} }));
}

function lease(seconds: number): Date {
  return new Date(server.clock.now().getTime() + seconds * SECOND);
}

describe('tw_chat_turns', () => {
  it('inserts a running record, appends numbered events and ends it with its terminal event and state in one update', async () => {
    const scope = await orgScope();
    const turn = newTurn();
    await turns.insert(scope, turn);
    expect(await turns.append(scope, turn.turnId, { from: 0, events: events(0, 'conversation', 'text'), leaseUntil: lease(30) })).toBe(true);
    expect(await turns.append(scope, turn.turnId, { from: 2, events: events(2, 'tool'), leaseUntil: lease(40) })).toBe(true);
    expect(await turns.progress(scope, turn.turnId)).toEqual({ state: 'running', eventCount: 3 });
    expect(await turns.end(scope, turn.turnId, { from: 3, events: events(3, 'text', 'done'), state: 'done', endedAt: server.clock.now() })).toBe(true);

    const record = await turns.readAfter(scope, turn.conversationId, turn.turnId, 0);
    expect(record).toMatchObject({
      turnId: turn.turnId, conversationId: turn.conversationId, locationId: turn.locationId, userId: turn.userId,
      state: 'done', stopRequested: false, eventCount: 5, endedAt: server.clock.now(),
      userNodeId: turn.userNodeId, replyNodeId: turn.replyNodeId, parentId: null, message: turn.message,
    });
    expect(record?.events.map((event) => [event.seq, event.type])).toEqual([[1, 'conversation'], [2, 'text'], [3, 'tool'], [4, 'text'], [5, 'done']]);
    expect(record?.events[1]?.data).toEqual({ delta: 'part 2' });
    // After a cursor: only the events numbered above it.
    expect((await turns.readAfter(scope, turn.conversationId, turn.turnId, 3))?.events.map((event) => event.seq)).toEqual([4, 5]);
    expect((await turns.readAfter(scope, turn.conversationId, turn.turnId, 5))?.events).toEqual([]);
  });

  it('keeps a regenerate’s null message and nodes', async () => {
    const scope = await orgScope();
    const turn = newTurn({ userNodeId: null, parentId: randomUUID(), message: null });
    await turns.insert(scope, turn);
    expect(await turns.readAfter(scope, turn.conversationId, turn.turnId, 0)).toMatchObject({ userNodeId: null, parentId: turn.parentId, message: null });
  });

  it('a batch that applied but was reported as failed is not doubled: the same write again matches nothing', async () => {
    const scope = await orgScope();
    const turn = newTurn();
    await turns.insert(scope, turn);
    const batch = events(0, 'conversation', 'text');
    expect(await turns.append(scope, turn.turnId, { from: 0, events: batch, leaseUntil: lease(30) })).toBe(true);
    // The runner never heard back, so it sends the same batch from the same count.
    expect(await turns.append(scope, turn.turnId, { from: 0, events: batch, leaseUntil: lease(30) })).toBe(false);
    expect(await turns.progress(scope, turn.turnId)).toEqual({ state: 'running', eventCount: 2 });
    expect((await turns.readAfter(scope, turn.conversationId, turn.turnId, 0))?.events).toHaveLength(2);
    // The same holds for the terminal write.
    const ending = { from: 2, events: events(2, 'done'), state: 'done' as const, endedAt: server.clock.now() };
    expect(await turns.end(scope, turn.turnId, ending)).toBe(true);
    expect(await turns.end(scope, turn.turnId, ending)).toBe(false);
    expect(await turns.progress(scope, turn.turnId)).toEqual({ state: 'done', eventCount: 3 });
  });

  it('a write to a settled record matches nothing: append, renew, end and a stop request', async () => {
    const scope = await orgScope();
    const turn = newTurn();
    await turns.insert(scope, turn);
    expect(await turns.end(scope, turn.turnId, { from: 0, events: events(0, 'error'), state: 'interrupted', endedAt: server.clock.now() })).toBe(true);
    expect(await turns.append(scope, turn.turnId, { from: 1, events: events(1, 'text'), leaseUntil: lease(30) })).toBe(false);
    expect(await turns.renew(scope, turn.turnId, lease(30))).toBe(false);
    expect(await turns.end(scope, turn.turnId, { from: 1, events: events(1, 'done'), state: 'done', endedAt: server.clock.now() })).toBe(false);
    // Stop on an ended turn answers its state and sets nothing.
    expect(await turns.requestStop(scope, { locationId: turn.locationId, conversationId: turn.conversationId, userId: turn.userId }, turn.turnId)).toBe('interrupted');
    expect(await turns.stopRequested(scope, turn.turnId)).toBe(false);
    expect(await turns.readAfter(scope, turn.conversationId, turn.turnId, 0)).toMatchObject({ state: 'interrupted', eventCount: 1, stopRequested: false });
  });

  it('renews the lease of a running record, and sets the stop flag only on the author’s running turn', async () => {
    const scope = await orgScope();
    const turn = newTurn();
    await turns.insert(scope, turn);
    expect(await turns.renew(scope, turn.turnId, lease(45))).toBe(true);
    expect((await turns.readAfter(scope, turn.conversationId, turn.turnId, 0))?.leaseUntil).toEqual(lease(45));
    expect(await turns.stopRequested(scope, turn.turnId)).toBe(false);
    expect(await turns.requestStop(scope, { locationId: turn.locationId, conversationId: turn.conversationId, userId: 'someone-else' }, turn.turnId)).toBeNull();
    expect(await turns.requestStop(scope, { locationId: turn.locationId, conversationId: new Types.ObjectId().toHexString(), userId: turn.userId }, turn.turnId)).toBeNull();
    expect(await turns.requestStop(scope, { locationId: new Types.ObjectId().toHexString(), conversationId: turn.conversationId, userId: turn.userId }, turn.turnId)).toBeNull();
    expect(await turns.stopRequested(scope, turn.turnId)).toBe(false);
    expect(await turns.requestStop(scope, { locationId: turn.locationId, conversationId: turn.conversationId, userId: turn.userId }, turn.turnId)).toBe('running');
    expect(await turns.stopRequested(scope, turn.turnId)).toBe(true);
    // Asking again is harmless.
    expect(await turns.requestStop(scope, { locationId: turn.locationId, conversationId: turn.conversationId, userId: turn.userId }, turn.turnId)).toBe('running');
  });

  it('a write to a deleted record matches nothing, whether it went with its conversation, its location or its organization', async () => {
    const scope = await orgScope();
    const byConversation = newTurn();
    const byLocation = newTurn();
    const byOrg = newTurn();
    const kept = newTurn();
    for (const turn of [byConversation, byLocation, byOrg, kept]) await turns.insert(scope, turn);
    const other = await orgScope();
    const otherTurn = newTurn({ conversationId: kept.conversationId, locationId: kept.locationId });
    await turns.insert(other, otherTurn);

    expect(await turns.removeForConversation(scope, byConversation.conversationId)).toBe(1);
    expect(await turns.removeForLocation(scope, byLocation.locationId)).toBe(1);
    for (const turn of [byConversation, byLocation]) {
      expect(await turns.append(scope, turn.turnId, { from: 0, events: events(0, 'conversation'), leaseUntil: lease(30) })).toBe(false);
      expect(await turns.renew(scope, turn.turnId, lease(30))).toBe(false);
      expect(await turns.end(scope, turn.turnId, { from: 0, events: events(0, 'done'), state: 'done', endedAt: server.clock.now() })).toBe(false);
      expect(await turns.progress(scope, turn.turnId)).toBeNull();
    }
    expect(await turns.removeForOrg(scope)).toBe(2);
    expect(await turns.renew(scope, byOrg.turnId, lease(30))).toBe(false);
    expect(await turns.progress(scope, kept.turnId)).toBeNull();
    // Another organization's record with the same conversation and location ids is untouched.
    expect(await turns.progress(other, otherTurn.turnId)).toEqual({ state: 'running', eventCount: 0 });
  });

  it('another organization’s turn is not found, and nothing of it can be written', async () => {
    const scope = await orgScope();
    const turn = newTurn();
    await turns.insert(scope, turn);
    const other = await orgScope();
    expect(await turns.readAfter(other, turn.conversationId, turn.turnId, 0)).toBeNull();
    expect(await turns.progress(other, turn.turnId)).toBeNull();
    expect(await turns.append(other, turn.turnId, { from: 0, events: events(0, 'conversation'), leaseUntil: lease(30) })).toBe(false);
    expect(await turns.renew(other, turn.turnId, lease(30))).toBe(false);
    expect(await turns.end(other, turn.turnId, { from: 0, events: events(0, 'done'), state: 'done', endedAt: server.clock.now() })).toBe(false);
    expect(await turns.requestStop(other, { locationId: turn.locationId, conversationId: turn.conversationId, userId: turn.userId }, turn.turnId)).toBeNull();
    expect(await turns.stopRequested(other, turn.turnId)).toBe(false);
    expect(await turns.removeForConversation(other, turn.conversationId)).toBe(0);
    // A turn of the right organization but another conversation is not found either.
    expect(await turns.readAfter(scope, new Types.ObjectId().toHexString(), turn.turnId, 0)).toBeNull();
    expect(await turns.progress(scope, turn.turnId)).toEqual({ state: 'running', eventCount: 0 });
  });

  it('refuses a second record for the same turn id in an organization', async () => {
    const scope = await orgScope();
    const turn = newTurn();
    await turns.insert(scope, turn);
    await expect(turns.insert(scope, turn)).rejects.toThrow();
  });
});
