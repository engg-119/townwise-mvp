Start after session d6 closes `weekly-forecast-suggestions` tasks 4.2 and 4.3, rebased on develop (design decision 9 lists the shared files). Write each task's tests (group 6) first, before its code. Groups 1, 3, 4 and 5 make the file source and seasons buildable and verifiable alone. Group 2, the sales source, comes after them, and is dropped if the owner defers it.

## 1. API: store, routes and the file source

- [x] 1.1 `stores/agent-suggestions.ts`:
  - optional `source` (absent reads as `weekly`), `fileId`, `evidence { noSalesCount, weekdayCount, lastSalesDate }` and `closureKey`;
  - the partial unique index `{ orgId, locationId, closureKey }` (`closureKey` a string);
  - `why` required for `weekly` only, null otherwise;
  - `season` on the content schema;
  - `insertOne` with a given id;
  - `listOpen` weekly only, and a new `listOpenRules` (file and sales rows whose end is null or not before today);
  - `expire` source-aware;
  - `findByKey`;
  - `openFromFile(scope, locationId, fileId)`.
- [x] 1.2 New `agent/closure-suggestions.ts` (pure): `closureKeyOf(schedule)` (weekdays, dates, `yearly=`, `ongoing`), `closureRuleText(schedule)` (the six forms in design decision 3), and `isSuggestable(schedule, { rules })` (a covering closure rule; same words only on a rule with a schedule).
- [x] 1.3 `files/extract/reader-prompt.ts`:
  - the `closedPatterns` bullet exactly as in design decision 2;
  - `closedPatterns` in `readerAnswer` (max 5, `yearly`);
  - `readerResult(raw, today)` with the drops of decision 2, each kept entry built into a full schedule and run through `readRuleSchedule`;
  - an answer with no `closedPatterns` reads as empty.

  Pass `today` from `files/ai-reader.ts`.
- [x] 1.4 `stores/files.ts`: the answer's `closedPatterns`, `plan.suggestionIds` (absent on old plans), and the outcome's `rulesSuggested` (ids) and `rulesSkipped { duplicate, cap, invalid }`.
- [x] 1.5 `files/ai-actions.ts`: after the notes, while the read is held, each pattern becomes an open suggestion (`source: 'file'`, `fileId`, `closureKey`, Townwise's words) under its planned id.
  - The planned id is looked up first; the caps of 5 a read and 10 open per location apply only to ids not yet written.
  - A duplicate `closureKey` counts `duplicate`.
  - A `closure` event refused for its span only, ending on or after today, becomes a suggestion under its own unused `noteIds[index]`. It is counted in `rulesSuggested`, not `notesSkipped.guard`. The 31-day total and buyouts stay `guard`.
- [x] 1.6 `files/ai-reader.ts`: `townwise.ai_read` gains `rulesSuggested` and `rulesSkipped`; `file.ai_read` gains `rulesSuggested`.
- [x] 1.7 `handlers/data.ts`: `undoAiRead` finishes as accepted each open suggestion whose rule exists under its id, deletes the other open ones, and keeps accepted and dismissed ones. `undoable` counts suggestions, and `file.ai_undone` gains `suggestions`.
- [x] 1.8 New `handlers/rule-suggestions.ts` and two `TOWNWISE_ROUTES` entries, `org.agent.rule_suggestion_accept` and `org.agent.rule_suggestion_dismiss` (`.../agent/rule-suggestions/:suggestionId/accept|dismiss`, `member`, `openAsAdmin: true`, 2 KB).
  - A `weekly` row answers 404 before any write.
  - Accept takes `{}` or `{ rule: { text, schedule } }`, checked by `ruleTextOf` and `readRuleSchedule`.
  - A rule already under the id with different words or schedule answers 409 `already_decided` with the stored rule.
  - `edited` is worked out from the stored rule.
  - 409 `rule_limit` and `rule_exists` leave the suggestion open.
  - Records `agent.suggestion_accepted { source, edited }` or `agent.suggestion_dismissed { source }` once, and logs `townwise.agent_suggestion` with `source` and `edited`.
- [x] 1.9 `handlers/weekly-suggestions.ts`: `suggestionOf` answers 404 for a `file` or `sales` row. No other change.
- [x] 1.10 `handlers/agent.ts`: GET .../agent adds `ruleSuggestions`. `handlers/rules.ts`: GET .../rules adds `suggested`. Both use one builder, listing file rows from `listOpenRules`.
- [x] 1.11 `lab/suggestions.ts`:
  - `keptSuggestions` drops a weekly rule whose `closureKey` matches a file or sales row;
  - `alreadySuggested` leaves file and sales rows out;
  - `sameDays` compares `season`.
- [x] 1.12 `stores/audit-events.ts` allowlists (`file.ai_read` `rulesSuggested`; `file.ai_undone` `suggestions`; `agent.suggestion_accepted` `source`, `edited`; `agent.suggestion_dismissed` `source`) and `audit.ts` wording.

## 2. The sales source (its own sign-off: `[CONFIRM: the sales history suggests standing closed weekdays]`)

- [x] 2.1 `agent/questions.ts`:
  - export `weekdayEvidence(input)`: the same counted days and 60% of at least 4, plus the last 4 counted days without sales, and `lastSalesDate`;
  - `questionsFor` stops emitting weekday questions and keeps `closedWeekdays` for gaps;
  - `salesSuggestionsFor(...)` gives a schedule starting the day after `lastSalesDate` (or `from`), suppressed by an `open`, `not_sure` or `other` weekday answer, by an existing row with its key, and by `isSuggestable`.
- [x] 2.2 The builder of 1.10 adds sales suggestions: `sales_weekday_{d}` while no row has the key, the stored id while that row is open, none otherwise.
- [x] 2.3 `handlers/rule-suggestions.ts`: a `sales_weekday_[0-6]` id recomputes its evidence (404 when it no longer holds), then inserts the row (`source: 'sales'`, `closureKey`, `evidence`), or finds it by `closureKey` on a duplicate key, before the decision.
- [x] 2.4 `handlers/sales.ts`: deleting a location's sales data deletes its sales rows that are not accepted.
- [x] 2.5 Client: the card's sales origin line ("No sales on any Monday since Sep 7", then "{n} of {m} Mondays"). The panel no longer receives weekday questions; the question card still ignores unknown kinds.
- [x] 2.6 Docs: spec 10.12 and `tuning-chat.md` section 8 (the weekday question replaced, its evidence, the start rule).
- [x] 2.7 Tests:
  - unit, in `api/test/agent-questions.test.ts`:
    - no weekday question;
    - the evidence and the recency bar;
    - a net-sales-only open Monday inside the window is not covered by the suggested schedule (audit B1);
    - gaps still bridge a closed weekday;
    - suppression by earlier answers;
  - integration, in `api/test/closure-suggestions.int.test.ts`:
    - two tabs confirming `sales_weekday_1` make one row and one rule;
    - a stale sales id answers 404;
    - a file row and a sales decide with one key make one row;
    - deleting sales data clears sales decisions.

## 3. Seasons in D31 rule schedules

- [x] 3.1 `stores/business-rules.ts`: `season { repeat: 'yearly', from, to }` on `RuleSchedule` and its schema (absent read as null). `handlers/notes.ts` `validDays` and `readRuleSchedule`:
  - real month-days, never `02-29`;
  - shorter than a year;
  - `endDate` null with a season;
  - notes refuse a season.

  `[CONFIRM: a yearly rule runs every year from its start until it is deleted; Feb 29 can't start or end a season; a season is shorter than a year]`
- [x] 3.2 `agent/questions.ts` `noteCovers` learns the season, including one crossing the new year. `rules.ts` `sameSchedule` compares it.
- [x] 3.3 `forecasts/reasons.ts`: `scheduleSummary` and `ruleReasonView` word a season as in design decision 12.
- [x] 3.4 `lab/suggestions.ts`: the one sentence on `season` in `SUGGESTIONS_SYSTEM_PROMPT`; the request sends it.
- [x] 3.5 Client: `client/src/portal/analytics/days.ts` `noteCovers` mirror; `rules/api.ts` schema; the P29 form's "Every year" box in `NoteFields` (rules only), with `checkSchedule`, `draftOfSchedule` and its words in `noteRules.ts` and `rules.ts`; editing a yearly rule prefills its first season.

## 4. Client (web and native)

- [x] 4.1 `client/src/chat/api.ts` and `client/src/portal/rules/api.ts`:
  - a `RuleSuggestion` schema (`id`, `source`, `text`, `schedule`, `scheduleSummary`, `file { ref, title } | null`, `evidence | null`, `canDecide`);
  - `ruleSuggestions` on the panel read and `suggested` on the rules read;
  - the two new routes, accept with an optional `rule`.
- [x] 4.2 A new shared `RuleSuggestionCard`:
  - the view's `text`, with no client wording copy;
  - what it does, and where it came from;
  - Confirm, Edit and Dismiss when `canDecide`, disabled under view-as;
  - the lines for 409 `rule_limit`, `rule_exists` (with the link to edit the unscheduled rule) and `already_decided` ("Already confirmed as: {text}").
- [x] 4.3 P29 `BusinessRules.tsx`:
  - the "Suggested by TownwiseAI" group above Add a rule;
  - Edit opens the rule form prefilled, and Save sends the accept with `rule`;
  - `?suggestion={id}` opens that card's edit;
  - a confirmed card moves into the list in place (`useRules`).
- [x] 4.4 P25 panel (`AgentSidePanel.tsx`, `useAgentPanel.ts`): a "Suggested rules" section before Questions for you; Edit links to P29 with `?suggestion=`.
- [x] 4.5 Home (`Home.tsx`): the count adds `ruleSuggestions`.
- [x] 4.6 P27 `AiSection.tsx` and `aiCopy.ts`:
  - "Suggested {n} rules on Business rules";
  - the guard line counts only events still left out;
  - the undo dialog names "the {n} suggested rules still waiting";
  - the `explain` opt-in sentence of design decision 10.

  Console `words.ts` shows the new details as counts.

## 5. Docs and privacy

- [x] 5.1 `docs/portal/spec.md`:
  - section 2: the D46 row, after D44 (D43 and D45 are other changes'), covering the file source, the sales source and yearly seasons, with every `[CONFIRM]` of design decisions 2, 4, 6, 8 and 12;
  - 6.24 (`season`), 6.27 (fields, index), 9.2 (details; line 885's "`townwise_ai` is reserved" corrected);
  - 10.12 and 10.14;
  - 10.16 (GET `suggested`, the season and its checks, the two new routes);
  - 11A.9 (the prompt bullet, the check, the actions' new step, the counts), 12 (notes refuse a season), 14.5 (a yearly schedule covers its months and days), 17;
  - P11, P25, P27 (the opt-in quote), and P29 (the group, the Every year box, and the lead's sentence "Until TownwiseAI can propose rules, no copy says it suggests or saves them." rewritten);
  - section 22 entries and a section 23 changelog entry for 2026-11-17.
- [x] 5.2 `api/README.md`: Reading with TownwiseAI (items 7 and 8), Business rules (the season), the side panel, the two new routes, the audit table, `tw_agent_suggestions` fields.
- [x] 5.3 Privacy and copy (owner approved the update on 2026-11-17):
  - apply design decision 10's exact sentences to `client/app/(marketing)/privacy.tsx` ("Files you let TownwiseAI read"), `docs/portal/estimates.md` section 5 and `aiCopy.ts` `explain`;
  - update `client/test/marketing/pages.test.web.tsx` and `client/test/portal/data/item-ai.test.web.tsx`;
  - check the marketing FAQ (`client/src/marketing/Home.web.tsx`) again and change any sentence the change makes untrue.
- [x] 5.4 `docs/portal/tuning-chat.md`: section 3 (a rule's "Forecast schedule" line can say "every year") and section 9 (the closure-key drop, `alreadySuggested` without file and sales rows, the season sentence). The chat sees confirmed rules only; no tool changes.
- [x] 5.5 `infra/README.md`: the two rollback cleanup lines (design Migration Plan).
- [x] 5.6 The coordinator records the D46 claim in the shared spec-number reservations.

## 6. Tests

- [x] 6.1 Unit tests:
  - `api/test/closure-suggestions.test.ts`: keys, words and `isSuggestable`, including an unscheduled same-words rule.
  - The reader prompt and check tests (`api/test/files/`):
    - "Closed Mondays" gives weekdays `[1]`;
    - "Brunch Saturday and Sunday" and "Happy hour Tue to Fri" give no pattern;
    - all 7 weekdays with no dates is dropped;
    - a past range, a 400-day span and a pattern with neither weekdays nor dates are dropped;
    - "closed every winter, January to March" gives `yearly`;
    - an answer with no `closedPatterns` reads as empty.
- [x] 6.2 Season unit tests:
  - `noteCovers` with a season, one crossing the new year, Feb 29 in a leap year inside a season, and before `startDate`;
  - `validDays` refusals;
  - `scheduleSummary` and the reason label;
  - the client `noteCovers` mirror and the P29 form's Every year checks (web and native);
  - a rule with no season unchanged in the existing forecast, lab input and questions tests.
- [x] 6.3 Integration tests in `api/test/closure-suggestions.int.test.ts`:
  - a file read with "Closed Mondays" makes one open suggestion and no rule;
  - a retried read makes it once and counts no `cap`;
  - an action on a pre-change saved answer and plan makes none and fails nothing;
  - a 60-day closure event becomes a suggestion, while a buyout and the 31-day overflow stay `guard`;
  - caps of 5 and 10;
  - undo removes an open one, keeps a confirmed rule, and finishes an accept that wrote its rule before undo ran;
  - confirm, edit and dismiss;
  - Confirm racing Edit gives one rule and one 409 `already_decided`, with `edited` matching the stored rule;
  - an Edit body of 200 four-byte characters passes 2 KB;
  - a dismissed key is not suggested again;
  - a member decides file rows, and gets 404 on a weekly row through the new routes;
  - an org admin gets 404 on a file row through the weekly routes;
  - a member's dismiss of a weekly row whose rule an admin's accept already wrote answers 403 through the weekly route and writes nothing;
  - view-as answers 403;
  - staff open as admin are audited;
  - 409 `rule_limit` at 30 leaves the suggestion open;
  - a yearly suggestion confirms into a yearly rule;
  - logs and audit carry no rule text, file name or date sentinel.
- [x] 6.4 The forecast is unchanged until accepted: with a published forecast, next Monday stays open while the suggestion is open, and closes once confirmed. A confirmed yearly rule closes the season's days and no others.
- [x] 6.5 Weekly pins in `api/test/weekly-suggestions.int.test.ts` and `.test.ts`:
  - the pass's `expire()` leaves an ongoing file row that starts today open;
  - `listOpen` returns no file or sales row;
  - `alreadySuggested` holds no file or sales row;
  - a weekly rule matching a file row's key is dropped.
- [x] 6.6 Tenant isolation and the route table:
  - another organization's suggestion id, a `sales_weekday_` id on another organization's location, and another organization's file answer 404 like unknown ones (`api/test/isolation.int.test.ts`);
  - `api/test/isolation.test.ts` import lists stay green;
  - `routes.test.ts` pins all four suggestion routes;
  - `api/test/indexes.test.ts` covers the new index;
  - `chain.int.test.ts` seeds a closed-weekday sales history, a file suggestion and an expired range, so "GET is side-effect free (7.3)" runs the new paths.
- [x] 6.7 Client tests:
  - `RuleSuggestionCard`, web and native;
  - `client/test/portal/rules/page.test.web.tsx` and `.test.native.tsx` (the group, Edit, Every year, confirm moving the rule, errors, view-as);
  - `client/test/chat/agent-panel.test.ts` and both `agent-panel.json` fixtures;
  - the Home count in `client/test/portal/home/home.test.web.tsx` and `.test.native.tsx`;
  - the P27 lines.

## 7. Verification and owner

- [ ] 7.1 Run `openspec validate suggest-closure-rules --strict` after any change to these files.
- [ ] 7.2 An independent UI review of P29's group, its Every year box, the P25 section and the card, on web and native, by an agent that did not build them.
- [ ] 7.3 Run `/review`, then `/verify` (`npm run verify`; coordinate heavy runs with the release session).
- [ ] 7.4 The owner sees the final privacy wording before push, and decides the `[CONFIRM]`s.
- [ ] 7.5 Push only after the owner's go.
