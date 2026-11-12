// Tables from a PDF's text (spec 11A), inside the parse thread only. unpdf (a serverless build of Mozilla pdf.js) gives
// each page's text items and positions; fonts are never loaded and nothing is rendered. A table starts at a header
// line: a line whose items include a date header and a guests or net sales header, each its own item. The header
// items' extents make the column bands; each following line's items fall into the band their centre is in; a line
// with fewer than two filled bands, or one that starts with "total", ends the table. A header repeated on a later
// page continues its table. For TownwiseAI's read of a PDF reference item, countPages gives the page count alone
// (openspec change connect-owner-calendar, design decision 9). The only file that imports unpdf
// (test/isolation.test.ts).
import { getDocumentProxy } from 'unpdf';

import { PDF_MAX_ITEMS_PER_PAGE, PDF_MAX_PAGES } from '../limits.ts';
import { familySignature } from './families.ts';
import { guessesFor } from './header.ts';
import type { KeptOutcome } from './mapping.ts';
import type { Sheet } from './xlsx.ts';

/** One positioned piece of text: x and y in PDF points, y up. */
export interface PdfItem { readonly text: string; readonly x: number; readonly y: number; readonly width: number }

export type PdfTables =
  | { readonly kind: 'tables'; readonly tables: Sheet[]; readonly pages: number }
  | { readonly kind: 'kept'; readonly outcome: KeptOutcome };

/** Items on the same baseline, within this many points. */
const BASELINE_POINTS = 2;

/** The page's lines, top to bottom, each left to right. */
export function linesOf(items: readonly PdfItem[]): PdfItem[][] {
  const sorted = items.filter((item) => item.text.trim() !== '').sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; items: PdfItem[] }[] = [];
  for (const item of sorted) {
    const line = lines.at(-1);
    if (line !== undefined && Math.abs(line.y - item.y) <= BASELINE_POINTS) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  return lines.map((line) => line.items.sort((a, b) => a.x - b.x));
}

function isHeaderLine(line: readonly PdfItem[]): boolean {
  const names = line.map((item) => item.text.trim());
  return guessesFor('date', names).length > 0 && (guessesFor('guests', names).length > 0 || guessesFor('netSales', names).length > 0);
}

/** Band edges between neighbouring header items: the midpoints between one's end and the next one's start. */
function edgesOf(header: readonly PdfItem[]): number[] {
  const edges: number[] = [];
  for (let index = 0; index + 1 < header.length; index += 1) {
    const here = header[index];
    const next = header[index + 1];
    if (here === undefined || next === undefined) continue;
    edges.push((here.x + here.width + next.x) / 2);
  }
  return edges;
}

function cellsOf(line: readonly PdfItem[], edges: readonly number[]): string[] {
  const cells = Array.from({ length: edges.length + 1 }, () => '');
  for (const item of line) {
    const centre = item.x + item.width / 2;
    let band = edges.findIndex((edge) => centre < edge);
    if (band === -1) band = edges.length;
    const text = item.text.trim();
    cells[band] = cells[band] === '' ? text : `${cells[band] ?? ''} ${text}`;
  }
  return cells;
}

/**
 * The tables on a document's pages (each a list of positioned items), in order. Text outside a table is dropped
 * here and never kept anywhere but the stored original.
 */
export function tablesOf(pages: readonly (readonly PdfItem[])[]): Sheet[] {
  const tables = new Map<string, Sheet>();
  for (const [pageIndex, items] of pages.entries()) {
    let open: { rows: string[][]; edges: number[] } | null = null;
    for (const line of linesOf(items)) {
      if (isHeaderLine(line)) {
        const header = line.map((item) => item.text.trim());
        const signature = familySignature(header);
        let table = tables.get(signature);
        if (table === undefined) {
          table = { name: `Page ${String(pageIndex + 1)} table`, rows: [header] };
          tables.set(signature, table);
        }
        open = { rows: table.rows, edges: edgesOf(line) };
        continue;
      }
      if (open === null) continue;
      const cells = cellsOf(line, open.edges);
      if (cells.filter((cell) => cell !== '').length < 2 || /^total/i.test(cells[0] ?? '')) {
        open = null;
        continue;
      }
      open.rows.push(cells);
    }
  }
  return [...tables.values()];
}

function isPasswordError(err: unknown): boolean {
  return err instanceof Error && err.name === 'PasswordException';
}

function open(buffer: Buffer): ReturnType<typeof getDocumentProxy> {
  // Fonts are never loaded or faked, and pdf.js logs nothing below errors (a warning can quote the file).
  return getDocumentProxy(new Uint8Array(buffer), {
    disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0, isOffscreenCanvasSupported: false,
  });
}

/** A PDF's page count; null when pdf.js cannot open it (damaged, locked with a password, or not a PDF). */
export async function countPages(buffer: Buffer): Promise<number | null> {
  let document;
  try {
    document = await open(buffer);
  } catch {
    return null;
  }
  try {
    return document.numPages;
  } finally {
    await document.cleanup().catch(() => undefined);
  }
}

/**
 * A PDF's tables. `onPage` reports pages read. Encrypted: kept `encrypted`; no text on any page: `pdf_scanned`; text but
 * no table: `pdf_no_table`; more pages than the reader takes: `too_complex`; not readable as a PDF, or a page that cannot be read: `not_a_table`.
 */
export async function readPdf(buffer: Buffer, onPage: (done: number, total: number) => void = () => undefined): Promise<PdfTables> {
  let document;
  try {
    document = await open(buffer);
  } catch (err) {
    return { kind: 'kept', outcome: isPasswordError(err) ? 'encrypted' : 'not_a_table' };
  }
  try {
    if (document.numPages > PDF_MAX_PAGES) return { kind: 'kept', outcome: 'too_complex' };
    const pages: PdfItem[][] = [];
    let anyText = false;
    for (let number = 1; number <= document.numPages; number += 1) {
      let content;
      let page;
      try {
        page = await document.getPage(number);
        content = await page.getTextContent();
      } catch {
        // A damaged page: the PDF is kept, like one pdf.js cannot open at all (the time limit ends the thread instead).
        return { kind: 'kept', outcome: 'not_a_table' };
      }
      if (content.items.length > PDF_MAX_ITEMS_PER_PAGE) return { kind: 'kept', outcome: 'too_complex' };
      const items: PdfItem[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (item.str.trim() !== '') anyText = true;
        items.push({ text: item.str, x: Number(item.transform[4] ?? 0), y: Number(item.transform[5] ?? 0), width: item.width });
      }
      pages.push(items);
      page.cleanup();
      onPage(number, document.numPages);
    }
    if (!anyText) return { kind: 'kept', outcome: 'pdf_scanned' };
    const tables = tablesOf(pages);
    if (tables.length === 0) return { kind: 'kept', outcome: 'pdf_no_table' };
    return { kind: 'tables', tables, pages: document.numPages };
  } finally {
    await document.cleanup().catch(() => undefined);
  }
}
