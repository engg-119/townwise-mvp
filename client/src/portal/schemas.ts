import { z } from 'zod';

// The /api response shapes the portal reads (docs/portal/spec.md 4.1, 8, 10.1 to 10.3), checked against the
// handlers in api/src (me.ts, requests.ts, locations.ts, view-as.ts, access/resolve.ts). `z.object` strips
// unknown keys, so a field the server adds later never reaches a screen by accident.

export const roleSchema = z.enum(['org_admin', 'member']);
export type Role = z.infer<typeof roleSchema>;

/** `townId` is one of the twelve researched towns, or null for another town (spec 10.1). */
export const townSchema = z.object({ townId: z.string().nullable(), name: z.string(), state: z.string() });
export type Town = z.infer<typeof townSchema>;

export const accessRequestSchema = z.object({
  id: z.string(),
  orgName: z.string(),
  contactName: z.string(),
  contactRole: z.string(),
  town: townSchema,
  locationCount: z.number(),
  note: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decisionMessage: z.string().nullable(),
});
export type AccessRequest = z.infer<typeof accessRequestSchema>;

export const invitationSchema = z.object({
  inviteId: z.string(),
  orgName: z.string(),
  role: roleSchema,
  /** email: the inviting org admin's current email; null when staff added it, or that account is gone. */
  invitedBy: z.object({ staff: z.boolean(), email: z.string().nullable() }),
});
export type Invitation = z.infer<typeof invitationSchema>;

const orgRef = z.object({ id: z.string(), name: z.string() });

export const accessSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('staff') }),
  z.object({ state: z.literal('staff_setup_required') }),
  z.object({ state: z.literal('staff_reauth_required'), reason: z.enum(['session_before_codes', 'session_too_old']) }),
  z.object({ state: z.literal('member'), org: orgRef, role: roleSchema }),
  z.object({ state: z.literal('invited'), invitations: z.array(invitationSchema), pendingRequest: accessRequestSchema.nullable() }),
  z.object({ state: z.literal('pending'), request: accessRequestSchema }),
  z.object({ state: z.literal('rejected'), request: accessRequestSchema }),
  z.object({ state: z.literal('removed'), org: z.object({ name: z.string() }), removedAt: z.string(), byYou: z.boolean() }),
  z.object({ state: z.literal('org_suspended'), org: z.object({ name: z.string() }) }),
  z.object({ state: z.literal('no_org') }),
]);
export type Access = z.infer<typeof accessSchema>;
export type AccessState = Access['state'];

export const viewAsSchema = z.object({
  id: z.string(),
  target: z.object({ userId: z.string(), email: z.string() }),
  org: orgRef.nullable(),
  role: roleSchema.nullable(),
  reason: z.string(),
  startedAt: z.string(),
  /** min(grant expiry, the staff member's verified window). */
  endsAt: z.string(),
});
export type ViewAs = z.infer<typeof viewAsSchema>;

/** GET /api/me, and the answer of join, decline, access requests and view-as start and end. */
export const meResponseSchema = z.object({
  /** Always the signed-in person: the staff member during view-as. */
  user: z.object({ id: z.string(), email: z.string() }),
  /** During view-as, the target's access. */
  access: accessSchema,
  viewAs: viewAsSchema.nullable(),
  staff: z.object({ verifiedUntil: z.string() }).nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const coverageSchema = z.object({
  dayCount: z.number(),
  guestsDayCount: z.number(),
  netSalesDayCount: z.number(),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
  missingDays: z.number(),
});
export type Coverage = z.infer<typeof coverageSchema>;

export const calibrationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_sales_data') }),
  z.object({ state: z.literal('not_calibrated'), dayCount: z.number(), firstDate: z.string(), lastDate: z.string() }),
]);
export type Calibration = z.infer<typeof calibrationSchema>;

export const locationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  town: townSchema,
  /** Places unit: the Google place id an org admin picked, or null. Optional for an API from before it. */
  placeId: z.string().nullable().optional(),
  coverage: coverageSchema,
  calibration: calibrationSchema,
  notesCount: z.number(),
  lastUploadAt: z.string().nullable(),
});
export type LocationSummary = z.infer<typeof locationSummarySchema>;

/** GET /api/org. `requestedLocationCount`: the location count of the request the organization came from. */
export const orgResponseSchema = z.object({
  org: orgRef,
  role: roleSchema,
  locations: z.array(locationSummarySchema),
  requestedLocationCount: z.number().nullable(),
  /** Places unit: whether the Google Places search is on (P10, P16 offer it only then); absent reads as off. */
  placeSearch: z.boolean().optional(),
});
export type OrgResponse = z.infer<typeof orgResponseSchema>;

/** POST /api/org/locations. */
export const createdLocationSchema = z.object({ location: locationSummarySchema });

/** GET /api/admin/requests: the console nav reads only the pending count. */
export const pendingCountSchema = z.object({ pendingCount: z.number() });
