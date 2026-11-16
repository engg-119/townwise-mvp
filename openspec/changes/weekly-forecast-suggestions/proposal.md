## Why

On 2026-11-16 the owner asked for "a combination of model retraining and agentic baselines / rules to create a forecast for every day over the next 3 months", set up "so it runs autonomously". The `autonomous-forecasts` change delivers the retraining and the baseline. This change delivers the agentic rules: each week TownwiseAI reads the next 3 months of the town's calendar against the location's notes and rules, and suggests the notes and rules that would change the forecast. Each suggestion waits for a person to accept it. It was split out of `autonomous-forecasts` after review so that change can land without a new automatic flow of data to Anthropic.

## What Changes

- **Opt-in per organization, off by default.** An org admin turns weekly suggestions on or off (`PATCH /api/org/weekly-suggestions`, `tw_orgs.weeklySuggestions`), with words that say what is sent to Anthropic and that it spends the organization's TownwiseAI budget.
- **One bounded pass per location per week.** It runs on the `autonomous-forecasts` weekly tick, after that tick's calibrations, and is recorded on the location's week row. Each pass is one Claude call with no tools that sends the next 91 days of the town's researched calendar, the location's notes and scheduled rules, and its history effects for those calendar groups. It never sends a sales figure, an email or a name. It reserves $0.30 of the organization's TownwiseAI month and is skipped when less is left. A kill switch, `TOWNWISE_WEEKLY_SUGGESTIONS`, is off by default.
- **Suggestions are checked and never applied on their own.** A pass makes at most 5 suggestions. Each is a note or a rule schedule checked by the same rules as a person's, and each is stored in `tw_agent_suggestions`. They show among the questions from TownwiseAI. An org admin accepts or dismisses each one, and nothing changes the forecast until it is accepted.

## Capabilities

### New Capabilities
- `weekly-suggestions`: the opt-in, the weekly pass and its bounds, and how a suggestion is accepted, dismissed or expires.

### Modified Capabilities
None.

## Impact

- Depends on `autonomous-forecasts` (its `api/src/lab/schedule.ts` tick, lease and `tw_forecast_weeks` rows). It lands after that change's phase 3b.
- API: new `api/src/lab/suggestions.ts` and `api/src/stores/agent-suggestions.ts`; `GET .../agent` lists open suggestions; new routes (the switch, accept, dismiss); audit actions `org.weekly_suggestions_changed`, `agent.suggestion_accepted` and `agent.suggestion_dismissed`; env var `TOWNWISE_WEEKLY_SUGGESTIONS`.
- Client: P25's Questions panel (suggestions, Accept and Dismiss for org admins, the switch) and Home's question count.
- Docs: `docs/portal/spec.md` (D42's suggestions part, P25, 6.x, 10.12), `docs/portal/tuning-chat.md`, `api/README.md`, `docs/portal/estimates.md` section 5 (the privacy paragraph's suggestions sentence), and `api/production.env` (switch explicitly off).

## Owner sign-offs

1. Weekly TownwiseAI suggestions are opt-in per organization and off by default.
2. A pass reserves $0.30 of the organization's TownwiseAI month and suggests at most 5 items.

## Owner actions

- Approve the privacy paragraph's suggestions sentence before any organization opts in.
