## ADDED Requirements

### Requirement: A location keeps one ordering setup
The system SHALL keep, per location, one ordering setup holding up to 20 suppliers and up to 300 items. A supplier has a name (1 to 60 characters) and 1 to 7 deliveries, each a delivery weekday, an order-by weekday and an order-by time (HH:MM, 24 hour, the town's zone). An item has a name (1 to 80 characters), a supplier from the same setup, a category (`bottles_cans`, `draft`, `liquor` or `cocktail_ingredient`), a unit (`cases`, `kegs`, `bottles` or `units`), servings per unit (0.1 to 2,000) [CONFIRM: at least 0.1 servings per unit, so one sale never orders thousands of units], a par (0 to 999), a deal size (1 to 999, or none), a never-run-out flag, and up to 10 point-of-sale names, each with servings per sale (greater than 0, at most 50; default 1).

#### Scenario: First save
- **WHEN** a member puts a setup with `expectedVersion: 0` for a location with none
- **THEN** the system stores it with version 1, mints an id for every supplier and item sent without one, and answers with the stored setup

#### Scenario: Item with an unknown supplier
- **WHEN** a setup names an item's supplier id that is not in its suppliers
- **THEN** the system answers 400 and stores nothing

### Requirement: Setup edits use compare-and-set
The system SHALL save a setup only when `expectedVersion` equals the stored version, incrementing the version on save, and SHALL answer 409 `setup_changed` otherwise.

#### Scenario: Two people edit at once
- **WHEN** two members load version 3 and both save
- **THEN** the first save stores version 4 and the second answers 409 `setup_changed`

### Requirement: Who may manage the setup
Reading and saving the setup SHALL be allowed for every member of the organization, staff opened as admin included, and saving SHALL be refused under view-as. A location id from another organization SHALL answer 404. [CONFIRM: every member may edit the ordering setup]

#### Scenario: Cross-tenant read
- **WHEN** a member of organization A reads the setup of a location in organization B
- **THEN** the system answers 404

### Requirement: Items can be imported from a sheet
The setup page SHALL offer a template (CSV) with the columns Item, Supplier, Category, Unit, Servings per unit, Par, Deal size, Never run out, Point-of-sale names, and SHALL read a filled CSV or Excel file in the browser into the item table, creating suppliers named in it, for the person to review before saving.

#### Scenario: Import a filled template
- **WHEN** a person imports a template with 40 rows and 3 supplier names
- **THEN** the table shows 40 items under 3 suppliers, unsaved, with rows that fail a check marked

### Requirement: Setup changes are audited and deleted with their location
Each save SHALL write an `order.setup_saved` audit event with the supplier and item counts only. Deleting the location or the organization SHALL delete its setup.

#### Scenario: Audit details carry counts only
- **WHEN** a member saves a setup with 2 suppliers and 12 items
- **THEN** the audit event's details are exactly `{ locationId, supplierCount: 2, itemCount: 12 }`
