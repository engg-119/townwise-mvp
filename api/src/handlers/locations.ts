// The organization and its locations (spec 10.3, P9, P10, P16): members read them, org admins add, change and
// delete locations. The organization comes only from the principal's scope, and every location route loads
// { _id, orgId } first (spec 6.10 rule 4).
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import { calibrationOf, type Calibration } from '../calibration.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { NO_COVERAGE, type Coverage } from '../stores/sales-days.ts';
import { resolveTown, townInputSchema, type Town } from '../towns.ts';
import { actorOf, orgAdmin } from './team.ts';

/** Spec 10.1. */
export interface LocationSummary {
  id: string; name: string; town: Town; coverage: Coverage; calibration: Calibration;
  notesCount: number; lastUploadAt: string | null;
}

/** Spec 6.4. [CONFIRM: 25 locations] */
const MAX_LOCATIONS = 25;

const nameSchema = z.string().trim().min(1).max(80);
const createBody = z.object({ name: nameSchema, town: townInputSchema });
const updateBody = z.object({ name: nameSchema.optional(), town: townInputSchema.optional() })
  .refine((body) => body.name !== undefined || body.town !== undefined);

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

function unknownTown(): AppError {
  return new AppError(400, 'unknown_town', 'Unknown town');
}

/** The member policy already passed; this narrows the principal for the handler. */
export function memberOf(principal: Principal): MemberPrincipal {
  if (principal.kind !== 'member') throw new AppError(403, 'no_access', 'No access');
  return principal;
}

/** A location of the caller's organization. Another organization's answers 404, exactly like one that does not exist. */
export async function loadLocation(ctx: TownwiseContext, scope: OrgScope, rawId: unknown): Promise<LocationRecord> {
  const location = await ctx.stores.locations.find(scope, parseInput(objectId, rawId));
  if (location === null) throw notFound();
  return location;
}

/** Reads the organization's coverage, note counts and last uploads once; the returned function builds each summary. */
async function summarizer(ctx: TownwiseContext, scope: OrgScope): Promise<(location: LocationRecord) => LocationSummary> {
  const [coverage, notes, uploads] = await Promise.all([
    ctx.stores.salesDays.coverageByLocation(scope),
    ctx.stores.notes.countByLocation(scope),
    ctx.stores.uploads.lastUploadByLocation(scope),
  ]);
  return (location) => {
    const covered = coverage.get(location.id) ?? NO_COVERAGE;
    return {
      id: location.id, name: location.name, town: location.town, coverage: covered, calibration: calibrationOf(covered),
      notesCount: notes.get(location.id) ?? 0, lastUploadAt: uploads.get(location.id)?.toISOString() ?? null,
    };
  };
}

/** GET /api/org. `requestedLocationCount` is the location count of the request the organization was approved from. */
export async function getOwnOrg(ctx: TownwiseContext, _req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const [org, locations, summarize] = await Promise.all([
    ctx.stores.orgs.findById(scope.orgId),
    ctx.stores.locations.list(scope),
    summarizer(ctx, scope),
  ]);
  // Only a deletion racing this request gets here; the client re-reads /api/me.
  if (org === null) throw new AppError(403, 'no_access', 'No access');
  const request = org.fromRequestId === null ? null : await ctx.stores.requests.findById(org.fromRequestId);
  res.status(200).json({
    org: { id: org.id, name: org.name },
    role: member.role,
    locations: locations.map(summarize),
    requestedLocationCount: request?.locationCount ?? null,
  });
}

/** POST /api/org/locations (P10). */
export async function createLocation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const body = parseInput(createBody, req.body);
  const town = resolveTown(body.town);
  if (town === null) throw unknownTown();
  if (await ctx.stores.locations.count(scope) >= MAX_LOCATIONS) {
    throw new AppError(409, 'location_limit', 'The organization has reached its location limit');
  }
  const now = ctx.now();
  const location = await ctx.stores.locations.create(scope, { name: body.name, town, createdAt: now, createdBy: admin.userId });
  if (location === null) throw new AppError(409, 'location_name_taken', 'Another location already uses that name');
  await recordAfter(ctx, {
    ...actorOf(admin), at: now, orgId: scope.orgId, action: 'location.created',
    target: { type: 'location', id: location.id },
    details: { name: location.name, townId: location.town.townId },
  });
  const summarize = await summarizer(ctx, scope);
  res.status(201).json({ location: summarize(location) });
}

/** PATCH /api/org/locations/:locationId (P16): name, town or both. */
export async function updateLocation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const body = parseInput(updateBody, req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  let town: Town | undefined;
  if (body.town !== undefined) {
    const resolved = resolveTown(body.town);
    if (resolved === null) throw unknownTown();
    town = resolved;
  }
  const outcome = await ctx.stores.locations.update(scope, location.id, { name: body.name, town });
  if (outcome === 'name_taken') throw new AppError(409, 'location_name_taken', 'Another location already uses that name');
  const updated = outcome === 'updated' ? await ctx.stores.locations.find(scope, location.id) : null;
  if (updated === null) throw notFound();
  await recordAfter(ctx, {
    ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'location.updated',
    target: { type: 'location', id: updated.id },
    details: { name: updated.name, townId: updated.town.townId },
  });
  const summarize = await summarizer(ctx, scope);
  res.status(200).json({ location: summarize(updated) });
}

/** DELETE /api/org/locations/:locationId (P16): only a location with no sales day and no note. */
export async function deleteLocation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  // Stored files are data too (spec 11A): deleting the sales data deletes them.
  const [hasDays, hasNotes, hasFiles] = await Promise.all([
    ctx.stores.salesDays.hasAny(scope, location.id),
    ctx.stores.notes.hasAny(scope, location.id),
    ctx.stores.files.hasAny(scope, location.id),
  ]);
  if (hasDays || hasNotes || hasFiles) throw new AppError(409, 'location_has_data', 'Delete the location’s sales data and notes first');
  if (!(await ctx.stores.locations.remove(scope, location.id))) throw notFound();
  // Records of uploads that never wrote a day (a crash leaves `applying`) go with it, and so do its tuning chats,
  // which nothing could reach without the location.
  await ctx.stores.uploads.removeForLocation(scope, location.id);
  await ctx.stores.chatConversations.removeForLocation(scope, location.id);
  await ctx.stores.chatProposals.removeForLocation(scope, location.id);
  // U9: answers to TownwiseAI's questions about the location's days.
  await ctx.stores.agentAnswers.removeForLocation(scope, location.id);
  // An empty import left open goes too.
  await ctx.stores.imports.removeForLocation(scope, location.id);
  // U13B: forecasts staff imported for it, even with no sales data left.
  await ctx.stores.forecasts.removeForLocation(scope, location.id);
  await recordAfter(ctx, {
    ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'location.deleted',
    target: { type: 'location', id: location.id },
    details: { name: location.name, townId: location.town.townId },
  });
  res.status(204).end();
}
