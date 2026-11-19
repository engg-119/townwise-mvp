// D59 (openspec change auto-apply-agent-reads, design decision 13): the organization's switch for TownwiseAI working on
// its own, end to end. Absent reads on; an org admin turns it off and on, each recorded once with its state only; a
// member, staff in view-as and staff open as admin turning it on are refused; GET .../agent shows it, and whether it can
// run here (TOWNWISE_AGENT_AUTO and TownwiseAI reading files). Synthetic organizations only.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import type { FileReaderModel } from '../src/files/extract/reader.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import type { AgentPanel } from '../src/handlers/agent.ts';
import { addGrant, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, logLines, removeStaffFactor, sharedAuthKeys, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const model: FileReaderModel = { readFile: () => Promise.resolve({ kind: 'failed', errType: 'test', status: null }) };

let server: TownwiseTestServer;
let deployOff: TownwiseTestServer;

beforeAll(async () => {
  const keys = sharedAuthKeys();
  deployOff = await startTownwiseServer({ env: { ...keys, TOWNWISE_AGENT_AUTO: 'false' }, files: createMemoryFileBlobs(), aiReader: { model } });
  server = await startTownwiseServer({ env: keys, files: createMemoryFileBlobs(), aiReader: { model }, keepData: true });
});
afterAll(async () => {
  await server.close();
  await deployOff.close();
});
beforeEach(async () => { await server.redis.flushdb(); });
afterEach(async () => {
  await removeStaffFactor(server);
  await server.connection.collection('tw_view_as_grants').deleteMany({});
});

interface Team { orgId: string; admin: TestSession; member: TestSession; locationId: string }

async function person(orgId: string, role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

async function team(): Promise<Team> {
  const orgId = await createOrg(server, { name: `Auto Kitchen ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, admin: await person(orgId, 'org_admin'), member: await person(orgId, 'member'), locationId };
}

function switchTo(session: TestSession, body: unknown, on: TownwiseTestServer = server): Promise<Response> {
  return call(on, '/api/org/agent-auto', { method: 'PATCH', session, json: body });
}

async function panel(t: Team, session: TestSession, on: TownwiseTestServer = server): Promise<AgentPanel> {
  const res = await call(on, `/api/org/locations/${t.locationId}/agent`, { session });
  expect(res.status).toBe(200);
  return await res.json() as AgentPanel;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

async function orgDoc(orgId: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(orgId) });
}

async function switchEvents(t: Team): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => event.action === 'org.agent_auto_switched' && String(event.orgId) === t.orgId);
}

describe('TownwiseAI works on its own (D59)', () => {
  it('reads as on for an organization that never set it; an org admin turns it off and back on, each recorded once with its state only', async () => {
    const t = await team();
    expect((await orgDoc(t.orgId))?.agentAuto).toBeUndefined();
    expect((await panel(t, t.member)).agentAuto).toEqual({ on: true, available: true, canChange: false });
    expect((await panel(t, t.admin)).agentAuto).toEqual({ on: true, available: true, canChange: true });
    const off = await switchTo(t.admin, { on: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ agentAuto: { on: false } });
    expect(await orgDoc(t.orgId)).toMatchObject({ agentAuto: { on: false, by: t.admin.userId } });
    expect((await panel(t, t.member)).agentAuto.on).toBe(false);
    expect((await server.ctx.stores.orgs.findById(t.orgId))?.agentAuto.on).toBe(false);
    // The same state again writes nothing.
    expect((await switchTo(t.admin, { on: false })).status).toBe(200);
    expect((await switchTo(t.admin, { on: true })).status).toBe(200);
    expect((await panel(t, t.member)).agentAuto.on).toBe(true);
    const events = await switchEvents(t);
    expect(events.map((event) => event.details)).toEqual([{ on: false }, { on: true }]);
    expect(events[0]).toMatchObject({ actorUserId: t.admin.userId, actorRole: 'org_admin', target: { type: 'org', id: t.orgId } });
    expect(logLines(server).filter((line) => line.msg === 'townwise.agent_auto_switched').at(-1)).toEqual(
      expect.objectContaining({ orgId: t.orgId, on: true }),
    );
    // The other switches are their own.
    expect((await orgDoc(t.orgId))?.weeklySuggestions).toBeUndefined();
    expect((await orgDoc(t.orgId))?.calendarTitlesToAi).toBeUndefined();
  });

  it('refuses a member (403), anything but { on } (400), and staff in view-as (403 view_as_read_only), changing nothing', async () => {
    const t = await team();
    expect(await errorOf(await switchTo(t.member, { on: false }))).toEqual({ status: 403, error: 'forbidden' });
    for (const body of [{}, { on: 'no' }, { on: false, files: [] }]) expect((await switchTo(t.admin, body)).status).toBe(400);
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.admin.userId, orgId: t.orgId });
    expect(await errorOf(await switchTo(staff, { on: false }))).toEqual({ status: 403, error: 'view_as_read_only' });
    // Staff viewing as the admin read the switch, and may not change it.
    expect((await panel(t, staff)).agentAuto).toEqual({ on: true, available: true, canChange: false });
    expect((await orgDoc(t.orgId))?.agentAuto).toBeUndefined();
    expect(await switchEvents(t)).toEqual([]);
  });

  it('staff open as admin turn it off with the tab’s orgId, and are refused turning it on (403 open_as_admin_refused)', async () => {
    const t = await team();
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: t.orgId });
    expect(await errorOf(await switchTo(staff, { on: false }))).toEqual({ status: 409, error: 'open_as_admin_active' });
    expect((await switchTo(staff, { on: false, orgId: t.orgId })).status).toBe(200);
    expect(await errorOf(await switchTo(staff, { on: true, orgId: t.orgId }))).toEqual({ status: 403, error: 'open_as_admin_refused' });
    expect(await orgDoc(t.orgId)).toMatchObject({ agentAuto: { on: false, by: staff.userId } });
    expect((await switchEvents(t)).map((event) => [event.actorRole, event.details])).toEqual([['superadmin', { on: false }]]);
    await removeStaffFactor(server);
    await server.connection.collection('tw_view_as_grants').deleteMany({});
    // The organization's own admin turns it back on.
    expect((await switchTo(t.admin, { on: true })).status).toBe(200);
    expect((await panel(t, t.admin)).agentAuto.on).toBe(true);
  });

  it('is not available while TOWNWISE_AGENT_AUTO is false, whatever the organization’s switch says', async () => {
    const t = await team();
    expect((await panel(t, t.admin, deployOff)).agentAuto).toEqual({ on: true, available: false, canChange: true });
    expect(deployOff.ctx.config.agentAuto).toBe(false);
    expect(server.ctx.config.agentAuto).toBe(true);
  });

  it('a deleted org admin’s id is cleared from the switch, which stays as it was', async () => {
    const t = await team();
    const at = server.clock.now();
    expect(await server.ctx.stores.orgs.setAgentAuto({ orgId: t.orgId } as OrgScope, { on: false, at, by: t.admin.userId })).toBe(true);
    const { deletePersonRecords } = await import('../src/stores/cross-tenant.ts');
    await deletePersonRecords(server.connection, { userId: t.admin.userId, email: 'gone@example.test' });
    expect((await orgDoc(t.orgId))?.agentAuto).toEqual({ on: false, at, by: null });
  });
});
