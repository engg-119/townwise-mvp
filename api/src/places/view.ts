// D47 (Settings' map hover): the view of a lettered map that Townwise sets itself rather than leaving to Google, so the
// page knows where each pin is. Google Maps Static draws in Web Mercator at 256 logical pixels per world tile at zoom 0
// (scale 2 doubles the pixels, not the logical size), centered on `center` at an integer `zoom`. This fits every point
// with a margin, picks the largest zoom that does (at most 15, the single-place map's), rounds the center to the six
// decimals the URL carries and then places every point from that rounded center, so the positions match the image.
// Pure: no network, nothing stored or logged.

export interface LatLng { lat: number; lng: number }

export interface MapView {
  center: LatLng;
  zoom: number;
  /** Each point's place on the image as fractions of its width and height, in the order given. */
  positions: { x: number; y: number }[];
}

const TILE = 256;
/** Web Mercator's limit: beyond it the projection runs off to infinity. */
const MAX_LAT = 85.05112878;
export const MAX_VIEW_ZOOM = 15;
/** Room kept between the outermost pins and the image's edges: a pin's head stands about 34 logical pixels tall. */
export const VIEW_PADDING = { side: 32, top: 44, bottom: 16 } as const;

function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** World coordinates at zoom 0, in logical pixels. */
export function worldOf(point: LatLng): { x: number; y: number } {
  const sin = Math.sin((clampLat(point.lat) * Math.PI) / 180);
  return {
    x: ((point.lng + 180) / 360) * TILE,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * TILE,
  };
}

function latLngOf(world: { x: number; y: number }): LatLng {
  const lng = (world.x / TILE) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * world.y) / TILE;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lng };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The view that shows every point on a width by height image. Throws on an empty list. */
export function fitView(points: readonly LatLng[], width: number, height: number): MapView {
  if (points.length === 0) throw new Error('fitView needs at least one point');
  const worlds = points.map(worldOf);
  const xs = worlds.map((w) => w.x);
  const ys = worlds.map((w) => w.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const roomX = width - 2 * VIEW_PADDING.side;
  const roomY = height - VIEW_PADDING.top - VIEW_PADDING.bottom;
  let zoom = MAX_VIEW_ZOOM;
  while (zoom > 0 && ((maxX - minX) * 2 ** zoom > roomX || (maxY - minY) * 2 ** zoom > roomY)) zoom -= 1;
  // The middle of the pins, nudged down by half the difference between the top and bottom margins, so the pin heads
  // above the highest point stay inside.
  const shift = (VIEW_PADDING.top - VIEW_PADDING.bottom) / 2 / 2 ** zoom;
  const middle = latLngOf({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 - shift });
  const center = { lat: round6(middle.lat), lng: round6(middle.lng) };
  const c = worldOf(center);
  const scale = 2 ** zoom;
  return {
    center,
    zoom,
    positions: worlds.map((w) => ({
      x: (width / 2 + (w.x - c.x) * scale) / width,
      y: (height / 2 + (w.y - c.y) * scale) / height,
    })),
  };
}
