import { createCipheriv, createDecipheriv, randomBytes, type KeyObject } from 'node:crypto';

import type { KeyringEntry } from './config.ts';

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

export interface TokenCrypto {
  encrypt(plaintext: string, context: string): string;
  decrypt(stored: string, context: string): string;
  isStale(stored: string): boolean;
}

function keyBytes(key: KeyObject): Buffer | null {
  if (key.type !== 'secret') return null;
  const raw = key.export();
  return Buffer.isBuffer(raw) ? raw : null;
}

/** Reads no env. Throws TokenCryptoError naming the position or kid for an empty ring, a duplicate kid or a key not 32 bytes. */
export function createTokenCrypto(keyring: readonly KeyringEntry[]): TokenCrypto {
  if (keyring.length === 0) throw new TokenCryptoError('position 1');
  const seen = new Set<string>();
  for (let index = 0; index < keyring.length; index += 1) {
    const entry = keyring[index];
    if (entry === undefined) throw new TokenCryptoError(`position ${String(index + 1)}`);
    if (seen.has(entry.kid)) throw new TokenCryptoError(`kid ${entry.kid}`);
    seen.add(entry.kid);
    const raw = keyBytes(entry.key);
    if (raw?.length !== 32) throw new TokenCryptoError(`position ${String(index + 1)}`);
  }
  const first = keyring[0];
  if (first === undefined) throw new TokenCryptoError('position 1');
  const current: KeyringEntry = first;

  function encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', current.key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`v1:${current.kid}:${context}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', current.kid, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join(':');
  }

  function decrypt(stored: string, context: string): string {
    try {
      const parts = stored.split(':');
      if (parts.length !== 5 || parts[0] !== 'v1') throw new TokenCryptoError('undecryptable');
      const kid = parts[1];
      const ivPart = parts[2];
      const dataPart = parts[3];
      const tagPart = parts[4];
      if (kid === undefined || ivPart === undefined || dataPart === undefined || tagPart === undefined) {
        throw new TokenCryptoError('undecryptable');
      }
      const entry = keyring.find((candidate) => candidate.kid === kid);
      if (entry === undefined) throw new TokenCryptoError('undecryptable');
      const iv = Buffer.from(ivPart, 'base64url');
      const data = Buffer.from(dataPart, 'base64url');
      const tag = Buffer.from(tagPart, 'base64url');
      if (tag.length !== 16) throw new TokenCryptoError('undecryptable');
      const decipher = createDecipheriv('aes-256-gcm', entry.key, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`v1:${kid}:${context}`, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (err) {
      if (err instanceof TokenCryptoError) throw err;
      throw new TokenCryptoError('undecryptable');
    }
  }

  function isStale(stored: string): boolean {
    const parts = stored.split(':');
    return parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== current.kid;
  }

  return { encrypt, decrypt, isStale };
}
