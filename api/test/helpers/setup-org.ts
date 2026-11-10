// Organizations in staff setup (D23): made as staff make one (F10), then joined by the person invited (F1).
import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import type { MeResponse } from '../../src/handlers/me.ts';
import { call, signIn, type TestSession, type TownwiseTestServer } from './server.ts';

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

/** An organization made as staff make one (F10): active, with only an org admin invitation. */
export async function setupOrg(
  server: TownwiseTestServer,
  staff: TestSession,
  name = `Setup Kitchen ${randomUUID().slice(0, 6)}`,
): Promise<{ orgId: string; name: string; adminEmail: string }> {
  const adminEmail = uniqueEmail('first-admin');
  const res = await call(server, '/api/admin/orgs', { session: staff, json: { name, adminEmail } });
  expect(res.status).toBe(201);
  return { orgId: (await res.json() as { org: { id: string } }).org.id, name, adminEmail };
}

/** The person invited at `email` signs in and joins (F1). */
export async function joinAs(server: TownwiseTestServer, email: string): Promise<TestSession> {
  const session = await signIn(server, email);
  const me = await (await call(server, '/api/me', { session })).json() as MeResponse;
  const inviteId = me.access.state === 'invited' ? me.access.invitations[0]?.inviteId ?? '' : '';
  expect((await call(server, '/api/me/join', { session, json: { inviteId } })).status).toBe(200);
  return session;
}
