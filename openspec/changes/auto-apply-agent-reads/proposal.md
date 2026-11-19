## Why

On 2026-11-18 the owner asked: "An agent should be able to read any source of data that a user puts into Townwise and process and use that data accordingly and update any forecasts, predictions etc." Given two choices, the owner chose:

1. **Apply, then show.** When TownwiseAI decides new data should change the forecast, it saves the change and the forecast updates right away. Every change shows in TownwiseAI's activity with one-click Undo. Anything it is not sure of still waits as a suggestion. This reverses today's rule "it never saves a note without you" (P25's How TownwiseAI works, the privacy page).
2. **Sources: everything.** Calendars (file, link, Google), stored files in Your data, sales uploads, chat messages and any other source a person adds.

Today each source has its own path and most wait for a press. A stored file goes to the model only when someone opts it in (D34). A calendar's bookings are sorted only when an org admin presses Sort and then Use for forecasts (D58, PR #110, in review). Weekly, calendar-event and closure-rule suggestions (D42, D53, D46) change nothing until someone accepts them. A note, rule or upload that changes the training days waits for Monday's refit (D42). The activity feed lists only uploads, files read, saved proposals and answers, and has no Undo.

By the owner's rule of 2026-11-16, features the owner asks for ship on by default. Spec decision **D59** (D58 is the highest, on `feat/learn-from-calendar-bookings`; check develop's spec and the reservation list again before writing it).

## What Changes

- **One switch, on by default.** A new organization switch, "TownwiseAI works on its own" (`agentAuto`, absent reads on), turned off or on by an org admin. Staff open as admin may only turn it off. A deploy switch `TOWNWISE_AGENT_AUTO` (default true). While it is off, everything behaves as today.
- **One ledger of TownwiseAI's changes.** A new collection `tw_agent_changes` records each change TownwiseAI saved on its own: the source, a typed action, the target's id, a dedupe key that is unique per location, the confidence, a short why, and the status (`applying`, `applied`, `undone`). Writes are ordered and use compare-and-set, as everywhere else on DocumentDB.
- **Typed actions that only add.** TownwiseAI may add a note, add a closure or hours business rule (slice 3), label an unlabeled calendar event (slice 2), add sales days the location does not have (D34's existing checks), or keep a summary item. It never changes or deletes anything that exists. Those changes, and anything below the confidence bar or in conflict with a person's note or rule, become suggestions, as today.
- **Owner beats agent.** A note a person made that decides a day sets aside a TownwiseAI note on that day, in the forecast read and in the lab input. A change someone undid, deleted or dismissed is never made again.
- **Undo per change.** The activity feed shows each change with Undo. A full log is one page further. Undo removes exactly what was added, by compare-and-set on the target's `updatedAt`. Once a person edits the target it is theirs, and Undo is no longer offered. D34's per-file undo stays and marks that file's ledger rows undone.
- **Forecasts update.** Notes and rules already change the forecast on read (`forecasts/adjust.ts`). For changes to training days (history notes, labels, sales days, closure rules, a person's edits too), the location is marked as wanting a refit. The hourly worker pass refits it as the system once the location has had no new change for 15 minutes, at most once a day, inside the live cap of 3 and the weekly cap. It skips the refit when the lab input's fingerprint has not changed. The lab's gate still decides what is published.
- **Triggers per source** (design decision 1): a stored file is read when it is stored; a file calendar is sorted when it is imported; a calendar refresh with new events ahead brings that location's weekly pass forward; a sales upload and a person's note or rule edits run only deterministic steps (no model call) and mark a refit; a chat message the person sends can save a note they stated plainly (slice 4).
- **Bounds.** Automatic file reads use the files month (`TOWNWISE_FILES_MONTHLY_BUDGET_USD`) only while more than $1 is left, so a press still works, at most 20 a day per organization, and one at a time per organization. A file with the same fingerprint as one already read is skipped `duplicate` before any call. Calendar sorts and weekly calls stay on the TownwiseAI month.
- **Privacy and consent.** The privacy page's "Files you let TownwiseAI read" and Anthropic items, P25's How TownwiseAI works, and the Add a file opt-in box are reworded. The box becomes checked by default while the switch is on, so a person can still keep one file from TownwiseAI. A file the sales reader already read into days (a point-of-sale export) is never sent automatically. All wording is marked [CONFIRM].

## Phasing

- **Slice 1 (needs no D58):** the switch, the ledger, activity with Undo and the log, owner-beats-agent, automatic reads of stored files with the confidence bar, refits after training changes, and the privacy wording.
- **Slice 2 (after PR #110 merges):** D58's sort runs on import, and labels it is sure of are confirmed on their own, with Undo per calendar.
- **Slice 3:** weekly, calendar-event and closure-rule suggestions it is sure of are applied. A calendar refresh brings the weekly pass forward, at most once a day.
- **Slice 4:** chat saves a note the person stated plainly, with Undo on the card. This changes the frozen prefix, so it ships with the other prefix changes.

## Capabilities

### New Capabilities
- `agent-ingestion`: what starts a TownwiseAI read for each source, the runner, the per-read and per-organization bounds, dedupe, and ordering without transactions.
- `agent-applied-changes`: the typed actions, the confidence bar, what always waits, owner-beats-agent, the ledger, Undo and how changes show.
- `agent-forecast-refresh`: refits after training changes, debounced and capped.
- `agent-auto-consent`: the organization and deploy switches, their defaults, the opt-in box, and the privacy and in-app wording.

### Modified Capabilities
None in `openspec/specs/`, which holds only `order-setup-read` and `top-bar-groups`. This change extends unarchived changes (`read-files-with-townwise-ai`, `learn-from-calendar-bookings`, `weekly-forecast-suggestions`, `calendar-event-suggestions`, `suggest-closure-rules`, `autonomous-forecasts`). As D58 does, its requirements are written as new ones so they validate on their own, and they fold in when those changes are archived.

## Impact

- Spec: D59, a new 6.31 `tw_agent_changes`, 10.12 (activity, log, Undo routes, switch), 11A.9 (automatic reads, confidence bar), 12 and 14.5 (owner beats agent), 14.6 (refit wanted), 17 (privacy), CONFIRM items numbered after D58's last (142), the changelog. `api/README.md`, `docs/portal/tuning-chat.md` sections 8 and 9.
- API: new `api/src/stores/agent-changes.ts` and `api/src/agent/apply.ts` (the one writer every source calls), `api/src/agent/activity.ts` (new source), `api/src/files/ai-actions.ts` and `files/extract/reader-prompt.ts` (per-event confidence, writes go through `apply.ts`), the file store's queueing at store time, `api/src/lab/schedule.ts` and `api/src/stores/locations.ts` (`refit` wanted and started), `api/src/forecasts/adjust.ts` and `api/src/lab/input.ts` (owner beats agent), `api/src/stores/orgs.ts` (`agentAuto`), `api/src/config.ts` (`TOWNWISE_AGENT_AUTO`), `api/src/access/routes.ts` (3 routes: the undo, the log and the switch), audit actions.
- Client: `client/src/chat/ui/AgentSidePanel.tsx` (activity with Undo, the switch, How TownwiseAI works), a log page under the TownwiseAI route group (`src/portal/routing.ts` `isAllowed`), `client/src/portal/data/AddFile.tsx` and `aiCopy.ts`, `client/app/(marketing)/privacy.tsx`.
- No lab code change, no input schema change and no model version bump in slices 1 to 3.
