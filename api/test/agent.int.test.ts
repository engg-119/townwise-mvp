// TownwiseAI's side panel (spec 10.12, docs/portal/tuning-chat.md section 8): the questions and the activity, read from
// the location's own records; an answer recorded once however often or from however many tabs it is sent, finished
// after a crash, `closed` saving one closure note through the notes rules, read-only under view-as, and logged with
// ids and the answer only. Synthetic days only.
import { randomUUID } from 'node:crypto';

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
 * A new location whose days run FROM to TO with no sales on Mondays and on Tuesday 2026-05-12 and Wednesday
 * 2026-05-13: it is asked WEEKDAY_ID and GAP_ID.
 */
async function askedLocation(): Promise<string> {
  const locationId = await addLocation(server, { orgId, name: `Counter ${randomUUID().slice(0, 8)}` });
  const rows = [];
  for (let date = FROM; date <= TO; date = plus(date, 1)) {
    if (isMonday(date) || date === '2026-05-12' || date === '2026-05-13') continue;
    rows.push({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), date, guests: 10, netSalesCents: null,
      uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
    });
  }
  await server.connection.collection('tw_sales_days').insertMany(rows);
  return locationId;
}

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

/** A claim that stopped before `done`, as a try that failed after it leaves it; with its closure note written, or not. */
async function stoppedClaim(locationId: string, answer: string, written: boolean): Promise<Types.ObjectId> {
  const noteId = new Types.ObjectId();
  const at = server.clock.now();
  await server.connection.collection('tw_agent_answers').insertOne({
    orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), questionId: GAP_ID, answer,
    noteId, status: 'saving', createdAt: at, updatedAt: at,
  });
  if (written) {
    await server.connection.collection('tw_notes').insertOne({
      _id: noteId, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), kind: 'closure',
      startDate: '2026-05-12', endDate: '2026-05-13', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
      createdBy: member.userId, createdAt: at, updatedAt: at,
    });
  }
  return noteId;
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
  it('asks about the weekday and the gap with no sales, and lists only applied uploads', async () => {
    const locationId = await askedLocation();
    const at = server.clock.now();
    await server.connection.collection('tw_uploads').insertMany(['applied', 'applying'].map((status) => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), uploadedBy: member.userId, uploadedAt: at,
      status, dayCount: 78, inserted: 78, replaced: 0, kept: 0, firstDate: FROM, lastDate: TO, hasGuests: true, hasNetSales: false,
    })));
    expect(await panel(locationId)).toEqual({
      status: 200,
      body: {
        questions: [
          { id: WEEKDAY_ID, kind: 'weekday', weekday: 1, from: FROM, to: TO, noSalesCount: 13, weekdayCount: 13 },
          { id: GAP_ID, kind: 'gap', from: '2026-05-12', to: '2026-05-13', dayCount: 2 },
        ],
        activity: [{ at: at.toISOString(), kind: 'upload_applied', firstDate: FROM, lastDate: TO, dayCount: 78 }],
      },
    });
  });

  it('asks nothing and lists nothing for a location with no records', async () => {
    const locationId = await addLocation(server, { orgId, name: 'Empty Room' });
    expect(await panel(locationId)).toEqual({ status: 200, body: { questions: [], activity: [] } });
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
    expect(after.body.questions.map((q) => q.id)).toEqual([WEEKDAY_ID]);
    expect(after.body.activity).toEqual([{
      at: server.clock.now().toISOString(), kind: 'note_saved', via: 'question', noteId: body.note?.id,
      noteKind: 'closure', startDate: '2026-05-12', endDate: '2026-05-13',
    }]);
  });

  it('on a weekday saves a weekly closure note over the window', async () => {
    const locationId = await askedLocation();
    const { status, body } = await answer(locationId, WEEKDAY_ID, { answer: 'closed' });
    expect(status).toBe(200);
    expect(body.note).toMatchObject({ kind: 'closure', startDate: FROM, endDate: TO, weekdays: [1], effect: 'closed' });
    expect(await notesOf(locationId)).toHaveLength(1);
    expect((await panel(locationId)).body.questions.map((q) => q.id)).toEqual([GAP_ID]);
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
      expect((await panel(locationId)).body.questions.map((q) => q.id)).toEqual(written ? [WEEKDAY_ID] : [WEEKDAY_ID, GAP_ID]);
      const { status, body } = await answer(locationId, GAP_ID, { answer: 'closed' });
      expect({ written, status, noteId: body.note?.id }).toEqual({ written, status: 200, noteId: noteId.toHexString() });
      expect(await notesOf(locationId)).toHaveLength(1);
      expect(await eventsAt(locationId, 'note.created')).toHaveLength(written ? 0 : 1);
      expect(await eventsAt(locationId, 'agent.question_answered')).toHaveLength(1);
      expect(await answerRows(locationId)).toEqual([expect.objectContaining({ status: 'done', noteId })]);
    }
  });

  it('after a closed answer that stopped with its note written, a different answer finishes it as closed', async () => {
    for (const next of ['open', 'not_sure']) {
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
      expect((await panel(locationId)).body.questions.map((q) => q.id)).toEqual([WEEKDAY_ID]);
      expect({ stopped, ...(await answer(locationId, GAP_ID, { answer: 'closed' })) })
        .toMatchObject({ stopped, status: 404, body: { error: 'not_found' } });
      expect(await notesOf(locationId)).toHaveLength(0);
      expect(await eventsAt(locationId, 'agent.question_answered')).toHaveLength(0);
    }
  });

  it('two members answering differently at once end with a row, a last audit event and notes that agree', async () => {
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
      const events = await eventsAt(locationId, 'agent.question_answered');
      expect((events.at(-1)?.details as { answer?: string }).answer).toBe(stored);
      const notes = await notesOf(locationId);
      expect(notes.map((n) => (n._id as Types.ObjectId).toHexString()))
        .toEqual(stored === 'closed' ? [(rows[0]?.noteId as Types.ObjectId).toHexString()] : []);
      expect((await answer(locationId, GAP_ID, { answer: 'not_sure' })).body.question.answer).toBe(stored);
    }
  });

  it('marking done: a different answer that took the row loses it, and a closed answer whose note is written overrules it', async () => {
    // The orders the handler cannot pin over HTTP: a claim, another tab's different claim, then each one's markDone.
    const staff = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
    const scope = scopeForNewOrg(staff, orgId);
    const store = createAgentAnswerStore(server.connection);
    const now = server.clock.now();
    // [first claim, second claim, first's markDone, second's markDone, the answer stored]
    const orders = [
      ['open', 'not_sure', false, true, 'not_sure'],
      ['closed', 'open', true, false, 'closed'],
      ['open', 'closed', false, true, 'closed'],
    ] as const;
    for (const [first, second, firstDone, secondDone, stored] of orders) {
      const key = { locationId: await askedLocation(), questionId: GAP_ID };
      const claimed = await store.claim(scope, key, { answer: first, now });
      expect(await store.claim(scope, key, { answer: second, now })).toMatchObject({ answer: second, noteId: claimed?.noteId });
      const done = [await store.markDone(scope, key, { answer: first, now }), await store.markDone(scope, key, { answer: second, now })];
      expect({ first, second, done, row: await store.find(scope, key) })
        .toMatchObject({ first, second, done: [firstDone, secondDone], row: { answer: stored, status: 'done' } });
    }
    // A closed answer whose note is written also takes back a row a different answer finished first.
    const key = { locationId: await askedLocation(), questionId: GAP_ID };
    await store.claim(scope, key, { answer: 'closed', now });
    await store.claim(scope, key, { answer: 'open', now });
    expect(await store.markDone(scope, key, { answer: 'open', now })).toBe(true);
    expect(await store.markDone(scope, key, { answer: 'closed', now })).toBe(true);
    expect(await store.markDone(scope, key, { answer: 'closed', now })).toBe(false);
    expect(await store.find(scope, key)).toMatchObject({ answer: 'closed', status: 'done' });
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
    expect((await panel(locationId)).body.questions.map((q) => q.id)).toEqual([WEEKDAY_ID, GAP_ID]);
    expect(await answer(locationId, GAP_ID, { answer: 'open' })).toMatchObject({
      status: 200, body: { question: { id: GAP_ID, answer: 'open' }, note: null },
    });
    expect(await eventsAt(locationId, 'agent.question_answered')).toHaveLength(1);
  });
});

describe('answering open or not sure', () => {
  it('saves no note, asks about those days no more, and shows in the activity', async () => {
    const locationId = await askedLocation();
    expect(await answer(locationId, GAP_ID, { answer: 'open' })).toEqual({ status: 200, body: { question: { id: GAP_ID, answer: 'open' }, note: null } });
    server.clock.advance(60_000);
    expect(await answer(locationId, WEEKDAY_ID, { answer: 'not_sure' })).toMatchObject({ status: 200, body: { note: null } });
    expect(await notesOf(locationId)).toHaveLength(0);
    const { body } = await panel(locationId);
    expect(body.questions).toEqual([]);
    expect(body.activity).toEqual([
      { at: server.clock.now().toISOString(), kind: 'question_answered', questionId: WEEKDAY_ID, answer: 'not_sure' },
      { at: new Date(server.clock.now().getTime() - 60_000).toISOString(), kind: 'question_answered', questionId: GAP_ID, answer: 'open' },
    ]);
  });
});

describe('what an answer may name', () => {
  it('a question not asked now is 404; a malformed id or body is 400; nothing is written', async () => {
    const locationId = await askedLocation();
    for (const questionId of ['gap_2026-04-01_2026-04-02', 'gap_2026-02-30_2026-03-01', `weekday_2_${FROM}_${TO}`]) {
      expect(await answer(locationId, questionId, { answer: 'closed' })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
    expect(await answer(locationId, 'gap_soon', { answer: 'closed' })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    for (const json of [{}, { answer: 'maybe' }, { answer: ['closed'] }]) {
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
      expect(await panel(locationId, staff)).toEqual(await panel(locationId));
      expect(await answer(locationId, GAP_ID, { answer: 'closed' }, staff)).toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
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
