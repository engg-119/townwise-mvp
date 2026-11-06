// The privacy pin for the AI column step (spec 11A): whatever a file holds, the request a model would be sent carries
// header text and value tokens only. Sentinels go in an item column, the file name, a ZIP entry path, a PDF line
// outside its table and a Word paragraph; none of them, and no figure from a row, may appear in a serialized request.
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { extractRequest } from '../../src/files/extract/model.ts';
import { redactedProfile, tokenOf, type RedactedProfile } from '../../src/files/extract/profile.ts';
import type { ColumnChoice } from '../../src/files/extract/prompt.ts';
import { runParse, type ParseKind } from '../../src/files/parse/run.ts';
import { pdfOf, row } from '../helpers/pdf.ts';
import { zipOf } from '../helpers/zip.ts';

const SENTINEL = 'Zqxj Party Of Twelve';
const FIGURES = ['7391.58', '6284.17', '41', '37'];
const HEADER = 'Business Date,Item,Total A,Total B';
const CSV = `${HEADER}\n2025-01-01,${SENTINEL},41,7391.58\n2025-01-02,${SENTINEL},37,6284.17\n`;

async function requestsFor(kind: ParseKind, bytes: Buffer): Promise<string[]> {
  const seen: RedactedProfile[] = [];
  const choose = (profile: RedactedProfile): Promise<ColumnChoice | null> => {
    seen.push(profile);
    return Promise.resolve(null);
  };
  await runParse({
    kind, sizeBytes: bytes.length, answers: {}, locationName: `${SENTINEL} Kitchen`, latest: '2026-06-02', replace: true,
    onProgress: () => undefined, chooseColumns: choose,
    open: () => Promise.resolve(Readable.from([bytes])),
    openAt: (offset) => Promise.resolve(Readable.from([bytes.subarray(offset)])),
  });
  return seen.map((profile) => JSON.stringify(extractRequest(profile)));
}

function expectClean(requests: string[]): void {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request).not.toContain('Zqxj');
    for (const figure of FIGURES) expect(request).not.toContain(figure);
    expect(request).toContain('Total A');
  }
}

describe('the redacted profile', () => {
  it('replaces every cell with a token', () => {
    expect(['2025-01-01', '1/2/2025', '41', '7391.58', '$12.00', '', SENTINEL].map(tokenOf))
      .toEqual(['<date:iso>', '<date:slash>', '<int>', '<decimal>', '<money>', '<empty>', '<text>']);
    const profile = redactedProfile(['Date', 'Total'], ['dates', 'numbers'], [['2025-01-01', '7391.58'], ['2025-01-02', '41']]);
    expect(profile.columns[1]).toEqual({ index: 1, header: 'Total', kind: 'numbers', filled: 1, distinct: '2-10', whole: false, magnitude: 3 });
    expect(JSON.stringify(profile)).not.toContain('7391');
  });

  it('cuts header text to 40 characters', () => {
    expect(redactedProfile(['x'.repeat(60)], ['text'], []).columns[0]?.header).toHaveLength(40);
  });

  it('holds no item, location name or figure from a CSV', async () => {
    expectClean(await requestsFor('text', Buffer.from(CSV)));
  });

  it('holds no entry path, PDF line outside a table or row of a ZIP', async () => {
    // A PDF table with no rows: it gives no days, so the ZIP's other table is the one the model is asked about.
    const pdf = pdfOf([{ texts: [{ text: `Prepared for ${SENTINEL}`, x: 72, y: 760 }, ...row(700, [[72, 'Date'], [200, 'Guests']])] }]);
    const zip = zipOf([{ name: `${SENTINEL}/sales.csv`, data: CSV }, { name: `${SENTINEL}/report.pdf`, data: pdf }]);
    expectClean(await requestsFor('zip', zip));
  });

  it('holds no Word paragraph', async () => {
    const cell = (text: string): string => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
    const tr = (...cells: string[]): string => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
    const docx = zipOf([
      { name: '[Content_Types].xml', data: '<Types/>' },
      {
        name: 'word/document.xml',
        data: `<w:document><w:body><w:p><w:r><w:t>Booked by ${SENTINEL}</w:t></w:r></w:p><w:tbl>${
          tr('Business Date', 'Item', 'Total A', 'Total B')}${tr('2025-01-01', SENTINEL, '41', '7391.58')}</w:tbl></w:body></w:document>`,
      },
    ]);
    expectClean(await requestsFor('docx', docx));
  });
});
