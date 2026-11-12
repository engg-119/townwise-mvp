// Tables read from a PDF's text (spec 11A): the header line anchors the column bands, a total line ends the table, a
// header repeated on a later page continues it, and the PDFs Townwise cannot use are kept with the reason. For
// TownwiseAI's read of a PDF reference item, the parse thread counts its pages (openspec change connect-owner-calendar,
// design decision 9). PDFs are written in the test (helpers/pdf.ts).
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { PDF_MAX_PAGES } from '../../src/files/limits.ts';
import { countPages, readPdf, tablesOf } from '../../src/files/parse/pdf.ts';
import { runItemRead, runParse } from '../../src/files/parse/run.ts';
import { pdfOf, row } from '../helpers/pdf.ts';

const COLUMNS = [72, 200, 300] as const;
const line = (y: number, a: string, b: string, c: string) => row(y, [[COLUMNS[0], a], [COLUMNS[1], b], [COLUMNS[2], c]]);
const base = { answers: {}, locationName: 'Main', latest: '2026-06-02', replace: true, onProgress: () => undefined } as const;

function parse(pdf: Buffer, more: { timeMs?: number } = {}): ReturnType<typeof runParse> {
  return runParse({ ...base, ...more, kind: 'pdf', sizeBytes: pdf.length, open: () => Promise.resolve(Readable.from([pdf])) });
}

const REPORT = pdfOf([
  {
    texts: [
      { text: 'Daily sales for Zqxj Party Of Twelve', x: 72, y: 760 },
      ...line(700, 'Date', 'Guests', 'Net Sales'),
      ...line(685, '2025-01-01', '10', '100.00'),
      ...line(670, '2025-01-02', '12', '120.00'),
      ...row(655, [[72, 'Total'], [200, '22'], [300, '220.00']]),
      ...line(640, '2025-12-31', '99', '999.00'),
    ],
  },
  { texts: [...line(700, 'Date', 'Guests', 'Net Sales'), ...line(685, '2025-01-03', '14', '140.00')] },
]);

describe('PDF tables', () => {
  it('reads a table under its header line, ends it at a total line, and continues it on the next page', async () => {
    const outcome = await parse(REPORT);
    expect(outcome).toMatchObject({
      kind: 'days',
      days: [
        { date: '2025-01-01', guests: 10, netSalesCents: 10_000 }, { date: '2025-01-02', guests: 12, netSalesCents: 12_000 },
        { date: '2025-01-03', guests: 14, netSalesCents: 14_000 },
      ],
      report: { mapping: { date: 'Date', guests: 'Guests', netSales: 'Net Sales' }, sheets: [{ name: 'Page 1 table', used: true }] },
    });
    // Text outside the table (the title, the line after the total) is in no row.
    const found = await readPdf(REPORT);
    expect(JSON.stringify(found)).not.toContain('Zqxj');
    expect(JSON.stringify(found)).not.toContain('2025-12-31');
  });

  it('puts each item in the band its centre lies in', () => {
    const tables = tablesOf([[
      { text: 'Date', x: 10, y: 100, width: 20 }, { text: 'Guests', x: 100, y: 100, width: 30 },
      { text: '2025-01-01', x: 5, y: 90, width: 50 }, { text: '7', x: 110, y: 91, width: 5 },
    ]]);
    expect(tables).toEqual([{ name: 'Page 1 table', rows: [['Date', 'Guests'], ['2025-01-01', '7']] }]);
  });

  it('keeps a PDF with text but no table, a scan with no text, and an encrypted one', async () => {
    expect(await parse(pdfOf([{ texts: [{ text: 'A letter, not a table', x: 72, y: 700 }] }]))).toEqual({ kind: 'kept', outcome: 'pdf_no_table', report: null });
    expect(await parse(pdfOf([{ drawing: true }]))).toEqual({ kind: 'kept', outcome: 'pdf_scanned', report: null });
    expect(await parse(pdfOf([{ texts: line(700, 'Date', 'Guests', 'Net Sales') }], { encrypted: true })))
      .toEqual({ kind: 'kept', outcome: 'encrypted', report: null });
    expect(await parse(Buffer.from('%PDF-1.4\nnot really'))).toMatchObject({ kind: 'kept' });
  });

  it('keeps a PDF whose page cannot be read as not_a_table, instead of failing the read', async () => {
    const damaged = pdfOf([{ texts: line(700, 'Date', 'Guests', 'Net Sales') }, { texts: line(685, '2025-01-01', '1', '1.00') }], { brokenPage: 1 });
    expect(await readPdf(damaged)).toEqual({ kind: 'kept', outcome: 'not_a_table' });
    expect(await parse(damaged)).toEqual({ kind: 'kept', outcome: 'not_a_table', report: null });
  });

  it('keeps a PDF over the page cap, and one past the thread’s time limit, as too_complex', async () => {
    const pages = Array.from({ length: PDF_MAX_PAGES + 1 }, () => ({}));
    expect(await readPdf(pdfOf(pages))).toEqual({ kind: 'kept', outcome: 'too_complex' });
    expect(await parse(REPORT, { timeMs: 1 })).toEqual({ kind: 'kept', outcome: 'too_complex', report: null });
  }, 30_000);

  it('reports progress in pages', async () => {
    const seen: [number, number | null][] = [];
    await runParse({ ...base, kind: 'pdf', sizeBytes: REPORT.length, open: () => Promise.resolve(Readable.from([REPORT])), onProgress: (done, total) => { seen.push([done, total]); } });
    expect(seen).toEqual([[1, 2], [2, 2]]);
  });
});

describe('PDF page count for TownwiseAI', () => {
  it('counts a PDF’s pages through the parse thread, whatever is on them', async () => {
    expect(await runItemRead({ job: { kind: 'pdf_pages' }, bytes: REPORT })).toEqual({ kind: 'pages', pages: 2 });
    expect(await runItemRead({ job: { kind: 'pdf_pages' }, bytes: pdfOf([{ drawing: true }, {}, {}]) })).toEqual({ kind: 'pages', pages: 3 });
  });

  it('answers cannot_open for an encrypted PDF or one pdf.js cannot open, and too_large past the time limit', async () => {
    expect(await countPages(pdfOf([{}], { encrypted: true }))).toBeNull();
    expect(await runItemRead({ job: { kind: 'pdf_pages' }, bytes: pdfOf([{}], { encrypted: true }) })).toEqual({ kind: 'cannot_open' });
    expect(await runItemRead({ job: { kind: 'pdf_pages' }, bytes: Buffer.from('%PDF-1.4\nnot really') })).toEqual({ kind: 'cannot_open' });
    expect(await runItemRead({ job: { kind: 'pdf_pages' }, bytes: REPORT, timeMs: 1 })).toEqual({ kind: 'too_large' });
  }, 30_000);
});
