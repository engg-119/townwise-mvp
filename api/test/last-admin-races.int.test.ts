// The last-admin rule under concurrent requests (spec 3, F6, F7, 9.3). A demotion and a removal of the same sole admin's
// seat, interleaved at their recounts in both orders, never leave the organization without an active admin, and each
// answer and record says what happened. Each handler writes, then recounts (TwMember.countDocuments); a hold on that
// count places the other request between the two steps.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MeResponse } from '../src/handlers/me.ts';
import { addInvite, addSeat, auditEvents, createOrg, memberDoc } from './helpers/fixtures.ts';
import { holdCalls, type Hold } from './helpers/hold.ts';
import {
  call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let staff: TestSession;
let held: Hold[] = [];

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  staff = await signInStaff(server);
});
afterEach(async () => {
  for (const hold of held) hold.restore();
  held = [];
  await removeStaffFactor(server);
});

function hold(): Hold {
  const counts = holdCalls(server, 'countDocuments');
  held.push(counts);
  return counts;
}

interface SoleAdmin { orgId: string; email: string; session: TestSession; seat: string }

async function soleAdmin(name: string): Promise<SoleAdmin> {
  const orgId = await createOrg(server, { name });
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  const seat = await addSeat(server, { orgId, userId: session.userId, email, role: 'org_admin' });
  return { orgId, email, session, seat };
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

async function activeAdmins(orgId: string): Promise<number> {
  return server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(orgId), status: 'active', role: 'org_admin' });
}

/** Each event about this seat as [action, not_applied code]; a staff_action.not_applied event carries its event's target. */
async function actionsFor(seat: string): Promise<unknown[][]> {
  return (await auditEvents(server))
    .filter((event) => (event.target as { id: string }).id === seat)
    .map((event) => [event.action, (event.details as { code?: string }).code ?? null]);
}

interface Step { readonly name: string; readonly byStaff: boolean; readonly run: (admin: SoleAdmin) => Promise<Response> }

const staffDemote: Step = {
  name: 'staff demotion', byStaff: true,
  run: (a) => call(server, `/api/admin/orgs/${a.orgId}/members/${a.seat}`, { method: 'PATCH', session: staff, json: { role: 'member' } }),
};
const selfDemote: Step = {
  name: 'self-demotion', byStaff: false,
  run: (a) => call(server, `/api/org/members/${a.seat}`, { method: 'PATCH', session: a.session, json: { role: 'member' } }),
};
const selfLeave: Step = { name: 'leaving', byStaff: false, run: (a) => call(server, '/api/org/leave', { session: a.session, json: {} }) };
const staffRemove: Step = {
  name: 'staff removal', byStaff: true,
  run: (a) => call(server, `/api/admin/orgs/${a.orgId}/members/${a.seat}`, { method: 'DELETE', session: staff }),
};
const selfRemove: Step = {
  name: 'self-removal on Team', byStaff: false, run: (a) => call(server, `/api/org/members/${a.seat}`, { method: 'DELETE', session: a.session }),
};

/** The removal runs whole while the demotion waits to recount. */
async function removalSettlesFirst(demote: () => Promise<Response>, remove: () => Promise<Response>): Promise<[Response, Response]> {
  const counts = hold();
  const demoted = demote();
  await Promise.race([counts.arrived(1), demoted]);   // the demotion has written
  counts.release(2);                                   // the removal recounts at once
  const removed = await remove();
  counts.open();
  return [await demoted, removed];
}

/** Both write before either recounts; the demotion then settles before the removal recounts. */
async function demotionSettlesFirst(demote: () => Promise<Response>, remove: () => Promise<Response>): Promise<[Response, Response]> {
  const counts = hold();
  const demoted = demote();
  await Promise.race([counts.arrived(1), demoted]);   // the demotion has written
  const removed = remove();
  await Promise.race([counts.arrived(2), removed]);   // the removal has written too
  counts.release(1);
  const demotedRes = await demoted;
  counts.open();
  return [demotedRes, await removed];
}

// Removing oneself on Team can't join these: once the demotion has written, the org_admin policy refuses it (403).
const interleavings: [Step, Step][] = [[staffDemote, selfLeave], [selfDemote, selfLeave], [selfDemote, staffRemove]];

describe('a demotion and a removal of the sole admin, interleaved at their recounts', () => {
  for (const [demotion, removal] of interleavings) {
    for (const order of [removalSettlesFirst, demotionSettlesFirst]) {
      const settling = order === removalSettlesFirst ? 'the removal' : 'the demotion';
      it(`${demotion.name} with ${removal.name}, ${settling} settling first: both 409 last_admin, and the admin keeps the seat`, async () => {
        const admin = await soleAdmin(`Race ${demotion.name} ${removal.name}`);
        const [demoted, removed] = await order(() => demotion.run(admin), () => removal.run(admin));
        expect(await errorOf(demoted)).toEqual({ status: 409, error: 'last_admin' });
        expect(await errorOf(removed)).toEqual({ status: 409, error: 'last_admin' });
        expect(await activeAdmins(admin.orgId)).toBe(1);
        expect(await memberDoc(server, admin.seat)).toMatchObject({
          status: 'active', role: 'org_admin', activeUserId: admin.session.userId, removedAt: null, removedBy: null,
        });
        // Client actions record nothing that did not happen; each staff event is followed by not_applied last_admin.
        const expected: unknown[][] = [];
        if (demotion.byStaff) expected.push(['member.role_changed', null], ['staff_action.not_applied', 'last_admin']);
        if (removal.byStaff) expected.push(['member.removed', null], ['staff_action.not_applied', 'last_admin']);
        expect((await actionsFor(admin.seat)).sort()).toEqual(expected.sort());
      });
    }
  }
});

describe('a seat that can’t be put back because the person joined another organization meanwhile', () => {
  /** The sole admin's seat is removed; before the recount, they join another organization that invited them. */
  async function joinElsewhereBeforeRecount(remove: Step): Promise<{ admin: SoleAdmin; otherOrg: string; res: Response }> {
    const admin = await soleAdmin('Left Behind Org');
    const otherOrg = await createOrg(server, { name: 'New Home Org' });
    const inviteId = await addInvite(server, { orgId: otherOrg, email: admin.email, invitedBy: 'f'.repeat(24) });
    const counts = hold();
    const removed = remove.run(admin);
    await Promise.race([counts.arrived(1), removed]);   // the seat is removed; the recount waits
    expect((await call(server, '/api/me/join', { session: admin.session, json: { inviteId } })).status).toBe(200);
    counts.open();
    return { admin, otherOrg, res: await removed };
  }

  async function expectRemovedAndJoined(admin: SoleAdmin, otherOrg: string): Promise<void> {
    expect(await memberDoc(server, admin.seat)).toMatchObject({ status: 'removed' });
    const me = await (await call(server, '/api/me', { session: admin.session })).json() as MeResponse;
    expect(me.access).toMatchObject({ state: 'member', org: { id: otherOrg } });
  }

  it('leaving stands: 200, recorded as member.left', async () => {
    const { admin, otherOrg, res } = await joinElsewhereBeforeRecount(selfLeave);
    expect(res.status).toBe(200);
    await expectRemovedAndJoined(admin, otherOrg);
    expect((await actionsFor(admin.seat)).map(([action]) => action)).toEqual(['member.left']);
  });

  it('a staff removal stands: 204, with no staff_action.not_applied', async () => {
    const { admin, otherOrg, res } = await joinElsewhereBeforeRecount(staffRemove);
    expect(res.status).toBe(204);
    await expectRemovedAndJoined(admin, otherOrg);
    expect(await actionsFor(admin.seat)).toEqual([['member.removed', null]]);
  });

  it('an org admin removing themself stands: 204, recorded as member.removed', async () => {
    const { admin, otherOrg, res } = await joinElsewhereBeforeRecount(selfRemove);
    expect(res.status).toBe(204);
    await expectRemovedAndJoined(admin, otherOrg);
    expect((await actionsFor(admin.seat)).map(([action]) => action)).toEqual(['member.removed']);
  });
});
