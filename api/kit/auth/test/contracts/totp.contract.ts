import { expect, test, describe } from 'vitest';

import type { AuthStores } from '../../src/stores/types.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);

export function runTotpStoreContract(makeStores: () => Promise<AuthStores>): void {
  describe('TotpStore contract', () => {
    test('startEnrollment refuses when enabled', async () => {
      const { totp } = await makeStores();
      expect(await totp.startEnrollment({
        userId: 'user-1',
        secretEnc: 'enc-1',
        pendingExpiresAt: LATER,
      })).toBe(true);
      expect(await totp.confirmEnrollment({
        userId: 'user-1',
        step: 10,
        recoveryCodeHashes: ['h1'],
        now: NOW,
      })).toBe(true);
      expect(await totp.startEnrollment({
        userId: 'user-1',
        secretEnc: 'enc-2',
        pendingExpiresAt: LATER,
      })).toBe(false);
      expect((await totp.get('user-1'))?.secretEnc).toBe('enc-1');
      expect((await totp.get('user-1'))?.status).toBe('enabled');
    });

    test('confirmEnrollment is a CAS and refuses an expired pending factor', async () => {
      const { totp } = await makeStores();
      await totp.startEnrollment({ userId: 'user-2', secretEnc: 'enc', pendingExpiresAt: NOW });
      expect(await totp.confirmEnrollment({
        userId: 'user-2',
        step: 3,
        recoveryCodeHashes: ['h'],
        now: LATER,
      })).toBe(false);
      await totp.startEnrollment({ userId: 'user-2', secretEnc: 'enc', pendingExpiresAt: LATER });
      const results = await Promise.all([0, 1].map((step) => totp.confirmEnrollment({
        userId: 'user-2',
        step,
        recoveryCodeHashes: [`h${String(step)}`],
        now: NOW,
      })));
      expect(results.filter((won) => won)).toHaveLength(1);
      expect(await totp.confirmEnrollment({
        userId: 'user-2',
        step: 9,
        recoveryCodeHashes: ['again'],
        now: NOW,
      })).toBe(false);
    });

    test('claimStep is monotonic under concurrency', async () => {
      const { totp } = await makeStores();
      await totp.startEnrollment({ userId: 'user-3', secretEnc: 'enc', pendingExpiresAt: LATER });
      await totp.confirmEnrollment({ userId: 'user-3', step: 4, recoveryCodeHashes: [], now: NOW });
      const results = await Promise.all(Array.from({ length: 10 }, () => totp.claimStep({ userId: 'user-3', step: 8, verifiedSecretEnc: 'enc' })));
      expect(results.filter((won) => won)).toHaveLength(1);
      expect(await totp.claimStep({ userId: 'user-3', step: 7, verifiedSecretEnc: 'enc' })).toBe(false);
      expect(await totp.claimStep({ userId: 'user-3', step: 9, verifiedSecretEnc: 'enc' })).toBe(true);
    });

    test('claimStep replaces secretEnc when given', async () => {
      const { totp } = await makeStores();
      await totp.startEnrollment({ userId: 'user-4', secretEnc: 'old', pendingExpiresAt: LATER });
      await totp.confirmEnrollment({ userId: 'user-4', step: 1, recoveryCodeHashes: [], now: NOW });
      expect(await totp.claimStep({ userId: 'user-4', step: 2, verifiedSecretEnc: 'old', secretEnc: 'new' })).toBe(true);
      expect((await totp.get('user-4'))?.secretEnc).toBe('new');
    });

    test('consumeRecoveryCode once under concurrency', async () => {
      const { totp } = await makeStores();
      await totp.startEnrollment({ userId: 'user-5', secretEnc: 'enc', pendingExpiresAt: LATER });
      await totp.confirmEnrollment({
        userId: 'user-5',
        step: 1,
        recoveryCodeHashes: ['code-hash', 'other'],
        now: NOW,
      });
      const results = await Promise.all(Array.from({ length: 5 }, () => totp.consumeRecoveryCode({
        userId: 'user-5',
        codeHash: 'code-hash',
      })));
      expect(results.filter((won) => won)).toHaveLength(1);
      expect((await totp.get('user-5'))?.recoveryCodeHashes).toEqual(['other']);
    });

    test('startReset needs an enabled factor and leaves the live secret alone', async () => {
      const { totp } = await makeStores();
      const reset = { userId: 'user-6', pendingSecretEnc: 'next', pendingExpiresAt: LATER, sessionId: 's1' };
      expect(await totp.startReset(reset)).toBe(false);
      await totp.startEnrollment({ userId: 'user-6', secretEnc: 'live', pendingExpiresAt: LATER });
      expect(await totp.startReset(reset)).toBe(false);
      await totp.confirmEnrollment({ userId: 'user-6', step: 1, recoveryCodeHashes: ['old'], now: NOW });
      expect(await totp.get('user-6')).toMatchObject({ pendingSecretEnc: null, pendingSessionId: null });
      expect(await totp.startReset(reset)).toBe(true);
      expect(await totp.get('user-6')).toMatchObject({
        status: 'enabled', secretEnc: 'live', lastUsedStep: 1, recoveryCodeHashes: ['old'],
        pendingSecretEnc: 'next', pendingSessionId: 's1', pendingExpiresAt: LATER,
      });
    });

    test('confirmReset swaps once, only for the pending secret, its session and before expiry', async () => {
      const { totp } = await makeStores();
      await totp.startEnrollment({ userId: 'user-7', secretEnc: 'live', pendingExpiresAt: LATER });
      await totp.confirmEnrollment({ userId: 'user-7', step: 1, recoveryCodeHashes: ['old'], now: NOW });
      await totp.startReset({ userId: 'user-7', pendingSecretEnc: 'next', pendingExpiresAt: LATER, sessionId: 's1' });
      const confirm = { userId: 'user-7', pendingSecretEnc: 'next', sessionId: 's1', step: 5, recoveryCodeHashes: ['new'], now: NOW };
      expect(await totp.confirmReset({ ...confirm, sessionId: 's2' })).toBe(false);
      expect(await totp.confirmReset({ ...confirm, pendingSecretEnc: 'other' })).toBe(false);
      expect(await totp.confirmReset({ ...confirm, now: LATER })).toBe(false);
      expect((await totp.get('user-7'))?.secretEnc).toBe('live');
      const results = await Promise.all(Array.from({ length: 5 }, () => totp.confirmReset(confirm)));
      expect(results.filter((won) => won)).toHaveLength(1);
      expect(await totp.get('user-7')).toMatchObject({
        status: 'enabled', secretEnc: 'next', lastUsedStep: 5, recoveryCodeHashes: ['new'],
        pendingSecretEnc: null, pendingSessionId: null, pendingExpiresAt: null,
      });
    });

    test('claimStep claims nothing for a code checked against a secret a reset has replaced', async () => {
      const { totp } = await makeStores();
      await totp.startEnrollment({ userId: 'user-8', secretEnc: 'live', pendingExpiresAt: LATER });
      await totp.confirmEnrollment({ userId: 'user-8', step: 1, recoveryCodeHashes: [], now: NOW });
      await totp.startReset({ userId: 'user-8', pendingSecretEnc: 'next', pendingExpiresAt: LATER, sessionId: 's1' });
      await totp.confirmReset({ userId: 'user-8', pendingSecretEnc: 'next', sessionId: 's1', step: 5, recoveryCodeHashes: [], now: NOW });
      // A sign-in that read the old secret before the swap: a later step, and a lazy re-encryption of the old secret.
      expect(await totp.claimStep({ userId: 'user-8', step: 6, verifiedSecretEnc: 'live' })).toBe(false);
      expect(await totp.claimStep({ userId: 'user-8', step: 6, verifiedSecretEnc: 'live', secretEnc: 'live-again' })).toBe(false);
      expect(await totp.get('user-8')).toMatchObject({ secretEnc: 'next', lastUsedStep: 5 });
      expect(await totp.claimStep({ userId: 'user-8', step: 6, verifiedSecretEnc: 'next' })).toBe(true);
    });
  });
}
