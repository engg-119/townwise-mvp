// The harness itself. Tests run on a clock frozen at 2026-06-01 (helpers/server.ts), so every session and magic link
// they write is long expired by the wall clock that mongod's TTL monitor reads. With the monitor on, a pass (once a
// minute) deleted them mid-test and the next request answered 401 (last-admin-races failed so in CI).
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

it('the test database deletes nothing by the wall clock: its TTL monitor is off', async () => {
  const reply = await server.connection.getClient().db('admin').command({ getParameter: 1, ttlMonitorEnabled: 1 });
  expect(reply.ttlMonitorEnabled).toBe(false);
});
