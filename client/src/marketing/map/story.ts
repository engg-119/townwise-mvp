import { fmt1, fmtSigned, side } from '../format';
import { DATA_YEAR, northeastSeries } from './countyData';
import { VIEW_HEIGHT, VIEW_WIDTH, type LabelSide } from './geometry';
import { mapTowns, markerScale, MONTH_NAMES, REST_MONTH, type MapTown } from './mapState';

// What the map story shows at each month (ConsoleV2.dc.html), derived from the bundled data with the mockup's
// formulas. Pure, with no DOM: the homepage map renders it and the tests pin it.

// A month's move against the Northeast: this month's gap minus last month's, in index points. January has no
// month before it, so it has none.
export function moveAt(gap: readonly number[], month: number): number {
  if (month <= 0) return 0;
  return (gap[month] ?? 0) - (gap[month - 1] ?? 0);
}

function rounds(delta: number): boolean {
  return Math.round(Math.abs(delta) * 10 + 1e-7) !== 0;
}

// The largest move by size; the first wins a tie.
export function largest<T extends { delta: number }>(moves: readonly T[]): T | null {
  return moves.reduce<T | null>((best, move) => (best === null || Math.abs(move.delta) > Math.abs(best.delta) ? move : best), null);
}

// The town that moved most against the Northeast since last month; the first in town order wins a tie.
export function biggestMove(month: number): { town: MapTown; delta: number } | null {
  if (month <= 0) return null;
  return largest(mapTowns.map((town) => ({ town, delta: moveAt(town.series.gap, month) })));
}

// The panel's sentence for a month.
export function moveSentence(month: number): string {
  const move = biggestMove(month);
  if (move === null) return `${MONTH_NAMES[0] ?? ''} starts the ${String(DATA_YEAR)} data, so there is no month before it to compare.`;
  return `Biggest move since ${MONTH_NAMES[month - 1] ?? ''}: ${move.town.label}, ${fmtSigned(move.delta)} index points against the Northeast.`;
}

// The month's three biggest movers (a move that rounds to zero is none), largest first, town order on a tie.
export function topMovers(month: number, count = 3): { town: MapTown; delta: number }[] {
  return mapTowns
    .map((town) => ({ town, delta: moveAt(town.series.gap, month) }))
    .filter((move) => rounds(move.delta))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, count);
}

export interface Flow {
  dir: 'in' | 'out';
  // Each particle's angle (degrees), distance (px) and place in the stagger.
  points: { a: number; d: number; j: number }[];
}

// Job flows, not people: a town's dot pulls particles in when its jobs rose against the Northeast since last
// month and pushes them out when they fell. One per 4 index points, at most 6; none under 1 point.
export function flowOf(townIndex: number, delta: number): Flow | null {
  const size = Math.abs(delta);
  if (size < 1) return null;
  const count = Math.min(6, Math.ceil(size / 4));
  const d = Math.round(14 + Math.min(26, size * 0.8));
  const points = Array.from({ length: count }, (_, j) => ({ a: Math.round(((j * 360) / count + townIndex * 23) % 360), d, j }));
  return { dir: delta > 0 ? 'in' : 'out', points };
}

// With reduced motion a + or − beside each dot that moved at least 4 points replaces the particles.
export function glyphOf(delta: number): '+' | '−' | null {
  if (Math.abs(delta) < 4) return null;
  return delta > 0 ? '+' : '−';
}

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

// The Northeast index as a 120 by 40 sparkline, and the month cursor's x on it.
const NE = northeastSeries.index;
const NE_LO = Math.min(...NE);
const NE_HI = Math.max(...NE);
export const NE_SPARK_D = NE.map((value, month) => `${month === 0 ? 'M' : 'L'}${String(r2((month * 120) / 11))} ${String(r2(38 - ((value - NE_LO) / (NE_HI - NE_LO)) * 36))}`).join(' ');

export function cursorX(month: number): number {
  return r2((month * 120) / 11);
}

// The month rail's fill, January a twelfth to December whole.
export function railFill(month: number): number {
  return (month + 1) / 12;
}

// The final step: the widest-spread month, with the counties furthest above and below the Northeast.
export function finale(): { title: string; line: string } {
  const gapOf = (town: MapTown): number => town.series.gap[REST_MONTH] ?? 0;
  const hi = mapTowns.reduce<MapTown | null>((best, town) => (best === null || gapOf(town) > gapOf(best) ? town : best), null);
  const lo = mapTowns.reduce<MapTown | null>((best, town) => (best === null || gapOf(town) < gapOf(best) ? town : best), null);
  const title = `${MONTH_NAMES[REST_MONTH] ?? ''}, the year’s widest spread.`;
  if (hi === null || lo === null) return { title, line: '' };
  return {
    title,
    line: `${hi.county} sat ${fmt1(Math.abs(gapOf(hi)))} index points ${side(gapOf(hi))} the Northeast; ${lo.county}, ${fmt1(Math.abs(gapOf(lo)))} ${side(gapOf(lo))}.`,
  };
}

// The legend and caption under the pinned map, budgeted when nothing is measured yet.
export const PIN_EXTRA = 150;

// The pinned map's size and top, in px, from the story's width and the scroll container's height. From 1024px
// the map plus its legend and caption (`extra`) is centered in the window, leaving room for the header (65px)
// and the story's padding. A short window gives up that room, down to 24px above and below, since the header has
// scrolled away by the time the map is pinned: otherwise the map shrinks, its legend wraps more and shrinks it
// again. Under 1024px the map, its month strip and caption fill about the top half.
export function storyBox(width: number, height: number, wide: boolean, extra = PIN_EXTRA): { mw: number; mh: number; top: number } {
  if (wide) {
    const reserve = Math.min(65 + 48, Math.max(48, height - 680));
    const mw = Math.round(Math.max(320, Math.min(width - (width >= 960 ? 340 : 300), (height - reserve - extra) / 0.87)));
    const mh = Math.round(mw * 0.87);
    return { mw, mh, top: Math.max(16, Math.round((height - mh - extra) / 2)) };
  }
  const mw = Math.round(Math.max(240, Math.min(width, (height * 0.5 - 88) / 0.87)));
  return { mw, mh: Math.round(mw * 0.87), top: 0 };
}

// A box in map px: left, top, right, bottom.
export type Box = readonly [number, number, number, number];

// From 1024px the H1 reaches over the map's northwest corner. The box it covers there, by window width (the
// mockup's fitted H1 sizes), offset by the text column to the map's left.
export function titleBox(windowWidth: number, storyWidth: number, mapWidth: number): Box {
  const [w, h] = windowWidth >= 1440 ? [642, 368] : windowWidth >= 1280 ? [558, 320] : [447, 256];
  const off = storyWidth - mapWidth;
  return [-off, 0, w - off + 24, h + 24];
}

// The month's value tags: each of the three biggest movers on the first side (its name tag's side, then right,
// left, above, below) that keeps the tag inside the map and 4px clear of the tags placed before it and of
// `avoid`. A tag that fits nowhere is left out. Sizes from the 12px mono face, 7.2px a character.
export interface Tag {
  text: string;
  side: LabelSide;
  box: Box;
}

export function placeTags(month: number, width: number, avoid: readonly Box[] = []): Map<string, Tag> {
  const placed = new Map<string, Tag>();
  if (month <= 0 || width <= 0) return placed;
  const height = width * 0.87;
  const boxes: Box[] = [...avoid];
  for (const { town, delta } of topMovers(month)) {
    const x = (town.shape.centroid[0] / VIEW_WIDTH) * width;
    const y = (town.shape.centroid[1] / VIEW_HEIGHT) * height;
    const r = 12 * markerScale(town.series.gap[month] ?? 0);
    const text = `${town.name} ${fmtSigned(delta)}`;
    const tw = text.length * 7.2 + 14;
    const th = 20;
    const sides: LabelSide[] = [town.shape.labelSide, ...(['right', 'left', 'above', 'below'] as const).filter((other) => other !== town.shape.labelSide)];
    for (const where of sides) {
      const box: Box = where === 'right' ? [x + r + 6, y - th / 2, x + r + 6 + tw, y + th / 2]
        : where === 'left' ? [x - r - 6 - tw, y - th / 2, x - r - 6, y + th / 2]
          : where === 'above' ? [x - tw / 2, y - r - 6 - th, x + tw / 2, y - r - 6]
            : [x - tw / 2, y + r + 6, x + tw / 2, y + r + 6 + th];
      if (box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height) continue;
      if (boxes.some((other) => box[0] < other[2] + 4 && box[2] + 4 > other[0] && box[1] < other[3] + 4 && box[3] + 4 > other[1])) continue;
      boxes.push(box);
      placed.set(town.id, { text, side: where, box });
      break;
    }
  }
  return placed;
}
