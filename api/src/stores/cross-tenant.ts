// Operations keyed by a person, or spanning organizations (spec 6.10 rule 8). The list is closed:
// findActiveSeat, findOpenInvites, claimInvite, declineInvite, latestRemovedSeat, adminOrgStats, peopleRecords,
// deletePersonRecords, the forecast lab's findLabCallback, the file reader's claimNextImport, and the daily file sweep's claimFileSweep, finishFileSweep,
// sweepCandidates, removeOldUploadDays and existingFileIds.
// Only access/resolve.ts, the join and decline handlers, the staff handlers (admin.ts, deletion.ts), the file reader
// (files/worker.ts), the file sweeper (files/sweeper.ts) and the lab job's callback (lab/callback.ts) import this file
// (test/isolation.test.ts enforces the list).
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { trusted, Types, type Connection } from 'mongoose';

import type { Role } from '../access/resolve.ts';
import { accessRequestModel, type AccessRequestStatus } from './access-requests.ts';
import { calibrationModel, LIVE_STATUSES } from './calibrations.ts';
import { chatConversationModel } from './chat-conversations.ts';
import { chatLiveTurnModel } from './chat-live-turns.ts';
import { chatProposalModel } from './chat-proposals.ts';
import { fileModel, type FileStatus } from './files.ts';
import { fileSweepModel } from './file-sweeps.ts';
import { forecastRunModel } from './forecasts.ts';
import { importModel } from './imports.ts';
import { locationModel } from './locations.ts';
import { memberModel } from './members.ts';
import { orgModel } from './orgs.ts';
import { HAS_VALUE, SALES_DAYS_COLLECTION } from './sales-days.ts';
import { uploadDayModel } from './upload-days.ts';
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
 * organization (the notes they saved from proposals stay with the organization, as every note does). Their staff id
 * is cleared from the forecast runs they imported or published (U13B), and their id from the calibrations they started
 * and from the forecasts switch they last set (the forecast lab). Never an active
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
  // D23: these removed seats can be all that says anyone joined an organization with no `firstJoinedAt` (one from
  // before the field, or one whose join stopped before marking it). Each such organization is marked first, with the
  // person's earliest join there, so deleting the seats never reopens staff setup, even if the delete never runs.
  const joined = await Member.aggregate<{ _id: Types.ObjectId; first: Date }>([
    { $match: { userId, status: 'removed', joinedAt: { $ne: null } } },
    { $group: { _id: '$orgId', first: { $min: '$joinedAt' } } },
  ]);
  for (const row of joined) {
    await orgModel(connection).updateOne({ _id: row._id, firstJoinedAt: trusted({ $exists: false }) }, { $set: { firstJoinedAt: row.first } });
  }
  const removed = (await Member.deleteMany({ userId, status: 'removed' })).deletedCount;
  const conversations = (await chatConversationModel(connection).deleteMany({ userId })).deletedCount;
  const liveTurns = (await chatLiveTurnModel(connection).deleteMany({ userId })).deletedCount;
  await chatProposalModel(connection).deleteMany({ userId });
  // U11: the welcome markers, in every organization. Not counted, so the audit details are unchanged.
  await welcomeModel(connection).deleteMany({ userId });
  // U13B: a staff member's id on the forecast runs they imported or published, in every organization. Not counted.
  await forecastRunModel(connection).updateMany({ importedBy: userId }, { $set: { importedBy: null } });
  await forecastRunModel(connection).updateMany({ publishedBy: userId }, { $set: { publishedBy: null } });
  // The forecast lab: the person who asked for a calibration, in every organization. Not counted.
  await calibrationModel(connection).updateMany({ 'requestedBy.userId': userId }, { $set: { 'requestedBy.userId': null } });
  // And the staff member who last switched an organization's forecasts, in every organization; the switch stays as it is.
  await orgModel(connection).updateMany({ 'forecasts.by': userId }, { $set: { 'forecasts.by': null } });
  return { requests, seats: invites + removed, conversations, liveTurns };
}

/** A calibration the forecast lab's job called back about. Only access/policy.ts's scopeForLabCallback turns it into an OrgScope. */
export interface LabCallbackClaim {
  readonly calibrationId: string;
  readonly orgId: string;
  readonly locationId: string;
}

/**
 * The lab job's callback (docs: forecast lab), across organizations: the calibration with this id whose stored token
 * hash matches, that is still live, and whose token has not expired. Null for anything else, so the route answers 404
 * alike for an unknown id, a wrong or expired token and a finished calibration.
 */
export async function findLabCallback(
  connection: Connection, calibrationId: string, tokenSha256: string, now: Date,
): Promise<LabCallbackClaim | null> {
  if (!Types.ObjectId.isValid(calibrationId) || calibrationId.length !== 24) return null;
  const doc = await calibrationModel(connection).findOne({
    _id: new Types.ObjectId(calibrationId),
    tokenSha256,
    status: trusted({ $in: [...LIVE_STATUSES] }),
    tokenExpiresAt: trusted({ $gt: now }),
  }).lean();
  if (doc === null) return null;
  return { calibrationId: doc._id.toHexString(), orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString() };
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

const SWEEP_ID = 'sweeper';

/**
 * The daily file sweep's lease (spec 11A, 6.14): true when this replica holds it now. Taken only when no other holds a
 * live lease and the last sweep finished `everyMs` or more ago; the first sweep ever creates the document.
 */
export async function claimFileSweep(
  connection: Connection, input: { readonly owner: string; readonly now: Date; readonly leaseMs: number; readonly everyMs: number },
): Promise<boolean> {
  const Sweep = fileSweepModel(connection);
  const until = new Date(input.now.getTime() + input.leaseMs);
  const claimed = await Sweep.findOneAndUpdate(
    {
      _id: SWEEP_ID, leaseUntil: trusted({ $lt: input.now }),
      $or: [{ lastRunAt: null }, { lastRunAt: trusted({ $lte: new Date(input.now.getTime() - input.everyMs) }) }],
    },
    { $set: { owner: input.owner, leaseUntil: until } },
  ).lean();
  if (claimed !== null) return true;
  try {
    await Sweep.create({ _id: SWEEP_ID, owner: input.owner, leaseUntil: until, lastRunAt: null });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

/** The sweep is done: the next one is due `everyMs` from now. */
export async function finishFileSweep(connection: Connection, input: { readonly owner: string; readonly now: Date }): Promise<void> {
  await fileSweepModel(connection).updateOne({ _id: SWEEP_ID, owner: input.owner }, { $set: { lastRunAt: input.now, leaseUntil: input.now } });
}

/** A file the sweep acts on. Only access/policy.ts's scopeForSweep turns it into an OrgScope. */
export interface SweptFile {
  readonly id: string;
  readonly orgId: string;
  readonly locationId: string;
}

/** An import never sent for reading. */
export interface SweptImport {
  readonly id: string;
  readonly orgId: string;
  readonly locationId: string;
}

export interface SweepCandidates {
  /** Upload sessions past their expiry. */
  readonly expiredUploads: readonly SweptFile[];
  /** Originals uploaded before `originalsBefore`, still stored, of files not uploading or being read. */
  readonly expiredOriginals: readonly SweptFile[];
  /** Files a staff purge flagged while they were uploading or being read, now neither. */
  readonly purges: readonly SweptFile[];
  /** Imports still open whose last drop was before `dropsBefore`. */
  readonly abandonedImports: readonly SweptImport[];
}

/** Every status but uploading, reading and deleting: a file whose original the sweep may delete (files/remove.ts). */
const SWEEPABLE: FileStatus[] = ['stored', 'queued', 'waiting', 'read', 'kept', 'failed'];

/** What the daily sweep has to do, across organizations, `limit` of each at most. */
export async function sweepCandidates(
  connection: Connection, input: { readonly now: Date; readonly originalsBefore: Date; readonly dropsBefore: Date; readonly limit: number },
): Promise<SweepCandidates> {
  const File = fileModel(connection);
  const file = (doc: { _id: Types.ObjectId; orgId: Types.ObjectId; locationId: Types.ObjectId }): SweptFile => ({
    id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString(),
  });
  const [expiredUploads, expiredOriginals, purges, abandonedImports] = await Promise.all([
    File.find({ status: 'uploading', 'upload.expiresAt': trusted({ $lte: input.now }) }).limit(input.limit).lean(),
    File.find({ rawDeletedAt: null, uploadedAt: trusted({ $lt: input.originalsBefore }), status: trusted({ $in: SWEEPABLE }) }).limit(input.limit).lean(),
    File.find({ purgeRaw: true, rawDeletedAt: null, status: trusted({ $in: SWEEPABLE }) }).limit(input.limit).lean(),
    importModel(connection).find({ status: 'open', lastDropAt: trusted({ $lt: input.dropsBefore }) }).limit(input.limit).lean(),
  ]);
  return {
    expiredUploads: expiredUploads.map(file),
    expiredOriginals: expiredOriginals.map(file),
    purges: purges.map(file),
    abandonedImports: abandonedImports.map((doc) => ({ id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString() })),
  };
}

/** Daily upload counters for days before `beforeDay` (YYYY-MM-DD), every organization's. Resolves the number deleted. */
export async function removeOldUploadDays(connection: Connection, beforeDay: string): Promise<number> {
  return (await uploadDayModel(connection).deleteMany({ day: trusted({ $lt: beforeDay }) })).deletedCount;
}

/** Which of `ids` (file ids) still have a row, in any organization: the orphan check for blobs. */
export async function existingFileIds(connection: Connection, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const docs = await fileModel(connection).find({ _id: trusted({ $in: ids.map((id) => new Types.ObjectId(id)) }) }, { _id: 1 }).lean();
  return new Set(docs.map((doc) => doc._id.toHexString()));
}
