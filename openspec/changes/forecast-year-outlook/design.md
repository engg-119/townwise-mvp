## Context

What exists (develop at 0487d57, D42 live in v2026.11.17):

- **The run's reach.** `forecast.run_end` (`modeling/lab/townwise_lab/forecast.py`) ends a run at the calibration's `today` plus 91 (`REACH_DAYS`), capped at `dataThrough` plus 182 (`HORIZON_DAYS`, the input's future days). Where the 91-day horizon has fewer than 8 backtest weeks the run stops at 28 days of lead; where sales lag so the longest lead passes 91 and the reach horizon (`forecast.reach_horizon`, the longest lead rounded up to whole weeks) has fewer than 8 weeks, at 91 (`MIN_HORIZON_WEEKS`). The input carries `horizonDays: 182` on both sides (`api/src/lab/input.ts:35,101`, `modeling/lab/townwise_lab/schema.py:119,138`).
- **Ranges by lead.** `pipeline.calibrate` builds `widening`: leads of 29 and over take the 91-day weekly band width over the 28-day one, leads past 91 the reach's, each ratio at least the previous and at least 1. `forecast.lead_ratios` maps a day's lead from `dataThrough` to its ratio; `forecast.assemble` widens a week's log range by its first day's ratio and `baseline.run_file` and `forecast.run_file` widen the daily range by `widen_k` times it, both sides by one ratio. `result.ts` allows at most 4 widening entries.
- **The backtests.** The model refits quarterly from the month-end on or after its first day plus 364 (`backtest.quarterly_origins`) and predicts every later history day from each origin, so any lead its history spans is already in its predictions. The baseline cuts every Sunday from `baseline.first_cutoff` (first day plus 28 or more) and predicts one week per horizon per cutoff (`baseline.backtest_predictions`). `pipeline._horizon` reports a horizon's scored weeks, WAPE and coverage, and its band width. The baseline's bands use split conformal ranks over the last 52 weeks and `metrics.same_kind`.
- **The baseline's shape** (`baseline.shape`) reads the 3 plain same weekdays around the date less 364 days and needs all 3 on or before the cutoff, so for leads over 357 days the shape is 1.
- **The run file** allows 400 days, each within 400 days of `dataThrough`, and 60 weeks (`api/src/forecasts/file.ts:26-27,170`). The lab result callback takes 256 KB (`api/src/lab/callback.ts:44`, "a result is about 50 KB" with a 93-day run).
- **"Current" is a run's last day.** `currentChampion` (`api/src/lab/gate.ts:97`) and `streakOf` (`gate.ts:198`) count a run current while `range.to` is at least 28 days past today; `refitExtends` (`api/src/lab/schedule.ts:198`) refits unchanged data only when no run will be current next Monday and the reference run ended at its `madeAt` plus 91. The jump guard reads the current (or lapsed) run's rows over the 28 days from the draft's `madeAt` (`api/src/lab/service.ts:331`).
- **Accuracy.** `liveAccuracy` and `scoredDay` (`api/src/forecasts/score.ts:53`) score every open, not closed, past day with guests that a run supplied, for each run's `live` and the window's `accuracy`.
- **Reads.** The forecast route allows 92 days a read, from 400 days back to 400 days ahead (`api/src/handlers/estimates.ts:20,48-63`). The reader's ranged read (`reader.ts`, `windowRows`) loads every published run's rows from the earliest start of any run reaching the window to the window's end. The Calendar shows 12 months either side of today with one read of the grid's 42 days (P28); Home's This month reads this month (P11); TownwiseAI's daily visual reads at most 31 days past today (`tuning-chat.md`, `show_visual`).
- **The town calendar.** Hanover's researched terms reach fall 2027's finals (2027-11-24, `api/src/town-calendar-data.ts:183`; `api/test/town-calendar.test.ts:151` pins it). A day no researched term covers is `interim` in the lab input (`input.ts:154`). The model reads `term` and `week_of_term` as features; the baseline reads last year's guests and the calendar's event and holiday groups, never the term.
- **Production.** The lab, the weekly worker and on-by-default forecasts are live (v2026.11.17); Sawtooth's history spans 2025-01-01 to 2026-10-21 (658 days).

## Goals / Non-Goals

**Goals:**
- Every published lab run reaches a year past today, with the days past its forecast tier labeled an outlook everywhere an owner or TownwiseAI sees them.
- Days 1 to 91 behave exactly as D42 built them, in the lab, the gate, the schedule, accuracy and the UI.
- Outlook ranges are never tighter than backtests support, and narrow as history grows long enough to back them.
- No migration of existing rows, no new route, read cost that does not grow with the reach, and two releases each safe on its own.

**Non-Goals:**
- Judging the outlook in the gate beyond sanity checks; changing the engine choice, the 28-day gate or the jump guard's rule.
- TownwiseAI's weekly suggestions: they stay at the next 91 days (`api/src/lab/suggestions.ts:59`; owner decision, 2026-11-17).
- Analytics, net sales or item forecasts; pruning superseded runs' rows (G3).

## Decisions

### 1. Spec numbers: D52, CONFIRM items from 95

D52 "A year of forecast: the outlook" is the decision row (reserved for this change). develop's CONFIRM index ends at 94; other unmerged branches (among them `calendar-event-suggestions` in the sibling worktree) may claim 95 and later, so this change's items are written as 95 to 102 provisionally and renumbered against `origin/develop` at the start of each release and again just before each push (tasks 0.2, A.8, B.10). D42 gains a build note that its (4) is amended by D52; 14.6's Horizon bullet, 14.4's read view and Accuracy, 14.3's reserved shape, 10.13, 10.15, 6.21, 6.23, 13.1, P11, P28 and P25's visuals gain build notes.

Alternatives: amending D42's row text in place (hides what changed and when); a new section 14.7 (the outlook is a horizon rule, and 14.6 holds the horizon).

### 2. The reach: today plus 365, capped at 400 days after the last day of sales

Owner decision, 2026-11-17: a run reaches the calibration's `today` plus 365 days, capped at `dataThrough` plus 400 (the run file's existing limit, so no file limit changes). The 35 days of slack mean a location whose sales lag by up to 35 days still sees a full year; past that, the year shortens by the excess. The input's future days become 400 (`horizonDays: 400`). `[CONFIRM: runs reach today plus 365 days, capped at 400 days after the last day of sales]`

Alternatives: a cap of 365 (any lag shortens the year; the earlier draft); no cap (an outlook built from a level more than a year old).

### 3. Two tiers, derived from the run

A run's forecast tier ends at `tierEnd(run) = min(madeAt + 91, dataThrough + 182)`: exactly the last day a D42 run made that day would have carried. A day after it is in the run's **outlook**. `forecastThrough(run) = min(range.to, tierEnd(run))`. Both live in `api/src/forecasts/tiers.ts` (new, pure), with `FORECAST_TIER_DAYS = 91` and `FORECAST_TIER_CAP_DAYS = 182` held equal to the lab's `FORECAST_DAYS` and `FORECAST_CAP_DAYS` by `api/test/lab-contract.test.ts`.

- Read days carry `outlook: boolean` from the run the reader chose for the date; weeks carry `outlook: true` when any day is.
- A run that is not refreshed keeps its tiers: a figure made 120 days ahead stays "Outlook" as today approaches it, since it is still that figure with that range.
- Imported runs follow the same rule. The frozen files in `modeling/forecasts/` cover 70 days and stay all forecast.

Derived, not stored: a stored tier would need a strict run file schema change and a backfill; the rule is one comparison of dates every reader already holds.

Alternatives: a stored per-row tier; the tier by the read's today (`date > today + 91`, which relabels a day while its range stays an outlook range); the tier by lead from `dataThrough` alone (a lagging location would lose forecast days it has today).

### 4. Days 1 to 91 unchanged

Everything that decides the forecast tier stays as D42 built it, and four places that would silently change with year-long runs are pinned:

- **(a) The lab's forecast tier.** `reach_horizon` and the forecast tier's end stay `min(today + 91, dataThrough + 182)` with D42's stops: under 8 weeks at 91 days the run stops at 28 days of lead, under 8 at the reach at 91, and then the run has **no outlook**. The engine choice, `passes`, the 28-day gate, the widening at 29 and over and past 91, and a forecast-tier week widened by its first day's ratio are unchanged. Test: `test_forecast_tier_unchanged`.
- **(b) Current.** `currentChampion`, `streakOf` and `refitExtends` use `forecastThrough(run)` where they use `range.to`; `refitExtends` checks the reference run's forecast tier was full (`forecastThrough(run) === tierEnd(run)` and `tierEnd(run) === madeAt + 91`). With 91-day runs `forecastThrough` equals `range.to`, so existing tests pass unchanged; new tests pin a year-long run lapsing when a 91-day one would.
- **(c) The jump guard.** `service.ts` reads `jumpRows` over the 28 days from the draft's `madeAt`, cut at `forecastThrough(against)`, so a lapsed run's stale outlook never feeds the 25% comparison: only days the D42 run would have carried count. Test in `api/test/lab-publish.int.test.ts`.
- **(d) Accuracy.** An outlook day is left out of live accuracy: `ScoredDay` gains `outlook`, `scoredDay` is false for it, so neither a run's `live` nor the window's `accuracy` counts it; it still carries `actual` and `inRange`. Live accuracy then keeps meaning what it meant for 91-day runs. Test in `api/test/forecast-score.test.ts`.

`calibrationOf`'s `calibrated` and `stale` read `dataThrough` and are unchanged.

Alternatives: leaving `range.to` (the streak would span a year of runs and unchanged data would never refit); scoring outlook days into `live` (mixes two kinds of figure in one accuracy).

### 5. Outlook horizons and the range rule

The lab backtests two outlook horizons, **182 and 365 days of lead**, on both engines, reported in the scorecard's `horizonOutlook` (`{ horizon, weeks, weeklyWape, coverage80, ratio, basis }`, never gated). Let S be the forecast tier's last horizon (91, or the reach when sales lag) with ratio r_S. For each outlook horizon H in order (S, then 182):

- **Growth floor** g_H = r_prev × sqrt(H / prev).
- **Backtest ratio** b_H, per side: max(lo_H / lo_28, hi_H / hi_28), where lo and hi are the sizes of the weekly log band's two sides; when a 28-day side is 0 (the range holds zero), that side uses the width ratio. Bands at long leads are rarely symmetric (a year out a level can fall further than it can rise, or the reverse), and the side that grew most sets the ratio, so neither side ends up narrower than its own backtest.
- **Fewer than 8 backtest weeks** at H: r_H = g_H (`basis: 'growth'`). **8 to 25**: r_H = max(g_H, b_H) (`'growth_or_backtest'`). **26 or more**: r_H = max(r_prev, b_H) (`'backtest'`). `[CONFIRM: 26 backtest weeks at a horizon let its backtest alone set the outlook's band; under 26 the backtest can only widen the square-root-of-lead growth]` (owner decision, 2026-11-17).

By lead L from `dataThrough`, past the forecast tier: up to 182, r_182; from 182 to 365, interpolated on the square root of lead between r_182 and r_365 (equal to r_182 × sqrt(L / 182) when r_365 is the pure growth); from 365 to 400, r_365 × sqrt(L / 365). Daily ranges widen by `widen_k` times the day's ratio on both sides, in `forecast.run_file` and `baseline.run_file`; an outlook week (any day in the outlook) widens by the largest ratio among its days in `forecast.assemble`. The run's `widening` carries the forecast tier's entries unchanged and two outlook anchors (`{ fromLead, ratio, horizon }` for 182 and 365), equal to `horizonOutlook`'s ratios.

Why this is honest, and where it leans on assumptions:

- **Never narrower with lead**: every ratio is at least the previous one.
- **Square root of lead** is the spread of a random walk, the usual model for a level drifting with no trend; a level that returns toward its season grows slower. A steady trend grows faster, which the coverage check (decision 6) puts inside the scored year. From 91 days it gives 1.41 at 182 and 2.0 at 365 in log terms.
- **Under 26 weeks the backtest can only widen.** Bands from 8 to 25 weeks under-cover (the model's `quantile_band` holds about 62% of weeks at 8, `baseline.weekly_band`'s docstring), and long-lead backtests read the town calendar as researched afterwards, which decision 6's hindsight test measures.
- **26 weeks counts weeks, not independent years.** The weeks at a long lead come from few origins, so they are far from independent. On Sawtooth's 658 days: the model has about 15 weeks at 182 and none at 365 (its quarterly origins start a year in), so its 182 band is the larger of growth and backtest, and its 365 the growth. The baseline has about 64 weeks at 182 and about 37 at 365, so both pass the bar. But the baseline's 365-day weeks are all forecast from cutoffs in its first year, where its shape is 1 and its forecast is the weekday level of the weeks just before the cutoff; a week 365 days later falls in the same season, so each is in effect a seasonal-naive forecast and its error is one year-over-year change of this restaurant, observed once. That is a fair sample of how a year-ahead figure misses only as far as the next year changes like the last one did. The bar is kept as the owner decided; the coverage check scores exactly this case (a two-year cut), and the spec text says the band rests on one year-over-year change until a location has three years.
- **Where the history allows, the backtest decides**, so precision improves as data grows.

Alternatives: three horizons (182, 273, 365; cut by review: a third horizon adds a backtest and a ratio that the sqrt interpolation already gives within the check's precision); linear growth (4 times the 91-day band at a year); the measured band alone from 8 weeks; a symmetric width ratio (a skewed band would narrow on its wider side).

### 6. The coverage check can fail, and failing blocks release B

`modeling/lab/tests/test_outlook_coverage.py` (synthetic only, never `data/`):

- **Histories**: four years each; `test_coverage.py`'s five weekly swings and four seeds, plus histories with a 20% level shift and with a trend that changes slope, both placed inside the scored year; one set with Hanover's calendar as D42's 7.1 did.
- **Cuts**: each history is calibrated as of two years and as of three years; each cut's run is scored on the year after it.
- **Hindsight**: the input given at each cut carries no calendar event that starts more than 182 days after the cut, while the scored days' guests were generated with them, so the check measures an outlook made before the town announced its events.
- **Pass**, per horizon (182 and 365) and per cut, not pooled: mean weekly coverage of the 80% bands at least 80% and no history under 65%; mean daily coverage of the daily ranges at least 75%.
- **It can fail**: a control run of the same check with every outlook ratio forced to the 28-day ratio (no widening) must fail it, which the test asserts, so a check that passes everything is caught.
- The exponent 0.5, the 26 weeks, the horizons and these thresholds are set here, before measuring, and not tuned after. If the check fails, release B does not ship: the work stops and goes back to the lead with the numbers, as D42 decision 14 did for runtime. Release A, which only reads and labels, is unaffected.

### 7. The baseline reads two years back past 357 days of lead

For a date whose 3 weeks around the date less 364 days are not all on or before the cutoff (leads 358 to 400), `baseline.shape` reads the 3 weeks around the date less 728 days over the plain level at the cutoff less 728 days, clamped as before, and 1 without two years of plain history. Leads of 357 or less are unchanged.

Alternatives: shape 1 for the outlook's last weeks (a seasonal cliff); 2 of the 3 weeks (still 1 at 365 and over); ending the outlook at 357 days.

### 8. The model's outlook stops at the town's last researched term

Owner decision, 2026-11-17. The model reads `term` and `week_of_term`, and a day no researched term covers reads `interim`, so a term not yet researched would be forecast as a break. Input version 3 carries `termsThrough` (the last day of the town's last term entry, classes or finals; null for a town with none), and the API records it on the calibration (`tw_calibrations.termsThrough`, optional, absent on older rows). A model run's outlook ends at `termsThrough` when that is earlier; the forecast tier is never cut by it, so the run ends at no earlier than `max(forecastThrough, termsThrough)`. The baseline is not cut. Task A.6 researches Dartmouth's winter and spring 2028 terms so Hanover's model outlook is not cut at 2027-11-24. `[CONFIRM: the trained model's outlook stops at the town's last researched term day; the baseline's does not]`

Events have the same blind spot on single days for both engines; decision 6's hindsight test measures it and the model card says so (decision 12).

Alternatives: no cap (a silent, systematic miss); an `unknown` term state (the model has never seen one); capping both engines.

### 9. Lab input version 3, one step, a paused schedule

Version 3 changes `horizonDays` to 400 and adds `termsThrough`. The lab accepts version 3 only and the API sends it only, built from one commit; `LAB_MODEL_VERSION` and `MODEL_VERSION` become `v9`, so every location refits once and gets its outlook the next Monday. The longer input also changes the weekly fingerprint (`dataSha256`) whenever an event 6 to 12 months out is researched or edited, which refits that town's locations the next Monday: expected, and bounded by the weekly caps.

The lab is live and the deploy updates the API, worker and lab images one after another, so release B pauses the weekly schedule from the console (P21), waits until no calibration is live, deploys, checks the three digests, and resumes (task B.12). A person's calibration in that window can fail and is retried by staff.

Alternatives: the lab accepting versions 2 and 3 for a release (dual paths for a window the pause closes).

### 10. The gate checks the outlook for sanity only

The gate (`gate.ts`) is unchanged. `checkLabResult` (`api/src/lab/result.ts`) refuses a result (the calibration fails, and a scheduled one alerts through `townwise-forecasts-failed`) when:

- the run's last day is after `min(madeAt + 365, dataThrough + 400)` (`outlook_too_far`);
- `widening`'s `fromLead` does not strictly increase, a ratio is under 1 or decreases, or its outlook anchors differ from `horizonOutlook`'s ratios (`widening_out_of_order`);
- a model run ends after `max(forecastThrough, termsThrough)` with the calibration's `termsThrough` set (`outlook_past_terms`; `checkLabResult` takes `termsThrough`).

The growth floor itself is pinned by pytest (decision 5's tests), not recomputed in the API. `[CONFIRM: the gate judges nothing about the outlook but these sanity checks]`

Alternatives: a new gate reason that holds the draft (it is a lab bug, not a judgment); an API copy of the floor (two implementations of one rule; cut by review).

### 11. Reads: unchanged limits, metadata-chosen rows

Limits stay: 92 days a read, 400 back and ahead; `get_forecast` 92 days. A month in 2027 on the Calendar is the same one read of its grid's 42 days, inside both bounds.

The ranged read would not stay bounded: with year-long weekly runs a 2027 read loads about 52 runs over about a year, roughly 19,000 day rows against about 1,400 today. So the reader chooses each date's run from run metadata first: a run whose `dayCount` equals its range's length (every lab run) supplies every date of its range, and the chosen run is the newest published one whose `dataThrough` is before the date and whose range covers it, exactly as `chooseDays` picks from rows. A run with gaps (an imported file may skip days) is chosen by rows over the window as today. Then the reader reads rows of only the chosen runs: over the window and a week either side, and each chosen run's supplied past days for its live accuracy. Answers do not change, pinned with a store spy (task A.3).

Alternatives: keeping `windowRows`; a row cap (changes answers); caching (the reader stores nothing).

### 12. Words

Owner decisions, 2026-11-17: an outlook cell shows its middle figure marked as an outlook, with the range in the day panel; the wording below as drafted. `[CONFIRM: the outlook's words on the Calendar, Home, TownwiseAI's visuals and the model card, and no "8 in 10" claim for an outlook day]`

- **Calendar month cell** (P28): the status line under the number reads "Outlook" (mono uppercase, `text3`, as "Booked"), with the middle figure; its label "Outlook about {212} guests, {150} to {290}."
- **Week view column**: the status word "Outlook" and the range line as today.
- **Tooltip**: "Outlook: about {212} guests ({150} to {290})".
- **Day panel**: the section headed "Outlook"; "About **{212}** guests", then "Likely {150} to {290}. Days more than 3 months away are less certain, so this range is wider." in place of the 8 in 10 sentence, which claims a calibration no location's outlook has had measured live.
- **Calendar key line**, when shown days include an outlook day: "Days more than 3 months after Townwise's last refresh show its outlook: a wider range that firms up as the weeks pass and your new sales come in."
- **Home**: This month's cells, labels and tooltip as the Calendar's; the day detail's row headed "Outlook" with "About {212} guests, likely {150} to {290}."; This week's Forecast cell "Outlook: about {90} guests, {67} to {113}" (only a stale run gives one).
- **TownwiseAI's visuals**: `api/src/chat/tools/visual.ts` carries `outlook` on a daily visual's days; `client/src/chat/visuals/words.ts` counts the 8 in 10 sentence's days without outlook days and adds "Days marked outlook have a wider range." when any is; `hover.ts` says "Outlook about 180, likely 117 to 256" for one. A daily visual reaches 31 days past today, so only a stale run shows one.
- **`get_forecast`**: days and weeks carry `outlook`; the description adds "A day or week with outlook true was forecast more than 91 days ahead: call it Townwise's outlook, give its range, and don't say 8 in 10 for it." (frozen-prefix change).
- **Model card**: the API's estimates line (`api/src/estimates/about.ts`) adds "Up to a year ahead: the first 3 months are the forecast, and the rest an outlook with a wider range.", a limit "Days more than 3 months ahead don't yet know events the town hasn't announced.", `MODEL_CARD_VERSION` bumped; the client's live line (`client/src/portal/estimates/ModelCard.tsx:60`, "Each day and week is a range that about 8 in 10 days should land inside.") becomes "Each day and week of the first 3 months is a range that about 8 in 10 days should land inside; the outlook's ranges are wider on purpose."
- **Public copy**: the homepage's and the privacy page's "up to three months ahead" (`client/src/marketing/Home.web.tsx:52`, `client/app/(marketing)/privacy.tsx:215`) become "up to a year ahead, the first three months as a forecast and the rest as a wider outlook", the privacy page's Last updated date bumped, for the owner's approval before push.

The model card's, ModelCard.tsx's and the public words ship in release B, since they would be false before it; every other word ships in release A and shows only on a run with outlook days.

Alternatives: only the range on outlook cells (reads as "no forecast" on a grid of figures); keeping 8 in 10 for the outlook.

### 13. Storage and payload

Each run adds about 365 day rows and 52 week rows to `tw_forecasts` (6.21) instead of about 93 and 13: about 21,700 rows a location a year instead of about 5,500. No new index. The lab result grows from about 50 KB to an estimated 130 KB, and the input by 218 future days; task B.7 measures both and raises `LAB_RESULT_LIMIT` to 512 KB only if a measured result passes 192 KB.

### 14. Runtime

The model already predicts every lead its history spans; the baseline adds 2 horizon weeks per cutoff; the run file grows to up to 400 days. Task B.7 times `calibrate` as D42 did; release B goes ahead only under 600 seconds.

### 15. Two releases

**Release A** ships the readers and judges of year-long runs while every run is still 91 days, so it is inert: `tiers.ts`, "current" by the forecast tier, the jump cut, outlook days out of accuracy, the metadata-first reader with `outlook`, `get_forecast`'s and the visuals' outlook marking, the result's new sanity checks and optional `horizonOutlook` with up to 8 widening entries, the client's words, Dartmouth's 2028 terms, and the docs (release B's parts written as not yet built). With no outlook day anywhere, every answer is today's.

**Release B** makes runs a year long: the coverage check, the lab, input version 3 with `termsThrough`, `horizonOutlook` required, the model card's and the public words, under a paused schedule.

Rollback of B is reverting B. Year-long runs it published stay readable and correctly labeled and judged by release A's code, and the next refit publishes a 91-day run.

Alternatives: one release (a rollback would need staff to withdraw year-long runs that the old reader shows unlabeled; the earlier draft's plan).

## Risks / Trade-offs

- [Outlook ranges are wide on short histories] → What the backtests and the growth floor support; the label and key line say so; they narrow as year-ahead backtest weeks accumulate.
- [The baseline's 365-day band rests on one year-over-year change] → Stated in the spec text; the coverage check scores the two-year cut that has exactly this.
- [The coverage check fails] → Release B does not ship; the numbers go to the lead (decision 6).
- [Hanover's 2028 terms are missing] → The model's outlook stops at the last researched term until task A.6 adds them; the baseline is unaffected.
- [Calibrations fail during release B] → The paused schedule.
- [Reads slow down] → Metadata-chosen rows, pinned with 52 year-long runs.
- [CONFIRM numbers or D52 collide with another branch] → Renumber at each release's start and before each push.

## Migration Plan

No migration of existing rows. `outlook`, `tierEnd` and `forecastThrough` are derived; `horizonOutlook` and `tw_calibrations.termsThrough` are optional and absent on older records; existing 91-day runs have no outlook days and stay current exactly as before. Release A first, then release B with the schedule paused; rollback of B is reverting B (decision 15).

## Open Questions

None blocking. The owner decided the cap, the 26-week bar, the term cap, the cell display, the weekly suggestions' 91 days and the words on 2026-11-17; each is a `[CONFIRM]` for the team's sign-off.

## Build notes (release A, 2026-11-17)

Where the code differs from the decisions above, or a decision needed a reading. None changes a decision or days 1 to 91.

- **Decision 4 (b), tests.** `api/test/lab-gate.test.ts`'s existing fixtures were partial casts without `madeAt` (and `streakOf`'s without `dataThrough`), which `forecastThrough` reads; each gains dates whose forecast tier reaches its `range.to`, assertions unchanged. That file's weekly fixture's "91-day" runs end at today plus 90, one day short of a D42 run (today plus 91), so the year-long streak case is compared with runs ending at today plus 91 as well as with the default.
- **Decision 11, metadata choice.** A run is chosen by metadata when `dayCount` equals its range's length (a run file never repeats a date). Runs with gaps have their rows read over D42's span (windowRows) and are chosen from them, so a gapped import is chosen exactly as before. `latest` reads only the newest run's rows. Two unit fixtures in `api/test/chat-estimate-tools.test.ts` gave runs a `range` that did not match their rows; they now match.
- **Decision 12, TownwiseAI's visuals.** A daily visual's day carries `outlook: true` only on an outlook day (as `status` is set only on a closed or booked day), so stored and new visuals without one are unchanged. When every banded day of a visual is an outlook day, the summary drops the 8 in 10 sentence ("The shaded band is {model}'s range, made {date}, plus guests from your notes on days that have them.") rather than say "for 0 days".
- **Decision 12, Calendar cells.** An outlook cell has status `outlook` and keeps its figure: from 641px its word sits in the cell's top row over the figure, as a booked day's does; below 641px, where no cell shows a top-row word, the figure shows alone and the cell's label says "Outlook". A booked or closed outlook day reads as booked or closed. The day panel's heading comes from `forecastLabel` (model.ts), so `forecastWords`' shape is unchanged.
- **Decision 10.** The cap of 400 days after the data is already the run file's own limit (`too_far_ahead`, `too_big` in `forecasts/file.ts`), so `outlook_too_far` can only fire on `madeAt` plus 365; both terms are kept as decided.
- **Decision 8, task A.6.** Hanover's winter and spring 2028 terms (registrar's 2027-28 key dates, read 2026-11-17) move `townCalendarCovers('hanover-nh')` to 2028-06-06, so the tests pinning Hanover's coverage (`calendar.int`, `estimates.int`, `chat-estimate-tools`) and term count (`people-term`) follow; the days from 2027-11-25 to 2028-01-03 now read `between_terms` instead of `unknown`.
