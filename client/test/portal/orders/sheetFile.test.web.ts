import '../../viewer/setup';

import { readSheetFile, SHEET_COPY } from '../../../src/portal/orders/sheetFile.web';
import { VIEW_LIMITS } from '../../../src/portal/viewer/limits';
import { workbookBytes } from '../../viewer/fixtures';

// The sheet reader shared by the ordering sheet import and the item sales upload (sheetFile.web.ts). A workbook read
// only in part is refused whole, with copy that fits both callers and either cause, too many rows or too many columns
// (#68 review C15). Every cell here is synthetic.

function workbook(sheetData: string): File {
  return new File([workbookBytes({ sheets: [['Sheet1', sheetData]] }) as Uint8Array<ArrayBuffer>], 'items.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

async function read(file: File): Promise<{ outcome: Awaited<ReturnType<typeof readSheetFile>>; rows: number }> {
  let rows = 0;
  const outcome = await readSheetFile(file, { header: () => undefined, row: () => { rows += 1; } }, () => false);
  return { outcome, rows };
}

test('a workbook cut at its rows or its columns is refused whole, with copy that names neither the import nor days', async () => {
  expect(SHEET_COPY.sheetCut).toBe(
    'That workbook is larger than Townwise reads from Excel (5,000 rows and 200 columns), so none of it was read. Export it as CSV instead.',
  );
  const long = Array.from({ length: VIEW_LIMITS.sheetRows + 1 }, (_row, i) => `<row r="${String(i + 1)}"><c r="A${String(i + 1)}"><v>${String(i)}</v></c></row>`).join('');
  expect(await read(workbook(long))).toEqual({ outcome: { problem: SHEET_COPY.sheetCut }, rows: 0 });
  const wide = '<row r="1"><c r="A1"><v>1</v></c><c r="GS1"><v>201</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>';
  expect(await read(workbook(wide))).toEqual({ outcome: { problem: SHEET_COPY.sheetCut }, rows: 0 });
  // A workbook inside both limits is read row by row.
  expect(await read(workbook('<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>'))).toEqual({ outcome: 'done', rows: 1 });
});
