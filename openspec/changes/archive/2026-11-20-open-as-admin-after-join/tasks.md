## 1. Tests first

- [x] 1.1 `api/test/open-as-admin.int.test.ts`: a join leaves the grant live, from the grant, with Team and leave still 403 `open_as_admin_refused`; a suspension after the join still ends it
- [x] 1.2 `api/test/open-as-admin-routes.int.test.ts`: start on a joined organization answers 201 and its admin reads the start; a suspended one, joined or not, answers 409 `org_suspended`; End after a join ends a live grant; the admin sees each change while staff are inside; the not-live cases use a suspension in place of a join
- [x] 1.3 Client: `org.test.web.tsx` (button after a join and hidden while suspended, start, 409 `org_suspended`), `setup.test.web.tsx`, `shell.test.web.tsx`, `settings.test.web.tsx` for the new copy
- [x] 1.4 Run them and see the new API tests fail (6 failed before the change)

## 2. API

- [x] 2.1 `access/resolve.ts`: an open-as-admin grant is live while its organization is active and not suspended since the start; no `isInSetup`
- [x] 2.2 `handlers/open-as-admin.ts`: start checks the organization is active, else 409 `org_suspended`; staff setup keeps `isInSetup`

## 3. Client

- [x] 3.1 P21: Open as admin while active; one Locations line; 409 `org_suspended` reads the page again and says so; setup-closed copy names Open as admin
- [x] 3.2 Banner line and Settings staff activity intro without the setup-only rule

## 4. Docs

- [x] 4.1 `api/README.md` Open as admin, staff setup item 3, the console table; `[CONFIRM]` reworded
- [x] 4.2 `docs/portal/spec.md`: D1, D7, D23, D25, 8a, 10.7, error table, 15.x, 15.5a, P18, P21, 17, 22, changelog
- [x] 4.3 Owner approval of the drafted legal copy (drafted in place 2026-11-15, see 6.3): the privacy page (`client/app/(marketing)/privacy.tsx`, Who can see it and Anthropic) and the homepage FAQ (`client/src/marketing/Home.web.tsx`) said open as admin was only before anyone joins. Approved as drafted by the owner, 2026-11-15; Last updated bumped to November 15, 2026

## 5. Verify

- [x] 5.1 API: the two open-as-admin files, `staff-setup.int`, `isolation`, `routes`, `chain.int`, `access.int`, `view-as*.int`, `isolation.int`, `join.int`
- [x] 5.2 Client: the four web test files above
- [x] 5.3 `eslint` on changed files and `npm run typecheck`

## 6. A reason after a join (owner call, 2026-11-15)

- [x] 6.1 Tests first: `open-as-admin-routes.int` (reason_required, invalid_request, stored on the grant and event, staff activity's `openAsAdmin.reason`, staff setup's notion of joined incl. `firstJoinedAt` alone and the legacy member row, no reason for an invitation only), `routes.test` (1 KB body), client `org.test.web` (dialog, validation, body), `setup.test.web` (400 `reason_required` opens the dialog), `settings.test.web` (Reason column); 5 API tests failed before the change
- [x] 6.2 API (`hasEverJoined` in `access/setup.ts`, the start's body, grant, audit allowlist and summary, staff activity view) and client (reason dialog on P21, `openAsAdmin(api, orgId, reason?)`, staff activity Reason column)
- [x] 6.3 Draft the legal copy in place (privacy Who can see it and Anthropic item, homepage FAQ) and its tests
- [x] 6.4 Docs: `api/README.md` (Open as admin, audit table, staff activity, route table, `tw_view_as_grants`), `docs/portal/spec.md` (D25, 6.x grant `reason`, 8a, 9.x audit table, `StaffActivityView`, 10.7, error table, P18, P21, changelog)
