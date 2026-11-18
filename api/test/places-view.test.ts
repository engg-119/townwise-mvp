// D47 (Settings' map hover): the view Townwise sets for a lettered map (src/places/view.ts) and its signed URL
// (viewMapPath in src/places/static-map.ts). The positions must be where Google draws each pin, so they are checked
// against Web Mercator worked out here independently. Nothing calls Google.
import { describe, expect, it } from 'vitest';

import { createStaticMapSigner, signPath, STATIC_MAP_STYLES, viewMapPath } from '../src/places/static-map.ts';
import { fitView, MAX_VIEW_ZOOM, VIEW_PADDING, type LatLng } from '../src/places/view.ts';

const HANOVER = { lat: 43.7022, lng: -72.2896 };
const LEBANON = { lat: 43.6426, lng: -72.2517 };
const NORWICH = { lat: 43.7151, lng: -72.3076 };
const BURLINGTON = { lat: 44.4759, lng: -73.2121 };

/** Google's documented Web Mercator, written out on its own: pixel at zoom z = world * 2^z. */
function pixel(point: LatLng, zoom: number): { x: number; y: number } {
  const siny = Math.sin((point.lat * Math.PI) / 180);
  const scale = 256 * 2 ** zoom;
  return { x: scale * (0.5 + point.lng / 360), y: scale * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) };
}

/** Where Google draws `point` on a width by height image centered on `center` at `zoom`, as fractions. */
function drawnAt(point: LatLng, center: LatLng, zoom: number, width = 640, height = 320): { x: number; y: number } {
  const p = pixel(point, zoom);
  const c = pixel(center, zoom);
  return { x: (width / 2 + p.x - c.x) / width, y: (height / 2 + p.y - c.y) / height };
}

describe('fitView', () => {
  it('one place is at zoom 15, just below the middle so its pin head fits', () => {
    const view = fitView([HANOVER], 640, 320);
    expect(view.zoom).toBe(MAX_VIEW_ZOOM);
    expect(view.positions[0]?.x).toBeCloseTo(0.5, 3);
    expect(view.positions[0]?.y).toBeCloseTo(0.5 + (VIEW_PADDING.top - VIEW_PADDING.bottom) / 2 / 320, 3);
  });

  it('every position is where Google draws the point from the rounded center, to a tenth of a pixel', () => {
    for (const points of [[HANOVER, LEBANON], [HANOVER, LEBANON, NORWICH], [HANOVER, BURLINGTON], [NORWICH, HANOVER]]) {
      const view = fitView(points, 640, 320);
      points.forEach((point, i) => {
        const google = drawnAt(point, view.center, view.zoom);
        expect(Math.abs((view.positions[i]?.x ?? NaN) - google.x) * 640).toBeLessThan(0.1);
        expect(Math.abs((view.positions[i]?.y ?? NaN) - google.y) * 320).toBeLessThan(0.1);
      });
    }
  });

  it('picks the largest zoom that keeps every pin inside the margins', () => {
    for (const points of [[HANOVER, LEBANON], [HANOVER, BURLINGTON], [HANOVER, LEBANON, NORWICH]]) {
      const view = fitView(points, 640, 320);
      for (const at of view.positions) {
        expect(at.x * 640).toBeGreaterThanOrEqual(VIEW_PADDING.side - 0.5);
        expect(at.x * 640).toBeLessThanOrEqual(640 - VIEW_PADDING.side + 0.5);
        expect(at.y * 320).toBeGreaterThanOrEqual(VIEW_PADDING.top - 0.5);
        expect(at.y * 320).toBeLessThanOrEqual(320 - VIEW_PADDING.bottom + 0.5);
      }
      // One zoom closer and the spread no longer fits the room inside the margins.
      const xs = points.map((p) => pixel(p, view.zoom + 1).x);
      const ys = points.map((p) => pixel(p, view.zoom + 1).y);
      const tooWide = Math.max(...xs) - Math.min(...xs) > 640 - 2 * VIEW_PADDING.side;
      const tooTall = Math.max(...ys) - Math.min(...ys) > 320 - VIEW_PADDING.top - VIEW_PADDING.bottom;
      expect(tooWide || tooTall).toBe(true);
    }
  });

  it('rounds the center to six decimals, as the URL carries it', () => {
    const { center } = fitView([HANOVER, LEBANON], 640, 320);
    expect(Math.round(center.lat * 1e6) / 1e6).toBe(center.lat);
    expect(Math.round(center.lng * 1e6) / 1e6).toBe(center.lng);
  });

  it('throws on no points', () => {
    expect(() => fitView([], 640, 320)).toThrow();
  });
});

describe('viewMapPath', () => {
  const KEY = 'test-static-key';
  const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  it('sends the center and zoom, then one lettered marker per pin at its point, the styles and the key', () => {
    const path = viewMapPath({ center: { lat: 43.67, lng: -72.27 }, zoom: 12 }, [{ at: HANOVER, letter: 'A' }, { at: LEBANON, letter: 'B' }], KEY, 'dark');
    expect([...new URLSearchParams(path.split('?')[1]).entries()]).toEqual([
      ['center', '43.67,-72.27'],
      ['zoom', '12'],
      ['size', '640x320'],
      ['scale', '2'],
      ['format', 'jpg-baseline'],
      ['maptype', 'roadmap'],
      ['language', 'en'],
      ['region', 'us'],
      ['markers', 'color:0x7bd2b4|label:A|43.7022,-72.2896'],
      ['markers', 'color:0x7bd2b4|label:B|43.6426,-72.2517'],
      ...STATIC_MAP_STYLES.dark.map((rule) => ['style', rule]),
      ['key', KEY],
    ]);
    const map = createStaticMapSigner(KEY, SECRET).mapOfView({ center: { lat: 43.67, lng: -72.27 }, zoom: 12 }, [{ at: HANOVER, letter: 'A' }, { at: LEBANON, letter: 'B' }], 'dark');
    expect(map.url).toBe(`https://maps.googleapis.com${path}&signature=${signPath(path, SECRET)}`);
  });

  it('26 pins stay far under Google’s 16,384-character cap', () => {
    const pins = Array.from({ length: 26 }, (_, i) => ({ at: { lat: 43.123456 + i / 1000, lng: -72.654321 }, letter: String.fromCharCode(65 + i) }));
    const map = createStaticMapSigner('A'.repeat(39), SECRET).mapOfView({ center: HANOVER, zoom: 9 }, pins, 'light');
    expect(map.url.length).toBeLessThan(4000);
  });

  it('throws on no pins', () => {
    expect(() => viewMapPath({ center: HANOVER, zoom: 12 }, [], KEY, 'dark')).toThrow();
  });
});
