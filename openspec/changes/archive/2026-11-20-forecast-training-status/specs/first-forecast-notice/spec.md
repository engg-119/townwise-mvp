## ADDED Requirements

### Requirement: Org admins get one email when a location's first forecast is published
After a run's publish has applied and nothing else of the publish is left (in the lab path, after the calibration finished; in the staff publish route, after its compare-and-set), when no other run of that location ever had a `publishedAt` at or before it, the API SHALL find each active `org_admin` seat of the organization that has a user; when there is at least one, it SHALL claim `tw_locations.firstForecastMailedAt` by compare-and-set (set only when absent) and, only when it won the claim, SHALL queue a `first_forecast` email to each of them at that user's current address. With no such admin it SHALL send nothing and claim nothing. A location whose marker is set SHALL never get the email again, whether its sales are deleted and uploaded again or its runs withdrawn and republished. The mail step SHALL never throw: a failed read, a lost claim, a failed send or email off SHALL NOT change, delay or fail the publish, the calibration's finish or the route's answer, and an error SHALL log only the organization and location ids.

#### Scenario: The first lab run passes the gate
- **WHEN** a location's first calibration is published by the gate in an organization with two active org admins and one member
- **THEN** each admin is sent one `first_forecast` email and the member none

#### Scenario: The callback is retried
- **WHEN** the lab's result is posted twice and both reach the publish step
- **THEN** each admin is sent exactly one email

#### Scenario: A location that already had a forecast
- **WHEN** a location whose earlier run was published and later withdrawn gets a new run published
- **THEN** no email is sent

#### Scenario: Staff publish the first run
- **WHEN** staff publish a location's first draft from the console
- **THEN** the org admins get the email once

#### Scenario: An organization nobody has joined
- **WHEN** staff set up an organization, upload its history, and its first forecast is published while its only admin seat is an invitation
- **THEN** no email is sent and the marker stays absent

#### Scenario: A read fails while mailing
- **WHEN** the member read throws during the mail step of a lab publish
- **THEN** the run stays published, the calibration finishes `succeeded`, and the callback answers 200

### Requirement: The email holds no figure and no person's name
The `first_forecast` email SHALL have a fixed subject with no user text, SHALL name the organization, the location and its town, SHALL hold no forecast or sales figure and no person's name, SHALL link only to the web app's sign-in page, its root and its privacy page, and its footer SHALL say it was sent because the recipient is an admin of the organization. Its log lines SHALL carry the kind, the organization id and the location id, never the address. Sending SHALL write no audit event. The privacy page, D14 and the mailer's header SHALL say Townwise sends three emails, that this one goes to every org admin once per location, and that Townwise keeps the date it was sent on the location.

#### Scenario: The rendered email
- **WHEN** the email is rendered for a location named "Main Street" in Hanover, NH
- **THEN** the subject is "Your first Townwise forecast is ready", the body names Main Street and Hanover, NH, and no number appears in it

### Requirement: Home shows the first forecast as it builds and once it lands
For a location with no published run, Home SHALL show a first-forecast line while its calibration `updating` is not null ("next" while waiting, "Building" while running), SHALL show the published forecast once it is published without a reload, and SHALL otherwise keep its no-forecast line, which states no minimum history, or the not-published notice when the location has a `lastRun` that was not published. The onboarding history step SHALL keep opening Home once the history is read.

#### Scenario: History under the minimum
- **WHEN** a location's history is too short for the pass to start a forecast
- **THEN** Home shows the existing no-forecast line and states no number of days

#### Scenario: Onboarding to a published first forecast
- **WHEN** an org admin finishes onboarding with 700 days, Home opens and the first run is published 40 minutes later
- **THEN** Home showed the first forecast as next, then building, and shows the forecast within one poll of the publish
