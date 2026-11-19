// The derived calibration state (spec 14.1, 14.3, D42): no_sales_data and not_calibrated from the location's days, and
// calibrated or stale once a run is published, from that run's last day of data and the days with guests since. D65:
// `updating` beside the state (a live calibration inside its 20 minutes; a first forecast the hourly pass will start,
// by its own predicate), `lastRun` on not_calibrated, and the updating sentences. Pure; every date is synthetic.
import { describe, expect, it } from 'vitest';

import { calibrationOf, calibrationWords, lastRunOf, nextRefreshOf, updatingOf, type Updating } from '../src/calibration.ts';
import type { RefitState } from '../src/stores/locations.ts';
import type { Coverage } from '../src/stores/sales-days.ts';
import { calibrationRecord as record } from './helpers/calibration-record.ts';

const COVERAGE: Coverage = {
  dayCount: 300, guestsDayCount: 300, netSalesDayCount: 300, firstDate: '2026-01-26', lastDate: '2026-11-21', missingDays: 0,
};
const NONE: Coverage = { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 };
const HISTORY = { dayCount: 300, firstDate: '2026-01-26', lastDate: '2026-11-21' };
/** Mon, Nov 23, 2:20 PM in Hanover (EST). */
const NOW = new Date('2026-11-23T19:20:00.000Z');
const ZONE = 'America/New_York';
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('calibrationOf', () => {
  it('no sales data, and days with no published run, are as before', () => {
    expect(calibrationOf(NONE)).toEqual({ state: 'no_sales_data', updating: null });
    expect(calibrationOf(NONE, { dataThrough: '2026-11-15', newerDays: 0 }, '2026-11-23')).toEqual({ state: 'no_sales_data', updating: null });
    expect(calibrationOf(COVERAGE)).toEqual({ state: 'not_calibrated', ...HISTORY, updating: null, lastRun: null });
    expect(calibrationOf(COVERAGE, null, '2026-11-23')).toEqual({ state: 'not_calibrated', ...HISTORY, updating: null, lastRun: null });
  });

  it('new days after the run: stale, with the days since and the Monday the weekly refresh refits it', () => {
    // The run's data ends Sun, Nov 15; the owner uploaded Nov 16 to 21
    expect(calibrationOf(COVERAGE, { dataThrough: '2026-11-15', newerDays: 6 }, '2026-11-23')).toEqual({
      state: 'stale', ...HISTORY, dataThrough: '2026-11-15', newerDays: 6, nextRefresh: '2026-11-23', updating: null,
    });
  });

  it('the lab off: stale with no next refresh', () => {
    expect(calibrationOf(COVERAGE, { dataThrough: '2026-11-15', newerDays: 6 }, null)).toMatchObject({ state: 'stale', nextRefresh: null });
  });

  it('up to date: the run’s last day of data is the last day with guests', () => {
    expect(calibrationOf(COVERAGE, { dataThrough: '2026-11-21', newerDays: 0 }, '2026-11-23')).toEqual({
      state: 'calibrated', ...HISTORY, dataThrough: '2026-11-21', newerDays: 0, nextRefresh: '2026-11-23', updating: null,
    });
  });
});

describe('nextRefreshOf', () => {
  const NOON = 12 * 60;
  it('is the first Monday after the town’s today while the refresh is on, and null while it is off', () => {
    expect(nextRefreshOf('2026-11-21', NOON, true)).toBe('2026-11-23'); // a Saturday
    expect(nextRefreshOf('2026-11-22', NOON, true)).toBe('2026-11-23'); // a Sunday
    expect(nextRefreshOf('2026-11-23', NOON, true)).toBe('2026-11-30'); // a Monday after 03:00: the next one
    expect(nextRefreshOf('2026-12-29', NOON, true)).toBe('2027-01-04');
    expect(nextRefreshOf('2026-11-21', NOON, false)).toBeNull();
  });

  it('on a Monday before 03:00 in the town it is that day, whose pass has not had its turn', () => {
    expect(nextRefreshOf('2026-11-23', 90, true)).toBe('2026-11-23'); // 01:30
    expect(nextRefreshOf('2026-11-23', 179, true)).toBe('2026-11-23'); // 02:59
    expect(nextRefreshOf('2026-11-23', 180, true)).toBe('2026-11-30'); // 03:00
    expect(nextRefreshOf('2026-11-23', 90, false)).toBeNull();
  });
});

describe('calibrationWords', () => {
  it('words a stale location by when Townwise refits it, or says the days aren’t in it yet', () => {
    const stale = calibrationOf(COVERAGE, { dataThrough: '2026-11-15', newerDays: 6 }, '2026-11-23');
    expect(calibrationWords(stale, ZONE, NOW)).toBe('Forecast made from your sales through Sun, Nov 15. Townwise refits on Mon, Nov 23 with the 6 days since.');
    const off = calibrationOf(COVERAGE, { dataThrough: '2026-11-15', newerDays: 6 }, null);
    expect(calibrationWords(off, ZONE, NOW)).toBe('Forecast made from your sales through Sun, Nov 15. The 6 days since aren’t in it yet.');
    const one = calibrationOf(COVERAGE, { dataThrough: '2026-11-20', newerDays: 1 }, null);
    expect(calibrationWords(one, ZONE, NOW)).toBe('Forecast made from your sales through Fri, Nov 20. The 1 day since isn’t in it yet.');
  });

  it('has no words for the other states', () => {
    expect(calibrationWords(calibrationOf(NONE), ZONE, NOW)).toBeNull();
    expect(calibrationWords(calibrationOf(COVERAGE), ZONE, NOW)).toBeNull();
    expect(calibrationWords(calibrationOf(COVERAGE, { dataThrough: '2026-11-21', newerDays: 0 }, '2026-11-23'), ZONE, NOW)).toBeNull();
  });

  const RUNNING: Updating = { stage: 'running', since: '2026-11-23T19:14:00.000Z' };

  it('words a running refit with the new days and its start in the town’s time (D65)', () => {
    const calibrated = calibrationOf(COVERAGE, { dataThrough: '2026-11-21', newerDays: 0 }, '2026-11-30', RUNNING);
    expect(calibrationWords(calibrated, ZONE, NOW)).toBe('Updating your forecast, started 2:14 PM.');
    const one = calibrationOf(COVERAGE, { dataThrough: '2026-11-20', newerDays: 1 }, '2026-11-30', RUNNING);
    expect(calibrationWords(one, ZONE, NOW)).toBe('Forecast made from your sales through Fri, Nov 20. Townwise refits on Mon, Nov 30 with the 1 day since. Updating your forecast with 1 new day, started 2:14 PM.');
    const stale = calibrationOf(COVERAGE, { dataThrough: '2026-11-15', newerDays: 6 }, null, RUNNING);
    expect(calibrationWords(stale, ZONE, NOW)).toBe('Forecast made from your sales through Sun, Nov 15. The 6 days since aren’t in it yet. Updating your forecast with 6 new days, started 2:14 PM.');
  });

  it('words a running first forecast with its days, and adds the date when it started on another day (D65)', () => {
    const first = calibrationOf({ ...COVERAGE, dayCount: 1041 }, null, null, RUNNING);
    expect(calibrationWords(first, ZONE, NOW)).toBe('Building your first forecast from 1,041 days, started 2:14 PM.');
    const lastNight = calibrationOf(COVERAGE, null, null, { stage: 'running', since: '2026-11-16T04:58:00.000Z' });
    expect(calibrationWords(lastNight, ZONE, new Date('2026-11-16T05:10:00.000Z'))).toBe('Building your first forecast from 300 days, started Sun, Nov 15, 11:58 PM.');
  });

  it('words a waiting first forecast with no time, no “Building” and no promise of a publish (D65)', () => {
    const words = calibrationWords(calibrationOf(COVERAGE, null, null, { stage: 'waiting', since: '2026-11-23T19:00:00.000Z' }), ZONE, NOW);
    expect(words).toBe('Your first forecast is next. Townwise starts building it soon.');
    expect(words).not.toMatch(/Building|\d|publish/);
  });
});

describe('updatingOf (D65)', () => {
  const live = (minutes: number, status: 'queued' | 'running' = 'running') =>
    record({ status, requestedAt: ago(minutes * MINUTE), finishedAt: null });
  const MARK: RefitState = { wantedAt: ago(5 * MINUTE), startedAt: null, causes: ['sales'] };
  const NO_MARK: RefitState = { wantedAt: null, startedAt: null, causes: [] };
  const held = record({ status: 'succeeded', runId: 'r1', gate: { published: false, reason: 'baseline_not_beaten' } });

  it('running: a queued or running calibration inside its 20 minutes, since its request, published run or not', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(updatingOf(live(6, status), null, null, true, false, NOW)).toEqual({ stage: 'running', since: ago(6 * MINUTE).toISOString() });
      expect(updatingOf(live(6, status), MARK, null, false, true, NOW)).toEqual({ stage: 'running', since: ago(6 * MINUTE).toISOString() });
    }
  });

  it('the 20-minute edge both ways: at 19 minutes running, at 20 and 21 not', () => {
    expect(updatingOf(live(19), null, null, true, false, NOW)?.stage).toBe('running');
    expect(updatingOf(live(20), null, null, true, false, NOW)).toBeNull();
    expect(updatingOf(live(21), null, null, true, false, NOW)).toBeNull();
  });

  it('a finished newest calibration is not running', () => {
    expect(updatingOf(record({ requestedAt: ago(MINUTE), finishedAt: ago(0) }), null, null, true, false, NOW)).toBeNull();
  });

  it('waiting: no published run, a due mark, no reference and the pass on, since the mark', () => {
    expect(updatingOf(null, MARK, null, false, true, NOW)).toEqual({ stage: 'waiting', since: ago(5 * MINUTE).toISOString() });
    // A timed-out first try does not hold it: the pass fails that one and goes on.
    expect(updatingOf(live(25), MARK, null, false, true, NOW)?.stage).toBe('waiting');
  });

  it('waiting only without a published run', () => {
    expect(updatingOf(null, MARK, null, true, true, NOW)).toBeNull();
  });

  it('waiting needs the pass on (lab, weekly forecasts, schedule, organization, the 230 days)', () => {
    expect(updatingOf(null, MARK, null, false, false, NOW)).toBeNull();
  });

  it('waiting needs a mark', () => {
    expect(updatingOf(null, NO_MARK, null, false, true, NOW)).toBeNull();
    expect(updatingOf(null, null, null, false, true, NOW)).toBeNull();
  });

  it('waiting is null when the last start was 3 hours ago and the mark was set again', () => {
    expect(updatingOf(record({ status: 'failed', failure: 'job_failed' }), { ...MARK, startedAt: ago(3 * HOUR) }, null, false, true, NOW)).toBeNull();
  });

  it('waiting is null after a refused start within the day (the pass records the try with no calibration)', () => {
    expect(updatingOf(null, { ...MARK, startedAt: ago(23 * HOUR) }, null, false, true, NOW)).toBeNull();
  });

  it('waiting at exactly 24 hours after a start, as the pass takes it', () => {
    expect(updatingOf(null, { ...MARK, startedAt: ago(24 * HOUR) }, null, false, true, NOW)?.stage).toBe('waiting');
  });

  it('waiting is null when a held first run exists (the reference)', () => {
    expect(updatingOf(held, MARK, held, false, true, NOW)).toBeNull();
  });

  it('null on no_sales_data, whatever is live', () => {
    expect(calibrationOf(NONE, null, null, updatingOf(live(6), null, null, false, false, NOW))).toEqual({ state: 'no_sales_data', updating: null });
  });
});

describe('lastRunOf (D65)', () => {
  it('a held first run reads kept with its owner reason, dated when it finished', () => {
    const held = record({ runId: 'r1', gate: { published: false, reason: 'baseline_not_beaten' } });
    expect(lastRunOf(held, { status: 'draft', publishedAt: null, publishedBy: null }, null, NOW))
      .toEqual({ outcome: 'kept', reason: 'not_beat_average', finishedAt: '2026-11-23T08:16:00.000Z' });
  });

  it('a failed first run reads not_run', () => {
    expect(lastRunOf(record({ status: 'failed', failure: 'job_failed' }), null, null, NOW))
      .toEqual({ outcome: 'not_run', reason: 'failed', finishedAt: '2026-11-23T08:16:00.000Z' });
  });

  it('a timed-out one, still stored live, reads not_run, failed, dated its request plus 20 minutes', () => {
    const stuck = record({ status: 'running', requestedAt: ago(30 * MINUTE), finishedAt: null });
    expect(lastRunOf(stuck, null, null, NOW)).toEqual({ outcome: 'not_run', reason: 'failed', finishedAt: ago(10 * MINUTE).toISOString() });
  });

  it('null while updating, and with no calibration', () => {
    const failed = record({ status: 'failed', failure: 'job_failed' });
    expect(lastRunOf(failed, null, { stage: 'waiting', since: NOW.toISOString() }, NOW)).toBeNull();
    expect(lastRunOf(record({ status: 'queued', requestedAt: ago(MINUTE), finishedAt: null }), null, null, NOW)).toBeNull();
    expect(lastRunOf(null, null, null, NOW)).toBeNull();
  });
});
