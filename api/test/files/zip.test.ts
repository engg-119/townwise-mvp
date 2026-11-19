// ZIP archives (spec 11A): the central directory and ZIP64, every archive guard before anything is inflated, the
// entries Townwise keeps without reading, and a large export of tiny files listed and read in place. ZIPs are built
// in the test (helpers/zip.ts); no binary fixtures.
import { describe, expect, it } from 'vitest';

import { readArchive } from '../../src/files/parse/archive.ts';
import { bufferRead, guardZip, listZip, readZip, type ZipEntry, type ZipListing } from '../../src/files/zip.ts';
import { zipOf } from '../helpers/zip.ts';

const input = { answers: {}, locationName: 'Main', latest: '2026-06-02' } as const;
const MIB = 1024 * 1024;
const LIMITS = { maxDeclaredBytes: 2 * 1024 * MIB, maxRatio: 100, ratioFloorBytes: MIB };

function read(zip: Buffer): ReturnType<typeof readArchive> {
  return readArchive(bufferRead(zip), zip.length, input);
}

function entry(over: Partial<ZipEntry>): ZipEntry {
  return { name: 'a.csv', nameLength: 5, method: 8, flags: 0, compressedSize: 100, uncompressedSize: 100, localHeaderOffset: 0, ...over };
}

const day = (date: string, guests: number): string => `${date},${String(guests)},${String(guests * 10)}.00\n`;

describe('the central directory', () => {
  it('reads names, methods and sizes, plain and ZIP64', async () => {
    const parts = [{ name: 'a.csv', data: 'x,y\n' }, { name: 'é/b.txt', data: 'hello', store: true }];
    for (const zip of [zipOf(parts), zipOf(parts, { zip64: true })]) {
      const listing = await readZip(bufferRead(zip), zip.length, { maxEntries: 10, maxDirectoryBytes: MIB });
      expect(listing.entries.map((e) => [e.name, e.method, e.uncompressedSize])).toEqual([['a.csv', 8, 4], ['é/b.txt', 0, 5]]);
    }
  });

  it('refuses too many entries before reading the directory', async () => {
    await expect(listZip(zipOf([{ name: 'a', data: '' }, { name: 'b', data: '' }]), 1)).rejects.toThrow(/too many entries/);
  });
});

describe('archive guards, on declared sizes', () => {
  const listing = (entries: ZipEntry[], directoryOffset = 10 * 1024 * MIB): ZipListing => ({ entries, directoryOffset });

  it('passes an honest archive', () => {
    expect(guardZip(listing([entry({}), entry({ localHeaderOffset: 200 })]), 10_000, LIMITS)).toBeNull();
  });

  it('refuses a declared total over 2 GiB, every depth together', () => {
    const big = entry({ compressedSize: 30 * MIB, uncompressedSize: 1024 * MIB });
    expect(guardZip(listing([big]), 60 * MIB, LIMITS)).toBeNull();
    expect(guardZip(listing([big, { ...big, localHeaderOffset: 40 * MIB }], 90 * MIB), 90 * MIB, LIMITS, 100)).toBe('zip_too_big');
  });

  it('refuses the archive’s ratio and a large entry’s ratio over 100 to 1', () => {
    expect(guardZip(listing([entry({ compressedSize: 1000, uncompressedSize: 900_000 })], 2000), 2000, LIMITS)).toBe('zip_bomb');
    expect(guardZip(listing([entry({ compressedSize: 1000, uncompressedSize: 2 * MIB })], 2000), 10 * MIB, LIMITS)).toBe('zip_bomb');
  });

  it('refuses entries whose data overlaps the next entry (the overlapping-entry bomb)', () => {
    const first = entry({ compressedSize: 500 });
    const second = entry({ localHeaderOffset: 100 });
    expect(guardZip(listing([first, second]), 10_000, LIMITS)).toBe('zip_bomb');
  });

  it('keeps a whole ZIP that is a bomb, unread, with no entry listed', async () => {
    const zip = zipOf([{ name: 'a.csv', data: 'a'.repeat(100), declaredSize: 50 * MIB }]);
    expect(await read(zip)).toEqual({ kind: 'kept', outcome: 'zip_bomb', entries: [] });
  });

  it('distrusts the whole ZIP when an entry inflates past what it declared', async () => {
    const zip = zipOf([{ name: 'a.csv', data: `Date,Guests\n${'2025-01-01,1\n'.repeat(50)}`, declaredSize: 20 }]);
    expect(await read(zip)).toEqual({ kind: 'kept', outcome: 'zip_damaged', entries: [] });
  });

  it('keeps an empty ZIP, and one that is not a ZIP at all', async () => {
    expect(await read(zipOf([{ name: 'folder/', data: '' }]))).toMatchObject({ kind: 'kept', outcome: 'zip_empty' });
    expect(await read(Buffer.from('PK\u0003\u0004 and nothing else'))).toMatchObject({ kind: 'kept', outcome: 'zip_damaged' });
  });
});

describe('entries', () => {
  it('reads each entry as a file of its own and says why every other one was kept', async () => {
    const sales = `Date,Guests,Net Sales\n${day('2025-01-01', 10)}${day('2025-01-02', 12)}`;
    const zip = zipOf([
      { name: 'sales.csv', data: sales },
      { name: '__MACOSX/._sales.csv', data: 'x' },
      { name: 'locked.csv', data: sales, flags: 0x801 },
      { name: 'odd.csv', data: sales, store: true, method: 12 },
      { name: 'photo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
      { name: 'old.xls', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]) },
      { name: 'report.pdf', data: '%PDF-1.4\n' },
    ]);
    const outcome = await read(zip);
    expect(outcome).toMatchObject({ kind: 'days', days: [{ date: '2025-01-01', guests: 10 }, { date: '2025-01-02', guests: 12 }] });
    if (outcome.kind !== 'days') return;
    expect(outcome.entries.map((row) => [row.index, row.path, row.kind, row.status, row.outcome])).toEqual([
      [0, 'sales.csv', 'text', 'used', null],
      [1, '__MACOSX/._sales.csv', 'other', 'kept', 'system_file'],
      [2, 'locked.csv', 'other', 'kept', 'encrypted'],
      [3, 'odd.csv', 'other', 'kept', 'zip_method'],
      [4, 'photo.png', 'other', 'kept', 'image'],
      [5, 'old.xls', 'xls', 'kept', 'old_excel'],
      [6, 'report.pdf', 'pdf', 'kept', 'not_a_table'],
    ]);
    expect(outcome.report.families).toEqual([expect.objectContaining({ label: ['Date', 'Guests', 'Net Sales'], used: true, dayCount: 2, why: 'sales' })]);
  });

  it('keeps a calendar export entry calendar_export and reads the sales beside it (D58)', async () => {
    const sales = `Date,Guests,Net Sales\n${day('2025-01-01', 10)}`;
    const calendar = 'event_id,title,start_at,end_at\ne1,Spring reunion,2025-04-12T18:00:00-04:00,2025-04-12T22:00:00-04:00\n';
    const outcome = await read(zipOf([{ name: 'sales.csv', data: sales }, { name: 'master.csv', data: calendar }]));
    expect(outcome).toMatchObject({ kind: 'days', days: [{ date: '2025-01-01', guests: 10 }] });
    if (outcome.kind !== 'days') return;
    expect(outcome.entries.map((row) => [row.path, row.status, row.outcome])).toEqual([['sales.csv', 'used', null], ['master.csv', 'kept', 'calendar_export']]);
  });

  it('opens a ZIP inside the ZIP, and never one inside that', async () => {
    const deepest = zipOf([{ name: 'c.csv', data: `Date,Guests\n${day('2025-03-01', 3)}` }]);
    const inner = zipOf([{ name: 'b.csv', data: `Date,Guests\n${day('2025-02-01', 2)}` }, { name: 'deeper.zip', data: deepest }]);
    const outcome = await read(zipOf([{ name: 'inner.zip', data: inner }]));
    expect(outcome).toMatchObject({ kind: 'days', days: [{ date: '2025-02-01', guests: 2 }] });
    if (outcome.kind !== 'days') return;
    expect(outcome.entries.map((row) => [row.path, row.depth, row.status, row.outcome])).toEqual([
      ['inner.zip', 1, 'used', null],
      ['inner.zip/b.csv', 2, 'used', null],
      ['inner.zip/deeper.zip', 2, 'kept', 'nested_zip'],
    ]);
  });

  it('holds at most 50 MiB of ZIPs inside the ZIP in memory at once, keeping the rest unread', async () => {
    const picture = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(26 * MIB)]);
    const inner = zipOf([{ name: 'photo.png', data: picture, store: true }]);
    const outcome = await read(zipOf([
      { name: 'a.csv', data: `Date,Guests\n${day('2025-01-01', 1)}` }, { name: 'one.zip', data: inner, store: true }, { name: 'two.zip', data: inner, store: true },
    ]));
    expect(outcome.kind).toBe('days');
    if (outcome.kind !== 'days') return;
    expect(outcome.entries.map((row) => [row.path, row.outcome])).toEqual([
      ['a.csv', null], ['one.zip', 'nothing_usable'], ['one.zip/photo.png', 'image'], ['two.zip', 'too_large_to_read'],
    ]);
  }, 30_000);

  it('reads PDF and Word entries as tables, joining the family of a CSV with the same header', async () => {
    const { pdfOf, row } = await import('../helpers/pdf.ts');
    const pdf = pdfOf([{ texts: [...row(700, [[72, 'Date'], [200, 'Guests']]), ...row(685, [[72, '2025-01-02'], [200, '4']])] }]);
    const word = zipOf([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Date</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Guests</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>2025-01-03</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>6</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' },
    ]);
    const outcome = await read(zipOf([
      { name: 'a.csv', data: 'Date,Guests\n2025-01-01,2\n' }, { name: 'b.pdf', data: pdf }, { name: 'c.docx', data: word },
    ]));
    expect(outcome).toMatchObject({ kind: 'days', days: [{ date: '2025-01-01', guests: 2 }, { date: '2025-01-02', guests: 4 }, { date: '2025-01-03', guests: 6 }] });
    if (outcome.kind !== 'days') return;
    expect(outcome.entries.map((entry) => [entry.kind, entry.status])).toEqual([['text', 'used'], ['pdf', 'used'], ['docx', 'used']]);
    expect(outcome.report.families).toEqual([expect.objectContaining({ entries: 3, dayCount: 3 })]);
  });

  it('keeps a damaged PDF entry and still reads the CSV beside it', async () => {
    const { pdfOf, row } = await import('../helpers/pdf.ts');
    const damaged = pdfOf([{ texts: row(700, [[72, 'Date'], [200, 'Guests']]) }, { texts: row(685, [[72, '2025-01-02'], [200, '4']]) }], { brokenPage: 1 });
    const outcome = await read(zipOf([{ name: 'a.csv', data: `Date,Guests,Net Sales\n${day('2025-01-01', 10)}` }, { name: 'b.pdf', data: damaged }]));
    expect(outcome).toMatchObject({ kind: 'days', days: [{ date: '2025-01-01', guests: 10 }] });
    if (outcome.kind !== 'days') return;
    expect(outcome.entries.map((entry) => [entry.path, entry.status, entry.outcome])).toEqual([['a.csv', 'used', null], ['b.pdf', 'kept', 'not_a_table']]);
  });

  it('strips control characters from entry paths', async () => {
    const outcome = await read(zipOf([{ name: 'a\u0007b.txt', data: 'just words' }]));
    expect(outcome.kind === 'question' ? [] : outcome.entries.map((row) => row.path)).toEqual(['ab.txt']);
  });

  it('lists and reads an export of 10,000 tiny files in place, one family', async () => {
    const files = Array.from({ length: 10_000 }, (_, index) => {
      const date = new Date(Date.UTC(2000, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
      return { name: `daily/${date}.csv`, data: `Date,Guests,Net Sales\n${day(date, (index % 50) + 1)}` };
    });
    const outcome = await read(zipOf(files));
    // 10,000 days is more than one upload takes (ten years), so the archive is kept, every entry listed with why.
    expect(outcome).toMatchObject({ kind: 'kept', outcome: 'too_many_days' });
    if (outcome.kind !== 'kept') return;
    expect(outcome.entries).toHaveLength(10_000);
    const smaller = await read(zipOf(files.slice(5000, 6000)));
    expect(smaller).toMatchObject({ kind: 'days' });
    if (smaller.kind === 'days') {
      expect(smaller.days).toHaveLength(1000);
      expect(smaller.report.families).toEqual([expect.objectContaining({ entries: 1000, dayCount: 1000 })]);
    }
  }, 60_000);
});
