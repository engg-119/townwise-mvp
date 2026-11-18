// TownwiseAI's weekly suggestions (openspec change weekly-forecast-suggestions): the org admin's switch (on for an
// organization that never set it, off and back on by an org admin, refused to members and under view-as), and the
// suggestions a pass stored, as GET .../agent lists them and as an org admin accepts (one note or rule however often it
// is sent, with the suggestion's id) or dismisses them; an expired one is gone, another organization's is 404, and they
// go with their location. Every date and number is synthetic; the test clock reads Mon, Jun 1, 2026 (Hanover).
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import type { AgentPanel } from '../src/handlers/agent.ts';
import type { DecideResult } from '../src/handlers/weekly-suggestions.ts';
import { SUGGESTIONS_SEEN_MS } from '../src/lab/schedule.ts';
import { createAgentSuggestionStore, type FollowContent, type NewSuggestion, type SuggestionRecord } from '../src/stores/agent-suggestions.ts';
import type { NoteContent } from '../src/stores/notes.ts';
import { addGrant, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, logLines, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

interface Team { orgId: string; scope: OrgScope; admin: TestSession; member: TestSession; locationId: string }

async function person(orgId: string, role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

async function team(): Promise<Team> {
  const orgId = await createOrg(server, { name: `Suggest Kitchen ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, scope: { orgId } as OrgScope, admin: await person(orgId, 'org_admin'), member: await person(orgId, 'member'), locationId };
}

/** A closure suggestion for one day. */
function closureOn(date: string): NewSuggestion {
  return {
    content: {
      type: 'note',
      note: {
        kind: 'closure', startDate: date, endDate: date, weekdays: null, effect: 'closed', expectedGuests: null,
        detail: null, startTime: null, endTime: null,
      },
    },
    why: 'Independence Day is Sat, Jul 4, and you were closed on it last year.',
    calendarIds: ['us:independence-day:2026'],
  };
}

const THANKSGIVING_LIKE = closureOn('2026-07-04');

const COMMENCEMENT_RULE: NewSuggestion = {
  content: {
    type: 'rule', text: 'Private party after Commencement',
    schedule: {
      kind: 'private_event', startDate: '2026-06-14', endDate: '2026-06-14', weekdays: null, effect: 'more_guests', expectedGuests: 40,
      startTime: null, endTime: null,
    },
  },
  why: 'Commencement is Sun, Jun 14.',
  calendarIds: ['hanover-nh:2026-06-14:commencement', 'not-a-calendar-id'],
};

async function stored(t: Team, suggestions: readonly NewSuggestion[], week = '2026-06-01'): Promise<SuggestionRecord[]> {
  return createAgentSuggestionStore(server.connection).insert(t.scope, { locationId: t.locationId, week, suggestions, now: server.clock.now() });
}

async function panel(t: Team, session: TestSession, locationId = t.locationId): Promise<AgentPanel> {
  const res = await call(server, `/api/org/locations/${locationId}/agent`, { session });
  expect(res.status).toBe(200);
  return await res.json() as AgentPanel;
}

function decide(t: Team, session: TestSession, id: string, action: 'accept' | 'dismiss', body: unknown = {}, locationId = t.locationId): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/agent/suggestions/${id}/${action}`, { session, json: body });
}

function switchTo(session: TestSession, body: unknown): Promise<Response> {
  return call(server, '/api/org/weekly-suggestions', { method: 'PATCH', session, json: body });
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

async function orgDoc(orgId: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(orgId) });
}

describe('the switch', () => {
  afterEach(async () => {
    await removeStaffFactor(server);
    await server.connection.collection('tw_view_as_grants').deleteMany({});
  });

  it('reads as on for an organization that never set it, to members and admins alike', async () => {
    const t = await team();
    expect((await orgDoc(t.orgId))?.weeklySuggestions).toBeUndefined();
    expect((await panel(t, t.member)).weeklySuggestions).toEqual({ on: true, available: false, canChange: false });
    expect((await panel(t, t.admin)).weeklySuggestions).toEqual({ on: true, available: false, canChange: true });
  });

  it('is available only while the weekly worker has run them lately and staff have not paused it', async () => {
    const t = await team();
    const schedule = server.connection.collection('tw_forecast_schedule');
    const ranAt = async (at: Date) => {
      await schedule.updateOne({ _id: 'weekly' as never }, { $set: { suggestionsAt: at }, $setOnInsert: { owner: null, leaseUntil: at, paused: null } }, { upsert: true });
    };
    try {
      await ranAt(new Date(server.clock.now().getTime() - 30 * 60_000));
      expect((await panel(t, t.member)).weeklySuggestions.available).toBe(true);
      await ranAt(new Date(server.clock.now().getTime() - SUGGESTIONS_SEEN_MS - 60_000));
      expect((await panel(t, t.member)).weeklySuggestions.available).toBe(false);
      await ranAt(server.clock.now());
      await server.ctx.stores.forecastSchedule.setPaused({ at: server.clock.now(), by: 'staff-0000', email: 'staff@townwise.test' }, server.clock.now());
      expect((await panel(t, t.member)).weeklySuggestions.available).toBe(false);
    } finally {
      await schedule.deleteMany({});
    }
  });

  it('an org admin turns it off and back on, each recorded once with its state only', async () => {
    const t = await team();
    const off = await switchTo(t.admin, { on: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ weeklySuggestions: { on: false } });
    expect(await orgDoc(t.orgId)).toMatchObject({ weeklySuggestions: { on: false, by: t.admin.userId } });
    expect((await panel(t, t.member)).weeklySuggestions.on).toBe(false);
    // The same state again writes nothing.
    expect((await switchTo(t.admin, { on: false })).status).toBe(200);
    expect((await switchTo(t.admin, { on: true })).status).toBe(200);
    expect((await panel(t, t.member)).weeklySuggestions.on).toBe(true);
    const events = (await auditEvents(server)).filter((event) => event.action === 'org.weekly_suggestions_changed' && String(event.orgId) === t.orgId);
    expect(events.map((event) => event.details)).toEqual([{ on: false }, { on: true }]);
    expect(events[0]).toMatchObject({ actorUserId: t.admin.userId, actorRole: 'org_admin', target: { type: 'org', id: t.orgId } });
    expect(logLines(server).filter((line) => line.msg === 'townwise.weekly_suggestions_switched').at(-1)).toEqual(
      expect.objectContaining({ orgId: t.orgId, on: true }),
    );
  });

  it('refuses a member (403) and anything but { on } (400), changing nothing', async () => {
    const t = await team();
    expect(await errorOf(await switchTo(t.member, { on: false }))).toEqual({ status: 403, error: 'forbidden' });
    for (const body of [{}, { on: 'no' }, { on: false, note: 'off please' }]) {
      expect((await switchTo(t.admin, body)).status).toBe(400);
    }
    expect((await orgDoc(t.orgId))?.weeklySuggestions).toBeUndefined();
  });

  it('is refused under view-as (403 view_as_read_only), and staff in view-as cannot decide', async () => {
    const t = await team();
    const [suggestion] = await stored(t, [THANKSGIVING_LIKE]);
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.admin.userId, orgId: t.orgId });
    expect(await errorOf(await switchTo(staff, { on: false }))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect(await errorOf(await decide(t, staff, suggestion?.id ?? '', 'accept'))).toEqual({ status: 403, error: 'view_as_read_only' });
    const viewed = await panel(t, staff);
    expect(viewed.suggestions).toHaveLength(1);
    expect(viewed.weeklySuggestions.canChange).toBe(false);
    expect((await orgDoc(t.orgId))?.weeklySuggestions).toBeUndefined();
  });
});

describe('open as admin (D25)', () => {
  afterEach(async () => {
    await removeStaffFactor(server);
    await server.connection.collection('tw_view_as_grants').deleteMany({});
  });

  it('staff setting the organization up decide as its admin; the switch needs the tab’s orgId (409 without it)', async () => {
    const t = await team();
    const [suggestion] = await stored(t, [THANKSGIVING_LIKE]);
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: t.orgId });
    expect((await panel(t, staff)).weeklySuggestions.canChange).toBe(true);
    expect(await errorOf(await switchTo(staff, { on: false }))).toEqual({ status: 409, error: 'open_as_admin_active' });
    expect((await switchTo(staff, { on: false, orgId: t.orgId })).status).toBe(200);
    expect((await decide(t, staff, suggestion?.id ?? '', 'dismiss')).status).toBe(200);
    const events = (await auditEvents(server)).filter((event) => String(event.orgId) === t.orgId
      && ['org.weekly_suggestions_changed', 'agent.suggestion_dismissed'].includes(String(event.action)));
    expect(events.map((event) => event.actorRole)).toEqual(['superadmin', 'superadmin']);
  });
});

describe('suggestions', () => {
  it('are listed to every member, soonest first, with the calendar entries they name and no unknown id', async () => {
    const t = await team();
    await stored(t, [THANKSGIVING_LIKE, COMMENCEMENT_RULE]);
    const { suggestions } = await panel(t, t.member);
    expect(suggestions).toEqual([
      expect.objectContaining({
        type: 'rule', text: 'Private party after Commencement', schedule: (COMMENCEMENT_RULE.content as { schedule: unknown }).schedule,
        scheduleSummary: expect.any(String) as unknown, why: COMMENCEMENT_RULE.why,
        calendar: [{ id: 'hanover-nh:2026-06-14:commencement', title: 'Commencement', start: '2026-06-14', end: '2026-06-14' }],
      }),
      expect.objectContaining({
        type: 'note', note: (THANKSGIVING_LIKE.content as { note: unknown }).note, why: THANKSGIVING_LIKE.why,
        calendar: [{ id: 'us:independence-day:2026', title: 'Independence Day', start: '2026-07-04', end: '2026-07-04' }],
      }),
    ]);
  });

  it('change nothing until accepted: accepting writes the note once with the suggestion’s id, however often it is sent', async () => {
    const t = await team();
    const [suggestion] = await stored(t, [THANKSGIVING_LIKE]);
    const id = suggestion?.id ?? '';
    expect(await server.connection.collection('tw_notes').countDocuments({ locationId: new Types.ObjectId(t.locationId) })).toBe(0);
    const results = await Promise.all([decide(t, t.admin, id, 'accept'), decide(t, t.admin, id, 'accept')]);
    for (const res of results) expect(res.status).toBe(200);
    const again = await decide(t, t.admin, id, 'accept');
    expect(again.status).toBe(200);
    const body = await again.json() as DecideResult;
    expect(body).toMatchObject({
      suggestion: { id, status: 'accepted' }, rule: null,
      note: { id, kind: 'closure', startDate: '2026-07-04', endDate: '2026-07-04', effect: 'closed' },
    });
    const notes = await server.connection.collection('tw_notes').find({ locationId: new Types.ObjectId(t.locationId) }).toArray();
    expect(notes.map((note) => note._id.toHexString())).toEqual([id]);
    expect(notes[0]).toMatchObject({ createdBy: t.admin.userId });
    expect((await panel(t, t.member)).suggestions).toEqual([]);
    const accepted = (await auditEvents(server)).filter((event) => event.action === 'agent.suggestion_accepted' && String(event.orgId) === t.orgId);
    expect(accepted).toEqual([expect.objectContaining({
      actorUserId: t.admin.userId, details: { locationId: t.locationId, suggestionId: id, type: 'note' },
    })]);
    // Dismissing it now answers what was accepted.
    const late = await decide(t, t.admin, id, 'dismiss');
    expect(await late.json()).toMatchObject({ suggestion: { id, status: 'accepted' }, note: { id } });
  });

  it('a rule is accepted as a business rule added by TownwiseAI with its schedule', async () => {
    const t = await team();
    const [suggestion] = await stored(t, [COMMENCEMENT_RULE]);
    const id = suggestion?.id ?? '';
    const res = await decide(t, t.admin, id, 'accept');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      suggestion: { id, status: 'accepted' }, note: null,
      rule: { id, text: 'Private party after Commencement', addedVia: 'townwise_ai', schedule: { kind: 'private_event', expectedGuests: 40 } },
    });
    expect(await server.connection.collection('tw_business_rules').countDocuments({ _id: new Types.ObjectId(id) })).toBe(1);
  });

  it('a dismiss after an accept that wrote its note but never marked it finishes the accept instead', async () => {
    const t = await team();
    const [suggestion] = await stored(t, [THANKSGIVING_LIKE]);
    const id = suggestion?.id ?? '';
    // What an accept leaves when it dies between writing the note and marking the suggestion accepted.
    await server.ctx.stores.notes.create(t.scope, t.locationId, (THANKSGIVING_LIKE.content as { note: NoteContent }).note, {
      id, createdBy: t.admin.userId, byStaff: false, now: server.clock.now(),
    });
    const res = await decide(t, t.admin, id, 'dismiss');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ suggestion: { id, status: 'accepted' }, note: { id }, rule: null });
    expect(await server.connection.collection('tw_agent_suggestions').findOne({ _id: new Types.ObjectId(id) })).toMatchObject({ status: 'accepted' });
    const events = (await auditEvents(server)).filter((event) => String(event.orgId) === t.orgId
      && ['agent.suggestion_accepted', 'agent.suggestion_dismissed'].includes(String(event.action)));
    expect(events.map((event) => event.action)).toEqual(['agent.suggestion_accepted']);
    // An accept after it answers what was written.
    expect(await (await decide(t, t.admin, id, 'accept')).json()).toMatchObject({ suggestion: { id, status: 'accepted' }, note: { id } });
  });

  it('dismissing records it once, writes nothing, and the suggestion is not listed or accepted after', async () => {
    const t = await team();
    const [suggestion] = await stored(t, [THANKSGIVING_LIKE]);
    const id = suggestion?.id ?? '';
    const res = await decide(t, t.admin, id, 'dismiss');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: { id, status: 'dismissed' }, note: null, rule: null });
    expect((await decide(t, t.admin, id, 'dismiss')).status).toBe(200);
    expect((await panel(t, t.member)).suggestions).toEqual([]);
    expect(await errorOf(await decide(t, t.admin, id, 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect(await server.connection.collection('tw_notes').countDocuments({ locationId: new Types.ObjectId(t.locationId) })).toBe(0);
    const dismissed = (await auditEvents(server)).filter((event) => event.action === 'agent.suggestion_dismissed' && String(event.orgId) === t.orgId);
    expect(dismissed.map((event) => event.details)).toEqual([{ locationId: t.locationId, suggestionId: id, type: 'note' }]);
  });

  it('members see suggestions and are refused Accept and Dismiss (403)', async () => {
    const t = await team();
    const [suggestion] = await stored(t, [THANKSGIVING_LIKE]);
    expect((await panel(t, t.member)).suggestions).toHaveLength(1);
    expect(await errorOf(await decide(t, t.member, suggestion?.id ?? '', 'accept'))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await decide(t, t.member, suggestion?.id ?? '', 'dismiss'))).toEqual({ status: 403, error: 'forbidden' });
  });

  it('one whose first date is today or past is not listed, and is 404 to accept or dismiss', async () => {
    const t = await team();
    const [suggestion] = await stored(t, [closureOn('2026-06-01')]);
    expect((await panel(t, t.admin)).suggestions).toEqual([]);
    expect(await errorOf(await decide(t, t.admin, suggestion?.id ?? '', 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await decide(t, t.admin, suggestion?.id ?? '', 'dismiss'))).toEqual({ status: 404, error: 'not_found' });
  });

  it('another organization’s or location’s suggestion answers 404, as an unknown id does, and a body is refused', async () => {
    const t = await team();
    const other = await team();
    const [theirs] = await stored(other, [THANKSGIVING_LIKE]);
    const sibling = await addLocation(server, { orgId: t.orgId, name: 'Side Room' });
    const [mine] = await stored(t, [THANKSGIVING_LIKE]);
    expect(await errorOf(await decide(t, t.admin, theirs?.id ?? '', 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await decide(t, t.admin, mine?.id ?? '', 'accept', {}, sibling))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await decide(t, t.admin, new Types.ObjectId().toHexString(), 'dismiss'))).toEqual({ status: 404, error: 'not_found' });
    expect((await decide(t, t.admin, mine?.id ?? '', 'accept', { note: { kind: 'closure' } })).status).toBe(400);
    expect((await panel(other, other.member)).suggestions).toHaveLength(1);
  });

  it('go with their location, with its pass rows, and no other location’s', async () => {
    const t = await team();
    const kept = await addLocation(server, { orgId: t.orgId, name: 'Kept Room' });
    await stored(t, [THANKSGIVING_LIKE]);
    await createAgentSuggestionStore(server.connection).insert(t.scope, { locationId: kept, week: '2026-06-01', suggestions: [THANKSGIVING_LIKE], now: server.clock.now() });
    const store = createAgentSuggestionStore(server.connection);
    expect(await store.claimPass(t.scope, { locationId: t.locationId, week: '2026-06-01', now: server.clock.now() })).toBe(true);
    const res = await call(server, `/api/org/locations/${t.locationId}`, { method: 'DELETE', session: t.admin });
    expect(res.status).toBe(204);
    const count = (name: string, locationId: string) => server.connection.collection(name).countDocuments({ locationId: new Types.ObjectId(locationId) });
    expect(await count('tw_agent_suggestions', t.locationId)).toBe(0);
    expect(await count('tw_suggestion_passes', t.locationId)).toBe(0);
    expect(await count('tw_agent_suggestions', kept)).toBe(1);
  });
});

describe('the owner-calendar kinds in the store (calendar-event-suggestions, design decisions 3 and 4)', () => {
  const PARTY: NoteContent = {
    kind: 'private_event', startDate: '2026-06-13', endDate: '2026-06-13', weekdays: null, effect: 'closed', expectedGuests: 40,
    detail: null, startTime: '18:00', endTime: '22:00',
  };
  const ON_13 = { startDate: '2026-06-13', endDate: '2026-06-13', startTime: '18:00', endTime: '22:00' };
  const ON_20 = { startDate: '2026-06-20', endDate: '2026-06-20', startTime: '18:00', endTime: '22:00' };
  const ON_27 = { startDate: '2026-06-27', endDate: '2026-06-27', startTime: '18:00', endTime: '22:00' };
  const calendarId = new Types.ObjectId().toHexString();
  const store = () => createAgentSuggestionStore(server.connection);

  function moveTo(noteId: string, to: typeof ON_20, noteUpdatedAt = new Date('2026-05-20T12:00:00.000Z')): FollowContent {
    return { type: 'move', note: { ...PARTY, ...to }, follow: { noteId, calendarId, change: 'moved', from: ON_13, to, noteUpdatedAt } };
  }

  function removal(noteId: string): FollowContent {
    return {
      type: 'remove', note: PARTY,
      follow: { noteId, calendarId, change: 'gone', from: ON_13, to: null, noteUpdatedAt: new Date('2026-05-20T12:00:00.000Z') },
    };
  }

  function rowsFor(noteId: string) {
    return server.connection.collection('tw_agent_suggestions').find({ 'follow.noteId': new Types.ObjectId(noteId) }).toArray();
  }

  // Wed, Jun 3: the follow-up's week is that Monday, Jun 1.
  const AT = { today: '2026-06-03', now: new Date('2026-06-03T15:00:00.000Z') };

  it('makes a follow-up open with its note id held, its week the Monday, no why and no calendar entries; the same again changes nothing', async () => {
    const t = await team();
    const noteId = new Types.ObjectId().toHexString();
    expect(await store().upsertFollow(t.scope, t.locationId, moveTo(noteId, ON_20), AT)).toBe('made');
    const [row] = await rowsFor(noteId);
    expect(row).toMatchObject({
      type: 'move', week: '2026-06-01', status: 'open', why: null, calendarIds: [], openFollowFor: new Types.ObjectId(noteId),
      content: { startDate: '2026-06-20', kind: 'private_event', expectedGuests: 40 },
    });
    const record = await store().find(t.scope, t.locationId, String(row?._id));
    expect(record).toMatchObject({ type: 'move', why: null, firstDate: '2026-06-20', follow: { noteId, calendarId, change: 'moved', from: ON_13, to: ON_20 } });
    expect(await store().upsertFollow(t.scope, t.locationId, moveTo(noteId, ON_20), { ...AT, now: new Date(AT.now.getTime() + 60_000) })).toBe('same');
    expect(await rowsFor(noteId)).toEqual([row]);
  });

  it('a newer change updates the open follow-up in place, and the index refuses a second open one for the note', async () => {
    const t = await team();
    const noteId = new Types.ObjectId().toHexString();
    await store().upsertFollow(t.scope, t.locationId, moveTo(noteId, ON_20), AT);
    const [first] = await rowsFor(noteId);
    expect(await store().upsertFollow(t.scope, t.locationId, moveTo(noteId, ON_27), { today: '2026-06-09', now: new Date('2026-06-09T15:00:00.000Z') })).toBe('updated');
    expect(await store().upsertFollow(t.scope, t.locationId, removal(noteId), { today: '2026-06-09', now: new Date('2026-06-09T16:00:00.000Z') })).toBe('updated');
    const rows = await rowsFor(noteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: first?._id, type: 'remove', week: '2026-06-08', follow: { change: 'gone', to: null } });

    const copy = Object.fromEntries(Object.entries(rows[0] ?? {}).filter(([key]) => key !== '_id'));
    await expect(server.connection.collection('tw_agent_suggestions').insertOne(copy)).rejects.toThrow(/duplicate key/);
    // Two runs at once still leave one open follow-up.
    const other = new Types.ObjectId().toHexString();
    await Promise.all([
      store().upsertFollow(t.scope, t.locationId, moveTo(other, ON_20), AT), store().upsertFollow(t.scope, t.locationId, moveTo(other, ON_27), AT),
    ]);
    expect((await rowsFor(other)).filter((row) => row.status === 'open')).toHaveLength(1);
  });

  it('every change of status lets the note go, and a change an org admin dismissed is not made again', async () => {
    const t = await team();
    const noteId = new Types.ObjectId().toHexString();
    await store().upsertFollow(t.scope, t.locationId, moveTo(noteId, ON_20), AT);
    const [made] = await rowsFor(noteId);
    const id = String(made?._id);
    expect(await store().markDismissed(t.scope, t.locationId, id, { by: 'admin-0001', now: AT.now })).toBe(true);
    expect((await rowsFor(noteId))[0]).not.toHaveProperty('openFollowFor');

    // The same note, kind and target: not again. Another target is a new follow-up.
    expect(await store().upsertFollow(t.scope, t.locationId, moveTo(noteId, ON_20, new Date('2026-05-25T12:00:00.000Z')), AT)).toBe('dismissed');
    expect(await rowsFor(noteId)).toHaveLength(1);
    expect(await store().upsertFollow(t.scope, t.locationId, moveTo(noteId, ON_27), AT)).toBe('made');
    // Back at the dismissed target, the open one goes too.
    expect(await store().upsertFollow(t.scope, t.locationId, moveTo(noteId, ON_20), AT)).toBe('dismissed');
    expect((await rowsFor(noteId)).map((row): [unknown, boolean] => [row.status, 'openFollowFor' in row])).toEqual([['dismissed', false], ['expired', false]]);

    // A removal dismissed is not made again either.
    const gone = new Types.ObjectId().toHexString();
    await store().upsertFollow(t.scope, t.locationId, removal(gone), AT);
    const [open] = await rowsFor(gone);
    await store().markDismissed(t.scope, t.locationId, String(open?._id), { by: 'admin-0001', now: AT.now });
    expect(await store().upsertFollow(t.scope, t.locationId, removal(gone), AT)).toBe('dismissed');

    // Accepting, expiring by date, expireFollow and markExpired each clear the note's hold.
    for (const end of ['accepted', 'expired-by-date', 'expireFollow', 'markExpired'] as const) {
      const each = new Types.ObjectId().toHexString();
      await store().upsertFollow(t.scope, t.locationId, moveTo(each, ON_20), AT);
      const [row] = await rowsFor(each);
      const rowId = String(row?._id);
      if (end === 'accepted') expect(await store().markAccepted(t.scope, t.locationId, rowId, { by: 'admin-0001', now: AT.now })).toBe(true);
      if (end === 'expired-by-date') expect(await store().expire(t.scope, t.locationId, '2026-06-20', AT.now)).toBeGreaterThan(0);
      if (end === 'expireFollow') expect(await store().expireFollow(t.scope, t.locationId, each, AT.now)).toBe(true);
      if (end === 'markExpired') expect(await store().markExpired(t.scope, t.locationId, rowId, AT.now)).toBe(true);
      expect((await rowsFor(each))[0]).not.toHaveProperty('openFollowFor');
      expect(await store().upsertFollow(t.scope, t.locationId, moveTo(each, ON_27), AT)).toBe('made');
    }
    expect(await store().expireFollow(t.scope, t.locationId, new Types.ObjectId().toHexString(), AT.now)).toBe(false);
  });

  it('stores a spotted event with its calendar and uid, and eventKeysSuggested names it in any status', async () => {
    const t = await team();
    const [spot] = await stored(t, [{
      content: { type: 'event', note: { ...PARTY, effect: 'unknown', expectedGuests: null }, event: { calendarId, uid: 'party@bookings.example.test', ...ON_13 } },
      why: null, calendarIds: [],
    }]);
    expect(spot).toMatchObject({ type: 'event', why: null, event: { calendarId, uid: 'party@bookings.example.test', ...ON_13 }, note: { effect: 'unknown' } });
    await store().markDismissed(t.scope, t.locationId, spot?.id ?? '', { by: 'admin-0001', now: AT.now });
    expect(await store().eventKeysSuggested(t.scope, t.locationId)).toEqual([{ calendarId, uid: 'party@bookings.example.test' }]);
    const other = await team();
    expect(await store().eventKeysSuggested(other.scope, t.locationId)).toEqual([]);
  });

  it('reads a note or rule suggestion stored before the change as it was', async () => {
    const t = await team();
    const [note, rule] = await stored(t, [THANKSGIVING_LIKE, COMMENCEMENT_RULE]);
    const raw = await server.connection.collection('tw_agent_suggestions').findOne({ _id: new Types.ObjectId(note?.id) });
    for (const field of ['event', 'follow', 'openFollowFor']) expect(raw).not.toHaveProperty(field);
    expect(await store().find(t.scope, t.locationId, note?.id ?? '')).toEqual(note);
    expect(note).toMatchObject({ type: 'note', why: THANKSGIVING_LIKE.why, note: THANKSGIVING_LIKE.content.type === 'note' ? THANKSGIVING_LIKE.content.note : null });
    expect(rule).toMatchObject({ type: 'rule', text: 'Private party after Commencement', why: 'Commencement is Sun, Jun 14.' });
    // The follow-up kinds are not listed by the panel yet, and are not this pass's to avoid.
    await store().upsertFollow(t.scope, t.locationId, moveTo(new Types.ObjectId().toHexString(), ON_20), AT);
    expect((await panel(t, t.member)).suggestions.map((each) => each.type).sort()).toEqual(['note', 'rule']);
  });
});
