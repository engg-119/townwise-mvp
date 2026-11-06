// Operations keyed by a person, or spanning organizations (spec 6.10 rule 8). The list is closed:
// findActiveSeat, findOpenInvites, claimInvite, declineInvite, latestRemovedSeat, adminOrgStats, peopleRecords,
// deletePersonRecords, and the file reader's claimNextImport.
// Only access/resolve.ts, the join and decline handlers, the staff handlers (admin.ts, deletion.ts) and the file
// reader (files/worker.ts) import this file (test/isolation.test.ts enforces the list).
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { trusted, type Connection, type Types } from 'mongoose';

import type { Role } from '../access/resolve.ts';
import { accessRequestModel, type AccessRequestStatus } from './access-requests.ts';
import { chatConversationModel } from './chat-conversations.ts';
import { chatLiveTurnModel } from './chat-live-turns.ts';
import { chatProposalModel } from './chat-proposals.ts';
import { importModel } from './imports.ts';
import { locationModel } from './locations.ts';
import { memberModel } from './members.ts';
import { orgModel } from './orgs.ts';
import { HAS_VALUE, SALES_DAYS_COLLECTION } from './sales-days.ts';
import { UPLOADS_COLLECTION } from './uploads.ts';
import { welcomeModel } from './welcomes.ts';

export interface ActiveSeat { readonly id: string; readonly orgId: string; readonly role: Role }

export interface OpenInvite {
  readonly id: string;
  readonly orgId: string;
  readonly role: Role;
  readonly invitedBy: string;
  readonly addedByStaff: boolean;
}

export interface RemovedSeat {
  readonly id: string;
  readonly orgId: string;
  readonly removedAt: Date;
  readonly removedBy: string | null;
}

/** A seat this person just took by joining; only claimInvite returns one. */
export interface JoinedSeat { readonly id: string; readonly orgId: string; readonly role: Role; readonly status: 'active' }

export type ClaimResult =
  | { readonly kind: 'joined'; readonly seat: JoinedSeat }
  | { readonly kind: 'no_invite' }
  | { readonly kind: 'already_in_org' };

export async function findActiveSeat(connection: Connection, userId: string): Promise<ActiveSeat | null> {
  const doc = await memberModel(connection).findOne({ activeUserId: userId }).lean();
  if (doc === null) return null;
  return { id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), role: doc.role };
}

/** Open invitations for this exact address, in every organization, oldest first. */
export async function findOpenInvites(connection: Connection, email: string): Promise<OpenInvite[]> {
  const docs = await memberModel(connection)
    .find({ inviteEmail: email, status: 'invited' })
    .sort({ invitedAt: 1, _id: 1 })
    .lean();
  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    orgId: doc.orgId.toHexString(),
    role: doc.role,
    invitedBy: doc.invitedBy,
    addedByStaff: doc.addedByStaff,
  }));
}

export async function latestRemovedSeat(connection: Connection, userId: string): Promise<RemovedSeat | null> {
  const doc = await memberModel(connection)
    .findOne({ userId, status: 'removed' })
    .sort({ removedAt: -1 })
    .lean();
  if (doc === null) return null;
  if (doc.removedAt === null) return null;
  return {
    id: doc._id.toHexString(),
    orgId: doc.orgId.toHexString(),
    removedAt: doc.removedAt,
    removedBy: doc.removedBy,
  };
}

/** The invitation exists, is open, is addressed to `email`, and its organization is active. */
async function isOpenInvite(connection: Connection, inviteId: string, email: string): Promise<boolean> {
  const invite = await memberModel(connection)
    .findOne({ _id: inviteId, status: 'invited', inviteEmail: email })
    .lean();
  if (invite === null) return false;
  const org = await orgModel(connection).findOne({ _id: invite.orgId, status: 'active' }).lean();
  return org !== null;
}

/**
 * F1 step 5: compare-and-set the invitation to active for this person. The unique activeUserId index
 * turns a second organization into already_in_org; of concurrent claims on one invitation, one wins.
 * The organization check is a read before the CAS (no multi-document transactions, D17).
 */
export async function claimInvite(
  connection: Connection,
  input: { inviteId: string; email: string; userId: string; now: Date },
): Promise<ClaimResult> {
  if (!(await isOpenInvite(connection, input.inviteId, input.email))) return { kind: 'no_invite' };
  try {
    const doc = await memberModel(connection).findOneAndUpdate(
      { _id: input.inviteId, status: 'invited', inviteEmail: input.email },
      {
        $set: { status: 'active', userId: input.userId, activeUserId: input.userId, joinedAt: input.now },
        $unset: { inviteEmail: '' },
      },
      { returnDocument: 'after' },
    ).lean();
    if (doc === null) return { kind: 'no_invite' };
    return {
      kind: 'joined',
      seat: { id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), role: doc.role, status: 'active' },
    };
  } catch (err) {
    if (isDuplicateKeyError(err)) return { kind: 'already_in_org' };
    throw err;
  }
}

/** “Not my team”: deletes the invitation, matched exactly as claimInvite matches it. */
export async function declineInvite(
  connection: Connection,
  input: { inviteId: string; email: string },
): Promise<{ readonly id: string; readonly orgId: string } | null> {
  if (!(await isOpenInvite(connection, input.inviteId, input.email))) return null;
  const doc = await memberModel(connection)
    .findOneAndDelete({ _id: input.inviteId, status: 'invited', inviteEmail: input.email })
    .lean();
  return doc === null ? null : { id: doc._id.toHexString(), orgId: doc.orgId.toHexString() };
}

/** Counts for the staff Organizations table (spec 10.7). Counts and times only, never figures (D7). */
export interface OrgStats {
  readonly adminCount: number;
  /** Active seats with the member role. */
  readonly memberCount: number;
  readonly inviteCount: number;
  readonly locationCount: number;
  /** Days with guests or net sales, across the organization's locations. */
  readonly salesDayCount: number;
  /** The newest applied upload. */
  readonly lastUploadAt: Date | null;
}

export const NO_ORG_STATS: OrgStats = {
  adminCount: 0, memberCount: 0, inviteCount: 0, locationCount: 0, salesDayCount: 0, lastUploadAt: null,
};

interface Count { _id: Types.ObjectId; n: number }

/** Per-organization counts across every organization, keyed by organization id. */
export async function adminOrgStats(connection: Connection): Promise<Map<string, OrgStats>> {
  const [seats, locations, salesDays, uploads] = await Promise.all([
    memberModel(connection).aggregate<{ _id: { orgId: Types.ObjectId; status: string; role: Role }; n: number }>([
      { $match: { status: { $in: ['active', 'invited'] } } },
      { $group: { _id: { orgId: '$orgId', status: '$status', role: '$role' }, n: { $sum: 1 } } },
    ]),
    locationModel(connection).aggregate<Count>([{ $group: { _id: '$orgId', n: { $sum: 1 } } }]),
    connection.collection(SALES_DAYS_COLLECTION)
      .aggregate<Count>([{ $match: HAS_VALUE }, { $group: { _id: '$orgId', n: { $sum: 1 } } }]).toArray(),
    connection.collection(UPLOADS_COLLECTION)
      .aggregate<{ _id: Types.ObjectId; last: Date }>([
        { $match: { status: 'applied' } },
        { $group: { _id: '$orgId', last: { $max: '$uploadedAt' } } },
      ]).toArray(),
  ]);
  type Building = { -readonly [K in keyof OrgStats]: OrgStats[K] };
  const stats = new Map<string, Building>();
  const entry = (orgId: Types.ObjectId): Building => {
    const key = orgId.toHexString();
    const existing = stats.get(key);
    if (existing !== undefined) return existing;
    const created = { ...NO_ORG_STATS };
    stats.set(key, created);
    return created;
  };
  for (const row of seats) {
    const counts = entry(row._id.orgId);
    if (row._id.status === 'invited') counts.inviteCount += row.n;
    else if (row._id.role === 'org_admin') counts.adminCount += row.n;
    else counts.memberCount += row.n;
  }
  for (const row of locations) entry(row._id).locationCount = row.n;
  for (const row of salesDays) entry(row._id).salesDayCount = row.n;
  for (const row of uploads) entry(row._id).lastUploadAt = row.last;
  return stats;
}

export interface PersonSeat {
  readonly id: string;
  readonly userId: string;
  /** The address the seat was added for (an invitation's, or the requester's at approval). */
  readonly email: string;
  readonly orgId: string;
  readonly role: Role;
  readonly status: 'active' | 'removed';
  readonly joinedAt: Date | null;
  readonly removedAt: Date | null;
}

export interface PersonInvite { readonly email: string; readonly orgId: string; readonly invitedAt: Date }

export interface PersonRequest {
  readonly userId: string;
  readonly emailAtRequest: string;
  readonly status: AccessRequestStatus;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
}

export interface PeopleRecords {
  readonly seats: readonly PersonSeat[];
  readonly invites: readonly PersonInvite[];
  readonly requests: readonly PersonRequest[];
}

/**
 * The Townwise records People is built from (spec 10.7): seats, open invitations and access requests, in every
 * organization. With `by`, only one person's: seats and requests by their user id, invitations by their address.
 */
export async function peopleRecords(
  connection: Connection,
  by?: { readonly userId: string | null; readonly email: string },
): Promise<PeopleRecords> {
  const byUser = by === undefined ? {} : { userId: by.userId };
  // An address with no kit user has no seats and no requests.
  const noUser = by?.userId === null;
  const [seats, invites, requests] = await Promise.all([
    noUser ? [] : memberModel(connection).find({ ...byUser, status: trusted({ $in: ['active', 'removed'] }) }).lean(),
    memberModel(connection).find({ status: 'invited', ...(by === undefined ? {} : { inviteEmail: by.email }) }).lean(),
    noUser ? [] : accessRequestModel(connection).find(byUser).lean(),
  ]);
  return {
    seats: seats.flatMap((doc) => (doc.userId === null || doc.status === 'invited' ? [] : [{
      id: doc._id.toHexString(), userId: doc.userId, email: doc.email, orgId: doc.orgId.toHexString(), role: doc.role, status: doc.status,
      joinedAt: doc.joinedAt, removedAt: doc.removedAt,
    }])),
    invites: invites.flatMap((doc) => (doc.inviteEmail === undefined ? [] : [{
      email: doc.inviteEmail, orgId: doc.orgId.toHexString(), invitedAt: doc.invitedAt,
    }])),
    requests: requests.map((doc) => ({
      userId: doc.userId, emailAtRequest: doc.emailAtRequest, status: doc.status, createdAt: doc.createdAt, decidedAt: doc.decidedAt,
    })),
  };
}

export interface DeletedPersonRecords {
  readonly requests: number;
  /** Open invitations and removed seats. */
  readonly seats: number;
  readonly conversations: number;
  readonly liveTurns: number;
}

/**
 * Person deletion (spec 10.7 step 3): their access requests, their open invitations in every organization, their
 * removed seats, their tuning chat conversations, live turns and proposal records, and their welcome markers, in every
 * organization (the notes they saved from proposals stay with the organization, as every note does). Never an active
 * seat: the handler refuses a person who holds one. An address with no kit user has only invitations. Deletes by
 * filter, so a retry completes the work. (U9: tw_agent_answers holds no person id, so nothing of it is the person's.)
 */
export async function deletePersonRecords(
  connection: Connection,
  person: { readonly userId: string | null; readonly email: string },
): Promise<DeletedPersonRecords> {
  const Member = memberModel(connection);
  const invites = (await Member.deleteMany({ inviteEmail: person.email, status: 'invited' })).deletedCount;
  const { userId } = person;
  if (userId === null) return { requests: 0, seats: invites, conversations: 0, liveTurns: 0 };
  const requests = (await accessRequestModel(connection).deleteMany({ userId })).deletedCount;
  const removed = (await Member.deleteMany({ userId, status: 'removed' })).deletedCount;
  const conversations = (await chatConversationModel(connection).deleteMany({ userId })).deletedCount;
  const liveTurns = (await chatLiveTurnModel(connection).deleteMany({ userId })).deletedCount;
  await chatProposalModel(connection).deleteMany({ userId });
  // U11: the welcome markers, in every organization. Not counted, so the audit details are unchanged.
  await welcomeModel(connection).deleteMany({ userId });
  return { requests, seats: invites + removed, conversations, liveTurns };
}

/** An import the file reader claimed. Only access/policy.ts's scopeForClaimedImport turns it into an OrgScope. */
export interface ClaimedImport {
  readonly id: string;
  readonly orgId: string;
  readonly locationId: string;
}

/**
 * The file reader's claim (spec 11A), across organizations: the oldest started import that is queued with no live
 * lease, or reading under a lease that ran out (its replica stopped). The claim takes the lease for `leaseMs`.
 */
export async function claimNextImport(
  connection: Connection,
  input: { readonly owner: string; readonly now: Date; readonly leaseMs: number },
): Promise<ClaimedImport | null> {
  const doc = await importModel(connection).findOneAndUpdate(
    { status: trusted({ $in: ['queued', 'reading'] }), $or: [{ lease: null }, { 'lease.until': trusted({ $lt: input.now }) }] },
    { $set: { status: 'reading', lease: { owner: input.owner, until: new Date(input.now.getTime() + input.leaseMs) }, claimedAt: input.now } },
    { sort: { startedAt: 1, _id: 1 }, returnDocument: 'after' },
  ).lean();
  if (doc === null) return null;
  return { id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString() };
}
