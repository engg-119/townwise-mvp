// The organization and its locations (spec 10.3, P9, P10, P16): members read them, org admins add, change and
// delete locations. The organization comes only from the principal's scope, and every location route loads
// { _id, orgId } first (spec 6.10 rule 4). A location can carry the Google place id the org admin picked: the server
// asks Google for that place and takes its town the way the Places search does (townOfAddress), so a client never
// sets a town for a place on its own word. Neither the id nor the address reaches a log or an audit event. Staff setup
// (D23, staff-setup.ts) runs the same checks and writes through the exported functions.
import { randomUUID } from 'node:crypto';

import { objectId } from '@ckeith26/mongo';
import { createRateLimiter, RateLimiterUnavailableError, type RateLimiter } from '@ckeith26/rate-limit';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import { endUnusedGoogleAccess, googleAccessDeps, markLocationForCheck } from '../calendar/google-access.ts';
import { calibrationFor, type Calibration } from '../calibration.ts';
import { placeIdSchema } from '../place-id.ts';
import { PlacesUnavailableError, type PlaceDetails } from '../places/google.ts';
import type { AuditDetails } from '../stores/audit-events.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { NO_COVERAGE, type Coverage } from '../stores/sales-days.ts';
import { resolveTown, townInputSchema, type Town } from '../towns.ts';
import { townOfAddress } from './places.ts';
import { assertNotReading, filesUnavailable, removeSalesData } from './sales.ts';
import { actorOf, assertOpenAsAdminTab, orgAdmin } from './team.ts';

/** Spec 10.1. */
export interface LocationSummary {
  id: string; name: string; town: Town; placeId: string | null; coverage: Coverage; calibration: Calibration;
  notesCount: number; lastUploadAt: string | null;
  /** D28: days that turned-off uploads hold, which `coverage` leaves out. */
  offDayCount: number;
}

/** Spec 6.4. [CONFIRM: 25 locations] */
export const MAX_LOCATIONS = 25;

const nameSchema = z.string().trim().min(1).max(80);
const createBody = z.object({ name: nameSchema, town: townInputSchema, placeId: placeIdSchema.nullish() });
/** A place id comes with the town the client showed for it, which must be the place's own; null takes the place off. */
const updateBody = z.object({ name: nameSchema.optional(), town: townInputSchema.optional(), placeId: placeIdSchema.nullable().optional() })
  .refine((body) => body.name !== undefined || body.town !== undefined || body.placeId !== undefined)
  .refine((body) => typeof body.placeId !== 'string' || body.town !== undefined);

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

function unknownTown(): AppError {
  return new AppError(400, 'unknown_town', 'Unknown town');
}

export function nameTaken(): AppError {
  return new AppError(409, 'location_name_taken', 'Another location already uses that name');
}

function placesUnavailable(): AppError {
  return new AppError(503, 'places_unavailable', 'Place search isn’t available right now');
}

/**
 * The Places routes' per-account budget (ROUTE_LIMITS.places in ../access/routes.ts; same name, so the same Redis
 * count). The location routes carry no route limiter, since a write without a place never calls Google; a write with
 * one spends a call from this budget before Google is asked.
 */
const PLACES_BUDGET = { name: 'townwise:places', limit: 300, windowSeconds: 3600 } as const;
const placesBudgets = new WeakMap<TownwiseContext['redis'], RateLimiter>();

/**
 * Spends one call of the caller's Places budget: 429 rate_limited when it is used up, and, since every call costs
 * money, 503 places_unavailable when the store can't count it (the page keeps its manual fields).
 */
async function spendPlacesCall(ctx: TownwiseContext, userId: string): Promise<void> {
  let limiter = placesBudgets.get(ctx.redis);
  if (limiter === undefined) {
    limiter = createRateLimiter({ redis: ctx.redis, ...PLACES_BUDGET });
    placesBudgets.set(ctx.redis, limiter);
  }
  let decision;
  try {
    decision = await limiter.consume(`acct:${userId}`);
  } catch (err) {
    if (!(err instanceof RateLimiterUnavailableError)) throw err;
    throw placesUnavailable();
  }
  if (!decision.allowed) {
    throw new AppError(429, 'rate_limited', 'Too many requests. Try again later.', { retryAfterSeconds: decision.retryAfterSeconds });
  }
}

/** The same town: one of the twelve by id, another town by name (ignoring case) and state. */
function sameTown(a: Town, b: Town): boolean {
  if (a.townId !== null || b.townId !== null) return a.townId === b.townId;
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && a.state === b.state;
}

/**
 * The place an org admin picked, checked with Google: its current id and its own town, which must be the town the
 * client sent. The call is spent from the admin's Places budget first (spendPlacesCall). 503 places_unavailable while
 * the search is off or Google fails (logged by route id and code only, as
 * the Places routes do); 400 unknown_place when Google has no such place; 400 place_not_supported outside the 50
 * states and DC or without a town; 400 place_town_mismatch when the sent town is another.
 */
async function checkedPlace(
  ctx: TownwiseContext, routeId: string, userId: string, placeId: string, sent: Town,
): Promise<{ placeId: string; town: Town }> {
  const places = ctx.places;
  if (places === null) throw placesUnavailable();
  await spendPlacesCall(ctx, userId);
  let place: PlaceDetails | null;
  try {
    // A session of its own: the client's search session ended with its details call.
    place = await places.details(placeId, randomUUID());
  } catch (err) {
    if (!(err instanceof PlacesUnavailableError)) throw err;
    ctx.logger.warn({ routeId, code: err.code, status: err.status, errType: err.errType }, 'townwise.places_failed');
    throw placesUnavailable();
  }
  if (place === null) throw new AppError(400, 'unknown_place', 'Unknown place');
  const town = townOfAddress(place.addressComponents);
  if (town === null) throw new AppError(400, 'place_not_supported', 'Townwise works with places in a US town');
  if (!sameTown(town, sent)) throw new AppError(400, 'place_town_mismatch', 'That town isn’t the place’s town');
  return { placeId: place.placeId, town };
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

/**
 * Reads the organization's coverage, note counts and last uploads once; the returned function builds each summary,
 * reading the location's newest published run for its calibration state (D42).
 */
export async function summarizer(ctx: TownwiseContext, scope: OrgScope): Promise<(location: LocationRecord) => Promise<LocationSummary>> {
  const [coverage, notes, uploads, offDays] = await Promise.all([
    ctx.stores.salesDays.coverageByLocation(scope),
    ctx.stores.notes.countByLocation(scope),
    ctx.stores.uploads.lastUploadByLocation(scope),
    ctx.stores.salesDays.offDayCountByLocation(scope),
  ]);
  return async (location) => {
    const covered = coverage.get(location.id) ?? NO_COVERAGE;
    return {
      id: location.id, name: location.name, town: location.town, placeId: location.placeId, coverage: covered,
      calibration: await calibrationFor(ctx, scope, location, covered), notesCount: notes.get(location.id) ?? 0,
      lastUploadAt: uploads.get(location.id)?.toISOString() ?? null, offDayCount: offDays.get(location.id) ?? 0,
    };
  };
}

/**
 * GET /api/org. `requestedLocationCount` is the location count of the request the organization was approved from;
 * `placeSearch` says whether the Google Places search is on, so P10 and P16 offer it only then.
 */
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
    locations: await Promise.all(locations.map(summarize)),
    requestedLocationCount: request?.locationCount ?? null,
    placeSearch: ctx.places !== null,
  });
}

/** A location as POST writes it, or as PATCH leaves it. */
export interface LocationInput { name: string; town: Town; placeId: string | null }

/** What PATCH writes: the fields given, `placeId` null taking the place off. */
export interface LocationChange { name: string | undefined; town: Town | undefined; placeId: string | null | undefined }

/** The details `location.created` and `location.updated` record: never the place id. */
export function locationDetails(location: LocationInput): AuditDetails {
  return { name: location.name, townId: location.town.townId, hasPlace: location.placeId !== null };
}

/**
 * POST's checks, shared by the org admin route and staff setup (D23): the body, its town, the location limit, then a
 * place, checked with Google on `userId`'s Places budget (`routeId` names the route in a failure's log line).
 */
export async function checkedCreate(
  ctx: TownwiseContext, scope: OrgScope, routeId: string, userId: string, raw: unknown,
): Promise<LocationInput> {
  const body = parseInput(createBody, raw);
  const sent = resolveTown(body.town);
  if (sent === null) throw unknownTown();
  if (await ctx.stores.locations.count(scope) >= MAX_LOCATIONS) {
    throw new AppError(409, 'location_limit', 'The organization has reached its location limit');
  }
  const place = body.placeId === undefined || body.placeId === null
    ? { placeId: null, town: sent }
    : await checkedPlace(ctx, routeId, userId, body.placeId, sent);
  return { name: body.name, town: place.town, placeId: place.placeId };
}

/**
 * PATCH's checks, shared by the org admin route and staff setup (D23): the body, the location (404), its new town and a
 * place, as checkedCreate. A place id sets the place and its town (checkedPlace); null takes the place off; a town
 * changed by hand takes the place off too, since the place no longer describes the location.
 */
export async function checkedUpdate(
  ctx: TownwiseContext, scope: OrgScope, routeId: string, userId: string, rawId: unknown, raw: unknown,
): Promise<{ location: LocationRecord; change: LocationChange }> {
  const body = parseInput(updateBody, raw);
  const location = await loadLocation(ctx, scope, rawId);
  let town: Town | undefined;
  if (body.town !== undefined) {
    const resolved = resolveTown(body.town);
    if (resolved === null) throw unknownTown();
    town = resolved;
  }
  let placeId = body.placeId;
  if (typeof placeId === 'string' && town !== undefined) {
    ({ placeId, town } = await checkedPlace(ctx, routeId, userId, placeId, town));
  } else if (placeId === undefined && town !== undefined && location.placeId !== null && !sameTown(town, location.town)) {
    placeId = null;
  }
  return { location, change: { name: body.name, town, placeId } };
}

/**
 * Staff setup's DELETE check (D23): only a location with no sales day, note, stored file or item-sales day. The org
 * admin's route deletes the data with the location instead (D44). Stored files and item sales are data too (spec 11A, D35): deleting the sales data
 * deletes them.
 */
export async function assertNoLocationData(ctx: TownwiseContext, scope: OrgScope, locationId: string): Promise<void> {
  const [hasDays, hasNotes, hasFiles, hasItemSales] = await Promise.all([
    ctx.stores.salesDays.hasAny(scope, locationId),
    ctx.stores.notes.hasAny(scope, locationId),
    ctx.stores.files.hasAny(scope, locationId),
    ctx.stores.itemSales.hasAny(scope, locationId),
  ]);
  if (hasDays || hasNotes || hasFiles || hasItemSales) {
    throw new AppError(409, 'location_has_data', 'Delete the location’s sales data and notes first');
  }
}

/**
 * DELETE's effect, shared with staff setup (D23): the location, then what only it reached. False when it was already
 * gone. First the Google connections backing its Google calendars are marked for a check (connect-google-calendar,
 * design decision 11), since a request that stops once the location row is gone leaves calendars the refresh loop
 * removes, and the check then ends a connection left backing nothing; at the end each one now backing nothing is ended.
 */
export async function removeLocation(ctx: TownwiseContext, scope: OrgScope, locationId: string): Promise<boolean> {
  const google = googleAccessDeps(ctx);
  const connections = await markLocationForCheck(google, scope, locationId);
  if (!(await ctx.stores.locations.remove(scope, locationId))) return false;
  // D44: an upload or a note that loaded the location before its row went can land after the org admin's delete swept
  // them, so they are swept again here (a no-op for staff setup, which only deletes an empty location).
  await ctx.stores.salesDays.removeForLocation(scope, locationId);
  await ctx.stores.notes.removeForLocation(scope, locationId);
  // Records of uploads that never wrote a day (a crash leaves `applying`) go with it, and so do its tuning chats,
  // which nothing could reach without the location.
  await ctx.stores.uploads.removeForLocation(scope, locationId);
  await ctx.stores.chatConversations.removeForLocation(scope, locationId);
  // resumable-chat-turns: their turns' records, so a turn still running ends at its next write.
  await ctx.stores.chatTurns.removeForLocation(scope, locationId);
  await ctx.stores.chatProposals.removeForLocation(scope, locationId);
  // D31: its business rules, which never block deleting it.
  await ctx.stores.businessRules.removeForLocation(scope, locationId);
  // U9: answers to TownwiseAI's questions about the location's days.
  await ctx.stores.agentAnswers.removeForLocation(scope, locationId);
  // Its weekly suggestions and their pass rows.
  await ctx.stores.agentSuggestions.removeForLocation(scope, locationId);
  // D59: the ledger of TownwiseAI's changes there.
  await ctx.stores.agentChanges.removeForLocation(scope, locationId);
  // An empty import left open goes too.
  await ctx.stores.imports.removeForLocation(scope, locationId);
  // The forecast lab: calibrations go first, so a running job's callback closes before its run could be written.
  await ctx.stores.calibrations.removeForLocation(scope, locationId);
  // D42: its weekly refresh rows.
  await ctx.stores.forecastWeeks.removeForLocation(scope, locationId);
  // U13B: forecasts staff imported for it, even with no sales data left.
  await ctx.stores.forecasts.removeForLocation(scope, locationId);
  // The owner's calendars and their events.
  await ctx.stores.ownerCalendars.removeForLocation(scope, locationId);
  // Orders: saved edits, confirmed rules, the setup, item sales and counts go with the location.
  await ctx.stores.orders.removeForLocation(scope, locationId);
  await ctx.stores.orderSetups.removeForLocation(scope, locationId);
  await ctx.stores.itemSales.removeForLocation(scope, locationId);
  await ctx.stores.orderCounts.removeForLocation(scope, locationId);
  // A connection that still backs a calendar of another location stays.
  for (const connectionId of connections) await endUnusedGoogleAccess(google, scope, connectionId, 'location_deleted');
  return true;
}

/** POST /api/org/locations (P10). `orgId`, the organization the page shows, is required in open as admin (D25). */
export async function createLocation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  assertOpenAsAdminTab(admin, req.body);
  const { scope } = admin;
  const input = await checkedCreate(ctx, scope, 'org.locations.create', admin.userId, req.body);
  const now = ctx.now();
  const location = await ctx.stores.locations.create(scope, {
    ...input, createdAt: now, createdBy: admin.userId, ...(admin.openAsAdmin !== null ? { byStaff: true } : {}),
  });
  if (location === null) throw nameTaken();
  await recordAfter(ctx, {
    ...actorOf(admin), at: now, orgId: scope.orgId, action: 'location.created',
    target: { type: 'location', id: location.id },
    details: locationDetails(location),
  });
  const summarize = await summarizer(ctx, scope);
  res.status(201).json({ location: await summarize(location) });
}

/** PATCH /api/org/locations/:locationId (P16): name, town, place, or any of them (checkedUpdate). */
export async function updateLocation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const { location, change } = await checkedUpdate(ctx, scope, 'org.locations.update', admin.userId, req.params.locationId, req.body);
  const outcome = await ctx.stores.locations.update(scope, location.id, change);
  if (outcome === 'name_taken') throw nameTaken();
  const updated = outcome === 'updated' ? await ctx.stores.locations.find(scope, location.id) : null;
  if (updated === null) throw notFound();
  await recordAfter(ctx, {
    ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'location.updated',
    target: { type: 'location', id: updated.id },
    details: locationDetails(updated),
  });
  const summarize = await summarizer(ctx, scope);
  res.status(200).json({ location: await summarize(updated) });
}

/**
 * DELETE /api/org/locations/:locationId (P16, D44): the location with all its data (sales days, uploads, stored files,
 * forecasts, notes, then everything `removeLocation` takes). 409 `import_running` while one of its files is being read,
 * 503 `files_unavailable` while stored files are off but it has some; nothing is deleted then.
 */
export async function deleteLocation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  // D44: one press deletes the location with all its data. The data goes first and the location row last, so a request
  // that stops partway leaves the location in place and the same delete, sent again, finishes it.
  await assertNotReading(ctx, scope, location.id);
  const removed = await removeSalesData(ctx, scope, location.id);
  if (removed === 'files_unavailable') throw filesUnavailable();
  const deletedNotes = await ctx.stores.notes.removeForLocation(scope, location.id);
  if (!(await removeLocation(ctx, scope, location.id))) throw notFound();
  await recordAfter(ctx, {
    ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'location.deleted',
    target: { type: 'location', id: location.id },
    details: {
      name: location.name, townId: location.town.townId,
      deletedDays: removed.deletedDays, deletedFiles: removed.deletedFiles, deletedNotes,
    },
  });
  res.status(204).end();
}
