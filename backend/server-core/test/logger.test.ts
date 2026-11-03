import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { redactUrl, serializers } from '../src/logger.ts';

test('logger: redactUrl redacts token/code/t values including token[]= and %5B%5D forms, keeps keys', () => {
  expect(redactUrl('/cb?code=abc&state=xyz')).toBe('/cb?code=[REDACTED]&state=[REDACTED]');
  expect(redactUrl('/x?t=1&a=2')).toBe('/x?t=[REDACTED]&a=2');
  expect(redactUrl('/x?token[]=a&token%5B%5D=b')).toBe('/x?token[]=[REDACTED]&token%5B%5D=[REDACTED]');
  expect(redactUrl('/x?TOKEN=a&access_token=z')).toBe('/x?TOKEN=[REDACTED]&access_token=[REDACTED]');
});

test('logger: redactUrl leaves faq=open, latest=1, keyword=x and postcode=y untouched', () => {
  expect(redactUrl('/s?faq=open&latest=1&keyword=x&postcode=y')).toBe('/s?faq=open&latest=1&keyword=x&postcode=y');
});

test('logger: the err serializer drops keyValue, errorResponse, errors and body, and redacts dup key, validation, cast, body-parser and JSON SyntaxError messages', () => {
  const sentinel = `SENT${randomUUID()}`;
  const dup = new Error(`E11000 duplicate key error collection: db.users index: email_1 dup key: { email: "${sentinel}" }`);
  dup.name = 'MongoServerError';
  Object.assign(dup, { code: 11000, keyValue: { email: sentinel }, errorResponse: { errmsg: sentinel }, body: sentinel });

  const validation = new Error(`User validation failed: email: ${sentinel}`);
  validation.name = 'ValidationError';
  Object.assign(validation, {
    _message: 'User validation failed',
    errors: { email: { message: sentinel }, age: { message: 'bad' } },
    body: sentinel,
  });

  const cast = new Error(`Cast to ObjectId failed for value "${sentinel}" (type string) at path "_id" for model "User"`);
  cast.name = 'CastError';
  Object.assign(cast, { kind: 'ObjectId', path: '_id', value: sentinel, body: sentinel });

  const bodyParser = new SyntaxError(`Unexpected token ${sentinel} in JSON at position 1`);
  Object.assign(bodyParser, { type: 'entity.parse.failed', body: sentinel, status: 400 });

  const jsonSyntax = new SyntaxError(`Unexpected token ${sentinel} in JSON at position 1`);
  Object.assign(jsonSyntax, { body: sentinel });

  const sentinelString = `SENT${randomUUID()}`;

  expect(serializers.err(dup).message).toBe('E11000 duplicate key error collection: db.users index: email_1 dup key: [REDACTED]');
  expect(serializers.err(dup).code).toBe(11000);
  expect(serializers.err(validation).message).toBe('User validation failed: email, age');
  expect(serializers.err(cast).message).toBe('Cast to ObjectId failed at path "_id"');
  expect(serializers.err(bodyParser).message).toBe('entity.parse.failed');
  expect(serializers.err(jsonSyntax).message).toBe('invalid JSON (message withheld)');
  expect(serializers.err(sentinelString)).toEqual({ type: 'string', message: '[non-Error value withheld]' });
  for (const err of [dup, validation, cast, bodyParser, jsonSyntax, sentinelString]) {
    const out = JSON.stringify(serializers.err(err));
    expect(out).not.toMatch(/SENT/);
    for (const key of ['keyValue', 'errorResponse', 'body']) expect(out).not.toContain(`"${key}"`);
  }
  expect(serializers.err(validation)).not.toHaveProperty('errors');
});

test('logger: the err serializer follows cause chains to depth 3', () => {
  const e4 = new Error('e4');
  const e3 = new Error('e3', { cause: e4 });
  const e2 = new Error('e2', { cause: e3 });
  const e1 = new Error('e1', { cause: e2 });
  const e0 = new Error('e0', { cause: e1 });
  expect(serializers.err(e0).cause?.cause?.cause?.message).toBe('e3');
  expect(serializers.err(e0).cause?.cause?.cause?.cause).toBeUndefined();
  expect(serializers.err(new AggregateError(Array.from({ length: 12 }, (_, i) => new Error(`a${String(i)}`)))).errors).toHaveLength(10);
});
