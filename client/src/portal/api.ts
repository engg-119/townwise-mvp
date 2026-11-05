import type { ApiClient } from '../api/client';
import {
  createdLocationSchema, meResponseSchema, orgResponseSchema, pendingCountSchema,
  type LocationSummary, type MeResponse, type OrgResponse,
} from './schemas';

// One function per /api call the shared portal pieces make (spec 10.2, 10.3, 10.7). Pages take the client
// from usePortal().api, which re-reads GET /api/me on the access errors of spec 4.3 (PortalProvider).

/** Spec 10.1 TownInput: one of the twelve by id, or another town by name and two-letter state. */
export type TownInput = { townId: string } | { townId: null; name: string; state: string };

export interface AccessRequestInput {
  orgName: string;
  contactName: string;
  contactRole: string;
  town: TownInput;
  locationCount: number;
  note?: string;
}

export function fetchMe(api: ApiClient): Promise<MeResponse> {
  return api.json('/api/me', meResponseSchema);
}

export function joinInvite(api: ApiClient, inviteId: string): Promise<MeResponse> {
  return api.json('/api/me/join', meResponseSchema, { method: 'POST', body: { inviteId } });
}

export function declineInvite(api: ApiClient, inviteId: string): Promise<MeResponse> {
  return api.json('/api/me/decline', meResponseSchema, { method: 'POST', body: { inviteId } });
}

/** 201 with the new access (pending). */
export function sendAccessRequest(api: ApiClient, input: AccessRequestInput): Promise<MeResponse> {
  return api.json('/api/access-requests', meResponseSchema, { method: 'POST', body: input });
}

export function fetchOrg(api: ApiClient): Promise<OrgResponse> {
  return api.json('/api/org', orgResponseSchema);
}

export async function createLocation(api: ApiClient, input: { name: string; town: TownInput }): Promise<LocationSummary> {
  const body = await api.json('/api/org/locations', createdLocationSchema, { method: 'POST', body: input });
  return body.location;
}

/** Idempotent; answers the staff member's own access. */
export function endViewAs(api: ApiClient): Promise<MeResponse> {
  return api.json('/api/admin/view-as/end', meResponseSchema, { method: 'POST', body: {} });
}

export async function fetchPendingCount(api: ApiClient): Promise<number> {
  const body = await api.json('/api/admin/requests?status=pending', pendingCountSchema);
  return body.pendingCount;
}
