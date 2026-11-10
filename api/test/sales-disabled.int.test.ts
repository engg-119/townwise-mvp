// Turned-off uploads (D28, design calls 1 to 3): a turned-off upload's days leave every sales read (coverage, months,
// days, history, GET /api/org) and TownwiseAI's questions, and come back when it is turned on; the existence checks
// still see them. The route that turns an upload off comes later, so these tests set the flag on tw_uploads directly,
// and the store tests call the stores. Synthetic days only.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import type { AgentPanel } from '../src/handlers/agent.ts';
import type { LocationSummary } from '../src/handlers/locations.ts';
import type { SalesHistory } from '../src/handlers/sales.ts';
import { createSalesDayStore, type Coverage, type SalesDay, type SalesMonth } from '../src/stores/sales-days.ts';
import { createUploadStore } from '../src/stores/uploads.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

let server: TownwiseTestServer;
let orgId: string;
let admin: TestSession;
let member: TestSession;
let l1: string;

interface Team { orgId: string; admin: TestSession; member: TestSession }

async function newTeam(name: string): Promise<Team> {
  const id = await createOrg(server, { name });
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  const teamAdmin = await signIn(server, adminEmail);
  const teamMember = await signIn(server, memberEmail);
  await addSeat(server, { orgId: id, userId: teamAdmin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId: id, userId: teamMember.userId, email: memberEmail });
  return { orgId: id, admin: teamAdmin, member: teamMember };
}

beforeAll(async () => {
  server = await startTownwiseServer();
  // The clock starts on 2026-06-01 and an upload takes days up to the next UTC day: start on 2026-07-01 instead, so
  // June can be sent. Before any sign-in, so every session is issued on the moved clock.
  server.clock.advance(30 * DAY_MS);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  // A new organization each test, with one location, so GET /api/org lists l1 alone.
  ({ orgId, admin, member } = await newTeam(`Switch Kitchen ${randomUUID().slice(0, 6)}`));
  l1 = await addLocation(server, { orgId, name: 'Main Room' });
});

function plus(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The days from `from` to `to`, inclusive. */
function range(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = plus(day, 1)) out.push(day);
  return out;
}

/** Posts `count` consecutive days from `from` through POST .../sales/uploads; answers the upload's id. */
async function send(session: TestSession, locationId: string, from: string, count: number): Promise<string> {
  const days = Array.from({ length: count }, (_, i) => ({ date: plus(from, i), guests: 40 + i, netSalesCents: null }));
  const res = await call(server, `/api/org/locations/${locationId}/sales/uploads`, { session, json: { days } });
  expect(res.status).toBe(201);
  return (await res.json() as { upload: { id: string } }).upload.id;
}

/** Turns an upload off as the store will: both fields set. */
async function turnOff(uploadId: string): Promise<void> {
  const result = await server.connection.collection('tw_uploads').updateOne(
    { _id: new Types.ObjectId(uploadId) },
    { $set: { disabledAt: server.clock.now(), disabledBy: admin.userId } },
  );
  expect(result.matchedCount).toBe(1);
}

/** Turns an upload back on as the store will: both fields unset, never null. */
async function turnOn(uploadId: string): Promise<void> {
  const result = await server.connection.collection('tw_uploads').updateOne(
    { _id: new Types.ObjectId(uploadId) },
    { $unset: { disabledAt: '', disabledBy: '' } },
  );
  expect(result.matchedCount).toBe(1);
}

async function getJson<T>(session: TestSession, path: string): Promise<T> {
  const res = await call(server, path, { session });
  expect(res.status).toBe(200);
  return await res.json() as T;
}

interface SalesView { coverage: Coverage; months: SalesMonth[] }

function history(locationId: string, session: TestSession = admin): Promise<SalesHistory> {
  return getJson<SalesHistory>(session, `/api/org/locations/${locationId}/sales/history`);
}

function dates(body: SalesHistory): string[] {
  return body.days.date;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

/** An OrgScope for calling the stores directly, as a staff handler would mint one. */
function scopeOf(id: string): OrgScope {
  const staff = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
  return scopeForNewOrg(staff, id);
}

describe('turned-off uploads leave every read (D28)', () => {
  it('a turned-off upload’s days leave coverage, months, days, history and GET /api/org, and come back when it is turned on', async () => {
    const a = await send(admin, l1, '2026-05-01', 10);
    await send(admin, l1, '2026-06-01', 5);
    await turnOff(a);
    const sales = await getJson<SalesView>(admin, `/api/org/locations/${l1}/sales`);
    expect(sales.coverage).toMatchObject({ dayCount: 5, firstDate: '2026-06-01' });
    expect(sales.months.map((m) => m.month)).toEqual(['2026-06']);
    expect((await getJson<SalesHistory>(admin, `/api/org/locations/${l1}/sales/history`)).days.date).toHaveLength(5);
    expect((await getJson<{ days: SalesDay[] }>(admin, `/api/org/locations/${l1}/sales/days?from=2026-05-01&to=2026-05-31`)).days).toEqual([]);
    expect((await getJson<{ locations: LocationSummary[] }>(admin, '/api/org')).locations[0]?.coverage.dayCount).toBe(5);
    await turnOn(a);
    expect((await getJson<SalesView>(admin, `/api/org/locations/${l1}/sales`)).coverage.dayCount).toBe(15);
    expect((await getJson<SalesView>(admin, `/api/org/locations/${l1}/sales`)).months.map((m) => m.month)).toEqual(['2026-05', '2026-06']);
  });

  it('says uploadsOff only when no day is left and a turned-off upload holds days, on sales and sales/history', async () => {
    const off = async (): Promise<[boolean, boolean]> => [
      (await getJson<{ uploadsOff: boolean }>(admin, `/api/org/locations/${l1}/sales`)).uploadsOff,
      (await getJson<{ uploadsOff: boolean }>(admin, `/api/org/locations/${l1}/sales/history`)).uploadsOff,
    ];
    expect(await off()).toEqual([false, false]);
    const a = await send(admin, l1, '2026-05-01', 3);
    const b = await send(admin, l1, '2026-06-01', 3);
    expect(await off()).toEqual([false, false]);
    await turnOff(a);
    expect(await off()).toEqual([false, false]);
    await turnOff(b);
    expect(await off()).toEqual([true, true]);
    await turnOn(b);
    expect(await off()).toEqual([false, false]);
  });

  it('a day two uploads covered belongs to the upload that last wrote it: turning off the earlier one keeps it, turning off the later one leaves it out with no fallback', async () => {
    const a = await send(admin, l1, '2026-05-01', 10); // 05-01..05-10
    const b = await send(admin, l1, '2026-05-06', 10); // replaces 05-06..05-10, adds 05-11..05-15
    await turnOff(a);
    expect(dates(await history(l1))).toEqual(range('2026-05-06', '2026-05-15'));
    await turnOn(a); await turnOff(b);
    expect(dates(await history(l1))).toEqual(range('2026-05-01', '2026-05-05'));
  });

  it('a member’s upload never writes a day another upload holds, so turning off the holder leaves those days out', async () => {
    const a = await send(admin, l1, '2026-05-01', 10);
    await send(member, l1, '2026-05-06', 10); // kept 05-06..05-10, adds 05-11..05-15
    await turnOff(a);
    expect(dates(await history(l1))).toEqual(range('2026-05-11', '2026-05-15'));
  });

  it('a location with only turned-off days still has data: DELETE /api/org/locations/:id answers 409 location_has_data', async () => {
    await turnOff(await send(admin, l1, '2026-05-01', 3));
    expect(await errorOf(await call(server, `/api/org/locations/${l1}`, { method: 'DELETE', session: admin })))
      .toEqual({ status: 409, error: 'location_has_data' });
  });

  // A smoke test, not the isolation pin: B's upload ids never hold A's days, so this would pass even if the turned-off
  // lookup lost its orgId. The pin is the store's own scoping of setEnabled and get (another organization answers null).
  it('turning off an upload in another organization changes nothing here (smoke)', async () => {
    await send(admin, l1, '2026-05-01', 10);
    const other = await newTeam(`Other Kitchen ${randomUUID().slice(0, 6)}`);
    const theirs = await addLocation(server, { orgId: other.orgId, name: 'Main Room' });
    await turnOff(await send(other.admin, theirs, '2026-05-01', 10));
    expect((await getJson<SalesView>(admin, `/api/org/locations/${l1}/sales`)).coverage).toMatchObject({ dayCount: 10, firstDate: '2026-05-01' });
    expect(dates(await history(l1))).toEqual(range('2026-05-01', '2026-05-10'));
    expect((await getJson<{ locations: LocationSummary[] }>(admin, '/api/org')).locations[0]?.coverage.dayCount).toBe(10);
    expect((await getJson<SalesView>(other.admin, `/api/org/locations/${theirs}/sales`)).coverage.dayCount).toBe(0);
  });

  it('GET .../agent asks no question about a turned-off upload’s days', async () => {
    await send(admin, l1, '2026-01-05', 120);
    await turnOff(await send(admin, l1, '2026-03-01', 3)); // replaces three days inside the run
    const { questions } = await getJson<AgentPanel>(admin, `/api/org/locations/${l1}/agent`);
    expect(questions.filter((q: { kind: string }) => q.kind === 'gap')).toEqual([]);
  });
});

describe('the switch in the stores', () => {
  it('setEnabled sets both fields, unsets both (never null), and answers null for an upload of another location or organization', async () => {
    const uploads = createUploadStore(server.connection);
    const scope = scopeOf(orgId);
    const id = await send(admin, l1, '2026-05-01', 3);
    expect(await uploads.get(scope, l1, id)).toMatchObject({ id, locationId: l1, disabledAt: null, disabledBy: null });
    const at = server.clock.now();
    expect(await uploads.setEnabled(scope, l1, id, { enabled: false, by: admin.userId, at }))
      .toMatchObject({ id, locationId: l1, disabledAt: at, disabledBy: admin.userId });
    expect(await uploads.get(scope, l1, id)).toMatchObject({ disabledAt: at, disabledBy: admin.userId });
    expect(await uploads.setEnabled(scope, l1, id, { enabled: true, by: admin.userId, at }))
      .toMatchObject({ id, disabledAt: null, disabledBy: null });
    const raw = await server.connection.collection('tw_uploads').findOne({ _id: new Types.ObjectId(id) });
    expect(Object.keys(raw ?? {})).not.toContain('disabledAt');
    expect(Object.keys(raw ?? {})).not.toContain('disabledBy');

    const elsewhere = await addLocation(server, { orgId, name: 'Back Room' });
    const otherScope = scopeOf(await createOrg(server, { name: `Elsewhere ${randomUUID().slice(0, 6)}` }));
    const unknown = new Types.ObjectId().toHexString();
    for (const [s, locationId, uploadId] of [[scope, elsewhere, id], [otherScope, l1, id], [scope, l1, unknown]] as const) {
      expect(await uploads.get(s, locationId, uploadId)).toBeNull();
      expect(await uploads.setEnabled(s, locationId, uploadId, { enabled: false, by: admin.userId, at })).toBeNull();
    }
    expect((await uploads.get(scope, l1, id))?.disabledAt).toBeNull();
  });

  it('disabledDates answers the dates in the range a turned-off upload holds, oldest first; hasAny and hasAnyForOrg still see them', async () => {
    const salesDays = createSalesDayStore(server.connection);
    const scope = scopeOf(orgId);
    const a = await send(admin, l1, '2026-05-01', 10);
    const b = await send(admin, l1, '2026-05-06', 10);
    expect(await salesDays.disabledDates(scope, l1, { from: '2026-05-01', to: '2026-05-31' })).toEqual([]);
    await turnOff(a);
    expect(await salesDays.disabledDates(scope, l1, { from: '2026-05-01', to: '2026-05-31' })).toEqual(range('2026-05-01', '2026-05-05'));
    expect(await salesDays.disabledDates(scope, l1, { from: '2026-05-03', to: '2026-05-04' })).toEqual(['2026-05-03', '2026-05-04']);
    await turnOff(b);
    expect(await salesDays.disabledDates(scope, l1, { from: '2026-05-01', to: '2026-05-31' })).toEqual(range('2026-05-01', '2026-05-15'));
    expect(await salesDays.coverage(scope, l1)).toMatchObject({ dayCount: 0, firstDate: null });
    expect(await salesDays.hasAny(scope, l1)).toBe(true);
    expect(await salesDays.hasAnyForOrg(scope)).toBe(true);
    const elsewhere = await addLocation(server, { orgId, name: 'Back Room' });
    expect(await salesDays.disabledDates(scope, elsewhere, { from: '2026-05-01', to: '2026-05-31' })).toEqual([]);
  });
});
