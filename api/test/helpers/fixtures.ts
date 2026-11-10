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
    // G1: forecasts switched on, as staff do with the owner's agreement.
    ...(opts.forecastsOn === true ? { forecasts: { on: true, at: server.clock.now(), by: 'fixture' } } : {}),
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
