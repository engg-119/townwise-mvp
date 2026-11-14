// Saving or setting aside a note TownwiseAI proposed (spec 10.12, docs/portal/tuning-chat.md section 2): saved as
// shown or edited first, once however often or from however many tabs Save is pressed, finished after a crash,
// recorded so a reload shows what became of each proposal, private to the conversation's author, read-only under
// view-as, deleted with the conversation, and never logging the note's text.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg } from '../src/access/policy.ts';
import type { ConversationView } from '../src/handlers/chat.ts';
import type { ProposalResult } from '../src/handlers/chat-proposals.ts';
import { createChatProposalStore } from '../src/stores/chat-proposals.ts';
import { addGrant, addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { setupOrg } from './helpers/setup-org.ts';
import {
  call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let orgId: string;
let locationId: string;
let otherLocationId: string;
let author: TestSession;
let colleague: TestSession;
let admin: TestSession;

const PROPOSAL = {
  kind: 'private_event', startDate: '2026-06-20', endDate: '2026-06-20', weekdays: null, effect: 'more_guests',
  expectedGuests: 120, detail: 'Sentinel-proposal-detail rehearsal dinner',
} as const;
const SHOWN = 'Shown to the owner as a proposal. They decide whether to add it.';

async function person(role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

/**
 * The author's conversation with one finished turn: TownwiseAI proposed `PROPOSAL` (call `toolu_proposal0001`), and a
 * note that broke a rule (call `toolu_invalid0001`, answered as an error, so never shown).
 */
async function conversationWithProposal(opts: { location?: string; userId?: string } = {}): Promise<string> {
  const _id = new Types.ObjectId();
  const at = server.clock.now();
  const params = [
    { role: 'user', content: 'We have a rehearsal dinner on June 20.' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_proposal0001', name: 'propose_note', input: PROPOSAL },
      { type: 'tool_use', id: 'toolu_invalid0001', name: 'propose_note', input: { ...PROPOSAL, endDate: '2026-06-19' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_proposal0001', content: SHOWN },
      { type: 'tool_result', tool_use_id: 'toolu_invalid0001', is_error: true, content: 'Not a valid note.' },
    ] },
    { role: 'assistant', content: [{ type: 'text', text: 'I proposed the dinner as a note.' }] },
  ];
  await server.connection.collection('tw_chat_conversations').insertOne({
    _id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(opts.location ?? locationId),
    userId: opts.userId ?? author.userId, title: 'Rehearsal dinner',
    messages: params.map((param) => ({ at, param: JSON.stringify(param) })),
    turnCount: 1, liveTurn: null, createdAt: at, updatedAt: at,
  });
  return _id.toHexString();
}

function proposalPath(conversationId: string, proposalId = 'toolu_proposal0001', location = locationId): string {
  return `/api/org/locations/${location}/chat/${conversationId}/proposals/${proposalId}`;
}

async function act(conversationId: string, json: unknown, opts: { session?: TestSession; proposalId?: string; location?: string } = {}) {
  const res = await call(server, proposalPath(conversationId, opts.proposalId, opts.location), { session: opts.session ?? author, json });
  return { status: res.status, body: await res.json() as ProposalResult & { error?: string } };
}

async function notesOf(location = locationId): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_notes').find({ locationId: new Types.ObjectId(location) }).toArray();
}

async function proposalRows(conversationId: string): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_chat_proposals').find({ conversationId: new Types.ObjectId(conversationId) }).toArray();
}

async function shownState(conversationId: string): Promise<unknown> {
  const view = await (await call(server, `/api/org/locations/${locationId}/chat/${conversationId}`, { session: author })).json() as ConversationView;
  return view.messages.flatMap((message) => message.proposals).map(({ id, status, noteId }) => ({ id, status, noteId }));
}

async function createdEvents(noteId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((e) => e.action === 'note.created' && (e.target as { id: string }).id === noteId);
}

beforeAll(async () => {
  server = await startTownwiseServer();
  orgId = await createOrg(server, { name: 'Proposal Tavern' });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
  otherLocationId = await addLocation(server, { orgId, name: 'Patio' });
  author = await person('member');
  colleague = await person('member');
  admin = await person('org_admin');
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.connection.collection('tw_notes').deleteMany({});
});

describe('saving a proposal', () => {
  it('as shown: one note with the proposal’s content, recorded once, and the proposal reads saved after a reload', async () => {
    const id = await conversationWithProposal();
    expect(await shownState(id)).toEqual([{ id: 'toolu_proposal0001', status: 'open', noteId: null }]);
    const { status, body } = await act(id, { action: 'save' });
    expect(status).toBe(200);
    const noteId = body.proposal.noteId ?? '';
    expect(body.proposal).toEqual({ id: 'toolu_proposal0001', status: 'saved', noteId, edited: false });
    expect(body.note).toMatchObject({ ...PROPOSAL, id: noteId, canEdit: true });
    const notes = await notesOf();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ ...PROPOSAL, createdBy: author.userId });
    expect((notes[0]?._id as Types.ObjectId).toHexString()).toBe(noteId);
    expect(await createdEvents(noteId)).toHaveLength(1);
    expect(await shownState(id)).toEqual([{ id: 'toolu_proposal0001', status: 'saved', noteId }]);
    expect(await proposalRows(id)).toEqual([expect.objectContaining({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), userId: author.userId,
      proposalId: 'toolu_proposal0001', status: 'saved', edited: false, noteId: new Types.ObjectId(noteId),
    })]);
  });

  it('edited first: the note holds the edit and the proposal says it was edited; a note that breaks a rule is 400', async () => {
    const id = await conversationWithProposal();
    const broken = await act(id, { action: 'save', note: { ...PROPOSAL, kind: 'opening', effect: 'closed' } });
    expect(broken).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await notesOf()).toHaveLength(0);
    expect(await proposalRows(id)).toHaveLength(0);

    const edit = { ...PROPOSAL, expectedGuests: 80, detail: 'Rehearsal dinner, smaller' };
    const { status, body } = await act(id, { action: 'save', note: edit });
    expect(status).toBe(200);
    expect(body.proposal).toMatchObject({ status: 'saved', edited: true });
    expect(body.note).toMatchObject(edit);
    expect(await notesOf()).toEqual([expect.objectContaining(edit)]);
  });

  it('an edit identical to the proposal is not counted as edited', async () => {
    const id = await conversationWithProposal();
    const { body } = await act(id, { action: 'save', note: PROPOSAL });
    expect(body.proposal).toMatchObject({ status: 'saved', edited: false });
  });

  it('two tabs pressing Save at the same time make one note, and both answer it', async () => {
    const id = await conversationWithProposal();
    const results = await Promise.all([1, 2, 3].map(() => act(id, { action: 'save' })));
    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    const noteIds = new Set(results.map((result) => result.body.proposal.noteId));
    expect(noteIds.size).toBe(1);
    expect(await notesOf()).toHaveLength(1);
    expect(await createdEvents([...noteIds][0] ?? '')).toHaveLength(1);
    expect(await proposalRows(id)).toEqual([expect.objectContaining({ status: 'saved' })]);
  });

  it('pressing Save again answers the same note; Not now after a save answers saved', async () => {
    const id = await conversationWithProposal();
    const first = await act(id, { action: 'save' });
    const again = await act(id, { action: 'save', note: { ...PROPOSAL, expectedGuests: 10 } });
    expect(again).toMatchObject({ status: 200, body: { proposal: first.body.proposal, note: { id: first.body.proposal.noteId, expectedGuests: 120 } } });
    const dismiss = await act(id, { action: 'dismiss' });
    expect(dismiss).toMatchObject({ status: 200, body: { proposal: { status: 'saved', noteId: first.body.proposal.noteId } } });
    expect(await notesOf()).toHaveLength(1);
  });

  it('a saved proposal whose note was deleted since stays saved with no note, and is not saved twice', async () => {
    const id = await conversationWithProposal();
    const first = await act(id, { action: 'save' });
    const noteId = first.body.proposal.noteId ?? '';
    expect((await call(server, `/api/org/locations/${locationId}/notes/${noteId}`, { method: 'DELETE', session: author })).status).toBe(204);
    const again = await act(id, { action: 'save' });
    expect(again).toMatchObject({ status: 200, body: { proposal: { status: 'saved', noteId }, note: null } });
    expect(await notesOf()).toHaveLength(0);
  });

  it('a save that stopped after its claim finishes on the next press with the claimed note id: with its note written, or not', async () => {
    for (const written of [true, false]) {
      const id = await conversationWithProposal();
      const noteId = new Types.ObjectId();
      const at = server.clock.now();
      await server.connection.collection('tw_chat_proposals').insertOne({
        orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), conversationId: new Types.ObjectId(id),
        userId: author.userId, proposalId: 'toolu_proposal0001', status: 'saving', noteId, edited: false, createdAt: at, updatedAt: at,
      });
      if (written) {
        await server.connection.collection('tw_notes').insertOne({
          _id: noteId, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), ...PROPOSAL,
          createdBy: author.userId, createdAt: at, updatedAt: at,
        });
      }
      // A save still in progress reads as open, so Save is offered and finishes it.
      expect(await shownState(id)).toEqual([{ id: 'toolu_proposal0001', status: 'open', noteId: null }]);
      const { status, body } = await act(id, { action: 'save' });
      expect({ written, status, noteId: body.proposal.noteId }).toEqual({ written, status: 200, noteId: noteId.toHexString() });
      expect(await notesOf()).toHaveLength(1);
      // The earlier try wrote its note's event; only a note this press wrote is recorded now.
      expect(await createdEvents(noteId.toHexString())).toHaveLength(written ? 0 : 1);
      expect(await proposalRows(id)).toEqual([expect.objectContaining({ status: 'saved' })]);
      await server.connection.collection('tw_notes').deleteMany({});
    }
  });

  it('a location with 1,000 notes is 409 note_limit, and the proposal stays open', async () => {
    const id = await conversationWithProposal({ location: otherLocationId });
    const at = server.clock.now();
    await server.connection.collection('tw_notes').insertMany(Array.from({ length: 1000 }, () => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(otherLocationId), kind: 'closure', startDate: '2026-05-03',
      endDate: '2026-05-03', weekdays: null, effect: 'closed', expectedGuests: null, detail: null, createdBy: 'fixture',
      createdAt: at, updatedAt: at,
    })));
    const full = await act(id, { action: 'save' }, { location: otherLocationId });
    expect(full).toMatchObject({ status: 409, body: { error: 'note_limit' } });
    expect(await notesOf(otherLocationId)).toHaveLength(1000);
    const view = await (await call(server, `/api/org/locations/${otherLocationId}/chat/${id}`, { session: author })).json() as ConversationView;
    expect(view.messages.flatMap((m) => m.proposals).map((p) => p.status)).toEqual(['open']);
  });
});

describe('setting a proposal aside', () => {
  it('a Not now that lands while a Save is writing its note is overruled: the proposal ends saved', async () => {
    // The race the handler cannot order: claim, then another tab's Not now, then the note's write and markSaved.
    const id = await conversationWithProposal();
    const staff = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
    const scope = scopeForNewOrg(staff, orgId);
    const store = createChatProposalStore(server.connection);
    const key = { conversationId: id, proposalId: 'toolu_proposal0001' };
    const owner = { locationId, userId: author.userId, now: server.clock.now() };
    const claimed = await store.claimSave(scope, key, { ...owner, edited: false });
    expect(await store.dismiss(scope, key, owner)).toMatchObject({ status: 'dismissed', noteId: claimed?.noteId });
    await store.markSaved(scope, key, server.clock.now());
    expect(await store.find(scope, key)).toEqual({ ...claimed, status: 'saved' });
  });

  it('Not now records it as dismissed after a reload, and it can still be saved later', async () => {
    const id = await conversationWithProposal();
    const dismissed = await act(id, { action: 'dismiss' });
    expect(dismissed).toEqual({
      status: 200, body: { proposal: { id: 'toolu_proposal0001', status: 'dismissed', noteId: null, edited: false }, note: null },
    });
    expect(await notesOf()).toHaveLength(0);
    expect(await shownState(id)).toEqual([{ id: 'toolu_proposal0001', status: 'dismissed', noteId: null }]);
    expect(await act(id, { action: 'dismiss' })).toEqual(dismissed);

    const saved = await act(id, { action: 'save' });
    expect(saved.body.proposal).toMatchObject({ status: 'saved' });
    expect(await notesOf()).toHaveLength(1);
    expect(await shownState(id)).toEqual([{ id: 'toolu_proposal0001', status: 'saved', noteId: saved.body.proposal.noteId }]);
  });
});

describe('what a reload shows', () => {
  it('a proposal with no record reads as saved when a note of the location says exactly the same', async () => {
    const id = await conversationWithProposal();
    const added = await call(server, `/api/org/locations/${locationId}/notes`, { session: author, json: PROPOSAL });
    const { note } = await added.json() as { note: { id: string } };
    expect(await shownState(id)).toEqual([{ id: 'toolu_proposal0001', status: 'saved', noteId: note.id }]);
  });

  it('a colleague’s note that says the same does not count: the proposal stays open, and saving it makes the author’s note', async () => {
    const id = await conversationWithProposal();
    expect((await call(server, `/api/org/locations/${locationId}/notes`, { session: colleague, json: PROPOSAL })).status).toBe(201);
    expect(await shownState(id)).toEqual([{ id: 'toolu_proposal0001', status: 'open', noteId: null }]);
    const { body } = await act(id, { action: 'save' });
    expect(await shownState(id)).toEqual([{ id: 'toolu_proposal0001', status: 'saved', noteId: body.proposal.noteId }]);
    expect((await notesOf()).map((note) => note.createdBy).sort()).toEqual([author.userId, colleague.userId].sort());
  });
});

describe('who may act on a proposal', () => {
  it('only the conversation’s author: anyone else, another location’s path, or an id that was never shown is 404', async () => {
    const id = await conversationWithProposal();
    for (const session of [colleague, admin]) {
      expect(await act(id, { action: 'save' }, { session })).toMatchObject({ status: 404, body: { error: 'not_found' } });
      expect(await act(id, { action: 'dismiss' }, { session })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
    expect(await act(id, { action: 'save' }, { location: otherLocationId })).toMatchObject({ status: 404 });
    for (const proposalId of ['toolu_invalid0001', 'toolu_unknown0001']) {
      expect(await act(id, { action: 'save' }, { proposalId })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
    expect(await act(new Types.ObjectId().toHexString(), { action: 'save' })).toMatchObject({ status: 404 });
    expect(await notesOf()).toHaveLength(0);
    expect(await proposalRows(id)).toHaveLength(0);
  });

  it('refuses a malformed proposal id, conversation id or body with 400', async () => {
    const id = await conversationWithProposal();
    expect(await act(id, { action: 'save' }, { proposalId: 'bad.id' })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await act('not-an-id', { action: 'save' })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    for (const json of [{}, { action: 'keep' }, { action: 'save', note: 'text' }]) {
      expect(await act(id, json)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
  });

  it('staff in view-as are refused with 403 view_as_read_only, and nothing is written', async () => {
    const id = await conversationWithProposal();
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: author.userId, orgId });
      for (const json of [{ action: 'save' }, { action: 'dismiss' }]) {
        expect(await act(id, json, { session: staff })).toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
      }
      expect(await notesOf()).toHaveLength(0);
      expect(await proposalRows(id)).toHaveLength(0);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });
});

describe('deletion and logs', () => {
  it('deleting the conversation deletes its proposal records; the notes saved from them stay', async () => {
    const id = await conversationWithProposal();
    const keep = await conversationWithProposal();
    await act(id, { action: 'save' });
    await act(keep, { action: 'dismiss' });
    expect((await call(server, `/api/org/locations/${locationId}/chat/${id}`, { method: 'DELETE', session: author })).status).toBe(204);
    expect(await proposalRows(id)).toHaveLength(0);
    expect(await proposalRows(keep)).toHaveLength(1);
    expect(await notesOf()).toHaveLength(1);
  });

  it('deleting the conversation deletes its order cards, and no other conversation’s', async () => {
    const id = await conversationWithProposal();
    const keep = await conversationWithProposal();
    const cards = server.connection.collection('tw_order_cards');
    await cards.insertMany([id, keep].map((conversationId) => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), conversationId: new Types.ObjectId(conversationId),
      proposalId: 'toolu_order0001', kind: 'change', status: 'dismissed', decisionId: new Types.ObjectId(), createdAt: server.clock.now(),
    })));
    // A13: the cards go before the conversation, so a colleague's DELETE (404) must not reach them.
    expect((await call(server, `/api/org/locations/${locationId}/chat/${id}`, { method: 'DELETE', session: colleague })).status).toBe(404);
    expect(await cards.countDocuments({ conversationId: new Types.ObjectId(id) })).toBe(1);
    expect((await call(server, `/api/org/locations/${locationId}/chat/${id}`, { method: 'DELETE', session: author })).status).toBe(204);
    expect(await cards.countDocuments({ conversationId: new Types.ObjectId(id) })).toBe(0);
    expect(await cards.countDocuments({ conversationId: new Types.ObjectId(keep) })).toBe(1);
  });

  it('logs the outcome with ids only, and no log line or event holds the note’s text', async () => {
    const id = await conversationWithProposal();
    server.logs.length = 0;
    await act(id, { action: 'save', note: { ...PROPOSAL, detail: 'Sentinel-edited-detail' } });
    const lines = server.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === 'townwise.chat_proposal');
    expect(lines).toEqual([expect.objectContaining({ orgId, locationId, conversationId: id, status: 'saved', edited: true })]);
    const everything = server.logs.join('\n') + JSON.stringify(await auditEvents(server));
    for (const sentinel of ['Sentinel-proposal-detail', 'Sentinel-edited-detail']) expect(everything).not.toContain(sentinel);
  });
});

/** Staff open a new organization nobody has joined as its admin and add a location. */
async function openAsAdminOrg(): Promise<{ staff: TestSession; orgId: string; locationId: string }> {
  const staff = await signInStaff(server);
  const setup = await setupOrg(server, staff);
  const started = await call(server, `/api/admin/orgs/${setup.orgId}/open-as-admin`, { method: 'POST', session: staff });
  expect(started.status).toBe(201);
  const created = await call(server, '/api/org/locations', {
    session: staff, json: { name: 'Main Street', town: { townId: 'hanover-nh' }, orgId: setup.orgId },
  });
  expect(created.status).toBe(201);
  return { staff, orgId: setup.orgId, locationId: (await created.json() as { location: { id: string } }).location.id };
}

describe('open as admin', () => {
  it('open as admin: saving a proposal makes a note by Townwise staff', async () => {
    const { staff, orgId: setupId, locationId: staffLocation } = await openAsAdminOrg();
    try {
      const id = await conversationWithProposal({ location: staffLocation, userId: staff.userId });
      // The conversation helper writes into this file's own organization; move it to the one staff opened.
      await server.connection.collection('tw_chat_conversations').updateOne(
        { _id: new Types.ObjectId(id) }, { $set: { orgId: new Types.ObjectId(setupId) } },
      );
      const { status, body } = await act(id, { action: 'save' }, { session: staff, location: staffLocation });
      expect(status).toBe(200);
      const noteId = body.proposal.noteId ?? '';
      expect(body.note?.createdByEmail).toBe('Townwise staff');
      const notes = await notesOf(staffLocation);
      expect(notes).toEqual([expect.objectContaining({ byStaff: true, createdBy: staff.userId })]);
      const events = await createdEvents(noteId);
      expect(events).toEqual([expect.objectContaining({ actorRole: 'superadmin', actorEmail: STAFF_EMAIL })]);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });
});
