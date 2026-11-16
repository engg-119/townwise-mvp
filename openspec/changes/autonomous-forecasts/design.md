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
- **Precedents for a background loop**: the daily file sweep under a Mongo lease (`api/src/files/sweeper.ts`, `claimFileSweep` in `api/src/stores/cross-tenant.ts:435`) and the calendar refresher's tick (`api/src/calendar/refresher.ts:1-35,290-296`). The API runs 1 to 2 replicas (`containerapp.tf:81-82`).
- **Production**: the lab is not enabled (`TOWNWISE_LAB_RUNNER` off, step 20 not applied). Sawtooth's history spans 2025-01-01 to 2026-10-21, a span of 658 days with 553 days of data. The minimum is a span, so Sawtooth is eligible for the model engine, and the baseline runs beside it. Whether the model's backtest gives 12 weeks with a range across Sawtooth's missing days is only known by running it; if not, the gate answers `too_few_weeks` and the baseline is the fallback.

## Goals / Non-Goals

**Goals:**
- Every location of every switched-on organization has a published forecast reaching 91 days past today, refreshed weekly with no person starting anything.
- A location with too little history for the model still gets an honest, labeled forecast.
- Home's Last week says how the forecast did, or shows it where guest counts are missing, and never shows an unpublished figure.
- Cost, runtime and blast radius are bounded; there are three ways to stop it; everything is off by default; develop stays releasable after each phase.
- No Sawtooth-specific code; the full loop runs locally with the local lab runner.

**Non-Goals:**
- Switching forecasts on for any organization (G1 stays a staff act with the owner's word).
- TownwiseAI's weekly suggestions of notes and rules: moved to the follow-up change `weekly-forecast-suggestions` (decision 16).
- Owner calendars (D33, D39) in the lab input.
- Item-level forecasts, Analytics forecasts, and changing the 28-day gate horizon.
- A new Azure resource or scheduler service.

## Decisions

### 1. Spec numbers: D42 and 14.6

D42 "Autonomous forecasts" (next free after D41) is the decision row; 14.6 "Weekly refresh, engines and publish policy" holds the rules, beside 14.4 and 14.5. D27, G2, 14.2, 14.3, 10.13, 10.15 and P11 gain build notes or amendments pointing at D42. D12 is not touched: its `[DECISION NEEDED]` stays, since a person's calibration keeps 595 days.

Alternatives: amending D27 in place (an owner decision; editing its text would hide what changed) or a new top-level section (the forecast rules already live in 14).

### 2. The weekly refresh lives in the API process, under a Mongo lease

`api/src/lab/schedule.ts`, shaped as `createForecastSchedule(deps)` like `createCalendarRefresher`, starts in `main.ts` only when `labRunner !== null` and `TOWNWISE_WEEKLY_FORECASTS` is true. Every hour (and once 2 minutes after boot) it claims the lease on the single `tw_forecast_schedule` document (`_id: 'weekly'`, `owner`, `leaseUntil`, 10 minutes) by compare-and-set, as `claimFileSweep` does, and renews it by compare-and-set before each location. A failed renewal stops the pass at once, so two holders never start in parallel. The holder lists candidates through a new cross-tenant lookup (`weeklyCandidates` in `stores/cross-tenant.ts`: locations of active organizations with `forecasts.on`), and `scopeForWeeklyRefresh` in `access/policy.ts` mints each `OrgScope`. Locations are taken one at a time. At most 3 scheduled calibrations are live at once across all organizations; a due location past that waits for a later tick without a week row.

Week rows (`tw_forecast_weeks`, unique `{ orgId, locationId, week }`) go `starting` before `launch`, then `started` with the calibration id or `start_failed`. A `starting` row older than the lease is resolved by looking for a system calibration of that location created after the row; this covers a holder that dies between the insert and the start.

Mongo, not Valkey, because the record that a week was done must survive a cache flush or a Valkey restart (a lost key would start a second calibration), because DocumentDB supports the same `findOneAndUpdate` lease the sweeper uses, and because it needs no new dependency or failure mode.

Alternatives considered: an Azure Container Apps scheduled job (a new resource, a new identity grant, and duplicate start logic outside the API); a cron trigger on the lab job (the lab holds no secret and cannot read Mongo); starting a refresh lazily on a read (GET is side-effect free, spec 7.3); a Valkey `SET NX` lease (above); no live cap (a Monday with many due locations would start dozens of 1 vCPU jobs at once).

*Claude's call:* the start is 03:00 Monday town time, so a weekend's uploads made by Sunday night are in. A start blocked by a live calibration (someone started one by hand) is tried again each tick until Monday ends in the town; once a scheduled calibration has started, a failure is not retried that week. The live cap of 3 is a [CONFIRM].

### 3. Scheduled calibrations are system-paid, bounded and stoppable

`requestedBy` becomes `{ userId: null, role: 'system', via: 'scheduled' }`. `launch` skips the org limiter (`service.ts:178`) and the charge (`service.ts:205`) for this requester and records `chargedMicroUsd: 0`; `checkStart`'s `budget_exhausted` does not apply. Bounds: one week row per location per week; the live cap of 3; a weekly cap of roughly `TOWNWISE_WEEKLY_FORECAST_CAP` (default 200), counted on this week's `starting` and `started` rows (approximate only by the rows a stopped holder leaves `starting`). At about $0.03 of compute a run (`infra/README.md:644`) that is roughly $6 a week at most.

Three ways to stop it: `TOWNWISE_WEEKLY_FORECASTS` (deploy level: false in `config.ts` and `.env.example`, written explicitly as `false` in `api/production.env` until the owner turns it on); `paused` on the schedule document, set by staff from the console (`POST /api/admin/forecast-schedule { paused }`, audited), effective at the next tick; and G1 off for one organization, effective at once. None cancels a live calibration.

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

Its backtest is refit weekly (it is cheap) and scored on the same weeks as the model's. Its minimum span is 56 + 28 + 6 + 140 = 230 days, pinned by `test_baseline_min_history_days_always_gives_twelve_weeks_with_a_range` the way 595 is pinned. The 230 applies to scheduled calibrations only; a calibration a person starts keeps needing 595, so `checkStart`'s refusal words and D12 are unchanged. [CONFIRM] in the delta, worded as superseding the 2026-11-10 decision for the baseline on scheduled calibrations only.

The run's `model.family` is `seasonal_baseline` (`MODEL_FAMILIES`, `api/src/forecasts/file.ts:14`); `ForecastRunView.engine` is derived from the family, so no stored field and no migration.

Alternatives: the weekday median alone (no seasonality or events; it remains the floor the baseline must beat, decision 9); lowering the model's minimum (its quarterly refits need a year to learn seasonality, `gate.ts:12-19`); an LLM-made baseline (an unscored figure; G4 keeps training data from Anthropic); 230 days for a person's calibration too (rejected by the lead: keep the owner's 595 where a person asks).

### 7. Lab input version 2, in one step

Version 2 adds `calendar: { id, group, kind, start, end, confidence }[]` (the same `townEvents` call `input.ts:112` makes; no title, URL or source label, since the reader words a reason and attaches its sources from its `ref`, `api/src/forecasts/reasons.ts:98`) and `champion.engine`. The lab accepts version 2 only. The API and the lab move together in one phase, built from the same commit. The lab is off in production until step 20, and locally both run from one checkout, so no mixed versions exist. `horizonDays` stays 182: it bounds the input's future days, and the run's own end is decision 10's.

Alternatives: answering versions 1 and 2 for a release (cut by the lead: twice the contract and tests for a job that is not live in production).

### 8. Which engine a calibration returns: the current one sticks

The lab runs the baseline always and the model at a 595-day span. It returns the current published run's engine (`champion.engine`) unless the other engine's backtest weekly WAPE is at least 0.5 points lower on the same weeks; with no current run, the model when it is 0.5 points better than the baseline, else the baseline. A tie keeps the current engine. This is the only cross-engine comparison, made on the same weeks, which is fairer than comparing recorded backtests from different weeks, and the 0.5-point margin stops weekly flip-flopping between close engines. When the current engine is the model and the model could not run (the span fell under 595, say after an upload was turned off), the lab returns the baseline's run and the gate holds it (`model_not_run`), so a model forecast is never replaced by a baseline for want of data. The scorecard carries `engine` and `engines`.

Alternatives: always preferring the model when it passes (two close engines would flip week to week); publishing both engines' runs (two published runs for one cutoff break "the newest run whose `dataThrough` is before the date"); the gate comparing engines on recorded backtests (different weeks; rejected by review).

### 9. The gate: one set of rules for every calibration

With weekly refits the published run is always a week or two old, so today's champion comparison, scored only on the champion's weeks after its `dataThrough` (`compare.py:43-56`), almost never reaches 12 weeks. New weeks would never reach a published run, and a person's calibration would answer `too_few_weeks` nearly every time. So every calibration, scheduled or started by a person (lead decision, 2026-11-16), is judged the same way after G1:

- **No current run**: the model's first-forecast rule, or the baseline's absolute checks.
- **Current lab run of the same engine**: the engine's absolute checks, and backtest weekly WAPE no more than 0.5 points above the best (lowest) recorded backtest weekly WAPE in the current streak (the consecutive published lab runs of that engine, read from their calibrations' scorecards). A tie publishes (`refreshed`), the one exception to G2's "ties do not publish"; otherwise `refresh_worse`. Comparing with the streak's best, not the latest run, stops the tolerance compounding: three refits each 0.4 points worse cannot drift 1.2 points.
- **Current lab run of the other engine**: the lab's same-weeks 0.5-point comparison (decision 8) stands; the gate checks the draft's absolute checks only.
- **Imported current run** (no lab scorecard): today's held-out comparison.
- **Absolute checks.** The model: coverage 65% to 95% on 12 weeks with a range, weekday bias no more than 2 points worse than the current run's recorded backtest, and 0.5 points under the weekday median. The baseline: 12 weeks with a range, coverage 65% to 95%, weekly bias within 5 points, and weekly WAPE strictly under `weekdayMedianWeeklyWape` (`baseline_not_beaten`), so the baseline never publishes something a weekday average beats.
- **Jump guard.** With a current run, a draft that passes everything is held for staff (`jump_held`, never published on its own) when its middles over the 28 days from `today`, summed over days both runs forecast open, differ from the current run's by more than 25%. A data error (a doubled upload) cannot reach owners unseen.

[CONFIRM]s in the delta: the recorded-backtest basis, the streak tolerance, the baseline's checks, the jump guard.

Alternatives: keeping today's held-out rule for a person's calibration (the trap above); scoring the champion's published days against actuals at any age (too few weeks for a young champion); comparing with the latest run's WAPE (drift compounds); storing the model to rescore it (G3 and 14.4 say the model is stored nowhere); no jump guard (a bad upload publishes a wild forecast on Monday morning).

### 10. Horizon: today plus 91 days, 28 gating, longer leads reported

A run carries the days after `dataThrough` through `today` plus 91, capped at 182 days after `dataThrough` (the input's reach), so a location whose sales lag still gets 91 days past today. The scorecard keeps `horizonDays: 28` for the gate and adds `horizon91` and, when sales lag so the run's longest lead passes 91 days, `horizonReach`: the backtest weeks forecast that far ahead, reported and not gating. Days with a lead of 29 to 91 widen by the 91-day to 28-day weekly band ratio; longer leads by the reach's ratio (at least 1). Where a horizon has fewer than 8 backtest weeks, the run stops at the shorter horizon's last day (no range without evidence). The backtest's predictions reach the run's longest lead plus 6 days past each cutoff. Gated by decision 14's runtime check. [CONFIRM] in the delta.

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

Nothing reads a town or organization by name: candidates come from `forecasts.on`, the time zone from `timeZoneOf(location.town)`, the calendar from `townEvents(townId)` (no researched calendar gives holidays only). `createForecastSchedule` takes `now`, `tickMs`, the runner and the stores as deps, so `api/test/weekly-refresh.int.test.ts` drives Mondays with a fake clock and a fake runner, and a local run with `TOWNWISE_LAB_RUNNER=local` and `TOWNWISE_WEEKLY_FORECASTS=true` exercises the real lab end to end.

### 14. Runtime headroom gates the lab work

The job is killed at 900 seconds (`lab.tf:89`) at 1 vCPU and 2 GiB (`lab.tf:99`), and today's runs are estimated at about 15 minutes. Before any lab change, task 0.3 times today's calibration in the lab image under `docker run --cpus=1 --memory=2g` on a 700-day fixture. The second engine and the longer reach (decisions 8 and 10) proceed only if the measured run, plus the baseline's measured cost and the longer prediction reach, stays under 600 seconds (two thirds of 900). Otherwise the work stops and goes back to the lead with the numbers. Options then are a larger job size or fewer folds, each with its own cost.

### 15. Order of landing

Each phase lands on develop with everything off: (1) docs and additive shapes, with the client and the staff view accepting new states, fields, `via: 'scheduled'` and role `system` before the API sends them; (2) the lab and the API's input version 2 together, after the runtime check; (3a) the gate, the system requester, the fingerprint and the ranged reader, with no loop; (3b) the scheduler behind its switch; (4) the client; (5) config and infra; (6) owner actions.

### 16. Weekly suggestions moved to a follow-up change

The owner's "agentic ... rules" (TownwiseAI reading the next 3 months of the town calendar and suggesting notes and rules each week) is the follow-up change `openspec/changes/weekly-forecast-suggestions/`. It runs on this change's tick and week rows. It is split out because it sends the owner's notes and rules to Anthropic unprompted, needs its own consent and privacy wording, and should not hold back the refresh.

## Risks / Trade-offs

- [A refit publishes a slightly worse forecast within the tolerance] → Measured against the streak's best, so it cannot compound; absolute checks and the jump guard apply; staff can withdraw.
- [Runtime passes the 900-second job limit with two engines and a longer reach] → Decision 14 measures first and stops at 600 seconds.
- [A bug starts calibrations in a loop] → One week row per location per week, the live cap of 3, the weekly cap, the staff pause and the env switch.
- [The lease holder dies or loses the lease mid-pass] → Renewal before each location; a failed renewal stops the holder; `starting` rows are resolved by the next holder.
- [Close engines alternate week to week] → The current engine sticks unless the other is 0.5 points better on the same weeks.
- [A bad upload produces a wild forecast] → The jump guard holds it for staff.
- [The baseline's seasonal shape misreads a year with a closure] → Closed and likely-closed days are left out, the shape is clamped, and the backtest's coverage, bias and weekday-median checks refuse a bad fit.
- [Reads slow down as weekly runs pile up] → The ranged reader, pinned with 52 runs.
- [The client or staff view sees a value it does not know] → Phase 1 makes them accept it first.

## Migration Plan

No data migration. New fields are optional or derived: `dataSha256` absent on old calibrations (counted as changed), `requestedBy.role: 'system'` only on new rows, `engine` derived from the family, `paused` absent meaning not paused. Rollback: set `TOWNWISE_WEEKLY_FORECASTS=false` or pause from the console; published runs stay (G3) and staff can withdraw any.

## Open Questions

- Who sees `stale` first: the model card only, or also a line on Home? This change shows it on the model card and in TownwiseAI only.
- If decision 14's measurement fails, should the lab job grow (cost) or the backtest shrink (fewer folds)?
