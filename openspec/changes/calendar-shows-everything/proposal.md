## Why

On 2026-11-17 the owner reviewed the Calendar and asked for two things, in his words:

1. "on the calendar and anywhere the calendar shows up e.g., in a week / month view on the home page or somewhere else calenda rin chat components etc, we should show all thigns going on. e.g, if it is closed and has a private event we should show both of those and ideally show the name of the private event"
2. "we should also have links from the calendar to their calendar that is attached or the source if we uploaded a calendar and that calendar should render nicely in the your data page on a detail page for that calendar"

His screenshot showed a BOOKED month cell with no entries; a tooltip reading "Mon, Nov 16, 2026 / No data. Booked for a private event / Fall term classes / Private event booked", with no event name; CLOSED cells showing nothing else; and "Veterans Day" listed twice on Nov 11. The day panel shows "From your calendar: Veterans Day" from his linked calendar with no way to reach that calendar, while town events already carry source chips.

The causes, read from develop at 85563ceb: notes have no name, only kind words and a free-text detail that cells never show; each surface builds its own list of a day's entries, and the month cell's and tooltip's lists leave out rules and, in the tooltip, every entry once the forecast has reasons; Home builds a third list from a separate `DayContext` and never reads the owner's calendars; nothing merges the town calendar's "Veterans Day" with the same title from the owner's linked calendar, and the API's `reasonViews` never merges two reasons with one label. By the owner's rule (2026-11-16), features he asks for ship on by default. Spec decision **D49**.

## What Changes

- **One "everything on a day" helper** (`client/src/portal/calendar/entries.ts`, new, pure) is the single source for the Calendar's month cell, tooltip, week cards and day panel, Home's This week, This month grid, day detail and month list, and native. Each shows the day's status (closed, booked, likely closed, and d6's no data and no forecast) together with its entries: the owner's notes, scheduled business rules, holidays and town events, and imported calendar events. Status never hides an entry. Each surface keeps a size limit with "+N more", set out per width in the design.
- **Notes gain an optional event name.** `title`, one line of 1 to 120 characters (white space collapsed, control and format characters refused), or null ([CONFIRM: 120 characters, matching the file reader's event titles]). Cells, tooltips and cards show it, falling back to today's kind words ("Private event, 70"). The note form (C6) gets "Event name", on web and native. Make a note never copies an imported event's title (D33 unchanged). TownwiseAI's file reader fills it from the event's title, and a boot-time pass names the notes it already made, exactly from their stored reads and only once. Never logged, never in an audit event, never sent to the lab. An edit that leaves `title` out keeps the stored one, so an older app cannot erase it. An `other` note needs a title or a detail.
- **D30 is amended, not broken.** A reason's label stays made in code. Where a note reason's note has a title, a surface may show the title after the label as the person's own words ("Your private buyout, 70 guests: Holiday party"), joined in the client by the reason's `note.id`. A model booking with no note keeps "Booked for a private event".
- **Duplicates show once where space is short.** In cells, the tooltip, week cards, Home's This week and the month list, entries on one day from different sources whose titles match (case and spacing folded) show once; two notes, two rules or two events of one calendar never merge. The day panel and Home's day detail keep each, with its source. The API's `reasonViews` keeps one run reason per folded label (the larger effect), so Why and the tooltip never say "Veterans Day" twice.
- **Source links.** Each imported event in the Calendar's day panel and Home's day detail links to its calendar's page in Your data. A note TownwiseAI made from a file links to that file's item (P27, `f_` or `u_`), and only while it exists. The shared source chip gains an in-app link mode. No answer, link or page ever shows a link calendar's address: D33 already keeps it out of every answer, and a Google or Outlook iCal address carries a private token. A link calendar's host shows as text, never as a link ([CONFIRM]).
- **Calendars get a page in Your data.**
  - Your data (P26) gains a "Calendars" group listing the location's calendars from the existing list route.
  - Each calendar opens P27 at the ref `c_<calendarId>`, a client-only ref. The page shows the calendar's name, kind, host, count and last refresh, then its events as an agenda grouped by month, one month at a time from the existing events route, each event linking to its day on the Calendar.
  - A stored file whose TownwiseAI read found a calendar (`ai.kind: 'calendar'`) shows its events the same way on its own P27. Each event that became a note links to the note's day on the Calendar.
  - **BREAKING (additive):** the data item's `ai` gains `events`.
- **Home's This month matches the Calendar and loses its empty space** (owner, 2026-11-17, 22:18: "the calendar in the home page is not showing all of the numbers like in the calendar page and that component in the home page has a lot of empty space fix it").
  - Home's grid builds its cells with the Calendar's `dayCell` and d6's `figureOf`, deleting its own copy (`analytics/week.ts` `cellFigure`). A parity test pins that both give the same figure for the same day.
  - The space fixes are Claude's calls:
    - cells list up to 2 entries where they are wide enough;
    - the grid column is wider (sticky only if the UI review still finds empty space);
    - the Reorder paragraph goes behind "How Townwise builds an order";
    - "Open the calendar" sits under the legend.
- **TownwiseAI.** `list_notes`, `get_day` and `propose_note` carry the title. The note proposal card and the weekly suggestion card show it; the side panel's activity line does not, since it is read under view-as. No chat visual gains per-day entries in this change: chat visuals are frozen snapshots of figures, so entries would need a server twin of the helper. Kept as an open question for the owner.

- **Actual or forecast, at a glance, and how the forecast did** (owner, 2026-11-18, relayed: "make sure one of the agents fills in the missing dates with forecasts or real data. real data should take precendence and we should have some place to show how the forecasts have performed relative to what actually happened", and "make sure the agent working on the dashboard calendar view includes either the forecast data or the real data and there should be an easy way to tell the difference for this and in general on the calendar page and anywhere else").
  - Every surface that shows a day's guest figure marks a forecast the same way, past or future, and leaves an actual plain, from one rule beside `figureOf` in `calendar/model.ts`; each grid's key names both, and each cell's label says "forecast" or "actual".
  - A past day with stored guests and a forecast made before it says how the forecast did; the Calendar's month and Home's This month say how many of the month's days landed inside the forecast range, in the model card's words.
  - The forecast read compares a past day only with a run made by that day: a run made after it only fills a day no earlier run covers, and is never scored (`api/src/forecasts/reader.ts`, `score.ts`).

## Capabilities

### New Capabilities
- `day-entries`: the shared list of what is on a day, its order, its dedupe, the status beside it, and what each Calendar and Home surface shows at each width; one run reason per label.
- `note-titles`: the note's optional event name in the API, the form, the file reader, TownwiseAI's tools and cards, and its privacy rules; the D30 amendment.
- `calendar-sources`: links from an imported event to its calendar's page and from a TownwiseAI-made note to its file, and what a source link may never hold.
- `calendar-detail`: the Calendars group in Your data, the `c_` calendar page, and the agenda of a calendar file's events on its P27.
- `forecast-vs-actual`: one mark for a forecast figure against an actual on every surface, the per-day and per-month comparison with what happened, and the read's rule that only a forecast made by a day is compared with it.

### Modified Capabilities
None under `openspec/specs/`. The Calendar's and owner calendars' requirements live in the unarchived `calendar-views`, `connect-owner-calendar`, `connect-google-calendar` and `refine-calendar-and-home` changes. This change adds to them without restating them. The design lists which of their requirements it narrows.

## Impact

- API:
  - `stores/notes.ts`, `handlers/notes.ts` (`title`, its cleaning, the keep-on-omit edit, the `other` rule, rule schedules refuse it; the note view's `source.ref`);
  - `stores/business-rules.ts` (`RuleSchedule` omits `title`), and the other code that builds or stores note content: `agent/questions.ts`, `lab/suggestions.ts`, `stores/agent-suggestions.ts`, `chat/view.ts`, `chat/turn.ts`, `chat/tools/registry.ts`, `handlers/chat-proposals.ts`, `handlers/agent.ts`, `handlers/chat.ts`, `handlers/weekly-suggestions.ts`;
  - the title backfill: `stores/cross-tenant.ts` (its query) and `access/policy.ts` (`scopeForNoteTitleBackfill`), run at boot from `main.ts`;
  - `forecasts/reasons.ts` (one run reason per label; note reasons unchanged, since the client joins the title by `note.id`);
  - `files/ai-actions.ts` (title from the event, detail its own, the duplicate check);
  - `handlers/data.ts` (`ai.events` on the single item only);
  - `chat/tools/notes.ts`, `day.ts`, `propose-note.ts` and their descriptions (a frozen-prefix change: one prompt cache miss per conversation);
  - `forecasts/reader.ts` and `score.ts` (2026-11-18: a past day takes the newest run made by it, and a run made after a day is never compared with it).
  - No new route, collection or env var.
- Client:
  - `client/src/portal/calendar/` (new `entries.ts`, `model.ts`, `grid.ts`, `CalendarGrid*.tsx`, `CalendarWeek*.tsx`, `DayTooltip.web.tsx`, `CalendarDay.tsx`, `YourCalendars.tsx`);
  - `client/src/portal/home/` (Home, ThisWeek, MonthGrid*, DayDetail, ThisMonth) and `analytics/week.ts`, `analytics/panel.ts` (`analytics/days.ts` is not changed);
  - `client/src/portal/ui/SourceChip.tsx` (an in-app link mode) and a new `calendar/AgendaCard.tsx` taken out of `CalendarWeek.tsx`;
  - `client/src/portal/locations/` (NoteFields, NoteForm, Notes, noteRules, api);
  - `client/src/portal/data/` (DataPage, ItemPage, item/AiSection, a new calendar agenda);
  - `client/src/portal/routing.ts` (`c_` refs);
  - `client/src/chat/` (ProposalCard, SuggestionCard, format).
- Docs:
  - `docs/portal/spec.md`: D49, the D30 amendment, 10.5, 10.14, 10.18, 11A.9, 12, 14.4, 14.5, 17, and P11, P14, P26, P27 and P28 in 16.3;
  - `client/app/(marketing)/privacy.tsx` (a note's fields gain the event name);
  - `client/src/portal/README.md` (page ownership: `entries.ts`, the agenda and the `c_` page);
  - `api/README.md` (notes, Your data, logs);
  - `docs/portal/tuning-chat.md` (the three tools).
- Ordering:
  - d6's uncommitted calendar work (`model.ts` `figureOf`, statuses `no_data` and `no_forecast`, `grid.ts` `headLine`, `CalendarWeek.web.tsx`, `DayTooltip.web.tsx`, spec 16.3) lands on develop first, and this branch merges it before building.
  - `suggest-closure-rules` (D46) shares files with this change; the design lists them.
