import { errorCopy } from '../errors';
import type { Problem } from './Dialog';

// What a console write's refusal says: the page's own copy for its codes (spec 16.4), else the shared copy
// (spec 15.7). The staff gate's 403s and 409 view_as_active also re-read GET /api/me through usePortal().api,
// which routes away from the console (spec 4.3).

export function problemOf(error: unknown, own?: (error: unknown) => Problem | string | null): Problem | null {
  if (error === null || error === undefined) return null;
  const mine = own?.(error) ?? null;
  if (mine !== null) return typeof mine === 'string' ? { text: mine } : mine;
  return { text: errorCopy(error) };
}
