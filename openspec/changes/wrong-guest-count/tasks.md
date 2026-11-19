Spec decision D67 (reserved for this change). CONFIRM index items from 220 (219 is D68's, on another branch), renumbered in 8.3. Tests first in every task. Run only the targeted suites listed (the laptop's CI runner is shared; ask before a full suite). Never print, log or commit the partner's sales figures; fixtures use made-up days. Tick a box only when its tests pass, and add a "Done:" line saying what differs from `design.md`.

## 0. Coordination

- [x] 0.1 Recheck D67 and items 220 onward against develop's `docs/portal/spec.md` (section 2 and 22.2) and the reservation list. Rebase onto develop and check whether `closed-days.ts`, `lab/input.ts`, `forecasts/reader.ts` or `handlers/notes.ts` changed since b49029d9.
  Done: D67 is not on origin/develop (29fd9c82; latest D64) and its 22.2 ends at item 218, so 220 onward is free (219 is D68's). None of the four files changed since b49029d9. Rebase skipped: the coordinator owns merging.

## 1. The predicate and the mask (design decisions 3 and 4)

- [x] 1.1 `api/src/closed-days.ts`: `isWrongGuestCount(entry)` beside `isClosure`, and `trustedGuestDays(days, notes)` with a local covers check (weekdays and range, as `people-in-town/history.ts` has). Answers the same array when no note has the effect. `closureOf`, `saysOpen`, `notesDecide` and `isAllZero` unchanged. Tests (`api/test/closed-days.test.ts`, new, or beside the fixture test): a covered date's guests null and sales kept; weekdays respected; no mark returns the same array (`toBe`); a marked day with guests 0 and sales above 0 is not likely closed and not closed; a marked day is not in a neighbor's `typicalByDate`. `npm test -w @townwise/api -- test/closed-days.test.ts`
  Done: as designed; `trustedGuestDays` answers `readonly D[]` (the same array when nothing is marked). `NoteEffect` gained the value here (type only; the mongoose enum in 2.1). 7 tests pass.
- [x] 1.2 Shared fixture: new rows in `api/test/fixtures/day-classes.json` and `client/test/portal/analytics/day-classes.json` (a marked day with a near-zero count stays `noted`, not `closed`; a neighbor's typical skips it; a marked Monday under a closed-Mondays rule is `closed`). Server side: `npm test -w @townwise/api -- test/people-history.test.ts`
  Done: three rows in both fixture copies; the server harness masks the case's day and history with `trustedGuestDays` before classifying (the client harness follows in 5.3). Without the mask exactly those 3 rows fail; with it 64 pass.

## 2. Notes accept the mark (decisions 1, 2 and 8)

- [x] 2.1 `stores/notes.ts`: `NoteEffect` and the mongoose enum gain `wrong_guest_count`. `handlers/notes.ts`: `noteBody` gets its own effect enum with the value; `sharedFields` (and so `scheduleBody`) keeps four. `readNoteContent(raw, today, { townToday })`: the effect only with `townToday`, kind `other`, `endDate < townToday`, guests null, hours null, no title or detail needed. `createNote` and `updateNote` load the location first and pass its town date. A create with `fromEvent` and the effect saves unlinked. Tests in `api/test/notes.int.test.ts`: 201 for Oct 31 to Nov 1, 2025; 400 for today, a future day, guests, hours, kind `private_event` or `closure`; the 21:00 Hanover case (UTC already tomorrow) refused; edit by author and org admin, 403 for another member; `fromEvent` dropped; refit wanted; a rule schedule with the effect 400 (in the rules suite). `npm test -w @townwise/api -- test/notes.int.test.ts test/business-rules.int.test.ts`
  Done: as designed; `readNoteContent` takes `{ keepTitle, townToday }` (`NoteReadOptions`), and `createNote` loads the location before reading the body, so a body error on an unknown location now answers 404 before 400. The rules suite already refused the effect (its enum), pinned by a new bad schedule. notes 49 and rules suites pass together (49 tests).
- [x] 2.2 `chat/tools/propose-note.ts` keeps its input enum and refuses the effect (no `townToday`); `calendar/follow-up.ts` skips such notes and expires their open follow-up. Tests: `api/test/chat-stated-notes.int.test.ts` or the proposal suite (invalid input, nothing stored), and the follow-up suite (no move written). `npm test -w @townwise/api -- test/chat-proposals.int.test.ts test/calendar-follow-up.test.ts test/calendar-follow-up.int.test.ts`.
  Done: `propose_note` unchanged (no `townToday`, so `readNoteContent` refuses); pinned in `chat-stated-notes.int.test.ts` (plain or not: the invalid-input message, no card, nothing stored). `followUpOf` skips a mark; the unit case with a later-dated mark failed before the skip. Ran calendar-follow-up (10), calendar-follow-up.int plus chat-proposals.int (26), chat-stated-notes.int (10).
- [x] 2.3 D59 precedence: tests that a mark is not in `notesDecide`, `ownerBeatsAgent` keeps a TownwiseAI note beside a person's mark, and `agent/apply.ts` `conflictsWith` is false against a mark. `npm test -w @townwise/api -- test/forecast-adjust.test.ts test/agent-apply.test.ts`
  Done: no code change; pinned in `forecast-adjust.test.ts` (ownerBeatsAgent keeps TownwiseAI's note beside a mark; both past_day; a rule's closure still holds) and `agent-apply.test.ts` (`conflictsWith` false against a mark). 37 pass.

## 3. The lab input (decision 4)

- [x] 3.1 `lab/input.ts` `labInputOf`: trusted days for `typicalByDate`, the likely-closed test and the guests sent; `guestSpan` on the stored days. Tests in `api/test/lab-input.test.ts` (new cases; the golden unchanged): Halloween weekend marked goes out `guests` null and `closed` false; a marked last day stays `dataThrough`; a neighbor's likely-closed result ignores the marked count; the fingerprint changes with the note and not without; the golden test passes untouched. `npm test -w @townwise/api -- test/lab-input.test.ts test/lab-contract.test.ts`
  Done: as designed (trusted rows for typical guests, the likely-closed test, rule closures and the guests sent; `guestSpan` on stored days). Five new cases, including a TownwiseAI party beside a mark keeping privateEvent. lab-input plus lab-contract: 47 pass, golden unchanged.
- [x] 3.2 Lab side, no change: `cd modeling/lab && uv run pytest tests/test_contract.py tests/test_parity.py`
  Done: 27 passed; `modeling/lab/tests/golden/` unchanged.

## 4. Forecast read, scoring and other analyses (decisions 3, 5 and 7)

- [ ] 4.1 `forecasts/reader.ts` `load`: read the marks over the whole stored range it reads, mask `stored`, and build `actuals`, `typical`, `closedOn` and `reasonEffects` from it. Tests: a marked day's `actual` null, `scored` false, its week's `actual` null; a holiday effect computed without it (`api/test/forecast-reasons.test.ts` for `reasonEffects`, and the reader's int suite, found by `grep -l "liveAccuracy\|forecastWindow" api/test`). `npm test -w @townwise/api -- test/forecast-reasons.test.ts test/forecast-score.test.ts`
- [ ] 4.2 `forecasts/reasons.ts` `noteLabel`: "Your note: guest count marked wrong" for the effect. Test in `api/test/forecast-reasons.test.ts` beside 'Your note: closed'. Same command.
- [ ] 4.3 Mask at each other reader: `people-in-town/reader.ts` (before `yourHistory`), `agent/questions.ts` input days (typical guests), `lab/suggestions.ts` (`reasonEffects`, `typicalByDate`, `pastDaysOf`), `orders/live.ts` (`historyGuests`). Then `grep -rn "salesDays.days\|salesDays.history\|typicalByDate\|typicalGuests(" api/src` and list in the Done line every reader left unmasked with the reason (record views only). Tests: `api/test/people-history.test.ts`, `api/test/agent-questions.test.ts` (a marked zero-count day is never asked about), `api/test/orders-engine.test.ts` or the live board test (baseline skips it). `npm test -w @townwise/api -- test/people-history.test.ts test/agent-questions.test.ts test/orders-engine.test.ts`
- [ ] 4.4 Chat: `get_sales_days` and `get_day` send a marked day's guests null with `guestCountMarkedWrong: true` and read typical and likely closed from trusted days; one clause added to each description (frozen prefix); `visual.ts` draws trusted days. Tests: `api/test/chat-data-tools.int.test.ts` (or the tool's unit suite), `api/test/chat-visual.test.ts`, and the tools' description snapshot if one exists. `npm test -w @townwise/api -- test/chat-tools.test.ts test/chat-visual.test.ts test/chat-data-tools.int.test.ts`
- [ ] 4.5 Isolation and privacy: no new route; `api/test/isolation.test.ts` still passes (no new file reaches stores across tenants). No log line or audit detail gains a figure. `npm test -w @townwise/api -- test/isolation.test.ts`

## 5. Client (decisions 6, 9 and 10)

- [ ] 5.1 `portal/locations/api.ts` `NOTE_EFFECTS` gains the value; `chat/api.ts` keeps its proposal enum without it (it imports `NOTE_EFFECTS` today: give the proposal its own list); `chat/format.ts` `EFFECT_LABEL` "Guest count marked wrong". Tests: `client/test/portal/locations/note-rules.test.ts`, the chat proposal parse test. `npm test -w @ckeith26/expo-shell -- test/portal/locations/note-rules.test.ts`
- [ ] 5.2 `NoteFields.tsx` and `noteRules.ts`: the option "The guest count was wrong (sales were right)" for kind Other only; while chosen, Expected guests and hours hidden and sent null; `checkNote` refuses an end on or after today with words; the title-or-detail rule skipped for it. Tests in `client/test/portal/locations/` (web and native). `npm test -w @ckeith26/expo-shell -- test/portal/locations`
- [ ] 5.3 `portal/analytics/days.ts`: `isWrongGuestCount` and the mask, applied where day records are built (`history.ts` before `typicalGuests`, and every guests mean or total in `aggregates.ts`, `week.ts`, `cells.ts`); the day panel shows the stored count with "Guest count marked wrong". Client fixture copy from 1.2. `npm test -w @ckeith26/expo-shell -- test/portal/analytics`
- [ ] 5.4 `portal/calendar/entries.ts` `noteChip`: "Guest count marked wrong" for the effect. Tests: `client/test/portal/calendar/entries.test.ts`, `entries-parity.test.ts`. `npm test -w @ckeith26/expo-shell -- test/portal/calendar/entries.test.ts test/portal/calendar/entries-parity.test.ts`
- [ ] 5.5 Independent UI review on a DB copy with made-up days (memory: UI review without owner sign-in): add a mark on a past day, see the calendar chip, the forecast day's reason with no actual, and the Analytics day panel; web and phone width.

## 6. Docs

- [ ] 6.1 `docs/portal/spec.md`: a D67 row in section 2 (same columns as D64's); F12 (the mark is a note); 6.7 (`tw_notes` effect value); 10.5 (the body rules and 400s); 12 (the `NoteEffect` type, the rules of decision 2, the words); 13.2 and D32's text (marked days read as no guest count); 14.4 (live accuracy and effects leave them out); 14.5 (the mark is listed `past_day` and changes no number); 22.2 items from 220 (design.md's [CONFIRM] markers: decisions 2, 3, 6, 7 and the closing-holiday risk); 23 changelog. `api/README.md`: the notes routes' body rules and 400s, `tw_notes`, and the narrative on notes and the forecast. `docs/portal/tuning-chat.md`: the two tool descriptions' new clause and `guestCountMarkedWrong`, and that `propose_note` never proposes the mark.

## 7. After release

- [ ] 7.1 The owner adds one note: kind Other, effect "The guest count was wrong (sales were right)", 2025-10-31 to 2025-11-01. Check that the location is marked for a refit and the next worker pass refits it.
- [ ] 7.2 Offline comparison, never committed: on a local copy of the partner's data, run the lab with and without the mark. Report both engines' backtest WAPE, weekday bias and the Halloween weekend forecast for 2026 to the owner as counts and metrics only.

## 8. Verification and landing

- [ ] 8.1 `npm run lint` on changed files and `npm run typecheck`.
- [ ] 8.2 The targeted suites above, then `test/isolation.test.ts`, `test/isolation.int.test.ts` and the view-as and open-as-admin route tests.
- [ ] 8.3 Renumber this change's CONFIRM items against develop's 22.2 just before push. Ask before a full `npm run verify` on the shared runner.
