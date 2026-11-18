import { heicToJpeg } from '../../../src/portal/orders/heic.web';

// An iPhone's HEIC photo as a JPEG (D41): the browser's own decoding first, libheif-js otherwise, a long side of at
// most 4,096 pixels, and the picture cap checked on the JPEG. jsdom draws nothing, so the canvas and the decoders are
// stand-ins; the real conversion was checked in Chrome under the production CSP (client/MODULE.md).

const mockDecode = jest.fn();
jest.mock('../../../src/portal/orders/heicDecoder.web', () => ({
  loadHeicDecoder: () => Promise.resolve({ HeifDecoder: class { decode = mockDecode; } }),
}));

interface Stage { sizes: number[]; drawn: unknown[]; made: HTMLCanvasElement[] }

function stage(blobSizes: (number | null)[]): Stage {
  const seen: Stage = { sizes: [...(blobSizes as number[])], drawn: [], made: [] };
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    seen.made.push(this);
    return { drawImage: (...args: unknown[]) => { seen.drawn.push(args); } } as unknown as CanvasRenderingContext2D;
  } as never);
  jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) => {
    const size = blobSizes.shift();
    done(size === null || size === undefined ? null : sized(size));
  });
  return seen;
}

/** A JPEG of `size` bytes, without its bytes. */
function sized(size: number): Blob {
  return { size, type: 'image/jpeg' } as unknown as Blob;
}

const close = jest.fn();

function bitmap(width: number, height: number): ImageBitmap {
  return { width, height, close };
}

const photo = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as Blob;

afterEach(() => {
  jest.restoreAllMocks();
  mockDecode.mockReset();
  close.mockReset();
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  delete (globalThis as { ImageData?: unknown }).ImageData;
});

test('a browser that draws HEIC itself makes the JPEG without the library, a 24 megapixel photo drawn at 4,096 pixels', async () => {
  const drawn = bitmap(5712, 4284);
  globalThis.createImageBitmap = jest.fn(() => Promise.resolve(drawn));
  const seen = stage([1_000_000]);
  expect(await heicToJpeg(photo)).toEqual({ jpeg: { size: 1_000_000, type: 'image/jpeg' } });
  expect(mockDecode).not.toHaveBeenCalled();
  expect([seen.made[0]?.width, seen.made[0]?.height]).toEqual([4096, 3072]);
  expect(seen.drawn).toEqual([[drawn, 0, 0, 4096, 3072]]);
  expect(close).toHaveBeenCalled();
});

test('any other browser decodes the primary image with libheif-js, frees it, and keeps a small photo’s size', async () => {
  const free = jest.fn();
  const image = (primary: boolean, width: number) => ({
    get_width: () => width, get_height: () => 600, is_primary: () => primary, free,
    display: (target: unknown, done: (shown: unknown) => void) => { done(target); },
  });
  mockDecode.mockReturnValue([image(false, 100), image(true, 800)]);
  (globalThis as { ImageData?: unknown }).ImageData = class { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h; } };
  globalThis.createImageBitmap = jest.fn((source: { width?: number; height?: number }) => (
    source === photo ? Promise.reject(new Error('not drawn')) : Promise.resolve(bitmap(source.width ?? 0, source.height ?? 0))
  )) as never;
  const seen = stage([200_000]);
  expect(await heicToJpeg(photo)).toEqual({ jpeg: { size: 200_000, type: 'image/jpeg' } });
  expect([seen.made[0]?.width, seen.made[0]?.height]).toEqual([800, 600]);
  expect(free).toHaveBeenCalledTimes(2);
});

test('the quality drops until the JPEG fits 3.75 MB, and a photo that never fits or is over 8,000 pixels is too large', async () => {
  globalThis.createImageBitmap = jest.fn(() => Promise.resolve(bitmap(4000, 3000)));
  stage([4_000_000, 3_750_000]);
  expect(await heicToJpeg(photo)).toEqual({ jpeg: { size: 3_750_000, type: 'image/jpeg' } });
  jest.restoreAllMocks();
  stage([4_000_000, 3_900_000, 3_750_001]);
  expect(await heicToJpeg(photo)).toEqual({ problem: 'too_large' });
  globalThis.createImageBitmap = jest.fn(() => Promise.reject(new Error('not drawn')));
  const free = jest.fn();
  mockDecode.mockReturnValue([{ get_width: () => 8064, get_height: () => 6048, is_primary: () => true, free, display: jest.fn() }]);
  expect(await heicToJpeg(photo)).toEqual({ problem: 'too_large' });
  expect(free).toHaveBeenCalled();
});

test('a file that is no HEIC photo, or a canvas that gives nothing, is not read', async () => {
  globalThis.createImageBitmap = jest.fn(() => Promise.reject(new Error('not drawn')));
  mockDecode.mockReturnValue([]);
  expect(await heicToJpeg(photo)).toEqual({ problem: 'not_read' });
  mockDecode.mockImplementation(() => { throw new Error('bad bytes'); });
  expect(await heicToJpeg(photo)).toEqual({ problem: 'not_read' });
  globalThis.createImageBitmap = jest.fn(() => Promise.resolve(bitmap(10, 10)));
  stage([null]);
  expect(await heicToJpeg(photo)).toEqual({ problem: 'not_read' });
});
