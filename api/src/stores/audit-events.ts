import { Schema, trusted, type Connection, type Model, type Types } from 'mongoose';

/** Each action and the only detail keys it may carry (spec 9.2). Never figures, note text, request notes,
 *  decision messages, file names, file content or tokens. */
export const AUDIT_DETAIL_KEYS = {
  'access_request.created': ['orgName', 'townId', 'townName', 'hasPlace', 'placeCount'],
  'access_request.approved': ['orgId'],
  'access_request.rejected': ['hasMessage'],
  'access_request.withdrawn': ['reason'],
  'org.created': ['name', 'via'],
  'org.renamed': ['from', 'to'],
  'org.suspended': [],
  'org.reactivated': [],
  'org.deleted': [],
  'member.invited': ['email', 'role'],
  'member.declined': ['email'],
  'member.joined': ['email', 'role'],
  'member.role_changed': ['email', 'from', 'to'],
  'member.removed': ['email', 'wasStatus'],
  'member.left': ['email'],
  'location.created': ['name', 'townId', 'hasPlace'],
  'location.updated': ['name', 'townId', 'hasPlace'],
  'location.deleted': ['name', 'townId'],
  'sales.uploaded': ['locationId', 'dayCount', 'inserted', 'replaced', 'firstDate', 'lastDate', 'fileId', 'via'],
  'sales.deleted': ['locationId', 'deletedDays', 'deletedFiles'],
  // D28, Your data: `item` is 'upload' or 'file' and `kind` an item kind; never a file name or title.
  'sales.upload_deleted': ['locationId', 'deletedDays', 'deletedFiles'],
  'data.turned_off': ['locationId', 'item', 'kind'],
  'data.turned_on': ['locationId', 'item', 'kind'],
  // Stored files (spec 11A): never a file name or anything from a file.
  'file.uploaded': ['locationId', 'kind', 'sizeBytes', 'purpose', 'via'],
  'file.deleted': ['locationId', 'kind', 'reason'],
  'file.raw_deleted': ['locationId', 'kind'],
  'files.raw_deleted_all': ['locationId', 'count'],
  // Staff: an organization's originals purged for a deletion request. The basis is an enum, never free text.
  'org.originals_deleted': ['count', 'basis'],
  'note.created': ['locationId', 'kind', 'startDate', 'endDate'],
  'note.updated': ['locationId', 'kind', 'startDate', 'endDate'],
  'note.deleted': ['locationId', 'kind', 'startDate', 'endDate'],
  // Business rules (D31): ids and how the rule was added, never its text.
  'rule.created': ['locationId', 'via'],
  'rule.updated': ['locationId'],
  'rule.deleted': ['locationId'],
  'chat.turn_completed': ['locationId', 'conversationId', 'model', 'calls', 'inputTokens', 'outputTokens', 'stopReason'],
  'chat.conversation_deleted': ['locationId', 'conversationId'],
  // U9, TownwiseAI's questions: the question's id holds only dates and a weekday number.
  'agent.question_answered': ['locationId', 'questionId', 'answer'],
  // U13B, forecast runs (spec 14.4): ids, the model version, the dates and the day count, never a figure.
  'forecast.imported': ['locationId', 'modelVersion', 'from', 'to', 'dayCount'],
  'forecast.published': ['locationId', 'modelVersion', 'from', 'to', 'dayCount', 'via', 'calibrationId'],
  'forecast.withdrawn': ['locationId', 'modelVersion', 'from', 'to', 'dayCount'],
  'forecast.deleted': ['locationId', 'modelVersion', 'from', 'to', 'dayCount'],
  // The forecast lab: ids, codes and counts, never a figure.
  'calibration.requested': ['locationId', 'calibrationId', 'via', 'hasRegime'],
  'calibration.finished': ['locationId', 'calibrationId', 'status', 'gate', 'failure', 'runId', 'heldOutWeeks'],
  'org.forecasts_switched': ['on'],
  'view_as.started': ['targetUserId', 'targetEmail', 'reason', 'expiresAt'],
  'view_as.ended': ['endReason'],
  // D25, open as admin: ids only. The grant is the target and the organization the event's orgId; no name, email or reason.
  'open_as_admin.started': [],
  'open_as_admin.ended': ['endReason'],
  'people.signed_out_everywhere': [],
  'person.deleted': ['userId'],
  'staff_action.not_applied': ['eventId', 'code'],
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_DETAIL_KEYS;
export type AuditActorRole = 'superadmin' | 'org_admin' | 'member' | 'user' | 'system';
export type AuditTargetType =
  | 'org' | 'member' | 'request' | 'location' | 'upload' | 'note' | 'user' | 'grant' | 'conversation' | 'file'
  // U13B.
  | 'forecast_run'
  // The forecast lab.
  | 'calibration'
  // Business rules (D31).
  | 'rule';
export type AuditDetails = Record<string, string | number | boolean | null>;

export interface AuditEventFields {
  at: Date;
  actorUserId: string;
  actorEmail: string;
  actorRole: AuditActorRole;
  viewAsGrantId: string | null;
  orgId: Types.ObjectId | null;
  action: AuditAction;
  target: { type: AuditTargetType; id: string };
  details: AuditDetails;
}

function auditSchema(): Schema<AuditEventFields> {
  const target = new Schema({
    type: { type: String, required: true },
    id: { type: String, required: true },
  }, { _id: false, strict: true });
  const schema = new Schema<AuditEventFields>({
    at: { type: Date, required: true },
    actorUserId: { type: String, required: true },
    actorEmail: { type: String, required: true },
    actorRole: { type: String, required: true, enum: ['superadmin', 'org_admin', 'member', 'user', 'system'] },
    viewAsGrantId: { type: String, default: null },
    orgId: { type: Schema.Types.ObjectId, default: null },
    action: { type: String, required: true, enum: Object.keys(AUDIT_DETAIL_KEYS) },
    target: { type: target, required: true },
    details: { type: Schema.Types.Mixed, required: true },
  }, { strict: true, versionKey: false, read: 'primary', minimize: false });
  schema.index({ at: -1 });
  schema.index({ orgId: 1, at: -1 });
  schema.index({ actorUserId: 1, at: -1 });
  schema.index({ orgId: 1, actorRole: 1, at: -1 });
  return schema;
}

/** Registers TwAuditEvent (tw_audit_events) on first call. */
export function auditEventModel(connection: Connection): Model<AuditEventFields> {
  const existing = connection.models.TwAuditEvent as Model<AuditEventFields> | undefined;
  return existing ?? connection.model<AuditEventFields>('TwAuditEvent', auditSchema(), 'tw_audit_events');
}

export interface AuditEventInput {
  readonly at: Date;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly actorRole: AuditActorRole;
  readonly viewAsGrantId: string | null;
  readonly orgId: string | null;
  readonly action: AuditAction;
  readonly target: { readonly type: AuditTargetType; readonly id: string };
  readonly details: AuditDetails;
}

export interface AuditEventRecord extends AuditEventInput {
  readonly id: string;
}

export interface AuditQuery {
  readonly orgId?: string;
  readonly actorUserId?: string;
  /** One role, or any of several. */
  readonly actorRole?: AuditActorRole | readonly AuditActorRole[];
  readonly action?: AuditAction;
  /** Every action but this one; ignored when `action` is set. */
  readonly excludeAction?: AuditAction;
  /** Only events strictly before this time. */
  readonly before?: Date;
  readonly limit: number;
}

/** What a deletion's redaction writes in place of a person's email, an organization's name and its locations' names. */
export const REDACTED = { person: 'deleted person', org: 'deleted organization', location: 'deleted location' } as const;

export type Redaction =
  | {
    readonly kind: 'person'; readonly userId: string | null; readonly email: string;
    /** Older addresses the handler read from the person's seats and requests before deleting them. */
    readonly formerEmails: readonly string[];
    /** The person's seats (tw_members ids), so events about them are found whatever address they name. */
    readonly seatIds: readonly string[];
  }
  | { readonly kind: 'org'; readonly orgId: string; readonly requestId: string | null };

const LOCATION_ACTIONS: readonly AuditAction[] = ['location.created', 'location.updated', 'location.deleted'];
/** Actions a person records about their own seat or invitation: details.email is their own address at the time. */
const SELF_ACTIONS: readonly AuditAction[] = ['member.joined', 'member.left', 'member.declined'];

/** Append only, with one update path: `redact`, which only the deletion handlers call (spec 9.3). Nothing deletes an event. */
export interface AuditEventStore {
  /** Throws when details carry a key outside the action's allowlist. Resolves the event id. */
  insert(event: AuditEventInput): Promise<string>;
  /**
   * Newest first. A full page also carries every event that shares its last event's time, so the next page,
   * read from `nextBefore` (that time), skips none. `nextBefore` is null when no older event matches.
   */
  query(query: AuditQuery): Promise<{ events: AuditEventRecord[]; nextBefore: Date | null }>;
  /** The staff_action.not_applied events that qualify any of these events. */
  findNotApplied(eventIds: readonly string[]): Promise<AuditEventRecord[]>;
  /** The view_as.started events of these grants. */
  findStarted(grantIds: readonly string[]): Promise<AuditEventRecord[]>;
  /**
   * Deletion's redaction (spec 9.3, 10.7). A person: their email in actorEmail and details.targetEmail; every address
   * they are known by in details.email, in anyone's events (the current one, the given former ones, and those their
   * own events and the events about their seats hold); and, found by their user id whatever address they had then, the
   * actorEmail of every event they acted in, the details.email of their own joins, leaves and declines, and the
   * targetEmail of every view-as of them. An organization, by
   * action, so old names after a rename go too: its name in org.created and org.renamed, its locations' names in
   * location.*, and the organization name in its request's access_request.created. Resolves the number of events changed.
   */
  redact(redaction: Redaction): Promise<number>;
  /** Whether any event still holds this person's email (person deletion's 404 check). */
  namesPerson(person: { readonly userId: string | null; readonly email: string }): Promise<boolean>;
}

function toRecord(doc: AuditEventFields & { _id: Types.ObjectId }): AuditEventRecord {
  return {
    id: doc._id.toHexString(),
    at: doc.at,
    actorUserId: doc.actorUserId,
    actorEmail: doc.actorEmail,
    actorRole: doc.actorRole,
    viewAsGrantId: doc.viewAsGrantId,
    orgId: doc.orgId === null ? null : doc.orgId.toHexString(),
    action: doc.action,
    target: { type: doc.target.type, id: doc.target.id },
    details: { ...doc.details },
  };
}

/** Events that still hold this person's email, or in details.email any of their addresses. */
function personFilter(
  person: { readonly userId: string | null; readonly email: string },
  addresses: readonly string[],
): Record<string, unknown> {
  const holds: Record<string, unknown>[] = [
    { actorEmail: person.email }, { 'details.email': trusted({ $in: [...addresses] }) }, { 'details.targetEmail': person.email },
  ];
  if (person.userId !== null) {
    holds.push(
      { actorUserId: person.userId, actorEmail: trusted({ $ne: REDACTED.person }) },
      { actorUserId: person.userId, action: trusted({ $in: [...SELF_ACTIONS] }), 'details.email': trusted({ $ne: REDACTED.person }) },
      { 'details.targetUserId': person.userId, 'details.targetEmail': trusted({ $ne: REDACTED.person }) },
    );
  }
  return { $or: holds };
}

export function createAuditEventStore(connection: Connection): AuditEventStore {
  const Event = auditEventModel(connection);

  /** Every address a person is known by: the given ones, and those their own events and the events about their seats hold. */
  async function addressesOf(person: Extract<Redaction, { kind: 'person' }>): Promise<string[]> {
    const found = new Set<unknown>([person.email, ...person.formerEmails]);
    const { userId, seatIds } = person;
    const lists: unknown[][] = [];
    if (userId !== null) {
      lists.push(
        await Event.distinct('actorEmail', { actorUserId: userId }),
        await Event.distinct('details.email', { actorUserId: userId, action: trusted({ $in: [...SELF_ACTIONS] }) }),
        await Event.distinct('details.targetEmail', { 'details.targetUserId': userId }),
      );
    }
    if (seatIds.length > 0) {
      lists.push(await Event.distinct('details.email', { 'target.type': 'member', 'target.id': trusted({ $in: [...seatIds] }) }));
    }
    for (const address of lists.flat()) found.add(address);
    found.delete(REDACTED.person);
    return [...found].filter((address): address is string => typeof address === 'string');
  }

  return {
    async query(query) {
      // Built fresh for each query, so each gets its own trusted operator.
      const filterOf = (): Record<string, unknown> => {
        const filter: Record<string, unknown> = {};
        if (query.orgId !== undefined) filter.orgId = query.orgId;
        if (query.actorUserId !== undefined) filter.actorUserId = query.actorUserId;
        if (query.actorRole !== undefined) {
          filter.actorRole = typeof query.actorRole === 'string' ? query.actorRole : trusted({ $in: [...query.actorRole] });
        }
        if (query.action !== undefined) filter.action = query.action;
        else if (query.excludeAction !== undefined) filter.action = trusted({ $ne: query.excludeAction });
        return filter;
      };
      const page = await Event
        .find(query.before === undefined ? filterOf() : { ...filterOf(), at: trusted({ $lt: query.before }) })
        .sort({ at: -1, _id: -1 })
        .limit(query.limit)
        .lean();
      const last = page.at(-1);
      if (last === undefined || page.length < query.limit) return { events: page.map(toRecord), nextBefore: null };
      const ties = await Event.find({ ...filterOf(), at: last.at, _id: trusted({ $lt: last._id }) }).sort({ _id: -1 }).lean();
      const older = await Event.exists({ ...filterOf(), at: trusted({ $lt: last.at }) });
      return { events: [...page, ...ties].map(toRecord), nextBefore: older === null ? null : last.at };
    },
    async findNotApplied(eventIds) {
      if (eventIds.length === 0) return [];
      const docs = await Event.find({ action: 'staff_action.not_applied', 'details.eventId': trusted({ $in: [...eventIds] }) }).lean();
      return docs.map(toRecord);
    },
    async findStarted(grantIds) {
      if (grantIds.length === 0) return [];
      const docs = await Event.find({ action: 'view_as.started', 'target.id': trusted({ $in: [...grantIds] }) }).lean();
      return docs.map(toRecord);
    },
    async redact(redaction) {
      if (redaction.kind === 'person') {
        const { userId, email } = redaction;
        const addresses = await addressesOf(redaction);
        const changed = await Event.countDocuments(personFilter(redaction, addresses));
        const byUser = (filter: Record<string, unknown>): Record<string, unknown>[] => (userId === null ? [] : [filter]);
        await Event.updateMany({ $or: [{ actorEmail: email }, ...byUser({ actorUserId: userId })] }, { $set: { actorEmail: REDACTED.person } });
        await Event.updateMany(
          {
            $or: [
              { 'details.email': trusted({ $in: addresses }) },
              ...byUser({ actorUserId: userId, action: trusted({ $in: [...SELF_ACTIONS] }) }),
            ],
          },
          { $set: { 'details.email': REDACTED.person } },
        );
        await Event.updateMany(
          { $or: [{ 'details.targetEmail': email }, ...byUser({ 'details.targetUserId': userId })] },
          { $set: { 'details.targetEmail': REDACTED.person } },
        );
        return changed;
      }
      const { orgId, requestId } = redaction;
      const results = [
        await Event.updateMany({ orgId, action: 'org.created' }, { $set: { 'details.name': REDACTED.org } }),
        await Event.updateMany({ orgId, action: 'org.renamed' }, { $set: { 'details.from': REDACTED.org, 'details.to': REDACTED.org } }),
        await Event.updateMany({ orgId, action: trusted({ $in: [...LOCATION_ACTIONS] }) }, { $set: { 'details.name': REDACTED.location } }),
      ];
      if (requestId !== null) {
        results.push(await Event.updateMany(
          { action: 'access_request.created', 'target.type': 'request', 'target.id': requestId },
          { $set: { 'details.orgName': REDACTED.org } },
        ));
      }
      return results.reduce((sum, result) => sum + result.modifiedCount, 0);
    },
    async namesPerson(person) {
      return (await Event.exists(personFilter(person, [person.email]))) !== null;
    },
    async insert(event) {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[event.action];
      const extra = Object.keys(event.details).filter((key) => !allowed.includes(key));
      if (extra.length > 0) throw new Error(`audit details for ${event.action} carry keys outside the allowlist`);
      const doc = await Event.create({ ...event, target: { ...event.target }, details: { ...event.details } });
      return doc._id.toHexString();
    },
  };
}
