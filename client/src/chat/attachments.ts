import type { FileKind } from '../portal/files/api';
import type { AttachmentKind, MessageAttachment } from './api';

// The words for files attached to a TownwiseAI message (spec P25, D36), shared by the composer's chips and the person's
// bubble. TownwiseAI reads a text file (CSV, TSV or text), a calendar file (.ics or .ical, D63), a PNG, JPEG, GIF or
// WebP picture, and a PDF, Word (.docx) or Excel (.xlsx) file as its text in the turn it is attached to; any other kind
// still attaches, and its chip says TownwiseAI can't read it (an old Word or Excel file, what to save it as).

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
  text: 'Text file', picture: 'Picture', pdf: 'PDF', word: 'Word file', excel: 'Excel file', zip: 'ZIP file', calendar: 'Calendar file',
  file: 'File',
};

/** Old Word and Excel files, which TownwiseAI doesn't read: their extension, and the one to save them as. */
const OLD_OFFICE = { word: ['doc', 'docx'], excel: ['xls', 'xlsx'] } as const;

/**
 * A file TownwiseAI reads in the turn it is attached to: a text or calendar file, a picture, a PDF, or a Word or Excel
 * file that isn't an old one (.doc, .xls). The server takes a file for an old one only by that extension
 * (api/src/files/sniff.ts), so the name tells.
 */
export function readable(kind: AttachmentKind, name: string): boolean {
  if (kind === 'word' || kind === 'excel') return extensionOf(name) !== OLD_OFFICE[kind][0];
  return kind === 'text' || kind === 'calendar' || kind === 'picture' || kind === 'pdf';
}

/**
 * A composer chip's line for a file TownwiseAI doesn't read: “TownwiseAI can’t read ZIP files yet”, or for an old Word
 * or Excel file what to save it as.
 */
export function unreadLine(kind: AttachmentKind): string {
  if (kind === 'word' || kind === 'excel') {
    const [old, current] = OLD_OFFICE[kind];
    return `TownwiseAI can’t read .${old} files; save it as .${current}`;
  }
  return kind === 'zip' ? 'TownwiseAI can’t read ZIP files yet' : 'TownwiseAI can’t read this kind of file yet';
}

// As api/src/files/sniff.ts kindOfName reads a name, with the pictures the item page shows (viewer/kinds.ts).
const TEXT = new Set(['csv', 'tsv', 'txt', 'text', 'tab', '']);
const PICTURES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/** D63: a calendar file, which the server stores as `other` and reads as text (api/src/files/sniff.ts isCalendarFileName). */
const CALENDARS = new Set(['ics', 'ical']);
const BY_FILE_KIND: Readonly<Record<FileKind, AttachmentKind>> = {
  text: 'text', xlsx: 'excel', xls: 'excel', pdf: 'pdf', docx: 'word', doc: 'word', zip: 'zip', other: 'file',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * A file's kind as a chip names it: from the stored file's kind once it is uploaded, else from its name. A picture is
 * a file of kind `other` named like one (the server reads its bytes, so a chip's word is only the client's guess), and
 * a calendar file one named .ics or .ical, as the server names it.
 */
export function kindOfFile(name: string, fileKind: FileKind | null): AttachmentKind {
  const extension = extensionOf(name);
  const kind = fileKind === null ? null : BY_FILE_KIND[fileKind];
  if (kind !== null && kind !== 'file') return kind;
  if (PICTURES.has(extension)) return 'picture';
  if (CALENDARS.has(extension)) return 'calendar';
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
