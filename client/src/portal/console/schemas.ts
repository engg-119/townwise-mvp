import { z } from 'zod';

import { accessRequestSchema, roleSchema, townSchema } from '../schemas';

// The staff console's response shapes (docs/portal/spec.md 10.7), checked against api/src/handlers/admin.ts,
// deletion.ts, team.ts, view-as.ts and audit.ts. `z.object` strips unknown keys, so the console keeps only what
// it shows: location coverage keeps its day count and dates, and nothing here can carry a sales figure or note
// text to a screen (D7).

const orgRef = z.object({ id: z.string(), name: z.string() });

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** GET /api/admin/requests: the request as its requester sent it, plus what staff need to decide it. */
export const adminRequestSchema = accessRequestSchema.extend({
  requester: z.object({ userId: z.string(), email: z.string() }),
  emailAtRequest: z.string(),
  requesterHasOrg: z.boolean(),
  decidedBy: z.object({ email: z.string() }).nullable(),
  orgId: z.string().nullable(),
});
export type AdminRequest = z.infer<typeof adminRequestSchema>;

export const requestListSchema = z.object({ requests: z.array(adminRequestSchema), pendingCount: z.number() });
export type RequestList = z.infer<typeof requestListSchema>;

export const approvedSchema = z.object({ org: orgRef, request: adminRequestSchema });
export const rejectedSchema = z.object({ request: adminRequestSchema });

export const orgStatusSchema = z.enum(['active', 'suspended']);
export type OrgStatus = z.infer<typeof orgStatusSchema>;

/** GET /api/admin/orgs: one row per organization, counts only. */
export const orgRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: orgStatusSchema,
  createdAt: z.string(),
  adminCount: z.number(),
  memberCount: z.number(),
  inviteCount: z.number(),
  locationCount: z.number(),
  salesDayCount: z.number(),
  lastUploadAt: z.string().nullable(),
});
export type OrgRow = z.infer<typeof orgRowSchema>;
export const orgListSchema = z.object({ orgs: z.array(orgRowSchema) });

export const ADD_OUTCOMES = ['invited', 'already_invited', 'already_member', 'invalid'] as const;
export const addResultSchema = z.object({ email: z.string(), outcome: z.enum(ADD_OUTCOMES) });
export type AddResult = z.infer<typeof addResultSchema>;

/** POST /api/admin/orgs: the organization and its first admin's invitation. */
export const createdOrgSchema = z.object({ org: orgRef, result: addResultSchema });

/** Spec 10.1 MemberView. It carries no kit user id, so View as finds the person by email (people lookup). */
export const memberSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  status: z.enum(['invited', 'active']),
  invitedAt: z.string(),
  joinedAt: z.string().nullable(),
  isYou: z.boolean(),
  addedByStaff: z.boolean(),
});
export type Member = z.infer<typeof memberSchema>;

export const staffOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: orgStatusSchema,
  createdAt: z.string(),
  fromRequestId: z.string().nullable(),
  suspendedAt: z.string().nullable(),
});
export type StaffOrg = z.infer<typeof staffOrgSchema>;

/** A location on the organization's page: metadata, the day count and the dates it covers (D7). */
export const orgLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  town: townSchema,
  coverage: z.object({ dayCount: z.number(), firstDate: z.string().nullable(), lastDate: z.string().nullable() }),
  notesCount: z.number(),
  lastUploadAt: z.string().nullable(),
});
export type OrgLocation = z.infer<typeof orgLocationSchema>;

/** Spec 10.7 AuditEventView: the server's plain-words summary and the action's allowlisted details. */
export const auditEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  actorEmail: z.string(),
  actorRole: z.string(),
  viewAs: z.object({ targetEmail: z.string() }).nullable(),
  orgId: z.string().nullable(),
  orgName: z.string().nullable(),
  action: z.string(),
  summary: z.string(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const orgDetailSchema = z.object({
  /**
   * `fromRequestSentAt`: when the request it came from was sent; null without one, or once it is deleted. `inSetup`:
   * whether staff setup is open (D23: active, and nobody has ever joined); absent, from an API before it, reads as not.
   */
  org: staffOrgSchema.extend({ fromRequestSentAt: z.string().nullable(), inSetup: z.boolean().optional() }),
  members: z.array(memberSchema),
  locations: z.array(orgLocationSchema),
  recent: z.array(auditEventSchema),
});
export type OrgDetail = z.infer<typeof orgDetailSchema>;

export const orgUpdatedSchema = z.object({ org: staffOrgSchema });

// Staff setup (D23, spec 10.7). The answers keep only ids, names, day counts and dates: an upload's calibration and the
// rest of its coverage are stripped here, so nothing from a setup answer can reach a screen but what the panel shows.
const dayRange = { dayCount: z.number(), firstDate: z.string().nullable(), lastDate: z.string().nullable() };
/** POST and PATCH /api/admin/orgs/:orgId/locations[/:locationId]. */
export const setupLocationSchema = z.object({ location: z.object({ id: z.string(), name: z.string() }) });
/** POST .../sales/uploads: the upload's days and the location's coverage after it. */
export const setupUploadSchema = z.object({
  upload: z.object({ dayCount: z.number(), firstDate: z.string(), lastDate: z.string() }),
  coverage: z.object(dayRange),
});
export type SetupUpload = z.infer<typeof setupUploadSchema>;
/** DELETE .../sales. */
export const setupSalesDeletedSchema = z.object({ deletedDays: z.number(), deletedUploads: z.number(), deletedFiles: z.number() });
export type SetupSalesDeleted = z.infer<typeof setupSalesDeletedSchema>;
/** DELETE /api/admin/orgs/:orgId answers counts; the page reads none of them. */
export const orgDeletedSchema = z.object({ deletedLocations: z.number() });
export const addMembersSchema = z.object({ results: z.array(addResultSchema), members: z.array(memberSchema) });
export const memberUpdatedSchema = z.object({ member: memberSchema });

export const PERSON_KINDS = ['staff', 'org_admin', 'member', 'invited', 'pending', 'rejected', 'removed', 'signed_in'] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

export const personSchema = z.object({
  userId: z.string().nullable(),
  email: z.string(),
  kind: z.enum(PERSON_KINDS),
  org: orgRef.nullable(),
  since: z.string().nullable(),
  staffTwoStep: z.discriminatedUnion('state', [
    z.object({ state: z.literal('on'), since: z.string() }),
    z.object({ state: z.literal('not_set_up') }),
    z.object({ state: z.literal('not_signed_in') }),
  ]).nullable(),
});
export type Person = z.infer<typeof personSchema>;

export const peopleSchema = z.object({ people: z.array(personSchema), truncated: z.boolean() });
export type People = z.infer<typeof peopleSchema>;
export const lookupSchema = z.object({ person: personSchema.nullable() });
export const signedOutSchema = z.object({ revoked: z.number() });
/** POST /api/admin/people/delete: `kitUserId` names the kit user record still to delete by hand, or null. */
export const personDeletedSchema = z.object({ kitUserId: z.string().nullable() });

export const auditPageSchema = z.object({ events: z.array(auditEventSchema), nextBefore: z.string().nullable() });
export type AuditPage = z.infer<typeof auditPageSchema>;
