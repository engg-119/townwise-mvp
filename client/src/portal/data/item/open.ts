import type { FileKind } from '../../files/api';
import { readDocument, type DocBlock } from '../../viewer/docx';
import { sniffImage, viewerFor, type ViewerKind } from '../../viewer/kinds';
import { VIEW_LIMITS } from '../../viewer/limits';
import { decodeText, parseDelimited, type Delimited, type Delimiter, type TextEncoding } from '../../viewer/text';
import { cellText, readWorkbook, TIME_ONLY_DAYS, type Cell, type Workbook } from '../../viewer/xlsx';
import type { DataItem } from '../api';

// What an item's page does with a stored file on web (P27): whether it fetches one (the original, or a sales file's
// cleaned copy) and with which viewer, or why not; and the fetched bytes opened as the model a viewer draws. The
// readers are in src/portal/viewer/; this only picks one and keeps what it read next to the bytes, so an editor can
// take the same model later. Imported only by .web files.

/** The original, or a sales file's cleaned copy (date,guests,net_sales). */
export type Which = 'raw' | 'clean';

export type Shown = Exclude<ViewerKind, 'none'>;

/** Why the page fetches nothing, in the order the page checks. */
export type Blocked =
  | { why: 'view_as' }
  | { why: 'files_off' }
  | { why: 'uploading' }
  | { why: 'raw_gone' }
  | { why: 'kind'; kind: FileKind }
  | { why: 'not_allowed' }
  | { why: 'too_large'; sizeBytes: number };

export type Plan = { fetch: Which; viewer: Shown; sizeBytes: number | null } | { blocked: Blocked };

/**
 * Whether to fetch the file and how to show it. Nothing opens under view-as, with stored files off (the API then sends
 * no file), while it is uploading, or once its original is gone; a kind no viewer draws is never fetched; the original
 * is fetched only for the people who may download it and only up to VIEW_LIMITS.originalBytes.
 */
export function planFor(item: DataItem, which: Which, viewAs: boolean): Plan {
  if (viewAs) return { blocked: { why: 'view_as' } };
  const { file } = item;
  if (file === null) return { blocked: { why: 'files_off' } };
  if (item.state === 'uploading') return { blocked: { why: 'uploading' } };
  if (which === 'clean') {
    return file.hasClean && file.canDownloadClean ? { fetch: 'clean', viewer: 'delimited', sizeBytes: null } : { blocked: { why: 'not_allowed' } };
  }
  if (!file.rawAvailable) return { blocked: { why: 'raw_gone' } };
  const kind: FileKind = item.kind === 'daily_totals' ? 'other' : item.kind;
  const viewer = viewerFor(kind, item.name);
  if (viewer === 'none') return { blocked: { why: 'kind', kind } };
  if (!file.canDownloadRaw) return { blocked: { why: 'not_allowed' } };
  const sizeBytes = item.sizeBytes ?? 0;
  if (sizeBytes > VIEW_LIMITS.originalBytes) return { blocked: { why: 'too_large', sizeBytes } };
  return { fetch: 'raw', viewer, sizeBytes };
}

export type ImageType = NonNullable<ReturnType<typeof sniffImage>>;

/**
 * A fetched file as its viewer draws it, with the bytes it came from. Text keeps its encoding and whether it began with
 * a byte-order mark, so it can be written back the way it was read.
 */
export type Opened =
  | { viewer: 'text'; bytes: Uint8Array; text: string; encoding: TextEncoding; bom: boolean }
  | { viewer: 'delimited'; bytes: Uint8Array; table: Delimited; encoding: TextEncoding; bom: boolean }
  | { viewer: 'workbook'; bytes: Uint8Array; workbook: Workbook }
  | { viewer: 'pdf'; bytes: Uint8Array }
  | { viewer: 'document'; bytes: Uint8Array; blocks: DocBlock[]; truncated: boolean }
  /** `type` null: named like a picture, but its bytes are no format the page shows. */
  | { viewer: 'image'; bytes: Uint8Array; type: ImageType | null };

/**
 * Reads `bytes` for `viewer`; a CSV or TSV by `delimiter` (kinds.ts delimiterFor), or the one its first line uses most.
 * Throws the readers' ViewerError for a workbook or document it can't read.
 */
export async function openBytes(viewer: Shown, bytes: Uint8Array, delimiter?: Delimiter): Promise<Opened> {
  switch (viewer) {
    case 'text':
      return { viewer, bytes, ...decodeText(bytes) };
    case 'delimited': {
      const { text, encoding, bom } = decodeText(bytes);
      return { viewer, bytes, table: parseDelimited(text, delimiter), encoding, bom };
    }
    case 'workbook':
      return { viewer, bytes, workbook: await readWorkbook(bytes) };
    case 'pdf':
      return { viewer, bytes };
    case 'document':
      return { viewer, bytes, ...(await readDocument(bytes)) };
    case 'image':
      return { viewer, bytes, type: sniffImage(bytes) };
  }
}

/** A Blob's bytes, through FileReader (every browser the viewer supports has it, and so does jsdom). */
export function bytesOf(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(new Uint8Array(reader.result as ArrayBuffer)); };
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')); };
    reader.readAsArrayBuffer(blob);
  });
}

/** Resolves after the browser has painted once more, so a line set before a long parse shows first. */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => { requestAnimationFrame(() => { setTimeout(resolve, 0); }); });
}

/** A workbook cell as the grid shows it: cellText, except that a time with no date shows only its time. */
export function shownCell(cell: Cell): string {
  if (cell.t === 'd' && cell.v.length > 10 && TIME_ONLY_DAYS.has(cell.v.slice(0, 10))) return cell.v.slice(11);
  return cellText(cell);
}

/** A sheet's column letters: 0 is A, 25 is Z, 26 is AA. */
export function columnLetters(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** A picture's bytes as a `data:` URL (the CSP's img-src allows data:, not blob:). */
export function dataUrlOf(bytes: Uint8Array, type: ImageType): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}
