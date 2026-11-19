## ADDED Requirements

### Requirement: Training changes mark a refit wanted
Applying or undoing a change on a day on or before the location's sales data end, a sales upload, a person's note or rule touching such a day, and a closure rule SHALL set the location's `refit.wantedAt` to the later of its value and now. Notes and rules that touch only later days SHALL change the forecast on read and SHALL NOT mark a refit.

#### Scenario: A note on next week only
- **WHEN** TownwiseAI applies a private-event note for next Saturday
- **THEN** the next forecast read shows it and no refit is wanted

### Requirement: The hourly pass refits a wanted location once things are quiet
On any day, the worker's hourly pass SHALL take a location whose `refit.wantedAt` is at least 15 minutes old, which has no live calibration, and whose `refit.startedAt` is absent or more than 24 hours old. It SHALL fingerprint the location's lab input as the weekly refresh does. When the fingerprint equals its reference calibration's, the pass SHALL clear the flag and start nothing. Otherwise it SHALL start a calibration as the system (no charge, not one of the 4 a day), inside the live cap of 3 and counted in the weekly cap, and set `refit.startedAt`. The flag SHALL be cleared by compare-and-set on the `wantedAt` value the pass read. The lab's gate and the organization's forecasts switch SHALL still decide publication.

#### Scenario: A burst of changes
- **WHEN** twelve notes on past days are applied over ten minutes
- **THEN** one refit starts at the first hourly pass at least 15 minutes after the last of them

#### Scenario: Twice in a day
- **WHEN** a refit for wanted changes started at 09:05 and another change lands at 11:00
- **THEN** no second refit starts before 09:05 the next day, and the flag stays set until then

#### Scenario: Nothing the lab reads changed
- **WHEN** a wanted refit's fingerprint equals the reference calibration's
- **THEN** no calibration starts and the flag is cleared

#### Scenario: A change during the pass
- **WHEN** a new change sets `refit.wantedAt` after the pass read it
- **THEN** the pass's clear does not match, and the flag stays for a later pass
