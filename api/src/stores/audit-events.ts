import { Schema, trusted, type Connection, type Model, type Types } from 'mongoose';

/** Each action and the only detail keys it may carry (spec 9.2). Never figures, note text, request notes,
 *  decision messages, file content or tokens. */
export const AUDIT_DETAIL_KEYS = {
  'access_request.created': ['orgName', 'townId', 'townName'],
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
  'location.created': ['name', 'townId'],
  'location.updated': ['name', 'townId'],
  'location.deleted': ['name', 'townId'],
  'sales.uploaded': ['locationId', 'dayCount', 'inserted', 'replaced', 'firstDate', 'lastDate'],
  'sales.deleted': ['locationId', 'deletedDays'],
  'note.created': ['locationId', 'kind', 'startDate', 'endDate'],
  'note.updated': ['locationId', 'kind', 'startDate', 'endDate'],
  'note.deleted': ['locationId', 'kind', 'startDate', 'endDate'],
  'view_as.started': ['targetUserId', 'targetEmail', 'reason', 'expiresAt'],
  'view_as.ended': ['endReason'],
  'people.signed_out_everywhere': [],
  'person.deleted': ['userId'],
  'staff_action.not_applied': ['eventId', 'code'],
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_DETAIL_KEYS;
export type AuditActorRole = 'superadmin' | 'org_admin' | 'member' | 'user';
export type AuditTargetType = 'org' | 'member' | 'request' | 'location' | 'upload' | 'note' | 'user' | 'grant';
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
    actorRole: { type: String, required: true, enum: ['superadmin', 'org_admin', 'member', 'user'] },
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
  readonly action?: AuditAction;
  /** Only events strictly before this time. */
  readonly before?: Date;
  readonly limit: number;
}

/** Append only: no code path here updates or deletes an event. The deletion redaction arrives with deletion (spec 9.3). */
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

export function createAuditEventStore(connection: Connection): AuditEventStore {
  const Event = auditEventModel(connection);
  return {
    async query(query) {
      const filter: Record<string, unknown> = {};
      if (query.orgId !== undefined) filter.orgId = query.orgId;
      if (query.actorUserId !== undefined) filter.actorUserId = query.actorUserId;
      if (query.action !== undefined) filter.action = query.action;
      const page = await Event
        .find(query.before === undefined ? filter : { ...filter, at: trusted({ $lt: query.before }) })
        .sort({ at: -1, _id: -1 })
        .limit(query.limit)
        .lean();
      const last = page.at(-1);
      if (last === undefined || page.length < query.limit) return { events: page.map(toRecord), nextBefore: null };
      const ties = await Event.find({ ...filter, at: last.at, _id: trusted({ $lt: last._id }) }).sort({ _id: -1 }).lean();
      const older = await Event.exists({ ...filter, at: trusted({ $lt: last.at }) });
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
    async insert(event) {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[event.action];
      const extra = Object.keys(event.details).filter((key) => !allowed.includes(key));
      if (extra.length > 0) throw new Error(`audit details for ${event.action} carry keys outside the allowlist`);
      const doc = await Event.create({ ...event, target: { ...event.target }, details: { ...event.details } });
      return doc._id.toHexString();
    },
  };
}
