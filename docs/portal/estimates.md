# Estimates: build contract

People in town, the town-local "today" TownwiseAI reads, the town calendar and people in town tools, and "How Townwise estimates" (the model card). Spec 10.13 (routes and shapes) and 13.2 (the rules). Forecast runs (store, staff import and publish, `get_forecast`, the model card's run state) are the next phase and are not built yet.

## 1. What exists, and what it honestly supports

- **No forecast.** No model runs in the product. The model card says so with an **In progress** tag, and TownwiseAI's prompt still says Townwise has no forecast for the location.
- **Hanover's calendar** is seeded from the committed public `modeling/dartmouth_calendar_2025_2026.csv` (13.1), so its term state is known from winter 2025 to fall 2026 finals. Other towns have key dates and holidays only.
- **No headcount input** (residents, students in college housing, enrollment, whether housing closes between terms, event attendance, visitors) is researched for any town (owner decision, 2026-11-05). `api/src/people-in-town/sources.ts` is committed empty; every headcount is null with its reason, and every surface says Townwise can't put a number on it yet.

Rules: a headcount only when every input has a stored source; every estimate a range; no free text from a model or a partner file; labels come from code and the public calendar.

## 2. API

| id | Method and path | Policy | Body | Limiter |
|---|---|---|---|---|
| `org.people.get` | `GET /api/org/locations/:locationId/people-in-town?from=&to=` | member | none | none |
| `org.estimates.about` | `GET /api/org/locations/:locationId/estimates/about` | member | none | none |

Query and shapes: spec 10.13. Both allowed under view-as (the chain logs `townwise.view_as_read`), both log and audit nothing, another organization's location is 404 like an unknown one.

Modules:
- `api/src/time-zones.ts`: `timeZoneOf(town)`, `localDay(at, timeZone)`, `weekdayOf(date)`.
- `api/src/people-in-town/term.ts` (term state), `estimate.ts` (the window, headcount rules, caveats), `history.ts` (day classes and your history), `sources.ts` (researched inputs, empty), `reader.ts` (the `PeopleInTownReader` port).
- `api/src/estimates/about.ts`: `MODEL_CARD`, `MODEL_CARD_VERSION`, `estimatesAbout(location, data, now)`.
- `api/src/app.ts`: `TownwiseContext.ports.peopleInTown`, built from `TownwiseDeps.peopleData` (tests) or the committed sources. Forecast runs add their reader to `ports`.

## 3. TownwiseAI

Appended to the frozen registry (`api/src/chat/tools/registry.ts`), after `propose_note`:

| Name | Input | Returns | Input view | Result view |
|---|---|---|---|---|
| `get_town_calendar` | `{ from, to }`, at most 92 days, from 2010-01-01, `to` at most 400 days after today | `{ from, to, town, researched, covers, events }`, each event with `startWeekday` and `endWeekday`, `confidence` and `sources` | `{ from, to }` | `{ from, to, town, researched, eventCount, sources }` |
| `get_people_in_town` | `{ from, to }`, at most 92 days, `from` at most 730 days back, `to` at most 400 ahead | `PeopleInTownWindow` | `{ from, to }` | `{ available, town, periods, headcount: 'range' \| 'none', sources }` |

`sources` on a card are at most 5 distinct https links `{ host, url }`. No view holds a figure.

Today: `ToolContext.today` is the town's local date and `ToolContext.timeZone` its zone; `get_location_overview` adds `todayWeekday` and `timeZone`. The budget month stays UTC.

Prompt lines (`api/src/chat/prompt.ts`, pinned by `api/test/chat.test.ts`): today and weekday in the town's time zone; use the weekday every dated row carries; say where each figure came from and which kind it is (the owner's history, public town data, a forecast once one exists); a headcount only where public counts support one, otherwise say what Townwise does know; attendance is not extra people in town; explain the town's effect from the location's own history by term state with its day counts; say which input is missing instead of filling a gap; compare tool figures and say so, never produce an estimate, range or headcount of its own.

Client tool rows (for `client/src/chat/tools.ts`, owned by the Agent page; unknown names render generically until they land):

| Tool | Running | Done | Detail |
|---|---|---|---|
| `get_town_calendar` | Reading {town}'s calendar for {range} | Read {town}'s calendar for {range} | "{n} events" (or "Holidays only; {town} isn't researched yet" when `researched` is false), then source hosts |
| `get_people_in_town` | Reading who's in {town} for {range} | Read who's in {town} for {range} | "No headcount yet" when `headcount` is `none`, "Headcount range from public counts" when `range`, then source hosts |

## 4. Client (`client/src/portal/estimates/`)

- `api.ts`: `fetchPeopleInTown(api, locationId, { from, to })`, `fetchEstimatesAbout(api, locationId)`, `monthRange(month)`, and the zod shapes. The about schema accepts only `forecast: { run: null, live: null }`, so an older client never says "no forecast" over a published run.
- `format.ts`: `rangeText`, `reasonLine`, `dayText`, `termSpans`, `termLines`, `peopleLine`, `noNumberLine`, `historyLine`, `sourceHosts`. Deterministic sentences, never model-written.
- `Provenance.tsx`: `<Provenance provenance />`, one mono line: people in town (source hosts as links, "County jobs are 2024.") or history ("From your sales, {first} to {last}, {n} days.").
- `PeopleInTownSummary.tsx`: `<PeopleInTownSummary locationId month />` for Home's "This month in {Town}", in place of its Planned line (follow-up F8, Home's unit mounts it).
- `ModelCard.tsx`: `<ModelCard locationId />`, the no-forecast state: In progress, what Home and TownwiseAI use instead, the card's facts, today in the town, the calendar's coverage and whether any public count is researched (Planned until one is). Mounted at the bottom of Analytics (F9) and opened from the Agent page's "How TownwiseAI works" (F10).

## 5. Privacy

What reaches Anthropic through the two tools: public town data and source URLs (calendar, jobs index, researched counts), term states, and the location's own mean guests or net sales by term state and weekday with day counts. Never an email, a person's or upload's id, a note's text or author, or a file name (`api/test/chat-estimate-tools.test.ts` sentinels). For the privacy page (applied by its owner): the Anthropic item gains "public facts about your town (its calendar and who is likely in town)".

## 6. Pillars

- **Transparency**: every public number names source ids that resolve (`api/test/people-estimate.test.ts` walks the window); sources carry their confidence; the model card says there is no forecast and what Townwise can't see (`client/test/portal/estimates/model-card.test.native.tsx`); "Planned" and "In progress" until the data exists.
- **Explainability**: term states and caveats in words; the location's own history by term state with day counts (`api/test/people-history.test.ts`, `client/test/portal/estimates/people-summary.test.native.tsx`); the prompt makes TownwiseAI say which kind each figure is, what is missing, and never estimate on its own (`api/test/chat.test.ts`).
- **Privacy**: tool output holds no email, id, note text or file name (`api/test/chat-estimate-tools.test.ts`); the routes log nothing and no log line carries a figure (`api/test/estimates.int.test.ts`); cross-organization ids are 404 (`api/test/isolation.int.test.ts`).

## 7. Known gaps

- Hanover's calendar has no winter 2027 classes entry, so from Nov 26, 2026 its term state is `unknown` (the break is not derived). Adding the entry, with its registrar source, is a calendar data change (13.1).
- Days between a term's last class and its first exam read `unknown`.
