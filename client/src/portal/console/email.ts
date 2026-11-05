import { z } from 'zod';

// The console's check of a typed address (P22 lookup, P23 actor filter) before it is sent: the API's own rule
// (api/src/normalize-email.ts: a zod email, at most 254 characters), so the server never answers 400 for one.

export const EMAIL_COPY = 'Enter an email address.';

const EMAIL = z.email().max(254);

export function isEmailAddress(text: string): boolean {
  return EMAIL.safeParse(text.trim().toLowerCase()).success;
}
