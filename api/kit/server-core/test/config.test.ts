import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { ConfigError, configSchema, loadEnv } from '../src/index.ts';
import { configErrorOf } from './helpers/errors.ts';

test('config: loadEnv error lists variables and never contains any input value', () => {
  const source = {
    NODE_ENV: `SENT${randomUUID()}`,
    LOG_LEVEL: `SENT${randomUUID()}`,
    PORT: '987654321',
    HTTP_KEEP_ALIVE_TIMEOUT_MS: '987654322',
    SHUTDOWN_TIMEOUT_MS: '987654323',
    CORS_ORIGINS: `SENT${randomUUID()}`,
    TRUST_PROXY: `SENT${randomUUID()}`,
  };
  const err = configErrorOf(() => loadEnv(configSchema, source));
  expect(err.problems.map((problem) => problem.variable).sort()).toEqual(
    ['HTTP_KEEP_ALIVE_TIMEOUT_MS', 'LOG_LEVEL', 'NODE_ENV', 'PORT', 'SHUTDOWN_TIMEOUT_MS'],
  );
  for (const value of Object.values(source)) {
    expect(err.message).not.toContain(value);
    expect(JSON.stringify(err.problems)).not.toContain(value);
  }
});

test('config: empty strings are treated as unset (defaults apply)', () => {
  expect(loadEnv(configSchema, {
    NODE_ENV: 'test',
    TRUST_PROXY: 'loopback',
    PORT: '',
    LOG_LEVEL: '',
    CORS_ORIGINS: '',
    HTTP_KEEP_ALIVE_TIMEOUT_MS: '',
    SHUTDOWN_TIMEOUT_MS: '',
  })).toEqual({
    NODE_ENV: 'test',
    PORT: 8080,
    LOG_LEVEL: 'info',
    CORS_ORIGINS: '',
    TRUST_PROXY: 'loopback',
    HTTP_KEEP_ALIVE_TIMEOUT_MS: 65000,
    SHUTDOWN_TIMEOUT_MS: 25000,
  });
});

test('config: TRUST_PROXY is required', () => {
  for (const source of [{ NODE_ENV: 'test' }, { NODE_ENV: 'test', TRUST_PROXY: '' }]) {
    const err = configErrorOf(() => loadEnv(configSchema, source));
    expect(err.problems.map((problem) => problem.variable)).toEqual(['TRUST_PROXY']);
  }
  const two = new ConfigError('X', 'p');
  expect(two.problems).toEqual([{ variable: 'X', problem: 'p' }]);
  expect(two.message).toBe('X: p');
});
