// D59 (openspec change auto-apply-agent-reads, design decision 10): Undo of one change TownwiseAI saved, end to end.
// A note is removed while unchanged and the row reads undone, recorded once with ids only; a note a person edited since
// answers 409 changed_since and the row reads adopted; one deleted since answers 200; a retry after a stop at each step
// finishes it; sales days need an org admin and a summary item its file's adder or an org admin; another location's id
// answers 404, view-as is refused, and a change still being applied answers 409. Synthetic notes and days only.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { applyChange, TOWNWISE_AI_AUTHOR } from '../src/agent/apply.ts';
import { TOWNWISE_AI_ACTOR } from '../src/audit.ts';
import type { AgentChangeView } from '../src/agent/changes.ts';
import type { AgentPanel } from '../src/handlers/agent.ts';
import type { NoteContent } from '../src/stores/notes.ts';
import { addGrant, addLocation, addSalesDay, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, logLines, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const SENTINEL = 'Yrtq';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
const id = (): string => new Types.ObjectId().toHexString();

interface Team { orgId: string; scope: OrgScope; admin: TestSession; member: TestSession; other: TestSession; locationId: string }

async function person(orgId: string, role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

async function team(): Promise<Team> {
  const orgId = await createOrg(server, { name: `Undo Kitchen ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return {
    orgId, scope: { orgId } as OrgScope, admin: await person(orgId, 'org_admin'), member: await person(orgId, 'member'),
    other: await person(orgId, 'member'), locationId,
  };
}

function content(over: Partial<NoteContent> = {}): NoteContent {
  return {
    kind: 'closure', startDate: '2026-05-20', endDate: '2026-05-20', weekdays: null, effect: 'closed', expectedGuests: null,
    detail: `${SENTINEL} closed for a floor refit`, title: `${SENTINEL} floor refit`, startTime: null, endTime: null, ...over,
  };
}

/** A note TownwiseAI applied from a made-up file of `t.member`'s. Resolves the change's and the note's ids. */
async function appliedNote(t: Team, over: Partial<NoteContent> = {}): Promise<{ changeId: string; noteId: string }> {
  const noteId = id();
  const result = await applyChange(server.ctx, t.scope, {
    action: 'note.add', locationId: t.locationId, sourceKind: 'file', sourceId: id(), targetId: noteId, confidence: 'high',
    why: `${SENTINEL} the file says so`, onBehalfOf: t.member.userId, actor: TOWNWISE_AI_ACTOR, note: content(over), createdBy: TOWNWISE_AI_AUTHOR,
  });
  expect(result.outcome).toBe('applied');
  return { changeId: result.change?.id ?? '', noteId };
}

function undo(t: Team, session: TestSession, changeId: string, locationId = t.locationId): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/agent/changes/${changeId}/undo`, { session, method: 'POST' });
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

async function rowOf(changeId: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_agent_changes').findOne({ _id: oid(changeId) });
}

async function undoneEvents(t: Team): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => event.action === 'agent.change_undone' && String(event.orgId) === t.orgId);
}

async function panel(t: Team, session: TestSession): Promise<AgentPanel> {
  const res = await call(server, `/api/org/locations/${t.locationId}/agent`, { session });
  expect(res.status).toBe(200);
  return await res.json() as AgentPanel;
}

describe('POST .../agent/changes/:changeId/undo (D59)', () => {
  it('removes a note TownwiseAI added and nobody changed, marks the row undone, and records it once with ids only', async () => {
    const t = await team();
    await addSalesDay(server, { orgId: t.orgId, locationId: t.locationId, date: '2026-05-31', guests: 90, netSalesCents: null });
    const { changeId, noteId } = await appliedNote(t);
    await server.connection.collection('tw_locations').updateOne({ _id: oid(t.locationId) }, { $unset: { refit: 1 } });
    expect((await panel(t, t.other)).activity.find((item) => item.kind === 'agent_change')).toMatchObject({ changeId, undoable: true });
    const res = await undo(t, t.other, changeId);
    expect(res.status).toBe(200);
    const body = await res.json() as { change: AgentChangeView };
    expect(body.change).toMatchObject({ id: changeId, status: 'undone', undoable: false, action: 'note.add' });
    expect(await server.connection.collection('tw_notes').findOne({ _id: oid(noteId) })).toBeNull();
    expect(await rowOf(changeId)).toMatchObject({ status: 'undone', statusBy: t.other.userId });
    // A retry answers the same and records nothing more.
    expect((await undo(t, t.other, changeId)).status).toBe(200);
    const events = await undoneEvents(t);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: t.other.userId, actorRole: 'member', details: { locationId: t.locationId, action: 'note.add', sourceKind: 'file' },
    });
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(server.logs.join('\n')).not.toContain(SENTINEL);
    expect(logLines(server).some((line) => line.msg === 'townwise.agent_change_undone' && line.changeId === changeId)).toBe(true);
    // The note was on a training day: undoing it wants a refit.
    const location = await server.connection.collection('tw_locations').findOne({ _id: oid(t.locationId) });
    expect((location?.refit as { wantedAt?: Date } | undefined)?.wantedAt).toEqual(server.clock.now());
    // The same note from a later read is never made again.
    const again = await applyChange(server.ctx, t.scope, {
      action: 'note.add', locationId: t.locationId, sourceKind: 'file', sourceId: id(), targetId: id(), confidence: 'high', why: null,
      onBehalfOf: t.member.userId, actor: TOWNWISE_AI_ACTOR, note: content(), createdBy: TOWNWISE_AI_AUTHOR,
    });
    expect(again.outcome).toBe('duplicate');
  });

  it('a note a person edited since is theirs: 409 changed_since, the note stays, the row reads adopted and Undo is no longer offered', async () => {
    const t = await team();
    const { changeId, noteId } = await appliedNote(t);
    server.clock.advance(60_000);
    const edit = await call(server, `/api/org/locations/${t.locationId}/notes/${noteId}`, {
      session: t.admin, method: 'PATCH', json: { kind: 'closure', startDate: '2026-05-21', endDate: '2026-05-21', effect: 'closed', detail: 'Moved' },
    });
    expect(edit.status).toBe(200);
    expect((await panel(t, t.member)).activity.find((item) => item.kind === 'agent_change')).toMatchObject({ changeId, undoable: false });
    expect(await errorOf(await undo(t, t.member, changeId))).toEqual({ status: 409, error: 'changed_since' });
    expect(await server.connection.collection('tw_notes').findOne({ _id: oid(noteId) })).not.toBeNull();
    expect(await rowOf(changeId)).toMatchObject({ status: 'adopted' });
    expect(await errorOf(await undo(t, t.member, changeId))).toEqual({ status: 409, error: 'changed_since' });
    expect(await undoneEvents(t)).toEqual([]);
  });

  it('a note deleted since answers 200 and the row reads undone', async () => {
    const t = await team();
    const { changeId, noteId } = await appliedNote(t);
    expect((await call(server, `/api/org/locations/${t.locationId}/notes/${noteId}`, { session: t.admin, method: 'DELETE' })).status).toBe(204);
    expect((await undo(t, t.member, changeId)).status).toBe(200);
    expect(await rowOf(changeId)).toMatchObject({ status: 'undone' });
  });

  it('a retry finishes an undo that stopped after marking the row, with the note still there or already gone', async () => {
    const t = await team();
    const first = await appliedNote(t);
    await server.ctx.stores.agentChanges.markUndoing(t.scope, t.locationId, first.changeId, { by: t.member.userId, now: server.clock.now() });
    expect((await undo(t, t.member, first.changeId)).status).toBe(200);
    expect(await server.connection.collection('tw_notes').findOne({ _id: oid(first.noteId) })).toBeNull();
    expect(await rowOf(first.changeId)).toMatchObject({ status: 'undone' });
    const second = await appliedNote(t, { startDate: '2026-05-22', endDate: '2026-05-22' });
    await server.ctx.stores.agentChanges.markUndoing(t.scope, t.locationId, second.changeId, { by: t.member.userId, now: server.clock.now() });
    await server.ctx.stores.notes.remove(t.scope, t.locationId, second.noteId);
    expect((await undo(t, t.member, second.changeId)).status).toBe(200);
    expect(await rowOf(second.changeId)).toMatchObject({ status: 'undone' });
    expect(await undoneEvents(t)).toHaveLength(2);
  });

  it('a retry after the target went still marks the refit an undo of a training change wants', async () => {
    const t = await team();
    await addSalesDay(server, { orgId: t.orgId, locationId: t.locationId, date: '2026-05-31', guests: 90, netSalesCents: null });
    const { changeId, noteId } = await appliedNote(t);
    // The first undo removed the note, then stopped before it marked the row undone.
    await server.ctx.stores.agentChanges.markUndoing(t.scope, t.locationId, changeId, { by: t.member.userId, now: server.clock.now() });
    await server.ctx.stores.notes.remove(t.scope, t.locationId, noteId);
    await server.connection.collection('tw_locations').updateOne({ _id: oid(t.locationId) }, { $unset: { refit: 1 } });
    expect((await undo(t, t.member, changeId)).status).toBe(200);
    const location = await server.connection.collection('tw_locations').findOne({ _id: oid(t.locationId) });
    expect((location?.refit as { wantedAt?: Date } | undefined)?.wantedAt).toEqual(server.clock.now());
  });

  it('a note a pressed read wrote in a person’s name: only that person or an org admin may undo it, as deleting it', async () => {
    const t = await team();
    const noteId = id();
    const result = await applyChange(server.ctx, t.scope, {
      action: 'note.add', locationId: t.locationId, sourceKind: 'file', sourceId: id(), targetId: noteId, confidence: 'high', why: null,
      onBehalfOf: t.member.userId, actor: TOWNWISE_AI_ACTOR, note: content(), createdBy: t.member.userId,
    });
    const changeId = result.change?.id ?? '';
    expect((await panel(t, t.other)).activity.find((item) => item.kind === 'agent_change')).toMatchObject({ changeId, undoable: false });
    expect(await errorOf(await undo(t, t.other, changeId))).toEqual({ status: 403, error: 'forbidden' });
    expect(await server.connection.collection('tw_notes').findOne({ _id: oid(noteId) })).not.toBeNull();
    expect((await panel(t, t.member)).activity.find((item) => item.kind === 'agent_change')).toMatchObject({ changeId, undoable: true });
    expect((await undo(t, t.member, changeId)).status).toBe(200);
    expect(await server.connection.collection('tw_notes').findOne({ _id: oid(noteId) })).toBeNull();
  });

  it('sales days need an org admin, who removes the upload and the days it added', async () => {
    const t = await team();
    const uploadId = id();
    const result = await applyChange(server.ctx, t.scope, {
      action: 'sales_days.add', locationId: t.locationId, sourceKind: 'file', sourceId: id(), targetId: uploadId, confidence: 'high', why: null,
      onBehalfOf: t.member.userId, actor: TOWNWISE_AI_ACTOR, key: `file:${id()}`, dates: { startDate: '2026-05-01', endDate: '2026-05-02' },
      write: async () => {
        const upload = await server.ctx.stores.uploads.start(t.scope, t.locationId, {
          id: uploadId, uploadedBy: t.member.userId, uploadedAt: server.clock.now(), dayCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-02',
          hasGuests: true, hasNetSales: false,
        });
        await server.ctx.stores.salesDays.apply(t.scope, t.locationId, {
          uploadId, replace: false, now: server.clock.now(),
          days: [{ date: '2026-05-01', guests: 80, netSalesCents: null }, { date: '2026-05-02', guests: 85, netSalesCents: null }],
        });
        await server.ctx.stores.uploads.finish(t.scope, uploadId, { inserted: 2, replaced: 0, kept: 0 });
        return upload.uploadedAt;
      },
    });
    const changeId = result.change?.id ?? '';
    expect((await panel(t, t.member)).activity.find((item) => item.kind === 'agent_change')).toMatchObject({ changeId, undoable: false });
    expect((await panel(t, t.admin)).activity.find((item) => item.kind === 'agent_change')).toMatchObject({ changeId, undoable: true });
    expect(await errorOf(await undo(t, t.member, changeId))).toEqual({ status: 403, error: 'forbidden' });
    expect((await undo(t, t.admin, changeId)).status).toBe(200);
    expect(await server.connection.collection('tw_uploads').countDocuments({ _id: oid(uploadId) })).toBe(0);
    expect(await server.connection.collection('tw_sales_days').countDocuments({ uploadId: oid(uploadId) })).toBe(0);
    expect(await rowOf(changeId)).toMatchObject({ status: 'undone' });
  });

  it('another location’s or organization’s id answers 404, view-as is refused, and a change still being applied answers 409', async () => {
    const t = await team();
    const { changeId } = await appliedNote(t);
    const elsewhere = await addLocation(server, { orgId: t.orgId, name: 'Back Room' });
    expect(await errorOf(await undo(t, t.member, changeId, elsewhere))).toEqual({ status: 404, error: 'not_found' });
    const u = await team();
    expect(await errorOf(await undo(u, u.member, changeId))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await undo(t, t.member, id()))).toEqual({ status: 404, error: 'not_found' });
    expect((await undo(t, t.member, 'not-an-id')).status).toBe(400);
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.admin.userId, orgId: t.orgId });
    try {
      expect(await errorOf(await undo(t, staff, changeId))).toEqual({ status: 403, error: 'view_as_read_only' });
      // Staff viewing see the change without its why, and no Undo.
      expect((await panel(t, staff)).activity.find((item) => item.kind === 'agent_change')).toMatchObject({ changeId, undoable: false });
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
    expect(await rowOf(changeId)).toMatchObject({ status: 'applied' });
    const applying = (await server.ctx.stores.agentChanges.insertApplying(t.scope, {
      id: id(), locationId: t.locationId, sourceKind: 'file', sourceId: null, action: 'note.add', targetId: id(), dedupeKey: 'applying-key',
      confidence: 'high', why: null, onBehalfOf: null, startDate: null, endDate: null, now: server.clock.now(),
    })).record;
    expect(await errorOf(await undo(t, t.member, applying.id))).toEqual({ status: 409, error: 'change_in_progress' });
  });
});
