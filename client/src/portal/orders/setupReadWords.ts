import { ApiError } from '../../api/client';
import { errorCopy, tooManyAttempts } from '../errors';
import type { SetupReadSource } from './api';
import type { ReadFrom } from './proposal';

// Reading the ordering setup with TownwiseAI on the web (D41, P31; SetupRead.web.tsx): which files it takes, the caps
// the browser checks before anything is sent (the server's, api/src/files/limits.ts), the section's words and each
// refusal's. The kind sent is the word for the file's extension; the server tells the real kind by the bytes. The file's
// name never leaves the browser.

type FileKind = Extract<SetupReadSource, { type: 'file' }>['kind'];

const KINDS: Readonly<Record<string, FileKind>> = {
  pdf: 'pdf', xlsx: 'xlsx', docx: 'docx', csv: 'text', tsv: 'text', txt: 'text', png: 'picture', jpg: 'picture', jpeg: 'picture',
  gif: 'picture', webp: 'picture',
  // An iPhone's photo: the browser turns it into a JPEG before it is sent (heic.web.ts).
  heic: 'picture', heif: 'picture',
  // Text under another name: the server reads each as the text it is.
  md: 'text', json: 'text', rtf: 'text', xml: 'text',
};

/** Kinds TownwiseAI can't read, each with the way to one it can. */
const OTHER_FORMAT: Readonly<Record<string, string>> = {
  xls: 'TownwiseAI can’t read old Excel files (.xls). Save it as .xlsx and choose it again.',
  doc: 'TownwiseAI can’t read old Word files (.doc). Save it as .docx and choose it again.',
  zip: 'TownwiseAI reads one file at a time, not a ZIP. Choose a file from inside it.',
  numbers: 'TownwiseAI can’t read Numbers files. Export it as CSV or Excel and choose it again.',
  tif: 'TownwiseAI can’t read TIFF pictures. Save it as a PNG or JPEG and choose it again.',
  tiff: 'TownwiseAI can’t read TIFF pictures. Save it as a PNG or JPEG and choose it again.',
  pages: 'TownwiseAI can’t read Pages files. Export it as PDF or Word and choose it again.',
  odt: 'TownwiseAI can’t read OpenDocument files. Save it as Word (.docx) or PDF and choose it again.',
  ods: 'TownwiseAI can’t read OpenDocument files. Save it as Excel (.xlsx) or CSV and choose it again.',
  // A saved email carries its headers (who sent and received it) and its attachments as code, and a saved page mostly markup.
  eml: 'TownwiseAI can’t read saved emails. Paste the email’s text, or choose the file attached to it.',
  msg: 'TownwiseAI can’t read saved emails. Paste the email’s text, or choose the file attached to it.',
  html: 'TownwiseAI can’t read saved web pages. Paste the page’s text, or save the page as a PDF and choose that.',
  htm: 'TownwiseAI can’t read saved web pages. Paste the page’s text, or save the page as a PDF and choose that.',
};

export const READ_ACCEPT = Object.keys(KINDS).map((extension) => `.${extension}`).join(',');

/** 5 MiB a file and 3,750,000 bytes a picture, as the server takes them. */
export const READ_FILE_BYTES = 5 * 1024 * 1024;
export const READ_PICTURE_BYTES = 3_750_000;

export const READ_COPY = {
  heading: 'Read a file with TownwiseAI',
  lead: 'Drop or choose a file, such as an order guide, an invoice, a price list or a register export, or paste text, and '
    + 'TownwiseAI suggests the suppliers and items it finds. Pressing Read sends it once to Anthropic’s Claude, with the '
    + 'names of the suppliers and items already here; Townwise doesn’t keep it. TownwiseAI never sets a par or never run '
    + 'out, and nothing saves until you save the setup.',
  register: 'A register export read this way sends its item names and quantities to Anthropic. The item sales upload below '
    + 'reads an export in your browser and never sends them.',
  privacy: 'How Townwise handles your data',
  privacyHref: '/privacy',
  drop: 'Drop a file here, or choose one: a PDF, an Excel (.xlsx) or Word (.docx) file, a CSV or text file, or a picture.',
  dropOver: 'Drop the file to choose it.',
  choose: 'Choose a file',
  remove: 'Remove the file',
  readFile: 'Read the file',
  pasteLabel: 'Or paste text',
  pasteHelp: 'Such as an email from a rep or a delivery schedule.',
  readText: 'Read the text',
  cancel: 'Cancel',
  stopped: 'Stopped. Nothing was added to the setup.',
  oneFile: 'TownwiseAI reads one file at a time. Choose just one.',
  notRead: 'Townwise couldn’t open that file in your browser. Choose it again.',
  heicNotRead: 'Townwise couldn’t open that HEIC photo in your browser. Save it as a JPEG, or take a screenshot of it, and choose that.',
  heicLarge: 'That photo is more than TownwiseAI reads once it is a JPEG: up to 3.75 MB and 8,000 pixels a side. Save a smaller copy and choose it again.',
  link: 'TownwiseAI can’t open links. Download the sheet or page as a file and choose it, or paste what it says.',
} as const;

export function readingLine(from: ReadFrom): string {
  return `TownwiseAI is reading the ${from}. This can take up to three minutes.`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

const HEIC: ReadonlySet<string> = new Set(['heic', 'heif']);

/**
 * The kind to send for `file`, from its extension, or why the browser refuses it before anything is sent. A HEIC photo
 * (`heic`) is turned into a JPEG first: it may be as large as any file, and the picture cap is checked on the JPEG.
 */
export function readKindOf(file: { name: string; size: number }): { kind: FileKind; heic: boolean } | { problem: string } {
  const extension = extensionOf(file.name);
  const kind = KINDS[extension];
  if (kind === undefined) {
    const other = OTHER_FORMAT[extension];
    if (other !== undefined) return { problem: other };
    return { problem: 'TownwiseAI can’t read this kind of file. It reads PDFs, Excel (.xlsx) and Word (.docx) files, CSV and text files, and PNG, JPEG, GIF, WebP or HEIC pictures. You can also paste the text.' };
  }
  if (file.size === 0) return { problem: 'That file is empty.' };
  const heic = HEIC.has(extension);
  if (kind === 'picture' && !heic && file.size > READ_PICTURE_BYTES) {
    return { problem: 'That picture is larger than 3.75 MB, the most TownwiseAI reads. Save a smaller copy and choose it again.' };
  }
  if (file.size > READ_FILE_BYTES) return { problem: 'That file is larger than 5 MB, the most TownwiseAI reads at once.' };
  return { kind, heic };
}

/** True for pasted text that is only web addresses: TownwiseAI reads what is sent and opens nothing. */
export function onlyLinks(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.every((word) => /^https?:\/\/\S+$/i.test(word));
}

const REFUSED: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  400: {
    extract_too_large: 'That’s more than TownwiseAI reads: a file of up to 5 MB, a PDF of up to 30 pages, and a picture of up to 3.75 MB and 8,000 pixels a side.',
    extract_kind_not_read: 'TownwiseAI can’t read this kind of file. It reads PDFs, Excel (.xlsx) and Word (.docx) files, CSV and text files, and pictures.',
    extract_kind_mismatch: 'That file isn’t the kind its name says. Save it again in its own format and choose it again.',
    // An old Excel or Word file renamed .xlsx or .docx answers this too: it has the container a password-protected one has.
    extract_encrypted: 'That file has a password, or it’s an old Excel (.xls) or Word (.doc) file. Save a copy without a password, or as .xlsx or .docx, and choose it again.',
    extract_not_readable: 'TownwiseAI couldn’t open that file, so it may be damaged. Save it again and choose it again.',
    extract_empty: 'There’s no text in that for TownwiseAI to read.',
    invalid_request: 'Townwise couldn’t send that. Reload the page and try again.',
  },
  409: { files_ai_budget_exhausted: 'Your organization’s TownwiseAI budget for reading files is spent for this month.' },
  413: { payload_too_large: 'That’s more than TownwiseAI reads at once. Choose a smaller file or paste less text.' },
  422: {
    extract_refused: 'TownwiseAI declined to read this.',
    extract_answer_too_long: 'TownwiseAI couldn’t finish: what it found was too long to write down. Try a shorter file, such as one supplier’s order guide.',
    extract_invalid_answer: 'TownwiseAI’s answer couldn’t be read. Try again.',
  },
  503: {
    ai_unavailable: 'TownwiseAI can’t read files right now. Try again later.',
    extract_busy: 'TownwiseAI is reading other files right now. Try again in a moment.',
    extract_failed: 'TownwiseAI couldn’t finish reading this. Try again in a minute.',
    extract_timed_out: 'TownwiseAI took too long to read this. Try a shorter file, or paste part of it.',
  },
};

/** Why a read failed, in words: this route's codes, a timeout, then the shared copy. */
export function readError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'timeout') return 'TownwiseAI took too long to answer. Try again, or try a shorter file or less text.';
    if (error.kind === 'http' && error.status === 429) {
      return tooManyAttempts(error.retryAfterSeconds).replace('Too many attempts.', 'TownwiseAI has read as much as it can for now.');
    }
    if (error.kind === 'http' && error.code !== null) {
      const words = REFUSED[error.status]?.[error.code];
      if (words !== undefined) return words;
    }
  }
  return errorCopy(error);
}
