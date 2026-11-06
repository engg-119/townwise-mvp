// POST /api/places/autocomplete and POST /api/places/details: the Places proxy that finds the business when someone
// requests access. Nothing from these routes is stored, and the typed text, place ids, addresses and Google's answers
// never reach a log or an audit event: a failure logs the route id and a code only.
import { randomUUID } from 'node:crypto';

import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import { placeIdSchema } from '../place-id.ts';
import { PlacesUnavailableError, type AddressComponent, type PlacesClient } from '../places/google.ts';
import { TOWNS, US_STATE_CODES, type Town, type TownId, type TownRecord } from '../towns.ts';

/** A version 4 UUID, any case. The server checks the format only; Google groups the calls by it. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionTokenSchema = z.string().regex(UUID_V4);

const autocompleteBody = z.object({
  input: z.string().trim().min(2).max(120),
  sessionToken: sessionTokenSchema.optional(),
});
const detailsBody = z.object({
  placeId: placeIdSchema,
  sessionToken: sessionTokenSchema,
});

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

/** Request `{ input, sessionToken? }`; without a session token the server makes one. Answers `{ suggestions, sessionToken }`. */
export async function placesAutocomplete(ctx: TownwiseContext, req: Request, res: Response): Promise<void> {
  const places = placesOf(ctx);
  const body = parseInput(autocompleteBody, req.body);
  const sessionToken = body.sessionToken ?? randomUUID();
  const suggestions = await ask(ctx, 'places.autocomplete', () => places.autocomplete(body.input, sessionToken));
  res.status(200).json({ suggestions, sessionToken });
}

/** Request `{ placeId, sessionToken }`, which ends Google's billed session. Answers `{ place: { placeId, address, town } }`. */
export async function placesDetails(ctx: TownwiseContext, req: Request, res: Response): Promise<void> {
  const places = placesOf(ctx);
  const body = parseInput(detailsBody, req.body);
  const place = await ask(ctx, 'places.details', () => places.details(body.placeId, body.sessionToken));
  if (place === null) throw new AppError(404, 'place_not_found', 'Place not found');
  res.status(200).json({
    place: { placeId: place.placeId, address: place.formattedAddress, town: townOfAddress(place.addressComponents) },
  });
}
