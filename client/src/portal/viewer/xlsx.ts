import { ViewerError } from './errors';
import { VIEW_LIMITS } from './limits';
import {
  attributeOf, childElement, childElements, openPackage, readingPackage, readXml, readXmlCut, relationshipOf,
  relationships, type Package,
} from './ooxml';

// An Excel workbook (.xlsx) read in the browser, values only: the workbook's sheet list (names, order, the 1904 date
// system), shared strings (plain and rich text, phonetic runs skipped), the cell styles that make a number a date,
// and each worksheet's cells placed by their references. A formula reads as its cached value; nothing is computed or
// run. Reading stops at VIEW_LIMITS (sheets, rows, columns), and `truncated` says so.

export type Cell =
  | { t: 'empty' }
  | { t: 's'; v: string }
  | { t: 'n'; v: number }
  | { t: 'b'; v: boolean }
  /** 'YYYY-MM-DD', or 'YYYY-MM-DDTHH:MM:SS' when it has a time. */
  | { t: 'd'; v: string }
  /** An error value as Excel shows it: '#DIV/0!', '#N/A'. */
  | { t: 'e'; v: string };

export interface Sheet {
  name: string;
  /** Dense: rowCount rows of columnCount cells, empty ones included. */
  rows: Cell[][];
  rowCount: number;
  columnCount: number;
  /** True when the sheet had more than `rows` holds. */
  truncated: boolean;
}

export interface Workbook {
  sheets: Sheet[];
  truncated: boolean;
}

const EMPTY: Cell = Object.freeze({ t: 'empty' });
const DAY_MS = 86_400_000;
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
/** Built-in number formats that show a date or a time (ECMA-376 18.8.30). */
const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function damaged(detail: string): ViewerError {
  return new ViewerError('damaged', detail);
}

// ---- Dates ---------------------------------------------------------------------------------------------------------

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * An Excel serial as ISO text, or null when it is no date (negative, past 9999, not finite). The 1900 system keeps
 * Lotus's leap-year bug: serial 60 is the 29 February 1900 that never was, and serials before it are a day later
 * than plain day arithmetic gives. A time is rounded to the second.
 */
export function serialToIso(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  let days = Math.floor(serial);
  let seconds = Math.round((serial - days) * 86_400);
  if (seconds >= 86_400) {
    days += 1;
    seconds -= 86_400;
  }
  let day: string;
  if (!date1904 && days === 60) day = '1900-02-29';
  else {
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days < 60 ? 31 : 30);
    const date = new Date(base + days * DAY_MS);
    const year = date.getUTCFullYear();
    if (year > 9999) return null;
    day = `${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
  }
  if (seconds === 0) return day;
  return `${day}T${pad(Math.floor(seconds / 3600), 2)}:${pad(Math.floor(seconds / 60) % 60, 2)}:${pad(seconds % 60, 2)}`;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** ISO date text in this module's form ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS'), or null when it is no real date. */
export function normalizeIso(text: string): string | null {
  const match = ISO.exec(text);
  if (match === null) return null;
  const [, y = '', mo = '', d = '', h = '0', mi = '0', s = '0'] = match;
  const year = Number(y);
  const month = Number(mo);
  const dayOfMonth = Number(d);
  const hours = Number(h);
  const minutes = Number(mi);
  const secs = Number(s);
  if (hours > 23 || minutes > 59 || secs > 59) return null;
  // 1900-02-29 is the day Excel's 1900 system has and the calendar does not.
  const leapBug = year === 1900 && month === 2 && dayOfMonth === 29;
  if (!leapBug) {
    const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== dayOfMonth) return null;
  }
  const day = `${y}-${mo}-${d}`;
  return hours === 0 && minutes === 0 && secs === 0 ? day : `${day}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}`;
}

/** The 1900-system serial of ISO date text, or null when it is not a date Excel can hold (before 1899-12-31). */
export function isoToSerial(iso: string): number | null {
  const normal = normalizeIso(iso);
  if (normal === null) return null;
  const [y = 0, mo = 0, d = 0] = normal.slice(0, 10).split('-').map(Number);
  const [h = 0, mi = 0, s = 0] = normal.length > 10 ? normal.slice(11).split(':').map(Number) : [];
  let days: number;
  if (y === 1900 && mo === 2 && d === 29) days = 60;
  else {
    days = (Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / DAY_MS;
    // Before 1900-03-01 the serials run one lower than plain day arithmetic (the leap-year bug).
    if (days < 61) days -= 1;
  }
  if (days < 0) return null;
  return days + (h * 3600 + mi * 60 + s) / 86_400;
}

/**
 * True when a number format code shows a date or a time: a y, m, d, h or s outside quoted text, backslash escapes,
 * `_x` and `*x` fills, and bracketed sections ([Red], [$-409]) other than the elapsed-time [h], [mm], [ss].
 */
export function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"|\\.|[_*].|\[(?![hms]+\])[^\]]*\]/gi, '');
  return /[ymdhs]/i.test(bare);
}

// ---- Parts ---------------------------------------------------------------------------------------------------------

/** Text escaped as OOXML does (ST_Xstring): `_xHHHH_` is that UTF-16 code unit, so `_x000D_` is a carriage return. */
function unescapeXstring(text: string): string {
  if (!text.includes('_x')) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The text of a shared string or inline string: its own t, or its rich-text runs' t; phonetic runs (rPh) skipped. */
function stringItemText(item: Element): string {
  let text = '';
  for (const part of childElements(item)) {
    if (part.localName === 't') text += part.textContent;
    else if (part.localName === 'r') for (const run of childElements(part, 't')) text += run.textContent;
  }
  return unescapeXstring(text);
}

async function readSharedStrings(pkg: Package, part: string | undefined): Promise<{ strings: string[]; cut: boolean }> {
  if (part === undefined) return { strings: [], cut: false };
  const read = await readXmlCut(pkg, part, 'si', ['sst']);
  if (read === null) return { strings: [], cut: false };
  return { strings: childElements(read.doc.documentElement, 'si').map(stringItemText), cut: read.cut };
}

/** For each cell format (cellXfs index), whether its number format shows a date or time. */
async function readDateStyles(pkg: Package, part: string | undefined): Promise<boolean[]> {
  const doc = part === undefined ? null : await readXml(pkg, part);
  if (doc === null) return [];
  const root = doc.documentElement;
  const custom = new Map<number, string>();
  for (const format of childElements(childElement(root, 'numFmts'), 'numFmt')) {
    custom.set(Number(format.getAttribute('numFmtId')), format.getAttribute('formatCode') ?? '');
  }
  return childElements(childElement(root, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(xf.getAttribute('numFmtId') ?? '0');
    const code = custom.get(id);
    return code === undefined ? BUILT_IN_DATE_FORMATS.has(id) : isDateFormat(code);
  });
}

/** A cell reference ('B3') as zero-based indexes, or null when it is not one. */
function parseReference(reference: string): { row: number; column: number } | null {
  const match = /^([A-Za-z]{1,3})([0-9]{1,7})$/.exec(reference);
  if (match === null) return null;
  const [, letters = '', digits = ''] = match;
  let column = 0;
  for (const letter of letters.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
  const row = Number(digits);
  if (column > MAX_COLUMNS || row < 1 || row > MAX_ROWS) return null;
  return { row: row - 1, column: column - 1 };
}

interface SheetContext {
  readonly strings: readonly string[];
  readonly stringsCut: boolean;
  readonly dateStyles: readonly boolean[];
  readonly date1904: boolean;
}

/** A cell's value; `missing` when it names a shared string the cut-off shared strings part no longer has. */
function readCell(cell: Element, context: SheetContext): { value: Cell; missing: boolean } {
  const type = cell.getAttribute('t') ?? 'n';
  if (type === 'inlineStr') {
    const item = childElement(cell, 'is');
    return { value: item === undefined ? EMPTY : { t: 's', v: stringItemText(item) }, missing: false };
  }
  const valueElement = childElement(cell, 'v');
  if (valueElement === undefined) return { value: EMPTY, missing: false };
  const text = valueElement.textContent;
  switch (type) {
    case 's': {
      const index = Number(text);
      const shared = Number.isInteger(index) ? context.strings[index] : undefined;
      if (shared !== undefined) return { value: { t: 's', v: shared }, missing: false };
      if (context.stringsCut) return { value: EMPTY, missing: true };
      throw damaged('shared string index');
    }
    case 'str':
      return { value: { t: 's', v: unescapeXstring(text) }, missing: false };
    case 'b':
      return { value: { t: 'b', v: text.trim() === '1' || text.trim().toLowerCase() === 'true' }, missing: false };
    case 'e':
      return { value: { t: 'e', v: text }, missing: false };
    case 'd': {
      const iso = normalizeIso(text.trim().slice(0, 19));
      return { value: iso === null ? { t: 's', v: text } : { t: 'd', v: iso }, missing: false };
    }
    default: {
      if (text.trim() === '') return { value: EMPTY, missing: false };
      const number = Number(text);
      if (!Number.isFinite(number)) return { value: { t: 's', v: text }, missing: false };
      const style = Number(cell.getAttribute('s') ?? '0');
      if (context.dateStyles[style] === true) {
        const iso = serialToIso(number, context.date1904);
        if (iso !== null) return { value: { t: 'd', v: iso }, missing: false };
      }
      return { value: { t: 'n', v: number }, missing: false };
    }
  }
}

function emptySheet(name: string): Sheet {
  return { name, rows: [], rowCount: 0, columnCount: 0, truncated: false };
}

async function readSheet(pkg: Package, part: string, name: string, context: SheetContext): Promise<Sheet> {
  const read = await readXmlCut(pkg, part, 'row', ['sheetData', 'worksheet']);
  if (read === null) throw damaged('worksheet missing');
  let truncated = read.cut;
  const placed = new Map<number, Map<number, Cell>>();
  let lastRow = -1;
  let lastColumn = -1;
  let rowIndex = -1;
  for (const row of childElements(childElement(read.doc.documentElement, 'sheetData'), 'row')) {
    const rowNumber = row.getAttribute('r');
    rowIndex = rowNumber === null ? rowIndex + 1 : Number(rowNumber) - 1;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= MAX_ROWS) throw damaged('row reference');
    let columnIndex = -1;
    for (const cell of childElements(row, 'c')) {
      const reference = cell.getAttribute('r');
      let at = { row: rowIndex, column: columnIndex + 1 };
      if (reference !== null) {
        const parsed = parseReference(reference);
        if (parsed === null) throw damaged('cell reference');
        at = parsed;
      }
      columnIndex = at.column;
      const { value, missing } = readCell(cell, context);
      if (missing) truncated = true;
      if (value.t === 'empty') continue;
      if (at.row >= VIEW_LIMITS.sheetRows || at.column >= VIEW_LIMITS.sheetColumns) {
        truncated = true;
        continue;
      }
      let cells = placed.get(at.row);
      if (cells === undefined) {
        cells = new Map();
        placed.set(at.row, cells);
      }
      cells.set(at.column, value);
      lastRow = Math.max(lastRow, at.row);
      lastColumn = Math.max(lastColumn, at.column);
    }
  }
  const rowCount = lastRow + 1;
  const columnCount = lastColumn + 1;
  const rows: Cell[][] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const dense = new Array<Cell>(columnCount).fill(EMPTY);
    for (const [column, value] of placed.get(r) ?? []) dense[column] = value;
    rows.push(dense);
  }
  return { name, rows, rowCount, columnCount, truncated };
}

/**
 * A workbook's sheets, in the workbook's order, values only. Throws ViewerError: `encrypted` for a password-protected
 * workbook (an OLE container holding an encrypted package), `unsupported` for an old binary workbook or a ZIP feature
 * the reader refuses, `too_big` past the ZIP guards, `damaged` for a broken package.
 */
export async function readWorkbook(bytes: Uint8Array): Promise<Workbook> {
  return readingPackage(async () => {
    const pkg = openPackage(bytes);
    const main = relationshipOf(await relationships(pkg, ''), 'officeDocument')?.target ?? 'xl/workbook.xml';
    const workbook = await readXml(pkg, main);
    const root = workbook?.documentElement;
    if (root?.localName !== 'workbook') throw damaged('no workbook');
    const date1904Flag = childElement(root, 'workbookPr')?.getAttribute('date1904');
    const date1904 = date1904Flag === '1' || date1904Flag === 'true';
    const rels = await relationships(pkg, main);
    const shared = await readSharedStrings(pkg, relationshipOf(rels, 'sharedStrings')?.target);
    const context: SheetContext = {
      strings: shared.strings,
      stringsCut: shared.cut,
      dateStyles: await readDateStyles(pkg, relationshipOf(rels, 'styles')?.target),
      date1904,
    };
    const listed = childElements(childElement(root, 'sheets'), 'sheet');
    // A cut shared-strings part truncates only the sheets that name a string past the cut (readCell's `missing`).
    let truncated = listed.length > VIEW_LIMITS.sheets;
    const sheets: Sheet[] = [];
    for (const entry of listed.slice(0, VIEW_LIMITS.sheets)) {
      const name = entry.getAttribute('name') ?? '';
      const id = attributeOf(entry, 'id', true);
      const rel = rels.find((candidate) => candidate.id === id);
      // A chart sheet, dialog sheet or macro sheet has no cells: it shows, by name, as an empty sheet.
      const sheet = rel?.type.endsWith('/worksheet') === true ? await readSheet(pkg, rel.target, name, context) : emptySheet(name);
      truncated ||= sheet.truncated;
      sheets.push(sheet);
    }
    return { sheets, truncated };
  });
}

// ---- Cells as text -------------------------------------------------------------------------------------------------

/** A cell as the page shows it: numbers to 15 significant digits (0.1 + 0.2 shows 0.3), TRUE/FALSE, dates as ISO. */
export function cellText(cell: Cell): string {
  switch (cell.t) {
    case 'empty':
      return '';
    case 'n':
      return Number.isFinite(cell.v) ? String(Number(cell.v.toPrecision(15))) : String(cell.v);
    case 'b':
      return cell.v ? 'TRUE' : 'FALSE';
    default:
      return cell.v;
  }
}

/** A number as a person types one: digits with an optional fraction and exponent. */
const TYPED_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A plain number: no leading zeros (an id such as 00123 stays text), no exponent, at most 15 significant digits. */
const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function plainNumber(text: string): number | null {
  if (!PLAIN_NUMBER.test(text)) return null;
  const digits = text.replace(/^-/, '').replace('.', '').replace(/^0+/, '');
  return digits.length > 15 ? null : Number(text);
}

/**
 * The cell a person's edit makes. '' is empty; text unchanged from the cell's own keeps it exactly; otherwise the
 * cell keeps its type when the text still reads as one (a number, TRUE or FALSE, an ISO date), then a plain number
 * becomes a number, and anything else is text.
 */
export function cellFromText(text: string, previous: Cell): Cell {
  if (text === '') return EMPTY;
  if (text === cellText(previous)) return previous;
  const trimmed = text.trim();
  if (previous.t === 'n' && TYPED_NUMBER.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return { t: 'n', v: number };
  }
  if (previous.t === 'b') {
    const upper = trimmed.toUpperCase();
    if (upper === 'TRUE' || upper === 'FALSE') return { t: 'b', v: upper === 'TRUE' };
  }
  if (previous.t === 'd') {
    const iso = normalizeIso(trimmed);
    if (iso !== null && isoToSerial(iso) !== null) return { t: 'd', v: iso };
  }
  const number = plainNumber(text);
  return number === null ? { t: 's', v: text } : { t: 'n', v: number };
}
