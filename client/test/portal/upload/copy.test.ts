import { ApiError } from '../../../src/api/client';
import type { ColumnProfile } from '../../../src/portal/upload/columns';
import {
  alreadyHaveLine, badNumberLine, calibrationLine, canCheck, columnOptions, COPY, formatDollars, formatSize, matchMessages,
  moreDaysLine, noDateLine, otherLocationLine, readingLine, repeatedDatesLine, resultLines, rowList, rowsBecameDays,
  sendErrorOf, sendingLine, sendLabel, stepLine,
} from '../../../src/portal/upload/copy';
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

  test('the calibration line (14.1)', () => {
    expect(calibrationLine({ state: 'not_calibrated', dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-02-04' })).toBe(
      'Your sales history is in: 400 days, Jan 1, 2025 to Feb 4, 2026. Calibration isn’t built yet, so there is no forecast.',
    );
    expect(calibrationLine({ state: 'no_sales_data' })).toMatch(/^Upload your sales history to start\./);
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
      { name: 'Date', kind: 'dates', slashDates: false, order: null },
      { name: 'Net Sales', kind: 'numbers', slashDates: false, order: null },
      { name: 'Net Sales', kind: 'numbers', slashDates: false, order: null },
      { name: '', kind: 'empty', slashDates: false, order: null },
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

  test('429 and the network use the shared copy; Try again sends the same days', () => {
    expect(sendErrorOf(http(429, 600))).toEqual({ text: 'Too many attempts. Try again in 10 minutes.', action: 'retry' });
    expect(sendErrorOf(new ApiError('network', 'down'))).toEqual({ text: 'Can’t reach Townwise. Check your connection and try again.', action: 'retry' });
  });
});
