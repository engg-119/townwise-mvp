## ADDED Requirements

### Requirement: The client bar groups four sections under More
The client app's top bar SHALL show a location's sections Home, Calendar, Orders, Analytics and TownwiseAI, then one control named "More", then the right-hand group (Team for org admins outside open as admin, and Settings). More SHALL hold Notes, Rules, Town and Your data, in that order. With no location the bar SHALL show only the right-hand group and no More. The gate and console bars SHALL be unchanged. [CONFIRM: Notes, Rules, Town and Your data under More]

#### Scenario: An org admin on a location page
- **WHEN** an org admin opens `/locations/l1`
- **THEN** the bar's nav reads Home, Calendar, Orders, Analytics, TownwiseAI, More, Team, Settings, and Notes, Rules, Town and Your data are not shown until More is opened

#### Scenario: No location yet
- **WHEN** a member with no location opens `/dashboard`
- **THEN** the nav holds only Settings and there is no More

### Requirement: More is a disclosure
More SHALL be a button with `aria-expanded` and, on web, `aria-controls` naming its links' container. Pressing it SHALL toggle its links. On web above 640px the links SHALL open in a box under More, inside the Main nav, over the page. On phones and in the native apps they SHALL open in a row under the bar, labeled "More". Escape SHALL close it and return focus to More. A press or focus outside More and its links SHALL close it, and so SHALL moving to another page or location.

#### Scenario: Keyboard
- **WHEN** a keyboard user focuses More, presses Enter, then Tab
- **THEN** the links open and focus moves to Notes; Escape then closes them and focuses More

#### Scenario: Following a link
- **WHEN** someone opens More and follows Town
- **THEN** Town's page opens and More's links are closed

### Requirement: More shows where you are
More SHALL be drawn white while open, hovered, or when one of its sections is the current page, or a page below one (Your data on Upload and an item's page). That section's link SHALL keep its `aria-current` (`page`, or `true` below it). On phones the scrolling row SHALL keep More in view when one of its sections is current.

#### Scenario: On Upload
- **WHEN** an org admin is on `/locations/l1/sales/upload`
- **THEN** More is drawn white, and once opened Your data carries `aria-current="true"`
