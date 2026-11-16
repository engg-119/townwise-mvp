## ADDED Requirements

### Requirement: Every draft is judged by the same rules, whoever started it
After G1 (forecasts on and the organization active, else `forecasts_off`), every draft, whether its calibration was scheduled or started by an org admin or staff, SHALL be judged as follows. With no current published run, a model draft SHALL need today's first-forecast rule and a baseline draft its absolute checks. With a current lab run of the same engine that has a recorded scorecard, the draft SHALL need its engine's absolute checks and the refresh tolerance below. With a current lab run of the other engine, the lab's same-weeks comparison (forecast-engines: the other engine at least 0.5 points better) SHALL stand as the comparison, and the draft SHALL need its engine's absolute checks; the gate SHALL make no second cross-engine comparison against a recorded backtest from different weeks. With a current run that has no recorded lab scorecard (an imported run), the draft SHALL keep today's comparison on held-out weeks after that run's `dataThrough` (`api/src/lab/gate.ts`). A baseline draft made because the model did not run while the current run is a model run SHALL stay a draft (`model_not_run`). [CONFIRM: a same-engine draft is compared with the current lab run's recorded backtest instead of held-out weeks after that run's cutoff, and an engine switch is decided by the lab on the same backtest weeks with a 0.5-point margin, a tie keeping the current engine]

#### Scenario: A manual calibration against a young run
- **WHEN** an org admin's calibration makes a model draft with backtest weekly WAPE 8.9%, the current run is a model run published 1 week earlier, and the best recorded backtest in its streak is 9.1%
- **THEN** the draft is judged under the refresh tolerance and publishes with reason `refreshed`, instead of answering `too_few_weeks`

#### Scenario: An engine switch
- **WHEN** the lab returned a model draft because it beat the baseline by 0.6 points on the same weeks, and the current run is a baseline run
- **THEN** the draft publishes once it passes the model's absolute checks, with no comparison against the baseline run's recorded backtest

#### Scenario: The model could not run
- **WHEN** the current run is a model run, the location's history now spans 580 days after an upload was turned off, and the lab returned a baseline draft
- **THEN** it stays a draft with reason `model_not_run`

#### Scenario: An imported current run
- **WHEN** the current run was imported by staff and has no lab scorecard
- **THEN** the draft is compared on held-out weeks after that run's `dataThrough`, as today

### Requirement: The refresh tolerance, against the streak's best
A same-engine draft SHALL publish when its backtest weekly WAPE is no more than 0.5 points above the best (lowest) recorded backtest weekly WAPE among the runs of the current streak (the consecutive published lab runs of that engine for the location, newest first, back to the first one of another engine or imported), reason `refreshed`; otherwise it SHALL stay a draft, reason `refresh_worse`. A tie SHALL publish: this is the only exception to G2's "ties do not publish". Using the streak's best, not the current run's, SHALL keep the tolerance from compounding week over week. [CONFIRM: a same-engine refit publishes when it passes its absolute checks and is no more than 0.5 points of weekly WAPE worse than the best recorded backtest in the current streak]

#### Scenario: New weeks are taken in
- **WHEN** Monday's scheduled calibration makes a model draft with backtest weekly WAPE 9.4% and the streak's best is 9.1%
- **THEN** the draft publishes with reason `refreshed`, and days after its `dataThrough` read from it

#### Scenario: No slow drift
- **WHEN** the streak's runs recorded 9.1%, 9.5% and 9.6% and a new draft records 9.7%
- **THEN** it stays a draft with reason `refresh_worse`, since 9.7% is more than 0.5 points above 9.1%

### Requirement: Absolute checks for each engine
A model draft's absolute checks SHALL be coverage 65% to 95% on at least 12 backtest weeks with an 80% range, weekday bias no more than 2 points worse than the current run's recorded backtest (when there is one), and weekly WAPE at least 0.5 points under the weekday median (`weekdayMedianWeeklyWape`). A baseline draft's SHALL be at least 12 backtest weeks with an 80% range (`too_few_weeks`), coverage 65% to 95% (`coverage_out_of_band`), weekly bias, the sum of forecast minus actual over the sum of actuals across the backtest weeks, within 5 points either way (`biased`), and weekly WAPE lower than the weekday median's (`baseline_not_beaten`; a tie fails). `GATE_WORDS` SHALL word every new reason. [CONFIRM: baseline publishes when the model is not eligible or does not win] [CONFIRM: a baseline's absolute checks are 12 backtest weeks with an 80% range, coverage 65% to 95%, weekly bias within 5 points, and a lower weekly WAPE than the weekday median]

#### Scenario: A young restaurant's first forecast
- **WHEN** a location with 300 days of history and forecasts on gets a baseline draft with 14 weeks with a range, 11 of them inside, bias of -2 points and WAPE 11% against the weekday median's 13%, and nothing is published
- **THEN** the draft publishes with gate reason `published`

#### Scenario: A biased baseline
- **WHEN** the baseline's backtest bias is +7 points
- **THEN** the draft stays a draft with gate reason `biased`

#### Scenario: A baseline no better than the weekday median
- **WHEN** the baseline's backtest weekly WAPE equals the weekday median's
- **THEN** the draft stays a draft with gate reason `baseline_not_beaten`

### Requirement: A large jump waits for staff
When a draft passes every other check and there is a current published run, the gate SHALL compare the two runs' middles over the 28 days from the calibration's `today`, summed over the days both forecast open. When the draft's sum differs from the current run's by more than 25% either way, the draft SHALL stay a draft with reason `jump_held` for staff to publish or withdraw, and SHALL not publish on its own. [CONFIRM: a draft whose next 28 days' middles differ from the current run's by more than 25% is held for staff]

#### Scenario: A jump
- **WHEN** the current run's middles over the next 28 days sum to 4,000 guests and a passing draft's sum to 5,200
- **THEN** the draft stays a draft with reason `jump_held`, and staff see it in the console's Forecasts section

#### Scenario: A normal week
- **WHEN** the draft's sum is 4,300 against 4,000
- **THEN** the jump guard does not hold it

### Requirement: Every published run says which engine made it
`ForecastRunView` SHALL carry `engine`, `'baseline'` for model family `seasonal_baseline` and `'model'` otherwise, derived and never stored. A baseline run's `model.label` SHALL be "Townwise's baseline from your recent weeks and the town calendar", and a model run's keeps "Townwise demand model v{n}". The model card, the Calendar's provenance, TownwiseAI's `get_forecast` and the console's runs list SHALL use these words.

#### Scenario: The model card for a baseline run
- **WHEN** the newest published run is a baseline run
- **THEN** the model card names it "Townwise's baseline from your recent weeks and the town calendar" with its training dates and accuracy

#### Scenario: TownwiseAI names the engine
- **WHEN** `get_forecast` answers over days from a baseline run
- **THEN** each run in its result carries `engine: 'baseline'` and that label
