# item-sales Specification

## Purpose
TBD - created by archiving change complete-bar-ordering. Update Purpose after archive.
## Requirements
### Requirement: The browser reads and matches a point-of-sale item export
The upload SHALL read a CSV or Excel file in the browser, propose the date, item and quantity columns (presets: Toast "Business Date", "Menu Item", "Item Qty"; Square "Date", "Item", "Qty"), let the person change them, assign a timestamp before 04:00 to the previous business day, and match each item name (trimmed, case-folded) to the setup's point-of-sale names. A matched row adds quantity x servings per sale to that item's servings for that day; a name listed under several items adds to each.

#### Scenario: Unmatched names stay in the browser
- **WHEN** a file has rows for 30 item names and 22 match the setup
- **THEN** the page lists the 8 unmatched names with "Add to an item", and the request body holds item ids, dates and servings only

#### Scenario: No date column
- **WHEN** the file has no column that reads as dates
- **THEN** the page says the export needs one row per day or per sale and sends nothing

### Requirement: Item sales are stored per day and replaced by range
The system SHALL accept `{ from, to, days: [{ date, items: { itemId: servings } }] }` with at most 31 days, `to` before the town's today (today is still open), each date inside `[from, to]` and unique, at most 500 items per day, servings from 0 to 100,000, and SHALL store one record per location and date. For an org admin's upload (staff opened as admin included) it SHALL upsert every sent day and then delete stored days inside `[from, to]` that were not sent, answering `{ stored, removed, kept: 0 }`. For a member's upload it SHALL insert only the sent days not already stored, leave every stored day as it was and delete nothing, answering `{ stored, removed: 0, kept }`, where `kept` counts the sent days already stored. A stored day means every item absent from it sold zero that day. Two replacing uploads over overlapping ranges at once SHALL leave each day as whichever wrote it last. [CONFIRM: members add only item-sales days not already stored; org admins replace]

#### Scenario: Today is still open
- **WHEN** an upload's range ends on the town's today
- **THEN** the system answers 400 `invalid_request` and stores nothing

#### Scenario: Re-upload a range
- **WHEN** a range of 7 days was stored and an org admin's new upload for the same range sends 6 of them
- **THEN** the 6 days are replaced and the seventh is deleted

#### Scenario: A member sends no day, or an empty day
- **WHEN** a range of 7 days was stored and a member uploads the range with no day, or with every day and no items
- **THEN** no stored day is deleted or changed, and the answer counts the days sent as `kept`

#### Scenario: A member adds a new day
- **WHEN** a member uploads a stored day and a day not stored
- **THEN** the new day is stored, the stored day stays as it was, and the answer is `{ stored: 1, removed: 0, kept: 1 }`

#### Scenario: Retry after a failure
- **WHEN** an upload fails after its upserts and is sent again
- **THEN** the second request completes it with the same result as one success

### Requirement: Who may upload and delete item sales
Every member SHALL be able to upload item sales, adding only days not already stored; only an org admin (staff opened as admin included) SHALL replace stored days by upload, or delete a location's item sales. Writes SHALL be refused under view-as. Uploads SHALL use their own `item_sales` limiter (`townwise:item-sales`, 60 an hour per account), apart from the sales uploads' `uploads`. [CONFIRM: members upload, org admins delete; 60 item sales uploads an hour] [CONFIRM: members add only item-sales days not already stored; org admins replace]

#### Scenario: Member deletes
- **WHEN** a member who is not an org admin deletes item sales
- **THEN** the system answers 403

### Requirement: Item sales go with the location's sales data
Deleting the location's sales data, the location or the organization SHALL delete its item sales. Each upload SHALL write `order.item_sales_uploaded` with day count, item count, first and last date, the count of stored days it deleted and the count of sent days it kept only, and each delete `order.item_sales_deleted` with the day count. A location with item sales SHALL not be deleted (409 `location_has_data`) until they are.

#### Scenario: Sales data deleted
- **WHEN** an org admin deletes the location's sales data
- **THEN** its item sales are deleted too and its setup and counts are kept

### Requirement: Coverage is visible
The setup page and `get_order_setup` SHALL show the first and last covered date, the number of covered days, and, per item, the number of covered days in the last 8 weeks with any servings.

#### Scenario: Item never sold
- **WHEN** an item has no servings in any covered day
- **THEN** the setup page marks it "No sales matched" so the owner can check its point-of-sale names

