// The model's input for a TownwiseAI read, from a file's bytes: reading with TownwiseAI (spec 11A.9, D34, a stored file
// read from storage as far as it needs) and reading the ordering setup (D39, a file sent in the request and never
// stored) share it, each within its own caps. A PDF is sent whole as a document (its own text, made in the AI text
// thread, kept only to check the answer against), a workbook or Word document as its text from that thread, a text
// file as its first characters, a ZIP (D34 only) as its entries' text, and a PNG, JPEG, GIF or WebP picture, told by
// its bytes whatever its name or kind, as an image: for D39 without its metadata and within the model's pixel cap. A
// file's name is read only for its extension and never leaves this file. Nothing here logs.
import type { FileKind } from '../../stores/files.ts';
import {
  AI_IMAGE_BYTES, AI_PDF_BYTES, AI_PDF_PAGES, AI_SOURCE_CHARS, AI_TEXT_CHARS, AI_TEXT_READ_BYTES, AI_ZIP_BYTES, CHAT_SLOT_WAIT_MS,
  CHAT_TEXT_TIME_MS, DOCX_READ_BYTES, HEAD_BYTES, MODEL_PICTURE_BYTES, MODEL_PICTURE_MAX_SIDE, SETUP_FILE_BYTES, SETUP_PDF_PAGES,
  SETUP_TEXT_CHARS, XLSX_READ_BYTES,
} from '../limits.ts';
import { capText, extractAiText, textFileText, type AiTextInput, type AiTextKind, type AiTextOutcome } from '../parse/ai-text.ts';
import { pictureSize, withoutMetadata } from '../picture.ts';
import { sniff } from '../sniff.ts';
import type { ImageMediaType, ReaderInput } from './reader.ts';

/**
 * Why a file is not sent: over the size or page caps (or, for D39, a picture over the pixel cap); a kind not read (old
 * Excel or Word, Numbers, anything else that is not a picture, or a ZIP with no entry read as text); encrypted; its text
 * ran past the thread's limits; or it could not be opened (for D39, a picture whose bytes don't parse as their type).
 */
export type InputRefusal = 'too_large' | 'kind_not_read' | 'encrypted' | 'too_complex' | 'not_readable';

/** `sourceText` is what the answer is checked against (null for a picture); `pages` a PDF's, to reserve its cost by. */
export type PreparedInput =
  | { readonly kind: 'skip'; readonly reason: InputRefusal }
  | {
    readonly kind: 'input'; readonly input: ReaderInput; readonly sourceText: string | null; readonly partial: boolean;
    readonly pages: number | null;
  };

/** A file to send: its kind (sniff.ts), its size, its name (for its extension only) and a way to read its bytes. */
export interface InputSource {
  readonly kind: FileKind;
  readonly sizeBytes: number;
  readonly name: string;
  /** Its first `count` bytes, or all of them. */
  read(count?: number): Promise<Buffer>;
}

export interface InputCaps {
  readonly pdfBytes: number;
  readonly pdfPages: number;
  /** Text sent: the most characters, and how much of a text file is read for them (4 bytes a character at most). */
  readonly textChars: number;
  readonly textReadBytes: number;
  /** The most of a PDF's own text kept to check the answer against. */
  readonly sourceChars: number;
  readonly xlsxBytes: number;
  readonly docxBytes: number;
  /** Null: a ZIP is not read. */
  readonly zipBytes: number | null;
  readonly pictureBytes: number;
  /** Null sends a picture byte for byte; else its metadata is dropped and one larger on a side is refused. */
  readonly pictureMaxSide: number | null;
  /** The AI text thread: how long to wait for its slot (absent: as long as it takes) and its time limit. */
  readonly slotWaitMs?: number;
  readonly textTimeMs?: number;
}

/** Reading with TownwiseAI (limits.ts, spec 11A.9). */
export const READER_INPUT: InputCaps = {
  pdfBytes: AI_PDF_BYTES, pdfPages: AI_PDF_PAGES, textChars: AI_TEXT_CHARS, textReadBytes: AI_TEXT_READ_BYTES, sourceChars: AI_SOURCE_CHARS,
  xlsxBytes: XLSX_READ_BYTES, docxBytes: DOCX_READ_BYTES, zipBytes: AI_ZIP_BYTES, pictureBytes: AI_IMAGE_BYTES, pictureMaxSide: null,
};

/** Reading the ordering setup (limits.ts, spec D39): within the request's time, so the thread waits as a chat read's does. */
export const SETUP_INPUT: InputCaps = {
  pdfBytes: SETUP_FILE_BYTES, pdfPages: SETUP_PDF_PAGES, textChars: SETUP_TEXT_CHARS, textReadBytes: SETUP_TEXT_CHARS * 4,
  sourceChars: AI_SOURCE_CHARS, xlsxBytes: SETUP_FILE_BYTES, docxBytes: SETUP_FILE_BYTES, zipBytes: null, pictureBytes: MODEL_PICTURE_BYTES,
  pictureMaxSide: MODEL_PICTURE_MAX_SIDE, slotWaitMs: CHAT_SLOT_WAIT_MS, textTimeMs: CHAT_TEXT_TIME_MS,
};

/** A PNG, JPEG, GIF or WebP picture, by its first bytes whatever its name or kind, or null. */
export function pictureType(head: Uint8Array): ImageMediaType | null {
  const starts = (bytes: readonly number[], at = 0): boolean => bytes.every((byte, index) => head[at + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

const skip = (reason: InputRefusal): PreparedInput => ({ kind: 'skip', reason });

/** A picture as sent within `maxSide` pixels a side, without its metadata (picture.ts), or why not. */
function cleanPicture(bytes: Buffer, type: ImageMediaType, maxSide: number): Buffer | InputRefusal {
  const size = pictureSize(bytes, type);
  if (size === null) return 'not_readable';
  if (size.width > maxSide || size.height > maxSide) return 'too_large';
  return withoutMetadata(bytes, type) ?? 'not_readable';
}

/**
 * The model's input from `source`, the text to check the answer against, and whether the input was cut. A failed read
 * of the bytes rejects (a stored original that is gone, BlobMissingError), as does a thread that failed or, with
 * `slotWaitMs`, a wait for its slot past it (SlotBusy).
 */
export async function prepareInput(
  source: InputSource, caps: InputCaps, extractText: (input: AiTextInput) => Promise<AiTextOutcome> = extractAiText,
): Promise<PreparedInput> {
  const head = await source.read(Math.min(HEAD_BYTES, source.sizeBytes));
  const picture = pictureType(head);
  if (picture !== null) {
    if (source.sizeBytes > caps.pictureBytes) return skip('too_large');
    const bytes = source.sizeBytes <= head.length ? head : await source.read();
    const sent = caps.pictureMaxSide === null ? bytes : cleanPicture(bytes, picture, caps.pictureMaxSide);
    if (typeof sent === 'string') return skip(sent);
    return { kind: 'input', input: { type: 'image', mediaType: picture, base64: sent.toString('base64') }, sourceText: null, partial: false, pages: null };
  }
  const thread = (kind: AiTextKind, bytes: Buffer, maxChars: number): Promise<AiTextOutcome> => extractText({
    kind, bytes, maxChars,
    ...(caps.textTimeMs === undefined ? {} : { timeMs: caps.textTimeMs }), ...(caps.slotWaitMs === undefined ? {} : { waitMs: caps.slotWaitMs }),
  });
  switch (source.kind) {
    case 'pdf': {
      if (source.sizeBytes > caps.pdfBytes) return skip('too_large');
      const bytes = await source.read();
      const text = await thread('pdf', bytes, caps.sourceChars);
      if (text.kind === 'kept') return skip(text.outcome);
      if (text.pages !== null && text.pages > caps.pdfPages) return skip('too_large');
      // Sent whole as a document (a scanned PDF too: its text is then empty); its text is only checked against.
      return { kind: 'input', input: { type: 'pdf', base64: bytes.toString('base64') }, sourceText: text.text, partial: false, pages: text.pages };
    }
    case 'text': {
      const count = Math.min(source.sizeBytes, caps.textReadBytes);
      const { text, cut } = textFileText(await source.read(count), source.sizeBytes > count, caps.textChars);
      return { kind: 'input', input: { type: 'text', form: 'text', text, cut }, sourceText: text, partial: cut, pages: null };
    }
    case 'xlsx':
    case 'docx': {
      if (source.sizeBytes > (source.kind === 'xlsx' ? caps.xlsxBytes : caps.docxBytes)) return skip('too_large');
      const made = await thread(source.kind, await source.read(), caps.textChars);
      if (made.kind === 'kept') return skip(made.outcome);
      const input: ReaderInput = { type: 'text', form: source.kind === 'xlsx' ? 'workbook' : 'word', text: made.text, cut: made.cut };
      return { kind: 'input', input, sourceText: made.text, partial: made.cut, pages: null };
    }
    case 'other':
      // The name is read here only for its extension (a password-protected Office file).
      return skip(sniff(source.name, head).outcome === 'encrypted' ? 'encrypted' : 'kind_not_read');
    case 'zip': {
      // Its entries as text, labelled by their place, never their path (parse/archive.ts readArchiveText).
      if (caps.zipBytes === null) return skip('kind_not_read');
      if (source.sizeBytes > caps.zipBytes) return skip('too_large');
      const made = await thread('zip', await source.read(), caps.textChars);
      if (made.kind === 'kept') return skip(made.outcome);
      const input: ReaderInput = { type: 'text', form: 'archive', text: made.text, cut: made.cut, skipped: made.skipped ?? 0 };
      return { kind: 'input', input, sourceText: made.source ?? made.text, partial: made.cut, pages: null };
    }
    case 'xls':
    case 'doc':
      return skip('kind_not_read');
  }
}

/** Text a person pasted (D39): its first `textChars` characters, said to be cut past them. */
export function pastedInput(text: string, caps: InputCaps): PreparedInput {
  const capped = capText(text, caps.textChars);
  return { kind: 'input', input: { type: 'text', form: 'text', text: capped.text, cut: capped.cut }, sourceText: capped.text, partial: capped.cut, pages: null };
}

/** What a member says a file posted to Ordering setup is, from its extension (D39). */
export const POSTED_KINDS = ['pdf', 'xlsx', 'docx', 'text', 'picture'] as const;
export type PostedKind = (typeof POSTED_KINDS)[number];

/** A name with the extension each posted kind has, for sniff (the file's own name never reaches the server). */
const POSTED_NAMES: Readonly<Record<PostedKind, string>> = {
  pdf: 'file.pdf', xlsx: 'file.xlsx', docx: 'file.docx', text: 'file.txt', picture: 'file.png',
};

/**
 * The kind to read a file posted as `claimed` as, from its first bytes (sniff.ts, as a stored file's kind is told), or
 * why it is refused: `kind_not_read` for a ZIP that is not the workbook or Word document it says it is, an old Excel
 * or Word file, or a picture of a kind the model does not read (HEIC); `encrypted` for a password-protected workbook or
 * Word document; `mismatch` for bytes of another kind than the one claimed (a PDF posted as a workbook, a binary file as
 * text). A picture is `other`, which prepareInput reads by its bytes.
 */
function postedKind(claimed: PostedKind, head: Uint8Array): FileKind | 'kind_not_read' | 'encrypted' | 'mismatch' {
  const sniffed = sniff(POSTED_NAMES[claimed], head.subarray(0, HEAD_BYTES));
  switch (sniffed.kind) {
    case 'pdf':
      return claimed === 'pdf' ? 'pdf' : 'mismatch';
    case 'xlsx':
    case 'docx':
    case 'text':
      // Only the extension claimed makes these.
      return sniffed.kind;
    case 'zip':
    case 'xls':
    case 'doc':
      return 'kind_not_read';
    case 'other':
      if (sniffed.outcome === 'encrypted') return 'encrypted';
      if (sniffed.outcome === 'image') return pictureType(head) === null ? 'kind_not_read' : claimed === 'picture' ? 'other' : 'mismatch';
      return 'mismatch';
  }
}

/** A file posted to Ordering setup as `claimed` (D39), held in memory, as prepareInput reads it; or why it is refused (postedKind). */
export function postedSource(claimed: PostedKind, bytes: Buffer): InputSource | 'kind_not_read' | 'encrypted' | 'mismatch' {
  const kind = postedKind(claimed, bytes);
  if (kind === 'kind_not_read' || kind === 'encrypted' || kind === 'mismatch') return kind;
  return {
    kind, sizeBytes: bytes.length, name: POSTED_NAMES[claimed],
    read: (count) => Promise.resolve(count === undefined ? bytes : bytes.subarray(0, count)),
  };
}
