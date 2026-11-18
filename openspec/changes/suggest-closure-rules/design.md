## Context

Three pieces exist, and none makes a standing closure rule.

- **The file reader** (D34, spec 11A.9). The prompt (`api/src/files/extract/reader-prompt.ts:36-69`) asks for kind, summary, facts, dated events and daily totals. Opening hours and closures are listed as facts (`:48-49`), and "a menu, price, hours or staffing change is a fact, not an event" (`:51-52`). The schema is `readerAnswer` (`:72-92`) and the server's check is `readerResult` (`:169-189`). The actions (`api/src/files/ai-actions.ts`) write events as notes with no second press (`:177-218`), plan their ids first so a retry writes once (`newPlan`, `:138-141`), and refuse a closed note over 14 days or past 31 closed days a read (`CLOSED_SPAN_DAYS`, `CLOSED_DAYS_PER_READ`, `:49-50`, guard at `:199`). Undo (`DELETE .../data/:ref/ai`, `api/src/handlers/data.ts:701-757`) removes what carries the file as its source (`:731-744`); `undoable` (`:211-216`) counts notes, an upload and an item only.
- **Business rules** (D31, 6.24, 10.16). A rule has words and an optional schedule (`RuleSchedule`, `api/src/stores/business-rules.ts:22-25`), at most 30 per location (`:13-14`). Any member adds one (`api/src/handlers/rules.ts:179-187`); `addRule` (`:129-163`) takes a planned `id` and is idempotent on it. Schedules use a note's rules (`validDays`, `api/src/handlers/notes.ts:72-85`: start from 2010, end at most 366 days after it or null).
- **The weekday question** (spec 10.12, `tuning-chat.md` section 8). `questionsFor` asks "Closed on Mondays?" when at least 60% of a weekday's counted days have no sales, at least 4 (`api/src/agent/questions.ts:50-52`, loop `:244-257`). Answering `closed` saves a closure note over the question's past days only (`closureNoteOf`, `:190-196`). Nothing closes a future Monday.
- **The suggestion store** from `weekly-forecast-suggestions` is built and on develop: `tw_agent_suggestions` (`api/src/stores/agent-suggestions.ts:94-113`), content a note or a rule schedule (`:27-29`), statuses open, accepted, dismissed, expired. Accept writes through `addNote` or `addRule` with the suggestion's id (`api/src/handlers/weekly-suggestions.ts:211-226`); routes `org.agent.suggestion_accept` and `org.agent.suggestion_dismiss` are `org_admin` (`api/src/access/routes.ts:403-412`). `listOpen` and `isOpen` treat a suggestion as gone once its first date is today or past (`agent-suggestions.ts:327-331`, `weekly-suggestions.ts:202-204`). Its tasks 4.1 to 4.3 (owner sign-off, UI review, review and verify) are still open with session d6.

## Goals / Non-Goals

**Goals:** a stated or evident closed pattern becomes a rule the owner confirms in one press; no forecast change without that press; one ask per pattern; on by default.

**Non-Goals:** inferring closed days from a file's missing rows; yearly recurring schedules (D31 has none); suggesting non-closure rules from a file; letting the chat see pending suggestions; a new env flag.

## Decisions

Each decision says whether it was decided by the owner or the lead's brief ("Decided") or is Claude's call ("Claude's call", each with a `[CONFIRM]`).

### 1. One store, a `source` field (Decided)

Suggested closure rules live in `tw_agent_suggestions` as `type: 'rule'` with a schedule. New optional fields:

- `source`: `weekly` | `file` | `sales`. Absent reads as `weekly`, so every row the weekly pass wrote keeps its meaning.
- `fileId` (file source): the read's file.
- `salesKey` (sales source): `weekday_{d}`, with a partial unique index `{ orgId, locationId, salesKey }` where `salesKey` is a string (the `$type` pattern of `api/src/stores/calibrations.ts:104`).
- `evidence` (sales source): `{ noSalesCount, weekdayCount, from }`, counts and a date only.
- `closureKey`: the dedupe key of decision 3, on file and sales rows.

The `week` field is required today (`agent-suggestions.ts:98`). File and sales rows set it to the town's Monday of the day they were made, so the field stays required.

Alternatives: a second collection (duplicates accept, dismiss, deletion and the panel's plumbing); questions-only state in `tw_agent_answers` (no Edit, no cross-source dedupe, nothing for P29 to list).

### 2. The file source (Decided; two parts Claude's call)

The reader's answer gains `closedPatterns`, at most 5, each `{ weekdays: number[] | null, startDate: date | null, endDate: date | null }`. The prompt adds one bullet: give a pattern only when the file states it. That means a line such as "Closed Mondays", opening hours that cover the whole week (the days not listed are closed), or a dated closed season. Never from days missing in a sales table, and never a one-off date (that stays an event). A date written without a year is its next occurrence, or the current one if it is under way. There is no free-text field, so nothing the file says is kept for a pattern.

`readerResult` checks each entry strictly: weekdays unique 0 to 6, at least one weekday or both dates, start not after end, span at most 366 days, end not before the read's today. Anything else is dropped and counted.

The actions turn each pattern into a schedule `{ kind: 'closure', effect: 'closed', weekdays, startDate, endDate }`. With no dates, `startDate` is the town's today and `endDate` is null (ongoing). They store it as an open suggestion with a planned id (`plan.suggestionIds`, saved with the rest of the plan), so a retry inserts it once (a duplicate key means it is there). They run after the notes and before the days, each checking that the read is still held, as the notes do.

- **Guard-refused closures become suggestions (Claude's call).** An event the guard refuses (`ai-actions.ts:199`: a closed span over 14 days, or past 31 closed days) becomes a suggestion with its dates instead of a skip. A season stated as an event is then not lost, and it still needs a press. [CONFIRM: a closure a file read may not write on its own becomes a suggested rule]
- **Undo (Claude's call).** `undoAiRead` deletes the read's suggestions that are still `open` (by `fileId`). Accepted ones stay: the rule is now the owner's, as a note the owner edited is not. Dismissed ones stay too, so the dismissal is remembered. `undoable` also counts suggestions made, and `file.ai_undone` gains `suggestions`. [CONFIRM: undoing a read removes its open suggested rules and keeps rules already confirmed]

Deleting the file leaves its suggestions (D34 keeps what a read made); the card then says "From a file you deleted" with no link.

### 3. Wording, closure key and dedupe (Decided: Townwise words it; dedupe on the schedule)

Rule text comes from the schedule, never the file or the model: "Closed on Mondays", "Closed on Mondays and Tuesdays", "Closed Jan 4 to Mar 31, 2027", "Closed on Mondays, Jan 4 to Mar 31, 2027". It is the same function on the server (`closureRuleText` in `agent/closure-suggestions.ts`) and the client's card.

`closureKey` is the weekdays, sorted, plus the end and start dates only for a dated range (`closed|w=1|ongoing`, `closed|w=*|2027-01-04..2027-03-31`). A standing weekday rule's key ignores its start, so a file's "Closed Mondays" and the sales history's Monday are one rule.

A suggestion is not made when any of these holds:

- a row with the same key exists in any status but expired;
- a closure rule the location has already covers it, meaning the same weekdays or more, ongoing, for a standing one, or the same key for a range;
- a rule has its words in any case.

### 4. The sales source replaces the weekday question (Decided to offer it; replacing is Claude's call)

Recommendation: **replace** the weekday question with the suggested rule. Do not make `closed` save a rule too.

- One card asks the forward question once. Confirm saves one rule whose `startDate` is the evidence's first day with sales (`from`) and whose end is null. That rule explains the past no-sales days (questions treat a rule closure as explaining days it covers, `questions.ts:24-27`). It closes every future Monday. D31 holds a rule's closure on a past day only where guests are missing, which is exactly the evidence.
- "Closed also saves the rule" mixes up "were you closed on those Mondays" with "will you be closed every Monday from now on". A seasonal Monday closure would silently become a standing rule that changes the forecast, from a question about the past, with no Edit.

How it works:

- **Evidence.** `questions.ts` exports `weekdayEvidence(input)`: the same counted days (weeks with sales on another day, turned-off days left out) and the same thresholds (60%, at least 4, `[CONFIRM]` unchanged), counted on all no-sales days. Closure notes are not subtracted, so an earlier `closed` answer still leads to the standing rule. `questionsFor` stops emitting weekday questions. `closedWeekdays` still keeps those days out of gaps (`:262`).
- **Suppressed** when the weekday's earlier answered weekday question (in `tw_agent_answers`) was `open`, `not_sure` or `other`, or by decision 3.
- **Computed on read, stored on decide.** GET must write nothing (spec 7.3). GET .../agent and GET .../rules list a sales suggestion with the id `sales_weekday_{d}`. Accept and dismiss take that id too. The handler recomputes the evidence (404 when it no longer holds, as an answer to a stale question is). It inserts the row (`source: 'sales'`, `salesKey`, `evidence`, `status: 'open'`; a duplicate key on `salesKey` finds the racing insert) and goes on with the stored id as for any suggestion. Retries and two tabs end with one row and one rule.
- **Deleting sales data** deletes sales-source rows that are not accepted, as it deletes `tw_agent_answers` (`api/src/handlers/sales.ts:309`), so a new history can suggest again.

### 5. Nothing changes until a press; Confirm, Edit, Dismiss (Decided)

A suggestion is a row in `tw_agent_suggestions`, which the forecast read never reads. Only an accepted one has a rule, written through `addRule` (`via: 'townwise_ai'`) with the suggestion's id.

- **Confirm** is the existing accept with an empty body.
- **Edit** opens P29's rule form (text plus Change the forecast, `NoteFields`) prefilled. Saving sends `accept { rule: { text, schedule } }`. That shape is allowed only on file and sales rows, and is checked by `ruleTextOf` and `readRuleSchedule` as P29's add is. The edited rule is written with the suggestion's id and the suggestion is marked accepted. A retry finds the rule by id and keeps whichever version landed first.
- **Dismiss** is the existing dismiss.
- 409 `rule_limit` and `rule_exists` leave the suggestion open, as today.

**Listing and expiry.** The weekly rule (expired once its first date is today) stays for `weekly` rows. A file or sales row is open while its end is null or on or after today. A range whose end has passed expires: lazily in lists and decide (both read-only checks), and in the weekly pass's `expire()`, made source-aware.

### 6. Who confirms (Decided to map it; the mapping is Claude's call)

Townwise has two roles in an organization: org admin and member (spec section 3). Staff open as admin act as org admin. "Owner / manager" maps to both. Recommendation: **any member**, outside view-as, decides a `file` or `sales` suggestion.

- Any member can add the same rule on P29 (`routes.ts:193-209`) and answered the weekday question this replaces.
- The member who asked for a read could already have had its notes written with no press (D34).

The two routes' policy becomes `member`. The handler answers 403 `forbidden` to a member on a `weekly` row, keeping that change's org-admin review. `decides()` (`weekly-suggestions.ts:80-82`) becomes source-aware, so `canDecide` per card replaces the panel-wide `canChange` for these cards. [CONFIRM: any member confirms, edits or dismisses a suggested closure rule; weekly suggestions stay with org admins]

Alternative: org admin only. Rejected because a manager on a member seat could not act on the owner's own request, while being able to type the same rule by hand.

### 7. Where they show (Decided)

- **P29**: a "Suggested by TownwiseAI" group above Add a rule, listing the location's open `file` and `sales` suggestions. GET .../rules adds `suggested: RuleSuggestionView[]`, built by the same function as GET .../agent. Each card shows the rule, what it does ("Changes the forecast: closed on Mondays, from Mar 2, 2026 on"), where it came from ("From {file's title}" linked to P27, or "No sales on 9 of 11 Mondays since Mar 2"), and Confirm, Edit and Dismiss (read-only under view-as, as P29 is).
- **P25**: GET .../agent adds `ruleSuggestions` (the weekly `suggestions` array is unchanged). The panel shows a "Suggested rules" section before Questions for you, using the same card. Edit there links to `/locations/{id}/rules?suggestion={id}`, which opens that card's edit on P29 (no new route path, so `isAllowed` is unchanged).
- **Home** (P11) counts questions, weekly suggestions and rule suggestions.
- **P27**: the read's outcome says "Suggested {n} rules on Business rules".
- Web and native share the components.

### 8. Caps (Claude's call)

- At most 5 suggested rules a file read: the schema's cap, guard-refused events included. Overflow is counted `rulesSkipped.cap`.
- At most 10 open `file` suggestions per location. A read past it skips and counts.
- `sales` makes at most one per weekday (7), uncapped beyond that.
- Pending suggestions do not count toward the 30 rules. Confirm at 30 answers 409 `rule_limit` and the card says the limit line.

[CONFIRM: 5 suggested rules a file read, 10 open per location from files, one per weekday from sales history] [CONFIRM: suggested rules don't count toward a location's 30 until confirmed]

### 9. Composing with `weekly-forecast-suggestions`

This change builds on that change's store, routes and panel. It changes their behavior only for rows whose `source` is not `weekly`, plus these shared points:

- The routes' policy moves to `member`, with the `weekly` check in the handler.
- The accept body allows `rule` on file and sales rows.
- `listOpen` and `expire` become source-aware.
- `keptSuggestions` (`api/src/lab/suggestions.ts:240-269`) also drops a weekly rule whose `closureKey` matches a file or sales row, since `sameDays` (`:189-193`) compares start dates and would miss a standing Monday rule.

Its spec delta (`weekly-suggestions`, unarchived) says accept and dismiss are org admin. This change's delta states the source split as ADDED. Whichever archives second reconciles that sentence: if weekly archives first, this delta gains a MODIFIED of its "Suggestions are checked and never applied on their own" requirement.

**Files both changes touch** (sequence this change after d6 closes weekly 4.2 and 4.3, rebased on develop):

- `api/src/stores/agent-suggestions.ts`
- `api/src/handlers/weekly-suggestions.ts`
- `api/src/handlers/agent.ts`
- `api/src/access/routes.ts`
- `api/src/lab/suggestions.ts`
- `api/src/stores/audit-events.ts`
- `api/src/audit.ts`
- `client/src/chat/api.ts`
- `client/src/chat/useAgentPanel.ts`
- `client/src/chat/ui/AgentSidePanel.tsx`
- `client/src/chat/ui/SuggestionCard.tsx`
- `client/src/portal/home/Home.tsx`
- `client/src/portal/console/words.ts`
- `client/app/(marketing)/privacy.tsx`
- `docs/portal/spec.md` (6.27, 9.2, 10.12, P11, P25)
- `docs/portal/tuning-chat.md` (sections 8 and 9)
- `docs/portal/estimates.md` (section 5)
- `api/README.md`
- `api/test/weekly-suggestions.int.test.ts`
- `api/test/routes.test.ts`
- `client/test/chat/suggestions.test.web.tsx`
- `client/test/chat/suggestions.test.native.tsx`
- the shared panel fixtures `api/test/fixtures/agent-panel.json` and `client/test/chat/agent-panel.json`, and `client/test/chat/agent-panel.test.ts`
- `client/test/portal/home/home.test.web.tsx` (the Home count test)

Weekly 4.2's UI review covers `SuggestionCard.tsx`; this change adds its own card and does not restyle that one.

### 10. Audit, logs and privacy (Decided: ids and counts only)

- **Suggested:** `file.ai_read` gains `rulesSuggested` (a count), and `townwise.ai_read` gains `rulesSuggested` and `rulesSkipped` (counts). A sales suggestion is computed on read and records nothing until decided.
- **Confirmed, edited:** `agent.suggestion_accepted` gains `source` and `edited` (boolean).
- **Dismissed:** `agent.suggestion_dismissed` gains `source`.
- **The rule:** `rule.created` as today (`via: 'townwise_ai'`).
- **Logs:** `townwise.agent_suggestion` gains `source` and `edited`.

No rule text, schedule, file name or evidence date goes in a log or event.

**Privacy.** Nothing new is sent to Anthropic. The file source asks one more question of a file already sent whole, and its answer is checked like the rest. The sales source calls no model. The privacy page's "Files you let TownwiseAI read" paragraph must still say what the read now does. Owner action, the exact edit in `client/app/(marketing)/privacy.tsx` and `docs/portal/estimates.md` section 5: after "dated events as notes," insert "regular closed days or a closed season it states as suggested business rules that change nothing until someone on your team confirms them,". No other sentence changes.

### 11. On by default; prompt and cache (Decided)

There is no new env var. The file source runs wherever the reader runs (`ANTHROPIC_API_KEY`, a files budget above 0), and the sales source always runs. To ship dark, revert the change.

The reader's system prompt and schema change. The reader sets no `cache_control` (only `api/src/chat/turn.ts:127` does), so no prompt-cache entry resets. The output grows by at most 5 short entries, within `READER_MAX_TOKENS` and the read's cost ceiling. No chat tool description changes, so the chat's cached prefix is untouched. The chat reads rules once confirmed, as it reads any rule (`tuning-chat.md` section 3), and never sees pending suggestions.

## Risks / Trade-offs

- [The model reads "Closed Mondays" into a file that does not say it] → It is a suggestion, it changes nothing until confirmed, and the card links the file.
- [Removing the weekday question loses the past-only answer] → Edit sets an end date ("closed on Mondays until June"), and Dismiss leaves the days out of gaps as today.
- [A seasonal closure every year is suggested once] → D31 has no yearly schedule; next year's file read or the owner adds it again. Listed in Open Questions.
- [Member policy on shared routes] → The handler check is pinned by a test, so a member cannot accept a weekly row.

## Migration Plan

None. The fields are optional (absent `source` is `weekly`) and the partial index builds at boot. Weekday questions already answered keep their notes. Rollback is a revert plus one cleanup. An older build's `listOpen` could show an open `file` row whose start is still ahead (a closed season) as a weekly suggestion, so a rollback first deletes them (`deleteMany({ source: { $in: ['file', 'sales'] }, status: 'open' })`). That runbook line goes in `infra/README.md` (task 4.6).

## Open Questions

- Should weekly rule suggestions also show in P29's group? They are left in the panel only, for now.
- Yearly recurring closures (D31 has no such schedule).
