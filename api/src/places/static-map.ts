// The map on the access request's confirm card: a Google Maps Static API URL, signed here and loaded by the browser
// (and the native Image) straight from maps.googleapis.com. The API never fetches, relays or stores the image.
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

/** The dark Townwise map (palette from the Confirm board and client/src/theme.ts). Later rules override earlier ones. */
export const STATIC_MAP_STYLES: readonly string[] = [
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
];

export interface PlaceMap { url: string; width: typeof STATIC_MAP_WIDTH; height: typeof STATIC_MAP_HEIGHT }

export interface StaticMapSigner {
  /** The signed map of the place, centred on it with the mint pin. Pure: no network, no clock, nothing stored. */
  mapOf(placeId: string): PlaceMap;
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

/** The path and query, unsigned, in a fixed order. URLSearchParams encodes `:` as %3A, `|` as %7C. */
export function staticMapPath(placeId: string, apiKey: string): string {
  const pairs: [string, string][] = [
    ['center', `place_id:${placeId}`],
    ['zoom', '15'],
    ['size', `${String(STATIC_MAP_WIDTH)}x${String(STATIC_MAP_HEIGHT)}`],
    ['scale', '2'],
    ['format', 'jpg-baseline'],
    ['maptype', 'roadmap'],
    ['language', 'en'],
    ['region', 'us'],
    ['markers', `color:0x7bd2b4|place_id:${placeId}`],
    ...STATIC_MAP_STYLES.map((rule): [string, string] => ['style', rule]),
    ['key', apiKey],
  ];
  return `${STATIC_MAP_PATH}?${new URLSearchParams(pairs).toString()}`;
}

/** The string signed is exactly the string sent: built once, never re-encoded. */
export function createStaticMapSigner(apiKey: string, signingSecret: string): StaticMapSigner {
  return {
    mapOf(placeId) {
      const path = staticMapPath(placeId, apiKey);
      return {
        url: `${STATIC_MAP_ORIGIN}${path}&signature=${signPath(path, signingSecret)}`,
        width: STATIC_MAP_WIDTH,
        height: STATIC_MAP_HEIGHT,
      };
    },
  };
}
