// Tables from a Word document (.docx, spec 11A), inside the parse thread. The package's guards run on its central
// directory first (as a workbook's do); then word/document.xml is parsed with saxen, and each top-level w:tbl becomes
// rows (w:tr) of cells (w:tc, the text of their w:t runs). Paragraph text outside tables is dropped by the table reader
// and never kept anywhere but the stored original. For TownwiseAI's read of a Word reference item, readWordText takes
// every paragraph's and table's text instead, under the same guards and a smaller document.xml cap (openspec change
// connect-owner-calendar, design decision 9): it reaches the model only in the turn that read it and is never stored.
import { Parser } from 'saxen';

import { DOCX_MAX_DOCUMENT_BYTES, ITEM_DOCX_DOCUMENT_BYTES, ZIP_PIECE_BYTES } from '../limits.ts';
import { bufferRead, dataLimits, entryBuffer, readZip, ZipDamagedError } from '../zip.ts';
import type { KeptOutcome } from './mapping.ts';
import { checkWorkbookArchive, type Sheet } from './xlsx.ts';

const DOCUMENT = 'word/document.xml';

export type WordTables = { readonly kind: 'tables'; readonly tables: Sheet[] } | { readonly kind: 'kept'; readonly outcome: KeptOutcome };

export type WordText = { readonly kind: 'text'; readonly text: string; readonly truncated: boolean } | { readonly kind: 'kept'; readonly outcome: KeptOutcome };

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
 * The text of a document.xml: each paragraph on a line of its own (its tabs and line breaks kept), each row of a
 * top-level table on one line with its cells' text between tabs, and a table inside a cell added to that cell's text.
 * The same content written again for older readers (mc:Fallback) is skipped. Reading stops once the text is longer
 * than `maxChars`, and the text is cut there.
 */
export function textOfXml(xml: string, maxChars: number): { text: string; truncated: boolean } {
  let text = '';
  let tables = 0;
  let fallback = 0;
  let inText = false;
  let row: string[] | null = null;
  let cell: string | null = null;
  const parser = new Parser();
  const put = (piece: string): void => {
    text += piece;
    if (text.length > maxChars) parser.stop();
  };
  // Inside a cell a tab, a line break or a paragraph's end is a space; text in a table but in no cell is dropped.
  const add = (piece: string, inCell = piece): void => {
    if (cell !== null) cell += inCell;
    else if (tables === 0) put(piece);
  };
  parser.on('openTag', (name: string) => {
    if (name === 'mc:Fallback') fallback += 1;
    if (fallback > 0) return;
    if (name === 'w:tbl') tables += 1;
    else if (name === 'w:t') inText = true;
    else if (name === 'w:tab') add('\t', ' ');
    else if (name === 'w:br' || name === 'w:cr') add('\n', ' ');
    else if (tables === 1 && name === 'w:tr') row = [];
    else if (tables === 1 && name === 'w:tc') cell = '';
  });
  parser.on('closeTag', (name: string) => {
    if (name === 'mc:Fallback') {
      fallback -= 1;
      return;
    }
    if (fallback > 0) return;
    if (name === 'w:t') inText = false;
    else if (name === 'w:tbl') tables -= 1;
    else if (name === 'w:p') add('\n', ' ');
    else if (tables === 1 && name === 'w:tc' && row !== null && cell !== null) {
      row.push(cell.replace(/\s+/g, ' ').trim());
      cell = null;
    } else if (tables === 1 && name === 'w:tr' && row !== null) {
      put(`${row.join('\t')}\n`);
      row = null;
    }
  });
  parser.on('text', (value: string, decode: (text: string) => string) => {
    if (inText && fallback === 0) add(decode(value));
  });
  parser.on('error', (err: Error) => { throw err; });
  parser.parse(xml);
  // Spaces that end a line, and runs of empty paragraphs, carry nothing.
  const tidy = text.replace(/ +$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  let cut = tidy.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (tidy.length > maxChars && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, truncated: text.length > maxChars };
}

/** A .docx's document.xml, under the package's guards and at most `maxBytes` uncompressed, or why it is kept unread. */
async function documentXml(buffer: Buffer, maxBytes: number): Promise<string | { kind: 'kept'; outcome: KeptOutcome }> {
  const check = await checkWorkbookArchive(buffer, ['[Content_Types].xml', DOCUMENT]);
  if (check !== 'ok') return { kind: 'kept', outcome: check };
  const read = bufferRead(buffer);
  const listing = await readZip(read, buffer.length, { maxEntries: Number.MAX_SAFE_INTEGER, maxDirectoryBytes: buffer.length });
  const part = listing.entries.find((entry) => entry.name === DOCUMENT);
  if (part === undefined) return { kind: 'kept', outcome: 'not_a_workbook' };
  if (part.uncompressedSize > maxBytes) return { kind: 'kept', outcome: 'too_large_to_read' };
  try {
    return (await entryBuffer(read, part, dataLimits(listing).get(part) ?? 0, ZIP_PIECE_BYTES)).toString('utf8');
  } catch (err) {
    if (err instanceof ZipDamagedError) return { kind: 'kept', outcome: 'not_a_workbook' };
    throw err;
  }
}

/**
 * A .docx's paragraph and table text for TownwiseAI, cut at `maxChars`: kept `not_a_workbook` (not a Word package, or
 * XML that does not parse), `too_complex` (guards) or `too_large_to_read` (document.xml over ITEM_DOCX_DOCUMENT_BYTES).
 */
export async function readWordText(buffer: Buffer, maxChars: number): Promise<WordText> {
  const xml = await documentXml(buffer, ITEM_DOCX_DOCUMENT_BYTES);
  if (typeof xml !== 'string') return xml;
  try {
    return { kind: 'text', ...textOfXml(xml, maxChars) };
  } catch {
    return { kind: 'kept', outcome: 'not_a_workbook' };
  }
}

/** A .docx's tables: kept `not_a_workbook` (not a Word package), `too_complex` (guards), or `word_no_table`. */
export async function readWord(buffer: Buffer): Promise<WordTables> {
  const xml = await documentXml(buffer, DOCX_MAX_DOCUMENT_BYTES);
  if (typeof xml !== 'string') return xml;
  let tables: Sheet[];
  try {
    tables = tablesOfXml(xml);
  } catch {
    return { kind: 'kept', outcome: 'not_a_workbook' };
  }
  return tables.length === 0 ? { kind: 'kept', outcome: 'word_no_table' } : { kind: 'tables', tables };
}
