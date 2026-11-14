// A calendar link's sealed address (src/calendar/secret.ts). Keys are made per run; none is committed.
import { createSecretKey, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { open, seal } from '../src/calendar/secret.ts';

const KEY = createSecretKey(randomBytes(32));
const ADDRESS = 'https://calendar.google.com/calendar/ical/owner%40example.test/private-0123456789abcdef/basic.ics';

/** The sealed string with one bit of byte 0 of part `index` (1 IV, 2 ciphertext, 3 tag) flipped, still canonical. */
function tampered(sealed: string, index: number): string {
  const parts = sealed.split(':');
  const bytes = Buffer.from(parts[index] ?? '', 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  parts[index] = bytes.toString('base64url');
  return parts.join(':');
}

describe('sealing a calendar link', () => {
  it('opens what it sealed, Unicode and the empty text included', () => {
    for (const text of [ADDRESS, 'webcal://bookings.example.test/feed.ics?token=é✓', '']) {
      expect(open(KEY, seal(KEY, text))).toEqual({ ok: true, text });
    }
  });

  it('writes v1:<iv>:<ciphertext>:<tag> in base64url, with a 12 byte IV and a 16 byte tag, and none of the address', () => {
    const sealed = seal(KEY, ADDRESS);
    const [version, iv, data, tag, ...rest] = sealed.split(':');
    expect(version).toBe('v1');
    expect(rest).toEqual([]);
    expect(Buffer.from(iv ?? '', 'base64url')).toHaveLength(12);
    expect(Buffer.from(data ?? '', 'base64url')).toHaveLength(Buffer.byteLength(ADDRESS));
    expect(Buffer.from(tag ?? '', 'base64url')).toHaveLength(16);
    expect(sealed).toMatch(/^v1(?::[A-Za-z0-9_-]+){3}$/);
    expect(sealed).not.toContain('calendar.google.com');
    expect(sealed).not.toContain('private-0123456789abcdef');
  });

  it('seals the same text differently each time, with a fresh IV', () => {
    const first = seal(KEY, ADDRESS);
    const second = seal(KEY, ADDRESS);
    expect(first).not.toBe(second);
    expect(first.split(':')[1]).not.toBe(second.split(':')[1]);
    expect(open(KEY, second)).toEqual({ ok: true, text: ADDRESS });
  });

  it('answers key_mismatch, without throwing, under another key', () => {
    expect(open(createSecretKey(randomBytes(32)), seal(KEY, ADDRESS))).toEqual({ ok: false, code: 'key_mismatch' });
    // A key of the wrong size cannot open it either.
    expect(open(createSecretKey(randomBytes(16)), seal(KEY, ADDRESS))).toEqual({ ok: false, code: 'key_mismatch' });
  });

  it('answers key_mismatch for a tampered IV, ciphertext or tag', () => {
    const sealed = seal(KEY, ADDRESS);
    for (const index of [1, 2, 3]) {
      const changed = tampered(sealed, index);
      expect(changed).not.toBe(sealed);
      expect(open(KEY, changed)).toEqual({ ok: false, code: 'key_mismatch' });
    }
    // A shorter ciphertext, with the tag unchanged.
    const [version, iv, data = '', tag] = sealed.split(':');
    const shorter = Buffer.from(data, 'base64url').subarray(1).toString('base64url');
    expect(open(KEY, [version, iv, shorter, tag].join(':'))).toEqual({ ok: false, code: 'key_mismatch' });
  });

  it('answers key_mismatch for a malformed string, never throwing', () => {
    const sealed = seal(KEY, ADDRESS);
    const [, iv = '', data = '', tag = ''] = sealed.split(':');
    const malformed = [
      '',
      'v1',
      ADDRESS,
      `v2:${iv}:${data}:${tag}`,
      `v1:${iv}:${data}`,
      `${sealed}:extra`,
      `v1:${iv}:${data}:${tag.slice(0, -2)}`,
      `v1:${iv.slice(0, -2)}:${data}:${tag}`,
      `v1:${iv}:${data}*:${tag}`,
      `v1:${iv}:${Buffer.from(data, 'base64url').toString('base64')}=:${tag}`,
      `v1:${iv}:${data} :${tag}`,
    ];
    for (const text of malformed) expect(open(KEY, text), text).toEqual({ ok: false, code: 'key_mismatch' });
  });
});
