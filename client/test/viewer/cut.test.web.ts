import './setup';

import { readDocument } from '../../src/portal/viewer/docx';
import { ViewerError } from '../../src/portal/viewer/errors';
import { readWorkbook } from '../../src/portal/viewer/xlsx';
import { documentBytes, para, workbookBytes } from './fixtures';

// An XML part larger than VIEW_LIMITS.xmlBytes, with the cap made small so the test stays fast: a worksheet or
// shared-strings part is cut at its last whole row or string, and anything else is too big.

jest.mock('../../src/portal/viewer/limits', () => {
  const actual = jest.requireActual<typeof import('../../src/portal/viewer/limits')>('../../src/portal/viewer/limits');
  return { VIEW_LIMITS: { ...actual.VIEW_LIMITS, xmlBytes: 4096 } };
});

const rowsXml = (count: number, cell: (i: number) => string): string =>
  Array.from({ length: count }, (_row, i) => `<row r="${String(i + 1)}"><c r="A${String(i + 1)}"${cell(i)}</c></row>`).join('');

test('a worksheet past the cap keeps its whole rows and is truncated', async () => {
  const workbook = await readWorkbook(workbookBytes({ sheets: [['Big', rowsXml(500, (i) => `><v>${String(i)}</v>`)]] }));
  const [sheet] = workbook.sheets;
  expect(sheet?.truncated).toBe(true);
  expect(workbook.truncated).toBe(true);
  const count = sheet?.rowCount ?? 0;
  expect(count).toBeGreaterThan(50);
  expect(count).toBeLessThan(500);
  expect(sheet?.rows.map((row) => row[0])).toEqual(Array.from({ length: count }, (_row, i) => ({ t: 'n', v: i })));
});

test('a cut shared-strings part leaves the strings past the cut out, and truncates only the sheets that name them', async () => {
  const strings = Array.from({ length: 400 }, (_s, i) => `string ${String(i)}`);
  const workbook = await readWorkbook(workbookBytes({
    sharedStrings: strings,
    sheets: [
      ['Early', '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'],
      ['Late', '<row r="1"><c r="A1" t="s"><v>2</v></c><c r="B1" t="s"><v>399</v></c></row>'],
    ],
  }));
  expect(workbook.sheets.map((sheet) => [sheet.name, sheet.truncated])).toEqual([['Early', false], ['Late', true]]);
  expect(workbook.sheets[1]?.rows).toEqual([[{ t: 's', v: 'string 2' }]]);
  expect(workbook.truncated).toBe(true);
});

test('a Word document part past the cap is too big', async () => {
  const body = Array.from({ length: 200 }, (_p, i) => para(`Paragraph ${String(i)}`)).join('');
  await expect(readDocument(documentBytes(body))).rejects.toEqual(expect.objectContaining({ reason: 'too_big' }));
  await expect(readDocument(documentBytes(body))).rejects.toBeInstanceOf(ViewerError);
});
