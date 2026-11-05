import {
  calendarDate, centsOf, MICROS, provenOrder, readAmount, readDateCell, readGuests, resolveDate, type DateCell,
} from '../../../src/portal/upload/values';

// Dates and numbers in a cell (spec 11.2 steps 2 and 3).

function cellOf(raw: string): DateCell {
  const cell = readDateCell(raw);
  if (cell === null) throw new Error(`not a date: ${raw}`);
  return cell;
}

function dateOf(raw: string, order: 'month_first' | 'day_first' = 'month_first'): string | null {
  const cell = readDateCell(raw);
  return cell === null ? null : resolveDate(cell, order);
}

describe('date formats', () => {
  test.each([
    ['2025-03-04', '2025-03-04'],
    ['20250304', '2025-03-04'],
    ['3/4/2025', '2025-03-04'],
    ['03/04/2025', '2025-03-04'],
    ['3/4/25', '2025-03-04'],
    [' 2025-03-04 ', '2025-03-04'],
  ])('%s reads as %s (month first)', (raw, date) => {
    expect(dateOf(raw)).toBe(date);
  });

  test.each([
    ['2025-03-04 23:15', '2025-03-04'],
    ['20250304 01:05:09', '2025-03-04'],
    ['3/4/2025 1:05 AM', '2025-03-04'],
    ['3/4/2025 1:05pm', '2025-03-04'],
    ['3/4/25 13:05:22.250', '2025-03-04'],
    ['3/4/2025  10:30 p.m.', '2025-03-04'],
  ])('a time after a space is ignored: %s', (raw, date) => {
    expect(dateOf(raw)).toBe(date);
  });

  test.each([
    'March 4, 2025', '2025/03/04', '3-4-2025', '2025-3-4', '2025-03-04T10:00:00', '2025-03-04 noon', '3/4', '', 'Total',
    '2025-02-30', '2025-13-01', '2023-02-29', '13/13/2025', '0/4/2025',
  ])('%s is not a readable date', (raw) => {
    expect(dateOf(raw)).toBeNull();
  });

  test('two-digit years are 20YY; leap days are real only in leap years', () => {
    expect(dateOf('12/31/09')).toBe('2009-12-31');
    expect(dateOf('2/29/24')).toBe('2024-02-29');
    expect(dateOf('2/29/2023')).toBeNull();
  });

  test('calendarDate checks the month and the day', () => {
    expect(calendarDate(2025, 4, 30)).toBe('2025-04-30');
    expect(calendarDate(2025, 4, 31)).toBeNull();
    expect(calendarDate(2025, 0, 1)).toBeNull();
  });
});

describe('month and day order', () => {
  test('03/04/2025 is March 4 month first and April 3 day first', () => {
    expect(dateOf('03/04/2025', 'month_first')).toBe('2025-03-04');
    expect(dateOf('03/04/2025', 'day_first')).toBe('2025-04-03');
  });

  test('a full date reads the same in either order', () => {
    expect(dateOf('2025-03-04', 'day_first')).toBe('2025-03-04');
    expect(dateOf('20250304', 'day_first')).toBe('2025-03-04');
  });

  test('a first part above 12 proves day first, a second part above 12 proves month first', () => {
    expect(provenOrder(cellOf('13/02/2025'))).toBe('day_first');
    expect(provenOrder(cellOf('31/12/2025'))).toBe('day_first');
    expect(provenOrder(cellOf('02/13/2025'))).toBe('month_first');
    expect(provenOrder(cellOf('03/04/2025'))).toBeNull();
    expect(provenOrder(cellOf('2025-03-04'))).toBeNull();
  });

  test('a slash date that only one order makes real is unreadable in the other', () => {
    expect(dateOf('13/02/2025', 'month_first')).toBeNull();
    expect(dateOf('13/02/2025', 'day_first')).toBe('2025-02-13');
  });
});

describe('numbers', () => {
  test.each<[string, number]>([
    ['1234', 1234],
    ['$1,234.56', 1234.56],
    ['1,234,567.8', 1234567.8],
    [' 12 ', 12],
    ['1 234', 1234],
    ['1\u00A0234', 1234],
    ['$0.5', 0.5],
    ['.25', 0.25],
    ['12.', 12],
    ['0', 0],
  ])('%s reads as %d', (raw, value) => {
    expect(readAmount(raw)).toBe(Math.round(value * MICROS));
  });

  test.each<[string, number]>([
    ['(12.50)', -12.5],
    ['($1,200.00)', -1200],
    ['-12.5', -12.5],
    ['\u221212.5', -12.5],
    ['-$12', -12],
    ['$-12', -12],
    ['\u2212$3.10', -3.1],
  ])('parentheses or a leading minus mean negative: %s', (raw, value) => {
    expect(readAmount(raw)).toBe(Math.round(value * MICROS));
  });

  test('an empty cell has no value', () => {
    expect(readAmount('')).toBeNull();
    expect(readAmount('   ')).toBeNull();
  });

  test.each(['12,50', '1.234,56', '1,23', '1,2345', 'abc', '$', '-', '.', '(-12)', '12-', '1e3', '+12', '12%', '\u20AC12', '$$12', '(12'])(
    '%s is a number Townwise can’t read',
    (raw) => {
      expect(Number.isNaN(readAmount(raw))).toBe(true);
    },
  );

  test('read with a comma for decimals, dots group thousands', () => {
    expect(readAmount('1.234,50', ',')).toBe(1234.5 * MICROS);
    expect(readAmount('12,50', ',')).toBe(12.5 * MICROS);
    expect(readAmount('1.234', ',')).toBe(1234 * MICROS);
    expect(readAmount('(1.234,50)', ',')).toBe(-1234.5 * MICROS);
    expect(Number.isNaN(readAmount('980.00', ','))).toBe(true);
    expect(Number.isNaN(readAmount('1,234.50', ','))).toBe(true);
  });

  test('amounts are exact in millionths, so sums do not drift', () => {
    const sum = (readAmount('0.1') ?? 0) + (readAmount('0.2') ?? 0);
    expect(sum).toBe(300_000);
    expect(centsOf(sum)).toBe(30);
  });

  test('more than six decimal places round half up once, in the cell', () => {
    expect(readAmount('0.0000005')).toBe(1);
    expect(readAmount('0.0000004')).toBe(0);
  });

  test('guests must be whole numbers', () => {
    expect(readGuests('12')).toBe(12);
    expect(readGuests('1,200')).toBe(1200);
    expect(readGuests('12.0')).toBe(12);
    expect(readGuests('(3)')).toBe(-3);
    expect(readGuests('')).toBeNull();
    expect(Number.isNaN(readGuests('12.5'))).toBe(true);
    expect(Number.isNaN(readGuests('twelve'))).toBe(true);
  });

  test('cents round half up', () => {
    expect(centsOf(readAmount('1.005') ?? 0)).toBe(101);
    expect(centsOf(readAmount('1.0049') ?? 0)).toBe(100);
    expect(centsOf(readAmount('0.005') ?? 0)).toBe(1);
    expect(centsOf(readAmount('1000000') ?? 0)).toBe(100_000_000);
  });
});
