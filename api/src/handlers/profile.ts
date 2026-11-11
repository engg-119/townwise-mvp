// GET and PATCH /api/me/profile (spec 10.2, 17): the display name TownwiseAI greets a person with. The name travels
// only in these bodies; it is never in a URL, a log line or an audit event.
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { requesterFirstName } from '../welcome.ts';
import { memberOf } from './locations.ts';

export interface ProfileView {
  displayName: string | null;
  /** True only when the one-time “What should TownwiseAI call you?” prompt should show. */
  askName: boolean;
}

const MAX_NAME = 40;
const NAME_SHAPE = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’ .-]*[\p{L}\p{M}.])?$/u;

/** Trimmed, NFC, inner whitespace collapsed; 1 to 40 characters of letters and marks with inner spaces, hyphens, apostrophes and periods. Null when invalid. */
export function displayNameOf(raw: string): string | null {
  const name = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const length = Array.from(name).length;
  if (length < 1 || length > MAX_NAME) return null;
  return NAME_SHAPE.test(name) ? name : null;
}

const updateBody = z.strictObject({
  displayName: z.string().max(1000).nullable().transform((raw, ctx) => {
    if (raw === null) return null;
    const name = displayNameOf(raw);
    if (name === null) ctx.addIssue({ code: 'custom', message: 'Invalid name' });
    return name;
  }),
});

export async function getProfile(ctx: TownwiseContext, _req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const row = await ctx.stores.profiles.get(member.userId);
  const displayName = row !== null ? row.displayName : await requesterFirstName(ctx, member.scope, member.userId);
  const view: ProfileView = { displayName, askName: row === null && displayName === null && member.viewAs === null };
  res.status(200).json(view);
}

/** The view-as guard refuses this before it runs, so the member is the signed-in person. */
export async function updateProfile(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { displayName } = parseInput(updateBody, req.body);
  await ctx.stores.profiles.set(member.userId, displayName, ctx.now());
  const view: ProfileView = { displayName, askName: false };
  res.status(200).json(view);
}
