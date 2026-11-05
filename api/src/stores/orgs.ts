import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, type Connection, type Model, type Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export interface OrgFields {
  name: string;
  status: 'active' | 'suspended';
  createdAt: Date;
  createdBy: string;
  fromRequestId: Types.ObjectId | null;
  suspendedAt: Date | null;
}

function orgSchema(): Schema<OrgFields> {
  const schema = new Schema<OrgFields>({
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    status: { type: String, required: true, enum: ['active', 'suspended'] },
    createdAt: { type: Date, required: true },
    createdBy: { type: String, required: true },
    fromRequestId: { type: Schema.Types.ObjectId, default: null },
    suspendedAt: { type: Date, default: null },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ createdAt: -1 });
  return schema;
}

/** Registers TwOrg (tw_orgs) on first call; the first registration on a connection wins. */
export function orgModel(connection: Connection): Model<OrgFields> {
  const existing = connection.models.TwOrg as Model<OrgFields> | undefined;
  return existing ?? connection.model<OrgFields>('TwOrg', orgSchema(), 'tw_orgs');
}

export interface OrgRecord {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'suspended';
  readonly createdAt: Date;
  readonly fromRequestId: string | null;
  readonly suspendedAt: Date | null;
}

export interface OrgStore {
  findById(id: string): Promise<OrgRecord | null>;
  findByIds(ids: readonly string[]): Promise<OrgRecord[]>;
  /** Every organization, newest first (the staff console). */
  list(): Promise<OrgRecord[]>;
  /** F3 step 6: inserts the organization with this id once (`$setOnInsert`), so a retry finds it. */
  insertFromRequest(input: {
    id: string; name: string; createdAt: Date; createdBy: string; fromRequestId: string;
  }): Promise<{ org: OrgRecord; inserted: boolean }>;
  /** F10: a new active organization staff created directly, with no request. */
  insertByStaff(input: { id: string; name: string; createdAt: Date; createdBy: string }): Promise<OrgRecord>;
  /** Sets the name. Resolves the organization as it was before, or null when it is gone. */
  rename(scope: OrgScope, name: string): Promise<OrgRecord | null>;
  /** Suspends (setting suspendedAt) or reactivates (clearing it); false when the organization is gone. */
  setStatus(scope: OrgScope, status: 'active' | 'suspended', now: Date): Promise<boolean>;
  /** Deletion's last step (spec 10.7), so a retry still finds the organization until then. */
  remove(scope: OrgScope): Promise<boolean>;
}

function toOrg(doc: OrgFields & { _id: Types.ObjectId }): OrgRecord {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    status: doc.status,
    createdAt: doc.createdAt,
    fromRequestId: doc.fromRequestId === null ? null : doc.fromRequestId.toHexString(),
    suspendedAt: doc.suspendedAt,
  };
}

/** The organization is the tenant root: reads by its own id, which callers take from a seat or a scope. */
export function createOrgStore(connection: Connection): OrgStore {
  const Org = orgModel(connection);
  return {
    async findById(id) {
      const doc = await Org.findById(id).lean();
      return doc === null ? null : toOrg(doc);
    },
    async findByIds(ids) {
      if (ids.length === 0) return [];
      const docs = await Org.find({ _id: trusted({ $in: [...ids] }) }).lean();
      return docs.map(toOrg);
    },
    async list() {
      const docs = await Org.find({}).sort({ createdAt: -1, _id: -1 }).lean();
      return docs.map(toOrg);
    },
    async insertFromRequest(input) {
      let inserted = false;
      try {
        const result = await Org.updateOne({ _id: input.id }, {
          $setOnInsert: {
            name: input.name, status: 'active', createdAt: input.createdAt, createdBy: input.createdBy,
            fromRequestId: input.fromRequestId, suspendedAt: null,
          },
        }, { upsert: true });
        inserted = result.upsertedCount === 1;
      } catch (err) {
        // A concurrent retry inserted it first.
        if (!isDuplicateKeyError(err)) throw err;
      }
      const doc = await Org.findById(input.id).lean();
      if (doc === null) throw new Error('organization missing after its upsert');
      return { org: toOrg(doc), inserted };
    },
    async insertByStaff(input) {
      const doc = await Org.create({
        _id: input.id, name: input.name, status: 'active', createdAt: input.createdAt, createdBy: input.createdBy,
        fromRequestId: null, suspendedAt: null,
      });
      return toOrg(doc.toObject());
    },
    async rename(scope, name) {
      const doc = await Org.findOneAndUpdate({ _id: scope.orgId }, { $set: { name } }, { returnDocument: 'before' }).lean();
      return doc === null ? null : toOrg(doc);
    },
    async setStatus(scope, status, now) {
      const result = await Org.updateOne(
        { _id: scope.orgId },
        { $set: { status, suspendedAt: status === 'suspended' ? now : null } },
      );
      return result.matchedCount === 1;
    },
    async remove(scope) {
      return (await Org.deleteOne({ _id: scope.orgId })).deletedCount === 1;
    },
  };
}
