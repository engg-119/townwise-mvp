// D59 slice 5 (openspec change auto-apply-agent-reads design decision 16, src/calendar/answers.ts): when a calendar's
// events switch, the location's calendars answer its open closure questions and suggestions with no model call. While
// TownwiseAI works on its own, a closure note linked to each answering event (or, for a standing weekday, the rule) is
// saved through the one writer with Undo, and the suggestion reads `answered` by the calendar; while it does not, the
// suggestion is answered and nothing is saved. Either way it is gone from GET .../agent (its counts too) and GET
// .../rules. A title that does not plainly say closed answers nothing, and a person's note that decides a day
// differently keeps the suggestion open. Gap questions are answered on read. The refresh loop answers too, and its log
// line and the audit event carry ids and counts only. Every title, uid and day here is made up; the test clock reads
// Mon, Jun 1, 2026 (Hanover).
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';

import { createLogger } from '@ckeith26/server-core';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { closureKeyOf, closureRuleText } from '../src/agent/closure-suggestions.ts';
import type { CalendarFetcher, CalendarFetchResult } from '../src/calendar/fetch.ts';
import { parseIcs } from '../src/calendar/ics.ts';
import { createCalendarRefresher } from '../src/calendar/refresher.ts';
import { seal } from '../src/calendar/secret.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
import { createTownwiseStores, type TownwiseStores } from '../src/stores/index.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const KEY = createSecretKey(randomBytes(32));
const HOST = 'calendar.example.test';
const TOWN = { today: '2026-06-01', timeZone: 'America/New_York' };
/** A made-up name in a closed title: never logged. */
const LOOP_TITLE = 'Closed for the Quillfeather holidays';

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
    const lines = loopLogs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === 'townwise.calendar_answers');
    expect(lines.map((line) => Object.keys(line).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key)).sort()))
      .toEqual([['answered', 'held', 'locationId', 'notes', 'rules']]);
    expect(lines[0]).toMatchObject({ locationId: t.locationId, answered: 1, notes: 1, rules: 0, held: 0 });
    expect(loopLogs.join('\n')).not.toMatch(/Quillfeather|holidays-0002/);
  });
});
