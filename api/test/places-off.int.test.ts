// The Places proxy with no GOOGLE_PLACES_API_KEY: both routes answer 503 places_unavailable, whatever the body, and
// write nothing, and GET /api/places/status says the search is off. The client then shows the manual fields.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, signIn, startTownwiseServer, writesDuring, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

describe('the Places proxy while it is off', () => {
  it('both routes answer 503 places_unavailable to a signed-in person, for valid and invalid bodies, and write nothing', async () => {
    const session = await signIn(server, `no-org-${randomUUID().slice(0, 8)}@example.test`);
    const requests: [string, unknown][] = [
      ['/api/places/autocomplete', { input: 'Lou’s', sessionToken: randomUUID() }],
      ['/api/places/autocomplete', { input: 'Lou’s' }],
      ['/api/places/autocomplete', {}],
      ['/api/places/details', { placeId: 'ChIJTestPlace0001', sessionToken: randomUUID() }],
      ['/api/places/details', {}],
    ];
    const writes = await writesDuring(server, async () => {
      for (const [path, json] of requests) {
        const res = await call(server, path, { session, json });
        expect({ path, json, status: res.status, body: await res.json() as unknown })
          .toMatchObject({ path, json, status: 503, body: { error: 'places_unavailable' } });
      }
    });
    expect(writes).toEqual([]);
  });

  it('GET /api/places/status answers placeSearch false, and writes nothing', async () => {
    const session = await signIn(server, `no-org-${randomUUID().slice(0, 8)}@example.test`);
    const writes = await writesDuring(server, async () => {
      const res = await call(server, '/api/places/status', { session });
      expect({ status: res.status, body: await res.json() as unknown }).toEqual({ status: 200, body: { placeSearch: false } });
    });
    expect(writes).toEqual([]);
  });
});
