// Live accuracy (spec 14.4), without Docker: WAPE and in-range counts, booked and closed days left out, nothing
// under 5 scored days, misses kept, and a week compared only when all its open days have passed. Synthetic numbers.
import { describe, expect, it } from 'vitest';

import { inRangeOf, liveAccuracy, MIN_SCORED_DAYS, weekActual, type ScoredDay } from '../src/forecasts/score.ts';

function open(date: string, actual: number | null): ScoredDay {
  return { date, status: 'open', low: 80, mid: 100, high: 120, actual };
}

describe('live accuracy', () => {
  it('scores open days with an actual: in range, and the typical miss as WAPE, misses included', () => {
    const days = [open('2026-05-05', 100), open('2026-05-01', 110), open('2026-05-02', 150), open('2026-05-03', 90), open('2026-05-04', 50)];
    // |0| + |10| + |50| + |-10| + |-50| = 120 over 500 guests.
    expect(liveAccuracy(days)).toEqual({ days: 5, inRange: 3, typicalErrorPct: 24, from: '2026-05-01', to: '2026-05-05' });
  });

  it('leaves out booked and closed days and days with no actual', () => {
    const days = [
      open('2026-05-01', 100), open('2026-05-02', 100), open('2026-05-03', 100), open('2026-05-04', 100),
      { date: '2026-05-05', status: 'booked', low: null, mid: null, high: null, actual: 400 } satisfies ScoredDay,
      { date: '2026-05-06', status: 'closed', low: null, mid: null, high: null, actual: 0 } satisfies ScoredDay,
      open('2026-05-07', null),
    ];
    expect(liveAccuracy(days)).toBeNull();
    expect(liveAccuracy([...days, open('2026-05-08', 120)])).toMatchObject({ days: MIN_SCORED_DAYS, inRange: 5 });
  });

  it('rounds to one decimal, and has no typical miss when no guests came', () => {
    expect(liveAccuracy([open('a1', 99), open('a2', 100), open('a3', 100), open('a4', 100), open('a5', 100)])?.typicalErrorPct).toBe(0.2);
    expect(liveAccuracy([open('a1', 0), open('a2', 0), open('a3', 0), open('a4', 0), open('a5', 0)])?.typicalErrorPct).toBeNull();
  });

  it('counts a day in range at either end of it', () => {
    expect([inRangeOf(80, 80, 120), inRangeOf(120, 80, 120), inRangeOf(79, 80, 120), inRangeOf(null, 80, 120)]).toEqual([true, true, false, null]);
  });
});

describe('a week’s actual', () => {
  it('sums the open days only once every one has passed, and never for a week with a booked day', () => {
    const closed: ScoredDay = { date: 'c', status: 'closed', low: null, mid: null, high: null, actual: null };
    expect(weekActual([open('a', 100), open('b', 90), closed])).toBe(190);
    expect(weekActual([open('a', 100), open('b', null)])).toBeNull();
    expect(weekActual([open('a', 100), { date: 'b', status: 'booked', low: null, mid: null, high: null, actual: 300 }])).toBeNull();
    expect(weekActual([closed])).toBeNull();
  });
});
