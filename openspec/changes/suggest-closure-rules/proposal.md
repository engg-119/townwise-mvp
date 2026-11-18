## Why

On 2026-11-17 the owner asked to "improve the data extraction agent to know when certain days are closed and create those rules automatically so the owner / manager just has to confirm them". Each suggested rule should offer "confirm, edit or dismiss".

Today a file that states "Closed Mondays", "Hours Tue to Sun" or "Closed January to March" ends up only as a free-text fact in the read's summary item. A closed season over 14 days is dropped by the read's guard. The sales history already notices a weekday with no sales, but answering its question saves a closure note over past days only, so nothing closes the next Monday. Business rules cannot say "every year".

The owner then said "dive in" (keeping the sales history as a source), "sure add seasons", and "update privacy policy etc". By the owner's rule of 2026-11-16, features the owner asks for are on by default. Spec decision D46.

## What Changes

- **The file reader states closed patterns.** The reader's answer gains `closedPatterns`: closed weekdays, the restaurant's own opening hours for the whole week, and closed seasons (`yearly` when the file says they recur). It takes only what the file states: never a meal's or bar's hours, and never days missing from a sales table. No text from the file is kept for them.
- **Each pattern becomes a suggested closure rule, not a rule.**
  - A read stores each pattern as an open suggestion in the existing `tw_agent_suggestions` store, with `source: 'file'`, the file's id and a closure key (a unique index).
  - Townwise words the rule from its schedule ("Closed on Mondays", "Closed Jan 1 to Mar 31 every year").
  - A closure event over 14 days, which the read's guard refuses, becomes a suggestion with its dates.
  - Undoing the read removes its suggestions still waiting; a confirmed rule stays.
- **Yearly seasons in business rules.** A rule's schedule may carry `season: { repeat: 'yearly', from, to }`, including seasons that cross the new year. One coverage function applies it everywhere: the forecast, the lab input, the questions, the calendar and the weekly pass. P29's form gets an "Every year" box on web and native.
- **The sales history suggests a standing closed weekday** (its own task group and sign-off). The weekday question becomes a suggested rule "Closed on Mondays". It needs 60% of at least 4 counted days with no sales, plus the last 4 with no sales. The rule starts after the last Monday with sales, so it never covers a day with recorded sales.
- **Confirm, Edit, Dismiss.**
  - A suggestion changes no forecast until confirmed.
  - Confirm saves it as a business rule.
  - Edit opens the rule form prefilled and saves the edited rule.
  - Dismiss is remembered by the closure key.
  - A confirm racing an edit answers 409 `already_decided`.
- **Who decides.** Any member, outside view-as, decides a suggested closure rule through two new `member` routes, `org.agent.rule_suggestion_accept` and `org.agent.rule_suggestion_dismiss`. The weekly suggestion routes stay org admin and unchanged.
- **Where they show.** P29 Business rules gets a "Suggested by TownwiseAI" group at the top. P25's panel shows a "Suggested rules" section first. Home's question count includes them. P27 says what a read suggested. Web and native.
- **Bounds.** At most 5 suggested rules from a read's patterns, 10 open file suggestions per location, and one sales suggestion per weekday. Pending suggestions do not count toward the 30 rules.
- **Privacy.** Nothing new goes to Anthropic: the weekly pass leaves file and sales suggestions out of its request. The privacy page, `docs/portal/estimates.md` section 5 and P27's opt-in gain the exact sentences in design decision 10.
- **No new env flag.**

## Capabilities

### New Capabilities
- `closure-rule-suggestions`: suggested closure rules from a file read and from the sales history, and yearly seasons in rule schedules. It covers how suggestions are checked, deduped, listed, confirmed, edited, dismissed, undone and audited.

### Modified Capabilities
None in `openspec/specs/`. This change composes with the unarchived `weekly-forecast-suggestions` change (a shared store, separate routes), as design decision 9 sets out.

## Impact

- API:
  - `files/extract/reader-prompt.ts`, `files/ai-reader.ts`, `files/ai-actions.ts`;
  - `handlers/data.ts`, `handlers/agent.ts`, `handlers/rules.ts`, `handlers/notes.ts` (season checks), `handlers/sales.ts`, `handlers/weekly-suggestions.ts` (404 for non-weekly rows), new `handlers/rule-suggestions.ts`;
  - `stores/files.ts`, `stores/agent-suggestions.ts`, `stores/business-rules.ts` (`season`), `stores/audit-events.ts`;
  - new `agent/closure-suggestions.ts`, `agent/questions.ts` (`noteCovers` with seasons, weekday evidence);
  - `forecasts/reasons.ts` (season words), `lab/suggestions.ts`, `access/routes.ts`, `audit.ts`.
- Client:
  - `client/src/portal/rules/` (the group, the edit, Every year), `client/src/portal/locations/NoteFields.tsx` and `noteRules.ts`, `client/src/portal/analytics/days.ts` (`noteCovers`);
  - a new shared rule suggestion card;
  - the `client/src/chat/` panel and API types;
  - `client/src/portal/home/Home.tsx`, `client/src/portal/data/item/AiSection.tsx` and `aiCopy.ts`;
  - `client/app/(marketing)/privacy.tsx`.
- Docs:
  - `docs/portal/spec.md`: the D46 row; 6.24, 6.27, 9.2, 10.12, 10.14, 10.16, 11A.9, 12, 14.5 and 17; P11, P25, P27 and P29; sections 22 and 23;
  - `api/README.md`, `docs/portal/tuning-chat.md` sections 3, 8 and 9, `docs/portal/estimates.md` section 5, `infra/README.md` (rollback).
- Data: new optional fields on `tw_agent_suggestions` and `tw_business_rules` (absent `source` reads as `weekly`, absent `season` as none) and a partial unique index. No migration.

## Owner sign-offs

1. Any member confirms, edits or dismisses a suggested closure rule; weekly suggestions stay with org admins.
2. The sales history suggests standing closed weekdays, replacing the weekday question (60% of at least 4 days, the last 4 without sales).
3. Caps: 5 suggested rules from a read's patterns, 10 open file suggestions per location, one sales suggestion per weekday. Pending ones do not count toward the 30 rules.
4. Undoing a read removes its suggested rules still waiting and keeps confirmed ones.
5. A closure over 14 days that a read may not write as a note becomes a suggestion.
6. Seasons: a yearly rule runs until deleted, Feb 29 can't start or end a season, and a season is shorter than a year.

## Owner actions

- See the final privacy wording before push.
