// The organization's forecasts switch since D42 (owner directive, 2026-11-16): an organization nobody switched reads as
// on, existing and new alike; a staff switch off is stored with when and by whom and stays off until switched on again.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeForNewOrg } from '../src/access/policy.ts';
import { createOrgStore } from '../src/stores/orgs.ts';
import { createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

describe('the forecasts switch (G1, D42)', () => {
  it('reads an organization with no forecasts field as on, with no date, whether created by a request or by staff', async () => {
    const orgs = createOrgStore(server.connection);
    const fixture = await createOrg(server, { name: `Default Kitchen ${randomUUID().slice(0, 6)}` });
    expect((await orgs.findById(fixture))?.forecasts).toEqual({ on: true, at: null });
    const id = new Types.ObjectId().toHexString();
    await orgs.insertByStaff({ id, name: `Staff Kitchen ${randomUUID().slice(0, 6)}`, createdAt: server.clock.now(), createdBy: 'staff-0000' });
    expect((await orgs.findById(id))?.forecasts).toEqual({ on: true, at: null });
    expect(await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(id) })).not.toHaveProperty('forecasts');
  });

  it('a staff switch off is stored with when and by whom, and stays off', async () => {
    const orgs = createOrgStore(server.connection);
    const orgId = await createOrg(server, { name: `Off Kitchen ${randomUUID().slice(0, 6)}` });
    const at = server.clock.now();
    expect(await orgs.setForecasts(scopeForNewOrg(STAFF, orgId), { on: false, at, by: 'staff-0000' })).toBe(true);
    expect((await orgs.findById(orgId))?.forecasts).toEqual({ on: false, at });
    expect((await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(orgId) }))?.forecasts).toEqual({ on: false, at, by: 'staff-0000' });
    expect((await orgs.list()).find((org) => org.id === orgId)?.forecasts.on).toBe(false);
  });
});
