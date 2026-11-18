## Why

On 2026-11-18 the owner exported the partner restaurant's master calendar as a CSV (1,067 events, 2023-11-18 to 2027-11-05, one calendar, Google Calendar API field names) and asked three things: "test out parsing and rendering with the townwise data agent", that the data agent read big CSVs, and "we may need to retrain the model based on these events", so the forecast learns from the restaurant's past and future bookings.

Today none of that works:

- **Your calendars** imports only `.ics` (`api/src/calendar/ics.ts`). A CSV is refused `not_calendar`.
- **Read with TownwiseAI** (D34, `api/src/files/extract/`) sends a text file's first 300,000 characters. This file is 596,304 bytes sorted oldest first, so the model would see rows through 2025-03-21 (591 of 1,067), never a future booking, and D34 would write up to 50 of those old events as notes without a second press. A chat attachment (D36) sends 20,000 characters.
- **Even as an `.ics`**, a calendar keeps only events within 400 days of today: 279 of the 1,067. The 788 older events, the ones that overlap the sales history the model trains on, would be dropped.
- **The forecast** learns private events only from notes (`api/src/lab/input.ts` `labInputOf`). Notes are capped at 1,000 per location and each is made by hand or accepted one at a time (D53, 5 a week, 91 days ahead). Hundreds of past bookings cannot get there.

Measured shape of the file, which rules out the simplest design: 58% to 68% of days in 2024 and 2025 have at least one event, and so do 92% of Fridays and 95% of Saturdays. Fewer than 30% of titles read like a party or celebration. About 12% read like a hold or tentative entry, 6% like a meeting, 2% like catering, and 11 say buyout. About 60% match none of those words, and about 400 events start at 20:00 or 21:00 and run 1 to 3 hours. If every event counted as a private event, the flag would be almost the same as the weekday and would teach the model nothing.

## What Changes

- **Your calendars imports a calendar CSV, parsed in code.** "Import a calendar file" accepts `.csv` beside `.ics`. The server detects a calendar CSV by its header row (the profile this export uses: `event_id`, `title`, `start_at`, `end_at`, optional `status`), reads each row deterministically with the same town clock, hours and late-night rules as `.ics`, and stores the same fields it keeps for `.ics`: a uid, a title cut at 200 characters, dates and hours. It never reads descriptions, locations, organizer or attendee fields, attachments, calendar ids or Google URLs. Recurring instances are imported, since the export lists each one. No model call.
- **A file calendar keeps 3 years of history.** File calendars (CSV or `.ics`) keep events from 1,096 days before the town's today to 400 days after, at most 2,000, keeping upcoming events first as Google calendars already do. Links and Google calendars keep their 400-day window. The Calendar, Home and TownwiseAI chat's `get_owner_calendar`, which already reads any past range back to 2010 in 92-day pages, show the history with no further change.
- **Your data recognizes a calendar export.** A stored text file whose header is a calendar CSV is kept `calendar_export`: it is not read for sales, Read with TownwiseAI does not send it to the model and writes no notes from it, and its page says to import it in Your calendars.
- **Each event of a file calendar gets a booking label, which an org admin confirms.** The labels are `buyout` (takes the whole restaurant), `party` (a private party alongside regular service), `own_event` (the restaurant's own public event) and `other` (not a booking: catering, a meeting, a hold), or none. An org admin presses "Sort with TownwiseAI" on the calendar's page. That makes one bounded set of structured calls sending the events' titles (emails and phone numbers removed), dates and hours, and the answer is checked in code. The admin reviews and edits the labels, then presses "Use for forecasts". Until then labels change nothing.
- **Confirmed labels train the forecast on past days.** The lab input reads them on history days only. A `buyout` books the day, so the model never learns walk-ins from it. A `party` sets the day's `privateEvent`. A note on the day still decides, and labels never change `closed`, the likely-closed test or the guests sent. The lab's code, the input schema (`townwise.lab-input/2`) and `LAB_MODEL_VERSION` (v9) are unchanged. The input fingerprint changes, so the weekly refresh refits that location, and confirming also starts a refit for the admin when they have a start left.
- **Confirmed labels on upcoming events become linked notes.** Confirming makes a private-event note for each upcoming `buyout` or `party` event that no note links or covers: effect closed or more guests, no title, no count, `fromEvent` set, as D53's accept writes one. At most 100 per confirm. The forecast read applies them as it applies any note, so editing or deleting one changes the forecast at once. D53's weekly call leaves out labeled events.
- **Privacy words change before this runs in production.** The privacy page, the import popover and the calendar page say that a CSV's titles, dates and hours are kept (never its other columns), and that Sort with TownwiseAI sends the titles, dates and hours to Anthropic once, when an org admin presses it.

## Capabilities

### New Capabilities
- `calendar-csv-import`: detecting and parsing a calendar CSV, what is kept, the file calendars' history window, and how Your data treats a calendar export.
- `calendar-booking-labels`: the per-event booking labels, the TownwiseAI sort and its checks, the admin's review and confirm, and the notes confirm makes for upcoming events.
- `bookings-in-training`: how confirmed labels reach the lab input, their precedence under notes, refits, and D53's weekly call leaving labeled events out.

### Modified Capabilities
None in `openspec/specs/` (it holds only `order-setup-read` and `top-bar-groups`). This change extends unarchived changes' capabilities (`connect-owner-calendar`, `read-files-with-townwise-ai`, `calendar-event-suggestions`, `autonomous-forecasts`). Its requirements are written as new ones so they validate on their own, and they fold in when those are archived.

## Impact

- Spec decision **D58** (D57 is the highest on develop and in the reservation list; check both again before writing it). CONFIRM index items numbered after develop's last, 129 today, and renumbered before push.
- API: new `api/src/calendar/csv-events.ts`, `api/src/calendar/ics.ts` (`keepWindow` takes a history length; a `parseCalendarFile` entry that picks the format), `api/src/handlers/owner-calendars.ts` (file add accepts either format; new sort, label and confirm handlers), `api/src/stores/owner-calendars.ts` (`format` and `bookings` on sources; `booking`, `bookingBy`, `bookingAt` on event rows; `bookingsBetween`), new `api/src/calendar/booking-sort.ts`, `api/src/access/routes.ts` (three routes), `api/src/lab/input.ts` (`bookings` in `labInputOf`, read in `buildLabInput`), `api/src/lab/suggestions.ts` (leave out labeled events), the stored-file reader's header step and `api/src/files/ai-reader.ts` (skip `calendar_export`), audit actions `owner_calendar.bookings_sorted` and `owner_calendar.bookings_confirmed`.
- Client: `client/src/portal/calendar/IcsImport*.tsx` and `calendars.ts` (accept `.csv`, label from the file name), `client/src/portal/data/item/CalendarItem.tsx` (the Bookings section), the Your data file outcome words, `client/app/(marketing)/privacy.tsx`.
- Docs: `docs/portal/spec.md` (D58, 6.x for the new fields, 10.18, 11A.4, 11A.9, 14.5, 17, CONFIRM index, changelog), `api/README.md` (routes, fields, audit), `docs/portal/tuning-chat.md` (section 9: labeled events are not sent weekly), `client/MODULE.md` (Local changes only if a kit file is touched; none planned).
- No new collection, env var, lab code change, input schema change or model version bump. No change to the chat's frozen prefix.
- Not in this change: reading guest counts from descriptions, a lab feature for `own_event`, updating a file calendar from a newer export, and model reads of big non-calendar CSVs (design, Open Questions).

## Owner sign-offs needed before the training half is built

Tasks group 0 lists the questions. The import half (tasks 1 to 4) needs only the [CONFIRM] defaults. The labels half (tasks 5 to 9) waits on the owner's answers about what the master calendar holds, because the sort's label definitions and the prompt come from them.
