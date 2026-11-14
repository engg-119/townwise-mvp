// A picture attached to a TownwiseAI message, before its bytes go to the model (spec D36): its size in pixels, read from
// its header, and its bytes without the metadata a camera or an editor writes beside the pixels (where and when it was
// taken, the device, the author, a caption). JPEG drops its APP1 (EXIF, XMP), APP13 (IPTC) and COM segments and
// anything after its end; PNG its tEXt, iTXt, zTXt and eXIf chunks and anything after IEND; WebP its EXIF and XMP chunks
// (with the VP8X flags that announce them). Every other segment or chunk, the pixels among them, is kept byte for
// byte. A GIF is sent as it is. Bytes that don't parse as their type are null: such a picture is never sent. Pure; no
// dependency.
import type { PictureType } from './sniff.ts';

export interface PictureSize {
  readonly width: number;
  readonly height: number;
}

function byteAt(bytes: Uint8Array, at: number): number {
  return bytes[at] ?? -1;
}

function u16be(bytes: Uint8Array, at: number): number {
  return (byteAt(bytes, at) << 8) | byteAt(bytes, at + 1);
}

function u16le(bytes: Uint8Array, at: number): number {
  return byteAt(bytes, at) | (byteAt(bytes, at + 1) << 8);
}

function u24le(bytes: Uint8Array, at: number): number {
  return byteAt(bytes, at) | (byteAt(bytes, at + 1) << 8) | (byteAt(bytes, at + 2) << 16);
}

function u32be(bytes: Uint8Array, at: number): number {
  return ((byteAt(bytes, at) << 24) >>> 0) + (u16be(bytes, at + 1) << 8) + byteAt(bytes, at + 3);
}

function u32le(bytes: Uint8Array, at: number): number {
  return u16le(bytes, at) + ((u16le(bytes, at + 2) << 16) >>> 0);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return at + length > bytes.length ? '' : Buffer.from(bytes.subarray(at, at + length)).toString('latin1');
}

function sized(width: number, height: number): PictureSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

// JPEG: SOI, then marker segments (0xFF, a marker byte, a two-byte length that counts itself, the data), each scan's
// entropy-coded data after its SOS segment, and EOI.
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
/** Dropped: APP1 (EXIF, XMP), APP13 (Photoshop's IPTC) and COM. */
const JPEG_METADATA: ReadonlySet<number> = new Set([0xe1, 0xed, 0xfe]);
/** Start of frame, which carries the size: C0 to CF except DHT (C4), JPG (C8) and DAC (CC). */
const SOF: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

interface JpegPart {
  readonly marker: number;
  /** Where its 0xFF is (fill bytes before it are not part of it). */
  readonly start: number;
  /** Past its last byte: a scan's part ends after its entropy-coded data. */
  readonly end: number;
}

function isRst(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

/** The parts after SOI, up to EOI or the end of the bytes; null unless it is a JPEG with at least one scan. */
function jpegParts(bytes: Uint8Array): JpegPart[] | null {
  if (byteAt(bytes, 0) !== 0xff || byteAt(bytes, 1) !== SOI) return null;
  const parts: JpegPart[] = [];
  let at = 2;
  while (at < bytes.length) {
    if (byteAt(bytes, at) !== 0xff) return null;
    while (byteAt(bytes, at) === 0xff) at += 1;
    const marker = byteAt(bytes, at);
    const start = at - 1;
    at += 1;
    if (marker === EOI) {
      parts.push({ marker, start, end: at });
      break;
    }
    if (marker === -1 || marker === 0x00 || marker === SOI) return null;
    if (marker === 0x01 || isRst(marker)) {
      parts.push({ marker, start, end: at });
      continue;
    }
    const length = u16be(bytes, at);
    if (length < 2 || at + length > bytes.length) return null;
    at += length;
    if (marker === SOS) {
      // Entropy-coded data runs to the next marker: an 0xFF followed by neither 0x00 (a stuffed byte) nor an RST.
      while (at < bytes.length) {
        const next = byteAt(bytes, at + 1);
        if (byteAt(bytes, at) === 0xff && next !== -1 && next !== 0x00 && !isRst(next)) break;
        at += 1;
      }
    }
    parts.push({ marker, start, end: at });
  }
  return parts.some((part) => part.marker === SOS) ? parts : null;
}

function jpegSize(bytes: Uint8Array): PictureSize | null {
  const frame = jpegParts(bytes)?.find((part) => SOF.has(part.marker));
  // FF, the marker, the length (2), the precision (1), the height (2), the width (2).
  if (frame === undefined || frame.end < frame.start + 9) return null;
  return sized(u16be(bytes, frame.start + 7), u16be(bytes, frame.start + 5));
}

function stripJpeg(bytes: Uint8Array): Buffer | null {
  const parts = jpegParts(bytes);
  if (parts === null) return null;
  const kept = parts.filter((part) => !JPEG_METADATA.has(part.marker)).map((part) => bytes.subarray(part.start, part.end));
  return Buffer.concat([Buffer.from([0xff, SOI]), ...kept]);
}

// PNG: its 8-byte signature, then chunks (a four-byte length, a four-letter type, the data, a CRC), IHDR first, IEND last.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA: ReadonlySet<string> = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);

interface PngChunk { readonly type: string; readonly start: number; readonly end: number }

/** The chunks up to and including IEND; null unless it is a PNG whose first chunk is IHDR and which ends with IEND. */
function pngChunks(bytes: Uint8Array): PngChunk[] | null {
  if (bytes.length < 8 || !PNG_SIGNATURE.equals(bytes.subarray(0, 8))) return null;
  const chunks: PngChunk[] = [];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const end = at + 12 + u32be(bytes, at);
    if (end > bytes.length) return null;
    const type = ascii(bytes, at + 4, 4);
    chunks.push({ type, start: at, end });
    at = end;
    if (type === 'IEND') return chunks[0]?.type === 'IHDR' ? chunks : null;
  }
  return null;
}

function pngSize(bytes: Uint8Array): PictureSize | null {
  const header = pngChunks(bytes)?.[0];
  // The length, "IHDR", the width (4), the height (4).
  return header === undefined || header.end < header.start + 16 ? null : sized(u32be(bytes, header.start + 8), u32be(bytes, header.start + 12));
}

function stripPng(bytes: Uint8Array): Buffer | null {
  const chunks = pngChunks(bytes);
  if (chunks === null) return null;
  return Buffer.concat([PNG_SIGNATURE, ...chunks.filter((chunk) => !PNG_METADATA.has(chunk.type)).map((chunk) => bytes.subarray(chunk.start, chunk.end))]);
}

// WebP: "RIFF", a four-byte little-endian size of what follows it, "WEBP", then chunks (a four-letter code, a four-byte
// little-endian size, the data, a pad byte when the size is odd). The first is VP8 (lossy), VP8L (lossless) or VP8X
// (extended: its flags say whether EXIF and XMP chunks follow).
const WEBP_METADATA: ReadonlySet<string> = new Set(['EXIF', 'XMP ']);
/** VP8X's flags: EXIF (0x08) and XMP (0x04). */
const VP8X_METADATA_FLAGS = 0x08 | 0x04;

interface WebpChunk { readonly code: string; readonly start: number; readonly end: number }

/** The chunks, within the RIFF's own size; null unless it is a WebP with at least one chunk. */
function webpChunks(bytes: Uint8Array): WebpChunk[] | null {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const riffEnd = Math.min(bytes.length, 8 + u32le(bytes, 4));
  const chunks: WebpChunk[] = [];
  let at = 12;
  while (at + 8 <= riffEnd) {
    const size = u32le(bytes, at + 4);
    const dataEnd = at + 8 + size;
    if (dataEnd > riffEnd) return null;
    // An odd chunk's pad byte, when the file has it.
    const end = Math.min(riffEnd, dataEnd + (size % 2));
    chunks.push({ code: ascii(bytes, at, 4), start: at, end });
    at = end;
  }
  return chunks.length === 0 ? null : chunks;
}

function webpSize(bytes: Uint8Array): PictureSize | null {
  const first = webpChunks(bytes)?.[0];
  if (first === undefined) return null;
  const data = first.start + 8;
  if (first.code === 'VP8X' && first.end >= data + 10) return sized(1 + u24le(bytes, data + 4), 1 + u24le(bytes, data + 7));
  if (first.code === 'VP8L' && first.end >= data + 5 && byteAt(bytes, data) === 0x2f) {
    const [b0, b1, b2, b3] = [byteAt(bytes, data + 1), byteAt(bytes, data + 2), byteAt(bytes, data + 3), byteAt(bytes, data + 4)];
    return sized(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
  }
  // VP8: a three-byte frame tag, the start code 9D 01 2A, then 14-bit width and height.
  if (first.code === 'VP8 ' && first.end >= data + 10 && byteAt(bytes, data + 3) === 0x9d && byteAt(bytes, data + 4) === 0x01 && byteAt(bytes, data + 5) === 0x2a) {
    return sized(u16le(bytes, data + 6) & 0x3fff, u16le(bytes, data + 8) & 0x3fff);
  }
  return null;
}

function stripWebp(bytes: Uint8Array): Buffer | null {
  const chunks = webpChunks(bytes);
  if (chunks === null) return null;
  const kept = chunks.filter((chunk) => !WEBP_METADATA.has(chunk.code)).map((chunk) => {
    const part = Buffer.from(bytes.subarray(chunk.start, chunk.end));
    if (chunk.code === 'VP8X' && part.length > 8) part[8] = (part[8] ?? 0) & ~VP8X_METADATA_FLAGS;
    return part;
  });
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...kept]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, body]);
}

function gifSize(bytes: Uint8Array): PictureSize | null {
  // "GIF87a" or "GIF89a", then the logical screen's width and height.
  return ascii(bytes, 0, 4) !== 'GIF8' || bytes.length < 10 ? null : sized(u16le(bytes, 6), u16le(bytes, 8));
}

/** The picture's width and height in pixels, from its header; null when its bytes don't parse as `type`. */
export function pictureSize(bytes: Uint8Array, type: PictureType): PictureSize | null {
  switch (type) {
    case 'image/jpeg': return jpegSize(bytes);
    case 'image/png': return pngSize(bytes);
    case 'image/webp': return webpSize(bytes);
    case 'image/gif': return gifSize(bytes);
  }
}

/** The picture without its metadata, its pixels byte for byte; null when its bytes don't parse as `type`. */
export function withoutMetadata(bytes: Uint8Array, type: PictureType): Buffer | null {
  switch (type) {
    case 'image/jpeg': return stripJpeg(bytes);
    case 'image/png': return stripPng(bytes);
    case 'image/webp': return stripWebp(bytes);
    case 'image/gif': return gifSize(bytes) === null ? null : Buffer.from(bytes);
  }
}
