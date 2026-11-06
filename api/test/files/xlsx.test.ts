import { describe, expect, it } from 'vitest';

import { checkWorkbookArchive, readWorkbook } from '../../src/files/parse/xlsx.ts';
import { listZip } from '../../src/files/zip.ts';
import { xlsxOf, zipOf } from '../helpers/zip.ts';

describe('workbooks (spec 11A)', () => {
  it('reads every sheet to text cells: dates as YYYY-MM-DD, numbers as written', async () => {
    const book = xlsxOf([
      { name: 'Daily', rows: [['Business Date', 'Guests', 'Net Sales'], [45658, 120, 3456.5], [45659, 98, 2890]], dateColumns: [0] },
      { name: 'Notes', rows: [['Date', 'Note'], ['2025-01-01', 'Closed early']] },
    ]);
    const workbook = await readWorkbook(book);
    expect(workbook).toEqual({
      kind: 'sheets',
      sheets: [
        { name: 'Daily', rows: [['Business Date', 'Guests', 'Net Sales'], ['2025-01-01', '120', '3456.5'], ['2025-01-02', '98', '2890']] },
        { name: 'Notes', rows: [['Date', 'Note'], ['2025-01-01', 'Closed early']] },
      ],
    });
  });

  it('refuses a declared-size bomb and a huge entry before inflating anything, and an archive without a workbook', async () => {
    const parts = [{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'xl/workbook.xml', data: '<x/>' }];
    expect(await checkWorkbookArchive(zipOf(parts))).toBe('ok');
    expect(await checkWorkbookArchive(zipOf([...parts, { name: 'xl/big.xml', data: 'a'.repeat(2000), declaredSize: 2 * 1024 * 1024 }]))).toBe('too_complex');
    expect(await checkWorkbookArchive(zipOf([...parts, { name: 'xl/huge.xml', data: 'a', declaredSize: 65 * 1024 * 1024, store: true }]))).toBe('too_complex');
    expect(await checkWorkbookArchive(zipOf([parts[0] ?? { name: '', data: '' }]))).toBe('not_a_workbook');
    expect(await checkWorkbookArchive(Buffer.from('not a zip'))).toBe('not_a_workbook');
  });

  it('lists a ZIP’s central directory', async () => {
    const entries = await listZip(zipOf([{ name: 'a.csv', data: 'x,y\n' }, { name: 'é.txt', data: '', store: true }]), 10);
    expect(entries.map((entry) => [entry.name, entry.method, entry.uncompressedSize])).toEqual([['a.csv', 8, 4], ['é.txt', 0, 0]]);
    await expect(listZip(zipOf([{ name: 'a', data: '' }, { name: 'b', data: '' }]), 1)).rejects.toThrow(/too many entries/);
  });
});
