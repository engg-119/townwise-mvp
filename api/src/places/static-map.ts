// The map of the places someone checks (and of one place on the confirm card): a Google Maps Static API URL, signed
// here and loaded by the browser (and the native Image) straight from maps.googleapis.com. The API never fetches,
// relays or stores the image.
// main.ts builds the signer when GOOGLE_MAPS_STATIC_KEY and GOOGLE_MAPS_SIGNING_SECRET are both set; without either
// there is no map, and a map URL is never made unsigned.
// The URL carries the static key and a signature, so nothing here logs, and the handler returns it only in the answer
// body (server-core logs the request path, never the body). The key is browser-safe by design: restricted in Google's
// console to the Maps Static API, with unsigned requests refused (infra/README.md, step 17), so on its own it draws
// nothing, and the signing secret never leaves the server.
import { createHmac } from 'node:crypto';

import { z } from 'zod';

export const STATIC_MAP_ORIGIN = 'https://maps.googleapis.com';
export const STATIC_MAP_PATH = '/maps/api/staticmap';
/** The logical size; with scale 2 Google draws 1280 by 640 pixels. The client sizes the image by this 2:1 ratio. */
export const STATIC_MAP_WIDTH = 640;
export const STATIC_MAP_HEIGHT = 320;

/** The portal's two modes (client/src/portal/shell/themeMode.ts). A request that names none gets the dark map. */
export const MAP_THEMES = ['dark', 'light'] as const;
export type MapTheme = (typeof MAP_THEMES)[number];
/** Exactly 'dark' or 'light': any other value, case or type is refused. */
export const mapThemeSchema = z.enum(MAP_THEMES);

/**
 * Each mode's map style (palettes from the Confirm board and client/src/theme.ts), the same 15 rules in the same
 * order, only the colors differ. Later rules override earlier ones. Dark: the ground just above the palette's ground,
 * roads a step lighter, labels in the line gray. Light: land in the light palette's raised gray, local roads its
 * ground and larger roads its white panel, labels in its line gray with text3 for towns, water a light gray-blue.
 * Both hide icons, points of interest (parks stay, as a tint) and transit.
 */
export const STATIC_MAP_STYLES: Readonly<Record<MapTheme, readonly string[]>> = {
  dark: [
    'feature:all|element:geometry|color:0x0e1216',
    'feature:all|element:labels.icon|visibility:off',
    'feature:all|element:labels.text.fill|color:0x7b8187',
    'feature:all|element:labels.text.stroke|color:0x080a0d',
    'feature:administrative|element:geometry|visibility:off',
    'feature:administrative.locality|element:labels.text.fill|color:0x9a9fa6',
    'feature:poi|visibility:off',
    'feature:poi.park|element:geometry|visibility:on|color:0x121a17',
    'feature:road|element:geometry.stroke|visibility:off',
    'feature:road.local|element:geometry.fill|color:0x1e2329',
    'feature:road.arterial|element:geometry.fill|color:0x2a3037',
    'feature:road.highway|element:geometry.fill|color:0x2a3037',
    'feature:transit|visibility:off',
    'feature:water|element:geometry|color:0x0b1820',
    'feature:water|element:labels.text.fill|color:0x34383e',
  ],
  light: [
    'feature:all|element:geometry|color:0xe9ecef',
    'feature:all|element:labels.icon|visibility:off',
    'feature:all|element:labels.text.fill|color:0x7a8088',
    'feature:all|element:labels.text.stroke|color:0xf5f6f8',
    'feature:administrative|element:geometry|visibility:off',
    'feature:administrative.locality|element:labels.text.fill|color:0x5d636b',
    'feature:poi|visibility:off',
    'feature:poi.park|element:geometry|visibility:on|color:0xdce8e1',
    'feature:road|element:geometry.stroke|visibility:off',
    'feature:road.local|element:geometry.fill|color:0xf5f6f8',
    'feature:road.arterial|element:geometry.fill|color:0xffffff',
    'feature:road.highway|element:geometry.fill|color:0xffffff',
    'feature:transit|visibility:off',
    'feature:water|element:geometry|color:0xd0dbe5',
    'feature:water|element:labels.text.fill|color:0x8d98a3',
  ],
};

/** The pin: each palette's mint (theme.palette.dark.mint, theme.palette.light.mint). */
export const STATIC_MAP_PIN: Readonly<Record<MapTheme, string>> = { dark: '0x7bd2b4', light: '0x136a53' };

export interface PlaceMap { url: string; width: typeof STATIC_MAP_WIDTH; height: typeof STATIC_MAP_HEIGHT }

export interface StaticMapSigner {
  /** The signed map of the place in the mode, centered on it with the mint pin. Pure: no network, no clock, nothing stored. */
  mapOf(placeId: string, theme: MapTheme): PlaceMap;
  /**
   * D29: the signed map of every place in the mode, a mint pin each: one place is exactly `mapOf`; several leave the
   * center and zoom to Google, which fits every pin. Throws on an empty list. Pure, as mapOf.
   */
  mapOfPlaces(placeIds: readonly string[], theme: MapTheme): PlaceMap;
  /**
   * D47: the same map with a lettered pin per place, A for the first id sent, so a legend beside it can name each one.
   * One place keeps `mapOf`'s center and zoom. Throws on an empty list or more than 26 ids. Pure, as mapOf.
   */
  mapOfLabeledPlaces(placeIds: readonly string[], theme: MapTheme): PlaceMap;
}

/** URL-safe base64 of 16 to 64 bytes, as Google issues it (28 characters today). Boot refuses anything else. */
export const signingSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{22,86}={0,2}$/, 'must be a URL-safe base64 signing secret');

/**
 * Google's URL signature of `pathAndQuery` (the URL without scheme and host): HMAC-SHA1 keyed by the secret decoded
 * from URL-safe base64, encoded as URL-safe base64 with its `=` padding, as Google's own samples keep it.
 */
export function signPath(pathAndQuery: string, secret: string): string {
  const key = Buffer.from(secret, 'base64url');
  return createHmac('sha1', key).update(pathAndQuery).digest('base64').replaceAll('+', '-').replaceAll('/', '_');
}

/**
 * The path and query, unsigned, in a fixed order whatever the mode: the mode changes only the pin's color and the
 * style rules' colors. URLSearchParams encodes `:` as %3A, `|` as %7C.
 */
export function staticMapPath(placeId: string, apiKey: string, theme: MapTheme): string {
  const pairs: [string, string][] = [
    ['center', `place_id:${placeId}`],
    ['zoom', '15'],
    ['size', `${String(STATIC_MAP_WIDTH)}x${String(STATIC_MAP_HEIGHT)}`],
    ['scale', '2'],
    ['format', 'jpg-baseline'],
    ['maptype', 'roadmap'],
    ['language', 'en'],
    ['region', 'us'],
    ['markers', `color:${STATIC_MAP_PIN[theme]}|place_id:${placeId}`],
    ...STATIC_MAP_STYLES[theme].map((rule): [string, string] => ['style', rule]),
    ['key', apiKey],
  ];
  return `${STATIC_MAP_PATH}?${new URLSearchParams(pairs).toString()}`;
}

/**
 * The path and query for every place: one place is `staticMapPath` unchanged; several send no `center` and no `zoom`
 * (Google then fits every marker) and one `markers` parameter with each id in the order given. 25 ids at the
 * 512-character maximum stay under Google's 16,384-character URL cap in either mode (both modes' rules are the same
 * length).
 */
export function staticMapPathOf(placeIds: readonly string[], apiKey: string, theme: MapTheme): string {
  const [first, ...rest] = placeIds;
  if (first === undefined) throw new Error('staticMapPathOf needs at least one place id');
  if (rest.length === 0) return staticMapPath(first, apiKey, theme);
  const pairs: [string, string][] = [
    ['size', `${String(STATIC_MAP_WIDTH)}x${String(STATIC_MAP_HEIGHT)}`],
    ['scale', '2'],
    ['format', 'jpg-baseline'],
    ['maptype', 'roadmap'],
    ['language', 'en'],
    ['region', 'us'],
    ['markers', [`color:${STATIC_MAP_PIN[theme]}`, ...placeIds.map((id) => `place_id:${id}`)].join('|')],
    ...STATIC_MAP_STYLES[theme].map((rule): [string, string] => ['style', rule]),
    ['key', apiKey],
  ];
  return `${STATIC_MAP_PATH}?${new URLSearchParams(pairs).toString()}`;
}

/** A pin's letter: A for the first place, up to Z, the letters Google draws on a pin. */
export function pinLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 25) throw new Error('a pin label is A to Z');
  return String.fromCharCode(65 + index);
}

/**
 * D47: the path and query with a lettered pin per place: one `markers` parameter per id, in the order given, each
 * `color|label|place_id`, since a `markers` parameter has one style. One place is centered at zoom 15 as `staticMapPath`;
 * several leave the center and zoom to Google. 25 ids at the 512-character maximum stay under Google's 16,384-character
 * URL cap in either mode (static-map.test.ts measures it).
 */
export function labeledMapPathOf(placeIds: readonly string[], apiKey: string, theme: MapTheme): string {
  if (placeIds.length === 0) throw new Error('labeledMapPathOf needs at least one place id');
  const [only] = placeIds.length === 1 ? placeIds : [];
  const pairs: [string, string][] = [
    ...(only === undefined ? [] : [['center', `place_id:${only}`], ['zoom', '15']] satisfies [string, string][]),
    ['size', `${String(STATIC_MAP_WIDTH)}x${String(STATIC_MAP_HEIGHT)}`],
    ['scale', '2'],
    ['format', 'jpg-baseline'],
    ['maptype', 'roadmap'],
    ['language', 'en'],
    ['region', 'us'],
    ...placeIds.map((id, i): [string, string] => ['markers', `color:${STATIC_MAP_PIN[theme]}|label:${pinLabel(i)}|place_id:${id}`]),
    ...STATIC_MAP_STYLES[theme].map((rule): [string, string] => ['style', rule]),
    ['key', apiKey],
  ];
  return `${STATIC_MAP_PATH}?${new URLSearchParams(pairs).toString()}`;
}

/** The string signed is exactly the string sent: built once, never re-encoded. */
export function createStaticMapSigner(apiKey: string, signingSecret: string): StaticMapSigner {
  const signed = (path: string): PlaceMap => ({
    url: `${STATIC_MAP_ORIGIN}${path}&signature=${signPath(path, signingSecret)}`,
    width: STATIC_MAP_WIDTH,
    height: STATIC_MAP_HEIGHT,
  });
  return {
    mapOf: (placeId, theme) => signed(staticMapPath(placeId, apiKey, theme)),
    mapOfPlaces: (placeIds, theme) => signed(staticMapPathOf(placeIds, apiKey, theme)),
    mapOfLabeledPlaces: (placeIds, theme) => signed(labeledMapPathOf(placeIds, apiKey, theme)),
  };
}
