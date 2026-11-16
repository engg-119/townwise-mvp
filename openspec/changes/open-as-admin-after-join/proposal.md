## Why

Open as admin (D25) only worked while an organization was in setup: the start route answered 409 `org_not_in_setup` once anyone had joined, and a live grant ended at the first join. The owner decided on 2026-11-15 that Townwise staff keep Open as admin after the client joins, with the same powers, so staff can keep helping in the real pages, and, in a second answer the same day, that staff give a reason once anyone has joined, so the organization's admins see why.

## What Changes

- `POST /api/admin/orgs/:orgId/open-as-admin` opens any active organization, joined or not. A suspended one answers 409 `org_suspended` (it answered `org_not_in_setup`).
- Once anyone has joined (staff setup's notion: `firstJoinedAt`, or a member row that joined on an organization from before that field), the start needs `{ reason }`, 5 to 200 characters validated as view-as's (400 `invalid_request`), or answers 400 `reason_required`. The reason is stored on the grant and in `open_as_admin.started`, and the staff activity row carries `openAsAdmin: { reason }` for its Reason column. An organization nobody has joined needs no reason. The route's body limit becomes 1 KB.
- A live open-as-admin grant no longer ends at the first join. It still ends at End, sign-out, the end of the staff window and a suspension (for good, by `lastSuspendedAt`).
- Unchanged: one grant per session, people, seats and requests answer 403 `open_as_admin_refused`, staff routes answer 409 `open_as_admin_active`, the audit events, `byStaff` and "Townwise staff" attribution, and staff activity for the organization's admins, who now see each change while staff are inside.
- Staff setup (D23, the write-only console routes) is unchanged and still ends at the first join; it keeps its own `isInSetup` check.
- Client: P21 shows Open as admin while the organization is active, and after a join asks the reason in a dialog as View as does (400 `reason_required` reads the page again and opens it); one Locations line ("Sales figures and notes are visible only through Open as admin or View as."); 409 `org_suspended` reads the page again and says so. The open-as-admin banner and the staff activity intro on Settings drop the setup-only wording.
- Docs: `api/README.md` (Open as admin), `docs/portal/spec.md` (D1, D7, D23, D25, 8a, 10.7, the error table, 15.x, 15.5a, P18, P21, 17, 22, changelog), with D25's `[CONFIRM]` reworded to the new default.

- Legal copy, drafted for the owner's approval: the privacy page (Who can see it, and the Anthropic item) and the homepage FAQ answer, with the tests that pin them. Nothing ships until the owner approves the wording (task 4.3).

## Capabilities

### New Capabilities

- `open-as-admin`: when staff can open an organization as its admin, when the grant is live and what stays refused.

### Modified Capabilities

None. `openspec/specs/` has no matching capability; the behavior lives in `docs/portal/spec.md` (D25, 8a), which this change updates.

## Impact

- API: `api/src/access/resolve.ts`, `api/src/handlers/open-as-admin.ts`, `api/src/access/setup.ts` (`hasEverJoined`, which `isInSetup` now reads), `api/src/stores/view-as-grants.ts`, `api/src/stores/audit-events.ts`, `api/src/audit.ts`, `api/src/access/routes.ts`; comments in `access/setup.ts`, `handlers/admin.ts`, `handlers/staff-setup.ts`.
- Client: `app/(gate)/(app)/(console)/admin/orgs/[orgId].tsx`, `src/portal/console/api.ts`, `src/portal/shell/OpenAsAdminBanner.tsx`, `src/portal/settings/copy.ts`, `api.ts` and `StaffActivityTable.tsx`, `app/(marketing)/privacy.tsx` and `src/marketing/Home.web.tsx` (drafts), comments in `PortalProvider.tsx` and `schemas.ts`.
- Tests: `api/test/open-as-admin.int.test.ts`, `api/test/open-as-admin-routes.int.test.ts`, `api/test/routes.test.ts`, `client/test/marketing/pages.test.web.tsx`, `home.test.web.tsx`, `client/test/portal/console/org.test.web.tsx`, `setup.test.web.tsx`, `client/test/app/shell.test.web.tsx`, `client/test/portal/settings/settings.test.web.tsx`.
- Tenant isolation: the organization still comes from the grant, never the request (`api/test/isolation.test.ts`).
