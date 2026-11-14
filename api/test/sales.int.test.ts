// Sales upload, reads and deletion (spec 10.4, 11, 14.1): strict validation, replace-by-day for org admins,
// new days only for members, exactly the eight stored keys, coverage and calibration, and no figure in any log
// line or audit event.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Coverage, SalesDay } from '../src/stores/sales-days.ts';
import { addLocation, addNote, addSeat, addUpload, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, limiterKey, logLines, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

// The test clock starts at 2026-06-01T12:00Z, so the latest accepted day is 2026-06-02.
const DAY_MS = 24 * 60 * 60 * 1000;

interface Team {
  orgId: string;
  admin: TestSession;
  adminEmail: string;
  member: TestSession;
  memberEmail: string;
}

interface UploadResponse {
  upload: {
    id: string; uploadedAt: string; uploadedByEmail: string; status: string; dayCount: number; inserted: number;
    replaced: number; kept: number; firstDate: string; lastDate: string; hasGuests: boolean; hasNetSales: boolean;
  };
  coverage: Coverage;
  calibration: { state: string; dayCount?: number; firstDate?: string; lastDate?: string };
}

let team: Team;

beforeAll(async () => {
  const orgId = await createOrg(server, { name: 'Upload Kitchen' });
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, adminEmail);
  const member = await signIn(server, memberEmail);
  await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
  team = { orgId, admin, adminEmail, member, memberEmail };
});

function newLocation(name = `Room ${randomUUID().slice(0, 6)}`): Promise<string> {
  return addLocation(server, { orgId: team.orgId, name });
}

function upload(locationId: string, body: unknown, session = team.admin): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/sales/uploads`, { session, json: body });
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function day(date: string, guests: number | null, netSalesCents: number | null): SalesDay {
  return { date, guests, netSalesCents };
}

/** `count` consecutive days ending on `last`. */
function daysEnding(last: string, count: number, value: (index: number) => Omit<SalesDay, 'date'>): SalesDay[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(end - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10),
    ...value(index),
  }));
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of ['tw_sales_days', 'tw_uploads', 'tw_audit_events']) out[name] = await server.connection.collection(name).countDocuments({});
  return out;
}

async function storedDays(locationId: string): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_sales_days')
    .find({ locationId: new Types.ObjectId(locationId) }).sort({ date: 1 }).toArray();
}

describe('validation (spec 11.3): any failure is 400 invalid_request, and nothing is written', () => {
  it('refuses an extra key in the body or in a day', async () => {
    const locationId = await newLocation();
    const before = await counts();
    const good = day('2026-05-01', 10, 1000);
    expect(await errorOf(await upload(locationId, { days: [good], fileName: 'export.csv' }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await upload(locationId, { days: [{ ...good, customer: 'Sentinel Customer' }] }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await upload(locationId, { days: [good, { ...good, date: '2026-05-02', checks: 4 }] }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await counts()).toEqual(before);
  });

  it('refuses dates that are malformed, not real, before 2010-01-01 or after the UTC date plus one day', async () => {
    const locationId = await newLocation();
    const before = await counts();
    for (const date of ['2026-6-01', '20260601', '06/01/2026', '2026-02-30', '2026-13-01', '2009-12-31', '2026-06-03', '2026-06-01T00:00:00Z']) {
      expect({ date, ...(await errorOf(await upload(locationId, { days: [day(date, 10, null)] }))) })
        .toEqual({ date, status: 400, error: 'invalid_request' });
    }
    expect(await counts()).toEqual(before);
    const edges = await upload(locationId, { days: [day('2010-01-01', 1, null), day('2026-06-02', 2, null)] });
    expect(edges.status).toBe(201);
  });

  it('refuses negative, fractional, too large, string and missing values, and a day with neither value', async () => {
    const locationId = await newLocation();
    const before = await counts();
    const bad: unknown[] = [
      { date: '2026-05-01', guests: -1, netSalesCents: 100 },
      { date: '2026-05-01', guests: 10, netSalesCents: -100 },
      { date: '2026-05-01', guests: 10.5, netSalesCents: 100 },
      { date: '2026-05-01', guests: 10, netSalesCents: 100.25 },
      { date: '2026-05-01', guests: 20_001, netSalesCents: 100 },
      { date: '2026-05-01', guests: 10, netSalesCents: 100_000_001 },
      { date: '2026-05-01', guests: '10', netSalesCents: 100 },
      { date: '2026-05-01', guests: 10 },
      { date: '2026-05-01', guests: null, netSalesCents: null },
    ];
    for (const entry of bad) {
      expect({ entry, ...(await errorOf(await upload(locationId, { days: [entry] }))) }).toEqual({ entry, status: 400, error: 'invalid_request' });
    }
    expect(await counts()).toEqual(before);
  });

  it('refuses no days, a repeated date and 3,661 days; a body over 256 KB is 413', async () => {
    const locationId = await newLocation();
    const before = await counts();
    expect(await errorOf(await upload(locationId, { days: [] }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await upload(locationId, {}))).toEqual({ status: 400, error: 'invalid_request' });
    const repeated = [day('2026-05-01', 1, null), day('2026-05-01', 2, null)];
    expect(await errorOf(await upload(locationId, { days: repeated }))).toEqual({ status: 400, error: 'invalid_request' });
    const tooMany = daysEnding('2026-06-01', 3661, () => ({ guests: 1, netSalesCents: 1 }));
    expect(await errorOf(await upload(locationId, { days: tooMany }))).toEqual({ status: 400, error: 'invalid_request' });
    const big = JSON.stringify({ days: [day('2026-05-01', 1, null)], pad: 'x'.repeat(257 * 1024) });
    const res = await call(server, `/api/org/locations/${locationId}/sales/uploads`, { session: team.admin, rawBody: big });
    expect(await errorOf(res)).toEqual({ status: 413, error: 'payload_too_large' });
    expect(await counts()).toEqual(before);
  });

  it('accepts 3,660 days at the largest allowed values, which serialize to 230,590 bytes', async () => {
    const locationId = await newLocation();
    const days = daysEnding('2026-06-02', 3660, () => ({ guests: 20_000, netSalesCents: 100_000_000 }));
    const body = { days };
    expect(JSON.stringify(body).length).toBe(230_590);
    const res = await upload(locationId, body);
    expect(res.status).toBe(201);
    expect((await res.json() as UploadResponse).upload).toMatchObject({ dayCount: 3660, inserted: 3660, replaced: 0 });
  });

  it('answers 404 for a location that does not exist, after validating the body', async () => {
    const missing = new Types.ObjectId().toHexString();
    expect(await errorOf(await upload(missing, { days: [day('2026-05-01', 1, null)] }))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await upload('not-an-id', { days: [day('2026-05-01', 1, null)] }))).toEqual({ status: 400, error: 'invalid_request' });
  });
});

describe('the write (spec 11.4)', () => {
  it('an org admin’s upload inserts new days and replaces the days it covers in full, nulls included', async () => {
    const locationId = await newLocation();
    const first = await upload(locationId, { days: [day('2026-04-01', 10, 1000), day('2026-04-02', 20, 2000), day('2026-04-03', 30, null)] });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as UploadResponse;
    expect(firstBody.upload).toEqual({
      id: firstBody.upload.id, uploadedAt: server.clock.now().toISOString(), uploadedByEmail: team.adminEmail, status: 'applied',
      dayCount: 3, inserted: 3, replaced: 0, kept: 0, firstDate: '2026-04-01', lastDate: '2026-04-03', hasGuests: true, hasNetSales: true,
    });
    expect(firstBody.coverage).toEqual({
      dayCount: 3, guestsDayCount: 3, netSalesDayCount: 2, firstDate: '2026-04-01', lastDate: '2026-04-03', missingDays: 0,
    });
    expect(firstBody.calibration).toEqual({ state: 'not_calibrated', dayCount: 3, firstDate: '2026-04-01', lastDate: '2026-04-03' });

    const second = await upload(locationId, { days: [day('2026-04-02', null, 2500), day('2026-04-03', 35, 3500), day('2026-04-05', 50, 5000)] });
    const secondBody = await second.json() as UploadResponse;
    expect(secondBody.upload).toMatchObject({ dayCount: 3, inserted: 1, replaced: 2, kept: 0, firstDate: '2026-04-02', lastDate: '2026-04-05', hasGuests: true });
    expect(secondBody.coverage).toMatchObject({ dayCount: 4, firstDate: '2026-04-01', lastDate: '2026-04-05', missingDays: 1 });

    const stored = await storedDays(locationId);
    expect(stored.map((doc) => [doc.date, doc.guests, doc.netSalesCents, String(doc.uploadId)])).toEqual([
      ['2026-04-01', 10, 1000, firstBody.upload.id],
      ['2026-04-02', null, 2500, secondBody.upload.id],
      ['2026-04-03', 35, 3500, secondBody.upload.id],
      ['2026-04-05', 50, 5000, secondBody.upload.id],
    ]);
    const record = await server.connection.collection('tw_uploads').findOne({ _id: new Types.ObjectId(secondBody.upload.id) });
    expect(record).toMatchObject({ status: 'applied', inserted: 1, replaced: 2, kept: 0 });
  });

  it('a member’s upload never changes an existing day, and reports it as kept', async () => {
    const locationId = await newLocation();
    const first = await (await upload(locationId, { days: [day('2026-04-01', 10, 1000)] })).json() as UploadResponse;
    const res = await upload(locationId, { days: [day('2026-04-01', 99, 9900), day('2026-04-02', 20, 2000)] }, team.member);
    expect(res.status).toBe(201);
    const body = await res.json() as UploadResponse;
    expect(body.upload).toMatchObject({ uploadedByEmail: team.memberEmail, dayCount: 2, inserted: 1, replaced: 0, kept: 1 });
    const stored = await storedDays(locationId);
    expect(stored.map((doc) => [doc.date, doc.guests, doc.netSalesCents, String(doc.uploadId)])).toEqual([
      ['2026-04-01', 10, 1000, first.upload.id],
      ['2026-04-02', 20, 2000, body.upload.id],
    ]);
    const event = (await auditEvents(server)).find((e) => (e.target as { id: string }).id === body.upload.id);
    expect(event).toMatchObject({ action: 'sales.uploaded', actorRole: 'member', actorUserId: team.member.userId });
    expect(event?.details).toEqual({ locationId, dayCount: 2, inserted: 1, replaced: 0, firstDate: '2026-04-01', lastDate: '2026-04-02' });
  });

  it('stores exactly the eight keys of spec 6.5, for org admins and members alike', async () => {
    const locationId = await newLocation();
    await upload(locationId, { days: [day('2026-03-01', 12, null)] });
    await upload(locationId, { days: [day('2026-03-02', null, 4400)] }, team.member);
    const stored = await storedDays(locationId);
    expect(stored).toHaveLength(2);
    for (const doc of stored) {
      expect(Object.keys(doc).sort()).toEqual(['_id', 'date', 'guests', 'locationId', 'netSalesCents', 'orgId', 'updatedAt', 'uploadId']);
      expect(doc.orgId).toEqual(new Types.ObjectId(team.orgId));
      expect(doc.locationId).toEqual(new Types.ObjectId(locationId));
      expect(doc.updatedAt).toEqual(server.clock.now());
    }
  });

  it('keeps counts and dates only on the upload record: no file name, column names, row count or figures', async () => {
    const locationId = await newLocation();
    const body = await (await upload(locationId, { days: [day('2026-03-01', 12, null)] })).json() as UploadResponse;
    const record = await server.connection.collection('tw_uploads').findOne({ _id: new Types.ObjectId(body.upload.id) });
    expect(Object.keys(record ?? {}).sort()).toEqual([
      '_id', 'dayCount', 'firstDate', 'hasGuests', 'hasNetSales', 'inserted', 'kept', 'lastDate', 'locationId', 'orgId', 'replaced',
      'status', 'uploadedAt', 'uploadedBy',
    ]);
    expect(record).toMatchObject({ uploadedBy: team.admin.userId, hasGuests: true, hasNetSales: false });
  });

  it('puts no figure in any log line or audit event, accepted or refused', async () => {
    const locationId = await newLocation();
    // Figures no id, time or count in this test can contain: matched only when not next to another hex digit.
    const figures = [/(?<![0-9a-f])17389(?![0-9a-f])/i, /(?<![0-9a-f])98765431(?![0-9a-f])/i, /987654\.31/];
    server.logs.length = 0;
    const res = await upload(locationId, { days: [day('2026-02-01', 17389, 98_765_431)] });
    expect(res.status).toBe(201);
    const { upload: made } = await res.json() as UploadResponse;
    await upload(locationId, { days: [{ date: '2026-02-02', guests: 17389, netSalesCents: 98_765_431, note: 'refused' }] });
    await upload(locationId, { days: [day('2026-02-03', 17389, 98_765_431)] }, team.member);

    const logs = server.logs.join('\n');
    for (const figure of figures) expect(logs).not.toMatch(figure);
    const applied = logLines(server).filter((line) => line.msg === 'townwise.upload_applied');
    expect(applied).toHaveLength(2);
    expect(applied[0]).toMatchObject({ orgId: team.orgId, locationId, uploadId: made.id, dayCount: 1 });
    // Beyond pino's own fields (level, time, pid, hostname, msg): ids and a count only.
    expect(Object.keys(applied[0] ?? {}).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key)).sort())
      .toEqual(['dayCount', 'locationId', 'orgId', 'uploadId']);

    const events = JSON.stringify((await auditEvents(server)).filter((event) => event.action === 'sales.uploaded'));
    for (const figure of figures) expect(events).not.toMatch(figure);
  });
});

describe('reads (spec 10.4, 14.1)', () => {
  it('before any upload: no coverage, no_sales_data, no months and no uploads', async () => {
    const locationId = await newLocation();
    const res = await call(server, `/api/org/locations/${locationId}/sales`, { session: team.member });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      coverage: { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 },
      uploadsOff: false,
      calibration: { state: 'no_sales_data' },
      months: [],
      uploads: [],
    });
  });

  it('sums each month over the days with a value, with guests null for a month without guest counts; uploads newest first', async () => {
    const locationId = await newLocation();
    const first = await (await upload(locationId, { days: [day('2026-03-30', null, 10_000), day('2026-03-31', null, 20_050)] })).json() as UploadResponse;
    server.clock.advance(60 * 1000);
    const second = await (await upload(locationId, { days: [day('2026-04-01', 40, 30_000), day('2026-04-03', 60, null)] }, team.member)).json() as UploadResponse;
    await addUpload(server, { orgId: team.orgId, locationId, uploadedAt: new Date(server.clock.now().getTime() + 60 * 1000), status: 'applying' });

    const res = await call(server, `/api/org/locations/${locationId}/sales`, { session: team.member });
    const body = await res.json() as {
      coverage: Coverage; calibration: unknown; months: unknown[];
      uploads: { id: string; status: string; uploadedByEmail: string; kept: number }[];
    };
    expect(body.coverage).toEqual({
      dayCount: 4, guestsDayCount: 2, netSalesDayCount: 3, firstDate: '2026-03-30', lastDate: '2026-04-03', missingDays: 1,
    });
    expect(body.calibration).toEqual({ state: 'not_calibrated', dayCount: 4, firstDate: '2026-03-30', lastDate: '2026-04-03' });
    expect(body.months).toEqual([
      { month: '2026-03', dayCount: 2, guests: null, netSalesCents: 30_050 },
      { month: '2026-04', dayCount: 2, guests: 100, netSalesCents: 30_000 },
    ]);
    // The crash leftover shows as applying, so the Sales data tab can say the upload didn't finish.
    expect(body.uploads.map((u) => [u.status, u.uploadedByEmail])).toEqual([
      ['applying', 'Deleted person'], ['applied', team.memberEmail], ['applied', team.adminEmail],
    ]);
    expect(body.uploads.slice(1).map((u) => u.id)).toEqual([second.upload.id, first.upload.id]);
  });

  it('returns the days of a range oldest first; a reversed, missing, malformed or longer-than-366-day range is 400', async () => {
    const locationId = await newLocation();
    await upload(locationId, { days: [day('2025-06-01', 5, 500), day('2025-06-02', 6, null), day('2026-05-31', 7, 700)] });
    const days = (query: string) => call(server, `/api/org/locations/${locationId}/sales/days${query}`, { session: team.member });

    // 2025-05-31 to 2026-05-31 is 366 days, inclusive: the longest range allowed.
    const year = await days('?from=2025-05-31&to=2026-05-31');
    expect(year.status).toBe(200);
    expect(await year.json()).toEqual({ days: [day('2025-06-01', 5, 500), day('2025-06-02', 6, null), day('2026-05-31', 7, 700)] });
    expect(await (await days('?from=2025-06-02&to=2025-06-02')).json()).toEqual({ days: [day('2025-06-02', 6, null)] });
    for (const query of ['?from=2025-05-30&to=2026-05-31', '?from=2026-05-31&to=2025-06-01', '?from=2025-06-01', '?from=2025-6-1&to=2025-06-02', '']) {
      expect({ query, ...(await errorOf(await days(query))) }).toEqual({ query, status: 400, error: 'invalid_request' });
    }
  });
});

describe('DELETE /api/org/locations/:locationId/sales', () => {
  it('is for org admins only; it deletes every day and upload record of the location, keeps notes and is audited', async () => {
    const locationId = await newLocation();
    const other = await newLocation();
    await upload(locationId, { days: [day('2026-05-01', 1, 100), day('2026-05-02', 2, 200)] });
    await upload(locationId, { days: [day('2026-05-03', 3, 300)] }, team.member);
    await upload(other, { days: [day('2026-05-01', 9, 900)] });
    await addNote(server, { orgId: team.orgId, locationId, detail: 'Kept after the delete' });

    const refused = await call(server, `/api/org/locations/${locationId}/sales`, { method: 'DELETE', session: team.member });
    expect(await errorOf(refused)).toEqual({ status: 403, error: 'forbidden' });
    expect(await storedDays(locationId)).toHaveLength(3);

    const res = await call(server, `/api/org/locations/${locationId}/sales`, { method: 'DELETE', session: team.admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deletedDays: 3, deletedUploads: 2, deletedFiles: 0 });
    expect(await storedDays(locationId)).toEqual([]);
    expect(await server.connection.collection('tw_uploads').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(0);
    expect(await storedDays(other)).toHaveLength(1);
    expect(await server.connection.collection('tw_notes').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(1);

    const after = await (await call(server, `/api/org/locations/${locationId}/sales`, { session: team.admin })).json() as { calibration: unknown };
    expect(after.calibration).toEqual({ state: 'no_sales_data' });
    const event = (await auditEvents(server)).filter((e) => e.action === 'sales.deleted').at(-1);
    expect(event).toMatchObject({ actorUserId: team.admin.userId, actorRole: 'org_admin', target: { type: 'location', id: locationId } });
    expect(event?.details).toEqual({ locationId, deletedDays: 3, deletedFiles: 0 });
  });

  it('also deletes its answers to TownwiseAI’s questions, so the same days uploaded again are asked about again', async () => {
    const locationId = await newLocation();
    const other = await newLocation();
    // Ten weeks with no sales on Tuesday 2026-04-14 and Wednesday 2026-04-15: TownwiseAI asks about that gap, as the
    // weeks before it make those weekdays usually busy (spec 10.12).
    const GAP = 'gap_2026-04-14_2026-04-15';
    const days = daysEnding('2026-04-28', 70, () => ({ guests: 100, netSalesCents: null }))
      .filter((each) => each.date !== '2026-04-14' && each.date !== '2026-04-15');
    const asked = async (id: string): Promise<string[]> => {
      const res = await call(server, `/api/org/locations/${id}/agent`, { session: team.admin });
      return ((await res.json()) as { questions: { id: string }[] }).questions.map((question) => question.id);
    };
    const answers = (id: string): Promise<number> =>
      server.connection.collection('tw_agent_answers').countDocuments({ locationId: new Types.ObjectId(id) });
    for (const id of [locationId, other]) {
      expect((await upload(id, { days })).status).toBe(201);
      expect(await asked(id)).toContain(GAP);
      const res = await call(server, `/api/org/locations/${id}/agent/questions/${GAP}`, { session: team.admin, json: { answer: 'open' } });
      expect(res.status).toBe(200);
      expect(await asked(id)).not.toContain(GAP);
    }

    expect((await call(server, `/api/org/locations/${locationId}/sales`, { method: 'DELETE', session: team.admin })).status).toBe(200);
    expect(await answers(locationId)).toBe(0);
    expect(await answers(other)).toBe(1);
    // An answer said what was true of the deleted days; uploaded again, they are asked about again.
    expect((await upload(locationId, { days })).status).toBe(201);
    expect(await asked(locationId)).toContain(GAP);
    expect(await asked(other)).not.toContain(GAP);
  });
});

describe('the uploads limiter', () => {
  it('the 31st upload in an hour is 429, and nothing is written', async () => {
    const locationId = await newLocation();
    await server.redis.set(limiterKey('townwise:uploads', team.admin.userId), '30', 'EX', 3600);
    const before = await counts();
    expect(await errorOf(await upload(locationId, { days: [day('2026-05-01', 1, null)] }))).toEqual({ status: 429, error: 'rate_limited' });
    expect(await counts()).toEqual(before);
  });
});
