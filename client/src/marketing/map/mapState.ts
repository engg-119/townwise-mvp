import { fmtSigned } from '../format';
import { pickStep, type Side } from './band';
import { countySeries, MAX_ABS_GAP, MONTHS, type CountySeries } from './countyData';
import { countyShapes, townShapes, type TownShape } from './geometry';
import { towns, type Town } from './towns';

// The homepage map's model, from ConsoleV2.dc.html: the twelve towns joined to their county series and
// shapes, and one reducer for the state the map, the town list and the panel share. Pure, with no DOM.

export type Pattern = 'moves' | 'breaks' | 'opposite';

export const PATTERNS: readonly Pattern[] = ['moves', 'breaks', 'opposite'];

export const PATTERN_LABEL: Record<Pattern, string> = {
  moves: 'Moves with the region',
  breaks: 'Breaks from the region',
  opposite: 'Runs opposite the region',
};

export const KIND_LABEL: Record<Town['kind'], string> = {
  college: 'College town',
  seasonal: 'Seasonal town',
  event: 'Event town',
};

export const MONTH_NAMES: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface MapTown extends Town {
  // "Hanover, NH"
  label: string;
  series: CountySeries;
  shape: TownShape;
  countyD: string;
  pattern: Pattern;
}

// A county breaks from the region when its mean absolute gap is 5 index points or more, and runs opposite
// when it also moves against the Northeast (Pearson r at or below minus 0.5). Team thresholds, never printed.
function patternOf(series: CountySeries): Pattern {
  if (series.divergenceVsNortheast < 5) return 'moves';
  return series.correlationWithNortheast <= -0.5 ? 'opposite' : 'breaks';
}

export const mapTowns: readonly MapTown[] = towns.flatMap((town) => {
  const series = countySeries.find((county) => county.townId === town.id);
  const shape = townShapes.find((candidate) => candidate.id === town.id);
  const county = countyShapes.find((candidate) => candidate.fips === town.countyFips);
  if (series === undefined || shape === undefined || county === undefined) return [];
  return [{ ...town, label: `${town.name}, ${town.state}`, series, shape, countyD: county.d, pattern: patternOf(series) }];
});

// The town whose dot is nearest a point, in map units (the viewBox). Each dot's 44px hit area overlaps its
// neighbors' where towns sit close (Burlington and Stowe are 12px apart on a phone), so a tap goes to the dot
// nearest it, whichever button it landed on.
export function nearestTown(x: number, y: number): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const town of mapTowns) {
    const [cx, cy] = town.shape.centroid;
    const distance = (cx - x) ** 2 + (cy - y) ** 2;
    if (best === null || distance < best.distance) best = { id: town.id, distance };
  }
  return best === null ? null : best.id;
}

export function monthLabel(month: number): string {
  return MONTHS[month] ?? '';
}

export function valueAt(values: readonly number[], month: number): number {
  return values[month] ?? 0;
}

// The town's data sentence after its pattern label, shared by the panel and the live line.
export function patternGap(town: MapTown): string {
  const { monthIndex, signedGap } = town.series.largestGap;
  return `; biggest gap with the region in ${MONTH_NAMES[monthIndex] ?? ''}, ${fmtSigned(signedGap)} index points.`;
}

// A marker's scale for a month's gap: 0.35 with no gap, 1 at the year's largest gap, by area.
export function markerScale(gap: number): number {
  return 0.35 + 0.65 * Math.sqrt(Math.min(1, Math.abs(gap) / MAX_ABS_GAP));
}

// The map story's steps (ConsoleV2.dc.html): 0 the title over the outlines, 1 the region, 2 the towns appear,
// 3 to 14 January to December, 15 back to the reader's month (thisMonth). Scroll is the only clock.
export const STORY_STEPS = 16;
export const FINAL_STEP = STORY_STEPS - 1;

export function stepMonth(step: number, thisMonth: number): number | null {
  if (step < 2) return null;
  if (step === 2) return 0;
  return step < FINAL_STEP ? step - 3 : thisMonth;
}

export type Phase = 'region' | 'local';
export type Draw = 'pre' | 'run' | 'done';

export function stepPhase(step: number): Phase {
  return step >= 2 ? 'local' : 'region';
}

export interface MapState {
  // The map has come into view, so the intro may run.
  seen: boolean;
  // The state outlines' draw-in: hidden before, drawing, then done.
  draw: Draw;
  phase: Phase;
  sel: string | null;
  hover: string | null;
  // The hover came from a pointer, which also scales the marker.
  pointer: boolean;
  // The month set by the story, the scrubber or a selection; null shows thisMonth.
  month: number | null;
  // The reader's current calendar month (0 to 11), read once when the map mounts: where the map rests with
  // nothing chosen, the story's last step, and the month a picked town opens on.
  thisMonth: number;
  // Story mode: the scroll sets the step (on), or the map lies flat at thisMonth (no working observer).
  story: boolean;
  // The story's step, and a tick bumped on each change so its particle burst replays.
  ss: number;
  ssTick: number;
  // Who set the month: the story's scroll (the dots ease and the particles run) or the reader.
  mby: 'scroll' | 'user';
  // Just zoomed out: the markers wait for the zoom to settle.
  back: boolean;
  // The last change came from the keyboard, so it does not animate.
  kb: boolean;
  // Bumped on each change, so the crossfades replay (their classes flip between two copies).
  monthTick: number;
  cardTick: number;
}

export type MapAction =
  | { type: 'seen'; reduced: boolean }
  | { type: 'draw' }
  | { type: 'towns' }
  | { type: 'story'; on: boolean }
  | { type: 'band'; sides: readonly Side[] }
  | { type: 'select'; id: string; kb: boolean }
  | { type: 'reset'; kb: boolean }
  | { type: 'month'; month: number; kb: boolean }
  | { type: 'hover'; id: string | null; pointer: boolean };

const START: Omit<MapState, 'thisMonth'> = {
  seen: false, draw: 'pre', phase: 'region', sel: null, hover: null, pointer: false, month: null,
  story: true, ss: 0, ssTick: 0, mby: 'user', back: false, kb: false, monthTick: 0, cardTick: 0,
};

// The story starts at its title, outlines hidden until the map is in view (drawn at once with reduced motion).
// Without an observer the map lies flat: towns at thisMonth, nothing to wait for.
export function initialMapState(options: { reduced: boolean; story: boolean; thisMonth: number }): MapState {
  const start: MapState = { ...START, thisMonth: options.thisMonth };
  if (!options.story) return { ...start, story: false, ss: FINAL_STEP, phase: 'local', draw: 'done', seen: true };
  return options.reduced ? { ...start, draw: 'done' } : start;
}

export function shownMonth(state: MapState): number {
  return state.month ?? state.thisMonth;
}

function storyOn(state: MapState): MapState {
  if (state.story) return state;
  const selected = state.sel !== null;
  return { ...state, story: true, ss: 0, ssTick: state.ssTick + 1, phase: selected ? 'local' : 'region', month: selected ? state.month : null };
}

// The scroll owns the month while the story runs; a selected town keeps its zoom and follows the months.
function toStep(state: MapState, step: number): MapState {
  if (!state.story || step === state.ss) return state;
  const month = stepMonth(step, state.thisMonth);
  const next: MapState = { ...state, ss: step, kb: false, ssTick: state.ssTick + 1 };
  if (state.sel === null) next.phase = stepPhase(step);
  return month === state.month ? next : { ...next, month, monthTick: state.monthTick + 1, mby: 'scroll' };
}

// Any use of the map, list or scrubber finishes the draw at once; the month it sets is the reader's.
function halt(state: MapState, patch: Partial<MapState>, kb: boolean): MapState {
  const next: MapState = { ...state, ...patch, kb, draw: 'done', mby: 'user' };
  return shownMonth(next) === shownMonth(state) ? next : { ...next, monthTick: state.monthTick + 1 };
}

export function mapReducer(state: MapState, action: MapAction): MapState {
  switch (action.type) {
    case 'seen':
      if (state.seen) return state;
      return { ...state, seen: true, draw: action.reduced ? 'done' : state.draw };
    case 'draw':
      return state.draw === 'pre' ? { ...state, draw: 'run' } : state;
    case 'towns':
      return state.draw === 'done' ? state : { ...state, draw: 'done' };
    case 'story':
      if (action.on) return storyOn(state);
      if (!state.story) return state;
      return { ...state, story: false, ss: FINAL_STEP, phase: 'local', month: state.sel === null ? null : state.month, draw: 'done', seen: true };
    case 'band': {
      // A report from the band also means the observer works: a story laid flat by its watchdog comes back.
      const on = storyOn(state);
      return toStep(on, pickStep(action.sides, on.ss));
    }
    case 'select':
      return halt(state, { sel: action.id, month: state.thisMonth, phase: 'local', back: false, cardTick: state.cardTick + 1 }, action.kb);
    case 'reset': {
      // During the story, Back returns to the step's own month and, before the towns, to the region.
      const story = state.story ? { month: stepMonth(state.ss, state.thisMonth), phase: stepPhase(state.ss) } : { month: null };
      return halt(state, { sel: null, back: true, cardTick: state.cardTick + 1, ...story }, action.kb);
    }
    case 'month':
      return halt(state, { month: action.month }, action.kb);
    case 'hover':
      if (state.hover === action.id && state.pointer === action.pointer) return state;
      return { ...state, hover: action.id, pointer: action.pointer };
  }
}
