// Whether an organization is in setup (D23): the one predicate behind staff setup's routes and the console's `inSetup`,
// and the notion of “joined” behind it, which open as admin (D25) reads to ask a reason once someone has joined.
import { AppError } from '@ckeith26/server-core';

import type { TownwiseContext } from '../app.ts';
import type { OrgRecord } from '../stores/orgs.ts';
import type { OrgScope } from './policy.ts';

/**
 * Staff setup (D23): the organization is active and nobody has ever joined it, by its `firstJoinedAt`, which outlives
 * every seat and person deletion, or, for an organization from before that field, by any member row that joined
 * (`joinedAt`, active or removed). The setup routes (staff-setup.ts) and `inSetup` (admin.ts) read this one predicate.
 */
export async function isInSetup(ctx: TownwiseContext, scope: OrgScope, org: OrgRecord): Promise<boolean> {
  return org.status === 'active' && !(await hasEverJoined(ctx, scope, org));
}

/**
 * Whether anyone has ever joined the organization, as staff setup counts it: its `firstJoinedAt`, or, for an
 * organization from before that field, any member row that joined. Open as admin asks a reason once this holds (D25).
 */
export async function hasEverJoined(ctx: TownwiseContext, scope: OrgScope, org: OrgRecord): Promise<boolean> {
  return org.firstJoinedAt !== null || await ctx.stores.members.anyJoined(scope);
}

export function notInSetup(): AppError {
  return new AppError(409, 'org_not_in_setup', 'Staff setup ends for good once someone joins the organization, and is closed while it is suspended');
}
