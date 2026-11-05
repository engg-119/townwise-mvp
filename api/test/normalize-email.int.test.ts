// Parity with the kit's email rule (spec Section 19, item 3). The kit does not export normalizeEmail, so
// each input goes through its public magic-link route: 202 and the address it would mail, or 400.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normalizeEmail } from '../src/normalize-email.ts';
import { call, startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

async function kitNormalizes(input: string): Promise<string | null> {
  const before = server.mail.length;
  const res = await call(server, '/auth/magic-link', { json: { email: input, platform: 'native' } });
  if (res.status === 400) return null;
  expect(res.status).toBe(202);
  expect(server.mail).toHaveLength(before + 1);
  return server.mail.at(-1)?.to ?? null;
}

const CASES = [
  'Owner@Example.COM',
  '  chef@example.com  ',
  '\tMixed.Case+Tag@Example.Org\n',
  'UPPER@EXAMPLE.TEST',
  'not-an-email',
  'two@@example.com',
  'missing-domain@',
  '@missing-local.test',
  'spaces in@example.com',
  `${'a'.repeat(250)}@example.com`,
  '',
];

describe('normalizeEmail', () => {
  it('matches the kit for case, spaces and rejection', async () => {
    for (const input of CASES) {
      expect({ input, normalized: normalizeEmail(input) }).toEqual({ input, normalized: await kitNormalizes(input) });
    }
  });

  it('lowercases and trims', () => {
    expect(normalizeEmail('  Owner@Example.COM ')).toBe('owner@example.com');
  });
});
