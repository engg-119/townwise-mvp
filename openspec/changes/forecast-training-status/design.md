## Context

What exists (develop at cb8e3f53), read for this design:

- **Calibrations** (spec 6.23, `api/src/stores/calibrations.ts`, `tw_calibrations`). One record per lab run: `requestedBy { userId, role, via }` with via `chat | console | file | scheduled`, status `queued | running | succeeded | failed` (`LIVE_STATUSES` the first two), `failure`, `gate { published, reason }`, `championRunId` (null on a first forecast), `dataThrough` set at the input fetch, `scorecardJson`, `requestedAt`, `startedAt`, `finishedAt`, and `liveLocation` (a unique partial index: one live calibration per location). Nothing records what started a system calibration, how many days it used or its first day. The schema is `strict: 'throw'`.
- **Who starts one** (`api/src/lab/service.ts` `launch`). People: TownwiseAI chat (`via: 'chat'`), a pressed TownwiseAI file read and a bookings confirm (`via: 'file'`), staff (`via: 'console'`). The system, as `SYSTEM_REQUESTER` (`role: 'system'`, `via: 'scheduled'`): the weekly refresh (`lab/schedule.ts` `consider`) and D59 refits (`considerRefit`). A weekly start is linkable through `tw_forecast_weeks.calibrationId`; a refit is not.
- **Refit marks** (D59, `tw_locations.refit { wantedAt, startedAt, starts }`). `wantRefit` (`$max`) is called by `agent/refit.ts` `wantRefitFor` (sales uploads and staff setup uploads, a person's notes and rules, undo of a file read, agent undo, calendar answers) and directly by `files/worker.ts` (the file reader's days) and `agent/apply.ts` (TownwiseAI's changes). The mark stores no cause. The hourly pass (`createForecastSchedule().pass()`) takes a mark 15 quiet minutes old with no start in 24 hours, inside the live cap of 3 and the weekly cap, and clears it by compare-and-set on `wantedAt`.
- **First forecast after onboarding.** It already starts on its own: the upload marks a refit, and the pass starts it within about 15 to 75 minutes, when the lab runner is on, `TOWNWISE_WEEKLY_FORECASTS` is true, staff have not paused the schedule, the organization is active with forecasts on, the history spans 230 days (`GATE.baselineMinHistoryDays`) and the caps allow. Under 230 days the pass clears the mark and nothing runs. A first forecast is published only when the gate passes (G1 included).
- **A timed-out calibration.** A live calibration older than 20 minutes (`CALIBRATION_TIMEOUT_MS`) is failed `timeout` by `expireStale`, which writes, on the next start, staff read, chat tool or pass. There is no sweep, so a dead run can read `queued` or `running` for hours. Spec 7.3 and `api/test/chain.int.test.ts` require every GET to write nothing.
- **Calibration state** (14.1, `api/src/calibration.ts`). Derived on every read: `no_sales_data | not_calibrated | calibrated | stale`, served by GET /api/org's location summaries, the sales GET and the upload answer. The client's `calibrationSchema` (`client/src/portal/schemas.ts`) is a strict `z.discriminatedUnion('state', ...)` inside the GET /api/org parse, so an unknown `state` breaks every page of an older client; an unknown key is stripped. Switches on `state`: `upload/copy.ts` `calibrationHeading` and `calibrationLine`, `ModelCard.tsx` `staleLine`. 14.3 reserves `queued`, `calibrating` and `failed`.
- **Activity** (`api/src/agent/activity.ts`). `ACTIVITY_SOURCES` is append-only and already reserves `forecast_made`. The client parses each item through `known()`, so an unknown kind is dropped, and renders with an exhaustive `activityLine` switch. Items carry ids, dates and counts, never a figure; the panel is read under view-as.
- **Words.** `GATE_WORDS` (`lab/gate.ts`) and `FAILURE_WORDS` (`lab/service.ts`) are staff words ("stays a draft for Townwise staff to review").
- **Email** (D14, `api/src/mail/`). Two kinds, `request_received` and `request_approved`. `EmailRef.requestId` is required. "Nothing about a send is stored" and "Email writes no audit event". `ctx.mailer` is on the API's `TownwiseContext`, which the /lab callback uses, so it is there where a lab run is published (`publishDraft`) and where staff publish one (`handlers/forecast-runs.ts`).
- **Client refresh.** No page polls the org. `reloadOrg()` drops the org to `loading`, so the dashboard flashes its skeleton; LocationShell keeps the previous org. `files/useImport.ts` (AppState-aware poll) and `data/item/AiSection.tsx` (saw running, now announce the end) are the templates.

## Goals / Non-Goals

**Goals:** an owner sees, on the pages they already use, when their forecast is being updated and when a first forecast is being built; can read every finished run of the location in TownwiseAI's activity, with what started it, the days it used and what happened, failures included; and is told by email once when a location's first forecast is published. An older client keeps working. No GET writes. One pattern D66 reuses.

**Non-Goals:** a live training view or loss curve (staff keep D50's post-hoc RunTraining); a separate run-history page; starting the first forecast sooner than the hourly pass; emails for later runs or failures; stating a minimum history anywhere an owner reads (14.1's DECISION NEEDED stays open); changing `via`, the gate, the lab, its input schema or model version.

## Decisions

### 1. An additive `updating` field, not a new state

Every calibration answer gains `updating: { stage: 'running' | 'waiting'; since: string } | null`, beside the existing fields of every union member (`null` on `no_sales_data`). The four states and their headings do not change.

- An older client strips the unknown key and parses every answer as today. A new `state` would fail GET /api/org's parse on an older client and blank every portal page, and would force a case into each switch on `state`.
- Updating is orthogonal to the state: a `calibrated` or `stale` location can be updating, and so can a `not_calibrated` one (its first forecast). A state would have to multiply (`stale_updating`) or lose the published facts the model card shows while it updates.
- 14.3's reserved names stay reserved: they describe a stored model's state, and updating is a run in flight.

The client's schema takes `updating` as `.optional()` (an API from before it reads as not updating), the precedent of `placeId` and `offDayCount`. API tests that `toEqual` a calibration object (`sales.int`, `locations.int`, `staff-setup.int`) gain `updating: null`. [CONFIRM: the forecast's progress is a field beside the calibration state; queued, calibrating and failed stay reserved]

Alternatives: a sibling key on the location summary (the sales GET and upload answer would need it too, and the words need the state's day counts anyway); a new `updating` state (breaks older clients).

### 2. The two stages, read only

`calibrationFor` reads `calibrations.live(scope, locationId)` and the location's refit mark, and never writes:

- **`running`**: a live calibration (queued or running) whose `requestedAt` is less than `CALIBRATION_TIMEOUT_MS` (20 minutes) ago; `since` its `requestedAt` (`startedAt` is null while queued). One past its 20 minutes reads as not updating, without `expireStale`, so the GET stays a read (chain.int). The next start, staff read or pass still fails it `timeout` as today. Every live calibration counts, staff's and chat's included: it is the location's forecast being updated, whoever asked. [CONFIRM: owners see every live calibration of their location as updating, including one staff or another admin started] [CONFIRM: a calibration past its 20 minutes reads as not updating, with no write, until the next start or pass fails it]
- **`waiting`**: no live calibration, no run of the location ever published, a refit mark the pass has not tried since it was set (`wantedAt` set, `startedAt` absent or before `wantedAt`), and `nextRefreshFor`'s conditions on (lab runner, weekly forecasts, schedule not paused, organization active with forecasts on, a history the schedule starts). `since` is `wantedAt`. These are exactly the pass's conditions, so `waiting` promises only a start the pass will make; under them (230 days included) it is null, and no number is stated (14.1). A later refit of a location with a published run never shows `waiting`: the pass may find its fingerprint unchanged and start nothing, so it shows only once it runs. [CONFIRM: a location's first forecast reads as being built from the moment its history lands and the hourly pass will start it]

The live read uses the existing `{ liveLocation: 1 }` index; GET /api/org reads it once per location, as it already reads coverage and the newest published run.

### 3. Where it shows, and the words

Words are client functions in `client/src/portal/upload/copy.ts` beside `calibrationHeading`, pure and pinned, with `formatTime` ("2:14 PM", the viewer's time zone) and `plural`; a `since` on an earlier day than the viewer's today adds the short date ("Sun, Nov 15, 11:58 PM"). [CONFIRM: every updating sentence below]

| Where | `running`, published run | `running`, first forecast | `waiting` |
|---|---|---|---|
| Model card (P24), beside the stale line, or in the In progress block | "Updating your forecast with {n} new days, started {time}." ({n} is `newerDays`; with none, "Updating your forecast, started {time}.") | "Building your first forecast from {dayCount} days, started {time}." | "Building your first forecast. Townwise starts it within about an hour." |
| Home (P11), the In progress Tagline | unchanged (the forecast shows) | "Building your first forecast for {name}. Home shows it here once it’s published." | the same |
| Dashboard Calibration cell (P9), second line, plain words (15.6) | "Updating now" | "Building the first forecast" | "Building the first forecast" |
| Upload result (11.2 step 4) | "Townwise is updating the forecast with these days." | the first-forecast line | "Townwise builds the first forecast next, within about an hour." |
| TownwiseAI overview tool | `calibrationWords` gains the model card's sentence | the same | the same |

The dashboard cell stays plain words, not a StatusTag (15.6: a client's own data state is words). The dashboard links to no new page; the history is in TownwiseAI's activity (decision 6). [CONFIRM: no separate run-history page; the dashboard shows updating as words in the Calibration cell] The chat tool's change is a tool result, not the frozen prefix.

### 4. A quiet poll, and acting on done

- `PortalProvider` gains `refreshOrg()`: it re-reads GET /api/org in place, keeping the ready org, the newest answer winning (`useRefreshable`'s rule). `reloadOrg()` is unchanged.
- `client/src/portal/hooks.ts` gains `useWhileRunning(running, refresh, { everyMs, onDone })`: while `running`, it calls `refresh` every `everyMs`, waits while the app is in the background (AppState, as `useImport`), waits 10 seconds after an error, and calls `onDone` once when `running` turns false after it was seen true in this mount (AiSection's `sawRunning`).
- The dashboard runs it on "any location updating", LocationShell on "this location updating", both with `refreshOrg` every 30 seconds. [CONFIRM: pages re-read every 30 seconds while a forecast is updating]
- On done, Home re-reads its forecast quietly (so the forecast replaces "Building" with no reload) and the model card re-reads its estimates. When Home saw a first forecast building and the location is still `not_calibrated` after it, Home shows the notice "Townwise’s first forecast for {name} wasn’t published. TownwiseAI’s activity says why." [CONFIRM: Home's words when a first forecast was not published]

### 5. What started it: `causes`

- The refit mark gains `refit.causes: Cause[]`, set with `$addToSet` beside the `$max` on `wantedAt`. `locations.wantRefit(scope, locationId, at, cause)` and `wantRefitFor(ctx, scope, locationId, touched, cause)` take a required cause, so typecheck finds every caller. `clearRefitWanted` unsets `causes` in the same compare-and-set; a mark set after the pass read it moves `wantedAt`, the clear misses, and both stay.
- `Cause = 'weekly' | 'sales' | 'person_change' | 'townwise_ai'` for system starts:

| Caller | Cause |
|---|---|
| `handlers/sales.ts` `applyUpload` (the upload route and staff setup's), `files/worker.ts` (the file reader's days) | `sales` |
| `handlers/notes.ts`, `handlers/rules.ts`, `handlers/agent-changes.ts` (an undo), `handlers/data.ts` (undoing a file read) | `person_change` |
| `agent/apply.ts`, `files/ai-actions.ts` (an automatic read's days), `calendar/answers.ts` | `townwise_ai` |
| `lab/schedule.ts` `consider` (the weekly path) | `weekly` |

- `StartRequest` gains `causes`; `launch` passes them to `insertQueued`, which stores `causes` (optional, non-empty) on a system calibration. `considerRefit` reads the mark's causes with its `wantedAt` (a mark from before this change, with none, starts with `[]` and reads as unknown). Person starts store none; their cause is read from `via`: `chat` and `file` as `asked` (an admin asked), `console` as `staff`.
- An older system calibration with no `causes` reads `unknown` ("Scheduled refresh"); no backfill and no join with `tw_forecast_weeks`.
- `via` does not change, so the staff console's `via` enum, `townwise.calibration_finished`, the infra test pins on it and the `forecasts_failed` alert (`via == "scheduled"`) are untouched.

Alternatives: new `via` values (break the console's strict enum and change what the alert catches); a single cause per mark (a burst of an upload and a note would lose one).

### 6. What it used, and the history

- `recordInput` (`lab/callback.ts`) also stores `dayCount` (the input's days), `dataFrom` (its first day) and `newDays` (input days after the compared run's `dataThrough`; null on a first forecast), all optional, absent on older records.
- `forecast_made` is appended to `ACTIVITY_SOURCES`. It reads `calibrations.list(scope, MAX_ACTIVITY, locationId)` (the `{ orgId, locationId, requestedAt }` index), keeps finished ones and dates each by `finishedAt`:

```ts
{ at; kind: 'forecast_made'; calibrationId; causes: OwnerCause[]; outcome: 'published' | 'kept' | 'not_run';
  reason: OwnerReason; firstForecast: boolean; dayCount: number | null; firstDate: string | null;
  lastDate: string | null; newDays: number | null;
  accuracy: { weeklyErrorPct: number; currentWeeklyErrorPct: number | null; weeks: number } | null }
```

`OwnerCause` is decision 5's causes plus `asked`, `staff` and `unknown`. `outcome`: `published` when `gate.published`; `kept` when it succeeded and the gate held it; `not_run` when it failed. `accuracy` comes from `lab/views.ts`'s summary (percentages and a week count). [CONFIRM: the history lists every finished run, failures included, with its causes, the days it used and its weekly error percentages]

### 7. Owner reasons and words

A new pure `api/src/lab/owner-outcome.ts` maps every `GateReason` and `CalibrationFailure` to a closed `OwnerReason` with an exhaustive `Record` (a new gate reason fails typecheck until mapped):

| OwnerReason | From | Client words (first forecast in brackets) |
|---|---|---|
| `published` | `published`, `refreshed`, `engine_switched` | "Published: your forecast uses it now." ("Your first forecast was published.") |
| `not_more_accurate` | `not_better`, `refresh_worse`, `baseline_not_beaten` | "Kept your current forecast: the new one wasn’t more accurate on the weeks it was tested on." ("Not published: it wasn’t more accurate than a simple weekday average.") |
| `failed_checks` | `coverage_out_of_band`, `weekday_bias_worse`, `biased` | "Kept your current forecast: the new one didn’t pass Townwise’s accuracy checks." |
| `held_for_review` | `jump_held` | "Kept your current forecast: the new one changed a lot at once, so Townwise staff check it first." |
| `too_soon` | `too_few_weeks` | "Kept your current forecast: there weren’t enough new weeks to compare yet." |
| `needs_more_history` | `not_enough_history` (gate or failure), `model_not_run` | "Kept your current forecast: Townwise needs more history for this one." ("Not published yet: Townwise needs more history.") No number (14.1). |
| `forecasts_off` | `forecasts_off` | "Not published: forecasts are off for your organization." |
| `newer_forecast` | `champion_changed` | "Not used: a newer forecast was published while it ran." |
| `failed` | `start_failed`, `timeout`, `job_failed`, `invalid_result` | "Couldn’t run. Your forecast didn’t change." |

The line reads: outcome sentence, then the cause ("Weekly refresh", "After your sales upload", "After your notes or rules changed", "After TownwiseAI’s changes", "Asked for by your team", "Started by Townwise staff", "Scheduled refresh"), then the days ("1,035 days, Jan 1, 2024 to Nov 15, 2026, 6 new") and, when present, "Weekly error 11.2% (current 11.9%) over 12 weeks." A failure promises no retry, since a cleared mark is not retried until the next weekly refresh finds new data. The staff `GATE_WORDS` and `FAILURE_WORDS` stay staff-only. [CONFIRM: the owner reasons, their words and the cause words]

### 8. D7: no guest figure in any item

`forecast_made` carries dates, counts and percentages, never a guest or sales figure, for every caller. It is the same under view-as and open-as-admin, so `ActivityInput.caller` needs no `openAsAdmin`. This is stricter than D7 requires and is stated as its own rule, as D50 does.

### 9. The first-forecast email, once

- A third `TownwiseEmail` kind, `first_forecast { orgName, locationName, town }`. Subject (fixed): "Your first Townwise forecast is ready". Heading: "Your first forecast for {locationName} is ready." Body: "Townwise published the first forecast for {locationName} in {town}. Open Townwise to see the days ahead on Home and the Calendar. Townwise refreshes it each week as new sales come in." The button and footer links stay `/sign-in`, the web root and `/privacy`. The footer: "You’re getting this email because you’re an admin of {orgName} on Townwise." No figure, no person's name.
- A new `api/src/mail/first-forecast.ts` `mailFirstForecast(ctx, scope, locationId, runId)`, called after a run's draft-to-published compare-and-set succeeds, in `lab/service.ts` `publishDraft` and in `handlers/forecast-runs.ts`'s publish:
  1. No other run of the location has a `publishedAt` (`forecasts.publishedBefore(scope, locationId, runId)`, a new store read), so a location whose runs were withdrawn and republished is not "first".
  2. Claim `tw_locations.firstForecastMailedAt` by compare-and-set (`$exists: false`). A retried or concurrent publish loses the claim and sends nothing.
  3. Every active `org_admin` seat with a user id (`members.list`), each address from `authStores.users.findById`; a deleted user is skipped. `ctx.mailer.send(email, to, { orgId, locationId })` each.
- At most once: a crash between claim and send loses the email rather than sending twice. Sales deleted and uploaded again do not re-arm it; the marker goes with the location. Locations with a published run before this change never get one (step 1). [CONFIRM: one email per location, to every org admin, when its first forecast is published; no opt-out; never again for that location] [CONFIRM: the email's subject and words]
- `EmailRef` becomes `{ requestId?, orgId?, locationId? }`; `townwise.email_sent` and `townwise.email_failed` log the keys present. The marker is stored on the location, not about the send's content; email still writes no audit event (9.3). D14, the privacy page, `api/README.md` and `infra/README.md` say three emails.
- Local and test: email stays off until `EMAIL_ENDPOINT` is set; tests use the recording mailer.

### 10. The running-and-done pattern for D66

The pattern this change sets, which D66's research runs follow: (1) the read the page already makes gains an additive `{ stage, since } | null` field computed read-only, with a time limit read as not running; (2) the page polls with `useWhileRunning` and refreshes in place on done; (3) a finished run appends an activity kind with an outcome and plain words, no figure, failures included; (4) the server decides the words' codes, the client the words. D66 adds its own kinds (`research_done`) and its own field.

## Risks / Trade-offs

- [`waiting` and the pass disagree] → `waiting` reuses `nextRefreshFor`'s own conditions and the mark; a start the lab refuses sets `startedAt` after `wantedAt`, so it stops reading `waiting`. The live and weekly caps can still delay a start by an hour; the words say "about an hour".
- [Polling load] → only while something updates, every 30 seconds, paused in the background; GET /api/org adds one indexed read per location.
- [A dead run reads updating] → read as not updating after 20 minutes, without a write.
- [Email to an admin who left] → only active seats with a user; a deleted user is skipped.
- [History pushes other activity out] → at most one item a week per location from the weekly refresh, plus refits at most once a day; the merge keeps the newest 20.
- [Mixing owner and staff words] → separate maps, exhaustive by type.

## Migration Plan

Optional fields only: `refit.causes` and `firstForecastMailedAt` on `tw_locations`; `causes`, `dayCount`, `dataFrom`, `newDays` on `tw_calibrations` (the strict sub-schemas gain them). No backfill. No index. No new collection, route or env var. Rollback: a client from before ignores `updating` and drops `forecast_made`; an API from before omits them.

## Open Questions

Owner questions (none blocks building):

1. The owner asked for "the dashboard page that links to a full page". This design shows updating on the dashboard and the history in TownwiseAI's activity (the agreed shape), with no full page. Is that enough, or should a run-history page follow?
2. A first forecast starts at the hourly pass, up to about 75 minutes after the history lands. Starting it from the upload itself is possible (a debounced API-side start). Is about an hour acceptable?
3. Should the email have an opt-out, or go to members too?
