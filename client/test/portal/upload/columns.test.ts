import {
  checkFile, guessColumns, lacksHeader, LocationValues, looksBinary, MAX_FILE_BYTES, Profiler, type ColumnProfile,
} from '../../../src/portal/upload/columns';
import { parseCsv } from '../../../src/portal/upload/csv';

// What the Match columns step knows about a file (spec 11.2 steps 1 and 2, D11). Every file here is synthetic.

const SENTINEL = 'Zelda Sentinelname';

function profile(text: string): ColumnProfile[] {
  const [header, ...rows] = parseCsv(text);
  const profiler = new Profiler(header ?? []);
  for (const row of rows) profiler.add(row);
  return profiler.finish();
}

describe('file checks before reading', () => {
  test('larger than 50 MB is refused; 50 MB is allowed', () => {
    expect(MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
    expect(checkFile({ name: 'export.csv', size: MAX_FILE_BYTES + 1 })).toBe('too_large');
    expect(checkFile({ name: 'export.csv', size: MAX_FILE_BYTES })).toBeNull();
  });

  test('.csv or .txt, in any case; an Excel or other file is not a CSV file', () => {
    expect(checkFile({ name: 'export.CSV', size: 10 })).toBeNull();
    expect(checkFile({ name: 'export.txt', size: 10 })).toBeNull();
    expect(checkFile({ name: 'export.xlsx', size: 10 })).toBe('not_csv');
    expect(checkFile({ name: 'export.xls', size: 10 })).toBe('not_csv');
    expect(checkFile({ name: 'export', size: 10 })).toBe('not_csv');
  });

  test('a spreadsheet renamed to .csv reads as binary', () => {
    expect(looksBinary('PK\u0003\u0004[Content_Types].xml')).toBe(true);
    expect(looksBinary('Date,Guests\n\u0000\u0000')).toBe(true);
    expect(looksBinary('Date,Guests\n2025-03-04,12\n')).toBe(false);
  });
});

describe('the header row', () => {
  test('an empty file, a blank first row, or a first row of dates and numbers has no header', () => {
    expect(lacksHeader(null)).toBe(true);
    expect(lacksHeader(['', ' '])).toBe(true);
    expect(lacksHeader(['2025-03-04', '12', '$1,204.50'])).toBe(true);
    expect(lacksHeader(['3/4/2025', '', '12'])).toBe(true);
  });

  test('a first row with a name is a header', () => {
    expect(lacksHeader(['Date', 'Guests'])).toBe(false);
    expect(lacksHeader(['Business Date', '', ''])).toBe(false);
  });
});

describe('column kinds from the first 200 non-empty cells', () => {
  test('dates, numbers, text and empty columns', () => {
    const rows = Array.from({ length: 5 }, (_, i) => `2025-03-0${String(i + 1)},${String(i * 3)},"$1,20${String(i)}.00",${SENTINEL},`);
    expect(profile(['Business Date,Guest Count,Net Sales,Customer,Notes', ...rows].join('\n')).map((column) => [column.name, column.kind])).toEqual([
      ['Business Date', 'dates'], ['Guest Count', 'numbers'], ['Net Sales', 'numbers'], ['Customer', 'text'], ['Notes', 'empty'],
    ]);
  });

  test('cells after the first 200 non-empty ones do not change the kind; empty cells do not count', () => {
    const lines = ['Guests'];
    for (let i = 0; i < 50; i += 1) lines.push('');
    for (let i = 0; i < 200; i += 1) lines.push(String(i));
    for (let i = 0; i < 300; i += 1) lines.push('n/a');
    expect(profile(lines.join('\n'))[0]?.kind).toBe('numbers');
  });

  test('the kind is the most common one in the sample, dates before numbers on a tie', () => {
    expect(profile('a\n1\n2\nx')[0]?.kind).toBe('numbers');
    expect(profile('a\nx\ny\n1')[0]?.kind).toBe('text');
    expect(profile('a\n20250304\n12')[0]?.kind).toBe('dates');
  });

  test('a profile holds header names and kinds, never a cell (D11)', () => {
    const columns = profile(`Date,Customer\n2025-03-04,${SENTINEL}\n2025-03-05,${SENTINEL}`);
    expect(JSON.stringify(columns)).not.toContain('Sentinel');
  });

  test('rows shorter or longer than the header are read safely', () => {
    expect(profile('Date,Guests\n2025-03-04\n2025-03-05,4,extra').map((column) => column.kind)).toEqual(['dates', 'numbers']);
  });
});

describe('slash date order from the whole column', () => {
  test('a first part above 12 anywhere, even after the sample, sets day first', () => {
    const lines = ['Date'];
    for (let i = 0; i < 400; i += 1) lines.push('03/04/2025');
    lines.push('13/04/2025');
    const [column] = profile(lines.join('\n'));
    expect(column).toMatchObject({ kind: 'dates', slashDates: true, order: 'day_first' });
  });

  test('a second part above 12 sets month first', () => {
    expect(profile('Date\n03/04/2025\n03/14/2025')[0]).toMatchObject({ slashDates: true, order: 'month_first' });
  });

  test('dates that read either way leave the order to the person', () => {
    expect(profile('Date\n03/04/2025\n12/11/2025 10:00 PM')[0]).toMatchObject({ slashDates: true, order: null });
  });

  test('full dates need no order', () => {
    expect(profile('Date\n2025-03-14\n20250315')[0]).toMatchObject({ slashDates: false, order: null });
  });
});

describe('header guesses', () => {
  test('date from date or business date (business date first); guests from guests, covers or guest count; net sales', () => {
    expect(guessColumns(['Date', 'Covers', 'Net Sales', 'Business Date'])).toEqual({ date: 3, guests: 1, netSales: 2 });
    expect(guessColumns(['date', 'GUESTS', 'net_sales'])).toEqual({ date: 0, guests: 1, netSales: 2 });
    expect(guessColumns([' Guest  Count ', 'Order Date', 'Gross Sales'])).toEqual({ date: null, guests: 0, netSales: null });
  });

  test('no match leaves a picker empty', () => {
    expect(guessColumns(['Opened', 'Party size', 'Total'])).toEqual({ date: null, guests: null, netSales: null });
  });
});

describe('location values', () => {
  test('distinct, trimmed, non-empty and sorted', () => {
    const values = new LocationValues(1);
    for (const row of [['x', ' River Grill '], ['x', 'Main Street Bar'], ['x', ''], ['x', 'River Grill'], ['x']]) values.add(row);
    expect(values.values()).toEqual(['Main Street Bar', 'River Grill']);
    expect(values.more).toBe(false);
  });

  test('stops after 50 distinct values and says there are more', () => {
    const values = new LocationValues(0);
    let going = true;
    let added = 0;
    for (let i = 0; i < 80 && going; i += 1) {
      going = values.add([`Place ${String(i).padStart(2, '0')}`]);
      added += 1;
    }
    expect(values.values()).toHaveLength(50);
    expect(values.more).toBe(true);
    expect(added).toBe(51);
  });
});
