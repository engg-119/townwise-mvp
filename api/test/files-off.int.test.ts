// Stored files while they are off (FILES_BLOB_ACCOUNT_URL unset): every files and imports route answers 503.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TOWNWISE_ROUTES } from '../src/access/routes.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { putChunk } from './helpers/files.ts';
import { call, signIn, startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

describe('stored files off', () => {
  it('answers 503 files_unavailable on every files and imports route', async () => {
    const orgId = await createOrg(server, { name: 'Off Kitchen' });
    const email = `off-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId, userId: session.userId, email, role: 'org_admin' });
    const locationId = await addLocation(server, { orgId, name: 'Off Room' });
    const ids: Record<string, string> = { locationId, fileId: new Types.ObjectId().toHexString(), importId: new Types.ObjectId().toHexString(), index: '0' };
    const routes = TOWNWISE_ROUTES.filter((route) => route.id.startsWith('org.files.') || route.id.startsWith('org.imports.') || route.id === 'org.data.text');
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      const path = `/api${route.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => ids[name] ?? '')}`;
      if (route.method === 'PUT') {
        const res = await putChunk(server, path, session, Buffer.from('a'));
        expect({ id: route.id, status: res.status, error: res.json<{ error: string }>().error }).toEqual({ id: route.id, status: 503, error: 'files_unavailable' });
        continue;
      }
      const json = route.id === 'org.files.create' ? { name: 'a.csv', sizeBytes: 1, purpose: 'history' }
        : route.id === 'org.data.text' ? { title: 'a', text: 'a' } : route.method === 'POST' ? {} : undefined;
      const res = await call(server, path, { session, method: route.method, ...(json === undefined ? {} : { json }) });
      const body = await res.json() as { error: string };
      expect({ id: route.id, status: res.status, error: body.error }).toEqual({ id: route.id, status: 503, error: 'files_unavailable' });
    }
  });
});
