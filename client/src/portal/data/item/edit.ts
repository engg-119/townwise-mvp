import { VIEW_LIMITS } from '../../viewer/limits';
import { encodeText, toDelimited, type Delimited, type TextEncoding } from '../../viewer/text';
import { cellFromText, cellText, normalizeIso, type Cell, type Sheet, type Workbook } from '../../viewer/xlsx';
import { writeWorkbook } from '../../viewer/xlsxWrite';
import { shownCell, type Opened } from './open';

// What an edit on an item's page (P27, D28) works on, as plain data: whether what opened can be edited here, the
// draft of a CSV or a sheet as a grid of text, and the bytes a draft saves as. Text and CSV save in place, as UTF-8
// with a byte-order mark when the file had one or wasn't UTF-8 (Excel reads a CSV without one in its own code page);
// a workbook saves as a values-only copy. Imported only by .web files (it reads open.ts), except for its types.
//
// Line endings: a browser reports a <textarea>'s value with every CRLF and CR made LF, so a draft holds LF only and is
// compared with what opened regardless of line endings (sameText). Saving writes the line breaks back as the file had
// them: text by the ending it opened with (eolOf), a CSV cell whose text is unchanged exactly as the file had it, and
// an edited cell's line breaks by the table's own line ending (Delimited.eol).

export type EditKind = 'text' | 'table' | 'workbook';

export type Eol = '\r\n' | '\n';

/** CRLF when every line break in `text` is a CRLF (and it has one), else LF. */
export function eolOf(text: string): Eol {
  return text.includes('\r\n') && !/\r(?!\n)|(?:^|[^\r])\n/.test(text) ? '\r\n' : '\n';
}

/** `text` as a browser reports a textarea's value: every CRLF and CR made LF. */
export function lfText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** True when two texts differ at most in their line endings. */
export function sameText(a: string, b: string): boolean {
  return a === b || lfText(a) === lfText(b);
}

/** `text` with every line break written as `eol`. */
export function withEol(text: string, eol: Eol): string {
  return text.replace(/\r\n?|\n/g, eol);
}

/** What opened can be edited as `kind`, if it `fits` the editor's limits (VIEW_LIMITS.editRows and the rest). */
export interface Editable {
  kind: EditKind;
  fits: boolean;
}

/** How a save ended, for the line the page shows next: in place, or as a copy beside the original. */
export type Saved = 'edited' | 'copy';

/** What opened, when it is something the editor takes. */
export type EditableOpened = Extract<Opened, { viewer: 'text' | 'delimited' | 'workbook' }>;

export function isEditable(opened: Opened): opened is EditableOpened {
  return opened.viewer === 'text' || opened.viewer === 'delimited' || opened.viewer === 'workbook';
}

function fitsTable(rows: number, columns: number): boolean {
  return rows <= VIEW_LIMITS.editRows && columns <= VIEW_LIMITS.editColumns;
}

function widest(rows: readonly (readonly unknown[])[]): number {
  return rows.reduce((most, row) => Math.max(most, row.length), 0);
}

/**
 * Text up to editTextChars; a CSV or TSV read whole (not truncated) up to editRows by editColumns, its widest row
 * counted; a workbook read whole whose every sheet fits the same. Anything else (a PDF, a document, a picture, a
 * workbook with no sheet) is not edited here: null.
 */
export function editableOf(opened: Opened): Editable | null {
  switch (opened.viewer) {
    case 'text':
      return { kind: 'text', fits: opened.text.length <= VIEW_LIMITS.editTextChars };
    case 'delimited': {
      const { table } = opened;
      return { kind: 'table', fits: !table.truncated && fitsTable(table.rows.length, widest(table.rows)) };
    }
    case 'workbook': {
      const { workbook } = opened;
      // A workbook with no sheet shows as empty, with nothing to edit.
      if (workbook.sheets.length === 0) return null;
      const fits = !workbook.truncated && workbook.sheets.every((sheet) => !sheet.truncated && fitsTable(sheet.rowCount, sheet.columnCount));
      return { kind: 'workbook', fits };
    }
    default:
      return null;
  }
}

// ---- Grids ---------------------------------------------------------------------------------------------------------

export interface DraftRow {
  /** The row's cells as text, as the person sees them, line breaks as LF; a CSV's ragged rows stay as long as they were. */
  text: string[];
  /** How long the row is kept: cells typed past it and cleared again are dropped, so a ragged row stays ragged. */
  base: number;
  /** A workbook row's own cells by column, which an edit's text is read back against (cellOf). */
  cells?: readonly Cell[];
  /** A CSV row's own fields by column, which a cell whose text is unchanged is written back as (tableBytes). */
  fields?: readonly string[];
}

export interface Grid {
  rows: DraftRow[];
  /** Columns shown: the widest row, or more after Add a column. */
  width: number;
}

export function gridOfRows(rows: readonly (readonly string[])[]): Grid {
  return { rows: rows.map((row) => ({ text: row.map(lfText), base: row.length, fields: row })), width: widest(rows) };
}

/** A sheet as the grid shows it (a time with no date shows only its time, as in the viewer). */
export function gridOfSheet(sheet: Sheet): Grid {
  return {
    rows: sheet.rows.map((row) => ({ text: row.map((cell) => lfText(shownCell(cell))), base: row.length, cells: row })),
    width: sheet.columnCount,
  };
}

/** Typing in a cell: past a ragged row's end the row grows to that cell; clearing it shrinks the row back. */
export function setCell(grid: Grid, row: number, column: number, value: string): Grid {
  const current = grid.rows[row];
  if (current === undefined || column >= grid.width || (column >= current.text.length && value === '')) return grid;
  const text = [...current.text];
  while (text.length <= column) text.push('');
  text[column] = value;
  while (text.length > current.base && text[text.length - 1] === '') text.pop();
  const rows = [...grid.rows];
  rows[row] = { ...current, text };
  return { ...grid, rows };
}

/** A new empty row at the end, as wide as the grid. */
export function addRow(grid: Grid): Grid {
  return { ...grid, rows: [...grid.rows, { text: Array.from({ length: grid.width }, () => ''), base: grid.width }] };
}

export function deleteRow(grid: Grid, row: number): Grid {
  return { ...grid, rows: grid.rows.filter((_each, index) => index !== row) };
}

/** A new empty column at the end: every row as wide as the grid gets an empty cell; a shorter ragged row stays. */
export function addColumn(grid: Grid): Grid {
  const { width } = grid;
  return {
    width: width + 1,
    rows: grid.rows.map((row) => (row.text.length === width ? { ...row, text: [...row.text, ''], base: width + 1 } : row)),
  };
}

export function canAddRow(grid: Grid): boolean {
  return grid.rows.length < VIEW_LIMITS.editRows;
}

export function canAddColumn(grid: Grid): boolean {
  return grid.width < VIEW_LIMITS.editColumns;
}

/** True when both grids hold the same rows of the same text, line endings aside. */
export function sameGrid(a: Grid, b: Grid): boolean {
  if (a.rows.length !== b.rows.length) return false;
  return a.rows.every((row, index) => {
    // A row no edit touched is the same object in both.
    if (row === b.rows[index]) return true;
    const other = b.rows[index]?.text;
    return other?.length === row.text.length && row.text.every((value, column) => sameText(value, other[column] ?? ''));
  });
}

const EMPTY: Cell = { t: 'empty' };

/**
 * The cell a workbook cell's text makes: the cell itself when its text is unchanged; a time with no date edited as
 * a time keeps its date part; otherwise cellFromText (a number stays a number when it still reads as one, and so on).
 */
export function cellOf(text: string, previous: Cell): Cell {
  const shown = shownCell(previous);
  if (sameText(text, shown)) return previous;
  if (previous.t === 'd' && shown !== cellText(previous)) {
    const iso = normalizeIso(`${previous.v.slice(0, 10)}T${text.trim()}`);
    if (iso !== null && iso.length > 10) return { t: 'd', v: iso };
  }
  return cellFromText(text, previous);
}

export function cellsOf(grid: Grid): Cell[][] {
  return grid.rows.map((row) => row.text.map((text, column) => cellOf(text, row.cells?.[column] ?? EMPTY)));
}

// ---- Bytes ---------------------------------------------------------------------------------------------------------

/** UTF-8, after a byte-order mark when the file had one or wasn't UTF-8. */
export function encodedLike(text: string, from: { encoding: TextEncoding; bom: boolean }): Uint8Array {
  return encodeText(text, from.bom || from.encoding !== 'utf-8');
}

/** Text with its line breaks written back as `eol`, the ending it opened with (eolOf). */
export function textBytes(text: string, eol: Eol, from: { encoding: TextEncoding; bom: boolean }): Uint8Array {
  return encodedLike(withEol(text, eol), from);
}

/**
 * A CSV or TSV with its own delimiter and line endings: a cell whose text is unchanged is written as the file had it,
 * and an edited cell's line breaks as the table's line ending.
 */
export function tableBytes(table: Delimited, grid: Grid, from: { encoding: TextEncoding; bom: boolean }): Uint8Array {
  const rows = grid.rows.map((row) => row.text.map((value, column) => {
    const field = row.fields?.[column];
    return field !== undefined && sameText(field, value) ? field : withEol(value, table.eol);
  }));
  return encodedLike(toDelimited({ ...table, rows }), from);
}

/** Every sheet of the workbook, in order, with its edited cells: a values-only .xlsx (xlsxWrite.ts). */
export function workbookBytes(workbook: Workbook, grids: readonly Grid[]): Uint8Array {
  return writeWorkbook(workbook.sheets.map((sheet, index) => ({ name: sheet.name, rows: cellsOf(grids[index] ?? gridOfSheet(sheet)) })));
}
