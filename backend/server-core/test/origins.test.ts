import { expect, test } from 'vitest';

import { ConfigError, parseOrigins } from '../src/index.ts';
import { configErrorOf } from './helpers/errors.ts';

test('origins: rejects https://localhost.evil.com, a trailing slash, a path, the null origin and http in production', () => {
  expect(parseOrigins('http://localhost:8081', 'development').has('https://localhost.evil.com')).toBe(false);
  for (const bad of ['https://app.example.com/', 'https://app.example.com/x', 'null']) {
    expect(() => parseOrigins(bad, 'development')).toThrow(ConfigError);
  }
  expect(() => parseOrigins('http://app.example.com', 'production')).toThrow(ConfigError);
  const err = configErrorOf(() => parseOrigins('https://ok.example.com,https://app.example.com/', 'test'));
  expect(err.problems[0]?.problem).toContain('entry 2');
  expect(err.message).not.toContain('app.example.com');
  expect([...parseOrigins(' https://a.example.com , ,http://localhost:8081', 'test')]).toEqual([
    'https://a.example.com',
    'http://localhost:8081',
  ]);
  expect(parseOrigins('', 'production').size).toBe(0);
});
