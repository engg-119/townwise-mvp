## Context

The owner's two requests of 2026-11-17 are quoted in the proposal. This design was read against develop at 85563ceb, plus d6's uncommitted calendar work in the main checkout (see Ordering). Paths are under `client/src/portal` unless they start with `api/`.

What the code does today:
- **Notes have no name.** A note is kind, dates, weekdays, effect, expected guests, hours and a 280-character `detail` (`api/src/stores/notes.ts`, spec 12). Month cells and the tooltip word a note by its kind (`calendar/model.ts` `noteChip`: "Private event, 70", "Private buyout", "Closure"). Only the day panel shows `detail`.
- **A "booked" day can have no note.** "Private event booked" is the run's own reason (kind `booking`, `api/src/forecasts/reasons.ts` `PLAIN`). "Booked for a private event" is the client's words for a run-booked day (`model.ts` `bookedWords`, `home/DayDetail.tsx`, `analytics/week.ts`). Neither has a note behind it, so no name exists to show.
- **Each surface builds its own list of a day's entries:**
  - month cell: `model.ts` `dayCell` (holidays and town events, note chips, imported titles, at most 3; no rules);
  - tooltip: `tooltipLines` (the top 3 reasons, and entries only when there are no reasons);
  - week cards: `grid.ts` `weekCards` (everything, rules by their text);
  - day panel: `dayView`, the most complete;
  - Home: `analytics/week.ts` (`thisWeek`, `monthGrid` booleans, `monthItems`), from `analytics/days.ts` `dayContext`. Home never reads the owner's calendars; `home/ThisMonth.tsx` passes `imported: []` to the shared tooltip.
- **Width decides what a cell shows, not status.** A status does not filter entries. CLOSED and BOOKED cells look empty because their entry list leaves out rules and the booking, and because below 1024px a cell shows marks only (`grid.ts` `cellSize`).
- **The duplicate "Veterans Day"** on Nov 11 is the town calendar's holiday (`api/src/town-calendar.ts`) plus the same title from the owner's linked US holidays calendar. `dayCell` concatenates both lists. Separately, `reasonViews` maps every run reason to a label with no dedupe, so two run reasons can both read "Veterans Day".
- **Imported events have no source.** Each event read (`GET .../owner-calendars/events`) carries `calendarId`, `uid`, `title`, dates and hours. Each calendar is `{ id, label, kind, host, eventCount, ... }`, and no answer carries a link's address or a Google calendar id (spec 10.18, D33, D39). A calendar file imported under Your calendars keeps only its events; it is not a Your data item.
- **A calendar file in Your data is a stored file.** TownwiseAI's read of it answers `kind: 'calendar'` with up to 50 events (title at most 120 characters, never naming a person; `api/src/files/extract/reader-prompt.ts`). Those events become notes with `source: { via: 'ai_file', fileId }` (`api/src/files/ai-actions.ts`). P27's `ai` shows only the notes made (`api/src/handlers/data.ts` `aiView`), not the events read.
- **Chat visuals are frozen snapshots.** They hold figures and a day's status (`client/src/chat/visuals/schema.ts`). No visual has per-day entries. `get_day` and `list_notes` return notes with `detail`; `propose_note` takes a note's fields.

## Goals / Non-Goals

**Goals:**
- Every Calendar and Home surface shows a day's status and its entries together, from one helper, on web and native.
- A note can carry the event's name, and every compact surface shows it.
- A day never lists the same title twice where space is short, and Why never repeats a label.
- Every imported event and every TownwiseAI-made note can be followed to where it came from.
- A calendar renders as a readable page in Your data.
- No new route, collection, env var, npm dependency or CSP origin.

**Non-Goals:**
- Naming a run-made booking. The model's `booking` reason has no note, and its words stay as they are.
- New chat visuals, or entries in the chat's daily chart (see Open Questions).
- Storing a calendar file imported under Your calendars as a Your data file. Its page is the `c_` page below.
- Copying an imported event's title into a note. D33 says Make a note never copies a title, and a Google event's title is never shown to staff (D39), while notes have no view-as masking.
- Analytics' heatmap and charts. Analytics' day panel shows a note's title (decision 2) but gains no other entries.

## Decisions

### 1. One helper, `calendar/entries.ts`, for every surface

`dayEntries(date, sources)` is pure. It returns the day's entries in one order:
1. the owner's notes, in start order;
2. scheduled business rules covering the day, oldest first;
3. holidays, then town events, as the Calendar's filters allow;
4. imported calendar events, by start time.

Term and season periods come last, and only for the surfaces that list them (the day panel, week cards and Home's This week periods line). Each entry is `{ key, kind, words, title, source }`:
- `words` is what a compact surface prints: a note's title, else its kind words (`noteChip`); a rule's text; a town entry's or imported event's title.
- `title` is the foldable name used for dedupe (null for kind words made in code).
- `source` is a town event's sources, `{ calendarId, calendar }` for an imported event (the events read already carries the calendar's label), the note's `source.ref` for a note TownwiseAI made (decision 5), else null.
- `group` is where the entry comes from: `notes`, `rules`, `town`, or `calendar:<calendarId>`.

`compactEntries(entries)` merges entries only across groups. A later entry is dropped when its folded `title` equals an earlier entry's from another group. Folding is lower case, with each run of white space one space, trimmed (the same as `ai-actions.ts` `folded`). Within one group nothing merges:
- two notes stay two, since two notes are two facts, even with one title;
- two rules stay two;
- two events of one calendar stay two (a lunch and a dinner "Private party" with their own hours).

Kind words are never merged, so two untitled "Private event, 70" notes stay two. Two calendars that both hold "Veterans Day" merge, as do a town holiday and an imported event.

Notes come first so a booked day shows its party's name within the cell's three lines; that ordering is Claude's call. Today the cell shows town entries first. With notes first, a busy town day can push a holiday past "+N more", but the panel and the label keep it.

Rules are worded by their own text, as the week card and the day panel already word them. The orchestrator's brief said "worded from their schedule". Claude's call is to keep the rule's text on every entry surface, since two wordings for one rule across surfaces is the inconsistency this change removes. D31's "never from the rule's text" governs forecast reason labels, which stay as they are. [CONFIRM: a rule's entry is its own text]

`model.ts` keeps its `CalendarInput` and adapts it into the helper. Its `eventsOn`, `notesOn`, `rulesOn` and `importedOn` become the helper's inputs, and `dayCell`, `tooltipLines`, `dayView` and `grid.ts` `weekCards` read the helper's list. Home builds every surface (This week, the month grid, the day detail, the tooltip and the month list) from `dayEntries` over the one `CalendarInput` it already builds for the tooltip (`ThisMonth.tsx` `tipInput`), with Home's imported events added. `analytics/days.ts` `dayContext` is not touched: it is pinned to the notebook's day classes (the day-classes.json parity fixture), Analytics uses it, and its rules are schedules without text or id. Rule coverage goes through `noteCovers`, which `suggest-closure-rules` extends with seasons, so seasonal rules appear with no change here.

### 2. What each surface shows

| Surface | Width | Status | Entries |
|---|---|---|---|
| Calendar month cell (web) | from 1024px | status word or figure, as today (d6's `figureOf`), plus BOOKED in the corner | up to 3 compact entry lines; with 4 or more, the first 2 and "+N more" |
| | 641 to 1023px | as above | corner marks: town (holiday or event), yours (note or rule), imported |
| | 640px and below | status word in the figure's place | corner marks |
| Calendar month cell (native) | all | as at 640px | corner marks |
| Tooltip (web, pointer only; Calendar and Home's This month) | all | d6's first line (figure, or "No data. Booked for a private event", "Closed", ...) | up to 3 reasons, deduped by label, a note reason followed by its note's title; then up to 3 compact entries that no shown reason already names (folded), the first 2 and "+N more" when there are 4 or more |
| Week cards (web columns from 641px; agenda below and on native) | all | d6's `headLine` in the column head | every compact entry as a card, wrapped (D40); terms and seasons last |
| Day panel (Calendar, web and native) | all | the forecast part, as today | everything, each entry with its source; no dedupe |
| Home This week | all | status word beside the day | up to 3 compact entries per day; with 4 or more, the first 2 and "+N more" |
| Home This month grid | by the grid column's measured width (decision 9) | the Calendar's figure, status and caption (`dayCell`) | up to 2 compact entry lines when a cell is at least 88px wide, else corner marks; the shared tooltip on web, now with Home's imported events |
| Home day detail | all | forecast lines, Why 3 | everything with sources, as the Calendar's day panel |
| Home month list | all | none: it lists items, not days | each item once by its first day, as today, now with note titles, rules and imported events; compact dedupe across groups |

Every cell's screen reader label says the status and every entry, as today, with no dedupe.

### 3. A note's event name

- **The field.** `title: string | null`, with an empty string read as null. It is cleaned as the rules page cleans one-line text (`handlers/rules.ts`, `lab/suggestions.ts` `CONTROL_OR_FORMAT`): normalized to NFC, each run of white space made one space, trimmed, and refused (400 `invalid_request`) if it holds a control or format character (`\p{Cc}`, `\p{Cf}`, which catches a newline and a bidi override), then 1 to 120 code points. Rendering is text only, so this guards layout and spoofing, not script injection. It goes in `tw_notes` (optional, no migration) and in spec 12's `NoteInput`. 120 matches the file reader's event titles and Your data's titles, so a title from a file is never cut. [CONFIRM: 120 characters]
- **Editing.** A note edit replaces the whole note today (`readNoteContent`). An edit body without a `title` key keeps the stored title, and `title: null` clears it. An installed native build that predates the field therefore cannot erase a title by saving. This is Claude's call, and the only field with this rule. `updateNote` merges the stored title when `!Object.hasOwn(body, 'title')` before the `other` rule runs (`readNoteContent(raw, today, { keepTitle })`), so an older client editing an `other` note that has only a title is not refused. An edited chat proposal saved without a `title` key keeps the proposal's title the same way (`handlers/chat-proposals.ts`, code review nit 6).
- **The `other` kind.** An `other` note needs a title or a detail (today, a detail). Without that, a file event of kind other with no detail of its own would be refused.
- **Rule schedules.** A business rule's schedule stays strict and refuses `title`, as it refuses `detail`. `RuleSchedule` (`api/src/stores/business-rules.ts`) becomes `Omit<NoteContent, 'detail' | 'endDate' | 'title'>`.
- **Everything else that builds or stores `NoteContent`** gains `title: null` or reads it:
  - `api/src/agent/questions.ts` (`closureNoteOf`, `noteFor`);
  - `api/src/lab/suggestions.ts`, and `api/src/stores/agent-suggestions.ts`, whose stored suggestions read back with no title as `title: null`;
  - `api/src/chat/view.ts` (`ShownProposal`) and `api/src/handlers/chat-proposals.ts`, whose stored proposals with no title read as null;
  - `api/src/handlers/agent.ts`, `api/src/handlers/chat.ts`, `api/src/handlers/weekly-suggestions.ts`, `api/src/chat/turn.ts` and `api/src/chat/tools/registry.ts`;
  - `api/src/closed-days.ts`, `api/src/forecasts/adjust.ts` and `api/src/people-in-town/history.ts`, which read note content and ignore the title.
  - The weekly pass's request (`lab/suggestions.ts`) does not carry `title`, and its suggestions save with `title: null` (Claude's call: no new words to the model without a need).
- **Privacy.** The title is the person's words, under the same rules as `detail` (spec 12, section 17). It is never logged, never put in an audit event (`note.*` keep `locationId`, `kind`, `startDate`, `endDate`), never in a URL, and never sent to the lab (`api/src/lab/input.ts` sends no note words). TownwiseAI reads it as data, as it reads `detail`. Under view-as, notes show as they do today.
- **The form (C6, `locations/NoteFields.tsx`, web and native).** "Event name" comes after Kind, optional, with placeholder "Holiday party" and the helper "Name the event, not the guests." Its limit is 120 code points, as the API counts, checked by `checkNote`; the field's own `maxLength` counts UTF-16 units, so it is 240 and never cuts a name of emoji early (code review nit 2). Edit fills it from the note. Make a note leaves it empty and never copies the imported event's title, as D33 says and `client/test/portal/calendar/note-popover.test.web.tsx` pins. D33 is unchanged.
- **Where it shows.** Cells, the tooltip, week cards, Home and the Notes page (P14) show the title in place of the kind words. The day panel and Home's day detail show the title, then the kind words line, then the detail. Analytics' day panel shows it beside the kind words.
- **The D30 amendment** (Claude's wording for the D30 row): "each shows as a reason labeled in code, never from its detail or its title; where a reason comes from a note that has a title (12, D49), the Calendar, Home and TownwiseAI's cards may show the title after the label as the person's own words ('Your private buyout, 70 guests: Holiday party'), never in its place." The client joins the title through the reason's `note.id` against the notes it already read. The API's reason view gains nothing.
- **A run-made booking keeps its words.** "Booked for a private event" (status) and "Private event booked" (reason) stay.
- **TownwiseAI's file reader** (`ai-actions.ts`).
  - A note it makes gets `title` from the event's title and `detail` from the event's own detail: null when that is empty or equal to the title. Today the detail is "title: detail".
  - The title is cleaned before it is used: NFC, white space collapsed, control and format characters removed (not refused, since the person did not type them), then cut to 120 code points, since NFC can lengthen a title the reader kept to 120 (code review nit 3). If nothing is left, the note gets no title and the event is still made, except an `other` event with no detail of its own, which has nothing left to save and is skipped as invalid (a known limit).
  - The duplicate check matches an existing note of the same kind and dates whose folded title equals the event's, checked before the `detail === null` early return in `duplicates()`. The old detail match stays, for notes made before this change.
- **Backfill of notes TownwiseAI already made** (the coordinator's decision; the audit's S5). Notes made before this change have no `title` key and a detail of "Title: detail", so without a backfill the owner's existing notes would keep showing kind words.
  - A pass at boot, after `ensureIndexes`, finds notes with `source` set and no `title` key. For each one it reads the file's stored read and takes `ai.result.events[plan.noteIds.indexOf(noteId)].title`, exactly as `aiView` reads it, cleaned as above.
  - It names a note only while its detail still says the event's title, by the test `duplicates()` uses (the folded detail equals the folded title, or starts with "title:"). A note whose detail the owner rewrote, perhaps to take a name out, gets null, so the pass never puts back a name they removed (code review SF3).
  - It writes with a compare-and-set: `updateOne({ _id, title: { $exists: false } }, { $set: { title } })`. The title is null when the event is gone (the original deleted, the file removed, or nothing left after cleaning) or the detail no longer says it, so every note is visited once and the pass is idempotent: a second run, or two replicas at once, find nothing to do.
  - `detail` is left as it is.
  - The query spans organizations, so it lives in `stores/cross-tenant.ts`, and each write takes a scope from a new `scopeForNoteTitleBackfill` in `access/policy.ts`, following `scopeForStaleChatTurn` (resumable-chat-turns). The isolation test is updated to allow it.
  - It writes no audit event, since a title is never audited. It logs only counts (`notes_titled`, `notes_untitled`).
  - Notes created after the change always store `title` (a string or null), so the pass never touches them.
  - This is Claude's call. The undo is unchanged: it deletes by the planned ids.
- **TownwiseAI's tools.**
  - `list_notes` and `get_day` return `title` beside `detail`.
  - `propose_note` takes `title` (string or null, at most 120, "names the event, never a person") and lists it in `required` with the others. The proposal card shows it, and Save sends it.
  - Each of the three descriptions gains a clause, which is a frozen-prefix change: one prompt cache miss per conversation, once.
  - The weekly suggestion card shows a note's title when it has one. The weekly pass (`api/src/lab/suggestions.ts`) does not propose titles in this change.
  - The side panel's activity line (`note_saved`) stays as it is. It is built by the API (`api/src/agent/activity.ts`) with only the kind and dates, and the panel is read under view-as, so it never names anything.

### 4. Dedupe

- **Compact surfaces** use `compactEntries` (decision 1). The day panel and Home's day detail list each entry with its source, so the owner can see that "Veterans Day" came from both the town calendar and the US holidays calendar.
- **Reasons, in the API.** `reasonViews` keeps one run reason per folded label on a day: the one with the larger absolute `effectPct`, else the first in the run's order. It applies to run reasons only. Note and rule reasons are never merged, since two notes are two facts.
  - The kept reason takes the union of both reasons' `sources`, so no source chip is lost.
  - Doing it in the API means Why, the tooltip, Home and TownwiseAI's `get_forecast` all agree.
  - The audit notes (its N3) that the owner's duplicate was in a cell, not in Why, and that this step could be dropped. Claude keeps it: a holiday reason and an event reason that resolve to one town entry do occur, and the fix is a few lines in one function with one caller (`forecasts/reader.ts`).
  - The run files are unchanged, and live accuracy does not read reasons.
- **Reasons against entries.** The tooltip leaves out a note or rule whose own reason it shows (by id), and any other entry (town or imported) whose folded words equal a shown reason's label or a note reason's title. A note or rule is never left out for its words, so a second note sharing a shown note's title still shows (code review SF1). The day panel already leaves out town entries that Why names (`dayView` `inWhy`), and keeps doing so.

### 5. Source links

- **An imported event** in the Calendar's day panel and Home's day detail ends with a source chip naming its calendar (the calendar's `label`, which is "Google calendar" under view-as and open as admin, D39). The chip links inside the app to that calendar's page, `/locations/[id]/data/c_<calendarId>` (decision 6).
  - The shared source chip (`client/src/portal/ui/SourceChip.tsx`) gains an internal mode, since today it opens a URL with `Linking.openURL` on native, which cannot open an app path, and renders a plain `<a href>` on web, which reloads the page. The internal mode takes an app path and a given name, renders a calendar glyph in place of a site logo, and navigates with expo-router (`Link` on web, `router.push` on native). It follows the `asChild` style rule (`test/portal/link-child.test.ts`). No new image origin is needed.
  - The chip's name comes from the event itself: each event in the events read already carries its calendar's label (`OwnerCalendarEvent.calendar`). Neither the Calendar nor Home needs the calendar list for chips.
  - Home starts reading the location's events over `forecastRange(today)` (this month, plus This week's days past it, at most about 37 days). Home's calendar range (`homeCalendarRange`) starts about two years back and would be refused 400 `bad_range` by the events route's 92-day limit. A test pins that Home's request is under 92 days. A failed read leaves Home showing with no imported events.
- **A note TownwiseAI made from a file** shows a chip "Your file" linking to that file's item in Your data (P27). The chip names no file, since the name would need more than a ref (Claude's call).
  - A file that wrote days of its own is the item `u_<uploadId>`, not `f_<fileId>` (`api/src/data/library.ts`, `handlers/data.ts`), and every `f_` item is 404 while stored files are off.
  - So the note view's `source` gains `ref`: `f_<fileId>`, `u_<uploadId>`, or null once the file is gone or stored files are off. It comes from one `files.byIds` read per notes list.
  - The chip shows only while `ref` is not null.
- **Never the feed address.** The API answers no link address (D33), and a Google, Outlook or iCloud iCal address carries a private token in its path, so no chip, page or tooltip may hold one.
  - A link calendar's host (`calendar.google.com`) shows as text on its page, never as a link. A link to a host's front page tells the owner nothing.
  - The Your calendars popover's rows gain "Open" to the same page.
  - [CONFIRM: a link calendar's host is shown as text, never linked]
- **Town events** keep their source chips. Notes the person typed and rules have no source chip (rules keep the panel's link to P29).
- **Compact surfaces carry no links.** Pressing a cell, a card or a This week day opens the day, whose panel holds the links.

### 6. Calendars in Your data

- **The route guard first.** `client/src/portal/routing.ts` allows only `ITEM_REF = '[uf]_[0-9a-f]{24}'`, so `AccessGuard` would redirect every `/data/c_` path, and `isItemPath` marks the More menu's current page from it. It becomes `[ufc]_`, with a routing test, before any link to a `c_` page is built.
- **The Calendars group.** Your data (P26) gains a "Calendars" group above the list, from `GET .../owner-calendars` (at most 5 rows, no paging). Each row shows the name, kind ("File", "Link, calendar.google.com", "Google calendar"), event count and last refresh, and opens `/locations/[id]/data/c_<calendarId>`. The group is hidden when the location has none, and shows with stored files off, since calendars are not stored files.
- **The `c_` page.** `c_<calendarId>` is a client-only ref on P27's route. `ItemPage` sees the prefix and renders the calendar page instead of reading `org.data.get`, which keeps answering 400 for a malformed ref.
  - The page shows the calendar's name, kind, host as text, event count, repeating events not imported, status and last refresh, then an agenda of its events for one month at a time ("Earlier" and "Later", today's month first).
  - It reads the existing events route over that month and keeps the events whose `calendarId` matches. An event that began the month before and runs into it lists under the month shown (code review nit 8). A month with none reads "No events in {Month}." (stored events reach 400 days each way, so many months are empty).
  - Each event shows its dates and hours and links to `/locations/[id]/calendar?day=<startDate>`.
  - An unknown or removed calendar shows P27's not-found state.
  - The page has no Refresh or Remove, which stay in the Your calendars popover, so one place manages calendars.
- **A calendar file's P27** (`f_` ref whose `ai.kind` is `calendar`).
  - The AI section shows the read's events with the same agenda component, grouped by month and in date order.
  - Each event shows its title, dates, kind words and guests. One that became a note links to `/locations/[id]/calendar?day=<startDate>`, marked "Note made"; one that did not reads "No note made".
  - The API adds `ai.events: { title, startDate, endDate, kind, effect, expectedGuests, noteId }[]` to the single item's view (`getDataItem`) only. The list answer leaves it out, since `listData` shares `dataItemView` and each row could otherwise carry 50 events.
    - `noteId` is the planned id when the outcome made that note and it still exists, else null.
    - `title` is null under view-as, as `ai.notes[].title` is.
    - The list is empty once the original is deleted, since the events are cleared then.
    - A PATCH's or another action's answer leaves it out too (spec 10.14). The item page shows an action's answer while it reads the item again, so it keeps the events already on screen while both are the same item's done read (`ItemPage.tsx` `keepEvents`; code review SF2), and the agenda does not blink out.
- **Why one page for every calendar** (the orchestrator asked for one option). Yes: linked and Google calendars also get the `c_` page, reachable from Your calendars and from every imported event's chip.
  - The event in the owner's screenshot ("From your calendar: Veterans Day") came from a linked calendar, so a link only to the popover would leave his request unmet for exactly the case he showed.
  - One page for every kind needs no API change, because the list and events routes already exist.
- **Why an agenda, not a month grid.** An agenda reads well at 375px and on native. A file's read holds at most 50 events, and a month of a linked calendar is short. The Calendar's grid is built around forecasts and filters, which a calendar's page does not have. The agenda reuses the week view's agenda card, with its kinds and marks. `CalendarWeek.tsx` exports only `CalendarWeek`, so the card moves to its own file, `calendar/AgendaCard.tsx`, which the week view and the agenda both import.

### 7. Chat components (decision 6 of the brief)

The minimum that meets "anywhere the calendar shows up":
- The chat components that show a note's content (the proposal card and the weekly suggestion card) show its title. The side panel's activity line stays as it is (decision 3).
- TownwiseAI's tools carry the title, so its words can name the event.

No chat visual gains per-day entries in this change:
- The daily chart is a chart of figures, frozen when drawn.
- Entries in it would need the API to build them (a server twin of `entries.ts` and its dedupe) and would freeze note titles into stored conversations, where a later edit would not reach them.
- Its tooltip already says "Forecast: closed" or "Forecast: booked for a private event".

This is Claude's recommendation, and the owner decides (Open Questions). In plain words for him: if he does not answer, chat's charts will still not list what is on each day.

### 8. Ordering with other work

- **d6's calendar commit lands first.** d6's uncommitted work in the main checkout changes the same calendar files, so tasks.md's first task is "merge develop after d6's calendar commit lands". That work:
  - adds `figureOf`'s past forecast, the statuses `no_data` and `no_forecast`, and `CellFigure` `past_forecast` in `model.ts`;
  - adds `headLine` in `grid.ts`, and removes `WeekDay.noForecast`;
  - changes `CalendarWeek.web.tsx` and `DayTooltip.web.tsx`;
  - adds the tooltip's "No data. ..." lines;
  - edits spec 16.3.
- **Develop has also moved.** 3710fb01 ("keep hover tooltips off the hovered day", after the base 85563ceb) changed `DayTooltip.web.tsx` and `CalendarWeek.web.tsx`. Task 0.1's merge picks it up.
- **How this change composes with d6.** It takes d6's first tooltip line and cell status as given, and only changes what follows them, so the two compose.
- **Files shared with d6:**
  - `client/src/portal/calendar/model.ts`, `grid.ts`, `CalendarWeek.web.tsx`, `DayTooltip.web.tsx`;
  - `client/test/portal/calendar/model.test.ts`, `grid.test.ts`, `grid.test.web.tsx`, and d6's new `day-tooltip.test.web.tsx`;
  - `docs/portal/spec.md` (16.3 P28);
  - Home's This month (decision 9) depends on d6's `figureOf`, and exports it (or `dayCell`) from `model.ts`.
  - Not shared: `CalendarWeek.tsx` (native), from which `AgendaCard.tsx` is extracted; d6 does not change it.
- **Files shared with `suggest-closure-rules` (D46, branch `feat/suggested-closure-rules`, proposal only):**
  - API: `api/src/forecasts/reasons.ts` (D46 adds season words; this change adds label dedupe), `api/src/files/ai-actions.ts`, `api/src/stores/business-rules.ts` (D46 adds `season` to `RuleSchedule`; this change omits `title` from it), `api/src/agent/questions.ts`, `api/src/lab/suggestions.ts`, `api/src/stores/agent-suggestions.ts`, `api/src/handlers/weekly-suggestions.ts`, `api/src/handlers/data.ts`, `api/src/handlers/notes.ts` (D46 adds season checks; this change adds `title`), `api/src/stores/files.ts` (read only here, unless the item view's types move);
  - client: `client/src/portal/locations/NoteFields.tsx` and `noteRules.ts`, `client/src/portal/analytics/days.ts` (D46 adds seasons to `noteCovers`; this change only calls `noteCovers`), `client/src/portal/home/Home.tsx`, `client/src/portal/data/item/AiSection.tsx` and `client/src/portal/data/aiCopy.ts`, `client/src/chat/api.ts`, `client/test/portal/data/item-ai.test.web.tsx`, `client/test/portal/home/home.test.web.tsx`;
  - docs: `docs/portal/spec.md` (12, 14.5, 10.14, 11A.9, P11, P25, P27), `api/README.md`, `docs/portal/tuning-chat.md`.
  - Whichever lands second merges the other. Neither needs the other's fields.

### 9. Home's This month (owner, 2026-11-17, 22:18)

The owner's words: "it looks like the calendar in the home page is not showing all of the numbers like in the calendar page and that component in the home page has a lot of empty space fix it". His screenshots, taken as staff opened as admin on Sawtooth on Nov 17, showed two problems:
- Days 1 to 16 were blank cells, while the Calendar showed figures for them.
- The grid took about 45% of the card (`ThisMonth.tsx` `gridSide`, `maxWidth: 420`). The day detail beside it was much taller, mostly the Reorder part's paragraph (`home/beside.ts` `REORDER_OVERVIEW`), so a large empty area sat under the grid and its legend before "Open the calendar".

**Figures: one rule (the orchestrator's decision).**
- Home's grid has its own copy of the figure rule (`analytics/week.ts` `cellFigure` and `monthGrid`). That copy shows a past day only from stored data.
- d6's `figureOf` in `calendar/model.ts` shows a past day's stored guests, else the run's figure for that day captioned "forecast", else "No data"; from today on, the forecast, else "No forecast". Sawtooth's stored days end before Nov 1, which is why the Calendar (with d6's rule) shows past figures and Home does not.
- Once d6 lands, `monthGrid` builds each cell from the Calendar's `dayCell` over the same `CalendarInput` that Home already builds for the tooltip (`tipInput`, with Home's imported events from decision 5). `cellFigure` goes, keeping only Home's own "This week" outline (the 7 days from today).
- Home's metric:
  - Home shows net sales only for a location with no stored guests (`Home.tsx` `metricsWithData`).
  - d6's `figureOf` is private and works in guests only, and its `CellFigure` is `{ value, kind }` with no text. Home's cell today renders `figure.text` from `metricNumber` (`analytics/week.ts`).
  - So `model.ts` exports `figureOf(date, input, metric = 'guests')`. With net sales, the stored value it reads is the day's net sales instead of its guests; the fallbacks (the run's guest figure captioned "forecast", "No data", and from today on the guest forecast or "No forecast") are unchanged.
  - Likely closed stays guest-based. A net-sales location has no stored guests, so it is never likely closed, as today.
  - `CellFigure` stays `{ value, kind }`. Home formats it: `kind: 'actual'` with `metricNumber(value, metric)`, and every other kind (a guest count) with `formatCount`.
  - The rule therefore still lives once (Claude's call).
- A parity test feeds one fixture month to `calendarMonth` and to Home's `monthGrid` and asserts the same figure, caption and status for every day. The fixture covers:
  - a past day with stored guests;
  - a past day that was likely closed;
  - a past day with only the run's figure;
  - a past day with neither;
  - today with a forecast;
  - a future closed day, a future booked day, and a future day with no forecast.
- The Calendar never shows net sales, so there is nothing to compare a net-sales Home grid against. That case gets a Home-only expectation test instead of a parity test: a past day shows its stored net sales in dollars, and a past day with none shows the run's guest figure captioned "forecast".

**Space: each of these is Claude's call, refining the orchestrator's four proposals.**
- (a) **Home cells list entries where they fit.** The grid column measures its width (`onLayout`). When a cell is at least 88px wide, each cell shows up to 2 compact entry lines from the shared helper, or 1 line and "+N more", under its figure, at a fixed cell height of 96px, so the grid has one height per tier. Narrower cells keep corner marks at today's height. The cell's label says everything either way.
  - A wide cell lays out as the Calendar's (UI review B1): the day with a booked or outlook day's status word or the figure's caption beside it, then the figure with its "+40" beside it, or the status in its place, each row at a fixed height (`week.ts` `WIDE_ROWS`: 16px and 24px of the 86px inside the border and padding). `monthEntryLines` takes a line budget, `WIDE_LINES`, which is what is left (2 lines); "+N more" counts as a line. A booked buyout's party shows "~70" with no "forecast" beside it, since "Booked" holds that place; the "~" and the label say it.
- (b) **A sticky grid column, only if still needed** (the audit's N4). On web, when grid and detail sit side by side, the grid column would be `position: sticky`, `top: 16`, aligned to the top.
  - React Native's style types do not allow `position: 'sticky'`, so it would need a `.web` style. It breaks under any ancestor with `overflow: hidden`, and jsdom cannot test it.
  - So (a), (c) and (d) ship first. The UI review (task 7.2) judges whether an empty area is left at 1280px and 1440px. Sticky is added (task 5.7) only if it is.
  - Native and stacked layouts never stick.
- (c) **The Reorder paragraph goes behind a disclosure, in `DayDetail.tsx` only.** `REORDER_OVERVIEW` stays in `home/beside.ts`, since Orders (`orders/Orders.tsx`) also shows it in full. On Home it moves behind "How Townwise builds an order", closed by default, with `aria-expanded` on web and an expanded state on native. The one-line status ("Townwise can't build an order...", or the order's cover sentence) and "Open this day on Orders" stay visible.
- (d) **"Open the calendar" moves up.** The legend (`MonthKey`) already sits directly under the grid inside `MonthGrid`. "Open the calendar" moves from under the whole card into the grid column, directly under the legend, so the grid side reads as one unit. When stacked, it stays under the legend, above the day detail.
- **The grid column gets more room.** Side by side, the grid column takes `flexGrow: 3` against the detail's 2, with no 420px cap and a minimum of 360px. The detail keeps a minimum of 280px.

**Layout at each width.** Home's content column width, not the window, decides; the column is narrower than the window at every width:
| Content column | Layout |
|---|---|
| 1100px and wider | side by side, grid about 60%: cells about 90px wide, 2 entry lines, then the legend and Open the calendar under it (sticky only if task 5.7 adds it) |
| 720 to 1099px | side by side, grid at its 360px minimum or more: cells under 88px, corner marks |
| under 720px, and every phone | stacked: grid full width (entry lines only if cells reach 88px, as on a tablet held wide), the legend, Open the calendar, then the day detail |
| native (iOS, Android) | stacked as above at every width, with no sticky and no tooltip; entry lines by the same 88px cell rule; the Reorder disclosure works by tap |

### 10. Actual or forecast, one mark on every surface (owner, 2026-11-18)

The owner's words are in the proposal. His screenshots showed Home's This month with past days empty, the Calendar's past fallback days with a number and a small "FORECAST" tag while today and future days (forecasts too) showed a bare number, and a BOOKED day with no number.

What the build already did, checked on 2026-11-18:
- Home's This month fills past days (decision 9, tasks 5.3 and 5.4): its cells are the Calendar's `dayCell`, so a past day shows its stored guests first, else the run's figure, else "No data". `month-figure-parity.test.ts` pins it, including a past day with stored guests.
- The marking was not one rule: `captionOf` tagged only `past_forecast` ("forecast") and `actual` ("guests"), and every cell drew an actual in `text2` and a forecast in `white`, so a forecast looked like the solid figure.
- A booked day has no figure unless a buyout note gave its party a guest count (14.5: a booked day has no walk-in forecast, and a run's booked row has no figures). So the BOOKED cell with no number had no number to show; a buyout with a guest count shows its party.

**The rule lives once, in `calendar/model.ts` beside `figureOf`:**
- `figureSource(kind)`: `actual` for stored guests (or Home's stored net sales); `forecast` for a published day's middle figure, a past day's run figure (`past_forecast`) and a buyout's party (`booked`, an expected count, not a count of guests who came).
- `markedFigure(text, kind)`: a forecast's figure is printed with a leading "~" ("~82"); an actual is printed bare ("94").
- `figureTone(kind)`: an actual is `white` (solid); a forecast is `text2` (lighter).
- `FORECAST_TAG` ("forecast"): the word a surface prints beside a forecast's figure where it has room; an actual gets no tag.
- `figureLabel(value, kind, metric)`: what a screen reader hears and the tooltip's first line says: "82 guests, forecast", "94 guests, actual".
- `FIGURE_KEY`: the key's two entries, "Actual guests" ("Actual sales" on a net-sales Home) and "Forecast", each shown with its own sample figure ("94", "~82").

**The treatment (Claude's call, [CONFIRM: a forecast's figure is lighter with a leading "~" and the word "forecast"; an actual is a plain solid figure]).** The "~" is text, so the mark never rests on color alone, and it fits a phone cell where no tag does. It reads as "about", which is what a forecast's middle figure is. No new token: `white` and `text2` are the theme's.

| Surface | Actual | Forecast |
|---|---|---|
| Calendar month cell, web and native, from 641px | solid figure, no caption | "~82" lighter, "FORECAST" in the top row (a booked day keeps "BOOKED" there; its party's "~70" still carries the "~") |
| Calendar month cell at 640px and below | solid figure | "~82" lighter (no room for a tag); a booked day keeps its status word in the figure's place, its label says both |
| Calendar week view head | solid figure | "~82" lighter, then "forecast, 70 to 95" (or "forecast" alone) |
| Tooltip (Calendar and Home) | "94 guests, actual" | "82 guests, forecast (likely 70 to 95)"; a past fallback day keeps d6's "No data." before it |
| Calendar day panel | the part headed "Actual guests" over the figure | the part headed "Forecast" over "About 82 guests" ("Outlook" over "Forecast" for an outlook day) |
| Home This month cell | solid figure, no caption ("sales" stays with a net-sales figure) | "~82" lighter, "forecast" under it in a narrow cell, beside the day in a wide one, and none on a phone |
| Home This week | the day's own figure, solid | the Forecast row: "~90 guests, forecast, likely 68 to 112", lighter |
| Home day detail | "This day": the stored figure | "Forecast": the run's figure for a past day with no data, the published one from today on |
| Home Last week | unchanged: actual rows plain, forecast-only rows already say "Forecast, no guest count uploaded yet" | |
| TownwiseAI daily chart | its line is named "Actual guests" in the key, and "180 guests, actual" in the hover, when the chart also draws a forecast | the band and dashed middle, as today |
| Analytics | shows stored days only, so nothing to mark | |

Each grid's key gains the two entries: Home's `MonthKey`, and a new `FigureKey` under the Calendar's month and week views (the Calendar had no key). Every cell's label says "forecast" or "actual" after its figure. Tests pin the distinction on the Calendar and on Home, and their parity, on web and native.

### 11. How the forecast did against what happened (owner, 2026-11-18)

**Only a forecast made before the day is compared with it.** The read (`api/src/forecasts/reader.ts` `chooseDays`) took each day from the newest published run whose data ended before it, whatever its `madeAt`. A run made after a day (data uploads lagging, as Sawtooth's: data through Oct 21, runs made in November) never saw the day's sales, but came after it, and it won over an older run made in time. Its `inRange` and `scored` then counted in live accuracy, the window's `accuracy` and Last week.
- Now a day takes the newest run made by it (`madeAt` on or before the day), and only with none the newest made after it, which fills the day (owner's first request: data first, else a forecast, else a word).
- A day from a run made after it has `inRange: null` and `scored: false` and counts in no `live` or `accuracy`; a week from a run made after its first day has `inRange: null`.
- A run made on the day itself counts as made by it: the lab makes its weekly run at 03:00 in the town, before service, forecasting from that day. The read's `madeAfterDay` follows the same rule (it was `madeAt >= date`), so TownwiseAI's `get_forecast` and the Calendar's `forecastCheck` agree (code review nit 1).
- No field is added. Pinned by `api/test/forecast-score.test.ts` and `api/test/estimates.int.test.ts`.

**Amended the same day: compared by the run's data, not its made-at day** (the release coordinator, for the owner, 2026-11-18). The rule above scored no past day from a run made after it, so a published lab run with data through May 24 made June 1 had no live accuracy for May 25 to 31 (`lab-publish.int.test.ts`), and a restaurant that uploads in arrears would never be scored. Honesty needs only that the forecast never saw the day's sales, and a run with data through an earlier day never did, however late it was made.
- The read still takes a day from the newest run made by it, else the newest; a past day is compared with whichever it took (`score.ts` `sawDay`: `late` when the run's `dataThrough` is on or after the day, which the read never takes). `scored`, `inRange`, `accuracy` and `live` keep D42's definitions.
- The one thing a run made later can learn about a passed day is a note or rule. On a day after a run's data the lab input sets no `closed` or `booked` and no guests; it flags `privateEvent` for a private event the read doesn't apply itself (`adjust.ts` `flagsAfterData`, which `lab/input.ts` now shares: not a buyout, not a counted party). Town calendar entries are the town's schedule, not how the day went, and uploads after `dataThrough` never reach the input.
- So a day before today covered by such a note or rule, last written (`updatedAt`) on or after the day and by the day after the run's `madeAt`, both in UTC, from a run made on or after the day (`score.ts` `writtenForRun`), answers `laterNote: true`, `inRange: null` and `scored: false`, and a week holding it `inRange: null`. Both ends lean to "may have": nothing records which notes a run read. A note deleted since leaves no trace, so its day is still scored. A note written before the day is a fair input.
- The Calendar and Home compare every scored day. From a run made after the day they say "Forecast from sales through Oct 21, 2026: about 82 (likely 70 to 95); 94 guests came: inside the range" (`checkWords`, the run's `dataThrough` from the window's `runs`); a `laterNote` day says "Townwise's model forecast 70 to 95, but it may have used a note or rule written on or after this day, so it isn't scored." TownwiseAI's `get_forecast` carries `laterNote` and says what both flags mean.
- [CONFIRM: a past day is compared with any run whose data ends before it, however late the run was made, unless the run may have read a private event note or rule written on or after the day] Pinned by `api/test/forecast-score.test.ts`, `api/test/forecast-adjust.test.ts`, `api/test/estimates.int.test.ts`, `api/test/lab-publish.int.test.ts` (unchanged), `api/test/chat-estimate-tools.test.ts` and `client/test/portal/calendar/model.test.ts`.

**A past day says how the forecast did.** `forecastCheck(day)` in `model.ts` gives `{ mid, low, high, actual, verdict }` only when the read's day has passed, is `scored` (open in the model, not closed or likely closed, stored guests, not `laterNote`) and has an `inRange`. Its words: "Forecast was about 82 (likely 70 to 95); 94 guests came: inside the range" ("above the range", "below the range"). They use the model's own figures, which are the day's before today. They show in:
- the tooltip (Calendar and Home's This month), after the first line;
- the Calendar's day panel, in place of "and the day landed in that range";
- Home's day detail, in its Forecast part.

A past day whose run was made after it says so in its words ("Forecast from sales through Oct 21, 2026: about 82 ..."), and a `laterNote` day says why it isn't scored (amended, above).

**The month says how many days landed inside.** `monthCheckLine(month, input)`: "So far this month: 5 of 6 days inside the forecast range." for today's month, "In October: 5 of 6 days inside the forecast range." for an earlier month on the Calendar. With no comparable day yet in a month that has begun: "No day this month can be compared with its forecast yet." ("No day in October could be compared with its forecast." for an earlier month). Nothing for a later month, or while the read loads or failed. It shows under the Calendar's month view and under Home's This month key. It counts the read's own days of that month, so it agrees with each day's words.

**Same words where views overlap.** "inside the forecast range" (`insideWords`) is also the model card's live line ("So far: 5 of 6 days inside the forecast range; typical miss 12%, ...") and Last week's ("5 of 6 days inside the forecast range."), which read "inside the range" and "landed in its range" before.

**No API change beyond the rule above**: the read already answers each day's `actual`, `inRange`, `scored`, `madeAt` and `model`. Nothing is logged.

## Risks / Trade-offs

- [Notes first in a cell can push a holiday past "+N more"] → The label, tooltip and panel still list it, and the order is a [CONFIRM] in the D49 row.
- [A sticky grid taller than the window, if task 5.7 adds sticky] → Sticky applies only when the grid column fits the viewport height; otherwise it scrolls with the page (checked from its measured height).
- [Home's grid now shows past forecasts] → It is the Calendar's rule, captioned "forecast", so a run's figure is never mistaken for a stored one.
- [Home makes one more read] → The events over `forecastRange(today)`, at most about 37 days. A failure leaves Home showing without imported events and their marks, as the Calendar does.
- [The title backfill visits every older TownwiseAI note once] → Notes are capped at 1,000 a location and the pass reads each file's read once per file. It writes with a compare-and-set, so a second run or a second replica finds nothing to do.
- [Dedupe hides which source a compact entry came from] → The day panel and Home's day detail keep every source.
- [Merging run reasons drops a smaller effect] → Only for two reasons with one label on one day, which read as a bug today. The larger effect is kept.
- [An old native build saving a note] → It sends no `title`, and the keep-on-omit rule keeps the stored one.
- [A past day can lose a later run's figure to an earlier one] → Only when the earlier run was made by the day: its figure is the forecast the owner could have read, and the later run still fills any day no earlier run covers (decision 11).
- [Live accuracy can drop to "Not scored yet"] → Since the amendment only for a location whose past days' runs may have read a private event note or rule written on or after them; the model card and Last week say so rather than score them (decision 11).
- [A day stays unscored for a note its run never read] → A note written once the day began but after the run was made, within a day, counts as read; nothing records which notes a run read, so the check leans to leaving the day out (decision 11, amended).
- [The `c_` ref shares P27's route] → `ItemPage` branches on the prefix before any read, and a test pins that a `c_` ref never calls `org.data.get`.

### Known limits (code review of 2026-11-18)

The review's should-fix items and nits 1 to 4 and 6 to 8 are fixed. These are left as they are:
- **The backfill's cost and rolling deploys** (nit 5). The boot pass scans `tw_notes` for `source` set and no `title` key on every boot, with no index; the collection is small (1,000 notes a location at most). During a rolling deploy the old revision can still write an untitled TownwiseAI note after the new one's pass; the next boot names it.
- **An `other` file event with no detail and a title of only format characters** (nit 3). Nothing is left to save, so the event is skipped as invalid; the cut to 120 code points means a long title no longer drops its event.
- **The Calendars group ignores the all-locations view** (nit 9). Your data's "All locations" lists every location's items, while the Calendars group above it still shows the current location's calendars. Naming the location there, or hiding the group, is a choice for the UI review.
- **Home's day detail takes town events from `monthDay`** (nit 10). `home/DayDetail.tsx` reads town events from `dayContext` and notes, rules and imported events from `dayView`. The output matches today, since Home's filters are all on, but it is one more list than the one-helper design.

### Known limits (UI review of 2026-11-18)

The review's blocker (B1), its should-fix items (S1 to S6) and nits 2, 3, 5, 6, 8 and 11 are fixed (tasks 10.1 to 10.7). These are left as they are:
- **"Manage it on the Calendar" opens the Calendar, not the popover** (S6). Your calendars stays closed on every load (spec 16.3), so the link lands on the Calendar, whose toolbar holds "Your calendars". Opening it from a link would need a query parameter and an exception to that rule.
- **Home's day detail Forecast part has no "~"** (nit 1). It reads "About 82 guests, likely 49 to 96." under "Forecast", which says it is a forecast; the Calendar's panel marks the figure too.
- **The Calendar's key below 1024px names only the figures** (nit 4). The corner marks there (town, yours, your calendar) predate D49; Home's `MonthKey` explains them, and `FigureKey` could gain them.
- **Changing month on a `c_` page announces nothing** (nit 6, its second half). The month heading is now an h4 under Events; a live region over the whole agenda would read every event again on each move.
- **A file calendar shows no import date** (nit 7). Its row and page read "File, 4 events"; the view's `createdAt` could give "Imported Nov 16".
- **A buyout at 375px shows "BOOKED" and no "~70"** (nit 9). A phone cell holds one of them; the label says both.
- **Home's day detail says a past day with no data twice** (nit 10): "No data. 98 guests, forecast…" under Forecast, then "No sales stored for this day." under This day.
- **A note titled like a holiday hides the holiday's source from compact lists** (nit 12). Per decision 4, the earlier source (the note) wins in the month list, cells and tooltip; the day panel and Home's day detail keep every source.

## Where Claude departs from the audit

The audit of 2026-11-17 was applied in full (B1, S1 to S14, the nits), with two partial exceptions:
- **N3, the API's reason dedupe.** Kept, with the union of sources, for the reasons in decision 4.
- **N7, a first page of the next 92 days on the `c_` page.** Not taken. The page reads one month at a time, as the Calendar does, and says "No events in {Month}." for an empty month. One paging rule is simpler than two.

## Migration Plan

No schema migration. `title` is optional, and a note without it reads as null. The one data step is the boot-time title backfill of decision 3, which is idempotent. `ai.events` is computed on read from the saved answer. It ships on by default with no switch, by the owner's rule. Rollback is a revert: stored titles stay in `tw_notes` unread.

## Open Questions

- **Chat's daily chart entries.** Should it gain per-day entries in its tooltip? Claude recommends not in this change (decision 7). If the owner says yes, it is a follow-up: an API-side twin of the entries rules, frozen with the visual.
- **The Nov 16 example will still show no name.** Tell the owner in plain words: the day in his screenshot ("Booked for a private event / Private event booked") was booked by the forecast run itself, with no note behind it, so there is no name to show. Saving a note for that day with an Event name makes the name show.
- **The shared [CONFIRM]s**, each in the D49 row:
  - notes first in compact lists;
  - a rule's entry is its text;
  - 120 characters for a title;
  - a link calendar's host as text only;
  - "Your file" naming no file;
  - a forecast's figure lighter with a leading "~" and the word "forecast", an actual plain (decision 10);
  - a past day is compared with any run whose data ends before it, however late the run was made, unless the run may have read a private event note or rule written on or after the day (decision 11, amended 2026-11-18).
