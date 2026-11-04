import { z } from 'zod';

// The kit's rule (backend/auth/src/email-id.ts), which the kit does not export (spec Section 19, item 3).
// test/normalize-email.int.test.ts pins this copy against the kit's own magic-link route.
const emailSchema = z.email().max(254);

export function normalizeEmail(raw: string): string | null {
  const parsed = emailSchema.safeParse(raw.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}
