import type { ApiClient } from '../../api/client';
import type { TownInput } from '../api';
import { meResponseSchema, type MeResponse, type Role } from '../schemas';
import type { SalesDay } from '../upload/days';
import {
  addMembersSchema, approvedSchema, auditPageSchema, createdOrgSchema, lookupSchema, memberUpdatedSchema, orgDeletedSchema,
  orgDetailSchema, orgListSchema, orgUpdatedSchema, peopleSchema, personDeletedSchema, rejectedSchema, requestListSchema,
  setupLocationSchema, setupSalesDeletedSchema, setupUploadSchema, signedOutSchema,
  type AddResult, type AdminRequest, type AuditPage, type Member, type OrgDetail, type OrgRow, type OrgStatus, type People,
  type Person, type PersonKind, type RequestList, type RequestStatus, type SetupSalesDeleted, type SetupUpload, type StaffOrg,
} from './schemas';

// One function per staff console call (spec 10.7). Pages pass usePortal().api, which re-reads GET /api/me on
// 409 view_as_active and the staff gate's 403s, so the layout routes again (spec 4.3). Ids go in paths encoded;
// no email or name goes in a path or query, except the people lookup's `q`, which server-core redacts.

function id(value: string): string {
  return encodeURIComponent(value);
}

export function fetchRequests(api: ApiClient, status: RequestStatus): Promise<RequestList> {
  return api.json(`/api/admin/requests?status=${status}`, requestListSchema);
}

/** A request without places names its one location; one with places names each, in the places' order. */
export type ApproveInput = { orgName: string; locationName: string } | { orgName: string; locationNames: string[] };

export function approveRequest(
  api: ApiClient, requestId: string, input: ApproveInput,
): Promise<{ org: { id: string; name: string }; request: AdminRequest }> {
  return api.json(`/api/admin/requests/${id(requestId)}/approve`, approvedSchema, { method: 'POST', body: input });
}

/** An empty message is left out, so the requester sees none. */
export async function rejectRequest(api: ApiClient, requestId: string, message: string): Promise<AdminRequest> {
  const body = message === '' ? {} : { message };
  return (await api.json(`/api/admin/requests/${id(requestId)}/reject`, rejectedSchema, { method: 'POST', body })).request;
}

export async function fetchOrgs(api: ApiClient): Promise<OrgRow[]> {
  return (await api.json('/api/admin/orgs', orgListSchema)).orgs;
}

/** A new 24-hex organization id, made once per New organization dialog so a repeat of the request finds the same one. */
export function newOrgId(): string {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/** `id` makes a retry or double submit answer with the organization it made (200) instead of creating a second. */
export function createOrg(
  api: ApiClient, input: { id: string; name: string; adminEmail: string },
): Promise<{ org: { id: string; name: string }; result: AddResult }> {
  return api.json('/api/admin/orgs', createdOrgSchema, { method: 'POST', body: input });
}

export function fetchOrg(api: ApiClient, orgId: string): Promise<OrgDetail> {
  return api.json(`/api/admin/orgs/${id(orgId)}`, orgDetailSchema);
}

export async function updateOrg(api: ApiClient, orgId: string, patch: { name: string } | { status: OrgStatus }): Promise<StaffOrg> {
  return (await api.json(`/api/admin/orgs/${id(orgId)}`, orgUpdatedSchema, { method: 'PATCH', body: patch })).org;
}

/** Only a suspended organization (409 org_not_suspended). */
export async function deleteOrg(api: ApiClient, orgId: string): Promise<void> {
  await api.json(`/api/admin/orgs/${id(orgId)}`, orgDeletedSchema, { method: 'DELETE' });
}

export function addOrgMembers(
  api: ApiClient, orgId: string, input: { emails: string[]; role: Role },
): Promise<{ results: AddResult[]; members: Member[] }> {
  return api.json(`/api/admin/orgs/${id(orgId)}/members`, addMembersSchema, { method: 'POST', body: input });
}

export async function changeOrgMemberRole(api: ApiClient, orgId: string, memberId: string, role: Role): Promise<Member> {
  const path = `/api/admin/orgs/${id(orgId)}/members/${id(memberId)}` as const;
  return (await api.json(path, memberUpdatedSchema, { method: 'PATCH', body: { role } })).member;
}

/** 204: an invitation is deleted, a seat removed. */
export async function removeOrgMember(api: ApiClient, orgId: string, memberId: string): Promise<void> {
  await api.request(`/api/admin/orgs/${id(orgId)}/members/${id(memberId)}`, { method: 'DELETE' });
}

// Staff setup (D23, F10b): while nobody has joined the organization. Every call can answer 409 org_not_in_setup once
// someone has. The bodies are the org routes' (10.3, 11.3).

function setupPath(orgId: string, locationId?: string): `/${string}` {
  const base = `/api/admin/orgs/${id(orgId)}/locations` as const;
  return locationId === undefined ? base : `${base}/${id(locationId)}`;
}

export async function createSetupLocation(
  api: ApiClient, orgId: string, input: { name: string; town: TownInput; placeId?: string },
): Promise<{ id: string; name: string }> {
  return (await api.json(setupPath(orgId), setupLocationSchema, { method: 'POST', body: input })).location;
}

/** A town changed by hand takes the location's place off; a place id sets the place and its town. */
export async function updateSetupLocation(
  api: ApiClient, orgId: string, locationId: string, patch: { name?: string; town?: TownInput; placeId?: string },
): Promise<{ id: string; name: string }> {
  return (await api.json(setupPath(orgId, locationId), setupLocationSchema, { method: 'PATCH', body: patch })).location;
}

/** 204; 409 location_has_data while it has any sales day, note or stored file. */
export async function deleteSetupLocation(api: ApiClient, orgId: string, locationId: string): Promise<void> {
  await api.request(setupPath(orgId, locationId), { method: 'DELETE' });
}

/** `{ days }` and nothing else (spec 11.1); it replaces the days it covers. */
export function uploadSetupSales(api: ApiClient, orgId: string, locationId: string, body: { days: SalesDay[] }): Promise<SetupUpload> {
  return api.json(`${setupPath(orgId, locationId)}/sales/uploads`, setupUploadSchema, { method: 'POST', body });
}

/** Every day, upload and stored file of the location; 409 import_running, 503 files_unavailable. */
export function deleteSetupSales(api: ApiClient, orgId: string, locationId: string): Promise<SetupSalesDeleted> {
  return api.json(`${setupPath(orgId, locationId)}/sales`, setupSalesDeletedSchema, { method: 'DELETE' });
}

export function fetchPeople(api: ApiClient, kind: PersonKind | null): Promise<People> {
  return api.json(kind === null ? '/api/admin/people' : `/api/admin/people?kind=${kind}`, peopleSchema);
}

/** One person by exact email, signed-in-only people included; null when there is none. */
export async function lookupPerson(api: ApiClient, email: string): Promise<Person | null> {
  return (await api.json(`/api/admin/people/lookup?q=${encodeURIComponent(email)}`, lookupSchema)).person;
}

export async function signOutEverywhere(api: ApiClient, userId: string): Promise<number> {
  return (await api.json(`/api/admin/people/${id(userId)}/sign-out-everywhere`, signedOutSchema, { method: 'POST', body: {} })).revoked;
}

/** The email goes in the body, never the path, because the server logs URLs. */
export async function deletePerson(api: ApiClient, email: string): Promise<{ kitUserId: string | null }> {
  return api.json('/api/admin/people/delete', personDeletedSchema, { method: 'POST', body: { email } });
}

/** Each filter is left out of the query when undefined or empty. */
export interface AuditQuery {
  orgId?: string | undefined;
  actorUserId?: string | undefined;
  action?: string | undefined;
  /** The `nextBefore` of the page before. */
  before?: string | undefined;
}

export function fetchAudit(api: ApiClient, query: AuditQuery): Promise<AuditPage> {
  const params = (['orgId', 'actorUserId', 'action', 'before'] as const)
    .flatMap((key) => (query[key] === undefined || query[key] === '' ? [] : [`${key}=${encodeURIComponent(query[key])}`]));
  return api.json(params.length === 0 ? '/api/admin/audit' : `/api/admin/audit?${params.join('&')}`, auditPageSchema);
}

/** 201 with the organization's admin access, the staff member still the user (D25). No body. */
export function openAsAdmin(api: ApiClient, orgId: string): Promise<MeResponse> {
  return api.json(`/api/admin/orgs/${encodeURIComponent(orgId)}/open-as-admin`, meResponseSchema, { method: 'POST' });
}

/** 201 with the target's access and `viewAs` set. */
export function startViewAs(api: ApiClient, userId: string, reason: string): Promise<MeResponse> {
  return api.json('/api/admin/view-as', meResponseSchema, { method: 'POST', body: { userId, reason } });
}
