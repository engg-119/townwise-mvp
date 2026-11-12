import { ViewerError } from './errors';
import { VIEW_LIMITS } from './limits';

// A ZIP reader and a STORE-only writer with browser built-ins only. The reader takes the central directory from the
// end of the archive and checks every guard on the sizes it declares (entry count, each entry, the total, the
// compression ratio, and that no two entries' data overlap) before a byte is inflated. Inflating (DecompressionStream)
// stops the moment an entry passes its declared size or the cap. ZIP64, split archives, encryption and methods other
// than stored and deflate are refused with a typed error.

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const U16 = 0xffff;
const U32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
/** 1980-01-01 in MS-DOS date form: (1980 - 1980) << 9 | 1 << 5 | 1. */
const DOS_DATE_1980 = 0x0021;

function damaged(detail: string): ViewerError {
  return new ViewerError('damaged', detail);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function latin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** Where the End of Central Directory record starts: the last one whose comment ends the archive exactly. */
function findEnd(view: DataView): number {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - U16);
  for (let at = last; at >= first; at -= 1) {
    if (view.getUint32(at, true) === EOCD && at + 22 + view.getUint16(at + 20, true) === view.byteLength) return at;
  }
  throw damaged('no end of central directory');
}

/**
 * Every entry of the archive, in central-directory order, after the guards: at most VIEW_LIMITS.zipEntries entries,
 * each declaring at most zipEntryBytes inflated, zipTotalBytes in all, and no more than zipRatio times its compressed
 * size once past zipRatioFromBytes. Each entry's local header is checked and no two entries' data may overlap.
 */
export function listZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length > VIEW_LIMITS.originalBytes) throw new ViewerError('too_big', 'archive');
  if (bytes.length < 22) throw damaged('no end of central directory');
  const view = viewOf(bytes);
  const end = findEnd(view);
  if (end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR) throw new ViewerError('unsupported', 'zip64');
  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const onDisk = view.getUint16(end + 8, true);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === U16 || directorySize === U32 || directoryOffset === U32) throw new ViewerError('unsupported', 'zip64');
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) throw new ViewerError('unsupported', 'split archive');
  if (count > VIEW_LIMITS.zipEntries) throw new ViewerError('too_big', 'entries');
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > end) throw damaged('directory out of range');

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let total = 0;
  let at = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > directoryEnd || view.getUint32(at, true) !== CENTRAL) throw damaged('directory entry');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localHeaderOffset = view.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd) throw damaged('directory entry');
    if (compressedSize === U32 || size === U32 || localHeaderOffset === U32) throw new ViewerError('unsupported', 'zip64');
    const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
    if (method !== 0 && method !== 8) throw new ViewerError(encrypted ? 'encrypted' : 'unsupported', 'compression method');
    // A stored entry's data is the file itself (an encrypted one carries a 12-byte header first).
    if (method === 0 && !encrypted && compressedSize !== size) throw damaged('stored size');
    if (size > VIEW_LIMITS.zipEntryBytes) throw new ViewerError('too_big', 'entry');
    if (size > VIEW_LIMITS.zipRatioFromBytes && size > VIEW_LIMITS.zipRatio * compressedSize) {
      throw new ViewerError('too_big', 'compression ratio');
    }
    total += size;
    if (total > VIEW_LIMITS.zipTotalBytes) throw new ViewerError('too_big', 'total');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const name = (flags & FLAG_UTF8) !== 0 ? decoder.decode(nameBytes) : latin1(nameBytes);
    entries.push({ name, method, compressedSize, size, localHeaderOffset, encrypted });
    at = next;
  }
  checkExtents(view, entries, directoryOffset);
  return entries;
}

/** Where an entry's data starts, from its local header, after checking the header and the data fit the archive. */
function dataStart(view: DataView, entry: ZipEntry, limit: number): number {
  const at = entry.localHeaderOffset;
  if (at + 30 > limit || view.getUint32(at, true) !== LOCAL) throw damaged('local header');
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  if (start + entry.compressedSize > limit) throw damaged('entry out of range');
  return start;
}

/** Every entry's header and data lie before the central directory, and no two of them share a byte. */
function checkExtents(view: DataView, entries: readonly ZipEntry[], directoryOffset: number): void {
  const extents = entries
    .map((entry) => ({ from: entry.localHeaderOffset, to: dataStart(view, entry, directoryOffset) + entry.compressedSize }))
    .sort((a, b) => a.from - b.from);
  let previousEnd = 0;
  for (const extent of extents) {
    if (extent.from < previousEnd) throw damaged('overlapping entries');
    previousEnd = extent.to;
  }
}

function ignore(): void {
  // A stream error is reported once, by the reader.
}

/** Inflates `input`, which must produce exactly `size` bytes; stops after `limit` (at most `size`) bytes. */
async function inflateRaw(input: Uint8Array, size: number, limit: number): Promise<{ data: Uint8Array; complete: boolean }> {
  if (typeof DecompressionStream === 'undefined') throw new ViewerError('unsupported', 'browser cannot inflate');
  const out = new Uint8Array(limit);
  let length = 0;
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  writer.write(input as Uint8Array<ArrayBuffer>).catch(ignore);
  writer.close().catch(ignore);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (length + value.byteLength > limit) {
        if (limit < size) {
          out.set(value.subarray(0, limit - length), length);
          return { data: out, complete: false };
        }
        throw damaged('entry larger than declared');
      }
      out.set(value, length);
      length += value.byteLength;
    }
  } catch (error) {
    if (error instanceof ViewerError) throw error;
    throw damaged('deflate data');
  } finally {
    reader.cancel().catch(ignore);
  }
  if (length !== size) throw damaged('entry shorter than declared');
  return { data: out, complete: true };
}

async function entryBytes(bytes: Uint8Array, entry: ZipEntry, limit: number): Promise<{ data: Uint8Array; complete: boolean }> {
  if (entry.encrypted) throw new ViewerError('encrypted', 'entry');
  const start = dataStart(viewOf(bytes), entry, bytes.length);
  const input = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw damaged('stored size');
    return { data: input.slice(0, limit), complete: limit >= entry.size };
  }
  return inflateRaw(input, entry.size, Math.min(limit, entry.size));
}

/** One entry's bytes, inflated. ViewerError('too_big') when it declares more than `maxBytes`. */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
  if (entry.size > maxBytes) throw new ViewerError('too_big', 'entry');
  return (await entryBytes(bytes, entry, entry.size)).data;
}

/** The first `maxBytes` of an entry (all of it when it is no larger); `complete` is false when it was cut. */
export async function readZipEntryPrefix(
  bytes: Uint8Array, entry: ZipEntry, maxBytes: number,
): Promise<{ data: Uint8Array; complete: boolean }> {
  return entryBytes(bytes, entry, maxBytes);
}

let crcTable: Uint32Array | null = null;

/** The CRC-32 (IEEE 802.3) of `data`, as ZIP stores it. */
export function crc32(data: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const table = crcTable;
  let crc = U32;
  for (const byte of data) crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ U32) >>> 0;
}

/**
 * A ZIP of `files`, every one stored (method 0) under its UTF-8 name, dated 1980-01-01 00:00, with CRC-32, local
 * headers, the central directory and the end record. No ZIP64: past 65,535 files or 4 GiB it refuses.
 */
export function zipStore(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const records = files.map((file) => {
    const name = encoder.encode(file.name);
    if (name.length > U16) throw new ViewerError('too_big', 'name');
    return { name, data: file.data, crc: crc32(file.data) };
  });
  if (records.length >= U16) throw new ViewerError('too_big', 'entries');
  let localBytes = 0;
  let directoryBytes = 0;
  for (const record of records) {
    localBytes += 30 + record.name.length + record.data.length;
    directoryBytes += 46 + record.name.length;
  }
  if (localBytes + directoryBytes >= U32) throw new ViewerError('too_big', 'archive');

  const out = new Uint8Array(localBytes + directoryBytes + 22);
  const view = viewOf(out);
  const offsets: number[] = [];
  let at = 0;
  for (const record of records) {
    offsets.push(at);
    view.setUint32(at, LOCAL, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, FLAG_UTF8, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, DOS_DATE_1980, true);
    view.setUint32(at + 14, record.crc, true);
    view.setUint32(at + 18, record.data.length, true);
    view.setUint32(at + 22, record.data.length, true);
    view.setUint16(at + 26, record.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(record.name, at + 30);
    out.set(record.data, at + 30 + record.name.length);
    at += 30 + record.name.length + record.data.length;
  }
  const directoryOffset = at;
  records.forEach((record, index) => {
    view.setUint32(at, CENTRAL, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, FLAG_UTF8, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, DOS_DATE_1980, true);
    view.setUint32(at + 16, record.crc, true);
    view.setUint32(at + 20, record.data.length, true);
    view.setUint32(at + 24, record.data.length, true);
    view.setUint16(at + 28, record.name.length, true);
    view.setUint16(at + 30, 0, true);
    view.setUint16(at + 32, 0, true);
    view.setUint16(at + 34, 0, true);
    view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, 0, true);
    view.setUint32(at + 42, offsets[index] ?? 0, true);
    out.set(record.name, at + 46);
    at += 46 + record.name.length;
  });
  view.setUint32(at, EOCD, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, records.length, true);
  view.setUint16(at + 10, records.length, true);
  view.setUint32(at + 12, directoryBytes, true);
  view.setUint32(at + 16, directoryOffset, true);
  view.setUint16(at + 20, 0, true);
  return out;
}
