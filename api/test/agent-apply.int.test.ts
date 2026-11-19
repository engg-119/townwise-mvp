// D59: the one writer (agent/apply.ts) against the database: a note applied with its ledger row, its audit event (ids,
// the action and the source kind only) and a refit wanted only for a training day; a crash between the steps finished by
// a retry with one note; two sources racing write one note; a person's covering note blocks; an undone change is never
// made again; a writer that adds nothing frees its key; (slice 2) a calendar's labels are one change whose retry writes at
// the time planned first. Synthetic notes and days only.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { applyChange, dedupeKeyOf, TOWNWISE_AI_AUTHOR, type NoteCandidate } from '../src/agent/apply.ts';
import { TOWNWISE_AI_ACTOR } from '../src/audit.ts';
import type { NoteContent } from '../src/stores/notes.ts';
import { addLocation, addSalesDay, auditEvents, createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const SENTINEL = 'Wqzk';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

const id = (): string => new Types.ObjectId().toHexString();

interface Place { orgId: string; scope: OrgScope; locationId: string }

async function place(): Promise<Place> {
  const orgId = await createOrg(server, { name: `Apply Kitchen ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, scope: { orgId } as OrgScope, locationId };
}

function content(over: Partial<NoteContent> = {}): NoteContent {
  return {
    kind: 'private_event', startDate: '2026-12-12', endDate: '2026-12-12', weekdays: null, effect: 'closed', expectedGuests: 60,
    detail: `${SENTINEL} back room`, title: `${SENTINEL} rehearsal dinner`, startTime: null, endTime: null, ...over,
  };
}

function candidate(p: Place, over: Partial<NoteCandidate> = {}): NoteCandidate {
  return {
    action: 'note.add', locationId: p.locationId, sourceKind: 'file', sourceId: id(), targetId: id(), confidence: 'high',
    why: `${SENTINEL} the file says the room is booked`, onBehalfOf: 'adder', actor: TOWNWISE_AI_ACTOR, note: content(),
    createdBy: TOWNWISE_AI_AUTHOR, ...over,
  };
}

async function notesOf(p: Place): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_notes').find({ locationId: new Types.ObjectId(p.locationId) }).toArray();
}

async function rowsOf(p: Place): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_agent_changes').find({ locationId: new Types.ObjectId(p.locationId) }).toArray();
}

async function refitOf(p: Place): Promise<unknown> {
  return (await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(p.locationId) }))?.refit;
}

describe('applyChange', () => {
  it('applies a note under its planned id, marked as TownwiseAI’s, with its ledger row and an audit event of ids only', async () => {
    const p = await place();
    const c = candidate(p);
    const result = await applyChange(server.ctx, p.scope, c);
    expect(result.outcome).toBe('applied');
    const [note] = await notesOf(p);
    expect(note).toMatchObject({ _id: new Types.ObjectId(c.targetId), createdBy: 'townwise_ai', title: `${SENTINEL} rehearsal dinner` });
    expect((note?.agent as { at: Date }).at).toEqual(note?.updatedAt);
    expect(String((note?.agent as { changeId: unknown }).changeId)).toBe(result.change?.id);
    expect(result.change).toMatchObject({
      status: 'applied', action: 'note.add', sourceKind: 'file', targetId: c.targetId, confidence: 'high', onBehalfOf: 'adder',
      startDate: '2026-12-12', endDate: '2026-12-12', noteKind: 'private_event', dedupeKey: dedupeKeyOf({ action: 'note.add', note: c.note }),
    });
    expect(result.change?.targetUpdatedAt).toEqual(note?.updatedAt);
    const events = (await auditEvents(server)).filter((event) => event.action === 'agent.change_applied' && String(event.orgId) === p.orgId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: 'townwise_ai', actorRole: 'system', details: { locationId: p.locationId, action: 'note.add', sourceKind: 'file' },
    });
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(server.logs.join('\n')).not.toContain(SENTINEL);
    // A note on a day after the last stored sales day changes the forecast on read and wants no refit.
    expect(await refitOf(p)).toBeUndefined();
    // Applying it again finds it applied, and writes nothing more.
    expect((await applyChange(server.ctx, p.scope, c)).outcome).toBe('applied');
    expect(await notesOf(p)).toHaveLength(1);
    expect((await auditEvents(server)).filter((event) => event.action === 'agent.change_applied' && String(event.orgId) === p.orgId)).toHaveLength(1);
  });

  it('a note on or before the last stored sales day wants a refit', async () => {
    const p = await place();
    await addSalesDay(server, { orgId: p.orgId, locationId: p.locationId, date: '2026-05-31', guests: 100, netSalesCents: null });
    expect((await applyChange(server.ctx, p.scope, candidate(p, { note: content({ startDate: '2026-05-30', endDate: '2026-05-30' }) }))).outcome)
      .toBe('applied');
    expect(await refitOf(p)).toEqual({ wantedAt: server.clock.now() });
  });

  it('a retry of a change applied before its refit mark landed marks the refit', async () => {
    const p = await place();
    await addSalesDay(server, { orgId: p.orgId, locationId: p.locationId, date: '2026-05-31', guests: 100, netSalesCents: null });
    const c = candidate(p, { note: content({ startDate: '2026-05-30', endDate: '2026-05-30' }) });
    expect((await applyChange(server.ctx, p.scope, c)).outcome).toBe('applied');
    // As if the first attempt stopped between marking the row applied and marking the refit.
    await server.connection.collection('tw_locations').updateOne({ _id: new Types.ObjectId(p.locationId) }, { $unset: { refit: 1 } });
    expect((await applyChange(server.ctx, p.scope, c)).outcome).toBe('applied');
    expect(await refitOf(p)).toEqual({ wantedAt: server.clock.now() });
  });

  it('a retry finishes a change that stopped after its row, or after its note, with one note and one event', async () => {
    const p = await place();
    // Stopped after the row: the retry writes the note under the planned id.
    const first = candidate(p);
    const key = dedupeKeyOf({ action: 'note.add', note: first.note });
    await server.ctx.stores.agentChanges.insertApplying(p.scope, {
      id: id(), locationId: p.locationId, sourceKind: 'file', sourceId: first.sourceId, action: 'note.add', targetId: first.targetId, dedupeKey: key,
      confidence: 'high', why: null, onBehalfOf: 'adder', startDate: '2026-12-12', endDate: '2026-12-12', now: server.clock.now(),
    });
    expect((await applyChange(server.ctx, p.scope, first)).outcome).toBe('applied');
    // Stopped after the note: the retry finds it and sets the row applied.
    const second = candidate(p, { note: content({ startDate: '2026-12-19', endDate: '2026-12-19' }) });
    const row = (await server.ctx.stores.agentChanges.insertApplying(p.scope, {
      id: id(), locationId: p.locationId, sourceKind: 'file', sourceId: second.sourceId, action: 'note.add', targetId: second.targetId,
      dedupeKey: dedupeKeyOf({ action: 'note.add', note: second.note }), confidence: 'high', why: null, onBehalfOf: 'adder',
      startDate: '2026-12-19', endDate: '2026-12-19', now: server.clock.now(),
    })).record;
    await server.ctx.stores.notes.create(p.scope, p.locationId, second.note, {
      createdBy: TOWNWISE_AI_AUTHOR, now: server.clock.now(), id: second.targetId, agent: { changeId: row.id },
    });
    const done = await applyChange(server.ctx, p.scope, second);
    expect(done.outcome).toBe('applied');
    expect(done.change).toMatchObject({ id: row.id, status: 'applied' });
    expect(await notesOf(p)).toHaveLength(2);
    expect((await rowsOf(p)).map((each) => each.status)).toEqual(['applied', 'applied']);
    expect((await auditEvents(server)).filter((event) => event.action === 'agent.change_applied' && String(event.orgId) === p.orgId)).toHaveLength(2);
  });

  it('two sources stating the same event at once write one note; the other is a duplicate', async () => {
    const p = await place();
    const fromPdf = candidate(p);
    const fromPhoto = candidate(p, { note: content({ title: `${SENTINEL.toUpperCase()}  Rehearsal Dinner`, detail: 'Another detail' }) });
    const results = await Promise.all([applyChange(server.ctx, p.scope, fromPdf), applyChange(server.ctx, p.scope, fromPhoto)]);
    expect(results.map((each) => each.outcome).sort()).toEqual(['applied', 'duplicate']);
    expect(await notesOf(p)).toHaveLength(1);
    expect(await rowsOf(p)).toHaveLength(1);
  });

  it('a person’s note that decides the day differently blocks the change: a conflict, and nothing is written', async () => {
    const p = await place();
    await server.ctx.stores.notes.create(p.scope, p.locationId, content({ kind: 'closure', effect: 'closed', expectedGuests: null, title: null }), {
      createdBy: 'person', now: server.clock.now(),
    });
    const result = await applyChange(server.ctx, p.scope, candidate(p));
    expect(result).toEqual({ outcome: 'conflict', change: null });
    expect(await notesOf(p)).toHaveLength(1);
    expect(await rowsOf(p)).toEqual([]);
  });

  it('a change someone undid keeps its key, so the same event from a later read is a duplicate', async () => {
    const p = await place();
    const result = await applyChange(server.ctx, p.scope, candidate(p));
    const change = result.change;
    if (change === null) throw new Error('no change');
    await server.ctx.stores.agentChanges.markUndoing(p.scope, p.locationId, change.id, { by: 'person', now: server.clock.now() });
    await server.ctx.stores.notes.remove(p.scope, p.locationId, change.targetId);
    await server.ctx.stores.agentChanges.markUndone(p.scope, p.locationId, change.id, { by: 'person', now: server.clock.now() });
    const again = await applyChange(server.ctx, p.scope, candidate(p));
    expect(again.outcome).toBe('duplicate');
    expect(again.change?.status).toBe('undone');
    expect(await notesOf(p)).toEqual([]);
  });

  it('a writer that adds nothing after all answers invalid and frees its key', async () => {
    const p = await place();
    const base = {
      locationId: p.locationId, sourceKind: 'file' as const, sourceId: id(), confidence: 'high' as const, why: null, onBehalfOf: 'adder',
      actor: TOWNWISE_AI_ACTOR, action: 'item.add' as const, key: 'file:one', dates: null,
    };
    expect(await applyChange(server.ctx, p.scope, { ...base, targetId: id(), write: () => Promise.resolve(null) }))
      .toEqual({ outcome: 'invalid', change: null });
    expect(await rowsOf(p)).toEqual([]);
    const at = server.clock.now();
    const written = await applyChange(server.ctx, p.scope, { ...base, targetId: id(), write: () => Promise.resolve(at) });
    expect(written.outcome).toBe('applied');
    expect(written.change).toMatchObject({ action: 'item.add', targetUpdatedAt: at, startDate: null });
  });

  it('slice 2: a calendar’s labels are one change whose writer gets the row, so a retry writes at the time planned first', async () => {
    const p = await place();
    await addSalesDay(server, { orgId: p.orgId, locationId: p.locationId, date: '2026-05-01', guests: 50, netSalesCents: 100_000 });
    const calendarId = id();
    const seen: Date[] = [];
    const label = (write: (at: Date) => Promise<Date | null>) => applyChange(server.ctx, p.scope, {
      action: 'booking.label', locationId: p.locationId, sourceKind: 'calendar', sourceId: calendarId, targetId: calendarId, confidence: 'high',
      why: null, onBehalfOf: 'adder', actor: TOWNWISE_AI_ACTOR, key: `calendar:${calendarId}`,
      dates: { startDate: '2026-04-11', endDate: '2026-06-20' }, count: 7,
      write: (change) => {
        seen.push(change.appliedAt);
        return write(change.appliedAt);
      },
    });
    // The labels were written, then the attempt stopped before the row was marked applied.
    await expect(label(() => Promise.reject(new Error('stopped')))).rejects.toThrow('stopped');
    expect((await rowsOf(p)).map((row) => row.status)).toEqual(['applying']);
    server.clock.advance(5_000);
    const retried = await label((at) => Promise.resolve(at));
    expect(retried.outcome).toBe('applied');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(retried.change).toMatchObject({
      action: 'booking.label', sourceKind: 'calendar', targetId: calendarId, count: 7, targetUpdatedAt: seen[0], startDate: '2026-04-11',
    });
    // A past booking: the training days changed.
    expect(await refitOf(p)).toMatchObject({ wantedAt: expect.any(Date) as unknown });
    // The same calendar again (its key) is the change already made.
    expect((await label((at) => Promise.resolve(at))).outcome).toBe('applied');
    expect(seen).toHaveLength(2);
    expect(await rowsOf(p)).toHaveLength(1);
  });
});
