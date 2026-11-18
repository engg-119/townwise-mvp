// The tuning chat's turn time limit (docs/portal/tuning-chat.md section 3), shortened to 300 ms here: a turn that runs
// past it aborts the provider call, saves nothing but its cost, and ends the stream with error `timeout`, where a
// closed connection aborts nothing (resumable-chat-turns, chat.int.test.ts). A turn that finishes in time is unaffected.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { eventsOf, message, scriptedModel, text, type ScriptedModel } from './helpers/chat-model.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
let model: ScriptedModel;
let orgId: string;
let locationId: string;
let session: TestSession;

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model, chatTurnTimeLimitMs: 300 });
  orgId = await createOrg(server, { name: 'Slow Tavern' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email });
  locationId = await addLocation(server, { orgId, name: 'Back Bar' });
});
afterAll(async () => { await server.close(); });

function postTurn(content: string): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/chat/turns`, { session, json: { content } });
}

describe('the turn time limit', () => {
  it('a turn past the limit ends with error timeout, aborts the provider call, and saves nothing but its cost', async () => {
    server.logs.length = 0;
    model.script({ kind: 'hang', before: eventsOf(message([text('Still thinking it over')], { usage: { input: 1000 } })).slice(0, 3) });
    const res = await postTurn('Take your time');
    expect(res.status).toBe(200);
    const body = await res.text();
    // resumable-chat-turns: each event carries its number as its SSE id, and `conversation` names the turn.
    expect(body).toMatch(
      /^id: 1\nevent: conversation\ndata: \{"id":"[0-9a-f]{24}","title":"Take your time","userNodeId":"[0-9a-f-]{36}","replyNodeId":"[0-9a-f-]{36}","parentId":null,"turnId":"[0-9a-f-]{36}"\}\n\n/,
    );
    expect(body.endsWith('id: 2\nevent: text\ndata: {"delta":"Still t"}\n\nid: 3\nevent: error\ndata: {"code":"timeout"}\n\n')).toBe(true);
    expect(model.calls[0]?.signal.aborted).toBe(true);

    const org = new Types.ObjectId(orgId);
    expect(await server.connection.collection('tw_chat_conversations').countDocuments({ orgId: org })).toBe(0);
    expect(await server.connection.collection('tw_chat_live_turns').countDocuments({ orgId: org })).toBe(0);
    // message_start reported 1000 input tokens; the 7 streamed characters count as 3 output tokens.
    const usage = await server.connection.collection('tw_chat_usage').findOne({ orgId: org, month: '2026-06' });
    expect(usage?.costMicroUsd).toBe(1000 * 4 + 3 * 20);
    const logs = server.logs.join('\n');
    expect(logs).toContain('townwise.chat_turn_failed');
    expect(logs).toContain('"code":"timeout"');
    expect(logs).not.toContain('townwise.chat_turn_aborted');
  });

  it('a turn that finishes within the limit is saved as usual', async () => {
    model.script({ kind: 'message', message: message([text('Quick answer.')]) });
    const body = await (await postTurn('Quick question')).text();
    expect(body).toContain('event: done\ndata: {"stopReason":"end_turn"');
    expect(model.remaining()).toBe(0);
  });
});
