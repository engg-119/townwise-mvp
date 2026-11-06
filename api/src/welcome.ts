// Who gets the welcome statement (spec 15.8, 10.1): only the person whose approved request created the organization,
// on their first visit, while the organization has no sales days (so “ready to set up” is true), never under view-as.
// Invited teammates and admins of staff-created organizations have the Joining notice instead. Reads only.
import type { TownwiseContext } from './app.ts';
import type { Principal } from './access/policy.ts';

export interface WelcomeView {
  /** Null for an honorific, an initial or a long token: the welcome then has no name. */
  firstName: string | null;
  /** The organization's current name. */
  restaurant: string;
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof']);
const MAX_FIRST_NAME = 40;

/** The first word of the name they typed, or null for an honorific, an initial, or a long token. */
export function firstNameOf(contactName: string): string | null {
  const first = contactName.trim().split(/\s+/)[0]?.replace(/,+$/, '') ?? '';
  if (first === '' || first.length > MAX_FIRST_NAME) return null;
  if (HONORIFICS.has(first.replace(/\.$/, '').toLowerCase())) return null;
  // A single letter, with or without its period (“J.”).
  if (/^\p{L}?\.?$/u.test(first)) return null;
  return first;
}

/**
 * At most four point reads, only in GET /api/me: one once the welcome is recorded (the common path), two for
 * teammates of organizations with data.
 */
export async function welcomeFor(ctx: TownwiseContext, principal: Principal): Promise<WelcomeView | null> {
  if (principal.kind !== 'member' || principal.viewAs !== null) return null;
  const { scope, userId } = principal;
  if (await ctx.stores.welcomes.has(scope, userId)) return null;
  if (await ctx.stores.salesDays.hasAnyForOrg(scope)) return null;
  const org = await ctx.stores.orgs.findById(scope.orgId);
  if (org?.fromRequestId == null) return null;
  const request = await ctx.stores.requests.findById(org.fromRequestId);
  if (request?.status !== 'approved' || request.userId !== userId) return null;
  return { firstName: firstNameOf(request.contactName), restaurant: org.name };
}
