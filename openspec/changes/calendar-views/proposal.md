## Why

The Calendar page (P28) shows one month with blank cells before the 1st and after the last day, so the grid is 5 rows one month and 6 the next and the page jumps as the owner moves between months. Each day shows at most one truncated event, so the owner cannot see what is on the calendar without opening every day, and a four-line import note above the toolbar leaves a band of empty space under the heading. The owner asked on 2026-11-12 for a full grid that does not move, a week view and a month view with more of each day's events on the calendar itself, and no dead space.

## What Changes

- **Month view, always 6 weeks.** The grid shows the days of the previous and next months that complete its first and last weeks (muted, with their own data), so every month is 42 days in 6 rows of fixed height. Clicking a leading or trailing day selects it in place; the grid stays on its month.
- **Month cells show more.** Cells are 104px tall from desktop width and show up to three entries (holidays, town events, notes, imported events; term periods span weeks, so they show in the day panel and the week view instead) with "+N more", next to the status and the forecast figure.
- **Week view.** A Month and Week switch in the toolbar. The week view is 7 day columns, each headed by the day's forecast figure, range and status, with every item as a full card. On phones and on native it is an agenda list. The view is kept in the URL (`?view=week`).
- **No dead space.** The header becomes one 44px row (Today, previous, next, the label, the view switch, then an "Import a calendar file" button with a "How importing works" disclosure for the privacy note). The filters move into the left column above the grid, so the day panel rises beside them. The page keeps its 64px bottom padding.
- **One read for the grid.** The page reads a grid's whole 42 (or 7) days in one forecast request (the route now allows 42 days), clamped to the 25 months the page can show. `client/src/portal/calendar/grid.ts` is the one place that computes a view's date range, and the header has a slot for the "Your calendars" panel that `connect-owner-calendar` adds next.
- **Loading keeps the shape.** The page's skeleton draws the same header, 6 rows and cell heights, so nothing jumps when the data arrives.

## Capabilities

### New Capabilities
- `calendar-views`: the Calendar page's month and week views: the fixed 6-week month grid with adjacent-month days, month cell content, the week view and its phone and native agenda, the view switch and URL, keyboard and screen reader behavior across both views, the read range per view, the header layout and the loading shape.

### Modified Capabilities
None. `openspec/specs/` has no spec yet; the current Calendar behavior lives in `docs/portal/spec.md` (P28, 16.3), which this change updates.

## Impact

- **Client** (`client/src/portal/calendar/`): new `grid.ts` (pure: the 42-day and 7-day builders and `gridRange`), `CalendarWeek.tsx` and `.web.tsx`, `Toolbar.tsx` (view switch, import slot), `CalendarGrid.tsx` and `.web.tsx` (outside days, cell content, keys across months), `CalendarPage.tsx` (view state, URL, one read per grid, header layout), `IcsImport.web.tsx` and `IcsImport.tsx` (the button, the disclosure and the full-width line), `model.ts` (exports the cell builder, `eventsOn` and `rangeWords`; three entries per cell); `client/src/portal/skeleton/pages.tsx` (`CalendarSkeleton` sizing). Tests in new files under `client/test/portal/calendar/`; the page tests that pin today's one-month ranges, the forecast fake in `fakes.ts`, `model.test.ts`, `grid-hover.test.web.tsx` and the skeleton tests change with them. Home's month grid is unchanged.
- **API**: none. The forecast route already accepts 42 days per read.
- **Docs**: spec P28 (16.3): the grid, the views, the header and "one read of at most 31 days" becomes the grid's range; `client/MODULE.md` Local changes; the P28 row of `client/src/portal/README.md`.
- **Follows**: `connect-owner-calendar`'s client tasks (stored events read by `gridRange`, the "Your calendars" panel in the header slot) build on this change.
