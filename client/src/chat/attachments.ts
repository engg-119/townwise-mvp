import type { FileKind } from '../portal/files/api';
import type { AttachmentKind, MessageAttachment } from './api';

// The words for files attached to a TownwiseAI message (spec P25, D36), shared by the composer's chips and the person's
// bubble. TownwiseAI reads a text file (CSV, TSV or text) and a PNG, JPEG, GIF or WebP picture in the turn it is
// attached to; any other kind still attaches, and its chip says TownwiseAI can't read that kind yet.

/** Files one message can attach (the API's limit, api/src/chat/attachments.ts). */
export const MAX_ATTACHMENTS = 5;
/** The largest picture TownwiseAI reads (api/src/files/limits.ts MODEL_PICTURE_BYTES): a larger one gets no thumbnail. */
export const PICTURE_MAX_BYTES = 3_750_000;

/** A Your data file's ref as the API writes one (api/src/chat/attachments.ts ATTACHMENT_REF). */
const FILE_REF = /^f_[0-9a-f]{24}$/;

/** True for a well-formed file ref: only such a ref becomes an item page's path or a read. */
export function isFileRef(ref: string): boolean {
  return FILE_REF.test(ref);
}

/** What a chip calls a file of each kind. */
export const KIND_WORD: Readonly<Record<AttachmentKind, string>> = {
  text: 'Text file', picture: 'Picture', pdf: 'PDF', word: 'Word file', excel: 'Excel file', zip: 'ZIP file', file: 'File',
};

const KIND_PLURAL: Readonly<Record<AttachmentKind, string>> = {
  text: 'text files', picture: 'pictures', pdf: 'PDFs', word: 'Word files', excel: 'Excel files', zip: 'ZIP files', file: 'this kind of file',
};

/** A kind TownwiseAI reads in the turn it is attached to. */
export function readable(kind: AttachmentKind): boolean {
  return kind === 'text' || kind === 'picture';
}

/** “TownwiseAI can’t read PDFs yet”: a composer chip's line for a kind TownwiseAI doesn't read. */
export function unreadLine(kind: AttachmentKind): string {
  return `TownwiseAI can’t read ${KIND_PLURAL[kind]} yet`;
}

// As api/src/files/sniff.ts kindOfName reads a name, with the pictures the item page shows (viewer/kinds.ts).
const TEXT = new Set(['csv', 'tsv', 'txt', 'text', 'tab', '']);
const PICTURES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const BY_FILE_KIND: Readonly<Record<FileKind, AttachmentKind>> = {
  text: 'text', xlsx: 'excel', xls: 'excel', pdf: 'pdf', docx: 'word', doc: 'word', zip: 'zip', other: 'file',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * A file's kind as a chip names it: from the stored file's kind once it is uploaded, else from its name. A picture is
 * a file of kind `other` named like one (the server reads its bytes, so a chip's word is only the client's guess).
 */
export function kindOfFile(name: string, fileKind: FileKind | null): AttachmentKind {
  const extension = extensionOf(name);
  const kind = fileKind === null ? null : BY_FILE_KIND[fileKind];
  if (kind !== null && kind !== 'file') return kind;
  if (PICTURES.has(extension)) return 'picture';
  if (kind === 'file') return 'file';
  if (TEXT.has(extension)) return 'text';
  if (extension === 'xlsx' || extension === 'xlsm' || extension === 'xls') return 'excel';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'docx' || extension === 'doc') return 'word';
  if (extension === 'zip') return 'zip';
  return 'file';
}

/** A bubble chip's words: its title (the name, or the kind under view-as and once the file is gone) and the line under it. */
export function chipWords(attachment: MessageAttachment): { title: string; line: string | null } {
  const kind = KIND_WORD[attachment.kind];
  const state = attachment.state === 'off' ? 'Turned off on Your data' : attachment.state === 'gone' ? 'No longer on Your data' : null;
  if (attachment.name === null) return { title: kind, line: state };
  return { title: attachment.name, line: state === null ? kind : `${kind}. ${state}` };
}
