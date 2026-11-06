// A ZIP reader with no dependency (spec 11A): the central directory (and its ZIP64 form) read from the end of the
// archive by ranged reads, the archive guards checked on declared sizes before any byte is inflated, and one entry's
// bytes streamed through node:zlib with its real output counted. A workbook's guards use the same directory reader on
// a buffer; a stored ZIP is read in place, so it is never downloaded whole.
import { pipeline, Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  /** Bytes of the name as stored, for the local header's extent. */
  readonly nameLength: number;
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

/** An entry inflated past its declared size, or its data is not what the directory says. */
export class ZipDamagedError extends Error {
  /** True when the entry produced more than it declared: the whole archive is then distrusted. */
  readonly overrun: boolean;
  constructor(overrun: boolean) {
    super('zip: entry damaged');
    this.name = 'ZipDamagedError';
    this.overrun = overrun;
  }
}

/** `count` bytes from `offset` (fewer only at the end of the archive). */
export type RangeRead = (offset: number, count: number) => Promise<Buffer>;

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
const U32 = 0xffffffff;
/** The End of Central Directory record, its longest comment and the ZIP64 locator before it. */
export const TAIL_BYTES = 22 + MAX_COMMENT + 20;

function u64(buffer: Buffer, at: number): number {
  const value = buffer.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError('size too large');
  return Number(value);
}

interface Directory { readonly offset: number; readonly size: number; readonly count: number }

/** The directory's place, from the archive's last bytes (`tail`, which starts at `tailStart`). */
async function directoryOf(tail: Buffer, tailStart: number, archiveSize: number, read: RangeRead): Promise<Directory> {
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) !== EOCD) continue;
    let count = tail.readUInt16LE(at + 10);
    let size = tail.readUInt32LE(at + 12);
    let offset = tail.readUInt32LE(at + 16);
    const locator = at - 20;
    if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR) {
      const recordAt = u64(tail, locator + 8);
      if (recordAt + 56 > archiveSize) throw new ZipFormatError('bad zip64 record');
      const record = recordAt >= tailStart && recordAt + 56 <= tailStart + tail.length
        ? tail.subarray(recordAt - tailStart, recordAt - tailStart + 56)
        : await read(recordAt, 56);
      if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_EOCD) throw new ZipFormatError('bad zip64 record');
      count = u64(record, 32);
      size = u64(record, 40);
      offset = u64(record, 48);
    }
    if (offset + size > archiveSize) throw new ZipFormatError('directory out of range');
    return { offset, size, count };
  }
  throw new ZipFormatError('no end of central directory');
}

function parseDirectory(buffer: Buffer, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) throw new ZipFormatError('bad directory entry');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    let compressedSize = buffer.readUInt32LE(at + 20);
    let uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    let localHeaderOffset = buffer.readUInt32LE(at + 42);
    if (at + 46 + nameLength + extraLength > buffer.length) throw new ZipFormatError('bad directory entry');
    const name = buffer.toString((flags & 0x800) === 0 ? 'latin1' : 'utf8', at + 46, at + 46 + nameLength);
    // ZIP64: the extra field holds, in order, whichever of the three values were 0xFFFFFFFF.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra);
      const length = buffer.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === U32 && field + 8 <= extraEnd) { uncompressedSize = u64(buffer, field); field += 8; }
        if (compressedSize === U32 && field + 8 <= extraEnd) { compressedSize = u64(buffer, field); field += 8; }
        if (localHeaderOffset === U32 && field + 8 <= extraEnd) localHeaderOffset = u64(buffer, field);
      }
      extra += 4 + length;
    }
    entries.push({ name, nameLength, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    at = extraEnd + commentLength;
  }
  return entries;
}

export interface ZipListing {
  readonly entries: ZipEntry[];
  /** Where the central directory starts: no entry's data may run past it. */
  readonly directoryOffset: number;
}

/**
 * Every entry of an archive of `size` bytes, in central-directory order, read through `read`. Throws ZipFormatError
 * for an archive that cannot be read, `too many entries` past `maxEntries` and `directory too big` past
 * `maxDirectoryBytes`, before the directory itself is read.
 */
export async function readZip(read: RangeRead, size: number, limits: { maxEntries: number; maxDirectoryBytes: number }): Promise<ZipListing> {
  if (size < 22) throw new ZipFormatError('too short');
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = await read(tailStart, size - tailStart);
  const directory = await directoryOf(tail, tailStart, size, read);
  if (directory.count > limits.maxEntries) throw new ZipFormatError('too many entries');
  if (directory.size > limits.maxDirectoryBytes) throw new ZipFormatError('directory too big');
  const buffer = directory.offset >= tailStart
    ? tail.subarray(directory.offset - tailStart, directory.offset - tailStart + directory.size)
    : await read(directory.offset, directory.size);
  return { entries: parseDirectory(buffer, directory.count), directoryOffset: directory.offset };
}

/** A RangeRead over bytes already in memory (a workbook, or a ZIP inside a ZIP). */
export function bufferRead(buffer: Buffer): RangeRead {
  return (offset, count) => Promise.resolve(buffer.subarray(offset, offset + count));
}

/** Every entry of the ZIP in `buffer`, in central-directory order (a workbook's parts). */
export async function listZip(buffer: Buffer, maxEntries: number): Promise<ZipEntry[]> {
  return (await readZip(bufferRead(buffer), buffer.length, { maxEntries, maxDirectoryBytes: buffer.length })).entries;
}

export type ZipGuard = 'zip_too_big' | 'zip_bomb';

/**
 * The archive guards on declared sizes (spec 11A): the uncompressed total, the archive's ratio, each large entry's
 * ratio, and entry ranges that overlap (one entry's data inside another's, the overlapping-entry bomb). Null when the
 * archive passes. `declaredSoFar` carries the total of the archive this one sits inside.
 */
export function guardZip(
  listing: ZipListing, archiveBytes: number,
  limits: { maxDeclaredBytes: number; maxRatio: number; ratioFloorBytes: number },
  declaredSoFar = 0,
): ZipGuard | null {
  let declared = declaredSoFar;
  for (const entry of listing.entries) {
    declared += entry.uncompressedSize;
    if (entry.uncompressedSize > limits.ratioFloorBytes && entry.uncompressedSize > limits.maxRatio * Math.max(1, entry.compressedSize)) return 'zip_bomb';
  }
  if (declared > limits.maxDeclaredBytes) return 'zip_too_big';
  if (declared - declaredSoFar > limits.maxRatio * Math.max(1, archiveBytes)) return 'zip_bomb';
  const sorted = [...listing.entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  for (const [index, entry] of sorted.entries()) {
    const next = sorted[index + 1]?.localHeaderOffset ?? listing.directoryOffset;
    if (entry.localHeaderOffset + 30 + entry.nameLength + entry.compressedSize > next) return 'zip_bomb';
  }
  return null;
}

/** Where the entry's data ends at the latest: the next entry's header, or the directory. */
export function dataLimits(listing: ZipListing): Map<ZipEntry, number> {
  const sorted = [...listing.entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  return new Map(sorted.map((entry, index) => [entry, sorted[index + 1]?.localHeaderOffset ?? listing.directoryOffset]));
}

/**
 * The inflated bytes of one entry (method 0 or 8), streamed in pieces of at most `piece` compressed bytes. Throws
 * ZipDamagedError when the local header is wrong, the data runs past `limit`, the data does not inflate, or it
 * inflates past the declared size (`overrun`).
 */
export async function* entryBytes(read: RangeRead, entry: ZipEntry, limit: number, piece: number): AsyncGenerator<Buffer> {
  const header = await read(entry.localHeaderOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) throw new ZipDamagedError(false);
  const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressedSize > limit) throw new ZipDamagedError(false);
  async function* compressed(): AsyncGenerator<Buffer> {
    for (let at = 0; at < entry.compressedSize; at += piece) {
      const bytes = await read(start + at, Math.min(piece, entry.compressedSize - at));
      if (bytes.length === 0) throw new ZipDamagedError(false);
      yield bytes;
    }
  }
  const source = Readable.from(compressed(), { objectMode: false });
  const out: AsyncIterable<Buffer> = entry.method === 8 ? pipeline(source, createInflateRaw(), () => undefined) : source;
  let total = 0;
  try {
    for await (const part of out) {
      total += part.length;
      if (total > entry.uncompressedSize) throw new ZipDamagedError(true);
      yield part;
    }
  } catch (err) {
    if (err instanceof ZipDamagedError) throw err;
    throw new ZipDamagedError(false);
  } finally {
    source.destroy();
  }
}

/** The whole entry, when it is small enough to hold. */
export async function entryBuffer(read: RangeRead, entry: ZipEntry, limit: number, piece: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of entryBytes(read, entry, limit, piece)) parts.push(part);
  return Buffer.concat(parts);
}
