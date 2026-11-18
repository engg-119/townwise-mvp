// TownwiseAI's weekly suggestions (openspec change weekly-forecast-suggestions): the org admin's switch (on for an
// organization that never set it, off and back on by an org admin, refused to members and under view-as), and the
// suggestions a pass stored, as GET .../agent lists them and as an org admin accepts (one note or rule however often it
// is sent, with the suggestion's id) or dismisses them; an expired one is gone, another organization's is 404, and they
// go with their location. Every date and number is synthetic; the test clock reads Mon, Jun 1, 2026 (Hanover).
// The owner-calendar kinds (openspec change calendar-event-suggestions): accepting and dismissing a spotted event, a
// move and a removal, the cards' words (no title on a follow-up; a Google event's title never to staff), and what the
// panel hides once the note or calendar a card rests on is gone. Every event title here is made up.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { parseIcs } from '../src/calendar/ics.ts';
import type { AgentPanel } from '../src/handlers/agent.ts';
import type { NoteView } from '../src/handlers/notes.ts';
import type { DecideResult, SuggestionView } from '../src/handlers/weekly-suggestions.ts';
import { SUGGESTIONS_SEEN_MS } from '../src/lab/schedule.ts';
import { suggestFor } from '../src/lab/suggestions.ts';
import { createAgentSuggestionStore, type FollowContent, type NewSuggestion, type SuggestionRecord } from '../src/stores/agent-suggestions.ts';
import type { NoteContent } from '../src/stores/notes.ts';
import { message, messagesOf, scriptedModel, text } from './helpers/chat-model.ts';
import { addGrant, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, logLines, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
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
        detail: null, title: null, startTime: null, endTime: null,
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
    expect((await panel(t, t.member)).weeklySuggestions).toEqual({ on: true, available: false, canChange: false, calendarTitles: true });
    expect((await panel(t, t.admin)).weeklySuggestions).toEqual({ on: true, available: false, canChange: true, calendarTitles: true });
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

describe('the calendar titles switch (calendar-event-suggestions, design decision 9)', () => {
  afterEach(async () => {
    await removeStaffFactor(server);
    await server.connection.collection('tw_view_as_grants').deleteMany({});
  });

  function titlesTo(session: TestSession, body: unknown): Promise<Response> {
    return call(server, '/api/org/weekly-suggestions/calendar-titles', { method: 'PATCH', session, json: body });
  }

  async function titleEvents(t: Team): Promise<Record<string, unknown>[]> {
    return (await auditEvents(server)).filter((event) => event.action === 'org.calendar_titles_ai_changed' && String(event.orgId) === t.orgId);
  }

  it('reads as on for an organization that never set it; an org admin turns it off and back on, each recorded once with its state only', async () => {
    const t = await team();
    expect((await orgDoc(t.orgId))?.calendarTitlesToAi).toBeUndefined();
    expect((await panel(t, t.member)).weeklySuggestions.calendarTitles).toBe(true);
    const off = await titlesTo(t.admin, { on: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ calendarTitles: { on: false } });
    expect(await orgDoc(t.orgId)).toMatchObject({ calendarTitlesToAi: { on: false, by: t.admin.userId } });
    expect((await panel(t, t.member)).weeklySuggestions).toMatchObject({ on: true, calendarTitles: false });
    expect((await titlesTo(t.admin, { on: false })).status).toBe(200);
    expect((await titlesTo(t.admin, { on: true })).status).toBe(200);
    expect((await panel(t, t.member)).weeklySuggestions.calendarTitles).toBe(true);
    const events = await titleEvents(t);
    expect(events.map((event) => event.details)).toEqual([{ on: false }, { on: true }]);
    expect(events[0]).toMatchObject({ actorUserId: t.admin.userId, actorRole: 'org_admin', target: { type: 'org', id: t.orgId } });
    expect(logLines(server).filter((line) => line.msg === 'townwise.calendar_titles_switched').at(-1)).toEqual(
      expect.objectContaining({ orgId: t.orgId, on: true }),
    );
    // The weekly switch is its own.
    expect((await orgDoc(t.orgId))?.weeklySuggestions).toBeUndefined();
  });

  it('refuses a member (403), anything but { on } (400), and staff in view-as (403 view_as_read_only), changing nothing', async () => {
    const t = await team();
    expect(await errorOf(await titlesTo(t.member, { on: false }))).toEqual({ status: 403, error: 'forbidden' });
    for (const body of [{}, { on: 'no' }, { on: false, titles: [] }]) expect((await titlesTo(t.admin, body)).status).toBe(400);
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.admin.userId, orgId: t.orgId });
    expect(await errorOf(await titlesTo(staff, { on: false }))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect((await orgDoc(t.orgId))?.calendarTitlesToAi).toBeUndefined();
  });

  it('staff open as admin turn it off with the tab’s orgId, and are refused turning it on (403 open_as_admin_refused)', async () => {
    const t = await team();
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: t.orgId });
    expect(await errorOf(await titlesTo(staff, { on: false }))).toEqual({ status: 409, error: 'open_as_admin_active' });
    expect((await titlesTo(staff, { on: false, orgId: t.orgId })).status).toBe(200);
    expect(await errorOf(await titlesTo(staff, { on: true, orgId: t.orgId }))).toEqual({ status: 403, error: 'open_as_admin_refused' });
    expect(await orgDoc(t.orgId)).toMatchObject({ calendarTitlesToAi: { on: false, by: staff.userId } });
    expect((await titleEvents(t)).map((event) => [event.actorRole, event.details])).toEqual([['superadmin', { on: false }]]);
    // The organization's own admin turns it back on.
    expect((await titlesTo(t.admin, { on: true })).status).toBe(200);
    expect((await panel(t, t.admin)).weeklySuggestions.calendarTitles).toBe(true);
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
    detail: null, title: null, startTime: '18:00', endTime: '22:00',
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

  it('recent reads notes and rules only, so follow-ups and spotted events never crowd them out of the pass’s duplicate check', async () => {
    const t = await team();
    const [note] = await stored(t, [THANKSGIVING_LIKE]);
    for (let index = 0; index < 3; index += 1) await store().upsertFollow(t.scope, t.locationId, moveTo(new Types.ObjectId().toHexString(), ON_20), AT);
    await stored(t, [{
      content: { type: 'event', note: { ...PARTY, effect: 'unknown', expectedGuests: null }, event: { calendarId, uid: 'party@bookings.example.test', ...ON_13 } },
      why: null, calendarIds: [],
    }]);
    expect((await store().recent(t.scope, t.locationId)).map((each) => each.id)).toEqual([note?.id]);
  });

  it('reads a note or rule suggestion stored before the change as it was', async () => {
    const t = await team();
    const [note, rule] = await stored(t, [THANKSGIVING_LIKE, COMMENCEMENT_RULE]);
    const raw = await server.connection.collection('tw_agent_suggestions').findOne({ _id: new Types.ObjectId(note?.id) });
    for (const field of ['event', 'follow', 'openFollowFor']) expect(raw).not.toHaveProperty(field);
    expect(await store().find(t.scope, t.locationId, note?.id ?? '')).toEqual(note);
    expect(note).toMatchObject({ type: 'note', why: THANKSGIVING_LIKE.why, note: THANKSGIVING_LIKE.content.type === 'note' ? THANKSGIVING_LIKE.content.note : null });
    expect(rule).toMatchObject({ type: 'rule', text: 'Private party after Commencement', why: 'Commencement is Sun, Jun 14.' });
    // A follow-up whose note and calendar are not there is not listed.
    await store().upsertFollow(t.scope, t.locationId, moveTo(new Types.ObjectId().toHexString(), ON_20), AT);
    expect((await panel(t, t.member)).suggestions.map((each) => each.type).sort()).toEqual(['note', 'rule']);
  });
});

describe('accepting and dismissing the owner-calendar kinds (calendar-event-suggestions, design decisions 4, 5 and 10)', () => {
  const TOWN = { today: '2026-06-01', timeZone: 'America/New_York' };
  const PARTY_UID = 'party-0001@bookings.example.test';
  const TITLE = 'Sentinel Pemberton rehearsal dinner';
  const GOOGLE_LABEL = 'Sentinel Google label';
  const ON_13 = { startDate: '2026-06-13', endDate: '2026-06-13', startTime: '18:00', endTime: '22:00' };
  const ON_20 = { startDate: '2026-06-20', endDate: '2026-06-20', startTime: '18:00', endTime: '22:00' };

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeStaffFactor(server);
    await server.connection.collection('tw_view_as_grants').deleteMany({});
  });

  const ON_27 = { startDate: '2026-06-27', endDate: '2026-06-27', startTime: '18:00', endTime: '22:00' };

  type Query = PromiseLike<unknown> & { lean?: () => Promise<unknown> };

  /**
   * Runs `hook` once, right after the first `method` call on the shared model `name` resolves, inside the app's own
   * request (the test server's ctx has stores of its own, so a race is staged at the model both share).
   */
  function afterFirst(name: string, method: string, hook: () => Promise<void>): void {
    const model = server.connection.models[name] as unknown as Record<string, (...args: unknown[]) => Query>;
    const original = model[method];
    if (original === undefined) throw new Error(`no ${method} on ${name}`);
    let done = false;
    vi.spyOn(model, method).mockImplementation((...args: unknown[]): Query => {
      const query = original.apply(model, args);
      if (done) return query;
      done = true;
      const run = async (lean: boolean): Promise<unknown> => {
        const result = lean && query.lean !== undefined ? await query.lean() : await query;
        await hook();
        return result;
      };
      return { lean: () => run(true), then: (onFulfilled, onRejected) => run(false).then(onFulfilled, onRejected) };
    });
  }

  /** What a refresh does when the event moves again: the note's open move now proposes Jun 27. */
  async function movedAgain(t: Team, note: NoteView, calendarId: string): Promise<void> {
    const content: NoteContent = {
      kind: note.kind, startDate: note.startDate, endDate: note.endDate, weekdays: note.weekdays, effect: note.effect,
      expectedGuests: note.expectedGuests, detail: note.detail, title: null, startTime: note.startTime, endTime: note.endTime,
    };
    server.clock.advance(MINUTE);
    const follow: FollowContent = {
      type: 'move', note: { ...content, ...ON_27 },
      follow: { noteId: note.id, calendarId, from: ON_13, noteUpdatedAt: new Date(note.updatedAt), change: 'moved', to: ON_27 },
    };
    expect(await server.ctx.stores.agentSuggestions.upsertFollow(t.scope, t.locationId, follow, { today: '2026-06-01', now: server.clock.now() })).toBe('updated');
  }

  /** A calendar holding the party on `day` (YYYYMMDD), 6 pm to 10 pm. */
  function parsedOn(day: string) {
    const text = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Townwise test//EN', 'BEGIN:VEVENT', `UID:${PARTY_UID}`, `SUMMARY:${TITLE}`,
      `DTSTART:${day}T180000`, `DTEND:${day}T220000`, 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    const parsed = parseIcs(text, TOWN);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  }

  async function calendarOf(t: Team, kind: 'link' | 'google' = 'link'): Promise<{ calendarId: string; connectionId: string }> {
    const connectionId = new Types.ObjectId().toHexString();
    const added = await server.ctx.stores.ownerCalendars.add(t.scope, t.locationId, kind === 'link'
      ? { kind, label: 'Front desk bookings', sealedAddress: 'sealed-for-test', host: 'calendar.example.test' }
      : { kind, label: GOOGLE_LABEL, sealedAddress: 'sealed-for-test', googleConnectionId: connectionId }, parsedOn('20260613'), {
      createdBy: t.admin.userId, now: server.clock.now(),
    });
    if (added === 'calendar_limit') throw new Error('calendar_limit');
    return { calendarId: added.id, connectionId };
  }

  /** Make a note on the party as a member: a buyout of 40, linked to the event. */
  async function partyNote(t: Team, calendarId: string, extra: Record<string, unknown> = {}): Promise<NoteView> {
    const res = await call(server, `/api/org/locations/${t.locationId}/notes`, {
      session: t.member,
      json: { kind: 'private_event', ...ON_13, effect: 'closed', expectedGuests: 40, detail: 'Upstairs room', fromEvent: { calendarId, uid: PARTY_UID }, ...extra },
    });
    expect(res.status).toBe(201);
    return (await res.json() as { note: NoteView }).note;
  }

  /** The follow-up the refresh would make for the note: a move to Jun 20, or a removal. */
  async function followUp(t: Team, note: NoteView, calendarId: string, type: 'move' | 'remove'): Promise<string> {
    const content: NoteContent = {
      kind: note.kind, startDate: note.startDate, endDate: note.endDate, weekdays: note.weekdays, effect: note.effect,
      expectedGuests: note.expectedGuests, detail: note.detail, title: null, startTime: note.startTime, endTime: note.endTime,
    };
    const base = { noteId: note.id, calendarId, from: ON_13, noteUpdatedAt: new Date(note.updatedAt) };
    const follow: FollowContent = type === 'move'
      ? { type, note: { ...content, ...ON_20 }, follow: { ...base, change: 'moved', to: ON_20 } }
      : { type, note: content, follow: { ...base, change: 'gone', to: null } };
    expect(await createAgentSuggestionStore(server.connection).upsertFollow(t.scope, t.locationId, follow, { today: '2026-06-01', now: server.clock.now() })).toBe('made');
    const row = await server.connection.collection('tw_agent_suggestions').findOne({ openFollowFor: new Types.ObjectId(note.id) });
    return String(row?._id);
  }

  /** The weekly pass's spot of the party: effect unknown, 40 guests from the title's digits. */
  async function spotted(t: Team, calendarId: string): Promise<string> {
    const [row] = await stored(t, [{
      content: {
        type: 'event', note: { kind: 'private_event', ...ON_13, weekdays: null, effect: 'unknown', expectedGuests: 40, detail: null, title: null },
        event: { calendarId, uid: PARTY_UID, ...ON_13 },
      },
      why: null, calendarIds: [],
    }]);
    return row?.id ?? '';
  }

  async function noteRow(id: string): Promise<Record<string, unknown> | null> {
    return server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(id) });
  }

  async function statusOf(id: string): Promise<unknown> {
    return (await server.connection.collection('tw_agent_suggestions').findOne({ _id: new Types.ObjectId(id) }))?.status;
  }

  async function actions(t: Team): Promise<{ action: unknown; details: unknown }[]> {
    return (await auditEvents(server)).filter((event) => String(event.orgId) === t.orgId && String(event.action) !== 'note.created')
      .map((event) => ({ action: event.action, details: event.details }));
  }

  function only(view: AgentPanel, id: string): SuggestionView | undefined {
    return view.suggestions.find((each) => each.id === id);
  }

  it('a move is listed with words from the note’s kind and dates only, and accepting it moves the note and its link once', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'move');
    const listed = await panel(t, t.member);
    expect(only(listed, id)).toEqual({
      id, type: 'move', why: null, calendar: [], createdAt: expect.any(String) as unknown, noteId: note.id,
      words: 'The private event on Sat, Jun 13 moved to Sat, Jun 20 on your calendar.',
      from: ON_13, note: expect.objectContaining({ ...ON_20, kind: 'private_event', expectedGuests: 40 }) as unknown,
    });
    expect(JSON.stringify(listed)).not.toContain('Pemberton');

    const res = await decide(t, t.admin, id, 'accept');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ suggestion: { id, status: 'accepted' }, rule: null, note: { id: note.id, ...ON_20, fromEvent: { ...ON_20, uid: PARTY_UID } } });
    expect(await noteRow(note.id)).toMatchObject({ ...ON_20, kind: 'private_event', effect: 'closed', expectedGuests: 40, detail: 'Upstairs room', fromEvent: { ...ON_20, calendarId: new Types.ObjectId(calendarId) } });
    expect((await decide(t, t.admin, id, 'accept')).status).toBe(200);
    expect(await actions(t)).toEqual([
      { action: 'note.updated', details: { locationId: t.locationId, kind: 'private_event', startDate: '2026-06-20', endDate: '2026-06-20' } },
      { action: 'agent.suggestion_accepted', details: { locationId: t.locationId, suggestionId: id, type: 'move' } },
    ]);
    expect(only(await panel(t, t.member), id)).toBeUndefined();
  });

  it('a move whose note was moved by an accept that died before marking it is accepted with no second note.updated', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'move');
    server.clock.advance(MINUTE);
    expect(await server.ctx.stores.notes.moveIf(t.scope, t.locationId, note.id, { updatedAt: new Date(note.updatedAt), dates: ON_20, link: ON_20, now: server.clock.now() })).not.toBeNull();
    expect((await decide(t, t.admin, id, 'accept')).status).toBe(200);
    expect(await statusOf(id)).toBe('accepted');
    expect((await actions(t)).map((each) => each.action)).toEqual(['agent.suggestion_accepted']);
  });

  it('a guest count changed since the move answers 409 note_changed, leaving the note and the suggestion as they are', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'move');
    server.clock.advance(MINUTE);
    const edit = await call(server, `/api/org/locations/${t.locationId}/notes/${note.id}`, {
      method: 'PATCH', session: t.member, json: { kind: 'private_event', ...ON_13, effect: 'closed', expectedGuests: 55, detail: 'Upstairs room' },
    });
    expect(edit.status).toBe(200);
    expect(await errorOf(await decide(t, t.admin, id, 'accept'))).toEqual({ status: 409, error: 'note_changed' });
    expect(await noteRow(note.id)).toMatchObject({ ...ON_13, expectedGuests: 55 });
    expect(await statusOf(id)).toBe('open');
  });

  it('a move a refresh rewrote after the accept read it answers 409 note_changed, and the note is not moved to the old target', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'move');
    // The refresh lands right after the accept's first read of the suggestion.
    afterFirst('TwAgentSuggestion', 'findOne', () => movedAgain(t, note, calendarId));
    expect(await errorOf(await decide(t, t.admin, id, 'accept'))).toEqual({ status: 409, error: 'note_changed' });
    expect(await noteRow(note.id)).toMatchObject(ON_13);
    const row = await server.connection.collection('tw_agent_suggestions').findOne({ _id: new Types.ObjectId(id) });
    expect(row).toMatchObject({ status: 'open', follow: { to: ON_27 } });
    expect((await actions(t)).map((each) => each.action)).toEqual([]);
  });

  it('a move rewritten after its own write landed answers 409 note_changed and is not marked accepted under the old choice', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'move');
    afterFirst('TwNote', 'findOneAndUpdate', () => movedAgain(t, note, calendarId));
    expect(await errorOf(await decide(t, t.admin, id, 'accept'))).toEqual({ status: 409, error: 'note_changed' });
    expect(await statusOf(id)).toBe('open');
    expect((await actions(t)).map((each) => each.action)).toEqual(['note.updated']);
  });

  it('an accept whose own move or removal landed is accepted even when a refresh expired the follow-up meanwhile, once, and a retry answers accepted', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'move');
    /** The refresh after the write finds nothing to suggest and expires the follow-up. */
    const expire = (suggestionId: string) => async (): Promise<void> => {
      expect(await server.ctx.stores.agentSuggestions.markExpired(t.scope, t.locationId, suggestionId, server.clock.now())).toBe(true);
    };
    afterFirst('TwNote', 'findOneAndUpdate', expire(id));
    expect((await decide(t, t.admin, id, 'accept')).status).toBe(200);
    expect(await statusOf(id)).toBe('accepted');
    vi.restoreAllMocks();
    expect(await decide(t, t.admin, id, 'accept')).toMatchObject({ status: 200 });

    const second = await partyNote(t, calendarId);
    const removal = await followUp(t, second, calendarId, 'remove');
    afterFirst('TwNote', 'deleteOne', expire(removal));
    expect((await decide(t, t.admin, removal, 'accept')).status).toBe(200);
    expect(await statusOf(removal)).toBe('accepted');
    expect(await noteRow(second.id)).toBeNull();
    expect((await actions(t)).map((each) => each.action)).toEqual([
      'note.updated', 'agent.suggestion_accepted', 'note.deleted', 'agent.suggestion_accepted',
    ]);
  });

  it('a removal deletes the note once; a retry after its own delete is accepted, and a changed note answers 409', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'remove');
    expect(only(await panel(t, t.member), id)).toMatchObject({
      type: 'remove', why: null, noteId: note.id, words: 'The private event on Sat, Jun 13 is no longer on your calendar.',
    });
    const res = await decide(t, t.admin, id, 'accept');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: { id, status: 'accepted' }, note: null, rule: null });
    expect(await noteRow(note.id)).toBeNull();
    expect((await decide(t, t.admin, id, 'accept')).status).toBe(200);
    expect(await actions(t)).toEqual([
      { action: 'note.deleted', details: { locationId: t.locationId, kind: 'private_event', startDate: '2026-06-13', endDate: '2026-06-13' } },
      { action: 'agent.suggestion_accepted', details: { locationId: t.locationId, suggestionId: id, type: 'remove' } },
    ]);

    // An accept that deleted the note and died before marking it: the retry finds the note gone and accepts.
    const second = await partyNote(t, calendarId);
    const retried = await followUp(t, second, calendarId, 'remove');
    expect(await server.ctx.stores.notes.removeIf(t.scope, t.locationId, second.id, new Date(second.updatedAt))).toBe(true);
    expect((await decide(t, t.admin, retried, 'accept')).status).toBe(200);
    expect(await statusOf(retried)).toBe('accepted');

    // A note edited since: 409, and it stays.
    const third = await partyNote(t, calendarId);
    const changed = await followUp(t, third, calendarId, 'remove');
    server.clock.advance(MINUTE);
    await call(server, `/api/org/locations/${t.locationId}/notes/${third.id}`, {
      method: 'PATCH', session: t.member, json: { kind: 'private_event', ...ON_13, effect: 'closed', expectedGuests: 41 },
    });
    expect(await errorOf(await decide(t, t.admin, changed, 'accept'))).toEqual({ status: 409, error: 'note_changed' });
    expect(await noteRow(third.id)).not.toBeNull();
  });

  it('a titled note (D49) moved by accepting a move keeps its title; the card and the stored follow-up hold none', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId, { title: 'Sentinel Holiday party' });
    expect(note.title).toBe('Sentinel Holiday party');
    const id = await followUp(t, note, calendarId, 'move');
    const listed = only(await panel(t, t.member), id);
    expect(listed).toMatchObject({ type: 'move', words: 'The private event on Sat, Jun 13 moved to Sat, Jun 20 on your calendar.', note: { title: null } });
    expect(JSON.stringify(listed)).not.toContain('Sentinel Holiday party');
    const row = await server.connection.collection('tw_agent_suggestions').findOne({ _id: new Types.ObjectId(id) });
    expect(JSON.stringify(row)).not.toContain('Sentinel Holiday party');

    const res = await decide(t, t.admin, id, 'accept');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ note: { id: note.id, ...ON_20, title: 'Sentinel Holiday party', detail: 'Upstairs room' } });
    expect(await noteRow(note.id)).toMatchObject({ ...ON_20, title: 'Sentinel Holiday party', detail: 'Upstairs room', expectedGuests: 40 });
  });

  it('a removal of a titled note (D49) deletes it with no other write to any note', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId, { title: 'Sentinel Holiday party' });
    const id = await followUp(t, note, calendarId, 'remove');
    expect(JSON.stringify(only(await panel(t, t.member), id))).not.toContain('Sentinel Holiday party');
    const model = server.connection.models.TwNote as unknown as Record<string, (...args: unknown[]) => unknown>;
    const writesSpied = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'bulkWrite', 'insertMany', 'create']
      .map((method) => vi.spyOn(model, method));
    const res = await decide(t, t.admin, id, 'accept');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: { id, status: 'accepted' }, note: null, rule: null });
    for (const spy of writesSpied) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await noteRow(note.id)).toBeNull();
    expect(await actions(t)).toEqual([
      { action: 'note.deleted', details: { locationId: t.locationId, kind: 'private_event', startDate: '2026-06-13', endDate: '2026-06-13' } },
      { action: 'agent.suggestion_accepted', details: { locationId: t.locationId, suggestionId: id, type: 'remove' } },
    ]);
  });

  it('a spotted event’s accepted note has no title, even when its stored snapshot was handed one', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const [row] = await stored(t, [{
      content: {
        type: 'event', note: { kind: 'private_event', ...ON_13, weekdays: null, effect: 'unknown', expectedGuests: 40, detail: null, title: 'Sentinel model title' },
        event: { calendarId, uid: PARTY_UID, ...ON_13 },
      },
      why: null, calendarIds: [],
    }]);
    const id = row?.id ?? '';
    expect(JSON.stringify(await server.connection.collection('tw_agent_suggestions').findOne({ _id: new Types.ObjectId(id) }))).not.toContain('Sentinel model title');
    expect(only(await panel(t, t.member), id)).toMatchObject({ type: 'event', note: { title: null } });
    const res = await decide(t, t.admin, id, 'accept', { effect: 'closed', expectedGuests: 40 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ note: { id, title: null, detail: null } });
    expect(await noteRow(id)).toMatchObject({ title: null, detail: null });
    expect(JSON.stringify(await noteRow(id))).not.toMatch(/Sentinel model title|Pemberton/u);
  });

  it('members are refused (403), staff in view-as are refused, and a dismiss records it with its type', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'remove');
    expect(await errorOf(await decide(t, t.member, id, 'accept'))).toEqual({ status: 403, error: 'forbidden' });
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.admin.userId, orgId: t.orgId });
    expect(await errorOf(await decide(t, staff, id, 'accept'))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect(await noteRow(note.id)).not.toBeNull();
    const res = await decide(t, t.admin, id, 'dismiss');
    expect(await res.json()).toEqual({ suggestion: { id, status: 'dismissed' }, note: null, rule: null });
    expect(await actions(t)).toEqual([{ action: 'agent.suggestion_dismissed', details: { locationId: t.locationId, suggestionId: id, type: 'remove' } }]);
    expect(await noteRow(note.id)).not.toBeNull();
  });

  it('a Google calendar whose access ended hides its removal, whose accept answers 404 and expires it, the note kept', async () => {
    const t = await team();
    const { calendarId, connectionId } = await calendarOf(t, 'google');
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'remove');
    expect(only(await panel(t, t.admin), id)).toBeDefined();
    expect(await server.ctx.stores.ownerCalendars.removeForConnection(t.scope, connectionId)).toBe(1);
    expect(only(await panel(t, t.admin), id)).toBeUndefined();
    expect(await errorOf(await decide(t, t.admin, id, 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect(await statusOf(id)).toBe('expired');
    expect(await noteRow(note.id)).not.toBeNull();
  });

  it('a move whose note was deleted is hidden; its accept answers 404 and expires it, and so does a dismiss of another', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const note = await partyNote(t, calendarId);
    const id = await followUp(t, note, calendarId, 'move');
    expect((await call(server, `/api/org/locations/${t.locationId}/notes/${note.id}`, { method: 'DELETE', session: t.member })).status).toBe(204);
    expect(only(await panel(t, t.admin), id)).toBeUndefined();
    expect(await errorOf(await decide(t, t.admin, id, 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect(await statusOf(id)).toBe('expired');

    const other = await partyNote(t, calendarId);
    const gone = await followUp(t, other, calendarId, 'move');
    await server.ctx.stores.notes.remove(t.scope, t.locationId, other.id);
    expect(await errorOf(await decide(t, t.admin, gone, 'dismiss'))).toEqual({ status: 404, error: 'not_found' });
    expect(await statusOf(gone)).toBe('expired');
  });

  it('a spotted event names its live title to members and admins, and a link calendar’s title to staff, as the Calendar does', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const id = await spotted(t, calendarId);
    const words = `From your calendar: ${TITLE}, Sat, Jun 13, 6 pm to 10 pm`;
    expect(only(await panel(t, t.member), id)).toEqual({
      id, type: 'event', why: null, calendar: [], createdAt: expect.any(String) as unknown, words,
      note: { kind: 'private_event', ...ON_13, weekdays: null, effect: 'unknown', expectedGuests: 40, detail: null, title: null },
      event: { calendarId, title: TITLE, titleHidden: false, ...ON_13 },
    });
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: t.orgId });
    expect(only(await panel(t, staff), id)).toMatchObject({ words, event: { title: TITLE, titleHidden: false } });
  });

  it('a Google calendar’s spotted event reads as “Google calendar event” to staff, open as admin or in view-as, never its title', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t, 'google');
    const id = await spotted(t, calendarId);
    expect(only(await panel(t, t.admin), id)).toMatchObject({ event: { title: TITLE, titleHidden: false } });
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: t.orgId });
    const opened = await panel(t, staff);
    expect(only(opened, id)).toMatchObject({
      words: 'From your calendar: Google calendar event, Sat, Jun 13, 6 pm to 10 pm. Ask your client’s team what this event is.',
      event: { title: 'Google calendar event', titleHidden: true },
    });
    await server.connection.collection('tw_view_as_grants').deleteMany({});
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.member.userId, orgId: t.orgId });
    const viewed = await panel(t, staff);
    expect(only(viewed, id)).toMatchObject({ event: { title: 'Google calendar event', titleHidden: true } });
    for (const view of [opened, viewed]) {
      expect(JSON.stringify(view)).not.toContain('Pemberton');
      expect(JSON.stringify(view)).not.toContain(GOOGLE_LABEL);
    }
  });

  it('accepting a spotted event writes a linked private-event note with no detail, once; alongside service needs a count', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const id = await spotted(t, calendarId);
    expect(await errorOf(await decide(t, t.admin, id, 'accept'))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await decide(t, t.admin, id, 'accept', { effect: 'more_guests', expectedGuests: null }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await decide(t, t.admin, id, 'accept', { effect: 'closed', expectedGuests: 40, detail: 'x' }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await noteRow(id)).toBeNull();
    const results = await Promise.all([
      decide(t, t.admin, id, 'accept', { effect: 'closed', expectedGuests: 40 }), decide(t, t.admin, id, 'accept', { effect: 'closed', expectedGuests: 40 }),
    ]);
    for (const res of results) expect(res.status).toBe(200);
    expect(await results[0].json()).toMatchObject({
      suggestion: { id, status: 'accepted' },
      note: { id, kind: 'private_event', ...ON_13, weekdays: null, effect: 'closed', expectedGuests: 40, detail: null, fromEvent: { calendarId, uid: PARTY_UID, ...ON_13 } },
    });
    expect(await noteRow(id)).toMatchObject({ createdBy: t.admin.userId, detail: null });
    expect(await actions(t)).toEqual([{ action: 'agent.suggestion_accepted', details: { locationId: t.locationId, suggestionId: id, type: 'event' } }]);
    expect(JSON.stringify(await noteRow(id))).not.toContain('Pemberton');
  });

  it('a spotted event another note now covers is hidden, not counted, and its accept answers 409 event_changed and expires it', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    // A member made a note on the event itself since the spot.
    const linked = await spotted(t, calendarId);
    const made = await partyNote(t, calendarId);
    expect(only(await panel(t, t.admin), linked)).toBeUndefined();
    expect(await errorOf(await decide(t, t.admin, linked, 'accept', { effect: 'closed', expectedGuests: 40 }))).toEqual({ status: 409, error: 'event_changed' });
    expect(await statusOf(linked)).toBe('expired');
    expect(await noteRow(linked)).toBeNull();
    await call(server, `/api/org/locations/${t.locationId}/notes/${made.id}`, { method: 'DELETE', session: t.member });

    // A closure note over its days, made by hand (not linked).
    const closed = await spotted(t, calendarId);
    expect(only(await panel(t, t.admin), closed)).toBeDefined();
    const closure = await call(server, `/api/org/locations/${t.locationId}/notes`, {
      session: t.member, json: { kind: 'closure', startDate: '2026-06-12', endDate: '2026-06-14', effect: 'closed' },
    });
    expect(closure.status).toBe(201);
    expect((await panel(t, t.admin)).suggestions.filter((each) => each.type === 'event')).toEqual([]);
    expect(await errorOf(await decide(t, t.admin, closed, 'accept', { effect: 'more_guests', expectedGuests: 40 }))).toEqual({ status: 409, error: 'event_changed' });
    expect(await statusOf(closed)).toBe('expired');
  });

  it('a spotted event under a note of another kind stays listed and can be accepted', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const id = await spotted(t, calendarId);
    const opening = await call(server, `/api/org/locations/${t.locationId}/notes`, {
      session: t.member, json: { kind: 'opening', startDate: '2026-06-13', endDate: '2026-06-13', effect: 'more_guests', expectedGuests: 30 },
    });
    expect(opening.status).toBe(201);
    expect(only(await panel(t, t.admin), id)).toBeDefined();
    expect((await decide(t, t.admin, id, 'accept', { effect: 'closed', expectedGuests: 40 })).status).toBe(200);
  });

  it('a spotted event that moved is hidden, and its accept answers 409 event_changed and expires it; its calendar gone, 404', async () => {
    const t = await team();
    const { calendarId } = await calendarOf(t);
    const id = await spotted(t, calendarId);
    await server.ctx.stores.ownerCalendars.replaceEvents(t.scope, t.locationId, calendarId, parsedOn('20260620'), server.clock.now());
    expect(only(await panel(t, t.admin), id)).toBeUndefined();
    expect(await errorOf(await decide(t, t.admin, id, 'accept', { effect: 'more_guests', expectedGuests: 40 }))).toEqual({ status: 409, error: 'event_changed' });
    expect(await statusOf(id)).toBe('expired');
    expect(await noteRow(id)).toBeNull();

    const again = await spotted(t, calendarId);
    await server.ctx.stores.ownerCalendars.remove(t.scope, t.locationId, calendarId);
    expect(await errorOf(await decide(t, t.admin, again, 'accept', { effect: 'closed', expectedGuests: null }))).toEqual({ status: 404, error: 'not_found' });
    expect(await statusOf(again)).toBe('expired');
  });
});

describe('suggested closure rules beside weekly ones (openspec change suggest-closure-rules)', () => {
  const MONDAYS = {
    kind: 'closure', startDate: '2026-06-01', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
  } as const;

  async function fileRow(t: Team, schedule: typeof MONDAYS | Readonly<Record<string, unknown>>, key: string): Promise<string> {
    const id = new Types.ObjectId().toHexString();
    const made = await createAgentSuggestionStore(server.connection).insertOne(t.scope, {
      id, locationId: t.locationId, week: '2026-06-01', source: 'file', fileId: new Types.ObjectId().toHexString(),
      text: 'Closed on Mondays', schedule: schedule as typeof MONDAYS, closureKey: key, now: server.clock.now(),
    });
    expect(made?.created).toBe(true);
    return id;
  }

  it('the weekly pass’s expire leaves an ongoing file row that starts today open, and expires a file range that has ended', async () => {
    const t = await team();
    const store = createAgentSuggestionStore(server.connection);
    const ongoing = await fileRow(t, MONDAYS, 'closed|w=1|ongoing');
    const ended = await fileRow(t, { ...MONDAYS, weekdays: null, startDate: '2026-05-01', endDate: '2026-05-31' }, 'closed|w=*|2026-05-01..2026-05-31');
    const endsToday = await fileRow(t, { ...MONDAYS, weekdays: null, startDate: '2026-05-01', endDate: '2026-06-01' }, 'closed|w=*|2026-05-01..2026-06-01');
    const [weekly] = await stored(t, [closureOn('2026-06-01')]);
    expect(await store.expire(t.scope, t.locationId, '2026-06-01', server.clock.now())).toBe(2);
    const status = async (id: string) => (await store.find(t.scope, t.locationId, id))?.status;
    expect([await status(ongoing), await status(ended), await status(endsToday), await status(weekly?.id ?? '')])
      .toEqual(['open', 'expired', 'open', 'expired']);
    expect((await store.listOpenRules(t.scope, t.locationId, '2026-06-01')).map((record) => record.id).sort()).toEqual([ongoing, endsToday].sort());
    expect(await store.listOpenRules(t.scope, t.locationId, '2026-06-02')).toEqual([expect.objectContaining({ id: ongoing })]);
  });

  it('listOpen holds weekly rows only, and the panel’s weekly suggestions never show a file row', async () => {
    const t = await team();
    await fileRow(t, { ...MONDAYS, startDate: '2026-07-06' }, 'closed|w=1|ongoing');
    const [weekly] = await stored(t, [THANKSGIVING_LIKE]);
    expect((await createAgentSuggestionStore(server.connection).listOpen(t.scope, t.locationId, '2026-06-01')).map((record) => record.id))
      .toEqual([weekly?.id]);
    expect((await panel(t, t.member)).suggestions.map((suggestion) => suggestion.id)).toEqual([weekly?.id]);
  });

  it('one row per closure key in any status; the same id again is the row a retry wrote', async () => {
    const t = await team();
    const store = createAgentSuggestionStore(server.connection);
    const id = await fileRow(t, MONDAYS, 'closed|w=1|ongoing');
    const again = await store.insertOne(t.scope, {
      id, locationId: t.locationId, week: '2026-06-01', source: 'file', fileId: new Types.ObjectId().toHexString(),
      text: 'Closed on Mondays', schedule: MONDAYS, closureKey: 'closed|w=1|ongoing', now: server.clock.now(),
    });
    expect(again).toMatchObject({ created: false, record: { id, source: 'file', why: null, closureKey: 'closed|w=1|ongoing' } });
    expect(await store.markDismissed(t.scope, t.locationId, id, { by: t.member.userId, now: server.clock.now() })).toBe(true);
    const other = await store.insertOne(t.scope, {
      id: new Types.ObjectId().toHexString(), locationId: t.locationId, week: '2026-06-01', source: 'sales',
      evidence: { noSalesCount: 9, weekdayCount: 11, lastSalesDate: '2026-03-02' },
      text: 'Closed on Mondays', schedule: MONDAYS, closureKey: 'closed|w=1|ongoing', now: server.clock.now(),
    });
    expect(other).toBeNull();
    expect(await store.findByKey(t.scope, t.locationId, 'closed|w=1|ongoing')).toMatchObject({ id, status: 'dismissed' });
  });
});

describe('the weekly pass beside suggested closure rules (D46)', () => {
  it('sends no file or sales suggestion in alreadySuggested, and drops a weekly rule matching one’s closure key', async () => {
    const t = await team();
    const store = createAgentSuggestionStore(server.connection);
    await store.insertOne(t.scope, {
      id: new Types.ObjectId().toHexString(), locationId: t.locationId, week: '2026-06-01', source: 'file', fileId: new Types.ObjectId().toHexString(),
      text: 'Closed on Thursdays', closureKey: 'closed|w=4|ongoing', now: server.clock.now(),
      schedule: { kind: 'closure', startDate: '2026-06-01', endDate: null, weekdays: [4], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
    });
    const [weekly] = await stored(t, [THANKSGIVING_LIKE]);
    const reply = JSON.stringify({ suggestions: [{
      type: 'rule', ruleText: 'Shut Thursdays', kind: 'closure', startDate: '2026-06-04', endDate: null, weekdays: [4], effect: 'closed',
      expectedGuests: null, detail: null, startTime: null, endTime: null, why: 'Thursdays are quiet.', calendarIds: [],
    }] });
    const chat = scriptedModel();
    chat.script({ kind: 'message', message: message([text(reply)]) });
    const location = await server.ctx.stores.locations.find(t.scope, t.locationId);
    if (location === null) throw new Error('no location');
    const outcome = await suggestFor({ config: server.ctx.config, now: server.ctx.now, stores: server.ctx.stores, chat }, t.scope, location, '2026-06-01');
    expect(outcome).toEqual({ status: 'none', ownerEvents: 0 });
    const [sent] = messagesOf(chat.calls[0]);
    expect((JSON.parse(typeof sent?.content === 'string' ? sent.content : '') as { alreadySuggested: unknown[] }).alreadySuggested).toEqual([
      expect.objectContaining({ type: 'note', startDate: (weekly?.type === 'note' ? weekly.note.startDate : '') }),
    ]);
  });
});

describe('the weekly pass beside the sales history’s suggestion (code review S2)', () => {
  it('drops a weekly rule the sales history already suggests, though no row holds its key yet', async () => {
    const t = await team();
    const rows: Record<string, unknown>[] = [];
    for (let day = '2026-03-02'; day <= '2026-05-31'; day = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)) {
      if (new Date(`${day}T00:00:00.000Z`).getUTCDay() === 1) continue;
      rows.push({
        orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(t.locationId), date: day, guests: 80, netSalesCents: null,
        uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
      });
    }
    await server.connection.collection('tw_sales_days').insertMany(rows);
    const chat = scriptedModel();
    chat.script({ kind: 'message', message: message([text(JSON.stringify({ suggestions: [{
      type: 'rule', ruleText: 'Shut Mondays', kind: 'closure', startDate: '2026-06-08', endDate: null, weekdays: [1], effect: 'closed',
      expectedGuests: null, detail: null, startTime: null, endTime: null, why: 'Mondays had no sales.', calendarIds: [],
    }] }))]) });
    const location = await server.ctx.stores.locations.find(t.scope, t.locationId);
    if (location === null) throw new Error('no location');
    const outcome = await suggestFor({ config: server.ctx.config, now: server.ctx.now, stores: server.ctx.stores, chat }, t.scope, location, '2026-06-01');
    expect(outcome).toEqual({ status: 'none', ownerEvents: 0 });
    expect((await panel(t, t.member)).ruleSuggestions.map((each) => each.id)).toEqual(['sales_weekday_1']);
  });
});
