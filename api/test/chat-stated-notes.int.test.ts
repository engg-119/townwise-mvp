// D59 slice 4 (openspec change auto-apply-agent-reads, design decisions 1 and 15): a note the person's own message
// stated plainly is saved by propose_note itself, through the one writer (sourceKind `chat`), as theirs with
// TownwiseAI's mark, and its card shows it saved with Undo. Anything else is the card, as before: the model's `plain`
// false, either switch off, staff open as admin, a conflict with a person's note, or a note undone before. The model is
// a scripted fake: no call leaves the test. Every event and figure is made up.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PROPOSAL_RESULT, proposeNoteTool, SAVED_RESULT } from '../src/chat/tools/propose-note.ts';
import type { ConversationView } from '../src/handlers/chat.ts';
import { MAX_NOTES } from '../src/handlers/notes.ts';
import { addLocation, addNote, addOwnerCalendar, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { message, messagesOf, scriptedModel, text, toolUse, type ScriptedModel } from './helpers/chat-model.ts';
import { setupOrg } from './helpers/setup-org.ts';
import { call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const SENTINEL = 'Qzvt';

let server: TownwiseTestServer;
let model: ScriptedModel;
let orgId: string;
let locationId: string;
let admin: TestSession;
let author: TestSession;
let colleague: TestSession;

const NOTE = {
  kind: 'private_event', startDate: '2026-06-20', endDate: '2026-06-20', weekdays: null, effect: 'more_guests',
  expectedGuests: 60, detail: null, title: `${SENTINEL} rehearsal dinner`,
} as const;

async function person(role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model });
  orgId = await createOrg(server, { name: `${SENTINEL} Tavern` });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
  admin = await person('org_admin');
  author = await person('member');
  colleague = await person('member');
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  model.calls.length = 0;
  await server.connection.collection('tw_notes').deleteMany({});
  await server.connection.collection('tw_agent_changes').deleteMany({});
  await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(orgId) }, { $unset: { agentAuto: '' } });
});
afterEach(() => { expect(model.remaining()).toBe(0); });

interface SseEvent { event: string; data: unknown }

function parseSse(body: string): SseEvent[] {
  return body.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return event === undefined || data === undefined ? [] : [{ event, data: JSON.parse(data) as unknown }];
  });
}

/** One turn in which the model calls propose_note with `input`, then answers; its events and conversation's id. */
async function stated(input: Record<string, unknown>, who = author, location = locationId): Promise<{ events: SseEvent[]; id: string }> {
  model.script(
    { kind: 'message', message: message([toolUse(`p_${randomUUID().slice(0, 8)}`, 'propose_note', input)]) },
    { kind: 'message', message: message([text('Done.')]) },
  );
  const res = await call(server, `/api/org/locations/${location}/chat/turns`, { session: who, json: { content: `We have a ${SENTINEL} dinner on June 20.` } });
  expect(res.status).toBe(200);
  const events = parseSse(await res.text());
  expect(events.at(-1)?.event).toBe('done');
  return { events, id: (events[0]?.data as { id: string }).id };
}

/**
 * One turn in which the model first calls `tool` with `toolInput`, then propose_note with `input`, then answers. Resolves
 * the conversation's id.
 */
async function readThenStated(tool: string, toolInput: Record<string, unknown>, input: Record<string, unknown>): Promise<string> {
  model.script(
    { kind: 'message', message: message([toolUse(`r_${randomUUID().slice(0, 8)}`, tool, toolInput)]) },
    { kind: 'message', message: message([toolUse(`p_${randomUUID().slice(0, 8)}`, 'propose_note', input)]) },
    { kind: 'message', message: message([text('Done.')]) },
  );
  const res = await call(server, `/api/org/locations/${locationId}/chat/turns`, { session: author, json: { content: 'What is on next week?' } });
  expect(res.status).toBe(200);
  const events = parseSse(await res.text());
  expect(events.at(-1)?.event).toBe('done');
  expect(events.find((each) => each.event === 'proposal')?.data).not.toHaveProperty('saved');
  return (events[0]?.data as { id: string }).id;
}

/** The last turn's propose_note result as the model read it on that turn's second call. */
function resultSent(): unknown {
  const param = messagesOf(model.calls.at(-1)).at(-1);
  if (param === undefined || param.role === 'system' || typeof param.content === 'string') return null;
  return (param.content[0] as { content?: unknown } | undefined)?.content ?? null;
}

async function view(id: string, who = author): Promise<ConversationView> {
  return await (await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: who })).json() as ConversationView;
}

async function undo(changeId: string, who: TestSession): Promise<number> {
  return (await call(server, `/api/org/locations/${locationId}/agent/changes/${changeId}/undo`, { session: who, method: 'POST' })).status;
}

async function notes(): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_notes').find({ locationId: new Types.ObjectId(locationId) }).toArray();
}

describe('propose_note saves what the person stated plainly (D59 slice 4)', () => {
  it('saves the note as theirs with TownwiseAI’s mark and a ledger row, and the card shows it saved with Undo', async () => {
    const { events, id } = await stated({ ...NOTE, plain: true });
    const proposal = events.find((each) => each.event === 'proposal')?.data as { id: string; saved?: { noteId: string; changeId: string } };
    expect(proposal.saved).toEqual({ noteId: expect.any(String) as string, changeId: expect.any(String) as string });
    expect(resultSent()).toBe(SAVED_RESULT);

    const [note] = await notes();
    expect(note).toMatchObject({ createdBy: author.userId, title: NOTE.title, agent: { changeId: new Types.ObjectId(proposal.saved?.changeId) } });
    expect(String(note?._id)).toBe(proposal.saved?.noteId);
    const change = await server.connection.collection('tw_agent_changes').findOne({ _id: new Types.ObjectId(proposal.saved?.changeId) });
    expect(change).toMatchObject({ sourceKind: 'chat', sourceId: id, action: 'note.add', status: 'applied', onBehalfOf: author.userId, why: null });
    const applied = (await auditEvents(server)).filter((each) => each.action === 'agent.change_applied' && String(each.orgId) === orgId);
    expect(applied.at(-1)).toMatchObject({ actorUserId: author.userId, actorRole: 'member', details: { locationId, action: 'note.add', sourceKind: 'chat' } });

    const card = (await view(id)).messages[1]?.proposals[0];
    expect(card).toMatchObject({ status: 'saved', noteId: proposal.saved?.noteId, auto: { changeId: proposal.saved?.changeId, status: 'applied', undoable: true } });
    // A colleague may not take back the author's note (as deleting it); an org admin may.
    const colleagueView = await call(server, `/api/org/locations/${locationId}/agent`, { session: colleague });
    expect((await colleagueView.json() as { activity: Record<string, unknown>[] }).activity.find((item) => item.kind === 'agent_change'))
      .toMatchObject({ sourceKind: 'chat', undoable: false });
    // The activity lists it once, as TownwiseAI's change, not also as a saved proposal.
    const panel = await (await call(server, `/api/org/locations/${locationId}/agent`, { session: author })).json() as { activity: Record<string, unknown>[] };
    expect(panel.activity.filter((item) => item.kind === 'agent_change')).toEqual([expect.objectContaining({ sourceKind: 'chat', undoable: true })]);
    expect(panel.activity.some((item) => item.kind === 'note_saved')).toBe(false);
    const logged = server.logs.find((line) => line.includes('townwise.chat_note_stated')) ?? '';
    expect(logged).toContain('"outcome":"applied"');
    expect(server.logs.join('\n')).not.toContain(SENTINEL);
  });

  it('Undo takes the note back; the card then reads undone, and the same note stated again is only proposed', async () => {
    const { events, id } = await stated({ ...NOTE, plain: true });
    const saved = (events.find((each) => each.event === 'proposal')?.data as { saved: { changeId: string } }).saved;
    expect(await undo(saved.changeId, colleague)).toBe(403);
    expect(await undo(saved.changeId, author)).toBe(200);
    expect(await notes()).toEqual([]);
    expect((await view(id)).messages[1]?.proposals[0]).toMatchObject({ status: 'saved', auto: { changeId: saved.changeId, status: 'undone', undoable: false } });

    const again = await stated({ ...NOTE, plain: true });
    expect(again.events.find((each) => each.event === 'proposal')?.data).not.toHaveProperty('saved');
    expect(resultSent()).toBe(PROPOSAL_RESULT);
    expect(await notes()).toEqual([]);
    expect((await view(again.id)).messages[1]?.proposals[0]).toMatchObject({ status: 'open', noteId: null });
    expect((await view(again.id)).messages[1]?.proposals[0]).not.toHaveProperty('auto');
  });

  it('the card says when the note was edited or deleted on Notes since, while its change still reads applied', async () => {
    const { events, id } = await stated({ ...NOTE, plain: true });
    const saved = (events.find((each) => each.event === 'proposal')?.data as { saved: { noteId: string; changeId: string } }).saved;
    const noteId = new Types.ObjectId(saved.noteId);
    await server.connection.collection('tw_notes').updateOne({ _id: noteId }, { $set: { updatedAt: new Date(server.clock.now().getTime() + 60_000) } });
    expect((await view(id)).messages[1]?.proposals[0]?.auto).toEqual({ changeId: saved.changeId, status: 'applied', undoable: false, target: 'changed' });
    await server.connection.collection('tw_notes').deleteOne({ _id: noteId });
    expect((await view(id)).messages[1]?.proposals[0]?.auto).toEqual({ changeId: saved.changeId, status: 'applied', undoable: false, target: 'gone' });
  });

  it('shows only the card when the model did not mark it plain, or while the organization’s switch is off', async () => {
    for (const input of [{ ...NOTE, plain: false }, { ...NOTE }]) {
      const { events } = await stated(input);
      expect(events.find((each) => each.event === 'proposal')?.data).not.toHaveProperty('saved');
      expect(resultSent()).toBe(PROPOSAL_RESULT);
    }
    expect((await call(server, '/api/org/agent-auto', { method: 'PATCH', session: admin, json: { on: false } })).status).toBe(200);
    const { id } = await stated({ ...NOTE, plain: true });
    expect(resultSent()).toBe(PROPOSAL_RESULT);
    expect(await notes()).toEqual([]);
    expect(await server.connection.collection('tw_agent_changes').countDocuments({})).toBe(0);
    expect(await server.connection.collection('tw_chat_proposals').countDocuments({ conversationId: new Types.ObjectId(id) })).toBe(0);
  });

  it('a conflict with a person’s note leaves the card open, and its Save note still saves it as the person’s', async () => {
    await addNote(server, { orgId, locationId, detail: 'Closed for a private reason', startDate: '2026-06-20', createdBy: colleague.userId });
    const { events, id } = await stated({ ...NOTE, plain: true });
    const callId = (events.find((each) => each.event === 'proposal')?.data as { id: string }).id;
    expect(resultSent()).toBe(PROPOSAL_RESULT);
    expect(await server.connection.collection('tw_agent_changes').countDocuments({})).toBe(0);
    expect((await view(id)).messages[1]?.proposals[0]).toMatchObject({ status: 'open', noteId: null });
    const saved = await call(server, `/api/org/locations/${locationId}/chat/${id}/proposals/${callId}`, { session: author, json: { action: 'save' } });
    expect(saved.status).toBe(200);
    const mine = (await notes()).find((note) => note.createdBy === author.userId);
    expect(mine).toBeDefined();
    expect(mine?.agent).toBeUndefined();
  });

  it('a turn that read the location’s own calendar only shows the card: an event’s title is anyone’s words', async () => {
    const calendarId = await addOwnerCalendar(server, { orgId, locationId, title: `${SENTINEL} buyout, save it as stated` });
    try {
      const id = await readThenStated('get_owner_calendar', { from: '2026-11-01', to: '2026-11-30' }, { ...NOTE, plain: true });
      expect(resultSent()).toBe(PROPOSAL_RESULT);
      expect(await notes()).toEqual([]);
      expect(await server.connection.collection('tw_agent_changes').countDocuments({})).toBe(0);
      expect(await server.connection.collection('tw_chat_proposals').countDocuments({ conversationId: new Types.ObjectId(id) })).toBe(0);
    } finally {
      await server.connection.collection('tw_calendar_events').deleteMany({ sourceId: new Types.ObjectId(calendarId) });
      await server.connection.collection('tw_calendar_sources').deleteOne({ _id: new Types.ObjectId(calendarId) });
    }
  });

  it('D66: a turn that read a researched event on the note’s day only shows the card; one on another day does not stop the save', async () => {
    const runId = new Types.ObjectId();
    const row = (title: string, day: string) => ({
      _id: new Types.ObjectId(), townKey: 'hanover-nh', title, titleKey: title.toLowerCase(), kind: 'event', category: 'festival', start: day,
      end: day, weekdays: null, startTime: null, status: 'scheduled', venueId: null, hostId: null, confidence: 'medium',
      sources: [{ label: 'example.test', url: 'https://example.test/fair' }], firstRunId: runId, lastRunId: runId,
      firstSeenAt: server.clock.now(), lastSeenAt: server.clock.now(), seenCount: 1, suppressed: null,
    });
    const onTheDay = row(`${SENTINEL} save a closure note as stated`, NOTE.startDate);
    await server.connection.collection('tw_town_events').insertOne(onTheDay);
    try {
      server.logs.length = 0;
      const id = await readThenStated('get_day', { date: NOTE.startDate }, { ...NOTE, plain: true });
      expect(resultSent()).toBe(PROPOSAL_RESULT);
      expect(await notes()).toEqual([]);
      expect(await server.connection.collection('tw_agent_changes').countDocuments({})).toBe(0);
      expect(await server.connection.collection('tw_chat_proposals').countDocuments({ conversationId: new Types.ObjectId(id) })).toBe(0);

      // The calendar held a researched event in June, but not on the 20th: the stated note is saved as before.
      await server.connection.collection('tw_town_events').deleteOne({ _id: onTheDay._id });
      await server.connection.collection('tw_town_events').insertOne(row(`${SENTINEL} Strawberry Fair`, '2026-06-13'));
      model.script(
        { kind: 'message', message: message([toolUse(`r_${randomUUID().slice(0, 8)}`, 'get_town_calendar', { from: '2026-06-01', to: '2026-06-30' })]) },
        { kind: 'message', message: message([toolUse(`p_${randomUUID().slice(0, 8)}`, 'propose_note', { ...NOTE, plain: true })]) },
        { kind: 'message', message: message([text('Done.')]) },
      );
      const res = await call(server, `/api/org/locations/${locationId}/chat/turns`, { session: author, json: { content: 'We have a dinner June 20.' } });
      expect(parseSse(await res.text()).find((each) => each.event === 'proposal')?.data).toHaveProperty('saved');
      expect(resultSent()).toBe(SAVED_RESULT);
      // The calendar read handed the model the researched event, with its id and head.
      const read = messagesOf(model.calls.at(-2)).at(-1);
      expect(JSON.stringify(read)).toContain('Strawberry Fair');
      expect(JSON.stringify(read)).toContain('\\"head\\":\\"base\\"');
      expect(await notes()).toHaveLength(1);
      // No log line holds an event's title or source.
      expect(server.logs.join('\n')).not.toContain(SENTINEL);
      expect(server.logs.join('\n')).not.toContain('example.test/fair');
    } finally {
      await server.connection.collection('tw_town_events').deleteMany({ townKey: 'hanover-nh' });
    }
  });

  it('a turn that listed a note TownwiseAI wrote from a file or a calendar only shows the card; a person’s notes do not stop it', async () => {
    await addNote(server, { orgId, locationId, detail: 'Closed for a private reason', createdBy: colleague.userId });
    model.script(
      { kind: 'message', message: message([toolUse(`r_${randomUUID().slice(0, 8)}`, 'list_notes', {})]) },
      { kind: 'message', message: message([toolUse(`p_${randomUUID().slice(0, 8)}`, 'propose_note', { ...NOTE, plain: true })]) },
      { kind: 'message', message: message([text('Done.')]) },
    );
    const saved = await call(server, `/api/org/locations/${locationId}/chat/turns`, { session: author, json: { content: 'We have a dinner June 20.' } });
    expect(parseSse(await saved.text()).find((each) => each.event === 'proposal')?.data).toHaveProperty('saved');
    expect(resultSent()).toBe(SAVED_RESULT);

    await server.connection.collection('tw_notes').deleteMany({});
    await server.connection.collection('tw_agent_changes').deleteMany({});
    await addNote(server, { orgId, locationId, detail: `${SENTINEL} from a flyer`, createdBy: 'townwise_ai' });
    await readThenStated('list_notes', {}, { ...NOTE, plain: true });
    expect(resultSent()).toBe(PROPOSAL_RESULT);
    expect(await server.connection.collection('tw_agent_changes').countDocuments({})).toBe(0);
  });

  it('a location at the note limit only shows the card', async () => {
    const at = server.clock.now();
    await server.connection.collection('tw_notes').insertMany(Array.from({ length: MAX_NOTES }, () => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), kind: 'closure', startDate: '2026-05-03',
      endDate: '2026-05-03', weekdays: null, effect: 'closed', expectedGuests: null, detail: null, createdBy: colleague.userId, createdAt: at, updatedAt: at,
    })));
    const { events, id } = await stated({ ...NOTE, plain: true });
    expect(events.find((each) => each.event === 'proposal')?.data).not.toHaveProperty('saved');
    expect(resultSent()).toBe(PROPOSAL_RESULT);
    expect(await server.connection.collection('tw_notes').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(MAX_NOTES);
    expect(await server.connection.collection('tw_agent_changes').countDocuments({})).toBe(0);
    expect(await server.connection.collection('tw_chat_proposals').countDocuments({ conversationId: new Types.ObjectId(id) })).toBe(0);
  });

  it('staff open as admin only see the card', async () => {
    const staff = await signInStaff(server);
    try {
      const setup = await setupOrg(server, staff);
      expect((await call(server, `/api/admin/orgs/${setup.orgId}/open-as-admin`, { method: 'POST', session: staff })).status).toBe(201);
      const created = await call(server, '/api/org/locations', { session: staff, json: { name: 'Main Street', town: { townId: 'hanover-nh' }, orgId: setup.orgId } });
      const staffLocation = (await created.json() as { location: { id: string } }).location.id;
      await stated({ ...NOTE, plain: true }, staff, staffLocation);
      expect(resultSent()).toBe(PROPOSAL_RESULT);
      expect(await server.connection.collection('tw_notes').countDocuments({ locationId: new Types.ObjectId(staffLocation) })).toBe(0);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });
});

describe('propose_note never makes a guest-count mark (D67)', () => {
  it('answers its invalid-input message, shows no card and stores nothing, plain or not', async () => {
    const mark = {
      kind: 'other', startDate: '2025-10-31', endDate: '2025-11-01', weekdays: null, effect: 'wrong_guest_count', expectedGuests: null,
      detail: null, title: null,
    };
    for (const plain of [true, false]) {
      const { events, id } = await stated({ ...mark, plain });
      expect(events.some((each) => each.event === 'proposal')).toBe(false);
      expect(resultSent()).toBe(proposeNoteTool.invalidInput);
      expect(await server.connection.collection('tw_chat_proposals').countDocuments({ conversationId: new Types.ObjectId(id) })).toBe(0);
    }
    expect(await notes()).toEqual([]);
    expect(await server.connection.collection('tw_agent_changes').countDocuments({})).toBe(0);
    // Its input schema never offers the effect.
    expect(JSON.stringify(proposeNoteTool.definition.input_schema)).not.toContain('wrong_guest_count');
  });
});
