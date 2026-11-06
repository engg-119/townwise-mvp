// A ZIP central directory reader (spec 11A), with no dependency: the entries' names, methods and declared sizes, read
// from the End of Central Directory record (and its ZIP64 form) without inflating anything, so a workbook's guards run
// before any byte is decompressed.

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/** The archive's structure cannot be read. */
export class ZipFormatError extends Error {
  constructor(reason: string) {
    super(`zip: ${reason}`);
    this.name = 'ZipFormatError';
  }
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const MAX_COMMENT = 0xffff;
const U32 = 0xffffffff;

function u64(buffer: Buffer, at: number): number {
  const value = buffer.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError('size too large');
  return Number(value);
}

/** Where the central directory starts and how many entries it has. */
function directoryOf(buffer: Buffer): { offset: number; size: number; count: number } {
  const from = Math.max(0, buffer.length - 22 - MAX_COMMENT);
  for (let at = buffer.length - 22; at >= from; at -= 1) {
    if (buffer.readUInt32LE(at) !== EOCD) continue;
    let count = buffer.readUInt16LE(at + 10);
    let size = buffer.readUInt32LE(at + 12);
    let offset = buffer.readUInt32LE(at + 16);
    const locator = at - 20;
    if (locator >= 0 && buffer.readUInt32LE(locator) === ZIP64_LOCATOR) {
      const record = u64(buffer, locator + 8);
      if (record + 56 > buffer.length || buffer.readUInt32LE(record) !== ZIP64_EOCD) throw new ZipFormatError('bad zip64 record');
      count = u64(buffer, record + 32);
      size = u64(buffer, record + 40);
      offset = u64(buffer, record + 48);
    }
    if (offset + size > buffer.length) throw new ZipFormatError('directory out of range');
    return { offset, size, count };
  }
  throw new ZipFormatError('no end of central directory');
}

/** Every entry of the ZIP in `buffer`, in central-directory order. `maxEntries` stops a huge directory early. */
export function listZip(buffer: Buffer, maxEntries: number): ZipEntry[] {
  if (buffer.length < 22) throw new ZipFormatError('too short');
  const directory = directoryOf(buffer);
  if (directory.count > maxEntries) throw new ZipFormatError('too many entries');
  const entries: ZipEntry[] = [];
  let at = directory.offset;
  for (let index = 0; index < directory.count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) throw new ZipFormatError('bad directory entry');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    let compressedSize = buffer.readUInt32LE(at + 20);
    let uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    let localHeaderOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString((flags & 0x800) === 0 ? 'latin1' : 'utf8', at + 46, at + 46 + nameLength);
    // ZIP64: the extra field holds, in order, whichever of the three values were 0xFFFFFFFF.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra);
      const length = buffer.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === U32) { uncompressedSize = u64(buffer, field); field += 8; }
        if (compressedSize === U32) { compressedSize = u64(buffer, field); field += 8; }
        if (localHeaderOffset === U32) localHeaderOffset = u64(buffer, field);
      }
      extra += 4 + length;
    }
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    at = extraEnd + commentLength;
  }
  return entries;
}
