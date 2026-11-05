# The portal: shared pieces and page ownership

The signed-in app of `docs/portal/spec.md`: access routing (4.3), the app shell (15), and every page in 16.1. Each page owns its route file plus a folder of its own under `src/portal/`; change a page there, and say so in your PR if you have to edit anything shared.

## Which file each page owns

| Page | Route | File (under `client/app/(gate)/(app)/`) | Status |
|---|---|---|---|
| P3 Request access | `/request-access` | `(access)/request-access.tsx` | built |
| P4 Waiting | `/waiting` | `(access)/waiting.tsx` | built |
| P5 No access | `/no-access` | `(access)/no-access.tsx` | built |
| P6 Joining | `/joining` | `(access)/joining.tsx` | built |
| P7 Two-step sign-in | `/settings/security` | `(account)/settings/security.tsx` | exists; staff notice added |
| P8 Staff sign in again | `/staff/sign-in-again` | `(access)/staff/sign-in-again.tsx` | built |
| P9 Locations | `/dashboard` | `(client)/dashboard.tsx` | built |
| P10 Add location | `/locations/new` | `(client)/locations/new.tsx` | built (`src/portal/locations/`, `AddLocationForm`) |
| P11 Forecast | `/locations/[locationId]` | `(client)/locations/[locationId]/index.tsx` | built (`src/portal/locations/`) |
| P12 Sales data | `/locations/[locationId]/sales` | `(client)/locations/[locationId]/sales/index.tsx` | built (`src/portal/locations/`) |
| P13 Upload | `/locations/[locationId]/sales/upload` | `(client)/locations/[locationId]/sales/upload.tsx` | built, web only (`src/portal/upload/`) |
| P14 Notes | `/locations/[locationId]/notes` | `(client)/locations/[locationId]/notes.tsx` | built (`src/portal/locations/`) |
| P15 Town | `/locations/[locationId]/town` | `(client)/locations/[locationId]/town.tsx` | built (`TownProfile`) |
| P16 Location settings | `/locations/[locationId]/settings` | `(client)/locations/[locationId]/settings.tsx` | built (`src/portal/locations/`) |
| P17 Team | `/team` | `(client)/team.tsx` | built (`src/portal/team/`) |
| P18 Settings | `/settings` | `(client)/settings.tsx` | built (`src/portal/settings/`), with the link to two-step settings |
| P19 Requests | `/admin` | `(console)/admin/index.tsx` | built, web only (`src/portal/console/`) |
| P20 Organizations | `/admin/orgs` | `(console)/admin/orgs/index.tsx` | built, web only (`src/portal/console/`) |
| P21 Organization | `/admin/orgs/[orgId]` | `(console)/admin/orgs/[orgId].tsx` | built, web only (`src/portal/console/`) |
| P22 People | `/admin/people` | `(console)/admin/people.tsx` | built, web only (`src/portal/console/`) |
| P23 Audit log | `/admin/audit` | `(console)/admin/audit.tsx` | built, web only (`src/portal/console/`) |
| Tuning chat | `/locations/[locationId]/chat` | `(client)/locations/[locationId]/chat.tsx` | built; read-only under view-as (`src/chat/`) |

Route files under `app/` never carry a platform suffix (`test/marketing/boundary.test.ts`). Put web-only code in a `.web.tsx` file under `src/` with a native file of the same name beside it, as `src/portal/town/TownChart` does.

## How routing works

- `app/(gate)/(app)/_layout.tsx` wraps every signed-in screen in `PortalProvider` and `PortalGate`. The provider reads `GET /api/me` once per sign-in. Until it answers, the page says “Checking your access”; if it fails, the shared error with Try again.
- Each group's layout (`(access)`, `(client)`, `(account)`, `(console)`) wraps its pages in `AccessGuard`, which redirects any path the person may not open to their state's own route (`routing.ts`: `HOME`, `isAllowed`). A page therefore never mounts in the wrong state, so it can assume its state (narrow `me.access` and return an empty view otherwise, as the gate pages do).
- `isAllowed` also gates by role (`/team`, `/locations/new` and a location's Settings tab are for org admins) and never allows the console or `/settings/security` during view-as. A new path must be added there, or it redirects.
- `usePortal().api` re-reads `GET /api/me` on 403 `no_access`, `forbidden`, `staff_setup_required`, `staff_reauth_required` and 409 `view_as_active`, and clears the cached organization, so the guard routes again. Use it for every `/api` call. `applyMe(me)` takes any answer that carries the access (join, decline, a request, End view-as).
- Staff in view-as get the target's access from `/api/me`, so they are routed as the target, under the banner.

## Frames and page layout

- Frames are in the group layouts: the gate frame, the client app frame (top bar with the organization, the nav per role, the email and Sign out), the account frame (client app for members, gate otherwise) and the staff console (web only; native shows one line). Pages render only their page.
- Non-location pages render `<Page eyebrow title lead? side? gate?>` from `shell/Page.tsx`: the header, the one-time notice, then your content. `side` holds the page's actions (at most one primary) or a gate page's side column.
- Location tab pages render only their content: the location layout (`shell/LocationShell.tsx`) already draws the header, the switcher and the tabs. Read the location with `useLocation()` (`{ location, org }`).
- The chat route fills the screen instead of scrolling (`routing.ts` `isFillRoute`).

## Shared pieces

- `PortalProvider.tsx`: `usePortal()` (`me`, `api`, `applyMe`, `refreshMe`, `showNotice`), `useOrg()` (`GET /api/org`, loaded once and shared), and `useReadOnly()` (`{ readOnly, line }`: under view-as, render every write control disabled and show `line` once per form or section, tied by `describedBy`).
- `hooks.ts`: `useLoad(load)` for reads (wrap `load` in `useCallback`; the state is `loading`, `failed` or `ready`, with `reload`), `useAction(fn)` for writes (one at a time, with `pending` and `error`), and `useBreakpoint()` (phone at 640px and below, desktop from 1024px).
- `errors.ts`: `errorCopy(error)` (the shared copy of spec 15.7), `hasCode(error, status, code)` for your page's own codes, `COPY`.
- `api.ts` and `schemas.ts`: zod schemas for the shapes the API returns. Add your routes' schemas to `schemas.ts` and their calls to `api.ts` (or a file of your own); `z.object` strips unknown keys.
- `format.ts`: `formatDate` (“Mar 2, 2026”), `formatTime` (“3:42 PM”), `formatCount`, `plural`, `townLabel`, `roleLabel`.
- `towns.ts`: the twelve towns from the homepage's bundled data, `townProfile`, `townResearchLine` (P11 step 1), `townSentences`. `town/TownProfile.tsx` is the whole profile (chart on web, text and table on native) for P15.
- `AddLocationForm.tsx`: Name and Town, `POST /api/org/locations`, then the new location's Forecast tab (P10).
- `ui/` (import from `src/portal/ui`): `Button` and `LinkButton` (primary white, outline, link; `disabled` keeps the same element and its focus, with aria-disabled on web), `Actions`, `FormField`, `Select`, `TownFields` with `checkTown`, `DataTable` (stacks at 640px and below) and `DefinitionList`, `ConfirmDialog` (with `typedName`; Cancel and Escape wait while its action runs), `MessageFocus` and `useFocusMessage()` (when an action removes its opener, focus moves to the resulting `Notice` or `ErrorNotice`), `Notice`, `ErrorNotice`, `LoadingLine`, `EmptyState`, `ReadOnlyLine`, `StatusTag`, `Panel`, `Section`, `Columns`, `Pair`, `Stack`, and the type components (`Title`, `Heading`, `Body`, `Small`, `Mono`, `Eyebrow`).

Mint (`#7bd2b4`) is for data and selection only, never a button or a message. Visible copy uses curly apostrophes and no em dashes. Nothing animates on keyboard input.

## Tests

`client/test/helpers/portal.ts` has fixtures in the API's shapes for every access state (`ACCESS`, `meOf`, `staffMe`, `viewAsMe`, `orgOf`) and `fakePortalApi`, which answers `/api/me`, `/api/org` and any write you add to `answers`. `renderApp(path, api)` (`helpers/renderApp.tsx`) renders the whole app on native; on web, use `appRoutes(seededRoot(auth))` with `ExpoRoot`, as `test/app/shell.test.web.tsx` does. Add your route to `ROUTES` in `helpers/routes.ts`; `test/marketing/links.test.ts` keeps it equal to the files in `app/`.
