import { fmtSigned } from '../../src/marketing/format';
import { bandEdges, CENTER_BAND, phoneBand, pickStep, rootMargin, sideOf, sideOfRect, type Side } from '../../src/marketing/map/band';
import { mapTowns, MONTH_NAMES } from '../../src/marketing/map/mapState';
import {
  biggestMove, cursorX, finale, flowOf, glyphOf, largest, moveAt, moveSentence, NE_SPARK_D, placeTags, railFill, storyBox,
  titleBox, topMovers, type Box,
} from '../../src/marketing/map/story';

function rect(top: number, bottom: number, width = 100): { top: number; bottom: number; width: number; height: number } {
  return { top, bottom, width, height: bottom - top };
}

// Sixteen sides: `at` in the band, the slots before it above, the rest below.
function sides(at: number): Side[] {
  return Array.from({ length: 16 }, (_, index) => (index === at ? 'in' : index < at ? 'above' : 'below'));
}

describe('the band', () => {
  test('exactly one slot in the band is the step; two hold the current one', () => {
    expect(pickStep(sides(4), 0)).toBe(4);
    const two = sides(4);
    two[5] = 'in';
    expect(pickStep(two, 4)).toBe(4);
    expect(pickStep(two, 9)).toBe(9);
  });

  test('with no slot in the band the step is the last slot passed: past the story the last, ahead of it the first', () => {
    expect(pickStep(Array<Side>(16).fill('above'), 6)).toBe(15);
    expect(pickStep(Array<Side>(16).fill('below'), 6)).toBe(0);
    // On phones the pinned map's flow sits between the title slot and the first card: there, the title's step.
    expect(pickStep(['above', ...Array<Side>(15).fill('below')], 1)).toBe(0);
    expect(pickStep(['above', 'above', 'above', ...Array<Side>(13).fill('below')], 9)).toBe(2);
    // Sides out of slot order cannot be placed, and no slots at all hold.
    expect(pickStep(['below', 'above', ...Array<Side>(14).fill('below')], 4)).toBe(4);
    expect(pickStep([], 3)).toBe(3);
  });

  test('a side that cannot be told (a hidden screen) holds the step', () => {
    const hidden = Array<Side>(16).fill('above');
    hidden[9] = 'unknown';
    expect(pickStep(hidden, 7)).toBe(7);
    expect(pickStep(Array<Side>(16).fill('unknown'), 7)).toBe(7);
  });

  test('a slot’s side from layout: in when it overlaps the band, above or below otherwise', () => {
    expect(sideOfRect(rect(300, 410), 405, 495)).toBe('in');
    expect(sideOfRect(rect(490, 700), 405, 495)).toBe('in');
    expect(sideOfRect(rect(100, 405), 405, 495)).toBe('above');
    expect(sideOfRect(rect(495, 700), 405, 495)).toBe('below');
    // No box (display: none, or a hidden screen), or a band with no height, cannot tell.
    expect(sideOfRect({ top: 0, bottom: 0, width: 0, height: 0 }, 405, 495)).toBe('unknown');
    expect(sideOfRect(rect(300, 410), 0, 0)).toBe('unknown');
  });

  test('a slot’s side from an observer entry, unknown when the root or the slot has no box', () => {
    const band = rect(405, 495, 1440);
    expect(sideOf({ isIntersecting: true, boundingClientRect: rect(300, 500), rootBounds: band })).toBe('in');
    expect(sideOf({ isIntersecting: false, boundingClientRect: rect(-300, 100), rootBounds: band })).toBe('above');
    expect(sideOf({ isIntersecting: false, boundingClientRect: rect(900, 1100), rootBounds: band })).toBe('below');
    expect(sideOf({ isIntersecting: false, boundingClientRect: rect(-300, 100), rootBounds: null })).toBe('unknown');
    expect(sideOf({ isIntersecting: false, boundingClientRect: rect(-300, 100), rootBounds: { top: 0, bottom: 0, width: 0, height: 0 } })).toBe('unknown');
    expect(sideOf({ isIntersecting: false, boundingClientRect: { top: 0, bottom: 0, width: 0, height: 0 }, rootBounds: band })).toBe('unknown');
  });

  test('from 1024px the band is the window’s middle tenth; under it, the middle tenth of what the pinned map leaves', () => {
    expect(rootMargin(CENTER_BAND)).toBe('-45% 0px -45% 0px');
    expect(bandEdges(CENTER_BAND, 0, 900)).toEqual({ top: 405, bottom: 495 });
    // A 390 by 844 phone with the pinned map, strip and caption 420px tall: the band is 611 to 653.
    const phone = phoneBand(844, 420);
    expect(phone).toEqual({ top: 611, bottom: 191, unit: 'px' });
    expect(rootMargin(phone)).toBe('-611px 0px -191px 0px');
    expect(bandEdges(phone, 0, 844)).toEqual({ top: 611, bottom: 653 });
    // A pin that leaves less than a fifth of the window keeps the center band.
    expect(phoneBand(600, 500)).toBe(CENTER_BAND);
  });
});

describe('the months', () => {
  test('a month’s move is this month’s gap minus last month’s; January has none', () => {
    const gap = [1, 4, 2];
    expect(moveAt(gap, 0)).toBe(0);
    expect(moveAt(gap, 1)).toBe(3);
    expect(moveAt(gap, 2)).toBe(-2);
  });

  test('the panel’s sentence names the month’s biggest move against the Northeast', () => {
    expect(MONTH_NAMES.map((_, month) => moveSentence(month))).toEqual([
      'January starts the 2024 data, so there is no month before it to compare.',
      'Biggest move since January: Ithaca, NY, +12.4 index points against the Northeast.',
      'Biggest move since February: Hanover, NH, −7.9 index points against the Northeast.',
      'Biggest move since March: Stowe, VT, −17.3 index points against the Northeast.',
      'Biggest move since April: Nantucket, MA, +50.1 index points against the Northeast.',
      'Biggest move since May: Nantucket, MA, +54.1 index points against the Northeast.',
      'Biggest move since June: Nantucket, MA, +38.9 index points against the Northeast.',
      'Biggest move since July: Nantucket, MA, −5.0 index points against the Northeast.',
      'Biggest move since August: Nantucket, MA, −42.9 index points against the Northeast.',
      'Biggest move since September: Nantucket, MA, −29.4 index points against the Northeast.',
      'Biggest move since October: Nantucket, MA, −48.9 index points against the Northeast.',
      'Biggest move since November: Bar Harbor, ME, −15.0 index points against the Northeast.',
    ]);
    expect(biggestMove(0)).toBeNull();
  });

  test('a tie for the biggest move goes to the first in list order, by size whatever the sign', () => {
    expect(largest([{ id: 'a', delta: 3 }, { id: 'b', delta: -5 }, { id: 'c', delta: 5 }, { id: 'd', delta: 4.9 }])?.id).toBe('b');
    expect(largest([])).toBeNull();
    expect(biggestMove(1)?.town.id).toBe('ithaca-ny');
  });

  test('the value tags are each month’s three biggest movers, larger raw moves first', () => {
    const tags = (month: number): string[] => topMovers(month).map(({ town, delta }) => `${town.name} ${fmtSigned(delta)}`);
    expect(MONTH_NAMES.map((_, month) => tags(month))).toEqual([
      [],
      ['Ithaca +12.4', 'Amherst +4.7', 'State College +4.7'],
      ['Hanover −7.9', 'Middlebury −5.6', 'North Elba −5.3'],
      ['Stowe −17.3', 'Bar Harbor +12.1', 'Nantucket +10.9'],
      ['Nantucket +50.1', 'Bar Harbor +30.2', 'State College −16.5'],
      ['Nantucket +54.1', 'Bar Harbor +37.9', 'Provincetown +32.5'],
      ['Nantucket +38.9', 'North Elba +25.3', 'Provincetown +20.5'],
      ['Nantucket −5.0', 'North Elba −2.9', 'Provincetown −2.4'],
      ['Nantucket −42.9', 'Provincetown −31.0', 'North Elba −25.7'],
      ['Nantucket −29.4', 'Bar Harbor −22.7', 'Provincetown −13.6'],
      ['Nantucket −48.9', 'Bar Harbor −44.5', 'Provincetown −20.3'],
      ['Bar Harbor −15.0', 'Stowe +14.1', 'North Elba +5.9'],
    ]);
  });

  test('job flows: one particle per 4 points, at most 6 a town, none under 1 point', () => {
    const totals = MONTH_NAMES.map((_, month) => mapTowns.reduce((sum, town, index) => sum + (flowOf(index, moveAt(town.series.gap, month))?.points.length ?? 0), 0));
    expect(totals).toEqual([0, 15, 18, 25, 29, 44, 38, 10, 44, 25, 32, 17]);
    for (let month = 0; month < 12; month += 1) {
      for (const [index, town] of mapTowns.entries()) expect(flowOf(index, moveAt(town.series.gap, month))?.points.length ?? 0).toBeLessThanOrEqual(6);
    }
    expect(flowOf(3, 0.99)).toBeNull();
    // Ithaca (third in the list) in February: +12.4, so 4 particles pulling in, 24px out, a quarter turn apart.
    expect(flowOf(2, 12.4)).toEqual({ dir: 'in', points: [{ a: 46, d: 24, j: 0 }, { a: 136, d: 24, j: 1 }, { a: 226, d: 24, j: 2 }, { a: 316, d: 24, j: 3 }] });
    expect(flowOf(0, -50)).toEqual({ dir: 'out', points: Array.from({ length: 6 }, (_, j) => ({ a: j * 60, d: 40, j })) });
  });

  test('with reduced motion a + or − marks each move of 4 points or more', () => {
    const counts = MONTH_NAMES.map((_, month) => mapTowns.filter((town) => glyphOf(moveAt(town.series.gap, month)) !== null).length);
    expect(counts).toEqual([0, 3, 6, 7, 6, 10, 9, 1, 10, 5, 6, 3]);
    expect([glyphOf(4), glyphOf(-4), glyphOf(3.99)]).toEqual(['+', '−', null]);
  });

  test('the Northeast sparkline, the cursor and the rail', () => {
    expect(NE_SPARK_D).toBe('M0 38 L10.91 36.26 L21.82 30.33 L32.73 24.01 L43.64 11.73 L54.55 2 L65.45 7.2 L76.36 8.24 L87.27 13.93 L98.18 18.36 L109.09 22.37 L120 20.87');
    expect(MONTH_NAMES.map((_, month) => cursorX(month))).toEqual([0, 10.91, 21.82, 32.73, 43.64, 54.55, 65.45, 76.36, 87.27, 98.18, 109.09, 120]);
    expect(railFill(0)).toBeCloseTo(1 / 12);
    expect(railFill(11)).toBe(1);
  });

  test('the final step is the widest-spread month, from the data', () => {
    expect(finale()).toEqual({
      title: 'July, the year’s widest spread.',
      line: 'Nantucket County sat 93.5 index points above the Northeast; Centre County, 15.4 below.',
    });
  });

  test('no generated sentence has an en or em dash, or says curve', () => {
    const text = [...MONTH_NAMES.map((_, month) => moveSentence(month)), finale().title, finale().line,
      ...MONTH_NAMES.flatMap((_, month) => [...placeTags(month, 732).values()].map((tag) => tag.text))].join(' ');
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/curve/i);
  });
});

describe('the pinned map', () => {
  test('its size and top, from the story’s width and the scroll container’s height', () => {
    expect(storyBox(1280, 900, true)).toEqual({ mw: 732, mh: 637, top: 57 });
    expect(storyBox(1280, 1080, true)).toEqual({ mw: 939, mh: 817, top: 57 });
    expect(storyBox(910, 768, true)).toEqual({ mw: 580, mh: 505, top: 57 });
    expect(storyBox(1280, 800, true)).toEqual({ mw: 617, mh: 537, top: 57 });
    expect(storyBox(1280, 1400, true)).toEqual({ mw: 940, mh: 818, top: 216 });
    expect(storyBox(358, 844, false)).toEqual({ mw: 358, mh: 311, top: 0 });
    expect(storyBox(704, 1024, false)).toEqual({ mw: 487, mh: 424, top: 0 });
    expect(storyBox(358, 664, false)).toEqual({ mw: 280, mh: 244, top: 0 });
    expect(storyBox(343, 667, false)).toEqual({ mw: 282, mh: 245, top: 0 });
    // A taller legend and caption than budgeted shrink the map so the whole block still fits, centered.
    expect(storyBox(1280, 900, true, 176)).toEqual({ mw: 702, mh: 611, top: 57 });
    // From 1024px the box is centered in the window: its middle is the window's middle, to the half pixel.
    for (const [width, height, extra] of [[1280, 900, 150], [1280, 1080, 150], [1280, 900, 176], [1280, 1400, 150]] as const) {
      const box = storyBox(width, height, true, extra);
      expect(Math.abs(box.top + (box.mh + extra) / 2 - height / 2)).toBeLessThanOrEqual(0.5);
    }
  });

  test('value tags stay inside the map, 4px clear of each other and of the title', () => {
    const clear = (a: Box, b: Box): boolean => !(a[0] < b[2] + 4 && a[2] + 4 > b[0] && a[1] < b[3] + 4 && a[3] + 4 > b[1]);
    const check = (width: number, avoid: readonly Box[]): number => {
      let shown = 0;
      for (let month = 0; month < 12; month += 1) {
        const tags = [...placeTags(month, width, avoid)];
        const movers = topMovers(month);
        // The placed tags are the movers, in their order, with their text.
        expect(tags.map(([id]) => id)).toEqual(movers.map(({ town }) => town.id).filter((id) => tags.some(([placed]) => placed === id)));
        for (const [id, tag] of tags) {
          const move = movers.find(({ town }) => town.id === id);
          expect(tag.text).toBe(`${move?.town.name ?? '?'} ${fmtSigned(move?.delta ?? 0)}`);
          const [left, top, right, bottom] = tag.box;
          expect(left >= 0 && top >= 0 && right <= width && bottom <= width * 0.87).toBe(true);
          for (const other of avoid) expect(clear(tag.box, other)).toBe(true);
          for (const [otherId, other] of tags) if (otherId !== id) expect(clear(tag.box, other.box)).toBe(true);
        }
        shown += tags.length;
      }
      return shown;
    };
    for (const width of [358, 487, 580, 732, 939]) expect(check(width, [])).toBeGreaterThan(20);
    expect(placeTags(0, 732).size).toBe(0);
    expect(placeTags(3, 0).size).toBe(0);
    // Flat and wide, the title reaches over the map's northwest corner: no tag lands on it.
    const title = titleBox(1440, 1280, 732);
    expect(title).toEqual([-548, 0, 118, 392]);
    expect(check(732, [title])).toBeGreaterThan(20);
  });
});
