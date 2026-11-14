## ADDED Requirements

### Requirement: The browser reads and matches a point-of-sale item export
The upload SHALL read a CSV or Excel file in the browser, propose the date, item and quantity columns (presets: Toast "Business Date", "Menu Item", "Item Qty"; Square "Date", "Item", "Qty"), let the person change them, assign a timestamp before 04:00 to the previous business day, and match each item name (trimmed, case-folded) to the setup's point-of-sale names. A matched row adds quantity x servings per sale to that item's servings for that day; a name listed under several items adds to each.

#### Scenario: Unmatched names stay in the browser
- **WHEN** a file has rows for 30 item names and 22 match the setup
- **THEN** the page lists the 8 unmatched names with "Add to an item", and the request body holds item ids, dates and servings only

#### Scenario: No date column
- **WHEN** the file has no column that reads as dates
- **THEN** the page says the export needs one row per day or per sale and sends nothing

### Requirement: Item sales are stored per day and replaced by range
The system SHALL accept `{ from, to, days: [{ date, items: { itemId: servings } }] }` with at most 31 days, each date inside `[from, to]` and unique, at most 500 items per day, servings from 0 to 100,000, and SHALL store one record per location and date. It SHALL upsert every sent day and then delete stored days inside `[from, to]` that were not sent. A stored day means every item absent from it sold zero that day.

#### Scenario: Re-upload a range
- **WHEN** a range of 7 days was stored and a new upload for the same range sends 6 of them
- **THEN** the 6 days are replaced and the seventh is deleted

#### Scenario: Retry after a failure
- **WHEN** an upload fails after its upserts and is sent again
- **THEN** the second request completes it with the same result as one success

### Requirement: Who may upload and delete item sales
Every member SHALL be able to upload item sales; only an org admin (staff opened as admin included) SHALL delete a location's item sales. Writes SHALL be refused under view-as. Uploads SHALL use the `uploads` limiter. [CONFIRM: members upload, org admins delete]

#### Scenario: Member deletes
- **WHEN** a member who is not an org admin deletes item sales
- **THEN** the system answers 403

### Requirement: Item sales go with the location's sales data
Deleting the location's sales data, the location or the organization SHALL delete its item sales. Each upload SHALL write `order.item_sales_uploaded` with day count, item count, first and last date only, and each delete `order.item_sales_deleted` with the day count.

#### Scenario: Sales data deleted
- **WHEN** an org admin deletes the location's sales data
- **THEN** its item sales are deleted too and its setup and counts are kept

### Requirement: Coverage is visible
The setup page and `get_order_setup` SHALL show the first and last covered date, the number of covered days, and, per item, the number of covered days in the last 8 weeks with any servings.

#### Scenario: Item never sold
- **WHEN** an item has no servings in any covered day
- **THEN** the setup page marks it "No sales matched" so the owner can check its point-of-sale names
