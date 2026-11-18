## Why

On 2026-11-17 the owner asked to "make the super admin page much more interesting and useful" and said: "I want to see at a high level how people are using the app and how well it is going." Today the staff console lands on `/admin` (Requests, P19), which is an empty card when nothing is pending, and nothing in the console answers either question across organizations. The owner picked the shape: an overview built from what the app already records, plus a new record of which days each person was active.

The new record is needed because the audit log (`tw_audit_events`) records writes only (uploads, notes, TownwiseAI turns, order decisions, accepted suggestions). An owner who opens Home, reads the forecast and leaves, which is the product's main use, leaves no trace. The client has no analytics tool, and the privacy page says the app sends no telemetry.

## What Changes

- **A new staff page, Overview (P32, `/admin/overview`).** First in the console's nav (Overview, Requests, Organizations, People, Audit log) and where staff land after sign-in and from the wordmark. `/admin` stays Requests, with its links, notices and nav count unchanged. The page has a window switch (7, 28 or 90 days, as `?days=`), stat tiles with the change against the window before, a Needs attention list, an activity-by-day chart, and a table of organizations whose rows open `/admin/orgs/[orgId]`. Changing the window keeps the last answer on screen until the next one arrives.
- **One new staff read, `GET /api/admin/overview?days=7|28|90`** (route `admin.overview`, policy `staff`, one entry in `TOWNWISE_ROUTES`). It answers totals for the window and the window before it (staff setup uploads count as sales uploads, by the owner's answer of 2026-11-17); a per-day series of active people and of people's actions grouped by kind (from audit actions, each action assigned to one group or to none by a table a test pins); one row per organization (status, setup, last active day, active people, actions, sales days and last upload, forecast state per location with the window's live accuracy, the weekly refresh's outcome, TownwiseAI spend this month against the budget); and a Needs attention list computed on the server.
- **A new record of active days, `tw_activity_days`.** One document per person, organization and UTC day, written when a member or org admin with their own seat makes any `/api` request that passes its policy, at most once per person per day per replica, from the route chain after the policy and never inside `resolveAccess`. Never for staff, view-as or open as admin. It holds a person id, an organization id and a date, nothing else (its `_id` is built from those three, so not even a time of day is kept). The write never delays or fails a request. Rows older than 180 days are deleted (owner, 2026-11-17); organization and person deletion delete theirs.
- **Privacy.** The console still shows counts and dates only (D7), with one new kind of figure: a published forecast's live accuracy (typical error as a percent, with its scored-day and in-range counts), never a guest or sales figure. The privacy page says Townwise keeps the dates on which each signed-in person used the app, for 180 days. Both are marked `[CONFIRM: ...]` in the spec text.
- **Spec decision D48** records the owner's request and these choices. D48 is reserved for this change; the spec text is written during implementation (tasks.md), not in this proposal.

## Capabilities

### New Capabilities
- `staff-overview`: the Overview page and its read: the window, the totals and their change, the activity series and its action groups, the organizations table, Needs attention, and what the console may show.
- `activity-days`: when a person's active day is recorded, what is kept, how long, and how it is deleted.

### Modified Capabilities
None. The staff console has no capability spec under `openspec/specs/`; its contract is `docs/portal/spec.md` (10.7, P19 to P23) and `api/README.md`, updated by this change's tasks.

## Impact

- API: new `api/src/stores/activity-days.ts` (`tw_activity_days`, tenant store), new `api/src/access/activity.ts` (the recorder), `api/src/access/routes.ts` (the recorder call in `authorize`, the `admin.overview` entry), new `api/src/handlers/overview.ts`, `api/src/stores/cross-tenant.ts` (the overview's cross-organization reads, old-row removal, person deletion), `api/src/access/policy.ts` (a scope for an organization `orgs.list()` returned), `api/src/handlers/deletion.ts` (organization deletion, both sweeps), `api/src/stores/index.ts` (registration and indexes), `api/src/app.ts` (the recorder on the context).
- Client: new `client/app/(gate)/(app)/(console)/admin/overview.tsx`; new pieces in `client/src/portal/console/` (schema, API call, words, tiles, attention list, `ActivityChart.tsx` and `ActivityChart.web.tsx`, organizations table); `client/src/portal/skeleton/console.tsx`; `client/src/portal/routing.ts` (`HOME.staff`, `consoleNav`); `client/src/portal/shell/TopBar.tsx` (the console wordmark's link); `client/app/(marketing)/privacy.tsx`.
- Docs: `docs/portal/spec.md` (D48, P32 and its page section, the console nav in 15.4, 6.30 `tw_activity_days`, 10.7's new route, deletion in 10.7), `api/README.md` (the route, the collection, the recorder, deletion).
- Tests: `api/test/isolation.test.ts` (two new importers of `stores/cross-tenant.ts`), `api/test/routes.test.ts`, `api/test/indexes.test.ts`, new API unit and integration tests, client tests beside `client/test/portal/console/` and in `client/test/portal/logic.test.ts`.
- Infra and dependencies: none. No new package, no new origin, no CSP change.
- Cost: one upsert per active person per day per replica, and one staff read of a few dozen small queries per Overview load (most of it one forecast read per location; see design.md).

## Owner sign-offs

All three given by the owner on 2026-11-17, with the proposal's approval.

1. Given. Townwise keeps, for 180 days, the dates on which each signed-in member or org admin used the app, tied to their account and organization. In an organization of one person this is that person's activity, visible to staff by organization.
2. Given. The console shows a published forecast's live accuracy (typical error percent and day counts) per location. Staff already see backtest error in the forecast lab.
3. Given. The privacy page's "The Townwise app sends no telemetry" stays true (the app sends nothing new), and a new line says what the server keeps.
