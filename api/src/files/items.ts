// Reference items (spec 11A, D28): pasted text kept as a `.txt` stored file, and the one reader TownwiseAI's tools use
// for a text item's words, which also reads a file attached to a message for its turn (D36: text, a picture's bytes
// without its metadata, or a PDF's, Word document's or workbook's text, made in the AI text thread as reading with
// TownwiseAI makes it, parse/ai-text.ts), for the person who added it or an org admin only. The title, the text and a
// picture are never logged or audited. The one log line here, a text thread that failed, carries ids and its error's
// type only, never its message, which could quote the file.
import { createHash } from 'node:crypto';

import type { Logger } from '@ckeith26/server-core';
import { Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { Role } from '../access/resolve.ts';
import { utcDay } from '../dates.ts';
import type { AiSource, FileKind, FileRecord } from '../stores/files.ts';
import type { TownwiseStores } from '../stores/index.ts';
import { BlobMissingError, type FileBlobs } from './blobs.ts';
import {
  AI_PDF_BYTES, CHAT_SLOT_WAIT_MS, CHAT_TEXT_TIME_MS, CHUNK_BYTES, DAILY_UPLOAD_BYTES, DOCX_READ_BYTES, FILES_PER_LOCATION,
  MODEL_PICTURE_BYTES, MODEL_PICTURE_MAX_SIDE, STORED_BYTES_PER_ORG, XLSX_READ_BYTES,
} from './limits.ts';
import { extractAiText, type AiTextInput, type AiTextKind, type AiTextOutcome } from './parse/ai-text.ts';
import { decoderFor, detectEncoding } from './parse/text.ts';
import { SlotBusy } from './parse/thread-slot.ts';
import { pictureSize, withoutMetadata } from './picture.ts';
import { pictureType, sanitizeName, type PictureType } from './sniff.ts';
import { fingerprintOf } from './upload.ts';

export const TEXT_ITEM_MAX_CHARS = 10_000;
export const TEXT_ITEM_TITLE_MAX = 120;
/** What one read takes of an item's bytes, and the most characters it hands back. */
export const READ_ITEM_BYTES = 64 * 1024;
export const READ_ITEM_MAX_CHARS = 20_000;

/**
 * Editing an item: how long a replace's claim on it (`replacedBy`) holds. An older claim, or one with no `replacedAt`,
 * is stale: the call that made it stopped, and the next edit may free it.
 */
export const REPLACE_CLAIM_MS = 2 * 60 * 1000;

/** Whether an edit is being saved over the item now: it is claimed and the claim is not stale. */
export function replaceClaimLive(file: Pick<FileRecord, 'replacedBy' | 'replacedAt'>, now: Date): boolean {
  return file.replacedBy !== null && file.replacedAt !== null && now.getTime() - file.replacedAt.getTime() <= REPLACE_CLAIM_MS;
}

/** The cutoff for the store's rename: a claim made before it is stale (replaceClaimLive). */
export function replaceClaimStaleBefore(now: Date): Date {
  return new Date(now.getTime() - REPLACE_CLAIM_MS);
}

const OBJECT_ID = /^[0-9a-f]{24}$/;

export interface TextItemInput {
  readonly id?: string;
  readonly title: string;
  readonly text: string;
  readonly uploadedBy: string;
  readonly uploaderRole: Role;
  /** D25: staff kept it while open as admin, under this grant, so it reads “Townwise staff”. */
  readonly openAsAdminGrantId?: string;
  readonly addedVia: 'townwise_ai' | null;
  /** A TownwiseAI read's summary item (spec 11A.9): the file it was read from. */
  readonly source?: AiSource;
  /** D59 slice 4: pasted text saved with the box checked, which TownwiseAI then reads on its own. */
  readonly aiAuto?: boolean;
  readonly now: Date;
}

/**
 * A title's words for a name. `sanitizeName` reads a name as a path and keeps what follows the last slash, so a title's
 * slashes (a date such as 12/24) become hyphens first, and it deletes control characters, so a pasted tab or line break
 * becomes a space first ("Lunch menu", not "Lunchmenu"). Empty for a title of nothing else.
 */
function titleWords(title: string): string {
  // eslint-disable-next-line no-control-regex -- a control character inside a title separates words
  return title.replace(/[\\/]/g, '-').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
}

/** The item's name: the title with `.txt` after it. A title of nothing else is named "Pasted text". */
function textItemName(title: string): string {
  const words = titleWords(title);
  return sanitizeName(`${words === '' ? 'Pasted text' : words}.txt`);
}

/**
 * D28, renaming an item: the title's words as a name, with the current name's extension (from its last dot, when that is
 * not its first character) after them, unless they already end with it in any case. Null for a title of nothing else.
 */
export function renamedItemName(current: string, title: string): string | null {
  const words = titleWords(title);
  if (words === '') return null;
  const dot = current.lastIndexOf('.');
  const extension = dot > 0 ? current.slice(dot) : '';
  return sanitizeName(words.toLowerCase().endsWith(extension.toLowerCase()) ? words : `${words}${extension}`);
}

/**
 * Keeps pasted text as a reference item. A retried save with the same `id` answers the stored item and reserves nothing
 * more. Order: caps, the day's reservation, the blob, then the row; a crash after the blob leaves an orphan the daily
 * sweep removes. A failed blob write or row insert gives the day's bytes back before the error goes on, as a canceled
 * upload does, so a retry reserves them once.
 */
export async function saveTextItem(
  stores: TownwiseStores, blobs: Pick<FileBlobs, 'writeRaw'>, scope: OrgScope, locationId: string, input: TextItemInput,
): Promise<{ file: FileRecord; created: boolean } | 'storage_full' | 'daily_upload_limit'> {
  if (input.id !== undefined) {
    const existing = await stores.files.get(scope, locationId, input.id);
    if (existing !== null) return { file: existing, created: false };
  }
  const bytes = Buffer.from(input.text, 'utf8');
  const counts = await stores.files.counts(scope, locationId, null, input.now);
  if (counts.inLocation >= FILES_PER_LOCATION || bytes.length > STORED_BYTES_PER_ORG - await stores.files.storedBytes(scope, input.now)) {
    return 'storage_full';
  }
  const day = utcDay(input.now);
  if (!(await stores.uploadDays.reserve(scope, day, bytes.length, DAILY_UPLOAD_BYTES, input.now))) return 'daily_upload_limit';
  const id = input.id ?? new Types.ObjectId().toHexString();
  let inserted: FileRecord | 'exists';
  try {
    await blobs.writeRaw(scope, { locationId, fileId: id }, bytes, 'text/plain; charset=utf-8');
    inserted = await stores.files.insertStored(scope, locationId, {
      id, uploadedBy: input.uploadedBy, uploaderRole: input.uploaderRole, uploadedAt: input.now,
      ...(input.openAsAdminGrantId === undefined ? {} : { openAsAdminGrantId: input.openAsAdminGrantId }),
      name: textItemName(input.title), sizeBytes: bytes.length,
      fingerprint: fingerprintOf(CHUNK_BYTES, [createHash('sha256').update(bytes).digest('hex')]), addedVia: input.addedVia,
      ...(input.source === undefined ? {} : { source: input.source }), ...(input.aiAuto === true ? { aiAuto: true } : {}),
    });
  } catch (err) {
    await stores.uploadDays.refund(scope, day, bytes.length, input.now);
    throw err;
  }
  if (inserted !== 'exists') return { file: inserted, created: true };
  // A save with the same id got there first and holds its own reservation.
  await stores.uploadDays.refund(scope, day, bytes.length, input.now);
  const raced = await stores.files.get(scope, locationId, id);
  if (raced === null) throw new Error('item id is taken by another location');
  return { file: raced, created: false };
}

export type ItemText =
  | { readonly status: 'ok'; readonly text: string; readonly truncated: boolean }
  | { readonly status: 'files_off' | 'not_found' | 'not_readable' | 'turned_off' | 'gone' };

/** What a file attached to a TownwiseAI message is, in its words (spec D36). A picture is known by its bytes. */
export type AttachmentKind = 'text' | 'picture' | 'pdf' | 'word' | 'excel' | 'zip' | 'file';

/** A stored file's kind as an attachment's; a file of kind `other` is a picture when its bytes say so. */
const ATTACHMENT_KINDS: Readonly<Record<FileKind, AttachmentKind>> = {
  text: 'text', xlsx: 'excel', xls: 'excel', pdf: 'pdf', docx: 'word', doc: 'word', zip: 'zip', other: 'file',
};

/** The kinds TownwiseAI reads as text: a text file, and a PDF, Word (.docx) or Excel (.xlsx) file. */
export type TextKind = 'text' | 'pdf' | 'word' | 'excel';

/** A file attached to a TownwiseAI message, once its bytes are read for the turn (spec D36). */
export type ItemContent =
  /**
   * A text file: its first characters, as readText reads them. A PDF, Word or Excel file: its text as the AI text thread
   * makes it for reading with TownwiseAI (11A.9), at most READ_ITEM_MAX_CHARS, `truncated` when the thread cut it.
   */
  | { readonly status: 'text'; readonly kind: TextKind; readonly text: string; readonly truncated: boolean }
  /** A picture of at most MODEL_PICTURE_BYTES and MODEL_PICTURE_MAX_SIDE pixels a side: its bytes without metadata, base64. */
  | { readonly status: 'picture'; readonly mediaType: PictureType; readonly base64: string }
  /**
   * Not sent after all: its original was deleted since it was checked, a picture whose bytes don't parse as their type,
   * or one over MODEL_PICTURE_MAX_SIDE pixels on a side; or a PDF, Word or Excel file the thread refused (it has a
   * password, it couldn't be opened or its thread failed, its text ran past the thread's limits, or its Word document is
   * too large), or one still waiting for the parse thread after the chat's wait (`busy`).
   */
  | {
    readonly status: 'gone' | 'not_readable' | 'too_many_pixels' | 'encrypted' | 'damaged' | 'too_complex' | 'too_large' | 'busy';
    readonly kind: AttachmentKind;
  }
  /** A PDF, Word or Excel file not read at all: the turn hasn't the time left for the wait for the thread and its run. */
  | { readonly status: 'no_time'; readonly kind: AttachmentKind };

/** A file attached to a TownwiseAI message, as the checks before the turn's claim find it (spec D36). */
export type ItemForModel =
  /**
   * A text file, a picture, or a PDF, Word or Excel file the turn can send: `bytes` is how many of its bytes `read`
   * takes, and `read` reads them, which a turn does only after its claim. Nothing is read before. `by` is when the read
   * must be done (Date.now() milliseconds): a PDF, Word or Excel file is read only while the chat's wait for the parse
   * thread and its thread's time both fit before it, else it is `no_time` and nothing is read.
   */
  | { readonly status: 'readable'; readonly kind: TextKind | 'picture'; readonly bytes: number; read(by: number): Promise<ItemContent> }
  /**
   * Kept on Your data, but not sent: a kind TownwiseAI can't read (old Word or Excel, a ZIP, any other file), a picture,
   * PDF, Word or Excel file too large, turned off, or its original deleted.
   */
  | { readonly status: 'not_readable' | 'too_large' | 'turned_off' | 'gone'; readonly kind: AttachmentKind }
  /**
   * Not a file this person can attach: stored files are off, no such file at this location (or another member's still
   * uploading), a sales file, not kept yet, or one only the person who added it or an org admin may attach.
   */
  | { readonly status: 'files_off' | 'not_found' | 'not_reference' | 'not_ready' | 'not_allowed' };

/**
 * Who attaches a file (spec D36): the same right as downloading its original, so the person who added it or an org
 * admin (staff open as admin act as one).
 */
export interface ItemViewer {
  readonly userId: string;
  readonly role: Role;
}

/** The door TownwiseAI's tools and its turns read an item through (chat/* imports no file code). */
export interface ItemReader {
  readonly on: boolean;
  readText(scope: OrgScope, locationId: string, fileId: string): Promise<ItemText>;
  /**
   * A reference file attached to a message (spec D36): what its record and first bytes say, so a turn can refuse or list
   * it before anything is claimed, and for one it can send, how to read it.
   */
  readForModel(scope: OrgScope, locationId: string, fileId: string, viewer: ItemViewer): Promise<ItemForModel>;
}

async function bytesOf(body: AsyncIterable<unknown>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array));
  return Buffer.concat(parts);
}

/** The first `count` bytes of the file's original. Throws BlobMissingError when it is gone. */
async function rawBytes(blobs: FileBlobs, scope: OrgScope, file: FileRecord, count: number): Promise<Buffer> {
  return bytesOf(await blobs.openRaw(scope, { locationId: file.locationId, fileId: file.id }, { offset: 0, count }));
}

/** A text file's first READ_ITEM_BYTES, decoded, at most READ_ITEM_MAX_CHARS. Throws BlobMissingError when it is gone. */
async function textOf(blobs: FileBlobs, scope: OrgScope, file: FileRecord): Promise<{ text: string; truncated: boolean }> {
  const bytes = await rawBytes(blobs, scope, file, Math.min(file.sizeBytes, READ_ITEM_BYTES));
  // When the item was read whole, a last byte that cannot end a UTF-8 character means windows-1252 (detectEncoding
  // forgives it, because a longer file may continue). A cut item streams, so the character cut at the edge is
  // dropped rather than an error.
  const whole = file.sizeBytes <= READ_ITEM_BYTES;
  let encoding = detectEncoding(bytes);
  if (whole && encoding === 'utf-8') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      encoding = 'windows-1252';
    }
  }
  const decoded = decoderFor(encoding).decode(bytes, { stream: !whole });
  let text = decoded.slice(0, READ_ITEM_MAX_CHARS);
  const last = text.charCodeAt(text.length - 1);
  if (decoded.length > READ_ITEM_MAX_CHARS && last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return { text, truncated: decoded.length > READ_ITEM_MAX_CHARS || file.sizeBytes > READ_ITEM_BYTES };
}

/** Enough of a file's first bytes to tell a picture (pictureType). */
const PICTURE_HEAD_BYTES = 12;

/** A file read as text in the AI text thread, as reading with TownwiseAI reads it (11A.9): its kinds, and its byte cap there. */
interface DocumentKind { readonly kind: Exclude<TextKind, 'text'>; readonly thread: AiTextKind; readonly maxBytes: number }

const DOCUMENTS: Readonly<Partial<Record<FileKind, DocumentKind>>> = {
  pdf: { kind: 'pdf', thread: 'pdf', maxBytes: AI_PDF_BYTES },
  docx: { kind: 'word', thread: 'docx', maxBytes: DOCX_READ_BYTES },
  xlsx: { kind: 'excel', thread: 'xlsx', maxBytes: XLSX_READ_BYTES },
};

/** How long a chat read waits for the parse-thread slot, and its thread's time limit (CHAT_SLOT_WAIT_MS). Tests shorten them. */
export interface ChatReadLimits { readonly slotWaitMs: number; readonly textTimeMs: number }

export interface ItemReaderDeps {
  /** For a text thread that failed: its error's type, never its message. */
  readonly logger: Pick<Logger, 'warn'>;
  /** Tests shorten these, and stand in for the thread. */
  readonly limits?: ChatReadLimits;
  readonly extractText?: (input: AiTextInput) => Promise<AiTextOutcome>;
}

/** How a PDF, Word or Excel file is read for a chat: the thread, its limits, and where a failure is logged. */
interface DocumentReader {
  readonly logger: Pick<Logger, 'warn'>;
  readonly limits: ChatReadLimits;
  readonly extractText: (input: AiTextInput) => Promise<AiTextOutcome>;
}

export function createItemReader(stores: Pick<TownwiseStores, 'files'>, blobs: FileBlobs | null, deps: ItemReaderDeps): ItemReader {
  const documentReader: DocumentReader = {
    logger: deps.logger,
    limits: deps.limits ?? { slotWaitMs: CHAT_SLOT_WAIT_MS, textTimeMs: CHAT_TEXT_TIME_MS },
    extractText: deps.extractText ?? extractAiText,
  };
  return {
    on: blobs !== null,
    async readText(scope, locationId, fileId) {
      if (blobs === null) return { status: 'files_off' };
      if (!OBJECT_ID.test(fileId) || !OBJECT_ID.test(locationId)) return { status: 'not_found' };
      const file = await stores.files.get(scope, locationId, fileId);
      if (file === null || file.status === 'deleting') return { status: 'not_found' };
      if (file.purpose !== 'reference' || file.kind !== 'text' || file.status !== 'kept') return { status: 'not_readable' };
      if (file.disabledAt !== null) return { status: 'turned_off' };
      if (file.rawDeletedAt !== null) return { status: 'gone' };
      try {
        return { status: 'ok', ...await textOf(blobs, scope, file) };
      } catch (err) {
        if (err instanceof BlobMissingError) return { status: 'gone' };
        throw err;
      }
    },
    async readForModel(scope, locationId, fileId, viewer) {
      if (blobs === null) return { status: 'files_off' };
      if (!OBJECT_ID.test(fileId) || !OBJECT_ID.test(locationId)) return { status: 'not_found' };
      const file = await stores.files.get(scope, locationId, fileId);
      if (file === null || file.status === 'deleting') return { status: 'not_found' };
      // The right to download the original (handlers/files.ts isUploaderOrAdmin).
      const allowed = viewer.role === 'org_admin' || viewer.userId === file.uploadedBy;
      // Your data lists a file still uploading only to the person adding it: to anyone else it is no file at all.
      if (!allowed && file.status === 'uploading') return { status: 'not_found' };
      if (file.purpose !== 'reference') return { status: 'not_reference' };
      if (file.status !== 'kept') return { status: 'not_ready' };
      if (!allowed) return { status: 'not_allowed' };
      const kind = ATTACHMENT_KINDS[file.kind];
      // A deleted original never comes back, so it is said before a turned-off item's state.
      if (file.rawDeletedAt !== null) return { status: 'gone', kind };
      if (file.disabledAt !== null) return { status: 'turned_off', kind };
      if (file.kind === 'text') {
        return { status: 'readable', kind: 'text', bytes: Math.min(file.sizeBytes, READ_ITEM_BYTES), read: () => contentOf(blobs, scope, file, null) };
      }
      const document = DOCUMENTS[file.kind];
      if (document !== undefined) {
        if (file.sizeBytes > document.maxBytes) return { status: 'too_large', kind: document.kind };
        return { status: 'readable', kind: document.kind, bytes: file.sizeBytes, read: (by) => documentOf(blobs, scope, file, document, documentReader, by) };
      }
      if (file.kind !== 'other') return { status: 'not_readable', kind };
      let mediaType: PictureType | null;
      try {
        // Known by its bytes, never its name.
        mediaType = pictureType(await rawBytes(blobs, scope, file, Math.min(file.sizeBytes, PICTURE_HEAD_BYTES)));
      } catch (err) {
        if (err instanceof BlobMissingError) return { status: 'gone', kind };
        throw err;
      }
      if (mediaType === null) return { status: 'not_readable', kind };
      if (file.sizeBytes > MODEL_PICTURE_BYTES) return { status: 'too_large', kind: 'picture' };
      const picture = mediaType;
      return { status: 'readable', kind: 'picture', bytes: file.sizeBytes, read: () => contentOf(blobs, scope, file, picture) };
    },
  };
}

/**
 * A picture's bytes as the model gets them: only when its header gives a size within MODEL_PICTURE_MAX_SIDE, and
 * without its metadata (picture.ts).
 */
export function pictureContent(bytes: Uint8Array, mediaType: PictureType): ItemContent {
  const size = pictureSize(bytes, mediaType);
  if (size === null) return { status: 'not_readable', kind: 'picture' };
  if (size.width > MODEL_PICTURE_MAX_SIDE || size.height > MODEL_PICTURE_MAX_SIDE) return { status: 'too_many_pixels', kind: 'picture' };
  const clean = withoutMetadata(bytes, mediaType);
  return clean === null ? { status: 'not_readable', kind: 'picture' } : { status: 'picture', mediaType, base64: clean.toString('base64') };
}

/** A checked file's content: a text file's first characters (`picture` null), or a picture's. Its original deleted since is gone. */
async function contentOf(blobs: FileBlobs, scope: OrgScope, file: FileRecord, picture: PictureType | null): Promise<ItemContent> {
  try {
    if (picture === null) return { status: 'text', kind: 'text', ...await textOf(blobs, scope, file) };
    return pictureContent(await rawBytes(blobs, scope, file, file.sizeBytes), picture);
  } catch (err) {
    if (err instanceof BlobMissingError) return { status: 'gone', kind: picture === null ? 'text' : 'picture' };
    throw err;
  }
}

/** What a PDF, Word or Excel file the thread refused is listed as. Only a ZIP is ever `kind_not_read`, so none of these is. */
const KEPT = {
  encrypted: 'encrypted', not_readable: 'damaged', too_complex: 'too_complex', too_large: 'too_large', kind_not_read: 'not_readable',
} as const satisfies Readonly<Record<Extract<AiTextOutcome, { kind: 'kept' }>['outcome'], ItemContent['status']>>;

/**
 * A PDF, Word or Excel file's text, made in the AI text thread within the chat's limits: its first READ_ITEM_MAX_CHARS
 * characters, or why it isn't sent. Nothing is read when the wait for the thread and the thread's time don't both fit
 * before `by` (`no_time`). Its original deleted since is gone, and a wait for the thread past the chat's is `busy`
 * (that thread never runs). Any other failure of the thread is `damaged`, logged by its error's type only: a parser's
 * message could quote the file, and a send that fails for it would fail on every retry. A failed read of the original
 * itself still rejects, as any store failure does.
 */
async function documentOf(
  blobs: FileBlobs, scope: OrgScope, file: FileRecord, document: DocumentKind, reader: DocumentReader, by: number,
): Promise<ItemContent> {
  const { kind } = document;
  const { limits } = reader;
  if (by - Date.now() < limits.slotWaitMs + limits.textTimeMs) return { status: 'no_time', kind };
  let bytes: Buffer;
  try {
    bytes = await rawBytes(blobs, scope, file, file.sizeBytes);
  } catch (err) {
    if (err instanceof BlobMissingError) return { status: 'gone', kind };
    throw err;
  }
  let made: AiTextOutcome;
  try {
    made = await reader.extractText({ kind: document.thread, bytes, maxChars: READ_ITEM_MAX_CHARS, timeMs: limits.textTimeMs, waitMs: limits.slotWaitMs });
  } catch (err) {
    if (err instanceof SlotBusy) return { status: 'busy', kind };
    reader.logger.warn({ orgId: scope.orgId, fileId: file.id, kind, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.chat_file_read_failed');
    return { status: 'damaged', kind };
  }
  if (made.kind === 'kept') return { status: KEPT[made.outcome], kind };
  return { status: 'text', kind, text: made.text, truncated: made.cut };
}
