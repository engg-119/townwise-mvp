// Tables read from a Word document (spec 11A): each w:tbl becomes rows of cells; paragraphs are never read into one.
// Documents are built in the test (helpers/zip.ts).
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readWord, tablesOfXml } from '../../src/files/parse/docx.ts';
import { runParse } from '../../src/files/parse/run.ts';
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
