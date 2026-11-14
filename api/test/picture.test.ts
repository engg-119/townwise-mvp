// A picture attached to a TownwiseAI message (spec D36), before its bytes go to the model: its size from its header and
// its bytes without metadata (src/files/picture.ts), and what pictureContent sends. Crafted bytes only: each metadata
// segment or chunk holds a sentinel, and the pixels' bytes must come through unchanged.
import { describe, expect, it } from 'vitest';

import { pictureContent } from '../src/files/items.ts';
import { MODEL_PICTURE_MAX_SIDE } from '../src/files/limits.ts';
import { pictureSize, withoutMetadata } from '../src/files/picture.ts';

const bytes = (...parts: (number[] | Buffer | string)[]): Buffer => Buffer.concat(parts.map((part) => (
  typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part)
)));
const u16be = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const u32be = (value: number): number[] => [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const u32le = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
const u24le = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];

const SENTINELS = ['Sentinel-gps', 'Sentinel-iptc', 'Sentinel-comment', 'Sentinel-trailer', 'Sentinel-text', 'Sentinel-itxt', 'Sentinel-ztxt', 'Sentinel-exif', 'Sentinel-xmp'];

function withoutSentinels(out: Buffer | null): void {
  expect(out).not.toBeNull();
  for (const sentinel of SENTINELS) expect(out?.toString('latin1')).not.toContain(sentinel);
}

// JPEG: a marker segment is FF, the marker, a length that counts itself, the data.
const segment = (marker: number, data: Buffer): Buffer => bytes([0xff, marker], u16be(data.length + 2), data);
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const APP0 = segment(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]));
const DQT = segment(0xdb, Buffer.alloc(65, 1));
const sof = (marker: number, width: number, height: number): Buffer => segment(marker, bytes([8], u16be(height), u16be(width), [3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]));
const DHT = segment(0xc4, Buffer.alloc(20, 2));
const SOS = segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]));
/** Entropy-coded data: a stuffed FF 00 and an RST marker stay inside it. */
const SCAN = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);
const EXIF = segment(0xe1, bytes('Exif\0\0', 'Sentinel-gps'));
const XMP = segment(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0', 'Sentinel-xmp'));
const IPTC = segment(0xed, bytes('Photoshop 3.0\0', 'Sentinel-iptc'));
const COM = segment(0xfe, bytes('Sentinel-comment'));

describe('a JPEG', () => {
  const clean = bytes(SOI, APP0, DQT, sof(0xc0, 640, 480), DHT, SOS, SCAN, EOI);

  it('drops APP1 (EXIF, XMP), APP13 and COM and anything after its end, keeping every other byte', () => {
    const tagged = bytes(SOI, APP0, EXIF, XMP, IPTC, COM, DQT, sof(0xc0, 640, 480), DHT, SOS, SCAN, EOI, 'Sentinel-trailer');
    const out = withoutMetadata(tagged, 'image/jpeg');
    withoutSentinels(out);
    expect(out).toEqual(clean);
    // A JPEG with none comes through byte for byte.
    expect(withoutMetadata(clean, 'image/jpeg')).toEqual(clean);
  });

  it('keeps a progressive JPEG\'s later scans and drops a comment between them; fill bytes before a marker go', () => {
    const progressive = bytes(SOI, sof(0xc2, 100, 50), DHT, SOS, SCAN, COM, DHT, SOS, SCAN, [0xff, 0xff], EOI);
    expect(withoutMetadata(progressive, 'image/jpeg')).toEqual(bytes(SOI, sof(0xc2, 100, 50), DHT, SOS, SCAN, DHT, SOS, SCAN, EOI));
    expect(withoutMetadata(bytes(SOI, [0xff], EXIF, sof(0xc0, 1, 1), SOS, SCAN, EOI), 'image/jpeg')).toEqual(bytes(SOI, sof(0xc0, 1, 1), SOS, SCAN, EOI));
  });

  it('reads its size from the frame header, after any metadata, for baseline and progressive frames', () => {
    expect(pictureSize(bytes(SOI, APP0, EXIF, sof(0xc0, 640, 480), SOS, SCAN, EOI), 'image/jpeg')).toEqual({ width: 640, height: 480 });
    expect(pictureSize(bytes(SOI, sof(0xc2, 8001, 20), SOS, SCAN, EOI), 'image/jpeg')).toEqual({ width: 8001, height: 20 });
    // A DHT (C4) is no frame.
    expect(pictureSize(bytes(SOI, DHT, sof(0xc1, 3, 4), SOS, SCAN), 'image/jpeg')).toEqual({ width: 3, height: 4 });
  });

  it('is null when it doesn\'t parse: no SOI, a length past the end, no scan, a byte where a marker should be, or a zero size', () => {
    for (const broken of [
      bytes(APP0, SOS, SCAN, EOI),
      bytes(SOI, [0xff, 0xe1, 0x40, 0x00], 'short'),
      bytes(SOI, APP0, sof(0xc0, 1, 1), EOI),
      bytes(SOI, [0x12], SOS, SCAN, EOI),
      bytes(SOI, SOI, SOS, SCAN, EOI),
    ]) expect(withoutMetadata(broken, 'image/jpeg')).toBeNull();
    expect(pictureSize(bytes(SOI, sof(0xc0, 0, 10), SOS, SCAN, EOI), 'image/jpeg')).toBeNull();
    expect(pictureSize(bytes(SOI, SOS, SCAN, EOI), 'image/jpeg')).toBeNull();
  });
});

// PNG: the signature, then chunks (a length, a type, the data, a CRC this code never checks).
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunk = (type: string, data: Buffer | string): Buffer => {
  const body = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  return bytes(u32be(body.length), type, body, [0xde, 0xad, 0xbe, 0xef]);
};
const ihdr = (width: number, height: number): Buffer => chunk('IHDR', bytes(u32be(width), u32be(height), [8, 2, 0, 0, 0]));
const IDAT = chunk('IDAT', bytes([0x78, 0x9c, 0x01, 0x02, 0x03]));
const IEND = chunk('IEND', '');

describe('a PNG', () => {
  it('drops its tEXt, iTXt, zTXt and eXIf chunks and anything after IEND, keeping every other chunk byte for byte', () => {
    const tagged = bytes(
      SIGNATURE, ihdr(32, 16), chunk('tEXt', 'Comment\0Sentinel-text'), chunk('iCCP', 'icc'), chunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0Sentinel-itxt'),
      IDAT, chunk('zTXt', 'Raw\0\0Sentinel-ztxt'), chunk('eXIf', 'MM\0*Sentinel-exif'), IEND, 'Sentinel-trailer',
    );
    const out = withoutMetadata(tagged, 'image/png');
    withoutSentinels(out);
    expect(out).toEqual(bytes(SIGNATURE, ihdr(32, 16), chunk('iCCP', 'icc'), IDAT, IEND));
    const clean = bytes(SIGNATURE, ihdr(32, 16), IDAT, IEND);
    expect(withoutMetadata(clean, 'image/png')).toEqual(clean);
  });

  it('reads its size from IHDR', () => {
    expect(pictureSize(bytes(SIGNATURE, ihdr(9000, 12), IDAT, IEND), 'image/png')).toEqual({ width: 9000, height: 12 });
  });

  it('is null without IEND, with IHDR not first, with a chunk past the end, or with another signature', () => {
    for (const broken of [
      bytes(SIGNATURE, ihdr(2, 2), IDAT),
      bytes(SIGNATURE, IDAT, ihdr(2, 2), IEND),
      bytes(SIGNATURE, ihdr(2, 2), u32be(1000), 'IDAT', 'short'),
      bytes('GIF89a', ihdr(2, 2), IEND),
    ]) {
      expect(withoutMetadata(broken, 'image/png')).toBeNull();
      expect(pictureSize(broken, 'image/png')).toBeNull();
    }
  });
});

// WebP: RIFF, its size, WEBP, then chunks (a code, a little-endian size, the data, a pad byte when the size is odd).
const webpChunk = (code: string, data: Buffer | string): Buffer => {
  const body = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  return bytes(code, u32le(body.length), body, body.length % 2 === 1 ? [0] : []);
};
const riff = (...chunks: Buffer[]): Buffer => {
  const body = bytes('WEBP', ...chunks);
  return bytes('RIFF', u32le(body.length), body);
};
const vp8x = (flags: number, width: number, height: number): Buffer => webpChunk('VP8X', bytes([flags, 0, 0, 0], u24le(width - 1), u24le(height - 1)));
/** VP8L: the signature 0x2F, then 14 bits of width - 1 and 14 of height - 1, little-endian. */
const vp8l = (width: number, height: number): Buffer => {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return webpChunk('VP8L', bytes([0x2f], u32le(bits), [1, 2, 3]));
};
/** VP8: a frame tag, the start code 9D 01 2A, then 14-bit width and height (the top bits are a scale). */
const vp8 = (width: number, height: number): Buffer => webpChunk('VP8 ', bytes([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a], [width & 0xff, (width >> 8) | 0x40], [height & 0xff, height >> 8], [4, 5]));

describe('a WebP', () => {
  it('drops its EXIF and XMP chunks, clears VP8X\'s flags for them and writes the RIFF size again, keeping the rest', () => {
    const tagged = riff(vp8x(0x20 | 0x10 | 0x08 | 0x04, 640, 480), webpChunk('ICCP', 'icc'), vp8l(640, 480), webpChunk('EXIF', 'Sentinel-exif'), webpChunk('XMP ', 'Sentinel-xmp!'));
    const out = withoutMetadata(tagged, 'image/webp');
    withoutSentinels(out);
    expect(out).toEqual(riff(vp8x(0x20 | 0x10, 640, 480), webpChunk('ICCP', 'icc'), vp8l(640, 480)));
    const simple = riff(vp8(30, 20));
    expect(withoutMetadata(simple, 'image/webp')).toEqual(simple);
  });

  it('reads its size from VP8X, VP8L or VP8', () => {
    expect(pictureSize(riff(vp8x(0, 9000, 100), vp8(1, 1)), 'image/webp')).toEqual({ width: 9000, height: 100 });
    expect(pictureSize(riff(vp8l(300, 16384)), 'image/webp')).toEqual({ width: 300, height: 16384 });
    expect(pictureSize(riff(vp8(1024, 768)), 'image/webp')).toEqual({ width: 1024, height: 768 });
  });

  it('is null with a chunk past the RIFF, no chunk, or a first chunk that isn\'t a picture', () => {
    expect(withoutMetadata(bytes('RIFF', u32le(100), 'WEBP', 'VP8L', u32le(90), [0x2f]), 'image/webp')).toBeNull();
    expect(withoutMetadata(riff(), 'image/webp')).toBeNull();
    expect(pictureSize(riff(webpChunk('EXIF', 'x')), 'image/webp')).toBeNull();
  });
});

describe('a GIF', () => {
  it('reads its size from the logical screen and is sent as it is', () => {
    const gif = bytes('GIF89a', [0x40, 0x1f, 0x10, 0x00], [0, 0, 0], ';');
    expect(pictureSize(gif, 'image/gif')).toEqual({ width: 8000, height: 16 });
    expect(withoutMetadata(gif, 'image/gif')).toEqual(gif);
    expect(withoutMetadata(Buffer.from('GIF8'), 'image/gif')).toBeNull();
  });
});

describe('what a turn sends of a picture', () => {
  it('sends it without metadata, refuses one over 8,000 pixels on a side, and lists one that doesn\'t parse as not readable', () => {
    expect(MODEL_PICTURE_MAX_SIDE).toBe(8000);
    const tagged = bytes(SIGNATURE, ihdr(8000, 8000), chunk('tEXt', 'Sentinel-text'), IDAT, IEND);
    expect(pictureContent(tagged, 'image/png')).toEqual({
      status: 'picture', mediaType: 'image/png', base64: bytes(SIGNATURE, ihdr(8000, 8000), IDAT, IEND).toString('base64'),
    });
    expect(pictureContent(bytes(SIGNATURE, ihdr(8001, 10), IDAT, IEND), 'image/png')).toEqual({ status: 'too_many_pixels', kind: 'picture' });
    expect(pictureContent(bytes(SOI, sof(0xc0, 10, 8001), SOS, SCAN, EOI), 'image/jpeg')).toEqual({ status: 'too_many_pixels', kind: 'picture' });
    expect(pictureContent(bytes(SIGNATURE, ihdr(2, 2), IDAT), 'image/png')).toEqual({ status: 'not_readable', kind: 'picture' });
  });
});
