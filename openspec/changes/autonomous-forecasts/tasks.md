Each phase lands on develop on its own with everything off by default (design decision 15). Tests first: write the named test, see it fail, then make it pass. Heavy local runs: one workspace at a time, and ask the release session before a full suite.

## 0. Before starting

- [x] 0.1 Record the baseline of the suites this change touches: `npm test -w @townwise/api -- test/lab-gate.test.ts test/lab-input.test.ts test/forecast-score.test.ts test/estimates.int.test.ts test/chat-estimate-tools.test.ts test/calibrations.int.test.ts`, `npm test -w @ckeith26/expo-shell -- test/portal/home test/portal/estimates test/portal/console`, and `uv run pytest` in `modeling/lab`. Note any failure that predates the change.
  - Baseline, 2026-11-16 at c6ffd75: API 5 files and 108 tests passed (`test/calibrations.int.test.ts` does not exist; `test/calibrations-store.int.test.ts` and `test/forecast-file.test.ts` were run instead, 33 passed). Client: 35 suites, 539 of 541 tests passed; `test/portal/console/people.test.web.tsx` and `test/portal/home/home.test.web.tsx` ("the last week chart prints its key and scale") failed in the full run at about 55 seconds each and passed when rerun alone (41 of 41), so they are load flakes, not failures of the code. Lab: 116 passed.
- [x] 0.2 Confirm D42 and 14.6 are still free in `docs/portal/spec.md` (`grep -n "D42\|### 14.6"`); if taken, renumber here and in the delta text before any code.
  - Free on 2026-11-16: no `D42` row or `### 14.6` in `docs/portal/spec.md` here or on `origin/develop`; only `weekly-forecast-suggestions` names D42, as this change's.
- [x] 0.3 Runtime headroom (design decision 14): build the lab image from develop and time today's calibration under `docker run --cpus=1 --memory=2g` on a 700-day synthetic fixture (never `data/`), three runs, against the job's `replicaTimeout` of 900 seconds (`infra/terraform/production/lab.tf:89,99`). Record the times in design.md. Phase 2's second engine and longer reach go ahead only when the measured run plus their measured cost (2.3 and 2.6 time it again) stays under 600 seconds; otherwise stop and report to the lead.
  - Measured: 28.6, 19.3 and 18.6 seconds (amd64 image under Rosetta on an M4 Max, 1 CPU, 2 GiB; peak 189 MB). Headroom under 600 seconds; details in design.md decision 14.

## 1. Spec, docs and additive shapes (design decisions 1, 5, 11, 12, 15)

- [x] 1.1 `docs/portal/spec.md`: add D42 (the decision, the owner's words of 2026-11-16, every [CONFIRM] of the deltas, the link to the `weekly-forecast-suggestions` follow-up) and section 14.6 (weekly refresh, engines, publish rules, horizon). Add build notes on D27 (scheduled calibrations are system-paid and may start from 230 days; a person's keep 595), G2 (the same-engine tolerance), 14.2, 14.3 (`calibrated` and `stale` built; shape `horizon: 28 | 91`), 14.4 (92-day reads, `engine`, `accuracy`, `scored`), 10.13, 10.15 (input version 2), 6.20 (family `seasonal_baseline`), and 6.23 (`requestedBy` role `system`, via `scheduled`; `dataSha256`; the new gate reasons). Add section 6 entries `tw_forecast_schedule` and `tw_forecast_weeks`; P11 ("never an unpublished guess", the Last week bullet, At a glance); P21 (week outcomes, pause); 18 (env vars); the 22.1 index; the 23 changelog. Leave D12 and its `[DECISION NEEDED]` untouched.
  - Done as follows. The new collections are 6.25 and 6.26 (6.24 was the last). Section 22.1 is an unnumbered list; the numbered CONFIRM index is 22.2, so the eleven new items are 22.2 items 83 to 93. P11's Last week bullet never said "never a guess", so its build note says "never an unpublished guess", and At a glance's "none is a guess" is kept with a build note after it. `baseline_not_beaten` already existed, so 6.23 extends its meaning to baseline drafts. Every later-phase rule is written as not yet built. D12 is unchanged.
- [x] 1.2 `api/README.md`: Calibration (the new states), Forecast lab (scheduled calibrations, engines, publish rules, the three stops, local run steps), the forecast route's 92 days and `accuracy`, rate limits (scheduled calibrations outside the limiter), collections, env vars, the staff route and audit actions. `docs/portal/tuning-chat.md`: `get_forecast` 92 days and `engine` (frozen-prefix note), and `start_calibration`'s words when weekly refresh is on. `docs/portal/estimates.md`: section 7 gaps and section 8's lab paragraph.
  - Done. Later-phase items in `api/README.md` read "coming in autonomous-forecasts phase N, not yet in the code". The deltas give no words for `start_calibration` while the weekly refresh is on, so `tuning-chat.md`'s wording there is a draft for review.
- [x] 1.3 Client and staff view accept before the API sends:
  - `client/src/portal/schemas.ts` accepts calibration states `calibrated` and `stale` with their fields.
  - `client/src/portal/estimates/api.ts` accepts `engine`, day `scored` and window `accuracy` (optional).
  - `client/src/portal/console/calibrations.ts:22-23` accepts `via: 'scheduled'` and `requestedByRole: 'system'`.
  - `api/src/lab/views.ts:29-30` and `api/src/stores/calibrations.ts:31-33,70-71` type them.
  - `client/src/portal/console/forecasts.ts` accepts family `seasonal_baseline` and the new gate reasons.
  - Tests: `client/test/portal/estimates/forecast-schema.test.ts`, `client/test/portal/console/calibrations.test.web.tsx` and `client/test/portal/console/forecasts.test.web.tsx` parse old and new shapes; `api/test/lab-views.test.ts` shows a system requester as "Townwise (weekly)".
  - Done as follows. The API's staff view carries no requester words (it passes `via` and `requestedByRole` through), so `api/test/lab-views.test.ts` (new) pins the system requester passing through with `chargedUsd` 0, and the console's `CalibrationsPanel.tsx` words it "Started by Townwise (weekly)" (`calibrations.test.web.tsx`). The store's enums gain `system` and `scheduled` (`calibrations-store.int.test.ts`). The client never lists gate reasons (`gate.reason` is any string with the server's words), so the console test only pins that `jump_held` shows its words. `calibrated` and `stale` carry `dayCount`, `firstDate` and `lastDate` as `not_calibrated` does, plus `dataThrough`, `newerDays` and `nextRefresh`, because the upload step's `calibrationLine` reads the day count in every state with days; 3a.5 must send all six (`client/test/portal/logic.test.ts`). `engine` is any string on the client, like `trainingSource`, so an engine it doesn't know never fails a page.
- [x] 1.4 `api/src/forecasts/score.ts`: export window accuracy and a `scoredDay` predicate. `api/src/forecasts/reader.ts`: `MAX_FORECAST_RANGE_DAYS` 92; each day's `scored`; the window's `accuracy`; `engine` and the baseline's label on `ForecastRunView`. Tests first: `api/test/forecast-score.test.ts` (window accuracy over days of two runs; booked, closed and likely-closed days left out; null under 5) and `api/test/estimates.int.test.ts` (92 days answers 200, 93 answers 400; `accuracy` and `scored`; a `seasonal_baseline` run's `engine` and label).
  - Done as follows. score.ts exports `scoredDay`, and `liveAccuracy` is the window's accuracy when given the read's own days, so no second function was added. A no-forecast answer carries `accuracy: null`. `chat/tools/visual.ts` reads the forecast in `MAX_FORECAST_RANGE_DAYS` chunks and a daily visual is capped at 92 days, so it now makes one read; its loop is unchanged and `api/test/chat-visual.test.ts` pins the single read. Hand-built windows in `chat-visual.test.ts` and `chat-order-tools.test.ts` gained the new fields. The estimates test's baseline run is a staff import with family `seasonal_baseline`, which needs 1.6.
- [x] 1.5 `api/src/chat/tools/forecast.ts`: 92 days, `engine` per run, description and invalid-input words. Test: `api/test/chat-estimate-tools.test.ts` (92 days, 93 refused, `engine` in the result).
- [x] 1.6 `api/src/forecasts/file.ts`: `MODEL_FAMILIES` gains `seasonal_baseline`. Test: `api/test/forecast-file.test.ts`.
  - The import shares `MODEL_FAMILIES`, so a staff import may now carry `seasonal_baseline` too (the client's run file check accepts it the same way, 1.3).
- [x] 1.7 Run the touched suites, `npm run typecheck`, `npx eslint` on touched files. Commit (`feat: accept forecast engines and 92-day reads`).
  - Ran: API 19 files (the six of 0.1 that exist plus `forecast-file`, `lab-views`, `chat-visual`, `chat-order-tools`, `chat`, `lab-publish`, `lab`, `forecast-runs`, `isolation`, `chat-lab-tools`, `routes`, `chat-tools`), all passing; `lab-publish.int.test.ts` gained `engine` in its exact run match. Client: home, estimates, console, calendar, `logic` and `upload/copy`, 64 suites and 1,137 tests passing on web and native. `npm run typecheck` and `npx eslint` on every touched file clean.

## 2. Lab and input version 2, in one step (design decisions 6, 7, 8, 10, 14)

Needs 0.3's headroom. The lab and the API's input change land in one commit.

- [ ] 2.1 `modeling/lab/townwise_lab/schema.py` and `api/src/lab/input.ts`: `townwise.lab-input/2` only (`calendar`, `champion.engine`); the lab refuses version 1. Tests: `modeling/lab/tests/test_contract.py` (version 2 valid; version 1 refused; a title or URL key in a calendar entry refused) and `api/test/lab-input.test.ts` (no title or URL anywhere; `champion.engine` set from the run's family).
- [ ] 2.2 `modeling/lab/townwise_lab/baseline.py`: level, shape (clamped), calendar effects, shared statuses, reasons with `effectPct`. Tests first in new `modeling/lab/tests/test_baseline.py`: a known weekday pattern, a home-game group lifting Saturdays by 1.3, a closed weekday, a one-off event with no effect, the shape clamp.
- [ ] 2.3 Baseline backtest (weekly cutoffs, same scored weeks as the model) and its ranges; time it (0.3). Test: `test_baseline_min_history_days_always_gives_twelve_weeks_with_a_range` (230 days) beside the 595 test.
- [ ] 2.4 `modeling/lab/townwise_lab/pipeline.py`: the baseline always, the model at a 595-day span; engine stickiness (the current engine unless the other is 0.5 points better on the same weeks; a tie keeps it); scorecard `engine`, `engines`, bias. Tests in `test_pipeline.py`: model chosen with no current run; baseline chosen; model not run under 595; engine flip-flop (four calibrations whose margins alternate within 0.5 keep the current engine); a 0.6-point win switches.
- [ ] 2.5 `modeling/lab/townwise_lab/compare.py`: compare the returned engine's predictions with the current run. Test: `test_pipeline.py`.
- [ ] 2.6 `backtest.py` and `forecast.py`: predictions reach the run's longest lead plus 6 days; `horizon91` and `horizonReach`; the run through `today` plus 91, capped at `dataThrough` plus 182; widening by lead; the stop under 8 weeks. Time it (0.3). Tests in `test_pipeline.py`: `test_run_file_obeys_api_rules` with current sales (ends today plus 91) and with sales 3 weeks behind (starts after `dataThrough`, ends today plus 91); a short history stops at 28 days of lead; ranges never narrower with lead.
- [ ] 2.7 Update `modeling/lab/tests/golden` with `make_golden.py` and check `test_parity.py` still holds for the model engine.
- [ ] 2.8 `uv run pytest` in `modeling/lab`, the API's `test/lab-input.test.ts`. Commit (`feat: add the lab's baseline engine and lab input v2`).

## 3a. API: gate, system requester, fingerprint, ranged reads (no loop; design decisions 3, 4, 8, 9, 11)

- [ ] 3a.1 `api/src/lab/scorecard.ts` and `api/src/lab/result.ts`: `engine`, `engines`, bias, `horizon91`, `horizonReach`. Test: `api/test/lab-result.test.ts`.
- [ ] 3a.2 `api/src/lab/gate.ts` (design decision 9): one set of rules for every calibration; the same-engine tolerance against the streak's best recorded backtest; no second cross-engine check; the imported-run path; `model_not_run`; each engine's absolute checks, including the baseline beating `weekdayMedianWeeklyWape`; the jump guard; the new reasons and `GATE_WORDS`. Tests first in `api/test/lab-gate.test.ts`, one per scenario of the forecast-publish-policy delta, plus:
  - a same-engine tie publishes, and a baseline tied with the weekday median does not;
  - drift: refits of 9.1%, 9.5%, 9.6% and then 9.7% hold the last;
  - the jump guard: 5,200 against 4,000 is held, and 4,300 against 4,000 is not;
  - an org admin's calibration against a one-week-old run publishes `refreshed`, not `too_few_weeks`.
- [ ] 3a.3 `api/src/lab/service.ts` and `api/src/stores/calibrations.ts`: requester `{ userId: null, role: 'system', via: 'scheduled' }` skips the org limiter, the budget check and the charge (`chargedMicroUsd` 0) and may start from 230 days; a person's start keeps 595 and its refusal words; `dataSha256` on every calibration; the gate reads the streak's scorecards. Tests: `api/test/calibrations.int.test.ts` (a system start leaves the month and the limiter unchanged; a person's start still charges and needs 595; a system start at 230 days allowed, 229 refused).
- [ ] 3a.4 `api/src/lab/input.ts`: the fingerprint over the input without `calibrationId`, `today` and `champion`, with the schema version and `LAB_MODEL_VERSION`. Add a contract test that `LAB_MODEL_VERSION` equals `modeling/lab/townwise_lab/version.py`'s `MODEL_VERSION`. Tests: `api/test/lab-input.test.ts` (unchanged when only `today` or the champion changes; changed by a rule, a note, a day, a deleted day, or a version bump).
- [ ] 3a.5 `api/src/calibration.ts`: `calibrated` and `stale` with `dataThrough`, `newerDays` and `nextRefresh` (null while the lab runner is off, the switch is false, the schedule is paused, or forecasts are off), and the "Townwise refits on" words; callers in `handlers/locations.ts`, `handlers/sales.ts`, `chat/tools/overview.ts`, `chat/tools/calibration.ts`. Tests: `api/test/calibration.test.ts` (each scenario of the delta, including the lab off).
- [ ] 3a.6 `api/src/forecasts/reader.ts:193`: read rows by range (the window plus the past days live accuracy and `accuracy` score) instead of every row. Test: `api/test/estimates.int.test.ts` with 52 published weekly runs; the answer equals the unranged reader's, and the store is asked for a bounded range.
- [ ] 3a.7 Run the touched suites, typecheck, lint. Commit (`feat: judge every forecast draft by one set of rules`).

## 3b. API: the scheduler (design decisions 2, 3, 4, 13)

- [ ] 3b.1 Stores: new `api/src/stores/forecast-weeks.ts` (`tw_forecast_weeks`, unique `{ orgId, locationId, week }`, `starting` then `started`), the `tw_forecast_schedule` document (lease, `paused`), and `weeklyCandidates` in `api/src/stores/cross-tenant.ts`. Also `scopeForWeeklyRefresh` in `api/src/access/policy.ts`, indexes in `ensureIndexes`, and deletion with the location and the organization. Tests: `api/test/isolation.test.ts` (the importer list gains `lab/schedule.ts`) and `api/test/forecast-weeks.int.test.ts`.
- [ ] 3b.2 `api/src/lab/schedule.ts` (`createForecastSchedule(deps)`). Tests first in `api/test/weekly-refresh.int.test.ts`, with a fake clock and a fake runner, one per scenario of the weekly-forecast-refresh delta. They must include:
  - the reference rule: G1 switched on after a `forecasts_off` draft starts a fresh calibration with unchanged data;
  - `regimeStart` carried over from the current run's calibration;
  - the live cap of 3, with later ticks starting the rest;
  - a lease renewal that fails mid-pass, after which the holder starts nothing more;
  - a `starting` row resolved after the holder dies;
  - a location in another time zone, and organizations with forecasts on and off.
- [ ] 3b.3 The staff pause: `POST /api/admin/forecast-schedule { paused }` (staff), audit `forecast_schedule.paused` and `forecast_schedule.resumed`. The console's Forecasts section shows the pause toggle and each location's latest week row. Tests: `api/test/forecast-schedule.int.test.ts` (staff only; the next tick starts nothing while paused) and `client/test/portal/console/forecasts.test.web.tsx`.
- [ ] 3b.4 The pass's log line `townwise.weekly_refresh_pass { started, failed, skipped, capped, ms }` and `calibration.scheduled` in the audit allowlists (`api/src/audit.ts`) and console labels. Tests: `api/test/weekly-refresh.int.test.ts` (no id or figure in the line) and `api/test/audit.test.ts`.
- [ ] 3b.5 `api/src/config.ts` and `api/src/main.ts`: `TOWNWISE_WEEKLY_FORECASTS` (default false) and `TOWNWISE_WEEKLY_FORECAST_CAP` (default 200); start the loop only with the lab runner on and the switch true, and stop it on shutdown. Test: `api/test/config.test.ts`.
- [ ] 3b.6 Local end to end, by hand: `TOWNWISE_LAB_RUNNER=local`, `TOWNWISE_WEEKLY_FORECASTS=true`, a seeded location with 300 days and forecasts on, and the clock at a Monday 03:05. A baseline run publishes. Record the steps in `api/README.md`.
- [ ] 3b.7 Run the touched suites. Commit (`feat: refresh forecasts weekly`).

## 4. Client: Last week, the states and the engine words (design decisions 5, 10, 12)

- [ ] 4.1 `client/src/portal/analytics/week.ts`: `lastWeekComparison` takes the Last week forecast read and returns the forecast part (scored days with `accuracy`; days with a forecast and no guest count, with their figures) beside today's comparison; pure. Tests first: `client/test/portal/home/week.test.ts`, one per scenario of the home-last-week delta, including the mix of scored and forecast-only days.
- [ ] 4.2 Home:
  - `client/src/portal/home/Home.tsx`: the Last week forecast read, on its own.
  - `LastWeek.tsx` and the `LastWeekChart` pair: rows reading "Forecast, no guest count uploaded yet: ..."; forecast bars and their key on web (`.web.tsx`); text and the table on native.
  - `Glance.tsx`'s tile, and comments changed to "never an unpublished guess".
  - Tests: `client/test/portal/home/last-week.test.web.tsx` and `.test.native.tsx` (each state; the read failing; no total over forecast days; no figure from a draft) and `client/test/portal/home/glance.test.ts`.
- [ ] 4.3 `client/src/portal/estimates/ModelCard.tsx`: the baseline's label and the `calibrated` and `stale` lines. Test: `client/test/portal/estimates/model-card.test.native.tsx`.
- [ ] 4.4 Calendar reach: no code change expected. Add a test in `client/test/portal/calendar/` that a day 91 days after today shows its forecast and a day past the run says "The published forecast doesn't cover this day." Do not edit `refine-calendar-and-home`'s files beyond this test.
- [ ] 4.5 `client/MODULE.md` under Local changes, and `client/src/portal/README.md` if a shared piece changed. Run the client suites for home, estimates, console and calendar (web and native). Commit (`feat: show the forecast on home's last week`).

## 5. Infra and config

- [ ] 5.1 `api/production.env`: `TOWNWISE_WEEKLY_FORECASTS=false`, explicit, with a comment pointing at D42 and the owner's step, and `TOWNWISE_WEEKLY_FORECAST_CAP=200`. `api/.env.example`: the same names, off, with the local run's note.
- [ ] 5.2 `infra/README.md` step 20: the weekly refresh runs in the API once the lab is on and the switch is true; the cost line (about $0.03 a run, roughly 200 a week); the three ways to stop it; the measured runtime from 0.3. Add a log search alert beside the daily-cap alert (`infra/README.md:650`), as Terraform in `infra/terraform/production/` with its `terraform test`, firing when `townwise.weekly_refresh_pass` reports `failed` above 0 or no pass line appears for 8 days while the switch is on; add its line to the cost table.
- [ ] 5.3 `docs/portal/estimates.md` section 5: draft the privacy page's forecasts paragraph for the owner's approval (weekly refits on Townwise's servers from the location's own days and notes and the public town calendar, and the baseline). Do not edit `privacy.tsx`: that is the owner's.

## 6. Owner actions (not done by an agent)

- [ ] 6.1 Owner: approve or edit the privacy paragraph drafted in 5.3, then apply it to the privacy page.
- [ ] 6.2 Owner: confirm Sawtooth's consent (owner decision 2026-11-05) and have staff switch its forecasts on (G1). Its 658-day span makes it eligible for the model engine.
- [ ] 6.3 Owner: enable the lab in production (infra step 20: `terraform apply`, the lab image, `TOWNWISE_LAB_RUNNER=azure`), then set `TOWNWISE_WEEKLY_FORECASTS=true` in `api/production.env` and release.
- [ ] 6.4 Owner: decide each `[CONFIRM]` listed under Owner sign-offs in proposal.md.

## 7. Review and verification

- [ ] 7.1 Independent UI review before merge: an agent that did not build phase 4 checks against the deltas and the design system, and must judge the UI ready. It covers:
  - Home's Last week in its states, at 375, 640, 1024 and 1280 px on web, and on native;
  - the tile;
  - the model card's states;
  - the console's week outcomes and pause.
- [ ] 7.2 Code review of the whole branch (`/review`), with a security pass on the staff route, the cross-tenant lookup and the system requester.
- [ ] 7.3 When `refine-calendar-and-home` is archived (not before, and not in this change), reconcile its `design.md:35` and its Open Questions `[CONFIRM]` that say Home's Last week stays Monday to Sunday. Since 5132bcd, Last week is the seven days before today (spec 22.2 item 62), which this change builds on.
- [ ] 7.4 `/verify` (what CI runs: `npm run verify`, plus `uv run pytest` in `modeling/lab` and the Terraform checks for the alert), green before the PR to develop.
