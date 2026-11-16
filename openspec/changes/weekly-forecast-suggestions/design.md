## Context

`autonomous-forecasts` adds a weekly tick in the API (`api/src/lab/schedule.ts`) under a Mongo lease, with one `tw_forecast_weeks` row per location and week. TownwiseAI already proposes notes in chat (`propose_note`, `api/src/chat/tools/propose-note.ts`) and lists rule-based questions about past days in P25's side panel (`api/src/agent/questions.ts`, computed at read time). Notes act on the forecast from today on at read time (spec 14.5), so an accepted note takes effect immediately. A "more guests" note without a guest count changes no forecast (14.5 rule 5).

## Goals / Non-Goals

**Goals:** suggest the notes and rules a busy owner would otherwise forget (closures on holidays, counted private events around town events); spend nothing without an organization's opt-in; never change a forecast without a person.

**Non-Goals:** an LLM computing a forecast figure; auto-applying a suggestion; owner calendars (D33, D39) as input.

## Decisions

### 1. Opt-in per organization, off by default

`tw_orgs.weeklySuggestions` (`{ on, at, by }`, absent meaning off), set by an org admin. It is off by default because it sends the owner's notes and rules to Anthropic and spends the organization's budget with nobody pressing anything, which no feature does today. Consent should be a person's act, and the privacy page must say it first.

Alternatives: on by default (an unprompted data flow and spend); per location (organizations decide budget and consent as a whole today, D27).

### 2. One call on the weekly tick

The pass runs after the tick's calibrations (`autonomous-forecasts` decision 2), at most once per location per week, recorded on the week row. It is one Claude call: the chat's model, structured output, no tools, low effort and 8,000 output tokens. It sends the next 91 days of the town's researched calendar (titles, dates, kinds, public source URLs), the location's notes and scheduled rules covering those days (as TownwiseAI already reads them in chat), and history effects for those calendar groups (percentages and day counts, as `get_forecast` sends). The call reserves $0.30 of the organization's TownwiseAI month and corrects it after. A kill switch, `TOWNWISE_WEEKLY_SUGGESTIONS`, is off by default, and the pass is off without `ANTHROPIC_API_KEY`.

Alternatives: a chat conversation per pass (needs an author, and grows the chat history); tools (more calls and cost for data that fits in one message).

### 3. Checked, stored, accepted by an org admin

At most 5 suggestions a pass. Each is checked by the note rules (spec 12) or D31's schedule rules, and dropped if it duplicates a note or rule or starts before tomorrow in the town. Suggestions are stored in `tw_agent_suggestions` and shown in P25's Questions panel and in Home's question count. An org admin accepts one (the note or rule is written with the suggestion's id, so a retried accept writes it once) or dismisses it. A suggestion expires when its first date arrives.

Alternatives: any member accepts (notes allow that, but a suggestion was not written by a person, so the lead chose admin review); auto-apply (an unreviewed closure on a busy Saturday would empty its forecast at once).

## Risks / Trade-offs

- [Notes and rules reach Anthropic unprompted] → Opt-in, and the privacy paragraph is a prerequisite.
- [Suggestions with no forecast effect ("more guests" without a count)] → The prompt says only closures, buyouts and counted private events move the forecast; the rest are dropped by the check or shown as reminders.

## Migration Plan

None: a new optional field and a new collection. Rollback: `TOWNWISE_WEEKLY_SUGGESTIONS=false`.

## Open Questions

- Should accepted suggestions be marked on the note or rule, so Notes can say they came from TownwiseAI?
