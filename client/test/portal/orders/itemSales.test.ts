import type { SetupItem } from '../../../src/portal/orders/api';
import {
  businessDate, chunksOf, ColumnSampler, ITEM_SALES_DAYS, MAX_CHUNK_BYTES, MAX_CHUNK_DAYS, proposeColumns, readQuantity, SalesMatcher,
  SERIAL_RANGE, timeColumnOf, type ColumnProfile, type MatchColumns,
} from '../../../src/portal/orders/itemSales';
import { addDays } from '../../../src/portal/locations/dates';
import { serialToIso } from '../../../src/portal/viewer/xlsx';

// Item sales matched in the browser (design Decision 4, the item-sales spec): column presets and guesses, business
// days (US dates, Excel serials, the 04:00 rule, a separate Time column, times with a UTC offset read in the town's
// zone), name folding, a name under two items, the days kept (before the town's today, within the 244 the board
// reads, and not a last day an export of times may have cut short), the chunks by days and bytes, and a request body
// that holds only ids, dates and servings. Every name here is synthetic.

const NEW_YORK = 'America/New_York';

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

  test('a Square export: its Time column joins each date, so sales after midnight go to the day before', () => {
    const header = ['Date', 'Time', 'Time Zone', 'Category', 'Item', 'Qty', 'Gross Sales'];
    const rows = [
      ['11/1/2026', '11:30 PM', 'Eastern Time (US & Canada)', 'Beer', 'Lager Pint', '2', '$12.00'],
      ['11/2/2026', '1:15 AM', 'Eastern Time (US & Canada)', 'Beer', 'Lager Pint', '3', '$18.00'],
      ['11/2/2026', '8:00 PM', 'Eastern Time (US & Canada)', 'Beer', 'Lager Pint', '1', '$6.00'],
      ['11/3/2026', '12:30 AM', 'Eastern Time (US & Canada)', 'Beer', 'IPA Pint', '1', '$7.00'],
    ];
    const columns = profiles(header, rows);
    const proposal = proposeColumns(columns);
    expect(proposal).toEqual({ preset: 'Square', columns: { date: 0, item: 4, quantity: 5 } });
    const picked = { date: 0, item: 4, quantity: 5 };
    expect(timeColumnOf(columns, picked)).toBe(1);
    const matcher = new SalesMatcher({ ...picked, time: timeColumnOf(columns, picked) }, [LAGER, IPA], { today: '2026-11-13', zone: null });
    for (const row of rows) matcher.add(row);
    const outcome = matcher.finish();
    // Without the Time column, Nov 2 would hold the 1:15 AM sale and Nov 3 the 12:30 AM one.
    expect(outcome.days).toEqual([{ date: '2026-11-01', items: { a1: 5 } }, { date: '2026-11-02', items: { a1: 1, b2: 1 } }]);
    expect(outcome.cut).toBeNull();
    expect(timeColumnOf(profiles(['Date', 'Item', 'Qty'], []), { date: 0, item: 1, quantity: 2 })).toBeNull();
  });

  test('a column of times with an offset is marked zoned, so the page reads the town’s zone first', () => {
    const header = ['When', 'Product', 'Units'];
    const rows = [['2026-11-01T21:15:00Z', 'Lager Pint', '2'], ['2026-11-02T01:15:00-05:00', 'IPA Pint', '1']];
    expect(profiles(header, rows).map((column) => [column.kind, column.zoned])).toEqual([['dates', true], ['text', false], ['numbers', false]]);
    expect(profiles(header, [['2026-11-01T00:00:00Z', 'Lager Pint', '2']])[0]?.zoned).toBe(false);
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
    for (const text of ['', 'Nov 1, 2026', '13/1/2026', '2026-02-30', '11/1/2026 25:00', 'Total', '12']) expect(businessDate(text)).toBeNull();
  });

  // #68 review C9: a time with Z or an offset is an instant, so its day depends on the zone it is read in.
  test('a time with Z or an offset is read in the town’s zone, and names no day without one; midnight stays a date alone', () => {
    // 05:30Z on Nov 2 is 00:30 in New York, after midnight, so the sale is Nov 1's; read as written it would be Nov 2's.
    expect(businessDate('2026-11-02T05:30:00Z', NEW_YORK)).toBe('2026-11-01');
    expect(businessDate('2026-11-02T05:30:00.000Z', NEW_YORK)).toBe('2026-11-01');
    expect(businessDate('2026-11-02T10:30:00Z', NEW_YORK)).toBe('2026-11-02');
    expect(businessDate('2026-11-02T00:30:00-05:00', 'America/Los_Angeles')).toBe('2026-11-01');
    // 09:00 at +01:00 is 03:00 in New York, still Nov 1's business day; 15:00 at +01:00 is 09:00.
    expect(businessDate('2026-11-02 09:00:00 +0100', NEW_YORK)).toBe('2026-11-01');
    expect(businessDate('2026-11-02 15:00:00 +0100', NEW_YORK)).toBe('2026-11-02');
    expect(businessDate('2026-11-01T21:15:00Z', NEW_YORK)).toBe('2026-11-01');
    for (const text of ['2026-11-01T21:15:00Z', '2026-11-02T05:30:00-05:00', '11/2/2026 1:30 AM +00:00']) expect(businessDate(text)).toBeNull();
    // A date column written as midnight UTC is a date alone, never moved to the evening before.
    expect(businessDate('2026-11-01T00:00:00Z', NEW_YORK)).toBe('2026-11-01');
    expect(businessDate('2026-11-01T00:00:00Z')).toBe('2026-11-01');
    // A zone this browser doesn't know places nothing.
    expect(businessDate('2026-11-02T05:30:00Z', 'Not/A_Zone')).toBeNull();
  });

  // #68 review C10: Square writes the time in its own column, so the 04:00 rule needs it joined to the date.
  test('a separate time joins the date before the 04:00 rule, as text or as Excel writes a time with no date', () => {
    expect(businessDate('11/2/2026', null, '1:15 AM')).toBe('2026-11-01');
    expect(businessDate('11/2/2026', null, '20:00:00')).toBe('2026-11-02');
    expect(businessDate('2026-11-02', null, '1899-12-31T01:15:00')).toBe('2026-11-01');
    expect(businessDate('2026-11-02', null, '0.0625')).toBe('2026-11-01');
    expect(businessDate('2026-11-02', null, '')).toBe('2026-11-02');
    expect(businessDate('2026-11-02', null, 'noon')).toBeNull();
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

  function match(
    rows: string[][], items: SetupItem[] = [LAGER, IPA], today = '2026-11-13', zone: string | null = null, columns: MatchColumns = COLUMNS,
  ): ReturnType<SalesMatcher['finish']> {
    const matcher = new SalesMatcher(columns, items, { today, zone });
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
    // 'Total' is no date; 2009 is before the 244 days; Nov 14 is after the town's today.
    expect(outcome.skipped).toEqual({ date: 1, zoned: 0, open: 1, old: 1, name: 1, quantity: 2 });
    expect(outcome.rowsRead).toBe(9);
    expect(outcome.matchedRows).toBe(0);
  });

  // #68 review A7 and C4: the town's today is still open (the server refuses it), and the board reads no more than the
  // 244 days before it, so a long file sends only those and is not refused by the uploads limiter.
  test('keeps only the days before the town’s today and within the 244 the board reads', () => {
    expect(ITEM_SALES_DAYS).toBe(244);
    const earliest = addDays('2026-11-13', -ITEM_SALES_DAYS);
    expect(earliest).toBe('2026-03-14');
    const outcome = match([
      ['2026-03-13', 'Lager Pint', '1'],
      ['2026-03-14', 'Lager Pint', '2'],
      ['2026-11-12', 'Lager Pint', '3'],
      ['2026-11-13', 'Lager Pint', '4'],
      ['2026-11-14', 'IPA Pint', '5'],
    ]);
    expect(outcome).toMatchObject({ firstDate: '2026-03-14', lastDate: '2026-11-12', today: '2026-11-13', earliest: '2026-03-14', matchedRows: 2 });
    expect(outcome.days).toEqual([{ date: '2026-03-14', items: { a1: 2 } }, { date: '2026-11-12', items: { a1: 3 } }]);
    expect(outcome.skipped).toMatchObject({ open: 2, old: 1 });
    expect(outcome.itemRows).toEqual({ a1: 2 });
  });

  // #68 review R2: a per-sale export run by calendar date stops at midnight, before its last day's after-midnight sales.
  test('with times, the last business day is left out unless some row is dated the day after it', () => {
    const cut = match([
      ['2026-11-01 20:00', 'Lager Pint', '1'],
      ['2026-11-02 01:00', 'Lager Pint', '1'],
      ['2026-11-02 21:00', 'Lager Pint', '2'],
      ['2026-11-02 23:30', 'IPA Pint', '1'],
    ]);
    expect(cut).toMatchObject({ cut: '2026-11-02', firstDate: '2026-11-01', lastDate: '2026-11-01', matchedRows: 2, itemRows: { a1: 2 } });
    expect(cut.days).toEqual([{ date: '2026-11-01', items: { a1: 2 } }]);
    // A row after midnight dated the next day shows the export ran past the end of that day: nothing is cut.
    const whole = match([['2026-11-01 20:00', 'Lager Pint', '1'], ['2026-11-02 21:00', 'Lager Pint', '2'], ['2026-11-03 00:45', 'IPA Pint', '1']]);
    expect(whole).toMatchObject({ cut: null, lastDate: '2026-11-02' });
    // So is a row of the town's today, left out itself.
    expect(match([['2026-11-12 21:00', 'Lager Pint', '2'], ['2026-11-13 10:00', 'Lager Pint', '1']])).toMatchObject({ cut: null, lastDate: '2026-11-12' });
    // A file of dates alone has no time to stop at, and neither does a date column written as midnight.
    expect(match([['2026-11-01', 'Lager Pint', '1'], ['2026-11-02', 'Lager Pint', '2']])).toMatchObject({ cut: null, lastDate: '2026-11-02' });
    expect(match([['2026-11-01 00:00:00', 'Lager Pint', '1'], ['2026-11-02 00:00:00', 'Lager Pint', '2']])).toMatchObject({ cut: null, lastDate: '2026-11-02' });
  });

  // #68 second review N5: a bar that closes before midnight has no row the next morning; finish(true) keeps its last day.
  test('finish(true) keeps the cut last day, and the same matcher still gives the default', () => {
    const matcher = new SalesMatcher(COLUMNS, [LAGER, IPA], { today: '2026-11-13', zone: null });
    for (const row of [['2026-11-01 20:00', 'Lager Pint', '1'], ['2026-11-02 21:00', 'Lager Pint', '2'], ['2026-11-02 23:30', 'IPA Pint', '1']]) {
      matcher.add(row);
    }
    const kept = matcher.finish(true);
    expect(kept).toMatchObject({ cut: '2026-11-02', cutIncluded: true, firstDate: '2026-11-01', lastDate: '2026-11-02', matchedRows: 3 });
    expect(kept.itemRows).toEqual({ a1: 2, b2: 1 });
    expect(kept.days).toEqual([{ date: '2026-11-01', items: { a1: 1 } }, { date: '2026-11-02', items: { a1: 2, b2: 1 } }]);
    expect(matcher.finish()).toMatchObject({ cut: '2026-11-02', cutIncluded: false, lastDate: '2026-11-01', matchedRows: 1 });
    // Nothing cut: finish(true) is the default match.
    const whole = new SalesMatcher(COLUMNS, [LAGER, IPA], { today: '2026-11-13', zone: null });
    whole.add(['2026-11-01', 'Lager Pint', '1']);
    expect(whole.finish(true)).toEqual(whole.finish());
    expect(whole.finish(true)).toMatchObject({ cut: null, cutIncluded: false });
  });

  test('times with an offset: counted as zoned without the town’s zone, read in it with one', () => {
    const rows = [['2026-11-02T05:30:00Z', 'Lager Pint', '1'], ['2026-11-02T22:00:00Z', 'Lager Pint', '2'], ['2026-11-03T15:00:00Z', 'IPA Pint', '1']];
    const without = match(rows);
    expect(without).toMatchObject({ skipped: { zoned: 3 }, converted: 0, firstDate: null, days: [] });
    const within = match(rows, [LAGER, IPA], '2026-11-13', NEW_YORK);
    expect(within).toMatchObject({ skipped: { zoned: 0 }, converted: 3, cut: '2026-11-03' });
    // 05:30Z is 00:30 in New York, Nov 1's business day; 22:00Z is 17:00, Nov 2's. Nov 1 holds only that after-midnight
    // sale, so it is part of a day and left out.
    expect(within.days).toEqual([{ date: '2026-11-02', items: { a1: 2 } }]);
  });

  test('each setup item’s matched rows on the days sent; a row under two items counts for each', () => {
    const outcome = match([
      ['2026-11-01', 'Lager Pint', '3'],
      ['2026-11-01', 'Lager Pitcher', '1'],
      ['2026-11-02', 'Beer Flight', '4'],
      ['2026-11-02', 'Nachos', '1'],
    ], [LAGER, IPA, FLIGHT_A, FLIGHT_B]);
    expect(outcome.itemRows).toEqual({ a1: 2, c3: 1, d4: 1 });
    expect(outcome.matchedRows).toBe(3);
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

  // #68 review C3: 31 days of 300 items is about 370,000 bytes of JSON, over the route's 256 kb.
  test('a span whose JSON would pass 250,000 bytes is split into spans that meet end to end', () => {
    const ids = Array.from({ length: 300 }, (_, index) => index.toString(16).padStart(24, '0'));
    const first = '2026-10-01';
    const days = Array.from({ length: 31 }, (_, index) => ({
      date: addDays(first, index), items: Object.fromEntries(ids.map((id) => [id, 12_345.125])),
    }));
    expect(JSON.stringify({ from: first, to: '2026-10-31', days }).length).toBeGreaterThan(MAX_CHUNK_BYTES);
    const chunks = chunksOf(days, first, '2026-10-31');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(chunk.days.every((day) => day.date >= chunk.from && day.date <= chunk.to)).toBe(true);
    }
    expect(chunks[0]?.from).toBe(first);
    expect(chunks.at(-1)?.to).toBe('2026-10-31');
    chunks.slice(1).forEach((chunk, index) => { expect(chunk.from).toBe(addDays(chunks[index]?.to ?? '', 1)); });
    expect(chunks.flatMap((chunk) => chunk.days)).toEqual(days);
    // The 31-day cap still holds, and a small span is one request.
    const long = Array.from({ length: 62 }, (_, index) => ({ date: addDays(first, index), items: { a1: 1 } }));
    expect(chunksOf(long, first, addDays(first, 61)).map((chunk) => [chunk.from, chunk.to])).toEqual([
      [first, addDays(first, MAX_CHUNK_DAYS - 1)], [addDays(first, MAX_CHUNK_DAYS), addDays(first, 61)],
    ]);
    // A tight limit splits where the next day would pass it, leaving a dateless gap inside a span, never between spans.
    const tight = chunksOf([{ date: first, items: { a1: 1 } }, { date: addDays(first, 3), items: { a1: 2 } }], first, addDays(first, 5), 80);
    expect(tight).toEqual([
      { from: first, to: addDays(first, 2), days: [{ date: first, items: { a1: 1 } }] },
      { from: addDays(first, 3), to: addDays(first, 5), days: [{ date: addDays(first, 3), items: { a1: 2 } }] },
    ]);
  });

  test('the request body holds only item ids, dates and servings: no name from the file', () => {
    const matcher = new SalesMatcher({ date: 0, item: 1, quantity: 2 }, [LAGER], { today: '2026-11-13', zone: null });
    for (const row of [['2026-11-01', 'Lager Pint', '2'], ['2026-11-02', 'Secret Party Package', '1']]) matcher.add(row);
    const outcome = matcher.finish();
    const body = JSON.stringify(chunksOf(outcome.days, outcome.firstDate ?? '', outcome.lastDate ?? ''));
    expect(body).toBe('[{"from":"2026-11-01","to":"2026-11-02","days":[{"date":"2026-11-01","items":{"a1":2}},{"date":"2026-11-02","items":{}}]}]');
    expect(body).not.toMatch(/Lager|Secret|Party/);
  });
});
