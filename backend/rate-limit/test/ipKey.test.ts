import type { Request } from 'express';
import { expect, it } from 'vitest';

import { ipKey } from '../src/index.ts';

const key = (ip?: string) => ipKey((ip === undefined ? {} : { ip }) as unknown as Request);

it('ipKey: keeps /64s apart when :: compresses the host bits; one /64 shares a key; ::ffff:203.0.113.7 and ::ffff:cb00:7107 key as ip:203.0.113.7; fe80::1%eth0 drops the zone; missing req.ip gives ip:unknown', () => {
  expect(key('2001:db8::1')).toBe('ip:2001:db8:0:0');
  expect(key('2001:db8:0:1::1')).toBe('ip:2001:db8:0:1');
  expect(key('2001:db8:0:2::')).toBe('ip:2001:db8:0:2');
  expect(key('2001:db8:0:1:ffff:ffff:ffff:ffff')).toBe('ip:2001:db8:0:1');
  expect(key('2001:0DB8:0000:0001::9')).toBe('ip:2001:db8:0:1'); // lowercase, no leading zeros
  expect(key('203.0.113.7')).toBe('ip:203.0.113.7');
  expect(key('::ffff:203.0.113.7')).toBe('ip:203.0.113.7');
  expect(key('::ffff:cb00:7107')).toBe('ip:203.0.113.7');
  expect(key('fe80::1%eth0')).toBe('ip:fe80:0:0:0');
  expect(key(undefined)).toBe('ip:unknown');
  // rateLimiter.ipPrefixKey.test.js:41-53 cases not already listed above.
  expect(key('2001:db8:0:1::5')).toBe('ip:2001:db8:0:1');
  expect(key('2001:db8:0:2::5')).toBe('ip:2001:db8:0:2');
});
