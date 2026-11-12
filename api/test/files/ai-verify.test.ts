// Reading with TownwiseAI (spec 11A.9): which daily totals the file's own text bears out before any is written. Every
// text and figure is synthetic.
import { describe, expect, it } from 'vitest';

import { datesIn, numbersIn, verifiedDays } from '../../src/files/ai-verify.ts';

const BOUNDS = { earliest: '2010-01-01', latest: '2026-11-17' };

describe('datesIn', () => {
  it('reads ISO, month-first, two-digit-year, unambiguous day-first and month-name dates, case-insensitively', () => {
    const { dates } = datesIn([
      '2026-11-16', '11/15/2026', '11/14/26', '25/10/2026', 'Nov 13 2026', 'november 12, 2026', '11 NOV 2026', 'Sept. 9th, 2026',
      '2026-11-08T10:00:00Z',
    ].join(' | '));
    expect([...dates].sort()).toEqual([
      '2026-09-09', '2026-10-25', '2026-11-08', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16',
    ]);
  });

  it('reads an ambiguous slash date month first only, and leaves out impossible dates', () => {
    expect([...datesIn('03/04/2026 2026-02-30 13/13/2026').dates]).toEqual(['2026-03-04']);
  });

  it('blanks the dates it read, so their parts are not read as figures', () => {
    const { rest } = datesIn('2026-11-16,120');
    expect([...numbersIn(rest).whole]).toEqual([120]);
  });
});

describe('numbersIn', () => {
  it('reads thousands separators and a leading $, whole numbers as guests and every number in cents', () => {
    const { whole, cents } = numbersIn('Net $3,456.50 and 1,204 covers, 98.25 and 12');
    for (const guests of [12, 1204]) expect(whole.has(guests)).toBe(true);
    expect(whole.has(98)).toBe(false);
    for (const amount of [1200, 9825, 120_400, 345_650]) expect(cents.has(amount)).toBe(true);
  });

  it('reads a CSV row’s comma-parted numbers each on their own too', () => {
    const { whole, cents } = numbersIn('98,2104.00,120,3456.5');
    for (const guests of [98, 120]) expect(whole.has(guests)).toBe(true);
    for (const amount of [210_400, 345_650]) expect(cents.has(amount)).toBe(true);
  });
});

describe('verifiedDays', () => {
  const text = 'Date,Guests,Net\n2026-11-14,120,"$3,456.50"\n11/15/2026,98,2104.00\nNov 16 2026,77,1999.99\n';

  it('keeps a day whose date and every figure appear, in cents', () => {
    expect(verifiedDays([
      { date: '2026-11-14', guests: 120, netSales: 3456.5 },
      { date: '2026-11-15', guests: 98, netSales: 2104 },
      { date: '2026-11-16', guests: null, netSales: 1999.99 },
    ], text, BOUNDS)).toEqual([
      { date: '2026-11-14', guests: 120, netSalesCents: 345_650 },
      { date: '2026-11-15', guests: 98, netSalesCents: 210_400 },
      { date: '2026-11-16', guests: null, netSalesCents: 199_999 },
    ]);
  });

  it('drops a day whose date or a figure is not in the text', () => {
    expect(verifiedDays([
      { date: '2026-11-13', guests: 120, netSales: null },
      { date: '2026-11-14', guests: 121, netSales: null },
      { date: '2026-11-15', guests: 98, netSales: 2104.01 },
    ], text, BOUNDS)).toEqual([]);
  });

  it('drops a day past the upload caps: after the latest date, before 2010, over 20,000 guests or a million dollars', () => {
    const wide = '2026-11-18 2009-12-31 2026-11-10 2026-11-11 20001 100000000.01 5';
    expect(verifiedDays([
      { date: '2026-11-18', guests: 5, netSales: null },
      { date: '2009-12-31', guests: 5, netSales: null },
      { date: '2026-11-10', guests: 20_001, netSales: null },
      { date: '2026-11-11', guests: null, netSales: 100_000_000.01 },
    ], wide, BOUNDS)).toEqual([]);
  });
});
