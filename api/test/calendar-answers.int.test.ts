// D59 slice 5 (openspec change auto-apply-agent-reads design decision 16, src/calendar/answers.ts): when a calendar's
// events switch, the location's calendars answer its open closure questions and suggestions with no model call. While
// TownwiseAI works on its own, a closure note linked to each answering event (or, for a standing weekday, the rule) is
// saved through the one writer with Undo, and the suggestion reads `answered` by the calendar; while it does not, the
// suggestion is answered and nothing is saved. Either way it is gone from GET .../agent (its counts too) and GET
// .../rules. A title that does not plainly say closed answers nothing, and a person's note that decides a day
// differently keeps the suggestion open. Gap questions are answered on read. The refresh loop, Refresh now, a sales
// upload and the weekly pass (whatever its outcome) answer too, and the log line and the audit event carry ids and
// counts only. A note over part of an event does not count as the event's, an undone note is not written, Undo on a
// calendar's labels leaves its answers, removing the calendar takes them back, and a location deleted mid-run keeps
// nothing. Every title, uid and day here is made up; the test clock reads Mon, Jun 1, 2026 (Hanover).
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';

import { createLogger } from '@ckeith26/server-core';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { applyChange } from '../src/agent/apply.ts';
import { closureKeyOf, closureRuleText } from '../src/agent/closure-suggestions.ts';
import { TOWNWISE_AI_ACTOR } from '../src/audit.ts';
import { answerFromCalendars } from '../src/calendar/answers.ts';
import type { CalendarFetcher, CalendarFetchResult } from '../src/calendar/fetch.ts';
import { parseIcs } from '../src/calendar/ics.ts';
import { createCalendarRefresher } from '../src/calendar/refresher.ts';
import { seal } from '../src/calendar/secret.ts';
import { removeLocation } from '../src/handlers/locations.ts';
import { suggestFor } from '../src/lab/suggestions.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
import { createTownwiseStores, type TownwiseStores } from '../src/stores/index.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const KEY = createSecretKey(randomBytes(32));
const HOST = 'calendar.example.test';
const TOWN = { today: '2026-06-01', timeZone: 'America/New_York' };
/** A closed title: never logged. */
const LOOP_TITLE = 'Closed for the holidays';

function vevent(uid: string, title: string, start: string, end: string): string {
  return ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`, 'END:VEVENT'].join('\r\n');
}

function ics(...events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Townwise test//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');
}

/** "Closed" all day Dec 24 to Dec 26, 2026 (DTEND is exclusive). */
const HOLIDAYS = vevent('holidays-0001@example.test', 'Closed for the holidays', '20261224', '20261227');

let server: TownwiseTestServer;
let stores: TownwiseStores;
let answer: CalendarFetchResult = { ok: true, text: ics(), host: HOST };
const fetcher: CalendarFetcher = { fetch: () => Promise.resolve(answer) };
const loopLogs: string[] = [];
const logger = createLogger({ LOG_LEVEL: 'info' }, { destination: { write: (line: string) => { loopLogs.push(line); } } });

beforeAll(async () => {
  server = await startTownwiseServer({ calendarKey: KEY, calendarFetcher: fetcher });
  stores = createTownwiseStores(server.connection);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

interface Tenant { orgId: string; locationId: string; scope: OrgScope; admin: TestSession; member: TestSession }

async function person(orgId: string, role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Answer Bistro ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId), admin: await person(orgId, 'org_admin'), member: await person(orgId, 'member') };
}

function closure(over: Partial<RuleSchedule> = {}): RuleSchedule {
  return {
    kind: 'closure', startDate: '2026-12-24', endDate: '2026-12-26', weekdays: null, effect: 'closed', expectedGuests: null,
    startTime: null, endTime: null, ...over,
  };
}

/** A closure rule a file read suggested, stored open. Resolves its id. */
async function fileRule(t: Tenant, schedule: RuleSchedule = closure()): Promise<string> {
  const id = new Types.ObjectId().toHexString();
  const stored = await stores.agentSuggestions.insertOne(t.scope, {
    id, locationId: t.locationId, week: '2026-06-01', source: 'file', text: closureRuleText(schedule), schedule,
    closureKey: closureKeyOf(schedule), now: server.clock.now(),
  });
  expect(stored?.created).toBe(true);
  return id;
}

async function addFile(t: Tenant, text: string): Promise<void> {
  const res = await call(server, `/api/org/locations/${t.locationId}/owner-calendars`, {
    session: t.member, json: { kind: 'file', label: 'Front desk', ics: text },
  });
  expect(res.status).toBe(201);
}

interface Panel { questions: { id: string }[]; ruleSuggestions: { id: string }[]; waiting: number; activity: { kind: string; changeId?: string; sourceKind?: string; undoable?: boolean }[] }

async function panel(t: Tenant): Promise<Panel> {
  const res = await call(server, `/api/org/locations/${t.locationId}/agent`, { session: t.member });
  expect(res.status).toBe(200);
  return await res.json() as Panel;
}

async function suggestedRules(t: Tenant): Promise<unknown[]> {
  const res = await call(server, `/api/org/locations/${t.locationId}/rules`, { session: t.member });
  expect(res.status).toBe(200);
  return (await res.json() as { suggested: unknown[] }).suggested;
}

function rowsOf(collection: string, t: Tenant) {
  return server.connection.collection(collection).find({ locationId: new Types.ObjectId(t.locationId) }).toArray();
}

/** A closure note a file read left as a suggestion ("Not sure from your files"), stored open. Resolves its id. */
async function fileNote(t: Tenant, startDate = '2026-12-24', endDate = '2026-12-26'): Promise<string> {
  const id = new Types.ObjectId().toHexString();
  const stored = await stores.agentSuggestions.insertFileNote(t.scope, {
    id, locationId: t.locationId, week: '2026-06-01', fileId: new Types.ObjectId().toHexString(), now: server.clock.now(),
    note: {
      kind: 'closure', startDate, endDate, weekdays: null, effect: 'closed', expectedGuests: null, detail: null, title: null, startTime: null, endTime: null,
    },
  });
  expect(stored.created).toBe(true);
  return id;
}

/** A file calendar stored with no switch point run (no answer yet). Resolves its id. */
async function storedFile(t: Tenant, text: string): Promise<string> {
  const parsed = parseIcs(text, TOWN);
  if ('error' in parsed) throw new Error(parsed.error);
  const added = await stores.ownerCalendars.add(t.scope, t.locationId, { kind: 'file', label: 'Front desk' }, parsed, {
    createdBy: t.member.userId, now: server.clock.now(),
  });
  if (added === 'calendar_limit') throw new Error('calendar_limit');
  return added.id;
}

/** A link calendar stored with no switch point run, the one the refresh loop and Refresh now read. Resolves its id. */
async function storedLink(t: Tenant): Promise<string> {
  const parsed = parseIcs(ics(), TOWN);
  if ('error' in parsed) throw new Error(parsed.error);
  const added = await stores.ownerCalendars.add(t.scope, t.locationId, {
    kind: 'link', label: 'Front desk', sealedAddress: seal(KEY, `https://${HOST}/secret-${randomUUID()}.ics`), host: HOST,
  }, parsed, { createdBy: t.member.userId, now: server.clock.now() });
  if (added === 'calendar_limit') throw new Error('calendar_limit');
  return added.id;
}

async function location(t: Tenant) {
  const found = await stores.locations.find(t.scope, t.locationId);
  if (found === null) throw new Error('no location');
  return found;
}

const answerDeps = (over: Partial<Parameters<typeof answerFromCalendars>[0]> = {}): Parameters<typeof answerFromCalendars>[0] => ({
  stores, logger, now: server.clock.now, agentAuto: true, ...over,
});

/** The next 8 Mondays from the test's today, as all-day "Closed" events. */
const MONDAYS = ['20260608', '20260615', '20260622', '20260629', '20260706', '20260713', '20260720', '20260727'];
const nextDay = (day: string): string => day.slice(0, 6) + String(Number(day.slice(6)) + 1).padStart(2, '0');
const closedMondays = (): string => ics(...MONDAYS.map((day, i) => vevent(`monday-${String(i)}@example.test`, 'Closed', day, nextDay(day))));

describe('a calendar answers an open closure suggestion', () => {
  it('while TownwiseAI works on its own: the suggestion goes everywhere, and a closure note linked to the event is saved with Undo', async () => {
    const t = await tenant();
    const id = await fileRule(t);
    expect((await panel(t)).ruleSuggestions.map((each) => each.id)).toEqual([id]);
    expect((await panel(t)).waiting).toBe(1);
    expect(await suggestedRules(t)).toHaveLength(1);

    await addFile(t, ics(HOLIDAYS));

    const after = await panel(t);
    expect(after.ruleSuggestions).toEqual([]);
    expect(after.waiting).toBe(0);
    expect(await suggestedRules(t)).toEqual([]);
    const row = await stores.agentSuggestions.find(t.scope, t.locationId, id);
    expect(row).toMatchObject({ status: 'answered' });
    expect((await server.connection.collection('tw_agent_suggestions').findOne({ _id: new Types.ObjectId(id) }))?.decidedBy).toBe('calendar');
    const notes = await rowsOf('tw_notes', t);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'closure', startDate: '2026-12-24', endDate: '2026-12-26', effect: 'closed', createdBy: 'townwise_ai',
      fromEvent: { uid: 'holidays-0001@example.test', startDate: '2026-12-24', endDate: '2026-12-26' },
    });
    expect(notes[0]?.title ?? null).toBeNull();
    const change = after.activity.find((item) => item.kind === 'agent_change');
    expect(change).toMatchObject({ sourceKind: 'calendar', undoable: true });

    const audit = (await auditEvents(server)).filter((event) => String(event.orgId) === t.orgId);
    expect(audit.filter((event) => event.action === 'agent.change_applied').map((event) => event.details))
      .toEqual([{ locationId: t.locationId, action: 'note.add', sourceKind: 'calendar' }]);
    expect(audit.filter((event) => event.action === 'agent.calendar_answered').map((event) => event.details)).toEqual([{ locationId: t.locationId, count: 1 }]);

    // Undo removes the note; the suggestion stays answered.
    const undo = await call(server, `/api/org/locations/${t.locationId}/agent/changes/${String(change?.changeId)}/undo`, { session: t.member, method: 'POST' });
    expect(undo.status).toBe(200);
    expect(await rowsOf('tw_notes', t)).toEqual([]);
    expect((await panel(t)).ruleSuggestions).toEqual([]);
  });

  it('while it does not: the suggestion is answered and gone, and nothing is saved', async () => {
    const t = await tenant();
    const off = await call(server, '/api/org/agent-auto', { method: 'PATCH', session: t.admin, json: { on: false } });
    expect(off.status).toBe(200);
    const id = await fileRule(t);
    await addFile(t, ics(HOLIDAYS));
    expect((await panel(t)).ruleSuggestions).toEqual([]);
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, id)).toMatchObject({ status: 'answered' });
    expect(await rowsOf('tw_notes', t)).toEqual([]);
    expect(await rowsOf('tw_agent_changes', t)).toEqual([]);
  });

  it('answers nothing from a title that does not plainly say closed, nor over a person’s note that disagrees', async () => {
    const plain = await tenant();
    const id = await fileRule(plain);
    await addFile(plain, ics(vevent('early-0001@example.test', 'Closed early', '20261224', '20261227')));
    expect(await stores.agentSuggestions.find(plain.scope, plain.locationId, id)).toMatchObject({ status: 'open' });
    expect((await panel(plain)).ruleSuggestions.map((each) => each.id)).toEqual([id]);

    const t = await tenant();
    const held = await fileRule(t);
    const party = await call(server, `/api/org/locations/${t.locationId}/notes`, {
      session: t.member,
      json: { kind: 'private_event', startDate: '2026-12-24', endDate: '2026-12-24', effect: 'more_guests', expectedGuests: 30 },
    });
    expect(party.status).toBe(201);
    await addFile(t, ics(HOLIDAYS));
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, held)).toMatchObject({ status: 'open' });
    expect(await rowsOf('tw_notes', t)).toHaveLength(1);
    expect(await rowsOf('tw_agent_changes', t)).toEqual([]);

    // A person's note that says the restaurant is open on one of the days keeps it open too.
    const open = await tenant();
    const kept = await fileRule(open);
    const opening = await call(server, `/api/org/locations/${open.locationId}/notes`, {
      session: open.member, json: { kind: 'opening', startDate: '2026-12-26', endDate: '2026-12-26', effect: 'unknown' },
    });
    expect(opening.status).toBe(201);
    await addFile(open, ics(HOLIDAYS));
    expect(await stores.agentSuggestions.find(open.scope, open.locationId, kept)).toMatchObject({ status: 'open' });
    expect(await rowsOf('tw_agent_changes', open)).toEqual([]);
  });

  it('writes the note when a person’s closure note covers only part of the event, or only its weekdays', async () => {
    const t = await tenant();
    const partial = await call(server, `/api/org/locations/${t.locationId}/notes`, {
      session: t.member, json: { kind: 'closure', startDate: '2026-12-24', endDate: '2026-12-24', effect: 'closed' },
    });
    expect(partial.status).toBe(201);
    const id = await fileNote(t);
    await addFile(t, ics(HOLIDAYS));
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, id)).toMatchObject({ status: 'answered' });
    expect((await rowsOf('tw_notes', t)).map((note): unknown[] => [note.startDate, note.endDate, note.createdBy === 'townwise_ai'])).toEqual([
      ['2026-12-24', '2026-12-24', false], ['2026-12-24', '2026-12-26', true],
    ]);

    // "Closed on Mondays" all year does not close Thanksgiving (a Thursday).
    const w = await tenant();
    const mondays = await call(server, `/api/org/locations/${w.locationId}/notes`, {
      session: w.member, json: { kind: 'closure', startDate: '2026-06-01', endDate: '2026-12-31', weekdays: [1], effect: 'closed' },
    });
    expect(mondays.status).toBe(201);
    const thanksgiving = await fileNote(w, '2026-11-26', '2026-11-26');
    await addFile(w, ics(vevent('thanksgiving-0001@example.test', 'Closed for Thanksgiving', '20261126', '20261127')));
    expect(await stores.agentSuggestions.find(w.scope, w.locationId, thanksgiving)).toMatchObject({ status: 'answered' });
    expect((await rowsOf('tw_notes', w)).filter((note) => note.createdBy === 'townwise_ai').map((note): unknown[] => [note.startDate, note.endDate]))
      .toEqual([['2026-11-26', '2026-11-26']]);
  });

  it('leaves a later suggestion open once a person undid the event’s note', async () => {
    const t = await tenant();
    await fileRule(t);
    await addFile(t, ics(HOLIDAYS));
    const change = (await panel(t)).activity.find((item) => item.kind === 'agent_change');
    const undo = await call(server, `/api/org/locations/${t.locationId}/agent/changes/${String(change?.changeId)}/undo`, { session: t.member, method: 'POST' });
    expect(undo.status).toBe(200);
    // A file read later suggests the same closure; the next switch must not count the undone note as written.
    const later = await fileNote(t);
    loopLogs.length = 0;
    await answerFromCalendars(answerDeps(), t.scope, await location(t));
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, later)).toMatchObject({ status: 'open' });
    expect(await rowsOf('tw_notes', t)).toEqual([]);
    const lines = loopLogs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === 'townwise.calendar_answers');
    expect(lines).toEqual([expect.objectContaining({ locationId: t.locationId, answered: 0, notes: 0, held: 1 })]);
  });

  it('answers a standing closed weekday from 8 upcoming closed Mondays with the rule itself', async () => {
    const t = await tenant();
    const id = await fileRule(t, closure({ startDate: '2026-06-01', endDate: null, weekdays: [1] }));
    const mondays = ['20260608', '20260615', '20260622', '20260629', '20260706', '20260713', '20260720', '20260727'];
    const next = (day: string): string => day.slice(0, 6) + String(Number(day.slice(6)) + 1).padStart(2, '0');
    await addFile(t, ics(...mondays.map((day, i) => vevent(`monday-${String(i)}@example.test`, 'Closed', day, next(day)))));
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, id)).toMatchObject({ status: 'answered' });
    const rules = await rowsOf('tw_business_rules', t);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ text: 'Closed on Mondays', createdBy: 'townwise_ai', schedule: { weekdays: [1], endDate: null } });
    expect(await rowsOf('tw_notes', t)).toEqual([]);
    expect((await rowsOf('tw_agent_changes', t)).map((row): unknown[] => [row.action, row.sourceKind])).toEqual([['rule.add', 'calendar']]);
    // The rule is from the calendar of the events that answered, on behalf of its adder.
    const calendarId = (await stores.ownerCalendars.list(t.scope, t.locationId))[0]?.id;
    expect((await rowsOf('tw_agent_changes', t))[0]).toMatchObject({ sourceId: calendarId, onBehalfOf: t.member.userId });
  });

  it('while TownwiseAI does not work on its own, leaves a standing closed weekday open: the calendar shows only weeks', async () => {
    const t = await tenant();
    const off = await call(server, '/api/org/agent-auto', { method: 'PATCH', session: t.admin, json: { on: false } });
    expect(off.status).toBe(200);
    const id = await fileRule(t, closure({ startDate: '2026-06-01', endDate: null, weekdays: [1] }));
    await addFile(t, closedMondays());
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, id)).toMatchObject({ status: 'open' });
    expect((await panel(t)).ruleSuggestions.map((each) => each.id)).toEqual([id]);
    expect(await rowsOf('tw_business_rules', t)).toEqual([]);
  });
});

describe('the sales history’s closed weekday, computed on read', () => {
  /** Mar 2 to May 31, 2026 with sales every day but Mondays: the sales history suggests "Closed on Mondays". */
  async function seedNoMondays(t: Tenant): Promise<void> {
    const days = [];
    for (let at = Date.parse('2026-03-02T00:00:00.000Z'); at <= Date.parse('2026-05-31T00:00:00.000Z'); at += 86_400_000) {
      const day = new Date(at);
      if (day.getUTCDay() !== 1) days.push({ date: day.toISOString().slice(0, 10), guests: 100, netSalesCents: null });
    }
    const res = await call(server, `/api/org/locations/${t.locationId}/sales/uploads`, { session: t.member, json: { days } });
    expect(res.status).toBe(201);
  }

  it('a sales upload asks it, and the calendar’s closed Mondays answer it with the rule, stored answered under its key', async () => {
    const t = await tenant();
    await storedFile(t, closedMondays());
    await seedNoMondays(t);
    const row = await stores.agentSuggestions.findByKey(t.scope, t.locationId, closureKeyOf(closure({ startDate: '2026-06-02', endDate: null, weekdays: [1] })));
    expect(row).toMatchObject({ status: 'answered', source: 'sales' });
    expect(await suggestedRules(t)).toEqual([]);
    expect((await panel(t)).ruleSuggestions).toEqual([]);
    expect((await rowsOf('tw_business_rules', t)).map((rule): unknown => rule.text)).toEqual(['Closed on Mondays']);
  });
});

describe('the weekly pass', () => {
  it('answers whatever its outcome: weekly suggestions off still checks the calendars', async () => {
    const t = await tenant();
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(t.orgId) }, { $set: { 'weeklySuggestions.on': false } });
    const id = await fileRule(t);
    await storedFile(t, ics(HOLIDAYS));
    const chat = { send: () => Promise.reject(new Error('no call')) } as unknown as Parameters<typeof suggestFor>[0]['chat'];
    const outcome = await suggestFor({ config: server.ctx.config, now: server.clock.now, stores, logger, chat }, t.scope, await location(t), '2026-06-01');
    expect(outcome.status).toBe('off');
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, id)).toMatchObject({ status: 'answered' });
    expect(await rowsOf('tw_notes', t)).toHaveLength(1);
  });
});

describe('Refresh now', () => {
  it('answers after a refresh that switches in a closed event', async () => {
    const t = await tenant();
    const id = await fileRule(t);
    const calendarId = await storedLink(t);
    answer = { ok: true, text: ics(vevent('holidays-0003@example.test', 'Closed', '20261224', '20261227')), host: HOST };
    const res = await call(server, `/api/org/locations/${t.locationId}/owner-calendars/${calendarId}/refresh`, { session: t.member, method: 'POST' });
    expect(res.status).toBe(200);
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, id)).toMatchObject({ status: 'answered' });
    expect(await rowsOf('tw_notes', t)).toHaveLength(1);
  });
});

describe('what the answers wrote, later', () => {
  it('Undo on a calendar’s booking labels leaves the closure notes its answers saved', async () => {
    const t = await tenant();
    const calendarId = await storedFile(t, ics(HOLIDAYS));
    const id = await fileRule(t);
    await answerFromCalendars(answerDeps(), t.scope, await location(t));
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, id)).toMatchObject({ status: 'answered' });
    // The calendar's sort (slice 2), as its ledger row reads.
    const labels = await applyChange({ stores, logger, now: server.clock.now }, t.scope, {
      action: 'booking.label', locationId: t.locationId, sourceKind: 'calendar', sourceId: calendarId, targetId: calendarId, confidence: 'high',
      why: null, onBehalfOf: t.member.userId, actor: TOWNWISE_AI_ACTOR, key: `labels-${calendarId}`, dates: null, count: 1,
      write: () => Promise.resolve(server.clock.now()),
    });
    expect(labels.outcome).toBe('applied');
    const undo = await call(server, `/api/org/locations/${t.locationId}/agent/changes/${String(labels.change?.id)}/undo`, { session: t.admin, method: 'POST' });
    expect(undo.status).toBe(200);
    expect((await rowsOf('tw_notes', t)).map((note): unknown[] => [note.startDate, note.endDate])).toEqual([['2026-12-24', '2026-12-26']]);
    expect((await rowsOf('tw_agent_changes', t)).map((row): unknown[] => [row.action, row.status])).toEqual([['note.add', 'applied'], ['booking.label', 'undone']]);
  });

  it('removing the calendar takes back the closure notes its answers saved, as TownwiseAI', async () => {
    const t = await tenant();
    await fileRule(t);
    await addFile(t, ics(HOLIDAYS));
    expect(await rowsOf('tw_notes', t)).toHaveLength(1);
    const calendarId = (await stores.ownerCalendars.list(t.scope, t.locationId))[0]?.id;
    const removed = await call(server, `/api/org/locations/${t.locationId}/owner-calendars/${String(calendarId)}`, { session: t.member, method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect(await rowsOf('tw_notes', t)).toEqual([]);
    expect((await rowsOf('tw_agent_changes', t)).map((row): unknown[] => [row.status, row.statusBy])).toEqual([['undone', 'townwise_ai']]);
    const audit = (await auditEvents(server)).filter((event) => String(event.orgId) === t.orgId && event.action === 'agent.change_undone');
    expect(audit.map((event): unknown[] => [event.actorUserId, event.details])).toEqual([
      ['townwise_ai', { locationId: t.locationId, action: 'note.add', sourceKind: 'calendar' }],
    ]);
  });

  it('a location deleted while it runs keeps nothing it wrote', async () => {
    const t = await tenant();
    await storedFile(t, ics(HOLIDAYS));
    await fileRule(t);
    const found = await location(t);
    // The delete lands between the run's reads and its first write.
    const notes = { ...stores.notes, create: async (...args: Parameters<TownwiseStores['notes']['create']>) => {
      await removeLocation(server.ctx, t.scope, t.locationId);
      return stores.notes.create(...args);
    } };
    await answerFromCalendars(answerDeps({ stores: { ...stores, notes } }), t.scope, found);
    expect(await rowsOf('tw_notes', t)).toEqual([]);
    expect(await rowsOf('tw_agent_changes', t)).toEqual([]);
    expect(await rowsOf('tw_agent_suggestions', t)).toEqual([]);
  });
});

describe('a calendar answers a gap question on read', () => {
  it('the gap goes from the panel, and a closure note for its event is saved while TownwiseAI works on its own', async () => {
    const t = await tenant();
    const gap = new Set(['2026-05-23', '2026-05-24', '2026-05-25']);
    const days = [];
    for (let at = Date.parse('2026-03-02T00:00:00.000Z'); at <= Date.parse('2026-05-31T00:00:00.000Z'); at += 86_400_000) {
      const date = new Date(at).toISOString().slice(0, 10);
      if (!gap.has(date)) {
        days.push({
          orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(t.locationId), date, guests: 100, netSalesCents: null,
          uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
        });
      }
    }
    await server.connection.collection('tw_sales_days').insertMany(days);
    expect((await panel(t)).questions.map((q) => q.id)).toEqual(['gap_2026-05-23_2026-05-25']);
    await addFile(t, ics(vevent('gap-0001@example.test', 'We’re closed', '20260523', '20260526')));
    expect((await panel(t)).questions).toEqual([]);
    expect((await rowsOf('tw_notes', t)).map((note): unknown[] => [note.startDate, note.endDate, (note.fromEvent as { uid: string } | undefined)?.uid])).toEqual([
      ['2026-05-23', '2026-05-25', 'gap-0001@example.test'],
    ]);
  });
});

describe('the refresh loop', () => {
  it('answers after a refresh that switches in a closed event, logging ids and counts only', async () => {
    const t = await tenant();
    const id = await fileRule(t);
    const parsed = parseIcs(ics(), TOWN);
    if ('error' in parsed) throw new Error(parsed.error);
    const added = await stores.ownerCalendars.add(t.scope, t.locationId, {
      kind: 'link', label: 'Front desk', sealedAddress: seal(KEY, `https://${HOST}/secret-${randomUUID()}.ics`), host: HOST,
    }, parsed, { createdBy: t.member.userId, now: server.clock.now() });
    if (added === 'calendar_limit') throw new Error('calendar_limit');
    const sources = server.connection.collection('tw_calendar_sources');
    await sources.updateMany({}, { $set: { nextRefreshAt: new Date('2099-01-01T00:00:00.000Z') } });
    await sources.updateOne({ _id: new Types.ObjectId(added.id) }, { $set: { nextRefreshAt: server.clock.now() } });
    answer = { ok: true, text: ics(vevent('holidays-0002@example.test', LOOP_TITLE, '20261224', '20261227')), host: HOST };
    await createCalendarRefresher({
      connection: server.connection, stores, key: KEY, logger, now: server.clock.now, fetcher, agentAuto: true,
    }).drain();
    expect(await stores.agentSuggestions.find(t.scope, t.locationId, id)).toMatchObject({ status: 'answered' });
    expect(await rowsOf('tw_notes', t)).toHaveLength(1);
    const lines = loopLogs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === 'townwise.calendar_answers' && line.locationId === t.locationId);
    expect(lines.map((line) => Object.keys(line).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key)).sort()))
      .toEqual([['answered', 'held', 'locationId', 'notes', 'rules']]);
    expect(lines[0]).toMatchObject({ locationId: t.locationId, answered: 1, notes: 1, rules: 0, held: 0 });
    expect(loopLogs.join('\n')).not.toMatch(/Closed for|holidays-0002/);
  });
});
