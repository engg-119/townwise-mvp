// The tuning chat with no ANTHROPIC_API_KEY (docs/portal/tuning-chat.md section 1): the GET answers enabled: false,
// and a turn answers 503 chat_unavailable and writes nothing.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addConversation, addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

describe('the tuning chat while it is off', () => {
  it('GET answers enabled: false with the budget and the caller’s conversations; a turn answers 503 and writes nothing', async () => {
    const orgId = await createOrg(server, { name: 'Quiet Tavern' });
    const email = `member-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId, userId: session.userId, email });
    const locationId = await addLocation(server, { orgId, name: 'Bar Room' });
    const conversationId = await addConversation(server, { orgId, locationId, userId: session.userId, text: 'Earlier question' });

    const res = await call(server, `/api/org/locations/${locationId}/chat`, { session });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      budget: { month: '2026-06', usedUsd: 0, limitUsd: 20, exhausted: false },
      conversations: [{ id: conversationId, title: 'Earlier question', updatedAt: server.clock.now().toISOString(), turnCount: 1 }],
    });

    const before = await server.connection.collection('tw_chat_conversations').find({}).toArray();
    for (const json of [{ content: 'Hello' }, { content: 'Hello again', conversationId }]) {
      const turn = await call(server, `/api/org/locations/${locationId}/chat/turns`, { session, json });
      expect(turn.status).toBe(503);
      expect(await turn.json()).toMatchObject({ error: 'chat_unavailable' });
    }
    expect(await server.connection.collection('tw_chat_conversations').find({}).toArray()).toEqual(before);
    expect(await server.connection.collection('tw_chat_usage').countDocuments({})).toBe(0);
  });
});
