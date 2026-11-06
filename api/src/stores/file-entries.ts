// tw_file_entries (spec 6.18): one row per entry of a stored ZIP, in central-directory order, with what the reader did
// with it. `path` is the entry's name inside the archive, sanitized; like a file's name it is shown to the
// organization only, never logged, audited or sent to a model, and it is cleared when the ZIP's original is deleted
// (a path can itself name a person). Removed with the file, the location's sales data and the organization. Nothing
// here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { FILE_KINDS, type FileKind } from './files.ts';

export const FILE_ENTRIES_COLLECTION = 'tw_file_entries';

export type EntryStatus = 'used' | 'kept' | 'failed';

interface EntryFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  fileId: Types.ObjectId;
  index: number;
  path: string | null;
  depth: 1 | 2;
  kind: FileKind;
  sizeBytes: number;
  status: EntryStatus;
  outcome: string | null;
  family: string | null;
  dayCount: number | null;
}

function entrySchema(): Schema<EntryFields> {
  const schema = new Schema<EntryFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    fileId: { type: Schema.Types.ObjectId, required: true },
    index: { type: Number, required: true },
    path: { type: String, default: null },
    depth: { type: Number, required: true, enum: [1, 2] },
    kind: { type: String, required: true, enum: FILE_KINDS },
    sizeBytes: { type: Number, required: true },
    status: { type: String, required: true, enum: ['used', 'kept', 'failed'] },
    outcome: { type: String, default: null },
    family: { type: String, default: null },
    dayCount: { type: Number, default: null },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, fileId: 1, index: 1 }, { unique: true });
  schema.index({ orgId: 1, locationId: 1 });
  return schema;
}

/** Registers TwFileEntry (tw_file_entries) on first call. */
export function fileEntryModel(connection: Connection): Model<EntryFields> {
  const existing = connection.models.TwFileEntry as Model<EntryFields> | undefined;
  return existing ?? connection.model<EntryFields>('TwFileEntry', entrySchema(), FILE_ENTRIES_COLLECTION);
}

export interface NewEntry {
  readonly index: number;
  readonly path: string;
  readonly depth: 1 | 2;
  readonly kind: FileKind;
  readonly sizeBytes: number;
  readonly status: EntryStatus;
  readonly outcome: string | null;
  readonly family: string | null;
}

export interface EntryRecord extends Omit<NewEntry, 'path'> {
  readonly path: string | null;
  readonly dayCount: number | null;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface FileEntryStore {
  /** The file's entries become `entries` (a re-read after an answer replaces them), written `batch` at a time. */
  replace(scope: OrgScope, locationId: string, fileId: string, entries: readonly NewEntry[], batch: number): Promise<void>;
  /** Central-directory order, after `after` (an index). */
  page(scope: OrgScope, fileId: string, after: number | null, limit: number): Promise<EntryRecord[]>;
  /** The ZIP's original is gone: its entry paths go with it. */
  clearPaths(scope: OrgScope, fileId: string): Promise<void>;
  removeForFile(scope: OrgScope, fileId: string): Promise<number>;
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  removeForOrg(scope: OrgScope): Promise<number>;
}

export function createFileEntryStore(connection: Connection): FileEntryStore {
  const Entry = fileEntryModel(connection);
  const org = (scope: OrgScope): Types.ObjectId => new Types.ObjectId(scope.orgId);
  const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
  return {
    async replace(scope, locationId, fileId, entries, batch) {
      await Entry.deleteMany({ orgId: org(scope), fileId: oid(fileId) });
      for (let at = 0; at < entries.length; at += batch) {
        const docs = entries.slice(at, at + batch).map((entry) => ({
          ...entry, orgId: org(scope), locationId: oid(locationId), fileId: oid(fileId), dayCount: null,
        }));
        try {
          await Entry.insertMany(docs, { ordered: false });
        } catch (err) {
          // A concurrent retry's duplicates (the unique index) are fine; anything else is not.
          if (!isDuplicateKeyError(err)) throw err;
        }
      }
    },
    async page(scope, fileId, after, limit) {
      const filter: Record<string, unknown> = { orgId: org(scope), fileId: oid(fileId) };
      if (after !== null) filter.index = trusted({ $gt: after });
      const docs = await Entry.find(filter).sort({ index: 1 }).limit(limit).lean();
      return docs.map((doc) => ({
        index: doc.index, path: doc.path, depth: doc.depth, kind: doc.kind, sizeBytes: doc.sizeBytes, status: doc.status,
        outcome: doc.outcome, family: doc.family, dayCount: doc.dayCount,
      }));
    },
    async clearPaths(scope, fileId) {
      await Entry.updateMany({ orgId: org(scope), fileId: oid(fileId) }, { $set: { path: null } });
    },
    async removeForFile(scope, fileId) {
      return (await Entry.deleteMany({ orgId: org(scope), fileId: oid(fileId) })).deletedCount;
    },
    async removeForLocation(scope, locationId) {
      return (await Entry.deleteMany({ orgId: org(scope), locationId: oid(locationId) })).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Entry.deleteMany({ orgId: org(scope) })).deletedCount;
    },
  };
}
