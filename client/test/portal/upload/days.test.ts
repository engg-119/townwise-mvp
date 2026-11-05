import { detectDelimiter, parseCsv } from '../../../src/portal/upload/csv';
import {
  bodyBytes, DayAggregator, exclusionOf, latestDate, MAX_BODY_BYTES, MAX_DAYS, totalsOf, uploadBody, type CheckResult,
  type DaysResult, type Mapping, type SalesDay,
} from '../../../src/portal/upload/days';

// Check the totals (spec 11.2 step 3, 11.3): rows become days, skipped rows and left-out days, and the request body
// of 11.1. Every file here is synthetic.

const LATEST = '2026-11-05';
const MAPPING: Mapping = { rowMode: 'day', date: 0, guests: 1, netSales: 2, location: null, locationValue: null, dateOrder: 'month_first' };

function check(text: string, mapping: Partial<Mapping> = {}): CheckResult {
  const [, ...rows] = parseCsv(text);
  const days = new DayAggregator({ ...MAPPING, ...mapping }, LATEST, detectDelimiter(text));
  rows.forEach((row, index) => { days.add(row, index + 2); });
  return days.finish();
}

function daysOf(text: string, mapping: Partial<Mapping> = {}): DaysResult {
  const result = check(text, mapping);
  if (result.kind !== 'days') throw new Error(`expected days, got ${result.kind}`);
  return result;
}

describe('one row is one day', () => {
  test('each row becomes its day, oldest first, with guests and net sales in cents', () => {
    const result = daysOf('Date,Guests,Net\n2025-03-05,90,"$1,204.50"\n2025-03-04,120,980\n');
    expect(result.days).toEqual([
      { date: '2025-03-04', guests: 120, netSalesCents: 98_000 },
      { date: '2025-03-05', guests: 90, netSalesCents: 120_450 },
    ]);
    expect(result.rows).toBe(2);
  });

  test('an empty cell is no value for that day', () => {
    expect(daysOf('Date,Guests,Net\n2025-03-04,,12\n2025-03-05,7,').days).toEqual([
      { date: '2025-03-04', guests: null, netSalesCents: 1200 },
      { date: '2025-03-05', guests: 7, netSalesCents: null },
    ]);
  });

  test('an unmapped column sends null for every day', () => {
    expect(daysOf('Date,Guests,Net\n2025-03-04,5,12', { guests: null }).days).toEqual([{ date: '2025-03-04', guests: null, netSalesCents: 1200 }]);
  });

  test('a repeated date is an error that counts the dates and lists the repeating rows, up to 10', () => {
    const lines = ['Date,Guests,Net'];
    for (let i = 0; i < 15; i += 1) lines.push('2025-03-04,1,1');
    lines.push('2025-03-05,1,1', '2025-03-05,1,1');
    const result = check(lines.join('\n'));
    expect(result).toEqual({ kind: 'repeated_dates', dates: 2, repeats: { count: 15, rows: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } });
  });

  test('day first reads slash dates the other way', () => {
    expect(daysOf('Date,Guests,Net\n03/04/2025,5,1', { dateOrder: 'day_first' }).days[0]?.date).toBe('2025-04-03');
  });
});

describe('one row is one check or order', () => {
  test('rows that share a date are added up', () => {
    const result = daysOf('Date,Guests,Net\n2025-03-04,2,10.25\n2025-03-04 23:50,3,4.75\n2025-03-05,4,1\n', { rowMode: 'check' });
    expect(result.days).toEqual([
      { date: '2025-03-04', guests: 5, netSalesCents: 1500 },
      { date: '2025-03-05', guests: 4, netSalesCents: 100 },
    ]);
    expect(result.rows).toBe(3);
  });

  test('net sales round half up once per day, not per row', () => {
    // Per row, 0.335 would round to 0.34 three times (102 cents); the day's 1.005 rounds to 101.
    expect(daysOf('Date,Guests,Net\n2025-03-04,1,0.335\n2025-03-04,1,0.335\n2025-03-04,1,0.335', { rowMode: 'check' }).days[0]?.netSalesCents).toBe(101);
  });

  test('refunds net out: parentheses and minus signs subtract', () => {
    const day = daysOf('Date,Guests,Net\n2025-03-04,4,100\n2025-03-04,,(20.00)\n2025-03-04,-1,-$5', { rowMode: 'check' }).days[0];
    expect(day).toEqual({ date: '2025-03-04', guests: 3, netSalesCents: 7500 });
  });

  test('a day whose rows all have empty guests has no guest count', () => {
    expect(daysOf('Date,Guests,Net\n2025-03-04,,1\n2025-03-04,,2', { rowMode: 'check' }).days[0]?.guests).toBeNull();
  });
});

describe('skipped rows, with row numbers and never a value', () => {
  test('no readable date: counted, with the first 10 row numbers', () => {
    const lines = ['Date,Guests,Net', '2025-03-04,1,1'];
    for (let i = 0; i < 12; i += 1) lines.push('Total,1,1');
    const result = daysOf(lines.join('\n'));
    expect(result.noDate).toEqual({ count: 12, rows: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
    expect(result.days).toHaveLength(1);
  });

  test('a number Townwise can’t read, or a guest count that isn’t whole, skips the row', () => {
    const result = daysOf('Date,Guests,Net\n2025-03-04,1,1\n2025-03-05,2.5,1\n2025-03-06,1,"12,50"\n2025-03-07,1,1');
    expect(result.badNumber).toEqual({ count: 2, rows: [3, 4] });
    expect(result.days.map((day) => day.date)).toEqual(['2025-03-04', '2025-03-07']);
  });

  test('rows for other locations are counted, without a list', () => {
    const text = 'Date,Location,Guests,Net\n2025-03-04,Main Street Bar,1,1\n2025-03-04, River Grill ,1,1\n2025-03-05, Main Street Bar ,2,2\nnot a date,River Grill,1,1';
    const result = daysOf(text, { date: 0, location: 1, locationValue: 'Main Street Bar', guests: 2, netSales: 3 });
    expect(result.otherLocation).toBe(2);
    expect(result.noDate.count).toBe(0);
    expect(result.days.map((day) => day.date)).toEqual(['2025-03-04', '2025-03-05']);
  });

  test('blank rows are ignored without counting', () => {
    const result = daysOf('Date,Guests,Net\n\n2025-03-04,1,1\n,,\n');
    expect(result.days).toHaveLength(1);
    expect(result.noDate.count).toBe(0);
  });

  test('no row with a readable date is its own error', () => {
    expect(check('Date,Guests,Net\nTotal,1,1\nx,2,2')).toEqual({ kind: 'no_dates' });
    expect(check('Date,Location,Guests,Net\n2025-03-04,River Grill,1,1', { location: 1, locationValue: 'Main Street Bar', guests: 2, netSales: 3 })).toEqual({ kind: 'no_dates' });
  });

  test('readable dates whose numbers are all unreadable leave nothing to send, not a date error', () => {
    const result = daysOf('Date,Guests,Net\n2025-03-04,x,1');
    expect(result.days).toEqual([]);
    expect(result.badNumber.count).toBe(1);
  });
});

describe('days left out (the rules of 11.3)', () => {
  test.each<[SalesDay, string | null]>([
    [{ date: '2026-11-06', guests: 1, netSalesCents: 1 }, 'after_tomorrow'],
    [{ date: '2026-11-05', guests: 1, netSalesCents: 1 }, null],
    [{ date: '2009-12-31', guests: 1, netSalesCents: 1 }, 'before_earliest'],
    [{ date: '2010-01-01', guests: 1, netSalesCents: 1 }, null],
    [{ date: '2025-03-04', guests: -1, netSalesCents: 1 }, 'negative'],
    [{ date: '2025-03-04', guests: 1, netSalesCents: -1 }, 'negative'],
    [{ date: '2025-03-04', guests: 20_001, netSalesCents: 1 }, 'guests_cap'],
    [{ date: '2025-03-04', guests: 20_000, netSalesCents: 100_000_000 }, null],
    [{ date: '2025-03-04', guests: 1, netSalesCents: 100_000_001 }, 'sales_cap'],
    [{ date: '2025-03-04', guests: null, netSalesCents: null }, 'no_value'],
    [{ date: '2025-03-04', guests: 0, netSalesCents: null }, null],
  ])('%j is %s', (day, reason) => {
    expect(exclusionOf(day, LATEST)).toBe(reason);
  });

  test('left-out days are listed by date with their reason, and their rows are not counted as sent', () => {
    const text = 'Date,Guests,Net\n2026-11-09,1,1\n2009-05-01,1,1\n2025-03-04,1,1\n2025-03-05,,\n2025-03-06,30000,1\n2025-03-07,1,(5)\n2025-03-08,1,"1,000,000.01"';
    const result = daysOf(text);
    expect(result.days.map((day) => day.date)).toEqual(['2025-03-04']);
    expect(result.rows).toBe(1);
    expect(result.excluded).toEqual([
      { date: '2009-05-01', reason: 'before_earliest' },
      { date: '2025-03-05', reason: 'no_value' },
      { date: '2025-03-06', reason: 'guests_cap' },
      { date: '2025-03-07', reason: 'negative' },
      { date: '2025-03-08', reason: 'sales_cap' },
      { date: '2026-11-09', reason: 'after_tomorrow' },
    ]);
  });

  test('a day rounding to zero cents is not negative', () => {
    expect(daysOf('Date,Guests,Net\n2025-03-04,1,-0.004').days[0]?.netSalesCents).toBe(0);
  });
});

describe('semicolon files and the decimal comma', () => {
  test('1.234 or 12,50 in a semicolon file is refused, never read as $1.23 or skipped as unreadable', () => {
    expect(check('Datum;Gäste;Umsatz\n2025-03-04;5;1.234\n2025-03-05;6;980')).toEqual({ kind: 'decimal_comma' });
    expect(check('Datum;Gäste;Umsatz\n2025-03-04;5;"1.234,50"\n2025-03-05;6;12,50')).toEqual({ kind: 'decimal_comma' });
    // A dot-decimal cell doesn't excuse one that needs the comma.
    expect(check('Date;Guests;Net\n2025-03-04;5;980.00\n2025-03-05;6;12,50')).toEqual({ kind: 'decimal_comma' });
  });

  test('a semicolon file whose cells prove the dot reads as before; whole amounts read the same either way', () => {
    expect(daysOf('Date;Guests;Net\n2025-03-04;5;1.234\n2025-03-05;6;980.00').days.map((day) => day.netSalesCents)).toEqual([123, 98_000]);
    expect(daysOf('Date;Guests;Net\n2025-03-04;5;1234\n2025-03-05;6;$980').days.map((day) => day.netSalesCents)).toEqual([123_400, 98_000]);
    expect(daysOf('Date;Guests;Net\n2025-03-04;5;1234', { netSales: null }).days).toHaveLength(1);
  });

  test('a comma file reads 1.234 as a decimal, as before', () => {
    expect(daysOf('Date,Guests,Net\n2025-03-04,5,1.234').days[0]?.netSalesCents).toBe(123);
  });
});

describe('ten years at a time', () => {
  function daysFile(count: number): string {
    const lines = ['Date,Guests,Net'];
    const start = Date.UTC(2015, 0, 1);
    for (let i = 0; i < count; i += 1) lines.push(`${new Date(start + i * 86_400_000).toISOString().slice(0, 10)},1,1`);
    return lines.join('\n');
  }

  test('3,660 days are allowed; 3,661 are too many', () => {
    expect(MAX_DAYS).toBe(3660);
    expect(daysOf(daysFile(3660)).days).toHaveLength(3660);
    expect(check(daysFile(3661))).toEqual({ kind: 'too_many_days', days: 3661 });
  });
});

describe('the latest date', () => {
  /** `iso` as a browser `offsetHours` from UTC sees it: its local date fields, whatever zone the tests run in. */
  function seenAt(iso: string, offsetHours: number): Date {
    const now = new Date(iso);
    const wall = new Date(now.getTime() + offsetHours * 3_600_000);
    return Object.assign(now, {
      getFullYear: () => wall.getUTCFullYear(),
      getMonth: () => wall.getUTCMonth(),
      getDate: () => wall.getUTCDate(),
    });
  }

  test('tomorrow in local time, never later than the server’s UTC date plus one day', () => {
    expect(latestDate(seenAt('2026-11-04T12:00:00.000Z', 0))).toBe('2026-11-05');
    // Tokyo is already on Nov 5, so its tomorrow is Nov 6; the server's UTC date is Nov 4, so it allows Nov 5.
    expect(latestDate(seenAt('2026-11-04T23:30:00.000Z', 9))).toBe('2026-11-05');
    // New York is still on Nov 4, so tomorrow is Nov 5, a day before the server's limit.
    expect(latestDate(seenAt('2026-11-05T02:00:00.000Z', -5))).toBe('2026-11-05');
  });
});

describe('the request body (11.1)', () => {
  test('exactly { days }, each day exactly date, guests and netSalesCents', () => {
    const extra = { date: '2025-03-04', guests: 1, netSalesCents: 2, rows: 4, name: 'x' } as SalesDay;
    const body = uploadBody([extra]);
    expect(Object.keys(body)).toEqual(['days']);
    expect(body.days).toEqual([{ date: '2025-03-04', guests: 1, netSalesCents: 2 }]);
    expect(Object.keys(body.days[0] ?? {})).toEqual(['date', 'guests', 'netSalesCents']);
  });

  test('3,660 days at the largest values fit the route’s 256 KB body limit', () => {
    expect(MAX_BODY_BYTES).toBe(262_144);
    const days: SalesDay[] = Array.from({ length: MAX_DAYS }, () => ({ date: '2026-11-05', guests: 20_000, netSalesCents: 100_000_000 }));
    const bytes = bodyBytes(uploadBody(days));
    expect(bytes).toBe(230_590);
    expect(bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
    // ASCII only, so characters are bytes on the wire.
    expect(/^[\x20-\x7E]*$/.test(JSON.stringify(uploadBody(days)))).toBe(true);
  });

  test('totals add guests and cents over the days to send', () => {
    expect(totalsOf([{ date: 'a', guests: 2, netSalesCents: null }, { date: 'b', guests: null, netSalesCents: 150 }])).toEqual({ guests: 2, netSalesCents: 150 });
  });
});
