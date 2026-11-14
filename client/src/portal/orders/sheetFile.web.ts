import { MAX_FILE_BYTES } from '../upload/columns';
import { nextTask, scanText } from '../upload/scan';
import { ViewerError } from '../viewer/errors';
import { cellText, readWorkbook } from '../viewer/xlsx';

// A CSV or Excel file read in the browser, row by row, for the ordering sheet import and the item sales upload. The
// caller gets the header and each row as text (Excel dates as ISO text, numbers as Excel shows them) and keeps what it
// needs; nothing here keeps the file's text, and nothing logs it or its name. Each read reads the File again.

export const SHEET_ACCEPT = '.csv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const SHEET_COPY = {
  notSheet: 'Choose a CSV file or an Excel workbook (.xlsx).',
  oldExcel: 'Townwise reads Excel workbooks saved as .xlsx. Save it as .xlsx or CSV and choose it again.',
  tooLarge: 'That file is larger than 50 MB. Export a shorter date range.',
  tooManyRows: 'That workbook has more rows than Townwise reads from Excel (5,000). Export it as CSV instead.',
  password: 'That workbook has a password. Save a copy without one, or export it as CSV.',
  unreadable: 'Townwise couldn’t read that file. Export it again as CSV and choose it again.',
  empty: 'That file has no rows.',
} as const;

export interface RowVisitor {
  /** Row 1. */
  header: (cells: string[]) => void;
  /** Each row after it, with its row number (the header is row 1). */
  row: (cells: string[], row: number) => void;
}

export type ReadOutcome = 'done' | 'cancelled' | { problem: string };

function kindOf(name: string): 'csv' | 'xlsx' | 'xls' | null {
  if (/\.(csv|txt)$/i.test(name)) return 'csv';
  if (/\.xlsx$/i.test(name)) return 'xlsx';
  if (/\.xls$/i.test(name)) return 'xls';
  return null;
}

/** Why `file` can't be read, before reading it. */
export function checkSheetFile(file: { name: string; size: number }): string | null {
  const kind = kindOf(file.name);
  if (kind === null) return SHEET_COPY.notSheet;
  if (kind === 'xls') return SHEET_COPY.oldExcel;
  return file.size > MAX_FILE_BYTES ? SHEET_COPY.tooLarge : null;
}

function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(new Uint8Array(reader.result as ArrayBuffer)); };
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')); };
    reader.readAsArrayBuffer(blob);
  });
}

async function readCsv(file: File, visit: RowVisitor, cancelled: () => boolean): Promise<ReadOutcome> {
  const text = await file.text();
  if (text.startsWith('PK\u0003\u0004') || text.slice(0, 4096).includes('\u0000')) return { problem: SHEET_COPY.notSheet };
  const seen = { header: false };
  const outcome = await scanText(text, {
    header: (cells) => {
      if (cells === null) return false;
      seen.header = true;
      visit.header(cells);
      return true;
    },
    row: (cells, row) => { visit.row(cells, row); return true; },
  }, { pause: nextTask, cancelled });
  if (outcome === 'cancelled') return 'cancelled';
  if (!seen.header) return { problem: SHEET_COPY.empty };
  return outcome.unterminated ? { problem: SHEET_COPY.unreadable } : 'done';
}

async function readExcel(file: File, visit: RowVisitor, cancelled: () => boolean): Promise<ReadOutcome> {
  const workbook = await readWorkbook(await bytesOf(file));
  if (cancelled()) return 'cancelled';
  const sheet = workbook.sheets.find((each) => each.rowCount > 0);
  if (sheet === undefined) return { problem: SHEET_COPY.empty };
  // A cut sheet would drop the rows of its last days, and an upload replaces whole days.
  if (sheet.truncated) return { problem: SHEET_COPY.tooManyRows };
  sheet.rows.forEach((cells, index) => {
    if (index === 0) visit.header(cells.map(cellText));
    else visit.row(cells.map(cellText), index + 1);
  });
  return 'done';
}

/** Reads `file` (CSV or .xlsx, the first sheet with rows) into `visit`, or says why it can't. */
export async function readSheetFile(file: File, visit: RowVisitor, cancelled: () => boolean): Promise<ReadOutcome> {
  const problem = checkSheetFile(file);
  if (problem !== null) return { problem };
  try {
    return kindOf(file.name) === 'xlsx' ? await readExcel(file, visit, cancelled) : await readCsv(file, visit, cancelled);
  } catch (error) {
    if (error instanceof ViewerError && error.reason === 'encrypted') return { problem: SHEET_COPY.password };
    return { problem: SHEET_COPY.unreadable };
  }
}
