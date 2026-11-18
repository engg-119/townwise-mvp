// Active days through the route chain (openspec change staff-overview, design decisions 2 and 3): routes.ts authorize
// calls the recorder once the policy passed, so a member's request records their UTC day once, staff, view-as, open as
// admin and people without a seat never, a failed write never changes the answer, and the first write of a new day
// removes rows older than the 180 days kept.
import { randomUUID } from 'node:crypto';

import { createLogger } from '@ckeith26/server-core';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createActivityRecorder } from '../src/access/activity.ts';
import { scopeForNewOrg } from '../src/access/policy.ts';
import { utcDay } from '../src/dates.ts';
import { createActivityDayStore } from '../src/stores/activity-days.ts';
import {
  addActivityDay, addGrant, addInvite, addOpenAsAdminGrant, addSeat, createOrg,
} from './helpers/fixtures.ts';
import {
  call, logLines, makeStaff, MINUTE, removeStaffFactor, signIn, STAFF_EMAIL, startTownwiseServer, writesDuring,
  type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer({ activity: true }); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.connection.collection('tw_activity_days').deleteMany({});
});
afterEach(async () => { await removeStaffFactor(server); });

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

/** A signed-in person with an active seat in a new organization. */
async function seated(opts: { role?: 'org_admin' | 'member'; status?: 'active' | 'suspended' } = {}) {
  const email = uniqueEmail('person');
  const session = await signIn(server, email);
  const orgId = await createOrg(server, { name: `Active Day Cafe ${randomUUID().slice(0, 6)}`, status: opts.status ?? 'active' });
  const seatId = await addSeat(server, { orgId, userId: session.userId, email, role: opts.role ?? 'member' });
  return { email, session, orgId, seatId };
}

async function get(session: TestSession, path: string): Promise<number> {
  return (await call(server, path, { session })).status;
}

/** Every request's write has settled. */
function settled(): Promise<void> {
  return server.ctx.activity.idle();
}

function rows(): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_activity_days').find({}).sort({ _id: 1 }).toArray();
}

function today(): string {
  return utcDay(server.clock.now());
}

/** Makes every write to `collection` fail at the database, then puts it back. */
async function withWritesFailing(collection: string, run: () => Promise<void>): Promise<void> {
  const db = server.connection.db;
  if (db === undefined) throw new Error('not connected');
  await db.command({ collMod: collection, validator: { $expr: { $eq: [1, 0] } } });
  try {
    await run();
  } finally {
    await db.command({ collMod: collection, validator: {} });
  }
}

describe('active days through the route chain', () => {
  it('opening the app (GET /api/me) records one row for the member’s organization and UTC day; later requests that day write none', async () => {
    const owner = await seated({ role: 'org_admin' });
    const first = await writesDuring(server, async () => {
      expect(await get(owner.session, '/api/me')).toBe(200);
      await settled();
    });
    expect(first.filter((write) => write === 'update tw_activity_days')).toHaveLength(1);
    expect(await rows()).toEqual([
      { _id: `${owner.orgId}:${owner.session.userId}:${today()}`, orgId: new Types.ObjectId(owner.orgId), userId: owner.session.userId, day: today() },
    ]);

    const later = await writesDuring(server, async () => {
      for (let i = 0; i < 5; i += 1) expect(await get(owner.session, '/api/me')).toBe(200);
      expect(await get(owner.session, '/api/org')).toBe(200);
      await settled();
    });
    expect(later.filter((write) => write.endsWith(' tw_activity_days'))).toEqual([]);
    expect(await rows()).toHaveLength(1);
  });

  it('a second replica’s recorder, over the same database, adds no second row for the day', async () => {
    const member = await seated();
    expect(await get(member.session, '/api/me')).toBe(200);
    await settled();
    const replica = createActivityRecorder({
      connection: server.connection, activityDays: createActivityDayStore(server.connection), logger: createLogger({ LOG_LEVEL: 'silent' }),
      now: server.clock.now,
    });
    replica.record({
      kind: 'member', userId: member.session.userId, email: member.email, scope: scopeForNewOrg(STAFF, member.orgId), role: 'member',
      memberId: member.seatId, viewAs: null, openAsAdmin: null,
    });
    await replica.idle();
    expect((await rows()).map((row) => row._id)).toEqual([`${member.orgId}:${member.session.userId}:${today()}`]);
  });

  it('staff, staff in view-as, staff open as admin, a suspended organization’s member and a person with no seat write none', async () => {
    const target = await seated({ role: 'org_admin' });
    // Three sessions of the staff member: plain, viewing as the org admin, and an organization nobody joined open as its admin.
    const viewing = await signIn(server, STAFF_EMAIL);
    const opened = await signIn(server, STAFF_EMAIL);
    const staff = await signIn(server, STAFF_EMAIL);
    await makeStaff(server, staff.userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });
    await addGrant(server, { actorUserId: viewing.userId, sessionId: viewing.sessionId, targetUserId: target.session.userId, orgId: target.orgId });
    const setupOrgId = await createOrg(server, { name: `Setup Cafe ${randomUUID().slice(0, 6)}` });
    await addInvite(server, { orgId: setupOrgId, email: uniqueEmail('first-admin'), invitedBy: staff.userId, role: 'org_admin', addedByStaff: true });
    await addOpenAsAdminGrant(server, { actorUserId: opened.userId, sessionId: opened.sessionId, orgId: setupOrgId });
    const paused = await seated({ status: 'suspended' });
    const nobody = await signIn(server, uniqueEmail('no-seat'));

    expect(await get(staff, '/api/me')).toBe(200);
    expect(await get(staff, '/api/admin/requests')).toBe(200);
    expect(await get(viewing, '/api/me')).toBe(200);
    expect(await get(viewing, '/api/org')).toBe(200);
    expect(await get(opened, '/api/me')).toBe(200);
    expect(await get(opened, '/api/org')).toBe(200);
    expect(await get(paused.session, '/api/me')).toBe(200);
    expect(await get(nobody, '/api/me')).toBe(200);
    await settled();
    expect(await rows()).toEqual([]);
  });

  it('a request refused by its policy writes none; one refused after its policy, by its body, still counts', async () => {
    const member = await seated();
    expect(await get(member.session, '/api/admin/requests')).toBe(403);
    expect((await call(server, '/api/org', { method: 'PATCH', session: member.session, json: { name: 'Renamed' } })).status).toBe(403);
    await settled();
    expect(await rows()).toEqual([]);

    const locationId = new Types.ObjectId().toHexString();
    const res = await call(server, `/api/org/locations/${locationId}/notes`, { session: member.session, rawBody: '{"kind":' });
    expect(res.status).toBe(400);
    await settled();
    expect((await rows()).map((row) => row.userId)).toEqual([member.session.userId]);
  });

  it('a write that fails at the database still answers 200, logs the organization and its code only, and the next request writes the row', async () => {
    const member = await seated();
    await withWritesFailing('tw_activity_days', async () => {
      expect(await get(member.session, '/api/me')).toBe(200);
      await settled();
    });
    expect(await rows()).toEqual([]);
    const failed = logLines(server).filter((line) => line.msg === 'townwise.activity_write_failed');
    expect(failed.at(-1)).toMatchObject({ orgId: member.orgId, code: 121 });
    expect(JSON.stringify(failed)).not.toContain(member.email);
    expect(JSON.stringify(failed)).not.toContain(member.session.userId);

    expect(await get(member.session, '/api/me')).toBe(200);
    await settled();
    expect((await rows()).map((row) => row.userId)).toEqual([member.session.userId]);
  });

  it('the first write of a new UTC day removes rows dated before the 180 days kept, and keeps the row 179 days old', async () => {
    server.clock.advance(24 * 60 * MINUTE);
    const otherOrg = await createOrg(server, { name: `Old Days Cafe ${randomUUID().slice(0, 6)}` });
    const tooOld = utcDay(server.clock.now(), -180);
    const oldest = utcDay(server.clock.now(), -179);
    await addActivityDay(server, { orgId: otherOrg, userId: 'former-0001', day: tooOld });
    await addActivityDay(server, { orgId: otherOrg, userId: 'former-0002', day: oldest });
    const member = await seated();
    expect(await get(member.session, '/api/me')).toBe(200);
    await settled();
    expect((await rows()).map((row) => row.day).sort()).toEqual([oldest, today()].sort());
    expect(logLines(server).filter((line) => line.msg === 'townwise.activity_days_removed').at(-1)).toMatchObject({ deleted: 1 });

    // Not again that day.
    await addActivityDay(server, { orgId: otherOrg, userId: 'former-0003', day: tooOld });
    const another = await seated();
    expect(await get(another.session, '/api/me')).toBe(200);
    await settled();
    expect((await rows()).map((row) => row.day)).toContain(tooOld);
  });
});
