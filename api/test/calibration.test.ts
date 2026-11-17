// The derived calibration state (spec 14.1, 14.3, D42): no_sales_data and not_calibrated from the location's days, and
// calibrated or stale once a run is published, from that run's last day of data and the days with guests since. Pure;
// every date is synthetic.
import { describe, expect, it } from 'vitest';

import { calibrationOf, calibrationWords, nextRefreshOf } from '../src/calibration.ts';
import type { Coverage } from '../src/stores/sales-days.ts';

const COVERAGE: Coverage = {
  dayCount: 300, guestsDayCount: 300, netSalesDayCount: 300, firstDate: '2026-01-26', lastDate: '2026-11-21', missingDays: 0,
};
const NONE: Coverage = { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 };
const HISTORY = { dayCount: 300, firstDate: '2026-01-26', lastDate: '2026-11-21' };

describe('calibrationOf', () => {
  it('no sales data, and days with no published run, are as before', () => {
    expect(calibrationOf(NONE)).toEqual({ state: 'no_sales_data' });
    expect(calibrationOf(NONE, { dataThrough: '2026-11-15', newerDays: 0 }, '2026-11-23')).toEqual({ state: 'no_sales_data' });
    expect(calibrationOf(COVERAGE)).toEqual({ state: 'not_calibrated', ...HISTORY });
    expect(calibrationOf(COVERAGE, null, '2026-11-23')).toEqual({ state: 'not_calibrated', ...HISTORY });
  });

  it('new days after the run: stale, with the days since and the Monday the weekly refresh refits it', () => {
    // The run's data ends Sun, Nov 15; the owner uploaded Nov 16 to 21
    expect(calibrationOf(COVERAGE, { dataThrough: '2026-11-15', newerDays: 6 }, '2026-11-23')).toEqual({
      state: 'stale', ...HISTORY, dataThrough: '2026-11-15', newerDays: 6, nextRefresh: '2026-11-23',
    });
  });

  it('the lab off: stale with no next refresh', () => {
    expect(calibrationOf(COVERAGE, { dataThrough: '2026-11-15', newerDays: 6 }, null)).toMatchObject({ state: 'stale', nextRefresh: null });
  });

  it('up to date: the run’s last day of data is the last day with guests', () => {
    expect(calibrationOf(COVERAGE, { dataThrough: '2026-11-21', newerDays: 0 }, '2026-11-23')).toEqual({
      state: 'calibrated', ...HISTORY, dataThrough: '2026-11-21', newerDays: 0, nextRefresh: '2026-11-23',
    });
  });
});

describe('nextRefreshOf', () => {
  it('is the first Monday after the town’s today while the refresh is on, and null while it is off', () => {
    expect(nextRefreshOf('2026-11-21', true)).toBe('2026-11-23'); // a Saturday
    expect(nextRefreshOf('2026-11-22', true)).toBe('2026-11-23'); // a Sunday
    expect(nextRefreshOf('2026-11-23', true)).toBe('2026-11-30'); // a Monday: the next one
    expect(nextRefreshOf('2026-12-29', true)).toBe('2027-01-04');
    expect(nextRefreshOf('2026-11-21', false)).toBeNull();
  });
});

describe('calibrationWords', () => {
  it('words a stale location by when Townwise refits it, or says the days aren’t in it yet', () => {
    const stale = calibrationOf(COVERAGE, { dataThrough: '2026-11-15', newerDays: 6 }, '2026-11-23');
    expect(calibrationWords(stale)).toBe('Forecast made from your sales through Sun, Nov 15. Townwise refits on Mon, Nov 23 with the 6 days since.');
    const off = calibrationOf(COVERAGE, { dataThrough: '2026-11-15', newerDays: 6 }, null);
    expect(calibrationWords(off)).toBe('Forecast made from your sales through Sun, Nov 15. The 6 days since aren’t in it yet.');
    const one = calibrationOf(COVERAGE, { dataThrough: '2026-11-20', newerDays: 1 }, null);
    expect(calibrationWords(one)).toBe('Forecast made from your sales through Fri, Nov 20. The 1 day since isn’t in it yet.');
  });

  it('has no words for the other states', () => {
    expect(calibrationWords(calibrationOf(NONE))).toBeNull();
    expect(calibrationWords(calibrationOf(COVERAGE))).toBeNull();
    expect(calibrationWords(calibrationOf(COVERAGE, { dataThrough: '2026-11-21', newerDays: 0 }, '2026-11-23'))).toBeNull();
  });
});
