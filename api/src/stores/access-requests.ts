import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, type Connection, type Model, type Types } from 'mongoose';

import type { Town } from '../towns.ts';
import { townFieldSchema } from './locations.ts';

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface AccessRequestFields {
  userId: string;
  emailAtRequest: string;
  orgName: string;
  contactName: string;
  contactRole: string;
  town: Town;
  locationCount: number;
  note: string | null;
  status: AccessRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionMessage: string | null;
  orgId: Types.ObjectId | null;
  withdrawnReason: 'joined_org' | null;
}

function accessRequestSchema(): Schema<AccessRequestFields> {
  const schema = new Schema<AccessRequestFields>({
    userId: { type: String, required: true },
    emailAtRequest: { type: String, required: true },
    orgName: { type: String, required: true, minlength: 2, maxlength: 120 },
    contactName: { type: String, required: true, minlength: 1, maxlength: 120 },
    contactRole: { type: String, required: true, minlength: 1, maxlength: 80 },
    town: { type: townFieldSchema(), required: true },
    locationCount: { type: Number, required: true, min: 1, max: 50 },
    note: { type: String, default: null, maxlength: 1000 },
    status: { type: String, required: true, enum: ['pending', 'approved', 'rejected', 'withdrawn'] },
    createdAt: { type: Date, required: true },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: String, default: null },
    decisionMessage: { type: String, default: null, maxlength: 500 },
    orgId: { type: Schema.Types.ObjectId, default: null },
    withdrawnReason: { type: String, default: null, enum: ['joined_org'] },
  }, { strict: true, versionKey: false, read: 'primary' });
  // One pending request per person.
  schema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
  schema.index({ status: 1, createdAt: -1 });
  schema.index({ userId: 1, createdAt: -1 });
  return schema;
}

/** Registers TwAccessRequest (tw_access_requests) on first call. */
export function accessRequestModel(connection: Connection): Model<AccessRequestFields> {
  const existing = connection.models.TwAccessRequest as Model<AccessRequestFields> | undefined;
  return existing ?? connection.model<AccessRequestFields>('TwAccessRequest', accessRequestSchema(), 'tw_access_requests');
}

export interface AccessRequestRecord {
  readonly id: string;
  readonly userId: string;
  readonly emailAtRequest: string;
  readonly orgName: string;
  readonly contactName: string;
  readonly contactRole: string;
  readonly town: Town;
  readonly locationCount: number;
  readonly note: string | null;
  readonly status: AccessRequestStatus;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly decisionMessage: string | null;
  readonly orgId: string | null;
}

export interface NewAccessRequest {
  readonly userId: string;
  readonly emailAtRequest: string;
  readonly orgName: string;
  readonly contactName: string;
  readonly contactRole: string;
  readonly town: Town;
  readonly locationCount: number;
  readonly note: string | null;
  readonly createdAt: Date;
}

/** Requests belong to a person, not an organization: reads are keyed by userId, or by the request id for staff. */
export interface AccessRequestStore {
  findPending(userId: string): Promise<AccessRequestRecord | null>;
  latestRejected(userId: string): Promise<AccessRequestRecord | null>;
  /** Withdraws the caller's pending request after they joined an organization; the request id, or null. */
  withdrawPendingOnJoin(userId: string, now: Date): Promise<string | null>;
  /** Inserts a pending request; null when this person already has one (the unique partial index). */
  create(input: NewAccessRequest): Promise<string | null>;
  findById(id: string): Promise<AccessRequestRecord | null>;
  /** Pending oldest first; every other status newest first (P19). */
  listByStatus(status: AccessRequestStatus): Promise<AccessRequestRecord[]>;
  countPending(): Promise<number>;
  /** Compare-and-set from pending; false when the request is no longer pending. */
  markApproved(id: string, input: { orgId: string; decidedAt: Date; decidedBy: string }): Promise<boolean>;
  /** Compare-and-set from pending; false when the request is no longer pending. */
  markRejected(id: string, input: { decidedAt: Date; decidedBy: string; decisionMessage: string | null }): Promise<boolean>;
  /** Organization deletion: the request it was approved from (spec 10.7). Resolves the number deleted. */
  remove(id: string): Promise<number>;
}

function toRecord(doc: AccessRequestFields & { _id: Types.ObjectId }): AccessRequestRecord {
  return {
    id: doc._id.toHexString(),
    userId: doc.userId,
    emailAtRequest: doc.emailAtRequest,
    orgName: doc.orgName,
    contactName: doc.contactName,
    contactRole: doc.contactRole,
    town: { townId: doc.town.townId, name: doc.town.name, state: doc.town.state },
    locationCount: doc.locationCount,
    note: doc.note,
    status: doc.status,
    createdAt: doc.createdAt,
    decidedAt: doc.decidedAt,
    decidedBy: doc.decidedBy,
    decisionMessage: doc.decisionMessage,
    orgId: doc.orgId === null ? null : doc.orgId.toHexString(),
  };
}

export function createAccessRequestStore(connection: Connection): AccessRequestStore {
  const Request = accessRequestModel(connection);
  return {
    async findPending(userId) {
      const doc = await Request.findOne({ userId, status: 'pending' }).lean();
      return doc === null ? null : toRecord(doc);
    },
    async latestRejected(userId) {
      const doc = await Request.findOne({ userId, status: 'rejected' }).sort({ createdAt: -1 }).lean();
      return doc === null ? null : toRecord(doc);
    },
    async withdrawPendingOnJoin(userId, now) {
      const doc = await Request.findOneAndUpdate(
        { userId, status: 'pending' },
        { $set: { status: 'withdrawn', withdrawnReason: 'joined_org', decidedAt: now } },
        { returnDocument: 'after' },
      ).lean();
      return doc === null ? null : doc._id.toHexString();
    },
    async create(input) {
      try {
        const doc = await Request.create({
          userId: input.userId,
          emailAtRequest: input.emailAtRequest,
          orgName: input.orgName,
          contactName: input.contactName,
          contactRole: input.contactRole,
          town: { townId: input.town.townId, name: input.town.name, state: input.town.state },
          locationCount: input.locationCount,
          note: input.note,
          status: 'pending',
          createdAt: input.createdAt,
          decidedAt: null,
          decidedBy: null,
          decisionMessage: null,
          orgId: null,
          withdrawnReason: null,
        });
        return doc._id.toHexString();
      } catch (err) {
        if (isDuplicateKeyError(err)) return null;
        throw err;
      }
    },
    async findById(id) {
      const doc = await Request.findById(id).lean();
      return doc === null ? null : toRecord(doc);
    },
    async listByStatus(status) {
      const order = status === 'pending' ? 1 : -1;
      const docs = await Request.find({ status }).sort({ createdAt: order, _id: order }).lean();
      return docs.map(toRecord);
    },
    countPending() {
      return Request.countDocuments({ status: 'pending' });
    },
    async markApproved(id, input) {
      const result = await Request.updateOne(
        { _id: id, status: 'pending' },
        { $set: { status: 'approved', orgId: input.orgId, decidedAt: input.decidedAt, decidedBy: input.decidedBy } },
      );
      return result.modifiedCount === 1;
    },
    async markRejected(id, input) {
      const result = await Request.updateOne(
        { _id: id, status: 'pending' },
        { $set: { status: 'rejected', decidedAt: input.decidedAt, decidedBy: input.decidedBy, decisionMessage: input.decisionMessage } },
      );
      return result.modifiedCount === 1;
    },
    async remove(id) {
      return (await Request.deleteOne({ _id: id })).deletedCount;
    },
  };
}
