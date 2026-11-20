// A location's competitors (D66, openspec change town-research-agent, design decision 10). Pure: Nearby Search's live
// answer around the location's place (places/google.ts `nearby`) in, the competitors out. Nothing here is stored:
// Google's names, types, websites and points live only for the request or the research thread that asked, and only
// place ids (which Google lets us keep) reach an event row, as `competitorPlaceId`.
//
// Nearby's `includedTypes` matches any of a place's types, not only its primary one (task 0.2's probe got a book store
// and a community center), so a place is a competitor only when its `primaryType` is a food or drink type. Specific
// primary types are common (`american_restaurant`, `wine_bar`, `coffee_shop`), so they are grouped in three families,
// and places of the location's own family come first.
//
// The name match: with Google's names kept from Anthropic (TOWNWISE_RESEARCH_PLACES_TO_AI off, the code default; also
// with it on when the run had no competitor list), the competitors thread finds businesses
// on the web and stores each as a `business` entity; the Competition card puts an entity's events under a competitor's
// letter when the entity's `nameKey` equals the `nameKey` of that competitor's live display name. The comparison runs on
// the server for each view, and its result is stored and sent nowhere.
import type { NearbyPlace } from '../places/google.ts';
import { nameKey } from './dedupe.ts';
import { MAX_COMPETITORS, type CompetitorInput } from './prompt.ts';

/** How far a competitor may be from the location. */
export const COMPETITOR_RADIUS_M = 1_500;

export type TypeFamily = 'restaurant' | 'bar' | 'cafe';

const FAMILY_OF: Readonly<Record<string, TypeFamily>> = {
  restaurant: 'restaurant', diner: 'restaurant', steak_house: 'restaurant', bistro: 'restaurant', deli: 'restaurant',
  sandwich_shop: 'restaurant', food_court: 'restaurant', meal_takeaway: 'restaurant', meal_delivery: 'restaurant',
  bar_and_grill: 'restaurant', snack_bar: 'restaurant', noodle_shop: 'restaurant', hot_dog_stand: 'restaurant',
  bar: 'bar', pub: 'bar', gastropub: 'bar', brewpub: 'bar', brewery: 'bar', beer_garden: 'bar', beer_hall: 'bar',
  night_club: 'bar', winery: 'bar',
  cafe: 'cafe', coffee_shop: 'cafe', coffee_roastery: 'cafe', coffee_stand: 'cafe', tea_house: 'cafe', bakery: 'cafe',
  bagel_shop: 'cafe', donut_shop: 'cafe', dessert_shop: 'cafe', ice_cream_shop: 'cafe', juice_shop: 'cafe', acai_shop: 'cafe',
  cake_shop: 'cafe', pastry_shop: 'cafe', chocolate_shop: 'cafe', confectionery: 'cafe', cafeteria: 'cafe',
};

/** Types whose suffix reads as food or drink but are not (an internet cafe). */
const NOT_FOOD: ReadonlySet<string> = new Set(['internet_cafe']);

/**
 * A primary type's family, or null when it is not a food or drink type. Beyond the listed types, a `_restaurant`
 * suffix is a restaurant, `_bar` or `_pub` a bar, and `_cafe` a cafe, so a new specific type Google adds still counts.
 */
export function typeFamily(primaryType: string | null): TypeFamily | null {
  if (primaryType === null || NOT_FOOD.has(primaryType)) return null;
  const listed = FAMILY_OF[primaryType];
  if (listed !== undefined) return listed;
  if (primaryType.endsWith('_restaurant')) return 'restaurant';
  if (primaryType.endsWith('_bar') || primaryType.endsWith('_pub')) return 'bar';
  if (primaryType.endsWith('_cafe')) return 'cafe';
  return null;
}

export interface Point { readonly lat: number; readonly lng: number }

const EARTH_RADIUS_M = 6_371_008.8;

/** The great-circle distance in meters. */
export function distanceM(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A competitor, live from Google: `n` is its number in a research request and its letter's position on the card. */
export interface Competitor {
  readonly n: number;
  readonly placeId: string;
  readonly name: string;
  readonly primaryType: string;
  readonly family: TypeFamily;
  readonly website: string | null;
  readonly distanceM: number;
}

/**
 * The location's competitors from Nearby Search's answer around its point: its own place dropped, places that are not
 * food or drink dropped, at most COMPETITOR_RADIUS_M away; the location's own family first (its family read from its
 * own place in the answer, when there), then the nearest; at most MAX_COMPETITORS, numbered from 1.
 */
export function pickCompetitors(input: { readonly ownPlaceId: string; readonly center: Point; readonly places: readonly NearbyPlace[] }): Competitor[] {
  const own = input.places.find((place) => place.placeId === input.ownPlaceId);
  const ownFamily = own === undefined ? null : typeFamily(own.primaryType);
  const seen = new Set<string>([input.ownPlaceId]);
  const candidates: Omit<Competitor, 'n'>[] = [];
  for (const place of input.places) {
    if (seen.has(place.placeId)) continue;
    seen.add(place.placeId);
    const family = typeFamily(place.primaryType);
    if (family === null || place.primaryType === null) continue;
    const distance = distanceM(input.center, place);
    if (distance > COMPETITOR_RADIUS_M) continue;
    candidates.push({ placeId: place.placeId, name: place.name, primaryType: place.primaryType, family, website: place.website, distanceM: distance });
  }
  const rank = (family: TypeFamily): number => (ownFamily !== null && family === ownFamily ? 0 : 1);
  return candidates
    .sort((a, b) => rank(a.family) - rank(b.family) || a.distanceM - b.distanceM || (a.placeId < b.placeId ? -1 : 1))
    .slice(0, MAX_COMPETITORS)
    .map((competitor, index) => ({ n: index + 1, ...competitor }));
}

/** The competitors as the competitors thread's request lists them (only while Google's names may go to Anthropic). */
export function competitorInputs(competitors: readonly Competitor[]): CompetitorInput[] {
  return competitors.map((competitor) => ({ n: competitor.n, name: competitor.name, type: competitor.primaryType, website: competitor.website }));
}

/**
 * The competitors' place ids by `n`, from the ids a recorded competitors thread kept in request order (the merge's
 * `competitorPlaces`); null when the thread listed none (Google's names kept from Anthropic, or no list).
 */
export function placesByN(placeIds: readonly string[] | undefined): ReadonlyMap<number, string> | null {
  if (placeIds === undefined || placeIds.length === 0) return null;
  return new Map(placeIds.map((placeId, index) => [index + 1, placeId]));
}

/**
 * Which live competitor a competitor event belongs to: the one whose place id the event stored, else the first whose
 * live display name has the business entity's `nameKey`; null for none (the card's "found on the web" list). Neither
 * input nor answer is stored or sent.
 */
export function matchCompetitor(
  link: { readonly placeId: string | null; readonly nameKey: string | null },
  competitors: readonly { readonly placeId: string; readonly name: string }[],
): string | null {
  if (link.placeId !== null && competitors.some((competitor) => competitor.placeId === link.placeId)) return link.placeId;
  if (link.nameKey === null || link.nameKey === '') return null;
  return competitors.find((competitor) => nameKey(competitor.name) === link.nameKey)?.placeId ?? null;
}
