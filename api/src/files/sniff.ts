// A stored file's kind, from its name's extension and its first bytes (spec 11A). No file is refused for its type:
// a kind Townwise cannot read is kept, with the outcome that says why. The browser's MIME type is never read.
import type { FileKind } from '../stores/files.ts';

/** Why a file of this kind is kept without being read, or null when the reader opens it. */
export type KindOutcome = 'old_excel' | 'old_word' | 'numbers' | 'encrypted' | 'image' | 'type_not_read';

export interface Sniffed {
  readonly kind: FileKind;
  readonly outcome: KindOutcome | null;
}

const TEXT_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'text', 'tab', '']);

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function startsWith(head: Uint8Array, bytes: readonly number[], at = 0): boolean {
  if (head.length < at + bytes.length) return false;
  return bytes.every((byte, index) => head[at + index] === byte);
}

function isPdf(head: Uint8Array): boolean {
  return Buffer.from(head.subarray(0, 1024)).includes('%PDF-', 0, 'latin1');
}

const ZIP = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]] as const;
const OLE = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** A picture TownwiseAI's model can read (spec D36). */
export type PictureType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const PICTURES: readonly (readonly [readonly number[], PictureType])[] = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
];

/** The picture type of a file whose first bytes are `head` (12 are enough): PNG, JPEG, GIF or WebP, else null. */
export function pictureType(head: Uint8Array): PictureType | null {
  const found = PICTURES.find(([signature]) => startsWith(head, signature));
  if (found !== undefined) return found[1];
  // WebP: RIFF....WEBP.
  return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8) ? 'image/webp' : null;
}

function isImage(head: Uint8Array): boolean {
  if (pictureType(head) !== null) return true;
  // HEIC: ....ftypheic (or mif1, heix).
  const brand = Buffer.from(head.subarray(4, 12)).toString('latin1');
  return brand === 'ftypheic' || brand === 'ftypheix' || brand === 'ftypmif1';
}

function isUtf16(head: Uint8Array): boolean {
  return startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff]);
}

/** The kind of a file named `name` whose first bytes are `head` (up to 8 KiB). */
export function sniff(name: string, head: Uint8Array): Sniffed {
  const extension = extensionOf(name);
  if (isPdf(head)) return { kind: 'pdf', outcome: null };
  if (ZIP.some((signature) => startsWith(head, signature))) {
    if (extension === 'xlsx' || extension === 'xlsm') return { kind: 'xlsx', outcome: null };
    if (extension === 'docx') return { kind: 'docx', outcome: null };
    if (extension === 'numbers') return { kind: 'other', outcome: 'numbers' };
    return { kind: 'zip', outcome: null };
  }
  if (startsWith(head, OLE)) {
    if (extension === 'xls') return { kind: 'xls', outcome: 'old_excel' };
    if (extension === 'doc') return { kind: 'doc', outcome: 'old_word' };
    // A password-protected Office file is an OLE container.
    if (extension === 'xlsx' || extension === 'xlsm' || extension === 'docx') return { kind: 'other', outcome: 'encrypted' };
    return { kind: 'other', outcome: 'type_not_read' };
  }
  if (isImage(head)) return { kind: 'other', outcome: 'image' };
  if (TEXT_EXTENSIONS.has(extension) && (isUtf16(head) || !head.includes(0))) return { kind: 'text', outcome: null };
  return { kind: 'other', outcome: 'type_not_read' };
}

/** The kind a name suggests before any byte arrives (a file's row while it uploads). */
export function kindOfName(name: string): FileKind {
  const extension = extensionOf(name);
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (extension === 'xlsx' || extension === 'xlsm') return 'xlsx';
  if (extension === 'xls') return 'xls';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'docx') return 'docx';
  if (extension === 'doc') return 'doc';
  if (extension === 'zip') return 'zip';
  return 'other';
}

const KIND_LABELS: Readonly<Record<FileKind, string>> = {
  text: 'CSV or text file',
  xlsx: 'Excel file',
  xls: 'Excel file',
  pdf: 'PDF file',
  docx: 'Word file',
  doc: 'Word file',
  zip: 'ZIP file',
  other: 'File',
};

/** What a file is called once its name is gone (view-as, or after its original is deleted). */
export function kindLabel(kind: FileKind): string {
  return KIND_LABELS[kind];
}

/** The original name, as stored: its last path part, control characters removed, NFC, at most 255 characters. */
export function sanitizeName(raw: string): string {
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return base.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').normalize('NFC').trim().slice(0, 255);
}
