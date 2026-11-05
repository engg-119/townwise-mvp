import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import { roleSchema, type Role } from '../schemas';

// Team (spec F5, F6, 10.6), checked against api/src/handlers/team.ts: an org admin lists the active members and
// open invitations, adds addresses, changes a role and removes a seat or an invitation. No route carries an
// organization id; the server takes it from the session. `z.object` strips unknown keys.

export const memberViewSchema = z.object({
  id: z.string(),
  /** The person's current kit email for a seat ("Deleted person" when that account is gone); the added address for an invitation. */
  email: z.string(),
  role: roleSchema,
  status: z.enum(['invited', 'active']),
  invitedAt: z.string(),
  joinedAt: z.string().nullable(),
  isYou: z.boolean(),
  addedByStaff: z.boolean(),
});
export type MemberView = z.infer<typeof memberViewSchema>;

export const addOutcomeSchema = z.enum(['invited', 'already_invited', 'already_member', 'invalid']);
export type AddOutcome = z.infer<typeof addOutcomeSchema>;

/** One per distinct address: the normalized address, or the trimmed input when it isn't an email. */
export const addResultSchema = z.object({ email: z.string(), outcome: addOutcomeSchema });
export type AddResult = z.infer<typeof addResultSchema>;

export const membersResponseSchema = z.object({ members: z.array(memberViewSchema) });
export const addMembersResponseSchema = z.object({ results: z.array(addResultSchema), members: z.array(memberViewSchema) });
export const memberResponseSchema = z.object({ member: memberViewSchema });

function memberPath(memberId: string): `/${string}` {
  return `/api/org/members/${encodeURIComponent(memberId)}`;
}

export async function fetchMembers(api: ApiClient): Promise<MemberView[]> {
  const body = await api.json('/api/org/members', membersResponseSchema);
  return body.members;
}

/** 200 with one result per address and the updated team; 409 member_limit past 200 people. */
export function addMembers(api: ApiClient, emails: readonly string[], role: Role): Promise<z.infer<typeof addMembersResponseSchema>> {
  return api.json('/api/org/members', addMembersResponseSchema, { method: 'POST', body: { emails, role } });
}

/** 200 with the row as it is now; 404; 409 last_admin. */
export async function changeRole(api: ApiClient, memberId: string, role: Role): Promise<MemberView> {
  const body = await api.json(memberPath(memberId), memberResponseSchema, { method: 'PATCH', body: { role } });
  return body.member;
}

/** 204; 404; 409 last_admin. An invitation is deleted; a seat is removed. */
export async function removeMember(api: ApiClient, memberId: string): Promise<void> {
  await api.request(memberPath(memberId), { method: 'DELETE' });
}
