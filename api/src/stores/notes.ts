// tw_notes (spec 6.7, 12): structured notes per location, the tuning step. Only the tuning chat reads them yet.
// `detail` is the owner's own words: no function here logs, and nothing copies it into an audit event.
import { Schema, Types, type Connection, type Model } from 'mongoose';

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
  createdBy: string;
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
    createdBy: { type: String, required: true },
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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface NoteStore {
  /** The number of notes per location id. */
  countByLocation(scope: OrgScope): Promise<Map<string, number>>;
  /** Sorted by start date. */
  list(scope: OrgScope, locationId: string): Promise<NoteRecord[]>;
  /** One note of this location, else null (another location's or organization's id included). */
  find(scope: OrgScope, locationId: string, noteId: string): Promise<NoteRecord | null>;
  count(scope: OrgScope, locationId: string): Promise<number>;
  hasAny(scope: OrgScope, locationId: string): Promise<boolean>;
  create(scope: OrgScope, locationId: string, content: NoteContent, input: { createdBy: string; now: Date }): Promise<NoteRecord>;
  /** A full replace of the content; null when the note is gone. */
  replace(scope: OrgScope, locationId: string, noteId: string, content: NoteContent, now: Date): Promise<NoteRecord | null>;
  remove(scope: OrgScope, locationId: string, noteId: string): Promise<boolean>;
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
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** The stored content, field by field. */
function fieldsOf(content: NoteContent): Pick<NoteFields, 'kind' | 'startDate' | 'endDate' | 'weekdays' | 'effect' | 'expectedGuests' | 'detail'> {
  return {
    kind: content.kind,
    startDate: content.startDate,
    endDate: content.endDate,
    weekdays: content.weekdays === null ? null : [...content.weekdays],
    effect: content.effect,
    expectedGuests: content.expectedGuests,
    detail: content.detail,
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
        orgId: scope.orgId, locationId, ...fieldsOf(content), createdBy: input.createdBy, createdAt: input.now, updatedAt: input.now,
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
  };
}
