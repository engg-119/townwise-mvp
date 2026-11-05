import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';
import { z } from 'zod';

import { parseInput } from '../src/index.ts';
import { appErrorOf } from './helpers/errors.ts';

test('errors: parseInput failure is 400 invalid_request with no field details or values', () => {
  const sentinel = `SENT${randomUUID()}`;
  const err = appErrorOf(() => parseInput(z.object({ email: z.email() }), { email: sentinel }));
  expect([err.status, err.code, err.message]).toEqual([400, 'invalid_request', 'Invalid request']);
  expect(err.cause).toBeUndefined();
  const dumped: Record<string, unknown> = { m: err.message, cause: err.cause };
  for (const key of Object.keys(err)) dumped[key] = Object.getOwnPropertyDescriptor(err, key)?.value as unknown;
  expect(JSON.stringify(dumped)).not.toMatch(/SENT|email/);
  expect(parseInput(z.object({ n: z.number() }), { n: 1 })).toEqual({ n: 1 });
});
