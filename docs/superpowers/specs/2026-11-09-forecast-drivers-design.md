# Forecast drivers: twelve months, owner adjustments, weather

Design, 2026-11-09. Status: approved by the user ("build it"), with D1 taken as option (A) until the user confirms. Sequencing revised the same day for the forecast lab (next section).

## Update after approval: the forecast lab

`feat/forecast-lab` (approved 2026-11-09, in progress in another session) packages the notebook's model as `modeling/lab/townwise_lab`, runs calibrations as an Azure job, and auto-publishes a draft run when it beats the published one. It changes this design as follows:

- **The level trap is already fixed there.** `features.add_recent_level` sets `recent_level` to 1 for the last 364 days of history and every future date, replacing `is_2026`.
- **The production horizon lives there.** Lab runs forecast `dataThrough + 1` to `dataThrough + 182`. "Twelve months" therefore means raising that to 365 with ranges by horizon band, in the lab, after it merges. The notebook v6 frozen forecast is dropped: it would be a side artifact, not the product path.
- **The lab reads terms and events from the app's town calendar,** so the 2027 calendar rows are the part of piece 1 that is safe now. They are done: `api/src/town-calendar-data.ts` (summer and fall 2027 terms from the registrar's 2027-28 key dates; Winter Carnival, Homecoming and five home football games from the October 2026 five-year calendar). The notebook CSV stays as it is, following the file's existing convention.
- **Pieces 2 and 3 wait for the lab to merge.** The lab branch edits `forecasts/file.ts`, `reader.ts`, `stores/forecasts.ts` and `chat/tools/forecast.ts`, which piece 2 needs, and its parity tests execute the notebook's own function definitions.

## Why

Kieran (Sawtooth) scales staff, ordering and prep to how busy the bar will be. Two horizons matter: this week, and the weeks after it, up to about a month, with the forecast as a whole reaching the next twelve months. Today the forecast is a frozen Oct 22 to Dec 31, 2026 run that knows the town calendar and holidays, but nothing the owner knows (bookings, things happening in town), and nothing about weather. Owners should be able to tell TownwiseAI what they know, see the forecast move, and see why every day looks the way it does.

## Three pieces, in this order

1. **Twelve-month horizon.** Small, concrete, and the other two build on it.
2. **Owner adjustments through TownwiseAI, with a rationale on every day.**
3. **Weather as a driver** for the near term.

Each piece ships and is reviewed separately. Pieces 2 and 3 depend on one team decision (D1, below).

## Goals

- G1. Sawtooth's published forecast covers the next twelve months, with ranges that widen honestly the further out a day is.
- G2. An owner tells TownwiseAI about a day, saves the proposed note, and the forecast they see for that day changes.
- G3. Every forecast day explains itself in code-made words: the model's reasons, the owner's notes, weather when known, and, for an ordinary day, why it is ordinary.
- G4. Weather improves the near-term forecast, measured with weather forecasts as they were known at the time.
- G5. Accuracy stays honest: the model is scored on its own numbers, never on numbers an owner's note changed.

## Non-goals

- Drink mix and reorder math (models 3 and 4 in the notebook).
- Forecasts for any restaurant other than Sawtooth.
- Weather beyond about 30 days ahead, or seasonal outlooks.
- A live Toast connection. Sales still arrive as Kieran's exports.
- Any change to the frozen forecasts v1 to v5 in `modeling/forecasts/`.
- A twelve-month calendar view in the app (see "My calls", C9).

## Anti-goals (failure even if it technically works)

- Weather looks useful only because the backtest used the weather that actually happened (an oracle leak, like the notebook's M4).
- An owner's 80 booked guests are added to the walk-in forecast, then scored against Toast, which never records them, and the model takes the blame.
- Owner note text (`detail`) reaches a forecast label, a log, an audit event or a run file.
- A forecast eleven months out with a range as narrow as next week's.
- Any customer or group name from Toast item names appears in an output, a file or a published page.
- 2027 days silently forecast at the 2025 level (see Piece 1, "The level trap").

## Constraints (from the code and docs, verified 2026-11-09)

- **Run file** (`api/src/forecasts/file.ts`): strict schema; `days` 1 to 400 rows, each after `dataThrough` and at most 400 days past it; `weeks` at most 60; reasons at most 6 per day, kinds `weekday | term | event | holiday | level | closure | booking`; `trainingSource` literal `'files_from_owner'`; `frozen` nullable. The 256 KB cap and some rules are duplicated in `client/src/portal/console/forecasts.ts`. A 365-day run has not been measured against 256 KB.
- **Reader** (`api/src/forecasts/reader.ts:112-126`): for each date, the newest published run whose `dataThrough` is before it (ties by `publishedAt`). A week row shows only if every day of that week came from the same run. Read windows are at most 31 days; `get_forecast` reaches 400 days ahead in 31-day calls.
- **Live accuracy** (`score.ts`): per run, open days with a `mid` and an actual, booked and closed days left out, null under 5 scored days. A run that is superseded quickly rarely reaches 5.
- **Labels are made in code** (`reasons.ts`), from the town calendar and fixed words. Nothing a partner or owner typed reaches a label.
- **The rule that pieces 2 and 3 run into.** Spec 14.4 and `docs/portal/estimates.md:7, :101`: "The API never computes a forecast and never holds a model." Changing it is D1.
- **Spec 14.1** `[DECISION NEEDED: whether staff may copy a client's uploaded days into research notebooks ...]`. Feeding owner notes into an offline model run is close to this question.
- **Notes** (`api/src/stores/notes.ts`, `handlers/notes.ts`): kind `closure | private_event | opening | other`; effect `closed | more_guests | fewer_guests | unknown`; `expectedGuests` 1 to 20000 or null; `detail` up to 280 characters; dates up to two years ahead. No field says whether walk-ins are served during a private event. Audit events for notes carry only locationId, kind, startDate and endDate (`stores/audit-events.ts:33-35`).
- **TownwiseAI**: tool registry is append-only and pinned by `api/test/chat-tools.test.ts`; `propose_note` requires every field (`additionalProperties: false`) and never writes; the prompt (`chat/prompt.ts`) is a fixed cache prefix and already says "The forecast can't answer 'what if' questions ... say what a note would let Townwise take into account" (line 26), and "Don't give a walk-in range for a booked day" (line 23).
- **Client hosts**: no page shows forecast days yet. The Home rework is on develop (`83672df`); its `home/ThisWeek.tsx` (next 7 days, already lists events and "Your note:" lines) and `home/DayDetail.tsx` (a selected day in This month) are the hosts. `estimates/format.ts:18-37` (`reasonLine`, `dayText`) already formats reasons and is unused. Spec 14.2's build note says Home shows no forecast "until a later change"; this work is that change, and updates the note.
- **Publishing gates**: nothing is published in production yet. Spec 14.4's owner decision allows publishing Sawtooth's v3 only once Sawtooth is an organization and Kieran consents, and `docs/portal/estimates.md` lists further steps before any run is published. This work doesn't change or bypass those gates; every "publishes" below means on a local stack.
- **Copy pinned by tests**: "Weather." in the model card's cannot-see list (`api/src/estimates/about.ts:34`), "Weather as a driver." in Analytics (`client/src/portal/analytics/Analytics.tsx:338`), "It can't see the weather" in the chat side panel (`client/src/chat/ui/AgentSidePanel.tsx:205`).
- **Weather data**: Open-Meteo's free API is non-commercial only (fine for a student project; a paid plan if Townwise charges), data CC BY 4.0, attribution "Weather data by Open-Meteo.com" with a link wherever weather is shown. Previous Runs API: hourly variables at lead offsets of 1 to 7 days, archived from January 2024 for most models. Historical Weather API (ERA5) for actual weather. Sources: https://open-meteo.com/en/terms, https://open-meteo.com/en/license, https://open-meteo.com/en/docs/previous-runs-api.
- **Privacy and data**: Sawtooth's exports stay in `data/` (gitignored); never copy them out; notebook outputs stay stripped; route any item name through `redact()`.
- **Working tree**: `docs/portal/spec.md` and several client files have uncommitted edits from other work. Don't overwrite them; fold doc changes in on top.

## Piece 1: twelve-month horizon

**Town calendar.**
- Notebook: `modeling/dartmouth_calendar_2025_2026.csv` ends Nov 25, 2026. Every later day reads as "interim" with no events. Add the Dartmouth dates from Dec 2026 through at least Dec 2027 (winter, spring, summer and fall terms and finals; Winter Carnival, Green Key, Commencement, orientation, Homecoming, Family Weekend, home football), in the same columns, each with a source URL and confidence. Dates not yet published (likely fall 2027 and 2027 football) get a marked estimate at low confidence.
- App: `api/src/town-calendar-data.ts` already has winter and spring 2027 terms and Commencement 2027-06-13 from the registrar, but no 2027 events and nothing after June 13, 2027. Add the same new rows there with their sources, extend the test that pins Hanover's rows against the notebook CSV, and fix the stale lines that say winter 2027 is missing (`docs/portal/estimates.md:8, :93`; `docs/portal/spec.md:1409, :1417`).
- Holidays are generated by rule in both places and need no work.

**The level trap.** Every model uses `is_2026 = (year == 2026)` (`demand_model_v0.ipynb`, section 1; `BASE`, `BASE_V5`). For a 2027 date it is 0, so the model forecasts 2027 at the 2025 level, about 22% above 2026. The twelve-month model must carry the most recent level forward instead. The builder picks the form (a level-since-a-date flag that stays on, or a trailing level), and the notebook shows the 2027 forecast against 2026's same months as a sanity check.

**Ranges that widen with horizon.** The current weekly ranges come from 28-day-ahead errors (section 9e) and would be far too narrow at eleven months. Build ranges per horizon band (for example 1 to 4 weeks, 1 to 3 months, 3 to 12 months) from backtest errors at those horizons. With about 22 months of history, a true twelve-month backtest exists only once (train through about Oct 2025, test the following year, which includes the 22% drop). Say so in the notebook and in the run's backtest summary; don't present that single fold as a calibration.

**Delivery.** A new frozen forecast (v6), committed before its outcomes exist, exported with `export_forecast_run.py` and published the usual way. Its days start on Jan 1, 2027, after v5's window. A run with the same data cutoff would win every date it shares with v5 (`stores/forecasts.ts:365`) and erase v5's pre-registered November to December test. With data through Oct 21, 2026, the 400-day limit ends v6 on Nov 25, 2027. When Kieran's next export arrives, a refit extends it to a full twelve months. Measure the run file against 256 KB; if it is over, cut reasons before cutting days.

**Done when:** the v6 run imports and publishes on a local stack, `get_forecast` answers for a day eleven months out with a range wider than next week's, January to March 2027 show the winter term and its events with sources, and no 2027 day uses the 2025 level.

## Piece 2: owner adjustments and rationales

**What the data says about private events** (45 past Sawtooth private-event nights the restaurant was open, from booking dates in Toast item names and invoice numbers, against nearby same-weekday nights; script in the session scratchpad, prints ratios only):

| Walk-in guests vs a normal night | Ordinary nights | Private-event nights |
|---|---|---|
| Below 0.6x | 9% | 23% |
| 0.6x to 0.85x | 18% | 25% |
| 0.85x to 1.25x | 52% | 27% |
| Above 1.25x | 22% | 25% |

Booked guests mostly don't appear in Toast's guest count (party nights: sales 1.34x, guests 0.98x), and walk-ins tend to drop. Reunions (3 nights, 0.37x) and grad parties (4 nights, 0.61x) push walk-ins out; plain parties (33 nights, 0.98x) usually run alongside normal service. The list is partial and the subgroups are tiny, but the direction matches the notebook's booking rule (section 9d).

**Behavior (decided with the user, from that data):**
- Booked guests are never added to the walk-in forecast. They show on their own line: "Booked: about 80 guests."
- TownwiseAI asks, when it isn't clear, whether the restaurant is open to walk-ins that night. Not open: the day is `booked` (no walk-in range), as the booking rule does today. Open, or unknown: the walk-in range stays, with its low end lowered to reflect that walk-ins often drop.
- For staffing, "how busy" is walk-ins plus booked guests, and the day's rationale says so.

**Note change.** Add a walk-ins field for private events (`walkIns: 'open' | 'closed' | null`, null meaning not known; name is the builder's call). It must be added in the API validation, the store, `propose_note`'s input schema, `NoteForm`/`noteRules.ts`, the proposal card, and the README. It is meaningless for other kinds and must be null there.

**How each note moves a day** (fixed rules in code, applied on top of the model's numbers):

| Note | Effect on the day |
|---|---|
| `closure`, or effect `closed` | status closed |
| `private_event`, walk-ins closed | status booked; booked-guests line if `expectedGuests` |
| `private_event`, walk-ins open or unknown | model range kept, low end lowered; booked-guests line if `expectedGuests` |
| `other`/`opening`, `more_guests` or `fewer_guests` with `expectedGuests` | middle moves to the owner's number; range stretched to cover both it and the model's middle |
| same, without a number | middle shifted by a default effect, range widened, labeled rough |
| effect `unknown` | numbers unchanged; the note still shows as a reason |

`expectedGuests` is the day's total, not a change: the app already shows it as "About N guests" (`client/src/portal/locations/noteRules.ts:141`). On a private event it is the booked headcount; on other notes it is the owner's expected walk-in total for the day. The `propose_note` description and the prompt say so explicitly.

When several notes cover one day: closed beats booked beats shifts. The exact low-end lowering, default effect and widening are the builder's call, set from the notebook (for example the event-night spread above and the shrunken town-event effects in section 2b), written down with their source, and pinned by tests.

**Rationales on every day.**
- New reason kinds `note` and `weather`, with labels made in code from kind, effect, walk-ins and `expectedGuests`, never from `detail`.
- An ordinary day gets a line too: "A usual Thursday in fall term: no town events, holidays or notes."
- A day beyond the weather horizon says weather isn't known that far out (after piece 3 ships).
- A day changed by a note also shows what the model alone said ("Without your note: 60 to 95 guests").
- Shown in `ThisWeek.tsx` and `DayDetail.tsx`, and returned by `get_forecast` so TownwiseAI can explain a day.

**TownwiseAI.** Prompt and `propose_note` description changes: for a private event, ask about walk-ins and an approximate booked headcount; for something happening in town, ask for a rough size and accept "not sure"; never state a number the forecast didn't give. Replace the "can't answer 'what if'" line with how notes move the forecast. The registry stays append-only; no new tool is needed.

**Week rows.** Week ranges stay the run's own, never sums of days (existing rule). When a note changes any day in a week, the week shows the model's range with a code-made line saying which days' notes it leaves out, so the week and its days never silently disagree.

**Scoring.** Live accuracy keeps scoring the model's own stored numbers; adjusted numbers are not scored in this piece. One exception, matching today's rule for days a run marks closed or booked: a day is left out if a closure or walk-ins-closed note covering it was saved before that day began. Notes saved on or after the day never change its score, so a miss can't be erased after the fact.

**Done when:** saving a proposed note from the chat changes that day in This week and in `get_forecast` with a code-made reason; the rehearsal-dinner case (80 booked, open to walk-ins) shows a walk-in range plus "Booked: about 80 guests"; the model's stored numbers are untouched by notes, and the only scoring change is the closed or booked exclusion above (tests, including a note saved after the day); no note text appears in any label, log or audit event (tests).

## Piece 3: weather

**How weather enters the model.** As a departure from normal for that date, so that where there is no forecast skill the departure is zero and the forecast is exactly the piece 1 model. Its weight is learned separately for each lead-time band.

**Features (pre-registered before results are seen, at most three):** evening precipitation, evening snowfall, and evening temperature against the normal for the date. "Evening" is 4 pm to 11 pm local. Normals come from ERA5 actuals over a multi-year baseline.

**Honest backtest.**
- Days 1 to 7: features from Open-Meteo's Previous Runs API at the matching lead (the forecast as it stood N days before), aggregated from hourly. Rolling backtest in the style of section 8, on guests.
- Shown side by side: no weather, weather as forecast, and actual weather (the oracle, labeled as an upper bound, never a result).
- Decision rule written before running, as section 9f does: weather is adopted for a lead band only if it lowers both daily and weekly WAPE on the held-out window.
- Days 8 to 30: try the NOAA GEFS 35-day ensemble mean archive (dynamical.org catalog; its old endpoint was due to end 2026-09-30, so confirm the current one) at the same leads, under the same rule. Published skill says precipitation is near climatology past about 10 days, so a null result is the expected outcome and gets reported as such. If extracting it takes more than about a day, stop, document, and skip.

**Outputs.**
- A new notebook section with the result, an honest summary in the notebook's "Answer", and a small committed weather CSV (public data, with source and license) so the backtest reproduces.
- If weather is adopted: per-band weather effects in the run file, the model card's "Weather." moved from cannot-see to inputs, the Analytics "Planned" line and the chat panel copy updated (each pinned by a test), and Open-Meteo attribution wherever a weather reason shows.
- How fresh weather reaches the owner depends on D1.

**Done when:** the notebook reports, per lead band, weather's effect on daily and weekly WAPE with forecast-as-known features, beside the oracle; and either weather is adopted with its decision rule met, or the result is documented as not helping and the product copy stays as it is.

## Decisions still needed (theirs)

- **D1. Can the API adjust a published forecast?** Options:
  - (A) Amend the rule so the API may apply fixed, code-made adjustments on top of a published run at read time: owner notes, and weather effects the run file supplies, with the API fetching the weather forecast daily. No model runs in the API. Notes apply the moment they are saved, weather stays fresh daily without staff steps, and the run's live accuracy stays meaningful.
  - (B) Keep the rule. Notes and weather change numbers only when staff rerun the notebook and publish a new run (with weather, weekly at best). Notes then fall under the spec 14.1 decision, and per-run accuracy fragments because each run lives about a week.
  - Recommended: (A). This is a team decision and goes into the spec as `[DECISION NEEDED]` until it is made.
- **D2. Refresh cadence under (B)** (moot under A): how often someone exports, imports and publishes a run.

## My calls (the builder may revisit; the user should check these)

- C1. Order of the pieces: calendar, then owner adjustments, then weather.
- C2. Weather as departure-from-normal with per-band weights; no weather past about 30 days.
- C3. Evening window 4 pm to 11 pm (lunch service ended around July 2026).
- C4. Weather sources: Open-Meteo Previous Runs (days 1 to 7), ERA5 (normals and the oracle), GEFS 35-day (days 8 to 30, try once).
- C5. Twelve-month ranges by horizon band, with the single-fold limit stated.
- C6. The 2027 level carries the latest level forward.
- C7. A walk-ins field on private-event notes, rather than inferring buyouts from kind or weekday.
- C8. For things happening in town, TownwiseAI asks for a rough size; without one, a default effect with a wider range, labeled rough.
- C9. Twelve months are reachable through TownwiseAI and the read route; the app shows days in This week and This month only. A year view is a follow-up.
- C10. Accuracy scores the model's own numbers only, leaving out days a closure or walk-ins-closed note covered before they began.
- C11. v6 starts Jan 1, 2027, so v5's November to December test keeps its live score.
- C12. A week whose days a note changed shows the model's week range plus a line naming what it leaves out, rather than an adjusted week range.
- C13. `expectedGuests` means the day's total, matching how the app already displays it.

## Left to the builder

The exact field and reason-kind names; the run file schema versioning (a `/2` schema or optional fields, as long as existing runs still read); where the adjustment code lives; the numeric adjustment constants (sourced and pinned); the weather model form within the constraints above; cache and failure handling for a daily weather fetch under (A) (a failed fetch shows the forecast without weather, never an error); how the notebook stores the committed weather CSV.
