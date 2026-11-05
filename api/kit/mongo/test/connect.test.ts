import { expect, it } from 'vitest';

import { ConfigError } from '@ckeith26/server-core';

import { assertProductionTls, connectMongo } from '../src/connect.ts';
import { captureLogs } from './helpers/logs.ts';

const TLS_PROBLEM = [{
  variable: 'MONGODB_URI',
  problem: 'production requires TLS with certificate and hostname validation',
}];

function configErrorFrom(fn: () => void): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    if (!(err instanceof ConfigError)) throw err;
    return err;
  }
  expect.unreachable('expected ConfigError');
}

function hidesSecrets(err: ConfigError, secrets: readonly string[]): void {
  const rendered = String(err);
  const problems = JSON.stringify(err.problems);
  for (const secret of secrets) {
    expect(rendered).not.toContain(secret);
    expect(problems).not.toContain(secret);
  }
}

it('production TLS rule: rejects a plaintext URI, +srv with tls=false, TLSAllowInvalidCertificates=true, tlsinsecure=true and tlsAllowInvalidHostnames=true; accepts +srv and tls=true; the message excludes the URI', async () => {
  const password = ['pw', String(process.pid), 'x'].join('-');
  const host = 'db.example.net:27017';
  const srvHost = 'cluster.example.net';
  const plain = `mongodb://kit:${password}@${host}/app`;
  const srvOff = `mongodb+srv://kit:${password}@${srvHost}/app?tls=false`;
  const invalidCerts = `mongodb://kit:${password}@${host}/app?tls=true&TLSAllowInvalidCertificates=true`;
  const tlsInsecure = `mongodb://kit:${password}@${host}/app?tls=true&tlsinsecure=true`;
  const invalidHostnames = `mongodb://kit:${password}@${host}/app?tls=true&tlsAllowInvalidHostnames=true`;
  const srvOk = `mongodb+srv://kit:${password}@${srvHost}/app`;
  const tlsOk = `mongodb://kit:${password}@${host}/app?tls=true`;
  const conflict = `mongodb://kit:${password}@${host}/app?tls=true&tlsInsecure=true&tlsAllowInvalidCertificates=true`;
  const secrets = [password, 'db.example.net', srvHost, plain, srvOff, invalidCerts, tlsInsecure, invalidHostnames, conflict];

  for (const uri of [plain, srvOff, invalidCerts, tlsInsecure, invalidHostnames]) {
    const err = configErrorFrom(() => {
      assertProductionTls(uri);
    });
    expect(err.problems).toEqual(TLS_PROBLEM);
    hidesSecrets(err, secrets);
  }

  expect(() => {
    assertProductionTls(srvOk);
  }).not.toThrow();
  expect(() => {
    assertProductionTls(tlsOk);
  }).not.toThrow();

  const construction = configErrorFrom(() => {
    assertProductionTls(conflict);
  });
  expect(construction.problems).toHaveLength(1);
  expect(construction.problems[0]?.variable).toBe('MONGODB_URI');
  expect(construction.problems[0]?.problem).toMatch(
    /^production requires TLS with certificate and hostname validation \(Mongo\w*Error\)$/,
  );
  hidesSecrets(construction, secrets);

  let rejected: unknown;
  try {
    await connectMongo({
      config: { MONGODB_URI: plain, NODE_ENV: 'production' },
      logger: captureLogs().logger,
    });
  } catch (err) {
    rejected = err;
  }
  expect(rejected).toBeInstanceOf(ConfigError);
  if (!(rejected instanceof ConfigError)) throw new Error('expected ConfigError');
  expect(rejected.problems).toEqual(TLS_PROBLEM);
  hidesSecrets(rejected, secrets);
});
