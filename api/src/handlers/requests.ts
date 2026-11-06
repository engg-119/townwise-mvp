// POST /api/access-requests (spec F2, 6.3, 10.2).
import { authOf } from '@ckeith26/auth';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { isStaffPrincipal, type Principal } from '../access/policy.ts';
import { resolveAccess } from '../access/resolve.ts';
import { placeIdSchema } from '../place-id.ts';
import { resolveTown, townInputSchema } from '../towns.ts';
import { meResponse } from './me.ts';

const requestBody = z.object({
  orgName: z.string().trim().min(2).max(120),
  contactName: z.string().trim().min(1).max(120),
  contactRole: z.string().trim().min(1).max(80),
  town: townInputSchema,
  locationCount: z.number().int().min(1).max(50),
  note: z.string().trim().max(1000).nullish(),
  placeId: placeIdSchema.nullish(),
});

/** Who may send a request: a signed-in person with no organization, a rejected request, or a removed seat. */
const MAY_REQUEST: ReadonlySet<string> = new Set(['no_org', 'rejected', 'removed']);

export async function createAccessRequest(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  if (principal.kind !== 'other' || isStaffPrincipal(principal) || !MAY_REQUEST.has(principal.access.state)) {
    throw new AppError(403, 'forbidden', 'Forbidden');
  }
  const body = parseInput(requestBody, req.body);
  const town = resolveTown(body.town);
  if (town === null) throw new AppError(400, 'unknown_town', 'Unknown town');
  const now = ctx.now();
  const note = body.note === undefined || body.note === null || body.note === '' ? null : body.note;
  const requestId = await ctx.stores.requests.create({
    userId: principal.userId,
    emailAtRequest: principal.email,
    orgName: body.orgName,
    contactName: body.contactName,
    contactRole: body.contactRole,
    town,
    locationCount: body.locationCount,
    note,
    placeId: body.placeId ?? null,
    createdAt: now,
  });
  if (requestId === null) throw new AppError(409, 'request_exists', 'A request is already pending');
  await recordAfter(ctx, {
    actorUserId: principal.userId, actorEmail: principal.email, actorRole: 'user', viewAsGrantId: null,
    at: now, orgId: null, action: 'access_request.created',
    target: { type: 'request', id: requestId },
    details: { orgName: body.orgName, townId: town.townId, townName: town.name, hasPlace: body.placeId != null },
  });
  res.status(201).json(meResponse(await resolveAccess(ctx, authOf(req))));
}
