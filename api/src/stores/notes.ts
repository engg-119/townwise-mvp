// tw_notes (spec 6.7, 12): structured notes per location, the tuning step. The forecast reader and the tuning chat read
// them. A note may carry local hours (`startTime`, `endTime`); a note stored before they existed reads as no hours.
// `detail` is the owner's own words: no function here logs, and nothing copies it into an audit event.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const NOTES_COLLECTION = 'tw_notes';

export type NoteKind = 'closure' | 'private_event' | 'opening' | 'other';
export type NoteEffect = 'closed' | 'more_guests' | 'fewer_guests' | 'unknown';

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
  /** Local wall-clock 'HH:MM' (24-hour), with `endTime`, or null for all day; both or neither, start before end. */
  readonly startTime: string | null;
  readonly endTime: string | null;
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
  /** Missing on a note stored before hours existed. */
  startTime?: string | null;
  endTime?: string | null;
  createdBy: string;
  byStaff?: boolean;
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
    effect: { type: String, required: true, enum: ['closed', 'more_guests', 'fewer_guests', 'unknown'] },
    expectedGuests: { type: Number, default: null },
    detail: { type: String, default: null, maxlength: 280 },
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    createdBy: { type: String, required: true },
    byStaff: { type: Boolean },
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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

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
  /** `id`, when given, becomes the note's id: a second create with it fails on the primary key. */
  create(scope: OrgScope, locationId: string, content: NoteContent, input: { createdBy: string; now: Date; id?: string; byStaff?: boolean }): Promise<NoteRecord>;
  /** A full replace of the content; null when the note is gone. */
  replace(scope: OrgScope, locationId: string, noteId: string, content: NoteContent, now: Date): Promise<NoteRecord | null>;
  remove(scope: OrgScope, locationId: string, noteId: string): Promise<boolean>;
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
    startTime: doc.startTime ?? null,
    endTime: doc.endTime ?? null,
    createdBy: doc.createdBy,
    byStaff: doc.byStaff === true,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** The stored content, field by field. */
function fieldsOf(
  content: NoteContent,
): Pick<NoteFields, 'kind' | 'startDate' | 'endDate' | 'weekdays' | 'effect' | 'expectedGuests' | 'detail' | 'startTime' | 'endTime'> {
  return {
    kind: content.kind,
    startDate: content.startDate,
    endDate: content.endDate,
    weekdays: content.weekdays === null ? null : [...content.weekdays],
    effect: content.effect,
    expectedGuests: content.expectedGuests,
    detail: content.detail,
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
    async create(scope, locationId, content, input) {
      const doc = await Note.create({
        ...(input.id === undefined ? {} : { _id: new Types.ObjectId(input.id) }),
        orgId: scope.orgId, locationId, ...fieldsOf(content), createdBy: input.createdBy, ...(input.byStaff === true ? { byStaff: true } : {}), createdAt: input.now, updatedAt: input.now,
      });
      return toNote(doc.toObject());
    },
    async replace(scope, locationId, noteId, content, now) {
      const doc = await Note.findOneAndUpdate(
        { _id: noteId, orgId: scope.orgId, locationId },
        { $set: { ...fieldsOf(content), updatedAt: now } },
        { returnDocument: 'after' },
      ).lean();
      return doc === null ? null : toNote(doc);
    },
    async remove(scope, locationId, noteId) {
      const result = await Note.deleteOne({ _id: noteId, orgId: scope.orgId, locationId });
      return result.deletedCount === 1;
    },
    async removeForOrg(scope) {
      return (await Note.deleteMany({ orgId: scope.orgId })).deletedCount;
    },
  };
}
