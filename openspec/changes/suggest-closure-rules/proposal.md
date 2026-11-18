## Why

On 2026-11-17 the owner asked to "improve the data extraction agent to know when certain days are closed and create those rules automatically so the owner / manager just has to confirm them", with each suggested rule offering "confirm, edit or dismiss". Today a file that states "Closed Mondays", "Hours Tue to Sun" or "Closed January to March" ends up only as a free-text fact in the read's summary item, and a seasonal closure over 14 days is dropped by the read's guard. The sales history already notices a weekday with no sales, but answering its question saves a closure note over past days only, so nothing closes the next Monday. By the owner's rule of 2026-11-16 (features the owner asks for are on by default), this is on by default. Spec decision D46.

## What Changes

- **The file reader states closed patterns.** The reader's answer gains `closedPatterns`: weekdays the restaurant is closed and closed date ranges, only when the file states them (a "Closed Mondays" line, posted hours for the whole week, a dated season). Never inferred from missing days in a sales table. No text from the file is kept for them.
- **Each pattern becomes a suggested closure rule, not a rule.** A read stores each one as an open suggestion in the existing `tw_agent_suggestions` store, with a new `source` (`file`) and the file's id. Townwise words the rule from its schedule ("Closed on Mondays"). A closure event the read's guard refuses (over 14 days, or past 31 closed days a read) becomes a suggestion with its dates instead of being dropped. Undoing the read removes its suggestions that are still open; a confirmed rule stays.
- **The weekday question becomes a suggested rule.** When the sales history shows a weekday with no sales (the question's 60%, at least 4 days), the panel offers "Closed on Mondays" as a suggested standing rule (`source` `sales`) instead of asking "Closed on Mondays?". Confirm saves one rule that covers the past days and closes every Monday from today on, so the owner is asked once.
- **Confirm, Edit, Dismiss.** A suggestion changes no forecast until confirmed. Confirm saves it as a business rule. Edit opens the rule form prefilled, and saving it saves the edited rule and marks the suggestion accepted. Dismiss is remembered by the rule's closure key, so the same rule is not suggested again.
- **Who decides.** Any member, outside view-as (staff open as admin included), confirms, edits or dismisses a suggested closure rule, as any member can add the same rule on P29 today. Weekly suggestions stay with org admins.
- **Where they show.** P29 Business rules gets a "Suggested by TownwiseAI" group at the top. P25's panel shows them in a "Suggested rules" section first. Home's question count includes them. Web and native.
- **Bounds.** At most 5 suggested rules a file read and 10 open file suggestions per location; the sales source makes at most one per weekday. Pending suggestions do not count toward the 30-rule cap.
- **No new env flag.** The file source runs wherever the reader runs; the sales source calls no model.

## Capabilities

### New Capabilities
- `closure-rule-suggestions`: suggested closure rules from a file read and from the sales history, how they are checked, deduped, listed, confirmed, edited, dismissed, undone and audited.

### Modified Capabilities
None in `openspec/specs/`. This change composes with the unarchived `weekly-forecast-suggestions` change (shared store and routes), as design.md decision 9 sets out.

## Impact

- API: `files/extract/reader-prompt.ts` (prompt and schema), `files/ai-actions.ts` (suggestions in the actions, planned ids), `handlers/data.ts` (undo), `stores/files.ts` (answer and outcome fields), `stores/agent-suggestions.ts` (`source`, `fileId`, `salesKey`, `evidence`, closure key), new `agent/closure-suggestions.ts`, `agent/questions.ts` (weekday evidence, no weekday question), `handlers/agent.ts`, `handlers/weekly-suggestions.ts` (accept with an edit, member policy for these sources), `handlers/rules.ts` (GET lists them), `handlers/sales.ts` (deleting sales data deletes sales-source decisions), `lab/suggestions.ts` (closure-key dedupe), `access/routes.ts`, `stores/audit-events.ts`, `audit.ts`.
- Client: `client/src/portal/rules/` (the suggested group and its edit), a shared rule suggestion card, `client/src/chat/` panel and API types, `client/src/portal/home/Home.tsx`, `client/src/portal/data/item/AiSection.tsx`.
- Docs: `docs/portal/spec.md` (D46 row; 6.27, 9.2, 10.12, 10.14, 10.16, 11A.9, 17, P11, P25, P27, P29, 22, 23), `api/README.md`, `docs/portal/tuning-chat.md` sections 8 and 9, `docs/portal/estimates.md` section 5 and `client/app/(marketing)/privacy.tsx` (one clause, for the owner).
- Data: new optional fields on `tw_agent_suggestions` (absent `source` reads as `weekly`) and a partial unique index. No migration.

## Owner sign-offs

1. Any member confirms, edits or dismisses a suggested closure rule; weekly suggestions stay with org admins.
2. The weekday question is replaced by the suggested rule.
3. Caps: 5 suggested rules a read, 10 open file suggestions per location, one sales suggestion per weekday; pending ones do not count toward the 30 rules.
4. Undoing a read removes its open suggestions and keeps rules already confirmed.
5. A closure event the read's guard refuses becomes a suggestion.

## Owner actions

- Approve the new clause in the privacy page's "Files you let TownwiseAI read" paragraph (design.md decision 10) before push.
- Push only after the owner's go.
