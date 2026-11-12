// Tables from a Word document (.docx, spec 11A), inside the parse thread. The package's guards run on its central
// directory first (as a workbook's do); then word/document.xml is parsed with saxen, and each top-level w:tbl becomes
// rows (w:tr) of cells (w:tc, the text of their w:t runs). Paragraph text outside tables is dropped here and never
// kept anywhere but the stored original. The one exception is readWordText, for a file the person let TownwiseAI read
// (spec 11A.9): the document's paragraphs and tables as plain text, through ai-text.ts.
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

/**
 * The text of a document.xml for reading with TownwiseAI: each paragraph outside a table on a line of its own (a tab
 * as a tab, a line break as a line break), and each top-level table's rows on lines of their own, cells apart by a tab
 * and each cell's text as tablesOfXml reads it (a table inside a cell adds its text to that cell).
 */
export function textOfXml(xml: string): string {
  const lines: string[] = [];
  let depth = 0;
  let line = '';
  let row: string[] | null = null;
  let cell: string | null = null;
  let inText = false;
  const parser = new Parser();
  parser.on('openTag', (name: string, _attrs: unknown, _decode: unknown, selfClosing: boolean) => {
    if (name === 'w:tbl') depth += 1;
    else if (name === 'w:t') inText = !selfClosing;
    else if (depth === 0) {
      if (name === 'w:tab') line += '\t';
      else if (name === 'w:br' || name === 'w:cr') line += '\n';
    } else if (depth === 1 && name === 'w:tr') row = [];
    else if (depth === 1 && name === 'w:tc') cell = '';
    else if ((name === 'w:tab' || name === 'w:br' || name === 'w:cr') && cell !== null) cell += ' ';
  });
  parser.on('closeTag', (name: string) => {
    if (name === 'w:t') inText = false;
    else if (name === 'w:tbl') depth -= 1;
    else if (depth === 0) {
      if (name === 'w:p') {
        lines.push(line);
        line = '';
      }
    } else if (name === 'w:p' && cell !== null && cell !== '' && !cell.endsWith(' ')) cell += ' ';
    else if (depth === 1 && name === 'w:tc' && row !== null && cell !== null) {
      row.push(cell.trim());
      cell = null;
    } else if (depth === 1 && name === 'w:tr' && row !== null) {
      lines.push(row.join('\t'));
      row = null;
    }
  });
  parser.on('text', (value: string, decode: (text: string) => string) => {
    if (!inText) return;
    if (depth === 0) line += decode(value);
    else if (cell !== null) cell += decode(value);
  });
  parser.on('error', (err: Error) => { throw err; });
  parser.parse(xml);
  return lines.join('\n');
}

/** A .docx's word/document.xml, or why it is kept (as readWord keeps it). */
async function documentXml(buffer: Buffer): Promise<{ kind: 'xml'; xml: string } | { kind: 'kept'; outcome: KeptOutcome }> {
  const check = await checkWorkbookArchive(buffer, ['[Content_Types].xml', DOCUMENT]);
  if (check !== 'ok') return { kind: 'kept', outcome: check };
  const read = bufferRead(buffer);
  const listing = await readZip(read, buffer.length, { maxEntries: Number.MAX_SAFE_INTEGER, maxDirectoryBytes: buffer.length });
  const part = listing.entries.find((entry) => entry.name === DOCUMENT);
  if (part === undefined) return { kind: 'kept', outcome: 'not_a_workbook' };
  if (part.uncompressedSize > DOCX_MAX_DOCUMENT_BYTES) return { kind: 'kept', outcome: 'too_large_to_read' };
  try {
    return { kind: 'xml', xml: (await entryBuffer(read, part, dataLimits(listing).get(part) ?? 0, ZIP_PIECE_BYTES)).toString('utf8') };
  } catch (err) {
    if (err instanceof ZipDamagedError) return { kind: 'kept', outcome: 'not_a_workbook' };
    throw err;
  }
}

/**
 * A .docx's paragraphs and tables as text (textOfXml), for a file the person let TownwiseAI read: kept as readWord
 * keeps it when it is not a Word package or too large, and `not_a_workbook` when its XML does not parse.
 */
export async function readWordText(buffer: Buffer): Promise<{ kind: 'text'; text: string } | { kind: 'kept'; outcome: KeptOutcome }> {
  const document = await documentXml(buffer);
  if (document.kind === 'kept') return document;
  try {
    return { kind: 'text', text: textOfXml(document.xml) };
  } catch {
    return { kind: 'kept', outcome: 'not_a_workbook' };
  }
}

/** A .docx's tables: kept `not_a_workbook` (not a Word package), `too_complex` (guards), or `word_no_table`. */
export async function readWord(buffer: Buffer): Promise<WordTables> {
  const document = await documentXml(buffer);
  if (document.kind === 'kept') return document;
  const { xml } = document;
  let tables: Sheet[];
  try {
    tables = tablesOfXml(xml);
  } catch {
    return { kind: 'kept', outcome: 'not_a_workbook' };
  }
  return tables.length === 0 ? { kind: 'kept', outcome: 'word_no_table' } : { kind: 'tables', tables };
}
