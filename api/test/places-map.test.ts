// The confirm card's map URL (src/places/static-map.ts): Google's URL signature against known vectors, the exact
// request, and the signing secret's format. Nothing here calls Google. Test secrets stay inline as call arguments
// (gitleaks flags a variable named like a secret holding a random-looking value).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createStaticMapSigner, signingSecretSchema, signPath, STATIC_MAP_STYLES, staticMapPath,
} from '../src/places/static-map.ts';

const KEY = 'test-static-key';
const PLACE_ID = 'ChIJTestPlace0001';

describe('signPath', () => {
  it('matches the vector in Google’s URL signing guide', () => {
    expect(signPath('/maps/api/geocode/json?address=New+York&client=clientID', 'vNIXE0xscrmjlyV-12Nj_BvUPaw='))
      .toBe('chaRF2hTJKOScPr-RQCEhZbSzIE=');
  });

  it('matches the Townwise map fixture, signed independently with Python’s hmac over 20 zero bytes', () => {
    expect(signPath(staticMapPath(PLACE_ID, KEY), 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe('yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=');
  });

  it('uses the URL-safe alphabet: never + or /', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(signPath(`/maps/api/staticmap?center=place_id%3A${String(i)}`, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toMatch(/^[A-Za-z0-9_-]{27}=$/);
    }
  });
});

describe('staticMapPath', () => {
  it('asks for a 2:1 dark roadmap centred on the place, with the mint pin and the static key, in a fixed order', () => {
    const path = staticMapPath(PLACE_ID, KEY);
    expect(path.startsWith('/maps/api/staticmap?')).toBe(true);
    expect([...new URLSearchParams(path.slice(path.indexOf('?') + 1))]).toEqual([
      ['center', `place_id:${PLACE_ID}`],
      ['zoom', '15'],
      ['size', '640x320'],
      ['scale', '2'],
      ['format', 'jpg-baseline'],
      ['maptype', 'roadmap'],
      ['language', 'en'],
      ['region', 'us'],
      ['markers', `color:0x7bd2b4|place_id:${PLACE_ID}`],
      ...STATIC_MAP_STYLES.map((rule) => ['style', rule]),
      ['key', KEY],
    ]);
    expect(STATIC_MAP_STYLES).toHaveLength(15);
    expect(path).toContain('center=place_id%3AChIJTestPlace0001&zoom=15&');
    expect(path).toContain('markers=color%3A0x7bd2b4%7Cplace_id%3AChIJTestPlace0001&');
  });

  it('sends a place id with - and _ unchanged', () => {
    expect(staticMapPath('ChIJ-Test_Place-01', KEY)).toContain('center=place_id%3AChIJ-Test_Place-01&');
  });
});

describe('createStaticMapSigner', () => {
  it('returns the signed URL on maps.googleapis.com at 640 by 320, signing exactly the path and query it sends', () => {
    const map = createStaticMapSigner(KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=').mapOf(PLACE_ID);
    expect(map).toEqual({
      url: `https://maps.googleapis.com${staticMapPath(PLACE_ID, KEY)}&signature=yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=`,
      width: 640,
      height: 320,
    });
    // The URL parser (what the browser does) changes nothing, so Google checks the very bytes that were signed.
    const parsed = new URL(map.url);
    expect(parsed.origin).toBe('https://maps.googleapis.com');
    expect(parsed.pathname + parsed.search).toBe(`${staticMapPath(PLACE_ID, KEY)}&signature=yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=`);
    expect(parsed.searchParams.getAll('signature')).toEqual(['yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=']);
    expect(map.url.length).toBeLessThan(16_384);
  });

  it('is never unsigned: the signature is the last parameter of every URL, and differs per place', () => {
    const signer = createStaticMapSigner(KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    const first = new URL(signer.mapOf(PLACE_ID).url);
    const second = new URL(signer.mapOf('ChIJTestPlace0002').url);
    expect([...first.searchParams.keys()].at(-1)).toBe('signature');
    expect(first.searchParams.get('signature')).not.toBe(second.searchParams.get('signature'));
  });

  it('a place id at the 512-character maximum still makes a URL under Google’s 16,384-character cap', () => {
    const map = createStaticMapSigner(KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=').mapOf('A'.repeat(512));
    expect(map.url.length).toBeLessThan(4096);
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
