// TownwiseAI's side panel (spec 10.12, docs/portal/tuning-chat.md section 8): the questions with their evidence and the
// activity, read from the location's own records; an answer recorded once however often or from however many tabs it is
// sent, finished after a crash, `closed` saving one closure note and `open` on a likely-closed day one open-day note
// through the notes rules, `other` saving nothing and never taking the person's words, read-only under view-as, and
// logged with ids and the answer only. Synthetic days only.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg } from '../src/access/policy.ts';
import type { AgentPanel, AnswerResult } from '../src/handlers/agent.ts';
import { createAgentAnswerStore } from '../src/stores/agent-answers.ts';
import { addGrant, addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, logLines, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let orgId: string;
let member: TestSession;
let colleague: TestSession;

const DAY_MS = 24 * 60 * 60 * 1000;
// Sunday 2026-03-01 to Sunday 2026-05-31, thirteen Mondays; the test clock reads 2026-06-01.
const FROM = '2026-03-01';
const TO = '2026-05-31';
const WEEKDAY_ID = `weekday_1_${FROM}_${TO}`;
const GAP_ID = 'gap_2026-05-12_2026-05-13';
const LIKELY_ID = 'likely_closed_2026-05-23';
/**
 * D46: Mondays with no sales are no longer asked about; the sales history suggests the standing rule instead, from the
 * first day with sales (the location never had a Monday with sales).
 */
const SALES_MONDAY = {
  id: 'sales_weekday_1', source: 'sales', text: 'Closed on Mondays',
  schedule: { kind: 'closure', startDate: FROM, endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
  scheduleSummary: 'Closed on Mondays from Mar 1, 2026', file: null, evidence: { noSalesCount: 13, weekdayCount: 13, lastSalesDate: null }, canDecide: true,
};
const GAP = { id: GAP_ID, kind: 'gap', from: '2026-05-12', to: '2026-05-13', dayCount: 2, typicalGuestsLow: 100, typicalGuestsHigh: 100 };
const LIKELY = { id: LIKELY_ID, kind: 'likely_closed', date: '2026-05-23', guests: 1, typicalGuests: 100 };
/** The note "Yes, it was just slow" saves on LIKELY_ID. */
const OPEN_DAY = {
  kind: 'other', startDate: '2026-05-23', endDate: '2026-05-23', weekdays: null, effect: 'fewer_guests', expectedGuests: null,
  detail: 'Open, with very few guests (your answer to TownwiseAI).', startTime: null, endTime: null,
};
const LIKELY_CLOSURE = {
  kind: 'closure', startDate: '2026-05-23', endDate: '2026-05-23', weekdays: null, effect: 'closed', expectedGuests: null,
  detail: null, startTime: null, endTime: null,
};

function plus(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isMonday(day: string): boolean {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay() === 1;
}

async function person(): Promise<TestSession> {
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email });
  return session;
}

/**
 * A new location whose days run FROM to TO with 100 guests a day and no sales on Mondays and on Tuesday 2026-05-12 and
 * Wednesday 2026-05-13: it is asked GAP_ID, and suggested SALES_MONDAY. With `nearEmpty`, Saturday 2026-05-23 has 1 guest, and it
 * is asked LIKELY_ID too. `netSalesCents` is every row's net sales (none unless given).
 */
async function askedLocation(opts: { nearEmpty?: boolean; netSalesCents?: number } = {}): Promise<string> {
  const locationId = await addLocation(server, { orgId, name: `Counter ${randomUUID().slice(0, 8)}` });
  const rows = [];
  for (let date = FROM; date <= TO; date = plus(date, 1)) {
    if (isMonday(date) || date === '2026-05-12' || date === '2026-05-13') continue;
    rows.push({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), date,
      guests: opts.nearEmpty === true && date === '2026-05-23' ? 1 : 100, netSalesCents: opts.netSalesCents ?? null,
      uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
    });
  }
  await server.connection.collection('tw_sales_days').insertMany(rows);
  return locationId;
}

/** D31: a rule's schedule, closed on 2026-05-12 to 2026-05-13 unless `over` says otherwise. */
function ruleSchedule(over: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'closure', startDate: '2026-05-12', endDate: '2026-05-13', weekdays: null, effect: 'closed', expectedGuests: null,
    startTime: null, endTime: null, ...over,
  };
}

/** D31: one business rule at the location per schedule given (null: a rule with no schedule), each text a sentinel. */
async function addRules(locationId: string, schedules: readonly (Record<string, unknown> | null)[]): Promise<void> {
  await server.connection.collection('tw_business_rules').insertMany(schedules.map((schedule, i) => ({
    orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), text: `Sentinel-rule-text ${i}`,
    key: `sentinel-rule-text ${i}`, addedVia: 'page', createdBy: member.userId, createdAt: server.clock.now(),
    updatedAt: server.clock.now(), ...(schedule === null ? {} : { schedule }),
  })));
}

/** A member's panel at a location with no weekly suggestions (openspec change weekly-forecast-suggestions) and no suggested rules (D46). */
const NO_SUGGESTIONS = {
  suggestions: [], weeklySuggestions: { on: true, available: false, canChange: false, calendarTitles: true }, ruleSuggestions: [],
};

async function panel(locationId: string, session = member): Promise<{ status: number; body: AgentPanel }> {
  const res = await call(server, `/api/org/locations/${locationId}/agent`, { session });
  return { status: res.status, body: await res.json() as AgentPanel };
}

async function answer(locationId: string, questionId: string, json: unknown, session = member) {
  const res = await call(server, `/api/org/locations/${locationId}/agent/questions/${questionId}`, { session, json });
  return { status: res.status, body: await res.json() as AnswerResult & { error?: string } };
}

function notesOf(locationId: string): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_notes').find({ locationId: new Types.ObjectId(locationId) }).toArray();
}

function answerRows(locationId: string): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_agent_answers').find({ locationId: new Types.ObjectId(locationId) }).toArray();
}

/**
 * A claim that stopped before `done`, as a try that failed after it leaves it; with its note written, or not. The
 * question is GAP_ID with its closure note unless `opts` names another.
 */
async function stoppedClaim(locationId: string, answer: string, written: boolean, opts: {
  questionId?: string; note?: Record<string, unknown>;
} = {}): Promise<Types.ObjectId> {
  const noteId = new Types.ObjectId();
  const at = server.clock.now();
  await server.connection.collection('tw_agent_answers').insertOne({
    orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), questionId: opts.questionId ?? GAP_ID, answer,
    noteId, status: 'saving', createdAt: at, updatedAt: at,
  });
  if (written) {
    await server.connection.collection('tw_notes').insertOne({
      _id: noteId, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId),
      ...(opts.note ?? {
        kind: 'closure', startDate: '2026-05-12', endDate: '2026-05-13', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
      }),
      createdBy: member.userId, createdAt: at, updatedAt: at,
    });
  }
  return noteId;
}

/** Every document of every tw_ collection, as text. */
async function everyTownwiseDocument(): Promise<string> {
  const db = server.connection.db;
  if (db === undefined) throw new Error('not connected');
  const names = (await db.listCollections().toArray()).map((c) => c.name).filter((name) => name.startsWith('tw_'));
  const docs = await Promise.all(names.map((name) => db.collection(name).find({}).toArray()));
  return JSON.stringify(docs);
}

/**
 * F3: a stored file of the location, `status` as given, with `result` (what its read added) when it was read. Its
 * name is a sentinel, so a test can show that no file name reaches the panel.
 */
async function storedFile(locationId: string, opts: {
  id?: Types.ObjectId; status: string; readStartedAt: Date | null; readMs: number | null; result: Record<string, unknown> | null;
  uploadId: Types.ObjectId | null;
}): Promise<string> {
  const _id = opts.id ?? new Types.ObjectId();
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), importId: new Types.ObjectId(), purpose: 'history',
    uploadedBy: member.userId, uploaderRole: 'member', uploadedAt: new Date('2026-06-01T08:00:00.000Z'), name: 'Sentinel-file-name.csv',
    kind: 'text', sizeBytes: 3, fingerprint: null, status: opts.status, outcome: null, upload: null, progress: null,
    readStartedAt: opts.readStartedAt, readMs: opts.readMs, answers: {}, uploadId: opts.uploadId, result: opts.result, report: null,
    cleanBytes: null, rawDeletedAt: null, attempts: 1,
  });
  return _id.toHexString();
}

async function eventsAt(locationId: string, action: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((e) => e.action === action && (e.details as { locationId?: string }).locationId === locationId);
}

beforeAll(async () => {
  server = await startTownwiseServer();
  orgId = await createOrg(server, { name: 'Question Diner' });
  member = await person();
  colleague = await person();
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

describe('GET /api/org/locations/:locationId/agent', () => {
  it('asks about the gap with no sales, suggests closed Mondays as a rule (D46), and lists only applied uploads', async () => {
    const locationId = await askedLocation();
    const at = server.clock.now();
    await server.connection.collection('tw_uploads').insertMany(['applied', 'applying'].map((status) => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), uploadedBy: member.userId, uploadedAt: at,
      status, dayCount: 78, inserted: 78, replaced: 0, kept: 0, firstDate: FROM, lastDate: TO, hasGuests: true, hasNetSales: false,
    })));
    expect(await panel(locationId)).toEqual({
      status: 200,
      body: {
        questions: [GAP],
        activity: [{ at: at.toISOString(), kind: 'upload_applied', firstDate: FROM, lastDate: TO, dayCount: 78 }],
        ...NO_SUGGESTIONS, ruleSuggestions: [SALES_MONDAY],
      },
    });
  });

  it('asks about a usually busy day with almost no guests, and the gap (newest first)', async () => {
    const locationId = await askedLocation({ nearEmpty: true });
    expect(await panel(locationId)).toEqual({
      status: 200, body: { questions: [LIKELY, GAP], activity: [], ...NO_SUGGESTIONS, ruleSuggestions: [SALES_MONDAY] },
    });
  });

  it('reads the 56 days before the window for typical guests, and never asks about a day before it', async () => {
    // Coverage from 2025-04-01 to 2026-05-31: the window starts on Sunday 2025-06-01, and Monday 2025-06-02 follows 8
    // Mondays before it. Monday 2025-05-26, before the window, has no sales too.
    const locationId = await addLocation(server, { orgId, name: `Long Counter ${randomUUID().slice(0, 8)}` });
    const rows = [];
    for (let date = '2025-04-01'; date <= TO; date = plus(date, 1)) {
      if (date === '2025-05-26' || date === '2025-06-02') continue;
      rows.push({
        orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), date, guests: 100, netSalesCents: null,
        uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
      });
    }
    await server.connection.collection('tw_sales_days').insertMany(rows);
    expect((await panel(locationId)).body.questions).toEqual([{
      id: 'gap_2025-06-02_2025-06-02', kind: 'gap', from: '2025-06-02', to: '2025-06-02', dayCount: 1, typicalGuestsLow: 100, typicalGuestsHigh: 100,
    }]);
  });

  it('a business rule’s closure schedule explains the days with no sales it covers; one with more guests does not (D31)', async () => {
    const locationId = await askedLocation({ nearEmpty: true });
    await addRules(locationId, [ruleSchedule({})]);
    const { body } = await panel(locationId);
    expect(body.questions).toEqual([LIKELY]);
    expect(JSON.stringify(body)).not.toContain('Sentinel-rule-text');
    // More guests on 2026-05-12 to 2026-05-13: days with no sales under it are more suspicious, not less.
    const busy = await askedLocation({ nearEmpty: true });
    await addRules(busy, [ruleSchedule({ kind: 'other', effect: 'more_guests' })]);
    expect((await panel(busy)).body.questions).toEqual([LIKELY, GAP]);
  });

  it('a business rule’s schedule with fewer guests says a likely-closed day was open; a rule with no schedule changes nothing (D31)', async () => {
    const slow = await askedLocation({ nearEmpty: true });
    await addRules(slow, [ruleSchedule({ kind: 'other', effect: 'fewer_guests', startDate: '2026-05-23', endDate: '2026-05-23' })]);
    expect((await panel(slow)).body.questions).toEqual([GAP]);
    const plain = await askedLocation({ nearEmpty: true });
    await addRules(plain, [null]);
    expect((await panel(plain)).body.questions).toEqual([LIKELY, GAP]);
  });

  it('carries guest counts and never net sales', async () => {
    const locationId = await askedLocation({ nearEmpty: true, netSalesCents: 987_654 });
    const { status, body } = await panel(locationId);
    expect({ status, questions: body.questions }).toEqual({ status: 200, questions: [LIKELY, GAP] });
    expect(JSON.stringify(body)).not.toContain('987654');
    expect(JSON.stringify(body)).not.toContain('netSales');
  });

  it('asks nothing and lists nothing for a location with no records', async () => {
    const locationId = await addLocation(server, { orgId, name: 'Empty Room' });
    expect(await panel(locationId)).toEqual({ status: 200, body: { questions: [], activity: [], ...NO_SUGGESTIONS } });
  });
});

describe('answering closed', () => {
  it('on a gap saves one closure note over it, records the answer and the note once, and the question is gone', async () => {
    const locationId = await askedLocation();
    const { status, body } = await answer(locationId, GAP_ID, { answer: 'closed' });
    expect(status).toBe(200);
    const closure = {
      kind: 'closure', startDate: '2026-05-12', endDate: '2026-05-13', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
    };
    expect(body.question).toEqual({ id: GAP_ID, answer: 'closed' });
    expect(body.note).toMatchObject({ ...closure, canEdit: true });
    const notes = await notesOf(locationId);
    expect(notes).toEqual([expect.objectContaining({ ...closure, createdBy: member.userId })]);
    expect((notes[0]?._id as Types.ObjectId).toHexString()).toBe(body.note?.id);
    expect((await eventsAt(locationId, 'agent.question_answered')).map((e) => e.details))
      .toEqual([{ locationId, questionId: GAP_ID, answer: 'closed' }]);
    expect(await eventsAt(locationId, 'note.created')).toHaveLength(1);

    const after = await panel(locationId);
    expect(after.body.questions.map((q) => q.id)).toEqual([]);
    expect(after.body.activity).toEqual([{
      at: server.clock.now().toISOString(), kind: 'note_saved', via: 'question', noteId: body.note?.id,
      noteKind: 'closure', startDate: '2026-05-12', endDate: '2026-05-13',
    }]);
  });

  it('on a weekday is 404 and writes nothing: the weekday question is no longer asked (D46)', async () => {
    const locationId = await askedLocation();
    expect(await answer(locationId, WEEKDAY_ID, { answer: 'closed' })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await notesOf(locationId)).toHaveLength(0);
    expect(await answerRows(locationId)).toHaveLength(0);
  });

  it('again, or from three tabs at once, answers the same one note; a different later answer does not change it', async () => {
    const locationId = await askedLocation();
    const results = await Promise.all([1, 2, 3].map(() => answer(locationId, GAP_ID, { answer: 'closed' })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map((r) => r.body.note?.id)).size).toBe(1);
    expect(await notesOf(locationId)).toHaveLength(1);
    expect(await eventsAt(locationId, 'agent.question_answered')).toHaveLength(1);
    expect(await eventsAt(locationId, 'note.created')).toHaveLength(1);

    const later = await answer(locationId, GAP_ID, { answer: 'open' }, colleague);
    expect(later).toMatchObject({ status: 200, body: { question: { id: GAP_ID, answer: 'closed' }, note: { id: results[0]?.body.note?.id } } });
    expect(await answerRows(locationId)).toEqual([expect.objectContaining({ questionId: GAP_ID, answer: 'closed', status: 'done' })]);
  });

  it('after an answer that stopped after its claim finishes it with the claimed note id: its note written, or not', async () => {
    for (const written of [true, false]) {
      const locationId = await askedLocation();
      const noteId = await stoppedClaim(locationId, 'closed', written);
      // With its note written the gap is explained and no longer asked, and the answer still finishes.
      expect((await panel(locationId)).body.questions.map((q) => q.id)).toEqual(written ? [] : [GAP_ID]);
      const { status, body } = await answer(locationId, GAP_ID, { answer: 'closed' });
      expect({ written, status, noteId: body.note?.id }).toEqual({ written, status: 200, noteId: noteId.toHexString() });
      expect(await notesOf(locationId)).toHaveLength(1);
      expect(await eventsAt(locationId, 'note.created')).toHaveLength(written ? 0 : 1);
      expect(await eventsAt(locationId, 'agent.question_answered')).toHaveLength(1);
      expect(await answerRows(locationId)).toEqual([expect.objectContaining({ status: 'done', noteId })]);
    }
  });

  it('after a closed answer that stopped with its note written, a different answer finishes it as closed', async () => {
    for (const next of ['open', 'not_sure', 'other']) {
      const locationId = await askedLocation();
      const noteId = await stoppedClaim(locationId, 'closed', true);
      const { status, body } = await answer(locationId, GAP_ID, { answer: next }, colleague);
      expect({ next, status, answer: body.question.answer, noteId: body.note?.id })
        .toEqual({ next, status: 200, answer: 'closed', noteId: noteId.toHexString() });
      expect(await answerRows(locationId)).toEqual([expect.objectContaining({ answer: 'closed', status: 'done', noteId })]);
      expect((await eventsAt(locationId, 'agent.question_answered')).map((e) => e.details))
        .toEqual([{ locationId, questionId: GAP_ID, answer: 'closed' }]);
      expect(await notesOf(locationId)).toHaveLength(1);
      expect((await panel(locationId)).body.activity).toEqual([expect.objectContaining({ kind: 'note_saved', via: 'question' })]);
    }
  });

  it('a stopped claim without its note is not finished once its days are no longer asked about', async () => {
    for (const stopped of ['closed', 'open']) {
      const locationId = await askedLocation();
      await stoppedClaim(locationId, stopped, false);
      // The gap's days gain sales, so a stale panel's answer names a question no longer asked.
      await server.connection.collection('tw_sales_days').insertMany(['2026-05-12', '2026-05-13'].map((date) => ({
        orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), date, guests: 10, netSalesCents: null,
        uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
      })));
      expect((await panel(locationId)).body.questions.map((q) => q.id)).toEqual([]);
      expect({ stopped, ...(await answer(locationId, GAP_ID, { answer: 'closed' })) })
        .toMatchObject({ stopped, status: 404, body: { error: 'not_found' } });
      expect(await notesOf(locationId)).toHaveLength(0);
      expect(await eventsAt(locationId, 'agent.question_answered')).toHaveLength(0);
    }
  });

  it('two members answering differently at once end with a row, audit events and notes that agree', async () => {
    for (let round = 0; round < 6; round += 1) {
      const locationId = await askedLocation();
      const [first, second] = round % 2 === 0 ? [member, colleague] : [colleague, member];
      const results = await Promise.all([
        answer(locationId, GAP_ID, { answer: 'closed' }, first), answer(locationId, GAP_ID, { answer: 'open' }, second),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const rows = await answerRows(locationId);
      expect(rows).toEqual([expect.objectContaining({ status: 'done' })]);
      const stored = rows[0]?.answer;
      // One event for the stored answer; two only when `closed`, its note written, overruled an `open` finished in the
      // same moment. The two can share a time, so their order says nothing.
      const recorded = (await eventsAt(locationId, 'agent.question_answered'))
        .map((e) => (e.details as { answer?: string }).answer).sort();
      if (recorded.length === 1) expect(recorded).toEqual([stored]);
      else expect({ stored, recorded }).toEqual({ stored: 'closed', recorded: ['closed', 'open'] });
      const notes = await notesOf(locationId);
      expect(notes.map((n) => (n._id as Types.ObjectId).toHexString()))
        .toEqual(stored === 'closed' ? [(rows[0]?.noteId as Types.ObjectId).toHexString()] : []);
      expect((await answer(locationId, GAP_ID, { answer: 'not_sure' })).body.question.answer).toBe(stored);
    }
  });

  it('marking done: a different answer that took the row loses it, and an answer whose note is written overrules it', async () => {
    // The orders the handler cannot pin over HTTP: a claim, another tab's different claim, then each one's markDone.
    const staff = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
    const scope = scopeForNewOrg(staff, orgId);
    const store = createAgentAnswerStore(server.connection);
    const now = server.clock.now();
    // [first claim, second claim, first's markDone, second's markDone, the answer stored]; on a gap only `closed` writes
    // a note.
    const orders = [
      ['open', 'not_sure', false, true, 'not_sure'],
      ['closed', 'open', true, false, 'closed'],
      ['open', 'closed', false, true, 'closed'],
    ] as const;
    for (const [first, second, firstDone, secondDone, stored] of orders) {
      const key = { locationId: await askedLocation(), questionId: GAP_ID };
      const claimed = await store.claim(scope, key, { answer: first, now });
      expect(await store.claim(scope, key, { answer: second, now })).toMatchObject({ answer: second, noteId: claimed?.noteId });
      const done = [
        await store.markDone(scope, key, { answer: first, now, noteWritten: first === 'closed' }),
        await store.markDone(scope, key, { answer: second, now, noteWritten: second === 'closed' }),
      ];
      expect({ first, second, done, row: await store.find(scope, key) })
        .toMatchObject({ first, second, done: [firstDone, secondDone], row: { answer: stored, status: 'done' } });
    }
    // An answer whose note is written also takes back a row a different answer finished first: `closed` on a gap, and
    // `open` on a likely-closed day.
    for (const [questionId, noted, other] of [[GAP_ID, 'closed', 'open'], [LIKELY_ID, 'open', 'not_sure']] as const) {
      const key = { locationId: await askedLocation({ nearEmpty: true }), questionId };
      await store.claim(scope, key, { answer: noted, now });
      await store.claim(scope, key, { answer: other, now });
      expect(await store.markDone(scope, key, { answer: other, now, noteWritten: false })).toBe(true);
      expect(await store.markDone(scope, key, { answer: noted, now, noteWritten: true })).toBe(true);
      expect(await store.markDone(scope, key, { answer: noted, now, noteWritten: true })).toBe(false);
      expect({ questionId, row: await store.find(scope, key) }).toMatchObject({ questionId, row: { answer: noted, status: 'done' } });
    }
  });

  it('at a location with 1,000 notes is 409 note_limit; the question stays, and another answer then works', async () => {
    const locationId = await askedLocation();
    const at = server.clock.now();
    await server.connection.collection('tw_notes').insertMany(Array.from({ length: 1000 }, () => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), kind: 'opening', startDate: '2026-01-01',
      endDate: '2026-01-01', weekdays: null, effect: 'unknown', expectedGuests: null, detail: null, createdBy: 'fixture',
      createdAt: at, updatedAt: at,
    })));
    expect(await answer(locationId, GAP_ID, { answer: 'closed' })).toMatchObject({ status: 409, body: { error: 'note_limit' } });
    expect(await notesOf(locationId)).toHaveLength(1000);
    expect((await panel(locationId)).body.questions.map((q) => q.id)).toEqual([GAP_ID]);
    expect(await answer(locationId, GAP_ID, { answer: 'open' })).toMatchObject({
      status: 200, body: { question: { id: GAP_ID, answer: 'open' }, note: null },
    });
    expect(await eventsAt(locationId, 'agent.question_answered')).toHaveLength(1);
  });
});

describe('answering open or not sure', () => {
  it('saves no note, asks about those days no more, and shows in the activity', async () => {
    const locationId = await askedLocation({ nearEmpty: true });
    expect(await answer(locationId, GAP_ID, { answer: 'open' })).toEqual({ status: 200, body: { question: { id: GAP_ID, answer: 'open' }, note: null } });
    server.clock.advance(60_000);
    expect(await answer(locationId, LIKELY_ID, { answer: 'not_sure' })).toMatchObject({ status: 200, body: { note: null } });
    expect(await notesOf(locationId)).toHaveLength(0);
    const { body } = await panel(locationId);
    expect(body.questions).toEqual([]);
    expect(body.activity).toEqual([
      { at: server.clock.now().toISOString(), kind: 'question_answered', questionId: LIKELY_ID, answer: 'not_sure' },
      { at: new Date(server.clock.now().getTime() - 60_000).toISOString(), kind: 'question_answered', questionId: GAP_ID, answer: 'open' },
    ]);
  });
});

describe('answering a likely-closed day', () => {
  it('open (it was just slow) saves the open-day note once, records it, and the question is gone', async () => {
    const locationId = await askedLocation({ nearEmpty: true });
    const { status, body } = await answer(locationId, LIKELY_ID, { answer: 'open' });
    expect(status).toBe(200);
    expect(body).toEqual({
      question: { id: LIKELY_ID, answer: 'open' },
      note: {
        ...OPEN_DAY, id: expect.any(String) as string, createdByEmail: expect.any(String) as string,
        createdAt: server.clock.now().toISOString(), updatedAt: server.clock.now().toISOString(), canEdit: true, source: null, fromEvent: null,
      },
    });
    const notes = await notesOf(locationId);
    expect(notes).toEqual([expect.objectContaining({ ...OPEN_DAY, createdBy: member.userId })]);
    expect((notes[0]?._id as Types.ObjectId).toHexString()).toBe(body.note?.id);
    expect(await eventsAt(locationId, 'note.created')).toHaveLength(1);
    expect((await eventsAt(locationId, 'agent.question_answered')).map((e) => e.details))
      .toEqual([{ locationId, questionId: LIKELY_ID, answer: 'open' }]);

    const after = await panel(locationId);
    expect(after.body.questions).toEqual([GAP]);
    expect(after.body.activity).toEqual([{
      at: server.clock.now().toISOString(), kind: 'note_saved', via: 'question', noteId: body.note?.id,
      noteKind: 'other', startDate: '2026-05-23', endDate: '2026-05-23',
    }]);
  });

  it('closed saves one closure note for that day', async () => {
    const locationId = await askedLocation({ nearEmpty: true });
    const { status, body } = await answer(locationId, LIKELY_ID, { answer: 'closed' });
    expect({ status, answer: body.question.answer }).toEqual({ status: 200, answer: 'closed' });
    expect(body.note).toMatchObject(LIKELY_CLOSURE);
    expect(await notesOf(locationId)).toEqual([expect.objectContaining(LIKELY_CLOSURE)]);
    expect((await panel(locationId)).body.questions).toEqual([GAP]);
  });

  it('closed and open at once end with one note, and a row and a last audit event that agree with it', async () => {
    for (let round = 0; round < 6; round += 1) {
      const locationId = await askedLocation({ nearEmpty: true });
      const [first, second] = round % 2 === 0 ? [member, colleague] : [colleague, member];
      const results = await Promise.all([
        answer(locationId, LIKELY_ID, { answer: 'closed' }, first), answer(locationId, LIKELY_ID, { answer: 'open' }, second),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const rows = await answerRows(locationId);
      expect(rows).toEqual([expect.objectContaining({ status: 'done' })]);
      const stored = rows[0]?.answer;
      const notes = await notesOf(locationId);
      expect(notes).toEqual([expect.objectContaining(stored === 'closed' ? LIKELY_CLOSURE : OPEN_DAY)]);
      expect((notes[0]?._id as Types.ObjectId).toHexString()).toBe((rows[0]?.noteId as Types.ObjectId).toHexString());
      expect(results.map((r) => r.body.question.answer)).toEqual([stored, stored]);
      const events = await eventsAt(locationId, 'agent.question_answered');
      expect((events.at(-1)?.details as { answer?: string }).answer).toBe(stored);
      expect(await eventsAt(locationId, 'note.created')).toHaveLength(1);
      expect((await answer(locationId, LIKELY_ID, { answer: 'not_sure' })).body.question.answer).toBe(stored);
    }
  });

  it('a stopped open claim whose open-day note is written is finished as open by any later answer', async () => {
    for (const next of ['not_sure', 'closed', 'other']) {
      const locationId = await askedLocation({ nearEmpty: true });
      const noteId = await stoppedClaim(locationId, 'open', true, { questionId: LIKELY_ID, note: OPEN_DAY });
      // The note explains the day, so it is no longer asked, and the answer still finishes.
      expect((await panel(locationId)).body.questions).toEqual([GAP]);
      const { status, body } = await answer(locationId, LIKELY_ID, { answer: next }, colleague);
      expect({ next, status, answer: body.question.answer, noteId: body.note?.id })
        .toEqual({ next, status: 200, answer: 'open', noteId: noteId.toHexString() });
      expect(await answerRows(locationId)).toEqual([expect.objectContaining({ answer: 'open', status: 'done', noteId })]);
      expect((await eventsAt(locationId, 'agent.question_answered')).map((e) => e.details))
        .toEqual([{ locationId, questionId: LIKELY_ID, answer: 'open' }]);
      expect(await notesOf(locationId)).toHaveLength(1);
      expect(await eventsAt(locationId, 'note.created')).toHaveLength(0);
    }
  });
});

describe('answering something else', () => {
  it('saves nothing but the answer, stops the question, and is recorded with ids and the answer only', async () => {
    const locationId = await askedLocation();
    server.logs.length = 0;
    expect(await answer(locationId, GAP_ID, { answer: 'other' }))
      .toEqual({ status: 200, body: { question: { id: GAP_ID, answer: 'other' }, note: null } });
    expect(await notesOf(locationId)).toHaveLength(0);
    const rows = await answerRows(locationId);
    expect(rows).toEqual([expect.objectContaining({ questionId: GAP_ID, answer: 'other', status: 'done' })]);
    expect(Object.keys(rows[0] ?? {}).sort())
      .toEqual(['_id', 'answer', 'createdAt', 'locationId', 'noteId', 'orgId', 'questionId', 'status', 'updatedAt']);
    expect((await eventsAt(locationId, 'agent.question_answered')).map((e) => e.details))
      .toEqual([{ locationId, questionId: GAP_ID, answer: 'other' }]);
    const lines = logLines(server).filter((line) => line.msg === 'townwise.agent_answer');
    expect(lines).toEqual([expect.objectContaining({ orgId, locationId, answer: 'other' })]);
    expect(Object.keys(lines[0] ?? {})).not.toContain('questionId');

    const { body } = await panel(locationId);
    expect(body.questions).toEqual([]);
    expect(body.activity).toEqual([{ at: server.clock.now().toISOString(), kind: 'question_answered', questionId: GAP_ID, answer: 'other' }]);
  });

  it('works at a location with 1,000 notes, as it saves none', async () => {
    const locationId = await askedLocation({ nearEmpty: true });
    const at = server.clock.now();
    await server.connection.collection('tw_notes').insertMany(Array.from({ length: 1000 }, () => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), kind: 'opening', startDate: '2026-01-01',
      endDate: '2026-01-01', weekdays: null, effect: 'unknown', expectedGuests: null, detail: null, createdBy: 'fixture',
      createdAt: at, updatedAt: at,
    })));
    expect(await answer(locationId, LIKELY_ID, { answer: 'open' })).toMatchObject({ status: 409, body: { error: 'note_limit' } });
    expect(await answer(locationId, LIKELY_ID, { answer: 'other' }))
      .toEqual({ status: 200, body: { question: { id: LIKELY_ID, answer: 'other' }, note: null } });
    expect(await notesOf(locationId)).toHaveLength(1000);
  });

  it('never takes the person’s words: any other key is 400, a body over 1 KB is 413, and nothing is written or logged', async () => {
    const locationId = await askedLocation();
    server.logs.length = 0;
    const words = 'Sentinel-typed-text';
    for (const json of [
      { answer: 'other', text: words }, { answer: 'other', message: words }, { answer: 'closed', detail: words },
      { answer: 'other', note: { kind: 'other', detail: words } },
    ]) {
      expect({ json, ...(await answer(locationId, GAP_ID, json)) }).toMatchObject({ json, status: 400, body: { error: 'invalid_request' } });
    }
    const big = await call(server, `/api/org/locations/${locationId}/agent/questions/${GAP_ID}`, {
      session: member, rawBody: JSON.stringify({ answer: 'other', text: `${words} ${'x'.repeat(2048)}` }),
    });
    expect({ status: big.status, body: await big.json() as unknown }).toMatchObject({ status: 413, body: { error: 'payload_too_large' } });
    // An id carrying text is not an id.
    for (const questionId of ['other_hello', 'likely_closed_soon']) {
      expect({ questionId, ...(await answer(locationId, questionId, { answer: 'other' })) })
        .toMatchObject({ questionId, status: 400, body: { error: 'invalid_request' } });
    }
    expect(await answerRows(locationId)).toHaveLength(0);
    expect(await notesOf(locationId)).toHaveLength(0);
    expect(server.logs.join('\n')).not.toContain(words);
    expect(JSON.stringify(await auditEvents(server))).not.toContain(words);
    expect(await everyTownwiseDocument()).not.toContain(words);
  });

  it('a member of another organization gets 404 and writes nothing, in either organization', async () => {
    const locationId = await askedLocation({ nearEmpty: true });
    const otherOrg = await createOrg(server, { name: `Other Diner ${randomUUID().slice(0, 6)}` });
    const email = `outsider-${randomUUID().slice(0, 8)}@example.test`;
    const outsider = await signIn(server, email);
    await addSeat(server, { orgId: otherOrg, userId: outsider.userId, email });
    for (const [questionId, json] of [[GAP_ID, { answer: 'other' }], [LIKELY_ID, { answer: 'open' }]] as const) {
      expect({ questionId, ...(await answer(locationId, questionId, json, outsider)) })
        .toMatchObject({ questionId, status: 404, body: { error: 'not_found' } });
    }
    expect((await panel(locationId, outsider)).status).toBe(404);
    /** Answers and notes matching `filter`. */
    const written = (filter: Record<string, Types.ObjectId>) => Promise.all(['tw_agent_answers', 'tw_notes'].map((name) =>
      server.connection.collection(name).countDocuments(filter)));
    expect(await written({ locationId: new Types.ObjectId(locationId) })).toEqual([0, 0]);
    expect(await written({ orgId: new Types.ObjectId(otherOrg) })).toEqual([0, 0]);
    expect((await panel(locationId)).body.questions).toEqual([LIKELY, GAP]);
  });
});

describe('what an answer may name', () => {
  it('a question not asked now is 404; a malformed id or body is 400; nothing is written', async () => {
    const locationId = await askedLocation();
    for (const questionId of [
      'gap_2026-04-01_2026-04-02', 'gap_2026-02-30_2026-03-01', `weekday_2_${FROM}_${TO}`, 'likely_closed_2026-05-24', LIKELY_ID,
    ]) {
      expect(await answer(locationId, questionId, { answer: 'closed' })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
    expect(await answer(locationId, 'gap_soon', { answer: 'closed' })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    for (const json of [{}, { answer: 'maybe' }, { answer: ['closed'] }, { answer: 'other', extra: 1 }]) {
      expect(await answer(locationId, GAP_ID, json)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await answer(new Types.ObjectId().toHexString(), GAP_ID, { answer: 'closed' })).toMatchObject({ status: 404 });
    expect(await answerRows(locationId)).toHaveLength(0);
    expect(await notesOf(locationId)).toHaveLength(0);
  });

  it('staff in view-as read the panel and are refused an answer with 403 view_as_read_only', async () => {
    const locationId = await askedLocation();
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: member.userId, orgId });
      // The same panel, but the suggested rules are not theirs to decide (D46).
      const own = await panel(locationId);
      expect(await panel(locationId, staff)).toEqual({
        ...own, body: { ...own.body, ruleSuggestions: own.body.ruleSuggestions.map((each) => ({ ...each, canDecide: false })) },
      });
      for (const json of [{ answer: 'closed' }, { answer: 'other' }]) {
        expect({ json, ...(await answer(locationId, GAP_ID, json, staff)) })
          .toMatchObject({ json, status: 403, body: { error: 'view_as_read_only' } });
      }
      expect(await answerRows(locationId)).toHaveLength(0);
      expect(await notesOf(locationId)).toHaveLength(0);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });
});

describe('activity', () => {
  it('merges uploads, the caller’s own saved proposals and answers newest first, leaving out a note deleted since', async () => {
    const locationId = await askedLocation();
    const location = new Types.ObjectId(locationId);
    const t0 = server.clock.now();
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    await server.connection.collection('tw_uploads').insertOne({
      orgId: new Types.ObjectId(orgId), locationId: location, uploadedBy: member.userId, uploadedAt: at(1), status: 'applied',
      dayCount: 7, inserted: 7, replaced: 0, kept: 0, firstDate: '2026-05-25', lastDate: '2026-05-31', hasGuests: true, hasNetSales: false,
    });
    // A saved proposal each for the member (at 2) and their colleague (at 3), with the notes they saved.
    const saved = async (session: TestSession, minutes: number, day: string): Promise<string> => {
      const noteId = new Types.ObjectId();
      await server.connection.collection('tw_notes').insertOne({
        _id: noteId, orgId: new Types.ObjectId(orgId), locationId: location, kind: 'private_event', startDate: day, endDate: day,
        weekdays: null, effect: 'more_guests', expectedGuests: 40, detail: 'Sentinel-activity-detail', createdBy: session.userId,
        createdAt: at(minutes), updatedAt: at(minutes),
      });
      await server.connection.collection('tw_chat_proposals').insertOne({
        orgId: new Types.ObjectId(orgId), locationId: location, conversationId: new Types.ObjectId(), userId: session.userId,
        proposalId: 'toolu_proposal0001', status: 'saved', noteId, edited: false, createdAt: at(minutes), updatedAt: at(minutes),
      });
      return noteId.toHexString();
    };
    const mine = await saved(member, 2, '2026-06-20');
    const theirs = await saved(colleague, 3, '2026-06-27');
    server.clock.advance(4 * 60_000);
    expect((await answer(locationId, GAP_ID, { answer: 'open' })).status).toBe(200);

    const upload = { at: at(1).toISOString(), kind: 'upload_applied', firstDate: '2026-05-25', lastDate: '2026-05-31', dayCount: 7 };
    const note = (noteId: string, minutes: number, day: string) => ({
      at: at(minutes).toISOString(), kind: 'note_saved', via: 'chat', noteId, noteKind: 'private_event', startDate: day, endDate: day,
    });
    const answered = { at: at(4).toISOString(), kind: 'question_answered', questionId: GAP_ID, answer: 'open' };
    expect((await panel(locationId)).body.activity).toEqual([answered, note(mine, 2, '2026-06-20'), upload]);
    expect((await panel(locationId, colleague)).body.activity).toEqual([answered, note(theirs, 3, '2026-06-27'), upload]);
    expect(JSON.stringify((await panel(locationId)).body)).not.toContain('Sentinel-activity-detail');

    expect((await call(server, `/api/org/locations/${locationId}/notes/${mine}`, { method: 'DELETE', session: member })).status).toBe(204);
    expect((await panel(locationId)).body.activity).toEqual([answered, upload]);
  });

  it('F3: shows a stored file Townwise read once, as the file and not its upload, with no name; files not read show nothing', async () => {
    const locationId = await askedLocation();
    const location = new Types.ObjectId(locationId);
    const t0 = server.clock.now();
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    // The read wrote this upload record, as the reader does; a browser upload has no file.
    const fromFile = new Types.ObjectId();
    await server.connection.collection('tw_uploads').insertMany([
      {
        _id: fromFile, orgId: new Types.ObjectId(orgId), locationId: location, uploadedBy: member.userId, uploadedAt: at(2),
        status: 'applied', dayCount: 7, inserted: 7, replaced: 0, kept: 0, firstDate: '2026-05-25', lastDate: '2026-05-31',
        hasGuests: true, hasNetSales: false,
      },
      {
        orgId: new Types.ObjectId(orgId), locationId: location, uploadedBy: member.userId, uploadedAt: at(1), status: 'applied',
        dayCount: 3, inserted: 3, replaced: 0, kept: 0, firstDate: '2026-05-01', lastDate: '2026-05-03', hasGuests: true, hasNetSales: false,
      },
    ]);
    const result = {
      dayCount: 7, firstDate: '2026-05-25', lastDate: '2026-05-31', guestsDayCount: 7, netSalesDayCount: 0, inserted: 7, replaced: 0,
      kept: 0, closedDates: [], missingDays: 0, uploadId: fromFile.toHexString(),
    };
    const read = await storedFile(locationId, { status: 'read', readStartedAt: at(2), readMs: 90_000, result, uploadId: fromFile });
    await storedFile(locationId, { status: 'failed', readStartedAt: at(3), readMs: 1_000, result: null, uploadId: null });
    await storedFile(locationId, { status: 'queued', readStartedAt: null, readMs: null, result: null, uploadId: null });

    const expected = [
      { at: new Date(at(2).getTime() + 90_000).toISOString(), kind: 'file_processed', fileId: read, firstDate: '2026-05-25', lastDate: '2026-05-31', dayCount: 7 },
      { at: at(1).toISOString(), kind: 'upload_applied', firstDate: '2026-05-01', lastDate: '2026-05-03', dayCount: 3 },
    ];
    const mine = await panel(locationId);
    expect(mine.body.activity).toEqual(expected);
    expect(JSON.stringify(mine.body)).not.toContain('Sentinel-file-name');
    expect(JSON.stringify(mine.body)).not.toContain(fromFile.toHexString());

    // Staff in view-as read the same items: no file name, as the files list shows them none.
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: member.userId, orgId });
      const viewed = await panel(locationId, staff);
      expect(viewed.body.activity).toEqual(expected);
      expect(JSON.stringify(viewed.body)).not.toContain('Sentinel-file-name');
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });
});

describe('logs', () => {
  it('log the answer with ids only', async () => {
    const locationId = await askedLocation();
    server.logs.length = 0;
    await answer(locationId, GAP_ID, { answer: 'closed' });
    const lines = logLines(server).filter((line) => line.msg === 'townwise.agent_answer');
    expect(lines).toEqual([expect.objectContaining({ orgId, locationId, answer: 'closed' })]);
    expect(Object.keys(lines[0] ?? {})).not.toContain('questionId');
  });
});

// The client reads these answers through its own schemas (client/src/chat/api.ts). Both sides test the one fixture,
// fixtures/agent-panel.json, and its client copy, client/test/chat/agent-panel.json, so a change to either side's shape
// fails a test until both and the fixture agree.
describe('the answers the client reads (fixtures/agent-panel.json)', () => {
  const FIXTURE = new URL('fixtures/agent-panel.json', import.meta.url);
  const CLIENT_COPY = new URL('../../client/test/chat/agent-panel.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    panel: AgentPanel;
    answer: { questionId: string; body: unknown; response: AnswerResult };
  };

  it('are the client’s: the fixture and its client copy are identical', () => {
    expect(readFileSync(CLIENT_COPY, 'utf8')).toBe(readFileSync(FIXTURE, 'utf8'));
  });

  it('GET answers every question kind and activity kind exactly as the fixture holds them, and POST answers as it does', async () => {
    const locationId = await askedLocation({ nearEmpty: true });
    const org = new Types.ObjectId(orgId);
    const location = new Types.ObjectId(locationId);
    const noteId = new Types.ObjectId('0000000000000000000000a1');
    // Records dated before the window, so they change no question; their times are fixed so the items are literal.
    await server.connection.collection('tw_uploads').insertOne({
      orgId: org, locationId: location, uploadedBy: member.userId, uploadedAt: new Date('2026-06-01T09:00:00.000Z'),
      status: 'applied', dayCount: 78, inserted: 78, replaced: 0, kept: 0, firstDate: FROM, lastDate: TO, hasGuests: true, hasNetSales: false,
    });
    await server.connection.collection('tw_agent_answers').insertMany([
      {
        orgId: org, locationId: location, questionId: 'gap_2026-02-03_2026-02-04', answer: 'not_sure', noteId: new Types.ObjectId(),
        status: 'done', createdAt: new Date('2026-06-01T10:00:00.000Z'), updatedAt: new Date('2026-06-01T10:00:00.000Z'),
      },
      {
        orgId: org, locationId: location, questionId: 'gap_2026-02-10_2026-02-11', answer: 'closed', noteId,
        status: 'done', createdAt: new Date('2026-06-01T11:00:00.000Z'), updatedAt: new Date('2026-06-01T11:00:00.000Z'),
      },
      {
        orgId: org, locationId: location, questionId: 'gap_2026-01-20_2026-01-21', answer: 'other', noteId: new Types.ObjectId(),
        status: 'done', createdAt: new Date('2026-06-01T07:00:00.000Z'), updatedAt: new Date('2026-06-01T07:00:00.000Z'),
      },
    ]);
    await server.connection.collection('tw_notes').insertOne({
      _id: noteId, orgId: org, locationId: location, kind: 'closure', startDate: '2026-02-10', endDate: '2026-02-11', weekdays: null,
      effect: 'closed', expectedGuests: null, detail: null, createdBy: member.userId,
      createdAt: new Date('2026-06-01T11:00:00.000Z'), updatedAt: new Date('2026-06-01T11:00:00.000Z'),
    });
    // F3: a stored file read from 08:29 for a minute.
    await storedFile(locationId, {
      id: new Types.ObjectId('0000000000000000000000f1'), status: 'read', readStartedAt: new Date('2026-06-01T08:29:00.000Z'),
      readMs: 60_000, uploadId: null,
      result: {
        dayCount: 7, firstDate: '2026-01-05', lastDate: '2026-01-11', guestsDayCount: 7, netSalesDayCount: 0, inserted: 7, replaced: 0,
        kept: 0, closedDates: [], missingDays: 0, uploadId: '0000000000000000000000b1',
      },
    });

    // Two weekly suggestions a pass stored, a rule and a note (openspec change weekly-forecast-suggestions).
    const suggestion = (id: string, over: Record<string, unknown>) => ({
      _id: new Types.ObjectId(id), orgId: org, locationId: location, week: '2026-06-01', calendarIds: [], status: 'open', decidedBy: null,
      decidedAt: null, createdAt: new Date('2026-06-01T06:00:00.000Z'), updatedAt: new Date('2026-06-01T06:00:00.000Z'), ...over,
    });
    await server.connection.collection('tw_agent_suggestions').insertMany([
      suggestion('0000000000000000000000c1', {
        type: 'note', text: null, why: 'Independence Day is Sat, Jul 4, and you were closed on it last year.', calendarIds: ['us:independence-day:2026'],
        content: { kind: 'closure', startDate: '2026-07-04', endDate: '2026-07-04', weekdays: null, effect: 'closed', expectedGuests: null, detail: null, startTime: null, endTime: null },
      }),
      suggestion('0000000000000000000000c2', {
        type: 'rule', text: 'Private party after Commencement', why: 'Commencement is Sun, Jun 14, and you booked a party after it last year.',
        calendarIds: ['hanover-nh:2026-06-14:commencement'],
        content: {
          kind: 'private_event', startDate: '2026-06-14', endDate: '2026-06-14', weekdays: null, effect: 'more_guests', expectedGuests: 40, detail: null,
          startTime: '18:00', endTime: '22:00',
        },
      }),
    ]);

    // The owner-calendar kinds (openspec change calendar-event-suggestions): a spotted event on a link calendar, and a
    // move and a removal of two notes linked to it. Their words are written at read time from the live event row and
    // the notes, so the calendar, its event and the notes are stored too.
    const calendarId = new Types.ObjectId('0000000000000000000000d1');
    const at = new Date('2026-06-01T06:00:00.000Z');
    await server.connection.collection('tw_calendar_sources').insertOne({
      _id: calendarId, orgId: org, locationId: location, slot: 0, kind: 'link', label: 'Front desk bookings', sealedAddress: 'sealed-for-test',
      host: 'calendar.example.test', googleConnectionId: null, generation: 1, reservedGeneration: 1, eventCount: 1, skippedRepeating: 0,
      status: 'ok', lastSuccessAt: at, lastAttemptAt: at, nextRefreshAt: null, leaseUntil: null, consecutiveFailures: 0,
      lastManualRefreshAt: null, createdBy: member.userId, createdAt: at,
    });
    const ON_11 = { startDate: '2026-07-11', endDate: '2026-07-11', startTime: '18:00', endTime: '22:00' };
    const ON_18 = { startDate: '2026-07-18', endDate: '2026-07-18', startTime: '18:00', endTime: '22:00' };
    const ON_25 = { startDate: '2026-07-25', endDate: '2026-07-25', startTime: '18:00', endTime: '22:00' };
    const AUG_1 = { startDate: '2026-08-01', endDate: '2026-08-01', startTime: null, endTime: null };
    await server.connection.collection('tw_calendar_events').insertOne({
      orgId: org, locationId: location, sourceId: calendarId, generation: 1, uid: 'party-0001@bookings.example.test',
      title: 'Private party, 40 guests', ...ON_11, keyed: true,
    });
    const linkedNote = (id: string, over: Record<string, unknown>) => ({
      _id: new Types.ObjectId(id), orgId: org, locationId: location, kind: 'private_event', weekdays: null, detail: null,
      createdBy: member.userId, createdAt: at, updatedAt: at, ...over,
    });
    await server.connection.collection('tw_notes').insertMany([
      linkedNote('0000000000000000000000a2', {
        ...ON_18, effect: 'closed', expectedGuests: 60,
        fromEvent: { calendarId, uid: 'party-0002@bookings.example.test', ...ON_18, linkedAt: at },
      }),
      linkedNote('0000000000000000000000a3', {
        ...AUG_1, effect: 'more_guests', expectedGuests: 30,
        fromEvent: { calendarId, uid: 'party-0003@bookings.example.test', ...AUG_1, linkedAt: at },
      }),
    ]);
    const noteContent = (dates: object, effect: string, expectedGuests: number) => ({
      kind: 'private_event', ...dates, weekdays: null, effect, expectedGuests, detail: null,
    });
    const follow = (noteId: string, change: string, from: object, to: object | null) => ({
      noteId: new Types.ObjectId(noteId), calendarId, change, from, to, noteUpdatedAt: at,
    });
    await server.connection.collection('tw_agent_suggestions').insertMany([
      suggestion('0000000000000000000000c4', {
        type: 'event', text: null, why: null, content: noteContent(ON_11, 'unknown', 40),
        event: { calendarId, uid: 'party-0001@bookings.example.test', ...ON_11 },
      }),
      suggestion('0000000000000000000000c5', {
        type: 'move', text: null, why: null, content: noteContent(ON_25, 'closed', 60),
        follow: follow('0000000000000000000000a2', 'moved', ON_18, ON_25), openFollowFor: new Types.ObjectId('0000000000000000000000a2'),
      }),
      suggestion('0000000000000000000000c6', {
        type: 'remove', text: null, why: null, content: noteContent(AUG_1, 'more_guests', 30),
        follow: follow('0000000000000000000000a3', 'gone', AUG_1, null), openFollowFor: new Types.ObjectId('0000000000000000000000a3'),
      }),
    ]);
    // A suggested closure rule a read of that file stored (openspec change suggest-closure-rules).
    await server.connection.collection('tw_agent_suggestions').insertOne(suggestion('0000000000000000000000d1', {
      type: 'rule', text: 'Closed on Tuesdays', why: null, calendarIds: [], source: 'file', fileId: new Types.ObjectId('0000000000000000000000f1'),
      closureKey: 'closed|w=2|ongoing',
      content: { kind: 'closure', startDate: '2026-06-01', endDate: null, weekdays: [2], effect: 'closed', expectedGuests: null, detail: null, startTime: null, endTime: null },
    }));

    expect(await panel(locationId)).toEqual({ status: 200, body: fixture.panel });
    expect(await answer(locationId, fixture.answer.questionId, fixture.answer.body)).toEqual({ status: 200, body: fixture.answer.response });
  });
});
