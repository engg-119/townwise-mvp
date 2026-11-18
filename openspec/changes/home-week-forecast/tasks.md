Built in the worktree `.worktrees/home-week-forecast` on `feat/home-week-forecast`, from develop at bb2e7dd, under Node 24. Client only. No em dashes in anything written.

## 1. Logic

- [x] 1.1 `weekForecast(week, forecast, metric)` in `client/src/portal/analytics/week.ts`: the seven days' Forecast-row figures added up (open: round(mid); closed: 0; booked: your party, else no figure), today, busiest, quietest open day; null with nothing published, a non-guests metric, or any day without a figure. With `weekForecastLabel`, `todayForecastPhrase`, `forecastDayPhrase` and `lastYearBesidePhrase`
- [x] 1.2 Tests in `client/test/portal/home/glance.test.ts`: the rounded sum, closed and buyout days, every null case, today's closed words and last year beside

## 2. Tiles

- [x] 2.1 `client/src/portal/home/Glance.tsx`: `ForecastWeekTile` when `weekForecast` finds a total, else the last-year tile unchanged; the Last week tile's forecast-only words; `Home.tsx` passes the month's published read
- [x] 2.2 Render tests in `client/test/portal/home/last-week.test.web.tsx` (the tile with a full week; a missing day keeps last year) and the new words in `last-week.test.native.tsx`

## 3. Docs

- [x] 3.1 `docs/portal/spec.md`: D43, P11's At a glance build note, CONFIRM index items 95 and 96, the changelog entry

## 4. Verify

- [x] 4.1 Lint, typecheck and the client's home, analytics and honesty suites on web and native. 2026-11-17: lint and typecheck clean; test/portal/home 16 suites, 235 tests, and with test/portal/analytics 25 suites, 506 tests, all passing on web and native
- [x] 4.2a Independent code review (2026-11-17): READY WITH NITS. Fixed: the eyebrow says "This week's forecast" so the figure never reads as a count; a buyout as the busiest day has no "about"; the range line folded into the label; a day counts only with all three figures, as the row; tests for a week into next month, a buyout busiest, quietest skipping booked days, a run-booked day and a rangeless day, and a native render. Left: the tile shows last year until the forecast read lands, as every forecast figure on Home does
- [x] 4.2b The tile in the running web app before any push. 2026-11-17, local API and Expo from this branch, Sawtooth's Hanover under view-as at 1440px and 390px: This week's forecast shows 736 guests for Tue, Nov 17 to Mon, Nov 23, exactly the Forecast row's 90 + 82 + 79 + 191 + 294 with Sunday and Monday closed; today, busiest, quietest and last year read as specified; the Last week tile shows the new words with its upload link; no console error from the page
