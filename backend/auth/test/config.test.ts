import { randomBytes } from 'node:crypto';

import { ConfigError, createLogger } from '@ckeith26/server-core';
import { Redis } from 'ioredis';
import { expect, test } from 'vitest';

import { configSchema, resolveAuthConfig, type AuthConfig } from '../src/config.ts';
import { createAuth } from '../src/create-auth.ts';
import type { AuthStores } from '../src/stores/types.ts';

function key(bytes: number): string {
  return randomBytes(bytes).toString('base64');
}

function ring(kid: string, bytes: number): string {
  return `${kid}:${key(bytes)}`;
}

function base(overrides?: Partial<AuthConfig>): AuthConfig {
  return {
    AUTH_ISSUER: 'https://api.example.test',
    AUTH_JWT_KEYS: ring('k1', 32),
    AUTH_ENCRYPTION_KEYS: ring('e1', 32),
    AUTH_MAGIC_LINK_URL: 'https://app.example.test/auth/magic',
    AUTH_TOTP_ISSUER: 'Kit Test',
    AUTH_GOOGLE_CLIENT_IDS: '1111-web.apps.googleusercontent.com',
    ...overrides,
  };
}

function configOf(overrides?: Partial<AuthConfig & { NODE_ENV: 'development' | 'test' | 'production'; CORS_ORIGINS: string }>) {
  return {
    NODE_ENV: 'development' as const,
    CORS_ORIGINS: 'https://app.example.test',
    ...base(),
    ...overrides,
  };
}

function boot(overrides?: Partial<AuthConfig & { NODE_ENV: 'development' | 'test' | 'production'; CORS_ORIGINS: string }>) {
  return resolveAuthConfig(configOf(overrides));
}

function attempt(
  overrides?: Partial<AuthConfig & { NODE_ENV: 'development' | 'test' | 'production'; CORS_ORIGINS: string }>,
  redis: Redis = {} as Redis,
) {
  return createAuth({
    config: configOf(overrides),
    stores: {} as AuthStores,
    redis,
    logger: createLogger({ LOG_LEVEL: 'silent' }),
    sendMagicLink: () => Promise.resolve(),
  });
}

test('configSchema rejects a JWT key under 32 bytes and over 64', () => {
  expect(configSchema.safeParse(base({ AUTH_JWT_KEYS: ring('k1', 31) })).success).toBe(false);
  expect(configSchema.safeParse(base({ AUTH_JWT_KEYS: ring('k1', 65) })).success).toBe(false);
});

test('configSchema rejects an encryption key that is not exactly 32 bytes', () => {
  expect(configSchema.safeParse(base({ AUTH_ENCRYPTION_KEYS: ring('e1', 31) })).success).toBe(false);
  expect(configSchema.safeParse(base({ AUTH_ENCRYPTION_KEYS: ring('e1', 33) })).success).toBe(false);
});

test('configSchema rejects non-canonical base64, a duplicate kid and a bad kid', () => {
  const padded = key(32);
  expect(padded.endsWith('=')).toBe(true);
  const stripped = padded.slice(0, -1);
  expect(configSchema.safeParse(base({ AUTH_JWT_KEYS: `k1:${stripped}` })).success).toBe(false);
  expect(configSchema.safeParse(base({ AUTH_JWT_KEYS: 'a:k,a:k' })).success).toBe(false);
  expect(configSchema.safeParse(base({ AUTH_JWT_KEYS: `A1:${key(32)}` })).success).toBe(false);
  expect(configSchema.safeParse(base({ AUTH_JWT_KEYS: `${'a'.repeat(17)}:${key(32)}` })).success).toBe(false);
});

test('configSchema rejects an issuer with a path', () => {
  expect(configSchema.safeParse(base({ AUTH_ISSUER: 'https://api.example.test/v1' })).success).toBe(false);
});

test('configSchema rejects a magic-link URL with a query or fragment', () => {
  expect(configSchema.safeParse(base({
    AUTH_MAGIC_LINK_URL: 'https://app.example.test/auth/magic?x=1',
  })).success).toBe(false);
  expect(configSchema.safeParse(base({
    AUTH_MAGIC_LINK_URL: 'https://app.example.test/auth/magic#x',
  })).success).toBe(false);
});

test('configSchema rejects a malformed Google client ID', () => {
  expect(configSchema.safeParse(base({
    AUTH_GOOGLE_CLIENT_IDS: 'web.apps.googleusercontent.com',
  })).success).toBe(false);
});

test('configSchema issues contain no values', () => {
  const jwt = ring('k1', 31);
  const encryption = ring('e1', 33);
  const duplicate = `a:${key(32)},a:${key(32)}`;
  const badKid = `A1:${key(32)}`;
  const longKid = `${'b'.repeat(17)}:${key(32)}`;
  const stripped = `k1:${key(32).slice(0, -1)}`;
  const cases = [
    base({ AUTH_JWT_KEYS: jwt }),
    base({ AUTH_JWT_KEYS: ring('k1', 65) }),
    base({ AUTH_ENCRYPTION_KEYS: encryption }),
    base({ AUTH_ENCRYPTION_KEYS: ring('e1', 31) }),
    base({ AUTH_JWT_KEYS: stripped }),
    base({ AUTH_JWT_KEYS: duplicate }),
    base({ AUTH_JWT_KEYS: 'a:k,a:k' }),
    base({ AUTH_JWT_KEYS: badKid }),
    base({ AUTH_JWT_KEYS: longKid }),
    base({ AUTH_ISSUER: 'https://api.example.test/v1' }),
    base({ AUTH_MAGIC_LINK_URL: 'https://app.example.test/auth/magic?x=1' }),
    base({ AUTH_MAGIC_LINK_URL: 'https://app.example.test/auth/magic#x' }),
    base({ AUTH_GOOGLE_CLIENT_IDS: 'web.apps.googleusercontent.com' }),
  ];
  for (const input of cases) {
    const result = configSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) continue;
    const blob = JSON.stringify(result.error.issues);
    for (const value of Object.values(input)) {
      if (value === undefined) continue;
      expect(blob).not.toContain(value);
      const encoded = value.slice(value.indexOf(':') + 1);
      if (encoded.length >= 16 && encoded !== value) expect(blob).not.toContain(encoded);
    }
  }
});

test('createAuth rejects an http issuer when NODE_ENV is production', () => {
  expect.assertions(2);
  try {
    attempt({
      NODE_ENV: 'production',
      AUTH_ISSUER: 'http://localhost:8080',
      AUTH_MAGIC_LINK_URL: 'http://localhost:8081/auth/magic',
      CORS_ORIGINS: 'http://localhost:8081',
    });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems[0]?.variable).toBe('AUTH_ISSUER');
  }
});

test('createAuth rejects an https issuer with an http web origin', () => {
  expect.assertions(2);
  try {
    attempt({
      AUTH_ISSUER: 'https://api.example.test',
      AUTH_MAGIC_LINK_URL: 'https://app.example.test/auth/magic',
      CORS_ORIGINS: 'http://localhost:8081',
    });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems[0]?.variable).toBe('CORS_ORIGINS');
  }
});

test('createAuth rejects http://127.0.0.1', () => {
  expect.assertions(2);
  try {
    attempt({
      NODE_ENV: 'development',
      AUTH_ISSUER: 'http://127.0.0.1:8080',
      AUTH_MAGIC_LINK_URL: 'http://localhost:8081/auth/magic',
      CORS_ORIGINS: 'http://localhost:8081',
    });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems[0]?.variable).toBe('AUTH_ISSUER');
  }
});

test('createAuth rejects a magic-link origin missing from CORS_ORIGINS', () => {
  expect.assertions(2);
  try {
    attempt({
      AUTH_MAGIC_LINK_URL: 'https://app.example.test/auth/magic',
      CORS_ORIGINS: 'https://other.example.test',
    });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems[0]?.variable).toBe('AUTH_MAGIC_LINK_URL');
  }
});

test('createAuth accepts an all-http://localhost development set', () => {
  const overrides = {
    NODE_ENV: 'development' as const,
    AUTH_ISSUER: 'http://localhost:8080',
    AUTH_MAGIC_LINK_URL: 'http://localhost:8081/auth/magic',
    CORS_ORIGINS: 'http://localhost:8081',
  };
  const resolved = boot(overrides);
  expect(resolved.secure).toBe(false);
  expect(resolved.webOrigins).toEqual(new Set(['http://localhost:8081']));
  const redis = new Redis({ lazyConnect: true });
  try {
    expect(() => { attempt(overrides, redis); }).not.toThrow();
  } finally {
    redis.disconnect();
  }
});

test('createAuth throws ConfigError before touching its dependencies', () => {
  expect(() => {
    attempt({
      NODE_ENV: 'production',
      AUTH_ISSUER: 'http://localhost:8080',
      AUTH_MAGIC_LINK_URL: 'http://localhost:8081/auth/magic',
      CORS_ORIGINS: 'http://localhost:8081',
    });
  }).toThrow(ConfigError);
});

test('ConfigError text contains no key material', () => {
  const jwt = ring('k1', 32);
  const encryption = ring('e1', 32);
  const secrets = [jwt.slice(jwt.indexOf(':') + 1), encryption.slice(encryption.indexOf(':') + 1)];
  try {
    boot({
      NODE_ENV: 'production',
      AUTH_ISSUER: 'http://localhost:8080',
      AUTH_JWT_KEYS: jwt,
      AUTH_ENCRYPTION_KEYS: encryption,
      AUTH_MAGIC_LINK_URL: 'http://localhost:8081/auth/magic',
      CORS_ORIGINS: 'http://localhost:8081',
    });
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    const configError = err as ConfigError;
    const blob = `${String(configError)}\n${configError.message}\n${JSON.stringify(configError.problems)}`;
    for (const secret of secrets) expect(blob).not.toContain(secret);
  }
});
