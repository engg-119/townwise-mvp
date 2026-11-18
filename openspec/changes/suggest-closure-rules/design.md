## Context

Four pieces exist, and none makes a standing closure rule.

- **The file reader** (D34, spec 11A.9). The prompt (`api/src/files/extract/reader-prompt.ts:36-69`) asks for kind, summary, facts, dated events and daily totals. Opening hours and closures are listed as facts (`:48-49`), and "a menu, price, hours or staffing change is a fact, not an event" (`:51-52`). The schema is `readerAnswer` (`:72-92`) and the server's check is `readerResult(raw)` (`:169-189`), which has no today.

  The actions (`api/src/files/ai-actions.ts`) write events as notes with no second press (`:177-218`). They check a planned id before anything else (`:192-196`) and plan their ids first so a retry writes once (`newPlan`, `:138-141`; an earlier attempt's plan is kept, `:357`). They refuse a closed note over 14 days or past 31 closed days a read (`:49-50`, guard at `:191` and `:199`).

  The read's log line and audit event are written in `api/src/files/ai-reader.ts` (`:145`, `:272-280`). A retry acts on the saved answer with no new call (`:255-258`). One organization has at most one read under a live lease (`:2-4`).

  Undo (`api/src/handlers/data.ts:701-757`) removes what carries the file as its source (`:731-744`). `undoable` (`:211-216`) counts notes, an upload and an item only.
- **Business rules** (D31, 6.24, 10.16). A rule has words and an optional schedule (`RuleSchedule`, `api/src/stores/business-rules.ts:22-36`), at most 30 per location (`:13-14`). Any member adds one (`api/src/handlers/rules.ts:179-187`). `addRule` (`:129-163`) takes a planned `id` and returns the existing rule when the id is there (`:137-138`).

  Schedules use a note's rules (`validDays`, `api/src/handlers/notes.ts:72-85`: start from 2010 to today plus 2 years, end at most 366 days after it or null). There is no yearly repeat.

  Every place that asks "does this schedule cover this day" calls one function, `noteCovers` (`api/src/agent/questions.ts:181-184`):

  - the forecast read (`api/src/forecasts/reader.ts:259-260`, then `forecasts/adjust.ts` and `forecasts/effects.ts` through `covering`);
  - the lab input (`api/src/lab/input.ts:281-282`);
  - the questions;
  - the chat's day tools (through `closed-days.ts`);
  - the weekly pass (`api/src/lab/suggestions.ts:33`).

  The client keeps a mirror (`client/src/portal/analytics/days.ts:62-65`), used by the calendar model (`client/src/portal/calendar/model.ts:100`).
- **The weekday question** (spec 10.12, `tuning-chat.md` section 8). `questionsFor` asks "Closed on Mondays?" when at least 60% of a weekday's counted days have no sales, at least 4 (`questions.ts:50-52`, loop `:244-257`). A day "has sales" when it has guests or net sales (`:222-224`). Answering `closed` saves a closure note over the question's past days only (`closureNoteOf`, `:190-196`).
- **The suggestion store** from `weekly-forecast-suggestions` is on develop:
  - `tw_agent_suggestions` (`api/src/stores/agent-suggestions.ts:94-113`; `why` required, `:102`; batch `insert`, `:319-326`; `listOpen` and `expire` by first date, `:327-331`, `:354-360`);
  - accept and dismiss (`api/src/handlers/weekly-suggestions.ts:211-256`; dismiss can finish an accept, `:241`);
  - the routes `org.agent.suggestion_accept` and `org.agent.suggestion_dismiss`, `org_admin`, 1 KB (`api/src/access/routes.ts:403-412`).

  The weekly pass sends earlier suggestions of every status overlapping its 91 days to Anthropic (`alreadySuggested`, `lab/suggestions.ts:169-171`). Its tasks 4.1 to 4.3 are still open with session d6.

## Goals / Non-Goals

**Goals:** a stated or evident closed pattern becomes a rule the owner confirms in one press; seasons that recur each year can be rules; no forecast change without that press; one ask per pattern; on by default.

**Non-Goals:** inferring closed days from a file's missing rows; suggesting a one-off date as a rule; suggesting non-closure rules from a file; letting the chat see pending suggestions; a new env flag; yearly notes (seasons are for rules only).

## Decisions

Each decision says whether the owner or the lead's brief decided it ("Decided") or it is Claude's call ("Claude's call", each with a `[CONFIRM]`). "Audit" names the finding of the independent audit (2026-11-17) that shaped it.

### 1. One store, a `source` field (Decided)

Suggested closure rules live in `tw_agent_suggestions` as `type: 'rule'` with a schedule. New optional fields:

- `source`: `weekly` | `file` | `sales`. Absent reads as `weekly`, so every row the weekly pass wrote keeps its meaning.
- `fileId` (file source).
- `evidence` (sales source): `{ noSalesCount, weekdayCount, lastSalesDate }`, counts and one date.
- `closureKey` (file and sales rows only), with a partial unique index `{ orgId, locationId, closureKey }` where `closureKey` is a string (the `$type` pattern of `api/src/stores/calibrations.ts:104`). Audit S2: this one index enforces the dedupe of decision 3 in every status, and replaces the `salesKey` of the first draft.

`why` stays required for `weekly` rows only (a required function on `source`) and is null on file and sales rows, whose origin the view words from `source`, `fileId` and `evidence` (audit S5). Nothing from the file is ever stored as words. `week` stays required: file and sales rows set it to the town's Monday of the day they were made.

New rows are written one at a time with `insertOne` and a given id. The weekly pass's batch `insert` is unchanged (audit N6).

Alternatives: a second collection (duplicates decide, deletion and the panel's plumbing); state only in `tw_agent_answers` (no Edit, no cross-source dedupe, nothing for P29 to list).

### 2. The file source (Decided; the guard conversion and undo are Claude's calls)

**The answer.** The reader's answer gains `closedPatterns`, at most 5, each `{ weekdays: number[] | null, startDate: date | null, endDate: date | null, yearly: boolean }`. The prompt adds one bullet (audit S7):

> closedPatterns: the days the restaurant is regularly closed, only when the file states them. Give one when the file says the restaurant is closed on a weekday ("Closed Mondays"), when it lists the restaurant's own opening hours for every day of the week (the days with no hours are closed), or when it states a closed season. Never from a meal, kitchen, bar, brunch, happy hour or menu section's hours, never from days missing in a sales table, and never a one-off date (that is an event). weekdays are numbers from 0 (Sunday) to 6 (Saturday), so Monday is 1, or null for every day. A season has startDate and endDate, the next time it happens or the current one if it is under way; yearly is true only when the file says it happens every year ("closed every winter, January to March"), else false. A weekly closure with no season has null dates.

There is no free-text field, so nothing the file says is kept for a pattern.

**The check.** `readerResult(raw, today)` takes the read's today (the caller has it, `ai-reader.ts:178`, `:217`; audit N2). It drops an entry when:

- its weekdays are not unique values 0 to 6;
- all 7 weekdays are set with no dates (that is not a pattern; audit S7);
- it has neither a weekday nor both dates;
- its start is after its end, or it spans more than 366 days;
- its end is before today;
- it is `yearly` with a start or end on Feb 29, or a season of 365 days or more.

Each kept entry is then built into a full schedule and run through `readRuleSchedule`: `kind: 'closure'`, `effect: 'closed'`, `expectedGuests`, `startTime` and `endTime` null.

- A weekly pattern with no dates gets `startDate` today and `endDate` null.
- A dated season keeps its dates.
- A yearly season gets `startDate` today, `endDate` null and `season` from its dates' months and days (decision 12).

An answer saved by the old build has no `closedPatterns`, which reads as empty (audit S10).

**The actions.** After the notes, each kept pattern becomes an open suggestion (`source: 'file'`, `fileId`, `closureKey`, Townwise's words) under a planned id (`plan.suggestionIds`, 5 ids saved with the rest of the plan; absent on a plan from the old build, which then makes none).

- **Retries.** As for notes, the planned id is looked up first, and the caps are checked only for an id not yet written (audit S11).
- **Duplicates.** A duplicate key on the id means a retry wrote it; a duplicate key on `closureKey` counts `duplicate`.
- **Caps are exact.** The reader never holds two reads of one organization at once (`ai-reader.ts:2-4`), so two file reads cannot race past the cap. The only race left is a file read against a sales decide, and the unique key resolves that.

**Guard-refused closures (Claude's call, narrowed by audit S8).** Only an event of `kind: 'closure'` that the guard refuses for its span (over 14 days) and that ends on or after today becomes a suggestion with its dates. It reuses that event's planned, unused `noteIds[index]`. It is counted in `rulesSuggested`, not `notesSkipped.guard`.

These stay skipped as `guard`:

- events refused by the 31-closed-days total (one-day holidays would become rules);
- buyouts (they would lose their guest count);
- past spans.

[CONFIRM: a closure over 14 days that a file read may not write as a note becomes a suggested rule]

**Undo (Claude's call).** `undoAiRead` treats the read's open suggestions one at a time:

- one whose rule already exists under its id (an accept is in flight, audit S4) is finished as accepted, as dismiss does at `weekly-suggestions.ts:241`;
- every other open one is deleted;
- accepted and dismissed ones stay, so a confirmed rule stays the owner's and a dismissal is remembered.

`undoable` also counts suggestions, and `file.ai_undone` gains `suggestions`. [CONFIRM: undoing a read removes its suggested rules still waiting and keeps rules already confirmed]

Deleting the file leaves its suggestions (D34 keeps what a read made). The card then says "From a file you deleted".

### 3. Wording, closure key and dedupe (Decided: Townwise words it; dedupe on the schedule)

**Words.** Rule text comes from the schedule, never the file or the model (`closureRuleText` in `api/src/agent/closure-suggestions.ts`; the client shows the view's `text`, no second copy, audit N5). Examples:

- "Closed on Mondays"
- "Closed on Mondays and Tuesdays"
- "Closed Jan 4 to Mar 31, 2027"
- "Closed on Mondays, Jan 4 to Mar 31, 2027"
- "Closed Jan 1 to Mar 31 every year"
- "Closed on Mondays, Jan 1 to Mar 31 every year"

**Key.** `closureKey` is built from:

- the weekdays, sorted, or `*`;
- for a dated range, its start and end;
- for a season, `yearly=` its from and to;
- for a standing weekly rule, `ongoing`.

Examples: `closed|w=1|ongoing`, `closed|w=*|2027-01-04..2027-03-31`, `closed|w=*|yearly=01-01..03-31`. A standing or yearly rule's key ignores its start, so a file's "Closed Mondays" and the sales history's Monday are one rule.

**Dedupe.** A suggestion is not made when any of these holds:

- a row with the same key exists in any status (the unique index);
- a closure rule of the location already covers it (for a standing one, an ongoing closure rule on the same weekdays or more; otherwise the same key);
- a rule **with a schedule** has its words in any case.

A rule with the same words and no schedule (a pre-D31 "Closed on Mondays") does not block the suggestion, since it closes nothing (audit N3). Confirming it then answers 409 `rule_exists`, and the card says "A rule with these words is already saved. Edit that rule, or change these words with Edit." (UI review S3: the earlier wording was false when the saved rule already had a schedule).

**The weekly pass.** It drops a rule suggestion whose key matches a file or sales row, and no longer sends file or sales rows in `alreadySuggested` (decision 10).

### 4. The sales source (Decided to keep it, as its own task group, after the owner said "dive in"; its shape is Claude's call)

The owner's request named "the data extraction agent". The sales history is a second source the owner agreed to keep in scope ("dive in", 2026-11-17). It is task group 2, buildable after the file source, and its own sign-off. [CONFIRM: the sales history suggests standing closed weekdays] If the owner defers it, the weekday question stays as it is, and group 2 is dropped.

**It replaces the weekday question.** Answering `closed` will not also save a rule.

- One card asks the forward question once, and Confirm saves a standing rule.
- "Closed also saves the rule" mixes up "were you closed on those Mondays" with "will you be closed every Monday from now on". It would turn a seasonal or past pattern into a standing rule that changes the forecast, with no Edit.

**Evidence (audit B1).** `questions.ts` exports `weekdayEvidence(input)`. It uses the same counted days (weeks with sales on another day, turned-off days left out) and the same threshold (60% of counted days with no sales, at least 4). It adds one recency bar: the weekday's last 4 counted days all have no sales. That keeps a past or seasonal pattern from becoming a standing rule. [CONFIRM: 60% of at least 4 days, and the last 4 counted days without sales]

The evidence also gives `lastSalesDate`, the last counted day of that weekday with sales (guests or net sales), or null.

**The rule's start (audit B1).** The rule starts the day after `lastSalesDate`, or at `from` when the weekday never had sales in the window. It therefore never covers a past day with recorded sales, whether guests or net sales. The first draft started it at `from` and claimed the past hold matched the evidence. That was wrong: D31 and D32 hold a past rule closure where **guests** are missing (`closed-days.ts:95-113`), while the evidence counts a day as open on net sales alone. A net-sales-only Monday would have been closed in the lab's input and in Analytics. The card says "No sales on any Monday since Sep 7" (`lastSalesDate`), then "{n} of {m} Mondays".

**Suppression.** Nothing is suggested when the weekday's earlier weekday question (in `tw_agent_answers`) was answered `open`, `not_sure` or `other`, or when decision 3 blocks it. An earlier `closed` answer does not suppress: the owner already said they close that day.

`questionsFor` stops emitting weekday questions. `closedWeekdays` still keeps those days out of gaps (`questions.ts:262`).

**Computed on read, stored on decide.** GET must write nothing (spec 7.3).

- GET .../agent and GET .../rules list a weekday's suggestion as `sales_weekday_{d}` while no row has its key. Once a row exists, it is listed under its stored id if open, and hidden otherwise (audit N4).
- Deciding `sales_weekday_{d}` recomputes the evidence (404 when it no longer holds, as a stale question is), then inserts the row (`source: 'sales'`, `closureKey`, `evidence`, `open`). A duplicate key finds the row by its key.
- It then goes on with the stored id. Two tabs end with one row and one rule.

**Deleting sales data** deletes sales rows that are not accepted (`api/src/handlers/sales.ts:309` deletes answers there), so a new history can suggest again.

### 5. Nothing changes until a press; Confirm, Edit, Dismiss (Decided)

A suggestion is a row in `tw_agent_suggestions`, which the forecast read never reads: it reads `businessRules.scheduled()` only (`forecasts/reader.ts:256`). Only an accepted suggestion has a rule, written through `addRule` (`via: 'townwise_ai'`) with the suggestion's id.

- **Confirm** sends an empty body.
- **Edit** opens P29's rule form, prefilled (text, Change the forecast and its Every year box, decision 12). Saving sends `{ rule: { text, schedule } }`, checked by `ruleTextOf` and `readRuleSchedule` as P29's add is.
- **Dismiss** marks it dismissed by compare-and-set.

**Races (audit S3).** Confirm and Edit both write the rule with the suggestion's id. When `addRule` finds a rule already there under that id whose words or schedule differ from what this request would write, the request answers 409 `already_decided` with the stored rule. The card then shows "Already confirmed as: {text}". `edited` on the audit event is worked out from the stored rule (its words or schedule differ from the suggestion's), not from the request. 409 `rule_limit` and `rule_exists` leave the suggestion open.

**Listing and expiry.**

- A `weekly` row keeps its rule: expired once its first date is today or past.
- A `file` or `sales` row is open while its end is null or on or after today. A dated range whose end has passed is hidden in lists and refused on decide (both read-only), and is expired by the weekly pass's `expire()`, which becomes source-aware.
- `listOpen` stays weekly only. A new `listOpenRules` lists file and sales rows.

Audit S13 asks for tests pinning both: the weekly `expire()` must not expire an ongoing file row that starts today, and `listOpen` must not return file or sales rows.

### 6. Who confirms, and the routes (mapping is Claude's call; routes changed by audit S1)

Townwise has two roles in an organization, org admin and member (spec section 3), and staff open as admin act as org admin. "Owner / manager" maps to both. Recommendation: **any member**, outside view-as, decides a file or sales suggestion.

- Any member can add the same rule on P29 (`routes.ts:193-209`).
- Any member answered the weekday question this replaces.
- The member who asked for a read could already have had its notes written with no press (D34).

[CONFIRM: any member confirms, edits or dismisses a suggested closure rule; weekly suggestions stay with org admins]

**Routes.** The first draft moved the weekly routes to `member` with a handler check. Audit S1 showed that a member's dismiss would run the finish-accept write (`weekly-suggestions.ts:241`) before such a check, and that policy belongs in the route table. So the weekly routes stay as they are, and two new routes take these rows:

- `org.agent.rule_suggestion_accept`: `POST /org/locations/:locationId/agent/rule-suggestions/:suggestionId/accept`.
- `org.agent.rule_suggestion_dismiss`: the same path ending `/dismiss`.

Both are `member`, `openAsAdmin: true`, and 2 KB (audit S6: 200 code points of four bytes plus a schedule pass 1 KB; P29's create is 2 KB, `routes.ts:199`). `:suggestionId` is an ObjectId or `sales_weekday_[0-6]`. The new handlers (`api/src/handlers/rule-suggestions.ts`) answer 404 for a `weekly` row before any write. The weekly handlers answer 404 for a `file` or `sales` row, a one-line change in their `suggestionOf`. The weekly change's spec delta needs no reconciling. `routes.test.ts` pins all four.

**Alternative:** org admin only. Rejected: a manager on a member seat could not act on the owner's own request, yet can type the same rule by hand.

### 7. Where they show (Decided)

- **P29.** A "Suggested by TownwiseAI" group above Add a rule lists the location's open file and sales suggestions. GET .../rules adds `suggested: RuleSuggestionView[]`, built by the same function as GET .../agent. Each card shows:
  - the rule;
  - what it does ("Changes the forecast: {scheduleSummary}");
  - where it came from ("From {file's title}" linked to P27, "From a file you deleted", or the day counts);
  - Confirm, Edit and Dismiss, read-only under view-as.
- **P25.** GET .../agent adds `ruleSuggestions`; the weekly `suggestions` array is unchanged. The panel shows a "Suggested rules" section before Questions for you, with the same card. Edit there links to `/locations/{id}/rules?suggestion={id}`, which opens that card's edit on P29. `isAllowed` is unchanged, since only a query string is added.
- **Home (P11)** counts questions, weekly suggestions and rule suggestions.
- **P27.** The read's outcome says "Suggested {n} rules on Business rules". The guard line counts only what was still left out, and the undo dialog names "the {n} suggested rules still waiting".
- Web and native share the components.

### 8. Caps (Claude's call)

- At most 5 suggested rules a file read from `closedPatterns`, plus the guard-converted closures, which are already bounded by the 50 events. Overflow counts `rulesSkipped.cap`.
- At most 10 open file suggestions per location; a read past it skips and counts.
- The sales source makes at most one per weekday (7).
- Pending suggestions do not count toward the 30 rules. Confirm at 30 answers 409 `rule_limit`.

[CONFIRM: 5 suggested rules a file read, 10 open per location from files, one per weekday from sales history] [CONFIRM: suggested rules don't count toward a location's 30 until confirmed]

### 9. Composing with `weekly-forecast-suggestions`

This change uses that change's store and panel. It changes weekly behavior only in these points:

- `listOpen` and `expire` become source-aware;
- the weekly handlers 404 non-weekly rows;
- `keptSuggestions` (`lab/suggestions.ts:240-269`) also drops a weekly rule whose `closureKey` matches a file or sales row, since `sameDays` (`:189-193`) compares start dates and would miss a standing rule;
- `alreadySuggested` leaves file and sales rows out;
- the weekly prompt gains one sentence on the yearly `season` (decision 12);
- `sameDays` compares `season`.

**Files both changes touch** (sequence this change after d6 closes weekly 4.2 and 4.3, rebased on develop):

- API: `stores/agent-suggestions.ts`, `handlers/weekly-suggestions.ts`, `handlers/agent.ts`, `access/routes.ts`, `lab/suggestions.ts`, `stores/audit-events.ts`, `audit.ts`.
- Client: `client/src/chat/api.ts`, `client/src/chat/useAgentPanel.ts`, `client/src/chat/ui/AgentSidePanel.tsx`, `client/src/portal/home/Home.tsx`, `client/src/portal/console/words.ts`, `client/app/(marketing)/privacy.tsx`.
- Docs: `docs/portal/spec.md` (6.27, 9.2, 10.12, P11, P25), `docs/portal/tuning-chat.md` (sections 8 and 9), `docs/portal/estimates.md` (section 5), `api/README.md`.
- Tests: `api/test/weekly-suggestions.int.test.ts`, `api/test/weekly-suggestions.test.ts`, `api/test/routes.test.ts`, `api/test/indexes.test.ts`, the panel fixtures `api/test/fixtures/agent-panel.json` and `client/test/chat/agent-panel.json`, `client/test/chat/agent-panel.test.ts`, `client/test/portal/home/home.test.web.tsx` and `.test.native.tsx`, `client/test/marketing/pages.test.web.tsx`.

`client/src/chat/ui/SuggestionCard.tsx` is not touched. This change adds its own card, so weekly 4.2's UI review is not disturbed.

A sales decide or a file read can insert a row after a location delete's sweep (`api/src/handlers/locations.ts:283`). That is the same window notes and rules have, and D44's late-write sweep picks rows up the same way (audit N8).

### 10. Audit, logs and privacy (Decided: ids and counts only; the owner approved the privacy update on 2026-11-17)

**Audit and logs.**

- `file.ai_read` (written in `ai-reader.ts:145`, audit N1) gains `rulesSuggested`.
- `townwise.ai_read` (`ai-reader.ts:272-280`) gains `rulesSuggested` and `rulesSkipped`.
- `file.ai_undone` gains `suggestions`.
- `agent.suggestion_accepted` gains `source` and `edited`; `agent.suggestion_dismissed` gains `source`. The new routes record these same two actions.
- `townwise.agent_suggestion` gains `source` and `edited`.
- `rule.created` keeps `via: 'townwise_ai'`. Spec 9.2's "`townwise_ai` is reserved, and nothing writes it yet" (spec line 885) is already untrue since the weekly change and is corrected here (audit N7).

No rule text, schedule, file name or evidence date goes in a log or event.

**What reaches Anthropic.**

- The file source asks one more question of a file already sent whole.
- The sales source calls no model.
- The weekly pass would otherwise begin sending file and sales rows in `alreadySuggested` (audit S9). It leaves them out instead: the closure-key drop already handles that dedupe.

So nothing new is sent to Anthropic.

**Copy that changes.** In each, only the quoted sentence changes, as written here. The owner approved updating them; the owner sees the final wording before push.

1. `client/app/(marketing)/privacy.tsx`, "Files you let TownwiseAI read", and `docs/portal/estimates.md` section 5 where it quotes it.
   - Replace "Everything it adds can be undone from the file’s page; a forecast update it started keeps running, and goes live if it passes Townwise’s accuracy checks and your forecasts are on." with "When the file states the days you’re regularly closed, or a closed season, TownwiseAI suggests them as business rules, which change nothing until someone on your team confirms them. Everything it adds can be undone from the file’s page, except a suggested rule someone has confirmed, which stays as your rule until you delete it. A forecast update it started keeps running, and goes live if it passes Townwise’s accuracy checks and your forecasts are on."
   - At the paragraph's end, add: "Suggested rules wait on Business rules until someone confirms, edits or dismisses them; undoing the read removes the ones still waiting, and we keep whether each was confirmed or dismissed, so it isn’t suggested again, until the location is deleted."
2. The P27 opt-in (`client/src/portal/data/aiCopy.ts:14`, `explain`). Replace "When an org admin asks, it may also start updating the forecast. Everything it adds can be undone." with "When the file states the days you’re regularly closed, it suggests them as business rules for your team to confirm. When an org admin asks, it may also start updating the forecast. Everything it adds can be undone, except a suggested rule someone has confirmed." Spec P27's quote (spec line 2442) changes to match.
3. `optInHelp` (`aiCopy.ts:41`) stays true as written.
4. The marketing FAQ (`client/src/marketing/Home.web.tsx:180-200`) says nothing about reading files, so no FAQ sentence becomes untrue. It is checked again in task 5.3.
5. The sales source sends nothing anywhere and the privacy page does not describe TownwiseAI's questions, so nothing is added for it.

### 11. On by default; prompts and cache (Decided)

There is no new env var. The file source runs wherever the reader runs (`ANTHROPIC_API_KEY`, a files budget above 0), and the sales source always runs. To ship dark, revert the change.

The reader's system prompt and schema change, and the weekly prompt gains one sentence. Neither sets `cache_control` (only `api/src/chat/turn.ts:127` does), so no prompt-cache entry resets. The reader's output grows by at most 5 short entries, within `READER_MAX_TOKENS` and the read's cost ceiling. No chat tool description and no chat system prompt changes, so the chat's cached prefix is untouched. The chat reads a rule once confirmed, as it reads any rule, and never sees pending suggestions.

### 12. Yearly seasons in D31 rule schedules (Decided by the owner on 2026-11-17: "sure add seasons"; defaults are Claude's calls)

**Shape.** `RuleSchedule` gains `season: { repeat: 'yearly'; from: 'MM-DD'; to: 'MM-DD' } | null`, absent or null on every existing rule.

- A yearly schedule covers a day when the day is on or after `startDate`, its weekday is allowed, and its month and day are in the season.
- When `to` is before `from` the season crosses the new year (`12-20` to `01-05`).
- With a season, `endDate` must be null: a yearly rule runs until deleted.
- Notes never have a season.

**Checks** (`validDays` and `readRuleSchedule`, `notes.ts:72-121`):

- `from` and `to` are real month-days, neither `02-29`; a season that spans Feb 29 includes it in leap years;
- the season is shorter than a year (at most 364 days counted in a non-leap year);
- `endDate` is null;
- the start date keeps its rule (2010 to today plus 2 years);
- hours, weekdays, kinds, effects and guest counts keep a schedule's other rules, so a yearly buyout or private event is allowed as any schedule is.

[CONFIRM: a yearly rule runs every year from its start until it is deleted; Feb 29 can't start or end a season; a season is shorter than a year]

**Coverage, in one place.** `noteCovers` (`questions.ts:181-184`) and its client mirror (`analytics/days.ts:62-65`) learn the season. Every consumer then applies it with no change of its own:

- the forecast read (`forecasts/reader.ts:259-260`) and its `adjust.ts` and `effects.ts` steps;
- the lab input (`lab/input.ts:281-282`), which sends the job per-day flags, not schedules;
- the questions' explanations (a yearly closure explains the no-sales days it covers, past ones only from its start);
- `closed-days.ts` and the chat's day and sales tools;
- the weekly pass's overlap;
- the client calendar.

D31's past-day rule is unchanged: before today, a yearly closure holds only where guests are missing. `sameSchedule` (`rules.ts:88-93`), `sameDays` (`lab/suggestions.ts:189-193`) and the store schemas (`business-rules.ts:27-64`, `agent-suggestions.ts:31-92`) compare and store `season`.

**Words.** `scheduleSummary` (`forecasts/reasons.ts:200-208`) words a season, for example:

- "Closed Jan 1 to Mar 31 every year, from Nov 17, 2026";
- "Closed on Mondays, Dec 20 to Jan 5 every year, from Nov 17, 2026".

`ruleReasonView`'s label (`:211-224`) adds the season with no start: "Your rule: closed Jan 1 to Mar 31 every year".

TownwiseAI's `business_rules` block carries `scheduleSummary` as its "Forecast schedule:" line (`chat/user-message.ts:46-51`), so the chat reads "every year" with no prompt change. Existing rules' summaries do not change, so no conversation gets a new block from the deploy.

**The weekly pass.** It sends a rule's schedule with its `season`, and `SUGGESTIONS_SYSTEM_PROMPT` gains one sentence: "A rule's season, when set, repeats its closure on the same months and days every year from its startDate." Its own answers stay without seasons.

**The P29 form** (web and native). Change the forecast gains a box, "Every year", shown for rules only (`NoteFields` and `checkSchedule` in `client/src/portal/locations/noteRules.ts`).

- When it is checked, Starts and Ends set the first season and Ends is required. The helper reads "Closes the same days every year from Starts on, until you delete the rule."
- The form sends `season` from the two dates' months and days, `startDate` as Starts and `endDate` null.
- A season over a year, or one starting or ending Feb 29, gets "Pick a season shorter than a year that doesn’t start or end on Feb 29."
- Editing a yearly rule prefills Starts and the first season's end.

**From a file.** A pattern with `yearly: true` becomes a yearly suggestion (decision 2), "Closed Jan 1 to Mar 31 every year". Otherwise a season is dated.

**A yearly rule starts at the read's today.** Earlier years' closed seasons stay explained only by notes or answers, as before. Edit can move Starts back.

## Risks / Trade-offs

- [The model reads "Closed Mondays" into a file that does not say it] → It is a suggestion, changes nothing until confirmed, and the card links the file; the prompt names service hours as not a pattern.
- [Removing the weekday question loses the past-only answer] → Edit sets an end date; Dismiss leaves the days out of gaps as today.
- [A yearly rule changes every coverage check] → One function changes (`noteCovers`, plus its client mirror). Rules with no season are pinned unchanged by the existing forecast, lab input and questions tests.
- [The new member routes sit beside admin routes over one collection] → Each pair 404s the other's rows before any write, pinned by tests.

### Known limits (code review, 2026-11-17)

The branch review's should-fixes S1 to S3 and nits N3 and N4 are fixed (the last day with sales read over every day of the weekday; the weekly pass drops a rule the sales history already suggests; API tests of a season across the new year; a Dismiss that lands after a racing Confirm wrote its rule answers accepted; an edit with no `season` key keeps the stored season). These stay as known limits:

- **N1, undo against an in-flight Confirm.** If undo deletes an open suggestion after a Confirm read it but before that Confirm wrote its rule, the rule stands with no suggestion row and no `agent.suggestion_accepted` event; `rule.created` still records it. The rule then blocks any new suggestion of the same closure (isSuggestable).
- **N2, who undo names.** When undo finishes as accepted a suggestion whose rule a Confirm already wrote, `agent.suggestion_accepted` names the person undoing; `rule.created` names the person who confirmed.
- **N4, an older client's dated edit of a yearly rule.** An edit with no `season` key keeps the stored season, so such an edit that also sets an end date is refused (400 `invalid_request`) rather than silently dropping the season.
- **N5, extra reads.** GET .../agent and GET .../rules each read the sales window again for the sales source, plus up to 7 lookups by closure key, and the weekly pass reads it once more. Fine at this scale; the reads could be shared later.
- **N6, the client's Every year check in a leap year.** The P29 form counts real days between Starts and Ends, so in a leap year it refuses a 364-day season the API accepts. It is never looser than the API.
- **N7, closed patterns after the original is deleted.** Deleting a file's original clears the answer's text but keeps `closedPatterns`, which are Townwise's schedules with no words of the file.

## Migration Plan

None. The fields are optional (absent `source` is `weekly`, absent `season` is none) and the partial index builds at boot. Weekday questions already answered keep their notes.

Rollback is a revert plus one cleanup. An older build would read a yearly rule's schedule without its season, so a rollback first takes the season off those rules or deletes them. Its `listOpen` could also show an open file row whose start is ahead as a weekly suggestion, so the rollback deletes open file and sales rows (`deleteMany({ source: { $in: ['file', 'sales'] }, status: 'open' })`). Both runbook lines go in `infra/README.md` (task 5.5).

## Open Questions

- Should weekly rule suggestions also show in P29's group? They are left in the panel only, for now.
- Should a yearly rule from a file start earlier, so it explains last year's closed season in the questions?
