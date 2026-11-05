import { createHmac, createSecretKey, hkdfSync, type KeyObject } from 'node:crypto';

import { z } from 'zod';

const emailSchema = z.email().max(254);

export function normalizeEmail(raw: string): string | null {
  const parsed = emailSchema.safeParse(raw.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

export function deriveEmailKey(firstJwtKey: KeyObject): KeyObject {
  const derived = Buffer.from(hkdfSync('sha256', firstJwtKey, Buffer.alloc(0), 'kit-auth:email-id', 32));
  return createSecretKey(derived);
}

export function emailId(emailKey: KeyObject, normalizedEmail: string): string {
  return createHmac('sha256', emailKey).update(normalizedEmail, 'utf8').digest('base64url');
}
