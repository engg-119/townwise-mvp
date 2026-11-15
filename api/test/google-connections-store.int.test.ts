// The Google connections store (src/stores/google-connections.ts, openspec change connect-google-calendar: design
// decisions 5, 6 and 10): one connection per (organization, person), its refresh token only sealed and never in a
// record, a reconnect replacing it, a check due at least daily and never null, the first revocation's time kept, and
// tenant scoping. Every token here is a made-up placeholder for what calendar/secret.ts would seal.
import { randomUUID } from 'node:crypto';

import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE } from '../src/calendar/google.ts';
import {
  CHECK_INTERVAL_MS, createGoogleConnectionStore, googleConnectionModel, type GoogleConnectionRecord, type GoogleConnectionStore,
} from '../src/stores/google-connections.ts';
import { createOrg } from './helpers/fixtures.ts';
import { MINUTE, startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const SEALED = 'v1:sealed-refresh-token-placeholder-0001';
const RESEALED = 'v1:sealed-refresh-token-placeholder-0002';
const SCOPES = ['openid', CALENDAR_LIST_SCOPE, CALENDAR_EVENTS_SCOPE];

let server: TownwiseTestServer;
let connections: GoogleConnectionStore;

beforeAll(async () => {
  server = await startTownwiseServer();
  connections = createGoogleConnectionStore(server.connection);
});
afterAll(async () => { await server.close(); });

async function orgScope(): Promise<{ orgId: string; scope: OrgScope }> {
  const orgId = await createOrg(server, { name: `Google Cafe ${randomUUID().slice(0, 6)}` });
  return { orgId, scope: scopeForNewOrg(STAFF, orgId) };
}

async function connect(scope: OrgScope, userId: string, sealed = SEALED): Promise<GoogleConnectionRecord> {
  const stored = await connections.upsert(scope, userId, { sealedRefreshToken: sealed, scopes: SCOPES, now: server.clock.now() });
  if (stored === null) throw new Error('no connection stored');
  return stored;
}

function rows(filter: Record<string, unknown> = {}) {
  return server.connection.collection('tw_google_connections').find(filter).sort({ _id: 1 }).toArray();
}

async function snapshotOf(orgId: string): Promise<string> {
  return JSON.stringify(await rows({ orgId: new Types.ObjectId(orgId) }));
}

describe('storing a connection', () => {
  it('stores one connection per person per organization, its token only sealed and in no record, its check due in 24 hours', async () => {
    const { orgId, scope } = await orgScope();
    const now = server.clock.now();
    const stored = await connect(scope, 'user-0001');
    expect(stored).toEqual({
      id: expect.any(String) as string, userId: 'user-0001', scopes: SCOPES, agreedAt: now, connectedAt: now, updatedAt: now, revokedAt: null,
      checkAt: new Date(now.getTime() + CHECK_INTERVAL_MS), leaseUntil: null,
    });
    expect(CHECK_INTERVAL_MS).toBe(24 * 60 * MINUTE);
    expect(await connections.find(scope, stored.id)).toEqual(stored);
    expect(await connections.findForUser(scope, 'user-0001')).toEqual(stored);
    expect(await connections.findForUser(scope, 'user-0002')).toBeNull();
    expect(JSON.stringify([stored, await connections.listForOrg(scope)])).not.toContain(SEALED);
    expect(Object.keys(stored)).not.toContain('sealedRefreshToken');

    // The database holds the token only as the sealed string, and nothing that names the person or their Google account.
    const raw = await rows({ orgId: new Types.ObjectId(orgId) });
    expect(raw).toHaveLength(1);
    expect(Object.keys(raw[0] ?? {}).sort()).toEqual([
      '_id', 'agreedAt', 'checkAt', 'connectedAt', 'leaseUntil', 'orgId', 'revokedAt', 'scopes', 'sealedRefreshToken', 'updatedAt', 'userId',
    ]);
    expect(raw[0]).toMatchObject({ sealedRefreshToken: SEALED, userId: 'user-0001' });
    expect(await connections.sealedToken(scope, stored.id)).toBe(SEALED);
  });

  it('a reconnect replaces the row: a new token, revokedAt cleared, the times and the check moved on', async () => {
    const { orgId, scope } = await orgScope();
    const first = await connect(scope, 'user-0001');
    expect(await connections.markRevoked(scope, first.id, server.clock.now())).toBe(true);
    server.clock.advance(MINUTE);
    const later = server.clock.now();
    const again = await connect(scope, 'user-0001', RESEALED);
    expect(again).toEqual({
      ...first, agreedAt: later, connectedAt: later, updatedAt: later, revokedAt: null, checkAt: new Date(later.getTime() + CHECK_INTERVAL_MS),
    });
    expect(await connections.sealedToken(scope, first.id)).toBe(RESEALED);
    expect(await rows({ orgId: new Types.ObjectId(orgId) })).toHaveLength(1);
  });

  it('a null token keeps the stored one and updates only a row that is there', async () => {
    const { orgId, scope } = await orgScope();
    const first = await connect(scope, 'user-0001');
    server.clock.advance(MINUTE);
    const later = server.clock.now();
    const kept = await connections.upsert(scope, 'user-0001', { sealedRefreshToken: null, scopes: SCOPES, now: later });
    expect(kept).toEqual({ ...first, agreedAt: later, connectedAt: later, updatedAt: later, checkAt: new Date(later.getTime() + CHECK_INTERVAL_MS) });
    expect(await connections.sealedToken(scope, first.id)).toBe(SEALED);
    // No row: nothing is inserted without a token.
    expect(await connections.upsert(scope, 'user-0002', { sealedRefreshToken: null, scopes: SCOPES, now: later })).toBeNull();
    expect(await rows({ orgId: new Types.ObjectId(orgId) })).toHaveLength(1);
  });

  it('a null token never clears a revocation: a connection revoked since connect checked it is left as it is, and null answered', async () => {
    const { orgId, scope } = await orgScope();
    const first = await connect(scope, 'user-0001');
    const revokedAt = server.clock.now();
    expect(await connections.markRevoked(scope, first.id, revokedAt)).toBe(true);
    const before = await snapshotOf(orgId);
    server.clock.advance(MINUTE);
    expect(await connections.upsert(scope, 'user-0001', { sealedRefreshToken: null, scopes: SCOPES, now: server.clock.now() })).toBeNull();
    expect(await snapshotOf(orgId)).toBe(before);
    expect(await connections.find(scope, first.id)).toMatchObject({ revokedAt });
  });

  it('two first connects at once keep one row, and the unique index refuses a second row for the same person', async () => {
    const { orgId, scope } = await orgScope();
    const [one, two] = await Promise.all([connect(scope, 'user-0001', SEALED), connect(scope, 'user-0001', RESEALED)]);
    expect(one.id).toBe(two.id);
    expect(await rows({ orgId: new Types.ObjectId(orgId) })).toHaveLength(1);
    const now = server.clock.now();
    const duplicate = googleConnectionModel(server.connection).create({
      orgId: new Types.ObjectId(orgId), userId: 'user-0001', sealedRefreshToken: SEALED, scopes: SCOPES, agreedAt: now, connectedAt: now,
      updatedAt: now, revokedAt: null, checkAt: now, leaseUntil: null,
    });
    await expect(duplicate).rejects.toSatisfy(isDuplicateKeyError);
    // The same person in another organization has a row of their own there.
    const other = await orgScope();
    expect((await connect(other.scope, 'user-0001')).id).not.toBe(one.id);
  });
});

describe('revocation and the check', () => {
  it('markRevoked keeps the first refusal’s time, and replaceToken swaps the sealed token', async () => {
    const { scope } = await orgScope();
    const stored = await connect(scope, 'user-0001');
    const first = server.clock.now();
    expect(await connections.markRevoked(scope, stored.id, first)).toBe(true);
    server.clock.advance(MINUTE);
    expect(await connections.markRevoked(scope, stored.id, server.clock.now())).toBe(false);
    expect(await connections.find(scope, stored.id)).toMatchObject({ revokedAt: first });

    const at = server.clock.now();
    expect(await connections.replaceToken(scope, stored.id, RESEALED, at)).toBe(true);
    expect(await connections.sealedToken(scope, stored.id)).toBe(RESEALED);
    expect(await connections.find(scope, stored.id)).toMatchObject({ updatedAt: at, revokedAt: first });
  });

  it('markForCheck makes it due now; clearCheck pushes it 24 hours on and lets a lease go; checkAt is never null', async () => {
    const { scope } = await orgScope();
    const stored = await connect(scope, 'user-0001');
    const lease = new Date(server.clock.now().getTime() + 5 * MINUTE);
    await server.connection.collection('tw_google_connections').updateOne({ _id: new Types.ObjectId(stored.id) }, { $set: { leaseUntil: lease } });

    server.clock.advance(MINUTE);
    const marked = server.clock.now();
    expect(await connections.markForCheck(scope, stored.id, marked)).toBe(true);
    expect(await connections.find(scope, stored.id)).toMatchObject({ checkAt: marked, leaseUntil: lease });

    server.clock.advance(MINUTE);
    const checked = server.clock.now();
    expect(await connections.clearCheck(scope, stored.id, checked)).toBe(true);
    expect(await connections.find(scope, stored.id)).toMatchObject({ checkAt: new Date(checked.getTime() + CHECK_INTERVAL_MS), leaseUntil: null });

    // A row without a check is refused.
    const now = server.clock.now();
    const unchecked = googleConnectionModel(server.connection).create({
      orgId: new Types.ObjectId(scope.orgId), userId: 'user-0002', sealedRefreshToken: SEALED, scopes: SCOPES, agreedAt: now, connectedAt: now, updatedAt: now,
    });
    await expect(unchecked).rejects.toThrow(/checkAt/);
    expect((await rows()).every((row) => row.checkAt instanceof Date)).toBe(true);
  });
});

describe('scoping and removal', () => {
  it('another organization’s scope reaches nothing, and an unknown id is answered the same', async () => {
    const a = await orgScope();
    const b = await orgScope();
    const ours = await connect(a.scope, 'user-0001');
    const before = await snapshotOf(a.orgId);
    const now = server.clock.now();
    for (const id of [ours.id, new Types.ObjectId().toHexString()]) {
      expect(await connections.find(b.scope, id)).toBeNull();
      expect(await connections.sealedToken(b.scope, id)).toBeNull();
      expect(await connections.replaceToken(b.scope, id, RESEALED, now)).toBe(false);
      expect(await connections.markRevoked(b.scope, id, now)).toBe(false);
      expect(await connections.markForCheck(b.scope, id, now)).toBe(false);
      expect(await connections.clearCheck(b.scope, id, now)).toBe(false);
      expect(await connections.remove(b.scope, id)).toBe(false);
    }
    expect(await connections.findForUser(b.scope, 'user-0001')).toBeNull();
    expect(await connections.listForOrg(b.scope)).toEqual([]);
    expect(await connections.removeForOrg(b.scope)).toBe(0);
    expect(await snapshotOf(a.orgId)).toBe(before);
  });

  it('lists an organization’s connections oldest first, and remove and removeForOrg delete only their own', async () => {
    const a = await orgScope();
    const b = await orgScope();
    const first = await connect(a.scope, 'user-0001');
    server.clock.advance(MINUTE);
    const second = await connect(a.scope, 'user-0002');
    const theirs = await connect(b.scope, 'user-0001');
    expect(await connections.listForOrg(a.scope)).toEqual([first, second]);

    expect(await connections.remove(a.scope, first.id)).toBe(true);
    expect(await connections.remove(a.scope, first.id)).toBe(false);
    expect(await connections.find(a.scope, first.id)).toBeNull();
    expect(await connections.removeForOrg(a.scope)).toBe(1);
    expect(await connections.listForOrg(a.scope)).toEqual([]);
    expect(await connections.listForOrg(b.scope)).toEqual([theirs]);
  });
});
