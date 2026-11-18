Run every command from `.worktrees/calendar-everything` under Node 24 (`. "$HOME/.nvm/nvm.sh" && nvm use` when `node --version` is not 24). Tests come first in every group. Run only the suites a task names, one workspace at a time. Leave `npm run verify` and full suites to 7.3, after asking the release session, since the laptop also runs CI.

## 0. Before building

- [x] 0.1 Merge develop after d6's calendar commit lands. It brings:
  - d6's `figureOf`, `no_data` and `no_forecast`, `headLine`, `CalendarWeek.web.tsx`, `DayTooltip.web.tsx` and spec 16.3;
  - 3710fb01 ("keep hover tooltips off the hovered day"), which changed `DayTooltip.web.tsx` and `CalendarWeek.web.tsx` after this branch's base.
  - Resolve conflicts in d6's favor for the first tooltip line and the cell status, then record the baseline: `npm test -w @ckeith26/expo-shell -- test/portal/calendar test/portal/home`.
- [ ] 0.2 Confirm D49 is still this change's in the reservation list and unused in develop's `docs/portal/spec.md`. Check whether `suggest-closure-rules` (D46) has landed. If it has, merge it and keep:
  - its `noteCovers` seasons;
  - its `reasons.ts` season words;
  - its `RuleSchedule.season`.
- [ ] 0.3 Ask the owner, in plain words:
  - to accept or change the design's [CONFIRM]s;
  - the chat question: if he does not answer, chat's charts will still not list what is on each day;
  - and tell him that his Nov 16 example was booked by the forecast run itself with no note behind it, so it will still show no name until he saves a note for that day with an Event name.
  - The defaults ship if he does not answer.

## 1. API: note titles

- [x] 1.1 Tests in `api/test/notes.int.test.ts`:
  - save, read and clear a title;
  - 121 code points is 400;
  - a newline, U+202E or another `Cc` or `Cf` character is 400, and runs of spaces collapse;
  - an edit with no `title` key keeps it;
  - an older client's edit of an `other` note that has only a title (no `title` key, `detail: null`) is saved;
  - an `other` note with only a title saves;
  - a rule schedule with `title` is 400 (`api/test/business-rules.int.test.ts`);
  - a sentinel title in no log line or audit event.
- [x] 1.2 `api/src/stores/notes.ts` (`title`, optional, max 120) and `api/src/handlers/notes.ts`:
  - `readNoteContent(raw, today, { keepTitle })` cleans `title` (NFC, white space collapsed, `Cc` and `Cf` refused, 1 to 120 code points, empty is null);
  - `updateNote` merges the stored title when `!Object.hasOwn(body, 'title')`, before the `other` rule;
  - `other` needs a title or a detail;
  - the rule schedule stays strict without `title`;
  - the equality check includes `title`;
  - the note view answers `title`;
  - `noteDetails` is unchanged.
- [x] 1.3 `NoteContent` gains `title`: everything that builds or stores it reads it, or sets `title: null`. Run `npm run typecheck -w @townwise/api` and `npm test -w @townwise/api -- test/business-rules test/agent-questions test/weekly-suggestions test/chat-proposals`. The places:
  - `api/src/stores/business-rules.ts` (`RuleSchedule` omits `title`);
  - `api/src/agent/questions.ts`;
  - `api/src/lab/suggestions.ts` (the request carries no `title`);
  - `api/src/stores/agent-suggestions.ts` (a stored suggestion with none reads as null);
  - `api/src/chat/view.ts` and `api/src/handlers/chat-proposals.ts` (a stored proposal with none reads as null);
  - `api/src/handlers/agent.ts`, `handlers/chat.ts`, `handlers/weekly-suggestions.ts`, `chat/turn.ts` and `chat/tools/registry.ts`.
- [x] 1.4 The note view's `source.ref`: `f_<fileId>`, `u_<uploadId>` for a file that wrote days, or null once gone or while stored files are off, from one `files.byIds` read in `listNotes`. Tests: `api/test/notes.int.test.ts` (each of the three cases).
- [x] 1.5 `api/src/files/ai-actions.ts`:
  - `title` from the event, cleaned (`Cc` and `Cf` removed, white space collapsed, no title when empty);
  - `detail` the event's own (null when empty or equal to the title);
  - `duplicates()` checks the folded title before its `detail === null` return.
  - Tests: `api/test/ai-actions.int.test.ts` (the buyout, a title with a newline, "already named" with no detail).
- [x] 1.6 The title backfill. Tests first, `api/test/note-title-backfill.int.test.ts` (new):
  - an older note is named exactly from its read;
  - its detail is unchanged;
  - a deleted original gives null;
  - a second run and two at once write nothing more;
  - a note made after the change is never touched;
  - only counts are logged.
  - The code:
    - the query in `api/src/stores/cross-tenant.ts`;
    - `scopeForNoteTitleBackfill` in `api/src/access/policy.ts`;
    - the pass run from `api/src/main.ts` after `ensureIndexes`;
    - the write `updateOne({ _id, title: { $exists: false } }, { $set: { title } })`.
  - Update `api/test/isolation.test.ts` for the new cross-tenant import.
- [x] 1.7 `api/src/forecasts/reasons.ts` `reasonViews` keeps one run reason per folded label (the larger |effectPct|, else the first), with the union of both reasons' sources, and leaves note and rule reasons as they are. Test first: `api/test/forecast-reasons.test.ts` (two "Veterans Day" reasons with their sources, two note reasons).
- [x] 1.8 `api/src/handlers/data.ts`: `ai.events` on `getDataItem` only (not `listData`). `noteId` is set while its note exists, titles are null under view-as, and the list is empty after the original is deleted. Tests: `api/test/data.int.test.ts`:
  - `noteId` is null once its note is deleted;
  - the list answer carries no `events`;
  - a cross-organization `GET data/f_` is 404.
- [x] 1.9 TownwiseAI tools, with tests in `api/test/chat-tools.test.ts` and `api/test/chat-data-tools.int.test.ts`:
  - `api/src/chat/tools/notes.ts` and `day.ts` return `title`;
  - `propose-note.ts` takes `title` (in `required`, nullable, max 120, never a person), and the proposal saves it;
  - add one clause to each description;
  - note in the commit that this is a frozen-prefix change, costing one cache miss per conversation.

## 2. Client: the shared entries helper

- [x] 2.1 Tests `client/test/portal/calendar/entries.test.ts`:
  - order (notes, rules, holidays, events, imported);
  - words (title, else kind words; a rule's text);
  - `compactEntries` merges only across sources: Veterans Day from the town and a calendar merges, two titled notes "Holiday party" stay two, two "Private party" events of one calendar at 12:00 and 18:00 stay two, and kind words never merge;
  - tooltip entries left out when a reason names them.
- [x] 2.2 `client/src/portal/calendar/entries.ts` (new, pure), and `client/src/portal/locations/api.ts` (`title` and `source.ref` on `Note`, nullish for an older API).
- [x] 2.3 `client/src/portal/calendar/model.ts`:
  - `dayCell`, `tooltipLines` (status line, 3 deduped reasons with a note reason's title, then 3 entries or 2 and "+N more") and `dayView` read the helper;
  - the label says every entry.
  - Update `client/test/portal/calendar/model.test.ts` and `day-tooltip.test.web.tsx`.
- [x] 2.4 `client/src/portal/calendar/grid.ts` `weekCards` reads the helper (compact, terms last), and a cell's yours mark covers rules. Update `grid.test.ts` and `grid.test.web.tsx`.
- [ ] 2.5 Cross-surface parity test `client/test/portal/calendar/entries-parity.test.ts` (new): one fixture day through the `dayCell` chips, `weekCards`, `tooltipLines` and Home's This week gives the same order and dedupe, cut only by each surface's limit. Home's half is filled in by 5.2.
- [x] 2.6 Run `npm test -w @ckeith26/expo-shell -- test/portal/calendar` and `npx eslint client/src/portal/calendar`.

## 3. Client: routing, the in-app chip and Calendar surfaces

- [ ] 3.1 `client/src/portal/routing.ts`: `ITEM_REF` becomes `[ufc]_[0-9a-f]{24}`, so `isAllowed` and `isItemPath` take `c_`. Test: `client/test/portal/logic.test.ts`, which holds the `isAllowed` cases (a `c_` path is allowed and marks Your data current). This is done before any task that links to a `c_` page.
- [ ] 3.2 `client/src/portal/ui/SourceChip.tsx`: an in-app mode that takes an app path, a name and a calendar glyph, and navigates with expo-router (`Link` on web, `router.push` on native), following the `asChild` style rule. Tests: the existing `client/test/portal/ui/source-chip.test.web.tsx` and `source-chip.test.native.tsx` gain the in-app cases, and `test/portal/link-child.test.ts` still passes.
- [ ] 3.3 `CalendarGrid.web.tsx`, `CalendarGrid.tsx`, `CalendarWeek.web.tsx`, `CalendarWeek.tsx` and `DayTooltip.web.tsx` render the helper's lines at each width, as the design's table says. Tests: `calendar.test.web.tsx` and `calendar.test.native.tsx` (the closed-with-event, booked-with-name and phone-width scenarios).
- [ ] 3.4 `CalendarDay.tsx`:
  - a note's title, kind words and detail;
  - "Your file" to `data/<source.ref>` while the ref is not null;
  - each imported event's in-app chip to `data/c_<calendarId>`, named by the event's `calendar` label.
  - Test: `client/test/portal/calendar/sources.test.web.tsx` (new), including that no rendered `href` holds anything but an app path.
- [ ] 3.5 `YourCalendars.tsx`: each row gains "Open". Test: `your-calendars.test.web.tsx`.

## 4. Client: note form and note lists

- [ ] 4.1 `client/src/portal/locations/NoteFields.tsx`, `NoteForm.tsx` and `noteRules.ts`:
  - "Event name" after Kind, with its placeholder, helper and 120 limit;
  - filled on Edit, and left empty on Make a note;
  - an `other` note with only a title passes.
  - Tests: `client/test/portal/locations/note-rules.test.ts`, `notes.test.native.tsx` and `pages.test.web.tsx`; `client/test/portal/calendar/note-popover.test.web.tsx` keeps its "without its title" case unchanged.
- [ ] 4.2 The Notes page (`Notes.tsx`), Analytics' day panel (`analytics/panel.ts`), and TownwiseAI's `ProposalCard.tsx`, `SuggestionCard.tsx` and `chat/format.ts` show the title. `AgentSidePanel.tsx` is not changed. Tests: the existing suites for each, one new case each.

## 5. Client: Home

- [ ] 5.1 Home reads the events over `forecastRange(today)` in `client/src/portal/home/Home.tsx`. A failure leaves Home showing. Test first: `client/test/portal/home/home.test.web.tsx` checks that the request's range is under 92 days (Nov 1 to 30 for Nov 17) and that a refused read leaves Home showing.
- [ ] 5.2 Home's surfaces read `dayEntries` over the one `CalendarInput` built in `ThisMonth.tsx` (now with imported events), and `analytics/days.ts` is not changed:
  - `analytics/week.ts` `thisWeek`, `monthGrid` and `monthItems`, with `monthItems` still a list of items by first day, with no status;
  - `ThisWeek.tsx`, `ThisMonth.tsx` (the tooltip gets imported events) and `DayDetail.tsx` (rules, imported events and every chip).
  - Tests:
    - `client/test/portal/home/week.test.ts`, `home.test.web.tsx` and `home.test.native.tsx`;
    - Home's half of 2.5.
- [ ] 5.3 Parity test first, `client/test/portal/home/month-figure-parity.test.ts` (design decision 9): one fixture month through `calendarMonth` and Home's `monthGrid` gives the same figure, caption and status for every day. The fixture covers:
  - a past day with stored guests;
  - a past day that was likely closed;
  - a past day with only the run's figure;
  - a past day with neither;
  - today;
  - a future closed day, a future booked day, and a future day with no forecast.
  - Beside it, a Home-only net-sales expectation test: a past day shows its stored net sales in dollars, and a past day with none shows the run's guest figure captioned "forecast".
- [ ] 5.4 `analytics/week.ts`: `monthGrid` builds each cell from `model.ts` `dayCell` (exported) over Home's `CalendarInput`, keeping Home's "This week" outline.
  - Delete `cellFigure` and its `NO_FIGURE`.
  - `figureOf(date, input, metric = 'guests')` is exported; with net sales it reads stored net sales, and likely closed stays guest-based.
  - Home formats `kind: 'actual'` with `metricNumber` and every other kind with `formatCount`.
  - `ThisMonth.tsx` passes the one `CalendarInput` to both the grid and the tooltip.
  - Run `npm test -w @ckeith26/expo-shell -- test/portal/home test/portal/calendar/model`.
- [ ] 5.5 `ThisMonth.tsx`, `MonthGrid.web.tsx` and `MonthGrid.tsx`:
  - the grid column measures its width, and cells of 88px or more show up to 2 entry lines at 96px high;
  - side by side, `flexGrow` 3 to 2, the grid's minimum 360px and the detail's 280px;
  - "Open the calendar" moves under the legend.
  - Tests: `month-grid-status.test.web.tsx` (entry lines at a wide grid, marks at a narrow one) and `month-grid.test.native.tsx` (stacked).
- [ ] 5.6 `DayDetail.tsx` only: `REORDER_OVERVIEW` goes behind "How Townwise builds an order", closed by default (`aria-expanded` on web, an expanded state on native). The status line and "Open this day on Orders" stay. `home/beside.ts` and `orders/Orders.tsx` are unchanged. Tests: `home.test.web.tsx` and `home.test.native.tsx`.
- [ ] 5.7 Only if the UI review (7.2) still finds an empty area under Home's grid at 1280px or 1440px:
  - a sticky grid column on web, through a `.web` style, when side by side and when it fits the viewport;
  - first check that no ancestor has `overflow: hidden`.
  - Otherwise, mark this task not needed.

## 6. Client: calendars in Your data

- [ ] 6.1 Extract the week view's agenda card from `CalendarWeek.tsx` into `client/src/portal/calendar/AgendaCard.tsx`, with the week view importing it unchanged. Then add `client/src/portal/data/item/CalendarAgenda.tsx` (web and native), with events grouped by month, each linking to its day, and "No events in {Month}." for an empty month. Tests: `week.test.native.tsx` still passes; `client/test/portal/data/calendar-agenda.test.ts` (new).
- [ ] 6.2 `DataPage.tsx`: the Calendars group (hidden with none; shown with stored files off). Tests: `client/test/portal/data/page.test.web.tsx` and `page.test.native.tsx`.
- [ ] 6.3 `ItemPage.tsx`: a `c_` ref renders the calendar page:
  - it makes no `org.data.get` request;
  - it shows the header facts and the host as text, then the month agenda with Earlier and Later, filtered by `calendarId`;
  - an unknown id shows not found.
  - Tests: `client/test/portal/data/calendar-page.test.web.tsx` and `calendar-page.test.native.tsx` (new).
- [ ] 6.4 `item/AiSection.tsx` and `aiCopy.ts`: a `calendar` read shows its `ai.events` in the agenda, marked "Note made" or "No note made". Tests: `client/test/portal/data/item-ai.test.web.tsx` and `item-ai.test.native.tsx`.

## 7. Docs, review and ship

- [ ] 7.1 Update the docs:
  - `docs/portal/spec.md`:
    - the D49 row: the owner's requests in his words, the decisions, Claude's calls and the [CONFIRM]s;
    - the D30 amendment;
    - 10.5 and 12: `title`, its cleaning, the edit rule, `other`, `source.ref`, the backfill;
    - 10.14 and 11A.9: `ai.events` on the single item;
    - 10.18: the `c_` page;
    - 14.4: one reason per label;
    - 14.5;
    - 17: the title is never logged or audited;
    - 16.3: P11, P14, P26, P27, P28 and the surface table;
    - 22.
  - `api/README.md`: notes, Your data, the boot backfill and its log line.
  - `docs/portal/tuning-chat.md`: `list_notes`, `get_day`, `propose_note`.
  - `client/app/(marketing)/privacy.tsx`: the Notes line gains the event name.
  - `client/src/portal/README.md`: page ownership for `entries.ts`, `AgendaCard.tsx`, the agenda and the `c_` page.
- [ ] 7.2 Independent UI review, web and native, by an agent that did not build it. It must judge the work ready on:
  - the month grid at 1280, 800 and 375px;
  - the tooltip;
  - the week view;
  - the day panel's chips, including a tap on native;
  - Home's four surfaces, and specifically Home's "This month in {Town}": past days show the same figures as the Calendar, and there is no empty area under the grid at 1280px and 1440px (side by side), 900px, 375px or on native, with the Reorder disclosure closed. Its verdict on empty space decides 5.7.
  - Your data's Calendars group and a `c_` page;
  - a calendar file's P27;
  - the note form's Event name, empty on Make a note.
- [ ] 7.3 `/review` of the branch, then `npm run verify` after asking the release session that the laptop is free.
- [ ] 7.4 Push only after the owner's go. He checks these on the local dev servers:
  - a closed day with a named event;
  - Nov 11 with one Veterans Day;
  - "US holidays" opening its page;
  - Home's This month on Sawtooth showing Nov 1 to 16 as the Calendar does, with no empty space.
