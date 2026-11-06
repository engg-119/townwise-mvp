// POST /api/access-requests (spec F2, 6.3, 10.2): a signed-in person who is not yet a member asks for access.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MeResponse } from '../src/handlers/me.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import type { OutboundEmail } from '../src/mail/acs.ts';
import { addInvite, addRemovedSeat, addRequest, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { createCapturingTransport } from './helpers/mail.ts';
import {
  call, limiterKey, logLines, MAIL_REPLY_TO, removeStaffFactor, signIn, signInStaff, STAFF_EMAIL, startTownwiseServer,
  type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
const mail = createCapturingTransport();
/** Runs inside the transport's send, before the capturing transport records it. */
let onSend: ((message: OutboundEmail) => Promise<void>) | null = null;

beforeAll(async () => {
  server = await startTownwiseServer({
    mailTransport: {
      send: async (message) => {
        if (onSend !== null) await onSend(message);
        await mail.send(message);
      },
    },
  });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.mailer.idle();
  mail.sent.length = 0;
  onSend = null;
});
afterEach(async () => { await removeStaffFactor(server); });

const PLACE_ID = 'ChIJTestPlace0001';

const VALID = {
  orgName: 'Lou’s Diner Group',
  contactName: 'Lou Sample',
  contactRole: 'Owner',
  town: { townId: 'hanover-nh' },
  locationCount: 2,
  note: 'Two dining rooms and a bar.',
};

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function person(name: string): Promise<{ email: string; session: TestSession }> {
  const email = uniqueEmail(name);
  return { email, session: await signIn(server, email) };
}

function send(session: TestSession, body: unknown): Promise<Response> {
  return call(server, '/api/access-requests', { session, json: body });
}

/** townwise:requests (5 a day) counts every request that passes the policy, valid or not (spec 7.2, 10.8). */
async function resetRequestLimit(session: TestSession): Promise<void> {
  await server.redis.del(limiterKey('townwise:requests', session.userId));
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function requestsOf(userId: string): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_access_requests').find({ userId }).sort({ _id: 1 }).toArray();
}

describe('POST /api/access-requests', () => {
  it('a person with no organization sends a request: 201 with the Waiting state, the stored request and access_request.created', async () => {
    const { email, session } = await person('requester');
    const res = await send(session, VALID);
    expect(res.status).toBe(201);
    const body = await res.json() as MeResponse;
    expect(body.user).toEqual({ id: session.userId, email });
    expect(body.access).toEqual({
      state: 'pending',
      request: {
        id: expect.any(String) as string, orgName: 'Lou’s Diner Group', contactName: 'Lou Sample', contactRole: 'Owner',
        town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, locationCount: 2, note: 'Two dining rooms and a bar.',
        status: 'pending', createdAt: server.clock.now().toISOString(), decidedAt: null, decisionMessage: null, placeId: null,
      },
    });
    const requestId = body.access.state === 'pending' ? body.access.request.id : '';

    const stored = await requestsOf(session.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      _id: new Types.ObjectId(requestId), emailAtRequest: email, status: 'pending', decidedAt: null, decidedBy: null,
      decisionMessage: null, orgId: null, withdrawnReason: null, placeId: null,
    });

    const events = (await auditEvents(server)).filter((event) => (event.target as { id: string }).id === requestId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'access_request.created', actorUserId: session.userId, actorEmail: email, actorRole: 'user',
      viewAsGrantId: null, orgId: null, target: { type: 'request', id: requestId },
    });
    expect(events[0]?.details).toEqual({ orgName: 'Lou’s Diner Group', townId: 'hanover-nh', townName: 'Hanover', hasPlace: false });
  });

  it('stores the picked place, answers it in Waiting, and records only hasPlace', async () => {
    const { session } = await person('placed');
    server.logs.length = 0;
    const res = await send(session, { ...VALID, placeId: PLACE_ID });
    expect(res.status).toBe(201);
    const body = await res.json() as MeResponse;
    expect(body.access).toMatchObject({ state: 'pending', request: { placeId: PLACE_ID } });
    expect(await requestsOf(session.userId)).toMatchObject([{ placeId: PLACE_ID }]);
    const requestId = body.access.state === 'pending' ? body.access.request.id : '';
    const events = (await auditEvents(server)).filter((event) => (event.target as { id: string }).id === requestId);
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toEqual({ orgName: 'Lou’s Diner Group', townId: 'hanover-nh', townName: 'Hanover', hasPlace: true });
    expect(JSON.stringify(events)).not.toContain(PLACE_ID);
    expect(server.logs.join('\n')).not.toContain(PLACE_ID);
  });

  it('an explicit null place is stored as null with hasPlace false', async () => {
    const { session } = await person('nullplace');
    const res = await send(session, { ...VALID, placeId: null });
    expect(res.status).toBe(201);
    expect(await requestsOf(session.userId)).toMatchObject([{ placeId: null }]);
    const body = await res.json() as MeResponse;
    const requestId = body.access.state === 'pending' ? body.access.request.id : '';
    const events = (await auditEvents(server)).filter((event) => (event.target as { id: string }).id === requestId);
    expect(events.map((event) => event.details)).toEqual([{ orgName: 'Lou’s Diner Group', townId: 'hanover-nh', townName: 'Hanover', hasPlace: false }]);
  });

  it('a malformed place ID is 400 invalid_request and nothing is stored', async () => {
    const { session } = await person('badplace');
    for (const placeId of ['', 'short', 'x'.repeat(513), 'ChIJ Test Place', '../ChIJTestPlace0001', ' ChIJTestPlace0001', 12345678901]) {
      await resetRequestLimit(session);
      expect(await errorOf(await send(session, { ...VALID, placeId }))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await requestsOf(session.userId)).toEqual([]);
  });

  it('an address in the body is neither stored nor answered', async () => {
    const { session } = await person('address');
    const address = '1 Sentinel Way, Hanover, NH 03755, USA';
    server.logs.length = 0;
    const res = await send(session, { ...VALID, placeId: PLACE_ID, address, formattedAddress: address, place: { address } });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain('Sentinel Way');
    const stored = await requestsOf(session.userId);
    expect(JSON.stringify(stored)).not.toContain('Sentinel Way');
    expect(Object.keys(stored[0] ?? {})).not.toContain('address');
    expect(JSON.stringify(await auditEvents(server))).not.toContain('Sentinel Way');
    expect(server.logs.join('\n')).not.toContain('Sentinel Way');
  });

  it('stores another town with townId null; an id outside the twelve is 400 unknown_town', async () => {
    const other = await person('other-town');
    const res = await send(other.session, { ...VALID, town: { townId: null, name: '  Hanover Center ', state: 'NH' }, note: '   ' });
    expect(res.status).toBe(201);
    expect((await requestsOf(other.session.userId))[0]).toMatchObject({
      town: { townId: null, name: 'Hanover Center', state: 'NH' }, note: null,
    });

    const unknown = await person('unknown-town');
    expect(await errorOf(await send(unknown.session, { ...VALID, town: { townId: 'springfield-zz' } })))
      .toEqual({ status: 400, error: 'unknown_town' });
    for (const town of [{ townId: null, name: 'Somewhere', state: 'ZZ' }, { townId: null, name: 'Somewhere', state: 'nh' }, { townId: null, name: '', state: 'NH' }, { townId: 7 }]) {
      await resetRequestLimit(unknown.session);
      expect(await errorOf(await send(unknown.session, { ...VALID, town }))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await requestsOf(unknown.session.userId)).toEqual([]);
  });

  it('refuses out-of-range fields with 400 invalid_request and stores nothing', async () => {
    const { session } = await person('invalid');
    const cases = [
      { orgName: 'A' }, { orgName: 'x'.repeat(121) }, { contactName: '  ' }, { contactRole: 'r'.repeat(81) },
      { locationCount: 0 }, { locationCount: 51 }, { locationCount: 1.5 }, { locationCount: '2' },
      { note: 'n'.repeat(1001) }, { town: undefined },
    ];
    for (const change of cases) {
      await resetRequestLimit(session);
      expect(await errorOf(await send(session, { ...VALID, ...change }))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await requestsOf(session.userId)).toEqual([]);
  });

  it('a person whose request was rejected, or who was removed, may send a new request', async () => {
    const rejected = await person('rejected');
    await addRequest(server, { userId: rejected.session.userId, email: rejected.email, status: 'rejected', decidedAt: server.clock.now() });
    expect((await send(rejected.session, VALID)).status).toBe(201);
    expect((await requestsOf(rejected.session.userId)).map((doc) => doc.status)).toEqual(['rejected', 'pending']);

    const removed = await person('removed');
    const orgId = await createOrg(server, { name: 'Former Org' });
    await addRemovedSeat(server, { orgId, userId: removed.session.userId, email: removed.email, removedAt: server.clock.now(), removedBy: 'f'.repeat(24) });
    expect((await send(removed.session, VALID)).status).toBe(201);
  });

  it('is 403 forbidden in every other state: pending, invited, member, paused, and any staff address', async () => {
    const pending = await person('pending');
    await addRequest(server, { userId: pending.session.userId, email: pending.email, status: 'pending' });
    const invited = await person('invited');
    const orgId = await createOrg(server, { name: 'Inviting Org' });
    await addInvite(server, { orgId, email: invited.email, invitedBy: 'f'.repeat(24) });
    const member = await person('member');
    await addSeat(server, { orgId, userId: member.session.userId, email: member.email, role: 'org_admin' });
    const paused = await person('paused');
    const pausedOrg = await createOrg(server, { name: 'Paused Org', status: 'suspended' });
    await addSeat(server, { orgId: pausedOrg, userId: paused.session.userId, email: paused.email });
    const unenrolled = await signIn(server, STAFF_EMAIL);

    for (const session of [pending.session, invited.session, member.session, paused.session, unenrolled]) {
      expect(await errorOf(await send(session, VALID))).toEqual({ status: 403, error: 'forbidden' });
    }
    const staff = await signInStaff(server);
    expect(await errorOf(await send(staff, VALID))).toEqual({ status: 403, error: 'forbidden' });

    expect(await requestsOf(pending.session.userId)).toHaveLength(1);
    for (const userId of [invited.session.userId, member.session.userId, paused.session.userId, staff.userId]) {
      expect(await requestsOf(userId)).toEqual([]);
    }
  });

  it('concurrent requests from one person leave exactly one pending request', async () => {
    const { session } = await person('racer');
    const results = await Promise.all(Array.from({ length: 4 }, () => send(session, VALID)));
    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    for (const res of results.filter((r) => r.status !== 201)) {
      expect([{ status: 409, error: 'request_exists' }, { status: 403, error: 'forbidden' }]).toContainEqual(await errorOf(res));
    }
    expect(await requestsOf(session.userId)).toHaveLength(1);
  });

  it('the sixth request in a day is 429 rate_limited, counted before the body is validated', async () => {
    const { session } = await person('busy');
    await server.redis.set(limiterKey('townwise:requests', session.userId), '5', 'EX', 86400);
    const res = await send(session, VALID);
    expect(await errorOf(res)).toEqual({ status: 429, error: 'rate_limited' });
    expect(await requestsOf(session.userId)).toEqual([]);
  });

  it('logs carry none of the request’s names, role, note or email', async () => {
    const { email, session } = await person('quiet');
    server.logs.length = 0;
    const body = { ...VALID, orgName: 'Sentinel Org Name', contactName: 'Sentinel Contact', contactRole: 'Sentinel Role', note: 'Sentinel note text' };
    expect((await send(session, body)).status).toBe(201);
    const logs = server.logs.join('\n');
    for (const secret of ['Sentinel Org Name', 'Sentinel Contact', 'Sentinel Role', 'Sentinel note text', email]) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe('audit', () => {
  it('every event written here carries only its action’s allowlisted detail keys, and never the note or contact', async () => {
    const events = await auditEvents(server);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[event.action as AuditAction];
      expect(Object.keys(event.details as object).every((key) => allowed.includes(key))).toBe(true);
    }
    const text = JSON.stringify(events);
    for (const secret of ['Two dining rooms', 'Lou Sample', 'Sentinel note text', 'Sentinel Contact']) expect(text).not.toContain(secret);
  });
});

describe('email (spec D14)', () => {
  it('a 201 sends one “request received” to the requester’s address, with Reply-To, after the request is stored', async () => {
    const { email, session } = await person('mailed');
    const storedAtSend: number[] = [];
    onSend = async () => { storedAtSend.push((await requestsOf(session.userId)).length); };
    const res = await send(session, VALID);
    expect(res.status).toBe(201);
    await server.mailer.idle();
    expect(storedAtSend).toEqual([1]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: email, replyTo: MAIL_REPLY_TO, subject: 'We’ve received your Townwise request' });
    expect(mail.sent[0]?.text).toContain('Thanks for telling us about Lou’s Diner Group in Hanover, NH.');
    expect(mail.sent[0]?.text).toContain(`Sign in with the Google account for ${email}.`);
    const sent = logLines(server).filter((line) => line.msg === 'townwise.email_sent' && line.kind === 'request_received');
    expect(sent.at(-1)).toMatchObject({ requestId: String((await requestsOf(session.userId))[0]?._id) });
  });

  it('400, 403, 409 request_exists and 429 send nothing', async () => {
    const { session } = await person('unmailed');
    expect((await send(session, { ...VALID, locationCount: 0 })).status).toBe(400);
    await resetRequestLimit(session);
    expect((await send(session, VALID)).status).toBe(201);
    await server.mailer.idle();
    mail.sent.length = 0;
    expect((await send(session, VALID)).status).toBe(403);   // now pending
    const racer = await person('mail-racer');
    const results = await Promise.all(Array.from({ length: 3 }, () => send(racer.session, VALID)));
    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    const busy = await person('mail-busy');
    await server.redis.set(limiterKey('townwise:requests', busy.session.userId), '5', 'EX', 86400);
    expect((await send(busy.session, VALID)).status).toBe(429);
    await server.mailer.idle();
    expect(mail.sent.map((message) => message.to)).toEqual([racer.email]);
  });

  it('a failed send still answers 201 with the request stored, and logs email_failed with a code, never the address or names', async () => {
    const { email, session } = await person('mail-fails');
    mail.failNext();
    server.logs.length = 0;
    const body = { ...VALID, orgName: 'Sentinel Mail Org', contactName: 'Sentinel Mail Contact' };
    expect((await send(session, body)).status).toBe(201);
    await server.mailer.idle();
    expect(await requestsOf(session.userId)).toHaveLength(1);
    const failed = logLines(server).filter((line) => line.msg === 'townwise.email_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: 'request_received', code: 'upstream_status', status: 500 });
    expect(Object.keys(failed[0] ?? {})).not.toContain('to');

    // And through a success.
    const second = await person('mail-quiet');
    expect((await send(second.session, body)).status).toBe(201);
    await server.mailer.idle();
    const logs = server.logs.join('\n');
    for (const secret of ['Sentinel Mail Org', 'Sentinel Mail Contact', email, second.email, 'Hanover']) expect(logs).not.toContain(secret);
  });
});
