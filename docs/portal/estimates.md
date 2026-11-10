# Estimates: build contract

People in town, the town-local "today" TownwiseAI reads, the town calendar and people in town tools, "How Townwise estimates" (the model card), and (U13B) forecast runs: the store, staff import and publish, the published forecast read, `get_forecast` and the model card's run state. Spec 10.13 (routes and shapes), 13.2 (people in town) and 14.4 (forecast runs).

## 1. What exists, and what it honestly supports

- **No forecast is published.** No model runs in the product, and none ever will in the API: staff import a run's outputs and publish it (section 8). Until a run is published for a location, the model card says so with an **In progress** tag, and `get_forecast` says "Townwise has no forecast for this location yet." Owner decision (2026-11-05): Sawtooth's frozen v3 forecast may be imported and published once Sawtooth is an organization in Townwise and the owner confirms its consent; nothing is published by this build.
- **Hanover's calendar** is seeded from the committed public `modeling/dartmouth_calendar_2025_2026.csv` (13.1) and extended from the registrar's 2026-27 and 2027-28 key dates and Dartmouth's five-year calendar, so its term state is known from winter 2025 to fall 2027 finals. Other towns have key dates and holidays only.
- **No headcount input** (residents, students in college housing, enrollment, whether housing closes between terms, event attendance, visitors) is researched for any town (owner decision, 2026-11-05). `api/src/people-in-town/sources.ts` is committed empty; every headcount is null with its reason, and every surface says Townwise can't put a number on it yet.

Rules: a headcount only when every input has a stored source; every estimate a range; no free text from a model or a partner file; labels come from code and the public calendar.

## 2. API

| id | Method and path | Policy | Body | Limiter |
|---|---|---|---|---|
| `org.people.get` | `GET /api/org/locations/:locationId/people-in-town?from=&to=` | member | none | none |
| `org.estimates.about` | `GET /api/org/locations/:locationId/estimates/about` | member | none | none |

U13B adds one member read and five staff routes:

| id | Method and path | Policy | Body | Limiter |
|---|---|---|---|---|
| `org.forecast.get` | `GET /api/org/locations/:locationId/forecast?from=&to=` | member | none | none |
| `admin.forecasts.list` | `GET /api/admin/orgs/:orgId/forecast-runs` | staff | none | none |
| `admin.forecasts.import` | `POST /api/admin/orgs/:orgId/locations/:locationId/forecast-runs` | staff | `256kb` | none |
| `admin.forecasts.publish` | `POST /api/admin/orgs/:orgId/forecast-runs/:runId/publish` | staff | `32kb` | none |
| `admin.forecasts.withdraw` | `POST /api/admin/orgs/:orgId/forecast-runs/:runId/withdraw` | staff | `32kb` | none |
| `admin.forecasts.remove` | `DELETE /api/admin/orgs/:orgId/forecast-runs/:runId` | staff | none | none |

Query and shapes: spec 10.13 and 14.4. The member reads are allowed under view-as (the chain logs `townwise.view_as_read`), both log and audit nothing, another organization's location is 404 like an unknown one.

Modules:
- `api/src/time-zones.ts`: `timeZoneOf(town)`, `localDay(at, timeZone)`, `weekdayOf(date)`.
- `api/src/people-in-town/term.ts` (term state), `estimate.ts` (the window, headcount rules, caveats), `history.ts` (day classes and your history), `sources.ts` (researched inputs, empty), `reader.ts` (the `PeopleInTownReader` port).
- `api/src/estimates/about.ts`: `MODEL_CARD`, `MODEL_CARD_VERSION`, `estimatesAbout(location, data, now)`.
- `api/src/app.ts`: `TownwiseContext.ports.peopleInTown`, built from `TownwiseDeps.peopleData` (tests) or the committed sources, and (U13B) `ports.forecasts`, the published-runs reader.
- U13B: `api/src/forecasts/file.ts` (the run file schema, its rules, issues and canonical hash), `reasons.ts` (labels from code and the calendar), `score.ts` (live accuracy), `reader.ts` (the `ForecastReader` port: `window`, `latest`); `api/src/stores/forecasts.ts` (`tw_forecast_runs`, `tw_forecasts`); `api/src/handlers/forecast-runs.ts` (staff routes); `api/src/handlers/estimates.ts` `getForecast`.

## 3. TownwiseAI

Appended to the frozen registry (`api/src/chat/tools/registry.ts`), after `propose_note`:

| Name | Input | Returns | Input view | Result view |
|---|---|---|---|---|
| `get_town_calendar` | `{ from, to }`, at most 92 days, from 2010-01-01, `to` at most 400 days after today | `{ from, to, town, researched, covers, events }`, each event with `startWeekday` and `endWeekday`, `confidence` and `sources` | `{ from, to }` | `{ from, to, town, researched, eventCount, sources }` |
| `get_people_in_town` | `{ from, to }`, at most 92 days, `from` at most 730 days back, `to` at most 400 ahead | `PeopleInTownWindow` | `{ from, to }` | `{ available, town, periods, headcount: 'range' \| 'none', sources }` |
| `get_forecast` (U13B) | `{ from, to }`, at most 31 days, `from` at most 92 days back, `to` at most 400 ahead | published runs only, rounded for speech (low down, mid nearest, high up): `model` and `earlierModels`, each with its own `accuracy` (backtest, and live over the days that run supplied), `interval`, `days`, `weeks`, `notCovered`, `about`; or `{ available: false, reason, useInstead }` | `{ from, to }` | `{ available, modelVersion, madeAt, dataThrough, days, notCovered }` (counts) |

`sources` on a card are at most 5 distinct https links `{ host, url }`. No view holds a figure.

Today: `ToolContext.today` is the town's local date and `ToolContext.timeZone` its zone; `get_location_overview` adds `todayWeekday` and `timeZone`. The budget month stays UTC.

U13B prompt lines replace "Townwise has no forecast for this location yet. Never claim or suggest that one exists, and don't predict figures.": call `get_forecast` before discussing upcoming demand and, with none, say so and answer from history and the calendar; give a forecast as its range with about eight in ten days inside it, never the middle alone, and use week rows for weeks; a booked day has no walk-in range; name the model and when it was made if asked, and its accuracy, misses included, when the owner is deciding; call a day busier or quieter only from `vsBaselinePct`; the forecast can't answer "what if" questions. Never make up a forecast.

Prompt lines (`api/src/chat/prompt.ts`, pinned by `api/test/chat.test.ts`): today and weekday in the town's time zone; use the weekday every dated row carries; say where each figure came from and which kind it is (the owner's history, public town data, a forecast once one exists); a headcount only where public counts support one, otherwise say what Townwise does know; attendance is not extra people in town; explain the town's effect from the location's own history by term state with its day counts; say which input is missing instead of filling a gap; compare tool figures and say so, never produce an estimate, range or headcount of its own.

Client tool rows (for `client/src/chat/tools.ts`, owned by the Agent page; unknown names render generically until they land):

| Tool | Running | Done | Detail |
|---|---|---|---|
| `get_town_calendar` | Reading {town}'s calendar for {range} | Read {town}'s calendar for {range} | "{n} events" (or "Holidays only; {town} isn't researched yet" when `researched` is false), then source hosts |
| `get_people_in_town` | Reading who's in {town} for {range} | Read who's in {town} for {range} | "No headcount yet" when `headcount` is `none`, "Headcount range from public counts" when `range`, then source hosts |
| `get_forecast` (U13B) | Reading Townwise's forecast for {range} | Read the forecast for {range} | "Model {modelVersion}, made {madeAt}" when `available`, else "No forecast yet" |

## 4. Client (`client/src/portal/estimates/`)

- `api.ts`: `fetchPeopleInTown(api, locationId, { from, to })`, `fetchEstimatesAbout(api, locationId)`, `monthRange(month)`, and the zod shapes. The about schema accepts only `forecast: { run: null, live: null }`, so an older client never says "no forecast" over a published run.
- `format.ts`: `rangeText`, `reasonLine`, `dayText`, `termSpans`, `termLines`, `peopleLine`, `noNumberLine`, `historyLine`, `sourceHosts`. Deterministic sentences, never model-written.
- `Provenance.tsx`: `<Provenance provenance />`, one mono line: people in town (source hosts as links, "County jobs are 2024.") or history ("From your sales, {first} to {last}, {n} days.").
- `PeopleInTownSummary.tsx`: `<PeopleInTownSummary locationId month />` for Home's "This month in {Town}", in place of its Planned line (follow-up F8, Home's unit mounts it).
- `ModelCard.tsx`: `<ModelCard locationId />`. U13B run state, for a published run: "Forecast: {label}, trained on sales exports you sent Townwise from {trainedFrom} to {dataThrough}, made {madeAt}. It saw no sales after {dataThrough}.", the 80% line, "Its ranges were widened after they ran narrow in backtests." when widened, the backtest line, and "So far: {k} of {n} days inside the range; typical miss {x}%, from {first} to {last}." over that run's own days, never an older run's (or "Not scored yet: Townwise scores it once 5 of its days have sales."); no In progress tag. The no-forecast state: In progress, what Home and TownwiseAI use instead, the card's facts, today in the town, the calendar's coverage and whether any public count is researched (Planned until one is). Mounted at the bottom of Analytics (F9) and opened from the Agent page's "How TownwiseAI works" (F10).

- U13B, the staff console (`client/src/portal/console/`): `forecasts.ts` (calls, shapes, the browser read of a run file, issue words), `ForecastRuns.tsx` (P21's Forecasts section: runs by location, Publish on drafts, Withdraw, Delete, each through a dialog that says the org's admins see it), `ForecastImport.web.tsx` (location, file, summary, Import) and `ForecastImport.tsx` (native: "Import a forecast for {org} from a computer."). `api.ts` accepts `forecast: { run, live }` with a published run.

## 5. Privacy

What reaches Anthropic through the two tools: public town data and source URLs (calendar, jobs index, researched counts), term states, and the location's own mean guests or net sales by term state and weekday with day counts. Never an email, a person's or upload's id, a note's text or author, or a file name (`api/test/chat-estimate-tools.test.ts` sentinels). For the privacy page (applied by its owner): the Anthropic item gains "public facts about your town (its calendar and who is likely in town)".

U13B, `get_forecast`: the location's published forecast ranges, code-made reasons with public source URLs, the model's version and dates, its accuracy, and the stored guests for past forecast days. Never the model, its features, training rows, the run file, the notebook commit, a stored calendar ref or a staff id (`api/test/chat-estimate-tools.test.ts`). Privacy page wording (applied in the forecast lab, D27): "Forecasts. Townwise builds your forecasts from your sales history and notes on Townwise's own servers, in a job that sees only that location's days. The model it fits learns only from your restaurant and is used only for your restaurant; Townwise keeps the results (a range of guests per day, the dates the model learned from, and how accurate it has been) and not the model. When Townwise staff import a forecast instead, it was built on the team's own computers from sales exports you sent us; that model and those exports stay with Townwise staff, are used only for your restaurant, and are deleted when your organization is deleted or when you ask. You and TownwiseAI see the results. Deleting your sales data or your organization deletes them." (the staff-import sentence awaits the owner, a [CONFIRM] in `privacy.tsx`). The Anthropic item gains "its forecast's ranges and accuracy and its calibration results"; the lab's tools send a calibration's backtest weeks and scorecard (the owner's own history), never a draft forecast day or the model (`tuning-chat.md` section 4).

## 6. Pillars

- **Transparency**: every public number names source ids that resolve (`api/test/people-estimate.test.ts` walks the window); sources carry their confidence; the model card says there is no forecast and what Townwise can't see (`client/test/portal/estimates/model-card.test.native.tsx`); "Planned" and "In progress" until the data exists.
- **Explainability**: term states and caveats in words; the location's own history by term state with day counts (`api/test/people-history.test.ts`, `client/test/portal/estimates/people-summary.test.native.tsx`); the prompt makes TownwiseAI say which kind each figure is, what is missing, and never estimate on its own (`api/test/chat.test.ts`).
- **Privacy**: tool output holds no email, id, note text or file name (`api/test/chat-estimate-tools.test.ts`); the routes log nothing and no log line carries a figure (`api/test/estimates.int.test.ts`); cross-organization ids are 404 (`api/test/isolation.int.test.ts`).
- U13B **Transparency**: every forecast figure carries its run's model version, training range and made-at date; imports, publishes, withdrawals and deletions show in the org's staff activity (`api/test/forecast-runs.int.test.ts`); drafts and withdrawn runs are invisible to owners, view-as and TownwiseAI (`api/test/estimates.int.test.ts`); the model card names the run (`client/test/portal/estimates/model-card.test.native.tsx`).
- U13B **Explainability**: ranges always, never the middle alone in the prompt; week rows never summed from days; live accuracy with misses, booked days left out, nothing under 5 days, each run scored over its own days only (`api/test/forecast-score.test.ts`, `chat-estimate-tools.test.ts`, `estimates.int.test.ts`); no forecast for a day its model saw (`estimates.int.test.ts`); reasons in code-made words (`forecast-file.test.ts`).
- U13B **Privacy**: labels come from code, never the run file; issues carry paths and codes only (`forecast-file.test.ts`, `client/test/portal/console/forecasts.test.web.tsx`); no figure in logs or audit events; runs deleted with the organization, the location and its sales data, staff ids cleared on person deletion (`forecast-runs.int.test.ts`).

## 7. Known gaps

- Hanover's calendar ends with fall 2027 finals, so from Nov 25, 2027 its term state is `unknown`. Dartmouth's five-year calendar lists Green Key, Family Weekend and orientation for 2027 without dates, so they are not entered yet. Adding either is a calendar data change (13.1).
- Days between a term's last class and its first exam read `unknown`.
- U13B: Home and Analytics show no forecast yet, even with a published run (spec 14.2 build note); the model card and TownwiseAI do. A `Provenance` kind for forecasts is not built; the model card states the run's facts in its own lines.
- U13B: `weeksScored` (`model.md` 2.6, a separate list of scored weeks) is not built. A week row in a forecast read carries its own `actual` and `inRange` once every open day has passed and none was booked, which is all the model card and TownwiseAI use; a list across all of a run's weeks waits for a page that needs it.
- U13B: no route or console view shows a draft's stored days to staff before Publish. The check before publishing is of the run file on the team's computer, before import (`infra/README.md`, Forecasts); what is stored differs from it only by refs that name no calendar entry on their day (dropped) and labels made in code. A staff preview of a draft's window is a follow-up.

## 8. Forecast runs (U13B)

Rules: spec 14.4. Staff export with `modeling/export_forecast_run.py` (standard library only; reads the frozen CSVs in `modeling/forecasts/` after checking their sha256 against the values given, maps the guest columns, writes only to the gitignored `modeling/outputs/`, prints counts and never a figure), import the file from P21 as a draft, check it, and publish it. The run file is outputs only; the API never computes a forecast and never holds a model (lab runs, below, are computed by a job, not the API). Run files trained on days owners uploaded to Townwise (`trainingSource: 'townwise_uploads'`) are refused until the team decides whether staff may use uploaded days for research (spec 14.1, DECISION NEEDED).

Forecast lab (spec D27, 14.4, 10.15): since 2026-11-09 a run can also come from a calibration. A job on Townwise's Azure servers (`modeling/lab`) refits a location's model on that location's own uploaded days and notes, with the notebook's method, and posts a draft run (`trainingSource: 'townwise_lab'`) and a scorecard to the API, which keeps outputs only; the fitted model is stored nowhere, and its code version, parameters and input hash are recorded on the run (`lab` block) so it can be reproduced. The system publishes a draft only when staff have switched the organization's forecasts on and it passes the gate in `api/src/lab/gate.ts` (at least 12 held-out weeks, at least half a point lower weekly WAPE than the published model on the same weeks, 80% ranges holding 65% to 95% of weeks, weekday bias no more than 2 points worse; a first forecast needs 12 backtest weeks with an 80% range, which 595 days of history always gives, and a weekday-median baseline beaten; a calibration needs those 595 days to start), and staff can withdraw it. "The API never computes a forecast and never holds a model" stays true; the job computes and keeps no model. The reader, the live accuracy and the model card treat a lab run like any published run (the card says "trained on sales exports you sent Townwise" for an imported run and "trained on sales history and notes you uploaded to Townwise" for a lab run, `trainedOnWords` in `client/src/portal/estimates/api.ts`). Run files with `trainingSource: 'townwise_uploads'` stay refused through the staff import until the research-copy decision (spec 14.1).
