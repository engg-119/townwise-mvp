import mongoose from 'mongoose';
import { expect, it } from 'vitest';

import { AppError, parseInput } from '@ckeith26/server-core';

import { isDuplicateKeyError, objectId } from '../src/errors.ts';

it('isDuplicateKeyError: true for MongoServerError and MongoBulkWriteError with code 11000', () => {
  expect(isDuplicateKeyError(new mongoose.mongo.MongoServerError({
    code: 11000,
    errmsg: 'E11000 duplicate key error',
  }))).toBe(true);

  // The driver types declare WriteError, but mongodb 7.7's package entry does not export the class.
  const writeError = {
    code: 11000,
    index: 0,
    errmsg: 'E11000',
    errInfo: {},
    op: {},
  } as unknown as mongoose.mongo.WriteError;
  expect(isDuplicateKeyError(new mongoose.mongo.MongoBulkWriteError(
    { message: 'E11000', code: 11000, writeErrors: [writeError] },
    {} as mongoose.mongo.BulkWriteResult,
  ))).toBe(true);
  expect(isDuplicateKeyError(new mongoose.mongo.MongoBulkWriteError(
    { message: 'E11000', code: 1, writeErrors: [writeError] },
    {} as mongoose.mongo.BulkWriteResult,
  ))).toBe(true);

  expect(isDuplicateKeyError(new mongoose.mongo.MongoServerError({
    code: 121,
    errmsg: 'Document failed validation',
  }))).toBe(false);
  expect(isDuplicateKeyError(new Error('E11000'))).toBe(false);
  expect(isDuplicateKeyError({ code: 11000 })).toBe(false);
  expect(isDuplicateKeyError(undefined)).toBe(false);
});

it('objectId: accepts 24 hex; rejects 12-char, 25-char and non-hex strings', () => {
  expect(objectId.safeParse('507f1f77bcf86cd799439011').success).toBe(true);
  expect(objectId.safeParse('507F1F77BCF86CD799439011').success).toBe(true);
  expect(objectId.safeParse('abcdefghijkl').success).toBe(false);
  expect(objectId.safeParse('507f1f77bcf86cd799439011a').success).toBe(false);
  expect(objectId.safeParse('507f1f77bcf86cd79943901z').success).toBe(false);

  expect(() => parseInput(objectId, 'abcdefghijkl')).toThrow(AppError);
  try {
    parseInput(objectId, 'abcdefghijkl');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    if (!(err instanceof AppError)) throw err;
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_request');
  }
});
