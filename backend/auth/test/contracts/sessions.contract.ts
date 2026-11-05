import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthStores, SessionRecord } from '../../src/stores/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T00:00:00.000Z');

function userId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

async function open(stores: AuthStores, input?: {
  refreshHash?: string;
  platform?: 'web' | 'native';
  now?: Date;
  absoluteExpiresAt?: Date;
  user?: string;
}): Promise<SessionRecord> {
  const now = input?.now ?? NOW;
  return stores.sessions.create({
    id: randomUUID(),
    userId: input?.user ?? userId(),
    platform: input?.platform ?? 'web',
    refreshHash: input?.refreshHash ?? randomUUID().replace(/-/g, ''),
    now,
    absoluteExpiresAt: input?.absoluteExpiresAt ?? new Date(now.getTime() + 30 * DAY),
  });
}

function window(now: Date): { now: Date; idleCutoff: Date } {
  return { now, idleCutoff: new Date(now.getTime() - 14 * DAY) };
}

export function runSessionStoreContract(makeStores: () => Promise<AuthStores>): void {
  describe('SessionStore contract', () => {
    test('create and findLive', async () => {
      const stores = await makeStores();
      const created = await open(stores);
      expect(await stores.sessions.findLive(created.id, window(NOW))).toEqual(created);
      expect(await stores.sessions.findLive(randomUUID(), window(NOW))).toBeNull();
    });

    test('idle and absolute expiry', async () => {
      const stores = await makeStores();
      const idle = await open(stores, { now: NOW });
      const later = new Date(NOW.getTime() + 14 * DAY + 1000);
      expect(await stores.sessions.findLive(idle.id, window(later))).toBeNull();
      expect(await stores.sessions.rotate({
        currentHash: idle.refreshHash,
        newHash: 'after-idle',
        platform: 'web',
        ...window(later),
      })).toBeNull();

      const absolute = await open(stores, {
        now: NOW,
        absoluteExpiresAt: new Date(NOW.getTime() + 1000),
      });
      const past = new Date(NOW.getTime() + 2000);
      expect(await stores.sessions.findLive(absolute.id, window(past))).toBeNull();
    });

    test('rotate CAS: 10 concurrent calls, exactly 1 wins, and records the retired hash', async () => {
      const stores = await makeStores();
      const created = await open(stores, { refreshHash: 'current-hash' });
      const results = await Promise.all(Array.from({ length: 10 }, (_unused, index) => stores.sessions.rotate({
        currentHash: 'current-hash',
        newHash: `next-${String(index)}`,
        platform: 'web',
        ...window(new Date(NOW.getTime() + 1000)),
      })));
      const winners = results.filter((row) => row !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.previousRefreshHash).toBe('current-hash');
      expect(await stores.sessions.findByRetiredHash('current-hash', 'web')).toMatchObject({ id: created.id });
    });

    test('rotateFromPrevious CAS leaves lastUsedAt unchanged and records the retired hash', async () => {
      const stores = await makeStores();
      const created = await open(stores, { refreshHash: 'hash-0' });
      const rotated = await stores.sessions.rotate({
        currentHash: 'hash-0',
        newHash: 'hash-1',
        platform: 'web',
        ...window(new Date(NOW.getTime() + 1000)),
      });
      const stamped = rotated?.lastUsedAt;
      const again = new Date(NOW.getTime() + 5000);
      const results = await Promise.all([0, 1].map((index) => stores.sessions.rotateFromPrevious({
        id: created.id,
        previousHash: 'hash-0',
        expectedCurrentHash: 'hash-1',
        newHash: `hash-grace-${String(index)}`,
        ...window(again),
      })));
      const winners = results.filter((row) => row !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.lastUsedAt).toEqual(stamped);
      expect(await stores.sessions.findByRetiredHash('hash-1', 'web')).toMatchObject({ id: created.id });
    });

    test('findByPreviousHash finds the session live or not', async () => {
      const stores = await makeStores();
      const created = await open(stores, { refreshHash: 'hash-0' });
      await stores.sessions.rotate({
        currentHash: 'hash-0',
        newHash: 'hash-1',
        platform: 'web',
        ...window(NOW),
      });
      expect((await stores.sessions.findByPreviousHash('hash-0', 'web'))?.id).toBe(created.id);
      expect(await stores.sessions.revoke({ id: created.id, reason: 'logout', now: NOW })).toBe(true);
      const after = await stores.sessions.findByPreviousHash('hash-0', 'web');
      expect(after?.id).toBe(created.id);
      expect(after?.revokedAt).not.toBeNull();
    });

    test('findByRetiredHash finds the session two rotations later', async () => {
      const stores = await makeStores();
      const created = await open(stores, { refreshHash: 'hash-0' });
      await stores.sessions.rotate({
        currentHash: 'hash-0', newHash: 'hash-1', platform: 'web', ...window(NOW),
      });
      await stores.sessions.rotate({
        currentHash: 'hash-1', newHash: 'hash-2', platform: 'web', ...window(new Date(NOW.getTime() + 1000)),
      });
      expect(await stores.sessions.findByPreviousHash('hash-0', 'web')).toBeNull();
      expect((await stores.sessions.findByRetiredHash('hash-0', 'web'))?.id).toBe(created.id);
      expect((await stores.sessions.findByRetiredHash('hash-1', 'web'))?.refreshHash).toBe('hash-2');
    });

    test('findByPreviousHash and findByRetiredHash refuse the other platform', async () => {
      const stores = await makeStores();
      const created = await open(stores, { refreshHash: 'hash-0', platform: 'web' });
      await stores.sessions.rotate({
        currentHash: 'hash-0', newHash: 'hash-1', platform: 'web', ...window(NOW),
      });
      expect(await stores.sessions.findByPreviousHash('hash-0', 'native')).toBeNull();
      expect(await stores.sessions.findByRetiredHash('hash-0', 'native')).toBeNull();
      expect((await stores.sessions.findByPreviousHash('hash-0', 'web'))?.id).toBe(created.id);
    });

    test('revoke is idempotent', async () => {
      const stores = await makeStores();
      const created = await open(stores);
      expect(await stores.sessions.revoke({ id: created.id, reason: 'logout', now: NOW })).toBe(true);
      expect(await stores.sessions.revoke({ id: created.id, reason: 'logout', now: NOW })).toBe(false);
      expect(await stores.sessions.findLive(created.id, window(NOW))).toBeNull();
    });

    test('revokeByRefreshHash revokes only the live session holding the hash', async () => {
      const stores = await makeStores();
      const live = await open(stores, { refreshHash: 'live-hash' });
      const other = await open(stores, { refreshHash: 'other-hash' });
      const stale = await open(stores, { refreshHash: 'stale-hash', now: new Date(NOW.getTime() - 20 * DAY) });
      expect(await stores.sessions.revokeByRefreshHash({
        hash: 'live-hash', platform: 'native', reason: 'logout', now: NOW,
      })).toBe(false);
      expect(await stores.sessions.revokeByRefreshHash({
        hash: 'stale-hash', platform: 'web', reason: 'logout', now: NOW,
      })).toBe(false);
      expect(await stores.sessions.revokeByRefreshHash({
        hash: 'live-hash', platform: 'web', reason: 'logout', now: NOW,
      })).toBe(true);
      expect(await stores.sessions.revokeByRefreshHash({
        hash: 'live-hash', platform: 'web', reason: 'logout', now: NOW,
      })).toBe(false);
      expect(await stores.sessions.findLive(live.id, window(NOW))).toBeNull();
      expect(await stores.sessions.findLive(other.id, window(NOW))).not.toBeNull();
      expect(await stores.sessions.findLive(stale.id, window(new Date(NOW.getTime() - 20 * DAY)))).not.toBeNull();
    });

    test('revokeAllForUser honors exceptId', async () => {
      const stores = await makeStores();
      const owner = userId();
      const first = await open(stores, { user: owner });
      const second = await open(stores, { user: owner });
      const kept = await open(stores, { user: owner });
      const stranger = await open(stores);
      const revoked = await stores.sessions.revokeAllForUser({
        userId: owner,
        reason: 'logout_all',
        now: NOW,
        exceptId: kept.id,
      });
      expect(revoked).toBe(2);
      expect(await stores.sessions.findLive(first.id, window(NOW))).toBeNull();
      expect(await stores.sessions.findLive(second.id, window(NOW))).toBeNull();
      expect((await stores.sessions.findLive(kept.id, window(NOW)))?.id).toBe(kept.id);
      expect((await stores.sessions.findLive(stranger.id, window(NOW)))?.id).toBe(stranger.id);
    });
  });
}
