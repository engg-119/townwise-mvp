# order-counts Specification

## Purpose
TBD - created by archiving change complete-bar-ordering. Update Purpose after archive.
## Requirements
### Requirement: A member saves a count
The system SHALL accept `{ date, items: { itemId: quantity } }` with a date from 14 days before the town's today through today, 1 to 300 items, and quantities from 0 to 9,999 in steps of 0.5 purchase units, and SHALL store it per location and date, replacing each sent item's quantity for that date and keeping the others.

#### Scenario: Count part of the bar
- **WHEN** a member counts 5 of 12 items today and later counts the other 7 today
- **THEN** today's count holds all 12 items

#### Scenario: Future date
- **WHEN** a count is dated tomorrow
- **THEN** the system answers 400 and stores nothing

### Requirement: The latest count per item wins
The board SHALL use, for each item, the quantity from the newest count date that holds it within the last 400 days, and its age in days from the town's today. A count older than 7 days SHALL still set the quantity to the par less what it counted. [CONFIRM: the latest count is read from the last 400 days]

#### Scenario: Older count for one item
- **WHEN** an item was counted 9 days ago and not since
- **THEN** its line uses that count with an age of 9 and low confidence

#### Scenario: A count 100 days old
- **WHEN** an item with par 3 was last counted at 2, 100 days ago
- **THEN** its line orders 1, the par less that count, not the whole par

### Requirement: Counts are audited, scoped and deleted with their location
Each save SHALL write `order.count_saved` with the date and item count only. Saving SHALL be allowed for every member, refused under view-as, and a foreign location SHALL answer 404. Deleting the location or the organization SHALL delete its counts.

#### Scenario: View-as
- **WHEN** staff in view-as post a count
- **THEN** the chain refuses it and nothing is stored

### Requirement: Counting is one step from the board
The Orders page SHALL offer "Enter a count" with one field per item grouped by supplier, prefilled with nothing, saving only filled fields.

#### Scenario: Save from Orders
- **WHEN** a person enters 3 quantities and saves
- **THEN** the board reloads with those 3 lines at high confidence

