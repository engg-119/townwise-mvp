Run every command from `.worktrees/calendar-everything` under Node 24 (`. "$HOME/.nvm/nvm.sh" && nvm use` when `node --version` is not 24). Tests come first in every group. Run only the suites a task names, one workspace at a time. Leave `npm run verify` and full suites to 7.1, after asking the release session, since the laptop also runs CI.

## 0. Before building

- [ ] 0.1 Merge develop after d6's calendar commit lands: `figureOf`, `no_data` and `no_forecast`, `headLine`, `CalendarWeek.web.tsx`, `DayTooltip.web.tsx` and spec 16.3. Resolve conflicts in d6's favor for the first tooltip line and the cell status, then record the baseline: `npm test -w @ckeith26/expo-shell -- test/portal/calendar test/portal/home`.
- [ ] 0.2 Confirm D49 is still this change's in the reservation list and unused in develop's `docs/portal/spec.md`. Check whether `suggest-closure-rules` (D46) has landed. If it has, merge it and keep its `noteCovers` seasons and `reasons.ts` season words.
- [ ] 0.3 Owner: accept or change the design's [CONFIRM]s and the chat Open Question (the defaults ship if he does not answer).

## 1. API: note titles

- [ ] 1.1 Tests in `api/test/notes.int.test.ts`:
  - save, read and clear a title;
  - 121 characters is 400;
  - an edit with no `title` key keeps it;
  - an `other` note with only a title saves;
  - a rule schedule with `title` is 400 (`api/test/business-rules.int.test.ts`);
  - a sentinel title in no log line or audit event.
- [ ] 1.2 `api/src/stores/notes.ts` (`title`, optional, max 120) and `api/src/handlers/notes.ts`:
  - `readNoteContent` reads `title` (empty is null);
  - the edit keeps a stored title when the key is absent;
  - `other` needs a title or a detail;
  - the rule schedule stays strict without `title`;
  - the equality check includes `title`;
  - the note view answers it;
  - `noteDetails` is unchanged.
- [ ] 1.3 `api/src/files/ai-actions.ts`: `title` from the event, `detail` the event's own (null when empty or equal), and the duplicate check by folded title as well. Tests: `api/test/ai-actions.int.test.ts` (the buyout and "already named" scenarios).
- [ ] 1.4 Tests first, then the code:
  - `api/src/forecasts/reasons.ts` `reasonViews` keeps one run reason per folded label (the larger |effectPct|, else the first), leaving note and rule reasons as they are. Test: `api/test/forecast-reasons.test.ts` (two "Veterans Day" reasons, two note reasons).
- [ ] 1.5 `api/src/handlers/data.ts` `aiView`: `events`, with `noteId` set while its note exists, titles null under view-as, and an empty list after the original is deleted. Tests: `api/test/data.int.test.ts`.
- [ ] 1.6 TownwiseAI tools, with tests in `api/test/chat-tools.test.ts` and `api/test/chat-data-tools.int.test.ts`:
  - `api/src/chat/tools/notes.ts` and `day.ts` return `title`;
  - `propose-note.ts` takes `title` (in `required`, nullable, max 120, never a person) and the proposal saves it;
  - add one clause to each description;
  - note in the commit that this is a frozen-prefix change, costing one cache miss per conversation.

## 2. Client: the shared entries helper

- [ ] 2.1 Tests `client/test/portal/calendar/entries.test.ts`:
  - order (notes, rules, holidays, events, imported);
  - words (title, else kind words; a rule's text);
  - `compactEntries` folds titles and never merges kind words;
  - Veterans Day from two sources;
  - tooltip entries left out when a reason names them.
- [ ] 2.2 `client/src/portal/calendar/entries.ts` (new, pure) and `client/src/portal/locations/api.ts` (`title` on `Note`, nullish for an older API).
- [ ] 2.3 `client/src/portal/calendar/model.ts`:
  - `dayCell`, `tooltipLines` (status line, 3 deduped reasons with a note reason's title, then 3 entries or 2 and "+N more") and `dayView` read the helper;
  - the label says every entry.
  - Update `client/test/portal/calendar/model.test.ts` and d6's `day-tooltip.test.web.tsx`.
- [ ] 2.4 `client/src/portal/calendar/grid.ts` `weekCards` reads the helper (compact, terms last), and a cell's yours mark covers rules. Update `grid.test.ts` and `grid.test.web.tsx`.
- [ ] 2.5 Run `npm test -w @ckeith26/expo-shell -- test/portal/calendar` and `npx eslint client/src/portal/calendar`.

## 3. Client: Calendar surfaces and links

- [ ] 3.1 `CalendarGrid.web.tsx`, `CalendarGrid.tsx`, `CalendarWeek.web.tsx`, `CalendarWeek.tsx` and `DayTooltip.web.tsx`: render the helper's lines at each width as the design's table says. Tests: `calendar.test.web.tsx` and `calendar.test.native.tsx` (the closed-with-event, booked-with-name and phone-width scenarios).
- [ ] 3.2 `CalendarDay.tsx`:
  - a note's title, kind words and detail;
  - "Your file" on an `ai_file` note;
  - each imported event's calendar chip to `data/c_<calendarId>` (the shared source chip, internal link, calendar glyph);
  - the CalendarPage passes the calendar list.
  - Test: `client/test/portal/calendar/sources.test.web.tsx` (new), including that no rendered `href` holds anything but an app path.
- [ ] 3.3 `YourCalendars.tsx`: each row gains "Open". Test: `your-calendars.test.web.tsx`.

## 4. Client: note form and note lists

- [ ] 4.1 `client/src/portal/locations/NoteFields.tsx`, `NoteForm.tsx` and `noteRules.ts`:
  - "Event name" after Kind, with its placeholder, helper and 120 limit;
  - prefilled on Edit, and from an imported title on Make a note;
  - an `other` note with only a title passes.
  - Tests: `client/test/portal/locations/note-rules.test.ts`, `notes.test.native.tsx` and `pages.test.web.tsx`.
- [ ] 4.2 The Notes page (`Notes.tsx`), Analytics' day panel (`analytics/panel.ts`), and TownwiseAI's `ProposalCard.tsx`, `SuggestionCard.tsx`, `AgentSidePanel.tsx` and `chat/format.ts` show the title. Tests: the existing suites for each, one new case each.

## 5. Client: Home

- [ ] 5.1 `client/src/portal/analytics/days.ts`:
  - `dayContext` takes rules and imported events per date;
  - `analytics/week.ts` (`thisWeek`, `monthGrid`, `monthItems`) reads the helper and gives each day its status word.
  - Tests: `client/test/portal/home/week.test.ts`.
- [ ] 5.2 `client/src/portal/home/Home.tsx` reads the calendars and the events over Home's calendar range, and a failure leaves Home showing. `ThisWeek.tsx`, `MonthGrid.web.tsx`, `MonthGrid.tsx`, `ThisMonth.tsx` (the tooltip gets imported events) and `DayDetail.tsx` (rules, imported events and every chip) render them. Tests: `client/test/portal/home/home.test.web.tsx`, `home.test.native.tsx`, `month-grid-status.test.web.tsx` and `month-grid.test.native.tsx`.

- [ ] 5.3 Parity test first, `client/test/portal/home/month-figure-parity.test.ts` (design decision 9): one fixture month through `calendarMonth` and Home's `monthGrid` gives the same figure, caption and status for every day. The fixture covers:
  - a past day with stored guests;
  - a past day that was likely closed;
  - a past day with only the run's figure;
  - a past day with neither;
  - today;
  - a future closed day, a future booked day, and a future day with no forecast.
  - It also runs once with the net sales metric.
- [ ] 5.4 `analytics/week.ts`: `monthGrid` builds each cell from `model.ts` `dayCell` (exported) over Home's `CalendarInput`, keeping Home's "This week" outline. Delete `cellFigure` and its `NO_FIGURE`. `figureOf` takes the optional metric. `ThisMonth.tsx` passes the one `CalendarInput` to both the grid and the tooltip. Run `npm test -w @ckeith26/expo-shell -- test/portal/home test/portal/calendar/model`.
- [ ] 5.5 `ThisMonth.tsx`, `MonthGrid.web.tsx` and `MonthGrid.tsx`:
  - the grid column measures its width, and cells of 88px or more show up to 2 entry lines at 96px high;
  - side by side, `flexGrow` 3 to 2, the grid's minimum 360px and the detail's 280px;
  - on web, a sticky grid column when side by side and when it fits the viewport;
  - "Open the calendar" moves under the legend.
  - Tests: `month-grid-status.test.web.tsx` (entry lines at a wide grid, marks at a narrow one) and `month-grid.test.native.tsx` (stacked, no sticky).
- [ ] 5.6 `DayDetail.tsx` and `beside.ts`: `REORDER_OVERVIEW` goes behind "How Townwise builds an order", closed by default (`aria-expanded` on web, an expanded state on native). The status line and "Open this day on Orders" stay. Tests: `home.test.web.tsx` and `home.test.native.tsx`.

## 6. Client: calendars in Your data

- [ ] 6.1 Agenda component `client/src/portal/data/item/CalendarAgenda.tsx` (web and native, reusing the week view's agenda card): events grouped by month, each linking to its day.
- [ ] 6.2 `DataPage.tsx`: the Calendars group (hidden with none; shown with stored files off). Tests: `client/test/portal/data/page.test.web.tsx` and `page.test.native.tsx`.
- [ ] 6.3 `ItemPage.tsx`: a `c_` ref renders the calendar page:
  - it makes no `org.data.get` request;
  - it shows the header facts and host as text, then the month agenda with Earlier and Later, filtered by `calendarId`;
  - an unknown id shows not found.
  - If `routing.ts` `isAllowed` needs it, allow the ref.
  - Tests: `client/test/portal/data/calendar-page.test.web.tsx` and `calendar-page.test.native.tsx` (new).
- [ ] 6.4 `item/AiSection.tsx` and `aiCopy.ts`: a `calendar` read shows its `ai.events` in the agenda, marked "Note made" or "No note made". Tests: `client/test/portal/data/item-ai.test.web.tsx` and `item-ai.test.native.tsx`.

## 7. Docs, review and ship

- [ ] 7.1 Update the docs:
  - `docs/portal/spec.md`:
    - the D49 row: the owner's two requests in his words, the decisions, Claude's calls and the [CONFIRM]s;
    - the D30 amendment;
    - 10.5 and 12: `title`, the edit rule, `other`;
    - 10.14 and 11A.9: `ai.events`;
    - 10.18: the `c_` page;
    - 14.4: one reason per label;
    - 14.5;
    - 16.3: P11, P14, P26, P27, P28 and the surface table;
    - 22.
  - `api/README.md`: notes, Your data, logs.
  - `docs/portal/tuning-chat.md`: `list_notes`, `get_day`, `propose_note`.
  - Check `client/app/(marketing)/privacy.tsx`, and change it only if it lists a note's fields.
- [ ] 7.2 Independent UI review, web and native, by an agent that did not build it. It must judge the work ready on:
  - the month grid at 1280, 800 and 375px;
  - the tooltip;
  - the week view;
  - the day panel's chips;
  - Home's four surfaces, and specifically Home's "This month in {Town}": past days show the same figures as the Calendar, and there is no empty area under the grid at 1280px and 1440px (side by side, sticky), 900px, 375px or on native, with the Reorder disclosure closed;
  - Your data's Calendars group and a `c_` page;
  - a calendar file's P27;
  - the note form's Event name.
- [ ] 7.3 `/review` of the branch, then `npm run verify` after asking the release session that the laptop is free.
- [ ] 7.4 Push only after the owner's go. He checks these on the local dev servers:
  - a closed day with a named event;
  - Nov 11 with one Veterans Day;
  - "US holidays" opening its page;
  - Home's This month on Sawtooth showing Nov 1 to 16 as the Calendar does, with no empty space.
