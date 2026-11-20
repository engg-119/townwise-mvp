// D66's competitors (src/research/competitors.ts, design decision 10): which nearby places are a location's
// competitors, how they are numbered for a request, the server-side name match, and the research runner's Places ports
// (src/research/places.ts). Made-up places and points; tests never call Google.
import { describe, expect, it } from 'vitest';

import { PlacesUnavailableError, type NearbyPlace, type PlacesClient } from '../src/places/google.ts';
import {
  COMPETITOR_RADIUS_M, competitorInputs, distanceM, matchCompetitor, pickCompetitors, placesByN, typeFamily,
} from '../src/research/competitors.ts';
import { createResearchPlaces } from '../src/research/places.ts';

const CENTER = { lat: 43.7, lng: -72.29 };
const OWN = 'ChIJFixtureOwnPlace';
/** About 111 meters a thousandth of a degree of latitude. */
const north = (meters: number) => ({ lat: CENTER.lat + meters / 111_195, lng: CENTER.lng });

function place(id: string, primaryType: string | null, meters: number, extra: Partial<NearbyPlace> = {}): NearbyPlace {
  return { placeId: id, name: `Fixture ${id}`, primaryType, ...north(meters), website: null, ...extra };
}

describe('typeFamily', () => {
  it('groups specific primary types into restaurants, bars and cafes', () => {
    expect(['restaurant', 'american_restaurant', 'fast_food_restaurant', 'diner', 'steak_house', 'sandwich_shop', 'snack_bar'].map(typeFamily))
      .toEqual(Array(7).fill('restaurant'));
    expect(['bar', 'pub', 'wine_bar', 'cocktail_bar', 'irish_pub', 'brewpub', 'night_club'].map(typeFamily)).toEqual(Array(7).fill('bar'));
    expect(['cafe', 'coffee_shop', 'bakery', 'tea_house', 'ice_cream_shop', 'cat_cafe'].map(typeFamily)).toEqual(Array(6).fill('cafe'));
  });

  it('is null for a place that is not food or drink, and for none', () => {
    expect(['book_store', 'community_center', 'internet_cafe', 'gas_station', 'lodging'].map(typeFamily)).toEqual(Array(5).fill(null));
    expect(typeFamily(null)).toBeNull();
  });
});

describe('distanceM', () => {
  it('measures great-circle meters', () => {
    expect(distanceM(CENTER, CENTER)).toBe(0);
    expect(distanceM(CENTER, north(1_000))).toBeCloseTo(1_000, 0);
  });
});

describe('pickCompetitors', () => {
  it('drops the location’s own place, even answered first', () => {
    const picked = pickCompetitors({ ownPlaceId: OWN, center: CENTER, places: [place(OWN, 'american_restaurant', 0), place('ChIJFixture00001', 'pizza_restaurant', 200)] });
    expect(picked.map((each) => each.placeId)).toEqual(['ChIJFixture00001']);
  });

  it('drops places whose primary type is not food or drink, and places past 1,500 m', () => {
    const picked = pickCompetitors({
      ownPlaceId: OWN, center: CENTER,
      places: [
        place('ChIJFixtureBooks', 'book_store', 50), place('ChIJFixtureNoType', null, 60), place('ChIJFixtureNear', 'cafe', 1_400),
        place('ChIJFixtureFar', 'cafe', COMPETITOR_RADIUS_M + 50),
      ],
    });
    expect(picked.map((each) => each.placeId)).toEqual(['ChIJFixtureNear']);
  });

  it('puts the location’s own family first, then the nearest, at most 8, numbered from 1', () => {
    const places = [
      place(OWN, 'wine_bar', 0),
      ...Array.from({ length: 6 }, (_unused, i) => place(`ChIJFixtureCafe0${String(i)}`, 'coffee_shop', 100 + i * 10)),
      place('ChIJFixtureBarFar', 'pub', 900),
      place('ChIJFixtureBarNear', 'cocktail_bar', 700),
      place('ChIJFixtureDiner', 'diner', 145),
      place('ChIJFixtureBakery', 'bakery', 1_000),
    ];
    const picked = pickCompetitors({ ownPlaceId: OWN, center: CENTER, places });
    expect(picked).toHaveLength(8);
    expect(picked.map((each) => each.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(picked.map((each) => each.placeId)).toEqual([
      'ChIJFixtureBarNear', 'ChIJFixtureBarFar', 'ChIJFixtureCafe00', 'ChIJFixtureCafe01', 'ChIJFixtureCafe02', 'ChIJFixtureCafe03',
      'ChIJFixtureCafe04', 'ChIJFixtureDiner',
    ]);
  });

  it('ranks by distance alone when its own place is not in the answer', () => {
    const picked = pickCompetitors({ ownPlaceId: OWN, center: CENTER, places: [place('ChIJFixtureBar', 'bar', 300), place('ChIJFixtureCafe', 'cafe', 100)] });
    expect(picked.map((each) => each.placeId)).toEqual(['ChIJFixtureCafe', 'ChIJFixtureBar']);
  });

  it('lists each competitor once for a request, as n, name, type and website', () => {
    const picked = pickCompetitors({
      ownPlaceId: OWN, center: CENTER,
      places: [place('ChIJFixtureTavern', 'bar', 100, { website: 'https://tavern.example.com/' }), place('ChIJFixtureTavern', 'bar', 100)],
    });
    expect(competitorInputs(picked)).toEqual([{ n: 1, name: 'Fixture ChIJFixtureTavern', type: 'bar', website: 'https://tavern.example.com/' }]);
  });
});

describe('placesByN', () => {
  it('numbers a kept list from 1, and is null for none', () => {
    expect(placesByN(['ChIJFixtureA0001', 'ChIJFixtureB0001'])).toEqual(new Map([[1, 'ChIJFixtureA0001'], [2, 'ChIJFixtureB0001']]));
    expect(placesByN([])).toBeNull();
    expect(placesByN(undefined)).toBeNull();
  });
});

describe('matchCompetitor (the server-side name match)', () => {
  const live = [{ placeId: 'ChIJFixtureTavern', name: 'The Fixture Tavern' }, { placeId: 'ChIJFixtureDiner', name: 'Fixture Diner, LLC' }];

  it('matches a stored place id that is still listed first', () => {
    expect(matchCompetitor({ placeId: 'ChIJFixtureDiner', nameKey: 'fixture tavern' }, live)).toBe('ChIJFixtureDiner');
  });

  it('else matches the business entity’s nameKey against each live display name’s', () => {
    expect(matchCompetitor({ placeId: null, nameKey: 'fixture tavern' }, live)).toBe('ChIJFixtureTavern');
    expect(matchCompetitor({ placeId: 'ChIJFixtureGone', nameKey: 'fixture diner' }, live)).toBe('ChIJFixtureDiner');
  });

  it('is null for no match, an empty key, or no key', () => {
    expect(matchCompetitor({ placeId: null, nameKey: 'another place' }, live)).toBeNull();
    expect(matchCompetitor({ placeId: null, nameKey: '' }, live)).toBeNull();
    expect(matchCompetitor({ placeId: null, nameKey: null }, live)).toBeNull();
  });
});

describe('createResearchPlaces (the runner’s Places ports)', () => {
  function ports(over: Partial<PlacesClient>, point: { lat: number; lng: number } | null = CENTER) {
    const asked: unknown[] = [];
    const warnings: unknown[] = [];
    const places: PlacesClient = {
      autocomplete: () => Promise.reject(new Error('not called')),
      details: () => Promise.reject(new Error('not called')),
      locate: () => Promise.reject(new Error('not called')),
      nearby: (center, opts) => { asked.push({ center, opts }); return Promise.resolve([place('ChIJFixtureCafe', 'cafe', 100)]); },
      profile: (placeId) => Promise.resolve({ placeId, name: 'Fixture Google Bistro', address: '1 Fixture Lane' }),
      ...over,
    };
    const made = createResearchPlaces({
      places, pointOf: () => Promise.resolve(point), logger: { warn: (fields: unknown) => { warnings.push(fields); } } as never,
    });
    return { made, asked, warnings };
  }

  it('answers the profile’s name and address', async () => {
    expect(await ports({}).made.profile(OWN)).toEqual({ name: 'Fixture Google Bistro', address: '1 Fixture Lane' });
  });

  it('asks Nearby Search around the place’s point within 1,500 m with websites, and picks from its answer', async () => {
    const { made, asked } = ports({});
    expect((await made.competitors(OWN))?.map((each) => each.placeId)).toEqual(['ChIJFixtureCafe']);
    expect(asked).toEqual([{ center: CENTER, opts: { radiusM: 1500, withWebsite: true } }]);
  });

  it('answers null without the place’s point, asking Google nothing', async () => {
    const { made, asked } = ports({}, null);
    expect(await made.competitors(OWN)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('answers null when Google fails, logging its code only', async () => {
    const failing = () => Promise.reject(new PlacesUnavailableError('upstream_status', { status: 503 }));
    const { made, warnings } = ports({ profile: failing, nearby: failing });
    expect(await made.profile(OWN)).toBeNull();
    expect(await made.competitors(OWN)).toBeNull();
    expect(warnings).toEqual([
      { call: 'profile', code: 'upstream_status', status: 503, errType: null },
      { call: 'nearby', code: 'upstream_status', status: 503, errType: null },
    ]);
  });

  it('lets any other error through', async () => {
    await expect(ports({ profile: () => Promise.reject(new Error('bug')) }).made.profile(OWN)).rejects.toThrow('bug');
  });
});
