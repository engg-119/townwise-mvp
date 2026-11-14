## Context

The Calendar page (P28, spec 16.3, `docs/portal/spec.md:2254`) is built from `client/src/portal/calendar/`. Today:

- **The month grid moves.** `calendarMonth` (`model.ts:232`) builds one row per week the month touches and puts `null` where a row's day is in another month, so a month is 4, 5 or 6 rows. Cells take `minHeight` from `cellSizes` (`model.ts:244`: 96, 64 and 52px), so a busy day also grows its row. A cell shows at most two entries (`MAX_CHIPS = 2`, `model.ts:171`).
- **The header wastes space.** `Toolbar.tsx` puts the month switcher, the filter chips and the `IcsImport` block in one wrapping bar with `alignItems: 'flex-end'` (`Toolbar.tsx:54`). The import block's help is always visible (`IcsImport.web.tsx:76`, `maxWidth: 520` at `:84`) and about 132px tall, so the switcher and chips sink to its bottom: about 88px and 60px of empty band under the title. Below a window of about 1,440px the block wraps to its own row, and title to grid becomes 56 + 72 + 16 + 132 + 24 = 300px with an empty area about 600 by 132px beside it.
- **Reads follow the month.** `CalendarPage.tsx:100` derives the month from `?day=` (`selected.slice(0, 7)`), and the page reads the town calendar, the past sales days (`pastRange`, `model.ts:632`) and the forecast over `monthRange(month)` (`CalendarPage.tsx:118-129`). The forecast route already accepts 42 days (`MAX_FORECAST_RANGE_DAYS = 42`, `api/src/forecasts/reader.ts:36`, used by `api/src/handlers/estimates.ts:54`); TownwiseAI's `get_forecast` keeps 31 with its own constant (`api/src/chat/tools/forecast.ts:25`). Only P28's intro (`spec.md:2256`) and the page test name "the forecast read covers exactly the shown month (one request of at most 31 days)" (`calendar.test.web.tsx:254`, named again in `client/MODULE.md:233`) still say 31.
- **Loading.** `CalendarPage.tsx:222` renders `CalendarSkeleton` (`skeleton/pages.tsx:425`), which already draws 42 cells (pinned by `test/portal/skeleton/pages.test.web.tsx:77`) but sizes them with `cellSizes(width).minHeight` and copies today's bar (switcher, four chips, a 170px import button).

Constraints that shape the design:

- Every date is a `YYYY-MM-DD` string, and date math runs through UTC (`locations/dates.ts`), so a daylight saving change never shifts a day. Weeks start on Monday (`rowOf` is `(weekday + 6) % 7`, `analytics/cells.ts:72`). "Today" is the device's date (`localToday`), fixed at mount.
- The page shows 25 months: 12 before today's to 12 after (`monthBounds`, `model.ts:605`). Every read must stay inside the API's 400 days either side of the server's day.
- The web grid is DOM (`CalendarGrid.web.tsx`): `role="grid"`, one roving tab stop, a delayed tooltip clear (`CLEAR_DELAY_MS = 80`, `:48`). Native is a Pressable per day (`CalendarGrid.tsx`).
- Home's month grid is separate and stays as it is: `MonthCell`, `monthGrid` and `monthMove` (`analytics/week.ts:451`, `:551`, `:579`) and `home/MonthGrid*.tsx`. Home imports `tooltipLines`, `ALL_FILTERS` and `CalendarInput` from `model.ts` and `DayTooltip` and `anchorOf` from `calendar/DayTooltip.web.tsx`, and its tests import `forecastDay`, `forecastOf` and `NO_FORECAST` from `test/portal/calendar/fakes.ts`. None of those change shape or behavior here.
- Colors are theme tokens only. In light mode `text2` and `text3` are both 4.5:1 on ground, panel and raised (`theme.ts:33`).
- On this branch every calendar file, `skeleton/pages.tsx` and spec P28 are ours, so the plan's interim steps for files owned elsewhere (making the Toolbar slot optional first, the import block parked under the grid, an `IcsImport` `helpId` hand-off, building cells by calling `calendarMonth` once per month, copying `eventsOn`'s filter) are not needed and are left out.
- This branch sits on `feat/forecast-calendar-rules`, which carries the 42-day route and the P28/P29 renumbering and is not yet on `develop`.

Stakeholders: the owner (request of 2026-11-12: a full grid that "won't move around", a week view, more of each day on the calendar, no dead space) and `connect-owner-calendar`, whose client tasks read stored events over this change's grid range and add a "Your calendars" panel to the header.

## Goals / Non-Goals

**Goals:**

- A month grid of exactly 42 days in 6 rows whose height depends on the window width alone.
- Leading and trailing days with their own figures, status and entries, muted, and selectable without moving the grid.
- Up to three entry lines in a month cell from 1024px.
- A week view: 7 day columns of cards on web from 641px, an agenda list at 640px and below and on native.
- One 44px header row with no empty band, and the import help behind a disclosure.
- One read per grid, of at most 42 days, clamped to the 25 months, computed in one place (`grid.ts`).
- The same keys, tab stop and screen reader words in both views and across months.
- A skeleton with the loaded page's shape.
- Delivery in two steps: step 1 (the 6-week grid and the header) ships alone; step 2 adds the week view.

**Non-Goals:**

- No API change. The route already reads 42 days.
- No hour grid and nothing that reads as an hourly forecast. `[DECISION NEEDED: hourly forecasts]` stays as it is.
- No change to Home's month grid, `monthMove`, `MonthCell`, `DayTooltip.web.tsx`, `dayView`, `forecastWords`, `tooltipLines` or `statusWord`. `CalendarCell` keeps its fields (only its `chips` comment and `MAX_CHIPS` change); the new slot types extend it.
- No change to the page shell: Content keeps its 64px bottom padding (`ui/layout.tsx:97`).
- Rows that grow to fill a tall window (the plan's F1) are not built. The browser check measures first.
- No stored events, no "Your calendars" panel and no server parsing: those are `connect-owner-calendar`'s.

## Decisions

### 1. Always 6 weeks from the Monday on or before the 1st

`gridDays(month)` is the 42 dates from `mondayOf(`${month}-01`)`. The 1st is always in row 1, and no month needs more than 6 rows.

| Month | Grid | Leading | Trailing | Rows the month needs |
|---|---|---|---|---|
| November 2026 (starts Sunday) | Oct 26 to Dec 6 | 6 | 6 | 6 |
| December 2026 | Nov 30 to Jan 10, 2027 | 1 | 10 | 5 |
| January 2027 | Dec 28, 2026 to Feb 7, 2027 | 4 | 7 | 5 |
| February 2027 (starts Monday, 28 days) | Feb 1 to Mar 14 | 0 | 14 | 4 |
| August 2027 (starts Sunday) | Jul 26 to Sep 5 | 6 | 5 | 6 |

February 2027 is the only 4-row month until 2038. The November 2026 grid holds the end of daylight saving time (Nov 1) and the March 2027 grid its start (Mar 14); both are 42 consecutive dates because nothing uses local time.

Alternatives: today's 4 to 6 rows (the page jumps, which is the complaint); rows sized from the window height through an estimated 540px of chrome (a magic number tied to layout the calendar doesn't own).

### 2. Fixed cell heights by width

Cells use `height` with `overflow: hidden`, never `minHeight`, on web and native:

| Width | Cell | Grid (16px weekday row, 6 rows, six 3px gaps) | Figure | Entry lines |
|---|---|---|---|---|
| 1024px and up | 104px | 658px | 22px | 3 |
| 641 to 1023px | 64px | 418px | 18px | 0 (corner marks) |
| 640px and below | 52px | 346px | 15px | 0 (corner marks) |

`cellSize(width)` and `gridHeight(width)` (`16 + 6 * height + 6 * 3`) live in `grid.ts` and replace `cellSizes`, which goes when its last callers (both grids and the skeleton) move.

Inside a 104px cell (94px after 8px of padding and a 2px border): row A 16px (the day number left; "BOOKED" or, under a past figure, "guests" right), row B 26px (the figure centered, "+70" inline in `mint`; on a closed or likely-closed day the status word in its place, mono 10/12 uppercase, up to two lines, "LIKELY" over "CLOSED"), row C 46px (three one-line entries, mono 11/14, ellipsis). 16 + 2 + 26 + 2 + 46 = 92px. Row B stays reserved when empty so entries line up across a week. At 641 to 1023px: the number row, then the 18px figure or the status word over two lines, and the corner marks. At 640px and below every status takes the figure's place, BOOKED included: "BOOKED" (about 32px in mono 9) doesn't fit beside a two-digit number in a 36px interior, and a booked party's figure alone would read as a forecast; "+70" and the caption leave the cell and stay in the label, tooltip and panel.

The owner chose 104px over 80px cells with one entry line, knowing the grid (658px) then ends about 1,050px down the page and its last three rows sit below the fold of a 1440 by 900 laptop.

### 3. Three entry lines from the model's chips

`MAX_CHIPS` becomes 3. `entryLines(cell)` in `grid.ts` gives what row C shows: every chip when the day has 3 entries or fewer, else the first two and "+{n} more" with n = `cell.more + 1`. Both grids use it, so web and native agree. Entries stay what they are today (holiday and town event titles, a note's `noteChip`, an imported event's title). Term and season periods mark no cell (`marksCell`, `model.ts:84`), as spec P28 says, because they span weeks; the week view and the panel list them. The one model test that pins two chips and `more: 1` for a three-entry day (`model.test.ts:153`) changes to three chips and `more: 0`.

### 4. `grid.ts`: the one place for a view's dates and ranges

`client/src/portal/calendar/grid.ts` is pure and imports only exported symbols. It holds:

- `GRID_DAYS = 42`, `gridDays(month)`, `inGrid(month, date)`.
- `gridMonthFor(selected, shown)`: `shown` while `selected` is in its 42 days, else `selected.slice(0, 7)`.
- `shownFor(shown, seen, selected)`: the month to keep after a render; `shown` while `selected === seen` (the last `?day=` the page saw), else `gridMonthFor(selected, shown)` (decision 8).
- `gridRange(month, bounds)`: the 42 days clamped to `[${bounds.first}-01, bounds.lastDay]`. For every "today" from 2026 to 2029 the clamped range reaches at most 396 days back and 396 ahead; unclamped edge grids reach 402 back and 407 ahead, past the API's 400. The 4 days of margin cover a 1-day gap between the device's date and UTC. With today 2026-11-11 the bounds are 2025-11 to 2027-11 (last day Nov 30, 2027): November 2025's grid reads Nov 1 to Dec 7, 2025, and November 2027's reads Nov 1 to 30, 2027.
- `pastRangeFor(range, today)`: `[range.from - TYPICAL_LOOKBACK_DAYS (56), min(range.to, yesterday)]`, or null when no day is past. At most 42 + 56 = 98 days, under the sales route's 366. It replaces `pastRange`, whose tests move with it.
- `buildGrid(month, input, bounds)`: 6 rows of 7 slots (decision 5).
- `cellSize`, `gridHeight`, `entryLines` (decisions 2 and 3).
- `gridMove(from, key, ctrl, at)` (decision 7).
- Step 2: `weekOf(date)`, `weekLabel(monday)`, `stepWeek(selected, step, bounds)`, `buildWeek(selected, month, input, bounds)` (decision 10).

`connect-owner-calendar`'s stored-events read calls `gridRange(month, bounds)`, so its range always equals the grid's.

`model.ts` exports what `grid.ts` needs instead of `grid.ts` copying it: `dayCell(date, input)` (the private `cellOf`, renamed because `model.test.ts` already has a local `cellOf(rows, date)` helper, with today's week computed inside; `calendarMonth` becomes a thin wrapper over it), `eventsOn` and `rangeWords`. `calendarMonth` stays: `model.test.ts` reaches cells through it 17 times and moving them is churn outside this change. The plan's interim (calling `calendarMonth` per month and indexing by date) is not needed.

Alternative: keep month ranges and add a second read for the outside days. Rejected: two busy, failed and settled states, and two forecast reads could straddle a publish and mix runs.

### 5. Slots: day, outside, pending and inert

```ts
interface DayCell extends CalendarCell { kind: 'day'; outside: boolean; pending: boolean }
interface InertCell { kind: 'inert'; date: string; label: string }
type GridSlot = DayCell | InertCell;
```

- **Outside** (in the month before or after the grid's): everything an in-month day shows, from the same reads, muted with tokens only: a transparent fill with a 1px `border` outline instead of `raised`; number, figure and entries in `text3`; the selected day still outlined `mint`, today's week still `line`. Today keeps its own number style (`white`, 600) even in an outside cell, which happens only when the grid isn't today's month (today 2026-11-03 sits in October 2026's trailing row, Sep 28 to Nov 8). Each carries `data-outside="1"`. Its label stays `cell.label`, which starts with the full date ("Thu, Dec 3, 2026" inside "November 2026"). In dark mode `text2` and `text3` are close, so the missing `raised` fill is the main cue.
- **Pending** (a month change whose reads are in flight): `buildGrid` takes covered days from `input`, whose own month may lag the grid's: covered = `gridRange(input.month, bounds)`. A date outside it shows its number only, is labeled "{Sun, Dec 13, 2026}. Loading.", keeps `data-date` and the roving tab stop, and gets no tooltip (the page's `tooltip(date)` answers null there, since `tooltipLines` would word it from reads that don't cover it). With `input.month` November and the grid on December, Nov 30 to Dec 6 show their data at once and Dec 7 on are pending.
- **Inert** (outside the 25 months): the number only in `text3`, no `data-date` (so click, hover and keys ignore it), `aria-disabled="true"`, labeled "{Sun, Dec 5, 2027}. Outside the months the calendar shows.", and nothing is read for it. With today 2026-11-11 they are Oct 27 to 31, 2025 (leading November 2025) and Dec 1 to 12, 2027 (trailing November 2027).

`CalendarGridProps.rows` widens to `CalendarCell | GridSlot | null`. A plain `CalendarCell` (no `kind`) renders as an in-month covered day and `null` as an empty gridcell, so `grid-hover.test.web.tsx`'s fixtures still compile and its `[role=gridcell]:not([data-date])` lookup still finds an empty cell (an inert one matches too). The props gain required `month` and `bounds` and `onSelect(date, moved?, month?)`, added together with their callers so typecheck stays clean: the page's one `<CalendarGrid>` and both of that test's renders (its `setup()` and the second test's own render) pass `month` and `bounds`, and nothing else in the test changes. The page's `select` stays assignable.

### 6. A selected day never leaves the grid

Clicking, Enter or Space on an outside day selects it in place; the grid stays on its month. The grid moves only on Previous, Next or Today, on PageUp or PageDown, and when the selected day leaves the 42 days (an arrow past the first or last row, browser back or forward, a link). `gridMonthFor` decides, and the shown month is not in the URL. `selectedDay` already clamps `?day=` to the 25 months, and every key move is clamped (decision 7), so the selected day is always in the shown grid and its week is always one of the grid's rows.

Alternative: a click on an outside day moves to that month, as some calendars do. Rejected: the owner asked for a grid that won't move around.

### 7. One key table for both views

`gridMove(from, key, ctrl, { layout, month, bounds })` returns `{ date, month }` (month only for PageUp and PageDown), `{ date: from, month: null }` when a key is consumed without moving, or null for a key it doesn't handle.

| Key | Month grid and week columns | Agenda (week view on web at 640px and below; native has no keys) |
|---|---|---|
| Left / Right | -1 / +1 day, across rows, weeks and months | the same |
| Up / Down | -7 / +7 days | -1 / +1 day |
| Home / End | the row's (week's) Monday / Sunday | the same |
| Ctrl or Cmd + Home / End | month view: the grid month's 1st / last day; week view: as Home / End | as Home / End |
| PageUp / PageDown | month view: the grid month -1 / +1, on the selected day's number clamped to that month's length; week view: the selected day's own month -1 / +1, the same way | as week view |
| Enter / Space / click | select; below 1024px, scroll the panel into view, as today | the same |

- PageUp/PageDown follow the APG date picker. In month view they step from the grid's month, because the selected day can sit in an outside cell: with the grid on November 2026, PageUp from Oct 28 shows October with Oct 28, PageDown from Oct 28 shows December with Dec 28, and PageDown from Dec 6 shows December with Dec 6 (the day stays, the grid moves). Stepping from the selected day's own month went wrong both ways (PageUp from Oct 28 would skip to September; PageDown from Dec 6 would skip to January). For an in-month day the two rules agree: Nov 3 to Dec 3, Jan 31 to Feb 28, 2027, Dec 31, 2026 to Jan 31, 2027, and Jan 31, 2028 to Feb 29, 2028. The week view hides the grid's month, so there the step starts from the selected day's month (PageDown from Oct 28 gives Nov 28).
- At the 25 months' ends: an arrow, PageUp or PageDown whose target is outside is consumed (default prevented, nothing called). Home, End and Ctrl+Home/End clamp instead, as `monthMove` clamps to the month: End from Mon, Nov 29, 2027 gives Nov 30, 2027 (the row's Sunday, Dec 5, is past the bounds), Home from Sun, Nov 2, 2025 gives Nov 1, 2025 (its row starts Oct 27). PageDown on November 2027 and PageUp on November 2025 are consumed.
- On a move the grid calls `onSelect(date, true, month)`, also when `date === from` with a month (PageDown from a trailing day).
- Focus: `focusNext` (`CalendarGrid.web.tsx:56`, effect `:63-70`) still focuses the new cell after a key move; pending cells guarantee it exists, so exactly one `tabindex="0"` survives a key crossing into a month whose reads are in flight. The week view focuses with `preventScroll: true`. After Previous, Next, Today or the view switch focus stays on the button and the `aria-live` label speaks. When the grid or week held focus and the focused node is gone after a render (back or forward to a day outside the grid, or across `?view`), focus moves to the selected cell with `preventScroll`. This restore lives in `CalendarPage.tsx` on web, around the one slot both views render in, not in each view: across `?view` the view that held focus unmounts and a fresh one mounts, and neither can see the other's focus. It is not tracked with `onFocus`/`onBlur`, since browsers differ on whether removing a focused node fires `blur`; instead the page's render reads `hadFocus = slot.current?.contains(document.activeElement)` (the old node is still mounted then), and its effect, which runs after the view's own `focusNext` effect, focuses the slot's `tabindex="0"` cell only when `hadFocus` was true and `document.activeElement` is now `body` or null. A click elsewhere has already moved focus out before the next render, so nothing is stolen back. The page already reads the DOM on web the same way for its panel scroll (`CalendarPage.tsx:133-137`).
- Home's `monthMove` is untouched; the Calendar grid no longer uses it.

### 8. Page state: the shown month, and the critic's fix

- `shownMonth` starts as `selected.slice(0, 7)`. Each render derives `month = gridMonthFor(selected, shownMonth)`.
- **`month` is written back into `shownMonth` only when `selected` changed since the last render** (`shownFor`, with the last seen `selected` kept in state, set during render as `useKept` does). The reason: `router.setParams` reaches the page through expo-router's navigation reducer (58.0.22; `push` and `navigate` drain through `RoutingQueueDrainer` in an effect, possibly in a transition), so an explicit `setShownMonth` and the new `?day=` need not land in the same render. With an unconditional write-back, Next from November (Nov 11 selected) can render once with `shownMonth` December and the old day, derive November (`gridMonthFor('2026-11-11', '2026-12')`), write it back, and then stay on November with Dec 1 selected, because Dec 1 is in November's grid. With the guard that render shows November once, and the next one, with Dec 1 selected, derives and keeps December. When the kept month's grid doesn't hold the old day (PageDown from a leading Oct 28 in November's grid sets December, whose grid starts Nov 30), the split render shows the month the page rendered last (`rendered`, kept in state as `seen` is, and passed to `gridMonthFor` as its fallback), never the day's own month, which would show October once and start its reads (2026-11-13, step 1 review).
- `shownMonth` is set explicitly on Previous, Next, Today, PageUp and PageDown, **before** `select`'s `if (date === selected) return` (or outside `select`): Today with today already selected, Next with the next month's 1st already selected in an outside cell, and PageDown from Dec 6 in November's grid all change the grid without changing `?day=`.
- Previous and Next step from the grid's month (`stepMonth(month, ±1)`), never from `selected.slice(0, 7)`: with Dec 3 selected in November's grid, Next shows December (not January) and Previous shows October. `canPrevious` and `canNext` compare the grid's month with the bounds.
- Every use of today's `month` in `CalendarPage.tsx` becomes the grid's month: the three reads' keys, `forecastFailed`, `busy`, the saved-note check, the Toolbar label, `canPrevious`/`canNext` and the error notice's month name. The grid's `label` becomes `monthLabel(month)` from the first render of the new month, not `monthLabel(shown.month)` (`CalendarPage.tsx:289`), so pending dates belong to the named month.
- The panel's `view` is `dayView(selected, input)` only when `gridRange(input.month, bounds)` covers `selected`; otherwise "Loading the day".
- Step 2, the URL: `?day=` is unchanged. `?view=week` is the week view, anything else the month view. The switch calls `router.setParams({ view: 'week' })` or `{ view: undefined }`; expo-router 58.0.22 drops undefined params (`fixCurrentParams`), as `Notes.tsx:124` already relies on. `select` keeps calling `setParams({ day })`, which merges, so the view survives a day change. `isAllowed` strips the query (`routing.ts:51-54`, pinned by `logic.test.ts:87`), so routing needs no change. Home's `calendarHref` links open the month view. The switch sets no state: the selected day's week is always a row of the shown grid, so Month, Week, Month returns to the grid you left unless you moved past it.
- Step 2, week Previous and Next move the selected day ±7, clamped to the bounds; `stepWeek` returns null (the button disabled in place) when that week is wholly outside them. The shown month follows through `shownFor`, so a new grid is read about every 5 weeks.

### 9. Reads: one per grid

| Read | Range |
|---|---|
| Town calendar | `gridRange(month, bounds)` |
| Sales days | `pastRangeFor(gridRange(month, bounds), today)`, or none |
| Forecast | `gridRange(month, bounds)`: one request of at most 42 days, keyed by the grid's month |
| Notes and rules | unchanged |

With today 2026-11-11: November 2026 reads the calendar and forecast `from=2026-10-26&to=2026-12-06` and sales days `from=2026-08-31&to=2026-11-10`; December 2026 reads the forecast `from=2026-11-30&to=2027-01-10` and no sales days. The week view reads nothing extra. The page never reads a forecast window's `weeks` or `runs`.

Alternative: two parallel reads merged by a `mergeWindows`. Not built: it exists only as a contingency if the 42-day route were reverted.

### 10. Week view (step 2): day columns of cards

- **Structure (web, 641px and up).** A `role="grid"` named by the week label ("Nov 16 to 22, 2026", "Nov 30 to Dec 6, 2026", "Dec 28, 2026 to Jan 3, 2027") with one `role="row"` of 7 gridcells, each a full-height column and the click target. The roving tab stop, `aria-selected`, `aria-label={cell.label}` (the month cell's words, so both views say the same) and `aria-describedby` pointing at the column's card list (`role="list"` of `role="listitem"`), so a screen reader hears the hours, terms and rules the label leaves out. No `aria-label` on the column head (ARIA 1.2 prohibits naming a generic `div`). The box has `minHeight: gridHeight(width)`, so switching views keeps the page height; columns stretch to the tallest, and the box grows only when one day's cards don't fit, which is rare and honest. Columns are about 80px wide at 1024, 104px at 1280 and 117px at 1440; titles wrap.
- **Column head**, top to bottom: "Mon 16" (with "Dec 1" on a month's 1st, and a "Today" tag under today), the status word, the figure (22px; `white`, past `text2`) with "+70" in `mint`, then one mono 11 `text3` line: the range "180 to 240" on an open forecast day (from `dayView(date, input).forecast`, worded by `rangeWords`, so it equals the tooltip's parenthesis and the panel's "Likely 180 to 240"), "guests" under a past figure, "No forecast" only when the read answered and the day is `none` with `why === 'not_covered'`, or nothing while loading or after a failure.
- **Cards.** Notes, rules (whatever the filters) and imported events from `dayView(date, input)`, the panel's own lists. Events from `eventsOn(date, input)`, never `dayView().events`, which leaves out the holidays and town events Why already names (`shownInWhy`, `model.ts:492`): a week view built from it would drop exactly the events that move the forecast. Order: all-day items first (holidays, town events, notes, rules, imported events, then terms and seasons), then timed items by start time, end time and title. Each card has a `panel` fill and a 2px left rule in its mark token (`white` holiday or town event, `text2` note or rule, `mint` imported, `line` term or season); a timed card starts with its hours in mono 10 (`hoursLine`, a rule's from `hoursLine(rule.schedule)`); the title in sans 12/16, wrapping in full (a note's `noteChip`, a rule's `text`, an event's `title`); a mono 10 `text3` sub-line with the kind words (`EVENT_WORDS[kind]`: "Holiday", "Town event", "Term", "Season", or "Federal holiday" when `scope === 'national'`, as `eventLine` words it; "Your note"; "Your calendar"; a rule's `scheduleSummary`, or "Your rule" when it has none, since a rule's `endDate` may be null and `dayMonthRange` needs an end), plus the span from `dayMonthRange` for a multi-day event, note or imported event ("Town event, Nov 20 to 22"). A term or season card is one line with an ellipsis because it repeats on most days; its full title stays in the DOM for the description. Cards are not focusable; the panel keeps the actions.
- **Inert and pending columns.** An inert day (the weeks of Oct 27, 2025 and Nov 29, 2027) is a head line only in `text3`, no `data-date`, `aria-disabled`, the inert label and no cards. A pending day shows its head line only, keeps `data-date` and the tab stop, is labeled "{date}. Loading.", has no `aria-describedby` until its cards exist and no tooltip; the box is `aria-busy`.
- **Selection and tooltip.** The selected column is outlined `mint`; today's column has its tag only. A mouse or pen over a column head shows the existing `DayTooltip` (`anchorOf(head, box)`); cards and touch show none.
- **Agenda (web at 640px and below, native at every width).** 7 rows, each a head line (date, figure, range or status) above full-width cards; the height follows the content. On web a `role="grid"` named by the week label with 7 `role="row"`s of one gridcell each, so Up and Down as ±1 day match what a screen reader announces as the next row, with the same label and description as a column. On native each row is a Pressable with `accessibilityLabel={cell.label}` and `accessibilityState={{ selected }}`, as the month cells are.
- **Files.** `CalendarWeek.tsx` (native agenda, exports the props type) and `CalendarWeek.web.tsx` (columns and the web agenda). The page renders the week view in the grid's slot; the import control sits outside that slot, so switching views never remounts it and a shown import error survives.

Alternative: an all-day lane over an hour grid. Rejected: holidays, town events and terms have no hours, so the grid sits mostly empty (about 500px in most weeks), blocks get cut off, and an hour grid beside a daily forecast invites the hourly reading the spec leaves open.

### 11. Header, filters and import

```
HANOVER, NH                                                         Location settings
Calendar
Row A, 44px, center, wrap: [Today] [‹] [›]  January 2027      [Month|Week]  [Import a calendar file]  How importing works
(full width, only when there is something to say: the help while open, "12 events from kitchen.ics.", an error)
Left, columns 1 to 8                                          | Right, columns 9 to 12, sticky (top 16)
Show on the calendar  [Holidays] [Town events] [Term dates]... | Fri, Jan 1, 2027 ...
6 rows x 104px (658px)                                        |
(64px Content padding)
```

- **Row A** (`Toolbar.tsx`): Today (link), "Previous month"/"Next month" ("Previous week"/"Next week" in week view), then the label with `aria-live="polite"`. The arrows sit before the label, whose width changes, so they never move under the pointer. From 641px the label has a fixed width of 216px (the longest week label, "Dec 28, 2026 to Jan 3, 2027", is about 200px in `ui` 14px), replacing `minWidth: 128` (`Toolbar.tsx:56`); otherwise between about 880 and 940px the month label fits Row A on one line and a week label pushes the right group onto a second, so switching views would move the page 56px. At 640px and below the label is flexible and may wrap to two lines inside the 44px row. Then the view switch (step 2): a `role="group"` named "Calendar view" holding "Month" and "Week", pressed state as `aria-pressed` on web and `accessibilityState={{ checked }}` on native (as `ToggleGroup` does), drawn in `Toolbar.tsx` with the `.tgl` look as one segmented pair (`ToggleGroup` stays as it is). Then `trailing`, an explicit slot whose children are direct flex items of Row A: from 1024px the left group (Today, the arrows and the label) takes `marginRight: 'auto'` and Row A `justifyContent: 'flex-end'`, so the switch and the slot sit at the right, and any that wrap sit at the right of the next line; the switch takes no auto margin of its own, since a second one would split the free space with the left group's. Below that the left group takes the whole row (`flexBasis: '100%'`), so the switch and the slot start their own line at the left (2026-11-13, step 1 review: with only a margin after the label, at 768 to 800px the import button stayed on the first line and "How importing works" wrapped alone). No item is taller than 44px, so nothing sinks; `slot` and `alignItems: 'flex-end'` go.
- **The trailing slot** holds the import control now and `connect-owner-calendar`'s "Your calendars" control next. `IcsImport.web.tsx` returns its pieces as direct children: the "Import a calendar file" button (opens the file picker; `describedBy` the help), a "How importing works" link-style Pressable with `aria-expanded` and `aria-controls` (the `ShowNumbers` pattern in `locations/parts.tsx`, except the help stays mounted), and a `flexBasis: '100%'` line under Row A holding the help (shown while open, `display: 'none'` while closed, so it stays in the DOM and `aria-describedby` still resolves) and the result and error messages (shown whatever the disclosure's state). `getByText(ICS_HELP)` (`calendar.test.web.tsx:392`) still finds the help. Native's `IcsImport.tsx` renders its one line, "To add events from your own calendar file, open Townwise on the web.", on that full-width line. Because that line is a `flexBasis: '100%'` item, it is the last item in Row A: the page passes any other control (`connect-owner-calendar`'s "Your calendars") before `<IcsImport>` in `trailing`, so it stays in Row A rather than under the line.
- **Filters**: `ToggleGroup` unchanged, with its "Show on the calendar" legend, exported from `Toolbar.tsx` as `CalendarFilters`. The page places it in the left column above the grid from 1024px (so the panel's top is level with the legend and the area beside the filters is the panel), after Row A from 641 to 1023px, and after the grid, before the panel, at 640px and below. On a 375 by 667 phone the filters wrap to two rows (124px) and Row A takes two lines; above the grid they would start it about 529px down (top bar about 109, header about 116, Content 32, Row A 104, 24, filters 124, 16), below the fold of a 548px viewport except the weekday row. Under the grid it starts about 389px down with its head and about 2.5 rows showing.
- **Notices**: the no-published-forecast banner stays first, above Row A; "Couldn't load the forecast for {November}." (month view) or "...for {Nov 16 to 22}." (week view, `dayMonthRange`) stays between Row A and the split, with Try again.
- **Arithmetic** (CSS px, from the styles): title to grid from 1024px is 56 + 44 + 24 + 72 + 16 = 212px, every band holding controls, against 212px with 88px and 60px of it empty today (from a window of about 1,440px) or 300px below that. At 1024px Row A after the switch and import is about 893px of a 910px content width (left group about 368, 32, switch about 132, import about 175, the link about 150, with gaps); if real metrics wrap it, the link's words become "How it works". At 375px title to grid is about 244px of controls against about 452px today.

Alternatives: the help always visible under the grid (adds about 70px there; the owner chose the disclosure); an `IcsImport` `helpId` prop with the help rendered by the page (a hand-off the plan needed only because `IcsImport` was owned elsewhere).

### 12. Loading keeps the shape

`CalendarSkeleton` draws Row A (44px blocks for Today, ‹ and ›, a 216px label block, flexible at 640px and below as the page's label is, then a 200px import block; step 2 adds a 120px switch block before it), the filters as the page places them (a legend line over four chip blocks, 72px as `ToggleGroup` is: in the left column above the month from 1024px, so the panel block's top is level with the legend; above the month from 641 to 1023px; after it at 640px and below), 6 rows of 7 cells with a fixed `height` of `cellSize(width).height` under the 16px weekday row with 3px gaps (`SkeletonText` mono is 16px, as the grid's head), and the panel. `SkeletonMonth` takes a fixed height; Home's skeleton passes 52px to empty cells (`skeleton/pages.tsx:371`), so it looks the same. On a month change the new 42 dates render at once, dimmed (opacity 0.6) and `aria-busy`, with pending days as in decision 5; the panel shows "Loading the day" until its day is covered.

### 13. Tests and fakes

- New test files under `client/test/portal/calendar/`: `grid.test.ts`, `grid.test.web.tsx`, `grid.test.native.tsx`, `toolbar.test.web.tsx`, `import.test.web.tsx`, `calendar-views.test.web.tsx` (step 1); `week.test.web.tsx`, `week.test.native.tsx` (step 2). `calendar.test.native.tsx` gains the view switch on native (step 2). jsdom has no layout, so tests pin heights and widths through the style (`style.height`, the label's 216px) and the browser check measures the boxes. A `?day=` or `?view=` changed from outside the page (browser back, a link) is driven in tests with expo-router's `router.setParams` or `router.back()` inside `act`, as `test/portal/theme-toggle.test.web.tsx` does.
- Home is pinned unchanged by its own suites, run with every calendar check: `test/portal/home/` (`month-grid-hover.test.web.tsx`, `month-grid-status.test.web.tsx`, `month-grid.test.native.tsx`, `week.test.ts` for `monthGrid` and `monthMove`, `honesty.test.ts`, `home.test.web.tsx`, `home.test.native.tsx`).
- `fakes.ts`: the forecast answers by range: the grid's month is the month of the range's 7th day (a grid has at most 6 leading days, and a clamped range starts on the 1st), that month's entry decides an `ApiError` or `NO_FORECAST`, and `days` merge from every month's window filtered to `[from, to]`, so tests seeded with `forecasts: { '2026-11': ... }` keep their figures. `forecastDay`, `forecastOf` and `NO_FORECAST` stay exactly as they are. A hold (a deferred answer per route and `from`, released by the test) makes pending days visible, since every answer is otherwise a resolved promise.
- `calendar.test.web.tsx`: `NOVEMBER_FORECAST` (`:58`) becomes `from=2026-10-26&to=2026-12-06`, the sales days (`:261`) `from=2026-08-31&to=2026-11-10`, December (`:264`) `from=2026-11-30&to=2027-01-10`, and the test at `:254` is renamed "the forecast read covers exactly the shown grid (one request of at most 42 days)", with its name in `client/MODULE.md:233`. `getByText('December 2026')` (`:267`) keeps passing because the label is the only element with exactly that text.

## Risks / Trade-offs

- [The 658px grid pushes rows 4 to 6 below the fold of a 1440 by 900 laptop (viewport about 780px; the grid's top at about 392px, its bottom at about 1,050px)] → The owner chose 104px cells for three entry lines; the top of the grid is where it is today. A `[CONFIRM: 104px cells]` marker records it.
- [Row A may wrap at 1024px once the switch and import are in it (about 893 of 910px)] → The browser check measures 1024px; the fallback shortens the link to "How it works".
- ["LIKELY" may clip at 320px (a 28px cell interior)] → The browser check measures 320px; the fallback drops the status word below 360px and keeps it in the label, tooltip and panel, as the caption already is.
- [jsdom fires no blur when a focused node is removed, and browsers differ] → Focus restore reads `hadFocus` during render instead of tracking blur; the browser check tries back and forward in Chrome and Safari.
- [expo-router may deliver `?day=` a render after `setShownMonth`] → `shownFor` writes back only on a `?day=` change; `grid.test.ts` replays the sequence and page tests pin Next, PageDown and Today from outside days.
- [A week column with many cards grows past `gridHeight`] → Rare; everything still shows, and only the week view grows.
- [Muted outside days in dark mode, where `text2` and `text3` are close] → The missing `raised` fill carries the difference; outside days stay 4.5:1.
- [Page height about 1,180px from 1024px; on a window taller than that (2560 by 1440) slack appears under the footer] → Measured first; rows that fill the window stay a follow-up.
- [The 42-day route is on `feat/forecast-calendar-rules`, not yet on `develop`] → This change lands after it. In production both ship from one `main` merge, and `deploy.yml` waits for the Container App revision before it uploads the web build, so no client asks the old API for 42 days.
- [`calendarMonth` stays though only tests call it] → Kept on purpose so 17 model tests keep their helper; it is a thin wrapper over `dayCell`.
- [Term and season periods could be read as month-cell entries] → They stay out of month cells, as spec P28 and `marksCell` do, because they span weeks; they show as one-line cards in the week view and in the panel. The proposal says the same.

## Migration Plan

Client only; nothing is stored and no data moves.

1. Land `feat/forecast-calendar-rules` on `develop` (it carries the 42-day route).
2. Step 1 on `feat/calendar-views`: `grid.ts` month parts, both month grids, the Toolbar's Row A with the import disclosure, the page's state, reads and focus restore, the skeleton, the fakes and tests, spec P28, `client/MODULE.md` and `src/portal/README.md`. Verify, then open a PR to `develop`. It ships alone.
3. Step 2 on the same branch: the week model, `CalendarWeek*`, the view switch and `?view=week`, spec P28 and `client/MODULE.md` and `src/portal/README.md` again. Verify, then a second PR (or the same one if step 1 is still open).

Rollback is a revert of either step. An old client opened with `?view=week` ignores the parameter and shows the month.

## Open Questions

- The import help says "choose it here". With the help under Row A, right below the button, it still reads correctly, so the copy (pinned by `ICS_HELP` and quoted in spec P28) is unchanged. The team may reword it.
- New `[CONFIRM]` markers for spec P28: clicking a leading or trailing day selects it in place; 104px cells; the week view as day columns of cards; the import help behind "How importing works". `[DECISION NEEDED: hourly forecasts]` stays.
- Browser measurements this design could only estimate from the styles: chip, button and label widths (the 216px label), the phone top bar, Row A at 1024px, "LIKELY" at 320px, and whether browsers fire `blur` on removal. The browser check task measures them in CSS px.
