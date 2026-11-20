## Why

Halloween weekend 2025 at the partner restaurant (Fri Oct 31, Sat Nov 1) shows net sales at 1.57x and 1.17x a normal day, but guests at only 0.96x and 0.78x. Spend per guest was about $40 against about $25 on a normal night. The door most likely did not count guests on those nights. Townwise trusts every stored guest count, so the lab learned that Halloween brings no extra guests. The same counts also lower the weekday's typical guests (D32), the "usually" effects on forecast reasons (14.4), live accuracy (14.4), "Your history by term state" (13.2) and the orders baseline.

Today a person can say a day was closed, had a private event, or had more or fewer guests, but cannot say "the guests we recorded are wrong, the sales are right". Every existing note either changes the forecast or is listed and ignored; none takes a day's count out of training and comparisons. The owner chose on 2026-11-19 to "build the mechanism now": an org admin or member marks a past day's guest count as wrong, so no forecast or statistic trains on or compares against that day's guests, and the sales stay as they are. The owner then adds such notes for Oct 31 and Nov 1, 2025.

## What Changes

- **A new note effect, `wrong_guest_count`.** A note of kind `other` may take it. Every date it covers is before the town's today, it has no expected guests and no hours, and it needs no title or detail (the effect says what it is). A member or org admin adds, edits and deletes it as any note. Business rules (D31) never take it. TownwiseAI never proposes or saves it (chat, Read with TownwiseAI, weekly suggestions, the D59 agent); it reads it and explains it.
- **One shared reading of a marked day.** `api/src/closed-days.ts` gains `isWrongGuestCount` beside `isClosure` and `trustedGuestDays(days, notes)`, which returns the stored days with `guests: null` on every date a wrong-guest-count note covers and sales untouched. A marked day then reads everywhere Townwise analyzes, trains or compares exactly as a day whose upload had sales and no guest count reads today.
- **Every guest consumer reads trusted days.** The lab input (so the day leaves all lab training and backtests with no Python change and no model version bump), the forecast reader's actuals, live accuracy and week actuals, the reason effects, typical guests and the likely-closed test (server and client mirror, pinned by the shared day-classes fixture), "Your history by term state", TownwiseAI's "Questions for you", the weekly pass's holiday counts and effects, the orders baseline, and the chat's per-day tools.
- **Record views keep the stored count.** Your data, the sales page and monthly totals show what was uploaded. The note is the record that the count was wrong.
- **Words.** The note form's Effect for an Other note gains "The guest count was wrong (sales were right)". A forecast day's reason reads "Your note: guest count marked wrong", and the calendar chip "Guest count marked wrong". The chat's `get_sales_days` and `get_day` send the day's guests as null with `guestCountMarkedWrong: true`. All marked [CONFIRM].
- **Refits follow.** The note touches days on or before the last stored day, so D59's `wantRefitFor` marks the location and the lab input's fingerprint changes. The next worker pass refits.

## Capabilities

### New Capabilities
- `wrong-guest-count-notes`: the note effect, who may write it, its validation, its words on the form, calendar and forecast, its precedence with D31 rules, D53 links and D59 agent notes, and what TownwiseAI may do with it.
- `trusted-guest-counts`: how a marked day's guests leave training, typical guests, likely-closed tests, reason effects, live accuracy, history means, questions, orders and chat reads, while its sales and record views stay.

### Modified Capabilities
None in `openspec/specs/` (it holds only `order-setup-read` and `top-bar-groups`). Notes, the lab input and the forecast read are specified in `docs/portal/spec.md` (12, 14.5, D32) and in unarchived changes. Requirements here are written as new ones so they validate on their own.

## Impact

- Spec decision **D67** (reserved for this change). CONFIRM index items from 220 (219 is D68's on another branch); recheck both against develop before push.
- API: `stores/notes.ts` (type and mongoose enum), `handlers/notes.ts` (note-only effect enum; `readNoteContent` takes the town's today and refuses the effect without it, so the chat's proposals and the D53 follow-up refuse it; past-only, kind other, no guests, no hours; `fromEvent` dropped), `closed-days.ts` (predicate and `trustedGuestDays`), `lab/input.ts`, `forecasts/reader.ts`, `forecasts/reasons.ts`, `people-in-town/history.ts` callers, `agent/questions.ts`, `lab/suggestions.ts` (holiday counts and effects; its zod enum unchanged), `orders/live.ts`, `calendar/follow-up.ts` (skip), `chat/tools/sales-days.ts`, `day.ts`, `visual.ts`, `propose-note.ts` (refuse the effect).
- Client: `portal/locations/api.ts` (`NOTE_EFFECTS`), `noteRules.ts`, `NoteFields.tsx`, `chat/format.ts` (`EFFECT_LABEL`), `chat/api.ts` (proposal enum stays without the effect), `portal/analytics/days.ts` (the mirror), `portal/calendar/entries.ts` (chip), and the shared `day-classes.json` fixture.
- Lab: no code change. `modeling/lab/tests/golden/api-input.json` unchanged.
- Docs: `docs/portal/spec.md` (D67 row, F12, 6.7, 10.5, 12, 13.2, 14.4, 14.5, D32's text, 22.2, 23), `api/README.md`, `docs/portal/tuning-chat.md` (two tool descriptions, a frozen-prefix change: one cache miss per conversation).
- No new collection, route, env var, audit action or log field. `note.created`, `note.updated` and `note.deleted` keep their details (location id, kind and dates; `noteDetails` sends no effect).
- Old clients: the web export and the API ship together. A native build from before this release fails to parse a location's notes once one carries the new effect (zod enum); there is no store build (no `client/eas.json`), so only a developer's local build is affected until rebuilt.
