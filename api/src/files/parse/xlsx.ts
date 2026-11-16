// Excel workbooks (.xlsx, .xlsm) to rows of text (spec 11A). The archive's guards run on its central directory before
// anything is inflated; then read-excel-file reads up to MAX_SHEETS sheets. Macros are never run: cells are data. Every
// cell becomes text the browser's readers understand: a date as YYYY-MM-DD (read in UTC), a number as String(n).
// The library's universal entry, not its node one: it unzips from the central directory, as the guards read it. The
// node entry unzips as a stream from the local headers, and refuses Toast's exports (Apache POI writes each entry with
// a data descriptor whose sizes are 8 bytes, which a streaming reader takes for 4: "invalid signature").
import readXlsxFile from 'read-excel-file/universal';

import { listZip, ZipFormatError } from '../zip.ts';
import {
  MAX_SHEETS, XLSX_MAX_DECLARED_BYTES, XLSX_MAX_ENTRIES, XLSX_MAX_ENTRY_BYTES, XLSX_MAX_RATIO,
} from '../limits.ts';

const ONE_MIB = 1024 * 1024;

export interface Sheet {
  readonly name: string;
  readonly rows: string[][];
}

/** `omitted` counts the sheets past MAX_SHEETS, which are not read. */
export type Workbook =
  | { readonly kind: 'sheets'; readonly sheets: Sheet[]; readonly omitted: number }
  | { readonly kind: 'kept'; readonly outcome: 'not_a_workbook' | 'too_complex' };

/**
 * The archive guards: entry count, declared sizes, ratio, and the parts every package of this kind has (a workbook's
 * by default; a Word document passes its own).
 */
export async function checkWorkbookArchive(
  buffer: Buffer, required: readonly string[] = ['[Content_Types].xml', 'xl/workbook.xml'],
): Promise<'ok' | 'not_a_workbook' | 'too_complex'> {
  let entries;
  try {
    entries = await listZip(buffer, XLSX_MAX_ENTRIES);
  } catch (err) {
    if (err instanceof ZipFormatError && err.message.includes('too many entries')) return 'too_complex';
    return 'not_a_workbook';
  }
  let declared = 0;
  for (const entry of entries) {
    declared += entry.uncompressedSize;
    if (entry.uncompressedSize > XLSX_MAX_ENTRY_BYTES) return 'too_complex';
    if (entry.uncompressedSize > ONE_MIB && entry.uncompressedSize > XLSX_MAX_RATIO * Math.max(1, entry.compressedSize)) return 'too_complex';
  }
  if (declared > XLSX_MAX_DECLARED_BYTES) return 'too_complex';
  const names = new Set(entries.map((entry) => entry.name));
  return required.every((name) => names.has(name)) ? 'ok' : 'not_a_workbook';
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return '';
}

export async function readWorkbook(buffer: Buffer): Promise<Workbook> {
  const check = await checkWorkbookArchive(buffer);
  if (check !== 'ok') return { kind: 'kept', outcome: check };
  let sheets;
  try {
    // A copy: the universal entry takes an ArrayBuffer, and a Buffer may sit on a shared or pooled one.
    sheets = await readXlsxFile(new Uint8Array(buffer).buffer);
  } catch {
    return { kind: 'kept', outcome: 'not_a_workbook' };
  }
  return {
    kind: 'sheets',
    omitted: Math.max(0, sheets.length - MAX_SHEETS),
    sheets: sheets.slice(0, MAX_SHEETS).map((sheet) => ({
      name: sheet.sheet,
      rows: sheet.data.map((row) => row.map(cellText)),
    })),
  };
}
