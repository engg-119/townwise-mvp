// Reference items (spec 11A, D28): pasted text kept as a `.txt` stored file, and the one reader TownwiseAI's tools use
// for a text item's words, which also reads a file attached to a message for its turn (D36: text, or a picture's
// bytes). The title, the text and a picture are never logged or audited. Nothing here logs.
import { createHash } from 'node:crypto';

import { Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { Role } from '../access/resolve.ts';
import { utcDay } from '../dates.ts';
import type { FileKind, FileRecord } from '../stores/files.ts';
import type { TownwiseStores } from '../stores/index.ts';
import { BlobMissingError, type FileBlobs } from './blobs.ts';
import { CHUNK_BYTES, DAILY_UPLOAD_BYTES, FILES_PER_LOCATION, MODEL_PICTURE_BYTES, STORED_BYTES_PER_ORG } from './limits.ts';
import { decoderFor, detectEncoding } from './parse/text.ts';
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

/** A file attached to a TownwiseAI message, as that turn sends it to the model (spec D36). */
export type ItemForModel =
  /** A text file: its first characters, as readText reads them. */
  | { readonly status: 'text'; readonly text: string; readonly truncated: boolean }
  /** A picture of at most MODEL_PICTURE_BYTES: its bytes, base64. */
  | { readonly status: 'picture'; readonly mediaType: PictureType; readonly base64: string }
  /** Kept on Your data, but not sent: a kind TownwiseAI can't read yet, a picture too large, turned off, or its original deleted. */
  | { readonly status: 'not_readable' | 'too_large' | 'turned_off' | 'gone'; readonly kind: AttachmentKind }
  /** Not a file a message can attach: stored files are off, no such file at this location, a sales file, or not kept yet. */
  | { readonly status: 'files_off' | 'not_found' | 'not_reference' | 'not_ready' };

/** The door TownwiseAI's tools and its turns read an item through (chat/* imports no file code). */
export interface ItemReader {
  readonly on: boolean;
  readText(scope: OrgScope, locationId: string, fileId: string): Promise<ItemText>;
  /** A reference file attached to a message (spec D36): its content for this turn, or why none is sent. */
  readForModel(scope: OrgScope, locationId: string, fileId: string): Promise<ItemForModel>;
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

export function createItemReader(stores: Pick<TownwiseStores, 'files'>, blobs: FileBlobs | null): ItemReader {
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
    async readForModel(scope, locationId, fileId) {
      if (blobs === null) return { status: 'files_off' };
      if (!OBJECT_ID.test(fileId) || !OBJECT_ID.test(locationId)) return { status: 'not_found' };
      const file = await stores.files.get(scope, locationId, fileId);
      if (file === null || file.status === 'deleting') return { status: 'not_found' };
      if (file.purpose !== 'reference') return { status: 'not_reference' };
      if (file.status !== 'kept') return { status: 'not_ready' };
      const kind = ATTACHMENT_KINDS[file.kind];
      // A deleted original never comes back, so it is said before a turned-off item's state.
      if (file.rawDeletedAt !== null) return { status: 'gone', kind };
      if (file.disabledAt !== null) return { status: 'turned_off', kind };
      try {
        if (file.kind === 'text') return { status: 'text', ...await textOf(blobs, scope, file) };
        if (file.kind !== 'other') return { status: 'not_readable', kind };
        // Known by its bytes, never its name.
        const mediaType = pictureType(await rawBytes(blobs, scope, file, Math.min(file.sizeBytes, PICTURE_HEAD_BYTES)));
        if (mediaType === null) return { status: 'not_readable', kind };
        if (file.sizeBytes > MODEL_PICTURE_BYTES) return { status: 'too_large', kind: 'picture' };
        return { status: 'picture', mediaType, base64: (await rawBytes(blobs, scope, file, file.sizeBytes)).toString('base64') };
      } catch (err) {
        if (err instanceof BlobMissingError) return { status: 'gone', kind };
        throw err;
      }
    },
  };
}
