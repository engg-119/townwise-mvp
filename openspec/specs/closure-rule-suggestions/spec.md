# closure-rule-suggestions Specification

## Purpose
TBD - created by archiving change suggest-closure-rules. Update Purpose after archive.
## Requirements
### Requirement: A file read suggests the closed patterns the file states
The file reader's answer SHALL include `closedPatterns`, at most 5, each `{ weekdays, startDate, endDate, yearly }`, with weekdays numbered 0 (Sunday) to 6. A pattern SHALL be one of these, as the file states it:

- a closed weekday;
- the restaurant's own opening hours for every day of the week (never a meal, kitchen, bar or menu section's hours);
- a dated closed season, `yearly` only when the file says it recurs.

A pattern SHALL never be inferred from days missing in a sales table, and SHALL keep no text from the file. Townwise SHALL check the answer against the read's today and drop an entry when:

- its weekdays are not unique;
- it names all 7 weekdays with no dates;
- it has neither a weekday nor both dates;
- its start is after its end, or it spans more than 366 days;
- its end is before today;
- it fails the rule schedule rules.

An answer with no `closedPatterns` SHALL read as empty.

The read's actions SHALL store each kept pattern as an open suggestion in `tw_agent_suggestions`, with:

- `source: 'file'` and the file's id;
- a closure schedule;
- rule words Townwise writes from the schedule;
- a planned id, looked up before any cap so a retried read stores each once.

A `closure` event the read may not write as a note only because it spans over 14 days, and that ends on or after today, SHALL become such a suggestion. Buyouts and events refused by the 31-closed-days total SHALL stay skipped. A read SHALL store at most 5 suggestions from patterns, and none while the location has 10 open file suggestions.

#### Scenario: Posted hours
- **WHEN** a member lets TownwiseAI read a menu whose opening hours read "Tuesday to Sunday, 11 to 9"
- **THEN** the read stores one open suggestion "Closed on Mondays" with weekdays `[1]` and no end, writes no rule, and next Monday's forecast is unchanged

#### Scenario: Service hours are not opening hours
- **WHEN** the file says "Brunch Saturday and Sunday" and states no opening hours
- **THEN** no pattern is kept and no suggestion is stored

#### Scenario: A season every year
- **WHEN** the file says "Closed every winter, January 1 to March 31"
- **THEN** the read stores an open suggestion "Closed Jan 1 to Mar 31 every year" with a yearly season and no end

#### Scenario: Missing days are not a pattern
- **WHEN** a sales export has no rows for Mondays and states no hours or closures
- **THEN** `closedPatterns` is empty and no suggestion is stored

#### Scenario: A retried read
- **WHEN** a read's actions stop after storing its suggestions and run again on the saved answer
- **THEN** each suggestion exists once and none is counted as over the cap

### Requirement: The sales history suggests a standing closed weekday
GET .../agent and GET .../rules SHALL list a suggested rule "Closed on {weekday}s" when all of these hold:

- at least 60% of the weekday's counted days in the last 365 days of coverage have no sales;
- there are at least 4 counted days;
- its last 4 counted days have no sales.

A day SHALL count as the weekday question counted it, and a day with guests or net sales SHALL have sales. The suggestion SHALL carry:

- a closure schedule with no end, starting the day after the weekday's last counted day with sales (or the first day with sales in the window when it had none), so it never covers a past day with recorded sales;
- its evidence (`noSalesCount`, `weekdayCount`, `lastSalesDate`).

These reads SHALL write nothing. The suggestion SHALL be listed as `sales_weekday_{d}` while no suggestion has its closure key, and under its stored id while that one is open. The weekday question SHALL no longer be asked. A weekday whose earlier weekday question was answered `open`, `not_sure` or `other` SHALL not be suggested.

Deciding a `sales_weekday_{d}` id SHALL recompute its evidence (404 when it no longer holds) and store the suggestion once per closure key before the decision. Deleting a location's sales data SHALL delete its sales suggestions that are not accepted.

#### Scenario: Closed Mondays in the history
- **WHEN** a location had no sales on 9 of its 11 counted Mondays, the last 4 among them, and last had sales on a Monday on Sep 7
- **THEN** GET .../agent lists `sales_weekday_1` as "Closed on Mondays" starting Sep 8, and its questions hold no weekday question

#### Scenario: A Monday with net sales and no guests
- **WHEN** one counted Monday in the window had net sales but no guest count
- **THEN** the suggested schedule starts after that Monday and does not cover it

#### Scenario: Two tabs confirm it
- **WHEN** two requests accept `sales_weekday_1` at once
- **THEN** one suggestion row and one rule exist, and `agent.suggestion_accepted` is recorded once

#### Scenario: The owner said they were open
- **WHEN** the location's weekday question for Mondays was answered `open`
- **THEN** no Monday rule is suggested

### Requirement: A suggestion is deduped on its closure key
A file or sales suggestion SHALL have a closure key: its weekdays, plus its dates when it has an end, or its season when it repeats yearly. A unique index SHALL keep one suggestion per key at a location in any status. A suggestion SHALL also not be made when either of these holds:

- a closure rule of the location already covers it;
- a rule with a schedule has its words in any case.

A rule with the same words and no schedule SHALL not block it. The weekly pass SHALL drop a rule suggestion whose key matches a file or sales suggestion, and SHALL not send file or sales suggestions to Anthropic.

#### Scenario: Dismissed is remembered
- **WHEN** a member dismissed "Closed on Mondays" from a file and the sales history later shows Mondays with no sales
- **THEN** no Monday rule is suggested again

#### Scenario: Two sources, one rule
- **WHEN** a file suggestion "Closed on Mondays" is open and the sales history's Monday evidence holds
- **THEN** only the file suggestion is listed

### Requirement: Nothing changes until someone confirms, edits or dismisses
A file or sales suggestion SHALL change no forecast and no rule until it is accepted. The one exception is D59 slice 3: while TownwiseAI works on its own (the `TOWNWISE_AGENT_AUTO` switch and the organization's `agentAuto` switch), it MAY apply a closure rule suggestion itself when the model rated it `high`, the code checks pass, it conflicts with no rule or note a person made on those days and its dedupe key was never used at the location, with Undo, and at most 2 rules a week per location. Anything else stays open for a person. Any member outside view-as, staff open as admin among them, SHALL decide one through `org.agent.rule_suggestion_accept` and `org.agent.rule_suggestion_dismiss`. Both are `member` routes, 2 KB, at `.../agent/rule-suggestions/:suggestionId/`. They SHALL answer 404 for a weekly suggestion before any write, and the weekly routes SHALL answer 404 for a file or sales suggestion.

**Confirm and Edit.**

- Confirm (an empty body) SHALL write the rule through the rules code as the caller, `addedVia: 'townwise_ai'`, with the suggestion's id.
- Edit (`{ rule: { text, schedule } }`, checked by the rule text and schedule rules) SHALL write the edited rule the same way.
- A request that finds a rule already under that id with other words or schedule SHALL answer 409 `already_decided` with the stored rule.
- `edited` SHALL be worked out from the stored rule.

**Dismiss** SHALL mark the suggestion dismissed.

**Limits and expiry.** 409 `rule_limit` or `rule_exists` SHALL leave the suggestion open. Open suggestions SHALL not count toward the location's 30 rules. A file or sales suggestion SHALL stay open while its end is null or not before today in the town, and the weekly pass's expiry SHALL not expire it before then.

#### Scenario: The forecast waits for Confirm
- **WHEN** a location with a published forecast has an open suggestion "Closed on Mondays"
- **THEN** next Monday's forecast is open, and after a member confirms it that Monday reads as closed

#### Scenario: Edit
- **WHEN** a member edits the suggestion's words to "Closed Mondays in winter" and saves
- **THEN** the rule is saved with those words, the suggestion is accepted, and `agent.suggestion_accepted` records `edited: true`

#### Scenario: Confirm and Edit at once
- **WHEN** one tab confirms and another saves an edit of the same suggestion, and the confirm's rule lands first
- **THEN** one rule exists, as confirmed, and the edit answers 409 `already_decided` with that rule

#### Scenario: A member and a weekly suggestion
- **WHEN** a member posts accept on the new route for a weekly suggestion's id
- **THEN** the API answers 404 and nothing is written

#### Scenario: Under view-as
- **WHEN** staff viewing as the organization post accept
- **THEN** the route chain answers 403 `view_as_read_only`

#### Scenario: Another organization's suggestion
- **WHEN** a member posts accept for a suggestion id of another organization, or `sales_weekday_1` on another organization's location
- **THEN** the API answers 404 exactly as for an unknown id

#### Scenario: At the rule limit
- **WHEN** a location has 30 rules and a member confirms a suggestion
- **THEN** the API answers 409 `rule_limit` and the suggestion stays open

### Requirement: Undoing a read removes its suggestions still waiting
Undoing a file read SHALL treat its open suggestions one at a time:

- one whose rule already exists under its id SHALL be finished as accepted;
- every other open one SHALL be deleted;
- accepted and dismissed ones SHALL be kept.

A read that made only suggestions SHALL be undoable. `file.ai_undone` SHALL count the suggestions removed.

#### Scenario: Undo after one was confirmed
- **WHEN** a read made two suggestions, a member confirmed one, and the read is undone
- **THEN** the open one is gone, the confirmed rule and its accepted suggestion stay, and `file.ai_undone` records `suggestions: 1`

#### Scenario: Undo while a confirm is in flight
- **WHEN** a confirm has written its rule but not yet marked the suggestion accepted, and the read is undone
- **THEN** the suggestion is marked accepted, not deleted, and the rule stays

### Requirement: A business rule's schedule can repeat every year
A rule's schedule SHALL accept `season: { repeat: 'yearly', from: 'MM-DD', to: 'MM-DD' }`, absent or null meaning none. A season with `to` before `from` SHALL cross the new year. A schedule with a season SHALL cover a day when the day is on or after its start date, its weekday is allowed, and its month and day are in the season. It SHALL then apply wherever a schedule applies:

- the forecast read;
- the lab input;
- the questions' explanations;
- the client calendar;
- the weekly pass.

Before today its closure SHALL hold only as any rule closure does. A season SHALL be refused when:

- its months and days are not real;
- it starts or ends on Feb 29;
- it lasts a year or more;
- its schedule has an end date;
- it is on a note.

`scheduleSummary` SHALL word it ("Closed Jan 1 to Mar 31 every year, from Nov 17, 2026"), and TownwiseAI's `business_rules` block SHALL carry those words. P29's rule form SHALL offer "Every year" on web and native, taking the season from Starts and Ends.

#### Scenario: A winter closure
- **WHEN** a location has the rule "Closed Jan 1 to Mar 31 every year" from 2026-11-17
- **THEN** the forecast reads Feb 10, 2027 and Feb 10, 2028 as closed and Apr 1, 2027 as open

#### Scenario: Across the new year
- **WHEN** a rule's season is `12-20` to `01-05`
- **THEN** Dec 31 and Jan 3 are covered and Jan 6 is not

#### Scenario: Refused on Feb 29
- **WHEN** a member saves a yearly rule whose season ends on Feb 29
- **THEN** the API answers 400 `invalid_request` and nothing is saved

#### Scenario: Rules with no season are unchanged
- **WHEN** a location's rules have no season
- **THEN** every forecast, lab input and question reads as it did before this change

### Requirement: Where suggested rules show
P29 Business rules SHALL show the location's open file and sales suggestions in a "Suggested by TownwiseAI" group above Add a rule. Each card SHALL show:

- the rule;
- what it does to the forecast;
- where it came from (the file, linked to its page, or the day counts and the date since which there were no sales);
- Confirm, Edit and Dismiss, disabled under view-as.

Edit SHALL open the rule form prefilled. P25's panel SHALL show these suggestions in a "Suggested rules" section before Questions for you, whose Edit opens the card's edit on P29. Home's question count SHALL include them. P27 SHALL say how many rules a read suggested. All of this SHALL work on web and native.

#### Scenario: The Rules page
- **WHEN** a member opens Business rules with one open suggestion
- **THEN** the "Suggested by TownwiseAI" group shows "Closed on Mondays" with Confirm, Edit and Dismiss above Add a rule

#### Scenario: Home
- **WHEN** a location has 1 question, 1 weekly suggestion and 2 suggested rules
- **THEN** Home says "4 questions from TownwiseAI"

### Requirement: Audit, logs and privacy carry ids and counts only
These SHALL gain the following fields:

- `file.ai_read`: `rulesSuggested`;
- `file.ai_undone`: `suggestions`;
- `agent.suggestion_accepted`: `source` and `edited`;
- `agent.suggestion_dismissed`: `source`;
- `townwise.ai_read`: `rulesSuggested` and `rulesSkipped`;
- `townwise.agent_suggestion`: `source` and `edited`.

No log line or audit event SHALL carry a rule's words, a schedule, a file name or an evidence date. Nothing new SHALL be sent to Anthropic: the sales source SHALL call no model, the file source SHALL send nothing beyond the read's existing request, and the weekly pass SHALL leave file and sales suggestions out of its request. The privacy page, `docs/portal/estimates.md` section 5 and P27's opt-in SHALL say that a read suggests closed days as rules that change nothing until confirmed, and that a confirmed rule stays after undo.

#### Scenario: Nothing private in logs
- **WHEN** a read suggests "Closed on Mondays" from a file named with a guest's name and a member confirms it
- **THEN** no log line or audit event holds the rule's words, the file's name or the rule's dates

#### Scenario: The weekly request
- **WHEN** a location has an open file suggestion and the weekly pass runs
- **THEN** the request to Anthropic holds no file or sales suggestion

