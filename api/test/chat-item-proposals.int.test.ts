// Keeping text TownwiseAI proposed (Your data, D28, design call 19): propose_data_item shows the owner a card, and only
// the conversation's author keeps it, as a .txt reference item holding exactly the text of the stored call, once however
// often or from however many tabs Keep is pressed. Read-only under view-as, 503 while stored files are off, and no
// title or text in a log line or an audit event. Synthetic data only.
import { randomUUID } from 'node:crypto';

import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { createItemReader, saveTextItem, type ItemReader } from '../src/files/items.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import type { ConversationView } from '../src/handlers/chat.ts';
import type { ItemProposalView } from '../src/handlers/chat-item-proposals.ts';
import { createChatProposalStore } from '../src/stores/chat-proposals.ts';
import { createTownwiseStores } from '../src/stores/index.ts';
import { message, messagesOf, scriptedModel, text, toolUse, type ScriptedModel } from './helpers/chat-model.ts';
import { addGrant, addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, limiterKey, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const ITEM = { title: 'Catering list', text: 'Party of 40 on Dec 12' } as const;
const NOTE = {
  kind: 'private_event', startDate: '2026-12-12', endDate: '2026-12-12', weekdays: null, effect: 'more_guests', expectedGuests: 40,
  detail: null,
} as const;
const callId = 'toolu_item0001';

let server: TownwiseTestServer;
let model: ScriptedModel;
let blobs: MemoryFileBlobs;
let reader: ItemReader;
let orgId: string;
let l1: string;
let member: TestSession;
let memberEmail: string;
let colleague: TestSession;

const scope = (): OrgScope => ({ orgId }) as unknown as OrgScope;

async function person(role: 'org_admin' | 'member'): Promise<{ session: TestSession; email: string }> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return { session, email };
}

/** The conversation id from a turn's `conversation` event. */
function conversationOf(body: string): string {
  const line = body.split('\n').find((row) => row.startsWith('data: {"id":'));
  return (JSON.parse(line?.slice(6) ?? '{}') as { id: string }).id;
}

/**
 * A finished turn in `who`'s new conversation at `location`, in which TownwiseAI called each of `calls` in one reply,
 * then said it showed a card. Resolves the conversation id.
 */
async function turnWith(
  calls: { id: string; name: string; input: unknown }[], who = member, location = l1, p: { server: TownwiseTestServer; model: ScriptedModel } = { server, model },
): Promise<string> {
  p.model.calls.length = 0;
  p.model.script(
    { kind: 'message', message: message(calls.map((c) => toolUse(c.id, c.name, c.input))) },
    { kind: 'message', message: message([text('I showed it to you as a card.')]) },
  );
  const res = await call(p.server, `/api/org/locations/${location}/chat/turns`, { session: who, json: { content: 'Please keep this for me.' } });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('event: done');
  return conversationOf(body);
}

/** The usual turn: one propose_data_item call, `callId`, with `ITEM`. */
function proposed(who = member): Promise<string> {
  return turnWith([{ id: callId, name: 'propose_data_item', input: ITEM }], who);
}

function proposalPath(convId: string, id: string, location = l1): string {
  return `/api/org/locations/${location}/chat/${convId}/item-proposals/${id}`;
}

async function getProposal(who: TestSession, convId: string, id: string, location = l1): Promise<unknown> {
  const res = await call(server, proposalPath(convId, id, location), { session: who });
  const body = await res.json() as Record<string, unknown>;
  return res.status === 200 ? body : { status: res.status, error: body.error };
}

async function actRaw(who: TestSession, convId: string, id: string, json: unknown, location = l1): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(server, proposalPath(convId, id, location), { session: who, json });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

type Kept = ItemProposalView & { item: NonNullable<ItemProposalView['item']> };

async function act(who: TestSession, convId: string, id: string, json: unknown): Promise<{ proposal: Kept }> {
  const { status, body } = await actRaw(who, convId, id, json);
  expect(status).toBe(200);
  return body as unknown as { proposal: Kept };
}

async function referenceFiles(): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_files').find({ purpose: 'reference' }).toArray();
}

async function proposalRows(convId: string): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_chat_proposals').find({ conversationId: new Types.ObjectId(convId) }).toArray();
}

async function uploadedEvents(fileId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((e) => e.action === 'file.uploaded' && (e.target as { id: string }).id === fileId);
}

beforeAll(async () => {
  model = scriptedModel();
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({ chat: model, files: blobs });
  reader = createItemReader(createTownwiseStores(server.connection), blobs);
  orgId = await createOrg(server, { name: 'Keeping Tavern' });
  l1 = await addLocation(server, { orgId, name: 'Taproom' });
  ({ session: member, email: memberEmail } = await person('member'));
  ({ session: colleague } = await person('member'));
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.connection.collection('tw_files').deleteMany({});
  await server.connection.collection('tw_chat_proposals').deleteMany({});
});

describe('the card', () => {
  it('GET shows a proposal from a stored turn with its exact title and text, open', async () => {
    const convId = await proposed();
    expect(await getProposal(member, convId, callId)).toEqual({ proposal: { id: callId, title: 'Catering list', text: 'Party of 40 on Dec 12', status: 'open', item: null } });
    // The model read the proposal result, and the conversation shows an ordinary tool part with the text's length and
    // that the card was shown, never the title or the text.
    const last = messagesOf(model.calls[1]).at(-1);
    const blocks = last === undefined || typeof last.content === 'string' ? [] : last.content ?? [];
    expect(blocks).toEqual([{ type: 'tool_result', tool_use_id: callId, content: 'Shown to the owner as a proposal. They decide whether to keep it.' }]);
    const view = await (await call(server, `/api/org/locations/${l1}/chat/${convId}`, { session: member })).json() as ConversationView;
    const parts = view.messages.flatMap((entry) => entry.parts);
    expect(parts).toContainEqual({ type: 'tool', id: callId, name: 'propose_data_item', state: 'done', input: { chars: 21 }, result: { shown: true } });
    expect(view.messages.flatMap((entry) => entry.proposals)).toEqual([]);
  });
});

describe('keeping it', () => {
  it('Keep saves exactly the proposed text as a .txt reference item by the conversation’s author, saved from TownwiseAI', async () => {
    const convId = await proposed();
    const { proposal } = await act(member, convId, callId, { action: 'save' });
    expect(proposal).toMatchObject({ status: 'saved', item: { kind: 'text', via: 'townwise_ai', name: 'Catering list.txt', addedByEmail: memberEmail } });
    expect(await reader.readText(scope(), l1, proposal.item.file?.id ?? '')).toEqual({ status: 'ok', text: 'Party of 40 on Dec 12', truncated: false });
    const files = await referenceFiles();
    expect(files).toEqual([expect.objectContaining({ uploadedBy: member.userId, addedVia: 'townwise_ai', kind: 'text', status: 'kept' })]);
    // The proposal's row reserved the kept file's id.
    expect(await proposalRows(convId)).toEqual([expect.objectContaining({ kind: 'item', status: 'saved', noteId: files[0]?._id })]);
    // A reload shows it kept, and Your data lists it.
    expect(await getProposal(member, convId, callId)).toEqual({ proposal });
    const listed = await (await call(server, `/api/org/data?locationId=${l1}`, { session: member })).json() as { items: { ref: string; via: string }[] };
    expect(listed.items).toContainEqual(expect.objectContaining({ ref: proposal.item.ref, via: 'townwise_ai' }));
    // TownwiseAI's activity lists saved notes only.
    expect(await createChatProposalStore(server.connection).listSaved(scope(), { locationId: l1, userId: member.userId }, 10)).toEqual([]);
  });

  it('Keep spends the files budget Paste text uses, and keeps nothing once it is used up', async () => {
    const convId = await proposed();
    await act(member, convId, callId, { action: 'save' });
    expect(await server.redis.get(limiterKey('townwise:files', member.userId))).toBe('1');
    await server.redis.set(limiterKey('townwise:files', member.userId), '120', 'EX', 3600);
    const second = await proposed();
    const refused = await actRaw(member, second, callId, { action: 'save' });
    expect(refused).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    expect(await referenceFiles()).toHaveLength(1);
  });

  it('two Keeps at once, or a retry after a crash between the steps, keep one item', async () => {
    const convId = await proposed();
    const both = await Promise.all([act(member, convId, callId, { action: 'save' }), act(member, convId, callId, { action: 'save' })]);
    expect(both[0].proposal).toEqual(both[1].proposal);
    expect(await server.connection.collection('tw_files').countDocuments({ purpose: 'reference' })).toBe(1);
    expect(await uploadedEvents(both[0].proposal.item.file?.id ?? '')).toHaveLength(1);
    expect(await act(member, convId, callId, { action: 'save' })).toEqual({ proposal: both[0].proposal });
    expect(await referenceFiles()).toHaveLength(1);

    // A save that stopped after its claim, with its item written or not, finishes on the next press with the claimed id.
    for (const written of [true, false]) {
      await server.connection.collection('tw_files').deleteMany({});
      const crashed = await proposed();
      const reserved = new Types.ObjectId();
      const at = server.clock.now();
      await server.connection.collection('tw_chat_proposals').insertOne({
        orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(l1), conversationId: new Types.ObjectId(crashed),
        userId: member.userId, proposalId: callId, kind: 'item', status: 'saving', noteId: reserved, edited: false, createdAt: at, updatedAt: at,
      });
      if (written) {
        await saveTextItem(createTownwiseStores(server.connection), blobs, scope(), l1, {
          id: reserved.toHexString(), ...ITEM, uploadedBy: member.userId, uploaderRole: 'member', addedVia: 'townwise_ai', now: at,
        });
      }
      // A save still in progress reads as open, so Keep is offered and finishes it.
      expect(await getProposal(member, crashed, callId)).toMatchObject({ proposal: { status: 'open', item: null } });
      const { proposal } = await act(member, crashed, callId, { action: 'save' });
      expect({ written, status: proposal.status, fileId: proposal.item.file?.id }).toEqual({ written, status: 'saved', fileId: reserved.toHexString() });
      expect(await referenceFiles()).toHaveLength(1);
      // Only an item this press wrote is recorded now.
      expect(await uploadedEvents(reserved.toHexString())).toHaveLength(written ? 0 : 1);
    }
  });

  it('Not now records dismissed; Keep afterwards still keeps it', async () => {
    const convId = await proposed();
    const dismissed = await act(member, convId, callId, { action: 'dismiss' });
    expect(dismissed).toEqual({ proposal: { id: callId, title: 'Catering list', text: 'Party of 40 on Dec 12', status: 'dismissed', item: null } });
    expect(await getProposal(member, convId, callId)).toEqual(dismissed);
    expect(await act(member, convId, callId, { action: 'dismiss' })).toEqual(dismissed);
    expect(await referenceFiles()).toHaveLength(0);
    expect(await proposalRows(convId)).toEqual([expect.objectContaining({ kind: 'item', status: 'dismissed' })]);

    const { proposal } = await act(member, convId, callId, { action: 'save' });
    expect(proposal).toMatchObject({ status: 'saved', item: { name: 'Catering list.txt' } });
    expect(await referenceFiles()).toHaveLength(1);
    // Not now after a Keep answers it kept.
    expect(await act(member, convId, callId, { action: 'dismiss' })).toEqual({ proposal });
  });

  it('a kept item deleted since reads saved with no item, and is not kept again', async () => {
    const convId = await proposed();
    const { proposal } = await act(member, convId, callId, { action: 'save' });
    const removed = await call(server, `/api/org/locations/${l1}/data/${proposal.item.ref}`, { method: 'DELETE', session: member });
    expect(removed.status).toBe(200);
    expect(await getProposal(member, convId, callId)).toMatchObject({ proposal: { status: 'saved', item: null } });
    expect(await act(member, convId, callId, { action: 'save' })).toMatchObject({ proposal: { status: 'saved', item: null } });
    expect(await referenceFiles()).toHaveLength(0);
  });
});

describe('who may see or keep a proposal', () => {
  it('another person’s conversation, an unknown id, a propose_note call’s id and a call whose result was an error answer 404', async () => {
    const convId = await turnWith([
      { id: callId, name: 'propose_data_item', input: ITEM },
      { id: 'toolu_note0001', name: 'propose_note', input: NOTE },
      { id: 'toolu_long0001', name: 'propose_data_item', input: { title: 'x'.repeat(121), text: 'a' } },
      { id: 'toolu_extra0001', name: 'propose_data_item', input: { ...ITEM, extra: true } },
    ]);
    const colleagues = await proposed(colleague);
    const cases: [TestSession, string, string][] = [
      [member, colleagues, callId], [colleague, convId, callId],
      [member, convId, 'toolu_unknown0001'], [member, convId, 'toolu_note0001'], [member, convId, 'toolu_long0001'],
      [member, convId, 'toolu_extra0001'], [member, new Types.ObjectId().toHexString(), callId],
    ];
    for (const [who, conversation, id] of cases) {
      expect(await getProposal(who, conversation, id)).toEqual({ status: 404, error: 'not_found' });
      for (const json of [{ action: 'save' }, { action: 'dismiss' }]) {
        const { status, body } = await actRaw(who, conversation, id, json);
        expect({ id, status, error: body.error }).toEqual({ id, status: 404, error: 'not_found' });
      }
    }
    // Another location of the organization is not where the conversation is.
    const l2 = await addLocation(server, { orgId, name: 'Patio' });
    expect(await getProposal(member, convId, callId, l2)).toEqual({ status: 404, error: 'not_found' });
    expect(await referenceFiles()).toHaveLength(0);
    expect(await server.connection.collection('tw_chat_proposals').countDocuments({})).toBe(0);
  });

  it('refuses a malformed proposal id, conversation id or body with 400, and takes no text from the request', async () => {
    const convId = await proposed();
    expect((await actRaw(member, convId, 'bad.id', { action: 'save' })).status).toBe(400);
    expect((await actRaw(member, 'not-an-id', callId, { action: 'save' })).status).toBe(400);
    expect(await getProposal(member, convId, 'bad.id')).toEqual({ status: 400, error: 'invalid_request' });
    for (const json of [{}, { action: 'keep' }, { action: 'save', text: 'Something else' }, { action: 'save', title: 'Other' }]) {
      expect(await actRaw(member, convId, callId, json)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await referenceFiles()).toHaveLength(0);
  });

  it('staff in view-as see the card but are refused Keep and Not now with 403 view_as_read_only', async () => {
    const convId = await proposed();
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: member.userId, orgId });
      expect(await getProposal(staff, convId, callId)).toMatchObject({ proposal: { id: callId, status: 'open' } });
      for (const json of [{ action: 'save' }, { action: 'dismiss' }]) {
        expect(await actRaw(staff, convId, callId, json)).toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
      }
      expect(await referenceFiles()).toHaveLength(0);
      expect(await proposalRows(convId)).toHaveLength(0);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });
});

describe('logs and audit events', () => {
  it('records file.uploaded with via townwise_ai and nothing from the text or the title', async () => {
    const convId = await proposed();
    server.logs.length = 0;
    const { proposal } = await act(member, convId, callId, { action: 'save' });
    const fileId = proposal.item.file?.id ?? '';
    expect(await uploadedEvents(fileId)).toEqual([expect.objectContaining({
      actorUserId: member.userId,
      details: { locationId: l1, kind: 'text', sizeBytes: 21, purpose: 'reference', via: 'townwise_ai' },
    })]);
    const lines = server.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === 'townwise.chat_proposal');
    expect(lines).toEqual([expect.objectContaining({ orgId, locationId: l1, conversationId: convId, status: 'saved', edited: false })]);
    const everything = server.logs.join('\n') + JSON.stringify(await auditEvents(server));
    for (const sentinel of ['Catering', 'Party of 40']) expect(everything).not.toContain(sentinel);
  });
});

describe('with stored files off', () => {
  let off: TownwiseTestServer;
  let offModel: ScriptedModel;
  let offOrg: string;
  let offLocation: string;
  let owner: TestSession;

  beforeAll(async () => {
    offModel = scriptedModel();
    off = await startTownwiseServer({ chat: offModel });
    offOrg = await createOrg(off, { name: 'Files Off Tavern' });
    offLocation = await addLocation(off, { orgId: offOrg, name: 'Taproom' });
    const email = `member-${randomUUID().slice(0, 8)}@example.test`;
    owner = await signIn(off, email);
    await addSeat(off, { orgId: offOrg, userId: owner.userId, email });
  });
  afterAll(async () => { await off.close(); });

  it('stored files off: the tool answers available false, and the POST answers 503 files_unavailable and keeps nothing', async () => {
    const convId = await turnWith([{ id: callId, name: 'propose_data_item', input: ITEM }], owner, offLocation, { server: off, model: offModel });
    const last = messagesOf(offModel.calls[1]).at(-1);
    const blocks = last === undefined || typeof last.content === 'string' ? [] : last.content ?? [];
    const result = blocks.find((block): block is BetaToolResultBlockParam => block.type === 'tool_result');
    expect(result?.is_error).not.toBe(true);
    expect(JSON.parse(result?.content as string)).toEqual({ available: false, reason: 'Townwise can’t keep items yet, so nothing was shown to the owner.' });

    const path = `/api/org/locations/${offLocation}/chat/${convId}/item-proposals/${callId}`;
    const save = await call(off, path, { session: owner, json: { action: 'save' } });
    expect({ status: save.status, error: (await save.json() as { error: string }).error }).toEqual({ status: 503, error: 'files_unavailable' });
    // Nothing was shown, so there is no card to read or set aside.
    expect((await call(off, path, { session: owner })).status).toBe(404);
    expect((await call(off, path, { session: owner, json: { action: 'dismiss' } })).status).toBe(404);
    // The conversation says so too, so the client shows no card for it.
    const view = await (await call(off, `/api/org/locations/${offLocation}/chat/${convId}`, { session: owner })).json() as ConversationView;
    expect(view.messages.flatMap((entry) => entry.parts)).toContainEqual(expect.objectContaining({ id: callId, result: { shown: false } }));
    expect(await off.connection.collection('tw_files').countDocuments({})).toBe(0);
    expect(await off.connection.collection('tw_chat_proposals').countDocuments({})).toBe(0);
  });
});
