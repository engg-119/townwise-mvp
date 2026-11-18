## ADDED Requirements

### Requirement: A file read suggests the closed patterns the file states
The file reader's answer SHALL include `closedPatterns`, at most 5, each `{ weekdays, startDate, endDate }`. Each SHALL be a pattern the file states (a closed weekday, opening hours that cover the whole week, or a dated closed season), never inferred from days missing in a sales table, with no text from the file. Townwise SHALL drop an entry whose weekdays are not unique values 0 to 6, that has neither a weekday nor both dates, whose start is after its end, that spans more than 366 days, or whose end is before the read's today. The read's actions SHALL store each kept pattern as an open suggestion in `tw_agent_suggestions` with `source: 'file'`, the file's id, a closure schedule (`kind: 'closure'`, `effect: 'closed'`, the weekdays, the dates, `startDate` the town's today and `endDate` null when the file states no dates) and rule words Townwise writes from the schedule. They SHALL store under ids planned with the read, so a retried read stores each once. A closure event the read may not write as a note (over 14 days, or past 31 closed days a read) SHALL become such a suggestion with its dates. A read SHALL store at most 5 suggestions, and none while the location has 10 open file suggestions, counting what it skips. [CONFIRM: a closure a file read may not write on its own becomes a suggested rule] [CONFIRM: 5 suggested rules a file read, 10 open per location from files]

#### Scenario: Posted hours
- **WHEN** a member lets TownwiseAI read a menu that says "Open Tuesday to Sunday, 11 to 9"
- **THEN** the read stores one open suggestion "Closed on Mondays" with weekdays `[1]` and no end, writes no rule, and the forecast for next Monday is unchanged

#### Scenario: A closed season
- **WHEN** the file says "Closed for the season January 4 to March 31" and today is 2026-11-17
- **THEN** the read stores an open suggestion "Closed Jan 4 to Mar 31, 2027" with those dates

#### Scenario: Missing days are not a pattern
- **WHEN** a sales export has no rows for Mondays and states no hours or closures
- **THEN** the answer's `closedPatterns` is empty and no suggestion is stored

#### Scenario: A retried read
- **WHEN** a read's actions stop after storing its suggestions and run again on the saved answer
- **THEN** each suggestion exists once

### Requirement: The sales history suggests a standing closed weekday
When at least 60% of a weekday's counted days in the last 365 days of coverage have no sales, with at least 4 counted days, GET .../agent and GET .../rules SHALL list a suggested rule "Closed on {weekday}s" with the id `sales_weekday_{d}`. A day SHALL count as the weekday question counted it before this change. The suggestion SHALL carry a closure schedule from the first day with sales in the window, with no end, and its evidence (`noSalesCount`, `weekdayCount`, `from`). These reads SHALL write nothing. The weekday question SHALL no longer be asked. A weekday whose earlier weekday question was answered `open`, `not_sure` or `other` SHALL not be suggested. Accepting or dismissing a `sales_weekday_{d}` id SHALL recompute its evidence (404 when it no longer holds) and store the suggestion once per location and weekday (`salesKey`, a unique index) before the decision is applied. Deleting a location's sales data SHALL delete its sales suggestions that are not accepted. [CONFIRM: the suggested rule replaces the weekday question, at the same 60% of at least 4 days]

#### Scenario: Closed Mondays in the history
- **WHEN** a location has no sales on 9 of its 11 counted Mondays
- **THEN** GET .../agent lists `sales_weekday_1` as "Closed on Mondays" with `noSalesCount` 9 and `weekdayCount` 11, and its questions hold no weekday question

#### Scenario: Two tabs confirm it
- **WHEN** two requests accept `sales_weekday_1` at once
- **THEN** one suggestion row and one rule exist, and `agent.suggestion_accepted` is recorded once

#### Scenario: The owner said they were open
- **WHEN** the location's weekday question for Mondays was answered `open`
- **THEN** no Monday rule is suggested

### Requirement: A suggestion is deduped on its closure schedule
A suggestion SHALL have a closure key: its weekdays, plus its dates only when it has an end. A file or sales suggestion SHALL not be made when one of these holds:

- a suggestion with the same key exists in any status but expired;
- a closure rule of the location already covers it (for one with no end, an ongoing closure rule on the same weekdays or more; for one with an end, the same key);
- a rule of the location has its words in any case.

The weekly pass SHALL drop a rule suggestion whose key matches a file or sales suggestion.

#### Scenario: Dismissed is remembered
- **WHEN** a member dismissed "Closed on Mondays" from a file and the sales history later shows Mondays with no sales
- **THEN** no Monday rule is suggested again

#### Scenario: Two sources, one rule
- **WHEN** a file suggestion "Closed on Mondays" is open and the sales history's Monday evidence holds
- **THEN** only the file suggestion is listed

### Requirement: Nothing changes until someone confirms, edits or dismisses
A file or sales suggestion SHALL change no forecast and no rule until it is accepted. Any member outside view-as, staff open as admin among them, SHALL decide one through `org.agent.suggestion_accept` and `org.agent.suggestion_dismiss`, both `member` routes. A member SHALL get 403 `forbidden` on a weekly suggestion, which stays with org admins. Confirm (an empty body) SHALL write the business rule through the rules code as the caller, `addedVia: 'townwise_ai'`, with the suggestion's id. Edit SHALL send `{ rule: { text, schedule } }`, checked by the rule text and schedule rules, and SHALL write the edited rule the same way. Edit is allowed on file and sales suggestions only. Both SHALL mark the suggestion accepted by compare-and-set. Dismiss SHALL mark it dismissed. 409 `rule_limit` or `rule_exists` SHALL leave the suggestion open, and open suggestions SHALL not count toward the location's 30 rules. A file or sales suggestion SHALL stay open while its end is null or not before today in the town. [CONFIRM: any member confirms, edits or dismisses a suggested closure rule; weekly suggestions stay with org admins] [CONFIRM: suggested rules don't count toward a location's 30 until confirmed]

#### Scenario: The forecast waits for Confirm
- **WHEN** a location with a published forecast has an open suggestion "Closed on Mondays"
- **THEN** next Monday's forecast is open, and after a member confirms it that Monday reads as closed

#### Scenario: Edit
- **WHEN** a member edits the suggestion to end on 2027-06-01 and saves
- **THEN** the rule is saved with that end, the suggestion is accepted, and `agent.suggestion_accepted` records `edited: true`

#### Scenario: A member on a weekly suggestion
- **WHEN** a member posts accept for a weekly suggestion
- **THEN** the API answers 403 `forbidden` and nothing is written

#### Scenario: Under view-as
- **WHEN** staff viewing as the organization post accept
- **THEN** the route chain answers 403 `view_as_read_only`

#### Scenario: Another organization's suggestion
- **WHEN** a member posts accept for a suggestion id of another organization, or `sales_weekday_1` on another organization's location
- **THEN** the API answers 404 exactly as for an unknown id

#### Scenario: At the rule limit
- **WHEN** a location has 30 rules and a member confirms a suggestion
- **THEN** the API answers 409 `rule_limit` and the suggestion stays open

### Requirement: Undoing a read removes its open suggestions
Undoing a file read SHALL delete the suggestions it stored that are still open, and SHALL keep the accepted and dismissed ones. A read that made only suggestions SHALL be undoable. `file.ai_undone` SHALL count the suggestions removed. [CONFIRM: undoing a read removes its open suggested rules and keeps rules already confirmed]

#### Scenario: Undo after one was confirmed
- **WHEN** a read made two suggestions, a member confirmed one, and the read is undone
- **THEN** the open one is gone, the confirmed rule and its accepted suggestion stay, and `file.ai_undone` records `suggestions: 1`

### Requirement: Where suggested rules show
P29 Business rules SHALL show the location's open file and sales suggestions in a "Suggested by TownwiseAI" group above Add a rule. Each card SHALL show the rule, what it does to the forecast, and where it came from (the file, linked to its page, or the day counts). It SHALL have Confirm, Edit and Dismiss, disabled under view-as. Edit SHALL open the rule form prefilled. P25's panel SHALL show them in a "Suggested rules" section before Questions for you, whose Edit opens the card's edit on P29. Home's question count SHALL include them. P27 SHALL say how many rules a read suggested. All of this SHALL work on web and native.

#### Scenario: The Rules page
- **WHEN** a member opens Business rules with one open suggestion
- **THEN** the "Suggested by TownwiseAI" group shows "Closed on Mondays" with Confirm, Edit and Dismiss above Add a rule

#### Scenario: Home
- **WHEN** a location has 1 question, 1 weekly suggestion and 2 suggested rules
- **THEN** Home says "4 questions from TownwiseAI"

### Requirement: Audit, logs and privacy carry ids and counts only
`file.ai_read` SHALL add `rulesSuggested`, `agent.suggestion_accepted` SHALL add `source` and `edited`, and `agent.suggestion_dismissed` SHALL add `source`. `townwise.ai_read` SHALL add `rulesSuggested` and `rulesSkipped`, and `townwise.agent_suggestion` SHALL add `source` and `edited`. No log line or audit event SHALL carry a rule's words, a schedule, a file name or an evidence date. Nothing new SHALL be sent to Anthropic: the sales source SHALL call no model, and the file source SHALL send nothing beyond the read's existing request.

#### Scenario: Nothing private in logs
- **WHEN** a read suggests "Closed on Mondays" from a file named with a guest's name and a member confirms it
- **THEN** no log line or audit event holds the rule's words, the file's name or the rule's dates
