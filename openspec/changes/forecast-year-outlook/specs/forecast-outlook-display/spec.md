## ADDED Requirements

### Requirement: The Calendar labels the outlook
On the Calendar (P28), on web and native, a day whose read day has `outlook: true` SHALL show its middle figure with "Outlook" as its cell's status line, and its label SHALL read "Outlook about {212} guests, {150} to {290}." in place of "Forecast about …". The week view's column SHALL show the status word "Outlook" with its range line; the tooltip SHALL read "Outlook: about {212} guests ({150} to {290})"; the day panel's section SHALL be headed "Outlook" and read "About {212} guests", then "Likely {150} to {290}. Days more than 3 months away are less certain, so this range is wider." with no "8 in 10" sentence. When the shown days include an outlook day, a line under the grid SHALL read "Days more than 3 months after Townwise's last refresh show its outlook: a wider range that firms up as the weeks pass and your new sales come in." [CONFIRM: the outlook's words on the Calendar, Home and TownwiseAI's visuals: a cell's middle figure marked "Outlook", its range in the day panel, and no "8 in 10" claim for an outlook day]

#### Scenario: An outlook cell
- **WHEN** the Calendar shows a day with `outlook: true`, mid 212, low 150, high 290
- **THEN** its cell shows 212 with "Outlook" as its status line, and its label reads "Outlook about 212 guests, 150 to 290."

#### Scenario: A forecast cell is unchanged
- **WHEN** the day has `outlook: false`
- **THEN** its cell, label, tooltip and panel read as before this change, including the 8 in 10 sentence

#### Scenario: No key line without the outlook
- **WHEN** the shown month has no outlook day
- **THEN** no key line shows

### Requirement: Home labels the outlook
Home (P11) SHALL word an outlook day as the Calendar does in This month's cells, labels and tooltip, its day detail's row headed "Outlook" with "About {212} guests, likely {150} to {290}.", and This week's Forecast cell "Outlook: about {90} guests, {67} to {113}". Home SHALL still never compute, sum or adjust a forecast figure.

#### Scenario: A stale run on Home
- **WHEN** the newest published run is 100 days old and This month shows its days
- **THEN** the days after its forecast tier read "Outlook" in the grid and the day detail

### Requirement: TownwiseAI's visuals label the outlook
A daily visual's words (`client/src/chat/visuals/words.ts`) SHALL count the "about 8 in 10" sentence's days without outlook days and add "Days marked outlook have a wider range." when any day is one, and its hover (`client/src/chat/visuals/hover.ts`) SHALL read "Outlook about {180}, likely {117} to {256}" for one.

#### Scenario: A visual with an outlook day
- **WHEN** a daily visual's band covers 10 days, 2 of them outlook days
- **THEN** its words count 8 days for the 8 in 10 sentence and add the outlook sentence

### Requirement: The model card and public copy
When runs reach a year (release B), the model card's estimates line (`api/src/estimates/about.ts`) SHALL say forecasts reach up to a year ahead, the first 3 months as the forecast and the rest as an outlook with a wider range, with a limit that days more than 3 months ahead don't yet know events the town hasn't announced, and `MODEL_CARD_VERSION` SHALL change; the card's range line (`client/src/portal/estimates/ModelCard.tsx`) SHALL limit "about 8 in 10" to the first 3 months and say the outlook's ranges are wider on purpose; the public homepage and the privacy page SHALL say "up to a year ahead, the first three months as a forecast and the rest as a wider outlook" in place of "up to three months ahead", the privacy page's Last updated date bumped; each approved by the owner before push. [CONFIRM: the model card's and the public words for a year of forecast]

#### Scenario: The homepage
- **WHEN** a visitor opens the homepage after release B
- **THEN** its line names a year ahead with the outlook, pinned by `client/test/marketing/home.test.web.tsx`
