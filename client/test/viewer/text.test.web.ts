import './setup';

import { ViewerError } from '../../src/portal/viewer/errors';
import { VIEW_LIMITS } from '../../src/portal/viewer/limits';
import { decodeText, encodeText, parseDelimited, toDelimited } from '../../src/portal/viewer/text';

// Text files and CSV or TSV tables, decoded and written back. Every file here is synthetic.

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const utf8 = (text: string): number[] => Array.from(new TextEncoder().encode(text));

describe('decoding', () => {
  test('UTF-8 without and with a byte-order mark', () => {
    expect(decodeText(bytes(...utf8('Café ☕')))).toEqual({ text: 'Café ☕', encoding: 'utf-8', bom: false });
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, ...utf8('Café')))).toEqual({ text: 'Café', encoding: 'utf-8', bom: true });
  });

  test('UTF-16 by its byte-order mark, either byte order', () => {
    expect(decodeText(bytes(0xff, 0xfe, 0x48, 0x00, 0xe9, 0x00))).toEqual({ text: 'Hé', encoding: 'utf-16le', bom: true });
    expect(decodeText(bytes(0xfe, 0xff, 0x00, 0x48, 0x00, 0xe9))).toEqual({ text: 'Hé', encoding: 'utf-16be', bom: true });
  });

  test('bytes that are not UTF-8 read as windows-1252, as Excel on Windows saves CSV', () => {
    // "Café, 5€" in windows-1252: é is 0xE9 and € is 0x80.
    expect(decodeText(bytes(0x43, 0x61, 0x66, 0xe9, 0x2c, 0x20, 0x35, 0x80))).toEqual({ text: 'Café, 5€', encoding: 'windows-1252', bom: false });
  });

  test('an empty file is UTF-8', () => {
    expect(decodeText(new Uint8Array(0))).toEqual({ text: '', encoding: 'utf-8', bom: false });
  });

  test('encoding is always UTF-8, with the UTF-8 mark when asked', () => {
    expect(Array.from(encodeText('Hé', false))).toEqual(utf8('Hé'));
    expect(Array.from(encodeText('Hé', true))).toEqual([0xef, 0xbb, 0xbf, ...utf8('Hé')]);
    const round = decodeText(encodeText('Day,Guests\r\n', true));
    expect(round).toEqual({ text: 'Day,Guests\r\n', encoding: 'utf-8', bom: true });
  });
});

describe('delimited tables', () => {
  const roundTrips = [
    ['LF with a final line ending', 'Day,Guests\n2024-03-15,42\n'],
    ['CRLF with a final line ending', 'Day,Guests\r\n2024-03-15,42\r\n'],
    ['no final line ending', 'Day,Guests\n2024-03-15,42'],
    ['quotes, delimiters and embedded line endings', 'Note,Count\n"He said ""hi""",1\n"a, b",2\n"line one\nline two",3\n"crlf\r\ninside",4\n'],
    ['leading and trailing spaces quoted', 'a," padded ",b\n'],
    ['ragged rows and empty fields', 'a,b,c\n1\n,,\n\n2,3\n'],
    ['semicolons', 'Day;Guests\n2024-03-15;42\n"x;y";1\n'],
    ['tabs', 'Day\tGuests\n2024-03-15\t42\n"has\ttab"\t1\n'],
    ['a single empty line', '\n'],
    ['empty', ''],
  ] as const;

  test.each(roundTrips)('%s comes back byte for byte', (_label, text) => {
    expect(toDelimited(parseDelimited(text))).toBe(text);
  });

  test('reads rows, delimiter and line ending', () => {
    expect(parseDelimited('Note,Count\r\n"He said ""hi""",1\r\n"two\r\nlines",2\r\n')).toEqual({
      rows: [['Note', 'Count'], ['He said "hi"', '1'], ['two\r\nlines', '2']],
      delimiter: ',',
      eol: '\r\n',
      trailingEol: true,
      truncated: false,
    });
    expect(parseDelimited('a\tb\nc\td')).toMatchObject({ rows: [['a', 'b'], ['c', 'd']], delimiter: '\t', eol: '\n', trailingEol: false });
  });

  test('a given delimiter wins over detection, and a byte-order mark is not a field', () => {
    expect(parseDelimited('a,b\tc\n', '\t').rows).toEqual([['a,b', 'c']]);
    expect(parseDelimited('﻿a,b\n').rows).toEqual([['a', 'b']]);
  });

  test('a line ending inside quotes is not the file’s line ending', () => {
    expect(parseDelimited('"a\nb",c\r\nd,e\r\n').eol).toBe('\r\n');
    expect(parseDelimited('"a\r\nb",c\nd,e\n').eol).toBe('\n');
  });

  test('edited rows are quoted as needed', () => {
    const table = parseDelimited('Day,Note\n1,plain\n');
    const edited = { ...table, rows: [...table.rows, ['2', 'has, comma'], ['3', 'has "quote"'], ['4', ' space'], ['5', 'new\nline']] };
    expect(toDelimited(edited)).toBe('Day,Note\n1,plain\n2,"has, comma"\n3,"has ""quote"""\n4," space"\n5,"new\nline"\n');
  });

  test('more rows or columns than are read truncate the table, and a truncated table is not written', () => {
    const long = parseDelimited('x\n'.repeat(VIEW_LIMITS.sheetRows + 1));
    expect(long.rows).toHaveLength(VIEW_LIMITS.sheetRows);
    expect(long.truncated).toBe(true);
    const wide = parseDelimited(`${'c,'.repeat(VIEW_LIMITS.sheetColumns)}c\n`);
    expect(wide.rows[0]).toHaveLength(VIEW_LIMITS.sheetColumns);
    expect(wide.truncated).toBe(true);
    expect(() => toDelimited(long)).toThrow(ViewerError);
    expect(parseDelimited('x\n'.repeat(VIEW_LIMITS.sheetRows)).truncated).toBe(false);
  });
});
