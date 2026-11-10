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

/**
 * D25: the organization open as admin, null outside it. Renaming the organization and adding a location name nothing
 * of it in their path, so in open as admin they send it as `orgId`: a tab left on an organization this session no
 * longer has open is then refused (409 open_as_admin_active, which reads GET /api/me again) instead of writing into
 * the one it has open now.
 */
export function openAsAdminOrgId(me: MeResponse): string | null {
  return me.openAsAdmin?.org.id ?? null;
}

/** `orgId` from openAsAdminOrgId: sent only when set. */
export function withOrgId<T extends object>(body: T, orgId: string | null): T & { orgId?: string } {
  return orgId === null ? body : { ...body, orgId };
}

export async function createLocation(api: ApiClient, input: { name: string; town: TownInput }, orgId: string | null): Promise<LocationSummary> {
  const body = await api.json('/api/org/locations', createdLocationSchema, { method: 'POST', body: withOrgId(input, orgId) });
  return body.location;
}

/**
 * Idempotent; answers the session's access after it. `grantId`, the view-as or open-as-admin grant the tab shows (D25),
 * ends that grant only, so a tab left on an earlier one never ends a newer one.
 */
export function endViewAs(api: ApiClient, grantId?: string): Promise<MeResponse> {
  return api.json('/api/admin/view-as/end', meResponseSchema, { method: 'POST', body: grantId === undefined ? {} : { grantId } });
}

export async function fetchPendingCount(api: ApiClient): Promise<number> {
  const body = await api.json('/api/admin/requests?status=pending', pendingCountSchema);
  return body.pendingCount;
}
