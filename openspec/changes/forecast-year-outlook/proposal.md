## Why

On 2026-11-17 the owner asked: "also let's increase the forecase to one year out and then forecasts can become more precise as we get more data". Today a published run reaches the calibration's today plus 91 days (D42, spec 14.6), so an owner planning a summer, a term or next year's big weekends sees nothing past three months. The owner approved the plan the same day: days 1 to 91 stay the forecast exactly as today; the rest of the year becomes a clearly labeled **outlook** with wider, honest ranges; precision improves as data grows, since the weekly refresh already refits on new data. Later that day the owner decided the open questions: a cap of 400 days after the last day of sales, a 26-week bar for the backtest alone, the model's outlook stopping at the last researched term, outlook cells showing the middle figure marked "Outlook", weekly suggestions staying at 91 days, and the drafted words.

## What Changes

- **Spec numbers.** New decision D52 "A year of forecast: the outlook" (reserved), CONFIRM index items provisionally 95 to 102 (renumbered against develop at each release's start and before each push), changelog entries, and build notes on D42, 6.21, 6.23, 10.13, 10.15, 13.1, 14.3, 14.4, 14.6, P11, P25 and P28.
- **Runs reach today plus 365 days, capped at 400 days after the last day of sales** (was today plus 91, capped at 182). `[CONFIRM]`.
- **Two tiers, derived, never stored.** A run's forecast tier ends where a D42 run made that day would have ended (`min(madeAt + 91, dataThrough + 182)`); later days are its outlook. The reader derives `outlook` per day and per week; no row is migrated.
- **Days 1 to 91 unchanged**, pinned in four places: the lab's forecast tier and its stops as D42; "current" (the streak, unchanged-data refits) judged by the forecast tier's end; the jump guard reading only the compared run's forecast tier; outlook days left out of live accuracy.
- **Honest outlook ranges.** Two outlook horizons, 182 and 365 days of lead, interpolated on the square root of lead between them and grown by it past 365. A horizon's band is its own backtest when 26 or more weeks back it; with 8 to 25 weeks, the larger of that and square-root-of-lead growth; with fewer, the growth alone. Backtest ratios are taken per side, so a skewed band never narrows on its wider side. Ratios never narrow with lead. A coverage check on four-year synthetic histories, including hindsight-free calendars and level shifts inside the scored year, must pass before runs grow, and is built to be able to fail. `[CONFIRM]`. (Release B's build, 2026-11-19: that rule failed the check, and the build carries one chosen after the check had been seen, the growth always, widened by a band of the engine's own misses read the same on both sides, with outlook weeks the same on both sides; design.md decision 5's amendment; the owner chose on 2026-11-19 to ship it as built (“Ship #118 as built”).)
- **The baseline reads two years back** for leads of 358 to 400 days instead of losing its seasonal shape.
- **The model's outlook stops at the town's last researched term**; the baseline's does not. Dartmouth's winter and spring 2028 terms are researched into the town calendar. `[CONFIRM]`.
- **Lab input version 3** (`horizonDays: 400`, `termsThrough`), one step for the lab and the API; `LAB_MODEL_VERSION` `v9` (`v10` as built: develop's `v9` became the closed-weekday fix of 2026-11-18); the scorecard's `horizonOutlook`, reported and never gated.
- **The gate checks the outlook for sanity only**: `outlook_too_far`, `widening_out_of_order` and `outlook_past_terms` in `checkLabResult`. `[CONFIRM]`.
- **Reads stay bounded.** The route keeps 92 days a read and 400 days ahead; the Calendar keeps one 42-day read per month, 2027 included. The reader chooses each date's run from run metadata and reads rows only of the runs it chose.
- **The UI and TownwiseAI say "Outlook"**: the Calendar (cells with the middle figure marked "Outlook", week columns, tooltip, a day panel with the range and no "8 in 10", a key line), Home (This month, day detail, This week), TownwiseAI's `get_forecast` and daily visuals, and, once runs reach a year, the model card and the public and privacy copy. `[CONFIRM]`.
- **Two releases.** Release A reads, judges and labels year-long runs while every run is still 91 days, so it changes no answer. Release B makes runs a year long under a paused weekly schedule; rolling it back is reverting it.

## Capabilities

### New Capabilities
- `forecast-outlook`: the reach to a year, the tiers, the forecast tier's protections (current, the jump guard), the outlook horizons and their range rule, the coverage check, the baseline's two-year shape, the model's term cap, lab input version 3, the gate's sanity checks and release B's paused schedule.
- `forecast-outlook-reads`: `outlook` on read days and weeks, outlook days out of accuracy, the unchanged limits, metadata-chosen bounded reads, and TownwiseAI's marking.
- `forecast-outlook-display`: the Calendar's, Home's and TownwiseAI's visuals' "Outlook" words, the model card and the public and privacy copy.

### Modified Capabilities
None. `autonomous-forecasts` is not archived, so `openspec/specs/` holds no forecast capability to modify; this change states its rules as new requirements and amends D42 through spec build notes.

## Impact

- **Release A, API**: new `api/src/forecasts/tiers.ts`; `forecasts/reader.ts`, `forecasts/score.ts`; `lab/gate.ts`, `lab/schedule.ts`, `lab/service.ts`, `lab/scorecard.ts`, `lab/result.ts`; `chat/tools/forecast.ts`, `chat/tools/visual.ts`; `town-calendar-data.ts`.
- **Release A, client**: `portal/estimates/api.ts`, `portal/calendar/`, `portal/home/`, `portal/analytics/week.ts`, `chat/visuals/words.ts` and `hover.ts`.
- **Release B, lab**: `modeling/lab/townwise_lab/{forecast,pipeline,baseline,schema,version}.py`, its tests and goldens.
- **Release B, API and words**: `lab/input.ts`, `lab/result.ts`, `lab/callback.ts` (if the measured result needs it), `stores/calibrations.ts` (`termsThrough`), `estimates/about.ts`, `portal/estimates/ModelCard.tsx`, `marketing/Home.web.tsx`, `app/(marketing)/privacy.tsx`.
- **Storage**: `tw_forecasts` grows about four times per run; no migration, no new index.
- **Docs**: `docs/portal/spec.md`, `api/README.md`, `docs/portal/tuning-chat.md`, `docs/portal/estimates.md`.
- **Production**: the lab is live (v2026.11.17); release B pauses the weekly schedule around its deploy.

## Owner sign-offs

Decided 2026-11-17 and marked `[CONFIRM]` for the team: the reach and cap, the 26-week bar, the term cap, the cell display, the words. Before release B's push: approval of the model card's, the public and the privacy words.

## Owner actions (not done by this change)

- Pause and resume the weekly schedule around release B (task B.12).
