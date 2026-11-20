## Context

What the code does today (develop at b49029d9, read for this design):

- **Notes** (spec 12, `api/src/stores/notes.ts`, `api/src/handlers/notes.ts`). `NoteKind` is `closure | private_event | opening | other`; `NoteEffect` is `closed | more_guests | fewer_guests | unknown`, enforced by a mongoose enum and by `sharedFields`, which business rule schedules (D31, `scheduleBody`) reuse. `readNoteContent(raw, today)` validates every note: the handlers pass `utcDay(now)`, not the town's date; the chat's `propose_note` and the D53 follow-up (`calendar/follow-up.ts`) call it too. An `other` note needs a title or detail. Notes touching a day on or before the last stored day call `wantRefitFor` (D59). Audit details are location id, kind and dates (`noteDetails`).
- **Closed and likely closed** (D32, `api/src/closed-days.ts`, mirrored in `client/src/portal/analytics/days.ts`, pinned by `api/test/fixtures/day-classes.json` and its client copy). `typicalByDate` takes the median of the open same weekdays before a day; `closureOf` reads the stored row, the typical guests and the covering notes and rules. A row with sales and a null guest count is never likely closed, and before today a rule's closure holds on it (`fewOrNoGuests`).
- **The lab input** (`api/src/lab/input.ts` `labInputOf`). `guestSpan` sets `dataThrough` from days with guests above 0. A likely-closed history day already goes out with `guests: null`. The lab trains only on days with guests above 0, not closed and not booked (`modeling/lab/townwise_lab/features.py` `training_rows`).
- **Guest consumers on the API** (each reads `salesDays.days` itself): `forecasts/reader.ts` `load` (actuals, `typicalByDate`, `closedOn`, and the `stored` days it hands to `forecasts/effects.ts` `reasonEffects`), `forecasts/score.ts` (`scoredDay` needs `actual`, `weekActual` needs every open day's), `people-in-town/history.ts` `yourHistory` (13.2), `agent/questions.ts` (typical guests for "usually busy"), `lab/suggestions.ts` (holiday `pastDays` and `reasonEffects` for the weekly pass), `orders/live.ts` (`historyGuests`, the orders baseline), and the chat's `get_sales_days`, `get_day` and visual tools.
- **Notes in the forecast** (14.5, `forecasts/adjust.ts`). Every note on a day before the town's today has outcome `past_day`. `notesDecide` (closure or `saysOpen`) drives D31's note-beats-rule and D59's `ownerBeatsAgent`; `agent/apply.ts` `decisionOf` drives D59 conflicts.
- **TownwiseAI's enums**: `propose_note`'s input schema, `files/ai-actions.ts` (a fixed vocabulary), `lab/suggestions.ts` (zod), `stores/agent-suggestions.ts` (mongoose, which also stores D53 follow-up content). None will hold the new value.

## Goals / Non-Goals

**Goals:** a person marks one or more past days' guest counts as wrong; from then on no training, typical guests, likely-closed test, effect, live accuracy, history mean, question, orders baseline or chat analysis reads those counts; sales are untouched; nothing changes for a location with no such note (the lab golden stays byte for byte).

**Non-Goals:** correcting a count (entering the right number); marking sales wrong; a Halloween feature or a lab change; TownwiseAI proposing the mark; a shortcut on the Calendar's day panel; changing record views (Your data, the sales page, monthly totals); business rules that mark counts.

## Decisions

### 1. A note effect, `wrong_guest_count`

The mark is a note with kind `other` and effect `wrong_guest_count`. It reuses the notes route, store, list, edit, delete, author rules, refit marking and calendar rendering, and its meaning (this day's guest count is not to be trusted) is exclusive with "more guests" or "fewer guests", which is what an effect is.

Alternatives: (a) a boolean field on any note (old clients parse it, since zod objects strip unknown keys, but a full-replace PATCH from an old client would drop it unless absent means keep, as `title` does; and a field combined with every kind and effect makes the lab and closure rules combinatorial); (b) a new kind (a kind sets the form's default effect and the calendar noun; a mark is not an event kind); (c) reusing `booked` (wrong: `compare.py` refuses windows with booked days and the calendar would say booked) or `closed` (the calendar, chat and live accuracy would call an open night closed).

### 2. Valid only on an Other note, strictly in the past, with nothing else

`readNoteContent(raw, today, { townToday })` accepts `wrong_guest_count` only when `townToday` is given and: kind is `other`; `endDate` is before `townToday`; `expectedGuests` is null; `startTime` and `endTime` are null. The other-needs-words rule does not apply to it. Weekdays are allowed (a counter broken every Friday in a month). Anything else is 400 `invalid_request`. The create and edit handlers pass the location's town date (`localDay(now, timeZoneOf(location.town).timeZone)`), so they load the location before validating. Callers that pass no `townToday` (the chat's `propose_note`, the D53 follow-up) refuse the effect, so TownwiseAI can never save it.

Strictly before today, not on or before: today's upload may be partial, as D32 already holds, and with every covered date before today the forecast read gives the note `past_day` on every day it covers, now and later, so no new `NoteOutcome` exists and the mark can never touch an upcoming day. The alternative, "valid any day, inert after `dataThrough`", lets a note sit on future days doing nothing, which the person would read as broken.

Business rules keep their own enum: `sharedFields.effect` stays the four values and `noteBody` extends it. A rule is a standing schedule; a wrong count is a fact about past days.

### 3. One reading: a marked day is a day with sales and no guest count

`closed-days.ts` gains:

```ts
export function isWrongGuestCount(entry: Pick<NoteContent, 'effect'>): boolean;
/** The days with guests null on every date a wrong-guest-count note covers; sales untouched; the same array when none does. */
export function trustedGuestDays<D extends { date: string; guests: number | null }>(days: readonly D[], notes: readonly CoverNote[]): D[];
```

It is applied once, where each consumer reads stored days, before anything else reads them. A marked day then behaves exactly as a day whose upload had sales and no guest count behaves today: never likely closed, never feeding a neighbor's typical guests, never in a mean or comparison, never an actual. `closureOf`, `saysOpen`, `notesDecide` and `isAllZero` do not change. The predicate is not in `saysOpen` or `notesDecide`: the mark decides nothing about open, closed or booked, so it never sets aside a rule's closure or buyout (D31), a TownwiseAI note (D59 `ownerBeatsAgent`), and `decisionOf` returns null for it (no D59 conflict).

A consequence: before today a D31 rule's closure holds on a marked day (as on any day with no guest count), so a marked Monday under "closed Mondays" reads closed. The person who means it was open adds an opening note, as today. Not special-casing keeps the client mirror and the fixture to one masking step.

The covers check is a local one in `closed-days.ts`, as `people-in-town/history.ts` has, since `agent/questions.ts` (home of `noteCovers`) imports `closed-days.ts`.

### 4. The lab input: guests null, span from stored counts

`labInputOf` passes `trustedGuestDays(args.days, args.notes)` to `typicalByDate`, the likely-closed test and the guests it sends. `guestSpan` keeps reading the stored days, so a marked last day stays `dataThrough`: the run saw that day's upload, the reader's `sawDay` stays true for it, and a past day is never turned into a forecast day. A marked history day goes out with `guests: null`, `closed: false`, its notes' other flags as before. `training_rows` drops it (`guests.gt(0)` is false for null) and the backtests never score it (they predict only training rows). No Python change, no `LAB_MODEL_VERSION` bump; the input fingerprint changes because the guests change, so the worker refits once.

### 5. The forecast read and scoring

`forecasts/reader.ts` `load` reads the wrong-guest-count notes over the whole stored range it reads (from the earliest of the typical lookback and the effects' history to yesterday; today the notes read covers only the scored days and the range), applies `trustedGuestDays` to `stored`, and builds `actuals`, `typical` and `closedOn` from it and hands it to `reasonEffects`. A marked day's `actual` is null, so `scoredDay` leaves it out, `inRange` is null, and `weekActual` is null for its week (a part week is never compared). The day keeps its forecast and shows the note's reason.

### 6. Words

- Note form, Effect for kind Other: "The guest count was wrong (sales were right)". Choosing it hides Expected guests and the hours, and the end date's helper says "Only days before today."
- Forecast reason (`noteReasonView`, any outcome): "Your note: guest count marked wrong", in the voice of "Your note: closed".
- Calendar chip and compact words (`noteChip`, used when the note has no title): "Guest count marked wrong".
- `chat/format.ts` `EFFECT_LABEL`: "Guest count marked wrong", so a note listed in chat or the agent panel reads the same.



### 7. TownwiseAI reads the mark and never makes it

`get_sales_days` and `get_day` send a marked day's guests as null with `guestCountMarkedWrong: true` and read typical guests and likely closed from trusted days. Their descriptions gain one clause: "A day with guestCountMarkedWrong true had its guest count marked wrong by the restaurant: its guests are null, its sales stand, and it is left out of typical guests." That is a frozen-prefix change (one cache miss per conversation, once), as D49's was. Visual charts read trusted days. `get_notes` already sends each note's effect. `propose_note`'s input enum, Read with TownwiseAI's vocabulary, the weekly suggestions' zod enum and `stores/agent-suggestions.ts` stay without the value.

### 8. D53 links

A create body with `fromEvent` and this effect saves the note unlinked (the link is dropped, as for an unknown event). `calendar/follow-up.ts` skips notes with this effect and expires any open follow-up for one, so a moved event never proposes moving a guest-count mark (its follow-up content would also fail the agent-suggestions enum).

### 9. The client mirror

`client/src/portal/analytics/days.ts` gains the same predicate and masking. The implementer applies it where the client turns stored days and notes into day records, before `typicalGuests` (`analytics/history.ts`) and before any guests mean or total over days (`analytics/aggregates.ts`, `week.ts`, `cells.ts`; task 5.3 lists each by grep), so Home, Analytics and the Calendar agree with the server. A marked day stays `noted` (any covering note that does not close a day). New rows in `api/test/fixtures/day-classes.json` and the client copy pin both sides. The note form checks the past-only rule against the device's today, as `noteRules.ts` checks dates now, and the API's town-date check decides.

### 10. Old clients and rollback

The web export and the API deploy together. A native build from before this release parses notes with `z.enum(NOTE_EFFECTS)` and fails a location's notes list once one note carries the effect. The repo has no `client/eas.json`, so there is no store build; a developer rebuilds. Rolling the API back leaves the notes stored (mongoose validates enums on save, not on read); the older code reads them as Other notes that change nothing, and the counts are trusted again until the release returns.

## Risks / Trade-offs

- **The lab's closed-holiday and closed-weekday rules** (`forecast.py` `closed_holidays`, `closed_weekdays`, `served`) read a null count as no guests. Marking Thanksgiving, Jan 1, Jul 4, Dec 24 or Dec 25 makes that holiday's next occurrence forecast closed when the marked one was its latest; marking all of a weekday's last 8 counted dates closes the weekday. This is today's behavior for a day with no guest count. The form's helper does not warn; the spec says so.
- **Fewer Halloween observations.** The lab's `hol_halloween` effect is shrunk toward zero by n / (n + lambda); dropping 2025 leaves 2023 and 2024. That is the intent (the owner chose to drop wrong counts, not to impute them), and task 7.2 measures it offline.
- **Weekly totals in the lab's folds** sum the remaining days of a week with a marked day on both the actual and the forecast side (`metrics.weekly_totals` has no full-week rule), so they stay comparable.
- **Champion comparison** (`compare.py`) skips a week whose open day is not a training row, so a marked day removes one comparison week, as a likely-closed day does.
- **A misuse to hide a bad forecast.** A member could mark a day to improve live accuracy. Notes carry their author and are audited; the number of marked days is visible on the calendar.

## Answers to the recon's open risks

- **(a) Lab backtests and metrics with a null actual.** Every scored row comes from `hist = features.training_rows(frame, through)` (`pipeline.py` l.345), and `backtest.rolling_predictions` predicts only `hist` rows; `_baseline_folds` and `compare.compare` read `hist` too. A null-guest day is never a row there, so no NaN reaches `metrics`.
- **(b) `served()` and closed weekdays.** `served` is `guests.gt(0) & ...`, false for NaN, and its weekly median uses `where(gt(0))`, which skips NaN. One marked Friday among 8 leaves the Friday open; see Risks for the all-marked and closing-holiday cases.
- **(c) The golden.** `trustedGuestDays` returns the input unchanged when no note has the effect, and the golden input has none, so `modeling/lab/tests/golden/api-input.json` and `hanover-calendar.json` stay byte for byte (`api/test/lab-input.test.ts` "matches the golden file").

## Migration Plan

No data migration. Release order: API and web together; then the owner adds one note from 2025-10-31 to 2025-11-01, kind Other, effect wrong guest count; the worker refits the location on its next pass. Rollback: section 10.

## Open Questions

1. Should the Calendar's day panel offer "Mark guest count wrong" on a past day with a stored row, prefilling the form? Left out (the form serves); a later change if the owner wants it.
2. Should TownwiseAI's "Questions for you" ask about a day whose spend per guest is far above usual (the Halloween signal)? Left out; it would be a new question kind.

## Implementation notes (2026-11-19)

Where the build differs from the decisions above, each the smallest change that kept them true:

- **Decision 2.** `createNote` now loads the location before it reads the body (the design asks for its town date first), so a bad body on an unknown location answers 404 where it answered 400. `readNoteContent` takes `{ keepTitle, townToday }` (`NoteReadOptions`).
- **Decision 3.** `trustedGuestDays` answers `readonly D[]`, the same array when nothing is marked. `RuleSchedule`'s effect type still inherits the widened `NoteEffect` (narrowing it cascaded through `validDays`, the suggestions and the stores), so `forecasts/reasons.ts` `EFFECT_WORDS` has an entry for the effect that no rule can reach; the rules routes refuse it.
- **Decision 5.** The reader's one notes read also spans the stored days it loads. `lab/suggestions.ts` reads its history notes from `readFrom`, not `from`, so a mark in the typical-guests lookback counts; `orders/live.ts` reads the notes over its 8 weeks. Neither changes what `covering` answers for any date it is asked about.
- **Readers.** "Your history by term state" masks inside `yourHistory` (it already takes the notes) rather than in `people-in-town/reader.ts`. `agent/questions.ts` masks only the rows its typical guests and likely-closed test read: `withSales` keeps the stored rows, so a marked row with guests and no net sales still counts as a day with sales. `rule-suggestion-views.ts` (weekday evidence reads only whether a day had sales), `calibration.ts` and `lab/service.ts` (`guestSpan`, which reads stored days as `labInputOf` does) and `handlers/sales.ts` (record views) stay unmasked.
- **Decision 9.** The client masks in `decodeHistory(body, notes)` (Home, Analytics and the month chart pass the notes; Your data's upload days and onboarding decode without them, as record views), and a marked record keeps `storedGuests` for the day panel. The Calendar page masks its sales days too, so a marked past day shows no actual there, as the API's forecast read gives none. `checkNote` takes the viewer's local date as a third argument for the past-only check. NoteForm and NoteFields take `marks`, off for a chat proposal's Edit first, whose save route refuses the effect; Details reads optional for a mark.
- **CONFIRM items** are 220 to 224 in spec 22.2: decisions 2, 3, 6 and 7 and the closing-holiday risk.
- **Docs.** `client/MODULE.md` gains a Local changes entry, as CLAUDE.md asks of every client change.

## Review fixes (2026-11-19)

After code and UI review of the build, each pinned by a test written to fail first:

- **Decision 3, amended: a marked day with sales is open.** The consequence above (a marked Monday under "closed Mondays" reads closed) made a really open day closed: the lab input sent it `closed: true` and a net-sales location dropped its real sales. The mark says the sales were right, so a marked day whose stored net sales are above 0 is open to every closure test that reads guests: `markedOpen(day, notes)` in `closed-days.ts` and its client mirror in `days.ts`, read by `closingRules` and the client's `closureOf`, keeps a rule's closure from holding on it (it was already never likely closed). It reads the covering notes, which every caller already passes. A closure note and a rule's buyout read no guests and still close it; a marked day with no sales reads as before. Its guests stay null for training and comparisons. Pinned by two rows in both `day-classes.json` copies and `lab-input.test.ts` ("a marked day with sales under a closing rule goes out open with no guest count").
- **Decision 8, amended.** An edit (PATCH) that turns a linked note into a mark removes `fromEvent` (`notes.replace`'s `unlink`), as a create drops it. Pinned by `notes.int.test.ts`.
- **Words.** Home's This day, which said "No sales stored for this day." on a marked day, says "{2} guests recorded, guest count marked wrong. Net sales {$480}."; the Calendar's day panel says the first sentence in place of "No guests stored for this day.", and its tooltip and cell label begin "Guest count marked wrong." in place of "No data.". The client's `trustedGuestDays` keeps the stored count in `storedGuests` so the Calendar can say it. The cell's visible status word stays "No data" on a marked day with no forecast figure. The note form's refusal is its own sentence, "A guest count can only be marked wrong on days before today.", announced as an alert (`DateField` passes FormField's `alert`), and the Effect helper reads "Townwise leaves this day’s guest count out of forecasts and comparisons. Its sales stay." while the mark is chosen. Spec D67, 10.5, 12, 14.5, Home's This day and CONFIRM items 221 and 222 say so.
