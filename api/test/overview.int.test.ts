// GET /api/admin/overview (openspec change staff-overview, design decisions 4 and 5): the staff policy and the window
// check, the totals and series against seeded active days and audit events (staff setup's uploads count, staff opened
// as admin and the system never do), each organization's own row with its forecast line, Needs attention from the
// database, and an answer that holds no sales figure, guest count, note text, chat text or member email. Every figure
// here is synthetic.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addActivityDay, addAuditEvent, addChatUsage, addConversation, addGrant, addInvite, addLocation, addNote, addOpenAsAdminGrant,
  addRequest, addSalesDay, addSeat, addUpload, createOrg,
} from './helpers/fixtures.ts';
import {
  call, logLines, makeStaff, MINUTE, removeStaffFactor, signIn, signInStaff, STAFF_EMAIL, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const DAY = 24 * 60 * MINUTE;
const RUN = JSON.parse(readFileSync(new URL('fixtures/forecast-run.json', import.meta.url), 'utf8')) as Record<string, unknown>;

let server: TownwiseTestServer;
let staff: TestSession;

// The clock stays at 2026-06-01T12:00Z: the 7-day window is 2026-05-26 to 2026-06-01, the one before 05-19 to 05-25.
beforeAll(async () => { server = await startTownwiseServer({ env: { TOWNWISE_CHAT_MONTHLY_BUDGET_USD: '20' } }); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  const db = server.connection.db;
  if (db === undefined) throw new Error('not connected');
  for (const { name } of await db.listCollections().toArray()) {
    if (name.startsWith('tw_')) await db.collection(name).deleteMany({});
  }
  staff = await signInStaff(server);
});
afterEach(async () => { await removeStaffFactor(server); });

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

interface Overview {
  window: Record<string, unknown>;
  recordingSince: string | null;
  totals: Record<string, { count: number; previous: number | null; of?: number }>;
  series: { day: string; activePeople: number; actions: Record<string, number> }[];
  schedule: unknown;
  orgs: {
    id: string; name: string; status: string; inSetup: boolean; lastActiveDay: string | null; activePeople: number; actions: number;
    salesDayCount: number; lastUploadAt: string | null; forecastsOn: boolean; chat: { spentMicroUsd: number; budgetMicroUsd: number };
    locations: { id: string; name: string; newestRun: unknown; accuracy: unknown; refresh: unknown; lastScheduled: unknown }[];
  }[];
  attention: { kind: string; orgId: string | null; requestId: string | null; count: number | null; since: string | null }[];
}

async function overview(days = '7'): Promise<{ body: Overview; text: string }> {
  const res = await call(server, `/api/admin/overview?days=${days}`, { session: staff });
  expect(res.status).toBe(200);
  const text = await res.text();
  return { body: JSON.parse(text) as Overview, text };
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

/** Every number anywhere in a JSON value. */
function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
  return [];
}

/** An active organization someone joined: an org admin and a member, each signed in, and a location. */
async function joinedOrg(name: string, opts: { forecastsOn?: boolean } = {}) {
  const adminEmail = uniqueEmail('admin');
  const memberEmail = uniqueEmail('member');
  const admin = await signIn(server, adminEmail);
  const member = await signIn(server, memberEmail);
  const orgId = await createOrg(server, { name, ...(opts.forecastsOn === undefined ? {} : { forecastsOn: opts.forecastsOn }) });
  await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
  const locationId = await addLocation(server, { orgId, name: `${name} Main Room` });
  return { orgId, locationId, admin, member, adminEmail, memberEmail };
}

const at = (day: string, hour = 12): Date => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);

describe('GET /api/admin/overview', () => {
  it('answers 403 to a member and an org admin, 409 in view-as and open as admin, and 400 for any window but 7, 28 or 90 days', async () => {
    const org = await joinedOrg('Policy Tavern');
    expect((await call(server, '/api/admin/overview?days=7', { session: org.member })).status).toBe(403);
    expect((await call(server, '/api/admin/overview?days=7', { session: org.admin })).status).toBe(403);

    // Two more sessions of the staff member, signed in before their codes are set up again: one viewing as the org admin,
    // one with an organization nobody joined open as its admin.
    await removeStaffFactor(server);
    const viewing = await signIn(server, STAFF_EMAIL);
    const opened = await signIn(server, STAFF_EMAIL);
    await makeStaff(server, staff.userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });
    await addGrant(server, { actorUserId: viewing.userId, sessionId: viewing.sessionId, targetUserId: org.admin.userId, orgId: org.orgId });
    expect(await errorOf(await call(server, '/api/admin/overview?days=7', { session: viewing }))).toEqual({ status: 409, error: 'view_as_active' });
    const setupOrgId = await createOrg(server, { name: 'Policy Setup Cafe' });
    await addOpenAsAdminGrant(server, { actorUserId: opened.userId, sessionId: opened.sessionId, orgId: setupOrgId });
    expect(await errorOf(await call(server, '/api/admin/overview?days=7', { session: opened }))).toEqual({ status: 409, error: 'open_as_admin_active' });

    for (const query of ['?days=10', '', '?days=7d', '?days=28&days=90']) {
      expect({ query, status: (await call(server, `/api/admin/overview${query}`, { session: staff })).status }).toEqual({ query, status: 400 });
    }
    for (const days of ['7', '28', '90']) expect((await overview(days)).body.window).toMatchObject({ days: Number(days) });
  });

  it('counts people’s actions and active days in the window and the one before; staff setup’s uploads count, staff opened as admin and the system never do', async () => {
    const a = await joinedOrg('Actor Rule Pub');
    // In setup: nobody has joined it.
    const b = await createOrg(server, { name: 'Setup Rule Diner' });
    await addLocation(server, { orgId: b, name: 'Setup Room' });
    const grantId = new Types.ObjectId().toHexString();
    await addActivityDay(server, { orgId: a.orgId, userId: a.admin.userId, day: '2026-06-01' });
    await addActivityDay(server, { orgId: a.orgId, userId: a.member.userId, day: '2026-05-31' });
    await addActivityDay(server, { orgId: a.orgId, userId: a.admin.userId, day: '2026-05-20' });
    await addActivityDay(server, { orgId: a.orgId, userId: a.member.userId, day: '2026-05-10' });
    const event = (orgId: string, action: string, when: Date, actor: { actorRole: string; viewAsGrantId?: string | null }) =>
      addAuditEvent(server, { at: when, orgId, action, details: {}, ...actor });
    await event(a.orgId, 'chat.turn_completed', at('2026-06-01', 10), { actorRole: 'member' });
    await event(a.orgId, 'sales.uploaded', at('2026-05-31', 9), { actorRole: 'org_admin' });
    await event(a.orgId, 'note.created', at('2026-05-21'), { actorRole: 'org_admin' });
    // Staff setup's upload (D23): staff, no grant. It counts.
    await event(b, 'sales.uploaded', at('2026-05-30'), { actorRole: 'superadmin', viewAsGrantId: null });
    // Never counted: staff opened as admin (a grant id), staff setup's other writes, and the system.
    await event(a.orgId, 'sales.uploaded', at('2026-05-30'), { actorRole: 'superadmin', viewAsGrantId: grantId });
    await event(a.orgId, 'note.created', at('2026-05-30'), { actorRole: 'superadmin', viewAsGrantId: grantId });
    await event(b, 'location.created', at('2026-05-30'), { actorRole: 'superadmin', viewAsGrantId: null });
    await event(a.orgId, 'calibration.scheduled', at('2026-05-30'), { actorRole: 'system' });
    await event(a.orgId, 'order.decision_saved', at('2026-05-29'), { actorRole: 'system' });

    const { body } = await overview('7');
    expect(body.window).toEqual({ days: 7, from: '2026-05-26', to: '2026-06-01', previousFrom: '2026-05-19', previousTo: '2026-05-25' });
    expect(body.recordingSince).toBe('2026-05-10');
    expect(body.totals).toEqual({
      activeOrgs: { count: 1, previous: 1, of: 1 },
      activePeople: { count: 2, previous: 1, of: 2 },
      chatTurns: { count: 1, previous: 0 },
      salesUploads: { count: 2, previous: 0 },
      notesWritten: { count: 0, previous: 1 },
      orderDecisions: { count: 0, previous: 0 },
    });
    const zero = { uploads: 0, notes: 0, townwiseAi: 0, orders: 0, team: 0 };
    expect(body.series).toEqual([
      { day: '2026-05-26', activePeople: 0, actions: zero },
      { day: '2026-05-27', activePeople: 0, actions: zero },
      { day: '2026-05-28', activePeople: 0, actions: zero },
      { day: '2026-05-29', activePeople: 0, actions: zero },
      { day: '2026-05-30', activePeople: 0, actions: { ...zero, uploads: 1 } },
      { day: '2026-05-31', activePeople: 1, actions: { ...zero, uploads: 1 } },
      { day: '2026-06-01', activePeople: 1, actions: { ...zero, townwiseAi: 1 } },
    ]);
    expect(body.orgs.map(({ id, inSetup, activePeople, actions, lastActiveDay }) => ({ id, inSetup, activePeople, actions, lastActiveDay }))).toEqual([
      { id: a.orgId, inSetup: false, activePeople: 2, actions: 2, lastActiveDay: '2026-06-01' },
      // Staff setup adds uploads, never active people.
      { id: b, inSetup: true, activePeople: 0, actions: 1, lastActiveDay: null },
    ]);
  });

  it('gives each organization its own row, its forecast line with the window’s live accuracy, and no figure, note, chat or member email', async () => {
    const x = await joinedOrg('Sentinel Harbor Grill', { forecastsOn: true });
    const y = await joinedOrg('Quiet Birch Cafe');
    await addLocation(server, { orgId: y.orgId, name: 'Quiet Birch Patio' });
    // X's figures, notes and chats: sentinels no answer may carry.
    await addSalesDay(server, { orgId: x.orgId, locationId: x.locationId, date: '2026-04-20', guests: 4321, netSalesCents: 98_765_432 });
    await addUpload(server, { orgId: x.orgId, locationId: x.locationId, uploadedAt: new Date(server.clock.now().getTime() - DAY), status: 'applied' });
    await addNote(server, { orgId: x.orgId, locationId: x.locationId, detail: 'Sentinel note text about the closing' });
    await addConversation(server, { orgId: x.orgId, locationId: x.locationId, userId: x.member.userId, text: 'Sentinel chat text about the menu' });
    await addChatUsage(server, { orgId: x.orgId, month: '2026-06', costMicroUsd: 1_250_000 });
    await addAuditEvent(server, { at: at('2026-05-31'), orgId: x.orgId, action: 'member.invited', actorRole: 'org_admin', actorEmail: x.adminEmail, details: { email: x.memberEmail, role: 'member' } });
    await addActivityDay(server, { orgId: x.orgId, userId: x.member.userId, day: '2026-05-31' });
    await addActivityDay(server, { orgId: y.orgId, userId: y.admin.userId, day: '2026-05-30' });
    // A published run (the fixture forecasts May 1 to 14 at 100 guests, 80 to 120, closed May 4 and 11) and actuals on six
    // open days of the 28-day window (May 4 to 31 in Hanover): one out of range. 41 guests off of 633 is 6.5%.
    for (const [date, guests] of [['2026-05-05', 99], ['2026-05-06', 103], ['2026-05-07', 97], ['2026-05-08', 102], ['2026-05-09', 131], ['2026-05-10', 101]] as const) {
      await addSalesDay(server, { orgId: x.orgId, locationId: x.locationId, date, guests, netSalesCents: guests * 1000 + 7 });
    }
    const imported = await call(server, `/api/admin/orgs/${x.orgId}/locations/${x.locationId}/forecast-runs`, { session: staff, json: RUN });
    expect(imported.status).toBe(201);
    const runId = (await imported.json() as { run: { id: string } }).run.id;
    expect((await call(server, `/api/admin/orgs/${x.orgId}/forecast-runs/${runId}/publish`, { session: staff, json: {} })).status).toBe(200);

    const { body, text } = await overview('28');
    const rowX = body.orgs.find((row) => row.id === x.orgId);
    const rowY = body.orgs.find((row) => row.id === y.orgId);
    expect(rowX).toMatchObject({
      name: 'Sentinel Harbor Grill', status: 'active', inSetup: false, activePeople: 1, actions: 1, lastActiveDay: '2026-05-31',
      salesDayCount: 7, forecastsOn: true, chat: { spentMicroUsd: 1_250_000, budgetMicroUsd: 20_000_000 },
    });
    expect(rowX?.lastUploadAt).toBe(new Date(server.clock.now().getTime() - DAY).toISOString());
    expect(rowX?.locations).toEqual([{
      id: x.locationId, name: 'Sentinel Harbor Grill Main Room',
      newestRun: { dataThrough: '2026-04-30', madeAt: '2026-05-01', engine: 'model' },
      accuracy: { days: 6, inRange: 5, typicalErrorPct: 6.5 },
      refresh: null, lastScheduled: null,
    }]);
    expect(rowY).toMatchObject({ activePeople: 1, actions: 0, salesDayCount: 0, lastUploadAt: null, chat: { spentMicroUsd: 0 } });
    expect(rowY?.locations.map((line) => [line.name, line.newestRun, line.accuracy])).toEqual([
      ['Quiet Birch Cafe Main Room', null, null], ['Quiet Birch Patio', null, null],
    ]);

    for (const sentinel of ['Sentinel note', 'Sentinel chat', 'closing', 'menu', x.adminEmail, x.memberEmail, y.adminEmail, y.memberEmail]) {
      expect({ sentinel, found: text.includes(sentinel) }).toEqual({ sentinel, found: false });
    }
    const numbers = numbersIn(body);
    for (const figure of [4321, 98_765_432, 131, 103, 101_007, 131_007]) expect({ figure, found: numbers.includes(figure) }).toEqual({ figure, found: false });
  });

  it('lists what needs attention from the database: a waiting request, the refresh off, a failed week, a quiet organization, setup, old invitations and spend past 80%', async () => {
    const now = server.clock.now().getTime();
    const requester = await signIn(server, uniqueEmail('requester'));
    const waiting = await addRequest(server, { userId: requester.userId, email: uniqueEmail('request'), status: 'pending', createdAt: new Date(now - 3 * DAY) });
    const fresh = await signIn(server, uniqueEmail('fresh'));
    await addRequest(server, { userId: fresh.userId, email: uniqueEmail('fresh-request'), status: 'pending', createdAt: new Date(now - DAY) });
    const quiet = await joinedOrg('Quiet Upload Tavern');
    await addUpload(server, { orgId: quiet.orgId, locationId: quiet.locationId, uploadedAt: new Date(now - 16 * DAY), status: 'applied' });
    await addInvite(server, { orgId: quiet.orgId, email: uniqueEmail('slow'), invitedBy: quiet.admin.userId, invitedAt: new Date(now - 8 * DAY) });
    await addInvite(server, { orgId: quiet.orgId, email: uniqueEmail('slower'), invitedBy: quiet.admin.userId, invitedAt: new Date(now - 9 * DAY) });
    await addInvite(server, { orgId: quiet.orgId, email: uniqueEmail('recent'), invitedBy: quiet.admin.userId, invitedAt: new Date(now - 2 * DAY) });
    await addChatUsage(server, { orgId: quiet.orgId, month: '2026-06', costMicroUsd: 16_500_000 });
    await server.connection.collection('tw_forecast_weeks').insertOne({
      orgId: new Types.ObjectId(quiet.orgId), locationId: new Types.ObjectId(quiet.locationId), week: '2026-06-01', status: 'start_failed',
      calibrationId: null, dataSha256: null, createdAt: new Date(now - 2 * DAY), updatedAt: new Date(now - 2 * DAY),
    });
    const setup = await createOrg(server, { name: 'Attention Setup Diner' });
    const busy = await joinedOrg('Busy Upload Cafe');
    await addUpload(server, { orgId: busy.orgId, locationId: busy.locationId, uploadedAt: new Date(now - DAY), status: 'applied' });

    const { body } = await overview('28');
    expect(body.attention).toEqual([
      { kind: 'request_waiting', orgId: null, requestId: waiting, count: null, since: new Date(now - 3 * DAY).toISOString() },
      // No lab runner on this server, so the weekly refresh does not run here.
      { kind: 'refresh_off', orgId: null, requestId: null, count: null, since: null },
      { kind: 'refresh_failed', orgId: quiet.orgId, requestId: null, count: 1, since: new Date(now - 2 * DAY).toISOString() },
      { kind: 'no_recent_upload', orgId: quiet.orgId, requestId: null, count: null, since: new Date(now - 16 * DAY).toISOString() },
      { kind: 'in_setup', orgId: setup, requestId: null, count: null, since: new Date(now).toISOString() },
      { kind: 'invites_waiting', orgId: quiet.orgId, requestId: null, count: 2, since: new Date(now - 9 * DAY).toISOString() },
      { kind: 'chat_budget', orgId: quiet.orgId, requestId: null, count: null, since: null },
    ]);
    expect(body.orgs.find((row) => row.id === quiet.orgId)?.locations[0]?.refresh).toEqual({ week: '2026-06-01', outcome: 'start_failed' });
    expect(body.schedule).toEqual({ running: false, paused: null });
  });

  it('logs one line with the window and the organization count, and no name or email', async () => {
    const org = await joinedOrg('Logged Lantern Inn');
    await overview('90');
    const lines = logLines(server).filter((line) => line.msg === 'townwise.admin_overview_read');
    expect(lines.at(-1)).toMatchObject({ days: 90, orgCount: 1 });
    const text = JSON.stringify(lines);
    for (const sentinel of ['Logged Lantern', org.adminEmail, org.memberEmail, STAFF_EMAIL]) expect(text).not.toContain(sentinel);
  });
});
