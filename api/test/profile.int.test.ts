// The display name's server side (spec 6.22, 10.2, 17): the approved requester's prefill, the one-time ask, PATCH,
// view-as, and that the name never reaches a log or an audit event.
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MeResponse } from '../src/handlers/me.ts';
import { addInvite } from './helpers/fixtures.ts';
import {
  call, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let staff: TestSession;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  staff = await signInStaff(server);
});
afterEach(async () => { await server.authStores.totp.remove(staff.userId); });

const ORG_NAME = 'Harbor Kitchen';

interface Owner { email: string; session: TestSession; orgId: string }
interface ProfileBody { displayName: string | null; askName: boolean }

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function approvedOwner(name: string, contactName: string): Promise<Owner> {
  const email = uniqueEmail(name);
  const session = await signIn(server, email);
  const sent = await call(server, '/api/access-requests', {
    session,
    json: {
      orgName: 'Harbor Kitchen Group', contactName, contactRole: 'General manager',
      town: { townId: 'bar-harbor-me' }, locationCount: 1, note: null,
    },
  });
  expect(sent.status).toBe(201);
  const sentMe = await sent.json() as MeResponse;
  if (sentMe.access.state !== 'pending') throw new Error('expected pending');
  const approved = await call(server, `/api/admin/requests/${sentMe.access.request.id}/approve`, {
    session: staff, json: { orgName: ORG_NAME, locationName: 'Main Street' },
  });
  expect(approved.status).toBe(200);
  const body = await approved.json() as { org: { id: string } };
  return { email, session, orgId: body.org.id };
}

async function teammateOf(owner: Owner): Promise<TestSession> {
  const email = uniqueEmail('teammate');
  const session = await signIn(server, email);
  const inviteId = await addInvite(server, { orgId: owner.orgId, email, invitedBy: owner.session.userId });
  expect((await call(server, '/api/me/join', { session, json: { inviteId } })).status).toBe(200);
  return session;
}

async function getProfile(session: TestSession): Promise<ProfileBody> {
  const res = await call(server, '/api/me/profile', { session });
  expect(res.status).toBe(200);
  return await res.json() as ProfileBody;
}

function patchRaw(session: TestSession, json: unknown): Promise<Response> {
  return call(server, '/api/me/profile', { method: 'PATCH', session, json });
}

async function patch(session: TestSession, json: unknown): Promise<ProfileBody> {
  const res = await patchRaw(session, json);
  expect(res.status).toBe(200);
  return await res.json() as ProfileBody;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function profiles(filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection('tw_profiles').countDocuments(filter);
}

describe('GET /api/me/profile', () => {
  it('prefills the approved requester’s first name and does not ask', async () => {
    const requester = await approvedOwner('requester', 'Cameron Sample');
    expect(await getProfile(requester.session)).toEqual({ displayName: 'Cameron', askName: false });
  });

  it('asks an invited teammate, and a requester whose contact name starts with an honorific', async () => {
    const owner = await approvedOwner('owner', 'Pat Sample');
    expect(await getProfile(await teammateOf(owner))).toEqual({ displayName: null, askName: true });
    const drSmith = await approvedOwner('dr-smith', 'Dr Smith');
    expect(await getProfile(drSmith.session)).toEqual({ displayName: null, askName: true });
  });

  it('a stored name wins over the request’s, and GET writes nothing', async () => {
    const owner = await approvedOwner('stored', 'Pat Sample');
    expect(await profiles({ userId: owner.session.userId })).toBe(0);
    await getProfile(owner.session);
    expect(await profiles({ userId: owner.session.userId })).toBe(0);
    await patch(owner.session, { displayName: 'Patricia' });
    expect(await getProfile(owner.session)).toEqual({ displayName: 'Patricia', askName: false });
  });

  it('answers 403 no_access with no organization', async () => {
    const session = await signIn(server, uniqueEmail('nobody'));
    expect(await errorOf(await call(server, '/api/me/profile', { session }))).toEqual({ status: 403, error: 'no_access' });
  });
});

describe('PATCH /api/me/profile', () => {
  it('sets, changes and clears the name; null answers Not now, so it never asks again', async () => {
    const owner = await approvedOwner('patcher', 'Pat Sample');
    const teammate = await teammateOf(owner);
    expect(await patch(teammate, { displayName: '  Sam   Lee ' })).toEqual({ displayName: 'Sam Lee', askName: false });
    expect(await getProfile(teammate)).toEqual({ displayName: 'Sam Lee', askName: false });
    expect(await patch(teammate, { displayName: 'Sam' })).toEqual({ displayName: 'Sam', askName: false });
    expect(await patch(teammate, { displayName: null })).toEqual({ displayName: null, askName: false });
    expect(await getProfile(teammate)).toEqual({ displayName: null, askName: false });
    expect(await profiles({ userId: teammate.userId })).toBe(1);
  });

  it('null also overrides the requester’s prefill: no name', async () => {
    const owner = await approvedOwner('opt-out', 'Pat Sample');
    expect(await patch(owner.session, { displayName: null })).toEqual({ displayName: null, askName: false });
    expect(await getProfile(owner.session)).toEqual({ displayName: null, askName: false });
  });

  it('refuses an invalid name with 400 and an extra key with 400, writing nothing', async () => {
    const owner = await approvedOwner('invalid', 'Pat Sample');
    for (const json of [{ displayName: 'Pat2' }, { displayName: '' }, { displayName: 'a'.repeat(41) }, { displayName: 7 }, {}, { displayName: 'Pat', extra: 1 }]) {
      expect(await errorOf(await patchRaw(owner.session, json))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await profiles({ userId: owner.session.userId })).toBe(0);
  });
});

describe('view-as', () => {
  it('reads the target’s name with askName false and cannot write (403)', async () => {
    const owner = await approvedOwner('viewed', 'Pat Sample');
    const teammate = await teammateOf(owner);
    await patch(teammate, { displayName: 'Sam' });
    const started = await call(server, '/api/admin/view-as', {
      session: staff, json: { userId: teammate.userId, reason: 'Checking the greeting' },
    });
    expect(started.status).toBe(201);
    expect(await getProfile(staff)).toEqual({ displayName: 'Sam', askName: false });
    expect(await errorOf(await patchRaw(staff, { displayName: 'Changed' }))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect((await call(server, '/api/admin/view-as/end', { session: staff, json: {} })).status).toBe(200);
    // A target with no name is never asked under view-as.
    const other = await teammateOf(owner);
    expect((await call(server, '/api/admin/view-as', {
      session: staff, json: { userId: other.userId, reason: 'Checking the prompt' },
    })).status).toBe(201);
    expect(await getProfile(staff)).toEqual({ displayName: null, askName: false });
    expect(await getProfile(teammate)).toEqual({ displayName: 'Sam', askName: false });
  });
});

describe('privacy', () => {
  it('never logs the name: request logs carry the route, never the body, and no audit event names it', async () => {
    const owner = await approvedOwner('quiet', 'Quintessa Sample');
    server.logs.length = 0;
    expect(await getProfile(owner.session)).toEqual({ displayName: 'Quintessa', askName: false });
    await patch(owner.session, { displayName: 'Zebulon' });
    const logged = server.logs.join('\n');
    expect(logged).toContain('/api/me/profile');
    expect(logged).not.toContain('Quintessa');
    expect(logged).not.toContain('Zebulon');
    const events = await server.connection.collection('tw_audit_events').find({ actorUserId: owner.session.userId }).toArray();
    expect(JSON.stringify(events)).not.toContain('Zebulon');
    expect(events.filter((event) => String(event.action).includes('profile'))).toEqual([]);
  });
});
