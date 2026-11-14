import '../../viewer/setup';

import {
  addColumn, addRow, cellOf, editableOf, eolOf, gridOfRows, gridOfSheet, sameGrid, sameText, setCell, tableBytes, textBytes,
} from '../../../src/portal/data/item/edit';
import type { Opened } from '../../../src/portal/data/item/open';
import type { Delimited } from '../../../src/portal/viewer/text';
import type { Cell } from '../../../src/portal/viewer/xlsx';

// The rules of an edit on an item's page (edit.ts): what fits the editor, how a grid's ragged rows change, how a
// workbook cell's text is read back, and how line endings survive a browser's textarea, which reports them as LF.

const bytes = new Uint8Array();
const UTF8 = { encoding: 'utf-8', bom: false } as const;
const decode = (data: Uint8Array): string => new TextDecoder().decode(data);

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
  // A browser reports a cell's CRLF as LF: the same text, so the same cell.
  const crlf: Cell = { t: 's', v: 'two\r\nlines' };
  expect(cellOf('two\nlines', crlf)).toBe(crlf);
});

test('line endings: a text’s own, read when it opens; drafts compared without them; LF written back as the text’s own', () => {
  expect(eolOf('a\r\nb\r\n')).toBe('\r\n');
  expect(eolOf('a\r\nb')).toBe('\r\n');
  expect(eolOf('a\nb\n')).toBe('\n');
  expect(eolOf('a\r\nb\nc')).toBe('\n');
  expect(eolOf('a\r\nb\rc')).toBe('\n');
  expect(eolOf('\na\r\n')).toBe('\n');
  expect(eolOf('one line')).toBe('\n');
  expect(sameText('a\r\nb\rc', 'a\nb\nc')).toBe(true);
  expect(sameText('a\r\nb', 'a\nc')).toBe(false);
  expect(decode(textBytes('one\ntwo\n', '\r\n', UTF8))).toBe('one\r\ntwo\r\n');
  expect(decode(textBytes('one\ntwo\n', '\n', UTF8))).toBe('one\ntwo\n');
});

test('a CSV keeps an unchanged cell as the file had it; an edited cell’s line breaks take the table’s line ending', () => {
  // Excel's own layout: CRLF between records, LF inside a cell.
  const csv: Delimited = { rows: [['a', 'b'], ['x\ny', 'z']], delimiter: ',', eol: '\r\n', trailingEol: true, truncated: false };
  let grid = setCell(gridOfRows(csv.rows), 0, 1, 'B');
  expect(decode(tableBytes(csv, grid, UTF8))).toBe('a,B\r\n"x\ny",z\r\n');
  grid = setCell(grid, 1, 1, 'z\nw');
  expect(decode(tableBytes(csv, grid, UTF8))).toBe('a,B\r\n"x\ny","z\r\nw"\r\n');
  // A CRLF inside a cell is drafted as LF, as the browser shows it; typed back as it was, nothing changed.
  const crlf: Delimited = { ...csv, rows: [['two\r\nlines', 'x']] };
  const drafted = gridOfRows(crlf.rows);
  expect(drafted.rows[0]?.text).toEqual(['two\nlines', 'x']);
  const retyped = setCell(drafted, 0, 0, 'two\nlines');
  expect(sameGrid(retyped, drafted)).toBe(true);
  expect(decode(tableBytes(crlf, setCell(retyped, 0, 1, 'y'), UTF8))).toBe('"two\r\nlines",y\r\n');
  // A sheet's cells are drafted the same way.
  const sheet = gridOfSheet({ name: 'S', rows: [[{ t: 's', v: 'a\r\nb' }]], rowCount: 1, columnCount: 1, truncated: false });
  expect(sheet.rows[0]?.text).toEqual(['a\nb']);
});
