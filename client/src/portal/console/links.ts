// The console's own paths. Ids are encoded; nothing else goes in a URL (spec 10, the server logs URLs).

export function orgHref(orgId: string): string {
  return `/admin/orgs/${encodeURIComponent(orgId)}`;
}

/** A request on its tab of Requests, selected (P21's “From request”). */
export function requestHref(status: 'pending' | 'approved' | 'rejected' | 'withdrawn', requestId: string): string {
  const id = encodeURIComponent(requestId);
  return status === 'pending' ? `/admin?request=${id}` : `/admin?status=${status}&request=${id}`;
}

export function auditHref(orgId: string): string {
  return `/admin/audit?orgId=${encodeURIComponent(orgId)}`;
}
