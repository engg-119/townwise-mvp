## ADDED Requirements

### Requirement: Runs reach a year
A lab run SHALL carry the days after its `dataThrough` through the calibration's `today` plus 365 days, capped at `dataThrough` plus 400 days, when its forecast tier is fully backed (8 or more backtest weeks at 91 days, and at the reach when sales lag past 91 days). When either of D42's stops applies, the run SHALL end where D42 ends it and carry no outlook. The lab input SHALL be `townwise.lab-input/3` with `horizonDays: 400` and `termsThrough`, accepted by the lab only in version 3, and `LAB_MODEL_VERSION` and the lab's `MODEL_VERSION` SHALL be `v9`. [CONFIRM: runs reach today plus 365 days, capped at 400 days after the last day of sales]

#### Scenario: Current sales
- **WHEN** a calibration on Monday 2026-11-23 has sales through Sunday 2026-11-22 and every horizon is backed
- **THEN** its run covers 2026-11-23 through 2027-11-23, today plus 365

#### Scenario: Sales three weeks behind
- **WHEN** the calibration's `dataThrough` is 21 days before its `today`
- **THEN** the run still ends at `today` plus 365, inside the cap of `dataThrough` plus 400

#### Scenario: Sales seven weeks behind
- **WHEN** the calibration's `dataThrough` is 49 days before its `today`
- **THEN** the run ends at `dataThrough` plus 400, 351 days after `today`

#### Scenario: The 91-day horizon is not backed
- **WHEN** fewer than 8 backtest weeks back the 91-day horizon
- **THEN** the run stops at 28 days of lead, as before, with no outlook day

### Requirement: A run's two tiers
A run's forecast tier SHALL end at `tierEnd(run) = min(madeAt + 91, dataThrough + 182)`, the last day a D42 run made then would have carried, and a day after it SHALL be in the run's outlook; `forecastThrough(run)` SHALL be the earlier of the run's last day and `tierEnd(run)`. The tier SHALL be derived wherever it is needed and never stored on a forecast row.

#### Scenario: The boundary
- **WHEN** a run made 2026-11-23 with sales through 2026-11-22 covers 2026-11-23 through 2027-11-23
- **THEN** 2027-02-22 (91 days after it was made) is a forecast day and 2027-02-23 an outlook day

#### Scenario: Sales lagging past three months
- **WHEN** a run made 2026-11-23 has sales through 2026-08-01
- **THEN** its forecast tier ends 2027-01-30 (182 days after its sales), as a D42 run's last day would, and later days are its outlook

### Requirement: Days 1 to 91 unchanged
For every day of the forecast tier the lab SHALL produce the same engine choice, figures, reasons, ranges and week rows, and the gate the same decision, as D42 for the same days of history: `reach_horizon` and the forecast tier's end of `min(today + 91, dataThrough + 182)`, the 28-day gate and its checks, the widening at 29 days of lead and past 91, and a forecast-tier week widened by its first day's ratio.

#### Scenario: The same forecast tier
- **WHEN** the golden history is calibrated as input version 2 before this change and version 3 after it
- **THEN** the forecast tier's days, reasons and week rows are equal, and so are the scorecard's gate fields

### Requirement: Current judged by the forecast tier
`currentChampion` and `streakOf` (`api/src/lab/gate.ts`) SHALL count a run current while `forecastThrough(run)` is at least 28 days past today. `refitExtends` (`api/src/lab/schedule.ts`) SHALL refit unchanged data when no run will be current at next Monday's pass and the reference run's forecast tier reached its `madeAt` plus 91. The jump guard (`api/src/lab/service.ts`) SHALL read the run it compares against only through `forecastThrough` of that run. [CONFIRM: a run counts as current while its forecast tier reaches 28 days past today, and the jump guard compares only that tier, so a year-long run lapses and is compared as a 91-day run was]

#### Scenario: A year-long run lapses as a 91-day one did
- **WHEN** the newest published run was made 64 days before today and covers a year
- **THEN** it is not the current run, and the streak and the jump guard treat it as lapsed

#### Scenario: A lapsed run's outlook stays out of the jump guard
- **WHEN** a draft follows a lapsed year-long run whose forecast tier ends 10 days into the draft's 28
- **THEN** the jump guard sums only those 10 days

#### Scenario: Unchanged data still refits
- **WHEN** a location's data has not changed for 9 weeks and its run covers a year
- **THEN** the weekly refresh refits it on the Monday it would have refit a 91-day run

### Requirement: Outlook horizons and honest ranges
Both engines SHALL be backtested at 182 and 365 days of lead, reported in the scorecard's `horizonOutlook` (`{ horizon, weeks, weeklyWape, coverage80, ratio, basis }`, never gated). For each outlook horizon H after the previous horizon P with ratio r_P (the forecast tier's last, 91 or the reach, then 182): the growth floor SHALL be r_P × sqrt(H / P), and the backtest ratio the larger of the two sides' ratios of H's weekly log band to the 28-day band's (a side whose 28-day size is 0 taking the width ratio). With fewer than 8 backtest weeks r_H SHALL be the floor; with 8 to 25, the larger of the floor and the backtest ratio; with 26 or more, the larger of r_P and the backtest ratio. By lead past the forecast tier, a day SHALL take r_182 up to 182 days, the square-root-of-lead interpolation between r_182 and r_365 from 182 to 365, and r_365 × sqrt(L / 365) past 365. Daily ranges SHALL widen by `widen_k` times the day's ratio on both sides, and an outlook week by the largest ratio among its days. The run's `widening` SHALL carry the forecast tier's entries unchanged and outlook anchors equal to `horizonOutlook`'s ratios. [CONFIRM: 26 backtest weeks at a horizon let its backtest alone set the outlook's band; under 26 the backtest can only widen the square-root-of-lead growth; while a location has under three years of history, its baseline's 365-day band rests on one year-over-year change]

#### Scenario: No year-ahead backtest
- **WHEN** a history has 15 backtest weeks at 182 days and none at 365, its 91-day ratio is 1.3 and its 182-day backtest ratio 1.5
- **THEN** r_182 is max(1.3 × sqrt(2), 1.5) and r_365 is r_182 × sqrt(365 / 182)

#### Scenario: A skewed band
- **WHEN** the 365-day band's low side is 3 times the 28-day band's and its high side 1.5 times
- **THEN** the backtest ratio is 3

#### Scenario: Never narrower with lead
- **WHEN** any calibration's run is assembled
- **THEN** every day's ratio is at least the ratio of every earlier lead

### Requirement: A coverage check that can fail
Before release B ships, `modeling/lab/tests/test_outlook_coverage.py` SHALL score synthetic four-year histories (the weekly swings of `test_coverage.py`, a 20% level shift and a changing trend inside the scored year, and a set with Hanover's calendar) cut at two and at three years, each cut's input carrying no calendar event that starts more than 182 days after it. Per horizon and per cut, the 80% weekly bands SHALL hold at least 80% of the scored weeks on average with no history under 65%, and the daily ranges at least 75% of days on average. The same check with every outlook ratio forced to the 28-day ratio SHALL fail. Its thresholds, the exponent, the 26 weeks and the horizons SHALL be fixed before measuring; a failure SHALL stop release B.

#### Scenario: The control fails
- **WHEN** the check runs with no outlook widening
- **THEN** it reports at least one horizon and cut under its threshold, and the test asserts that it does

### Requirement: The baseline's shape two years back
For a date whose 3 weeks around the date less 364 days are not all on or before the cutoff (leads 358 to 400), the baseline engine SHALL read its shape from the 3 weeks around the date less 728 days over the plain level at the cutoff less 728 days, clamped as before, and 1 when those are not history. Dates within 357 days of the cutoff SHALL keep today's shape.

#### Scenario: The last weeks of the year
- **WHEN** a three-year history is forecast 362 days ahead
- **THEN** the day's shape comes from two years back, not 1

### Requirement: The model's outlook stops at the last researched term
The API SHALL send `termsThrough`, the last day of the town's last researched term entry (classes or finals), or null for a town with none, and record it on the calibration. A model run SHALL end no later than the later of its forecast tier's end and `termsThrough` when that is set; a baseline run SHALL not be cut. [CONFIRM: the trained model's outlook stops at the town's last researched term day; the baseline's does not]

#### Scenario: A term not yet researched
- **WHEN** a model run made 2027-01-04 would reach 2028-01-04 and the town's last researched term ends 2027-11-24
- **THEN** its run ends 2027-11-24

#### Scenario: The baseline runs on
- **WHEN** the same location's run is the baseline's
- **THEN** its run reaches 2028-01-04

### Requirement: The gate checks the outlook for sanity only
The gate's decision SHALL not depend on any outlook day. `checkLabResult` SHALL take the calibration's `termsThrough` and refuse a result whose run ends after `min(madeAt + 365, dataThrough + 400)` (`outlook_too_far`), whose widening entries do not strictly increase in `fromLead`, fall under 1, decrease, or carry outlook anchors that differ from `horizonOutlook` (`widening_out_of_order`), or whose model run ends after the later of its `forecastThrough` and `termsThrough` (`outlook_past_terms`); a refused result fails its calibration. [CONFIRM: the gate judges nothing about the outlook but these sanity checks]

#### Scenario: A narrowing outlook refused
- **WHEN** a result's 365-day anchor ratio is lower than its 182-day one
- **THEN** the callback refuses it with `widening_out_of_order` and the calibration fails

### Requirement: Release B pauses the schedule
The release that ships lab input version 3 SHALL pause the weekly schedule, wait until no calibration is live, deploy the API, worker and lab images, check their digests, and resume.

#### Scenario: No mixed versions
- **WHEN** release B deploys
- **THEN** no scheduled calibration starts between the first image changing and the last
