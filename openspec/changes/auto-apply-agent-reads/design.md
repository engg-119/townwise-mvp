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
- **Afterwards:** when a person later saves a note that decides a day (`notesDecide`) that a TownwiseAI note also covers, the TownwiseAI note is set aside on that day (outcome `overridden`), in `forecasts/adjust.ts` and in `lab/input.ts` `labInputOf`. This mirrors the existing rule that a covering note beats a rule's closure. A person's note is one without `agent` and without `source`, or (slice 4) one TownwiseAI saved from the person's own words in chat: `agent` set, the person its author, no `source`. It is theirs from the start, so a later automatic note that decides its day differently is a conflict and waits, and it sets TownwiseAI's notes aside. Both stay pure functions. The lab golden is unchanged, since its fixture has no TownwiseAI notes. [CONFIRM: a note a person made beats a TownwiseAI note on the same day]
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
- **Slice 4:** `propose_note` saves a note the person's own message stated plainly, through `apply.ts` with `sourceKind: 'chat'`, and the card shows Saved with Undo. Code, not the model, refuses it in a turn that read words no person typed: a file, a picture, a web page, a calendar event's title, or a note TownwiseAI wrote from a file or a calendar. A chat change whose turn died mid-apply is finished by the weekly pass's sweep, as weekly and sales changes are. This changes the frozen prefix, so it ships with the other prefix changes. Pasted text items join the files path.
- **Slice 5:** a calendar's events answer TownwiseAI's open closure questions and suggestions (decision 16).

### 16. Slice 5: a calendar answers open questions

The owner asked on 2026-11-18, about an open question on a closure rule: "with my calendar or any linked calendar we will need to check it to see if anything has changed so that we can update things such as this. for example, if he connects his google calendar and puts in that they are closed then the question should go away about the rule in all places".

**When it runs.** Code only: no model call, no budget, nothing leaves Townwise, so it runs whatever the weekly suggestions and calendar titles switches say. It runs for the whole location (all its calendars) right after `followLinkedNotes` at every place a calendar's events switch (D53): a file, link or Google calendar added (POST .../owner-calendars, and D60's import of a stored calendar file, which share `addFileCalendar`), the refresh loop, and Refresh now. It also runs at the end of each location's weekly pass, so a suggestion made after the calendar's events switched (a file read's, the weekly pass's, the sales history's) is checked within the week. Removing a calendar runs nothing: it can only take an answer away, and questions computed on read come back at once. Never throws: a failure is logged by the location's id, and the switch it follows stands. [CONFIRM: a suggestion made after the calendar's last switch is checked at the next switch or weekly pass, not at once]

**A closed event** (`api/src/calendar/closed-events.ts`, pure). An event of any of the location's calendars (its current generation) counts only when all of these hold:

- It is keyed (its uid survives a refresh, D53), so a note can follow it.
- It is all day (no hours). A timed "Closed" is part of a day.
- Its title plainly says the business is closed. The title is folded (accents dropped, lower case, apostrophes dropped, every other mark a space). It holds no `?` and no digit (a time or a count). Its words are, in order: optionally `we are`, `were` (we're), `restaurant`, `cafe`, `shop`, `store` or `business`; then `closed`; then anything with none of these words: part of a day (`early`, `late`, `until`, `till`, `til`, `from`, `at`, `after`, `before`, `noon`, `midnight`, `am`, `pm`, `morning`, `afternoon`, `evening`, `night`, `lunch`, `dinner`, `brunch`, `breakfast`, `hours`, `hour`, `half`, `partial`, `partially`, `part`), part of the place (`kitchen`, `bar`, `patio`, `deck`, `dining`, `room`, `upstairs`, `downstairs`, `takeout`, `delivery`), a booking (`private`, `party`, `event`, `buyout`, `booked`, `booking`, `public`, `wedding`, `rehearsal`, `reception`), doubt (`maybe`, `tentative`, `tentatively`, `possibly`, `probably`, `tbd`, `if`, `unless`, `except`, `but`, `not`) or opening (`open`, `opens`, `opening`, `reopen`, `reopens`, `reopening`). "Closed", "CLOSED for Thanksgiving", "We're closed", "Closed (family vacation)" count; "Closed early", "Closed 2-5pm", "Kitchen closed", "Closed for a private party", "Closed?", "Maybe closed" and "Not closed" do not.
- Its dates make a closure note under Section 12's rules (readNoteContent).

[CONFIRM: an all-day keyed calendar event whose title plainly says closed, by this word rule, answers a closure question]

**What a calendar answers.** "Covered" means every day it names is a day of a closed event.

| Open question or suggestion | Where it shows | Answered when |
|---|---|---|
| Gap and likely-closed questions ("Were you closed?", "Were you open?"), computed on read (`agent/questions.ts`) | P25 Questions, Home's count | Each day a closed event covers is explained, as a covering note explains it, so the question shrinks to the days left or goes |
| A closure rule suggested with dates and no season (D46 from a file, D53 weekly) | P25 Suggested rules and weekly suggestions, P29, the counts | Every day it closes is covered |
| A standing closed weekday (D46 from the sales history, computed or stored, or a file's or the weekly pass's standing closure) | The same | The next 8 days of each of its weekdays, from tomorrow in the town, are covered [CONFIRM: 8 upcoming days of a weekday covered answer a standing closed weekday] |
| A closure note suggested by a file read ("Not sure from your files", D59) or the weekly pass (D53) | P25, the waiting count, Home's count | Every day it covers is covered |
| A yearly season, a private event or buyout, more or fewer guests, D53's spotted events, weekday questions (no longer asked) | | Never: a calendar's single days cannot say "every year", and a title that plainly says closed says nothing of a booking |
| D53's move and remove follow-ups | | Already followed by `followLinkedNotes` |

Read-time questions read the calendars on every GET .../agent (`questionsFor`'s new `calendarClosed` dates), so they also come back once the calendar's event goes. Stored suggestions are answered at the run above.

**Owner beats agent.** A suggestion is not answered when a person's own note or rule decides one of its days differently (closed, booked or open; apply.ts `conflictsWith`, from today for a standing one): the person's word and the calendar disagree, so the question stays.

**While TownwiseAI works on its own** (`TOWNWISE_AGENT_AUTO` and `agentAuto` both on), answering also makes the forecast follow, through the one writer:

- A dated answer: each closed event that answers it and that no closure or private-event note covers yet gets a closure note (`note.add`, `sourceKind: 'calendar'`, `sourceId` the calendar, a planned id hashed from the calendar and uid so a retry writes one, no title, `confidence: 'high'`, no why, author TownwiseAI, `onBehalfOf` the calendar's adder), linked to its event (`fromEvent`), so D53's follow-up proposes a move or a removal when the event moves or goes. A closure that long is the person's own calendar, so D34's 14-day guard for a model's reading does not apply.
- A read-time question: the same notes for the closed events covering any day a current question asks about (read without the calendar), so the history the lab reads matches what the panel stops asking. A history day wants a refit, as every applied change does.
- A standing weekday: the suggestion's own closure rule (`rule.add`, `sourceKind: 'calendar'`, `sourceId` the first answering calendar), which cannot link to one event; it is not counted in slice 3's 2 rules a week, which bound TownwiseAI's own guesses. [CONFIRM: a standing closed weekday a calendar answers is added as a rule, outside the 2 a week]
- Only when every note or rule it needs is written (or its key shows the same change was made before, `duplicate`) is the suggestion marked answered. A conflict, the note or rule limit, or anything else that adds nothing leaves it open, so the forecast and the panel never disagree.
- At most 20 notes a run per location; the rest are written at the next run. [CONFIRM: at most 20 notes from calendar answers a run]

**While it does not**, nothing is written: the suggestion is marked answered and the forecast reads its days as it did while the question was open (an open suggestion changes nothing either). The Calendar still offers Make a note on the event (D53), which is how a person puts the closure into the forecast. Production runs this way until owner question 1 is answered (`TOWNWISE_AGENT_AUTO=false`). [CONFIRM: while TownwiseAI does not work on its own, a calendar's answer closes the question and saves nothing]

**The resolution.** `tw_agent_suggestions` gains the status `answered` (`decidedBy: 'calendar'`, `decidedAt`), set by compare-and-set from `open`. It is not a person's dismissal and not an accept. An answered row is never listed, counted or expired, and is read by the weekly pass's duplicate check as any decided row; its closure key keeps the same rule from being suggested or added from the sales history again. A computed sales suggestion that is answered is stored `answered` under its key, as a decide stores one. Answered is final: a later change to the calendar does not reopen it, and the notes TownwiseAI wrote from it follow their events as D53's do. [CONFIRM: a suggestion a calendar answered stays answered when the calendar changes later]

**How it shows.** The answered question or suggestion is gone from TownwiseAI's panel, its counts, Home's count and Business rules, since each reads only open rows or computes on read. Each note or rule shows in the activity and log with Undo, worded "from your calendar" (which now also replaces slice 2's "from a calendar you imported", wrong for a link or a Google calendar). The switch's words add: "When your calendar plainly says you're closed on days it asked about, it saves that closure from the calendar and stops asking." [CONFIRM: the switch's and activity's words for answers from a calendar]

**Audit and logs.** Each note or rule records `agent.change_applied { locationId, action, sourceKind: 'calendar' }` as any change. A run that answered any records `agent.calendar_answered { locationId, count }` as TownwiseAI, and logs `townwise.calendar_answers { locationId, answered, notes, rules, held }` (counts; `held` the suggestions a conflict or a limit kept open). Never a title, uid or date.

**Not built.** The reverse, an event that plainly says open answering "were you open?", is left out: a title like "Open" is rare and close to "Open mic" or "Open bar", and a likely-closed day would still read as closed to D32 without the open-day note. [DECISION NEEDED: whether a calendar event that plainly says open answers a likely-closed question]

Alternatives: the forecast reading closed calendar events directly (it would close days on every calendar, switch or not, and change the lab input); a model call to read titles (cost, and titles sent for what a word rule decides); hiding questions only at read time (stored suggestions would need the calendar on every list, and the forecast would not follow).

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
- [DECISION NEEDED: whether a calendar event that plainly says open answers a likely-closed question (slice 5, decision 16)]
