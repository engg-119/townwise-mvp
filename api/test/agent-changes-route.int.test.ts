// D59 (openspec change auto-apply-agent-reads, design decision 11): GET .../agent/changes, the log of TownwiseAI's
// changes at a location, end to end: every change newest first, 50 a page with a `next` cursor that skips none, each with
// its why and status and whether Undo is offered; staff in view-as read it without the why or Undo; another location's
// or organization's id answers 404; a bad cursor answers 400; the read logs nothing. Synthetic rows only.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentChangeView } from '../src/agent/changes.ts';
import { addGrant, addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const SENTINEL = 'Hvbn';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

interface Team { orgId: string; member: TestSession; admin: TestSession; locationId: string }

async function person(orgId: string, role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

async function team(): Promise<Team> {
  const orgId = await createOrg(server, { name: `Log Kitchen ${randomUUID().slice(0, 6)}` });
  return { orgId, member: await person(orgId, 'member'), admin: await person(orgId, 'org_admin'), locationId: await addLocation(server, { orgId, name: 'Main Room' }) };
}

/** `count` applied note changes, a second apart from `base`, each with a note still as it was added. */
async function seedChanges(t: Team, count: number): Promise<string[]> {
  const base = Date.parse('2026-05-01T00:00:00.000Z');
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = new Date(base + Math.floor(i / 2) * 1000);
    const noteId = new Types.ObjectId();
    const changeId = new Types.ObjectId();
    await server.connection.collection('tw_notes').insertOne({
      _id: noteId, orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(t.locationId), kind: 'closure', startDate: '2026-07-01',
      endDate: '2026-07-01', weekdays: null, effect: 'closed', expectedGuests: null, detail: null, createdBy: 'townwise_ai',
      agent: { changeId, at }, createdAt: at, updatedAt: at,
    });
    await server.connection.collection('tw_agent_changes').insertOne({
      _id: changeId, orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(t.locationId), sourceKind: 'file', sourceId: 'f'.repeat(24),
      action: 'note.add', targetId: noteId, dedupeKey: `key-${String(i)}`, confidence: 'high', why: `${SENTINEL} why ${String(i)}`, onBehalfOf: null,
      status: 'applied', targetUpdatedAt: at, startDate: '2026-07-01', endDate: '2026-07-01', noteKind: 'closure', appliedAt: at, statusAt: at,
      statusBy: 'townwise_ai',
    });
    ids.push(changeId.toHexString());
  }
  return ids;
}

function log(t: Team, session: TestSession, query = '', locationId = t.locationId): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/agent/changes${query}`, { session });
}

describe('GET .../agent/changes (D59)', () => {
  it('lists every change newest first, 50 a page, with its why, its status and whether Undo is offered', async () => {
    const t = await team();
    const ids = await seedChanges(t, 53);
    const first = await log(t, t.member);
    expect(first.status).toBe(200);
    const page = await first.json() as { changes: AgentChangeView[]; next: string | null };
    expect(page.changes).toHaveLength(50);
    expect(page.changes[0]).toMatchObject({
      action: 'note.add', sourceKind: 'file', sourceRef: `f_${'f'.repeat(24)}`, status: 'applied', why: expect.stringContaining(SENTINEL) as unknown,
      undoable: true, noteKind: 'closure', startDate: '2026-07-01',
    });
    expect(page.next).not.toBeNull();
    const second = await (await log(t, t.member, `?before=${encodeURIComponent(page.next ?? '')}`)).json() as { changes: AgentChangeView[]; next: string | null };
    expect(second.changes).toHaveLength(3);
    expect(second.next).toBeNull();
    const all = [...page.changes, ...second.changes];
    expect(new Set(all.map((each) => each.id)).size).toBe(53);
    expect([...all.map((each) => each.id)].sort()).toEqual([...ids].sort());
    const times = all.map((each) => each.at);
    expect(times).toEqual([...times].sort().reverse());
    // A read records and logs nothing.
    expect(server.logs.join('\n')).not.toContain(SENTINEL);
  });

  it('staff in view-as read it without the why and with no Undo; another location’s or organization’s answers 404; a bad cursor 400', async () => {
    const t = await team();
    await seedChanges(t, 2);
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.member.userId, orgId: t.orgId });
    try {
      const page = await (await log(t, staff)).json() as { changes: AgentChangeView[] };
      expect(page.changes.map((each) => [each.why, each.undoable])).toEqual([[null, false], [null, false]]);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
    const u = await team();
    expect((await log(u, u.member, '', t.locationId)).status).toBe(404);
    const elsewhere = await addLocation(server, { orgId: t.orgId, name: 'Back Room' });
    expect(await (await log(t, t.member, '', elsewhere)).json()).toEqual({ changes: [], next: null });
    for (const bad of ['?before=yesterday', '?before=2026-05-01T00:00:00Z_abc']) expect((await log(t, t.member, bad)).status).toBe(400);
  });
});
