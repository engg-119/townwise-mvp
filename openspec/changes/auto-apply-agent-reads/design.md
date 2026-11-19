## Context

What exists (develop at dc9d3d50, and `feat/learn-from-calendar-bookings` at ac123da1 for D58), read for this design:

- **Read with TownwiseAI** (D34, spec 11A.9; `api/src/files/ai-reader.ts`, `api/src/files/ai-actions.ts`, `api/src/handlers/data.ts` `requestAiRead`, `undoAiRead`). A loop in each API replica claims the oldest queued read under a 90-second lease. It holds one read per organization at a time and at most 10 queued. It reserves the call's ceiling from `tw_files_usage` (`TOWNWISE_FILES_MONTHLY_BUDGET_USD`, $5), makes one call, checks the answer, and hands it to `onRead`. The actions save a plan of ids on the read first, then write each note, the upload and the summary item under those ids, so a retry writes each once. Notes carry `source: { via: 'ai_file', fileId }`. When an org admin asked, a calibration starts as them (charged, one of the 4 a day). `DELETE .../data/:ref/ai` undoes the whole read, edited notes included. The answer has one `confidence` for the whole read, none per event. Sales days need `high` confidence and 95% of them borne out by the file's text. A closed note is at most 14 days and 31 closed days a read. Longer closures and stated closed patterns become D46 rule suggestions.
- **Files are opted in per file.** The Add a file box ("Let TownwiseAI read these files and use what it finds", `client/src/portal/data/aiCopy.ts`) is off by default. The privacy page says "Townwise never sends a file you add to an AI model unless you ask". Files have a fingerprint (`stores/files.ts` `duplicateOf`).
- **D58** (PR #110, not merged). File calendars (CSV or `.ics`) get per-event booking labels from an org admin's Sort press (`calendar/booking-sort.ts`, the TownwiseAI month, 3 a calendar an hour). They change nothing until Use for forecasts (`confirmBookings`, compare-and-set). Confirm writes linked notes for upcoming buyouts and parties and starts a calibration. Confirmed labels reach `labInputOf` on history days through `bookingsBetween`.
- **Suggestions** (`stores/agent-suggestions.ts`, `tw_agent_suggestions`). The weekly pass (`lab/suggestions.ts`, D42/D53) makes one call per location a week, reserving $0.30 of the TownwiseAI month. It suggests at most 5 notes or rules, plus spotted calendar events and follow-ups when an event moves. D46 suggests closure rules from a file or the sales history. Each waits for a person. Two org switches exist: `weeklySuggestions` and `calendarTitlesToAi`, both absent-reads-on.
- **Chat** (`api/src/chat/`). `propose_note` and `propose_data_item` show cards and never write. The TownwiseAI month is `TOWNWISE_CHAT_MONTHLY_BUDGET_USD` ($20). The tool definitions are part of the frozen prefix.
- **Forecast reads** (`forecasts/adjust.ts`). Notes and rules change a published day on every read, so a new or deleted note shows at once. A covering note already beats a rule's closure or buyout (`notesDecide`).
- **Refits** (`lab/schedule.ts`). The worker job runs hourly (`5 * * * *`). From Monday 03:00 in the town it fingerprints each location's lab input and refits as the system (free, not one of the 4 a day) when the fingerprint changed. Live cap 3, weekly cap `TOWNWISE_WEEKLY_FORECAST_CAP` (200). The gate (`lab/gate.ts`) decides publication.
- **Activity** (`agent/activity.ts`). Uploads applied, files read, notes saved from the caller's own proposals and answers, at most 20, newest first, with no Undo.
- **Sales uploads** are parsed in the browser into three fields a day. There is nothing in them for a model to read for meaning, and sending them would send figures.
- **Consent.** Sawtooth's owner gave "any product use" consent on 2026-11-15 (relayed by the owner). The privacy rules still hold: no customer or group names in logs or outputs.

## Goals / Non-Goals

**Goals:** every source a person adds is processed without a press while the organization's switch is on. What TownwiseAI is sure of is saved and changes the forecast at once. Each change shows with Undo. Training changes refit within about an hour. Cost per read and per organization is bounded, a repeated source costs nothing, and a person's own data always wins.

**Non-Goals:** TownwiseAI changing or deleting anything that exists; sending sales figures or a sales export to a model on its own; reading a calendar's descriptions; Orders and Ordering setup (they are not forecast inputs); a configurable confidence threshold; a new budget env var; a lab code change, input schema change or model version bump.

## Decisions

### 1. What starts work, per source

| Source | Starts when | Work | Model call |
|---|---|---|---|
| Stored file in Your data (PDF, sheet, Word, picture, ZIP, text) | The file reader finishes it (`read`, `kept` or `failed` but with an original), and it was not read into sales days, is not `calendar_export`, and its box was left checked | D34's read, queued `auto` | Yes, files month |
| File calendar (CSV or `.ics`), slice 2 | It is imported | D58's sort, then decision 7's confirm | Yes, TownwiseAI month |
| Link or Google calendar, slice 3 | A refresh adds or moves a keyed event in the next 91 days | The location's weekly pass is brought forward, at most once a day | Yes, TownwiseAI month |
| Weekly pass and D46 sales suggestions, slice 3 | As today | Suggestions it is sure of are applied (decision 7) | As today |
| Sales upload | It is applied | Refit wanted (decision 11). D46's sales check runs as today | No |
| A person's note or rule change | Saved | Refit wanted, when it touches a history day | No |
| Chat message, slice 4 | The person sends it | `propose_note` may save a note the person stated plainly | Inside the turn |
| Pasted text item | Added | Read as a text file | Yes, files month (later slice, decision 15) |

A file the sales reader read into days is never sent on its own: it is a point-of-sale export whose meaning is already in Townwise as numbers, and it can hold diner names and card details. A person can still press Read with TownwiseAI on it. [CONFIRM: a file read into sales days is not sent to TownwiseAI automatically]

Alternatives: reading every file, sales exports included (more PII sent for little gain); a nightly batch over everything new (slower, and it still needs per-source rules); a model call on sales uploads (figures sent for nothing a model adds).

### 2. Deterministic code where exactness matters, the model for meaning

Code does the parsing, dates, figures and checks: the sales reader, D58's CSV and `.ics` parsers, D34's day verification, the note and rule validators, the closure guards, dedupe and conflict checks. The model only names what a text means: an event's kind and effect, a booking label, a closed pattern. Every model answer is checked again in code before anything is written, as today.

### 3. One runner, the D34 reader, extended

Automatic file reads use D34's queue and reader unchanged, with a new flag `ai.auto: true` on the read and the system as requester (decision 13). In slice 2 the same loop also claims queued calendar sorts. A file calendar's source gets `bookings.sortQueuedAt`, and the claim uses the same lease, the same one-job-per-organization rule and the same retry waits. The weekly pass stays in the worker.

Alternatives: a new generic `tw_agent_jobs` queue (a second queue beside D34's for the same loop); running the sort inside the import request (up to 150 seconds on an add).

### 4. Bounds

- **Per read:** D34's limits stand (one call, the ceiling reserved first, 64,000 output tokens, 300 seconds, 50 events, 31 closed days). D58's sort stands (8 batches, 150 seconds).
- **Per organization, files month:** an automatic read starts only while more than $1 of the month is left after its ceiling, so a press can still run. [CONFIRM: automatic reads leave $1 of the files month for presses] At most 20 automatic reads a day per organization, counted on the read records. [CONFIRM: 20 automatic file reads a day per organization] A read held back stays `skipped` with `budget_spent` or `daily_auto_limit`, and its page offers the press.
- **Per organization, TownwiseAI month:** an automatic sort reserves as D58 does. A brought-forward weekly pass runs at most once a day per location and reserves $0.30 as today. [CONFIRM: a calendar change brings the weekly pass forward at most once a day]
- **A burst:** a ZIP or 40 files at once queue 40 reads, which run one at a time per organization. The daily cap stops the rest, and the activity says how many waited.

Alternatives: a separate `TOWNWISE_AGENT_MONTHLY_BUDGET_USD` (one more knob; the owner prefers defaults); no reserve for presses (a burst would lock the person out of their own press).

### 5. Dedupe and idempotence

- **Same source twice:** a file whose fingerprint matches a file of the location that was already read is skipped `duplicate` before any call or charge. A re-imported calendar's sort sends only unlabeled events, as D58 does.
- **Same fact from two sources:** each change has a `dedupeKey`, a hash of the action and its content normalized: a note's kind, dates, weekdays, effect and folded title; a rule's schedule; a label's calendar and uid. `tw_agent_changes` holds a unique index on `{ orgId, locationId, dedupeKey }` in every status, so the same note from a PDF and a photo is written once. An undone change keeps its key, so it is never made again.
- **Retries:** D34's plan of ids is saved first. Every write uses its planned id, and a second create fails on the primary key and counts as done.

### 6. Typed actions

| Action | Target | Fields it may set | Who can Undo |
|---|---|---|---|
| `note.add` | `tw_notes` | Every note field through `readNoteContent`, plus `agent: { changeId, at }` | Any member (as deleting a note) |
| `rule.add` (slice 3) | `tw_business_rules` | A closure or hours schedule through D31's rules, plus `agent` | Any member |
| `booking.label` (slice 2) | an owner-calendar event row | `booking`, `bookingBy: 'ai'`, `bookingAt` on an unlabeled event | Org admin (as D58) |
| `sales_days.add` | an upload and its days | Only days the location lacks, D34's checks | Org admin (as an upload delete) |
| `item.add` | a summary text item | D34's summary item | The file's adder or an org admin |

Any other change is out of reach: TownwiseAI never sets a field on a record it did not add in that change. A note or rule it adds is marked `agent: { changeId, at }`. Notes D34 wrote before this change, which have `source` and no `agent`, also count as TownwiseAI's. [CONFIRM: TownwiseAI adds notes, closure or hours rules, booking labels, missing sales days and summary items, and changes nothing else]

### 7. The confidence bar

A candidate is applied only when all of these hold. Otherwise it becomes a suggestion in `tw_agent_suggestions`, or is dropped as today.

- The model said `high` for it. D34's reader schema gains a per-event `confidence` (the reader's own prompt, not the chat prefix), and an event is `high` only when it and the whole read are. D58's `unsure` stays unlabeled. D53's weekly answer gains a per-suggestion `confidence` in slice 3.
- It passes the code checks for its type: the note or rule validators, the 14-day and 31-day closure guards, and D34's 95% verification for days.
- It conflicts with no note or rule a person made on those days. A conflict is a covering person's note that decides the day differently, or a person's rule with a different closure on those days.
- Its dedupe key was never used at this location.
- It is a `rule.add` and fewer than 2 rules were applied at this location this week (slice 3). [CONFIRM: at most 2 rules applied a week per location]

A file event below the bar becomes an open note suggestion (`source: 'file'`, `type: 'note'`), which any member decides through D46's routes, as file rule suggestions are decided today.

The bar is fixed in code, not a setting. An org admin's choice is the switch (decision 13). [CONFIRM: TownwiseAI applies only what the model rated high and the code checks pass; everything else waits]

Alternatives: a per-organization threshold slider (configurability nobody asked for); a numeric score (models rate high, medium and low more reliably than numbers, and D34 already uses those three).

### 8. What always waits for a person

- Changing or deleting anything that exists, including D53's move and remove follow-ups and a calendar event's label that a person set.
- Replacing or deleting a sales day. Days from a picture, days below 95% borne out, and days from a read that is not `high`.
- A closure longer than 14 days or past 31 closed days a read (D46's suggested rule, as today).
- Anything that conflicts with a person's note or rule, and anything a person dismissed, undid or deleted before.
- Business rules until slice 3, and in slice 3 a third rule in one week.
- Orders, Ordering setup, the team, settings, calendars themselves and budgets: no action exists for them.

### 9. Owner beats agent

- **At apply time:** decision 7's conflict check.
- **Afterwards:** when a person later saves a note that decides a day (`notesDecide`) that a TownwiseAI note also covers, the TownwiseAI note is set aside on that day (outcome `overridden`), in `forecasts/adjust.ts` and in `lab/input.ts` `labInputOf`. This mirrors the existing rule that a covering note beats a rule's closure. A person's note is one without `agent` and without `source`. Both stay pure functions. The lab golden is unchanged, since its fixture has no TownwiseAI notes. [CONFIRM: a note a person made beats a TownwiseAI note on the same day]
- **Edits:** once a person edits a TownwiseAI note, rule or label, it is theirs. The ledger row reads `adopted` (decision 10), Undo is no longer offered, and the override above no longer applies to it, because a note's `agent` holds `{ changeId, at }`, `at` being its `updatedAt` when applied, and a note whose `updatedAt` is later than `agent.at` counts as a person's. The forecast read needs no ledger read for this.

Alternatives: newest wins (a weekly pass could then overrule a person's note); agent notes never count in the lab (throws away true history from files).

### 10. Undo

- `POST /api/org/locations/:locationId/agent/changes/:changeId/undo` (`org.agent.change_undo`, `member` with the action's own role check from decision 6, not under view-as, staff open as admin allowed).
- It works by compare-and-set: the ledger row goes `applied` to `undoing`. Then the target is removed only while its `updatedAt` equals `targetUpdatedAt` (a label is cleared only while it is still `bookingBy: 'ai'` at that `bookingAt`; sales days through the upload removal D34's undo uses). Then the row goes `undoing` to `undone`, and `agent.change_undone` is recorded.
- **Edited since:** the target's compare-and-set fails, so the row is set `adopted` and the answer is 409 `changed_since` ("You changed this since, so it's yours now. Delete it from {page} if you don't want it."). **Deleted since:** the row becomes `undone` and the answer is 200.
- A retry of any step finishes it. An undo of a training change wants a refit (decision 11).
- D34's per-file undo stays. It now also marks that file's ledger rows `undone`. D58's Undo per calendar (slice 2) clears the labels the sort applied the same way.
- A calibration already started is never undone (as D34).

[CONFIRM: Undo removes only what TownwiseAI added, only while nobody changed it since]

### 11. How it shows

- **Activity** (`agent/activity.ts`): a new source, `agent_change { at, changeId, action, sourceKind, status, startDate, endDate, noteKind?, undoable }`, with no title, file name, figure or why. The why is in the log. The client words each one ("Added a note: Private event, Sat, Jun 13, from a file you added." and Undo). An unknown kind renders as nothing, as today. The existing `file_processed` item stays.
- **Log:** `GET /api/org/locations/:locationId/agent/changes?before=` (`org.agent.changes`, `member`, 50 a page, newest first) holds every change with its why and status. It is a new client page `/locations/{id}/agent/changes`, added to `isAllowed`.
- **Waiting:** suggestions show where they show today. A new panel line says "{n} things TownwiseAI wasn't sure of are waiting for you".
- **Audit:** `agent.change_applied { locationId, action, sourceKind }` and `agent.change_undone { locationId, action, sourceKind }`. **Logs:** `townwise.agent_applied { locationId, applied, suggested, skipped }` counts. Never a title, why, figure, file name or uid.

### 12. Forecast updates

- **Read-time:** every applied note or rule changes the published forecast on the next read (`adjust.ts`). This is unchanged and needs no refit.
- **Refit wanted:** each change that can move the lab input sets `refit.wantedAt` on the location (`tw_locations`) with `$max`. That covers an applied or undone history note, label or sales day, a closure rule, a sales upload, and a person's note or rule touching a day on or before `dataThrough`.
- **The pass:** the hourly worker pass (`lab/schedule.ts`) also takes, any day of the week, a location whose `refit.wantedAt` is at least 15 minutes old, has no live calibration, and whose `refit.startedAt` is more than 24 hours ago or absent. It fingerprints the location as the Monday path does. Unchanged: the flag is cleared and no refit runs. Changed: it starts as the system (free, not one of the 4 a day), inside the live cap of 3 and counted in the weekly cap. A start sets `refit.startedAt`. The flag is cleared by compare-and-set on the `refit.wantedAt` it read, so a change that lands during the pass is kept. [CONFIRM: a training change refits as the system after 15 quiet minutes, at most once a day per location]
- The gate (`lab/gate.ts`) and the organization's forecasts switch (G1) still decide publication.
- Presses keep their own start: D34's org-admin calibration and D58's confirm are unchanged. An automatic read starts no calibration of its own; it only wants a refit.

Alternatives: a calibration per change (hits the 4 a day and charges $0.10 each); waiting for Monday (the owner asked for right away); a refit on every upload in the request (a burst starts many).

### 13. Switches, defaults and who acts

- **`agentAuto`** on `tw_orgs` (`{ on, at, by }`, absent reads on), via `PATCH /api/org/agent-auto` (`org.agent_auto.switch`, `org_admin`). Staff open as admin may only turn it off, as with `calendarTitlesToAi`. The deploy switch `TOWNWISE_AGENT_AUTO` defaults to true, and both must be on. [CONFIRM: TownwiseAI works on its own by default]
- **While on:** automatic triggers run and decision 7 applies. This includes reads a person pressed, which now also leave medium and low events as suggestions. [CONFIRM: a read someone asked for follows the same confidence bar]
- **While off:** no automatic trigger runs, presses behave exactly as today (D34 writes all events, D58 waits for confirm), suggestions wait, and refits wanted still run, since they send nothing anywhere.
- **Calendar titles:** an automatic sort or a brought-forward pass sends titles only while `calendarTitlesToAi` is also on.
- **Actor:** an automatic change is made by TownwiseAI: `createdBy: 'townwise_ai'` on notes and rules (shown as "TownwiseAI"), and the audit actor `{ actorUserId: 'townwise_ai', actorRole: 'system' }`. The file's or calendar's adder is recorded on the ledger row as `onBehalfOf` and is checked as D34's step 0 checks: an adder who has left means nothing is applied, and the candidates become suggestions.
- **Per file:** the Add a file box reads "Let TownwiseAI read these files and use what it finds" and is checked by default while the switch is on. Unchecking it keeps those files from automatic reads.

### 14. Privacy and consent

- **What newly goes to Anthropic:** stored files other than sales exports, on store (as on a D34 press); a file calendar's titles, dates and hours, on import (as on a D58 press); and the weekly request more often after a calendar change. Never a sales figure on its own, a description, or a file kept from TownwiseAI. Anthropic does not train on API data.
- **Privacy page** (`client/app/(marketing)/privacy.tsx`): rewrite "Files you let TownwiseAI read" to say that unless an org admin turns it off, TownwiseAI reads each file added to Your data, except a sales export Townwise read into days and any file whose box was unchecked. Add a "Changes TownwiseAI makes" item: what it may add, that each shows with Undo, that it never changes or deletes what exists, and the log. Reword the Anthropic item's "nothing is sent to Anthropic unless you use it" sentence. Reword the Sorting bookings item for the sort on import (slice 2). [CONFIRM: privacy wording for TownwiseAI working on its own]
- **In the app:** P25's How TownwiseAI works replaces "it never saves a note without you" with "It saves what it's sure of and shows each change here with Undo. Anything it isn't sure of waits for you." The switch's words sit beside the weekly suggestions switch. [CONFIRM: the panel's and switch's words]
- **Sawtooth:** the 2026-11-15 consent covers product use. Event invoices and booking PDFs can name customers, so the owner tells Sawtooth's owner before the switch is on in production, as for open as admin after join. [CONFIRM: Sawtooth's 2026-11-15 consent covers automatic reads, and its owner is told first]

### 15. Phasing

- **Slice 1** (no D58 dependency): decisions 1 (files, sales uploads, person edits), 2 to 6, 7 (files), 8 to 14. This is the foundation every later slice writes through: one writer, `agent/apply.ts`, and one ledger.
- **Slice 2** (after PR #110 merges): calendar sorts claimed by the runner on import, `high` labels confirmed by the system (D58's `confirmBookings` with `confirmedBy: 'townwise_ai'`) through `booking.label` changes, D58's linked notes as `note.add` changes, and Undo per calendar.
- **Slice 3:** weekly and D46 suggestions it is sure of are applied (`rule.add` enabled), and a calendar refresh brings the weekly pass forward.
- **Slice 4:** `propose_note` saves a note the person's own message stated plainly, through `apply.ts` with `sourceKind: 'chat'`, and the card shows Saved with Undo. This changes the frozen prefix, so it ships with the other prefix changes. Pasted text items join the files path.

## Risks / Trade-offs

- [A misread saves a wrong note] → Only `high` events that pass the checks are applied, every one shows with Undo, a person's note beats it, and the refit's gate still decides publication.
- [Customer names reach Anthropic without a press] → Sales exports are never sent on their own, the per-file box and the org switch stop it, and the privacy wording changes before production. This is the biggest change in this proposal and needs the owner's explicit yes (owner question 1).
- [A burst drains the files month] → The $1 reserve, 20 a day, one at a time, and dedupe before any call.
- [Refit churn] → 15 quiet minutes, once a day per location, the fingerprint check, and the live and weekly caps.
- [Two writers race] → Unique dedupe keys, planned ids and compare-and-set on every status.
- [D34's pressed reads now save less] → The switch off restores today's behavior. [CONFIRM] above.

## Migration Plan

Optional fields only: `agentAuto` on orgs, `ai.auto` on reads, `agent` on notes and rules, `refit` on locations, and the new collection `tw_agent_changes` with its indexes built in `ensureIndexes`. No backfill. Existing D34 notes count as TownwiseAI's by `source`. Rollback: turn the switch off (deploy or org), and every change stays undoable from the log.

## Open Questions

Owner questions (only the first blocks production; none blocks building slice 1):

1. Do you approve that, by default, TownwiseAI sends every file added to Your data (PDFs, sheets, Word documents, photos, ZIPs; not sales exports Townwise read into days) to Anthropic without a press, and the privacy wording in decision 14? Will you tell Sawtooth's owner first?
2. In slice 3, should business rules TownwiseAI is sure of be applied (default: yes, at most 2 a week), or always wait?

[DECISION NEEDED] items (gaps shown honestly, not settled here):

- [DECISION NEEDED: automatic reads skipped for budget are not retried when the month resets; a person presses Read with TownwiseAI]
- [DECISION NEEDED: booking labels on link and Google calendars, whose rows are replaced on refresh (D58 kept labels to file calendars)]
