import { loadHeicDecoder } from './heicDecoder.web';
import { READ_PICTURE_BYTES } from './setupReadWords';

// An iPhone's HEIC photo as a JPEG, made in the browser (D41, P31): the model reads no HEIC, so the photo is drawn here
// and sent as the JPEG picture the read already takes. Nothing leaves the browser in this step, and the JPEG is drawn
// fresh from the pixels, so it carries none of the photo's metadata. A browser that draws HEIC itself (Safari, so an
// iPhone) does; any other decodes it with libheif-js's JavaScript build (LGPL-3.0, unmodified; no WebAssembly and no
// worker, so the CSP is unchanged), loaded only then: it is about 3 MB. A photo longer than 4,096 pixels on a side is
// drawn smaller, which the model would do anyway and which keeps a 24 megapixel photo inside a phone's canvas.

/** The longest side of the JPEG, in pixels. */
const LONG_SIDE = 4096;
/** The server's cap on a picture's side (api/src/files/limits.ts): a larger one is not decoded in JavaScript. */
const MAX_SIDE = 8000;
/** Tried in order, until the JPEG fits the picture cap. */
const QUALITIES = [0.9, 0.75, 0.6] as const;

export type HeicResult = { jpeg: Blob } | { problem: 'not_read' | 'too_large' };

/** The photo as the browser draws it, when it can. */
async function drawnByBrowser(file: Blob): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

async function drawnByLibheif(file: Blob): Promise<ImageBitmap | 'not_read' | 'too_large'> {
  const { HeifDecoder } = await loadHeicDecoder();
  const images = new HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
  const image = images.find((each) => each.is_primary()) ?? images[0];
  try {
    if (image === undefined) return 'not_read';
    const width = image.get_width();
    const height = image.get_height();
    if (width > MAX_SIDE || height > MAX_SIDE) return 'too_large';
    const pixels = new ImageData(width, height);
    const shown = await new Promise<boolean>((resolve) => { image.display(pixels, (done) => { resolve(done !== null); }); });
    return shown ? await createImageBitmap(pixels) : 'not_read';
  } finally {
    for (const each of images) each.free();
  }
}

function jpegOf(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', quality); });
}

export async function heicToJpeg(file: Blob): Promise<HeicResult> {
  try {
    const drawn = await drawnByBrowser(file) ?? await drawnByLibheif(file);
    if (typeof drawn === 'string') return { problem: drawn };
    const scale = Math.min(1, LONG_SIDE / Math.max(drawn.width, drawn.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(drawn.width * scale));
    canvas.height = Math.max(1, Math.round(drawn.height * scale));
    const context = canvas.getContext('2d');
    if (context === null) return { problem: 'not_read' };
    context.drawImage(drawn, 0, 0, canvas.width, canvas.height);
    drawn.close();
    for (const quality of QUALITIES) {
      const jpeg = await jpegOf(canvas, quality);
      if (jpeg === null) return { problem: 'not_read' };
      if (jpeg.size <= READ_PICTURE_BYTES) return { jpeg };
    }
    return { problem: 'too_large' };
  } catch {
    return { problem: 'not_read' };
  }
}
