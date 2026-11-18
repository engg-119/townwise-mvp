## ADDED Requirements

### Requirement: Staff land on an Overview page
The staff console SHALL have an Overview page at `/admin/overview`, first in the console's navigation (Overview, Requests, Organizations, People, Audit log). Staff SHALL land on it after sign-in and from the console's wordmark. `/admin` SHALL stay Requests, with its links, notices and pending count unchanged. Only a person whose access is `staff` SHALL open it.

#### Scenario: Staff sign in
- **WHEN** a staff member signs in and passes two-step sign-in
- **THEN** the console opens on Overview, with Overview marked current in the navigation

#### Scenario: Requests is unchanged
- **WHEN** a staff member opens `/admin`
- **THEN** Requests shows as before, with its pending count in the navigation

#### Scenario: A member tries the page
- **WHEN** a member opens `/admin/overview`
- **THEN** they are sent to their own home and the API answers 403 to the page's read

### Requirement: The overview read covers a window and the window before it
`GET /api/admin/overview?days=<n>` (policy `staff`) SHALL accept `days` of 7, 28 or 90 and answer 400 otherwise. The window SHALL be the last `days` UTC days, today included, and the previous window the `days` days before it. The answer SHALL give, for the window and the previous window: active organizations of the active organizations someone has joined, active people of the active seats in active organizations, TownwiseAI turns completed, sales uploads, notes written and order decisions saved. A person or organization SHALL count as active when it has an active day in the window. The previous value of active organizations and active people SHALL be null when the previous window starts before the earliest recorded active day. Only events whose actor role is `member` or `org_admin` SHALL count as actions, with one exception: a `sales.uploaded` event made by staff in staff setup (actor role `superadmin` with no view-as or open-as-admin grant) SHALL count in the sales uploads total, the series' uploads and its organization's actions. No other staff, view-as, open-as-admin or system event SHALL count. Staff SHALL never count as active people, so staff setup never adds to active people or active organizations.

#### Scenario: A 28-day window
- **WHEN** staff read the overview with `days=28`
- **THEN** each total has its count for the last 28 days and for the 28 days before

#### Scenario: Before the record existed
- **WHEN** the previous window starts before the first recorded active day
- **THEN** active organizations and active people have no previous value, and the page says no earlier days are recorded

#### Scenario: A staff setup upload counts as an upload
- **WHEN** a staff member uploads sales for an organization in staff setup
- **THEN** it counts as a sales upload, in that day's uploads and in the organization's actions, and active people stay unchanged

#### Scenario: Staff opened as admin is not usage
- **WHEN** a staff member opened as an organization's admin uploads sales or writes a note
- **THEN** neither counts as a sales upload, a note written or an action

#### Scenario: An unsupported window
- **WHEN** staff ask for `days=10`
- **THEN** the API answers 400

### Requirement: Activity by day groups people's actions by kind
The answer SHALL include one entry per day of the window, oldest first and with zeros, holding the number of active people that day and the number of people's actions that day in five groups: uploads and data, notes rules and calendars, TownwiseAI, orders, and team and settings. Every audit action SHALL belong to exactly one group or to none, by one table that a test checks against the full list of audit actions. The page SHALL draw people active and the grouped actions per day as bars on web, with the same numbers in text and a table, never by color alone.

#### Scenario: A new audit action
- **WHEN** a developer adds an audit action without placing it in the table
- **THEN** a test fails

#### Scenario: Reading the chart without sight
- **WHEN** a screen reader reaches the activity section
- **THEN** it reads a summary and a table of each day's counts, and the chart itself is hidden from it

### Requirement: Each organization has a row of usage and forecast health
The answer SHALL have one row per organization with its name, status, whether it is in staff setup, its last active day, its active people and actions in the window, its days of sales and last upload, whether its forecasts are on, this UTC month's TownwiseAI spend against the monthly budget, and for each location the newest published run's dates, the window's live accuracy (typical error percent with its scored-day and in-range counts, or none under 5 scored days), the latest weekly refresh outcome and the status of its newest scheduled calibration. Each row SHALL link to the organization's page. The answer and the page SHALL carry no sales figure, guest count, note text, chat text or email address.

#### Scenario: An organization with a published forecast
- **WHEN** a location has a published forecast with 21 scored days in the window
- **THEN** its line shows the newest run's date and its typical error with 21 days and the number in range, and no guest count

#### Scenario: No figures leak
- **WHEN** an organization has sales, notes and TownwiseAI conversations
- **THEN** the overview's answer holds none of their figures or words

### Requirement: Needs attention lists what staff should act on
The answer SHALL list, independent of the window: each access request pending more than 2 days; the weekly refresh being off on the server or paused by staff; an organization with a location whose newest scheduled calibration failed or whose latest week could not start; an active organization out of setup, with a location, and no applied upload in 14 days; an organization still in staff setup; an organization with invitations unanswered after 7 days; and an organization that has spent more than 80% of the month's TownwiseAI budget. Each item SHALL carry its kind, its organization where it has one, its request where it is one, and the page SHALL link each to where it is acted on. When nothing applies the page SHALL say so.

#### Scenario: A waiting request
- **WHEN** an access request has been pending for 3 days
- **THEN** Needs attention lists it with a link to that request on Requests

#### Scenario: A quiet organization
- **WHEN** an active organization's last applied upload was 16 days ago
- **THEN** Needs attention lists it with a link to its page

#### Scenario: Nothing to do
- **WHEN** no rule applies
- **THEN** the page says nothing needs attention

### Requirement: Changing the window keeps the last answer on screen
The page SHALL offer 7, 28 and 90 days as links (`?days=`), with 28 when none is given. While another window's answer loads, the page SHALL keep showing the last answer, and SHALL show its loading skeleton only before its first answer. Each stat SHALL state its change against the previous window in words.

#### Scenario: Switching to 90 days
- **WHEN** staff viewing 28 days choose 90 days
- **THEN** the 28-day figures stay on screen until the 90-day answer replaces them, with no skeleton in between

#### Scenario: A change in words
- **WHEN** active people rose from 6 to 9
- **THEN** the tile reads "9" with "Up 3 from the 28 days before"
