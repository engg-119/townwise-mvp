import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkFile, guessColumns, lacksHeader, LocationValues, looksBinary, Profiler, type ColumnProfile } from '../../../src/portal/upload/columns';
import { canCheck, COPY, matchMessages, type MatchMessages } from '../../../src/portal/upload/copy';
import { detectDelimiter, parseCsv, stripBom } from '../../../src/portal/upload/csv';
import { DayAggregator, uploadBody, type CheckResult, type Mapping, type RowMode } from '../../../src/portal/upload/days';
import { scanText, type ScanOptions } from '../../../src/portal/upload/scan';

// The browser upload (P13) against the API's shared fixtures (storage2.md 15 and 19, parity). The API's
// csv-stream.test.ts reads every file in api/test/fixtures/sales-files/ to expected.json; this test runs the same
// files through the browser's modules the way UploadPage.web.tsx calls them (openFile, loadLocationValues,
// checkTotals), with a person who keeps the page's guesses and answers only what the API's rules settle by
// themselves. Where the two disagree, the difference is pinned in DIFFERENCES below and neither side is changed
// here: a change to either reader that closes or moves a gap fails this test, so the gap is decided on purpose.

const DIR = join(__dirname, '..', '..', '..', '..', 'api', 'test', 'fixtures', 'sales-files');

type Want =
  | { outcome: 'days'; days: { date: string; guests: number | null; netSalesCents: number | null }[] }
  | { outcome: 'kept'; code: string }
  | { outcome: 'question'; kind: string };

interface Expected { locationName: string; latest: string; files: Record<string, Want> }

const expected = JSON.parse(readFileSync(join(DIR, 'expected.json'), 'utf8')) as Expected;
const fixtures = readdirSync(DIR).filter((name) => name !== 'expected.json').sort();

/** What the person answers on Match columns, by header name; anything left out keeps the page's guess. */
interface Choices { rowMode?: RowMode; location?: string }

type Browser =
  | { step: 'refused'; reason: 'too_large' | 'not_csv' | 'no_header' }
  | {
    step: 'match';
    columns: ColumnProfile[];
    mapping: Mapping;
    messages: MatchMessages;
    /** The Date order choice shows: the date column has slash dates and none proves the order. */
    orderAsked: boolean;
    /** The location column's values, once the person names that column. */
    locationValues: string[] | null;
    /** Check the totals' result, or null while the page keeps that button disabled. */
    check: CheckResult | null;
  };

const OPTIONS: ScanOptions = { pause: () => Promise.resolve(), cancelled: () => false };

/** The browser's path for one fixture, step by step as UploadPage.web.tsx takes it. */
async function browse(name: string, choices: Choices = {}): Promise<Browser> {
  const bytes = readFileSync(join(DIR, name));
  const problem = checkFile({ name, size: bytes.length });
  if (problem !== null) return { step: 'refused', reason: problem };
  const text = bytes.toString('utf8');
  if (looksBinary(text)) return { step: 'refused', reason: 'not_csv' };

  // openFile: the header and the column profiles.
  const found: { profiler: Profiler | null } = { profiler: null };
  const opened = await scanText(text, {
    header: (cells) => {
      if (cells === null || lacksHeader(cells)) return false;
      found.profiler = new Profiler(cells);
      return true;
    },
    row: (cells) => {
      found.profiler?.add(cells);
      return true;
    },
  }, OPTIONS);
  if (found.profiler === null) return { step: 'refused', reason: 'no_header' };
  if (opened === 'cancelled' || opened.unterminated) return { step: 'refused', reason: 'not_csv' };
  const columns = found.profiler.finish();
  const names = columns.map((column) => column.name);
  const guess = guessColumns(names);
  // The page's EMPTY_MAPPING with the header guesses and the date column's proven order.
  let mapping: Mapping = {
    rowMode: 'day', location: null, locationValue: null, ...guess,
    dateOrder: (guess.date === null ? null : columns[guess.date]?.order) ?? 'month_first',
  };
  if (choices.rowMode !== undefined) mapping = { ...mapping, rowMode: choices.rowMode };

  // loadLocationValues: the named column's values, and the one that is this location's name preselected.
  let locationValues: string[] | null = null;
  if (choices.location !== undefined) {
    const column = names.indexOf(choices.location);
    expect(column).not.toBe(-1);
    const collector = new LocationValues(column);
    await scanText(text, { header: () => true, row: (cells) => collector.add(cells) }, OPTIONS);
    locationValues = collector.values();
    const own = expected.locationName.trim().toLowerCase();
    mapping = { ...mapping, location: column, locationValue: locationValues.find((value) => value.toLowerCase() === own) ?? null };
  }

  const messages = matchMessages(mapping, expected.locationName);
  const dateColumn = mapping.date === null ? undefined : columns[mapping.date];
  const orderAsked = dateColumn?.slashDates === true && dateColumn.order === null;
  if (!canCheck(messages)) return { step: 'match', columns, mapping, messages, orderAsked, locationValues, check: null };

  // checkTotals, with the API's `latest` in place of the page's tomorrow so both sides cut at the same date.
  const days = new DayAggregator(mapping, expected.latest, detectDelimiter(stripBom(text)));
  await scanText(text, { header: () => true, row: (cells, row) => { days.add(cells, row); return true; } }, OPTIONS);
  return { step: 'match', columns, mapping, messages, orderAsked, locationValues, check: days.finish() };
}

/** The API settles these by its own rules (a check column, a location named like this one); the person says them here. */
const CHOICES: Readonly<Record<string, Choices>> = {
  'check-level.csv': { rowMode: 'check' },
  'location.csv': { location: 'Location' },
  'location-unknown.csv': { location: 'Store' },
};

/**
 * Fixtures where the browser does not reach the API's outcome. Each names the gap; the tests below pin it exactly
 * and show that the browser's reader itself gives expected.json once past the step that differs.
 */
const DIFFERENCES: Readonly<Record<string, string>> = {
  // The API reads any text file. The page's file check (columns.ts checkFile) and its file control's `accept`
  // take only .csv and .txt, so a tab-separated export named .tsv is refused before it is read.
  'tab.tsv': 'refused by the file check (.tsv is not .csv or .txt)',
  // The API finds the header row in the first 30 rows (storage.md 7.2). The page takes row 1 as the header, so
  // rows 1 to 3 (the "Daily sales" title, the "Exported" line, a blank line) hide the real header on row 4, and
  // Match columns offers one column, "Daily sales", with no date column guessed.
  'title-block.csv': 'row 1 is taken as the header; the real header is row 4',
};

/** Where the browser and the API reach the same place by different routes. Both send nothing. */
const ROUTES: Readonly<Record<string, string>> = {
  // The API keeps the file as item-level from its header ("Menu Item", "Qty"). The page cannot tell: with its
  // default (One day), Check the totals refuses the repeated date and asks what one row is; only when the person
  // answers "One item on a check" does it say item-level exports are not supported.
  'item-level.csv': 'the API decides item-level from the header; the page asks the person',
};

describe('the browser upload against the shared fixtures', () => {
  test('every fixture is in expected.json, and every difference names a fixture', () => {
    expect(Object.keys(expected.files).sort()).toEqual(fixtures);
    for (const name of [...Object.keys(CHOICES), ...Object.keys(DIFFERENCES), ...Object.keys(ROUTES)]) expect(fixtures).toContain(name);
  });

  const days = fixtures.filter((name) => expected.files[name]?.outcome === 'days' && DIFFERENCES[name] === undefined);

  test.each(days)('%s: the browser sends exactly the days in expected.json', async (name) => {
    const want = expected.files[name];
    const seen = await browse(name, CHOICES[name]);
    expect(seen.step).toBe('match');
    if (seen.step !== 'match' || want?.outcome !== 'days') return;
    expect(seen.messages).toEqual({ row: [], date: [], values: [], locationValue: [] });
    expect(seen.orderAsked).toBe(false);
    expect(seen.check?.kind).toBe('days');
    if (seen.check?.kind !== 'days') return;
    expect(seen.check.days).toEqual(want.days);
    // What leaves the browser: exactly these days, three values each.
    expect(uploadBody(seen.check.days)).toEqual({ days: want.days });
  });

  test('slash-either.csv: the API asks the date order, and the page shows the Date order choice', async () => {
    expect(expected.files['slash-either.csv']).toEqual({ outcome: 'question', kind: 'date_order' });
    const seen = await browse('slash-either.csv');
    expect(seen).toMatchObject({ step: 'match', orderAsked: true, mapping: { dateOrder: 'month_first' } });
  });

  test('repeated-dates.csv: the API asks what one row is, and Check the totals refuses the repeated date', async () => {
    expect(expected.files['repeated-dates.csv']).toEqual({ outcome: 'question', kind: 'row_mode' });
    const seen = await browse('repeated-dates.csv');
    expect(seen).toMatchObject({ step: 'match', check: { kind: 'repeated_dates', dates: 1, repeats: { count: 1, rows: [3] } } });
  });

  test('location-unknown.csv: the API asks which value is this location, and so does the page', async () => {
    expect(expected.files['location-unknown.csv']).toEqual({ outcome: 'question', kind: 'location_value' });
    const seen = await browse('location-unknown.csv', CHOICES['location-unknown.csv']);
    expect(seen).toMatchObject({
      step: 'match', locationValues: ['North', 'South'], mapping: { locationValue: null }, check: null,
      messages: { locationValue: [`Choose which value is ${expected.locationName}.`] },
    });
  });

  test('semicolon-decimal-comma.csv: both refuse a decimal comma', async () => {
    expect(expected.files['semicolon-decimal-comma.csv']).toEqual({ outcome: 'kept', code: 'decimal_comma' });
    expect(await browse('semicolon-decimal-comma.csv')).toMatchObject({ step: 'match', check: { kind: 'decimal_comma' } });
  });

  test('notes-only.csv: the API keeps notes unread, and the page waits for a guests or net sales column', async () => {
    expect(expected.files['notes-only.csv']).toEqual({ outcome: 'kept', code: 'notes_not_read_yet' });
    expect(await browse('notes-only.csv')).toMatchObject({ step: 'match', check: null, messages: { values: [COPY.chooseValues] } });
  });

  test('no-header.csv: both refuse a file with no header row', async () => {
    expect(expected.files['no-header.csv']).toEqual({ outcome: 'kept', code: 'no_header' });
    expect(await browse('no-header.csv')).toEqual({ step: 'refused', reason: 'no_header' });
  });

  test('item-level.csv: the API keeps it as item-level; the page refuses it once the person says what one row is', async () => {
    expect(expected.files['item-level.csv']).toEqual({ outcome: 'kept', code: 'item_level' });
    expect(await browse('item-level.csv')).toMatchObject({ step: 'match', check: { kind: 'repeated_dates', repeats: { rows: [3] } } });
    expect(await browse('item-level.csv', { rowMode: 'item' })).toMatchObject({ step: 'match', check: null, messages: { row: [COPY.itemLevel] } });
  });
});

describe('where the browser and the API disagree (pinned, not resolved here)', () => {
  test('tab.tsv: the API reads its days; the page refuses the file by its extension', async () => {
    expect(expected.files['tab.tsv']?.outcome).toBe('days');
    expect(await browse('tab.tsv')).toEqual({ step: 'refused', reason: 'not_csv' });
  });

  test('tab.tsv: past the file check, the browser reader gives the same days', () => {
    const want = expected.files['tab.tsv'];
    const text = readFileSync(join(DIR, 'tab.tsv'), 'utf8');
    const [header, ...rows] = parseCsv(text);
    expect(detectDelimiter(text)).toBe('\t');
    const guess = guessColumns(header ?? []);
    const days = new DayAggregator({ rowMode: 'day', location: null, locationValue: null, dateOrder: 'month_first', ...guess }, expected.latest, '\t');
    rows.forEach((cells, index) => { days.add(cells, index + 2); });
    expect(days.finish()).toMatchObject({ kind: 'days', days: want?.outcome === 'days' ? want.days : [] });
  });

  test('title-block.csv: the API finds the header on row 4; the page takes row 1 and finds no date column', async () => {
    expect(expected.files['title-block.csv']?.outcome).toBe('days');
    const seen = await browse('title-block.csv');
    expect(seen).toMatchObject({ step: 'match', check: null, messages: { date: [COPY.chooseDate], values: [COPY.chooseValues] } });
    if (seen.step !== 'match') return;
    expect(seen.columns.map((column) => column.name)).toEqual(['Daily sales']);
  });

  test('title-block.csv: from the header the API finds, the browser reader gives the same days', () => {
    const want = expected.files['title-block.csv'];
    const records = parseCsv(readFileSync(join(DIR, 'title-block.csv'), 'utf8'));
    const header = records[3] ?? [];
    expect(header).toEqual(['Business Date', 'Guests', 'Net Sales']);
    const guess = guessColumns(header);
    const days = new DayAggregator({ rowMode: 'day', location: null, locationValue: null, dateOrder: 'month_first', ...guess }, expected.latest);
    records.slice(4).forEach((cells, index) => { days.add(cells, index + 5); });
    // Row 6, (2) guests and (15.00), is negative: left out on both sides.
    expect(days.finish()).toMatchObject({
      kind: 'days', days: want?.outcome === 'days' ? want.days : [], excluded: [{ date: '2025-07-02', reason: 'negative' }],
    });
  });
});
