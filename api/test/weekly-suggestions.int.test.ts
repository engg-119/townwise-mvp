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
import { createAgentSuggestionStore, type NewSuggestion, type SuggestionRecord } from '../src/stores/agent-suggestions.ts';
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
