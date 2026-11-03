import express from 'express';
import { expect, test } from 'vitest';

import { parseTrustProxy } from '../src/trustProxy.ts';
import { configErrorOf } from './helpers/errors.ts';

test('trustProxy: rejects 1, 2, true and a malformed CIDR; accepts loopback, an IPv6 CIDR and a mixed list', () => {
  for (const bad of ['1', '2', 'true', 'false', '10.0.0.0/33']) {
    expect(configErrorOf(() => parseTrustProxy(bad)).problems[0]?.variable).toBe('TRUST_PROXY');
  }
  expect(parseTrustProxy('loopback')).toEqual(['loopback']);
  expect(parseTrustProxy('fd00::/8')).toEqual(['fd00::/8']);
  expect(parseTrustProxy('loopback, 10.0.0.0/20,10.0.16.0/20')).toEqual(['loopback', '10.0.0.0/20', '10.0.16.0/20']);
});

test('trustProxy: with loopback, the compiled trust function trusts 127.0.0.1 and does not trust 172.17.0.1', () => {
  const app = express();
  app.set('trust proxy', parseTrustProxy('loopback'));
  const trust = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
  expect(trust('127.0.0.1', 0)).toBe(true);
  expect(trust('172.17.0.1', 0)).toBe(false);
});
