import type { Side } from '../../src/marketing/map/band';
import { initialMapState, mapReducer, REST_MONTH, shownMonth, stepMonth, stepPhase, type MapState } from '../../src/marketing/map/mapState';

// The band with slot `at` in it, the slots before it above and the rest below.
function band(at: number): Side[] {
  return Array.from({ length: 16 }, (_, index) => (index === at ? 'in' : index < at ? 'above' : 'below'));
}

function scrollTo(state: MapState, at: number): MapState {
  return mapReducer(state, { type: 'band', sides: band(at) });
}

const story = initialMapState({ reduced: false, story: true });

test('the story starts at its title with the outlines hidden; reduced motion draws them at once; no observer lies flat', () => {
  expect(story).toMatchObject({ story: true, ss: 0, phase: 'region', draw: 'pre', seen: false, month: null, mby: 'user' });
  expect(initialMapState({ reduced: true, story: true })).toMatchObject({ story: true, ss: 0, phase: 'region', draw: 'done', seen: false });
  for (const reduced of [false, true]) {
    expect(initialMapState({ reduced, story: false })).toMatchObject({ story: false, ss: 15, phase: 'local', draw: 'done', seen: true, month: null });
  }
});

test('each step has its month and phase: the title and region without one, January twice, then the year, then the widest spread', () => {
  expect([...Array(16).keys()].map(stepMonth)).toEqual([null, null, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, REST_MONTH]);
  expect([...Array(16).keys()].map(stepPhase)).toEqual(['region', 'region', ...Array<string>(14).fill('local')]);
  expect(REST_MONTH).toBe(6);
});

test('a band report moves the story one step at a time, and only an actual change counts', () => {
  const two = scrollTo(story, 2);
  expect(two).toMatchObject({ ss: 2, phase: 'local', month: 0, mby: 'scroll', kb: false, ssTick: 1, monthTick: 1 });
  // Steps 2 and 3 are both January: the step ticks, the month does not.
  const three = scrollTo(two, 3);
  expect(three).toMatchObject({ ss: 3, month: 0, ssTick: 2, monthTick: 1 });
  // The same step again is no change at all.
  expect(scrollTo(three, 3)).toBe(three);
  // Two slots in the band hold the step.
  const both = band(4);
  both[5] = 'in';
  expect(mapReducer(three, { type: 'band', sides: both })).toBe(three);
  // A hidden screen holds it too.
  expect(mapReducer(three, { type: 'band', sides: Array<Side>(16).fill('unknown') })).toBe(three);
  expect(scrollTo(three, 14)).toMatchObject({ ss: 14, month: 11, monthTick: 2 });
  expect(scrollTo(scrollTo(three, 14), 1)).toMatchObject({ ss: 1, phase: 'region', month: null });
});

test('a town picked during the story keeps its zoom while the scroll moves the month; Back returns to the step', () => {
  const june = scrollTo(story, 8);
  const picked = mapReducer(june, { type: 'select', id: 'hanover-nh', kb: false });
  expect(picked).toMatchObject({ sel: 'hanover-nh', phase: 'local', month: 4, mby: 'user', draw: 'done' });
  const moved = scrollTo(picked, 10);
  expect(moved).toMatchObject({ sel: 'hanover-nh', ss: 10, month: 7, mby: 'scroll' });
  // Before the towns the step's phase is the region, but a selected town keeps the map local.
  const early = scrollTo(moved, 1);
  expect(early).toMatchObject({ sel: 'hanover-nh', phase: 'local', month: null });
  expect(mapReducer(early, { type: 'reset', kb: true })).toMatchObject({ sel: null, phase: 'region', month: null, back: true, kb: true });
  expect(mapReducer(moved, { type: 'reset', kb: false })).toMatchObject({ sel: null, phase: 'local', month: 7 });
  // Flat, Back returns to the rest month.
  const flat = mapReducer(initialMapState({ reduced: false, story: false }), { type: 'select', id: 'stowe-vt', kb: false });
  expect(shownMonth(mapReducer(flat, { type: 'reset', kb: false }))).toBe(REST_MONTH);
});

test('the scrubber sets the month by hand and finishes the draw', () => {
  const next = mapReducer(scrollTo(story, 5), { type: 'month', month: 9, kb: false });
  expect(next).toMatchObject({ month: 9, mby: 'user', draw: 'done' });
  expect(next.monthTick).toBe(scrollTo(story, 5).monthTick + 1);
});

test('the intro never changes the phase: the story or the flat map owns it', () => {
  const seen = mapReducer(story, { type: 'seen', reduced: false });
  expect(seen).toMatchObject({ seen: true, draw: 'pre', phase: 'region' });
  const drawing = mapReducer(seen, { type: 'draw' });
  expect(drawing).toMatchObject({ draw: 'run', phase: 'region' });
  expect(mapReducer(drawing, { type: 'towns' })).toMatchObject({ draw: 'done', phase: 'region' });
  expect(mapReducer(story, { type: 'seen', reduced: true })).toMatchObject({ seen: true, draw: 'done', phase: 'region' });
});

test('a silent observer lays the story flat; any later report brings it back', () => {
  const flat = mapReducer(scrollTo(story, 6), { type: 'story', on: false });
  expect(flat).toMatchObject({ story: false, ss: 15, phase: 'local', month: null, draw: 'done', seen: true });
  expect(mapReducer(flat, { type: 'story', on: false })).toBe(flat);
  // In the flat map the band changes nothing until it reports: then the story is back, at the reported step.
  expect(scrollTo(flat, 9)).toMatchObject({ story: true, ss: 9, month: 6, phase: 'local', mby: 'scroll' });
  expect(mapReducer(flat, { type: 'story', on: true })).toMatchObject({ story: true, ss: 0, phase: 'region', month: null });
});
