// POST /api/places/autocomplete and POST /api/places/details: the Places proxy that finds the business when someone
// requests access; and (D29) POST /api/places/map, the signed map of every checked place, which never calls Google.
// Nothing from these routes is stored, and the typed text, place ids, addresses, Google's answers and the signed map
// URL never reach a log or an audit event: a failure logs the route id and a code only.
import { randomUUID } from 'node:crypto';

import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import { placeIdSchema } from '../place-id.ts';
import { PlacesUnavailableError, type AddressComponent, type PlacesClient } from '../places/google.ts';
import { mapThemeSchema } from '../places/static-map.ts';
import { TOWNS, US_STATE_CODES, type Town, type TownId, type TownRecord } from '../towns.ts';

/** A version 4 UUID, any case. The server checks the format only; Google groups the calls by it. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionTokenSchema = z.string().regex(UUID_V4);

const autocompleteBody = z.object({
  input: z.string().trim().min(2).max(120),
  sessionToken: sessionTokenSchema.optional(),
});
/** The portal's mode, which picks the map's style; 'dark' when absent, so a client from before light mode is unchanged. */
const mapTheme = mapThemeSchema.default('dark');
const detailsBody = z.object({
  placeId: placeIdSchema,
  sessionToken: sessionTokenSchema.optional(),
  theme: mapTheme,
});
/**
 * One map pins as many places as an organization may have locations: MAX_LOCATIONS in handlers/locations.ts, which
 * imports this module, so the number is repeated here (places-map.int.test.ts checks the two agree).
 */
const MAX_MAP_PLACES = 25;
/** 1 to MAX_MAP_PLACES distinct place ids, and the mode. */
const mapBody = z.object({ placeIds: z.array(placeIdSchema).min(1).max(MAX_MAP_PLACES), theme: mapTheme })
  .refine((body) => new Set(body.placeIds).size === body.placeIds.length);

/** Address component types that can name the town, in the order a town outside the twelve takes its name. */
const TOWN_COMPONENT_TYPES = ['locality', 'postal_town', 'sublocality', 'administrative_area_level_3'] as const;
/** The longest town name an access request accepts (townInputSchema). */
const MAX_TOWN_NAME = 80;
/** Villages Google may name instead of the researched town they are in. */
const TOWN_ALIASES: readonly { name: string; state: string; townId: TownId }[] = [
  { name: 'Lake Placid', state: 'NY', townId: 'north-elba-ny' },
  { name: 'North Conway', state: 'NH', townId: 'conway-nh' },
];
const STATE_CODES: ReadonlySet<string> = new Set(US_STATE_CODES);

function nameKey(name: string, state: string): string {
  return `${name.toLowerCase()}|${state}`;
}

/** The twelve by lower-case name and state, and by their aliases. */
const RESEARCHED: ReadonlyMap<string, TownRecord> = new Map([
  ...TOWNS.map((town) => [nameKey(town.name, town.state), town] as const),
  ...TOWN_ALIASES.flatMap((alias) => {
    const town = TOWNS.find((candidate) => candidate.townId === alias.townId);
    return town === undefined ? [] : [[nameKey(alias.name, alias.state), town] as const];
  }),
]);

function unavailable(): AppError {
  return new AppError(503, 'places_unavailable', 'Place search isn’t available right now');
}

function placesOf(ctx: TownwiseContext): PlacesClient {
  if (ctx.places === null) throw unavailable();
  return ctx.places;
}

/** One call to Google. A failure is logged by route id and code, and answers 503. */
async function ask<T>(ctx: TownwiseContext, routeId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof PlacesUnavailableError)) throw err;
    ctx.logger.warn({ routeId, code: err.code, status: err.status, errType: err.errType }, 'townwise.places_failed');
    throw unavailable();
  }
}

/**
 * The town of a US address, as a TownInput the access request accepts unchanged: one of the twelve researched towns
 * when any town-naming component (or an alias) matches its name and state, ignoring case; otherwise the first
 * town-naming component, in TOWN_COMPONENT_TYPES order, with townId null. Null unless the country component is US and
 * the state is in US_STATE_CODES (so a territory is null either way), or without a usable town name.
 */
export function townOfAddress(components: readonly AddressComponent[]): Town | null {
  const ofType = (type: string): AddressComponent | undefined => components.find((component) => component.types.includes(type));
  if (ofType('country')?.shortText !== 'US') return null;
  const state = (ofType('administrative_area_level_1')?.shortText ?? '').trim().toUpperCase();
  if (!STATE_CODES.has(state)) return null;
  const names = TOWN_COMPONENT_TYPES
    .map((type) => (ofType(type)?.longText ?? '').trim())
    .filter((name) => name !== '' && name.length <= MAX_TOWN_NAME);
  const researched = names.map((name) => RESEARCHED.get(nameKey(name, state))).find((town) => town !== undefined);
  if (researched !== undefined) return { townId: researched.townId, name: researched.name, state: researched.state };
  const [first] = names;
  return first === undefined ? null : { townId: null, name: first, state };
}

/**
 * Request `{ input, sessionToken? }`; without a session token the server makes one. Answers `{ suggestions, sessionToken }`,
 * each suggestion `{ placeId, name, detail, kind }` with kind `business` or `address` (D29).
 */
export async function placesAutocomplete(ctx: TownwiseContext, req: Request, res: Response): Promise<void> {
  const places = placesOf(ctx);
  const body = parseInput(autocompleteBody, req.body);
  const sessionToken = body.sessionToken ?? randomUUID();
  const suggestions = await ask(ctx, 'places.autocomplete', () => places.autocomplete(body.input, sessionToken));
  res.status(200).json({ suggestions, sessionToken });
}

/**
 * Request `{ placeId, sessionToken?, theme? }`, which ends Google's billed session; without a session token (a checked
 * place after the first in one list) the server makes one. Answers `{ place: { placeId, address, town, map } }`: `map`
 * is a signed Maps Static URL of Google's current id for the place in the mode `theme` names (dark without one), which
 * the browser loads from Google, or null while the map is off.
 */
export async function placesDetails(ctx: TownwiseContext, req: Request, res: Response): Promise<void> {
  const places = placesOf(ctx);
  const body = parseInput(detailsBody, req.body);
  const sessionToken = body.sessionToken ?? randomUUID();
  const place = await ask(ctx, 'places.details', () => places.details(body.placeId, sessionToken));
  if (place === null) throw new AppError(404, 'place_not_found', 'Place not found');
  res.status(200).json({
    place: {
      placeId: place.placeId,
      address: place.formattedAddress,
      town: townOfAddress(place.addressComponents),
      map: ctx.placesMap?.mapOf(place.placeId, body.theme) ?? null,
    },
  });
}

/**
 * Request `{ placeIds, theme? }`; answers `{ map }`, the signed map of every place (a mint pin each, in the order
 * given) in the mode `theme` names (dark without one), or null while the map is off. Signing is local: it never calls
 * Google and works with the Places search off.
 */
export function placesMap(ctx: TownwiseContext, req: Request, res: Response): Promise<void> {
  const { placeIds, theme } = parseInput(mapBody, req.body);
  res.status(200).json({ map: ctx.placesMap?.mapOfPlaces(placeIds, theme) ?? null });
  return Promise.resolve();
}
