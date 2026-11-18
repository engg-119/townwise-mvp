## Context

The staff console (spec 10.7, P19 to P23) is four pages: Requests (`/admin`, where staff land), Organizations, People and the Audit log. Each answers one narrow question. None says how the product is being used or how well it is going across organizations.

What the code already has, read for this change:

- **Writes are audited, reads are not.** `tw_audit_events` (`api/src/stores/audit-events.ts`) has one event per write, with `actorRole` (`member`, `org_admin`, `superadmin`, `user`, `system`) and indexes on `{ at }` and `{ orgId, actorRole, at }`. A member's own action carries their seat role; staff opened as admin record `superadmin` (`actorOf` in `api/src/handlers/team.ts`). Nothing records a read, so an owner who opens Home and leaves is invisible.
- **Every request already resolves the caller.** `authorize` in `api/src/access/routes.ts` runs `resolveAccess`, builds the `Principal` (`principalOf`, `api/src/access/policy.ts`), runs the view-as, open-as-admin and policy guards, then stores the principal for the handler. `resolveAccess` says in its header that it never writes (`api/src/access/resolve.ts`, lines 1 to 3); this change keeps it that way.
- **`GET /api/me` (policy `signed_in`) is read on every app load** by `PortalGate`, and a member with an active seat in an active organization resolves to a `member` principal there too. So "made any `/api` request that passed its policy" covers opening the app.
- **Per-organization counts exist.** `adminOrgStats` (`api/src/stores/cross-tenant.ts`) gives seats, invitations, locations, sales days and the newest applied upload for every organization in four aggregates; the Organizations page reads it already.
- **Forecast accuracy exists per location.** `api/src/forecasts/score.ts` defines live accuracy as `{ days, inRange, typicalErrorPct, from, to }` (WAPE, null under 5 scored days). `ForecastReader.window(scope, location, range, today)` returns the window's `accuracy` over its own days, each from the run chosen for it (D42). `ForecastReader.latest` returns the newest run's own live accuracy, which with weekly runs (D42) usually covers fewer than 5 passed days and so is usually null.
- **Staff already see forecast error.** The forecast lab panel (`client/src/portal/console/CalibrationsPanel.tsx`) prints backtest weekly WAPE.
- **Days.** Server-side days are UTC: `utcDay(ctx.now())` (`api/src/dates.ts`) keys `tw_upload_days`, and `tw_chat_usage` keys UTC months. Forecasts and TownwiseAI use the town's day (`localDay` in `api/src/time-zones.ts`).
- **Sweeps.** `removeOldUploadDays` runs in the daily file sweeper (`api/src/files/sweeper.ts`), which `api/src/main.ts` builds only while stored files are on. The weekly worker is a separate Container Apps job. No collection uses a TTL index.
- **The console is web only.** `ConsoleFrame` (`client/src/portal/shell/Frame.tsx`) shows a "use the web" page on native. Charts on web are inline SVG with no library (`client/src/portal/analytics/AnalyticsCharts.web.tsx`); their native files draw nothing (D21).

## Goals / Non-Goals

**Goals:**

- One page that tells staff, at a glance, how many organizations and people used Townwise in a window, what they did, whether that is going up or down, how each organization's forecast is doing, and what needs a staff member's attention now.
- Record that a person used the app on a day, and nothing else about it.
- Keep D7: no sales figure, guest count, note text or chat text reaches the console.

**Non-Goals:**

- Page views, clicks, sessions, funnels, durations or any third-party analytics. Nothing new is sent from the client.
- A per-person activity timeline or page.
- Any change to Requests (`/admin`).
- Native support for the console (it stays web only).

## Decisions

### 1. Activity days: what is kept

A new collection, `tw_activity_days` (`api/src/stores/activity-days.ts`, a tenant store whose functions take an `OrgScope`), holds one document per person, organization and UTC day:

```
{ _id: "<orgId>:<userId>:<YYYY-MM-DD>", orgId: ObjectId, userId: string, day: "YYYY-MM-DD" }
```

- The `_id` is built from the three fields, so it is the uniqueness itself and holds no time. A default ObjectId would carry the second of the person's first request that day, which is more than "a date".
- No path, route id, page, IP address, device, count or time is stored.
- Indexes: `{ orgId: 1, day: 1 }` (an organization's window), `{ day: 1 }` (the overview's cross-organization read and old-row removal), `{ userId: 1 }` (person deletion).
- The day is UTC (`utcDay(ctx.now())`), as the API's other server-side days are. Evening use in Eastern time (after 7 or 8 pm) lands on the next UTC day; for "which days did this person use the app" that shift is accepted and the console labels its days as UTC.

Alternatives considered: one counter per organization per day (cannot count distinct people, and the 1-member case identifies the person anyway); storing the route id (that is page-view analytics, a non-goal); the server's request log (it lives in Log Analytics, with IP and path, and the app cannot query it).

### 2. Activity days: when it is written

A recorder (`api/src/access/activity.ts`) is called in `authorize` (`api/src/access/routes.ts`), right after `recordResolution`, so only after the view-as guard, the open-as-admin guard and the route's policy have passed. It records only when the principal is `kind: 'member'` with `memberId !== null`, `viewAs === null` and `openAsAdmin === null`: a member or org admin on their own seat in an active organization. Staff, staff in view-as (whose principal carries the target's id), staff opened as admin, and people with no seat, a pending request or a suspended organization are never recorded.

- **At most once per person per day per replica.** The recorder keeps an in-process `Set` of `"<orgId>:<userId>:<day>"` keys and clears it when the UTC day changes. A key already in the set returns at once. Otherwise it adds the key and upserts `{ _id }` with `$setOnInsert`; a duplicate-key error from a race is success. With two replicas a person costs at most two upserts a day.
- **Never delays or fails the request.** The call is not awaited (`void`), and its promise's rejection is caught and logged once as `townwise.activity_write_failed` with `orgId` and the error's code only. A failed write removes its key from the set, so the next request that day tries again.
- A request that passes its policy and is then refused by its body parser or route limiter still counts: the person used the app that day.

Not inside `resolveAccess`: it must stay a pure read (its header), and it runs before the guards, so it would record view-as reads as the target's.

### 3. Activity days: how long, and deletion

- **180 days** (owner, 2026-11-17, so the 90-day window has a full window before it). Rows with `day` before `utcDay(now, -179)` are deleted, which keeps today and the 179 days before. They are deleted by the recorder itself: the first write of each UTC day in each replica also runs `removeOldActivityDays(connection, beforeDay)` (`stores/cross-tenant.ts`, one `deleteMany` on the `{ day }` index), not awaited and logged with its count. This needs no stored files (the file sweeper exists only while they are on) and no worker. A day with no activity at all deletes nothing that day, which only delays removal until the next active day.
- **Organization deletion** (`api/src/handlers/deletion.ts`) deletes the organization's rows with the other `removeForOrg` calls, and again in its second sweep of late writes. In practice no late write can happen: deletion needs a suspended organization, and a suspended organization's members never resolve as `member`.
- **Person deletion** (`deletePersonRecords`, `stores/cross-tenant.ts`) deletes the person's rows in every organization (not counted, so its audit details are unchanged).
- **A person removed from an organization** keeps their rows there until they age out within 180 days (owner, 2026-11-17: no delete on removal). They were active on those days; the record says only that.

Alternatives considered: a TTL index (not relied on with Azure DocumentDB, and no collection in the repo uses one); the daily file sweeper (off whenever stored files are off); the weekly worker job (a forecasting job, and a second process to keep in step).

### 4. The read: `GET /api/admin/overview?days=7|28|90`

Route `admin.overview`, policy `staff`, body `none`, no limiter, in `TOWNWISE_ROUTES`, handled by a new `api/src/handlers/overview.ts`. `days` is required to be 7, 28 or 90 (400 otherwise); the client sends 28 by default. The window is the last `days` UTC days, today included; the window before it is the `days` days before that.

The answer:

```
{
  window: { days, from, to, previousFrom, previousTo },
  recordingSince: "YYYY-MM-DD" | null,          // the earliest stored activity day
  totals: {
    activeOrgs:    { count, previous, of },     // of: active organizations someone has joined (not in setup)
    activePeople:  { count, previous, of },     // of: active seats in active organizations
    chatTurns:     { count, previous },
    salesUploads:  { count, previous },
    notesWritten:  { count, previous },
    orderDecisions:{ count, previous }
  },
  series: [ { day, activePeople, actions: { uploads, notes, townwiseAi, orders, team } } ],
  schedule: { running, paused: { at, email } | null },
  orgs: [ {
    id, name, status, inSetup, lastActiveDay, activePeople, actions,
    salesDayCount, lastUploadAt, forecastsOn,
    chat: { spentMicroUsd, budgetMicroUsd },
    locations: [ { id, name,
      newestRun: { dataThrough, madeAt, engine } | null,
      accuracy: { days, inRange, typicalErrorPct } | null,
      refresh: { week, outcome } | null,
      lastScheduled: "succeeded" | "failed" | "live" | null } ]
  } ],
  attention: [ { kind, orgId, requestId, count, since } ]
}
```

- **Active.** A person is active in a window when they have an activity day in it; an organization is active when any of its people is. `previous` is null for `activeOrgs` and `activePeople` when `previousFrom` is before `recordingSince` (or nothing is recorded yet), so the page never compares against days before the record existed. With 180 days kept (owner, 2026-11-17), the 90-day window's previous window (90 to 179 days ago) is covered once the record is 180 days old; until then `recordingSince` makes it null.
- **Actions** are audit events with `actorRole` `member` or `org_admin` in the window, plus staff setup's `sales.uploaded` (below), so staff otherwise, view-as, open as admin and the system never count. Each action belongs to one group or to none, by a table in `api/src/handlers/overview.ts` that covers every key of `AUDIT_DETAIL_KEYS`, which a unit test pins (a new audit action fails the test until it is placed):

  | Group | Audit actions |
  |---|---|
  | `uploads` (Uploads and data) | `sales.uploaded`, `sales.deleted`, `sales.upload_deleted`, `data.turned_off`, `data.turned_on`, `data.renamed`, `data.edited`, `file.uploaded`, `file.deleted`, `file.raw_deleted`, `files.raw_deleted_all`, `order.item_sales_uploaded`, `order.item_sales_deleted` |
  | `notes` (Notes, rules and calendars) | `note.created`, `note.updated`, `note.deleted`, `rule.created`, `rule.updated`, `rule.deleted`, `owner_calendar.added`, `owner_calendar.removed`, `owner_calendar.refreshed`, `google_calendar.connected`, `google_calendar.disconnected` |
  | `townwiseAi` (TownwiseAI) | `chat.turn_completed`, `chat.conversation_deleted`, `agent.question_answered`, `agent.suggestion_accepted`, `agent.suggestion_dismissed`, `file.ai_read_requested`, `file.ai_undone`, `order.setup_read`, `order.card_saved`, `order.card_dismissed`, `calibration.requested` |
  | `orders` (Orders) | `order.setup_saved`, `order.count_saved`, `order.decision_saved`, `order.rule_saved`, `order.rule_turned_off` |
  | `team` (Team and settings) | `member.invited`, `member.joined`, `member.role_changed`, `member.removed`, `member.left`, `location.created`, `location.updated`, `location.deleted`, `org.renamed`, `org.weekly_suggestions_changed` |
  | none | `access_request.*`, `org.created`, `org.suspended`, `org.reactivated`, `org.deleted`, `member.declined` (actor role `user`), `file.ai_read` (written by the reader, not the person), `org.originals_deleted`, `forecast.*`, `calibration.finished`, `calibration.scheduled`, `org.forecasts_switched`, `forecast_schedule.*`, `view_as.*`, `open_as_admin.*`, `people.signed_out_everywhere`, `person.deleted`, `staff_action.not_applied` |

  An action is an event, not a click. Some single steps write two events: a dropped sales file writes `file.uploaded` and, once read, `sales.uploaded`; accepting a weekly suggestion writes `agent.suggestion_accepted` and `note.created` (or `rule.created`). The page says "actions recorded", not "clicks".
- **Totals** count one action each: `chat.turn_completed`, `sales.uploaded`, `note.created`, `order.decision_saved`, with the same actor rule. An organization's `lastUploadAt` comes from `adminOrgStats` and includes every applied upload, as the Organizations page does.
- **Staff setup uploads count as uploads** (owner, 2026-11-17). Staff setup's upload (`uploadSetupSales`, `api/src/handlers/staff-setup.ts`) writes `sales.uploaded` with `actorOf(staff)` from `api/src/handlers/admin.ts`: `actorRole: 'superadmin'`, `viewAsGrantId: null`, the organization's `orgId`. Staff opened as admin also write `superadmin` events, but always with their grant's id in `viewAsGrantId` (`actorOf` in `api/src/handlers/team.ts`, the file reader's `openAsAdminGrantId`, the TownwiseAI reader's `requestedGrantId`). The rule: a `sales.uploaded` event counts when its `actorRole` is `member` or `org_admin`, or when its `actorRole` is `superadmin` and its `viewAsGrantId` is null (staff setup, D23). Such an event counts in the sales uploads total, in the `uploads` group of the per-day series and in its organization's actions column. No other staff event counts anywhere, staff opened as admin and staff setup's other writes (locations, sales deletes) included. Staff never have activity days, so staff setup never adds to active people or active organizations, and an organization in setup can show uploads with 0 active people.
- **The series** has one entry per day of the window, oldest first, zeros included.
- **Organizations** come from `orgs.list()`, every status. `inSetup` is `isInSetup` (`api/src/access/setup.ts`). `lastActiveDay` is the newest stored day (null when none in the 180 days kept). `salesDayCount` and `lastUploadAt` come from `adminOrgStats`. `forecastsOn` is `org.forecasts.on`. `chat` is this UTC month's `tw_chat_usage` against `chatMonthlyBudgetUsd`. Rows are sorted by actions in the window, most first, then by name.
- **Per location**: `newestRun` and `accuracy` come from one `ForecastReader.window` read over the window's passed days in the town (`from` = the town's today less `days`, `to` = the town's yesterday, at most 90 days, under the reader's 92), whose `accuracy` is the window's live accuracy (null under 5 scored days); `newestRun` is the first of its `runs`, and null when none is published. `refresh` is the location's latest `tw_forecast_weeks` row of the last 8 weeks (`forecastWeeks.latestByLocation`), and `lastScheduled` the status of its newest calibration with `via: 'scheduled'` (`calibrations.list`), `live` for queued or running.
- **Reads.** Organizations are scoped by a new `scopeForListedOrg(staff, org)` in `api/src/access/policy.ts`, minted from a record `orgs.list()` just returned, so the handler does not read each organization again through `scopeForStaffOrg`. Cross-organization reads are new functions in `stores/cross-tenant.ts`, which `handlers/overview.ts` and `access/activity.ts` import (both added to `api/test/isolation.test.ts`): `activityDaysSince(connection, day)` (the rows, projected to `orgId`, `userId`, `day`; at most one per person per day kept, so people times 90), `peopleActionsSince(connection, at)` (`{ orgId, action, at }` of member and org admin events since the previous window's start, bucketed by UTC day in Node, which avoids relying on `$dateToString` support in DocumentDB), `openInvitesBefore(connection, at)` (counts and oldest `invitedAt` per organization), `chatUsageForMonth(connection, month)`, and `removeOldActivityDays`.
- **Cost.** About 10 queries for the whole set, plus per organization 1 to 4 small indexed reads (locations, setup, calibrations, week rows), plus one forecast window read per location (each a few reads of runs, rows, sales days, notes and rules). With today's handful of organizations this is well under a second; task 2.6 measures it on the local data and, if it passes 2 seconds, the per-location forecast columns move to a second read the table makes after the page shows. `adminOrgStats` aggregates every sales day, as the Organizations page already does.
- **Logs.** One `townwise.admin_overview_read` line with `days` and the organization count. No email, no name.

### 5. Needs attention

Computed on the server, independent of the window, in this order, then oldest `since` first. Each item has a `kind`, an `orgId` (null when it has none), a `requestId` (requests only), a `count` where it says how many, and a `since` date. The client builds each link from the ids with `client/src/portal/console/links.ts`, so the server never writes client paths.

| Kind | Rule | Link | Cost |
|---|---|---|---|
| `request_waiting` | each pending access request created more than 2 days ago | `requestHref('pending', id)` | cheap: `requests.listByStatus('pending')`, as Requests reads |
| `refresh_off` | the weekly refresh does not run on this server (`ctx.labRunner === null` or `TOWNWISE_WEEKLY_FORECASTS` off) | none | free: config |
| `refresh_paused` | staff paused the weekly refresh (`forecastSchedule.paused()`) | `/admin/orgs` (the pause is on each organization's page) | cheap: one document |
| `refresh_failed` | an organization with a location whose newest scheduled calibration failed, or whose latest week row is `start_failed`; `count` is the locations | `orgHref(orgId)` | moderate: two indexed reads per organization, shared with the table's columns |
| `no_recent_upload` | an active organization, not in setup, with at least one location, and no applied upload in 14 days (or ever) | `orgHref(orgId)` | cheap: `adminOrgStats` |
| `in_setup` | an organization still in staff setup (D23) | `orgHref(orgId)` | cheap: `isInSetup`, a members read only for an organization from before `firstJoinedAt` |
| `invites_waiting` | an organization with invitations open more than 7 days; `count` is how many | `orgHref(orgId)` | cheap: one query on `tw_members` |
| `chat_budget` | an organization that has spent more than 80% of this month's TownwiseAI budget (only while the budget is above 0) | `orgHref(orgId)` | cheap: one query on `tw_chat_usage` |

The thresholds (2 days, 14 days, 7 days, 80%) are constants in `handlers/overview.ts`, each marked `[CONFIRM]` in the spec text.

### 6. Privacy and D7

- The console keeps counts and dates. The one new kind of figure is live accuracy: `typicalErrorPct` with `days` and `inRange`, shown as "Typical error 12.4% over 21 days, 17 in range". It is derived from guests and forecasts but is neither; staff already see backtest error. The client's zod schema keeps only `{ days, inRange, typicalErrorPct }` of it, and only the fields above of the whole answer, so nothing else can reach a screen. `[CONFIRM: the console shows a published forecast's live accuracy as a typical error percent with its scored-day and in-range counts, never a guest or sales figure]`
- Spend is Townwise's own cost of TownwiseAI, not the restaurant's money, and is already the budget the chat enforces.
- **Activity identifies people.** For an organization with one member, "1 active person on Tuesday" is that person. Staff already see every person by email on People (P22) and every member of an organization on P21, so the overview tells staff when a known person used the app. The page never lists people by name or email and has no per-person view, but anyone with the console can work it out for a small organization. This is why the privacy page says it plainly and why it is a sign-off.
- The privacy page (`client/app/(marketing)/privacy.tsx`) gains, in "The short version" after the telemetry line and again in "What we keep when you sign in": "Townwise keeps the dates on which each signed-in person used the app, for 180 days, to see whether the product is used. It keeps the date only: not the time, the page or what you did. Townwise staff see it by organization." "Delete your account" in "Your choices" adds the dates to what is deleted. The telemetry line stays true: the app sends nothing new. `[CONFIRM: Townwise keeps the dates on which each signed-in person used the app, for 180 days]`

### 7. The page

`client/app/(gate)/(app)/(console)/admin/overview.tsx` (P32, title "Overview"), with its pieces in `client/src/portal/console/`: `overviewSchema` in `schemas.ts`, `fetchOverview` in `api.ts`, pure words and change figures in `overview.ts`, `StatTiles.tsx`, `AttentionList.tsx`, `ActivityChart.tsx` and `ActivityChart.web.tsx`, and `OverviewOrgs.tsx`; `OverviewSkeleton` in `client/src/portal/skeleton/console.tsx`.

- **Landing.** `HOME.staff` in `client/src/portal/routing.ts` becomes `/admin/overview`, which is where `AccessGuard` sends staff after sign-in (`routeFor` sends `/dashboard`, which staff may not open). `consoleNav` gains Overview first. The console wordmark's link (`client/src/portal/shell/TopBar.tsx`, `consoleBar ? '/admin'`) becomes `/admin/overview`. `isAllowed` needs no change: `CONSOLE_PAGES` already matches every `/admin` path. The frame keeps reading the pending count off `/admin`, as it does on every other console page.
- **Window switch.** `FilterTabs` (`console/parts.tsx`) with links to `?days=7`, `?days=28` and `?days=90`, labeled "7 days", "28 days" and "90 days"; no query means 28. A change of window keeps the last answer on the page until the next arrives, as Requests holds its last list across tabs (`admin/index.tsx`, the `held` state): the skeleton shows only before the first answer.
- **Stat tiles.** Six tiles built from `Panel`, `Eyebrow` and the `value` type tokens: active organizations ("4 of 6"), active people ("9 of 14"), TownwiseAI turns, sales uploads, notes written, order decisions. Each says its change in words under the figure ("Up 3 from the 28 days before", "Same as the 28 days before", "Down 2 from the 28 days before", or "No earlier days recorded"), never by color alone.
- **Needs attention.** A list in plain words with a link per item ("Sample Tavern has had no upload in 16 days", "2 invitations to Sample Pub are unanswered after 7 days"); "Nothing needs attention." when empty. Organization names come from the answer's rows.
- **Activity by day.** `ActivityChart.web.tsx` draws, as inline SVG with no library and on the analytics charts' scale rules (`scaleTop` from `AnalyticsCharts.web.tsx`), two bands on one day axis: people active each day (mint bars) and actions each day as stacked bars in the group order of decision 4, with a legend. Hover shows the day's counts with `ChartTooltip.web.tsx` and `useChartHover`. The SVG is `aria-hidden`; a summary line and a "Show each day" table carry the same numbers. `ActivityChart.tsx` draws nothing, as `AnalyticsCharts.tsx` does on native (D21); the console never renders on native, but the base file keeps the import platform-neutral. Fills for the five groups come from existing tokens only (mint first), checked for contrast in both themes in the UI review; no new token unless that review asks for one.
- **Organizations.** `DataTable` rows, each name a link to `orgHref(id)`: status (and "In setup"), last active day, people active, actions, sales days, last upload, forecast (one line per location: newest run's date and its accuracy, or "No published forecast"), weekly refresh outcome, TownwiseAI this month ("$4.10 of $20").
- **Phone width.** At 320px the tiles stack, the chart scales to the column (bars thin to 2px at 90 days), and the tables follow the console's existing phone layout (`client/test/portal/console/phone.test.web.tsx`).

### 8. Rollout

On by default, no switch (owner directive, 2026-11-16: features are on unless the owner says otherwise). The recorder starts writing at deploy; until there are records, the page's activity figures read 0 with "No earlier days recorded", and `recordingSince` says from when. Rollback is the previous revision: `tw_activity_days` is ignored by old code and can be dropped.

### 9. Testing

- API unit (`api/test/overview.test.ts`): the action table covers every audit action exactly once; windows, previous windows and `recordingSince` cut-offs; change figures; the attention rules at their thresholds; sorting.
- API integration (`api/test/overview.int.test.ts`): a member's GET writes one row, a second request that day writes none, a second app instance writes at most one more; staff, view-as, open as admin and a suspended organization's member write none; a failed write still answers the request; rows older than 180 days are removed on the first write of a day and a row 179 days old stays; organization and person deletion remove rows; a staff setup upload counts in the uploads total, series and actions column and an open-as-admin upload counts in none; the route answers 403 to members, 400 for `days=10`, and an answer with no sales figure, guest count, note text or email in it (a sentinel check over the JSON); another organization's data never mixes into a row.
- `api/test/routes.test.ts`, `api/test/isolation.test.ts` (the two new importers), `api/test/indexes.test.ts`.
- Client (`client/test/portal/console/overview.test.web.tsx`): tiles and their words, attention links, the window switch keeps the last answer with no skeleton between, the table's links, the schema strips unknown keys; `client/test/portal/logic.test.ts` (`HOME.staff`, `consoleNav`, `/admin/overview` allowed only to staff); `phone.test.web.tsx` at 320px; the skeleton test.

## Risks / Trade-offs

- [Activity identifies a person in a small organization] → Dates only, no page or time, 180 days, deleted with the person; stated on the privacy page; owner sign-off.
- [Actions are events, so some steps count twice] → The group table is explicit, the page says "actions recorded", and the totals each count one action.
- [The read grows with locations] → Measured in task 2.6; the per-location forecast columns can move to a second read.
- [UTC days split Eastern evenings] → Accepted for a usage signal; the days are labeled UTC.
- [A replica that writes nothing for a day leaves old rows a day longer] → Removal runs on the next active day; at most a few days late, and the overview reads only its window.

## Migration Plan

1. Deploy API and web together. `tw_activity_days` and its indexes are created at boot; no data migration.
2. Activity figures fill in from the deploy day on.
3. Rollback: the previous revision; the collection can be dropped.

## Owner decisions (2026-11-17)

The owner approved this proposal on 2026-11-17, gave the three sign-offs in proposal.md, and settled the open questions:

1. **Retention is 180 days, not 90**, so the 90-day window can show a change for active people and active organizations. Every mention of the retention, the privacy page's line and its `[CONFIRM]` included, says 180 days (decisions 3, 4 and 6).
2. **A member removed from an organization keeps their activity days there until they age out.** No delete on removal; person deletion still deletes them (decision 3).
3. **Uploads staff make in staff setup count as sales uploads.** The exact rule is in decision 4: they count in the sales uploads total, the series' uploads and the organization's actions, never in active people or organizations.

## As built

**The read's cost (task 2.6, 2026-11-17).** Measured on the handler, end to end:

- The local `townwise` database (1 organization, 1 location, 174 audit events), read only (no index build, no collection create, a guard that stopped on any write): 21 queries, 10 to 40 ms for 7, 28 and 90 days.
- 12 seeded organizations in the test database, 3 locations each with a published run (36 forecast reads), 48 people with 5,760 active-day rows over the 180 days kept, and 7,200 audit events: 137 commands for 7 days and 281 for 28 and 90 days, counting the sign-in check and `resolveAccess`; 64 to 104 ms through HTTP.

Both are far under 2 seconds, so the per-location forecast columns stay in the one read.

**The previous window at the retention edge (decision 4, "Active").** The 90-day window's previous window starts 179 days back, which is the oldest day the 180 kept allow. `recordingSince` is the earliest stored row, so with few people a quiet day at that edge would make the 90-day change null nearly always, against the reason for 180 days (owner decision 1). As built, `hasPrevious` (`api/src/handlers/overview.ts`) also counts the previous window as covered when the earliest row is within `RETENTION_EDGE_SLACK_DAYS` (14) of the oldest day kept: recording has then run for the whole retention, and the gap is quiet days, not missing recording. Otherwise the rule is exact (`recordingSince` on or before `previousFrom`). The slack only ever matters to the 90-day window. Its cost: in days 166 to 179 after the record first started, the 90-day change shows although up to 14 of the previous window's first days predate the record. Tests: `api/test/overview.test.ts`.

**After the UI review (2026-11-17).** An independent review of the built page asked for these, and decision 7 reads with them:

- **Loading.** A window change keeps the last answer, but dimmed (opacity 0.6, as the calendar holds its grid), `aria-busy` and inert, under a line in a slot whose height is kept in every state: "The last 28 days, {from} to {to} (UTC).", and while the next loads "Loading the last 90 days… Below: the last 28 days until then.". A failed read shows the error in place of the figures, never the old ones under the new tab; Try again moves focus to that line (`useFocusMessage`), since the button goes with the error.
- **Tiles.** Eight, four to a row from 1024px: Organizations that used the app "{n} of {m} with people in them", People who used the app "{n} of {m} members and org admins", Forecast days in range and Locations with a published forecast (both computed in `overview.ts` from the answer's locations, no API change: the days in range of the scored days across locations with a scored window, "In range on 37 of 45 scored days", or "No forecast days scored yet" with no figure; the locations with a run used on the window's days, of all), then the four counts. The tiles and the table's usage columns never say a bare "active", which the table's Status keeps for an organization that is not suspended. A line under the tiles says who counts, what an action is and that days are UTC. With no previous value the words are "Not enough history to compare". The figure's comma is set in the sans face, so "1,234" does not read "1 , 234". On phones Needs attention comes before the tiles.
- **Chart.** The groups differ by mark in both palettes, existing tokens only: uploads solid `white` (mint is the people bars' alone), notes a diagonal hatch, TownwiseAI solid `line`, orders dots, team an outline; the key draws the same marks, and the patterns are scaled back by the svg's measured width so they stay square. At 90 days on a screen under 480px each bar is a week counted back from the newest day (actions summed, the most people on one of its days), with a caption saying so. The caption repeating the scales is gone, and the group names are lower case mid-sentence.
- **Organizations.** Below 1024px the table stacks as on phones (`DataTable`'s `stack="belowDesktop"`), since ten columns scrolled sideways hid three with no cue. Each head says its span: the window, all time (Days of sales), the latest week (Weekly refresh), this month (TownwiseAI). The forecast cell leads with "81% in range (17 of 21 days)" and keeps the typical error and the newest run used under it in `text3`.
- **Needs attention.** A link takes at most 40% of the row from 641px, so a long organization name wraps. The staff pause is one switch for every organization, on each organization's page (`WeeklyRefresh.tsx`), so its line says so and links to the first organization not suspended (Organizations with none).
