## Why

On 2026-11-15 the owner reviewed the Calendar and Home in the browser and asked for eight changes to how they read and behave: panels that push the page around should float, week cards should show whole names, the week should start on today, a new page should open at its top, sources should look the same everywhere, "your average day" should say what that day is, and the forecast's reasons should be colored and ordered by what they do to the number of guests. Each is small, they touch the same pages, and the calendar-views and connect-owner-calendar changes they amend are not archived yet, so they go together as one change.

## What Changes

- **"Your calendars" opens a popover** (request 1). The header button opens the calendars list, the import, Add a link and "How importing works" in a popover anchored to the button, on web and native, instead of the full-width panel under the header row. This reverses the 2026-11-14 decision recorded in spec D33, P28's Your calendars bullet and connect-owner-calendar design decision 11.
- **"Add an event" opens a popover** (request 2). The day panel's note form opens in a popover anchored to the button pressed (Add an event, and also Edit and Make a note), instead of replacing the button inside the panel.
- **Week cards wrap** (request 3). Every week card, term and season cards included, wraps its title onto as many lines as it needs, so "Fall term finals" is never cut to "Fall term fin...".
- **Today on the left** (request 4). The Calendar's Week view and Home's strip start on today and show today and the next 6 days when they load, not Monday to Sunday. The week view's weeks are 7-day blocks counted from today and read their own days. Home's "This week in {Town}" becomes "The next 7 days in {Town}", with its wording and its "This week, last year" tile to match.
- **New pages open at the top** (request 5). Moving to another page (a different path) shows the new page scrolled to its top, on web and native; a change of query on the same page (the Calendar's `?day=` and `?view=`) keeps the scroll.
- **Sources are round chips with the site's logo and name** (request 6), everywhere the portal and TownwiseAI show a source link. Logos are fetched once by a script and committed as assets, with a plain globe for a site without one; nothing loads from another site at view time, so the CSP is unchanged. The public marketing pages' source links and TownwiseAI's row words (which print hosts) stay as they are, each with a [CONFIRM] for the owner.
- **"Your average day" carries its number** (request 8): "Usually about 35% fewer guests than your average day (210)". **BREAKING (additive):** the forecast read's run reason `effect` gains `averageGuests`.
- **Why is colored and ordered by effect** (request 9). Each reason's mark (▲ ▼ =) is colored by its effect on guests, greener the bigger the rise and redder the bigger the fall, and the reasons run from most positive to most negative. Notes and rules that change guests get a mark too, and a buyout's words gain its comparison with Townwise's model, so the words still say everything the color says.
- Connecting a Google calendar (request 7) is its own change and is not part of this one.

## Capabilities

### New Capabilities
- `home-next-seven-days`: Home's strip, its words and its "last year" tile cover today and the next 6 days.
- `page-navigation`: a move to another page shows it at its top; a query change on the same page keeps the scroll.
- `source-chips`: how every source link looks and is named, the committed logos and the globe fallback, and the script that fetches them.
- `forecast-why`: the colored, graded marks on Why's reasons, their order from most positive to most negative, and the average day's number in parentheses (with the API field behind it).

### Modified Capabilities
- `calendar-views` (from the unarchived `calendar-views` change): the header row's trailing slot holds only the "Your calendars" button, with no line under the row; the week view starts on today and reads its own days; its keys, labels, failure notice and URL scenarios follow; week cards wrap; the day panel's note form opens in a popover.
- `owner-calendar` (from the unarchived `connect-owner-calendar` change): the "Your calendars" panel becomes a popover anchored to its button.

## Impact

- Client: `client/src/portal/calendar/` (CalendarPage, CalendarDay, CalendarWeek and its `.web` sibling, grid.ts, model.ts, YourCalendars.tsx, Toolbar.tsx), `client/src/portal/locations/NoteForm.tsx` (a `bare` form for the popover), `client/src/portal/home/` (ThisWeek, Glance, DayDetail, ThisMonth, InTown, Home), `client/src/portal/analytics/week.ts` and `DayPanel.tsx`, `client/src/portal/estimates/` (Provenance, api.ts), `client/src/portal/town/TownProfile.tsx`, `client/src/chat/ui/ToolGroup.tsx`, `client/src/portal/shell/Frame.tsx`, `client/src/portal/ui/` (a new Popover and a new SourceChip, Button, aria.ts), `client/src/theme.ts` and `client/public/index.html` (the logo backing and effect color tokens), a new `client/src/assets.d.ts` (the `*.png` declaration), new `client/assets/sources/`, `client/src/portal/sources/` and `client/scripts/source-logos/`.
- API: `api/src/forecasts/effects.ts` adds `averageGuests` to a weekday history effect; it reaches the forecast route and TownwiseAI's `get_forecast` result unchanged (`api/src/chat/tools/forecast.ts` gains one clause in its description, a frozen-prefix change: one prompt cache miss per conversation). No new route, collection or env var.
- Docs: `docs/portal/spec.md` (D40, D33, P11, P28, 14.4, the source links of P11, P15, P24, P25 and 13.2), `api/README.md` (the forecast day's `effect`), `docs/portal/tuning-chat.md` (`get_forecast`), `client/MODULE.md` (the committed logos under Security, and this change under Local changes), `client/src/portal/README.md` (the shared pieces and P28's row).
- No new npm dependency. No CSP change: logos are same-origin bundled assets, which `img-src 'self'` already allows.
