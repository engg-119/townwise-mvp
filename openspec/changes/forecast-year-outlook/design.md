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

Owner decision, 2026-11-17: a run reaches the calibration's `today` plus 365 days, capped at `dataThrough` plus 400 (the run file's existing limit, so no file limit changes). The 35 days of slack mean a location whose sales lag by up to 35 days still sees a full year; past that, the year shortens by the excess. The input's future days become 400 (`horizonDays: 400`).

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
- **Fewer than 8 backtest weeks** at H: r_H = g_H (`basis: 'growth'`). **8 to 25**: r_H = max(g_H, b_H) (`'growth_or_backtest'`). **26 or more**: r_H = max(r_prev, b_H) (`'backtest'`). (owner decision, 2026-11-17).

By lead L from `dataThrough`, past the forecast tier: up to 182, r_182; from 182 to 365, interpolated on the square root of lead between r_182 and r_365 (equal to r_182 × sqrt(L / 182) when r_365 is the pure growth); from 365 to 400, r_365 × sqrt(L / 365). Daily ranges widen by `widen_k` times the day's ratio on both sides, in `forecast.run_file` and `baseline.run_file`; an outlook week (any day in the outlook) widens by the largest ratio among its days in `forecast.assemble`. The run's `widening` carries the forecast tier's entries unchanged and two outlook anchors (`{ fromLead, ratio, horizon }` for 182 and 365), equal to `horizonOutlook`'s ratios.

Why this is honest, and where it leans on assumptions:

- **Never narrower with lead**: every ratio is at least the previous one.
- **Square root of lead** is the spread of a random walk, the usual model for a level drifting with no trend; a level that returns toward its season grows slower. A steady trend grows faster, which the coverage check (decision 6) puts inside the scored year. From 91 days it gives 1.41 at 182 and 2.0 at 365 in log terms.
- **Under 26 weeks the backtest can only widen.** Bands from 8 to 25 weeks under-cover (the model's `quantile_band` holds about 62% of weeks at 8, `baseline.weekly_band`'s docstring), and long-lead backtests read the town calendar as researched afterwards, which decision 6's hindsight test measures.
- **26 weeks counts weeks, not independent years.** The weeks at a long lead come from few origins, so they are far from independent. On Sawtooth's 658 days: the model has about 15 weeks at 182 and none at 365 (its quarterly origins start a year in), so its 182 band is the larger of growth and backtest, and its 365 the growth. The baseline has about 64 weeks at 182 and about 37 at 365, so both pass the bar. But the baseline's 365-day weeks are all forecast from cutoffs in its first year, where its shape is 1 and its forecast is the weekday level of the weeks just before the cutoff; a week 365 days later falls in the same season, so each is in effect a seasonal-naive forecast and its error is one year-over-year change of this restaurant, observed once. That is a fair sample of how a year-ahead figure misses only as far as the next year changes like the last one did. The bar is kept as the owner decided; the coverage check scores exactly this case (a two-year cut), and the spec text says the band rests on one year-over-year change until a location has three years.
- **Where the history allows, the backtest decides**, so precision improves as data grows.

Alternatives: three horizons (182, 273, 365; cut by review: a third horizon adds a backtest and a ratio that the sqrt interpolation already gives within the check's precision); linear growth (4 times the 91-day band at a year); the measured band alone from 8 weeks; a symmetric width ratio (a skewed band would narrow on its wider side).

**Amended in release B's build (2026-11-19); the owner chose on 2026-11-19 to ship it as built (“Ship #118 as built”).** The rule above failed decision 6's check on 2026-11-18 (build notes, release B, 2026-11-18). As built in release B (`pipeline._outlook_band`, `_outlook_errors` and `outlook_ratios`; `forecast.assemble`):

- **One size on both sides.** An outlook week's range is the same on both sides: the 28-day weekly range's wider side, max(-lo_28, hi_28), times the largest ratio among its days. A forecast-tier week is unchanged, and so are daily ranges.
- **The band.** m is a size of the engine's own weekly misses at H, |log(actual / forecast)|, over the backtest weeks forecast the way the run is (for the baseline, the weeks forecast with last year's shape, `metrics.same_kind`'s later kind; for the model, every week). Weeks at a lead of H share most of their H days, so n of them count as n × 7 / H independent windows (n_eff). From 9 windows (`CONFORMAL_MIN`), m is the split conformal 80% rank on n_eff, ceil(0.8 (n_eff + 1)) of them; from 1 to 9, the largest miss; under 1, the larger of the own weeks' largest miss and the conformal 80% rank of every backtest week at H, of either kind, from 8 weeks; with fewer than 8, there is no band. The every-week rank treats correlated weeks as exchangeable, which the n_eff reasoning rejects, so it is only a floor: the band then never widens when the own weeks reach one window and the floor drops away, unless a new week is a new largest miss (amended on review, 2026-11-19; the rank alone made the band jump to the largest miss after one weekly refit, build notes).
- **The ratio.** r_H = max(g_H, m / max(-lo_28, hi_28)): the backtest only ever widens the growth floor, at any count of weeks (`basis: 'growth_or_backtest'`, or `'growth'` with no band; `'backtest'` is no longer sent). Every ratio is still at least the one before.

This rule was chosen after the check had been seen (one-sided bands first, then |miss|, then one size on both sides), so decision 6's "set here, before measuring, and not tuned after" does not hold for it. [Decided (owner, 2026-11-19, of PR #118: “Ship #118 as built”): the rule as built ships; the R2 fallback (every outlook ratio at least sqrt(lead / 28), no backtest read; build notes, 2026-11-19) and holding release B were the alternatives.] The first rule's CONFIRM above (spec index item 96) stays until the team decides; the rule as built is (index item 160). Build notes, 2026-11-19, hold the numbers.

### 6. The coverage check can fail, and failing blocks release B

`modeling/lab/tests/test_outlook_coverage.py` (synthetic only, never `data/`):

- **Histories**: four years each; `test_coverage.py`'s five weekly swings and four seeds, plus histories with a 20% level shift and with a trend that changes slope, both placed inside the scored year; one set with Hanover's calendar as D42's 7.1 did.
- **Cuts**: each history is calibrated as of two years and as of three years; each cut's run is scored on the year after it.
- **Hindsight**: the input given at each cut carries no calendar event that starts more than 182 days after the cut, while the scored days' guests were generated with them, so the check measures an outlook made before the town announced its events.
- **Pass**, per horizon (182 and 365) and per cut, not pooled: mean weekly coverage of the 80% bands at least 80% and no history under 65%; mean daily coverage of the daily ranges at least 75%.
- **It can fail**: a control run of the same check with every outlook ratio forced to the 28-day ratio (no widening) must fail it, which the test asserts, so a check that passes everything is caught. (Made stricter on review, 2026-11-19: the control carries the forecast tier's last ratio flat over the outlook, the naive alternative to the outlook rule rather than a range narrower than the tier's own last days, and must fail at every cut and horizon; build notes, 2026-11-19.)
- The exponent 0.5, the 26 weeks, the horizons and these thresholds are set here, before measuring, and not tuned after. If the check fails, release B does not ship: the work stops and goes back to the lead with the numbers, as D42 decision 14 did for runtime. Release A, which only reads and labels, is unaffected.

**Note, 2026-11-19.** The check (its histories, cuts, hindsight and thresholds) is unchanged and was run unchanged; its control was made stricter on review (above). Decision 5's rule was changed after the check had been measured, which the lead decides on before release B merges (decision 5's amendment and its DECISION NEEDED). Seeds 4 to 19, outside the check, were measured too (build notes, 2026-11-19); they are not part of it and change nothing in it.

### 7. The baseline reads two years back past 357 days of lead

For a date whose 3 weeks around the date less 364 days are not all on or before the cutoff (leads 358 to 400), `baseline.shape` reads the 3 weeks around the date less 728 days over the plain level at the cutoff less 728 days, clamped as before, and 1 without two years of plain history. Leads of 357 or less are unchanged.

Alternatives: shape 1 for the outlook's last weeks (a seasonal cliff); 2 of the 3 weeks (still 1 at 365 and over); ending the outlook at 357 days.

### 8. The model's outlook stops at the town's last researched term

Owner decision, 2026-11-17. The model reads `term` and `week_of_term`, and a day no researched term covers reads `interim`, so a term not yet researched would be forecast as a break. Input version 3 carries `termsThrough` (the last day of the town's last term entry, classes or finals; null for a town with none), and the API records it on the calibration (`tw_calibrations.termsThrough`, optional, absent on older rows). A model run's outlook ends at `termsThrough` when that is earlier; the forecast tier is never cut by it, so the run ends at no earlier than `max(forecastThrough, termsThrough)`. The baseline is not cut. Task A.6 researches Dartmouth's winter and spring 2028 terms so Hanover's model outlook is not cut at 2027-11-24.

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

The growth floor itself is pinned by pytest (decision 5's tests), not recomputed in the API.

Alternatives: a new gate reason that holds the draft (it is a lab bug, not a judgment); an API copy of the floor (two implementations of one rule; cut by review).

### 11. Reads: unchanged limits, metadata-chosen rows

Limits stay: 92 days a read, 400 back and ahead; `get_forecast` 92 days. A month in 2027 on the Calendar is the same one read of its grid's 42 days, inside both bounds.

The ranged read would not stay bounded: with year-long weekly runs a 2027 read loads about 52 runs over about a year, roughly 19,000 day rows against about 1,400 today. So the reader chooses each date's run from run metadata first: a run whose `dayCount` equals its range's length (every lab run) supplies every date of its range, and the chosen run is the newest published one whose `dataThrough` is before the date and whose range covers it, exactly as `chooseDays` picks from rows. A run with gaps (an imported file may skip days) is chosen by rows over the window as today. Then the reader reads rows of only the chosen runs: over the window and a week either side, and each chosen run's supplied past days for its live accuracy. Answers do not change, pinned with a store spy (task A.3).

Alternatives: keeping `windowRows`; a row cap (changes answers); caching (the reader stores nothing).

### 12. Words

Owner decisions, 2026-11-17: an outlook cell shows its middle figure marked as an outlook, with the range in the day panel; the wording below as drafted. The owner approved the outlook's words and no "8 in 10" claim for an outlook day on 2026-11-19, with a comma added in the privacy page's Forecasts paragraph.

- **Calendar month cell** (P28): the status line under the number reads "Outlook" (mono uppercase, `text3`, as "Booked"), with the middle figure; its label "Outlook about {212} guests, {150} to {290}."
- **Week view column**: the status word "Outlook" and the range line as today.
- **Tooltip**: "Outlook: about {212} guests ({150} to {290})".
- **Day panel**: the section headed "Outlook"; "About **{212}** guests", then "Likely {150} to {290}. This day is more than 3 months after this forecast was made, or 6 months after the sales it learned from, so its range is wider." in place of the 8 in 10 sentence, which claims a calibration no location's outlook has had measured live.
- **Calendar key line**, when shown days include an outlook day: "Days more than 3 months after Townwise's forecast was made, or 6 months after the sales it learned from, show its outlook: a wider range that firms up as the weeks pass and your new sales come in."
- **Home**: This month's cells, labels and tooltip as the Calendar's; the day detail's row headed "Outlook" with "About {212} guests, likely {150} to {290}."; This week's Forecast cell "Outlook: about {90} guests, {67} to {113}" (only a stale run gives one).
- **TownwiseAI's visuals**: `api/src/chat/tools/visual.ts` carries `outlook` on a daily visual's days; `client/src/chat/visuals/words.ts` counts the 8 in 10 sentence's days without outlook days and adds "Days marked outlook have a wider range." when any is; `hover.ts` says "Outlook about 180, likely 117 to 256" for one. A daily visual reaches 31 days past today, so only a stale run shows one.
- **`get_forecast`**: days and weeks carry `outlook`; the description adds "A day or week with outlook true is more than 91 days after its run was made, or more than 182 days after the last sales the run learned from: call it Townwise's outlook, give its range, and don't say 8 in 10 for it." (frozen-prefix change).
- **Model card**: the API's estimates line (`api/src/estimates/about.ts`) becomes "Guests per day and per week, each as a range, never one exact number. Up to a year ahead: the first 3 months are the forecast, whose ranges about 8 in 10 days should land inside, and the rest an outlook with wider ranges." (the 8 in 10 claim moved onto the forecast's months, since the outlook's ranges are not calibrated to it), a limit "Days more than 3 months ahead don't yet know events the town hasn't announced.", `MODEL_CARD_VERSION` bumped; the client's live line (`client/src/portal/estimates/ModelCard.tsx:60`, "Each day and week is a range that about 8 in 10 days should land inside.") becomes "Each day and week of the first 3 months is a range that about 8 in 10 days should land inside; the outlook's ranges are wider on purpose."
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

None blocking. The owner decided the cap, the 26-week bar, the term cap, the cell display, the weekly suggestions' 91 days and the words on 2026-11-17; each was a `[CONFIRM]` for the team's sign-off, and the owner decided them on 2026-11-19 (spec 22.2 items 95 to 102).

## Build notes (release A, 2026-11-17)

Where the code differs from the decisions above, or a decision needed a reading. None changes a decision or days 1 to 91.

- **Decision 4 (b), tests.** `api/test/lab-gate.test.ts`'s existing fixtures were partial casts without `madeAt` (and `streakOf`'s without `dataThrough`), which `forecastThrough` reads; each gains dates whose forecast tier reaches its `range.to`, assertions unchanged. That file's weekly fixture's "91-day" runs end at today plus 90, one day short of a D42 run (today plus 91), so the year-long streak case is compared with runs ending at today plus 91 as well as with the default.
- **Decision 11, metadata choice.** A run is chosen by metadata when `dayCount` equals its range's length (a run file never repeats a date). Runs with gaps have their rows read over D42's span (windowRows) and are chosen from them, so a gapped import is chosen exactly as before. `latest` reads only the newest run's rows. Two unit fixtures in `api/test/chat-estimate-tools.test.ts` gave runs a `range` that did not match their rows; they now match.
- **Decision 12, TownwiseAI's visuals.** A daily visual's day carries `outlook: true` only on an outlook day (as `status` is set only on a closed or booked day), so stored and new visuals without one are unchanged. When every banded day of a visual is an outlook day, the summary drops the 8 in 10 sentence ("The shaded band is {model}'s range, made {date}, plus guests from your notes on days that have them.") rather than say "for 0 days".
- **Decision 12, Calendar cells.** An outlook cell has status `outlook` and keeps its figure: from 641px its word sits in the cell's top row over the figure, as a booked day's does; below 641px, where no cell shows a top-row word, the figure shows alone and the cell's label says "Outlook". A booked or closed outlook day reads as booked or closed. The day panel's heading comes from `forecastLabel` (model.ts), so `forecastWords`' shape is unchanged.
- **Decision 10.** The cap of 400 days after the data is already the run file's own limit (`too_far_ahead`, `too_big` in `forecasts/file.ts`), so `outlook_too_far` can only fire on `madeAt` plus 365; both terms are kept as decided.
- **Decision 8, task A.6.** Hanover's winter and spring 2028 terms (registrar's 2027-28 key dates, read 2026-11-17) move `townCalendarCovers('hanover-nh')` to 2028-06-06, so the tests pinning Hanover's coverage (`calendar.int`, `estimates.int`, `chat-estimate-tools`) and term count (`people-term`) follow; the days from 2027-11-25 to 2028-01-03 now read `between_terms` instead of `unknown`.
- **Review fixes (2026-11-17).** An independent review of release A came back ready with nits, fixed the same day:
  - The D42 reader test (52 runs of 91 days) now also compares each read, a read around its 2026-04-18 closure note (scored false, likely-closed scoring included) and the model card's read with `everyRowReader`, hoisted to the file's top, which chooses every date from every row, so metadata choice is checked against row choice for 91-day runs too.
  - `choiceOf` sorts the deduplicated rows by `from`, then `span`, as the store does, so weeks read from several reads (a gapped run's, then a gap-free run's) come in date order; pinned by `weeks from a gapped import and a gap-free run come in date order` in `api/test/estimates.int.test.ts`, seen to fail before the sort.
  - The outlook's words now say what an outlook day is measured from, the run, not today: `get_forecast`'s sentence reads "A day or week with outlook true is more than 91 days after its run was made, or more than 182 days after the last sales the run learned from: call it Townwise's outlook, give its range, and don't say 8 in 10 for it." (still one frozen-prefix change, since release A has not shipped); the Calendar's key line "Days more than 3 months after Townwise’s forecast was made, or 6 months after the sales it learned from, show its outlook: a wider range that firms up as the weeks pass and your new sales come in."; the day panel's sentence "This day is more than 3 months after this forecast was made, or 6 months after the sales it learned from, so its range is wider." Decision 12 above, the display and reads deltas, the spec (P28) and `tuning-chat.md` carry the new words. They replace the owner's drafted words, so they go to the owner with the other words before release B's push (task B.9).
  - Dartmouth's Commencement 2028 (2028-06-11, the registrar's 2027-28 key dates, checked again on 2026-11-17) joins the 2028 terms, as earlier years' do, so Hanover's `covers` ends 2028-06-11; the lab-input golden did not change.

## Build notes (release B, 2026-11-18): stopped at the coverage check

Release B stopped at task B.6, as decision 6 says it must: the honest rule fails the coverage check. Nothing of release B is committed; the work is in the `feat/forecast-year-outlook-b` worktree, uncommitted, for the lead. Days 1 to 91 are unchanged (`test_forecast_tier_unchanged` passes against `tests/golden/result-v2.json`).

- **Decision 6, as built** (`modeling/lab/tests/test_outlook_coverage.py`, values set before measuring and not changed after): 32 four-year histories from 2024-06-12 (`fixture.four_year_input`: the five swings of `test_coverage.py`; a 20% level shift, up for even seeds and down for odd, and a 15%-a-year trend that reverses, both from 183 days after the cut; Hanover's days and calendar with term lifts and 40% on event days), seeds 0 to 3, each cut at 730 and 1095 days of history. Horizon 182 is the outlook's days with a lead of at most 182, horizon 365 the rest; a week counts at its last day's horizon. Hanover's inputs drop every town event (kind `event`) starting more than 182 days after the cut; terms and federal holidays stay (read as the design's intent: an outlook made before the town announced its events). Hanover's days come from the API (`api/test/lab-input.test.ts` writes `tests/golden/hanover-calendar.json`, regenerated with `TOWNWISE_UPDATE_LAB_GOLDEN=1`), a file the design did not name. The control reruns each calibration's `run_file` with `forecast.outlook_ratio` answering 1, so it costs no second backtest.
- **Measured, 2026-11-18** (macOS arm64, 269 seconds; every run but one the baseline's):

  | cut | horizon | weekly mean | lowest history | daily mean | verdict |
  |---|---|---|---|---|---|
  | 2 years | 182 | 97.4% | 84.6% | 98.8% | pass |
  | 2 years | 365 | 95.3% | 42.3% | 98.6% | fail (lowest) |
  | 3 years | 182 | 86.8% | 23.1% | 86.9% | fail (lowest) |
  | 3 years | 365 | 85.4% | 22.2% | 88.7% | fail (lowest) |
  | control, 2 years | 182 / 365 | 83.4% / 73.8% | 7.7% / 0.0% | 78.0% / 72.8% | fail / fail |
  | control, 3 years | 182 / 365 | 78.8% / 71.2% | 0.0% / 18.5% | 80.4% / 76.2% | fail / fail |

  Every mean passes; every failure is the 65% floor for one history. Histories under 65%: level shift seeds 0, 1 and 3 at 3 years (16, 6 and 16 of 27 weeks at 365) and seed 2 at 2 years (16 of 26); drifting seed 2 at 3 years (3 of 13 at 182, 15 of 27 at 365) and seed 3 at 2 years (11 of 26 at 365); closed Mondays seed 2 at 3 years (8 of 13 at 182). The control fails all four, so the check can fail.
- **Why, as far as measured.** At three years every baseline has 26 or more backtest weeks at both horizons (125 at 182 and 99 at 365), so `basis: 'backtest'` sets the ratio, and its ratios sit near the forecast tier's: 1.01 and 1.09 on steady seed 0, 1.13 and 1.17 on level-shift seed 1, against 1.41 and 2.0 times the tier's ratio from the growth floor. The baseline's year-ahead backtest errors on these histories are about as small as its 28-day ones, so the bands hold the ordinary years and miss a shift or a drift the history never showed. At two years the ratios are wide (1.79 on steady seed 0, from first-year weeks forecast with no shape), and coverage is 95% to 97%. Changing the 26 weeks, the exponent or the floor is a decision for the lead, not this build.
- **Built and passing their own tests, uncommitted**: B.2 (`forecast.forecast_end`, `run_end` with D42's stops and the term cap, `FORECAST_DAYS` and `FORECAST_CAP_DAYS`, the outlook week's widest day; `api/test/lab-contract.test.ts` follows the rename), B.3 (`pipeline.outlook_ratios`, `_backtest_ratio`, `forecast.outlook_ratio` and `Outlook`, `horizonOutlook`, the widening anchors: r_182 from the first outlook lead, r_365 from lead 365, the leads where each is the least ratio that holds on), B.4 (`baseline.shape` two years back), the lab side of B.5 (`townwise.lab-input/3`, `termsThrough`, `MODEL_VERSION` `v9`). Not done: B.5's `test_contract.py` needs the API's `api-input.json` at version 3 (B.8); B.7 (goldens, sizes, timing) and B.8 to B.12.
- **Fixture changes**: `FUTURE_DAYS` is 400 (`CHAMPION_DAYS` keeps the champion at 182); `two_year_input` draws its guests over the same 182 future days as before and pads to 400 with no guests, so `test_coverage.py`'s histories are D42's; the fixture's copy of the notebook's holiday rule reads a day past the frame's end, as the lab does, since the 400-day frame ends on Thanksgiving Eve.
- **A stricter variant, measured 2026-11-18 at the lead's request** (the check unchanged): the growth floor always applies and the backtest only widens it, at any count of weeks (`outlook_ratios` in the working tree carries this variant, marked; the tests that pin the 26-week rule, `test_outlook_backtest_decides_from_26_weeks` and `check_outlook`'s basis, follow the designed rule and fail against it). Weekly mean, lowest history, daily mean: 2 years at 182 97.4%, 84.6%, 98.8% (pass); 2 years at 365 97.4%, 73.1%, 99.3% (pass); 3 years at 182 95.0%, 30.8%, 93.4% (fail); 3 years at 365 95.1%, 74.1%, 95.8% (pass). The one history under 65% is drifting seed 2 at 3 years, 4 of 13 weeks at 182 (3 of 13 under the designed rule). The control is unchanged and fails all four pairs. Release B stays stopped.

## Build notes (release B, 2026-11-19): the range rule as built, and its numbers

Built on `feat/forecast-year-outlook-b2`, from develop at e53aaa53 with release B's parked work (a723bd0d) carried over. develop's lab had moved on: its `v9` is the closed-weekday fix of 2026-11-18, so release B's lab is model **`v10`** (`version.py`, `LAB_MODEL_VERSION`, `api/test/lab-contract.test.ts`). The conflict was that one line. Days 1 to 91 are unchanged: `test_forecast_tier_unchanged` passes against `tests/golden/result-v2.json`, which is now develop's own golden result at e53aaa53, the commit before year-long runs on this branch (it differed from the 14ed2487 file only in its model version).

- **The rule** is decision 5's amendment: the growth floor always, widened by a band of the engine's own weekly misses read the same on both sides, and outlook weeks the same on both sides. Measured on the parked branch as a prototype on 2026-11-19 (the empirical approach of three put to the lead) and ported here with these changes: the conformal rank is computed in whole numbers (the prototype's `np.quantile` level could move a rank by one at 182 days, where H / 7 is a whole 26); the prototype's `_source` (which branch read the band) is dropped, since the API's outlook report is a strict object whose `basis` enum is `growth`, `growth_or_backtest` or `backtest` and has no field for it; `BACKTEST_ALONE_WEEKS` and `_backtest_ratio` are deleted, as nothing reads them.
- **Why the same size on both sides.** All three approaches put to the lead agree here: the asymmetric 28-day band is a real defect that a scalar ratio cannot fix. The 28-day weekly range always holds zero, so a range whose misses ran one way has a side near or at 0, and widening it by any ratio carries that one-sidedness a year out, where a level can drift either way. An outlook week therefore takes the wider side on both sides, whichever rule the lead chooses. `test_an_outlook_week_is_the_same_both_sides_when_a_28_day_side_is_0` pins it.
- **Why independent windows (n_eff).** The backtest forecasts each week from the Sunday cutoff at least H days before it, so two weeks a week apart share H - 7 of their H days of drift: at 182 days, 26 consecutive weeks hold about one independent draw of how the level moves in half a year, not 26. Reading them as n × 7 / H windows sizes the band by what the history can show: a conformal rank needs about 9 windows (as `baseline.weekly_band`'s ranks need 9 weeks), which at 182 days is 234 weeks of cutoffs (four and a half years), so on today's histories the band is the largest miss (from 26 weeks at 182, 53 at 365) or, with fewer, that largest miss over a floor of every week's conformal rank (amended on review, below). The same reasoning explains the check's one held-out failure (below): its 65% floor per history scores about one drift draw per history, since 13 or 27 outlook weeks of one history are strongly autocorrelated, so an occasional history outside it is expected under any honest rule and is not a regression.
- **The growth floor stays.** A level shift inside the scored year has never been seen in its own backtest, so the walk and backtest estimates give level-shift histories about 0 extra width: only the floor covers them. The rule never lets the backtest narrow under it, and must not in any later change. Across the 20 seeds below the floor set every 365-day ratio and 48 of the 320 182-day ones.
- **Amended on review, 2026-11-19: under one window.** As first built, under 1 window m was every week's conformal 80% rank alone: an 80% rank on correlated weeks, the statistic the n_eff reasoning rejects, and non-monotone in evidence. A baseline at 182 days with 25 own weeks took the rank of every week, and one weekly refit later, with 26 (one window), the largest own miss, so an outlook could widen after a single refit with no new evidence. Three fixes were measured on seeds 0 to 19 (320 calibrations each, the check's thresholds; weekly mean, lowest history, daily mean): **every week's largest miss** passes where the first build did (the same one held-out failure) but widens two-year outlooks to a median log(high / low) of 1.27 at 182 days and 1.54 at 365 (all outlook weeks 1.17, wider than R2's 0.98, and 2 in 5 Hanover outlook weeks more than 4 times as high as low), since for the baseline every week includes the weeks forecast without last year's shape; **the own weeks' largest miss alone** (no every-week read) is narrower (0.68 overall) but fails held-out histories at two years (drifting seed 10 at 182 days, 0 of 13 weeks; drifting seed 4 and level-shift seed 17 at 365); **the own weeks' largest miss over a floor of every week's rank**, built, is never narrower than the first build, so it keeps its coverage, and is monotone at one window: the floor drops away there, and the band widens only when a new week is a new largest miss. Its numbers are below (they differ from the first build's only at two years, and in 17 of the 160 three-year 365-day ratios). `test_outlook_band_never_widens_as_the_runs_own_weeks_reach_one_window` pins it. The floor still reads correlated weeks as exchangeable; it can only widen the own weeks' largest miss, never narrow it, which is why it was kept rather than dropped.
- **Daily ranges** are unchanged (each side as backtested, widened by `widen_k` times the day's ratio). Daily coverage passes everywhere (96.8% to 99.6% means), and no screen shows a week row's range beside its days' ranges: the Calendar and Home show days, Home's This week reads the run's 28-day `weeklyRangePct`, and only TownwiseAI's `get_forecast` returns both, as it always has for two independently drawn ranges.

**The coverage check** (`tests/test_outlook_coverage.py`, seeds 0 to 3, 64 calibrations, 206 seconds; weekly mean, lowest history, daily mean): 3 passed, and the control fails all four pairs. Its histories, cuts, hindsight and thresholds are unchanged. Its control was made stricter on review (2026-11-19): it had forced every outlook ratio to 1, narrower than the forecast tier's own last days (whose 91-day or reach ratio is at least 1, often 1.3 to 1.5), so it failed against a strawman; it now carries the tier's last ratio flat over the outlook, the obvious naive outlook, and the test asserts that it fails at every cut and horizon (it had asserted at least one). It fails all four pairs at seeds 0 to 3 and at every seed group below, but mostly on the per-history floor: its weekly means pass 80% in three of the four pairs, and at two years and 182 days it fails by one history (8 of 13 weeks). So the outlook rule's margin over the naive outlook is the histories that drift, not the average one.

| cut | horizon | rule as built | control (the tier's last ratio held flat) |
|---|---|---|---|
| 2 years | 182 | 100.0%, 100.0%, 98.9%: pass | 90.1%, 61.5%, 81.3%: fail |
| 2 years | 365 | 99.0%, 80.8%, 98.4%: pass | 83.2%, 7.7%, 77.1%: fail |
| 3 years | 182 | 99.3%, 84.6%, 96.8%: pass | 89.7%, 0.0%, 83.7%: fail |
| 3 years | 365 | 99.0%, 77.8%, 98.1%: pass | 77.8%, 18.5%, 80.0%: fail |

**Held-out seeds** (copies of the check that change only its `SEEDS` line, outside the repository; 128 calibrations each):

| seeds | cut | horizon | rule as built | control |
|---|---|---|---|---|
| 4 to 11 | 2 years | 182 | 99.4%, 76.9%, 99.6%: pass | 91.8%, 0.0%, 83.7%: fail |
| 4 to 11 | 2 years | 365 | 99.9%, 96.2%, 99.1%: pass | 79.9%, 3.8%, 79.4%: fail |
| 4 to 11 | 3 years | 182 | 99.8%, 92.3%, 97.9%: pass | 88.1%, 30.8%, 81.9%: fail |
| 4 to 11 | 3 years | 365 | 97.9%, 74.1%, 97.7%: pass | 74.0%, 7.4%, 76.7%: fail |
| 12 to 19 | 2 years | 182 | 99.8%, 92.3%, 99.0%: pass | 91.6%, 61.5%, 83.8%: fail |
| 12 to 19 | 2 years | 365 | 99.6%, 76.9%, 98.3%: pass | 81.7%, 15.4%, 77.9%: fail |
| 12 to 19 | 3 years | 182 | 98.7%, 92.3%, 96.9%: pass | 87.4%, 30.8%, 85.2%: fail |
| 12 to 19 | 3 years | 365 | 97.9%, **37.0%**, 97.1%: **fail** | 80.5%, 3.7%, 79.5%: fail |

The one failure is `level_shift` seed 13 at three years and 365 days: 10 of 27 weeks inside. Its history is calm (a 91-day ratio of 1.0, a 28-day weekly range of about ±0.14), its 182-day band the largest of 73 misses (r_182 1.52) and its 365-day ratio the floor (2.15), so its year-ahead weeks hold about ±0.30 in log terms, against a 20% fall (-0.22) from 183 days after the cut on top of its weekly swings. It is the only history under 65% in 640 history, cut and horizon pairs (20 seeds of 8 shapes, 2 cuts, 2 horizons), and the pass and fail of seeds 4 to 19 are the same as the prototype's on the parked branch. Seeds 4 to 19 are not part of the check and do not change it. (Both tables re-measured 2026-11-19 with the amended under-one-window band and the stricter control.)

**Widths** (outlook weeks of the 320 calibrations, seeds 0 to 19; log(high / low) median and 90th percentile, and (high - low) / mid median and 90th percentile):

| cut | horizon | log(high / low) | (high - low) / mid |
|---|---|---|---|
| 2 years | 182 | 0.88, 1.08 | 0.90, 1.13 |
| 2 years | 365 | 1.08, 1.34 | 1.13, 1.44 |
| 3 years | 182 | 0.63, 1.13 | 0.64, 1.19 |
| 3 years | 365 | 0.78, 1.37 | 0.80, 1.48 |
| all | | 0.90, 1.28 | |

A forecast-tier week's log(high / low) is a median 0.32 to 0.33. So an outlook week's high is a median 2.5 times its low, and one in ten is more than 3.5 times (seeds 0 to 3 alone: 0.85 and 1.16). The 90th percentile is under the 1.4 (4 times) the lead set for an owner-facing check overall, but not everywhere: on the Hanover-calendar histories it is 1.51 (1.64 at three years and 365 days) and on the drifting ones 1.56, where about one outlook week in five is more than 4 times as high as it is low (22% and 24%; 6% overall). Since Sawtooth is in Hanover, the owner should see this before release B ships: (spec index item 161). Those ranges are wide because they hold: Hanover's histories kept 98% to 100% of their outlook weeks at both horizons and cuts.

**What each ratio was read from** (320 calibrations; the branch of `_outlook_band`, and how often its band was wider than the growth floor):

| cut | horizon | band | wider than the floor |
|---|---|---|---|
| 2 years | 182 | the own weeks' largest miss over every week's conformal rank, 160 (0.8 windows) | 145 of 160 |
| 2 years | 365 | every week's conformal rank, 152 (no own weeks yet); growth alone, 8 (model runs with no 365-day week) | 0 of 160 |
| 3 years | 182 | the largest miss, 160 (2.8 windows) | 128 of 160 |
| 3 years | 365 | the own weeks' largest miss over every week's conformal rank, 160 (0.9 windows) | 17 of 160 |

No history reached 9 windows, so the conformal rank on own weeks never ran here; it is pinned by its unit test.

**In-sample, as a diagnostic only** (not a widening step): the share of each horizon's own backtest weeks the band the run gives that horizon (the wider 28-day side times r_H) would have held: 100% wherever there are own weeks, by construction since the amendment (under 9 windows the band is at least their largest miss; the first build's every-week rank held 99.5% at two years and 182 days, lowest history 71.4%). Of every backtest week at the horizon: 83.2% and 100% at two years, 81.6% and 99.7% at three. The scorecard's `horizonOutlook` keeps `coverage80` as `horizon91`'s is, the past-only band coverage at that lead, so no new scorecard field was added for these shares; they are reported here.

**The largest-miss step needs no ceiling.** One outlier week can set m when n_eff is 1 to 9, so it was measured against the every-week conformal rank: over the 160 horizons that took it, m over that rank is a median 0.93, a 90th percentile 1.37 and at most 2.40 (Hanover seed 16, whose ratio was then 2.00). The widest ratios it set were 3.48 and 3.35, on drifting seeds 18 and 17, which are the histories that need them; the widest outlook ratios overall (5.5 to 6.3) are the growth floor at 365 days on two-year cuts, mostly of calm histories, whose 28-day range is narrow. A ceiling at the every-week rank times a factor would bind only where a history has already shown a large miss, and would be one more number chosen after measuring, so none is set; the lead may add one with the rule's decision.

**The Hanover model run, separately** (the check's own runs are the baseline's but for 10 of 320; seeds 0 to 7, both cuts, the model forced): weekly mean, lowest history and daily mean pass at every cut and horizon (2 years: 95.2%, 92.3%, 96.9% at 182 and 100%, 100%, 99.6% at 365; 3 years: 100%, 100%, 99.9% and 100%, 100%, 100%), and each three-year run stops at Hanover's `termsThrough`, 2028-06-06. Its control, the tier's last ratio held flat, passes too (82.7% to 99.0% weekly means, lowest 76.9%): the model reads the term and week of term, so its own 28-day ranges already hold Hanover's outlook weeks, and the outlook widening adds width it did not need (median outlook-week log(high / low) 1.02 and 1.18 at two years, 1.13 and 1.36 at three, at 182 and 365 days). The model's own weeks are every week, so the amendment does not change these runs (re-measured 2026-11-19).

**The Hanover caveat.** Term boundaries move from year to year, so a baseline forecast a year ahead from last year's shape misses at the start and end of every term, which inflates the long-lead misses the band is read from; Hanover's weekly coverage of 98% to 100% with the widest ranges of any shape says its bands are wider than they need to be. If owners find Hanover's outlook too wide, the fix is calendar-adjusted residuals (misses read after moving last year's term weeks onto this year's dates), not a narrower rule.

**Future work.** A drift-rate prior pooled across locations is the principled way to stop under-widening calm histories that do drift (the level-shift failure above): one location's few windows cannot show its drift rate, but many locations' can.

**The fallback, R2** (from the third approach put to the lead), written down in case the lead rejects a rule tuned after measuring: every outlook ratio at least sqrt(lead / 28), the random-walk spread of the 28-day band, and no backtest read; the growth floor and the outlook weeks' one size on both sides kept. Measured once, on the check's seeds 0 to 3 with the check unchanged (a scratch plugin in place of the built rule; R2 is not built here): it passes (weekly means 99.6% to 100%, lowest history 92.3%, daily means 99.4% to 100%; the control fails as above), but its ranges are wider and do not narrow as history grows: outlook-week log(high / low) a median 0.98 and a 90th percentile 1.36, against the built rule's 0.85 and 1.16 on the same seeds, and at three years medians of 0.89 at 182 days and 1.07 at 365 against 0.60 and 0.74. It would not let the ranges firm up as data grows, which the owner asked for.

**B.5 and B.7.** `tests/golden` regenerated: `input.json` and `result.json` by `tests/make_golden.py` (version 3, a 367-day run), and `api-input.json` by `api/test/lab-input.test.ts` with `TOWNWISE_UPDATE_LAB_GOLDEN=1` (version 3, `horizonDays` 400, `termsThrough` 2028-06-06); `hanover-calendar.json` came out unchanged. `tests/test_parity.py`, `test_contract.py`, `test_job.py` and `test_cli.py` pass on them. Sizes (decision 13): the golden result is 99,671 bytes as compact JSON (110,099 as `json.dumps` writes it), the golden input 162,197 and the API's golden input 157,414, so `LAB_RESULT_LIMIT` stays 256 KB (the bar was 192 KB). Runtime (decision 14), timed as D42's tasks 0.3 and 2.6 were: the lab image built from this branch for `linux/amd64` (under Rosetta on the M4 Max), `docker run --platform linux/amd64 --cpus=1 --memory=2g`, three runs each, the input on standard input to a script that calls `calibrate`. A 700-day synthetic history (`fixture.two_year_input(0, "steady", 700)`, 1,100 input days, a 366-day run): the engine chosen (the baseline) 3.4 to 3.5 seconds inside the container and 7.9 to 11.3 wall clock, the model forced 5.1 to 5.2 and 9.5 to 10.0. The golden input (with its champion, a 367-day run): the baseline 2.6 to 2.9 and 7.0 to 7.8, the model forced 3.8 to 4.0 and 8.2 to 8.4. Peak memory 170 to 192 MB of the 2 GiB, and the largest result 103,738 bytes (the golden input's model run). Far under 600 seconds.

**CONFIRM numbers.** develop's index ends at 142 (D58). This change's new items were written as 143 and 144, provisionally; at merge (2026-11-19), after D60 to D63 (143 to 158) and #113 (159), they became 160 and 161.
