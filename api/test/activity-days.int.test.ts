// tw_activity_days (openspec change staff-overview, design decision 1): one row per person, organization and UTC day,
// whose _id is built from those three, so no time is kept anywhere in it; and the organization deletion's removal.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { createActivityDayStore, type ActivityDayStore } from '../src/stores/activity-days.ts';
import { createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;

let server: TownwiseTestServer;
let days: ActivityDayStore;

beforeAll(async () => {
  server = await startTownwiseServer();
  days = createActivityDayStore(server.connection);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.connection.collection('tw_activity_days').deleteMany({}); });

async function tenant(): Promise<{ orgId: string; scope: OrgScope }> {
  const orgId = await createOrg(server, { name: `Activity Cafe ${randomUUID().slice(0, 6)}` });
  return { orgId, scope: scopeForNewOrg(STAFF, orgId) };
}

function rows(): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_activity_days').find({}).sort({ _id: 1 }).toArray();
}

describe('tw_activity_days', () => {
  it('keeps one row per person, organization and day, holding exactly its id, the organization, the person and the date', async () => {
    const a = await tenant();
    const b = await tenant();
    const person = 'user-0001';
    await days.record(a.scope, person, '2026-06-01');
    await days.record(a.scope, person, '2026-06-01');
    await days.record(a.scope, person, '2026-06-02');
    await days.record(b.scope, person, '2026-06-01');
    await days.record(a.scope, 'user-0002', '2026-06-01');

    const stored = await rows();
    expect(stored).toHaveLength(4);
    const first = stored.find((row) => row._id === `${a.orgId}:${person}:2026-06-01`);
    // No time anywhere: not a field, not an ObjectId _id (which would carry the second of the first request).
    expect(first).toEqual({ _id: `${a.orgId}:${person}:2026-06-01`, orgId: new Types.ObjectId(a.orgId), userId: person, day: '2026-06-01' });
    for (const row of stored) {
      expect(Object.keys(row).sort()).toEqual(['_id', 'day', 'orgId', 'userId']);
      expect(typeof row._id).toBe('string');
    }
  });

  it('two first writes of the same day race to one row, neither failing', async () => {
    const a = await tenant();
    await Promise.all(Array.from({ length: 8 }, () => days.record(a.scope, 'user-0003', '2026-06-01')));
    expect(await rows()).toHaveLength(1);
  });

  it('removeForOrg deletes the organization’s rows and never another’s', async () => {
    const a = await tenant();
    const b = await tenant();
    await days.record(a.scope, 'user-0004', '2026-06-01');
    await days.record(a.scope, 'user-0005', '2026-06-02');
    await days.record(b.scope, 'user-0004', '2026-06-01');
    expect(await days.removeForOrg(a.scope)).toBe(2);
    expect((await rows()).map((row) => row._id)).toEqual([`${b.orgId}:user-0004:2026-06-01`]);
  });
});
