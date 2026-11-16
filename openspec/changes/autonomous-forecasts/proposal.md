## Why

On 2026-11-16 the owner asked: "for last week if we don't have that data, we can just use the forecasted data and if we have both, we can show the error and incorporate new data into the model week over week automatically? We should use a combination of model retraining and agentic baselines / rules to create a forecast for every day over the next 3 months", then "dive in. we should make this as generalizable and ready as possible. set this up so it runs autonomously".

Today a forecast exists only when a person starts a calibration (TownwiseAI's `start_calibration`, a file read, or staff's Calibrate), and each is charged $0.10 to the organization's TownwiseAI month. A calibration needs a 595-day span of history, so a newer restaurant gets nothing. A published run is never refreshed with the weeks that follow it, and once it is a few weeks old the gate can rarely compare a new one against it. Home's Last week card compares history with history only. Nothing runs on its own. This change keeps every switched-on location's forecast current every week, for any organization and location, with no Sawtooth-specific code. The "agentic rules" half of the request, TownwiseAI suggesting notes and rules from the town calendar each week, is the follow-up change `weekly-forecast-suggestions` (`openspec/changes/weekly-forecast-suggestions/`), which runs on this change's weekly tick.

## What Changes

- **Spec numbers.** New decision D42 "Autonomous forecasts" and new spec section 14.6, both claimed by this change.
- **A weekly refresh in the API process** (no new Azure resource). An hourly tick, run by one replica under a lease in Mongo, starts a calibration with via `scheduled` for each location whose organization has forecasts switched on (G1) and whose lab input changed since its last meaningful calibration. The input covers days, notes, scheduled rules, the town calendar, the input version and the lab model version. A switched-on organization's location starts with any change even when its last draft was refused `forecasts_off`. The refresh runs once per location per week, from 03:00 on Monday in the town's time zone, carries the owner's pattern-change date over, and is never retried that week once started. At most 3 run at once. Scheduled calibrations are paid by Townwise: they are not charged to the organization's TownwiseAI month and not counted in its 4 a day. A weekly cap of roughly 200 bounds the cost. Three ways stop it: the env switch `TOWNWISE_WEEKLY_FORECASTS` (off by default, explicit in `api/production.env`), a staff pause in the console, and G1 off for one organization. Each pass logs its counts, an alert watches for failures, and the console shows each location's last outcome.
- **The reserved `calibrated` and `stale` states** (14.3) are built as derived states. A stale location says "Townwise refits on {Mon} with the {n} days since."
- **Two engines in the lab.** Beside the trained model, a `baseline` engine: each weekday's recent level times last year's seasonal shape, times the location's own effects of town calendar events and holidays. Both are backtested on the same weeks. The current engine sticks unless the other is at least 0.5 points better on those weeks, so engines do not flip-flop. The lab input moves to `townwise.lab-input/2` in one step, adding the town calendar's entries (ids, groups, kinds, dates, confidence; never a title or URL) and the current engine.
- **One set of publish rules for every calibration**, scheduled or started by a person. A refit of the same engine is compared with the best recorded backtest in the current run's streak and may be up to 0.5 points worse (a tie publishes, an exception to G2). An engine switch is decided by the lab on the same weeks. The baseline must pass coverage, bias and beat the weekday median. A draft whose next 28 days move more than 25% from the current run's is held for staff. A model run is never replaced by a baseline because the model could not run.
- **History minimums.** Scheduled calibrations may start from a 230-day span (the baseline's minimum). Calibrations a person starts keep the owner's 595 days, and the model engine always needs 595.
- **Horizon.** Runs reach today plus 91 days, capped at 182 days after the last day of sales. The gate keeps judging 28 days ahead; error at 91 days (and further when sales lag) is reported, and ranges widen by it. The forecast route and `get_forecast` accept up to 92 days a read, and the reader reads by range so 52 weekly runs a year stay fast.
- **Home's Last week card** (P11) shows the published forecast's error on days with a guest count, and the published forecast, labeled "Forecast, no guest count uploaded yet", on days without one. With nothing published it is unchanged. "Never a guess" becomes "never an unpublished guess"; every other honesty rule stays.
- **API shapes (additive).** `ForecastRunView` gains `engine`; a forecast day gains `scored`; `ForecastWindow` gains `accuracy`; the calibration state gains `calibrated` and `stale`; `tw_calibrations.requestedBy` gains role `system` and via `scheduled`, and gains `dataSha256`; the model family gains `seasonal_baseline`; the gate gains the reasons `refreshed`, `refresh_worse`, `model_not_run`, `biased` and `jump_held`.

## Capabilities

### New Capabilities
- `forecast-engines`: the lab's two engines and engine stickiness, input version 2, the run's reach and its widened ranges, and the longer-horizon reports.
- `forecast-publish-policy`: one set of rules for every draft, the streak tolerance, each engine's absolute checks, the jump guard, and the engine's words.
- `weekly-forecast-refresh`: the tick and its lease, which locations start, week rows, who pays, the caps, the three stops, visibility, and the `calibrated` and `stale` states.
- `forecast-reads`: reads of up to 92 days, ranged reads, and the window's own accuracy.
- `home-last-week`: the Last week card and its At a glance tile.

### Modified Capabilities
None. No capability of an unarchived change (notably `refine-calendar-and-home`'s `calendar-views` and `forecast-why`) is modified.

## Impact

- Lab (`modeling/lab/townwise_lab/`): new `baseline.py`; `forecast.py`, `pipeline.py`, `compare.py`, `backtest.py`, `schema.py`; tests in `modeling/lab/tests/`.
- API: new `api/src/lab/schedule.ts`; `lab/gate.ts`, `lab/scorecard.ts`, `lab/input.ts`, `lab/service.ts`, `lab/result.ts`, `lab/views.ts`; `forecasts/file.ts`, `forecasts/reader.ts`, `forecasts/score.ts`; `calibration.ts`; `handlers/estimates.ts`, `handlers/calibrations.ts` (the staff pause); `chat/tools/forecast.ts` and `chat/tools/calibration.ts` (a frozen-prefix change: one prompt cache miss per conversation); `stores/calibrations.ts`, `stores/cross-tenant.ts`, `access/policy.ts`, new store `forecast-weeks.ts`; `main.ts`, `config.ts`, `audit.ts`.
- New collections: `tw_forecast_schedule` (lease and `paused`) and `tw_forecast_weeks`. New env vars: `TOWNWISE_WEEKLY_FORECASTS` and `TOWNWISE_WEEKLY_FORECAST_CAP`. New audit actions: `calibration.scheduled`, `forecast_schedule.paused` and `forecast_schedule.resumed`. New staff route: `POST /api/admin/forecast-schedule`.
- Client: `client/src/portal/home/` (LastWeek, LastWeekChart and its `.web` sibling, Glance, Home), `analytics/week.ts`, `estimates/api.ts` and `ModelCard.tsx`, `schemas.ts`, `console/calibrations.ts`, `console/forecasts.ts` and the console's Forecasts section (week outcomes, pause).
- Docs: `docs/portal/spec.md` (D27, D42, G2, 6.x, 10.13, 10.15, 14.2, 14.3, 14.4, new 14.6, P11, 18, 22, 23; D12 untouched), `api/README.md`, `docs/portal/tuning-chat.md`, `docs/portal/estimates.md`, `infra/README.md` (step 20, the alert), `api/.env.example`, `api/production.env`, `client/MODULE.md`.
- No new npm or Python dependency and no new Azure resource, unless decision 14's runtime check asks for a larger job size.
- Cost when on: about $0.03 of compute a calibration (`infra/README.md` cost table), so roughly $6 a week at the cap, paid by Townwise.

## Owner sign-offs

Every `[CONFIRM]` this change adds, most consequential first (each also goes into D42):

1. A same-engine draft is compared with the current lab run's recorded backtest, not held-out weeks after its cutoff; an engine switch is decided by the lab on the same backtest weeks with a 0.5-point margin, and a tie keeps the current engine. This changes how G2 is scored.
2. A same-engine refit publishes when it passes its absolute checks and is no more than 0.5 points worse than the best recorded backtest in the current streak. A tie publishes, the one exception to G2's "ties do not publish".
3. Scheduled calibrations may start from a 230-day span. This supersedes the owner's 2026-11-10 decision of 595 days for the baseline engine on scheduled calibrations only; a calibration a person starts and the model engine keep 595.
4. The baseline publishes when the model is not eligible or does not win.
5. Scheduled calibrations are paid by Townwise, not the organization's TownwiseAI month, and don't count toward its 4 a day (amends D27).
6. A draft whose next 28 days' middles differ from the current run's by more than 25% is held for staff.
7. A baseline's absolute checks: 12 backtest weeks with an 80% range, coverage 65% to 95%, weekly bias within 5 points, and a lower weekly WAPE than the weekday median.
8. Runs reach today plus 91 days, capped at 182 days after the last day of sales; ranges past 28 days of lead widen by the backtest's longer-horizon bands; a run stops where fewer than 8 backtest weeks back the next horizon.
9. At most 3 scheduled calibrations live at once.
10. Roughly 200 scheduled calibrations a week across all organizations.
11. A scheduled calibration starts from 03:00 on Monday in the town's time zone.

## Owner actions (not done by this change)

- Switch forecasts on (G1) for any organization, after confirming Sawtooth's consent to see its forecast and to its being sent to Anthropic through TownwiseAI (owner decision 2026-11-05). Sawtooth's 658-day span makes it eligible for the model engine.
- Approve the privacy page's forecasts paragraph (`docs/portal/estimates.md` section 5), drafted by this change, before any organization goes on.
- Enable the lab in production: infra step 20 (`terraform apply`, the lab image, `TOWNWISE_LAB_RUNNER=azure`), then set `TOWNWISE_WEEKLY_FORECASTS=true`.
- Sign off the `[CONFIRM]` markers above.
