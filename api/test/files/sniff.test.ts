import { describe, expect, it } from 'vitest';

import { kindLabel, kindOfName, sanitizeName, sniff } from '../../src/files/sniff.ts';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): Uint8Array => Buffer.from(text, 'latin1');
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0);
const EMPTY_ZIP = bytes(0x50, 0x4b, 0x05, 0x06, 0, 0);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1);

describe('sniff (spec 11A, the kind table): no file is refused', () => {
  it.each<[string, Uint8Array, string, string | null]>([
    ['report.pdf', ascii('%PDF-1.7\n'), 'pdf', null],
    ['scan.csv', ascii(`${' '.repeat(100)}%PDF-1.4`), 'pdf', null],
    ['sales.xlsx', ZIP, 'xlsx', null],
    ['macros.xlsm', ZIP, 'xlsx', null],
    ['notes.docx', ZIP, 'docx', null],
    ['sheet.numbers', ZIP, 'other', 'numbers'],
    ['export.zip', ZIP, 'zip', null],
    ['export', EMPTY_ZIP, 'zip', null],
    ['old.xls', OLE, 'xls', 'old_excel'],
    ['old.doc', OLE, 'doc', 'old_word'],
    ['locked.xlsx', OLE, 'other', 'encrypted'],
    ['locked.docx', OLE, 'other', 'encrypted'],
    ['photo.png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a), 'other', 'image'],
    ['photo.jpg', bytes(0xff, 0xd8, 0xff, 0xe0), 'other', 'image'],
    ['photo.gif', ascii('GIF89a'), 'other', 'image'],
    ['photo.webp', ascii('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), 'other', 'image'],
    ['photo.heic', ascii('\u0000\u0000\u0000\u0018ftypheic'), 'other', 'image'],
    ['sales.csv', ascii('Date,Guests\r\n2025-01-01,10\r\n'), 'text', null],
    ['sales.TSV', ascii('Date\tGuests\n'), 'text', null],
    ['notes.txt', ascii('hello'), 'text', null],
    ['unicode.txt', bytes(0xff, 0xfe, 0x44, 0x00, 0x61, 0x00), 'text', null],
    ['no-extension', ascii('Date,Guests\n'), 'text', null],
    ['binary.csv', bytes(0x44, 0x00, 0x61), 'other', 'type_not_read'],
    ['program.exe', ascii('MZ\u0090\u0000'), 'other', 'type_not_read'],
  ])('%s', (name, head, kind, outcome) => {
    expect(sniff(name, head)).toEqual({ kind, outcome });
  });

  it('guesses a kind from the name alone while a file uploads, and names each kind without the file name', () => {
    expect(['a.csv', 'a.XLSX', 'a.pdf', 'a.zip', 'a.doc', 'a.numbers'].map(kindOfName)).toEqual(['text', 'xlsx', 'pdf', 'zip', 'doc', 'other']);
    expect(kindLabel('text')).toBe('CSV or text file');
  });

  it('keeps the last path part, removes control characters, and caps the length', () => {
    expect(sanitizeName('C:\\Users\\Owner\\Downloads\\Sales\u0007 2025.csv')).toBe('Sales 2025.csv');
    expect(sanitizeName('folder/sub/e\u0301te.csv')).toBe('\u00e9te.csv');
    expect(sanitizeName(`${'a'.repeat(300)}.csv`)).toHaveLength(255);
  });
});
