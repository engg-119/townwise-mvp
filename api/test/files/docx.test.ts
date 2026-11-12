// Tables read from a Word document (spec 11A): each w:tbl becomes rows of cells; paragraphs are never read into one.
// And the text TownwiseAI reads of a Word reference item (openspec change connect-owner-calendar, design decision 9):
// paragraphs and tables, cut at a character limit, through the parse thread. Documents are built in the test
// (helpers/zip.ts).
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readWord, readWordText, tablesOfXml, textOfXml } from '../../src/files/parse/docx.ts';
import { runItemRead, runParse } from '../../src/files/parse/run.ts';
import { zipOf } from '../helpers/zip.ts';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const cell = (text: string): string => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
const tr = (...cells: string[]): string => `<w:tr>${cells.map(cell).join('')}</w:tr>`;

function docx(body: string): Buffer {
  return zipOf([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>` },
  ]);
}

const TABLE = `<w:p><w:r><w:t>Notes for Zqxj Party Of Twelve</w:t></w:r></w:p><w:tbl>${
  tr('Date', 'Guests', 'Net Sales')}${tr('2025-01-01', '10', '100.00')}${tr('2025-01-02', '12', '120.00')}</w:tbl>`;

const base = { answers: {}, locationName: 'Main', latest: '2026-06-02', replace: true, onProgress: () => undefined } as const;

describe('Word tables', () => {
  it('reads a table to days, through the parse thread', async () => {
    const file = docx(TABLE);
    const outcome = await runParse({ ...base, kind: 'docx', sizeBytes: file.length, open: () => Promise.resolve(Readable.from([file])) });
    expect(outcome).toMatchObject({
      kind: 'days',
      days: [{ date: '2025-01-01', guests: 10, netSalesCents: 10_000 }, { date: '2025-01-02', guests: 12, netSalesCents: 12_000 }],
      report: { sheets: [{ name: 'Table 1', used: true, why: 'sales' }] },
    });
  });

  it('never reads a paragraph into a row, and decodes the XML entities in cells', async () => {
    const found = await readWord(docx(TABLE));
    expect(JSON.stringify(found)).not.toContain('Zqxj');
    expect(tablesOfXml(`<w:document ${W}><w:body><w:tbl>${tr('A &amp; B', '&lt;1&gt;')}</w:tbl></w:body></w:document>`))
      .toEqual([{ name: 'Table 1', rows: [['A & B', '<1>']] }]);
  });

  it('keeps a document of paragraphs only, and a package that is not a Word document', async () => {
    expect(await readWord(docx('<w:p><w:r><w:t>Just a letter</w:t></w:r></w:p>'))).toEqual({ kind: 'kept', outcome: 'word_no_table' });
    expect(await readWord(zipOf([{ name: 'other.xml', data: '<x/>' }]))).toEqual({ kind: 'kept', outcome: 'not_a_workbook' });
  });
});

describe('Word text for TownwiseAI', () => {
  const para = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const xml = (body: string): string => `<w:document ${W}><w:body>${body}</w:body></w:document>`;

  it('puts each paragraph on a line, keeps tabs and line breaks, and decodes entities', () => {
    const body = `${para('Spring menu')}<w:p><w:r><w:t>Soup</w:t><w:tab/><w:t>$8</w:t><w:br/><w:t>Bread &amp; butter</w:t></w:r></w:p>${para('')}${para('')}${para('')}${para('Thanks')}`;
    expect(textOfXml(xml(body), 1000)).toEqual({ text: 'Spring menu\nSoup\t$8\nBread & butter\n\nThanks', truncated: false });
  });

  it('puts each table row on a line with its cells between tabs, a nested table in its cell, and skips mc:Fallback', () => {
    const nested = `<w:tc>${para('Patio')}<w:tbl>${tr('inner')}</w:tbl></w:tc>`;
    const body = `${para('Events')}<w:tbl>${tr('Date', 'Party')}<w:tr>${cell('Dec 12')}${nested}</w:tr></w:tbl>`
      + `<w:p><mc:AlternateContent><mc:Choice><w:t>Box</w:t></mc:Choice><mc:Fallback><w:t>Box</w:t></mc:Fallback></mc:AlternateContent></w:p>`;
    expect(textOfXml(xml(body), 1000)).toEqual({ text: 'Events\nDate\tParty\nDec 12\tPatio inner\nBox', truncated: false });
  });

  it('cuts at the limit and says so, never splitting a character in two', () => {
    const long = textOfXml(xml(para('a'.repeat(50_000))), 20_000);
    expect(long.text).toHaveLength(20_000);
    expect(long.truncated).toBe(true);
    const edge = textOfXml(xml(para(`${'a'.repeat(9)}\u{1F600}${'b'.repeat(20)}`)), 10);
    expect(edge).toEqual({ text: 'a'.repeat(9), truncated: true });
  });

  it('reads a document’s text through the parse thread, and answers what it cannot open or finish', async () => {
    const file = docx(`${para('Private party Dec 12')}<w:tbl>${tr('Date', 'Guests')}</w:tbl>`);
    expect(await runItemRead({ job: { kind: 'word_text', maxChars: 20_000 }, bytes: file }))
      .toEqual({ kind: 'text', text: 'Private party Dec 12\nDate\tGuests', truncated: false });
    // The caller keeps its bytes: they are copied to the thread.
    expect(file.length).toBeGreaterThan(0);
    expect(await runItemRead({ job: { kind: 'word_text', maxChars: 20_000 }, bytes: zipOf([{ name: 'other.xml', data: '<x/>' }]) }))
      .toEqual({ kind: 'cannot_open' });
    expect(await runItemRead({ job: { kind: 'word_text', maxChars: 20_000 }, bytes: Buffer.from('not a zip') })).toEqual({ kind: 'cannot_open' });
    expect(await runItemRead({ job: { kind: 'word_text', maxChars: 20_000 }, bytes: file, timeMs: 1 })).toEqual({ kind: 'too_large' });
  }, 30_000);

  it('keeps XML that does not parse as a package it cannot open', async () => {
    const broken = zipOf([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: `<w:document ${W}><w:body><w:p><w:t>open` },
    ]);
    expect(await readWordText(broken, 100)).toEqual({ kind: 'kept', outcome: 'not_a_workbook' });
  });
});
