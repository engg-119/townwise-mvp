import { afterEach, beforeEach, expect, test } from 'vitest';

import { runMagicLinkStoreContract } from './contracts/magic-links.contract.ts';
import { runSessionStoreContract } from './contracts/sessions.contract.ts';
import { runTotpStoreContract } from './contracts/totp.contract.ts';
import { runUserStoreContract } from './contracts/users.contract.ts';
import { openTestDb, type TestDb } from './helpers/server.ts';

let db: TestDb;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await db.close();
});

runUserStoreContract(() => Promise.resolve(db.stores));
runMagicLinkStoreContract(() => Promise.resolve(db.stores));
runTotpStoreContract(() => Promise.resolve(db.stores));
runSessionStoreContract(() => Promise.resolve(db.stores));

function indexNamed(
  indexes: readonly { key?: Record<string, unknown>; expireAfterSeconds?: number; partialFilterExpression?: unknown; sparse?: boolean }[],
  field: string,
): { expireAfterSeconds?: number; partialFilterExpression?: unknown; sparse?: boolean } | undefined {
  return indexes.find((entry) => entry.key?.[field] === 1);
}

test('every auth model reads from the primary', () => {
  for (const name of ['AuthUser', 'AuthSession', 'AuthRefreshRetired', 'AuthMagicLink', 'AuthTotp']) {
    const model = db.connection.models[name];
    expect(model, name).toBeDefined();
    expect(model?.schema.get('read')).toBe('primary');
  }
});

test('the googleSubject and previousRefreshHash indexes are partial on $type string and not sparse', async () => {
  const users = await db.connection.collection('users').indexes();
  const sessions = await db.connection.collection('auth_sessions').indexes();
  const google = indexNamed(users, 'googleSubject');
  const previous = indexNamed(sessions, 'previousRefreshHash');
  expect(google?.partialFilterExpression).toEqual({ googleSubject: { $type: 'string' } });
  expect(google?.sparse).not.toBe(true);
  expect(previous?.partialFilterExpression).toEqual({ previousRefreshHash: { $type: 'string' } });
  expect(previous?.sparse).not.toBe(true);
});

test('the users unique indexes carry the names the DocumentDB duplicate-key mapping reads', async () => {
  const users = await db.connection.collection('users').indexes();
  expect(users.filter((entry) => entry.unique === true).map((entry) => entry.name).sort())
    .toEqual(['email_1', 'googleSubject_1']);
});

// The tests' clock is frozen at 2026-06-01 (helpers/server.ts); by the wall clock the TTL monitor reads, every session
// and magic link they write has long expired, and a pass would delete it mid-test.
test('the test database deletes nothing by the wall clock: its TTL monitor is off', async () => {
  const reply = await db.connection.getClient().db('admin').command({ getParameter: 1, ttlMonitorEnabled: 1 });
  expect(reply.ttlMonitorEnabled).toBe(false);
});

test('TTL indexes present with the stated expireAfterSeconds', async () => {
  const sessions = await db.connection.collection('auth_sessions').indexes();
  const retired = await db.connection.collection('auth_refresh_retired').indexes();
  const links = await db.connection.collection('auth_magic_links').indexes();
  expect(indexNamed(sessions, 'absoluteExpiresAt')?.expireAfterSeconds).toBe(604800);
  expect(indexNamed(retired, 'expiresAt')?.expireAfterSeconds).toBe(604800);
  expect(indexNamed(links, 'expiresAt')?.expireAfterSeconds).toBe(0);
});
