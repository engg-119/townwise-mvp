// The map story's band (ConsoleV2.dc.html): an IntersectionObserver on the page's scroll container whose root
// is shrunk to a thin band, and the step slot alone in that band is the active step. Pure, with no DOM.

// Where a step slot is against the band. 'unknown' when there is no layout to tell (a hidden screen gives zero
// rects), and then the step holds.
export type Side = 'in' | 'above' | 'below' | 'unknown';

// The band, as the observer's root margin: `top` in from the root's top edge and `bottom` in from its bottom
// edge, in percent of the root's height or in px.
export interface Band {
  top: number;
  bottom: number;
  unit: '%' | 'px';
}

// From 1024px the map and the panel are pinned beside the text, so the band is the middle 10% of the window.
export const CENTER_BAND: Band = { top: 45, bottom: 45, unit: '%' };

// Under 1024px the map is pinned over the top of the window and the step cards pass under it, so the band is
// the middle 10% of what is left below the pin: the active card is the one in view under the map.
// A pin that leaves less than a fifth of the window keeps the center band.
export function phoneBand(height: number, pinBottom: number): Band {
  const pin = Math.min(height, Math.max(0, pinBottom));
  const below = height - pin;
  if (below < height * 0.2) return CENTER_BAND;
  return { top: Math.round(pin + below * 0.45), bottom: Math.round(below * 0.45), unit: 'px' };
}

export function rootMargin(band: Band): string {
  return `-${String(band.top)}${band.unit} 0px -${String(band.bottom)}${band.unit} 0px`;
}

// The band's top and bottom in viewport px, for a root at `rootTop` that is `rootHeight` tall.
export function bandEdges(band: Band, rootTop: number, rootHeight: number): { top: number; bottom: number } {
  const scale = band.unit === '%' ? rootHeight / 100 : 1;
  return { top: rootTop + band.top * scale, bottom: rootTop + rootHeight - band.bottom * scale };
}

interface Rect {
  top: number;
  bottom: number;
  width: number;
  height: number;
}

// Which side of the band a slot is on, from layout. A slot with no box (display: none, or a hidden screen) or a
// band with no height cannot tell.
export function sideOfRect(rect: Rect, bandTop: number, bandBottom: number): Side {
  if ((rect.width === 0 && rect.height === 0) || !(bandBottom > bandTop)) return 'unknown';
  if (rect.bottom > bandTop && rect.top < bandBottom) return 'in';
  return rect.bottom <= bandTop ? 'above' : 'below';
}

// The same from an observer entry, whose rootBounds is the band (the root shrunk by the margin).
export function sideOf(entry: { isIntersecting: boolean; boundingClientRect: Rect; rootBounds: Rect | null }): Side {
  const bounds = entry.rootBounds;
  const rect = entry.boundingClientRect;
  if (bounds === null || !(bounds.height > 0) || (rect.width === 0 && rect.height === 0)) return 'unknown';
  if (entry.isIntersecting) return 'in';
  return rect.top + rect.height / 2 < (bounds.top + bounds.bottom) / 2 ? 'above' : 'below';
}

// The active step for the slots' sides, in slot order. Exactly one slot in the band wins; two in it (the band
// straddles a boundary) hold the current step. With none in it, the step is the last slot the band has passed:
// the last step past the story (every slot above it), the first ahead of it (every slot below it), and on phones,
// where the pinned map's own flow separates the title from the first card, the title's step. Any unknown side, or
// sides out of slot order, hold.
export function pickStep(sides: readonly Side[], current: number): number {
  const inside = sides.flatMap((side, index) => (side === 'in' ? [index] : []));
  if (inside.length === 1) return inside[0] ?? current;
  if (inside.length > 1 || sides.length === 0 || sides.includes('unknown')) return current;
  const passed = sides.filter((side) => side === 'above').length;
  if (sides.slice(0, passed).some((side) => side !== 'above')) return current;
  return Math.max(0, passed - 1);
}
