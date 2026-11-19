import { z } from 'zod';

// The /api response shapes the portal reads (docs/portal/spec.md 4.1, 8, 10.1 to 10.3), checked against the
// handlers in api/src (me.ts, requests.ts, locations.ts, view-as.ts, access/resolve.ts). `z.object` strips
// unknown keys, so a field the server adds later never reaches a screen by accident.

export const roleSchema = z.enum(['org_admin', 'member']);
export type Role = z.infer<typeof roleSchema>;

/** `townId` is one of the twelve researched towns, or null for another town (spec 10.1). */
export const townSchema = z.object({ townId: z.string().nullable(), name: z.string(), state: z.string() });
export type Town = z.infer<typeof townSchema>;

/** What a Google place is: a business, or a street address for one Google doesn't list (api/README.md, Places search). */
export const placeKindSchema = z.enum(['business', 'address']);
export type PlaceKind = z.infer<typeof placeKindSchema>;

/**
 * One checked Google place on a request; `name` is null for a request stored before places, and `kind` reads as a
 * business when absent (a request stored before kinds, or an API from before them).
 */
export const requestPlaceSchema = z.object({
  placeId: z.string(), name: z.string().nullable(), kind: placeKindSchema.default('business'), town: townSchema,
});
export type RequestPlace = z.infer<typeof requestPlaceSchema>;

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
  /** Absent reads as none, for an API from before it. */
  places: z.array(requestPlaceSchema).optional(),
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

/** Staff open an organization as its admin, joined or not (D25). The access is then that organization's admin. */
export const openAsAdminSchema = z.object({ id: z.string(), org: orgRef, startedAt: z.string() });
export type OpenAsAdmin = z.infer<typeof openAsAdminSchema>;

export const welcomeSchema = z.object({ firstName: z.string().nullable(), restaurant: z.string() });

/** GET /api/me, and the answer of join, decline, access requests and view-as start and end. */
export const meResponseSchema = z.object({
  /** Always the signed-in person: the staff member during view-as. */
  user: z.object({ id: z.string(), email: z.string() }),
  /** During view-as, the target's access. */
  access: accessSchema,
  viewAs: viewAsSchema.nullable(),
  /** Set while staff set up an organization as its admin; the access is then that organization's admin. */
  openAsAdmin: openAsAdminSchema.nullable().optional(),
  staff: z.object({ verifiedUntil: z.string() }).nullable(),
  /** GET /api/me only: the first visit after approval (spec 15.8). Other answers carry null. */
  welcome: welcomeSchema.nullable().optional(),
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

const historyFields = { dayCount: z.number(), firstDate: z.string(), lastDate: z.string() };
/**
 * Calibrated and stale (14.3, D42) are accepted before the API sends them: the newest published run's `dataThrough`,
 * the days with guests after it, and the Monday the weekly refresh next considers the location (null while it is off).
 */
const publishedFields = { ...historyFields, dataThrough: z.string(), newerDays: z.number(), nextRefresh: z.string().nullable() };

/**
 * D65 (design decision 1): a forecast being updated, a field beside the state and never a state of its own, so a client
 * from before strips it. `running` is a live calibration inside its 20 minutes, since its request; `waiting` a first
 * forecast the hourly pass will start, since its refit mark.
 */
export const updatingSchema = z.object({ stage: z.enum(['running', 'waiting']), since: z.string() });
export type Updating = z.infer<typeof updatingSchema>;

/** D65 design decision 7: what happened to a run, in the codes the owner's pages word (the API's lab/owner-outcome.ts). */
export const OWNER_REASONS = [
  'published', 'published_by_staff', 'not_more_accurate', 'not_beat_average', 'failed_checks', 'held_for_review', 'too_soon',
  'needs_more_history', 'forecasts_off', 'newer_forecast', 'staff_withdrew', 'not_judged', 'failed',
] as const;
export type OwnerReason = (typeof OWNER_REASONS)[number];

/** D65 design decision 4: a `not_calibrated` location's newest calibration once it finished (or timed out). */
export const lastRunSchema = z.object({
  outcome: z.enum(['published', 'kept', 'not_run']),
  reason: z.enum(OWNER_REASONS),
  finishedAt: z.string(),
});
export type LastRun = z.infer<typeof lastRunSchema>;

// Optional for an API from before D65, which reads as not updating with no last run (read through `updatingOf` and
// `lastRunOf`). An answer this client can't read (a stage or reason added later) reads the same, so it never fails
// GET /api/org's parse.
const updating = updatingSchema.nullable().optional().catch(null);
const lastRun = lastRunSchema.nullable().optional().catch(null);

export const calibrationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_sales_data'), updating }),
  z.object({ state: z.literal('not_calibrated'), ...historyFields, updating, lastRun }),
  z.object({ state: z.literal('calibrated'), ...publishedFields, updating }),
  z.object({ state: z.literal('stale'), ...publishedFields, updating }),
]);
export type Calibration = z.infer<typeof calibrationSchema>;

/** D65: whether the location's forecast is updating; null from an API before it. */
export function updatingOf(calibration: Calibration): Updating | null {
  return calibration.updating ?? null;
}

/** D65: a `not_calibrated` location's last run; null in every other state and from an API before it. */
export function lastRunOf(calibration: Calibration): LastRun | null {
  return calibration.state === 'not_calibrated' ? calibration.lastRun ?? null : null;
}

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
  /** D28: days that turned-off uploads hold, which `coverage` leaves out. Optional for an API from before it. */
  offDayCount: z.number().optional(),
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
