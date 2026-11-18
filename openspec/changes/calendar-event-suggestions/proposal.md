## Why

On 2026-11-17 the owner asked: "have an agent to add in events around specific days right? e.g., if we know there is a private event and we need to account for moving that private event or cancelling it and whether not that event is exclusive for the whole restaurant or not". The owner approved this plan after being told its privacy cost: owner-calendar event titles would reach Anthropic once a week without anyone pressing anything.

Today a private event on the owner's own calendar (D33, D39) changes the forecast only through a note someone makes by hand (Make a note, or TownwiseAI's `propose_note` in chat). Once made, that note keeps no tie to its event: when the party moves to another Saturday or is canceled, the calendar refreshes and the note stays where it was, so the forecast keeps a booked or busier day that no longer exists, and nobody is told. TownwiseAI's weekly suggestions (D42's build note, `weekly-forecast-suggestions`) read the town calendar but only counts from the owner's calendars, so they cannot spot a private party at all. A private event is also one of two different things to the forecast: the whole restaurant (a buyout, which books the day) or alongside regular service (more guests, which adds its party), and only a person can say which.

## What Changes

- **A note remembers the calendar event it came from.** A note made with Make a note on the Calendar, or by accepting a TownwiseAI suggestion spotted from an owner-calendar event, stores `fromEvent`: the calendar's id, the event's stable key (the ICS UID, or Google's event id) and the event's dates and hours at link time. Only events whose key survives a refresh are linked. No migration: notes without the field read as unlinked.
- **Moves and cancellations become suggestions, with no model call.** After every calendar refresh, Refresh now and calendar add, Townwise compares each linked note's event with what the calendar now holds. A moved event gets an open suggestion to move the note to the event's new dates (only while the note is still on its event's dates); a canceled or vanished one gets an open suggestion to delete the note. Both accepts compare-and-set on the note's `updatedAt`, so a person's edit is never overwritten. They show in TownwiseAI's panel only. Nothing changes until an org admin accepts. These are new kinds in the existing `tw_agent_suggestions` store, with their own accept paths.
- **TownwiseAI spots private events on the owner's calendars.** The weekly suggestions call also sends the owner calendars' events in its 91-day window, titles included (never a calendar's name, an event's UID or a calendar id), with emails and phone numbers removed from titles, so it can propose a private-event note linked to its event. Spotted events have their own cap of 5 a pass, and any suggestion that echoes a distinctive word of a sent title is dropped, so no title is ever stored. The card asks the org admin to choose "The whole restaurant (a buyout)" or "Alongside regular service", with the guest count prefilled when the title states it, editable before accepting.
- **On by default, with an org admin's off switch for titles.** A new organization field (`tw_orgs.calendarTitlesToAi`, absent meaning on) and route (`PATCH /api/org/weekly-suggestions/calendar-titles`) turn the sending of titles off or on. Titles go only into that weekly call, are never logged or audited, and staff (view-as and open as admin) still see a Google calendar's events only as "Google calendar event" (D39), on the cards too.
- **Privacy words change before this runs in production.** The privacy page (its Your calendars, Google calendars, weekly suggestions and Anthropic items, and the Limited Use statement), the Google connect explainer, `docs/portal/estimates.md` section 5, `docs/portal/tuning-chat.md` section 9 and spec 17 say that titles of owner-calendar events reach Anthropic weekly unless an org admin turns it off.

## Capabilities

### New Capabilities
- `calendar-note-links`: a note's link to the owner-calendar event it came from, the deterministic move and delete follow-ups after a refresh, and how an org admin accepts or dismisses them.
- `private-event-spotting`: the weekly call's owner-calendar events with titles, the private-event suggestion and its buyout-or-alongside choice, the org admin's titles switch, and what staff see.

### Modified Capabilities
None in `openspec/specs/`. This change extends the `weekly-suggestions` capability of the unarchived `weekly-forecast-suggestions` change; its requirements here are written as new ones so they validate on their own, and they fold into `weekly-suggestions` when both are archived.

## Impact

- Depends on `weekly-forecast-suggestions` (merged into develop with `autonomous-forecasts`): `api/src/lab/suggestions.ts`, `api/src/stores/agent-suggestions.ts`, `api/src/handlers/weekly-suggestions.ts`, P25's suggestion cards. Spec decision **D53**; CONFIRM index items 112 to 125 (numbered after develop's last, 111 when develop was merged in on 2026-11-18; renumbered again before push).
- API: `api/src/stores/notes.ts` (`fromEvent`), `api/src/stores/owner-calendars.ts` (`keyed` on event rows, `findEvent`, `eventsByUid`), `api/src/calendar/ics.ts` and `google-events.ts` (`keyed`), new `api/src/calendar/follow-up.ts`, `api/src/calendar/refresher.ts` and `api/src/handlers/owner-calendars.ts` (the follow-up where `replaceEvents` switches events in), `api/src/handlers/notes.ts` (Make a note's link), `api/src/stores/cross-tenant.ts` (a deleted person's `by`), `api/src/stores/agent-suggestions.ts` (types `event`, `move`, `remove`), `api/src/lab/suggestions.ts` (request, prompt, answer schema, checks), `api/src/handlers/weekly-suggestions.ts` (accept bodies and paths, the titles switch, staff wording), `api/src/stores/orgs.ts`, `api/src/access/routes.ts` (one new route), audit action `org.calendar_titles_ai_changed`.
- Client: the Calendar's Make a note and a linked note's line (P28), P25's suggestion cards and the titles switch, the Google connect explainer, the privacy page.
- Docs: `docs/portal/spec.md` (D53, 6.1, 6.7, 6.27, 9.2, 10.5, 10.12, 10.18, 12, 17, P11, P25, P28, CONFIRM index, changelog), `docs/portal/tuning-chat.md` section 9, `api/README.md`, `client/MODULE.md` (Local changes), `docs/portal/estimates.md` section 5.
- No new collection, index on notes or env var. One new partial unique index on `tw_agent_suggestions`.
- Not touched: TownwiseAI chat's frozen prefix (system prompt and tools are unchanged; `propose_note` keeps no link).

## Coordination

D46 (`feat/suggested-closure-rules`, which also edits `api/src/stores/agent-suggestions.ts`) and D49 (`feat/calendar-everything`, which gives notes a `title` Make a note may prefill) are in flight. This change adds no title to notes, rebases onto develop before its PR and adapts to whichever has merged (design.md, Coordination).

## Owner sign-offs

1. Owner-calendar event titles are sent to Anthropic in the weekly suggestions call by default, and an org admin can turn that off (owner, 2026-11-17, after the privacy cost was explained; the default stays marked `[CONFIRM]`).
2. Decided by the owner on 2026-11-17, each still marked `[CONFIRM]`: Google calendars connected before the new explainer stay title-free until their person connects again (built as a stored notice: a calendar or connection sends titles only when its add or connect came from a screen that said so); staff open as admin can turn titles off, not on; chat's `propose_note` stays unlinked (no frozen-prefix change); spotted events get their own cap of 5; follow-ups show in TownwiseAI's panel only.
3. The privacy page's new words, before this runs in production.
