// A calendar link's address, sealed (openspec change connect-owner-calendar: the calendar-subscription spec, design
// decision 4). The address alone grants read access to the owner's whole calendar, so the database holds it only as
// AES-256-GCM ciphertext under TOWNWISE_CALENDAR_KEY, which main.ts alone reads (config.ts checks it is 32 bytes) and
// passes in. Each seal draws a fresh random 12 byte IV. The sealed string is versioned, `v1:<iv>:<ciphertext>:<tag>`,
// each part canonical base64url, and the version is bound in as additional data. Opening never throws: a wrong key, a
// tampered part or a malformed string all answer `key_mismatch`, the calendar's status when its link can no longer be
// read (the owner pastes it again). Pure apart from the IV's randomness; nothing here logs.
import { createCipheriv, createDecipheriv, randomBytes, type KeyObject } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type OpenedAddress = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: 'key_mismatch' };

const KEY_MISMATCH: OpenedAddress = { ok: false, code: 'key_mismatch' };

/** `text` sealed under `key`, a 32 byte secret key. Two seals of the same text differ. */
export function seal(key: KeyObject, text: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(VERSION, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(':');
}

/** The bytes of a canonical base64url part, or null (a lenient decode would skip characters it does not know). */
function bytesOf(part: string): Buffer | null {
  const bytes = Buffer.from(part, 'base64url');
  return bytes.toString('base64url') === part ? bytes : null;
}

/** The text `seal` sealed under `key`, or `key_mismatch` for any other key or string. Never throws. */
export function open(key: KeyObject, sealed: string): OpenedAddress {
  const [version, ivPart, dataPart, tagPart, ...rest] = sealed.split(':');
  if (version !== VERSION || ivPart === undefined || dataPart === undefined || tagPart === undefined || rest.length > 0) return KEY_MISMATCH;
  const iv = bytesOf(ivPart);
  const data = bytesOf(dataPart);
  const tag = bytesOf(tagPart);
  if (iv?.length !== IV_BYTES || data === null || tag?.length !== TAG_BYTES) return KEY_MISMATCH;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(VERSION, 'utf8'));
    decipher.setAuthTag(tag);
    return { ok: true, text: Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8') };
  } catch {
    return KEY_MISMATCH;
  }
}
