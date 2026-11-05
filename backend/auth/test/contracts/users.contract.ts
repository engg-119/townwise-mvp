import { expect, test, describe } from 'vitest';

import { DuplicateError, type AuthStores } from '../../src/stores/types.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');

export function runUserStoreContract(makeStores: () => Promise<AuthStores>): void {
  describe('UserStore contract', () => {
    test('create and find by id, email and subject', async () => {
      const { users } = await makeStores();
      const created = await users.create({ email: 'ada@example.test', googleSubject: 'sub-ada', now: NOW });
      expect(created.email).toBe('ada@example.test');
      expect(created.googleSubject).toBe('sub-ada');
      expect(created.id).toMatch(/^[0-9a-f]{24}$/);
      expect(await users.findById(created.id)).toEqual(created);
      expect(await users.findByEmail('ada@example.test')).toEqual(created);
      expect(await users.findByGoogleSubject('sub-ada')).toEqual(created);
      expect(await users.findById('not-an-object-id')).toBeNull();
      expect(await users.findByEmail('missing@example.test')).toBeNull();
    });

    test('duplicate email and duplicate subject throw DuplicateError with the right field', async () => {
      const { users } = await makeStores();
      await users.create({ email: 'ada@example.test', googleSubject: 'sub-ada', now: NOW });
      await expect(users.create({ email: 'ada@example.test', now: NOW })).rejects.toEqual(expect.any(DuplicateError));
      await expect(users.create({ email: 'ada@example.test', now: NOW })).rejects.toMatchObject({ field: 'email' });
      await expect(users.create({
        email: 'other@example.test',
        googleSubject: 'sub-ada',
        now: NOW,
      })).rejects.toMatchObject({ field: 'googleSubject' });
    });

    test('many users without a googleSubject coexist', async () => {
      const { users } = await makeStores();
      const first = await users.create({ email: 'one@example.test', now: NOW });
      const second = await users.create({ email: 'two@example.test', now: NOW });
      expect(first.googleSubject).toBeNull();
      expect(second.googleSubject).toBeNull();
      expect(first.id).not.toBe(second.id);
    });

    test('linkGoogleSubject only when unset', async () => {
      const { users } = await makeStores();
      const created = await users.create({ email: 'ada@example.test', now: NOW });
      const linked = await users.linkGoogleSubject({ id: created.id, subject: 'sub-ada' });
      expect(linked?.googleSubject).toBe('sub-ada');
      expect(await users.linkGoogleSubject({ id: created.id, subject: 'sub-other' })).toBeNull();
      expect((await users.findById(created.id))?.googleSubject).toBe('sub-ada');
      const other = await users.create({ email: 'bea@example.test', now: NOW });
      await expect(users.linkGoogleSubject({ id: other.id, subject: 'sub-ada' })).rejects.toMatchObject({
        field: 'googleSubject',
      });
    });

    test('updateEmail returns null when from is stale and throws DuplicateError(email) on a taken address', async () => {
      const { users } = await makeStores();
      const ada = await users.create({ email: 'ada@example.test', now: NOW });
      await users.create({ email: 'bea@example.test', now: NOW });
      expect(await users.updateEmail({ id: ada.id, from: 'stale@example.test', to: 'ada2@example.test' })).toBeNull();
      expect((await users.findById(ada.id))?.email).toBe('ada@example.test');
      await expect(users.updateEmail({ id: ada.id, from: 'ada@example.test', to: 'bea@example.test' })).rejects.toMatchObject({
        field: 'email',
      });
      const moved = await users.updateEmail({ id: ada.id, from: 'ada@example.test', to: 'ada2@example.test' });
      expect(moved?.email).toBe('ada2@example.test');
    });
  });
}
