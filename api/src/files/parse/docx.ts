// Tables from a Word document (.docx, spec 11A), inside the parse thread. The package's guards run on its central
// directory first (as a workbook's do); then word/document.xml is parsed with saxen, and each top-level w:tbl becomes
// rows (w:tr) of cells (w:tc, the text of their w:t runs). Paragraph text outside tables is dropped here and never
// kept anywhere but the stored original.
import { Parser } from 'saxen';

import { DOCX_MAX_DOCUMENT_BYTES, ZIP_PIECE_BYTES } from '../limits.ts';
import { bufferRead, dataLimits, entryBuffer, readZip, ZipDamagedError } from '../zip.ts';
import type { KeptOutcome } from './mapping.ts';
import { checkWorkbookArchive, type Sheet } from './xlsx.ts';

const DOCUMENT = 'word/document.xml';

export type WordTables = { readonly kind: 'tables'; readonly tables: Sheet[] } | { readonly kind: 'kept'; readonly outcome: KeptOutcome };

/** The tables of a document.xml, in document order. A table inside a cell adds its text to that cell. */
export function tablesOfXml(xml: string): Sheet[] {
  const tables: Sheet[] = [];
  let depth = 0;
  let rows: string[][] = [];
  let row: string[] | null = null;
  let cell: string | null = null;
  let inText = false;
  const parser = new Parser();
  parser.on('openTag', (name: string, _attrs: unknown, _decode: unknown, selfClosing: boolean) => {
    if (name === 'w:tbl') {
      depth += 1;
      if (depth === 1) rows = [];
      return;
    }
    if (depth !== 1) {
      if (name === 'w:t' && !selfClosing) inText = true;
      return;
    }
    if (name === 'w:tr') row = [];
    else if (name === 'w:tc') cell = '';
    else if (name === 'w:t' && !selfClosing) inText = true;
    else if ((name === 'w:tab' || name === 'w:br') && cell !== null) cell += ' ';
  });
  parser.on('closeTag', (name: string) => {
    if (name === 'w:t') inText = false;
    else if (name === 'w:tbl') {
      if (depth === 1 && rows.length > 0) tables.push({ name: `Table ${String(tables.length + 1)}`, rows });
      depth -= 1;
    } else if (depth === 1 && name === 'w:p' && cell !== null && cell !== '' && !cell.endsWith(' ')) cell += ' ';
    else if (depth === 1 && name === 'w:tc' && row !== null && cell !== null) {
      row.push(cell.trim());
      cell = null;
    } else if (depth === 1 && name === 'w:tr' && row !== null) {
      rows.push(row);
      row = null;
    }
  });
  parser.on('text', (value: string, decode: (text: string) => string) => {
    if (inText && cell !== null) cell += decode(value);
  });
  parser.on('error', (err: Error) => { throw err; });
  parser.parse(xml);
  return tables;
}

/** A .docx's tables: kept `not_a_workbook` (not a Word package), `too_complex` (guards), or `word_no_table`. */
export async function readWord(buffer: Buffer): Promise<WordTables> {
  const check = await checkWorkbookArchive(buffer, ['[Content_Types].xml', DOCUMENT]);
  if (check !== 'ok') return { kind: 'kept', outcome: check };
  const read = bufferRead(buffer);
  const listing = await readZip(read, buffer.length, { maxEntries: Number.MAX_SAFE_INTEGER, maxDirectoryBytes: buffer.length });
  const part = listing.entries.find((entry) => entry.name === DOCUMENT);
  if (part === undefined) return { kind: 'kept', outcome: 'not_a_workbook' };
  if (part.uncompressedSize > DOCX_MAX_DOCUMENT_BYTES) return { kind: 'kept', outcome: 'too_large_to_read' };
  let xml: string;
  try {
    xml = (await entryBuffer(read, part, dataLimits(listing).get(part) ?? 0, ZIP_PIECE_BYTES)).toString('utf8');
  } catch (err) {
    if (err instanceof ZipDamagedError) return { kind: 'kept', outcome: 'not_a_workbook' };
    throw err;
  }
  let tables: Sheet[];
  try {
    tables = tablesOfXml(xml);
  } catch {
    return { kind: 'kept', outcome: 'not_a_workbook' };
  }
  return tables.length === 0 ? { kind: 'kept', outcome: 'word_no_table' } : { kind: 'tables', tables };
}
