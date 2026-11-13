## ADDED Requirements

### Requirement: The board is one next order per supplier
With a setup that has at least one supplier delivery and one item, `GET /org/locations/:locationId/orders` SHALL answer `{ available: true, sample: false, missing, orders }`, one order per supplier with items, ordered by cutoff. Each order SHALL carry the supplier, the cutoff date and time, the delivery date, the date it covers through, a deadline sentence, and a line per item of that supplier. `missing` SHALL list what the board lacks among "item sales" and "a recent count". With no setup it SHALL answer `{ available: false, reason, missing }`, and with `?sample=true` the labeled sample.

#### Scenario: No setup
- **WHEN** a location has no ordering setup
- **THEN** the answer is unavailable with `missing` naming the supplier schedule and the items

#### Scenario: Two suppliers
- **WHEN** supplier A delivers Thursday (order by Wednesday 14:00) and supplier B Tuesday (order by Monday 12:00), and it is Sunday
- **THEN** the board holds B's order first, then A's, each with only its own items

### Requirement: The next order follows the schedule
For each delivery row, the system SHALL find the next order-by date and time after now in the town's zone; the delivery date SHALL be that date plus (delivery weekday minus order-by weekday) mod 7 days; the window SHALL run from the order-by date through the day before the supplier's following delivery, which the order covers through. A supplier's next order is the row with the soonest order-by time.

#### Scenario: Cutoff passed earlier today
- **WHEN** the order-by is Wednesday 14:00 and it is Wednesday 15:00
- **THEN** the next order is the following week's

#### Scenario: Sawtooth-style schedule
- **WHEN** deliveries are Monday, Tuesday and Thursday with order-by Saturday, Monday and Wednesday, and it is Tuesday
- **THEN** the next order is order-by Wednesday for Thursday, window Wednesday through Sunday, covering through Monday

### Requirement: Window demand comes from item sales and the guest forecast
Daily demand for an item SHALL be its mean servings on that weekday over the covered days of the last 8 weeks (an unsold item counting zero on a covered day), times the guest index when a published forecast covers the day; the guest index SHALL be the forecast's middle guests divided by the location's mean guests on that weekday over the same 8 weeks. Window demand mu SHALL be the sum over the window, skipping days with no mean, converted to purchase units by dividing by servings per unit x (1 - the category's loss rate). [CONFIRM: 8 weeks; guest index against the location's own history; loss rates bottles and cans 1%, draft 12%, liquor 5%, cocktail ingredients 0%]

#### Scenario: No forecast
- **WHEN** no published forecast covers the window
- **THEN** mu is the sum of weekday means and the why line says it follows the last 8 weeks of sales

### Requirement: The cushion comes from past window errors
sigma SHALL be the sample standard deviation of the errors of past windows of the same supplier schedule that ended before today, each error being actual servings minus the weekday-mean forecast made as of that window's order-by date, over the last 26 weeks, in purchase units; with fewer than 2 errors it SHALL be null.

#### Scenario: Too little history
- **WHEN** only one past window has closed
- **THEN** sigma is null, S equals mu, and the why line says there is no safety cushion yet

### Requirement: The quantity follows the engine
The target SHALL be 0.98 for a never-run-out item, else 0.95 for bottles and cans and draft, 0.92 for liquor and 0.88 for cocktail ingredients, with z 2.054, 1.645, 1.405 and 1.175. S SHALL be mu + z x (sigma or 0). With no count the quantity SHALL be the par; with a count over 7 days old, max(0, par - count); otherwise needed = max(0, S - count, par - count), rounded to the cheaper of the lower and upper multiples of the deal size by the engine's cost (holding 0.05, shortage 4.0), the other being the alternative, swapped when the pick is under par and the alternative is not; without a deal size, needed rounded up to a whole unit and no alternative. [CONFIRM: targets and z, whole units, the 7-day count limit]

#### Scenario: Spec 5g example
- **WHEN** mu is 14, sigma 3, the target 0.98, 5 counted today and the deal size 6
- **THEN** the line recommends 18 with 12 as the alternative

#### Scenario: Never counted
- **WHEN** an item with par 4 has no count
- **THEN** the line recommends 4 at low confidence and says there is no count, so this is the par

### Requirement: Confidence and the why line are honest
Confidence SHALL be low with no count, a count over 7 days old, or no covered item-sales days; medium with a count 3 to 7 days old or fewer than 28 covered days in the last 8 weeks; else high. The why line SHALL name the delivery and the day it covers through, the expected use and what it is based on, the count and its date, and, only when sigma exists, the target chance of not running out.

#### Scenario: Medium confidence
- **WHEN** the latest count is 5 days old
- **THEN** the line is medium and its why line asks for a count before sending

### Requirement: Saved edits and rules apply to the live board
A saved edit SHALL show on its line for the same delivery. A rule SHALL add its change to every later order of its item until turned off, each active rule listed on the line with its own turn-off, the recommended quantity never below 0. Saving an edit SHALL be refused on a sample and on a line not on the item's next order. [CONFIRM: a remembered change applies to every later order of the item]

#### Scenario: Two rules
- **WHEN** an item has active rules of +2 and -1
- **THEN** its line adds 1 and lists both rules, each with "Turn this rule off"

### Requirement: Order writes are safe under races and audited
Card status changes SHALL never overwrite a saved card and a racing first insert SHALL not answer 500; saving the same rule twice SHALL return the existing rule. Saving an edit, a rule, turning a rule off and saving or dismissing a card SHALL write `orders.decision_saved`, `orders.rule_saved`, `orders.rule_turned_off`, `orders.card_saved` and `orders.card_dismissed` with ids and dates only, never the reason text. Deleting a conversation or a person SHALL delete the order cards of their conversations.

#### Scenario: Dismiss races save
- **WHEN** a card is saved and a dismiss for it arrives after
- **THEN** the card stays saved

### Requirement: Home shows the next order
Home's Bar order card SHALL read the board and show the soonest deadline and how many items have a quantity above 0, linking to Orders; with no setup it SHALL say what is missing and link to Ordering setup. It SHALL stay hidden while Home shows onboarding.

#### Scenario: Set up
- **WHEN** the board's soonest order is Wednesday 14:00 with 9 items above 0
- **THEN** the card shows that deadline and "9 items to order" with "Open Orders"
