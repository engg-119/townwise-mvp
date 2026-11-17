## Context

What exists (develop at 564c17c):

- **The API never computes a forecast** (spec 14.4). The lab job `caj-townwise-lab` (`infra/terraform/production/lab.tf:86-99`: Manual trigger, parallelism 1, `replicaTimeout = 900`, 1 vCPU and 2 GiB) refits one location per calibration and posts a draft run and a scorecard to `/lab` (spec 10.15). The callback window is 20 minutes (`CALIBRATION_TIMEOUT_MS`, `api/src/lab/service.ts:34`), but the job itself is killed at 900 seconds, and `infra/README.md:644` already estimates about 15 minutes a calibration, so runtime headroom is the tightest constraint. Locally `createLocalLabRunner` (`api/src/lab/runner.ts:181`) spawns `uv run --frozen ... python -m townwise_lab job` with the API process's own secret, so the whole loop runs on a laptop and in tests.
- **Starting a calibration** is a person's act: an org admin through TownwiseAI's `start_calibration` or a file read (`via: 'file'`), or staff's Calibrate. `checkStart` (`service.ts:146`) needs a 595-day span (`GATE.minHistoryDays`, `api/src/lab/gate.ts:20`). The span runs from the first to the last day with guests (`guestSpan`, `api/src/lab/input.ts:91`; the lab's own check, `modeling/lab/townwise_lab/pipeline.py:83`); it is not a count of days. `launch` (`service.ts:166`) takes one of the organization's 4 a day (`service.ts:32,178`) and charges $0.10 to its TownwiseAI month (`service.ts:30,205`). One live calibration per location (`tw_calibrations.liveLocation`, spec 6.23). The requester's role and via are closed lists in the store (`api/src/stores/calibrations.ts:70-71`), the staff view (`api/src/lab/views.ts:29-30`) and the console's schema (`client/src/portal/console/calibrations.ts:22-23`).
- **The lab** forecasts 182 days (`input.ts:27`, `modeling/lab/townwise_lab/forecast.py:13`) and scores 28 days ahead (`api/src/lab/scorecard.ts:37`, `pipeline.py:22`), refitting every quarter in its backtest (`pipeline.py:89`).
- **The gate** (`gate.ts:71`): forecasts on (G1); with a current champion, at least 12 held-out weeks and 0.5 WAPE points better (`gate.ts:80`), coverage 65% to 95%, weekday bias no more than 2 points worse; with none, a 595-day span, 12 backtest weeks with a range, and 0.5 points under the weekday median. Ties do not publish (G2). The comparison is scored only on the champion's weeks after its `dataThrough` (`modeling/lab/townwise_lab/compare.py:43-56`).
- **The input** already carries the town calendar's term, week of term and event groups per day (`input.ts:112,127`), never a title. Its key set is exact on both sides (`input.ts:73`, `modeling/lab/townwise_lab/schema.py:17,86`), and `horizonDays` must equal 182 (`schema.py:94`).
- **Reads.** The forecast route allows 42 days a read and 400 days back (`api/src/forecasts/reader.ts:36`, `api/src/handlers/estimates.ts:49-61`); `get_forecast` 31 days and 92 back (`api/src/chat/tools/forecast.ts:25-27`). The reader loads every row of every published run on each read (`reader.ts:192-193`, no `range`, although `ForecastStore.rows` takes one, `api/src/stores/forecasts.ts:231`). For each date it uses the newest published run whose `dataThrough` is before it. Days carry `actual` and `inRange`; each run carries live accuracy (`api/src/forecasts/score.ts:45`). The run label is `Townwise demand model v{n}` (`reader.ts:134`).
- **Notes and scheduled rules** act from today on at read time (`api/src/forecasts/adjust.ts`) and feed the lab input's flags (14.5).
- **Home's Last week** (`client/src/portal/home/LastWeek.tsx`, `client/src/portal/analytics/week.ts:351-423`) is the seven days before today against the same weekdays 52 weeks earlier, history only. The spec promises "When forecasts arrive (14.3) this card compares forecast with what happened; until then it never shows a prediction" (P11).
- **Calibration state** (`api/src/calibration.ts`) is `no_sales_data | not_calibrated`, derived; `calibrated` and `stale` are reserved (14.3). The client parses the state strictly (`client/src/portal/schemas.ts`).
- **Jobs.** `infra/terraform/production/jobs.tf` runs the backup, restore, smoke and db-users jobs, each with its own identity holding only its Key Vault references (`jobs.tf:19-46`); the backup job runs on a schedule (`jobs.tf:118-123`). Valkey runs as a sidecar of the API's container app (`containerapp.tf:175`), so a job cannot reach it. The deploy workflow sets the API's image on every release (`containerapp.tf:211`).
- **The forecasts switch (G1)** is off until staff switch it on: an absent `forecasts` field reads as off (`api/src/stores/orgs.ts:107`), and the switch needs the staff member's word that the owner agreed (`api/src/handlers/calibrations.ts:29`).
- **Precedents for a background loop**: the daily file sweep under a Mongo lease (`api/src/files/sweeper.ts`, `claimFileSweep` in `api/src/stores/cross-tenant.ts:435`) and the calendar refresher's tick (`api/src/calendar/refresher.ts:1-35,290-296`). The API runs 1 to 2 replicas (`containerapp.tf:81-82`).
- **Production**: the lab is not enabled (`TOWNWISE_LAB_RUNNER` off, step 20 not applied). Sawtooth's history spans 2025-01-01 to 2026-10-21, a span of 658 days with 553 days of data. The minimum is a span, so Sawtooth is eligible for the model engine, and the baseline runs beside it. Whether the model's backtest gives 12 weeks with a range across Sawtooth's missing days is only known by running it; if not, the gate answers `too_few_weeks` and the baseline is the fallback.

## Goals / Non-Goals

**Goals:**
- Every location of every switched-on organization has a published forecast reaching 91 days past today, refreshed weekly with no person starting anything.
- A location with too little history for the model still gets an honest, labeled forecast.
- Home's Last week says how the forecast did, or shows it where guest counts are missing, and never shows an unpublished figure.
- Cost, runtime and blast radius are bounded, and there are three ways to stop it. Every part is on by default (owner directive, 2026-11-16) and inert while the lab runner is off, so develop stays releasable after each phase.
- It runs as a background worker, and the whole loop is tested end to end, and shown to the owner locally, before anything is pushed.
- No Sawtooth-specific code; the full loop runs locally with the local lab runner.

**Non-Goals:**
- Enabling the lab in production (infra step 20, an owner action). Until then on-by-default publishes nothing there.
- TownwiseAI's weekly suggestions of notes and rules: moved to the follow-up change `weekly-forecast-suggestions` (decision 16).
- Owner calendars (D33, D39) in the lab input.
- Item-level forecasts, Analytics forecasts, and changing the 28-day gate horizon.
- A scheduler service beyond one Container Apps scheduled job.

## Decisions

### 1. Spec numbers: D42 and 14.6

D42 "Autonomous forecasts" (next free after D41) is the decision row; 14.6 "Weekly refresh, engines and publish policy" holds the rules, beside 14.4 and 14.5. D27, G2, 14.2, 14.3, 10.13, 10.15 and P11 gain build notes or amendments pointing at D42. D12 is not touched: its `[DECISION NEEDED]` stays, since a person's calibration keeps 595 days.

Alternatives: amending D27 in place (an owner decision; editing its text would hide what changed) or a new top-level section (the forecast rules already live in 14).

### 2. The weekly refresh is a background worker: a scheduled job running one pass, under a Mongo lease

Owner directive, 2026-11-16: "these should be background workers". The pass lives in `api/src/lab/schedule.ts` as `createForecastSchedule(deps)` and is run by a separate entry point, `api/src/workers/weekly-forecasts.ts`. That entry point reads the config through `config.ts`'s schema, builds only the stores and the lab runner the pass needs (Mongo, no Valkey: a scheduled start uses no limiter, and Valkey is the API's sidecar), runs one pass, closes the connection and exits with 0, or 1 on an error. `main.ts` starts no loop. In production a Container Apps scheduled job, `caj-townwise-forecasts`, runs it in `jobs.tf`, following the backup job's pattern (`jobs.tf:104-123`):
- the API image with a command override (`node src/workers/weekly-forecasts.ts`) and an hourly cron (`"5 * * * *"`), parallelism 1, a 600-second replica timeout and no retry;
- its own managed identity with AcrPull, the `mongodb-uri` Key Vault reference and a role assignment to start the lab job (the `lab_starter` role, `lab.tf:41-56`);
- `identitySettings` lifecycle `Main`, since the runner signs in to Resource Manager from the container;
- a `terraform test` in `production.tftest.hcl`.

`deploy.yml` sets the job's image to the API's digest on each release, so the two never drift. Locally `npm run worker:forecasts -w @townwise/api` runs one pass, and `-- --loop` ticks hourly (and once at start) for development.

Each pass claims the lease on the single `tw_forecast_schedule` document (`_id: 'weekly'`, `owner`, `leaseUntil`, 10 minutes) by compare-and-set, as `claimFileSweep` does, and renews it before each location. The lease stays even with parallelism 1: a slow execution and the next hour's, a manual start, or a developer's `--loop` against the same database can overlap. A failed renewal stops the pass at once. The pass lists candidates through a new cross-tenant lookup (`weeklyCandidates` in `stores/cross-tenant.ts`: locations of active organizations whose forecasts are on, an absent switch counting as on), and `scopeForWeeklyRefresh` in `access/policy.ts` mints each `OrgScope`. Locations are taken one at a time. At most 3 scheduled calibrations are live at once across all organizations; a due location past that waits for a later pass without a week row.

Week rows (`tw_forecast_weeks`, unique `{ orgId, locationId, week }`) go `starting` before `launch`, then `started` with the calibration id or `start_failed`. A `starting` row older than the lease is resolved by looking for a system calibration of that location created after the row; this covers a pass that dies between the insert and the start.

Mongo, not Valkey, holds the lease and the week rows. The record that a week was done must survive a cache flush, the job cannot reach the sidecar Valkey, and DocumentDB supports the same `findOneAndUpdate` lease the sweeper uses.

Alternatives considered: an hourly timer inside every API replica (the earlier design of this change; the owner asked for background workers, and it would run scheduling work in the request-serving process and in every replica); a long-running worker container app (an always-on replica billed around the clock for a few minutes of work an hour); a cron trigger on the lab job itself (the lab holds no secret and cannot read Mongo); starting a refresh lazily on a read (GET is side-effect free, spec 7.3); a Valkey `SET NX` lease (above); no live cap (a Monday with many due locations would start dozens of 1 vCPU jobs at once).

*Claude's call:* the start is 03:00 Monday town time, so a weekend's uploads made by Sunday night are in. A start blocked by a live calibration (someone started one by hand) is tried again each hour until Monday ends in the town; once a scheduled calibration has started, a failure is not retried that week. The live cap of 3 is a [CONFIRM].

*As built in phase 3b (2026-11-16), where the code differs from the text above:*
- **The schedule document is its own store.** `api/src/stores/forecast-schedule.ts` is in `TownwiseStores` and takes no `OrgScope`: it holds no organization's data, and `calibration.ts` (the next refresh date) and the staff route read its pause, which must not import `stores/cross-tenant.ts`. Only the lookups that span organizations (`weeklyCandidates`, `liveScheduledCalibrations`, `staleStartingWeeks`, `countedWeekRows`) are cross-tenant. A released lease (`leaseUntil` set to now) can be taken at once.
- **`--now` moves only who is due.** The worker's development-only `--now` feeds `createForecastSchedule`'s `dueClock`; calibrations, week rows and the lease keep the real clock, since the API's callback window and the 20-minute timeout are real-time and a job started under a moved clock could never call back.
- **A shared local secret.** The local runner hands its job the secret the API accepts on `/lab`, which `main.ts` made per process, so a job the worker started could never call back. `TOWNWISE_LAB_LOCAL_SECRET` (development only) is now shared by both; unset, the API makes its own as before and the worker refuses `local`.
- **The worker's context.** `checkStart`, `launch`, `finishCalibration`, `expireStale`, `buildLabInput` and `recordAfter` take narrower contexts (`LabStartContext` has `redis` null for the worker; a person's start without Valkey is refused `rate_limited`), so the worker builds no auth, HTTP or Valkey. It builds the indexes before its pass, since the week rows' unique index is what keeps a week to one start.
- **Order of a location's checks.** Due and no row; a live calibration of its own (no row); under 230 days (`not_enough_history`); the fingerprint equal to the reference (`unchanged`); the live cap (no row); the weekly cap (`cap_reached`); then the start. Skips that cost nothing are recorded even while the cap holds starts back.
- **The pass's line** carries `state` (`ran`, `off`, `paused`, `lease_held`, `lease_lost`) besides its counts; a location whose turn throws logs its ids (`townwise.weekly_refresh_location_failed`), counts as failed, and the pass goes on.
- **An engine switch has its own reason**, `engine_switched`, whose words name the engine and its margin from the scorecard's `engines` (decision 9's switch branch published as `published` in phase 3a).
- **Measured by hand** (task 3b.7): on 700 synthetic days the loop ran end to end and a baseline run published. Synthetic histories whose weeks vary only by an independent shock were held `coverage_out_of_band` (over 95% of weeks inside) or `baseline_not_beaten`; how often real histories of about two years land over 95% coverage is for phase 7's end-to-end test and the owner's demo to show.

### 3. Scheduled calibrations are system-paid, bounded and stoppable

`requestedBy` becomes `{ userId: null, role: 'system', via: 'scheduled' }`. `launch` skips the org limiter (`service.ts:178`) and the charge (`service.ts:205`) for this requester and records `chargedMicroUsd: 0`; `checkStart`'s `budget_exhausted` does not apply. Bounds: one week row per location per week; the live cap of 3; a weekly cap of roughly `TOWNWISE_WEEKLY_FORECAST_CAP` (default 200), counted on this week's `starting` and `started` rows (approximate only by the rows a stopped holder leaves `starting`). At about $0.03 of compute a run (`infra/README.md:644`) that is roughly $6 a week at most.

Three ways to stop it: `TOWNWISE_WEEKLY_FORECASTS` (deploy level: true by default in `config.ts` and `.env.example`, and written explicitly as `true` in `api/production.env`, by the owner's directive); `paused` on the schedule document, set by staff from the console (`POST /api/admin/forecast-schedule { paused }`, audited), effective at the next tick; and G1 off for one organization, effective at once. None cancels a live calibration.

Visibility: each start records `calibration.scheduled` (system actor, ids only). Each pass logs `townwise.weekly_refresh_pass { started, failed, skipped, capped, ms }`, and `infra/README.md` gains a log search alert like the daily-cap alert (`infra/README.md:650`) for failures or a missing pass. The console's Forecasts section shows each location's latest week row.

This amends D27's "each costs $0.10 of the organization's TownwiseAI budget, at most 4 a day" for scheduled calibrations only. [CONFIRM] in the delta.

Alternatives: charging the organization (it would pay for something it did not ask for, and a spent budget would silently stop its forecast refreshing); no global cap (one bug starting runs in a loop has no ceiling); only the env switch (stopping it would need a deploy).

### 4. "Changed since its last fit": a fingerprint against a meaningful reference

`dataSha256` is the sha256 of the canonical JSON of the lab input without `calibrationId`, `today` and `champion`, together with the input schema version and `LAB_MODEL_VERSION`, an API constant held equal to `modeling/lab/townwise_lab/version.py`'s `MODEL_VERSION` by a contract test, so a change to the lab's model refits every location once. It is recorded on every calibration and on the week row. A location is skipped (`unchanged`) only when its fingerprint equals its reference calibration's: the newest calibration whose gate published the draft or refused it on its own data. A calibration refused `forecasts_off` or `champion_changed`, or one that failed, is never a reference, so switching G1 on after a `forecasts_off` draft gets a fresh calibration the next Monday. A calibration from before this change has no fingerprint and counts as changed.

A scheduled calibration carries `regimeStart` from the calibration that made the current published run, so an owner's described pattern change is not dropped by the weekly refit (the start check `service.ts:151` still applies).

Alternatives: comparing `updatedAt` of notes, rules and uploads (misses deletions and a turned-off upload); refitting every week regardless (pays for identical runs).

### 5. `calibrated` and `stale` are derived, like 14.1's states

`calibrationOf(coverage, newestPublished)` (`api/src/calibration.ts`) adds `calibrated` (the newest published run's `dataThrough` is on or after the last day with guests) and `stale` (before it), each with `dataThrough`, `newerDays` and `nextRefresh` (the next Monday the schedule will consider the location, or null while the lab runner is off, the switch is false, the schedule is paused, or the organization's forecasts are off). It reads one published run, so no new store, and stores nothing. The copy says "Townwise refits on {Mon, Nov 23} with the {6} days since." The client's schema accepts both states before the API sends them (phase 1). Notes and rules are left out of `stale` on purpose: they act on the forecast at read time from today on (14.5).

### 6. The baseline engine

`modeling/lab/townwise_lab/baseline.py`, pure pandas, no new dependency. For each future day with status `open` (the existing `statuses()`, `forecast.py:69`, so closures, closing holidays, closed weekdays and booked days are shared with the model):

- **Level**: the median guests of the last 8 open same weekdays on or before the cutoff, needing at least 3 (the input already marks likely-closed days closed with no guests, D32).
- **Shape**: last year's same weekday guests in the 3 weeks around the date less 364 days, over last year's level at the cutoff less 364 days, leaving out event and holiday days; 1 when last year has fewer than 3 such days; clamped to 0.5 to 2.
- **Calendar effects**: for each event or holiday group on the day, the median ratio of its past days to the same weekday without it (thresholds as `api/src/forecasts/effects.ts`), as a multiplier; an event with no group or too little history is a reason with no effect.
- **Business rules and notes** act exactly as on a model run: through the input flags and the read (14.5), never inside the engine.
- **Ranges** from the backtest's daily and weekly log errors, as the model does (`pipeline.py:104-106`).
- **Reasons**: the model's kinds (`forecast.py:81`), with `effectPct` from the engine's own multipliers, so the reader's effects use `basis: 'model'` for a baseline run.

Its backtest is refit weekly (it is cheap) and scored on the same weeks as the model's. Its minimum span is 56 + 28 + 6 + 140 = 230 days, pinned by `test_baseline_min_history_days_always_gives_twelve_weeks_with_a_range` the way 595 is pinned.

*As built in phase 2 (2026-11-16), where the code differs from the text above:*
- **The 230 days' parts.** A week's range needs 8 earlier weeks that ended 28 days before it, so the 12th week with a range is the 24th scored, ending 167 days after the first, as for the model (`gate.ts:12-19`); 140 days (20 weeks) is too few. The baseline's first weekly cutoff is therefore the first Sunday at least 28 days after the first day, and its scored weeks start on the first Monday at least 28 days after that cutoff: 28 + 6 + 29 + 167 = 230, the same number. Cutoffs are Sundays, as a Monday refit with data through Sunday is. Pinned at 230 and refused at 229 (`modeling/lab/tests/test_pipeline.py`, `test_baseline.py`).
- **Plain days.** The level and the shape read only plain training days (no event, holiday or private event), so a calendar effect is never counted twice; the level falls back to that weekday's last 8 training days, then the median training day, when fewer than 3 plain ones exist.
- **Effects' comparison.** An event day, like a holiday, is held to the plain same weekdays up to 4 weeks either side (on or before the cutoff), not the year's mean of that weekday as `effects.ts` does: a fall event held to all-year Saturdays would count the fall term again, which the shape already carries. The thresholds are `effects.ts`'s (3 and 3; 1).
- **Holidays.** The calendar's holiday groups (`us:*` and a town's) and the lab's own big nights and Halloween (`features.holiday_flags`), which the calendar has no group for.
- **Ranges.** The daily range is the 10th to 90th percentile of the scored backtest days' log errors around each middle, widened by `choose_k` as the model's are. The weekly range was the model's past-only rule; as built in phase 2 it held only 15 of 25 golden backtest weeks (60%), under the gate's 65% floor, since a week's band was the interpolated 10th to 90th percentile of as few as 8 earlier scored weeks (about 62% of weeks expected at 8).
- **Weekly ranges calibrated on earlier weeks (fixed before 3a, 2026-11-16).** A week's 80% band is now drawn from the baseline's own weekly log errors, log(actual over forecast), at the same lead band (28, 91 and the reach, each its own) on the weeks of its whole weekly backtest, from its first cutoff on, that ended at least that lead before the week starts: earlier weeks calibrate later ones, and no band ever reads its own week's actuals or a later one's (`test_a_weeks_band_never_reads_that_weeks_actuals_or_any_later_ones`). Of those, it reads the last 52 (a year: every season once, and nothing older, whose errors may be of another size, as in the baseline's first year, when it had no shape of last year), with split conformal ranks (`baseline.weekly_band`: the k-th and k'-th smallest, k = floor(0.1 (n + 1)), k' = ceil(0.9 (n + 1))) instead of interpolated percentiles; 8 earlier weeks are still needed, so the 230 days stand. The scorecard's coverage, its series, `horizon91`, `horizonReach`, the comparison's challenger bands, the run's weekly range and the lead widening all read the same bands. On the golden fixture coverage went from 15 of 25 weeks (60%) to 34 of 37 (92%): more weeks have a band because the baseline's backtest starts a year before the model's score window. Across 10 synthetic histories (5 seeds at 658 days, 3 at 300, 2 at 420) the 28-day bands held 78% of 329 weeks (54% before) and the 91-day bands 82% of 194. The 300-day ones stay under 65% (41% to 59%): their last weeks run into a fall term the baseline cannot see without a year of history, which no band drawn from the past covers. The daily range and `choose_k` still fit the scored days (not gated, as for the model). The model's bands are unchanged.
- **Weekly ranges by kind of forecast (task 7.1, 2026-11-17).** 7.1's coverage check (`modeling/lab/tests/test_coverage.py`: twenty synthetic two-year histories, five shapes of weekly swing and four seeds, no calendar) found the bands above too wide on two-year histories: 9 of 20 were held `coverage_out_of_band`, every one above 95%, and mean coverage was 92%. The cause: a band for a week forecast from on or after `baseline.shaped_from` (the first cutoff a year after the first, when last year's shape can be read) still read the first year's weeks, forecast with no shape and about twice as far off. Such a band now reads the earlier weeks forecast the same way, and while they are fewer than 26 (half a year, so a band has seen a season of the town calendar's busy and quiet weeks) the latest earlier weeks of the other kind fill in up to 26 (`metrics.same_kind`, `KIND_MIN_WEEKS`); the run's own weekly range reads the same weeks. Bands stay past-only with the same ranks, and none reads its own week's actuals (`test_a_weeks_band_never_reads_that_weeks_actuals_or_any_later_ones`, `test_a_week_forecast_with_last_years_shape_reads_its_own_kind_topped_up_to_half_a_year`). A first try with no filling in (a band only from 8 or more weeks of its own kind) passed the calendar-free check (0 of 20 held, mean 82%) but not synthetic histories with Hanover's calendar and no calendar effect in the guests, as the API builds them for a Hanover location (73 todays 10 days apart over two years, the baseline's own backtest whichever engine is chosen): with a weekly swing of 8% its mean coverage was 71% (17 of 73 under 65%), and with none 65% (34 under), where the bands before had 93% (22 above 95%) and 97% (52 above). Its few weeks of its own kind, from the months just after `shaped_from`, missed the fall's event weeks, where the baseline's calendar effects, fitted to noise on these histories, err most. The 26 was set before measuring and not tuned after. With it: the calendar-free check holds 1 of 20 (under 65%; none above 95%), mean 77%; the Hanover histories average 79% with no week share outside 65% to 95% (8% swing) and 72% with 9 of 73 under (no swing, the extreme where calendar noise dominates). Golden coverage is 30 of 37 (81%; 34 of 37 before), `horizon91` 17 of 28 (not gated). No band was calibrated on a scored week: the check reads synthetic histories only. The model's bands are unchanged; on the same Hanover histories (8% swing) the model won the engine choice 17 times and its bands held under 65% of weeks in 13 of them, so those drafts were held (Open Questions).
- **Folds.** One cutoff per half-year, the model's folds.
- **Params.** A baseline run's params are its own shape (`engine: 'baseline'`, its constants, the calendar effects found, its ranges); both engines' params gain `widening`, so a run's lead widening is reproducible (G3).
- **The run's `model.version`** is `v7` for both engines (bumped with the weekly ranges' fix, so 3a.4's fingerprint, which includes `LAB_MODEL_VERSION`, refits every location once; `v8` since 7.1's ranges by kind of forecast, which refits every location once more). The 230 applies to scheduled calibrations only; a calibration a person starts keeps needing 595, so `checkStart`'s refusal words and D12 are unchanged. [CONFIRM] in the delta, worded as superseding the 2026-11-10 decision for the baseline on scheduled calibrations only.

The run's `model.family` is `seasonal_baseline` (`MODEL_FAMILIES`, `api/src/forecasts/file.ts:14`); `ForecastRunView.engine` is derived from the family, so no stored field and no migration.

Alternatives: the weekday median alone (no seasonality or events; it remains the floor the baseline must beat, decision 9); lowering the model's minimum (its quarterly refits need a year to learn seasonality, `gate.ts:12-19`); an LLM-made baseline (an unscored figure; G4 keeps training data from Anthropic); 230 days for a person's calibration too (rejected by the lead: keep the owner's 595 where a person asks).

### 7. Lab input version 2, in one step

Version 2 adds `calendar: { id, group, kind, start, end, confidence }[]` (the same `townEvents` call `input.ts:112` makes; no title, URL or source label, since the reader words a reason and attaches its sources from its `ref`, `api/src/forecasts/reasons.ts:98`) and `champion.engine`. The lab accepts version 2 only. The API and the lab move together in one phase, built from the same commit. The lab is off in production until step 20, and locally both run from one checkout, so no mixed versions exist. `horizonDays` stays 182: it bounds the input's future days, and the run's own end is decision 10's.

Alternatives: answering versions 1 and 2 for a release (cut by the lead: twice the contract and tests for a job that is not live in production).

### 8. Which engine a calibration returns: the current one sticks

The lab runs the baseline always and the model at a 595-day span. It returns the current published run's engine (`champion.engine`) unless the other engine's backtest weekly WAPE is at least 0.5 points lower on the same weeks; with no current run, the model when it is 0.5 points better than the baseline, else the baseline. A tie keeps the current engine. This is the only cross-engine comparison, made on the same weeks, which is fairer than comparing recorded backtests from different weeks, and the 0.5-point margin stops weekly flip-flopping between close engines. When the current engine is the model and the model could not run (the span fell under 595, say after an upload was turned off), the lab returns the baseline's run and the gate holds it (`model_not_run`), so a model forecast is never replaced by a baseline for want of data. The scorecard carries `engine` and `engines`.

Alternatives: always preferring the model when it passes (two close engines would flip week to week); publishing both engines' runs (two published runs for one cutoff break "the newest run whose `dataThrough` is before the date"); the gate comparing engines on recorded backtests (different weeks; rejected by review).

*As built in phase 2:* `pipeline.choose_engine` is the rule above, with "at least 0.5 points" inclusive. On the lab's synthetic fixture the baseline wins (backtest weekly WAPE 9.70% against the model's 16.82% on the same 37 weeks; the fixture's guests jump 20% a year before its cutoff, which the model's quarterly refits cannot learn), so the golden result is a baseline run, and the lab's tests of the model's own run take it explicitly. With the jump taken out, the model wins (8.54% against 9.88%), which `test_the_model_wins_a_first_forecast` pins.

### 9. The gate: one set of rules for every calibration

With weekly refits the published run is always a week or two old, so today's champion comparison, scored only on the champion's weeks after its `dataThrough` (`compare.py:43-56`), almost never reaches 12 weeks. New weeks would never reach a published run, and a person's calibration would answer `too_few_weeks` nearly every time. So every calibration, scheduled or started by a person (lead decision, 2026-11-16), is judged the same way after G1:

- **No current run**: the model's first-forecast rule, or the baseline's absolute checks.
- **Current lab run of the same engine**: the engine's absolute checks, and backtest weekly WAPE no more than 0.5 points above the best (lowest) recorded backtest weekly WAPE in the current streak (the consecutive published lab runs of that engine that still reach 28 days past today, read from their calibrations' scorecards; a lapsed run ends it, so a lasting rise in error is held only while the run before it is current, not until the champion lapses every time). A tie publishes (`refreshed`), the one exception to G2's "ties do not publish"; otherwise `refresh_worse`. Comparing with the streak's best, not the latest run, stops the tolerance compounding: three refits each 0.4 points worse cannot drift 1.2 points.
- **Current lab run of the other engine**: the lab's same-weeks 0.5-point comparison (decision 8) stands; the gate checks the draft's absolute checks only.
- **Imported current run** (no lab scorecard): today's held-out comparison.
- **Absolute checks.** The model: coverage 65% to 95% on 12 weeks with a range, weekday bias no more than 2 points worse than the current run's recorded backtest, and 0.5 points under the weekday median. The baseline: 12 weeks with a range, coverage 65% to 95%, weekly bias within 5 points, and weekly WAPE strictly under `weekdayMedianWeeklyWape` (`baseline_not_beaten`), so the baseline never publishes something a weekday average beats.
- **Jump guard.** With a current run (or, with none, the newest published run that lapsed), a draft that passes everything is held for staff (`jump_held`, never published on its own) when its middles over the 28 days from `today`, summed over days both runs forecast open, differ from the current run's by more than 25%. A data error (a doubled upload) cannot reach owners unseen.

[CONFIRM]s in the delta: the recorded-backtest basis, the streak tolerance, the baseline's checks, the jump guard.

Alternatives: keeping today's held-out rule for a person's calibration (the trap above); scoring the champion's published days against actuals at any age (too few weeks for a young champion); comparing with the latest run's WAPE (drift compounds); storing the model to rescore it (G3 and 14.4 say the model is stored nowhere); no jump guard (a bad upload publishes a wild forecast on Monday morning).

### 10. Horizon: today plus 91 days, 28 gating, longer leads reported

A run carries the days after `dataThrough` through `today` plus 91, capped at 182 days after `dataThrough` (the input's reach), so a location whose sales lag still gets 91 days past today. The scorecard keeps `horizonDays: 28` for the gate and adds `horizon91` and, when sales lag so the run's longest lead passes 91 days, `horizonReach`: the backtest weeks forecast that far ahead, reported and not gating. Days with a lead of 29 to 91 widen by the 91-day to 28-day weekly band ratio; longer leads by the reach's ratio (at least 1). Where a horizon has fewer than 8 backtest weeks, the run stops at the shorter horizon's last day (no range without evidence). The backtest's predictions reach the run's longest lead plus 6 days past each cutoff. Gated by decision 14's runtime check. [CONFIRM] in the delta.

*As built in phase 2:* the reach's horizon is the longest lead rounded up to whole weeks (`forecast.reach_horizon`), so a run made the day after its last day of sales (a longest lead of 92) already reports `horizonReach` (98 days) and needs its 8 weeks. Each longer horizon's ratio is at least the shorter one's as well as at least 1, so ranges never narrow with lead. Only whole Monday-to-Sunday weeks inside the run get a week row, for both engines (the model's run used to carry a partial first and last week).

`currentChampion` still needs 28 days left (`gate.ts:54`), so a 91-day run stays champion for about 9 weeks without a refresh; a short run that stops at 28 days of lead is judged as a first forecast at the next refresh. The 14.3 reserved shape changes from `horizon: 7 | 28` to `horizon: 28 | 91`.

Alternatives: `dataThrough` plus 91 (a location that uploads late would see fewer than 91 days ahead; rejected by review); 182 days (unscored ranges for half a year); 28 days (misses "every day over the next 3 months").

### 11. Reads of up to 92 days, bounded as runs pile up

`MAX_FORECAST_RANGE_DAYS` (`reader.ts:36`) goes from 42 to 92, matching the people-in-town route; `get_forecast` (`forecast.ts:25`) from 31 to 92, a frozen-prefix change (one prompt cache miss per conversation, as D40's was) recorded in `tuning-chat.md`. The Calendar keeps reading 42-day grids and needs no change; a day past the newest run says "The published forecast doesn't cover this day." (`client/src/portal/calendar/model.ts:637`).

Weekly runs mean about 52 published runs a year per location, each about 104 rows. Today's reader reads all of them on every read (`reader.ts:193`). It moves to a ranged read: the window, plus the past days that live accuracy and `accuracy` score. Its answers do not change, and a test with 52 runs pins that.

### 12. Home's Last week: the API scores, Home shows

`ForecastWindow` gains `accuracy` (`liveAccuracy` over the window's own days, each from the run the reader chose for it, closed, likely-closed and booked days left out, null under 5) and each day gains `scored`. Home's Last week makes its own forecast read for the seven days before today, on its own like the month's read; while it loads, if it fails, or with nothing published, the card is exactly today's.

The card, in guests (forecasts are guests only):

- **Scored days**: "Townwise's forecast was off by {12%} over {5} days. {4} of {5} days landed in its range." (the first sentence only when `accuracy` is not null), then the last-year sentence unchanged.
- **Days with a forecast and no guest count**: "No guest count uploaded for {these days | Sat and Sun} yet; this is Townwise's forecast.", and each such row reads "Forecast, no guest count uploaded yet: about {150} guests, {120} to {180}", so a forecast row never reads like a sales figure; on web the bar is drawn in the forecast style and keyed "Forecast". There is no total over forecast days, since week ranges come only from a run's own week rows (14.4) and these seven days are not a Monday-to-Sunday week (lead decision, 2026-11-16).
- **A mix** shows both, scored rows with their guests and the forecast beside them.

At a glance's tile follows the card. The honesty rules stay: no figure without a published run, frozen runs never overwritten, a run never credited with an older run's days, past days keeping the model's own figures (14.5 rule 1). "Never a guess" becomes "never an unpublished guess" in P11's opening, the Last week bullet, `LastWeek.tsx:13`, `Glance.tsx:22` and `Home.tsx:44`; the In progress line (`Home.tsx:60`) shows only with nothing published and stays.

Alternatives: scoring in the client (Home "never computes or adds to" a forecast, P11; two copies of score.ts would drift); widening Home's month read (couples the card to the month's read and its failure).

### 13. Generic and locally runnable

Nothing reads a town or organization by name: candidates come from `forecasts.on`, the time zone from `timeZoneOf(location.town)`, the calendar from `townEvents(townId)` (no researched calendar gives holidays only). `createForecastSchedule` takes `now`, `tickMs`, the runner and the stores as deps, so `api/test/weekly-refresh.int.test.ts` drives Mondays with a fake clock and a fake runner, and `api/test/weekly-forecasts-e2e.int.test.ts` runs the worker's pass against the real local lab end to end (decision 19). A developer runs it with `TOWNWISE_LAB_RUNNER=local` and `npm run worker:forecasts -w @townwise/api`.

### 14. Runtime headroom gates the lab work

The job is killed at 900 seconds (`lab.tf:89`) at 1 vCPU and 2 GiB (`lab.tf:99`), and today's runs are estimated at about 15 minutes. Before any lab change, task 0.3 times today's calibration in the lab image under `docker run --cpus=1 --memory=2g` on a 700-day fixture. The second engine and the longer reach (decisions 8 and 10) proceed only if the measured run, plus the baseline's measured cost and the longer prediction reach, stays under 600 seconds (two thirds of 900). Otherwise the work stops and goes back to the lead with the numbers. Options then are a larger job size or fewer folds, each with its own cost.

**Measured (task 0.3, 2026-11-16).** The lab image built from this branch at c6ffd75 (lab code identical to develop at 564c17c), `linux/amd64` as production runs it, timed with `docker run --platform linux/amd64 --cpus=1 --memory=2g` on a 700-day synthetic input (`tests/fixture.py`'s `synthetic_input(0)` with its first day moved back to a 700-day span, 882 input days, with its champion, so the comparison runs too). The entry point was overridden to `python -m townwise_lab run --input ... --output ...`, which runs the same `calibrate()` as `job` without the API's fetch and post. Three runs: 28.6, 19.3 and 18.6 seconds wall clock (the first includes the image's first start), each "653 history days, 42 backtest weeks, 182 forecast days", with byte-identical results. A fourth run measured 17.5 seconds inside the container and a peak of 189 MB (`memory.peak`) against the 2 GiB limit. The host is an Apple M4 Max running the amd64 image under Rosetta, so an Azure Consumption vCPU may be slower per core; even at ten times the slowest run (about 290 seconds) a calibration stays under 600 seconds. The "about 15 minutes" in `infra/README.md`'s cost table is an estimate, not a measurement, and stays until step 20 measures a run in Azure. Verdict: room under 600 seconds for the baseline and the longer reach; 2.3 and 2.6 time them again.

**Re-measured (tasks 2.3 and 2.6, 2026-11-16).** The same way: the lab image built from this branch, `docker run --platform linux/amd64 --cpus=1 --memory=2g`, a 700-day synthetic input (`synthetic_input(0)` with 42 days added before its first day, copied from the same weekdays a year later; 883 input days, version 2, with its champion), three runs each, timed inside the container and wall clock.
- After 2.3 (the baseline built, not yet in `calibrate`): `calibrate` (the model, as in 0.3) 10.4, 9.9 and 11.6 seconds; the baseline's prepare and weekly backtest at the horizons 7, 28, 91 and 98 a further 0.6, 0.7 and 0.8 seconds (2,272 predictions). Wall clock 19.9, 18.2 and 20.2 seconds.
- After 2.6 (both engines, the reach and the widening): `calibrate` returning the baseline (what this input chooses) 5.7, 4.5 and 4.5 seconds, wall clock 11.5, 9.9 and 10.2; with the model returned (`choose_engine` forced, the most work a calibration does: both backtests, the model's final fit, its leave-one-out holiday lambda and its folds) 7.8, 7.6 and 6.9 seconds, wall clock 13.2, 13.0 and 11.8. Peak RSS 237 MB of the 2 GiB.
The 0.3 run was 17.5 seconds inside; these are lower because the run now forecasts 93 days instead of 182 and a baseline result skips the model's final fit. Even at ten times the slowest (about 130 seconds wall clock) a calibration stays under 600 seconds.

### 15. Order of landing

Each phase lands with every part on by default and inert while the lab runner is off (owner directive, 2026-11-16, replacing "everything off by default"): (1) docs and additive shapes, with the client and the staff view accepting new states, fields, `via: 'scheduled'` and role `system` before the API sends them; (2) the lab and the API's input version 2 together, after the runtime check; (3a) the gate, the system requester, the fingerprint and the ranged reader, with no loop; (3b) the worker, the scheduler and forecasts on by default; (4) the client, and the public and privacy copy; (5) the worker's scheduled job, config and its alert; (6) the owner's approvals; (7) the end-to-end test and the owner's local demo. Nothing is pushed before phase 7 and the owner's go; the branch's commits stay local until then.

### 16. Weekly suggestions moved to a follow-up change

The owner's "agentic ... rules" (TownwiseAI reading the next 3 months of the town calendar and suggesting notes and rules each week) is the follow-up change `openspec/changes/weekly-forecast-suggestions/`. It runs on this change's tick and week rows. It is split out because it sends the owner's notes and rules to Anthropic unprompted, needs its own consent and privacy wording, and should not hold back the refresh.

### 17. On by default, G1 included

Owner directive, 2026-11-16: "turn them on by deafult ... any features that I tell you to create should be on by default unless i tell you it shoul dbe off", and for the forecasts switch, "On by default for all orgs". So:
- `TOWNWISE_WEEKLY_FORECASTS` defaults to true in code, `.env.example` and `production.env`.
- Forecasts are on for every organization, existing and new. `OrgStore` reads an absent `forecasts` field as `{ on: true, at: null }` (`api/src/stores/orgs.ts:107`), and staff can still switch one off, which is stored with `at` and `by` and stays off.
- The console's switch shows "On (default)" for an organization nobody switched. Switching one off and back on works as today, including the staff member's word that the owner agreed when turning it on.
- The original G1 text stays in the spec as history beside a build note and a [CONFIRM], since it was the team's guardrail.
- The weekly suggestions (follow-up change) default to on per organization by the same directive.

Production stays inert until the lab runs there (infra step 20), which is why the privacy copy (decision 18) and Sawtooth's consent are owner actions before that step, not after.

Alternatives considered: keep G1 off by default with the env switch on (the owner chose otherwise; it would also make the weekly worker do nothing for every existing organization); a migration writing `forecasts: { on: true }` on every organization (a write to every row for a value the read can default, and new organizations would need it too).

### 18. Public and privacy copy ships in this branch

With forecasts on by default, the public site's "not built yet" and "the app shows no forecasts" become false the day the lab runs. So the branch redrafts:
- the privacy page's forecasts paragraph (`client/app/(marketing)/privacy.tsx:208`: weekly refits by a background job on Townwise's own servers from the location's own days, notes and the public town calendar, the baseline engine, forecasts on unless the organization asks Townwise staff to turn them off), with its "Last updated" date bumped (`privacy.tsx:278`);
- every public line found by grepping `client/src/marketing` and `client/app/(marketing)`:
  - `client/src/marketing/HowItWorks.web.tsx:238` ("Calibration itself is not built yet, so the app shows no forecasts.") and `:234`;
  - `client/app/(marketing)/about.tsx:58` and `:63`;
  - `client/src/marketing/Home.web.tsx:209` ("Not for forecasts yet ... The forecasts themselves are being built and tested now.") and `:57`, whose "No forecasts are for sale yet" stays true and is kept unless the owner says otherwise.

Each is pinned by its existing test (`client/test/marketing/home.test.web.tsx`, `how.test.web.tsx`, `pages.test.web.tsx` and `pages.test.native.tsx`) and a new privacy test. `docs/portal/estimates.md` section 5 carries the same paragraph. Every new line is marked for the owner's approval before push (task 6.1); the existing `[CONFIRM]` comments in `privacy.tsx` stay.

Alternatives: shipping the copy later (the site would say something false for as long as forecasts publish); leaving the copy to the owner (the owner asked for this to be ready; drafting it with an approval gate keeps their say).

### 19. Tested before push

Owner directive: "test it before we push everything". A phase before review:
- (a) `api/test/weekly-forecasts-e2e.int.test.ts` (testcontainers Mongo):
  - seeds an organization with no `forecasts` field and a location with about 300 synthetic days, never `data/`;
  - runs the worker's pass with the local lab runner and a fake clock at Monday 03:05 in the town;
  - lets the real lab job call back to an in-process API;
  - asserts a run publishes (baseline at 300 days);
  - asserts the Last week forecast read returns forecast-only days (the 7 days after the last seeded day) and scored days (when the seed covers them). It needs `uv` and is skipped with a stated reason where `uv` is missing, as the lab's own suite needs it; CI runs it.
- (b) A manual local demo for the owner on their stack, with Sawtooth's local location, after the owner's go to restart their dev servers. Push and the PR follow only after both and the owner's go.

*As built in 7.1 (2026-11-17):* the test seeds 700 synthetic days (not 300) for a Hanover location, so both engines run; the history ends the day before Last week, so the run covers Last week's seven days. The worker and the in-process API share one fixed clock at Monday 16 November 2026, 03:05 in Hanover (`WorkerDeps.now`, tests only), not the real time with `--now`: `--now` moves only which locations are due while the records keep the real time, which a test API on its own clock would not accept, and on the real date the town calendar days in the history, and so the lab's verdict, would change from day to day (the earlier draft's seed, chosen without the town calendar, was held `coverage_out_of_band` on 2026-11-16 itself, the model winning with ranges that held 15 of 28 weeks). The seed publishes the baseline with room on every check on that Monday and the Mondays either side. The CI `verify` job installs uv (the lab job's pinned `astral-sh/setup-uv`), so CI runs it.

Alternatives: the fake-runner integration test alone (it never exercises the real lab callback, which is where a contract mismatch would show); a demo only (not repeatable).

## Risks / Trade-offs

- [A refit publishes a slightly worse forecast within the tolerance] → Measured against the streak's best, so it cannot compound; absolute checks and the jump guard apply; staff can withdraw.
- [Runtime passes the 900-second job limit with two engines and a longer reach] → Decision 14 measures first and stops at 600 seconds.
- [A bug starts calibrations in a loop] → One week row per location per week, the live cap of 3, the weekly cap, the staff pause and the env switch.
- [Every organization publishes as soon as the lab runs in production, G1 being on by default] → The privacy and public copy ship in this branch with the owner's approval, Sawtooth's consent is an owner action before step 20, and staff can switch any organization off.
- [The worker's image drifts from the API's] → `deploy.yml` sets both to the same digest on each release.
- [The worker cannot reach Valkey] → It needs none: Valkey is the API's sidecar, and a scheduled start uses no limiter.
- [A pass dies or loses the lease mid-pass, or two executions overlap] → Renewal before each location; a failed renewal stops the pass; `starting` rows are resolved by the next pass.
- [Close engines alternate week to week] → The current engine sticks unless the other is 0.5 points better on the same weeks.
- [A bad upload produces a wild forecast] → The jump guard holds it for staff.
- [The baseline's seasonal shape misreads a year with a closure] → Closed and likely-closed days are left out, the shape is clamped, and the backtest's coverage, bias and weekday-median checks refuse a bad fit.
- [Reads slow down as weekly runs pile up] → The ranged reader, pinned with 52 runs.
- [The client or staff view sees a value it does not know] → Phase 1 makes them accept it first.

## Migration Plan

No data migration. New fields are optional or derived: `dataSha256` absent on old calibrations (counted as changed), `requestedBy.role: 'system'` only on new rows, `engine` derived from the family, `paused` absent meaning not paused. Existing organizations with no `forecasts` field read as on once phase 3b lands; one staff switched off stays off. Rollback: set `TOWNWISE_WEEKLY_FORECASTS=false` or pause from the console; published runs stay (G3) and staff can withdraw any.

## Open Questions

- `CLAUDE.md` says `api/src/main.ts` is the only file that reads the environment. The worker is a second composition root that resolves the same `config.ts` schema; updating `CLAUDE.md`'s line needs the owner's yes, since that file is theirs. (Phase 3b built the worker; `CLAUDE.md` is unchanged and still says this.)

- The model's weekly 80% ranges (its own scored weeks, `metrics.quantile_band` from as few as 8, section 8) held under 65% of weeks in 13 of the 17 synthetic two-year Hanover histories where the model won the engine choice (task 7.1), and 9 of 25 on the golden fixture, so the gate holds those drafts `coverage_out_of_band` and that week publishes nothing new. Should the model's bands get the baseline's treatment (its whole weekly backtest and finite-sample ranks), in this change or the next?
- Who sees `stale` first: the model card only, or also a line on Home? This change shows it on the model card and in TownwiseAI only.
- If decision 14's measurement fails, should the lab job grow (cost) or the backtest shrink (fewer folds)?
