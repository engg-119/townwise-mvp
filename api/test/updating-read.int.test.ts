// D65: the reads that answer whether a forecast is updating stay reads (spec 7.3). A calibration still stored queued 25
// minutes after its request is read as not updating and as a failed last run, never expired: GET /api/org, the sales
// GET and the TownwiseAI GET issue no write and leave its document as it was, for an org admin, a member, staff in
// view-as and staff open as admin. api/test/chain.int.test.ts is not given such a calibration: its every-GET check also
// runs GET /api/admin/orgs/:orgId/calibrations for staff, whose listCalibrations already expires stale records by
// design (a write), so the seed would fail that check for a reason this change does not touch. Synthetic records.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { addGrant, addInvite, addLocation, addOpenAsAdminGrant, addSalesDay, addSeat, createOrg } from './helpers/fixtures.ts';
import {
  call, makeStaff, MINUTE, signIn, startTownwiseServer, STAFF_EMAIL, writesDuring, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

interface Seeded { orgId: string; locationId: string; staleRequestedAt: Date }

/** A location with a day of sales, a calibration that failed two hours ago, and one still stored queued from 25 minutes ago. */
async function seeded(orgId: string, requestedBy: string): Promise<Seeded> {
  const locationId = await addLocation(server, { orgId, name: `Main Street ${randomUUID().slice(0, 4)}` });
  await addSalesDay(server, { orgId, locationId, date: '2026-05-01', guests: 120, netSalesCents: 345_600 });
  const scope = { orgId } as OrgScope;
  const { calibrations } = server.ctx.stores;
  const now = server.clock.now().getTime();
  const queue = async (requestedAt: Date): Promise<string> => {
    const id = new Types.ObjectId().toHexString();
    await calibrations.insertQueued(scope, {
      id, locationId, requestedBy: { userId: requestedBy, role: 'org_admin', via: 'chat' }, regimeStart: null, championRunId: null,
      tokenExpiresAt: new Date(requestedAt.getTime() + 20 * MINUTE), now: requestedAt,
    });
    return id;
  };
  const failed = await queue(new Date(now - 2 * 60 * MINUTE));
  await calibrations.finish(scope, failed, { status: 'failed', failure: 'job_failed' }, new Date(now - 110 * MINUTE));
  const staleRequestedAt = new Date(now - 25 * MINUTE);
  await queue(staleRequestedAt);
  return { orgId, locationId, staleRequestedAt };
}

function calibrationDocs(): Promise<unknown[]> {
  return server.connection.collection('tw_calibrations').find({}).sort({ _id: 1 }).toArray();
}

describe('GETs that answer updating write nothing (D65)', () => {
  it('a timed-out calibration reads as not updating and a failed last run, with no write, for every kind of caller', async () => {
    const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
    const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
    const admin = await signIn(server, adminEmail);
    const member = await signIn(server, memberEmail);
    const orgId = await createOrg(server, { name: 'Read Only Kitchen' });
    await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
    await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
    const joined = await seeded(orgId, admin.userId);

    // Staff viewing as the org admin, and staff with an organization nobody has joined open as its admin (D25).
    const viewing = await signIn(server, STAFF_EMAIL);
    const opened = await signIn(server, STAFF_EMAIL);
    const staff = await signIn(server, STAFF_EMAIL);
    await makeStaff(server, staff.userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });
    await addGrant(server, { actorUserId: viewing.userId, sessionId: viewing.sessionId, targetUserId: admin.userId, orgId });
    const setupOrgId = await createOrg(server, { name: 'Setup Kitchen' });
    await addInvite(server, { orgId: setupOrgId, email: `first-admin-${randomUUID().slice(0, 8)}@example.test`, invitedBy: staff.userId, role: 'org_admin', addedByStaff: true });
    const setup = await seeded(setupOrgId, staff.userId);
    await addOpenAsAdminGrant(server, { actorUserId: opened.userId, sessionId: opened.sessionId, orgId: setupOrgId });

    const before = await calibrationDocs();
    const callers: [string, TestSession, Seeded][] = [
      ['org admin', admin, joined], ['member', member, joined], ['view-as', viewing, joined], ['open as admin', opened, setup],
    ];
    for (const [who, session, place] of callers) {
      const lastRun = {
        outcome: 'not_run', reason: 'failed', finishedAt: new Date(place.staleRequestedAt.getTime() + 20 * MINUTE).toISOString(),
      };
      const answers: Record<string, unknown> = {};
      const writes = await writesDuring(server, async () => {
        for (const path of ['/api/org', `/api/org/locations/${place.locationId}/sales`, `/api/org/locations/${place.locationId}/agent`]) {
          const res = await call(server, path, { session });
          expect({ who, path, status: res.status }).toEqual({ who, path, status: 200 });
          answers[path] = await res.json();
        }
      });
      expect({ who, writes }).toEqual({ who, writes: [] });
      const org = answers['/api/org'] as { locations: { id: string; calibration: unknown }[] };
      expect(org.locations.find((location) => location.id === place.locationId)?.calibration)
        .toMatchObject({ state: 'not_calibrated', updating: null, lastRun });
      expect((answers[`/api/org/locations/${place.locationId}/sales`] as { calibration: unknown }).calibration)
        .toMatchObject({ state: 'not_calibrated', updating: null, lastRun });
    }
    expect(await calibrationDocs()).toEqual(before);
    expect(await server.connection.collection('tw_calibrations').countDocuments({ status: 'queued' })).toBe(2);
  });
});
