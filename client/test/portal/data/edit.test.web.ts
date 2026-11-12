import { addColumn, addRow, cellOf, editableOf, gridOfRows, sameGrid, setCell } from '../../../src/portal/data/item/edit';
import type { Opened } from '../../../src/portal/data/item/open';
import type { Cell } from '../../../src/portal/viewer/xlsx';

// The rules of an edit on an item's page (edit.ts): what fits the editor, how a grid's ragged rows change, and how a
// workbook cell's text is read back.

const bytes = new Uint8Array();

function table(rows: string[][], truncated = false): Opened {
  return { viewer: 'delimited', bytes, table: { rows, delimiter: ',', eol: '\n', trailingEol: true, truncated }, encoding: 'utf-8', bom: false };
}

test('what fits: text up to 200,000 characters; a table read whole up to 1,000 rows by 50 columns; nothing else', () => {
  expect(editableOf({ viewer: 'text', bytes, text: 'a'.repeat(200_000), encoding: 'utf-8', bom: false })).toEqual({ kind: 'text', fits: true });
  expect(editableOf({ viewer: 'text', bytes, text: 'a'.repeat(200_001), encoding: 'utf-8', bom: false })).toEqual({ kind: 'text', fits: false });
  const wide = Array.from({ length: 50 }, () => 'x');
  expect(editableOf(table(Array.from({ length: 1000 }, () => wide)))).toEqual({ kind: 'table', fits: true });
  expect(editableOf(table(Array.from({ length: 1001 }, () => ['x'])))).toEqual({ kind: 'table', fits: false });
  expect(editableOf(table([['x'], [...wide, 'one more']]))).toEqual({ kind: 'table', fits: false });
  expect(editableOf(table([['x']], true))).toEqual({ kind: 'table', fits: false });
  expect(editableOf({ viewer: 'pdf', bytes })).toBeNull();
  expect(editableOf({ viewer: 'workbook', bytes, workbook: { sheets: [], truncated: false } })).toBeNull();
});

test('a ragged row grows only where typed past its end, shrinks back when cleared, and Add a column skips it', () => {
  const grid = gridOfRows([['a', 'b', 'c'], ['d']]);
  expect(setCell(grid, 1, 2, '')).toBe(grid);
  const typed = setCell(grid, 1, 2, 'x');
  expect(typed.rows[1]?.text).toEqual(['d', '', 'x']);
  const cleared = setCell(typed, 1, 2, '');
  expect(cleared.rows[1]?.text).toEqual(['d']);
  expect(sameGrid(cleared, grid)).toBe(true);
  const wider = addColumn(grid);
  expect(wider.width).toBe(4);
  expect(wider.rows.map((row) => row.text)).toEqual([['a', 'b', 'c', ''], ['d']]);
  // The new column's empty cell is the row's own now: clearing a cell before it doesn't drop it.
  expect(setCell(wider, 0, 3, '').rows[0]?.text).toEqual(['a', 'b', 'c', '']);
  expect(addRow(wider).rows[2]?.text).toEqual(['', '', '', '']);
});

test('a workbook cell: unchanged text keeps the cell; a time with no date keeps its date part; types hold while they read', () => {
  const time: Cell = { t: 'd', v: '1899-12-31T12:00:00' };
  expect(cellOf('12:00:00', time)).toBe(time);
  expect(cellOf('13:30:00', time)).toEqual({ t: 'd', v: '1899-12-31T13:30:00' });
  const date: Cell = { t: 'd', v: '2026-01-05' };
  expect(cellOf('2026-01-05', date)).toBe(date);
  expect(cellOf('2026-02-01', date)).toEqual({ t: 'd', v: '2026-02-01' });
  expect(cellOf('next week', date)).toEqual({ t: 's', v: 'next week' });
  expect(cellOf('1e3', { t: 'n', v: 7 })).toEqual({ t: 'n', v: 1000 });
  expect(cellOf('00123', { t: 'empty' })).toEqual({ t: 's', v: '00123' });
  expect(cellOf('', { t: 'n', v: 7 })).toEqual({ t: 'empty' });
});
