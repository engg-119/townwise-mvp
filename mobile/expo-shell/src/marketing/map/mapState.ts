import { fmtSigned } from '../format';
import { countySeries, MAX_ABS_GAP, MONTHS, widestSpreadMonth, type CountySeries } from './countyData';
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

// Where the playing year comes to rest: the month with the widest spread of gaps across the twelve counties.
// It is also the month shown with nothing chosen, and the only one shown with reduced motion.
export const REST_MONTH = widestSpreadMonth();

// January to December, then the rest month. Each month holds 500ms; January holds 1000ms while the
// markers enter, and December 800ms before the rest. Resuming after Pause waits 300ms.
const PLAY_SEQUENCE: readonly number[] = [...MONTHS.keys(), REST_MONTH];
const LAST_STEP = PLAY_SEQUENCE.length - 1;
export const PLAY_MS = { first: 1000, month: 500, december: 800, resume: 300 } as const;

export type Phase = 'region' | 'local';
export type Play = 'idle' | 'on' | 'pause' | 'end' | 'stop';
export type Draw = 'pre' | 'run' | 'done';

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
  // The month chosen by the scrubber, a selection or the playing year; null shows REST_MONTH.
  month: number | null;
  play: Play;
  step: number;
  // Milliseconds until the next step of the playing year.
  wait: number;
  // Just zoomed out: the markers wait for the zoom to settle.
  back: boolean;
  // The last change came from the keyboard, so it does not animate.
  kb: boolean;
  // The Region / Towns toggle was used: the towns never appear on their own.
  toggled: boolean;
  // The map, list, toggle or scrubber was used: the towns appear without playing the year.
  touched: boolean;
  // Bumped on each change, so the crossfades replay (their classes flip between two copies).
  monthTick: number;
  cardTick: number;
}

export type MapAction =
  | { type: 'seen'; reduced: boolean }
  | { type: 'draw' }
  | { type: 'towns' }
  | { type: 'step' }
  | { type: 'togglePlay' }
  | { type: 'select'; id: string; kb: boolean }
  | { type: 'reset'; kb: boolean }
  | { type: 'phase'; phase: Phase; kb: boolean }
  | { type: 'month'; month: number; kb: boolean }
  | { type: 'hover'; id: string | null; pointer: boolean };

const START: MapState = {
  seen: false, draw: 'pre', phase: 'region', sel: null, hover: null, pointer: false, month: null,
  play: 'idle', step: 0, wait: PLAY_MS.first, back: false, kb: false, toggled: false, touched: false,
  monthTick: 0, cardTick: 0,
};

// With reduced motion nothing is drawn in. `seen`: the map counts as in view at once (no observer).
export function initialMapState(options: { reduced: boolean; seen: boolean }): MapState {
  const start: MapState = options.reduced ? { ...START, draw: 'done' } : START;
  return options.seen ? mapReducer(start, { type: 'seen', reduced: options.reduced }) : start;
}

export function shownMonth(state: MapState): number {
  return state.month ?? REST_MONTH;
}

// Region to Towns, once: on January with the year playing, or without the play once the map was used.
function advance(state: MapState): MapState {
  if (state.toggled || state.phase === 'local') return state;
  if (state.touched) return { ...state, phase: 'local' };
  return { ...state, phase: 'local', month: 0, monthTick: state.monthTick + 1, play: 'on', step: 0, wait: PLAY_MS.first };
}

// Any use of the map, list, toggle or scrubber stops the year and finishes the draw at once.
function halt(state: MapState, patch: Partial<MapState>, kb: boolean): MapState {
  const next: MapState = {
    ...state, ...patch, kb, touched: true, draw: 'done', play: state.play === 'idle' ? 'idle' : 'stop',
  };
  return shownMonth(next) === shownMonth(state) ? next : { ...next, monthTick: state.monthTick + 1 };
}

export function mapReducer(state: MapState, action: MapAction): MapState {
  switch (action.type) {
    case 'seen':
      if (state.seen) return state;
      if (!action.reduced) return { ...state, seen: true };
      return { ...state, seen: true, draw: 'done', phase: state.toggled ? state.phase : 'local' };
    case 'draw':
      return state.draw === 'pre' ? { ...state, draw: 'run' } : advance(state);
    case 'towns':
      return advance({ ...state, draw: 'done' });
    case 'step': {
      if (state.play !== 'on') return state;
      const step = Math.min(state.step + 1, LAST_STEP);
      return {
        ...state,
        step,
        month: PLAY_SEQUENCE[step] ?? REST_MONTH,
        monthTick: state.monthTick + 1,
        play: step === LAST_STEP ? 'end' : 'on',
        wait: step === LAST_STEP - 1 ? PLAY_MS.december : PLAY_MS.month,
      };
    }
    case 'togglePlay':
      if (state.play === 'on') return { ...state, play: 'pause' };
      if (state.play === 'pause' && state.step < LAST_STEP) return { ...state, play: 'on', kb: false, wait: PLAY_MS.resume };
      return { ...state, play: 'on', step: 0, month: 0, monthTick: state.monthTick + 1, kb: false, wait: PLAY_MS.month };
    case 'select': {
      const town = mapTowns.find((candidate) => candidate.id === action.id);
      const month = town === undefined ? null : town.series.largestGap.monthIndex;
      return halt(state, { sel: action.id, month, phase: 'local', back: false, cardTick: state.cardTick + 1 }, action.kb);
    }
    case 'reset':
      return halt(state, { sel: null, month: null, back: true, cardTick: state.cardTick + 1 }, action.kb);
    case 'phase': {
      const clear = action.phase === 'region' && state.sel !== null ? { sel: null, month: null, cardTick: state.cardTick + 1 } : {};
      return halt(state, { phase: action.phase, toggled: true, back: false, ...clear }, action.kb);
    }
    case 'month':
      return halt(state, { month: action.month }, action.kb);
    case 'hover':
      if (state.hover === action.id && state.pointer === action.pointer) return state;
      return { ...state, hover: action.id, pointer: action.pointer };
  }
}
