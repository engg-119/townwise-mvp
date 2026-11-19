// tw_notes (spec 6.7, 12): structured notes per location, the tuning step. The forecast reader and the tuning chat read
// them. A note may carry local hours (`startTime`, `endTime`); a note stored before they existed reads as no hours.
// `detail` and `title` are the owner's own words: no function here logs, and nothing copies them into an audit event. A
// note stored before titles existed (D49) has no `title` key and reads as untitled.
// A note made from an owner-calendar event keeps `fromEvent` (openspec change calendar-event-suggestions, design
// decisions 1, 2 and 5): the calendar's id, the event's stored uid and the event's dates and hours when the link was
// made or last followed, never its title. `replace` sets content only, so an edit keeps the link unless the caller
// asks to drop it (an edit into a guest-count mark, D67); moveIf and removeIf
// are the follow-up's compare-and-set on `updatedAt`. A uid names a booking: nothing here logs it.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { AiSource } from './files.ts';

/** A note's link holds a uid of at most this many characters (calendar/ics.ts MAX_KEY_CHARS). */
export const MAX_LINK_UID_CHARS = 1_024;

export const NOTES_COLLECTION = 'tw_notes';

/** D49: a note's title, at most, in code points. [CONFIRM: 120 characters, matching the file reader's event titles] */
export const MAX_NOTE_TITLE_CHARS = 120;

export type NoteKind = 'closure' | 'private_event' | 'opening' | 'other';
/** `wrong_guest_count` (D67): a past day's stored guest count is wrong and its sales right; notes only, never a rule. */
export type NoteEffect = 'closed' | 'more_guests' | 'fewer_guests' | 'unknown' | 'wrong_guest_count';

/** Spec 12 NoteInput, after validation. */
export interface NoteContent {
  readonly kind: NoteKind;
  readonly startDate: string;
  /** Inclusive. */
  readonly endDate: string;
  /** 0 (Sunday) to 6, ascending; null means every day in the range. */
  readonly weekdays: readonly number[] | null;
  readonly effect: NoteEffect;
  readonly expectedGuests: number | null;
  readonly detail: string | null;
  /** D49: the event's name, one line of 1 to 120 code points, or null. */
  readonly title: string | null;
  /** Local wall-clock 'HH:MM' (24-hour), with `endTime`, or null for all day; both or neither, start before end. */
  readonly startTime: string | null;
  readonly endTime: string | null;
}

/** A note's dates and hours. */
export type NoteDates = Pick<NoteContent, 'startDate' | 'endDate' | 'startTime' | 'endTime'>;

/** The owner-calendar event a note was made from, with the event's dates and hours when it was linked or last followed. */
export interface NoteLink extends NoteDates {
  readonly calendarId: string;
  /** The event row's stored uid (stores/owner-calendars.ts). */
  readonly uid: string;
  readonly linkedAt: Date;
}

interface StoredLink {
  calendarId: Types.ObjectId;
  uid: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  linkedAt: Date;
}

interface NoteFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  kind: NoteKind;
  startDate: string;
  endDate: string;
  weekdays: number[] | null;
  effect: NoteEffect;
  expectedGuests: number | null;
  detail: string | null;
  /** Missing on a note stored before titles existed (D49); every later write stores it, null included. */
  title?: string | null;
  /** Missing on a note stored before hours existed. */
  startTime?: string | null;
  endTime?: string | null;
  createdBy: string;
  byStaff?: boolean;
  /** Spec 11A.9: a note TownwiseAI made from an event in a file someone let it read. Absent otherwise. */
  source?: { via: 'ai_file'; fileId: Types.ObjectId };
  /** A note made from an owner-calendar event. Absent otherwise. */
  fromEvent?: StoredLink;
  /**
   * D59: a note TownwiseAI saved on its own, through agent/apply.ts: its ledger row (tw_agent_changes) and the note's
   * `updatedAt` when it was applied. A note whose `updatedAt` is later was edited by a person, and is theirs. Absent otherwise.
   */
  agent?: { changeId: Types.ObjectId; at: Date };
  createdAt: Date;
  updatedAt: Date;
}

function noteSchema(): Schema<NoteFields> {
  const schema = new Schema<NoteFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, required: true, enum: ['closure', 'private_event', 'opening', 'other'] },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    weekdays: { type: [Number], default: null },
    effect: { type: String, required: true, enum: ['closed', 'more_guests', 'fewer_guests', 'unknown', 'wrong_guest_count'] },
    expectedGuests: { type: Number, default: null },
    detail: { type: String, default: null, maxlength: 280 },
    // 120 code points, which a String's maxlength (UTF-16 units) cannot count.
    title: { type: String, validate: (title: string | null) => title === null || Array.from(title).length <= MAX_NOTE_TITLE_CHARS },
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    createdBy: { type: String, required: true },
    byStaff: { type: Boolean },
    source: {
      type: new Schema({
        via: { type: String, required: true, enum: ['ai_file'] }, fileId: { type: Schema.Types.ObjectId, required: true },
      }, { _id: false, strict: 'throw' }),
    },
    fromEvent: {
      type: new Schema({
        calendarId: { type: Schema.Types.ObjectId, required: true },
        uid: { type: String, required: true, maxlength: MAX_LINK_UID_CHARS },
        startDate: { type: String, required: true },
        endDate: { type: String, required: true },
        startTime: { type: String, default: null },
        endTime: { type: String, default: null },
        linkedAt: { type: Date, required: true },
      }, { _id: false, strict: 'throw' }),
    },
    agent: {
      type: new Schema({
        changeId: { type: Schema.Types.ObjectId, required: true }, at: { type: Date, required: true },
      }, { _id: false, strict: 'throw' }),
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, startDate: 1 });
  return schema;
}

/** Registers TwNote (tw_notes) on first call. */
export function noteModel(connection: Connection): Model<NoteFields> {
  const existing = connection.models.TwNote as Model<NoteFields> | undefined;
  return existing ?? connection.model<NoteFields>('TwNote', noteSchema(), NOTES_COLLECTION);
}

export interface NoteRecord extends NoteContent {
  readonly id: string;
  readonly createdBy: string;
  /** Made by Townwise staff in open as admin (D25); shown as "Townwise staff", never the staff email. */
  readonly byStaff: boolean;
  /** Made by TownwiseAI from a file someone let it read (spec 11A.9): that file. Null for any other note. */
  readonly source: AiSource | null;
  /** The owner-calendar event the note was made from; null for any other note. */
  readonly fromEvent: NoteLink | null;
  /** D59: the ledger row of a note TownwiseAI saved on its own, and its `updatedAt` then; null for any other note. */
  readonly agent: NoteAgent | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** D59: which ledger row added the note, and the note's `updatedAt` when it did. */
export interface NoteAgent { readonly changeId: string; readonly at: Date }

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface NoteStore {
  /** The number of notes per location id. */
  countByLocation(scope: OrgScope): Promise<Map<string, number>>;
  /** Sorted by start date. */
  list(scope: OrgScope, locationId: string): Promise<NoteRecord[]>;
  /** This location's notes whose dates touch the inclusive range (weekdays not applied), sorted by start date. */
  overlapping(scope: OrgScope, locationId: string, range: { from: string; to: string }): Promise<NoteRecord[]>;
  /** One note of this location, else null (another location's or organization's id included). */
  find(scope: OrgScope, locationId: string, noteId: string): Promise<NoteRecord | null>;
  count(scope: OrgScope, locationId: string): Promise<number>;
  hasAny(scope: OrgScope, locationId: string): Promise<boolean>;
  /** The organization's notes among `ids` (any location). */
  byIds(scope: OrgScope, ids: readonly string[]): Promise<NoteRecord[]>;
  /**
   * `id`, when given, becomes the note's id: a second create with it fails on the primary key. `source` marks a note
   * TownwiseAI made from a file (spec 11A.9); `fromEvent` links one made from an owner-calendar event.
   */
  create(scope: OrgScope, locationId: string, content: NoteContent, input: {
    createdBy: string; now: Date; id?: string; byStaff?: boolean; source?: AiSource; fromEvent?: NoteLink; agent?: { changeId: string };
  }): Promise<NoteRecord>;
  /**
   * The title backfill (D49): sets the note's title only while it has no `title` key (a compare-and-set), so a second
   * run or another replica writes nothing. Resolves whether this call wrote it.
   */
  setTitleOnce(scope: OrgScope, noteId: string, title: string | null): Promise<boolean>;
  /** A full replace of the content, keeping any link unless `unlink`; null when the note is gone. */
  replace(scope: OrgScope, locationId: string, noteId: string, content: NoteContent, now: Date, opts?: { unlink?: boolean }): Promise<NoteRecord | null>;
  remove(scope: OrgScope, locationId: string, noteId: string): Promise<boolean>;
  /** This location's notes linked to the calendar, sorted by start date. */
  linkedTo(scope: OrgScope, locationId: string, calendarId: string): Promise<NoteRecord[]>;
  /**
   * A follow-up's move, by compare-and-set: sets only the note's dates and hours, its link's dates and hours and
   * `updatedAt`, while the note is linked and its `updatedAt` is still `updatedAt`. Null otherwise (changed, or gone).
   */
  moveIf(scope: OrgScope, locationId: string, noteId: string, input: {
    updatedAt: Date; dates: NoteDates; link: NoteDates; now: Date;
  }): Promise<NoteRecord | null>;
  /** A follow-up's removal: deletes the note only while its `updatedAt` is still `updatedAt`. False otherwise. */
  removeIf(scope: OrgScope, locationId: string, noteId: string, updatedAt: Date): Promise<boolean>;
  /** Undoing a TownwiseAI read (spec 11A.9): the location's notes it made from `fileId`, edited or not. Resolves the count. */
  removeFromAiRead(scope: OrgScope, locationId: string, fileId: string): Promise<number>;
  /** Deleting a location (D44): every note of it. Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

function toNote(doc: NoteFields & { _id: Types.ObjectId }): NoteRecord {
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    startDate: doc.startDate,
    endDate: doc.endDate,
    weekdays: doc.weekdays === null ? null : [...doc.weekdays],
    effect: doc.effect,
    expectedGuests: doc.expectedGuests,
    detail: doc.detail,
    title: doc.title ?? null,
    startTime: doc.startTime ?? null,
    endTime: doc.endTime ?? null,
    createdBy: doc.createdBy,
    byStaff: doc.byStaff === true,
    source: doc.source === undefined ? null : { via: 'ai_file', fileId: doc.source.fileId.toHexString() },
    fromEvent: doc.fromEvent === undefined ? null : {
      calendarId: doc.fromEvent.calendarId.toHexString(), uid: doc.fromEvent.uid, startDate: doc.fromEvent.startDate,
      endDate: doc.fromEvent.endDate, startTime: doc.fromEvent.startTime, endTime: doc.fromEvent.endTime, linkedAt: doc.fromEvent.linkedAt,
    },
    agent: doc.agent === undefined ? null : { changeId: doc.agent.changeId.toHexString(), at: doc.agent.at },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** The stored content, field by field. */
function fieldsOf(
  content: NoteContent,
): Pick<NoteFields, 'kind' | 'startDate' | 'endDate' | 'weekdays' | 'effect' | 'expectedGuests' | 'detail' | 'title' | 'startTime' | 'endTime'> {
  return {
    kind: content.kind,
    startDate: content.startDate,
    endDate: content.endDate,
    weekdays: content.weekdays === null ? null : [...content.weekdays],
    effect: content.effect,
    expectedGuests: content.expectedGuests,
    detail: content.detail,
    title: content.title,
    startTime: content.startTime,
    endTime: content.endTime,
  };
}

export function createNoteStore(connection: Connection): NoteStore {
  const Note = noteModel(connection);
  return {
    async countByLocation(scope) {
      const rows = await connection.collection(NOTES_COLLECTION).aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { orgId: new Types.ObjectId(scope.orgId) } },
        { $group: { _id: '$locationId', n: { $sum: 1 } } },
      ]).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), row.n]));
    },
    async list(scope, locationId) {
      const docs = await Note.find({ orgId: scope.orgId, locationId }).sort({ startDate: 1, createdAt: 1, _id: 1 }).lean();
      return docs.map(toNote);
    },
    async overlapping(scope, locationId, range) {
      const docs = await Note.find({ orgId: scope.orgId, locationId, startDate: trusted({ $lte: range.to }), endDate: trusted({ $gte: range.from }) })
        .sort({ startDate: 1, createdAt: 1, _id: 1 }).lean();
      return docs.map(toNote);
    },
    async find(scope, locationId, noteId) {
      const doc = await Note.findOne({ _id: noteId, orgId: scope.orgId, locationId }).lean();
      return doc === null ? null : toNote(doc);
    },
    count(scope, locationId) {
      return Note.countDocuments({ orgId: scope.orgId, locationId });
    },
    async hasAny(scope, locationId) {
      return (await Note.exists({ orgId: scope.orgId, locationId })) !== null;
    },
    async byIds(scope, ids) {
      if (ids.length === 0) return [];
      const docs = await Note.find({ orgId: scope.orgId, _id: trusted({ $in: ids.map((id) => new Types.ObjectId(id)) }) }).lean();
      return docs.map(toNote);
    },
    async create(scope, locationId, content, input) {
      const doc = await Note.create({
        ...(input.id === undefined ? {} : { _id: new Types.ObjectId(input.id) }),
        orgId: scope.orgId, locationId, ...fieldsOf(content), createdBy: input.createdBy, ...(input.byStaff === true ? { byStaff: true } : {}),
        ...(input.source === undefined ? {} : { source: { via: 'ai_file', fileId: new Types.ObjectId(input.source.fileId) } }),
        ...(input.fromEvent === undefined ? {} : { fromEvent: { ...input.fromEvent, calendarId: new Types.ObjectId(input.fromEvent.calendarId) } }),
        ...(input.agent === undefined ? {} : { agent: { changeId: new Types.ObjectId(input.agent.changeId), at: input.now } }),
        createdAt: input.now, updatedAt: input.now,
      });
      return toNote(doc.toObject());
    },
    async replace(scope, locationId, noteId, content, now, opts = {}) {
      const doc = await Note.findOneAndUpdate(
        { _id: noteId, orgId: scope.orgId, locationId },
        { $set: { ...fieldsOf(content), updatedAt: now }, ...(opts.unlink === true ? { $unset: { fromEvent: 1 } } : {}) },
        { returnDocument: 'after' },
      ).lean();
      return doc === null ? null : toNote(doc);
    },
    async setTitleOnce(scope, noteId, title) {
      const result = await Note.updateOne({ _id: noteId, orgId: scope.orgId, title: trusted({ $exists: false }) }, { $set: { title } });
      return result.modifiedCount === 1;
    },
    async remove(scope, locationId, noteId) {
      const result = await Note.deleteOne({ _id: noteId, orgId: scope.orgId, locationId });
      return result.deletedCount === 1;
    },
    async linkedTo(scope, locationId, calendarId) {
      const docs = await Note.find({ orgId: scope.orgId, locationId, 'fromEvent.calendarId': new Types.ObjectId(calendarId) })
        .sort({ startDate: 1, createdAt: 1, _id: 1 }).lean();
      return docs.map(toNote);
    },
    async moveIf(scope, locationId, noteId, input) {
      const { dates, link } = input;
      const doc = await Note.findOneAndUpdate(
        { _id: noteId, orgId: scope.orgId, locationId, updatedAt: input.updatedAt, fromEvent: trusted({ $exists: true }) },
        {
          $set: {
            startDate: dates.startDate, endDate: dates.endDate, startTime: dates.startTime, endTime: dates.endTime,
            'fromEvent.startDate': link.startDate, 'fromEvent.endDate': link.endDate, 'fromEvent.startTime': link.startTime,
            'fromEvent.endTime': link.endTime, updatedAt: input.now,
          },
        },
        { returnDocument: 'after' },
      ).lean();
      return doc === null ? null : toNote(doc);
    },
    async removeIf(scope, locationId, noteId, updatedAt) {
      return (await Note.deleteOne({ _id: noteId, orgId: scope.orgId, locationId, updatedAt })).deletedCount === 1;
    },
    async removeFromAiRead(scope, locationId, fileId) {
      return (await Note.deleteMany({ orgId: scope.orgId, locationId, 'source.fileId': new Types.ObjectId(fileId) })).deletedCount;
    },
    async removeForLocation(scope, locationId) {
      return (await Note.deleteMany({ orgId: scope.orgId, locationId })).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Note.deleteMany({ orgId: scope.orgId })).deletedCount;
    },
  };
}
