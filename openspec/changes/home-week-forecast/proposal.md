## Why

On 2026-11-17 the owner asked whether Home should show estimated guests for today, this week and last week, and which would be most valuable. Home is built around the decisions made at the start of a week (ordering, staffing, prep), and the weekly worker now publishes a forecast for every location (D42), yet At a glance still leads with last year's total. The forecast only appears day by day in This week's strip, further down.

## What Changes

- At a glance's first tile becomes **This week's forecast** when a published forecast gives each of This week's seven days (today and the next 6) a figure in the Forecast row. Its big number is those figures added up, each rounded as the row shows it, so the row adds up to the total. It has no range: daily 80% ranges don't add up, and the run's own week rows, which carry an honest weekly range, run Monday to Sunday rather than from today. The owner chose the seven days from today, added up, as the more intuitive figure.
- The tile also gives today's figure and range, the busiest day and the quietest open day, and the same 7 days last year beside the total.
- With nothing published, a day without a figure, or a location without guests, the tile is This week, last year, unchanged.
- The Last week tile's forecast-only words become "No guest counts for these days yet. Upload your sales to see how Townwise's forecast did." It still shows no total over forecast days (D42).

## Capabilities

### New Capabilities
- `home-glance`: what At a glance's This week tile shows from a published forecast, and the Last week tile's forecast-only words.

### Modified Capabilities
None.

## Impact

- Client: `client/src/portal/analytics/week.ts` (`weekForecast` and its phrases), `client/src/portal/home/Glance.tsx` and `Home.tsx` (the forecast read passed to At a glance). Tests: `client/test/portal/home/glance.test.ts`, `last-week.test.web.tsx` and `last-week.test.native.tsx`.
- Docs: `docs/portal/spec.md` (D43, P11's At a glance, CONFIRM index items 95 and 96, the changelog).
- No API change: no new route, field, collection, env var or dependency, and no CSP change.
