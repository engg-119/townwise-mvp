import mongoose, { type Connection } from 'mongoose';
import { expect, test } from 'vitest';

import { createUserStore } from '../src/stores/mongo/users.ts';
import { DuplicateError, type UserStore } from '../src/stores/types.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const ID = '0123456789abcdef01234567';

// Shapes as documentdb-local pg17-1.0.0 (the Azure DocumentDB vCore engine) returns them.
const DOCDB_INSERT = 'Duplicate key violation on the requested collection: Index ';
const DOCDB_FIND_AND_MODIFY = 'Duplicate key violation on the requested collection.';

function duplicate(fields: Record<string, unknown>): Error {
  return new mongoose.mongo.MongoServerError({ code: 11000, ...fields });
}

/** A UserStore whose model rejects every write with `err`. */
function storeRejecting(err: Error): UserStore {
  const reject = (): Promise<never> => Promise.reject(err);
  const connection = { models: { AuthUser: { create: reject, findOneAndUpdate: reject } } };
  return createUserStore(connection as unknown as Connection);
}

const create = (users: UserStore): Promise<unknown> => users.create({ email: 'ada@example.test', now: NOW });
const updateEmail = (users: UserStore): Promise<unknown> =>
  users.updateEmail({ id: ID, from: 'ada@example.test', to: 'bea@example.test' });
const linkGoogleSubject = (users: UserStore): Promise<unknown> => users.linkGoogleSubject({ id: ID, subject: 'sub-ada' });

test('a DocumentDB insert duplicate maps the named index to its field', async () => {
  for (const [index, field] of [['email_1', 'email'], ['googleSubject_1', 'googleSubject']] as const) {
    const err = duplicate({ index: 0, errmsg: `${DOCDB_INSERT}'${index}'` });
    const rejection = create(storeRejecting(err));
    await expect(rejection).rejects.toBeInstanceOf(DuplicateError);
    await expect(rejection).rejects.toMatchObject({ field });
  }
});

test('a DocumentDB findAndModify duplicate names no index, so it maps to the one field the update sets', async () => {
  const err = duplicate({ ok: 0, codeName: 'DuplicateKey', errmsg: DOCDB_FIND_AND_MODIFY });
  await expect(updateEmail(storeRejecting(err))).rejects.toMatchObject({ name: 'DuplicateError', field: 'email' });
  await expect(linkGoogleSubject(storeRejecting(err))).rejects.toMatchObject({
    name: 'DuplicateError',
    field: 'googleSubject',
  });
});

test('an index-less DocumentDB duplicate on create rethrows, since an insert can collide on either field', async () => {
  const err = duplicate({ ok: 0, codeName: 'DuplicateKey', errmsg: DOCDB_FIND_AND_MODIFY });
  await expect(create(storeRejecting(err))).rejects.toBe(err);
});

test('a MongoDB duplicate maps by keyPattern or keyValue and never reads the message', async () => {
  const mongoText = 'E11000 duplicate key error collection: townwise.users index: email_1 dup key: { email: "a" }';
  const byPattern = duplicate({ index: 0, errmsg: mongoText, keyPattern: { email: 1 }, keyValue: { email: 'a' } });
  await expect(create(storeRejecting(byPattern))).rejects.toMatchObject({ field: 'email' });
  const byValue = duplicate({ errmsg: mongoText, keyValue: { googleSubject: 'a' } });
  await expect(create(storeRejecting(byValue))).rejects.toMatchObject({ field: 'googleSubject' });
  const patternWins = duplicate({ errmsg: `${DOCDB_INSERT}'googleSubject_1'`, keyPattern: { email: 1 } });
  await expect(create(storeRejecting(patternWins))).rejects.toMatchObject({ field: 'email' });
  const otherIndex = duplicate({ errmsg: `${DOCDB_INSERT}'email_1'`, keyPattern: { _id: 1 }, keyValue: { _id: 1 } });
  await expect(create(storeRejecting(otherIndex))).rejects.toBe(otherIndex);
  const otherOnUpdate = duplicate({ errmsg: DOCDB_FIND_AND_MODIFY, keyPattern: { _id: 1 } });
  await expect(updateEmail(storeRejecting(otherOnUpdate))).rejects.toBe(otherOnUpdate);
});

test('an index name that is not one of userSchema\'s unique indexes rethrows', async () => {
  for (const index of ['_id_', 'email_1_tenant_1', 'constructor', '__proto__']) {
    const err = duplicate({ index: 0, errmsg: `${DOCDB_INSERT}'${index}'` });
    await expect(create(storeRejecting(err))).rejects.toBe(err);
    await expect(updateEmail(storeRejecting(err))).rejects.toBe(err);
  }
});

test('a message that mentions another field anywhere but the exact DocumentDB form rethrows', async () => {
  const hostile = [
    'E11000 duplicate key error collection: townwise.users index: email_1 dup key: { email: "x: Index \'googleSubject_1\'" }',
    `${DOCDB_INSERT}'email_1' and ${DOCDB_INSERT}'googleSubject_1'`,
    `${DOCDB_INSERT}'email_1'\n${DOCDB_INSERT}'googleSubject_1'`,
    `prefix ${DOCDB_INSERT}'googleSubject_1'`,
    `${DOCDB_FIND_AND_MODIFY} googleSubject`,
  ];
  for (const errmsg of hostile) {
    const err = duplicate({ errmsg });
    await expect(create(storeRejecting(err))).rejects.toBe(err);
    await expect(updateEmail(storeRejecting(err))).rejects.toBe(err);
    await expect(linkGoogleSubject(storeRejecting(err))).rejects.toBe(err);
  }
});
