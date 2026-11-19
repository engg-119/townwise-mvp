import type { TownwiseContext } from './app.ts';

/** Shown for a person whose kit user no longer exists (spec 10.1). */
export const DELETED_PERSON = 'Deleted person';

/** Shown in place of the person for a record Townwise staff made during setup (D23); never the staff email. */
export const TOWNWISE_STAFF = 'Townwise staff';

/** Shown for a note or rule TownwiseAI saved on its own (D59, `createdBy: 'townwise_ai'`). */
export const TOWNWISE_AI = 'TownwiseAI';

/**
 * The author a record shows: "Townwise staff" for a record staff made (D23, D25), "TownwiseAI" for one TownwiseAI saved
 * on its own (D59), else the person's current kit email.
 */
export function authorEmail(ctx: TownwiseContext, userId: string, byStaff: boolean): Promise<string> {
  if (byStaff) return Promise.resolve(TOWNWISE_STAFF);
  return userId === 'townwise_ai' ? Promise.resolve(TOWNWISE_AI) : currentEmail(ctx, userId);
}

/** The person's current kit email, read at response time (spec 10.1). */
export async function currentEmail(ctx: TownwiseContext, userId: string): Promise<string> {
  return (await ctx.authStores.users.findById(userId))?.email ?? DELETED_PERSON;
}
