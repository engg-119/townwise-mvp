// GET /api/org/locations/map (D47, Settings' map with hover): the lettered map of the caller's own organization's
// locations, and where each pin sits on it, so the page can put a hover target over each pin. The place ids come from
// the organization's locations, never the request, so the route can't be used to look up other places.
// Each place's point comes from Google (Place Details `location`, an Essentials field) and is kept in Valkey for 29
// days, under the 30 consecutive days Google's Places policies allow for coordinates (place ids may be kept
// indefinitely); it is never written to Mongo, logged or answered except as a pin's position on the image. Without
// every point (the search off, Google failing, a place Google doesn't know), the answer is the lettered map Google
// fits itself (as POST /api/places/map with `labeled: true`) and no pins, so the page shows the map without hover.
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { PlacesUnavailableError } from '../places/google.ts';
import { mapThemeSchema, pinLabel, STATIC_MAP_HEIGHT, STATIC_MAP_WIDTH } from '../places/static-map.ts';
import { fitView, type LatLng } from '../places/view.ts';
import { memberOf } from './locations.ts';

const ROUTE_ID = 'org.locations.map';
/** Under Google's 30 consecutive days for coordinates. */
export const PLACE_POINT_TTL_SECONDS = 29 * 24 * 60 * 60;
const MAX_PINS = 26;

const query = z.object({ theme: mapThemeSchema.default('dark') });

export function placePointKey(placeId: string): string {
  return `townwise:place-point:${placeId}`;
}

/** The distinct place ids in the organization's order, at most 26, each with its letter: as Settings letters them. */
export function letteredPlaces(locations: readonly { placeId: string | null }[]): { placeId: string; letter: string }[] {
  const out: { placeId: string; letter: string }[] = [];
  const seen = new Set<string>();
  for (const { placeId } of locations) {
    if (placeId === null || seen.has(placeId) || out.length === MAX_PINS) continue;
    seen.add(placeId);
    out.push({ placeId, letter: pinLabel(out.length) });
  }
  return out;
}

function parsePoint(raw: string | null): LatLng | null {
  if (raw === null) return null;
  const [lat, lng] = raw.split(',').map(Number);
  return lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng) ? null : { lat, lng };
}

/** The place's point from Valkey, else from Google (then kept); null when it can't be had. */
async function pointOf(ctx: TownwiseContext, placeId: string): Promise<LatLng | null> {
  const cached = parsePoint(await ctx.redis.get(placePointKey(placeId)));
  if (cached !== null) return cached;
  if (ctx.places === null) return null;
  try {
    const at = await ctx.places.locate(placeId);
    if (at === null) return null;
    await ctx.redis.set(placePointKey(placeId), `${String(at.lat)},${String(at.lng)}`, 'EX', PLACE_POINT_TTL_SECONDS);
    return at;
  } catch (err) {
    if (!(err instanceof PlacesUnavailableError)) throw err;
    ctx.logger.warn({ routeId: ROUTE_ID, code: err.code, status: err.status, errType: err.errType }, 'townwise.places_failed');
    return null;
  }
}

export async function getLocationsMap(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const { theme } = parseInput(query, req.query);
  const places = letteredPlaces(await ctx.stores.locations.list(scope));
  const signer = ctx.placesMap;
  if (signer === null || places.length === 0) {
    res.status(200).json({ map: null, pins: [] });
    return;
  }
  // One at a time: at most 26, nearly always cached, and Google is never asked twice at once for one organization.
  const points: LatLng[] = [];
  for (const place of places) {
    const at = await pointOf(ctx, place.placeId);
    if (at === null) break;
    points.push(at);
  }
  if (points.length < places.length) {
    res.status(200).json({ map: signer.mapOfLabeledPlaces(places.map((p) => p.placeId), theme), pins: [] });
    return;
  }
  const view = fitView(points, STATIC_MAP_WIDTH, STATIC_MAP_HEIGHT);
  const pins = places.map((place, i) => ({ at: points[i] ?? { lat: 0, lng: 0 }, letter: place.letter }));
  res.status(200).json({
    map: signer.mapOfView(view, pins, theme),
    pins: places.map((place, i) => ({
      placeId: place.placeId, letter: place.letter, x: view.positions[i]?.x ?? 0, y: view.positions[i]?.y ?? 0,
    })),
  });
}
