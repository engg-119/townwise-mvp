// Raw fixture documents, written straight to the Townwise collections in the shapes of spec Section 6.
import { Types } from 'mongoose';

import type { TownwiseTestServer } from './server.ts';

type Server = Pick<TownwiseTestServer, 'connection' | 'clock'>;
type Role = 'org_admin' | 'member';

const TOWN = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };

export async function createOrg(
  server: Server,
  opts: { name: string; status?: 'active' | 'suspended'; fromRequestId?: string; forecastsOn?: boolean },
): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_orgs').insertOne({
    _id, name: opts.name, status: opts.status ?? 'active', createdAt: server.clock.now(), createdBy: 'fixture',
    fromRequestId: opts.fromRequestId === undefined ? null : new Types.ObjectId(opts.fromRequestId),
    suspendedAt: opts.status === 'suspended' ? server.clock.now() : null,
    // G1 as staff switched it: true on (with the owner's agreement), false off; absent, never switched, which reads as on
    // since D42.
    ...(opts.forecastsOn === undefined ? {} : { forecasts: { on: opts.forecastsOn, at: server.clock.now(), by: 'fixture' } }),
  });
  return _id.toHexString();
}

export async function addSeat(
  server: Server,
  opts: { orgId: string; userId: string; email: string; role?: Role },
): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_members').insertOne({
    _id, orgId: new Types.ObjectId(opts.orgId), email: opts.email, role: opts.role ?? 'member', status: 'active',
    userId: opts.userId, activeUserId: opts.userId, invitedAt: server.clock.now(), invitedBy: 'fixture',
    addedByStaff: false, joinedAt: server.clock.now(), removedAt: null, removedBy: null,
  });
  return _id.toHexString();
}

export async function addInvite(
  server: Server,
  opts: { orgId: string; email: string; invitedBy: string; role?: Role; addedByStaff?: boolean; invitedAt?: Date },
): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_members').insertOne({
    _id, orgId: new Types.ObjectId(opts.orgId), email: opts.email, role: opts.role ?? 'member', status: 'invited',
    inviteEmail: opts.email, userId: null, invitedAt: opts.invitedAt ?? server.clock.now(), invitedBy: opts.invitedBy,
    addedByStaff: opts.addedByStaff ?? false, joinedAt: null, removedAt: null, removedBy: null,
  });
  return _id.toHexString();
}

export async function addRemovedSeat(
  server: Server,
  opts: { orgId: string; userId: string; email: string; removedAt: Date; removedBy: string },
): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_members').insertOne({
    _id, orgId: new Types.ObjectId(opts.orgId), email: opts.email, role: 'member', status: 'removed',
    userId: opts.userId, invitedAt: opts.removedAt, invitedBy: 'fixture', addedByStaff: false,
    joinedAt: opts.removedAt, removedAt: opts.removedAt, removedBy: opts.removedBy,
  });
  return _id.toHexString();
}

export async function addRequest(
  server: Server,
  opts: {
    userId: string; email: string; status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
    orgName?: string; createdAt?: Date; decidedAt?: Date; decisionMessage?: string;
    /** Left out of the document when undefined, as in requests stored before place ids. */
    placeId?: string;
  },
): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_access_requests').insertOne({
    _id, userId: opts.userId, emailAtRequest: opts.email, orgName: opts.orgName ?? 'Fixture Kitchen',
    contactName: 'Fixture Contact', contactRole: 'Owner', town: TOWN, locationCount: 1, note: null,
    status: opts.status, createdAt: opts.createdAt ?? server.clock.now(), decidedAt: opts.decidedAt ?? null,
    decidedBy: null, decisionMessage: opts.decisionMessage ?? null, orgId: null, withdrawnReason: null,
    ...(opts.placeId === undefined ? {} : { placeId: opts.placeId }),
  });
  return _id.toHexString();
}

export async function addGrant(
  server: Server,
  opts: { actorUserId: string; sessionId: string; targetUserId: string; orgId: string | null; startedAt?: Date; minutes?: number },
): Promise<string> {
  const _id = new Types.ObjectId();
  const startedAt = opts.startedAt ?? server.clock.now();
  await server.connection.collection('tw_view_as_grants').insertOne({
    _id, actorUserId: opts.actorUserId, actorSessionId: opts.sessionId, activeSessionId: opts.sessionId,
    targetUserId: opts.targetUserId, orgId: opts.orgId === null ? null : new Types.ObjectId(opts.orgId),
    reason: 'Support request from the owner', startedAt,
    expiresAt: new Date(startedAt.getTime() + (opts.minutes ?? 30) * 60 * 1000), endedAt: null, endReason: null,
  });
  return _id.toHexString();
}

/** An open-as-admin grant (D25) in the shape insertOpenAsAdmin writes: `kind`, the organization, no target and no reason. */
export async function addOpenAsAdminGrant(
  server: Server,
  opts: { actorUserId: string; sessionId: string; orgId: string; startedAt?: Date; minutes?: number },
): Promise<string> {
  const _id = new Types.ObjectId();
  const startedAt = opts.startedAt ?? server.clock.now();
  await server.connection.collection('tw_view_as_grants').insertOne({
    _id, kind: 'open_as_admin', actorUserId: opts.actorUserId, actorSessionId: opts.sessionId, activeSessionId: opts.sessionId,
    orgId: new Types.ObjectId(opts.orgId), startedAt,
    expiresAt: new Date(startedAt.getTime() + (opts.minutes ?? 60) * 60 * 1000), endedAt: null, endReason: null,
  });
  return _id.toHexString();
}

export async function memberDoc(server: Server, id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_members').findOne({ _id: new Types.ObjectId(id) });
}

export async function auditEvents(server: Server): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_audit_events').find({}).sort({ at: 1, _id: 1 }).toArray();
}

export async function addLocation(server: Server, opts: { orgId: string; name: string }): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_locations').insertOne({
    _id, orgId: new Types.ObjectId(opts.orgId), name: opts.name, nameKey: opts.name.toLowerCase(), town: TOWN,
    createdAt: server.clock.now(), createdBy: 'fixture',
  });
  return _id.toHexString();
}

/** A tw_sales_days row in the shape of spec 6.5, written directly rather than through the upload route. */
export async function addSalesDay(
  server: Server,
  opts: { orgId: string; locationId: string; date: string; guests: number | null; netSalesCents: number | null },
): Promise<void> {
  await server.connection.collection('tw_sales_days').insertOne({
    orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId), date: opts.date,
    guests: opts.guests, netSalesCents: opts.netSalesCents, uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
  });
}

/** A tw_uploads record in the shape of spec 6.6. Resolves its id. */
export async function addUpload(
  server: Server,
  opts: { orgId: string; locationId: string; uploadedAt: Date; status: 'applying' | 'applied'; uploadedBy?: string; byStaff?: boolean },
): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_uploads').insertOne({
    _id, orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId), uploadedBy: opts.uploadedBy ?? 'fixture',
    uploadedAt: opts.uploadedAt, status: opts.status, dayCount: 1, inserted: 1, replaced: 0, kept: 0,
    firstDate: '2026-05-01', lastDate: '2026-05-01', hasGuests: true, hasNetSales: true,
    ...(opts.byStaff === true ? { byStaff: true } : {}),
  });
  return _id.toHexString();
}

/**
 * A file calendar in tw_calendar_sources (stores/owner-calendars.ts) at generation 1, with one event a day from
 * 2026-11-02 in tw_calendar_events. Resolves its id.
 */
export async function addOwnerCalendar(
  server: Server,
  opts: { orgId: string; locationId: string; eventCount?: number; label?: string; title?: string },
): Promise<string> {
  const _id = new Types.ObjectId();
  const orgId = new Types.ObjectId(opts.orgId);
  const locationId = new Types.ObjectId(opts.locationId);
  const eventCount = opts.eventCount ?? 2;
  const at = server.clock.now();
  await server.connection.collection('tw_calendar_sources').insertOne({
    _id, orgId, locationId, slot: 0, kind: 'file', label: opts.label ?? 'Bookings', sealedAddress: null, host: null,
    generation: 1, reservedGeneration: 1, eventCount, skippedRepeating: 0, status: 'ok', lastSuccessAt: at, lastAttemptAt: at,
    nextRefreshAt: null, leaseUntil: null, consecutiveFailures: 0, lastManualRefreshAt: null, createdBy: 'fixture', createdAt: at,
  });
  if (eventCount > 0) {
    await server.connection.collection('tw_calendar_events').insertMany(Array.from({ length: eventCount }, (_, index) => {
      const date = `2026-11-${String(index + 2).padStart(2, '0')}`;
      return {
        orgId, locationId, sourceId: _id, generation: 1, uid: `fixture-${String(index)}@example.test`, title: opts.title ?? 'Private dinner',
        startDate: date, endDate: date, startTime: '18:00', endTime: '21:00',
      };
    }));
  }
  return _id.toHexString();
}

/** A tw_notes record in the shape of spec 12. */
export async function addNote(
  server: Server,
  opts: { orgId: string; locationId: string; detail: string; createdBy?: string; startDate?: string },
): Promise<string> {
  const _id = new Types.ObjectId();
  const startDate = opts.startDate ?? '2026-05-03';
  await server.connection.collection('tw_notes').insertOne({
    _id, orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId), kind: 'closure',
    startDate, endDate: startDate, weekdays: null, effect: 'closed', expectedGuests: null,
    detail: opts.detail, createdBy: opts.createdBy ?? 'fixture', createdAt: server.clock.now(), updatedAt: server.clock.now(),
  });
  return _id.toHexString();
}

/** A tw_audit_events record in the shape of spec 9.1. */
export async function addAuditEvent(
  server: Server,
  opts: {
    at: Date; orgId: string | null; action: string; details: Record<string, string | number | boolean | null>;
    actorUserId?: string; actorEmail?: string; actorRole?: string; viewAsGrantId?: string | null;
    target?: { type: string; id: string };
  },
): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_audit_events').insertOne({
    _id, at: opts.at, actorUserId: opts.actorUserId ?? 'a'.repeat(24), actorEmail: opts.actorEmail ?? 'actor@example.test',
    actorRole: opts.actorRole ?? 'org_admin', viewAsGrantId: opts.viewAsGrantId ?? null,
    orgId: opts.orgId === null ? null : new Types.ObjectId(opts.orgId), action: opts.action,
    target: opts.target ?? { type: 'member', id: 'b'.repeat(24) }, details: opts.details,
  });
  return _id.toHexString();
}

/** A tw_chat_conversations record in the shape of docs/portal/tuning-chat.md section 5: one finished turn. */
export async function addConversation(
  server: Server,
  opts: { orgId: string; locationId: string; userId: string; text: string; turnCount?: number },
): Promise<string> {
  const _id = new Types.ObjectId();
  const at = server.clock.now();
  await server.connection.collection('tw_chat_conversations').insertOne({
    _id, orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId), userId: opts.userId,
    title: opts.text.slice(0, 60),
    messages: [
      { at, param: JSON.stringify({ role: 'user', content: opts.text }) },
      { at, param: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: `Answer to ${opts.text}` }] }) },
    ],
    turnCount: opts.turnCount ?? 1, liveTurn: null, createdAt: at, updatedAt: at,
  });
  return _id.toHexString();
}

/** A tw_chat_live_turns record: the person's one live tuning chat turn in the organization. */
export async function addLiveTurn(server: Server, opts: { orgId: string; userId: string }): Promise<void> {
  await server.connection.collection('tw_chat_live_turns').insertOne({
    orgId: new Types.ObjectId(opts.orgId), userId: opts.userId, turnId: `turn-${new Types.ObjectId().toHexString()}`,
    startedAt: server.clock.now(),
  });
}

/** A tw_chat_usage record: the organization's tuning chat cost for one month. */
export async function addChatUsage(server: Server, opts: { orgId: string; month: string; costMicroUsd: number }): Promise<void> {
  await server.connection.collection('tw_chat_usage').insertOne({
    orgId: new Types.ObjectId(opts.orgId), month: opts.month, costMicroUsd: opts.costMicroUsd, updatedAt: server.clock.now(),
  });
}

/** A tw_activity_days record (openspec change staff-overview): the person used the app in the organization that UTC day. */
export async function addActivityDay(server: Server, opts: { orgId: string; userId: string; day: string }): Promise<void> {
  await server.connection.collection<{ _id: string; orgId: Types.ObjectId; userId: string; day: string }>('tw_activity_days').insertOne({
    _id: `${opts.orgId}:${opts.userId}:${opts.day}`, orgId: new Types.ObjectId(opts.orgId), userId: opts.userId, day: opts.day,
  });
}

/** Ordering's six collections that hold a location's records. */
export const ORDER_COLLECTIONS = [
  'tw_order_decisions', 'tw_order_rules', 'tw_order_cards', 'tw_order_setups', 'tw_item_sales', 'tw_order_counts',
] as const;

/**
 * One record in each of ordering's collections for the location: an edit, a rule, a card in `conversationId` (a new id
 * when none is given), the setup, a day of item sales and a count. Synthetic figures.
 */
export async function addOrderRecords(
  server: Server,
  opts: { orgId: string; locationId: string; conversationId?: string },
): Promise<void> {
  const at = server.clock.now();
  const where = { orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId) };
  const supplierId = new Types.ObjectId().toHexString();
  const itemId = new Types.ObjectId().toHexString();
  const db = server.connection;
  await db.collection('tw_order_decisions').insertOne({
    ...where, itemId, delivery: '2026-06-03', windowStart: '2026-06-01', windowEnd: '2026-06-07', recommended: 4, quantity: 6,
    unit: 'cases', reason: 'Fixture reason', createdAt: at,
  });
  await db.collection('tw_order_rules').insertOne({
    ...where, itemId, delta: 2, unit: 'cases', situation: 'Fixture reason', off: false, createdAt: at, updatedAt: at,
  });
  await db.collection('tw_order_cards').insertOne({
    ...where, conversationId: new Types.ObjectId(opts.conversationId), proposalId: 'toolu_order0001', kind: 'change', status: 'dismissed',
    decisionId: new Types.ObjectId(), createdAt: at,
  });
  await db.collection('tw_order_setups').insertOne({
    ...where, version: 1, updatedAt: at,
    suppliers: [{ id: supplierId, name: 'Fixture Supplier', deliveries: [{ deliveryWeekday: 3, cutoffWeekday: 1, cutoffTime: '14:00' }] }],
    items: [{
      id: itemId, name: 'Fixture Lager', supplierId, category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 4, dealSize: null,
      neverRunOut: true, posNames: [{ name: 'Fixture Lager 12oz', perSale: 1 }],
    }],
  });
  await db.collection('tw_item_sales').insertOne({ ...where, date: '2026-05-01', items: { [itemId]: 30 }, uploadedAt: at });
  await db.collection('tw_order_counts').insertOne({ ...where, date: '2026-05-02', items: { [itemId]: 3 }, updatedAt: at });
}
