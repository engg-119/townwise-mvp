import { READ_PICTURE_BYTES } from './setupReadWords';

// An iPhone's HEIC photo as a JPEG, made in the browser (D41, P31): most browsers can't open HEIC and the model reads
// none, so the photo is decoded here and sent as the JPEG picture the read already takes. Nothing leaves the browser in
// this step, and the JPEG is drawn fresh from the pixels, so it carries none of the photo's metadata. The decoder is
// libheif-js's JavaScript build (LGPL-3.0, unmodified; no WebAssembly and no worker, so the CSP is unchanged), loaded
// only when a HEIC photo is read: it is about 3 MB.

/** The server's cap on a picture's side, in pixels (api/src/files/limits.ts). */
const MAX_SIDE = 8000;
/** Tried in order, until the JPEG fits the picture cap. */
const QUALITIES = [0.9, 0.75, 0.6] as const;

export type HeicResult = { jpeg: Blob } | { problem: 'not_read' | 'too_large' };

function jpegOf(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', quality); });
}

export async function heicToJpeg(file: Blob): Promise<HeicResult> {
  try {
    const { HeifDecoder } = await import('libheif-js');
    const [image] = new HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
    if (image === undefined) return { problem: 'not_read' };
    const width = image.get_width();
    const height = image.get_height();
    if (width > MAX_SIDE || height > MAX_SIDE) return { problem: 'too_large' };
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return { problem: 'not_read' };
    const pixels = context.createImageData(width, height);
    const shown = await new Promise<boolean>((resolve) => { image.display(pixels, (done) => { resolve(done !== null); }); });
    if (!shown) return { problem: 'not_read' };
    context.putImageData(pixels, 0, 0);
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
