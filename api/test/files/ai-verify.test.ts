// Reading with TownwiseAI (spec 11A.9): which daily totals the file's own text bears out before any is written: a line
// that carries the day's date alone must carry each of its figures. Every text and figure is synthetic.
import { describe, expect, it } from 'vitest';

import { datesIn, figuresIn, isCsvLine, verifiedIndexes } from '../../src/files/ai-verify.ts';

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
    expect(figuresIn(datesIn('2026-11-16,120').rest)).toEqual([{ whole: 120, cents: 12_000 }]);
  });
});

describe('figuresIn', () => {
  it('reads thousands separators and a leading $; only a number written whole is a whole number', () => {
    expect(figuresIn('Net $3,456.50 and 1,204 covers; 98.25 and 12; 2100.00 and $40')).toEqual([
      { whole: null, cents: 345_650 }, { whole: 1204, cents: 120_400 }, { whole: null, cents: 9825 }, { whole: 12, cents: 1200 },
      { whole: null, cents: 210_000 }, { whole: null, cents: 4000 },
    ]);
  });

  it('reads a line with a comma between words as a CSV row, keeping its thousands figures whole too', () => {
    expect(figuresIn('we served 1,204 guests, and took $3,456.50').map((figure) => figure.cents).sort((a, b) => a - b))
      .toEqual([100, 300, 20_400, 45_650, 120_400, 345_650]);
  });

  it('parts a CSV row at its commas, keeps a quoted figure whole, and never parts a figure on any other line', () => {
    expect(isCsvLine('          ,120,"$12,345.67"')).toBe(true);
    expect(figuresIn('          ,120,"$12,345.67"')).toEqual([{ whole: 120, cents: 12_000 }, { whole: null, cents: 1_234_567 }]);
    expect(figuresIn('98,2104.00,120,3456.5').map((figure) => figure.cents)).toEqual([9800, 210_400, 12_000, 345_650]);
    // A PDF or Word line: its only commas are thousands separators.
    expect(isCsvLine('             120   $3,456.50')).toBe(false);
    expect(figuresIn('             120   $3,456.50')).toEqual([{ whole: 120, cents: 12_000 }, { whole: null, cents: 345_650 }]);
    // A workbook row is apart by tabs, so its commas are never a CSV's.
    expect(isCsvLine('Mon\t120,3456.50')).toBe(false);
    expect(figuresIn('Mon\t120,3456.50')).toEqual([]);
  });
});

describe('verifiedIndexes', () => {
  const csv = 'Date,Guests,Net Sales\n2026-11-01,120,"$12,345.67"\n2026-11-02,95,2100.00\n2026-11-03,130,3456.50\n';

  it('keeps each day whose own line carries its figures, from a CSV, a workbook, a Word table, or a PDF line', () => {
    expect(verifiedIndexes([
      { date: '2026-11-01', guests: 120, netSales: 12_345.67 },
      { date: '2026-11-02', guests: 95, netSales: 2100 },
      { date: '2026-11-03', guests: null, netSales: 3456.5 },
    ], csv, BOUNDS)).toEqual([0, 1, 2]);
    const other = 'Sheet: Daily\n2026-11-04\t88\t1999.99\nNov 5, 2026   77   $1,204.10\nThe 6th of the month: 11/06/2026 we served 61 guests, and took $980.00';
    expect(verifiedIndexes([
      { date: '2026-11-04', guests: 88, netSales: 1999.99 },
      { date: '2026-11-05', guests: 77, netSales: 1204.1 },
      { date: '2026-11-06', guests: 61, netSales: 980 },
    ], other, BOUNDS)).toEqual([0, 1, 2]);
  });

  it('drops every day when the rows are shifted by one: each date’s figures are another day’s', () => {
    expect(verifiedIndexes([
      { date: '2026-11-01', guests: 95, netSales: 2100 },
      { date: '2026-11-02', guests: 130, netSales: 3456.5 },
      { date: '2026-11-03', guests: 120, netSales: 12_345.67 },
    ], csv, BOUNDS)).toEqual([]);
  });

  it('drops a day whose guests and net sales are swapped (2100.00 is no guest count)', () => {
    expect(verifiedIndexes([{ date: '2026-11-02', guests: 2100, netSales: 95 }], csv, BOUNDS)).toEqual([]);
  });

  it('drops the pieces of a quoted figure: $12,345.67 is neither 12 guests nor $345.67', () => {
    expect(verifiedIndexes([
      { date: '2026-11-01', guests: 12, netSales: null },
      { date: '2026-11-01', guests: null, netSales: 345.67 },
      { date: '2026-11-01', guests: 120, netSales: 345.67 },
    ], csv, BOUNDS)).toEqual([]);
  });

  it('drops a day whose date is only in a header line, or only on a line of two dates', () => {
    const header = 'Week of 2026-11-09\nMon,120,3456.50\nTue,98,2104.00\nReport 2026-11-10 to 2026-11-16: 120 guests, $3,456.50';
    expect(verifiedIndexes([
      { date: '2026-11-09', guests: 120, netSales: 3456.5 },
      { date: '2026-11-10', guests: 120, netSales: 3456.5 },
      { date: '2026-11-16', guests: 120, netSales: null },
    ], header, BOUNDS)).toEqual([]);
  });

  it('drops a day whose two figures are one number on the line', () => {
    expect(verifiedIndexes([{ date: '2026-11-07', guests: 120, netSales: 120 }], '2026-11-07 120', BOUNDS)).toEqual([]);
    expect(verifiedIndexes([{ date: '2026-11-07', guests: 120, netSales: 120 }], '2026-11-07 120 120.00', BOUNDS)).toEqual([0]);
  });

  it('bears out none of a crafted file of 304 dates and the numbers 0 to 49 written apart from them', () => {
    const dates = Array.from({ length: 304 }, (_, index) => new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10));
    const crafted = `${dates.join('\n')}\n${Array.from({ length: 50 }, (_, index) => String(index)).join(' ')}`;
    const claimed = dates.map((date, index) => ({ date, guests: index % 50, netSales: null }));
    expect(verifiedIndexes(claimed, crafted, BOUNDS)).toEqual([]);
  });

  it('drops a day past the upload caps: after the latest date, before 2010, over 20,000 guests or a million dollars', () => {
    const wide = '2026-11-18 5\n2009-12-31 5\n2026-11-10 20001\n2026-11-11 100000000.01';
    expect(verifiedIndexes([
      { date: '2026-11-18', guests: 5, netSales: null },
      { date: '2009-12-31', guests: 5, netSales: null },
      { date: '2026-11-10', guests: 20_001, netSales: null },
      { date: '2026-11-11', guests: null, netSales: 100_000_000.01 },
    ], wide, BOUNDS)).toEqual([]);
  });
});
