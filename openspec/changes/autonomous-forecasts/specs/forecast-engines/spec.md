## ADDED Requirements

### Requirement: Lab input version 2 carries the town calendar and the current engine
The lab input SHALL move to `townwise.lab-input/2` in one step, with the API and the lab built from the same commit; the lab SHALL refuse a version 1 input (`invalid_input`). Version 2 SHALL add `calendar`: every town calendar entry (`townEvents` for the location's town) overlapping the input's days, each as `{ id, group, kind, start, end, confidence }` with `kind` one of `event`, `holiday`, `term` or `season`; and SHALL add `engine` (`model` or `baseline`) to `champion`, the engine of the current published run. It SHALL never carry an entry's title, URL or source label.

#### Scenario: A version 2 input
- **WHEN** the API builds the input for a Hanover location whose days span Dartmouth's fall term and whose current run is a baseline run
- **THEN** `calendar` lists the term's entry with its id, group, kind `term`, dates and confidence, `champion.engine` is `baseline`, and no title or URL appears anywhere in the input

#### Scenario: A version 1 input
- **WHEN** the lab receives a `townwise.lab-input/1` input
- **THEN** it answers `invalid_input`

#### Scenario: A town with no researched calendar
- **WHEN** the location's town has no researched entries
- **THEN** `calendar` holds only the US federal holidays over the input's days

### Requirement: Two engines, one returned, and the current engine sticks
Every calibration SHALL run the baseline engine, and SHALL also run the trained model when the history (the span from the first to the last day with guests, `guestSpan`) is at least 595 days. Both SHALL be backtested on the same weeks, each scored from a cutoff at least 28 days before its Monday. The lab SHALL return the current engine's run (`champion.engine`) unless the other engine's backtest weekly WAPE is at least 0.5 points lower on those same weeks and the other engine passes the gate's checks that need no current run (12 or more backtest weeks with an 80% range, 65% to 95% of them inside it, a backtest weekly WAPE under that engine's own weekday median's on the same days, at least 0.5 points under for the model and strictly under for the baseline, and for the baseline a weekly bias within 5 points either way); with no current run, the model's run when it is at least 0.5 points lower than the baseline's, else the baseline's, except that when that engine fails those checks and the other passes them, the other's. A tie SHALL keep the current engine, and a current engine that fails those checks SHALL be kept (the current run stays published until it lapses). When the current engine is the model and the model did not run, the lab SHALL return the baseline's run, which the gate holds (forecast-publish-policy). The scorecard SHALL carry `engine` (the run returned) and `engines`, each engine's backtest metrics (the model's null when it did not run).

#### Scenario: The model wins a first forecast
- **WHEN** a location with 700 days of history and no published run has a model backtest WAPE of 9.0% against the baseline's 10.2%, and both pass the gate's checks
- **THEN** the result's run is the model's and `scorecard.engine` is `model`

#### Scenario: The WAPE winner's ranges miss
- **WHEN** a location with 700 days of history and no published run has a model backtest WAPE 1.3 points lower than the baseline's, but the model's 80% ranges hold 8 of 25 weeks, and the baseline's hold 32 of 37 with a weekly bias of -3.5%
- **THEN** the result's run is the baseline's, which the gate can publish, rather than a model draft the gate would hold `coverage_out_of_band`

#### Scenario: The WAPE winner does not beat its own weekday median
- **WHEN** a location with no published run has a baseline backtest WAPE of 13.2% against the model's 14.0%, both pass coverage and the baseline's bias, but the baseline's own weekday median scores 13.0% on those days and the model's 15.0%
- **THEN** the result's run is the model's, which the gate can publish, rather than a baseline draft the gate would hold `baseline_not_beaten`

#### Scenario: Close engines do not flip-flop
- **WHEN** the current run is a baseline run and, over four weekly calibrations, the model's backtest WAPE is 0.3 points lower, then 0.2 higher, then 0.4 lower, then 0.1 lower than the baseline's
- **THEN** every result is the baseline's run

#### Scenario: The other engine clearly wins
- **WHEN** the current run is a baseline run and the model's backtest WAPE is 0.6 points lower on the same weeks
- **THEN** the result's run is the model's

#### Scenario: Too little history for the model
- **WHEN** a location's history spans 400 days
- **THEN** only the baseline runs and `engines.model` is null

### Requirement: The baseline engine
The baseline engine SHALL forecast each open day as its weekday's recent level times last year's seasonal shape times the location's own calendar effects, where: the level is the median guests of the last 8 open same weekdays on or before the cutoff, needing at least 3; the shape is last year's same-weekday guests in the 3 weeks around the date less 364 days over last year's level at the cutoff less 364 days, leaving out event and holiday days, clamped to 0.5 to 2, and 1 when last year has fewer than 3 such days; and each event or holiday group on the day multiplies by the median ratio of its past days to the same weekday without it (an event needing 3 days with it and 3 without; a holiday 1 past occurrence against the 4 weeks either side). Day statuses (closed, booked) SHALL come from the same rules as the model's. Notes and scheduled business rules SHALL act only through the input's flags and the read (14.5), never inside the engine. Its run SHALL have `model.family` `seasonal_baseline`, the same reason kinds as the model's, and `effectPct` set on a reason from the engine's own multiplier. Its minimum history SHALL be the span that always gives 12 backtest weeks with an 80% range, 230 days, pinned by a lab test; it SHALL apply to scheduled calibrations only, and a calibration a person starts SHALL keep needing 595 days. [CONFIRM: scheduled calibrations, which can only use the baseline engine below 595 days, may start from a 230-day span of history; this supersedes the owner's 2026-11-10 decision of 595 days for the baseline engine on scheduled calibrations only, while a calibration a person starts and the model engine keep 595 days]

#### Scenario: A home game Saturday
- **WHEN** a location's past home football Saturdays averaged 1.3 times its other Saturdays over 6 games, and next Saturday is a home game
- **THEN** the baseline's middle for that Saturday is its Saturday level times its shape times 1.3, and its event reason carries `effectPct` 30

#### Scenario: A closed weekday
- **WHEN** the location had no guests on its last 8 Mondays in weeks open otherwise
- **THEN** the baseline's Mondays are `closed` with no figures, exactly as the model's would be

#### Scenario: A rule's closure is not counted twice
- **WHEN** a scheduled rule closes Tuesdays from next week
- **THEN** the baseline's own figures for those Tuesdays come from the engine alone, and the forecast read closes them (14.5)

#### Scenario: Minimum history
- **WHEN** a location's history spans 230 days with guests on every open day
- **THEN** the baseline's backtest has at least 12 weeks with an 80% range

### Requirement: Runs reach 91 days past today
A lab run SHALL carry the days from the day after `dataThrough` through the calibration's `today` plus 91 days, capped at 182 days after `dataThrough`, and only the Monday-to-Sunday weeks wholly inside them. The scorecard SHALL keep `horizonDays: 28`, which the gate judges, and SHALL add `horizon91`, the backtest weeks forecast from a cutoff at least 91 days before their Monday, as `{ weeks, weeklyWape, coverage80 }` or null, and `horizonReach`, the same at the run's longest lead in whole weeks when it is beyond 91 days (sales lag), or null. Days with a lead of 29 to 91 days SHALL take the 80% range widened by the ratio of the 91-day to the 28-day backtest weekly band width, and days with a longer lead by the ratio of the reach's band to the 28-day band, never less than 1; weeks likewise by their first day. When a horizon's backtest has fewer than 8 weeks, the run SHALL stop at the last day the shorter horizon covers (28 or 91 days of lead). [CONFIRM: runs reach today plus 91 days, capped at 182 days after the last day of sales; ranges past 28 days of lead widen by the backtest's longer-horizon bands; a run stops where fewer than 8 backtest weeks back the next horizon]

#### Scenario: Current sales
- **WHEN** a calibration runs on Mon, Nov 16, 2026 with `dataThrough` Sun, Nov 15 and `horizon91` has 20 weeks
- **THEN** the run's days are Nov 16, 2026 to Feb 15, 2027, and a day in January has a wider range than the same middle would have in its first 28 days

#### Scenario: Sales lag three weeks
- **WHEN** a calibration runs on Mon, Nov 16, 2026 with `dataThrough` Sun, Oct 25 and both `horizon91` and `horizonReach` have at least 8 weeks
- **THEN** the run's days are Oct 26, 2026 to Feb 15, 2027, and its last days take the reach's widening

#### Scenario: Not enough 91-day evidence
- **WHEN** `horizon91` has 5 weeks
- **THEN** the run's days end 28 days after `dataThrough`

#### Scenario: The gate still judges 28 days
- **WHEN** a scorecard reports `horizon91.weeklyWape` of 18%
- **THEN** the gate reads only the 28-day metrics, and the 91-day figure is shown to staff and TownwiseAI as reported
