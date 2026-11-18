// The confirm card's map URL (src/places/static-map.ts): Google's URL signature against known vectors, the exact
// request in each mode (dark and light), the signing secret's format, and the mode as the two routes' bodies take it
// (src/handlers/places.ts). Nothing here calls Google. Test secrets stay inline as call arguments (gitleaks flags a
// variable named like a secret holding a random-looking value).
import { AppError } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { TownwiseContext } from '../src/app.ts';
import { placesDetails, placesMap } from '../src/handlers/places.ts';
import type { PlacesClient } from '../src/places/google.ts';
import {
  createStaticMapSigner, labeledMapPathOf, mapThemeSchema, pinLabel, signingSecretSchema, signPath, STATIC_MAP_PIN,
  STATIC_MAP_STYLES, staticMapPath, staticMapPathOf, type StaticMapSigner,
} from '../src/places/static-map.ts';

const KEY = 'test-static-key';
const PLACE_ID = 'ChIJTestPlace0001';

/** The light rules, written out: the test pins each value, not the module's list. */
const LIGHT_RULES = [
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
];

/** 25 distinct ids at the 512-character maximum: the longest body POST /api/places/map takes. */
const LONGEST_IDS = Array.from({ length: 25 }, (_, i) => `${String.fromCharCode(65 + i)}${'a'.repeat(511)}`);

function paramsOf(path: string): string[][] {
  return [...new URLSearchParams(path.slice(path.indexOf('?') + 1))];
}

describe('signPath', () => {
  it('matches the vector in Google’s URL signing guide', () => {
    expect(signPath('/maps/api/geocode/json?address=New+York&client=clientID', 'vNIXE0xscrmjlyV-12Nj_BvUPaw='))
      .toBe('chaRF2hTJKOScPr-RQCEhZbSzIE=');
  });

  it('matches the Townwise map fixtures, signed independently with Python’s hmac over 20 zero bytes', () => {
    // The dark vector is the one from before light mode: a client that sends no mode gets the very same URL.
    expect(signPath(staticMapPath(PLACE_ID, KEY, 'dark'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe('yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=');
    expect(signPath(staticMapPath(PLACE_ID, KEY, 'light'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe('jpPbpMUoT-SRVwLsHO3DlixjtEI=');
  });

  it('uses the URL-safe alphabet: never + or /', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(signPath(`/maps/api/staticmap?center=place_id%3A${String(i)}`, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toMatch(/^[A-Za-z0-9_-]{27}=$/);
    }
  });
});

describe('staticMapPath', () => {
  it('asks for a 2:1 dark roadmap centered on the place, with the mint pin and the static key, in a fixed order', () => {
    const path = staticMapPath(PLACE_ID, KEY, 'dark');
    expect(path.startsWith('/maps/api/staticmap?')).toBe(true);
    expect(paramsOf(path)).toEqual([
      ['center', `place_id:${PLACE_ID}`],
      ['zoom', '15'],
      ['size', '640x320'],
      ['scale', '2'],
      ['format', 'jpg-baseline'],
      ['maptype', 'roadmap'],
      ['language', 'en'],
      ['region', 'us'],
      ['markers', `color:0x7bd2b4|place_id:${PLACE_ID}`],
      ...STATIC_MAP_STYLES.dark.map((rule) => ['style', rule]),
      ['key', KEY],
    ]);
    expect(STATIC_MAP_STYLES.dark).toHaveLength(15);
    expect(path).toContain('center=place_id%3AChIJTestPlace0001&zoom=15&');
    expect(path).toContain('markers=color%3A0x7bd2b4%7Cplace_id%3AChIJTestPlace0001&');
  });

  it('asks for the light roadmap with the same parameters in the same order: the light mint pin and the light rules', () => {
    const path = staticMapPath(PLACE_ID, KEY, 'light');
    expect(path.startsWith('/maps/api/staticmap?')).toBe(true);
    expect(paramsOf(path)).toEqual([
      ['center', `place_id:${PLACE_ID}`],
      ['zoom', '15'],
      ['size', '640x320'],
      ['scale', '2'],
      ['format', 'jpg-baseline'],
      ['maptype', 'roadmap'],
      ['language', 'en'],
      ['region', 'us'],
      ['markers', `color:0x136a53|place_id:${PLACE_ID}`],
      ...LIGHT_RULES.map((rule) => ['style', rule]),
      ['key', KEY],
    ]);
    expect(path).toContain('markers=color%3A0x136a53%7Cplace_id%3AChIJTestPlace0001&');
    expect(path.endsWith('&style=feature%3Awater%7Celement%3Alabels.text.fill%7Ccolor%3A0x8d98a3&key=test-static-key')).toBe(true);
  });

  it('the two modes differ only in colors: the same rules for the same features, in the same order, at the same length', () => {
    const shape = (rules: readonly string[]): string[] => rules.map((rule) => rule.replace(/0x[0-9a-f]{6}/g, 'COLOR'));
    expect(shape(STATIC_MAP_STYLES.light)).toEqual(shape(STATIC_MAP_STYLES.dark));
    expect(STATIC_MAP_STYLES.light).toEqual(LIGHT_RULES);
    expect(STATIC_MAP_PIN).toEqual({ dark: '0x7bd2b4', light: '0x136a53' });
    // Points of interest stay hidden in both: only parks show, as a tint.
    for (const rules of [STATIC_MAP_STYLES.dark, STATIC_MAP_STYLES.light]) {
      expect(rules).toContain('feature:poi|visibility:off');
      expect(rules).toContain('feature:transit|visibility:off');
      expect(rules).toContain('feature:all|element:labels.icon|visibility:off');
    }
    expect(staticMapPath(PLACE_ID, KEY, 'light')).toHaveLength(staticMapPath(PLACE_ID, KEY, 'dark').length);
  });

  it('sends a place id with - and _ unchanged', () => {
    expect(staticMapPath('ChIJ-Test_Place-01', KEY, 'dark')).toContain('center=place_id%3AChIJ-Test_Place-01&');
    expect(staticMapPath('ChIJ-Test_Place-01', KEY, 'light')).toContain('center=place_id%3AChIJ-Test_Place-01&');
  });
});

describe('createStaticMapSigner', () => {
  it('returns the signed URL on maps.googleapis.com at 640 by 320, signing exactly the path and query it sends', () => {
    const signer = createStaticMapSigner(KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    for (const [theme, signature] of [['dark', 'yLf7UY5VigCJ9Tc0GyjJzgV7Dbs='], ['light', 'jpPbpMUoT-SRVwLsHO3DlixjtEI=']] as const) {
      const map = signer.mapOf(PLACE_ID, theme);
      expect(map).toEqual({
        url: `https://maps.googleapis.com${staticMapPath(PLACE_ID, KEY, theme)}&signature=${signature}`,
        width: 640,
        height: 320,
      });
      // The URL parser (what the browser does) changes nothing, so Google checks the very bytes that were signed.
      const parsed = new URL(map.url);
      expect(parsed.origin).toBe('https://maps.googleapis.com');
      expect(parsed.pathname + parsed.search).toBe(`${staticMapPath(PLACE_ID, KEY, theme)}&signature=${signature}`);
      expect(parsed.searchParams.getAll('signature')).toEqual([signature]);
      expect(map.url.length).toBeLessThan(16_384);
    }
  });

  it('is never unsigned: the signature is the last parameter of every URL, and differs per place and per mode', () => {
    const signer = createStaticMapSigner(KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    const first = new URL(signer.mapOf(PLACE_ID, 'dark').url);
    const second = new URL(signer.mapOf('ChIJTestPlace0002', 'dark').url);
    const light = new URL(signer.mapOf(PLACE_ID, 'light').url);
    expect([...first.searchParams.keys()].at(-1)).toBe('signature');
    expect([...light.searchParams.keys()].at(-1)).toBe('signature');
    expect(first.searchParams.get('signature')).not.toBe(second.searchParams.get('signature'));
    expect(first.searchParams.get('signature')).not.toBe(light.searchParams.get('signature'));
  });

  it('a place id at the 512-character maximum still makes a URL under Google’s 16,384-character cap', () => {
    for (const theme of ['dark', 'light'] as const) {
      const map = createStaticMapSigner(KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=').mapOf('A'.repeat(512), theme);
      expect(map.url.length).toBeLessThan(4096);
    }
  });
});

describe('the map of several places (D29)', () => {
  const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  it('mapOfPlaces with one id is exactly mapOf: centered, zoom 15, one mint pin, in either mode', () => {
    const signer = createStaticMapSigner(KEY, SECRET);
    for (const theme of ['dark', 'light'] as const) {
      expect(staticMapPathOf([PLACE_ID], KEY, theme)).toBe(staticMapPath(PLACE_ID, KEY, theme));
      expect(signer.mapOfPlaces([PLACE_ID], theme)).toEqual(signer.mapOf(PLACE_ID, theme));
    }
    expect(signer.mapOfPlaces([PLACE_ID], 'dark').url).toBe(
      `https://maps.googleapis.com${staticMapPath(PLACE_ID, KEY, 'dark')}&signature=yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=`,
    );
    expect(signer.mapOfPlaces([PLACE_ID], 'light').url).toBe(
      `https://maps.googleapis.com${staticMapPath(PLACE_ID, KEY, 'light')}&signature=jpPbpMUoT-SRVwLsHO3DlixjtEI=`,
    );
  });

  it('several ids send no center or zoom, one markers parameter with every id in the order given, and the signature last', () => {
    const ids = ['ChIJTestPlace0003', 'ChIJTestPlace0001', 'ChIJTestPlace0002'];
    const pins = 'place_id:ChIJTestPlace0003|place_id:ChIJTestPlace0001|place_id:ChIJTestPlace0002';
    for (const [theme, pin, rules] of [['dark', '0x7bd2b4', STATIC_MAP_STYLES.dark], ['light', '0x136a53', LIGHT_RULES]] as const) {
      const path = staticMapPathOf(ids, KEY, theme);
      expect(path.startsWith('/maps/api/staticmap?')).toBe(true);
      expect(paramsOf(path)).toEqual([
        ['size', '640x320'],
        ['scale', '2'],
        ['format', 'jpg-baseline'],
        ['maptype', 'roadmap'],
        ['language', 'en'],
        ['region', 'us'],
        ['markers', `color:${pin}|${pins}`],
        ...rules.map((rule) => ['style', rule]),
        ['key', KEY],
      ]);
      const map = createStaticMapSigner(KEY, SECRET).mapOfPlaces(ids, theme);
      expect(map).toEqual({ url: `https://maps.googleapis.com${path}&signature=${signPath(path, SECRET)}`, width: 640, height: 320 });
      const parsed = new URL(map.url);
      expect(parsed.pathname + parsed.search).toBe(`${path}&signature=${signPath(path, SECRET)}`);
      expect([...parsed.searchParams.keys()].at(-1)).toBe('signature');
      expect(parsed.searchParams.getAll('markers')).toHaveLength(1);
    }
    expect(createStaticMapSigner(KEY, SECRET).mapOfPlaces(ids, 'light').url)
      .not.toBe(createStaticMapSigner(KEY, SECRET).mapOfPlaces(ids, 'dark').url);
  });

  it('25 place ids at the 512-character maximum still make a URL under Google’s 16,384-character cap, in either mode', () => {
    const signer = createStaticMapSigner(KEY, SECRET);
    const dark = signer.mapOfPlaces(LONGEST_IDS, 'dark');
    const light = signer.mapOfPlaces(LONGEST_IDS, 'light');
    for (const map of [dark, light]) {
      expect(new URL(map.url).searchParams.get('markers')?.split('|')).toHaveLength(26);
      expect(map.url.length).toBeLessThan(16_384);
    }
    // The worst case, worked out: the same length in both modes. 47 (origin and path) + 79 (size to region) + 13,175
    // (markers: the pin and 25 encoded ids) + 1,006 (15 style rules) + 19 (this 15-character key) + 39 (signature).
    // Google's keys are 39 characters, 24 more: 14,389 in production, about 2,000 under the cap.
    expect(light.url.length).toBe(dark.url.length);
    expect(light.url.length).toBe(14_365);
  });

  it('an empty list throws', () => {
    expect(() => staticMapPathOf([], KEY, 'dark')).toThrow();
    expect(() => createStaticMapSigner(KEY, SECRET).mapOfPlaces([], 'light')).toThrow();
  });
});

describe('the labeled map of every location (D47)', () => {
  const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const IDS = ['ChIJTestPlace0003', 'ChIJTestPlace0001', 'ChIJTestPlace0002'];

  it('sends one markers parameter per place, lettered A, B, C in the order given, with no center or zoom', () => {
    for (const [theme, pin, rules] of [['dark', '0x7bd2b4', STATIC_MAP_STYLES.dark], ['light', '0x136a53', LIGHT_RULES]] as const) {
      const path = labeledMapPathOf(IDS, KEY, theme);
      expect(paramsOf(path)).toEqual([
        ['size', '640x320'],
        ['scale', '2'],
        ['format', 'jpg-baseline'],
        ['maptype', 'roadmap'],
        ['language', 'en'],
        ['region', 'us'],
        ['markers', `color:${pin}|label:A|place_id:ChIJTestPlace0003`],
        ['markers', `color:${pin}|label:B|place_id:ChIJTestPlace0001`],
        ['markers', `color:${pin}|label:C|place_id:ChIJTestPlace0002`],
        ...rules.map((rule) => ['style', rule]),
        ['key', KEY],
      ]);
      const map = createStaticMapSigner(KEY, SECRET).mapOfLabeledPlaces(IDS, theme);
      expect(map).toEqual({ url: `https://maps.googleapis.com${path}&signature=${signPath(path, SECRET)}`, width: 640, height: 320 });
      expect([...new URL(map.url).searchParams.keys()].at(-1)).toBe('signature');
    }
  });

  it('one place keeps the center and zoom 15, with its pin lettered A', () => {
    expect(paramsOf(labeledMapPathOf([PLACE_ID], KEY, 'dark')).slice(0, 3)).toEqual([
      ['center', `place_id:${PLACE_ID}`], ['zoom', '15'], ['size', '640x320'],
    ]);
    expect(new URL(createStaticMapSigner(KEY, SECRET).mapOfLabeledPlaces([PLACE_ID], 'light').url).searchParams.getAll('markers'))
      .toEqual([`color:0x136a53|label:A|place_id:${PLACE_ID}`]);
  });

  it('25 place ids at the 512-character maximum stay under Google’s 16,384-character cap, in either mode', () => {
    const signer = createStaticMapSigner(KEY, SECRET);
    const dark = signer.mapOfLabeledPlaces(LONGEST_IDS, 'dark');
    const light = signer.mapOfLabeledPlaces(LONGEST_IDS, 'light');
    expect(new URL(dark.url).searchParams.getAll('markers').map((m) => m.split('|')[1])).toEqual(LONGEST_IDS.map((_, i) => `label:${pinLabel(i)}`));
    expect(light.url.length).toBe(dark.url.length);
    // The plain map's worst case (14,365) plus 900: each of the 24 markers after the first adds `&markers=` and its own
    // color and label, and the first its label. Google's 39-character key adds 24: 15,289 in production, under the cap.
    expect(dark.url.length).toBe(15_265);
  });

  it('letters run A to Z; an empty list throws', () => {
    expect([pinLabel(0), pinLabel(1), pinLabel(25)]).toEqual(['A', 'B', 'Z']);
    expect(() => pinLabel(26)).toThrow();
    expect(() => pinLabel(-1)).toThrow();
    expect(() => labeledMapPathOf([], KEY, 'dark')).toThrow();
  });
});

describe('the mode (mapThemeSchema)', () => {
  it('takes dark or light exactly, and refuses anything else', () => {
    expect(mapThemeSchema.parse('dark')).toBe('dark');
    expect(mapThemeSchema.parse('light')).toBe('light');
    for (const value of ['Light', 'DARK', ' light', 'sepia', 'system', '', null, undefined, 42, true, ['light'], { theme: 'light' }]) {
      expect({ value, success: mapThemeSchema.safeParse(value).success }).toEqual({ value, success: false });
    }
  });
});

describe('the routes read the mode from the body (handlers/places.ts)', () => {
  const signer = createStaticMapSigner(KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  const NEWER_ID = 'ChIJTestPlace0009';

  /** The handler's answer for a body, with the signer on and Google's details answering NEWER_ID. */
  async function answer(handler: typeof placesMap, body: unknown, placesMapOn: StaticMapSigner | null = signer): Promise<unknown> {
    const places: PlacesClient = {
      autocomplete: () => Promise.reject(new Error('not called')),
      details: (placeId) => Promise.resolve({ placeId: placeId === PLACE_ID ? NEWER_ID : placeId, formattedAddress: '', addressComponents: [] }),
      locate: () => Promise.reject(new Error('not called')),
    };
    const ctx = { places, placesMap: placesMapOn, logger: { warn: () => undefined } } as unknown as TownwiseContext;
    let sent: unknown;
    const res = { status: () => res, json: (value: unknown) => { sent = value; return res; } } as unknown as Response;
    await handler(ctx, { body } as Request, res);
    return sent;
  }

  async function refusalOf(handler: typeof placesMap, body: unknown): Promise<unknown> {
    try {
      await answer(handler, body);
    } catch (err) {
      return err instanceof AppError ? { status: err.status, code: err.code } : err;
    }
    return 'answered';
  }

  it('POST /api/places/map: no mode is dark, as before light mode; light and dark sign their own map', async () => {
    const ids = [PLACE_ID, 'ChIJTestPlace0002'];
    expect(await answer(placesMap, { placeIds: ids })).toEqual({ map: signer.mapOfPlaces(ids, 'dark') });
    expect(await answer(placesMap, { placeIds: ids, theme: 'dark' })).toEqual({ map: signer.mapOfPlaces(ids, 'dark') });
    expect(await answer(placesMap, { placeIds: ids, theme: 'light' })).toEqual({ map: signer.mapOfPlaces(ids, 'light') });
    expect(await answer(placesMap, { placeIds: ids, theme: 'light' }, null)).toEqual({ map: null });
  });

  it('POST /api/places/details: the map of Google’s current id in the mode sent, dark with none', async () => {
    const place = (theme: 'dark' | 'light'): unknown => ({ place: { placeId: NEWER_ID, address: '', town: null, map: signer.mapOf(NEWER_ID, theme) } });
    expect(await answer(placesDetails, { placeId: PLACE_ID })).toEqual(place('dark'));
    expect(await answer(placesDetails, { placeId: PLACE_ID, theme: 'dark' })).toEqual(place('dark'));
    expect(await answer(placesDetails, { placeId: PLACE_ID, theme: 'light' })).toEqual(place('light'));
  });

  it('any other mode is 400 invalid_request on either route', async () => {
    for (const theme of ['Light', 'sepia', '', null, 1, ['light']]) {
      expect({ theme, refused: await refusalOf(placesMap, { placeIds: [PLACE_ID], theme }) })
        .toEqual({ theme, refused: { status: 400, code: 'invalid_request' } });
      expect({ theme, refused: await refusalOf(placesDetails, { placeId: PLACE_ID, theme }) })
        .toEqual({ theme, refused: { status: 400, code: 'invalid_request' } });
    }
  });
});

describe('signingSecretSchema', () => {
  it('accepts URL-safe base64 of 16 to 64 bytes', () => {
    for (const value of ['AAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'A'.repeat(22), 'A'.repeat(86), 'AAAAAAAAAAAAAAAAAAAAAA-_AA=']) {
      expect(signingSecretSchema.safeParse(value).success).toBe(true);
    }
  });

  it('refuses anything else, and its message never quotes the value', () => {
    const refused = ['', 'AAAAAAAAAAAAAAAAAAAAAAA+AAA=', 'AAAAAAAAAAAAAAAAAAAAAAA/AAA=', 'AAAAAAAAAAAA AAAAAAAAAAAAAA=', 'A'.repeat(21), 'A'.repeat(90), 'AAAAAAAAAAAAAAAAAAAAAAAAAA==='];
    for (const value of refused) {
      const parsed = z.object({ GOOGLE_MAPS_SIGNING_SECRET: signingSecretSchema }).safeParse({ GOOGLE_MAPS_SIGNING_SECRET: value });
      expect({ value, success: parsed.success }).toEqual({ value, success: false });
      if (value !== '') expect(JSON.stringify(parsed.error?.issues)).not.toContain(value);
    }
  });
});
