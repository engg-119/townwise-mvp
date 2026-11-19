// D59 (openspec change auto-apply-agent-reads, design decision 12): a change to the days the lab trains on marks the
// location as wanting a refit, end to end. A person's note or rule on a day on or before the last stored sales day
// marks it, one on later days does not (the forecast read applies it); a sales upload always does; the mark only moves
// later; and its clear is a compare-and-set on the value read, so a change landing during the pass keeps it. Synthetic.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { addLocation, addSalesDay, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, MINUTE, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

interface Place { orgId: string; scope: OrgScope; locationId: string; admin: TestSession }

async function place(): Promise<Place> {
  const orgId = await createOrg(server, { name: `Refit Kitchen ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, email);
  await addSeat(server, { orgId, userId: admin.userId, email, role: 'org_admin' });
  // Sales through May 31.
  for (const date of ['2026-05-30', '2026-05-31']) await addSalesDay(server, { orgId, locationId, date, guests: 90, netSalesCents: null });
  return { orgId, scope: { orgId } as OrgScope, locationId, admin };
}

async function wantedAt(p: Place): Promise<Date | undefined> {
  const doc = await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(p.locationId) });
  return (doc?.refit as { wantedAt?: Date } | undefined)?.wantedAt;
}

function note(p: Place, date: string): Promise<Response> {
  return call(server, `/api/org/locations/${p.locationId}/notes`, {
    session: p.admin, json: { kind: 'closure', startDate: date, endDate: date, effect: 'closed', detail: null },
  });
}

describe('refit wanted (D59)', () => {
  it('a note on a later day marks nothing; one on a training day, its edit and its delete each mark the location', async () => {
    const p = await place();
    expect((await note(p, '2026-06-10')).status).toBe(201);
    expect(await wantedAt(p)).toBeUndefined();
    const res = await note(p, '2026-05-30');
    expect(res.status).toBe(201);
    expect(await wantedAt(p)).toEqual(server.clock.now());
    const { note: written } = await res.json() as { note: { id: string } };
    server.clock.advance(MINUTE);
    // Moved to a later day: it covered a training day before, so the edit still wants a refit.
    expect((await call(server, `/api/org/locations/${p.locationId}/notes/${written.id}`, {
      session: p.admin, method: 'PATCH', json: { kind: 'closure', startDate: '2026-06-20', endDate: '2026-06-20', effect: 'closed', detail: null },
    })).status).toBe(200);
    expect(await wantedAt(p)).toEqual(server.clock.now());
    server.clock.advance(MINUTE);
    // Now on a later day only: deleting it marks nothing new.
    const before = await wantedAt(p);
    expect((await call(server, `/api/org/locations/${p.locationId}/notes/${written.id}`, { session: p.admin, method: 'DELETE' })).status).toBe(204);
    expect(await wantedAt(p)).toEqual(before);
  });

  it('a rule whose schedule starts on a training day marks it; one with no schedule or a later start does not', async () => {
    const p = await place();
    const rule = (body: unknown): Promise<Response> => call(server, `/api/org/locations/${p.locationId}/rules`, { session: p.admin, json: body });
    expect((await rule({ text: 'We close for the staff party' })).status).toBe(201);
    expect((await rule({
      text: 'Closed Mondays from July', schedule: {
        kind: 'closure', startDate: '2026-07-06', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
      },
    })).status).toBe(201);
    expect(await wantedAt(p)).toBeUndefined();
    expect((await rule({
      text: 'Closed Tuesdays', schedule: {
        kind: 'closure', startDate: '2026-05-01', endDate: null, weekdays: [2], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
      },
    })).status).toBe(201);
    expect(await wantedAt(p)).toEqual(server.clock.now());
  });

  it('a sales upload marks the location, whatever its days', async () => {
    const p = await place();
    const res = await call(server, `/api/org/locations/${p.locationId}/sales/uploads`, {
      session: p.admin, json: { days: [{ date: '2026-06-01', guests: 70, netSalesCents: null }] },
    });
    expect(res.status).toBe(201);
    expect(await wantedAt(p)).toEqual(server.clock.now());
  });

  it('the mark only moves later, and its clear keeps a newer mark that landed after it was read', async () => {
    const p = await place();
    const { locations } = server.ctx.stores;
    const first = new Date('2026-06-01T12:00:00.000Z');
    const later = new Date('2026-06-01T12:05:00.000Z');
    expect(await locations.wantRefit(p.scope, p.locationId, later)).toBe(true);
    expect(await locations.wantRefit(p.scope, p.locationId, first)).toBe(true);
    expect((await locations.refitState(p.scope, p.locationId)).wantedAt).toEqual(later);
    // A pass read `later`; a change lands at `newest` before its clear: the clear misses, and the mark stays.
    const newest = new Date('2026-06-01T12:06:00.000Z');
    await locations.wantRefit(p.scope, p.locationId, newest);
    expect(await locations.clearRefitWanted(p.scope, p.locationId, later)).toBe(false);
    expect((await locations.refitState(p.scope, p.locationId)).wantedAt).toEqual(newest);
    expect(await locations.clearRefitWanted(p.scope, p.locationId, newest)).toBe(true);
    expect(await locations.refitState(p.scope, p.locationId)).toEqual({ wantedAt: null, startedAt: null });
    expect(await locations.markRefitStarted(p.scope, p.locationId, newest)).toBe(true);
    expect((await locations.refitState(p.scope, p.locationId)).startedAt).toEqual(newest);
    // Another organization's scope changes nothing.
    expect(await locations.wantRefit({ orgId: new Types.ObjectId().toHexString() } as unknown as OrgScope, p.locationId, newest)).toBe(false);
  });
});
