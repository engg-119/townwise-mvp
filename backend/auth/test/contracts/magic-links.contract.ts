import { expect, test, describe } from 'vitest';

import type { AuthStores } from '../../src/stores/types.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');

export function runMagicLinkStoreContract(makeStores: () => Promise<AuthStores>): void {
  describe('MagicLinkStore contract', () => {
    test('consume once: 5 concurrent consumes, 1 true', async () => {
      const { magicLinks } = await makeStores();
      await magicLinks.create({
        tokenHash: 'hash-once',
        email: 'ada@example.test',
        platform: 'web',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
      const results = await Promise.all(Array.from({ length: 5 }, () => magicLinks.consume({
        tokenHash: 'hash-once',
        email: 'ada@example.test',
        platform: 'web',
        now: NOW,
      })));
      expect(results.filter((won) => won)).toHaveLength(1);
    });

    test('wrong email or platform returns false and leaves the link consumable', async () => {
      const { magicLinks } = await makeStores();
      await magicLinks.create({
        tokenHash: 'hash-wrong',
        email: 'ada@example.test',
        platform: 'web',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
      expect(await magicLinks.consume({
        tokenHash: 'hash-wrong',
        email: 'bea@example.test',
        platform: 'web',
        now: NOW,
      })).toBe(false);
      expect(await magicLinks.consume({
        tokenHash: 'hash-wrong',
        email: 'ada@example.test',
        platform: 'native',
        now: NOW,
      })).toBe(false);
      expect(await magicLinks.consume({
        tokenHash: 'hash-wrong',
        email: 'ada@example.test',
        platform: 'web',
        now: NOW,
      })).toBe(true);
    });

    test('an expired link is not consumable', async () => {
      const { magicLinks } = await makeStores();
      await magicLinks.create({
        tokenHash: 'hash-expired',
        email: 'ada@example.test',
        platform: 'web',
        createdAt: new Date(NOW.getTime() - 120_000),
        expiresAt: new Date(NOW.getTime() - 1_000),
      });
      expect(await magicLinks.consume({
        tokenHash: 'hash-expired',
        email: 'ada@example.test',
        platform: 'web',
        now: NOW,
      })).toBe(false);
    });

    test('deleteForEmail removes every pending link for the email', async () => {
      const { magicLinks } = await makeStores();
      await magicLinks.create({
        tokenHash: 'hash-a',
        email: 'ada@example.test',
        platform: 'web',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
      await magicLinks.create({
        tokenHash: 'hash-b',
        email: 'ada@example.test',
        platform: 'native',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
      await magicLinks.create({
        tokenHash: 'hash-c',
        email: 'bea@example.test',
        platform: 'web',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
      expect(await magicLinks.deleteForEmail('ada@example.test')).toBe(2);
      expect(await magicLinks.consume({
        tokenHash: 'hash-a',
        email: 'ada@example.test',
        platform: 'web',
        now: NOW,
      })).toBe(false);
      expect(await magicLinks.consume({
        tokenHash: 'hash-c',
        email: 'bea@example.test',
        platform: 'web',
        now: NOW,
      })).toBe(true);
    });
  });
}
