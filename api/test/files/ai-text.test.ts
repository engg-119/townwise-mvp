// Text for reading with TownwiseAI (spec 11A.9): a PDF's lines, a workbook's sheets and a Word document's paragraphs
// and tables, made in the AI text thread with its limits, and a text file decoded as the sales reader decodes one.
// Every cut is reported, never silent. Files are built in the test (helpers/pdf.ts, helpers/zip.ts).
import { describe, expect, it } from 'vitest';

import { capText, extractAiText, textFileText } from '../../src/files/parse/ai-text.ts';
import { pdfOf, row } from '../helpers/pdf.ts';
import { xlsxOf, zipOf } from '../helpers/zip.ts';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (text: string): string => `<w:tc>${p(text)}</w:tc>`;
const tr = (...cells: string[]): string => `<w:tr>${cells.map(cell).join('')}</w:tr>`;

function docx(body: string): Buffer {
  return zipOf([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>` },
  ]);
}

const PDF = pdfOf([
  { texts: [{ text: 'Events for June', x: 72, y: 760 }, ...row(700, [[72, 'June 14'], [200, 'Wedding party, 80 guests']])] },
  { texts: [{ text: 'Closed July 4', x: 72, y: 760 }] },
]);

describe('the AI text thread', () => {
  it('reads a PDF’s pages as lines, pages apart by a blank line, with its page count', async () => {
    expect(await extractAiText({ kind: 'pdf', bytes: PDF, maxChars: 10_000 })).toEqual({
      kind: 'text', text: 'Events for June\nJune 14 Wedding party, 80 guests\n\nClosed July 4', cut: false, pages: 2,
    });
  });

  it('cuts a PDF’s text at the cap and says so', async () => {
    expect(await extractAiText({ kind: 'pdf', bytes: PDF, maxChars: 20 })).toEqual({ kind: 'text', text: 'Events for June\nJune', cut: true, pages: 2 });
  });

  it('keeps an encrypted PDF as encrypted and one that is not a PDF as not readable', async () => {
    expect(await extractAiText({ kind: 'pdf', bytes: pdfOf([{ texts: [{ text: 'x', x: 72, y: 700 }] }], { encrypted: true }), maxChars: 100 }))
      .toEqual({ kind: 'kept', outcome: 'encrypted' });
    expect(await extractAiText({ kind: 'pdf', bytes: Buffer.from('not a pdf'), maxChars: 100 })).toEqual({ kind: 'kept', outcome: 'not_readable' });
  });

  it('reads a workbook’s sheets as tab-separated rows under a Sheet line', async () => {
    const book = xlsxOf([
      { name: 'Daily', rows: [['Business Date', 'Guests', 'Net Sales'], [45658, 120, 3456.5]], dateColumns: [0] },
      { name: 'Notes', rows: [['Date', 'Note'], ['2025-01-01', 'Closed early']] },
    ]);
    expect(await extractAiText({ kind: 'xlsx', bytes: book, maxChars: 10_000 })).toEqual({
      kind: 'text',
      text: 'Sheet: Daily\nBusiness Date\tGuests\tNet Sales\n2025-01-01\t120\t3456.5\n\nSheet: Notes\nDate\tNote\n2025-01-01\tClosed early',
      cut: false, pages: null,
    });
    const cut = await extractAiText({ kind: 'xlsx', bytes: book, maxChars: 30 });
    expect(cut).toEqual({ kind: 'text', text: 'Sheet: Daily\nBusiness Date\tGue', cut: true, pages: null });
  });

  it('counts a workbook past its tenth sheet as cut', async () => {
    const sheets = Array.from({ length: 11 }, (_, index) => ({ name: `S${String(index + 1)}`, rows: [['a']] }));
    const made = await extractAiText({ kind: 'xlsx', bytes: xlsxOf(sheets), maxChars: 10_000 });
    expect(made).toMatchObject({ kind: 'text', cut: true });
    expect(made.kind === 'text' ? made.text : '').toContain('Sheet: S10');
    expect(made.kind === 'text' ? made.text : '').not.toContain('Sheet: S11');
  });

  it('reads a Word document’s paragraphs and tables, a table’s rows apart by tabs', async () => {
    const body = `${p('Spring menu')}<w:p><w:r><w:t>Soup</w:t></w:r><w:r><w:tab/><w:t>$8</w:t></w:r></w:p><w:tbl>${
      tr('Date', 'Event')}${tr('2025-05-01', 'Private party')}</w:tbl>${p('Last line &amp; more')}`;
    expect(await extractAiText({ kind: 'docx', bytes: docx(body), maxChars: 10_000 })).toEqual({
      kind: 'text', text: 'Spring menu\nSoup\t$8\nDate\tEvent\n2025-05-01\tPrivate party\nLast line & more', cut: false, pages: null,
    });
  });

  it('keeps a file that is not a Word package as not readable', async () => {
    expect(await extractAiText({ kind: 'docx', bytes: Buffer.from('nope'), maxChars: 100 })).toEqual({ kind: 'kept', outcome: 'not_readable' });
  });

  it('ends a thread past its time limit as too_complex', async () => {
    expect(await extractAiText({ kind: 'pdf', bytes: PDF, maxChars: 100, timeMs: 1 })).toEqual({ kind: 'kept', outcome: 'too_complex' });
  });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture')]);

describe('a ZIP’s entries in the AI text thread', () => {
  it('reads text, workbook, Word and PDF entries under "Entry n" lines, never their paths, and counts pictures skipped', async () => {
    const zip = zipOf([
      { name: 'Sentinel Party/covers.csv', data: 'Date,Covers\n2026-05-01,120\n' },
      { name: '__MACOSX/._covers.csv', data: 'junk' },
      { name: 'Sentinel Party/photo.png', data: PNG },
      { name: 'book.xlsx', data: xlsxOf([{ name: 'Daily', rows: [['Date', 'Covers'], ['2026-05-02', 98]] }]) },
      { name: 'rota.docx', data: docx(p('Staff rota')) },
      { name: 'events.pdf', data: PDF },
      { name: 'folder/', data: '' },
    ]);
    const made = await extractAiText({ kind: 'zip', bytes: zip, maxChars: 10_000 });
    expect(made).toEqual({
      kind: 'text',
      text: [
        'Entry 1 (a text file):\nDate,Covers\n2026-05-01,120\n',
        'Entry 2 (an Excel workbook):\nSheet: Daily\nDate\tCovers\n2026-05-02\t98',
        'Entry 3 (a Word document):\nStaff rota',
        'Entry 4 (a PDF document, as its text):\nEvents for June\nJune 14 Wedding party, 80 guests\n\nClosed July 4',
      ].join('\n\n'),
      source: [
        'Date,Covers\n2026-05-01,120\n', 'Sheet: Daily\nDate\tCovers\n2026-05-02\t98', 'Staff rota',
        'Events for June\nJune 14 Wedding party, 80 guests\n\nClosed July 4',
      ].join('\n'),
      cut: false, pages: null, skipped: 1,
    });
    expect(JSON.stringify(made)).not.toMatch(/Sentinel|covers\.csv|book\.xlsx|photo/);
  });

  it('reads at most 20 entries, and is cut when more follow', async () => {
    const zip = zipOf(Array.from({ length: 22 }, (_, index) => ({ name: `day${String(index + 1)}.csv`, data: `row ${String(index + 1)}` })));
    const made = await extractAiText({ kind: 'zip', bytes: zip, maxChars: 10_000 });
    expect(made).toMatchObject({ kind: 'text', cut: true, skipped: 2 });
    const text = made.kind === 'text' ? made.text : '';
    expect(text).toContain('Entry 20 (a text file):\nrow 20');
    expect(text).not.toContain('row 21');
  });

  it('stops at the cap and says the text was cut', async () => {
    const zip = zipOf([{ name: 'a.csv', data: 'a'.repeat(500) }, { name: 'b.csv', data: 'b'.repeat(500) }]);
    const made = await extractAiText({ kind: 'zip', bytes: zip, maxChars: 300 });
    expect(made).toMatchObject({ kind: 'text', cut: true });
    const text = made.kind === 'text' ? made.text : '';
    expect(text).toHaveLength(300);
    expect(text).not.toContain('b');
  });

  it('keeps an archive with no entry it reads as kind_not_read, one of encrypted entries as encrypted, and a bomb as not readable', async () => {
    expect(await extractAiText({ kind: 'zip', bytes: zipOf([{ name: 'photo.png', data: PNG }]), maxChars: 100 }))
      .toEqual({ kind: 'kept', outcome: 'kind_not_read' });
    expect(await extractAiText({ kind: 'zip', bytes: zipOf([{ name: 'a.csv', data: 'x', flags: 0x801 }]), maxChars: 100 }))
      .toEqual({ kind: 'kept', outcome: 'encrypted' });
    const bomb = zipOf([{ name: 'a.csv', data: 'x'.repeat(2048), declaredSize: 600 * 1024 * 1024 }]);
    expect(await extractAiText({ kind: 'zip', bytes: bomb, maxChars: 100 })).toEqual({ kind: 'kept', outcome: 'not_readable' });
    expect(await extractAiText({ kind: 'zip', bytes: Buffer.from('not a zip at all, long enough to look'), maxChars: 100 }))
      .toEqual({ kind: 'kept', outcome: 'not_readable' });
  });
});

describe('a text file’s text', () => {
  it('decodes UTF-8 and drops a byte-order mark', () => {
    expect(textFileText(Buffer.from('﻿Date,Guests\n2025-01-01,40\n', 'utf8'), false, 100)).toEqual({ text: 'Date,Guests\n2025-01-01,40\n', cut: false });
  });

  it('decodes UTF-16 by its mark, and windows-1252 when the bytes are not UTF-8', () => {
    expect(textFileText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Café', 'utf16le')]), false, 100)).toEqual({ text: 'Café', cut: false });
    expect(textFileText(Buffer.from([0x43, 0x61, 0x66, 0xe9]), false, 100)).toEqual({ text: 'Café', cut: false });
  });

  it('falls back to windows-1252 when bytes past the first 64 KiB are not UTF-8', () => {
    const bytes = Buffer.concat([Buffer.from('a'.repeat(70_000)), Buffer.from([0xe9])]);
    expect(textFileText(bytes, false, 100_000).text.endsWith('aé')).toBe(true);
  });

  it('is cut when the file goes on past the bytes read, leaving out a character cut in two', () => {
    const bytes = Buffer.from('ab€', 'utf8').subarray(0, 4);
    expect(textFileText(bytes, true, 100)).toEqual({ text: 'ab', cut: true });
  });

  it('is cut at the cap, never between the halves of a surrogate pair', () => {
    expect(textFileText(Buffer.from('abcdef'), false, 4)).toEqual({ text: 'abcd', cut: true });
    expect(capText('a😀b', 2)).toEqual({ text: 'a', cut: true });
  });
});
