## ADDED Requirements

### Requirement: The board is one next order per supplier
With a setup that has at least one supplier delivery and one item, `GET /org/locations/:locationId/orders` SHALL answer `{ available: true, sample: false, missing, orders }`, one order per supplier with items, ordered by cutoff. Each order SHALL carry the supplier, the cutoff date and time, the delivery date, the date it covers through, a deadline sentence, and a line per item of that supplier. `missing` SHALL list what the board lacks among "item sales" and "a recent count". With no setup it SHALL answer `{ available: false, reason, missing }`, and with `?sample=true` the labeled sample (every line at its par, with no deal size and no other deal option, ordered by the next Wednesday 2:00pm not yet passed). Every answer SHALL carry `today`, the town's date.

#### Scenario: No setup
- **WHEN** a location has no ordering setup
- **THEN** the answer is unavailable with `missing` naming the supplier schedule and the items

#### Scenario: Two suppliers
- **WHEN** supplier A delivers Thursday (order by Wednesday 14:00) and supplier B Tuesday (order by Monday 12:00), and it is Sunday
- **THEN** the board holds B's order first, then A's, each with only its own items

### Requirement: The next order follows the schedule
For each delivery row, the system SHALL find the next order-by date and time after now in the town's zone; the delivery date SHALL be that date plus (delivery weekday minus order-by weekday) mod 7 days; the window SHALL run from the order-by date through the day before the supplier's following delivery, which the order covers through. A supplier's next order is the row with the soonest order-by time; of two rows with the same order-by day and time, the one with the earlier delivery.

#### Scenario: Cutoff passed earlier today
- **WHEN** the order-by is Wednesday 14:00 and it is Wednesday 15:00
- **THEN** the next order is the following week's

#### Scenario: Sawtooth-style schedule
- **WHEN** deliveries are Monday, Tuesday and Thursday with order-by Saturday, Monday and Wednesday, and it is Tuesday
- **THEN** the next order is order-by Wednesday for Thursday, window Wednesday through Sunday, covering through Monday

### Requirement: Window demand comes from item sales and the guest forecast
Daily demand for an item SHALL be its mean servings on that weekday over the covered days of the last 8 weeks (an unsold item counting zero on a covered day), times the guest index when a published forecast covers the day; the guest index SHALL be the forecast's middle guests divided by the location's mean guests on that weekday over the same 8 weeks. Window demand mu SHALL be the sum over the window, skipping days with no mean, converted to purchase units by dividing by servings per unit x (1 - the category's loss rate). A day the published forecast marks closed SHALL expect no sales (a guest index of 0), and a booked day SHALL keep the weekday mean with no guest index. An item that no covered day of the 8 weeks sold SHALL have no mean, so its line follows the par. [CONFIRM: 8 weeks; guest index against the location's own history; loss rates bottles and cans 1%, draft 12%, liquor 5%, cocktail ingredients 0%] [CONFIRM: a closed forecast day expects no sales] [CONFIRM: a booked (private buyout) day uses the weekday mean] [CONFIRM: an item no covered day sold has no mean (Python would give it 0 and a target chance)]

#### Scenario: A closed day in the window
- **WHEN** the published forecast marks one window day closed
- **THEN** that day adds no servings and the why line says it was left out

#### Scenario: Never sold
- **WHEN** an item has no servings on any covered day of the 8 weeks
- **THEN** mu is null, the line is at low confidence and follows the par, and the why line says none of it sold

#### Scenario: No forecast
- **WHEN** no published forecast covers the window
- **THEN** mu is the sum of weekday means and the why line says it follows the last 8 weeks of sales

### Requirement: The cushion comes from past window errors
sigma SHALL be the sample standard deviation of the errors of past windows of the same supplier schedule that ended before today, each error being actual servings minus the weekday-mean forecast made as of that window's order-by date, over the window's covered days only, over the last 26 weeks, in purchase units; with fewer than 2 errors it SHALL be null. The board SHALL read the 244 days of item sales this needs (the oldest delivery 182 days back, its order-by up to 6 days before, and 56 days of means before that). [CONFIRM: a past window's error uses its covered days only]

#### Scenario: Too little history
- **WHEN** only one past window has closed
- **THEN** sigma is null, S equals mu, and the why line says there is no safety cushion yet

### Requirement: The quantity follows the engine
The target SHALL be 0.98 for a never-run-out item, else 0.95 for bottles and cans and draft, 0.92 for liquor and 0.88 for cocktail ingredients, with z 2.05, 1.65, 1.405 and 1.175 (the engine's table and inverse normal values). S SHALL be mu + z x (sigma or 0). With no count the quantity SHALL be the par; with a count over 7 days old, max(0, par - count); otherwise needed = max(0, S - count, par - count), rounded to the cheaper of the lower and upper multiples of the deal size by the engine's cost (holding 0.05, shortage 4.0), the other being the alternative, swapped when the pick is under par and the alternative is not; without a deal size, or with a deal size of 1, needed rounded up to a whole unit and no alternative. A draft item's par SHALL be the owner's par plus 1 when mu is more than one unit (engine.py's `draft_backup_par`, with the owner's par as its base where Python defaults to 2). A quantity above 999 SHALL be 999, with no alternative. [CONFIRM: targets and z, whole units, the 7-day count limit] [CONFIRM: the draft backup par on the owner's par] [CONFIRM: a deal size of 1 is no deal size] [CONFIRM: a line holds at most 999]

#### Scenario: Draft backup
- **WHEN** a draft item with par 2 expects 1.5 kegs and 0 were counted today
- **THEN** the line's par is 3 and it recommends 3

#### Scenario: Spec 5g example
- **WHEN** mu is 14, sigma 3, the target 0.98, 5 counted today and the deal size 6
- **THEN** the line recommends 18 with 12 as the alternative

#### Scenario: Never counted
- **WHEN** an item with par 4 has no count
- **THEN** the line recommends 4 at low confidence and says there is no count, so this is the par

### Requirement: Confidence and the why line are honest
Confidence SHALL be low with no count, a count over 7 days old, no covered item-sales days or no mean; medium with a count 3 to 7 days old or fewer than 28 covered days in the last 8 weeks; else high. The why line SHALL name the delivery and the day it covers through, the expected use and what it is based on, the count and its date, and, only when sigma exists and the target set the quantity, the target chance of not running out. It SHALL ask for a count only for a count 3 or more days old, and say the history is short when coverage made the line medium. When the par set the quantity it SHALL say the order brings stock up to the par, never a chance; with no sigma it SHALL say the order covers the expected use only when what is counted plus the order reaches it; and a quantity capped at 999 SHALL say so. Lines SHALL be ordered never-run-out first, then by name. [CONFIRM: low confidence without a mean (Python's confidence reads the count only)] [CONFIRM: lines by never-run-out, then name (Python orders by value)]

#### Scenario: Medium confidence
- **WHEN** the latest count is 5 days old
- **THEN** the line is medium and its why line asks for a count before sending

#### Scenario: Short history, fresh count
- **WHEN** the count is from today and item sales cover 20 of the last 56 days
- **THEN** the line is medium and its why line says the history is short, without asking for a count

#### Scenario: The par sets the quantity
- **WHEN** an item with par 20 expects 8 units and 0 were counted today
- **THEN** the line recommends 20 and its why line says it brings stock up to the par, with no chance

### Requirement: Saved edits and rules apply to the live board
A saved edit SHALL show on its line for the same delivery. A rule SHALL add its change to every later order of its item until turned off, each active rule listed on the line with its own turn-off, the recommended quantity never below 0 or above 999. A line a rule moves SHALL have no alternative, and its why line SHALL end with the quantity the rules leave, saying so when 0 or 999 stopped them. An edit or a rule saved in another unit than the item's unit now SHALL be neither shown nor applied. Saving an edit SHALL be refused on a sample and on a line not on the item's next order. [CONFIRM: a remembered change applies to every later order of the item]

#### Scenario: Two rules
- **WHEN** an item has active rules of +2 and -1
- **THEN** its line adds 1 and lists both rules, each with "Turn this rule off"

#### Scenario: A rule larger than the order
- **WHEN** a line recommends 3 and its rule leaves out 5
- **THEN** the line recommends 0 with no alternative, and its why line says only 3 could come off

### Requirement: Order writes are safe under races and audited
Card status changes SHALL never overwrite a saved card and a racing first insert SHALL not answer 500; saving the same rule twice SHALL return the existing rule. A change card save SHALL claim the card before storing its edit, under one id per card, so two saves at once store one edit and one `order.card_saved`. A rule card save SHALL send the situation its card showed and SHALL be refused with 409 `rule_changed`, storing nothing, when the item's latest edit has another reason. Only a call that changed a card's state, or created a rule, SHALL write its event. Saving an edit, a rule, turning a rule off and saving or dismissing a card SHALL write `order.decision_saved`, `order.rule_saved`, `order.rule_turned_off`, `order.card_saved` and `order.card_dismissed` with ids and dates only, never the reason text. Deleting a conversation or a person SHALL delete the order cards of their conversations.

#### Scenario: Dismiss races save
- **WHEN** a card is saved and a dismiss for it arrives after
- **THEN** the card stays saved

### Requirement: Home shows the next order
Home's Bar order card SHALL read the board and show the soonest deadline and how many items have a quantity above 0, linking to Orders; with no setup it SHALL say what is missing and link to Ordering setup. It SHALL stay hidden while Home shows onboarding.

#### Scenario: Set up
- **WHEN** the board's soonest order is Wednesday 14:00 with 9 items above 0
- **THEN** the card shows that deadline and "9 items to order" with "Open Orders"
