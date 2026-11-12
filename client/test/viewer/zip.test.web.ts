import './setup';

import { ViewerError } from '../../src/portal/viewer/errors';
import { VIEW_LIMITS } from '../../src/portal/viewer/limits';
import { crc32, listZip, readZipEntry, readZipEntryPrefix, zipStore } from '../../src/portal/viewer/zip';
import { buildZip } from './fixtures';

// The ZIP reader's guards and the STORE writer. Every archive here is synthetic.

const MIB = 1024 * 1024;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function reason(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ViewerError) return error.reason;
    throw error;
  }
  return 'no error';
}

/** The reason `listZip` refuses `zip` with. */
function refusal(zip: Uint8Array): string {
  try {
    listZip(zip);
  } catch (error) {
    if (error instanceof ViewerError) return error.reason;
    throw error;
  }
  return 'no error';
}

describe('reading entries', () => {
  test('lists the central directory and reads stored and deflated entries', async () => {
    const zip = buildZip([
      { name: 'a.txt', data: 'stored text' },
      { name: 'dir/b.xml', data: '<x>deflated, deflated, deflated</x>', deflate: true },
      { name: 'café.txt', data: 'utf-8 name' },
    ]);
    const entries = listZip(zip);
    expect(entries.map((entry) => [entry.name, entry.method, entry.encrypted])).toEqual([
      ['a.txt', 0, false], ['dir/b.xml', 8, false], ['café.txt', 0, false],
    ]);
    const [a, b] = entries;
    if (a === undefined || b === undefined) throw new Error('missing entries');
    expect(text(await readZipEntry(zip, a, 1000))).toBe('stored text');
    expect(text(await readZipEntry(zip, b, 1000))).toBe('<x>deflated, deflated, deflated</x>');
  });

  test('inflates a large deflated entry whole', async () => {
    const big = 'row,'.repeat(200_000);
    const zip = buildZip([{ name: 'big.csv', data: big, deflate: true }]);
    const [entry] = listZip(zip);
    if (entry === undefined) throw new Error('missing entry');
    expect(entry.compressedSize).toBeLessThan(entry.size);
    expect(text(await readZipEntry(zip, entry, VIEW_LIMITS.zipEntryBytes))).toBe(big);
  });

  test('refuses an entry larger than the caller’s cap before inflating it', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'x'.repeat(5000), deflate: true }]);
    const [entry] = listZip(zip);
    if (entry === undefined) throw new Error('missing entry');
    expect(await reason(() => readZipEntry(zip, entry, 4999))).toBe('too_big');
  });

  test('a prefix read stops at its cap and says the entry was cut', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'abcdefghij'.repeat(100_000), deflate: true }]);
    const [entry] = listZip(zip);
    if (entry === undefined) throw new Error('missing entry');
    const part = await readZipEntryPrefix(zip, entry, 12_345);
    expect(part.complete).toBe(false);
    expect(part.data.length).toBe(12_345);
    expect(text(part.data)).toBe('abcdefghij'.repeat(100_000).slice(0, 12_345));
    const whole = await readZipEntryPrefix(zip, entry, entry.size);
    expect(whole.complete).toBe(true);
  });

  test('an entry that inflates past its declared size is damaged', async () => {
    const zip = buildZip([{ name: 'liar.xml', data: 'y'.repeat(4000), deflate: true, size: 100 }]);
    const [entry] = listZip(zip);
    if (entry === undefined) throw new Error('missing entry');
    expect(await reason(() => readZipEntry(zip, entry, 1000))).toBe('damaged');
  });

  test('an entry that inflates short of its declared size is damaged', async () => {
    const zip = buildZip([{ name: 'short.xml', data: 'y'.repeat(100), deflate: true, size: 4000 }]);
    const [entry] = listZip(zip);
    if (entry === undefined) throw new Error('missing entry');
    expect(await reason(() => readZipEntry(zip, entry, 10_000))).toBe('damaged');
  });

  test('corrupt deflate data is damaged', async () => {
    const zip = buildZip([{ name: 'junk.xml', data: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), method: 8, size: 50 }]);
    const [entry] = listZip(zip);
    if (entry === undefined) throw new Error('missing entry');
    expect(await reason(() => readZipEntry(zip, entry, 1000))).toBe('damaged');
  });
});

describe('guards on the central directory', () => {
  test('a compression bomb (a ratio over 100 on an entry over 1 MiB) is too big', () => {
    const zip = buildZip([{ name: 'bomb.xml', data: new Uint8Array(2 * MIB), deflate: true }]);
    expect(zip.length).toBeLessThan(10_000);
    expect(refusal(zip)).toBe('too_big');
  });

  test('a high ratio on a small entry is allowed', () => {
    const zip = buildZip([{ name: 'small.xml', data: new Uint8Array(MIB), deflate: true }]);
    expect(listZip(zip)).toHaveLength(1);
  });

  test('more than 10,000 entries is too big', () => {
    const zip = buildZip([{ name: 'a', data: '' }], { count: VIEW_LIMITS.zipEntries + 1 });
    expect(refusal(zip)).toBe('too_big');
  });

  test('an entry declaring more than 64 MiB, or entries more than 128 MiB together, are too big', () => {
    const oneHuge = buildZip([{ name: 'a', data: 'x', method: 8, size: 64 * MIB + 1, compressedSize: MIB }]);
    expect(refusal(oneHuge)).toBe('too_big');
    const many = buildZip([0, 1, 2].map((i) => ({ name: `p${String(i)}`, data: 'x', method: 8, size: 50 * MIB, compressedSize: MIB })));
    expect(refusal(many)).toBe('too_big');
  });

  test('two entries sharing one entry’s data (an overlapping bomb) are damaged', () => {
    const zip = buildZip([{ name: 'a.xml', data: 'shared data', deflate: true }, { name: 'b.xml', data: 'shared data', deflate: true, sameDataAs: 0 }]);
    expect(refusal(zip)).toBe('damaged');
  });

  test('a declared compressed size running past the directory is damaged', () => {
    const zip = buildZip([{ name: 'a.xml', data: 'abc', compressedSize: 5000, size: 5000 }]);
    expect(refusal(zip)).toBe('damaged');
  });

  test('an encrypted entry is listed as encrypted and refused when read', async () => {
    const zip = buildZip([{ name: 'secret.xml', data: 'not really encrypted', flags: 0x0001 }]);
    const [entry] = listZip(zip);
    expect(entry?.encrypted).toBe(true);
    if (entry === undefined) throw new Error('missing entry');
    expect(await reason(() => readZipEntry(zip, entry, 1000))).toBe('encrypted');
  });

  test('an AES-encrypted entry (method 99) is encrypted; another method is unsupported', () => {
    expect(refusal(buildZip([{ name: 'a', data: 'x', method: 99, flags: 0x0001 }]))).toBe('encrypted');
    expect(refusal(buildZip([{ name: 'a', data: 'x', method: 12 }]))).toBe('unsupported');
  });

  test('ZIP64 is unsupported', () => {
    expect(refusal(buildZip([{ name: 'a', data: 'x' }], { zip64Locator: true }))).toBe('unsupported');
    expect(refusal(buildZip([{ name: 'a', data: 'x', size: 0xffffffff, compressedSize: 0xffffffff }]))).toBe('unsupported');
  });

  test('a truncated archive, or bytes that are no archive, are damaged', () => {
    const zip = buildZip([{ name: 'a.xml', data: 'some text here', deflate: true }]);
    for (const cut of [zip.length - 1, zip.length - 30, 25, 10, 0]) {
      expect(refusal(zip.subarray(0, cut))).toBe('damaged');
    }
    expect(refusal(new TextEncoder().encode('plain text, no archive at all'))).toBe('damaged');
  });

  test('an archive larger than the page fetches is too big', () => {
    expect(refusal(new Uint8Array(VIEW_LIMITS.originalBytes + 1))).toBe('too_big');
  });
});

describe('the STORE writer', () => {
  test('CRC-32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  test('what it writes reads back, names in UTF-8, every entry stored', async () => {
    const files = [
      { name: '[Content_Types].xml', data: new TextEncoder().encode('<Types/>') },
      { name: 'xl/données.xml', data: new TextEncoder().encode('é'.repeat(1000)) },
      { name: 'empty', data: new Uint8Array(0) },
    ];
    const zip = zipStore(files);
    const entries = listZip(zip);
    expect(entries.map((entry) => [entry.name, entry.method, entry.size, entry.compressedSize])).toEqual(
      files.map((file) => [file.name, 0, file.data.length, file.data.length]),
    );
    for (const [index, entry] of entries.entries()) {
      expect(Array.from(await readZipEntry(zip, entry, MIB))).toEqual(Array.from(files[index]?.data ?? []));
    }
  });

  test('sets the UTF-8 flag and dates every entry 1980-01-01', () => {
    const zip = zipStore([{ name: 'a', data: new Uint8Array([1, 2, 3]) }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true)).toBe(0x0800);
    expect(view.getUint16(10, true)).toBe(0);
    expect(view.getUint16(12, true)).toBe(0x21);
    expect(view.getUint32(14, true)).toBe(crc32(new Uint8Array([1, 2, 3])));
  });
});
