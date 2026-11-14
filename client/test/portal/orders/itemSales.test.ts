import type { SetupItem } from '../../../src/portal/orders/api';
import {
  businessDate, chunksOf, ColumnSampler, proposeColumns, readQuantity, SalesMatcher, SERIAL_RANGE, type ColumnProfile,
} from '../../../src/portal/orders/itemSales';
import { serialToIso } from '../../../src/portal/viewer/xlsx';

// Item sales matched in the browser (design Decision 4, the item-sales spec): column presets and guesses, business
// days (US dates, Excel serials, the 04:00 rule), name folding, a name under two items, the chunks, and a request body
// that holds only ids, dates and servings. Every name here is synthetic.

function item(id: string, posNames: SetupItem['posNames']): SetupItem {
  return {
    id, name: `Item ${id}`, supplierId: 's1', category: 'draft', unit: 'kegs', servingsPerUnit: 124, par: 1, dealSize: null,
    neverRunOut: false, posNames,
  };
}

const LAGER = item('a1', [{ name: 'Lager Pint', perSale: 1 }, { name: 'Lager Pitcher', perSale: 4 }]);
const IPA = item('b2', [{ name: 'IPA Pint', perSale: 1 }]);
const FLIGHT_A = item('c3', [{ name: 'Beer Flight', perSale: 0.25 }]);
const FLIGHT_B = item('d4', [{ name: 'beer   flight', perSale: 0.5 }]);

function profiles(header: string[], rows: string[][]): ColumnProfile[] {
  const sampler = new ColumnSampler(header);
  for (const row of rows) sampler.add(row);
  return sampler.finish();
}

describe('columns', () => {
  test('presets: Toast, Square and the clean daily layout, matched without regard to case or underscores', () => {
    expect(proposeColumns(profiles(['Location', 'Business Date', 'Menu Item', 'Item Qty', 'Net Amount'], [])))
      .toEqual({ preset: 'Toast', columns: { date: 1, item: 2, quantity: 3 } });
    expect(proposeColumns(profiles(['date', 'ITEM', 'Qty', 'Net Sales'], []))).toEqual({ preset: 'Square', columns: { date: 0, item: 1, quantity: 2 } });
    expect(proposeColumns(profiles(['menu_item', 'qty_sold', 'business_date'], [])))
      .toEqual({ preset: 'clean daily', columns: { date: 2, item: 0, quantity: 1 } });
  });

  test('a guess: a date-like column, a text column and a numeric column, preferring headers that name them', () => {
    const header = ['Check', 'When', 'Server', 'Product name', 'Units sold', 'Price'];
    const rows = [
      ['1001', '11/1/2026 9:15 PM', 'Server one', 'Lager Pint', '2', '6.00'],
      ['1002', '11/1/2026 9:20 PM', 'Server two', 'IPA Pint', '1', '7.00'],
    ];
    const guessed = proposeColumns(profiles(header, rows));
    expect(guessed).toEqual({ preset: null, columns: { date: 1, item: 3, quantity: 4 } });
  });

  test('Excel serials under a date header are guessed as the date column; a quantity column is never a serial one', () => {
    const header = ['Sold', 'Sale date', 'Name'];
    const rows = [['3', '45962', 'Lager Pint'], ['5', '45963.5', 'IPA Pint']];
    expect(profiles(header, rows).map((column) => [column.kind, column.serials])).toEqual([['numbers', false], ['numbers', true], ['text', false]]);
    expect(proposeColumns(profiles(header, rows)).columns).toEqual({ date: 1, item: 2, quantity: 0 });
  });

  test('no date-like column guesses no date column', () => {
    const header = ['Item', 'Qty'];
    expect(proposeColumns(profiles(header, [['Lager Pint', '2'], ['IPA Pint', '3']])).columns.date).toBeNull();
  });
});

describe('business days', () => {
  test('ISO, compact and US dates, with and without a time', () => {
    expect(businessDate('2026-11-01')).toBe('2026-11-01');
    expect(businessDate('20261101')).toBe('2026-11-01');
    expect(businessDate('11/1/2026')).toBe('2026-11-01');
    expect(businessDate('11/01/26')).toBe('2026-11-01');
    expect(businessDate('11/1/2026 9:15 PM')).toBe('2026-11-01');
    expect(businessDate('11/1/2026, 21:15')).toBe('2026-11-01');
    expect(businessDate('2026-11-01T21:15:00Z')).toBe('2026-11-01');
    for (const text of ['', 'Nov 1, 2026', '13/1/2026', '2026-02-30', '11/1/2026 25:00', 'Total', '12']) expect(businessDate(text)).toBeNull();
  });

  test('a time before 04:00 belongs to the business day before; exactly midnight is a date alone', () => {
    expect(businessDate('11/2/2026 1:30 AM')).toBe('2026-11-01');
    expect(businessDate('11/2/2026 12:15 AM')).toBe('2026-11-01');
    expect(businessDate('2026-11-02 03:59:59')).toBe('2026-11-01');
    expect(businessDate('2026-11-02 04:00')).toBe('2026-11-02');
    expect(businessDate('11/1/2026 12:30 PM')).toBe('2026-11-01');
    expect(businessDate('2026-11-01 00:00:00')).toBe('2026-11-01');
    // Across a month and a year.
    expect(businessDate('3/1/2026 2:00 AM')).toBe('2026-02-28');
    expect(businessDate('2027-01-01T01:00:00')).toBe('2026-12-31');
  });

  test('Excel serials, with the 04:00 rule on their fraction', () => {
    expect(serialToIso(SERIAL_RANGE.min, false)).toBe('2010-01-01');
    expect(serialToIso(SERIAL_RANGE.max, false)).toBe('2099-12-31');
    const serial = 46_327; // 2026-11-01
    expect(serialToIso(serial, false)).toBe('2026-11-01');
    expect(businessDate(String(serial))).toBe('2026-11-01');
    expect(businessDate(String(serial + 0.875))).toBe('2026-11-01');
    expect(businessDate(String(serial + 1 + 0.0625))).toBe('2026-11-01');
    expect(businessDate('12')).toBeNull();
  });

  test('quantities: numbers of 0 or more; empty, text and negative ones are left out', () => {
    expect(['2', ' 1.5 ', '1,200', '0'].map(readQuantity)).toEqual([2, 1.5, 1200, 0]);
    for (const text of ['', 'two', '-1', '(2)', 'n/a']) expect(readQuantity(text)).toBeNull();
  });
});

describe('matching', () => {
  const COLUMNS = { date: 0, item: 1, quantity: 2 };

  function match(rows: string[][], items: SetupItem[] = [LAGER, IPA], today = '2026-11-13'): ReturnType<SalesMatcher['finish']> {
    const matcher = new SalesMatcher(COLUMNS, items, today);
    for (const row of rows) matcher.add(row);
    return matcher.finish();
  }

  test('names match trimmed, case-folded and with spaces collapsed; quantity x servings per sale adds to the item’s day', () => {
    const outcome = match([
      ['2026-11-01', 'Lager Pint', '3'],
      ['2026-11-01', '  LAGER   pitcher ', '2'],
      ['2026-11-01', 'ipa pint', '1.5'],
      ['2026-11-02', 'Lager Pint', '1'],
    ]);
    expect(outcome.days).toEqual([
      { date: '2026-11-01', items: { a1: 11, b2: 1.5 } },
      { date: '2026-11-02', items: { a1: 1 } },
    ]);
    expect(outcome).toMatchObject({ firstDate: '2026-11-01', lastDate: '2026-11-02', rowsRead: 4, matchedRows: 4, itemsWithSales: 2, unmatched: [] });
  });

  test('a name listed under two items adds to each, with each item’s servings per sale', () => {
    const outcome = match([['2026-11-01', 'Beer Flight', '4']], [FLIGHT_A, FLIGHT_B]);
    expect(outcome.days).toEqual([{ date: '2026-11-01', items: { c3: 1, d4: 2 } }]);
    expect(outcome.matchedRows).toBe(1);
  });

  test('unmatched names are counted by rows, most first; bad rows are counted, not matched', () => {
    const outcome = match([
      ['2026-11-01', 'Nachos', '2'],
      ['2026-11-01', 'Wings', '1'],
      ['2026-11-02', 'nachos', '1'],
      ['2026-11-02', 'Lager Pint', 'two'],
      ['2026-11-02', 'Lager Pint', '-1'],
      ['2026-11-02', '', '4'],
      ['Total', 'Lager Pint', '9'],
      ['2009-12-31', 'Lager Pint', '1'],
      ['2026-11-14', 'Lager Pint', '1'],
      ['', '', ''],
    ]);
    expect(outcome.unmatched).toEqual([{ name: 'Nachos', rows: 2 }, { name: 'Wings', rows: 1 }]);
    expect(outcome.skipped).toEqual({ date: 3, name: 1, quantity: 2 });
    expect(outcome.rowsRead).toBe(9);
    expect(outcome.matchedRows).toBe(0);
  });

  test('every date any row names is covered; a date with no matched sales sends an empty items object', () => {
    const outcome = match([
      ['2026-11-01', 'Lager Pint', '1'],
      ['2026-11-02', 'Nachos', '3'],
      ['2026-11-03', 'Lager Pint', 'oops'],
      ['2026-11-04', 'IPA Pint', '0'],
    ]);
    expect(outcome.days).toEqual([
      { date: '2026-11-01', items: { a1: 1 } },
      { date: '2026-11-02', items: {} },
      { date: '2026-11-03', items: {} },
      { date: '2026-11-04', items: {} },
    ]);
  });

  test('a day reached only by after-midnight rows is part of a day, so it is left out and does not start the range', () => {
    const outcome = match([
      ['2026-11-02 01:30', 'Lager Pint', '5'],
      ['2026-11-02 20:00', 'Lager Pint', '2'],
      ['2026-11-03 01:00', 'Lager Pint', '1'],
    ]);
    expect(outcome.days).toEqual([{ date: '2026-11-02', items: { a1: 3 } }]);
    expect(outcome).toMatchObject({ firstDate: '2026-11-02', lastDate: '2026-11-02' });
  });

  test('a day above 100,000 servings of one item is flagged', () => {
    expect(match([['2026-11-01', 'Lager Pitcher', '30000']]).overLimit).toBe(1);
    expect(match([['2026-11-01', 'Lager Pitcher', '20000']]).overLimit).toBe(0);
  });
});

describe('chunks', () => {
  test('spans of at most 31 days across months, each with its own from, to and days', () => {
    const days = [
      { date: '2026-01-05', items: { a1: 2 } },
      { date: '2026-02-04', items: { a1: 1 } },
      { date: '2026-02-05', items: {} },
      { date: '2026-03-20', items: { b2: 3 } },
    ];
    expect(chunksOf(days, '2026-01-05', '2026-03-20')).toEqual([
      { from: '2026-01-05', to: '2026-02-04', days: [days[0], days[1]] },
      { from: '2026-02-05', to: '2026-03-07', days: [days[2]] },
      { from: '2026-03-08', to: '2026-03-20', days: [days[3]] },
    ]);
    expect(chunksOf([{ date: '2026-11-01', items: {} }], '2026-11-01', '2026-11-01')).toEqual([
      { from: '2026-11-01', to: '2026-11-01', days: [{ date: '2026-11-01', items: {} }] },
    ]);
  });

  test('the request body holds only item ids, dates and servings: no name from the file', () => {
    const matcher = new SalesMatcher({ date: 0, item: 1, quantity: 2 }, [LAGER], '2026-11-13');
    for (const row of [['2026-11-01', 'Lager Pint', '2'], ['2026-11-02', 'Secret Party Package', '1']]) matcher.add(row);
    const outcome = matcher.finish();
    const body = JSON.stringify(chunksOf(outcome.days, outcome.firstDate ?? '', outcome.lastDate ?? ''));
    expect(body).toBe('[{"from":"2026-11-01","to":"2026-11-02","days":[{"date":"2026-11-01","items":{"a1":2}},{"date":"2026-11-02","items":{}}]}]');
    expect(body).not.toMatch(/Lager|Secret|Party/);
  });
});
