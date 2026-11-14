// Business rules reach TownwiseAI (spec 10.16, docs/portal/tuning-chat.md section 3) against a scripted model
// (helpers/chat-model.ts): the person's message carries a business_rules block only when the location's rules differ from
// the last block on the turn's path. With no rules nothing is added, so the request is byte for byte what it was before
// rules existed. The block is stored with the message, never shown back as the person's text, and once a newer block
// replaces it, requests send it as a stub, so a deleted rule's text is not sent again.
import { randomUUID } from 'node:crypto';

import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { attachmentsBlock } from '../src/chat/attachments.ts';
import { REPLACED_RULES_BLOCK, rulesBlock } from '../src/chat/user-message.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import type { ConversationView } from '../src/handlers/chat.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { message, messagesOf, scriptedModel, text, type ScriptedModel } from './helpers/chat-model.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const blobs = createMemoryFileBlobs();
let server: TownwiseTestServer;
let model: ScriptedModel;
let orgId: string;
let author: TestSession;
let locationId: string;

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model, files: blobs });
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

/** Rules with no schedule, as the block lists them. */
const plain = (texts: readonly string[]) => texts.map((text) => ({ text, summary: null }));

const withBlock = (rules: readonly string[], content: string): BetaMessageParam => ({
  role: 'user', content: [{ type: 'text', text: rulesBlock(plain(rules)) }, { type: 'text', text: content }],
});

/** A stored message with a rules block, as a later request sends it once a newer block replaced that one. */
const replacedBlock = (content: string): BetaMessageParam => ({
  role: 'user', content: [{ type: 'text', text: REPLACED_RULES_BLOCK }, { type: 'text', text: content }],
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

  it('after a rule is edited, the next message carries the new list, the earlier block goes as a stub, and the stored history is unchanged', async () => {
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
    expect(sent[0]).toEqual(replacedBlock('Are we open Monday?'));
    expect(sent.slice(1, before.length).map((param) => JSON.stringify(param))).toEqual(before.slice(1));
    // Stored messages keep their blocks.
    expect((await rawParams(first.id)).slice(0, before.length)).toEqual(before);
  });

  it('deleting every rule sends the \'no business rules now\' block once, and the deleted rule\'s text never again', async () => {
    const ruleId = await addRule('Closed Mondays');
    const first = await turn({ content: 'Are we open Monday?' });
    const res = await call(server, `/api/org/locations/${locationId}/rules/${ruleId}`, { method: 'DELETE', session: author });
    expect(res.status).toBe(204);
    await turn({ conversationId: first.id, content: 'What about now?' });
    expect(sentUserMessage()).toEqual(withBlock([], 'What about now?'));
    expect(JSON.stringify(model.calls.at(-1)?.params.messages)).not.toContain('Closed Mondays');
    expect(rulesBlock(plain([]))).toContain('There are no business rules for this location now.');
    await turn({ conversationId: first.id, content: 'And now?' });
    expect(sentUserMessage()).toEqual({ role: 'user', content: 'And now?' });
    const sent = messagesOf(model.calls.at(-1));
    expect(sent[0]).toEqual(replacedBlock('Are we open Monday?'));
    expect(sent[2]).toEqual(withBlock([], 'What about now?'));
    expect(JSON.stringify(sent)).not.toContain('Closed Mondays');
    // The stored first message still holds it; only what is sent changes.
    expect((await rawParams(first.id))[0]).toContain('Closed Mondays');
  });

  it('a rule with a schedule carries its summary on its own line, and adding or taking off a schedule sends a new block', async () => {
    const schedule = {
      kind: 'closure', startDate: '2026-12-07', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
    };
    const res = await call(server, `/api/org/locations/${locationId}/rules`, { session: author, json: { text: 'Closed Mondays', schedule } });
    expect(res.status).toBe(201);
    const ruleId = (await res.json() as { rule: { id: string } }).rule.id;
    await addRule('Patio opens in May');
    const scheduled = [{ text: 'Closed Mondays', summary: 'Closed on Mondays from Dec 7, 2026' }, { text: 'Patio opens in May', summary: null }];
    const first = await turn({ content: 'Are we open Monday?' });
    expect(sentUserMessage()).toEqual({
      role: 'user', content: [{ type: 'text', text: rulesBlock(scheduled) }, { type: 'text', text: 'Are we open Monday?' }],
    });
    expect(rulesBlock(scheduled)).toContain('- Closed Mondays\n  Forecast schedule: Closed on Mondays from Dec 7, 2026\n- Patio opens in May');
    const off = await call(server, `/api/org/locations/${locationId}/rules/${ruleId}`, { method: 'PATCH', session: author, json: { schedule: null } });
    expect(off.status).toBe(200);
    await turn({ conversationId: first.id, content: 'And now?' });
    expect(sentUserMessage()).toEqual(withBlock(['Closed Mondays', 'Patio opens in May'], 'And now?'));
  });

  it('a regenerate resends the stored message with its block and adds none', async () => {
    await addRule('Closed Mondays');
    const first = await turn({ content: 'Are we open Monday?' });
    await addRule('Brunch only on weekends');
    if (first.userNodeId === null) throw new Error('no user node');
    await turn({ conversationId: first.id, replyTo: first.userNodeId });
    expect(messagesOf(model.calls.at(-1))).toEqual([withBlock(['Closed Mondays'], 'Are we open Monday?')]);
  });

  it('with attachments the message is [rules block, attachments block, text], and a later rules change stubs only the rules block', async () => {
    await addRule('Closed Mondays');
    const _id = new Types.ObjectId();
    await server.connection.collection('tw_files').insertOne({
      _id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), importId: null, purpose: 'reference',
      uploadedBy: author.userId, uploaderRole: 'member', uploadedAt: server.clock.now(), name: 'Menu.txt', kind: 'text', sizeBytes: 9,
      fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference', progress: null,
      readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null, rawDeletedAt: null, attempts: 0,
    });
    await blobs.writeRaw({ orgId } as unknown as OrgScope, { locationId, fileId: _id.toHexString() }, Buffer.from('Fall menu'), 'text/plain');
    const ref = `f_${_id.toHexString()}`;
    const block = attachmentsBlock([`- ${ref}: a text file`]);
    const first = await turn({ content: 'What is on it?', attachments: [ref] });
    expect(sentUserMessage()).toEqual({
      role: 'user', content: [
        { type: 'text', text: rulesBlock(plain(['Closed Mondays'])) }, { type: 'text', text: block },
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Fall menu' }, title: ref },
        { type: 'text', text: 'What is on it?' },
      ],
    });
    const stored = { role: 'user', content: [{ type: 'text', text: rulesBlock(plain(['Closed Mondays'])) }, { type: 'text', text: block }, { type: 'text', text: 'What is on it?' }] };
    expect(JSON.parse((await rawParams(first.id))[0] ?? '{}')).toEqual(stored);
    await addRule('Patio opens in May');
    await turn({ conversationId: first.id, content: 'And now?' });
    expect(messagesOf(model.calls.at(-1))[0]).toEqual({
      role: 'user', content: [{ type: 'text', text: REPLACED_RULES_BLOCK }, { type: 'text', text: block }, { type: 'text', text: 'What is on it?' }],
    });
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
