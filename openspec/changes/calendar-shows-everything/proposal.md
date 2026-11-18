## Why

On 2026-11-17 the owner reviewed the Calendar and asked for two things, in his words:

1. "on the calendar and anywhere the calendar shows up e.g., in a week / month view on the home page or somewhere else calenda rin chat components etc, we should show all thigns going on. e.g, if it is closed and has a private event we should show both of those and ideally show the name of the private event"
2. "we should also have links from the calendar to their calendar that is attached or the source if we uploaded a calendar and that calendar should render nicely in the your data page on a detail page for that calendar"

His screenshot showed a BOOKED month cell with no entries; a tooltip reading "Mon, Nov 16, 2026 / No data. Booked for a private event / Fall term classes / Private event booked", with no event name; CLOSED cells showing nothing else; and "Veterans Day" listed twice on Nov 11. The day panel shows "From your calendar: Veterans Day" from his linked calendar with no way to reach that calendar, while town events already carry source chips.

The causes, read from develop at 85563ceb: notes have no name, only kind words and a free-text detail that cells never show; each surface builds its own list of a day's entries, and the month cell's and tooltip's lists leave out rules and, in the tooltip, every entry once the forecast has reasons; Home builds a third list from a separate `DayContext` and never reads the owner's calendars; nothing merges the town calendar's "Veterans Day" with the same title from the owner's linked calendar, and the API's `reasonViews` never merges two reasons with one label. By the owner's rule (2026-11-16), features he asks for ship on by default. Spec decision **D49**.

## What Changes

- **One "everything on a day" helper** (`client/src/portal/calendar/entries.ts`, new, pure) is the single source for the Calendar's month cell, tooltip, week cards and day panel, Home's This week, This month grid, day detail and month list, and native. Each shows the day's status (closed, booked, likely closed, and d6's no data and no forecast) together with its entries: the owner's notes, scheduled business rules, holidays and town events, and imported calendar events. Status never hides an entry. Each surface keeps a size limit with "+N more", set out per width in the design.
- **Notes gain an optional event name.** `title`, 1 to 120 characters, trimmed, or null ([CONFIRM: 120 characters, matching the file reader's event titles]). Cells, tooltips and cards show it, falling back to today's kind words ("Private event, 70"). The note form (C6) gets "Event name", on web and native. TownwiseAI's file reader fills it from the event's title. Never logged, never in an audit event, never sent to the lab. An edit that leaves `title` out keeps the stored one, so an older app cannot erase it. An `other` note needs a title or a detail.
- **D30 is amended, not broken.** A reason's label stays made in code. Where a note reason's note has a title, a surface may show the title after the label as the person's own words ("Your private buyout, 70 guests: Holiday party"), joined in the client by the reason's `note.id`. A model booking with no note keeps "Booked for a private event".
- **Duplicates show once where space is short.** In cells, the tooltip, week cards, Home's This week and the month list, entries on one day whose titles match (case and spacing folded) show once. The day panel and Home's day detail keep each, with its source. The API's `reasonViews` keeps one run reason per folded label (the larger effect), so Why and the tooltip never say "Veterans Day" twice.
- **Source links.** Each imported event in the Calendar's day panel and Home's day detail links to its calendar's page in Your data. A note TownwiseAI made from a file links to that file's page (P27). No answer, link or page ever shows a link calendar's address: D33 already keeps it out of every answer, and a Google or Outlook iCal address carries a private token. A link calendar's host shows as text, never as a link ([CONFIRM]).
- **Calendars get a page in Your data.**
  - Your data (P26) gains a "Calendars" group listing the location's calendars from the existing list route.
  - Each calendar opens P27 at the ref `c_<calendarId>`, a client-only ref. The page shows the calendar's name, kind, host, count and last refresh, then its events as an agenda grouped by month, one month at a time from the existing events route, each event linking to its day on the Calendar.
  - A stored file whose TownwiseAI read found a calendar (`ai.kind: 'calendar'`) shows its events the same way on its own P27. Each event that became a note links to the note's day on the Calendar.
  - **BREAKING (additive):** the data item's `ai` gains `events`.
- **TownwiseAI.** `list_notes`, `get_day` and `propose_note` carry the title. The note proposal card and the weekly suggestion card show it. No chat visual gains per-day entries in this change: chat visuals are frozen snapshots of figures, so entries would need a server twin of the helper. Kept as an open question for the owner.

## Capabilities

### New Capabilities
- `day-entries`: the shared list of what is on a day, its order, its dedupe, the status beside it, and what each Calendar and Home surface shows at each width; one run reason per label.
- `note-titles`: the note's optional event name in the API, the form, the file reader, TownwiseAI's tools and cards, and its privacy rules; the D30 amendment.
- `calendar-sources`: links from an imported event to its calendar's page and from a TownwiseAI-made note to its file, and what a source link may never hold.
- `calendar-detail`: the Calendars group in Your data, the `c_` calendar page, and the agenda of a calendar file's events on its P27.

### Modified Capabilities
None under `openspec/specs/`. The Calendar's and owner calendars' requirements live in the unarchived `calendar-views`, `connect-owner-calendar`, `connect-google-calendar` and `refine-calendar-and-home` changes. This change adds to them without restating them. The design lists which of their requirements it narrows.

## Impact

- API:
  - `stores/notes.ts`, `handlers/notes.ts` (`title`, the keep-on-omit edit, the `other` rule, rule schedules refuse it);
  - `forecasts/reasons.ts` (one run reason per label; note reasons unchanged, since the client joins the title by `note.id`);
  - `files/ai-actions.ts` (title from the event, detail its own, the duplicate check);
  - `handlers/data.ts` (`ai.events`);
  - `chat/tools/notes.ts`, `day.ts`, `propose-note.ts` and their descriptions (a frozen-prefix change: one prompt cache miss per conversation).
  - No new route, collection or env var.
- Client:
  - `client/src/portal/calendar/` (new `entries.ts`, `model.ts`, `grid.ts`, `CalendarGrid*.tsx`, `CalendarWeek*.tsx`, `DayTooltip.web.tsx`, `CalendarDay.tsx`, `YourCalendars.tsx`);
  - `client/src/portal/home/` (Home, ThisWeek, MonthGrid*, DayDetail, ThisMonth) and `analytics/week.ts`, `analytics/days.ts`, `analytics/panel.ts`;
  - `client/src/portal/locations/` (NoteFields, NoteForm, Notes, noteRules, api);
  - `client/src/portal/data/` (DataPage, ItemPage, item/AiSection, a new calendar agenda);
  - `client/src/portal/routing.ts` if the `c_` ref needs it;
  - `client/src/chat/` (ProposalCard, SuggestionCard, format).
- Docs:
  - `docs/portal/spec.md`: D49, the D30 amendment, 10.5, 10.14, 10.18, 11A.9, 12, 14.4, 14.5, and P11, P14, P26, P27 and P28 in 16.3;
  - `api/README.md` (notes, Your data, logs);
  - `docs/portal/tuning-chat.md` (the three tools).
- Ordering:
  - d6's uncommitted calendar work (`model.ts` `figureOf`, statuses `no_data` and `no_forecast`, `grid.ts` `headLine`, `CalendarWeek.web.tsx`, `DayTooltip.web.tsx`, spec 16.3) lands on develop first, and this branch merges it before building.
  - `suggest-closure-rules` (D46) shares files with this change; the design lists them.
