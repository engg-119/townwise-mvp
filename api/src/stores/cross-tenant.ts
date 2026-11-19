// Operations keyed by a person, or spanning organizations (spec 6.10 rule 8). The list is closed:
// findActiveSeat, findOpenInvites, claimInvite, declineInvite, latestRemovedSeat, adminOrgStats, peopleRecords,
// deletePersonRecords, the forecast lab's findLabCallback, the file reader's claimNextImport, the TownwiseAI reader's
// claimNextAiRead, the daily file sweep's claimFileSweep, finishFileSweep, sweepCandidates, removeOldUploadDays and
// existingFileIds, the calendar refresh loop's claimDueCalendar and claimDueGoogleConnection, Google access's
// hasGoogleConnectionElsewhere and googleConnectionsOfPerson (openspec change connect-google-calendar, design decisions
// 10 and 11), the weekly refresh's weeklyCandidates, liveScheduledCalibrations, staleStartingWeeks and
// countedWeekRows (D42), the weekly suggestions' suggestionCandidates and staleSuggestionPasses (openspec change
// weekly-forecast-suggestions), the active days recorder's removeOldActivityDays, the staff Overview's
// activityDaysSince, peopleActionsSince, openInvitesBefore and chatUsageForMonth (openspec change staff-overview), the
// TownwiseAI turn sweep's staleChatTurns and removeEndedChatTurns (openspec change resumable-chat-turns), and the
// boot-time title backfill's untitledAiNotes (D49).
// Only access/resolve.ts, the active days recorder (access/activity.ts), the join and decline handlers, the staff
// handlers (admin.ts, deletion.ts, overview.ts), the TownwiseAI turn sweep (chat/turn-sweeper.ts), the file reader (files/worker.ts), the TownwiseAI reader (files/ai-reader.ts), the file sweeper (files/sweeper.ts), the lab job's
// callback (lab/callback.ts), the calendar refresh loop (calendar/refresher.ts), Google access
// (calendar/google-access.ts), the weekly refresh (lab/schedule.ts, which also runs the weekly suggestions), the
// TownwiseAI turn sweep (chat/turn-sweeper.ts) and the title backfill (files/note-titles.ts) import this file
// (test/isolation.test.ts enforces the list).
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { trusted, Types, type Connection } from 'mongoose';

import type { Role } from '../access/resolve.ts';
import { accessRequestModel, type AccessRequestStatus } from './access-requests.ts';
import { activityDayModel } from './activity-days.ts';
import { agentSuggestionModel, suggestionPassModel } from './agent-suggestions.ts';
import { auditEventModel, type AuditAction } from './audit-events.ts';
import { calibrationModel, LIVE_STATUSES } from './calibrations.ts';
import { chatConversationModel } from './chat-conversations.ts';
import { chatLiveTurnModel } from './chat-live-turns.ts';
import { chatProposalModel } from './chat-proposals.ts';
import { chatTurnModel } from './chat-turns.ts';
import { chatUsageModel } from './chat-usage.ts';
import { fileModel, type FileStatus } from './files.ts';
import { fileSweepModel } from './file-sweeps.ts';
import { DELETED_PERSON } from '../people.ts';
import { forecastScheduleModel } from './forecast-schedule.ts';
import { COUNTED_WEEK_STATUSES, forecastWeekModel } from './forecast-weeks.ts';
import { forecastRunModel } from './forecasts.ts';
import { googleConnectionModel } from './google-connections.ts';
import { importModel } from './imports.ts';
import { locationModel } from './locations.ts';
import { noteModel } from './notes.ts';
import { memberModel } from './members.ts';
import { orderCardModel } from './orders.ts';
import { orgModel } from './orgs.ts';
import { calendarSourceModel } from './owner-calendars.ts';
import { profileModel } from './profiles.ts';
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
 * removed seats, their tuning chat conversations, live turns, turn records, proposal records and order cards, their welcome markers
 * and their Google connections for calendars, in every organization, and their display name (the notes they saved from proposals stay with the organization, as every note does). Their staff id
 * is cleared from the forecast runs they imported or published (U13B), and their id from the calibrations they started
 * and from the forecasts switch they last set (the forecast lab), and from the weekly suggestions switch they last set
 * and the suggestions they decided, and from the file calendars whose bookings they confirmed (D58). Their active days go
 * too, in every organization (staff-overview). Never an active
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
  // Order cards hold no person id, so they go by the person's conversations, before those, so a retry still finds
  // them. Not counted, so the audit details are unchanged.
  const owned = await chatConversationModel(connection).find({ userId }, { _id: 1, orgId: 1 }).lean();
  if (owned.length > 0) {
    await orderCardModel(connection).deleteMany({
      // The organization too, so the delete uses the cards' index, which leads with it.
      orgId: trusted({ $in: owned.map((doc) => doc.orgId) }),
      conversationId: trusted({ $in: owned.map((doc) => doc._id) }),
    });
  }
  const conversations = (await chatConversationModel(connection).deleteMany({ userId })).deletedCount;
  const liveTurns = (await chatLiveTurnModel(connection).deleteMany({ userId })).deletedCount;
  await chatProposalModel(connection).deleteMany({ userId });
  // resumable-chat-turns: their turns' records, in every organization, so a turn still running ends at its next write.
  // Not counted, so the audit details are unchanged.
  await chatTurnModel(connection).deleteMany({ userId });
  // U11: the welcome markers, in every organization. Not counted, so the audit details are unchanged.
  await welcomeModel(connection).deleteMany({ userId });
  // The display name (spec 6.22). Not counted, so the audit details are unchanged.
  await profileModel(connection).deleteMany({ userId });
  // U13B: a staff member's id on the forecast runs they imported or published, in every organization. Not counted.
  await forecastRunModel(connection).updateMany({ importedBy: userId }, { $set: { importedBy: null } });
  await forecastRunModel(connection).updateMany({ publishedBy: userId }, { $set: { publishedBy: null } });
  // The forecast lab: the person who asked for a calibration, in every organization. Not counted.
  await calibrationModel(connection).updateMany({ 'requestedBy.userId': userId }, { $set: { 'requestedBy.userId': null } });
  // And the staff member who last switched an organization's forecasts, in every organization; the switch stays as it is.
  await orgModel(connection).updateMany({ 'forecasts.by': userId }, { $set: { 'forecasts.by': null } });
  // Weekly suggestions: the org admin who last turned them on or off, and who accepted or dismissed a suggestion. The
  // switch and the decisions stay. Not counted.
  await orgModel(connection).updateMany({ 'weeklySuggestions.by': userId }, { $set: { 'weeklySuggestions.by': null } });
  // And who last switched sending calendar event titles to TownwiseAI (calendar-event-suggestions). Not counted.
  await orgModel(connection).updateMany({ 'calendarTitlesToAi.by': userId }, { $set: { 'calendarTitlesToAi.by': null } });
  // D59: who last switched TownwiseAI working on its own; the switch stays. Not counted.
  await orgModel(connection).updateMany({ 'agentAuto.by': userId }, { $set: { 'agentAuto.by': null } });
  await agentSuggestionModel(connection).updateMany({ decidedBy: userId }, { $set: { decidedBy: null } });
  // D58: the org admin who confirmed a file calendar's bookings; the confirmation stays. Not counted.
  await calendarSourceModel(connection).updateMany({ 'bookings.confirmedBy': userId }, { $set: { 'bookings.confirmedBy': null } });
  // D42: the staff member who paused the weekly refresh, on its one schedule document; the pause stays. Not counted.
  await forecastScheduleModel(connection).updateOne({ 'paused.by': userId }, { $set: { 'paused.by': null, 'paused.email': DELETED_PERSON } });
  // Google access for calendars (connect-google-calendar): the handler has already ended any still found, revoking
  // each; this is the backstop for one left by a crash. Not counted, so the audit details are unchanged.
  await googleConnectionModel(connection).deleteMany({ userId });
  // The days they used the app, in every organization (openspec change staff-overview). Not counted, so the audit
  // details are unchanged.
  await activityDayModel(connection).deleteMany({ userId });
  return { requests, seats: invites + removed, conversations, liveTurns };
}

/** A calibration the forecast lab's job called back about. Only access/policy.ts's scopeForLabCallback turns it into an OrgScope. */
export interface LabCallbackClaim {
  readonly calibrationId: string;
  readonly orgId: string;
  readonly locationId: string;
}

/**
 * The lab job's callback (lab/callback.ts), across organizations, once the caller signed in as the lab identity: the
 * calibration with this id that is still live and whose 20-minute callback window is open, and, for a result
 * (`resultTokenSha256` not null), whose stored result token hash matches. Null for anything else, so the route answers
 * 404 alike for an unknown id, a wrong result token, a closed window and a finished calibration.
 */
export async function findLabCallback(
  connection: Connection, calibrationId: string, now: Date, resultTokenSha256: string | null,
): Promise<LabCallbackClaim | null> {
  if (!Types.ObjectId.isValid(calibrationId) || calibrationId.length !== 24) return null;
  const doc = await calibrationModel(connection).findOne({
    _id: new Types.ObjectId(calibrationId),
    ...(resultTokenSha256 === null ? {} : { tokenSha256: resultTokenSha256 }),
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

/**
 * A file the TownwiseAI reader claimed (spec 11A.9). Only access/policy.ts's scopeForClaimedAiRead turns it into an
 * OrgScope. `attempt` is the claim's token: the attempt count it set, which every later write under it matches.
 */
export interface ClaimedAiRead {
  readonly id: string;
  readonly orgId: string;
  readonly locationId: string;
  readonly attempt: number;
}

/**
 * The TownwiseAI reader's claim (spec 11A.9), across organizations: the file whose read was asked for first that is
 * `queued` (and past its `notBefore`, when an attempt put it back), or `reading` under a lease that ran out (its replica
 * stopped), leaving out a suspended organization's (they wait until it is active again), files being deleted, and every
 * read of an organization that has one `reading` under a live lease, so one organization never holds two replicas'
 * readers at once. The claim sets `reading`, the lease for `leaseMs`, the start, and counts the attempt.
 */
export async function claimNextAiRead(
  connection: Connection, input: { readonly now: Date; readonly leaseMs: number },
): Promise<ClaimedAiRead | null> {
  const File = fileModel(connection);
  const [held, busy] = await Promise.all([
    orgModel(connection).find({ status: trusted({ $ne: 'active' }) }, { _id: 1 }).lean(),
    File.distinct('orgId', { 'ai.status': 'reading', 'ai.leaseUntil': trusted({ $gte: input.now }) }),
  ]);
  const skipped = [...held.map((org) => org._id), ...busy];
  const doc = await File.findOneAndUpdate(
    {
      $or: [
        { 'ai.status': 'queued', 'ai.notBefore': trusted({ $not: { $gt: input.now } }) },
        { 'ai.status': 'reading', 'ai.leaseUntil': trusted({ $lt: input.now }) },
      ],
      status: trusted({ $ne: 'deleting' }),
      ...(skipped.length === 0 ? {} : { orgId: trusted({ $nin: skipped }) }),
    },
    {
      $set: { 'ai.status': 'reading', 'ai.leaseUntil': new Date(input.now.getTime() + input.leaseMs), 'ai.startedAt': input.now },
      $inc: { 'ai.attempts': 1 },
    },
    // D59: a pressed read (no `ai.auto`, which sorts first) before automatic ones, so a burst never makes a press wait.
    { sort: { 'ai.auto': 1, 'ai.requestedAt': 1, _id: 1 }, returnDocument: 'after' },
  ).lean();
  if (doc?.ai === undefined) return null;
  return { id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString(), attempt: doc.ai.attempts };
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

/**
 * Active days dated before `beforeDay` (YYYY-MM-DD), every organization's (openspec change staff-overview, design
 * decision 3): the recorder's daily removal. Resolves the number deleted.
 */
export async function removeOldActivityDays(connection: Connection, beforeDay: string): Promise<number> {
  return (await activityDayModel(connection).deleteMany({ day: trusted({ $lt: beforeDay }) })).deletedCount;
}

/** An active day as the staff Overview reads it (staff-overview): ids and the date only. */
export interface ActivityDayRow {
  readonly orgId: string;
  readonly userId: string;
  readonly day: string;
}

/** Every organization's active days from `day` (YYYY-MM-DD) on, for the staff Overview. Ids and dates only. */
export async function activityDaysSince(connection: Connection, day: string): Promise<ActivityDayRow[]> {
  const docs = await activityDayModel(connection).find({ day: trusted({ $gte: day }) }, { orgId: 1, userId: 1, day: 1 }).lean();
  return docs.map((doc) => ({ orgId: doc.orgId.toHexString(), userId: doc.userId, day: doc.day }));
}

/** One of people's actions as the staff Overview counts it: its organization, action and time only. */
export interface PeopleAction {
  readonly orgId: string;
  readonly action: AuditAction;
  readonly at: Date;
}

/**
 * People's actions since `at`, every organization's (openspec change staff-overview, design decision 4): events whose
 * actor is a member or an org admin, and staff setup's sales uploads (`sales.uploaded` by staff with no view-as or
 * open-as-admin grant, D23), which the owner counts as uploads. Never another staff event (staff opened as admin always
 * carry their grant's id), a view-as or the system's.
 */
export async function peopleActionsSince(connection: Connection, at: Date): Promise<PeopleAction[]> {
  const docs = await auditEventModel(connection).find(
    {
      at: trusted({ $gte: at }), orgId: trusted({ $ne: null }),
      $or: [
        { actorRole: trusted({ $in: ['member', 'org_admin'] }) },
        { action: 'sales.uploaded', actorRole: 'superadmin', viewAsGrantId: null },
      ],
    },
    { orgId: 1, action: 1, at: 1 },
  ).lean();
  return docs.flatMap((doc) => (doc.orgId === null ? [] : [{ orgId: doc.orgId.toHexString(), action: doc.action, at: doc.at }]));
}

/** An organization's invitations still open: how many, and when the oldest was sent. */
export interface OpenInvites {
  readonly count: number;
  readonly oldest: Date;
}

/** Invitations still open that were sent before `before`, per organization, keyed by its id (the Overview's Needs attention). */
export async function openInvitesBefore(connection: Connection, before: Date): Promise<Map<string, OpenInvites>> {
  const rows = await memberModel(connection).aggregate<{ _id: Types.ObjectId; n: number; oldest: Date }>([
    { $match: { status: 'invited', invitedAt: { $lt: before } } },
    { $group: { _id: '$orgId', n: { $sum: 1 }, oldest: { $min: '$invitedAt' } } },
  ]);
  return new Map(rows.map((row) => [row._id.toHexString(), { count: row.n, oldest: row.oldest }]));
}

/** What the tuning chat has cost each organization in `month` (YYYY-MM, UTC), in micro-dollars, keyed by its id. */
export async function chatUsageForMonth(connection: Connection, month: string): Promise<Map<string, number>> {
  const docs = await chatUsageModel(connection).find({ month }, { orgId: 1, costMicroUsd: 1 }).lean();
  return new Map(docs.map((doc) => [doc.orgId.toHexString(), doc.costMicroUsd]));
}

/** Which of `ids` (file ids) still have a row, in any organization: the orphan check for blobs. */
export async function existingFileIds(connection: Connection, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const docs = await fileModel(connection).find({ _id: trusted({ $in: ids.map((id) => new Types.ObjectId(id)) }) }, { _id: 1 }).lean();
  return new Set(docs.map((doc) => doc._id.toHexString()));
}

/**
 * A link or Google calendar the refresh loop claimed, and its kind, which picks how it is read. Only access/policy.ts's
 * scopeForCalendarRefresh turns it into an OrgScope.
 */
export interface ClaimedCalendar {
  readonly calendarId: string;
  readonly orgId: string;
  readonly locationId: string;
  readonly kind: 'link' | 'google';
}

/**
 * The calendar refresh loop's claim (openspec change connect-owner-calendar, design decision 6), across organizations:
 * one link or Google calendar (connect-google-calendar, design decision 10) that is due (`nextRefreshAt` at or before
 * `now`) and under no live lease, the longest due first whatever its kind. One compare-and-set takes it and sets its
 * lease to `leaseUntil`, so of replicas claiming at once only one gets each calendar. Ids and the kind only: the
 * address, the Google calendar id, the host, label and events stay in the tenant store.
 */
export async function claimDueCalendar(
  connection: Connection, input: { readonly now: Date; readonly leaseUntil: Date },
): Promise<ClaimedCalendar | null> {
  const doc = await calendarSourceModel(connection).findOneAndUpdate(
    {
      kind: trusted({ $in: ['link', 'google'] }), nextRefreshAt: trusted({ $lte: input.now }),
      $or: [{ leaseUntil: null }, { leaseUntil: trusted({ $lt: input.now }) }],
    },
    { $set: { leaseUntil: input.leaseUntil } },
    { sort: { nextRefreshAt: 1, _id: 1 }, returnDocument: 'after', projection: { orgId: 1, locationId: 1, kind: 1 } },
  ).lean();
  if (doc === null) return null;
  return {
    calendarId: doc._id.toHexString(), orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString(),
    kind: doc.kind === 'google' ? 'google' : 'link',
  };
}

/**
 * A Google connection whose check the refresh loop claimed. Only access/policy.ts's scopeForGoogleCheck turns it into
 * an OrgScope.
 */
export interface ClaimedGoogleConnection {
  readonly connectionId: string;
  readonly orgId: string;
  /** The checkAt it was due at: the check pushes it on only while it is still this (a mark since keeps it due). */
  readonly checkAt: Date;
}

/**
 * The refresh loop's claim of a connection check (openspec change connect-google-calendar, design decision 10), across
 * organizations: one Google connection that is due (`checkAt` at or before `now`) and under no live lease, the longest
 * due first. One compare-and-set takes it and sets its lease to `leaseUntil`, so of replicas claiming at once only one
 * checks each connection. Ids and the checkAt it claimed only: the sealed token, the person and the scopes stay in the
 * tenant store.
 */
export async function claimDueGoogleConnection(
  connection: Connection, input: { readonly now: Date; readonly leaseUntil: Date },
): Promise<ClaimedGoogleConnection | null> {
  const doc = await googleConnectionModel(connection).findOneAndUpdate(
    { checkAt: trusted({ $lte: input.now }), $or: [{ leaseUntil: null }, { leaseUntil: trusted({ $lt: input.now }) }] },
    { $set: { leaseUntil: input.leaseUntil } },
    { sort: { checkAt: 1, _id: 1 }, returnDocument: 'after', projection: { orgId: 1, checkAt: 1 } },
  ).lean();
  if (doc === null) return null;
  return { connectionId: doc._id.toHexString(), orgId: doc.orgId.toHexString(), checkAt: doc.checkAt };
}

/** A person's Google connection for calendars in some organization. Ids only: never the sealed token. */
export interface PersonGoogleConnection {
  readonly id: string;
  readonly orgId: string;
}

/**
 * Whether the person holds a Google connection for calendars in an organization other than `orgId` (openspec change
 * connect-google-calendar, design decision 11): Google's revoke ends every grant the account gave the project, so a
 * connection ended in one organization is revoked only when this is false. Ids only.
 */
export async function hasGoogleConnectionElsewhere(connection: Connection, userId: string, orgId: string): Promise<boolean> {
  const found = await googleConnectionModel(connection).exists({ userId, orgId: trusted({ $ne: new Types.ObjectId(orgId) }) });
  return found !== null;
}

/** Every Google connection the person still holds, in any organization, oldest first: the person deletion's backstop. */
export async function googleConnectionsOfPerson(connection: Connection, userId: string): Promise<PersonGoogleConnection[]> {
  const docs = await googleConnectionModel(connection).find({ userId }, { _id: 1, orgId: 1 }).sort({ connectedAt: 1, _id: 1 }).lean();
  return docs.map((doc) => ({ id: doc._id.toHexString(), orgId: doc.orgId.toHexString() }));
}

/**
 * A location the weekly refresh considers (D42). Only access/policy.ts's scopeForWeeklyRefresh turns it into an
 * OrgScope; the location itself is then read through the tenant store.
 */
export interface WeeklyCandidate {
  readonly orgId: string;
  readonly locationId: string;
}

/**
 * The weekly refresh's candidates, across organizations: every location of an active organization whose forecasts are
 * on (G1), an organization with no `forecasts` field counting as on (D42, owner directive 2026-11-16). Ids only, oldest
 * location first. Nothing here names a town, an organization or a location.
 */
export async function weeklyCandidates(connection: Connection): Promise<WeeklyCandidate[]> {
  const orgs = await orgModel(connection).find(
    { status: 'active', $or: [{ forecasts: trusted({ $exists: false }) }, { forecasts: null }, { 'forecasts.on': true }] },
    { _id: 1 },
  ).lean();
  if (orgs.length === 0) return [];
  const docs = await locationModel(connection).find({ orgId: trusted({ $in: orgs.map((org) => org._id) }) }, { _id: 1, orgId: 1 })
    .sort({ createdAt: 1, _id: 1 }).lean();
  return docs.map((doc) => ({ orgId: doc.orgId.toHexString(), locationId: doc._id.toHexString() }));
}

/**
 * The weekly suggestions' candidates (openspec change weekly-forecast-suggestions), across organizations: every location
 * of an active organization whose weekly suggestions are on, an organization with no `weeklySuggestions` field counting
 * as on (owner directive 2026-11-16). The forecasts switch (G1) does not apply: a suggestion changes no forecast until a
 * person accepts it. Ids only, oldest location first; scoped by access/policy.ts's scopeForWeeklyRefresh.
 */
export async function suggestionCandidates(connection: Connection): Promise<WeeklyCandidate[]> {
  const orgs = await orgModel(connection).find(
    { status: 'active', $or: [{ weeklySuggestions: trusted({ $exists: false }) }, { weeklySuggestions: null }, { 'weeklySuggestions.on': true }] },
    { _id: 1 },
  ).lean();
  if (orgs.length === 0) return [];
  const docs = await locationModel(connection).find({ orgId: trusted({ $in: orgs.map((org) => org._id) }) }, { _id: 1, orgId: 1 })
    .sort({ createdAt: 1, _id: 1 }).lean();
  return docs.map((doc) => ({ orgId: doc.orgId.toHexString(), locationId: doc._id.toHexString() }));
}

/** A live calibration the weekly refresh started, in any organization (ids and when it was asked for). */
export interface LiveScheduledCalibration {
  readonly id: string;
  readonly orgId: string;
  readonly locationId: string;
  readonly requestedAt: Date;
}

/** Every live (queued or running) calibration requested by the system (D42), for the live cap of 3. */
export async function liveScheduledCalibrations(connection: Connection): Promise<LiveScheduledCalibration[]> {
  const docs = await calibrationModel(connection).find(
    { 'requestedBy.role': 'system', status: trusted({ $in: [...LIVE_STATUSES] }) },
    { _id: 1, orgId: 1, locationId: 1, requestedAt: 1 },
  ).lean();
  return docs.map((doc) => ({
    id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString(), requestedAt: doc.requestedAt,
  }));
}

/** A week row left `starting` (D42): its holder died between the insert and the start, or before resolving it. */
export interface StaleStartingWeek {
  readonly id: string;
  readonly orgId: string;
  readonly locationId: string;
  readonly createdAt: Date;
}

/** Week rows still `starting` that were written before `before` (the lease's length ago), in any organization. */
export async function staleStartingWeeks(connection: Connection, before: Date): Promise<StaleStartingWeek[]> {
  const docs = await forecastWeekModel(connection).find(
    { status: 'starting', createdAt: trusted({ $lt: before }) },
    { _id: 1, orgId: 1, locationId: 1, createdAt: 1 },
  ).lean();
  return docs.map((doc) => ({
    id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString(), createdAt: doc.createdAt,
  }));
}

/** A weekly suggestions pass row left `running` (its pass died mid-call or before it): ids and its week. */
export interface StaleSuggestionPass {
  readonly orgId: string;
  readonly locationId: string;
  readonly week: string;
}

/**
 * Weekly suggestions pass rows still `running` that were last written before `before` (a lease's length ago), in any
 * organization (openspec change weekly-forecast-suggestions): what the weekly pass resolves and refunds.
 */
export async function staleSuggestionPasses(connection: Connection, before: Date): Promise<StaleSuggestionPass[]> {
  const docs = await suggestionPassModel(connection).find(
    { status: 'running', updatedAt: trusted({ $lt: before }) }, { orgId: 1, locationId: 1, week: 1 },
  ).lean();
  return docs.map((doc) => ({ orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString(), week: doc.week }));
}

/** A note TownwiseAI made from a file before notes had titles (D49): its id, organization and file. */
export interface UntitledAiNote { readonly id: string; readonly orgId: string; readonly fileId: string; readonly detail: string | null }

/**
 * The title backfill's lookup (D49): every note, in any organization, made by TownwiseAI from a file (`source` set)
 * with no `title` key. Every write since titles stores one, null included, so only notes from before are found.
 */
export async function untitledAiNotes(connection: Connection): Promise<UntitledAiNote[]> {
  const docs = await noteModel(connection).find(
    { 'source.fileId': trusted({ $exists: true }), title: trusted({ $exists: false }) }, { orgId: 1, source: 1, detail: 1 },
  ).lean();
  return docs.flatMap((doc) => (doc.source === undefined ? [] : [{
    id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), fileId: doc.source.fileId.toHexString(), detail: doc.detail ?? null,
  }]));
}

/** The weekly cap's count (D42): week rows of `week` that are `starting` or `started`, across organizations. */
export async function countedWeekRows(connection: Connection, week: string): Promise<number> {
  return forecastWeekModel(connection).countDocuments({ week, status: trusted({ $in: [...COUNTED_WEEK_STATUSES] }) });
}

/**
 * A running TownwiseAI turn whose lease has passed (its replica died, or shut down without settling it), or one the
 * sweep ended as interrupted whose claims it has yet to release.
 */
export interface StaleChatTurn {
  readonly orgId: string;
  readonly locationId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly turnId: string;
}

/**
 * The TownwiseAI turn sweep (chat/turn-sweeper.ts, openspec change resumable-chat-turns): running records in any
 * organization whose lease passed before `now`, and interrupted ones the sweep has yet to release the claims of, oldest
 * lease first, at most `limit`. Ids only, never the events.
 */
export async function staleChatTurns(connection: Connection, now: Date, limit: number): Promise<StaleChatTurn[]> {
  const stale = { $or: [{ state: 'running' as const, leaseUntil: trusted({ $lt: now }) }, { state: 'interrupted' as const, releasePending: true }] };
  const docs = await chatTurnModel(connection)
    .find(stale, { orgId: 1, locationId: 1, conversationId: 1, userId: 1, turnId: 1 })
    .sort({ leaseUntil: 1 }).limit(limit).lean();
  return docs.map((doc) => ({
    orgId: doc.orgId.toHexString(), locationId: doc.locationId.toHexString(), conversationId: doc.conversationId.toHexString(),
    userId: doc.userId, turnId: doc.turnId,
  }));
}

/** The TownwiseAI turn sweep: deletes every record, in any organization, whose turn ended at or before `before`. */
export async function removeEndedChatTurns(connection: Connection, before: Date): Promise<number> {
  return (await chatTurnModel(connection).deleteMany({ endedAt: trusted({ $lte: before }) })).deletedCount;
}
