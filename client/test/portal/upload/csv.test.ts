import { CsvReader, detectDelimiter, isBlankRecord, parseCsv, stripBom } from '../../../src/portal/upload/csv';

// The RFC 4180 reader of spec 11.2 step 1. Every file here is synthetic.

describe('records and line breaks', () => {
  test('LF, CRLF and a lone CR all end a record', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(parseCsv('a,b\r1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\r\n1,2\n3,4\r5,6')).toEqual([['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']]);
  });

  test('a final line break adds no record; an empty line is one empty field', () => {
    expect(parseCsv('a\n\nb\n')).toEqual([['a'], [''], ['b']]);
    expect(parseCsv('')).toEqual([]);
  });

  test('empty fields, including a trailing delimiter at the end of a line and of the text', () => {
    expect(parseCsv('a,,c\n,b,\n1,2,')).toEqual([['a', '', 'c'], ['', 'b', ''], ['1', '2', '']]);
  });

  test('spaces around fields are kept for the value readers to trim', () => {
    expect(parseCsv('a , b\n 1,2 ')).toEqual([['a ', ' b'], [' 1', '2 ']]);
  });
});

describe('quoted fields', () => {
  test('a quoted field holds delimiters, line breaks of either kind, and doubled quotes', () => {
    const text = 'name,note\n"Smith, J.","said ""hi""\r\nthen left"\n"",x\n';
    expect(parseCsv(text)).toEqual([['name', 'note'], ['Smith, J.', 'said "hi"\r\nthen left'], ['', 'x']]);
  });

  test('a field that is only a doubled quote is one quote', () => {
    expect(parseCsv('a\n""""')).toEqual([['a'], ['"']]);
  });

  test('a quote inside an unquoted field is kept as it is', () => {
    expect(parseCsv('a,b\n5" pie,2')).toEqual([['a', 'b'], ['5" pie', '2']]);
  });

  test('characters after a closing quote stay part of the field (lenient)', () => {
    expect(parseCsv('"ab"c,d')).toEqual([['abc', 'd']]);
  });

  test('a text that ends inside a quoted field is flagged', () => {
    const reader = new CsvReader('a,b\n"open,1\n2,3', ',');
    expect(reader.next()).toEqual(['a', 'b']);
    expect(reader.unterminated).toBe(false);
    expect(reader.next()).toEqual(['open,1\n2,3']);
    expect(reader.unterminated).toBe(true);
    expect(reader.next()).toBeNull();
  });
});

describe('byte-order mark', () => {
  test('a leading BOM is stripped, so the first header reads cleanly', () => {
    expect(stripBom('\uFEFFDate,Guests')).toBe('Date,Guests');
    expect(parseCsv('\uFEFFDate,Guests\n2025-03-04,12')[0]).toEqual(['Date', 'Guests']);
  });

  test('only a leading BOM is stripped', () => {
    expect(stripBom('a\uFEFF')).toBe('a\uFEFF');
  });
});

describe('delimiter detection from the header line', () => {
  test('comma, semicolon or tab, whichever the header line uses most', () => {
    expect(detectDelimiter('Date,Guests,Net Sales\n')).toBe(',');
    expect(detectDelimiter('Date;Guests;Net Sales\n1,2;3;4,5')).toBe(';');
    expect(detectDelimiter('Date\tGuests\tNet Sales')).toBe('\t');
  });

  test('delimiters inside quotes and on later lines do not count', () => {
    expect(detectDelimiter('"Sales, net";Date;Guests\n1,2,3,4,5,6')).toBe(';');
    expect(detectDelimiter('"a;b;c",d\n;;;;')).toBe(',');
  });

  test('a single-column header and ties read as a comma', () => {
    expect(detectDelimiter('Date\n2025-03-04')).toBe(',');
    expect(detectDelimiter('a,b;c')).toBe(',');
  });

  test('parseCsv reads a semicolon file and a tab file', () => {
    expect(parseCsv('Date;Net\n2025-03-04;"1,5"')).toEqual([['Date', 'Net'], ['2025-03-04', '1,5']]);
    expect(parseCsv('Date\tNet\r\n2025-03-04\t12')).toEqual([['Date', 'Net'], ['2025-03-04', '12']]);
  });
});

test('isBlankRecord: an empty line or only delimiters and spaces', () => {
  expect(isBlankRecord([''])).toBe(true);
  expect(isBlankRecord(['', ' ', ''])).toBe(true);
  expect(isBlankRecord(['', 'x'])).toBe(false);
});
