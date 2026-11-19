import { ApiError } from '../../../src/api/client';
import type { ColumnProfile } from '../../../src/portal/upload/columns';
import {
  alreadyHaveLine, badNumberLine, turnedOffLine, calibrationHeading, calibrationLine, canCheck, columnOptions, COPY, dashboardUpdatingLine,
  FIRST_FORECAST_REASONS, firstForecastLine, formatDollars, formatSize, matchMessages, moreDaysLine, noDateLine, notPublishedLine,
  otherLocationLine, readingLine, repeatedDatesLine, resultLines, rowList, rowsBecameDays, sendErrorOf, sendingLine, sendLabel, stepLine,
  updatingLine, uploadUpdatingLine,
} from '../../../src/portal/upload/copy';
import { OWNER_REASONS, type Calibration, type LastRun } from '../../../src/portal/schemas';
import type { Mapping } from '../../../src/portal/upload/days';

// The upload page's words (spec 11.2, P13), by role and by count.

describe('the result by role (11.2 step 4, D16)', () => {
  const upload = { dayCount: 120, inserted: 100, replaced: 20, kept: 0 };

  test('an org admin’s upload replaces by day', () => {
    expect(resultLines('org_admin', 'Main Street Bar', upload)).toEqual(['Saved 120 days for Main Street Bar: 100 new, 20 replaced.']);
    expect(resultLines('org_admin', 'Main Street Bar', { dayCount: 1, inserted: 1, replaced: 0, kept: 0 })).toEqual(['Saved 1 day for Main Street Bar: 1 new, 0 replaced.']);
  });

  test('a member’s upload adds new days only, and says how many it kept', () => {
    expect(resultLines('member', 'Main Street Bar', { dayCount: 1200, inserted: 1180, replaced: 0, kept: 20 })).toEqual([
      'Saved 1,180 new days for Main Street Bar.',
      '20 days already had data. Ask an admin to replace them.',
    ]);
    expect(resultLines('member', 'Main Street Bar', { dayCount: 5, inserted: 5, replaced: 0, kept: 0 })).toEqual(['Saved 5 new days for Main Street Bar.']);
    expect(resultLines('member', 'Main Street Bar', { dayCount: 2, inserted: 1, replaced: 0, kept: 1 })).toEqual([
      'Saved 1 new day for Main Street Bar.',
      '1 day already had data. Ask an admin to replace it.',
    ]);
  });

  test('days the location already has, by role', () => {
    expect(alreadyHaveLine('org_admin', '2025-01-01', '2026-02-04')).toBe('You already have Jan 1, 2025 to Feb 4, 2026. Days in both will be replaced by this file.');
    expect(alreadyHaveLine('member', '2025-01-01', '2026-02-04')).toBe(
      'You already have Jan 1, 2025 to Feb 4, 2026. Days you already have stay as they are. Only an admin can replace them.',
    );
  });

  test('days held by a turned-off upload: an admin’s file replaces them and they show again, a member’s leaves them hidden', () => {
    expect(turnedOffLine('org_admin', 12)).toBe('12 days are held by turned-off uploads. Any of them this file covers will be replaced, and will show again.');
    expect(turnedOffLine('member', 1)).toBe('1 day is held by turned-off uploads. Any of them this file covers stay as they are, and stay hidden.');
  });

  test('the calibration line (14.1)', () => {
    expect(calibrationLine({ state: 'not_calibrated', dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-02-04' })).toBe(
      'Your sales history is in: 400 days, Jan 1, 2025 to Feb 4, 2026.',
    );
    expect(calibrationLine({ state: 'no_sales_data' })).toMatch(/^Upload your sales history to start\./);
  });

  test('the calibration heading (14.1): a published forecast never reads “Not calibrated yet”', () => {
    const history = { dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-11-15' };
    expect(calibrationHeading({ state: 'no_sales_data' })).toBe('Not calibrated yet');
    expect(calibrationHeading({ state: 'not_calibrated', ...history })).toBe('Not calibrated yet');
    expect(calibrationHeading({ state: 'calibrated', ...history, dataThrough: '2026-11-15', newerDays: 0, nextRefresh: '2026-11-23' })).toBe('Forecast published');
    expect(calibrationHeading({ state: 'stale', ...history, dataThrough: '2026-11-08', newerDays: 6, nextRefresh: '2026-11-23' })).toBe(
      'Forecast published, 6 newer days not in it yet',
    );
    expect(calibrationHeading({ state: 'stale', ...history, dataThrough: '2026-11-14', newerDays: 1, nextRefresh: null })).toBe(
      'Forecast published, 1 newer day not in it yet',
    );
  });
});

describe('check the totals', () => {
  test('rows became days', () => {
    expect(rowsBecameDays(1204, 365, '2025-01-01', '2025-12-31')).toBe('1,204 rows became 365 days, Jan 1, 2025 to Dec 31, 2025.');
    expect(rowsBecameDays(1, 1, '2025-01-01', '2025-01-01')).toBe('1 row became 1 day, Jan 1, 2025 to Jan 1, 2025.');
  });

  test('skipped rows list up to 10 row numbers, then how many more', () => {
    expect(rowList({ count: 2, rows: [4, 9] })).toBe('rows 4, 9');
    expect(rowList({ count: 1, rows: [7] })).toBe('row 7');
    expect(rowList({ count: 31, rows: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] })).toBe('rows 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 21 more');
    expect(noDateLine({ count: 2, rows: [4, 9] })).toBe('2 rows had no readable date (rows 4, 9).');
    expect(noDateLine({ count: 1, rows: [4] })).toBe('1 row had no readable date (row 4).');
    expect(badNumberLine({ count: 3, rows: [2, 5, 8] })).toBe('3 rows had a number Townwise couldn’t read (rows 2, 5, 8).');
    expect(otherLocationLine(40)).toBe('40 rows were for other locations.');
    expect(otherLocationLine(1)).toBe('1 row was for another location.');
  });

  test('repeated dates in one-day mode', () => {
    expect(repeatedDatesLine(3, { count: 4, rows: [5, 6, 9, 12] })).toBe('3 dates appear more than once (rows 5, 6, 9, 12). Choose “One check or order”, or fix the file.');
    expect(repeatedDatesLine(1, { count: 1, rows: [5] })).toBe('1 date appears more than once (row 5). Choose “One check or order”, or fix the file.');
  });

  test('left-out days past the first 10', () => {
    expect(moreDaysLine(10)).toBeNull();
    expect(moreDaysLine(14)).toBe('And 4 more.');
  });

  test('money in whole dollars, rounded half up; sizes; the step line and labels', () => {
    expect(formatDollars(149)).toBe('$1');
    expect(formatDollars(150)).toBe('$2');
    expect(formatDollars(123_456_789)).toBe('$1,234,568');
    expect(formatSize(820 * 1024)).toBe('820 KB');
    expect(formatSize(200)).toBe('1 KB');
    expect(formatSize(12.4 * 1024 * 1024)).toBe('12.4 MB');
    expect(readingLine(3 * 1024 * 1024)).toBe('Reading 3.0 MB file…');
    expect(sendingLine(365)).toBe('Sending 365 days…');
    expect(sendLabel(1)).toBe('Send 1 day');
    expect(sendLabel(1204)).toBe('Send 1,204 days');
    expect(stepLine(2)).toBe('Step 2 of 4: Choose a file, Match columns, Check the totals, Send.');
  });
});

describe('match columns', () => {
  const MAPPING: Mapping = { rowMode: 'day', date: 0, guests: 1, netSales: null, location: null, locationValue: null, dateOrder: 'month_first' };

  test('pickers list header names with their kind; repeated and blank names get the column number', () => {
    const columns: ColumnProfile[] = [
      { name: 'Date', kind: 'dates', slashDates: false, order: null, mixedOrder: false },
      { name: 'Net Sales', kind: 'numbers', slashDates: false, order: null, mixedOrder: false },
      { name: 'Net Sales', kind: 'numbers', slashDates: false, order: null, mixedOrder: false },
      { name: '', kind: 'empty', slashDates: false, order: null, mixedOrder: false },
    ];
    expect(columnOptions(columns)).toEqual([
      { value: '0', label: 'Date: dates' },
      { value: '1', label: 'Net Sales (column 2): numbers' },
      { value: '2', label: 'Net Sales (column 3): numbers' },
      { value: '3', label: 'Unnamed (column 4): empty' },
    ]);
  });

  test('the item-level block, the guests-or-net-sales rule, the date and the location value', () => {
    expect(canCheck(matchMessages(MAPPING, 'Main Street Bar'))).toBe(true);
    expect(matchMessages({ ...MAPPING, rowMode: 'item' }, 'X').row).toEqual(['Item-level exports aren’t supported. Export daily totals or checks, not items.']);
    expect(matchMessages({ ...MAPPING, guests: null }, 'X').values).toEqual(['Choose a guests column, a net sales column, or both.']);
    expect(matchMessages({ ...MAPPING, date: null }, 'X').date).toEqual([COPY.chooseDate]);
    expect(matchMessages({ ...MAPPING, location: 3 }, 'Main Street Bar').locationValue).toEqual(['Choose which value is Main Street Bar.']);
    expect(canCheck(matchMessages({ ...MAPPING, rowMode: 'item' }, 'X'))).toBe(false);
    expect(canCheck(matchMessages({ ...MAPPING, location: 3, locationValue: 'Main Street Bar' }, 'Main Street Bar'))).toBe(true);
  });
});

describe('send errors (P13)', () => {
  const http = (status: number, retryAfterSeconds?: number): ApiError => new ApiError('http', 'refused', { status, retryAfterSeconds: retryAfterSeconds ?? null });

  test('400 and 413 are a client bug: the shared request copy, and Try again starts over', () => {
    expect(sendErrorOf(http(400))).toEqual({ text: 'Something went wrong with that request. Reload the page and try again.', action: 'restart' });
    expect(sendErrorOf(http(413)).action).toBe('restart');
  });

  test('500, 503 and a timeout may have half applied: send again', () => {
    for (const error of [http(500), http(503), new ApiError('timeout', 'slow')]) {
      expect(sendErrorOf(error)).toEqual({ text: 'The upload didn’t finish, and some days may have saved. Send again. Days are never duplicated.', action: 'send' });
    }
  });

  test('a 404 means the location is gone: “This location isn’t available.”, with Locations as the way back', () => {
    const missing = new ApiError('http', 'refused', { status: 404, code: 'not_found', retryAfterSeconds: null });
    expect(sendErrorOf(missing)).toEqual({ text: 'This location isn’t available.', action: 'missing' });
  });

  test('429 and the network use the shared copy; Try again sends the same days', () => {
    expect(sendErrorOf(http(429, 600))).toEqual({ text: 'Too many attempts. Try again in 10 minutes.', action: 'retry' });
    expect(sendErrorOf(new ApiError('network', 'down'))).toEqual({ text: 'Can’t reach Townwise. Check your connection and try again.', action: 'retry' });
  });
});

describe('D65: the forecast updating, in each page’s words (design decisions 3 and 4)', () => {
  // Local times, so the words read the same in any time zone the tests run in.
  const now = new Date(2026, 10, 19, 15, 0);
  const since = new Date(2026, 10, 19, 14, 14).toISOString();
  const earlier = new Date(2026, 10, 15, 23, 58).toISOString();
  const history = { dayCount: 1035, firstDate: '2024-01-01', lastDate: '2026-11-15' };
  const running = { stage: 'running', since } as const;
  const waiting = { stage: 'waiting', since } as const;
  const stale = (newerDays: number, updating: Calibration['updating']): Calibration => (
    { state: 'stale', ...history, dataThrough: '2026-11-08', newerDays, nextRefresh: '2026-11-23', updating }
  );
  const calibrated: Calibration = { state: 'calibrated', ...history, dataThrough: '2026-11-15', newerDays: 0, nextRefresh: '2026-11-23', updating: running };
  const first = (updating: Calibration['updating'], lastRun: LastRun | null = null): Calibration => ({ state: 'not_calibrated', ...history, updating, lastRun });

  test('the model card: updating a published forecast, with its new days and when it started', () => {
    expect(updatingLine(stale(6, running), now)).toBe('Updating your forecast with 6 new days, started 2:14 PM.');
    expect(updatingLine(stale(1, running), now)).toBe('Updating your forecast with 1 new day, started 2:14 PM.');
    expect(updatingLine(calibrated, now)).toBe('Updating your forecast, started 2:14 PM.');
    // Started on another day than the viewer's today: the short date too.
    expect(updatingLine(stale(6, { stage: 'running', since: earlier }), now)).toBe('Updating your forecast with 6 new days, started Sun, Nov 15, 11:58 PM.');
  });

  test('the model card: a first forecast building, and next', () => {
    expect(updatingLine(first(running), now)).toBe('Building your first forecast, started 2:14 PM.');
    expect(updatingLine(first(waiting), now)).toBe('Your first forecast is next. Townwise starts building it soon.');
  });

  test('nothing updating, or an API from before D65: no line anywhere', () => {
    for (const calibration of [stale(6, null), first(null), { state: 'no_sales_data' } as const, { state: 'not_calibrated', ...history } as const]) {
      expect(updatingLine(calibration, now)).toBeNull();
      expect(dashboardUpdatingLine(calibration)).toBeNull();
      expect(uploadUpdatingLine(calibration, now)).toBeNull();
      expect(firstForecastLine(calibration, 'Main Street Bar')).toBeNull();
    }
  });

  test('the dashboard’s second line, in plain words', () => {
    expect(dashboardUpdatingLine(stale(6, running))).toBe('Updating now');
    expect(dashboardUpdatingLine(calibrated)).toBe('Updating now');
    expect(dashboardUpdatingLine(first(running))).toBe('Building the first forecast');
    expect(dashboardUpdatingLine(first(waiting))).toBe('First forecast next');
  });

  test('the upload’s result', () => {
    expect(uploadUpdatingLine(stale(6, running), now)).toBe('Townwise is updating the forecast with these days.');
    expect(uploadUpdatingLine(first(running), now)).toBe('Building your first forecast, started 2:14 PM.');
    expect(uploadUpdatingLine(first(waiting), now)).toBe('Townwise starts on the first forecast soon.');
  });

  test('Home’s first-forecast line, only with no published run', () => {
    expect(firstForecastLine(first(running), 'Main Street Bar')).toBe('Building the first forecast for Main Street Bar. Home shows it here once it’s published.');
    expect(firstForecastLine(first(waiting), 'Main Street Bar')).toBe('The first forecast for Main Street Bar is next. Townwise starts building it soon.');
    expect(firstForecastLine(stale(6, running), 'Main Street Bar')).toBeNull();
  });

  test('no waiting sentence says Building, states a time or promises a publish (14.1)', () => {
    const lines = [updatingLine(first(waiting), now), dashboardUpdatingLine(first(waiting)), uploadUpdatingLine(first(waiting), now), firstForecastLine(first(waiting), 'Main Street Bar')];
    for (const line of lines) {
      expect(line).not.toBeNull();
      expect(line).not.toContain('Building');
      expect(line).not.toMatch(/\d|AM|PM/);
      expect(line).not.toMatch(/publish/i);
    }
  });

  test('Home’s notice when a first forecast wasn’t published, with the next step', () => {
    const held: LastRun = { outcome: 'kept', reason: 'not_beat_average', finishedAt: '2026-11-18T09:00:00.000Z' };
    expect(notPublishedLine(first(null, held), 'Main Street Bar')).toEqual({
      text: 'The first forecast for Main Street Bar wasn’t published: it wasn’t more accurate than a simple weekday average.',
      next: 'Townwise tries again after your next sales upload.',
    });
    expect(notPublishedLine(first(null, { outcome: 'not_run', reason: 'failed', finishedAt: '2026-11-18T09:20:00.000Z' }), 'Main Street Bar')).toEqual({
      text: 'The first forecast for Main Street Bar wasn’t published: it couldn’t run.',
      next: 'Townwise tries again after your next sales upload.',
    });
    // Forecasts off: the reason says why, so no next step.
    expect(notPublishedLine(first(null, { ...held, reason: 'forecasts_off' }), 'Main Street Bar')?.next).toBeNull();
    // None while updating, with no last run, from an older API, or when the last run was published (since withdrawn).
    expect(notPublishedLine(first(waiting, held), 'Main Street Bar')).toBeNull();
    expect(notPublishedLine(first(null), 'Main Street Bar')).toBeNull();
    expect(notPublishedLine({ state: 'not_calibrated', ...history }, 'Main Street Bar')).toBeNull();
    expect(notPublishedLine(first(null, { outcome: 'published', reason: 'published', finishedAt: held.finishedAt }), 'Main Street Bar')).toBeNull();
  });

  test('every reason a first forecast wasn’t published has words, none stating a minimum or a kept forecast', () => {
    for (const reason of OWNER_REASONS) {
      if (reason === 'published' || reason === 'published_by_staff') continue;
      const words = FIRST_FORECAST_REASONS[reason];
      expect(words).toMatch(/\.$/);
      expect(words).not.toMatch(/\d|current|didn’t change|tries again/);
    }
  });
});
