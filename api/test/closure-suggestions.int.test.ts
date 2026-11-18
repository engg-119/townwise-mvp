// Suggested closure rules (openspec change suggest-closure-rules, D46) end to end against the database: a file read
// stores the closed patterns it states as open suggestions (planned ids, retries, an answer and plan from before the
// change, a long closure the guard refuses, the caps), which change nothing until a member confirms, edits or dismisses
// one through the two member routes; races between them; undo; the weekly routes and the new ones keeping to their own
// rows; view-as, open as admin and the rule limit; and no rule words, file name or dates in a log line or an audit
// event. The model is a scripted fake: no call leaves the test. The test clock reads Mon, Jun 1, 2026 (Hanover). Every
// date is synthetic.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import type { FileReaderModel, ReaderAnswer } from '../src/files/extract/reader.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import type { RuleSuggestionView } from '../src/agent/rule-suggestion-views.ts';
import type { AgentPanel } from '../src/handlers/agent.ts';
import type { DataItemView } from '../src/handlers/data.ts';
import type { RuleView } from '../src/handlers/rules.ts';
import { createAgentSuggestionStore, type NewSuggestion } from '../src/stores/agent-suggestions.ts';
import { addGrant, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { holdCalls, type Hold } from './helpers/hold.ts';
import {
  call, logLines, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const SENTINEL = 'Wqzv';
const TODAY = '2026-06-01';

const MONDAYS = { weekdays: [1], startDate: null, endDate: null, yearly: false };
const TUESDAYS = { ...MONDAYS, weekdays: [2] };

function answer(over: Record<string, unknown> = {}): ReaderAnswer {
  return {
    kind: 'answered', costMicroUsd: 1000,
    output: { kind: 'menu', confidence: 'high', summary: 'A menu with opening hours.', facts: [], events: [], days: [], ...over },
  };
}

let answers: ReaderAnswer[] = [];
const model: FileReaderModel = { readFile: () => Promise.resolve(answers.shift() ?? answer()) };
const memory = createMemoryFileBlobs();
/** The next raw writes that fail (the summary item's blob), so the read is put back after its suggestions. */
let failRawWrites = 0;

let server: TownwiseTestServer;

interface Team { orgId: string; scope: OrgScope; admin: TestSession; member: TestSession; colleague: TestSession }
let team: Team;

async function person(orgId: string, role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

async function newTeam(): Promise<Team> {
  const orgId = await createOrg(server, { name: `Closure Kitchen ${randomUUID().slice(0, 6)}` });
  return {
    orgId, scope: { orgId } as OrgScope, admin: await person(orgId, 'org_admin'), member: await person(orgId, 'member'),
    colleague: await person(orgId, 'member'),
  };
}

beforeAll(async () => {
  server = await startTownwiseServer({
    files: {
      ...memory,
      writeRaw: (...args) => {
        if (failRawWrites > 0) {
          failRawWrites -= 1;
          return Promise.reject(new Error('blob outage'));
        }
        return memory.writeRaw(...args);
      },
    },
    aiReader: { model },
  });
  team = await newTeam();
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.aiReader?.settled();
  answers = [];
  failRawWrites = 0;
  await server.redis.flushdb();
  await server.connection.collection('tw_files_usage').deleteMany({});
  await server.connection.collection('tw_upload_days').deleteMany({});
});

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);

function newLocation(t = team): Promise<string> {
  return addLocation(server, { orgId: t.orgId, name: `${SENTINEL} Room ${randomUUID().slice(0, 6)}` });
}

/** A finished stored file with its original, named with the sentinel. */
async function seedStored(locationId: string, t = team, by = t.member): Promise<string> {
  const _id = new Types.ObjectId();
  const raw = Buffer.from(`Hours\nTuesday to Sunday 11 to 9\n${SENTINEL}\n`);
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: oid(t.orgId), locationId: oid(locationId), importId: null, purpose: 'reference', uploadedBy: by.userId,
    uploaderRole: 'member', uploadedAt: server.clock.now(), name: `${SENTINEL} menu.txt`, kind: 'text', sizeBytes: raw.length,
    fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference', progress: null,
    readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null, rawDeletedAt: null, attempts: 0,
  });
  await memory.writeRaw(t.scope, { locationId, fileId: _id.toHexString() }, raw, 'application/octet-stream');
  return _id.toHexString();
}

const itemPath = (locationId: string, fileId: string): string => `/api/org/locations/${locationId}/data/f_${fileId}`;

async function runReader(): Promise<void> {
  await server.connection.collection('tw_files').updateMany({ 'ai.status': 'queued' }, { $set: { 'ai.notBefore': null } });
  server.aiReader?.nudge();
  await server.aiReader?.settled();
}

async function readAs(session: TestSession, locationId: string, fileId: string): Promise<void> {
  expect((await call(server, `${itemPath(locationId, fileId)}/ai`, { session, json: {} })).status).toBe(202);
  await runReader();
}

/** A location whose file read answered `over`, read as the member. */
async function readWith(over: Record<string, unknown>, t = team): Promise<{ locationId: string; fileId: string }> {
  const locationId = await newLocation(t);
  const fileId = await seedStored(locationId, t);
  answers = [answer(over)];
  await readAs(t.member, locationId, fileId);
  return { locationId, fileId };
}

async function rulesPage(locationId: string, session = team.member): Promise<{ rules: RuleView[]; suggested: RuleSuggestionView[] }> {
  const res = await call(server, `/api/org/locations/${locationId}/rules`, { session });
  expect(res.status).toBe(200);
  return await res.json() as { rules: RuleView[]; suggested: RuleSuggestionView[] };
}

async function panel(locationId: string, session = team.member): Promise<AgentPanel> {
  const res = await call(server, `/api/org/locations/${locationId}/agent`, { session });
  expect(res.status).toBe(200);
  return await res.json() as AgentPanel;
}

function decide(session: TestSession, locationId: string, id: string, action: 'accept' | 'dismiss', body: unknown = {}): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/agent/rule-suggestions/${id}/${action}`, { session, json: body });
}

function weeklyDecide(session: TestSession, locationId: string, id: string, action: 'accept' | 'dismiss'): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/agent/suggestions/${id}/${action}`, { session, json: {} });
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

async function outcomeOf(fileId: string): Promise<Record<string, unknown>> {
  const doc = await server.connection.collection('tw_files').findOne({ _id: oid(fileId) });
  return ((doc?.ai as { actions?: { outcome?: Record<string, unknown> } } | undefined)?.actions?.outcome) ?? {};
}

async function itemOf(session: TestSession, locationId: string, fileId: string): Promise<DataItemView> {
  const res = await call(server, itemPath(locationId, fileId), { session });
  expect(res.status).toBe(200);
  return (await res.json() as { item: DataItemView }).item;
}

async function eventsOf(action: string, orgId = team.orgId): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => event.action === action && String(event.orgId) === orgId);
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

async function suggestionDoc(id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_agent_suggestions').findOne({ _id: oid(id) });
}

const CLOSED = { kind: 'closure', effect: 'closed', expectedGuests: null, startTime: null, endTime: null } as const;

// ---- A file read ----------------------------------------------------------------------------------------------------

describe('a file read', () => {
  it('stores "Closed Mondays" as one open suggestion and no rule, listed on Business rules and the panel; audit and log carry counts', async () => {
    server.logs.length = 0;
    const { locationId, fileId } = await readWith({ closedPatterns: [MONDAYS] });
    const { rules, suggested } = await rulesPage(locationId);
    expect(rules).toEqual([]);
    const schedule = { ...CLOSED, weekdays: [1], startDate: TODAY, endDate: null };
    expect(suggested).toEqual([{
      id: expect.any(String) as unknown, source: 'file', text: 'Closed on Mondays', schedule, scheduleSummary: 'Closed on Mondays from Jun 1, 2026',
      file: { ref: `f_${fileId}`, title: `${SENTINEL} menu.txt` }, evidence: null, canDecide: true,
    }]);
    expect((await panel(locationId)).ruleSuggestions).toEqual(suggested);
    expect((await panel(locationId)).suggestions).toEqual([]);
    expect(await count('tw_business_rules', { locationId: oid(locationId) })).toBe(0);
    expect(await suggestionDoc(suggested[0]?.id ?? '')).toMatchObject({
      source: 'file', fileId: oid(fileId), closureKey: 'closed|w=1|ongoing', status: 'open', why: null, type: 'rule', week: TODAY,
    });
    expect(await outcomeOf(fileId)).toMatchObject({ rulesSuggested: [suggested[0]?.id], rulesSkipped: { duplicate: 0, cap: 0, invalid: 0 } });
    expect((await itemOf(team.member, locationId, fileId)).ai).toMatchObject({ rulesSuggested: 1, rulesWaiting: 1, canUndo: true });
    expect((await eventsOf('file.ai_read')).at(-1)?.details).toMatchObject({ locationId, rulesSuggested: 1 });
    expect(logLines(server).filter((line) => line.msg === 'townwise.ai_read').at(-1))
      .toMatchObject({ fileId, rulesSuggested: 1, rulesSkipped: { duplicate: 0, cap: 0, invalid: 0 } });
  });

  it('a yearly season becomes a yearly suggestion from today, and a dated one keeps its dates', async () => {
    const winter = { weekdays: null, startDate: '2027-01-01', endDate: '2027-03-31' };
    const { locationId } = await readWith({ closedPatterns: [{ ...winter, yearly: true }, { ...winter, startDate: '2026-12-20', endDate: '2027-01-05', yearly: false }] });
    const { suggested } = await rulesPage(locationId);
    expect(suggested.map(({ text, schedule, scheduleSummary }) => ({ text, schedule, scheduleSummary }))).toEqual([
      {
        text: 'Closed Jan 1 to Mar 31 every year',
        schedule: { ...CLOSED, weekdays: null, startDate: TODAY, endDate: null, season: { repeat: 'yearly', from: '01-01', to: '03-31' } },
        scheduleSummary: 'Closed Jan 1 to Mar 31 every year, from Jun 1, 2026',
      },
      {
        text: 'Closed Dec 20, 2026 to Jan 5, 2027', schedule: { ...CLOSED, weekdays: null, startDate: '2026-12-20', endDate: '2027-01-05' },
        scheduleSummary: 'Closed every day from Dec 20, 2026 to Jan 5, 2027',
      },
    ]);
  });

  it('a retried read stores each suggestion once and counts none over the cap', async () => {
    const locationId = await newLocation();
    const store = createAgentSuggestionStore(server.connection);
    // Nine open suggestions from another file: the read's one makes ten.
    for (let day = 0; day < 9; day += 1) {
      const startDate = `2026-0${String(7 + Math.floor(day / 3))}-1${String(day % 3)}`;
      await store.insertOne(team.scope, {
        id: new Types.ObjectId().toHexString(), locationId, week: TODAY, source: 'file', fileId: new Types.ObjectId().toHexString(),
        text: `Closed ${startDate}`, schedule: { ...CLOSED, weekdays: null, startDate, endDate: startDate }, closureKey: `closed|w=*|${startDate}..${startDate}`,
        now: server.clock.now(),
      });
    }
    const fileId = await seedStored(locationId);
    answers = [answer({ closedPatterns: [MONDAYS] })];
    failRawWrites = 1;
    await readAs(team.member, locationId, fileId);
    expect(await outcomeOf(fileId)).toEqual({});
    await runReader();
    const outcome = await outcomeOf(fileId);
    expect(outcome).toMatchObject({ rulesSkipped: { duplicate: 0, cap: 0, invalid: 0 } });
    expect(outcome.rulesSuggested).toHaveLength(1);
    expect(await count('tw_agent_suggestions', { locationId: oid(locationId), fileId: oid(fileId) })).toBe(1);
  });

  it('acting on an answer and a plan saved before the change makes no suggestion and fails nothing', async () => {
    const locationId = await newLocation();
    const fileId = await seedStored(locationId);
    const noteId = new Types.ObjectId().toHexString();
    const longClosure = { title: 'Renovation', startDate: '2026-07-01', endDate: '2026-08-29', kind: 'closure', effect: 'closed', expectedGuests: null, detail: '' };
    await server.connection.collection('tw_files').updateOne({ _id: oid(fileId) }, { $set: { ai: {
      status: 'queued', requestedBy: team.member.userId, requestedByRole: 'member', requestedByStaff: false, requestedGrantId: null,
      requestedAt: server.clock.now(), attempts: 1, leaseUntil: null, notBefore: null, startedAt: null, finishedAt: null, reason: null,
      partial: false, costMicroUsd: 1000,
      result: {
        kind: 'calendar', confidence: 'high', summary: 'Old answer.', facts: [], events: [longClosure], days: [], daysCut: false,
        eventCount: 1, dayCount: 0, daysBorneOut: [],
      },
      actions: {
        plan: { noteIds: [noteId], uploadId: new Types.ObjectId().toHexString(), itemId: new Types.ObjectId().toHexString(), calibrationId: new Types.ObjectId().toHexString() },
        outcome: null,
      },
    } } });
    await runReader();
    const doc = await server.connection.collection('tw_files').findOne({ _id: oid(fileId) });
    expect(doc?.ai).toMatchObject({ status: 'done' });
    expect(await outcomeOf(fileId)).toMatchObject({ rulesSuggested: [], notesSkipped: { guard: 1 } });
    expect(await count('tw_agent_suggestions', { locationId: oid(locationId) })).toBe(0);
  });

  it('a closure over 14 days the guard refuses becomes a dated suggestion; a buyout, the 31-day overflow and a past one stay guard', async () => {
    const closed = (title: string, startDate: string, endDate: string, kind = 'closure') => (
      { title, startDate, endDate, kind, effect: 'closed', expectedGuests: null, detail: '' }
    );
    const { locationId, fileId } = await readWith({ events: [
      closed('Summer renovation', '2026-07-01', '2026-08-29'),
      closed('Private buyout', '2026-09-01', '2026-09-20', 'private_event'),
      closed('Old renovation', '2026-01-05', '2026-02-28'),
      closed('Break one', '2026-10-01', '2026-10-10'),
      closed('Break two', '2026-10-12', '2026-10-21'),
      closed('Break three', '2026-11-02', '2026-11-11'),
      closed('Break four', '2026-12-01', '2026-12-05'),
    ] });
    const outcome = await outcomeOf(fileId);
    const plan = ((await server.connection.collection('tw_files').findOne({ _id: oid(fileId) }))?.ai as { actions: { plan: { noteIds: string[] } } }).actions.plan;
    expect(outcome).toMatchObject({ rulesSuggested: [plan.noteIds[0]], notesSkipped: { guard: 3 } });
    expect(await count('tw_notes', { locationId: oid(locationId) })).toBe(3);
    const { suggested } = await rulesPage(locationId);
    expect(suggested).toEqual([expect.objectContaining({
      id: plan.noteIds[0], text: 'Closed Jul 1 to Aug 29, 2026', schedule: { ...CLOSED, weekdays: null, startDate: '2026-07-01', endDate: '2026-08-29' },
    })]);
    expect((await itemOf(team.member, locationId, fileId)).ai?.notesSkipped).toMatchObject({ guard: 3 });
  });

  it('stores at most 5 a read, and none past 10 open file suggestions at the location', async () => {
    const five = await readWith({ closedPatterns: [0, 1, 2, 3, 4, 5].map((day) => ({ ...MONDAYS, weekdays: [day] })) });
    expect((await rulesPage(five.locationId)).suggested).toHaveLength(5);
    // Two more reads of five each at one location: the second stops at ten.
    const locationId = await newLocation();
    const first = await seedStored(locationId);
    answers = [answer({ closedPatterns: [0, 1, 2, 3, 4].map((day) => ({ ...MONDAYS, weekdays: [day] })) })];
    await readAs(team.member, locationId, first);
    const second = await seedStored(locationId);
    const seasons = ['01', '02', '03', '04', '05', '06'].map((month) => ({ weekdays: null, startDate: `2027-${month}-01`, endDate: `2027-${month}-10`, yearly: false }));
    answers = [answer({ closedPatterns: seasons })];
    await readAs(team.member, locationId, second);
    expect(await outcomeOf(second)).toMatchObject({ rulesSkipped: { duplicate: 0, cap: 0, invalid: 0 } });
    expect((await outcomeOf(second)).rulesSuggested).toHaveLength(5);
    const third = await seedStored(locationId);
    answers = [answer({ closedPatterns: [{ weekdays: null, startDate: '2027-08-01', endDate: '2027-08-10', yearly: false }] })];
    await readAs(team.member, locationId, third);
    expect(await outcomeOf(third)).toMatchObject({ rulesSuggested: [], rulesSkipped: { duplicate: 0, cap: 1, invalid: 0 } });
    expect((await rulesPage(locationId)).suggested).toHaveLength(10);
  });
});

// ---- Deciding -------------------------------------------------------------------------------------------------------

describe('confirm, edit and dismiss', () => {
  let held: Hold[] = [];
  afterEach(async () => {
    for (const hold of held) hold.restore();
    held = [];
    await removeStaffFactor(server);
    await server.connection.collection('tw_view_as_grants').deleteMany({});
  });

  async function oneSuggestion(patterns: unknown[] = [MONDAYS]): Promise<{ locationId: string; fileId: string; id: string }> {
    const { locationId, fileId } = await readWith({ closedPatterns: patterns });
    const [first] = (await rulesPage(locationId)).suggested;
    return { locationId, fileId, id: first?.id ?? '' };
  }

  it('Confirm saves the rule as the member, added by TownwiseAI under the suggestion’s id; recorded once with its source', async () => {
    const { locationId, id } = await oneSuggestion();
    const results = await Promise.all([decide(team.member, locationId, id, 'accept'), decide(team.member, locationId, id, 'accept')]);
    for (const res of results) expect(res.status).toBe(200);
    const [first] = results;
    expect(await first.json()).toMatchObject({
      suggestion: { id, status: 'accepted' },
      rule: { id, text: 'Closed on Mondays', addedVia: 'townwise_ai', schedule: { ...CLOSED, weekdays: [1], startDate: TODAY, endDate: null } },
    });
    const page = await rulesPage(locationId);
    expect(page.suggested).toEqual([]);
    expect(page.rules.map((rule) => rule.id)).toEqual([id]);
    expect(await server.connection.collection('tw_business_rules').findOne({ _id: oid(id) })).toMatchObject({ createdBy: team.member.userId });
    expect((await eventsOf('agent.suggestion_accepted')).filter((event) => (event.details as { suggestionId: string }).suggestionId === id).map((event) => event.details))
      .toEqual([{ locationId, suggestionId: id, type: 'rule', source: 'file', edited: false }]);
    expect((await eventsOf('rule.created')).filter((event) => (event.target as { id: string }).id === id).map((event) => event.details))
      .toEqual([{ locationId, via: 'townwise_ai', scheduled: true }]);
    expect(logLines(server).filter((line) => line.msg === 'townwise.agent_suggestion').at(-1))
      .toMatchObject({ locationId, suggestionId: id, decision: 'accepted', source: 'file', edited: false });
  });

  it('Edit saves the edited rule, and the event says it was edited', async () => {
    const { locationId, id } = await oneSuggestion();
    const schedule = { ...CLOSED, weekdays: [1], startDate: '2026-11-02', endDate: null, season: { repeat: 'yearly', from: '11-01', to: '03-31' } };
    const res = await decide(team.colleague, locationId, id, 'accept', { rule: { text: 'Closed Mondays in winter', schedule } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ suggestion: { id, status: 'accepted' }, rule: { id, text: 'Closed Mondays in winter', schedule } });
    expect((await eventsOf('agent.suggestion_accepted')).filter((event) => (event.details as { suggestionId: string }).suggestionId === id).map((event) => event.details))
      .toEqual([{ locationId, suggestionId: id, type: 'rule', source: 'file', edited: true }]);
    // The same edit again answers what was saved; another one is already decided.
    expect((await decide(team.colleague, locationId, id, 'accept', { rule: { text: 'Closed Mondays in winter', schedule } })).status).toBe(200);
    const other = await decide(team.member, locationId, id, 'accept');
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: 'already_decided', rule: { id, text: 'Closed Mondays in winter' } });
  });

  it('an Edit of 200 four-byte characters passes the route’s 2 KB', async () => {
    const { locationId, id } = await oneSuggestion();
    const text = '🍕'.repeat(200);
    const res = await decide(team.member, locationId, id, 'accept', { rule: { text, schedule: { ...CLOSED, weekdays: [1], startDate: TODAY, endDate: null } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rule: { text } });
  });

  it('refuses a bad Edit (400) and leaves the suggestion open', async () => {
    const { locationId, id } = await oneSuggestion();
    for (const body of [{ rule: { text: '' } }, { rule: { text: 'Shut', schedule: { ...CLOSED, startDate: '2030-01-01' } } }, { note: 'x' }, { rule: { text: 'Shut', extra: 1 } }]) {
      expect(await errorOf(await decide(team.member, locationId, id, 'accept', body))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await errorOf(await decide(team.member, locationId, id, 'dismiss', { reason: 'no' }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await suggestionDoc(id)).toMatchObject({ status: 'open' });
  });

  it('Confirm racing Edit leaves one rule, as confirmed, and the Edit answers 409 already_decided; edited follows the stored rule', async () => {
    const { locationId, id } = await oneSuggestion();
    const marks = holdCalls(server, 'updateOne', 'TwAgentSuggestion');
    held.push(marks);
    const confirm = decide(team.member, locationId, id, 'accept');
    await marks.arrived(1);
    const edit = await decide(team.colleague, locationId, id, 'accept', { rule: { text: 'Closed Mondays all year', schedule: null } });
    expect(edit.status).toBe(409);
    expect(await edit.json()).toMatchObject({ error: 'already_decided', rule: { id, text: 'Closed on Mondays' } });
    marks.open();
    expect((await confirm).status).toBe(200);
    expect(await count('tw_business_rules', { locationId: oid(locationId) })).toBe(1);
    expect((await eventsOf('agent.suggestion_accepted')).filter((event) => (event.details as { suggestionId: string }).suggestionId === id).map((event) => event.details))
      .toEqual([{ locationId, suggestionId: id, type: 'rule', source: 'file', edited: false }]);
  });

  it('a Dismiss whose compare-and-set lands after a racing Confirm wrote its rule answers the end state, accepted (code review N3)', async () => {
    const { locationId, id } = await oneSuggestion();
    const marks = holdCalls(server, 'updateOne', 'TwAgentSuggestion');
    held.push(marks);
    const dismiss = decide(team.colleague, locationId, id, 'dismiss');
    await marks.arrived(1);
    const confirm = decide(team.member, locationId, id, 'accept');
    await marks.arrived(2);
    // The dismiss lands first, then finishes the accept the confirm's rule stands for; the confirm's own mark comes last.
    marks.release(1);
    marks.release(3);
    const dismissed = await dismiss;
    expect(await dismissed.json()).toMatchObject({ suggestion: { id, status: 'accepted' }, rule: { id, text: 'Closed on Mondays' } });
    marks.open();
    expect((await confirm).status).toBe(200);
    expect(await suggestionDoc(id)).toMatchObject({ status: 'accepted' });
    expect((await eventsOf('agent.suggestion_accepted')).filter((event) => (event.details as { suggestionId: string }).suggestionId === id)).toHaveLength(1);
  });

  it('Dismiss records it once, writes no rule, is remembered, and the same closure is not suggested again', async () => {
    const { locationId, id } = await oneSuggestion();
    const res = await decide(team.member, locationId, id, 'dismiss');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: { id, status: 'dismissed' }, rule: null });
    expect((await decide(team.member, locationId, id, 'dismiss')).status).toBe(200);
    expect(await errorOf(await decide(team.member, locationId, id, 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect((await rulesPage(locationId)).suggested).toEqual([]);
    expect(await count('tw_business_rules', { locationId: oid(locationId) })).toBe(0);
    expect((await eventsOf('agent.suggestion_dismissed')).filter((event) => (event.details as { suggestionId: string }).suggestionId === id).map((event) => event.details))
      .toEqual([{ locationId, suggestionId: id, type: 'rule', source: 'file' }]);
    const again = await seedStored(locationId);
    answers = [answer({ closedPatterns: [MONDAYS] })];
    await readAs(team.member, locationId, again);
    expect(await outcomeOf(again)).toMatchObject({ rulesSuggested: [], rulesSkipped: { duplicate: 1, cap: 0, invalid: 0 } });
    expect((await rulesPage(locationId)).suggested).toEqual([]);
  });

  it('a rule with a schedule already closing Mondays, or with the words, makes none; one with the words and no schedule answers 409 rule_exists', async () => {
    const locationId = await newLocation();
    expect((await call(server, `/api/org/locations/${locationId}/rules`, { session: team.member, json: { text: 'Closed on Mondays' } })).status).toBe(201);
    const fileId = await seedStored(locationId);
    answers = [answer({ closedPatterns: [MONDAYS] })];
    await readAs(team.member, locationId, fileId);
    const [suggestion] = (await rulesPage(locationId)).suggested;
    expect(suggestion?.text).toBe('Closed on Mondays');
    expect(await errorOf(await decide(team.member, locationId, suggestion?.id ?? '', 'accept'))).toEqual({ status: 409, error: 'rule_exists' });
    expect(await suggestionDoc(suggestion?.id ?? '')).toMatchObject({ status: 'open' });
    // A closure rule already on Mondays: nothing to suggest.
    const ruled = await newLocation();
    expect((await call(server, `/api/org/locations/${ruled}/rules`, {
      session: team.member, json: { text: 'Shut Mondays', schedule: { ...CLOSED, weekdays: [1], startDate: '2026-01-05', endDate: null } },
    })).status).toBe(201);
    const second = await seedStored(ruled);
    answers = [answer({ closedPatterns: [MONDAYS] })];
    await readAs(team.member, ruled, second);
    expect(await outcomeOf(second)).toMatchObject({ rulesSuggested: [], rulesSkipped: { duplicate: 1, cap: 0, invalid: 0 } });
  });

  it('409 rule_limit at 30 rules leaves the suggestion open; pending ones do not count', async () => {
    const { locationId, id } = await oneSuggestion();
    await server.connection.collection('tw_business_rules').insertMany(Array.from({ length: 30 }, (_, index) => ({
      orgId: oid(team.orgId), locationId: oid(locationId), text: `Filler ${String(index)}`, key: `filler ${String(index)}`, addedVia: 'page',
      createdBy: 'fixture', createdAt: server.clock.now(), updatedAt: server.clock.now(),
    })));
    expect(await errorOf(await decide(team.member, locationId, id, 'accept'))).toEqual({ status: 409, error: 'rule_limit' });
    expect(await suggestionDoc(id)).toMatchObject({ status: 'open' });
  });

  it('a yearly suggestion confirms into a yearly rule', async () => {
    const { locationId, id } = await oneSuggestion([{ weekdays: null, startDate: '2027-01-01', endDate: '2027-03-31', yearly: true }]);
    const res = await decide(team.member, locationId, id, 'accept');
    expect(await res.json()).toMatchObject({
      rule: {
        text: 'Closed Jan 1 to Mar 31 every year', scheduleSummary: 'Closed Jan 1 to Mar 31 every year, from Jun 1, 2026',
        schedule: { season: { repeat: 'yearly', from: '01-01', to: '03-31' }, endDate: null },
      },
    });
  });

  it('a weekly suggestion is 404 on the new routes, and a file suggestion 404 on the weekly ones, writing nothing', async () => {
    const { locationId, id } = await oneSuggestion();
    const weekly: NewSuggestion = {
      content: { type: 'rule', text: 'Closed on Thanksgiving', schedule: { ...CLOSED, weekdays: null, startDate: '2026-11-26', endDate: '2026-11-26' } },
      why: 'Thanksgiving is Thu, Nov 26.', calendarIds: [],
    };
    const [stored] = await createAgentSuggestionStore(server.connection).insert(team.scope, { locationId, week: TODAY, suggestions: [weekly], now: server.clock.now() });
    const weeklyId = stored?.id ?? '';
    for (const action of ['accept', 'dismiss'] as const) {
      expect(await errorOf(await decide(team.member, locationId, weeklyId, action))).toEqual({ status: 404, error: 'not_found' });
      expect(await errorOf(await decide(team.admin, locationId, weeklyId, action))).toEqual({ status: 404, error: 'not_found' });
      expect(await errorOf(await weeklyDecide(team.admin, locationId, id, action))).toEqual({ status: 404, error: 'not_found' });
    }
    expect(await suggestionDoc(weeklyId)).toMatchObject({ status: 'open' });
    expect(await suggestionDoc(id)).toMatchObject({ status: 'open' });
    expect(await count('tw_business_rules', { locationId: oid(locationId) })).toBe(0);
    // A member's dismiss of a weekly row whose rule an admin's accept already wrote is refused by the weekly route, writing nothing.
    await server.ctx.stores.businessRules.create(team.scope, locationId, {
      id: weeklyId, text: 'Closed on Thanksgiving', schedule: null, addedVia: 'townwise_ai', createdBy: team.admin.userId, now: server.clock.now(),
    });
    expect(await errorOf(await weeklyDecide(team.member, locationId, weeklyId, 'dismiss'))).toEqual({ status: 403, error: 'forbidden' });
    expect(await suggestionDoc(weeklyId)).toMatchObject({ status: 'open' });
  });

  it('view-as is refused (403 view_as_read_only) and sees the cards it cannot decide, with no file name', async () => {
    const { locationId, id } = await oneSuggestion();
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: team.member.userId, orgId: team.orgId });
    expect(await errorOf(await decide(staff, locationId, id, 'accept'))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect(await errorOf(await decide(staff, locationId, id, 'dismiss'))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect((await rulesPage(locationId, staff)).suggested).toEqual([expect.objectContaining({ id, canDecide: false, file: expect.objectContaining({ title: null }) as unknown })]);
    expect(await suggestionDoc(id)).toMatchObject({ status: 'open' });
  });

  it('staff open as admin confirm as the organization’s admin, audited as staff', async () => {
    const { locationId, id } = await oneSuggestion();
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: team.orgId });
    expect((await decide(staff, locationId, id, 'accept')).status).toBe(200);
    expect(await server.connection.collection('tw_business_rules').findOne({ _id: oid(id) })).toMatchObject({ byStaff: true });
    expect((await eventsOf('agent.suggestion_accepted')).filter((event) => (event.details as { suggestionId: string }).suggestionId === id))
      .toEqual([expect.objectContaining({ actorRole: 'superadmin' })]);
  });

  it('another organization’s suggestion, or one on another location, answers 404 as an unknown id does', async () => {
    const { locationId, id } = await oneSuggestion();
    const other = await newTeam();
    const theirs = await newLocation(other);
    const sibling = await newLocation();
    expect(await errorOf(await decide(other.member, theirs, id, 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await decide(team.member, sibling, id, 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await decide(team.member, locationId, new Types.ObjectId().toHexString(), 'dismiss'))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await decide(team.member, locationId, 'not-an-id', 'dismiss'))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await suggestionDoc(id)).toMatchObject({ status: 'open' });
  });

  it('logs and audit events carry no rule words, file name or the rule’s dates', async () => {
    server.logs.length = 0;
    const { locationId, id } = await oneSuggestion([{ weekdays: [3], startDate: '2027-01-04', endDate: '2027-03-31', yearly: false }]);
    expect((await decide(team.member, locationId, id, 'accept', {
      rule: { text: `${SENTINEL} Wednesdays`, schedule: { ...CLOSED, weekdays: [3], startDate: '2027-01-04', endDate: '2027-03-31' } },
    })).status).toBe(200);
    const events = JSON.stringify((await auditEvents(server)).filter((event) => String(event.orgId) === team.orgId));
    expect(events).not.toMatch(new RegExp(`${SENTINEL}|Wednesdays|2027-01-04|2027-03-31|Closed`));
    expect(server.logs.join('\n')).not.toMatch(new RegExp(`${SENTINEL}|Wednesdays|2027-01-04|2027-03-31|Closed on`));
  });
});

// ---- Undo -----------------------------------------------------------------------------------------------------------

describe('undoing a read', () => {
  function undo(session: TestSession, locationId: string, fileId: string): Promise<Response> {
    return call(server, `${itemPath(locationId, fileId)}/ai`, { session, method: 'DELETE' });
  }

  it('removes the suggestions still waiting and keeps a confirmed rule with its accepted suggestion', async () => {
    const { locationId, fileId } = await readWith({ closedPatterns: [MONDAYS, TUESDAYS] });
    const [mondays, tuesdays] = (await rulesPage(locationId)).suggested;
    expect((await decide(team.member, locationId, mondays?.id ?? '', 'accept')).status).toBe(200);
    expect((await itemOf(team.member, locationId, fileId)).ai).toMatchObject({ rulesSuggested: 2, rulesWaiting: 1 });
    expect((await undo(team.member, locationId, fileId)).status).toBe(200);
    expect(await suggestionDoc(tuesdays?.id ?? '')).toBeNull();
    expect(await suggestionDoc(mondays?.id ?? '')).toMatchObject({ status: 'accepted' });
    expect((await rulesPage(locationId)).rules.map((rule) => rule.id)).toEqual([mondays?.id]);
    expect((await eventsOf('file.ai_undone')).at(-1)?.details).toMatchObject({ locationId, suggestions: 1 });
  });

  it('a read that made only suggestions can be undone', async () => {
    const { locationId, fileId } = await readWith({ summary: '', closedPatterns: [MONDAYS] });
    expect((await itemOf(team.member, locationId, fileId)).ai).toMatchObject({ canUndo: true });
    expect((await undo(team.member, locationId, fileId)).status).toBe(200);
    expect(await count('tw_agent_suggestions', { locationId: oid(locationId) })).toBe(0);
  });

  it('finishes as accepted a suggestion whose rule a confirm wrote before undo ran, and keeps the rule', async () => {
    const { locationId, fileId } = await readWith({ closedPatterns: [MONDAYS] });
    const [suggestion] = (await rulesPage(locationId)).suggested;
    const id = suggestion?.id ?? '';
    // What a confirm leaves when undo runs between its rule and its compare-and-set.
    await server.ctx.stores.businessRules.create(team.scope, locationId, {
      id, text: 'Closed on Mondays', schedule: suggestion?.schedule ?? null, addedVia: 'townwise_ai', createdBy: team.member.userId, now: server.clock.now(),
    });
    expect((await undo(team.admin, locationId, fileId)).status).toBe(200);
    expect(await suggestionDoc(id)).toMatchObject({ status: 'accepted' });
    expect(await count('tw_business_rules', { _id: oid(id) })).toBe(1);
    expect((await eventsOf('file.ai_undone')).at(-1)?.details).toMatchObject({ suggestions: 0 });
    expect((await eventsOf('agent.suggestion_accepted')).filter((event) => (event.details as { suggestionId: string }).suggestionId === id))
      .toEqual([expect.objectContaining({ details: { locationId, suggestionId: id, type: 'rule', source: 'file', edited: false } })]);
  });

  it('a deleted file’s suggestion stays, and its card says so', async () => {
    const { locationId, fileId } = await readWith({ closedPatterns: [MONDAYS] });
    await server.connection.collection('tw_files').deleteOne({ _id: oid(fileId) });
    expect((await rulesPage(locationId)).suggested).toEqual([expect.objectContaining({ source: 'file', file: null })]);
  });
});

// ---- The sales history ----------------------------------------------------------------------------------------------

describe('the sales history', () => {
  const DAY_MS = 86_400_000;
  const plus = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

  /** Sales every day from 2026-03-02 (a Monday) to 2026-05-31, but on Mondays from `closedFrom` on. */
  async function history(locationId: string, closedFrom = '2026-03-16', t = team): Promise<void> {
    const rows: Record<string, unknown>[] = [];
    for (let day = '2026-03-02'; day <= '2026-05-31'; day = plus(day, 1)) {
      if (new Date(`${day}T00:00:00.000Z`).getUTCDay() === 1 && day >= closedFrom) continue;
      rows.push({
        orgId: oid(t.orgId), locationId: oid(locationId), date: day, guests: 80, netSalesCents: 200_000, uploadId: new Types.ObjectId(),
        updatedAt: server.clock.now(),
      });
    }
    await server.connection.collection('tw_sales_days').insertMany(rows);
  }

  it('lists a closed weekday as sales_weekday_1, starting after its last Monday with sales, with its counts; GET writes nothing; no weekday question', async () => {
    const locationId = await newLocation();
    await history(locationId);
    const before = await count('tw_agent_suggestions', { locationId: oid(locationId) });
    const { suggested } = await rulesPage(locationId);
    expect(suggested).toEqual([{
      id: 'sales_weekday_1', source: 'sales', text: 'Closed on Mondays',
      schedule: { ...CLOSED, weekdays: [1], startDate: '2026-03-10', endDate: null },
      scheduleSummary: 'Closed on Mondays from Mar 10, 2026', file: null,
      evidence: { noSalesCount: 11, weekdayCount: 13, lastSalesDate: '2026-03-09' }, canDecide: true,
    }]);
    const agent = await panel(locationId);
    expect(agent.ruleSuggestions).toEqual(suggested);
    expect(agent.questions.some((question) => question.kind === 'weekday')).toBe(false);
    expect(await count('tw_agent_suggestions', { locationId: oid(locationId) })).toBe(before);
  });

  it('two tabs confirming sales_weekday_1 make one row and one rule, recorded once; the card then lists nothing', async () => {
    const locationId = await newLocation();
    await history(locationId);
    const [a, b] = await Promise.all([decide(team.member, locationId, 'sales_weekday_1', 'accept'), decide(team.colleague, locationId, 'sales_weekday_1', 'accept')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = await server.connection.collection('tw_agent_suggestions').find({ locationId: oid(locationId) }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'sales', status: 'accepted', closureKey: 'closed|w=1|ongoing', evidence: { noSalesCount: 11, weekdayCount: 13, lastSalesDate: '2026-03-09' },
    });
    const id = rows[0]?._id.toHexString() ?? '';
    expect(await a.json()).toMatchObject({ suggestion: { id, status: 'accepted' }, rule: { id, text: 'Closed on Mondays', schedule: { startDate: '2026-03-10' } } });
    expect(await count('tw_business_rules', { locationId: oid(locationId) })).toBe(1);
    expect((await eventsOf('agent.suggestion_accepted')).filter((event) => (event.details as { suggestionId: string }).suggestionId === id).map((event) => event.details))
      .toEqual([{ locationId, suggestionId: id, type: 'rule', source: 'sales', edited: false }]);
    expect((await rulesPage(locationId)).suggested).toEqual([]);
  });

  it('a stale sales id answers 404 and writes nothing; an open answer to the weekday question suppresses it', async () => {
    const locationId = await newLocation();
    await history(locationId, '2026-05-25');
    expect(await errorOf(await decide(team.member, locationId, 'sales_weekday_1', 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await decide(team.member, locationId, 'sales_weekday_2', 'dismiss'))).toEqual({ status: 404, error: 'not_found' });
    expect(await count('tw_agent_suggestions', { locationId: oid(locationId) })).toBe(0);
    const answered = await newLocation();
    await history(answered);
    await server.connection.collection('tw_agent_answers').insertOne({
      orgId: oid(team.orgId), locationId: oid(answered), questionId: 'weekday_1_2026-03-02_2026-05-17', answer: 'open', noteId: new Types.ObjectId(),
      status: 'done', createdAt: server.clock.now(), updatedAt: server.clock.now(),
    });
    expect((await rulesPage(answered)).suggested).toEqual([]);
    expect(await errorOf(await decide(team.member, answered, 'sales_weekday_1', 'accept'))).toEqual({ status: 404, error: 'not_found' });
  });

  it('a file row and a sales decide with one key make one row: the file suggestion is listed and decided', async () => {
    const { locationId, fileId } = await readWith({ closedPatterns: [MONDAYS] });
    await history(locationId);
    const { suggested } = await rulesPage(locationId);
    expect(suggested).toEqual([expect.objectContaining({ source: 'file', file: expect.objectContaining({ ref: `f_${fileId}` }) as unknown })]);
    const res = await decide(team.member, locationId, 'sales_weekday_1', 'dismiss');
    expect(await res.json()).toEqual({ suggestion: { id: suggested[0]?.id, status: 'dismissed' }, rule: null });
    expect(await count('tw_agent_suggestions', { locationId: oid(locationId) })).toBe(1);
    // Dismissed is remembered: the sales history never suggests Mondays again.
    expect((await rulesPage(locationId)).suggested).toEqual([]);
  });

  it('deleting the sales data deletes its sales suggestions not accepted, so a new history can suggest again', async () => {
    const dismissed = await newLocation();
    await history(dismissed);
    expect((await decide(team.member, dismissed, 'sales_weekday_1', 'dismiss')).status).toBe(200);
    const accepted = await newLocation();
    await history(accepted);
    expect((await decide(team.member, accepted, 'sales_weekday_1', 'accept')).status).toBe(200);
    for (const locationId of [dismissed, accepted]) {
      expect((await call(server, `/api/org/locations/${locationId}/sales`, { method: 'DELETE', session: team.admin })).status).toBe(200);
    }
    expect(await count('tw_agent_suggestions', { locationId: oid(dismissed) })).toBe(0);
    expect(await count('tw_agent_suggestions', { locationId: oid(accepted), status: 'accepted' })).toBe(1);
    await history(dismissed);
    expect((await rulesPage(dismissed)).suggested.map((each) => each.id)).toEqual(['sales_weekday_1']);
  });

  it('sales_weekday_1 on another organization’s location answers 404 as an unknown location does', async () => {
    const other = await newTeam();
    const theirs = await newLocation(other);
    await history(theirs, '2026-03-16', other);
    expect(await errorOf(await decide(team.member, theirs, 'sales_weekday_1', 'accept'))).toEqual({ status: 404, error: 'not_found' });
    expect(await count('tw_agent_suggestions', { locationId: oid(theirs) })).toBe(0);
  });
});
