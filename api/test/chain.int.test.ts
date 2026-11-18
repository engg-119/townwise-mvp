// The route chain (spec 7.2) and the staff gate (D2), through /api and the test-only /probe table.
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TOWNWISE_ROUTES, type TownwiseRoute } from '../src/access/routes.ts';
import { ORDER_CHANGE_RESULT } from '../src/chat/tools/orders.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import {
  addChatTurn, addConversation, addGrant, addInvite, addLocation, addNote, addOpenAsAdminGrant, addRequest, addSalesDay, addSeat, addUpload, createOrg,
} from './helpers/fixtures.ts';
import { seedReadFile } from './helpers/files.ts';
import { addGoogleConnection, createFakeGoogle, GOOGLE_CLIENT_ID, linkGoogle } from './helpers/google.ts';
import { PROBE_ROUTES } from './helpers/probe.ts';
import {
  call, limiterKey, logLines, makeStaff, MINUTE, refresh, removeStaffFactor, signIn, signInStaff, startTownwiseServer,
  STAFF_EMAIL, writesDuring as writesOf, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;
/** Google calendars on, over the fake client, so the picker's choices (a GET) answer and run through the no-write check. */
const CALENDAR_KEY = createSecretKey(randomBytes(32));
const google = createFakeGoogle();

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({
    probe: PROBE_ROUTES, files: blobs, calendarKey: CALENDAR_KEY, googleCalendar: google.client, googleCalendarClientId: GOOGLE_CLIENT_ID,
    revokeGoogle: google.revoke,
    // Active days are recorded as in production (staff-overview), so the no-write check below sees the chain's one write.
    activity: true,
  });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });
afterEach(async () => { await removeStaffFactor(server); });

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

describe('route table', () => {
  it('every Express route on /api is in TOWNWISE_ROUTES, with no duplicates', () => {
    const mounted: string[] = [];
    for (const layer of server.apiRouter.stack) {
      const route = layer.route as { path: string; methods: Record<string, boolean> } | undefined;
      if (route === undefined) continue;
      for (const method of Object.keys(route.methods)) mounted.push(`${method.toUpperCase()} ${route.path}`);
    }
    const declared = TOWNWISE_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(declared).size).toBe(declared.length);
    expect(mounted.sort()).toEqual([...declared].sort());
  });

  it('a path outside the table reaches server-core’s notFound', async () => {
    const session = await signIn(server, uniqueEmail('lost'));
    expect(await errorOf(await call(server, '/api/nowhere', { session }))).toEqual({ status: 404, error: 'not_found' });
  });
});

/**
 * resumable-chat-turns: an ended turn record of `conversationId`, so the turn's events GET answers at once (it replays the
 * record and stops at its `done`) instead of following a running turn.
 */
async function endedTurn(opts: { orgId: string; locationId: string; conversationId: string; userId: string }): Promise<string> {
  const turnId = await addChatTurn(server, opts);
  await server.connection.collection('tw_chat_turns').updateOne({ turnId }, {
    $set: { state: 'done', endedAt: server.clock.now(), eventCount: 2 },
    $push: { events: { seq: 2, type: 'done', data: { stopReason: 'end_turn', costUsd: 0, leafId: 'reply-node', sources: [] } } },
  } as Record<string, unknown>);
  return turnId;
}

describe('GET is side-effect free (7.3)', () => {
  const WRITES = new Set(['insert', 'update', 'delete', 'findAndModify', 'bulkWrite']);

  async function writesDuring(session: TestSession, path: string): Promise<{ status: number; writes: string[] }> {
    server.commands.length = 0;
    const res = await call(server, path, { session });
    expect(server.commands).toContain('find');   // monitoring is on
    return { status: res.status, writes: server.commands.filter((name) => WRITES.has(name)) };
  }

  it('every GET route issues no write, for an org admin, a member, an invited person with a pending request, staff, staff in view-as, and staff open as admin', async () => {
    const adminEmail = uniqueEmail('admin');
    const admin = await signIn(server, adminEmail);
    const memberEmail = uniqueEmail('member');
    const member = await signIn(server, memberEmail);
    const orgId = await createOrg(server, { name: 'Read Only Org' });
    await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
    await addSeat(server, { orgId, userId: member.userId, email: memberEmail });

    const invitedEmail = uniqueEmail('invited');
    const invited = await signIn(server, invitedEmail);
    await addRequest(server, { userId: invited.userId, email: invitedEmail, status: 'pending' });
    await addInvite(server, { orgId, email: invitedEmail, invitedBy: admin.userId });

    // Three sessions of the staff member: one viewing as the org admin, one with an organization nobody has joined open as
    // its admin (D25), one plain.
    const viewing = await signIn(server, STAFF_EMAIL);
    const opened = await signIn(server, STAFF_EMAIL);
    const staff = await signIn(server, STAFF_EMAIL);
    await makeStaff(server, staff.userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });
    await addGrant(server, { actorUserId: viewing.userId, sessionId: viewing.sessionId, targetUserId: admin.userId, orgId });

    // Every GET runs for every caller; each must also succeed for at least one of them. Path ids name this
    // organization and its location, and the people lookup asks for the member's address.
    const locationId = await addLocation(server, { orgId, name: 'Main Street' });
    await addSalesDay(server, { orgId, locationId, date: '2026-05-01', guests: 120, netSalesCents: 345_600 });
    const uploadId = await addUpload(server, { orgId, locationId, uploadedAt: server.clock.now(), status: 'applied' });
    await addNote(server, { orgId, locationId, detail: 'Closed for a staff day' });
    // D46: a sales history with no Mondays (the panel and the rules page compute a suggested rule from it, writing
    // nothing), an open file suggestion, and an open range that has ended (hidden, never expired by a read).
    const history: Record<string, unknown>[] = [];
    for (let day = '2026-03-02'; day <= '2026-04-30'; day = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)) {
      if (new Date(`${day}T00:00:00.000Z`).getUTCDay() === 1) continue;
      history.push({
        orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), date: day, guests: 90, netSalesCents: null,
        uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
      });
    }
    await server.connection.collection('tw_sales_days').insertMany(history);
    const closureRow = (closureKey: string, content: Record<string, unknown>) => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), week: '2026-06-01', type: 'rule', text: 'Closed', why: null,
      calendarIds: [], status: 'open', decidedBy: null, decidedAt: null, source: 'file', fileId: new Types.ObjectId(), closureKey,
      content: { kind: 'closure', weekdays: null, effect: 'closed', expectedGuests: null, detail: null, startTime: null, endTime: null, ...content },
      createdAt: server.clock.now(), updatedAt: server.clock.now(),
    });
    await server.connection.collection('tw_agent_suggestions').insertMany([
      closureRow('closed|w=2|ongoing', { weekdays: [2], startDate: '2026-06-01', endDate: null }),
      closureRow('closed|w=*|2026-04-01..2026-04-30', { startDate: '2026-04-01', endDate: '2026-04-30' }),
    ]);
    const fileId = await seedReadFile(server, blobs, {
      orgId, locationId, uploadedBy: admin.userId, name: 'sales.csv', raw: Buffer.from('Date\n'), clean: 'date,guests,net_sales\r\n',
    });
    // A ZIP's, so its entries route answers too (with no entries).
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(fileId) }, { $set: { kind: 'zip' } });
    const importId = String((await server.connection.collection('tw_files').findOne({}, { sort: { _id: -1 } }))?.importId);
    // The org admin's conversation, in which TownwiseAI proposed keeping text (D28) and an order change, each shown, so
    // each card's GET answers too. Each card route reads its own call, by its own proposal id.
    const conversationId = await addConversation(server, { orgId, locationId, userId: admin.userId, text: 'Keep our catering list' });
    const proposalId = 'toolu_item0001';
    const orderProposalId = 'toolu_order0001';
    const proposed = [
      {
        role: 'assistant', content: [
          { type: 'tool_use', id: proposalId, name: 'propose_data_item', input: { title: 'Catering list', text: 'Party of 40' } },
          { type: 'tool_use', id: orderProposalId, name: 'propose_order_change', input: { itemId: 'a'.repeat(24), delivery: '2026-06-04' } },
        ],
      },
      {
        role: 'user', content: [
          { type: 'tool_result', tool_use_id: proposalId, content: 'Shown to the owner as a proposal. They decide whether to keep it.' },
          { type: 'tool_result', tool_use_id: orderProposalId, content: ORDER_CHANGE_RESULT },
        ],
      },
    ];
    const routeIds: Record<string, Record<string, string>> = { 'org.chat.order_proposal.get': { proposalId: orderProposalId } };
    await server.connection.collection('tw_chat_conversations').updateOne(
      { _id: new Types.ObjectId(conversationId) },
      { $push: { messages: { $each: proposed.map((param) => ({ at: server.clock.now(), param: JSON.stringify(param) })) } } } as Record<string, unknown>,
    );
    // D28: one item of Your data, the upload's.
    const ref = `u_${uploadId}`;
    // resumable-chat-turns: the org admin's ended turn in that conversation, so its events GET answers (and must write nothing).
    const turnId = await endedTurn({ orgId, locationId, conversationId, userId: admin.userId });
    const ids: Record<string, string> = { orgId, locationId, townId: 'hanover-nh', fileId, importId, conversationId, proposalId, ref, turnId };
    // The member's Google connection, so the picker's choices answer them (connect-google-calendar). The fake's refresh
    // sends no new refresh token, so the list's happy path writes nothing; Google's refusals write nothing either
    // (google-calendars.int.test.ts pins those).
    await linkGoogle(server, member.userId, 'google-subject-chain');
    await addGoogleConnection(server, { orgId, userId: member.userId, key: CALENDAR_KEY });
    const query: Record<string, string> = {
      'admin.people.lookup': `?q=${encodeURIComponent(memberEmail)}`,
      // staff-overview.
      'admin.overview': '?days=28',
      'org.sales.days': '?from=2026-01-01&to=2026-05-31',
      'org.calendar.get': '?from=2026-01-01&to=2026-05-31',
      // U13A.
      'org.people.get': '?from=2026-05-01&to=2026-05-31',
      // U13B.
      'org.forecast.get': '?from=2026-05-01&to=2026-05-31',
      'org.owner_calendars.events': '?from=2026-05-01&to=2026-05-31',
    };
    const getRoutes = TOWNWISE_ROUTES.filter((route) => route.method === 'GET');
    const pathOf = (route: TownwiseRoute, values: Record<string, string>): string => {
      const own = { ...values, ...routeIds[route.id] };
      return `/api${route.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => own[name] ?? '')}${query[route.id] ?? ''}`;
    };
    const gets = getRoutes.map((route) => pathOf(route, ids));
    // The chain's one write on a GET (staff-overview): a member's first request of a UTC day records their active day,
    // and nothing else. Each member's day is recorded here, so every GET below writes nothing.
    for (const session of [admin, member]) {
      const writes = await writesOf(server, async () => {
        expect((await call(server, '/api/me', { session })).status).toBe(200);
        await server.ctx.activity.idle();
      });
      expect(writes).toContain('update tw_activity_days');
      expect(writes.filter((write) => !write.endsWith(' tw_activity_days'))).toEqual([]);
    }
    const answered = new Set<string>();
    for (const session of [admin, member, invited, staff, viewing]) {
      for (const path of gets) {
        const { status, writes } = await writesDuring(session, path);
        expect(writes).toEqual([]);
        if (status === 200) answered.add(path);
      }
    }
    expect([...answered].sort()).toEqual([...gets].sort());

    // Staff open as admin read their own organization, one nobody has joined, with the same records: every GET that runs
    // in that mode answers, and none writes.
    const setupOrgId = await createOrg(server, { name: 'Setup Org' });
    await addInvite(server, { orgId: setupOrgId, email: uniqueEmail('first-admin'), invitedBy: staff.userId, role: 'org_admin', addedByStaff: true });
    const setupLocationId = await addLocation(server, { orgId: setupOrgId, name: 'Setup Street' });
    await addSalesDay(server, { orgId: setupOrgId, locationId: setupLocationId, date: '2026-05-01', guests: 90, netSalesCents: 210_000 });
    const setupUploadId = await addUpload(server, { orgId: setupOrgId, locationId: setupLocationId, uploadedAt: server.clock.now(), status: 'applied' });
    await addNote(server, { orgId: setupOrgId, locationId: setupLocationId, detail: 'Closed for setup', createdBy: staff.userId });
    const setupFileId = await seedReadFile(server, blobs, {
      orgId: setupOrgId, locationId: setupLocationId, uploadedBy: staff.userId, name: 'setup.csv', raw: Buffer.from('Date\n'),
      clean: 'date,guests,net_sales\r\n',
    });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(setupFileId) }, { $set: { kind: 'zip' } });
    const setupImportId = String((await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(setupFileId) }))?.importId);
    // The staff member's own conversation there, with the same proposal to keep text (D28), so its card's GET answers too.
    const setupConversationId = await addConversation(server, {
      orgId: setupOrgId, locationId: setupLocationId, userId: opened.userId, text: 'Keep our setup list',
    });
    await server.connection.collection('tw_chat_conversations').updateOne(
      { _id: new Types.ObjectId(setupConversationId) },
      { $push: { messages: { $each: proposed.map((param) => ({ at: server.clock.now(), param: JSON.stringify(param) })) } } } as Record<string, unknown>,
    );
    await addOpenAsAdminGrant(server, { actorUserId: opened.userId, sessionId: opened.sessionId, orgId: setupOrgId });
    const setupTurnId = await endedTurn({ orgId: setupOrgId, locationId: setupLocationId, conversationId: setupConversationId, userId: opened.userId });
    const setupIds = {
      ...ids, orgId: setupOrgId, locationId: setupLocationId, fileId: setupFileId, importId: setupImportId, conversationId: setupConversationId,
      ref: `u_${setupUploadId}`, turnId: setupTurnId,
    };
    const openedAnswered: string[] = [];
    for (const route of getRoutes) {
      const { status, writes } = await writesDuring(opened, pathOf(route, setupIds));
      expect(writes).toEqual([]);
      if (status === 200) openedAnswered.push(route.id);
    }
    expect(openedAnswered).toEqual(getRoutes.filter((route) => route.openAsAdmin === true).map((route) => route.id));
    for (const session of [member, viewing]) {
      const { status, writes } = await writesDuring(session, '/probe/member');
      expect({ status, writes }).toEqual({ status: 200, writes: [] });
    }
    // GET /api/me never joins and never withdraws the request.
    expect(await server.connection.collection('tw_members').countDocuments({ inviteEmail: invitedEmail, status: 'invited' })).toBe(1);
    expect(await server.connection.collection('tw_access_requests').countDocuments({ userId: invited.userId, status: 'pending' })).toBe(1);
  });
});

describe('townwise:writes and body parsing', () => {
  it('a write refused by policy counts toward townwise:writes and is never parsed: 300 KB to a 256 KB route answers 403, not 413', async () => {
    const session = await signIn(server, uniqueEmail('no-org'));
    const res = await call(server, '/probe/member', { session, rawBody: JSON.stringify({ pad: 'x'.repeat(300 * 1024) }) });
    expect(await errorOf(res)).toEqual({ status: 403, error: 'no_access' });
    expect(await server.redis.get(limiterKey('townwise:writes', session.userId))).toBe('1');
  });

  it('GETs do not count toward townwise:writes', async () => {
    const session = await signIn(server, uniqueEmail('reader'));
    expect((await call(server, '/api/me', { session })).status).toBe(200);
    expect(await server.redis.get(limiterKey('townwise:writes', session.userId))).toBeNull();
  });

  it('the 301st write in 10 minutes is 429 rate_limited, before access is resolved; reads still work', async () => {
    const session = await signIn(server, uniqueEmail('busy'));
    await server.redis.set(limiterKey('townwise:writes', session.userId), '300', 'EX', 600);
    const res = await call(server, '/api/me/join', { session, json: { inviteId: 'f'.repeat(24) } });
    expect(await errorOf(res)).toEqual({ status: 429, error: 'rate_limited' });
    expect(res.headers.get('retry-after')).not.toBeNull();
    expect((await call(server, '/api/me', { session })).status).toBe(200);
  });

  it('a route parses its body only after the policy passes, with its own limit', async () => {
    const session = await signIn(server, uniqueEmail('big-body'));
    const res = await call(server, '/api/me/join', { session, rawBody: JSON.stringify({ inviteId: 'f'.repeat(24), pad: 'x'.repeat(40 * 1024) }) });
    expect(await errorOf(res)).toEqual({ status: 413, error: 'payload_too_large' });
  });

  it('a denial logs townwise.access_denied with the policy and code only', async () => {
    const session = await signIn(server, uniqueEmail('denied'));
    server.logs.length = 0;
    await call(server, '/probe/staff', { session });
    const denied = logLines(server).filter((line) => line.msg === 'townwise.access_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ policy: 'staff', code: 'forbidden' });
  });
});

describe('staff gate (D2)', () => {
  it('a session created before codes were enabled is refused; one created after is accepted', async () => {
    const before = await signIn(server, STAFF_EMAIL);
    await makeStaff(server, before.userId, { enabledAt: new Date(server.clock.now().getTime() + 1000) });
    expect(await errorOf(await call(server, '/probe/staff', { session: before }))).toEqual({ status: 403, error: 'staff_reauth_required' });
    await server.authStores.totp.remove(before.userId);

    const after = await signInStaff(server);
    const res = await call(server, '/probe/staff', { session: after });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'staff', orgId: null, role: null });
  });

  it('after 60 minutes and one second, and a refresh, a staff route answers 403 staff_reauth_required', async () => {
    const session = await signInStaff(server);
    server.clock.advance(60 * MINUTE);
    await refresh(server, session);
    expect((await call(server, '/probe/staff', { session })).status).toBe(200);
    server.clock.advance(1000);
    expect(await errorOf(await call(server, '/probe/staff', { session }))).toEqual({ status: 403, error: 'staff_reauth_required' });
    const me = await (await call(server, '/api/me', { session })).json() as { access: unknown; staff: unknown };
    expect(me).toMatchObject({ access: { state: 'staff_reauth_required', reason: 'session_too_old' }, staff: null });
  });

  it('no factor is staff_setup_required, and a member gets forbidden, never a staff code', async () => {
    const unenrolled = await signIn(server, STAFF_EMAIL);
    expect(await errorOf(await call(server, '/probe/staff', { session: unenrolled }))).toEqual({ status: 403, error: 'staff_setup_required' });
    expect(await errorOf(await call(server, '/probe/staff', { session: unenrolled, json: {} }))).toEqual({ status: 403, error: 'staff_setup_required' });

    const email = uniqueEmail('member');
    const member = await signIn(server, email);
    const orgId = await createOrg(server, { name: 'Gate Org' });
    await addSeat(server, { orgId, userId: member.userId, email, role: 'org_admin' });
    expect(await errorOf(await call(server, '/probe/staff', { session: member }))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await call(server, '/probe/staff', { session: member, json: {} }))).toEqual({ status: 403, error: 'forbidden' });
  });

  it('staff are not members: member routes answer 403 no_access', async () => {
    const staff = await signInStaff(server);
    expect(await errorOf(await call(server, '/probe/member', { session: staff }))).toEqual({ status: 403, error: 'no_access' });
  });
});
