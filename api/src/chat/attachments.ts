// Files attached to a person's message from Your data (spec D36, docs/portal/tuning-chat.md section 3). The stored
// message carries an attachments block Townwise writes, after any business_rules block and before the person's text:
// each file's ref and a kind word, never its name. The files' content reaches the model only in the turn they were
// attached to (and a regenerate of that message), right after the block, through ctx.items.readForModel (chat/*
// imports no file code): before the turn's claim only each file's record and first bytes are checked, and its bytes are
// read after it, within a cap on the pictures a message sends and on the bytes this replica holds for turns at once. A
// PDF, Word (.docx) or Excel (.xlsx) file is sent as its text, made in the parse thread shared with the file readers,
// which a turn waits for only so long (the file is then listed busy): a message's documents one after another, each
// only while the turn has time for it. A later turn reads a file again with read_data_item. What a conversation stores never holds a file's text or a picture's bytes, and none of it is logged:
// the turn's log line has counts by kind only. D63: an .ics or .ical file is a calendar file, sent as a text file is,
// and when a message attaches calendar files the turn's content ends with a calendar_imports block saying what
// importing each as a calendar did (D60), with its label and links: sent in that turn only, never stored or logged.
import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { OrgScope } from '../access/policy.ts';
import type { AttachmentKind, ItemContent, ItemForModel, ItemReader, ItemViewer } from '../files/items.ts';
import type { SentFile } from './tools/registry.ts';
import type { ChatNode } from './tree.ts';
import { ATTACHMENTS_BLOCK_OPEN, isContextBlock } from './user-message.ts';

/** Files one message can attach. [CONFIRM: at most 5 a message, 20,000 characters, 3.75 MB a picture, about 150k tokens in all] */
export const MAX_ATTACHMENTS = 5;
/** About the most input tokens one message's attachments may add; past it, the rest are listed but not read. */
export const ATTACHMENT_TOKEN_CAP = 150_000;
/** What one picture counts toward the cap. Text counts a token for every 3 characters. */
export const PICTURE_TOKENS = 5_000;
/**
 * The most picture bytes one message sends, two of the largest; a picture past it, and every file with content after
 * it, is listed "not read: too much at once". [CONFIRM: at most 7.5 MB of pictures a message]
 */
export const MESSAGE_PICTURE_BYTES = 7_500_000;
/** The most bytes of attached files one replica holds for turns at once; past it a send answers 503 attachments_busy. */
export const ATTACHMENT_BYTES_IN_FLIGHT = 64_000_000;
/**
 * How long before its time limit a turn's file reads must be done (a message's documents, and read_data_item's), so it
 * still has time to answer. [CONFIRM: a turn's file reads end at least 30 seconds before its time limit]
 */
export const ANSWER_TIME_MS = 30_000;

/** A file of Your data: `f_` and its id. A sales upload (`u_`) is never attached. */
export const ATTACHMENT_REF = /^f_[0-9a-f]{24}$/;

const ATTACHMENTS_BLOCK_CLOSE = '</attachments>';
const ATTACHMENTS_LEAD = 'Townwise added this before the person\'s message; they didn\'t type it. The person attached these files from Your data to this message. Their content follows for this turn only; to read one again in a later turn, call read_data_item with its ref.';

const KIND_WORDS = {
  text: 'a text file',
  picture: 'a picture',
  pdf: 'a PDF',
  word: 'a Word file',
  excel: 'an Excel file',
  zip: 'a ZIP file',
  calendar: 'a calendar file',
  file: 'a file',
} as const satisfies Readonly<Record<AttachmentKind, string>>;

const KIND_OF_WORDS: ReadonlyMap<string, AttachmentKind> = new Map(
  Object.entries(KIND_WORDS).map(([kind, words]) => [words, kind as AttachmentKind]),
);

/** What follows a file's kind word when its content is not sent (no kind word holds a comma). */
const NOT_SENT = {
  not_readable: ', which TownwiseAI can\'t read yet',
  too_large: ', not read: over 3.75 MB',
  turned_off: ', not read: turned off in Your data',
  gone: ', not read: its original was deleted',
  // A regenerate's file deleted since the message was sent.
  missing: ', not read: no longer in Your data',
  files_off: ', not read: stored files are off',
  empty: ', not read: it is empty',
  too_much: ', not read: too much at once',
  not_allowed: ', not read: only the person who added it or an org admin can attach it',
  too_many_pixels: ', not read: too large in pixels',
  // A PDF, Word or Excel file: over its byte cap, or one the parse thread refused or couldn't get to.
  too_large_file: ', not read: too large',
  encrypted: ', not read: it has a password',
  damaged: ', not read: it couldn\'t be opened',
  too_complex: ', not read: too complex to turn into text',
  busy: ', not read: TownwiseAI was busy reading another file; try again in a moment',
  // A PDF with no text: a scan, which is read only as its text.
  no_text: ', not read: it has no text, so it may be a scan',
} as const;
/** What follows the kind word of a file sent as text (a text, calendar, PDF, Word or Excel file) when only its first characters are. */
const CUT = ', only its first 20,000 characters';

/**
 * D63: what importing an attached calendar file as one of the location's calendars did (files/calendar-import.ts
 * attachedCalendars makes these; chat/* imports no file code, so the shape is written again here).
 */
export type CalendarNote =
  | { readonly outcome: 'added' | 'already'; readonly calendarId: string; readonly label: string; readonly eventCount: number; readonly addedOn: string }
  | { readonly outcome: 'removed' | 'not_imported' }
  | { readonly outcome: 'refused'; readonly code: 'calendar_limit' | 'too_large' | 'not_calendar' | 'unavailable'; readonly retry: boolean };

/** D63: the calendar files a message attaches, by ref, and the location whose pages their links open. */
export interface CalendarNotes {
  readonly locationId: string;
  readonly byRef: ReadonlyMap<string, CalendarNote>;
}

const CALENDARS_BLOCK_OPEN = '<calendar_imports>';
const CALENDARS_BLOCK_CLOSE = '</calendar_imports>';
const CALENDARS_LEAD = 'Townwise added this before the person\'s message for this turn only; they didn\'t type it. When a calendar file is added to Your data, Townwise imports it as one of the location\'s calendars by itself, with no model call. Here is what that import did for each calendar file attached to this message, as of now. Tell the person what happened to each, and write each page below as a Markdown link with its path exactly as given. You can\'t add, retry or remove a calendar: where a line says what the person can do, tell them so, and never say a calendar was added unless a line here says it was.';

/** A path in the web app (client/src/portal/routing.ts itemHref): an item's page under Your data. Ids only. */
function dataPath(locationId: string, ref: string): string {
  return `/locations/${locationId}/data/${ref}`;
}

/** A calendar's label as a quoted string on one line, with no angle bracket that could close the block. */
function quoted(label: string): string {
  return JSON.stringify(label.replace(/</g, '＜').replace(/>/g, '＞'));
}

function events(count: number): string {
  return count === 1 ? '1 event' : `${String(count)} events`;
}

/** One calendar file's line in the calendar_imports block. */
function calendarLine(locationId: string, ref: string, note: CalendarNote): string {
  const filePage = `the file's page: ${dataPath(locationId, ref)}`;
  switch (note.outcome) {
    case 'added': case 'already': {
      const page = `Its page: ${dataPath(locationId, `c_${note.calendarId}`)}`;
      // The calendar's age alone tells added from already, and a copy Your data refused as a duplicate attaches the file
      // it copies, so a recent one may be from an earlier upload of the same file: the line never says which upload.
      return note.outcome === 'added'
        ? `- ${ref}: added within the last 30 minutes as the calendar ${quoted(note.label)}, with ${events(note.eventCount)}, when the file was added to Your data. ${page}`
        : `- ${ref}: already one of the location's calendars, ${quoted(note.label)}, with ${events(note.eventCount)}, added on ${note.addedOn}. ${page}`;
    }
    case 'removed': return `- ${ref}: added as a calendar before; that calendar was removed since, and Townwise never imports the same file again.`;
    // A file kept before D60 is never imported (its upload is done, and D60's retry needs a record): deleting it and
    // adding it again imports it, as a new upload.
    case 'not_imported': return `- ${ref}: not imported: it was kept in Your data before Townwise imported calendar files, and Townwise imports a file only when it is added. To add it as a calendar, the person who added it or an org admin can delete it on the file's page, then add the file again: ${dataPath(locationId, ref)}`;
    case 'refused': break;
  }
  const gone = 'and its original was deleted, so it can\'t be tried again.';
  switch (note.code) {
    case 'calendar_limit': return note.retry
      ? `- ${ref}: not added: the location already had 5 calendars, the most it can have. Once the person removes one, they can press Try again on ${filePage}`
      : `- ${ref}: not added: the location already had 5 calendars, the most it can have, ${gone}`;
    case 'unavailable': return note.retry
      ? `- ${ref}: not added: Townwise couldn't read the file then. The person can press Try again on ${filePage}`
      : `- ${ref}: not added: Townwise couldn't read the file, ${gone}`;
    case 'too_large': return `- ${ref}: not added: it is over 1 MB, the most a calendar file can be.`;
    case 'not_calendar': return `- ${ref}: not added: Townwise found no calendar in it.`;
  }
}

/** D63: the turn-only block that says what importing each attached calendar file did, in the message's order; null with none. */
export function calendarImportsBlock(refs: readonly string[], notes: CalendarNotes): string | null {
  const lines = refs.flatMap((ref) => {
    const note = notes.byRef.get(ref);
    return note === undefined ? [] : [calendarLine(notes.locationId, ref, note)];
  });
  return lines.length === 0 ? null : [CALENDARS_BLOCK_OPEN, CALENDARS_LEAD, ...lines, CALENDARS_BLOCK_CLOSE].join('\n');
}

/** `- f_…: a picture`, then anything after a comma. */
const LINE = /^- (f_[0-9a-f]{24}): ([^,]+)/;

/** A file a message carries: its ref and kind. */
export interface Attached {
  readonly ref: string;
  readonly kind: AttachmentKind;
}

/** A file as the checks before the turn's claim found it. `kind` is its stored kind (a regenerate), or null when the message is new. */
export interface AttachmentCheck {
  readonly ref: string;
  readonly kind: AttachmentKind | null;
  readonly check: ItemForModel;
}

/** A file as this turn read it: its content, or why none is sent (one past a cap, or past the turn's time, is `too_much`). */
export type FileRead =
  | Exclude<ItemContent, { readonly status: 'no_time' }>
  | Exclude<ItemForModel, { readonly status: 'readable' }>
  | { readonly status: 'too_much'; readonly kind: AttachmentKind };

/** A file once this turn read it. */
export interface AttachmentRead {
  readonly ref: string;
  readonly kind: AttachmentKind | null;
  readonly read: FileRead;
}

/**
 * What a send answers for a file it can't attach (handlers/chat.ts): no file there, a sales file, not kept yet, or
 * one only the person who added it or an org admin may attach.
 */
export type AttachmentRefusal = Extract<ItemForModel['status'], 'files_off' | 'not_found' | 'not_reference' | 'not_ready' | 'not_allowed'>;

/** What one message's attachments add to its turn. */
export interface TurnAttachments {
  /** The attachments block, as the person's message stores it and this turn sends it. */
  readonly block: string;
  /** The files' content, sent after the block in this turn's requests only; empty when none could be read. */
  readonly content: BetaContentBlockParam[];
  /** How many files of each kind the message carries, for the turn's log line. */
  readonly counts: Readonly<Partial<Record<AttachmentKind, number>>>;
  /** The bytes of the pictures sent, which count toward the turn's MESSAGE_PICTURE_BYTES (read_data_item adds to them). */
  readonly pictureBytes: number;
  /** D56: by ref, what `content` carries of each file sent: its text and whether it was cut, or a picture. */
  readonly sent: ReadonlyMap<string, SentFile>;
}

function attachmentsBlockAt(content: readonly BetaContentBlockParam[]): number {
  return content.findIndex((block, index) => isContextBlock(content, index) && block.type === 'text' && block.text.startsWith(ATTACHMENTS_BLOCK_OPEN));
}

/** The block listing these lines. */
export function attachmentsBlock(lines: readonly string[]): string {
  return [ATTACHMENTS_BLOCK_OPEN, ATTACHMENTS_LEAD, ...lines, ATTACHMENTS_BLOCK_CLOSE].join('\n');
}

/** The files a person's message carries, from its attachments block, in order; none without one. */
export function attachedTo(param: BetaMessageParam): Attached[] {
  if (param.role !== 'user' || typeof param.content === 'string') return [];
  const block = param.content[attachmentsBlockAt(param.content)];
  if (block?.type !== 'text') return [];
  return block.text.split('\n').flatMap((line) => {
    const match = LINE.exec(line);
    const kind = KIND_OF_WORDS.get(match?.[2] ?? '');
    return match?.[1] === undefined || kind === undefined ? [] : [{ ref: match[1], kind }];
  });
}

/** Every file the person's messages on `path` carry, each ref once, for the conversation view. */
export function attachedOnPath(path: readonly ChatNode[]): string[] {
  const refs = path.flatMap((node) => {
    const first = node.messages[0];
    return node.role === 'user' && first !== undefined ? attachedTo(JSON.parse(first.param) as BetaMessageParam).map((file) => file.ref) : [];
  });
  return [...new Set(refs)];
}

/** Checks each file for this turn, in the message's order, as `viewer` attaches it: its record and first bytes only. */
export async function checkAttachments(
  items: ItemReader, scope: OrgScope, locationId: string, viewer: ItemViewer,
  files: readonly { readonly ref: string; readonly kind: AttachmentKind | null }[],
): Promise<AttachmentCheck[]> {
  return Promise.all(files.map(async ({ ref, kind }) => ({ ref, kind, check: await items.readForModel(scope, locationId, ref.slice(2), viewer) })));
}

/** The first file in the message's order that a send can't attach, else null. */
export function refusalOf(checks: readonly AttachmentCheck[]): AttachmentRefusal | null {
  for (const { check } of checks) {
    const { status } = check;
    if (status === 'files_off' || status === 'not_found' || status === 'not_reference' || status === 'not_ready' || status === 'not_allowed') return status;
  }
  return null;
}

/**
 * Which files this turn reads, in the message's order: each it can send, until its pictures would pass
 * MESSAGE_PICTURE_BYTES; from that picture on, none.
 */
function taken(checks: readonly AttachmentCheck[]): boolean[] {
  let pictures = 0;
  let full = false;
  return checks.map(({ check }) => {
    if (check.status !== 'readable') return false;
    if (check.kind === 'picture' && !full) {
      full = pictures + check.bytes > MESSAGE_PICTURE_BYTES;
      if (!full) pictures += check.bytes;
    }
    return !full;
  });
}

/** How many bytes reading these files takes (readAttachments reads them, and gives a document's back once it is read). */
export function bytesToRead(checks: readonly AttachmentCheck[]): number {
  const take = taken(checks);
  return checks.reduce((sum, { check }, index) => sum + (check.status === 'readable' && take[index] === true ? check.bytes : 0), 0);
}

/**
 * Reads the files this turn sends, after its claim, each done by `by` (Date.now() milliseconds); one past the pictures'
 * cap is `too_much`, one not sent stays as checked. Text files, calendar files and pictures are read at once (a calendar
 * file's text comes from its original, never the parse thread). A PDF, Word or Excel file
 * is read in the shared parse thread, one after another in the message's order, so a message's documents never wait on
 * each other: one the turn hasn't the time for is `too_much`, and once one found the thread busy (another turn's or a
 * file reader's), the rest are listed busy without waiting again. Only a document's text is kept, so the bytes the turn
 * held for it (bytesToRead) go back through `bytes` once it is read, or once it won't be; a picture's, a text file's and
 * a calendar file's stay held for the turn. Once any read fails (the reads reject, and the send with them), no later document is read.
 */
export async function readAttachments(
  checks: readonly AttachmentCheck[], by: number, bytes: Pick<ByteGate, 'release'>,
): Promise<AttachmentRead[]> {
  const take = taken(checks);
  let documents: Promise<unknown> = Promise.resolve();
  let busy = false;
  let failed = false;
  const reading = async <T>(read: Promise<T>): Promise<T> => {
    try {
      return await read;
    } catch (err) {
      failed = true;
      throw err;
    }
  };
  return Promise.all(checks.map(async ({ ref, kind, check }, index): Promise<AttachmentRead> => {
    if (check.status !== 'readable') return { ref, kind, read: check };
    if (take[index] !== true) return { ref, kind, read: { status: 'too_much', kind: check.kind } };
    if (check.kind === 'text' || check.kind === 'calendar' || check.kind === 'picture') return { ref, kind, read: asSent(await reading(check.read(by))) };
    const mine = documents.then(async (): Promise<AttachmentRead> => {
      try {
        // The send already failed: what this returns is never used.
        if (failed) return { ref, kind, read: { status: 'too_much', kind: check.kind } };
        if (busy) return { ref, kind, read: { status: 'busy', kind: check.kind } };
        const read = await reading(check.read(by));
        if (read.status === 'busy') busy = true;
        return { ref, kind, read: asSent(read) };
      } finally {
        bytes.release(check.bytes);
      }
    });
    documents = mine.catch(() => undefined);
    return mine;
  }));
}

/** A read as the turn lists it: one there wasn't the time for is too much at once. */
function asSent(read: ItemContent): FileRead {
  return read.status === 'no_time' ? { status: 'too_much', kind: read.kind } : read;
}

/** Counts the bytes of attached files a replica holds for turns now (ATTACHMENT_BYTES_IN_FLIGHT). */
export interface ByteGate {
  /** False, holding nothing, when these bytes would take it past its limit. */
  reserve(bytes: number): boolean;
  release(bytes: number): void;
  readonly held: number;
}

export function createByteGate(limit: number): ByteGate {
  let held = 0;
  return {
    reserve(bytes) {
      if (bytes > 0 && held + bytes > limit) return false;
      held += bytes;
      return true;
    },
    release(bytes) {
      held = Math.max(0, held - bytes);
    },
    get held() {
      return held;
    },
  };
}

/** About how many input tokens a read file adds: 5,000 for a picture, a token for every 3 characters of text. */
export function estimatedTokens(read: FileRead): number {
  if (read.status === 'text') return Math.ceil(read.text.length / 3);
  return read.status === 'picture' ? PICTURE_TOKENS : 0;
}

function kindOf({ kind, read }: AttachmentRead): AttachmentKind {
  if (read.status === 'picture') return 'picture';
  return 'kind' in read ? read.kind : kind ?? 'file';
}

function noteOf(read: FileRead): string {
  switch (read.status) {
    case 'text': return read.truncated ? CUT : '';
    case 'picture': return '';
    case 'not_found': case 'not_reference': case 'not_ready': return NOT_SENT.missing;
    case 'too_large': return read.kind === 'picture' ? NOT_SENT.too_large : NOT_SENT.too_large_file;
    default: return NOT_SENT[read.status];
  }
}

/**
 * The block and content for these files. Text (a text file's, or a PDF's, Word file's or workbook's) is sent as a
 * document titled by its ref, a picture as a line naming its ref and then the image. The first file that would take the
 * estimate past ATTACHMENT_TOKEN_CAP, and every file with content after it, is listed "not read: too much at once".
 * D63: with `calendars`, a calendar_imports block after the files' content says what importing each calendar file did.
 */
export function turnAttachments(reads: readonly AttachmentRead[], calendars?: CalendarNotes): TurnAttachments {
  const lines: string[] = [];
  const content: BetaContentBlockParam[] = [];
  const counts: Partial<Record<AttachmentKind, number>> = {};
  const sent = new Map<string, SentFile>();
  let tokens = 0;
  let pictureBytes = 0;
  let full = false;
  for (const file of reads) {
    const { ref, read } = file;
    const kind = kindOf(file);
    counts[kind] = (counts[kind] ?? 0) + 1;
    const line = (note: string): void => { lines.push(`- ${ref}: ${KIND_WORDS[kind]}${note}`); };
    // The API refuses a document with no text in it.
    if (read.status === 'text' && read.text.trim() === '') {
      line(read.kind === 'pdf' ? NOT_SENT.no_text : NOT_SENT.empty);
      continue;
    }
    const cost = estimatedTokens(read);
    if (cost > 0 && (full || tokens + cost > ATTACHMENT_TOKEN_CAP)) {
      full = true;
      line(NOT_SENT.too_much);
      continue;
    }
    tokens += cost;
    line(noteOf(read));
    if (read.status === 'text') {
      content.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: read.text }, title: ref });
      sent.set(ref, { text: read.text, truncated: read.truncated });
    } else if (read.status === 'picture') {
      pictureBytes += Buffer.byteLength(read.base64, 'base64');
      content.push(
        { type: 'text', text: `The picture ${ref}:` },
        { type: 'image', source: { type: 'base64', media_type: read.mediaType, data: read.base64 } },
      );
      sent.set(ref, { picture: true });
    }
  }
  const imports = calendars === undefined ? null : calendarImportsBlock(reads.map((file) => file.ref), calendars);
  if (imports !== null) content.push({ type: 'text', text: imports });
  return { block: attachmentsBlock(lines), content, counts, pictureBytes, sent };
}

/**
 * The person's message as this turn's requests send it: its attachments block as `turn` wrote it, then the files'
 * content, then the rest as stored. A regenerate's block is written again from the files as they are now. Null when
 * that is the stored message itself (no content was read and the block is as stored), so the turn sends it as stored.
 */
export function expandedMessage(stored: BetaMessageParam, turn: TurnAttachments): BetaMessageParam | null {
  if (stored.role !== 'user' || typeof stored.content === 'string') return null;
  const { content } = stored;
  const at = attachmentsBlockAt(content);
  const block = content[at];
  if (block === undefined || (turn.content.length === 0 && block.type === 'text' && block.text === turn.block)) return null;
  return { ...stored, content: [...content.slice(0, at), { type: 'text', text: turn.block }, ...turn.content, ...content.slice(at + 1)] };
}
