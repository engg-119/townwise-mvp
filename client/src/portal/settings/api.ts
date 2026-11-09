import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import type { Auth } from '../../auth/auth';
import { withOrgId } from '../api';
import { meResponseSchema, type MeResponse } from '../schemas';

// Settings (spec 10.3, F7, D9, P18), checked against api/src/handlers/org.ts: an org admin renames the
// organization and reads its Townwise staff activity; anyone with a seat leaves. Sign out on every device is the
// kit's POST /auth/logout-all, through the auth client. `z.object` strips unknown keys.

export const renamedOrgSchema = z.object({ org: z.object({ id: z.string(), name: z.string() }) });

/** One staff event on this organization (spec 10.1, api/src/audit.ts StaffActivityView), newest first. */
export const staffActivitySchema = z.object({
  at: z.string(),
  staffEmail: z.string(),
  /** The server's plain-words summary ("Added {email} as member", "Viewed as {email}"). */
  summary: z.string(),
  /** view_as.started only; `endsAt` is the grant's scheduled end. */
  viewAs: z.object({ targetEmail: z.string(), reason: z.string(), endsAt: z.string() }).nullable(),
  /** False when the server refused or could not make the change; the refusal is never a row of its own. */
  applied: z.boolean(),
  /** Why it didn’t take effect, in plain words; null when applied. */
  notAppliedReason: z.string().nullable(),
});
export type StaffActivity = z.infer<typeof staffActivitySchema>;

/** `nextBefore` reads the next older page; null (or, from an older server, absent) when there is none. */
export const staffActivityResponseSchema = z.object({ events: z.array(staffActivitySchema), nextBefore: z.string().nullable().optional() });

export interface StaffActivityPage { events: StaffActivity[]; nextBefore: string | null }

/** PATCH /api/org { name, orgId? } (2 to 120 characters after trimming; orgId from openAsAdminOrgId): 200 { org }. */
export async function renameOrg(api: ApiClient, name: string, orgId: string | null): Promise<{ id: string; name: string }> {
  const body = await api.json('/api/org', renamedOrgSchema, { method: 'PATCH', body: withOrgId({ name }, orgId) });
  return body.org;
}

/** GET /api/org/staff-activity?before=: a page of 50 staff events on the organization, newest first; `before` pages older. */
export async function fetchStaffActivity(api: ApiClient, before?: string): Promise<StaffActivityPage> {
  const path = before === undefined ? '/api/org/staff-activity' : `/api/org/staff-activity?before=${encodeURIComponent(before)}` as const;
  const body = await api.json(path, staffActivityResponseSchema);
  return { events: body.events, nextBefore: body.nextBefore ?? null };
}

/** POST /api/org/leave {} (the body must be exactly {}): 200 with the new access, as GET /api/me; 409 last_admin. */
export function leaveOrg(api: ApiClient): Promise<MeResponse> {
  return api.json('/api/org/leave', meResponseSchema, { method: 'POST', body: {} });
}

/**
 * Sign out on every device: the kit's POST /auth/logout-all (204) revokes every session of this account, this one
 * included, and clears the web cookies; then this device signs out locally. The sessions are gone either way, so
 * if the local sign-out fails (a dropped connection between the two calls) the app still shows signed out.
 */
export async function signOutEverywhere(auth: Pick<Auth, 'api' | 'signOut' | 'store'>): Promise<void> {
  await auth.api.request('/auth/logout-all', { method: 'POST' });
  try {
    await auth.signOut();
  } catch {
    auth.store.set({ status: 'signedOut' });
  }
}
