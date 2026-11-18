// Live accuracy (spec 14.4), without Docker: WAPE and in-range counts, booked and closed days left out, nothing
// under 5 scored days, misses kept, and a week compared only when all its open days have passed. Synthetic numbers.
import { describe, expect, it } from 'vitest';

import { inRangeOf, liveAccuracy, MIN_SCORED_DAYS, scoredDay, weekActual, type ScoredDay } from '../src/forecasts/score.ts';

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

  it('leaves out a day that was closed or likely closed (spec D32): a closure, not a forecast miss', () => {
    const days = [open('2026-05-01', 100), open('2026-05-02', 100), open('2026-05-03', 100), open('2026-05-04', 100), open('2026-05-05', 110)];
    const likelyClosed: ScoredDay = { ...open('2026-05-06', 1), closed: true };
    expect(liveAccuracy([...days, likelyClosed])).toEqual({ days: 5, inRange: 5, typicalErrorPct: 2, from: '2026-05-01', to: '2026-05-05' });
    expect(liveAccuracy([...days, { ...likelyClosed, closed: false }])).toMatchObject({ days: 6, inRange: 5 });
  });

  it('rounds to one decimal, and has no typical miss when no guests came', () => {
    expect(liveAccuracy([open('a1', 99), open('a2', 100), open('a3', 100), open('a4', 100), open('a5', 100)])?.typicalErrorPct).toBe(0.2);
    expect(liveAccuracy([open('a1', 0), open('a2', 0), open('a3', 0), open('a4', 0), open('a5', 0)])?.typicalErrorPct).toBeNull();
  });

  it('scores a window over days of two runs, each day against its own run’s figures, and each run’s own accuracy is unchanged (D42)', () => {
    // The first 3 days from a run made May 8, the rest from one made May 15 with other figures.
    const older = [open('2026-05-12', 90), open('2026-05-13', 100), open('2026-05-14', 130)];
    const newer: ScoredDay[] = [
      { date: '2026-05-15', status: 'open', low: 160, mid: 200, high: 240, actual: 210 },
      { date: '2026-05-16', status: 'open', low: 160, mid: 200, high: 240, actual: 150 },
      { date: '2026-05-17', status: 'open', low: 160, mid: 200, high: 240, actual: 200 },
    ];
    // |10| + |0| + |30| + |10| + |50| + |0| = 100 over 880 guests; 4 of 6 in their own run's range.
    expect(liveAccuracy([...older, ...newer])).toEqual({ days: 6, inRange: 4, typicalErrorPct: 11.4, from: '2026-05-12', to: '2026-05-17' });
    expect(liveAccuracy(older)).toBeNull();
    expect(liveAccuracy([...newer, open('2026-05-18', 100), open('2026-05-19', 100)])).toMatchObject({ days: 5, inRange: 4 });
  });

  it('scoredDay is the day live accuracy counts: forecast open with a middle and stored guests, not closed or likely closed', () => {
    const booked: ScoredDay = { date: 'b', status: 'booked', low: null, mid: null, high: null, actual: 400 };
    const closed: ScoredDay = { date: 'c', status: 'closed', low: null, mid: null, high: null, actual: 0 };
    expect([
      scoredDay(open('a', 100)), scoredDay(open('a', 0)), scoredDay(open('a', null)), scoredDay({ ...open('a', 100), closed: true }),
      scoredDay(booked), scoredDay(closed), scoredDay({ ...open('a', 100), mid: null }),
    ]).toEqual([true, true, false, false, false, false, false]);
    // Under 5 scored days the window has no accuracy, and its days are still scored.
    const three = [open('2026-05-01', 100), open('2026-05-02', 100), open('2026-05-03', 100)];
    expect(liveAccuracy(three)).toBeNull();
    expect(three.map(scoredDay)).toEqual([true, true, true]);
  });

  it('outlook days are not scored (D52): a stale run’s outlook day keeps its actual but no accuracy counts it', () => {
    const days = [open('2026-05-01', 100), open('2026-05-02', 100), open('2026-05-03', 100), open('2026-05-04', 100), open('2026-05-05', 110)];
    const outlook: ScoredDay = { ...open('2026-05-06', 300), outlook: true };
    expect(scoredDay(outlook)).toBe(false);
    expect(scoredDay({ ...outlook, outlook: false })).toBe(true);
    expect(liveAccuracy([...days, outlook])).toEqual(liveAccuracy(days));
    expect(liveAccuracy([outlook, outlook, outlook, outlook, outlook])).toBeNull();
    // A 91-day run's days carry no outlook, so its accuracy is today's.
    expect(liveAccuracy(days.map((day) => ({ ...day, outlook: false })))).toEqual(liveAccuracy(days));
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
