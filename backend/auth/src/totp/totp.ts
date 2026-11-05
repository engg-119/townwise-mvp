import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31] ?? '';
  return out;
}

export function base32Decode(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/u, '').toUpperCase();
  if (clean.length === 0 || /[^A-Z2-7]/u.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / 30);
}

export function codeAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  if (key === null) throw new Error('malformed totp secret');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const binary = (
    ((hmac[offset] ?? 0) & 0x7f) << 24
    | (hmac[offset + 1] ?? 0) << 16
    | (hmac[offset + 2] ?? 0) << 8
    | (hmac[offset + 3] ?? 0)
  );
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Whitespace stripped; accepts step-1, step, step+1; returns the matched step or null; never throws. */
export function verifyCode(secret: string, code: string, now: Date): number | null {
  const normalized = code.replace(/\s+/gu, '');
  if (!/^\d{6}$/u.test(normalized)) return null;
  const step = stepAt(now);
  for (const delta of [-1, 0, 1]) {
    const candidate = step + delta;
    if (candidate < 0) continue;
    let expected: string;
    try {
      expected = codeAt(secret, candidate);
    } catch {
      return null;
    }
    const actual = Buffer.from(normalized);
    const wanted = Buffer.from(expected);
    if (actual.length === wanted.length && timingSafeEqual(actual, wanted)) return candidate;
  }
  return null;
}

export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = [
    `secret=${encodeURIComponent(input.secret)}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    'algorithm=SHA1',
    'digits=6',
    'period=30',
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}
