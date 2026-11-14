import { isDuplicateKeyError } from '@ckeith26/mongo';
import mongoose, { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { Role } from '../access/resolve.ts';

/** Invitations and memberships in one collection (spec 6.2). */
export interface MemberFields {
  orgId: Types.ObjectId;
  email: string;
  role: Role;
  status: 'invited' | 'active' | 'removed';
  inviteEmail?: string;
  userId: string | null;
  activeUserId?: string;
  invitedAt: Date;
  invitedBy: string;
  addedByStaff: boolean;
  joinedAt: Date | null;
  removedAt: Date | null;
  removedBy: string | null;
  /** Set by a demotion from org_admin in the same write, until its recount or revert ends (the last-admin rule). */
  demotingSince?: Date;
}

function memberSchema(): Schema<MemberFields> {
  const schema = new Schema<MemberFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    email: { type: String, required: true },
    role: { type: String, required: true, enum: ['org_admin', 'member'] },
    status: { type: String, required: true, enum: ['invited', 'active', 'removed'] },
    inviteEmail: { type: String },
    userId: { type: String, default: null },
    activeUserId: { type: String },
    invitedAt: { type: Date, required: true },
    invitedBy: { type: String, required: true },
    addedByStaff: { type: Boolean, required: true },
    joinedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
    removedBy: { type: String, default: null },
    demotingSince: { type: Date },
  }, { strict: true, versionKey: false, read: 'primary' });
  // One open invitation per address per organization.
  schema.index({ orgId: 1, inviteEmail: 1 }, {
    unique: true,
    partialFilterExpression: { inviteEmail: { $type: 'string' } },
  });
  // One active organization per person (D5).
  schema.index({ activeUserId: 1 }, {
    unique: true,
    partialFilterExpression: { activeUserId: { $type: 'string' } },
  });
  schema.index({ inviteEmail: 1 });
  schema.index({ orgId: 1, status: 1 });
  schema.index({ userId: 1, removedAt: -1 });
  return schema;
}

/** Registers TwMember (tw_members) on first call. Person-keyed reads and writes are in cross-tenant.ts. */
export function memberModel(connection: Connection): Model<MemberFields> {
  const existing = connection.models.TwMember as Model<MemberFields> | undefined;
  return existing ?? connection.model<MemberFields>('TwMember', memberSchema(), 'tw_members');
}

/** An active member or an open invitation. Removed rows are history and never returned here. */
export type MemberRecord = {
  readonly id: string;
  /** The invited address, or the requester's email for an approval seat. */
  readonly email: string;
  readonly role: Role;
  readonly invitedAt: Date;
  readonly joinedAt: Date | null;
  readonly addedByStaff: boolean;
} & ({ readonly status: 'invited'; readonly userId: null } | { readonly status: 'active'; readonly userId: string });

export type AdminSeatResult =
  | { readonly kind: 'inserted'; readonly id: string }
  | { readonly kind: 'exists' }
  | { readonly kind: 'elsewhere' };

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface MemberStore {
  /** Active members and open invitations, oldest first. */
  list(scope: OrgScope): Promise<MemberRecord[]>;
  /** One active member or open invitation of this organization, else null (another organization's id included). */
  find(scope: OrgScope, memberId: string): Promise<MemberRecord | null>;
  /** Active plus invited: the 200-person cap. */
  countSeats(scope: OrgScope): Promise<number>;
  countActiveAdmins(scope: OrgScope): Promise<number>;
  /**
   * Whether any row, active or removed, has joined (`joinedAt` set); open invitations never have. Staff setup (D23) reads
   * it beside the organization's `firstJoinedAt`, for organizations from before that field; so does approval's step 7
   * (F3) for a request with places, where a retry adds no location once anyone has.
   */
  anyJoined(scope: OrgScope): Promise<boolean>;
  /** Which of these addresses this organization already has an open invitation for. */
  openInviteEmails(scope: OrgScope, emails: readonly string[]): Promise<Set<string>>;
  hasActiveSeat(scope: OrgScope, userId: string): Promise<boolean>;
  /** The role of this person's active seat in the organization, or null when they have none. */
  activeRole(scope: OrgScope, userId: string): Promise<Role | null>;
  /** An open invitation; null when this organization already has one for the address (the unique index). */
  insertInvite(scope: OrgScope, input: InviteInput): Promise<string | null>;
  /**
   * Several open invitations in one write, each with the id its audit event already names. Resolves, per input in
   * order, whether it was inserted: false when this organization already has an invitation for the address.
   */
  insertInvites(scope: OrgScope, inputs: readonly (InviteInput & { id: string })[]): Promise<boolean[]>;
  /**
   * F3 step 8, the requester's admin seat. `exists` when this person already has a seat here, active or removed
   * (a retry completes the work and never re-seats someone the organization removed); `elsewhere` when the
   * unique activeUserId index finds them active in another organization.
   */
  insertAdminSeat(scope: OrgScope, input: {
    userId: string; email: string; joinedAt: Date; invitedBy: string;
  }): Promise<AdminSeatResult>;
  /**
   * Compare-and-set on the current role of an active member or open invitation. A demotion from org_admin also sets
   * demotingSince to `now` in the same write, so a removal racing it knows the seat was an admin a moment ago; any
   * other change clears it. Resolves the row's status at the write, or null when the row changed or is gone.
   */
  setRole(scope: OrgScope, memberId: string, from: Role, to: Role, now: Date): Promise<'invited' | 'active' | null>;
  /** Ends a demotion that stands: clears the demotingSince it set. */
  endDemotion(scope: OrgScope, memberId: string, since: Date): Promise<void>;
  /**
   * Reverts setRole (the last-admin rule) and clears demotingSince: matches the row by id, organization and the role
   * setRole wrote, whatever its status, so a seat removed since still gets its role back.
   */
  revertRole(scope: OrgScope, memberId: string, from: Role, to: Role): Promise<void>;
  deleteInvite(scope: OrgScope, memberId: string): Promise<boolean>;
  /**
   * Compare-and-set from active to removed; unsets activeUserId. Resolves the role the seat had when it was removed,
   * and whether a demotion of it was still under way, both read in the same write, or null when the row is not an
   * active seat.
   */
  removeSeat(
    scope: OrgScope, memberId: string, input: { removedAt: Date; removedBy: string },
  ): Promise<{ role: Role; demoting: boolean } | null>;
  /** Deletes an active seat outright: an approval undoing the seat it gave a person deleted meanwhile. */
  deleteSeat(scope: OrgScope, memberId: string): Promise<boolean>;
  /**
   * Reverts removeSeat (the last-admin rule). False when the seat can't come back: the person took a seat in another
   * organization since (the unique activeUserId index), or the row is no longer a removed seat.
   */
  restoreSeat(scope: OrgScope, memberId: string, userId: string): Promise<boolean>;
  /** Organization deletion: every row, invitations, seats and removed seats alike. Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

export interface InviteInput {
  readonly email: string; readonly role: Role; readonly invitedAt: Date; readonly invitedBy: string; readonly addedByStaff: boolean;
}

/** Active members and open invitations: a fresh trusted operator for each query. */
function open(): { $in: MemberFields['status'][] } {
  return trusted({ $in: ['invited', 'active'] });
}

function toMember(doc: MemberFields & { _id: Types.ObjectId }): MemberRecord {
  const base = {
    id: doc._id.toHexString(),
    email: doc.email,
    role: doc.role,
    invitedAt: doc.invitedAt,
    joinedAt: doc.joinedAt,
    addedByStaff: doc.addedByStaff,
  };
  return doc.status === 'active' && doc.userId !== null
    ? { ...base, status: 'active', userId: doc.userId }
    : { ...base, status: 'invited', userId: null };
}

export function createMemberStore(connection: Connection): MemberStore {
  const Member = memberModel(connection);
  return {
    async list(scope) {
      const docs = await Member.find({ orgId: scope.orgId, status: open() }).sort({ invitedAt: 1, _id: 1 }).lean();
      return docs.map(toMember);
    },
    async find(scope, memberId) {
      const doc = await Member.findOne({ _id: memberId, orgId: scope.orgId, status: open() }).lean();
      return doc === null ? null : toMember(doc);
    },
    countSeats(scope) {
      return Member.countDocuments({ orgId: scope.orgId, status: open() });
    },
    countActiveAdmins(scope) {
      return Member.countDocuments({ orgId: scope.orgId, status: 'active', role: 'org_admin' });
    },
    async anyJoined(scope) {
      return (await Member.exists({ orgId: scope.orgId, joinedAt: trusted({ $ne: null }) })) !== null;
    },
    async openInviteEmails(scope, emails) {
      if (emails.length === 0) return new Set();
      const docs = await Member.find({ orgId: scope.orgId, inviteEmail: trusted({ $in: [...emails] }) }).lean();
      return new Set(docs.flatMap((doc) => (doc.inviteEmail === undefined ? [] : [doc.inviteEmail])));
    },
    async hasActiveSeat(scope, userId) {
      return (await Member.exists({ orgId: scope.orgId, activeUserId: userId })) !== null;
    },
    async activeRole(scope, userId) {
      return (await Member.findOne({ orgId: scope.orgId, activeUserId: userId }, { role: 1 }).lean())?.role ?? null;
    },
    async insertInvite(scope, input) {
      try {
        const doc = await Member.create({
          orgId: scope.orgId, email: input.email, role: input.role, status: 'invited', inviteEmail: input.email,
          userId: null, invitedAt: input.invitedAt, invitedBy: input.invitedBy, addedByStaff: input.addedByStaff,
          joinedAt: null, removedAt: null, removedBy: null,
        });
        return doc._id.toHexString();
      } catch (err) {
        if (isDuplicateKeyError(err)) return null;
        throw err;
      }
    },
    async insertInvites(scope, inputs) {
      if (inputs.length === 0) return [];
      const orgId = new Types.ObjectId(scope.orgId);
      const docs = inputs.map((input) => ({
        _id: new Types.ObjectId(input.id), orgId, email: input.email, role: input.role, status: 'invited' as const,
        inviteEmail: input.email, userId: null, invitedAt: input.invitedAt, invitedBy: input.invitedBy,
        addedByStaff: input.addedByStaff, joinedAt: null, removedAt: null, removedBy: null,
      }));
      try {
        // One unordered insert: each row stands or falls on the unique index alone.
        await Member.collection.insertMany(docs, { ordered: false });
        return inputs.map(() => true);
      } catch (err) {
        if (!(err instanceof mongoose.mongo.MongoBulkWriteError)) throw err;
        const writeErrors = [err.writeErrors].flat();
        if (writeErrors.some((writeError) => writeError.code !== 11000)) throw err;
        const taken = new Set(writeErrors.map((writeError) => writeError.index));
        return inputs.map((_, i) => !taken.has(i));
      }
    },
    async insertAdminSeat(scope, input) {
      if ((await Member.exists({ orgId: scope.orgId, userId: input.userId })) !== null) return { kind: 'exists' };
      try {
        const doc = await Member.create({
          orgId: scope.orgId, email: input.email, role: 'org_admin', status: 'active',
          userId: input.userId, activeUserId: input.userId, invitedAt: input.joinedAt, invitedBy: input.invitedBy,
          addedByStaff: false, joinedAt: input.joinedAt, removedAt: null, removedBy: null,
        });
        return { kind: 'inserted', id: doc._id.toHexString() };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const here = await Member.exists({ orgId: scope.orgId, activeUserId: input.userId });
        return here === null ? { kind: 'elsewhere' } : { kind: 'exists' };
      }
    },
    async setRole(scope, memberId, from, to, now) {
      const update = from === 'org_admin' && to !== 'org_admin'
        ? { $set: { role: to, demotingSince: now } }
        : { $set: { role: to }, $unset: { demotingSince: '' } };
      const before = await Member.findOneAndUpdate(
        { _id: memberId, orgId: scope.orgId, status: open(), role: from },
        update,
        { returnDocument: 'before', lean: true },
      );
      return before === null || before.status === 'removed' ? null : before.status;
    },
    async endDemotion(scope, memberId, since) {
      await Member.updateOne({ _id: memberId, orgId: scope.orgId, demotingSince: since }, { $unset: { demotingSince: '' } });
    },
    async revertRole(scope, memberId, from, to) {
      await Member.updateOne({ _id: memberId, orgId: scope.orgId, role: from }, { $set: { role: to }, $unset: { demotingSince: '' } });
    },
    async deleteInvite(scope, memberId) {
      const result = await Member.deleteOne({ _id: memberId, orgId: scope.orgId, status: 'invited' });
      return result.deletedCount === 1;
    },
    async removeSeat(scope, memberId, input) {
      const before = await Member.findOneAndUpdate(
        { _id: memberId, orgId: scope.orgId, status: 'active' },
        { $set: { status: 'removed', removedAt: input.removedAt, removedBy: input.removedBy }, $unset: { activeUserId: '' } },
        { returnDocument: 'before', lean: true },
      );
      return before === null ? null : { role: before.role, demoting: before.demotingSince !== undefined };
    },
    async deleteSeat(scope, memberId) {
      return (await Member.deleteOne({ _id: memberId, orgId: scope.orgId, status: 'active' })).deletedCount === 1;
    },
    async restoreSeat(scope, memberId, userId) {
      try {
        const result = await Member.updateOne(
          { _id: memberId, orgId: scope.orgId, status: 'removed' },
          { $set: { status: 'active', activeUserId: userId, removedAt: null, removedBy: null } },
        );
        return result.modifiedCount === 1;
      } catch (err) {
        if (isDuplicateKeyError(err)) return false;
        throw err;
      }
    },
    async removeForOrg(scope) {
      return (await Member.deleteMany({ orgId: scope.orgId })).deletedCount;
    },
  };
}
