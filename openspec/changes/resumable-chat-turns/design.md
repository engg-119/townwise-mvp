## Context

A TownwiseAI turn is one POST, `POST /api/org/locations/:locationId/chat/turns` (route `org.chat.turn`, `postTurn` in `api/src/handlers/chat.ts`), answered as `text/event-stream` with a 15-second ping. The handler checks the budget and attachments, claims the person's one live turn (`tw_chat_live_turns`, `api/src/stores/chat-live-turns.ts`) and the conversation (`liveTurn { turnId, startedAt }` on `tw_chat_conversations`), reads attached files under the replica's byte gate, then runs `runTurn` (`api/src/chat/turn.ts`) with `signal = AbortSignal.any([closed, timeLimit])`, where `closed` aborts on `res.on('close')`. A closed connection therefore aborts the model call, logs `townwise.chat_turn_aborted` and saves nothing but cost. The turn is saved once, by `conversations.finish`, a compare-and-set on the claim's turn id that appends the person's message and every assistant and tool-result message and sets `activeLeafId`. Before it is saved, `savedTurn` elides `read_data_item` and `get_owner_calendar` results and drops thinking bound to content that is never stored (D28, D36, D39). A failed, aborted, timed-out or refused turn releases its claims, deletes a conversation it created and saves only its cost. Claims go stale 3 minutes after they were taken (`STALE_TURN_MS`).

Constraints that shape the design:

- Production runs 1 to 2 API replicas (`infra/terraform/production/containerapp.tf`). Valkey is a sidecar per replica on 127.0.0.1, so replicas share nothing in memory and there is no cross-replica pub/sub.
- Production Mongo is Azure DocumentDB with `retryWrites=false` and no multi-document transactions. Change streams are not assumed to be available there, so readers poll.
- The Container Apps ingress closes a request at about 240 seconds. Shutdown (`api/kit/server-core/src/lifecycle.ts`) drains HTTP for up to `SHUTDOWN_TIMEOUT_MS` minus 5 seconds (20 seconds by default), then runs each `onShutdown` hook with a 2-second limit.
- The API already runs lease-based loops in each replica: the file reader (`api/src/files/worker.ts`) and the AI file reader (`api/src/files/ai-reader.ts`, a 90-second lease renewed every 30 seconds), and the weekly worker keeps its lease in Mongo (`api/src/workers/weekly-forecasts.ts`).
- The owner agreed (2026-11-17) that a turn runs server side independently of the browser, progress is kept in Mongo, the client reattaches on load, and SSE stays.

## Goals / Non-Goals

**Goals:**

- A refresh, a dropped connection, a second tab or a phone returning from the background shows the reply that is being written, and then the saved reply.
- A turn ends the same way however many connections come and go: saved, refused, failed, timed out, stopped or interrupted.
- Every bound that holds today still holds: 150 seconds, 8 model calls, the monthly budget before every call after the first, 60 turns an hour, one live turn per person and per conversation.
- Nothing partial is ever shown as a saved turn, and the saved conversation is written exactly as today.
- Message text stays out of logs and audit events.

**Non-Goals:**

- Continuing a turn on another replica after its replica dies.
- WebSockets, change streams or a message broker.
- Longer turns, history compaction or queued turns (one person still has one live turn).
- Keeping a stopped turn's partial reply.

## Decisions

### 1. A turn runs detached in the replica that accepted it, under a lease

`postTurn` keeps every check and claim it makes today, then hands the turn to a per-replica runner (`api/src/chat/turn-runner.ts`) and streams the runner's events to its response. Closing the response unsubscribes that one listener and nothing else. The runner owns the turn's `AbortController`, which only the time limit, a stop request, a lost lease or shutdown abort.

The turn's record in `tw_chat_turns` (decision 2) carries `leaseUntil`, 30 seconds ahead, renewed by every write the turn makes and by a 10-second heartbeat while nothing is written (a long thinking step or a slow tool). Each write is a compare-and-set on `{ turnId, state: 'running' }`; when it matches nothing (the record was settled as interrupted, or deleted with its conversation, location, organization or person), the runner aborts the turn as `lease_lost`, which saves nothing, exactly like today's taken-over turn.

When a replica dies mid-turn (crash, out of memory, scale-in or a deploy that outlasts the drain), its records stop being renewed. Any reader treats a `running` record whose lease has passed as interrupted. A sweep loop in each replica (`api/src/chat/turn-sweeper.ts`, shaped like `ai-reader.ts`: a poll every 15 seconds, its query in `stores/cross-tenant.ts`, its scope minted by a new `scopeForStaleChatTurn` in `access/policy.ts`) settles each one, in an order a retry completes: release the conversation's claim by turn id (which deletes a conversation that never finished a turn, as `release` does today), release the person's claim by turn id, then compare-and-set the record from `running` to `interrupted` with a final `error { code: "interrupted" }` event. The cost of model calls already finished was recorded after each call, as today. The call in flight when the replica died is never charged; that loss is bounded by one call and is the same as a crash today.

A replica shutting down ends its own turns sooner. The HTTP drain (up to 20 seconds) lets turns finish while their streams are open. Then the runner's `onShutdown` hook, first in the list so Mongo is still open, stops taking turns, aborts the rest with reason `shutdown` and settles each as above, within the hook's 2 seconds; any it cannot settle in time are settled by the sweep on the other replica or on the next start, at most 45 seconds after the last heartbeat.

The claims keep their 3-minute age as a backstop. A turn on a live replica still ends within 150 seconds plus its save, so a claim older than 3 minutes is still a dead one, and a turn whose replica died has its claims released by the sweep within about 45 seconds, not 3 minutes.

Alternatives considered:

- **A lease-claimed worker loop** (the POST writes a queued turn; any replica's loop claims it and runs it; a new owner continues from the last completed step). Rejected. Continuing a turn needs the raw API messages of every completed step, and those hold what must never be stored: an attached file's content, `read_data_item` text, calendar event titles and thinking bound to them (D28, D36, D39 elide all of these before the save). A turn's attachments are read into memory under the accepting replica's byte gate, and a continuation would repeat a model call that had already streamed part of its answer, charging it twice. It also adds a queue hop to every turn's first token. Its only gain is surviving a replica death, which is rare (deploys are by hand, the app runs 1 or 2 replicas) and which the person can recover from by sending again.
- **A Container Apps job per turn.** Rejected: a cold start of tens of seconds before every reply, and the same storage problem.
- **Keep abort-on-close and only retry on the client.** Rejected: it does not meet the request; a refresh would still lose the turn.

### 2. What is kept, and when

A new collection, `tw_chat_turns` (`api/src/stores/chat-turns.ts`, tenant store taking an `OrgScope`), holds one record per turn: `orgId`, `locationId`, `conversationId`, `userId`, `turnId` (the claim's id), `state` (`running`, `done`, `failed`, `stopped` or `interrupted`), `leaseUntil`, `stopRequested`, `startedAt`, `endedAt`, the turn's nodes (`userNodeId`, `replyNodeId`, `parentId`), the person's message as they wrote it (`text` and the attachment refs; null for a regenerate), `events` (each `{ seq, type, data }`) and `eventCount`. Indexes: unique `{ orgId, turnId }`; `{ orgId, conversationId }`; `{ orgId, locationId }`; `{ userId }`; `{ state, leaseUntil }` for the sweep; `{ endedAt }` for clean-up. The record is inserted after both claims are held and before the first event, so its failure releases the claims as any failure before the stream does.

The events are the stream's own events (`conversation`, `thinking`, `text`, `tool`, `proposal`, `visual`, `suggestions`, `done`, `error`, and the new `stopped`), numbered from 1. A recorder between `runTurn`'s `emit` and the outside world batches them: adjacent `text` deltas join into one `text` event, adjacent `thinking` deltas into one `thinking` event, and a batch closes after 200 ms or 4 KB of deltas, or at once before any other event. Every listener (the POST's response, and a tail on the same replica) receives each batch as it closes, with the same numbers that are stored, so a resumed reader never sees a delta twice. A batch is written with `$push: { events: { $each } }`, `$set: { eventCount, leaseUntil }` under a compare-and-set on `eventCount`, so a write that applied but reported an error (no retryable writes) is found by re-reading `eventCount` and never doubled. A failed write is retried with the next batch; a lease that lapses meanwhile ends the turn as decision 1 says. The terminal event and the terminal `state` are written in one update, so a reader never sees `done` on a running record or a finished record without its last event.

The conversation is still written only by `finish`, unchanged: one compare-and-set on the claim's turn id that appends the saved messages and sets `activeLeafId`. The person's message is not written into the conversation when the turn starts. Writing it there would leave an unanswered message after a failure, a stop or a refusal (today each saves nothing), would need its own clean-up, and would have to apply the business-rules block and attachment rules to a message whose turn may never finish. The record holds it for display only, and the conversation GET shows it from there while the turn runs (decision 3).

A turn's record holds what its stream showed: the reply's text and thinking summary, tool input and result views, visuals, proposals and suggested questions. That is the same class of data as the saved conversation and the stream, so it is never logged or audited, and it goes with the conversation, the location, the organization and the person (each deletion path deletes the records too; location deletion includes them in its sweep of late writes). It never holds the raw API messages, so nothing elided before a save (D28, D36, D39) is kept. A record whose turn ended is deleted by the sweep 15 minutes after `endedAt`, which leaves time for a reader that lost its connection near the end to read the last event; afterwards the saved conversation is the only copy. A record is at most 8 model calls of 16,000 output tokens, about 1 MB of text and thinking plus tool views, well under the 16 MB document limit.

Alternatives considered:

- **Store the reply's text into the conversation as it streams** (or each completed step). Rejected: it breaks "a turn is saved only when it finishes", the single compare-and-set `finish`, the active leaf and the elision before a save, and every failure would need to undo it.
- **One document per event** in a separate collection. Rejected for now: more writes, more deletion paths, and the terminal event and state could not change in one write. A turn's events fit in one document.
- **Store raw deltas without batching.** Rejected: one write per token is roughly 50 writes a second per turn.

### 3. How a reader reattaches

- `GET .../chat` gains `liveTurn: { conversationId, turnId } | null`: the caller's running turn at this location (under view-as, the target's). On load, the chat page opens that conversation instead of a new one.
- `GET .../chat/:conversationId` gains `liveTurn: { turnId, state, startedAt, userNodeId, replyNodeId, parentId, message } | null`, present while the conversation's turn is running or was interrupted and not yet settled (`state` `running` or `interrupted`). `message` is the person's message as an entry of `messages` (text and attachments, names read as the conversation view reads them, so null under view-as), null for a regenerate. While a turn is live and no `?node=` is given, `messages` is the path to the turn's `parentId`, so an edit's or a regenerate's live branch is the one shown.
- A new SSE route, `GET .../chat/:conversationId/turns/:turnId?after=<n>` (`org.chat.turn_events`, policy `member`, the conversation's author or view-as of them, `openAsAdmin: true`, limiter `chat_tail`). It answers 404 when the turn is not that conversation's or the conversation is not the caller's, 400 for a malformed `after`, then streams every stored event numbered above `after` with its number as the SSE `id:`, and polls the record every 500 ms for more. It ends after the terminal event. A `running` record whose lease has passed is answered with `error { code: "interrupted" }` without writing anything (the sweep writes). It pings every 15 seconds and ends on its own after 200 seconds without a terminal event, under the ingress's 240, so the client reconnects with its cursor. Either replica can serve it.
- The POST's stream gains the same `id:` numbers, and its `conversation` event gains `turnId`, so the tab that sent the turn resumes with the tail if its connection drops.
- `chat_tail` is 300 an hour per account and allows the request when the limiter's store is down (it reads, it does not spend). A tail costs two small reads a second for at most 200 seconds.

Alternatives considered: plain polling of the conversation GET by the client (rejected: a second way to draw a streaming reply, and a whole conversation read every half second); a websocket (rejected with the owner: one-way traffic, the ingress already carries SSE, no shared memory between replicas); Valkey pub/sub (per-replica sidecar); Mongo change streams (not assumed on DocumentDB, and polling at this scale is cheap); sticky sessions so a tail lands on the running replica (does not survive a replica restart, and the second replica still has to read Mongo).

### 4. Stop is a request, not a disconnect

`POST .../chat/:conversationId/turns/:turnId/stop` (`org.chat.turn_stop`, policy `member`, body `1kb` and empty, `writes` only, `openAsAdmin: true`; the view-as guard refuses it like every non-GET). Only the conversation's author may stop its turn (404 otherwise). It sets `stopRequested` on a running record by compare-and-set and answers 202 `{ state: "running" }`; on a turn that has already ended it answers 200 `{ state }`, so a repeat is harmless. The runner checks `stopRequested` every second (a read of one field) and aborts with reason `stop`. A stopped turn saves nothing but its cost and releases its claims, as Stop does today; its last event is `stopped {}`, and it logs `townwise.chat_turn_aborted` with `reason: "stop"`.

The client's Stop calls the route and keeps reading its stream until `stopped` (or another terminal event, when the turn finished first). Stop and send waits for that terminal event, then sends; the existing 409 `chat_turn_in_progress` retries stay as the backstop.

Alternatives considered: a field on the turn POST (it is a new turn's body, and a stop must not count toward `chat`); `DELETE` on the turn (it does not delete anything kept); keeping the completed steps of a stopped turn (listed under Open Questions; today's behavior is kept).

### 5. Bounds

- **Time.** 150 seconds from the claims, measured in the runner, as today. The 240-second ingress limit no longer bounds the turn, only each connection, and each connection can reconnect. The limit stays at 150 for cost and because the claims' 3-minute backstop assumes it.
- **Model calls.** 8 per turn, unchanged.
- **Budget.** Checked before the turn and before every model call after the first, unchanged; a budget spent mid-turn ends with `done` `budget` and the turn is saved.
- **Rate.** `chat` stays 60 turns an hour per account on the POST. The tail has `chat_tail`; stop has `writes`.
- **One live turn.** The per-person and per-conversation claims work as today; a dead turn's claims are released by the sweep (decision 1).
- **Access.** A turn runs with the access its POST resolved, for at most 150 seconds, as today. A person removed or deleted mid-turn: person deletion deletes the record, so the runner's next write loses its lease and the turn ends; a removed seat's turn may still finish, as it may today while its connection stays open.

### 6. Rollout: on by default, no switch

Detached turns are the only behavior once deployed, with no environment switch. A switch would keep the abort-on-close path alive and tested beside the new one for a feature the owner asked to have on (owner directive, 2026-11-16: features are on by default unless the owner says otherwise). Rollback is the previous image's revision, and nothing needs migrating either way: `tw_chat_turns` is a new collection whose indexes build at boot, existing conversations and claims are unchanged, and a turn in flight on the old revision during a deploy ends as it would today.

- **Old clients.** A web tab still on the previous bundle keeps working: the POST streams the same events, now with `id:` lines it ignores. Its Stop only closes the connection, so the turn now finishes and is saved, and the tab shows it as stopped until it reloads. Web bundles are replaced on every deploy.
- **Several tabs.** Each tab that opens the conversation tails the same record. A send from another tab still gets 409 `chat_turn_in_progress`. Any of the author's tabs can stop the turn. When a tab that did not send the turn sees its end, it reads the conversation again rather than merging.
- **Native (Expo).** iOS and Android suspend a backgrounded app and drop its connection. On returning to the foreground (`AppState` `active`), the chat reads the conversation and resumes the tail from its cursor. On the web, `online` and `visibilitychange` to visible reconnect at once; otherwise a dropped stream reconnects after 1, 2 and 4 seconds, then every 4 seconds, until a terminal event or the conversation GET shows no live turn.

### 7. Testing

Integration tests (`api/test/chat-resume.int.test.ts`, with the scripted fake model the chat tests already use, and `chatTurnTimeLimitMs`, the lease, heartbeat, poll and sweep intervals shortened through the app factory):

- Close the POST's connection mid-turn: the turn finishes, is saved once, and a tail with `after=0` replays every event in order, ending with `done`; a tail with `after=n` starts at `n + 1`.
- Two app instances against one Mongo: the turn runs on A while B serves the tail and the conversation GET with `liveTurn`; both readers see the same events with the same numbers.
- Replica death: start a turn on A, stop A's runner without settling (simulated crash), let the lease pass; B's readers answer `interrupted`, B's sweep releases both claims, deletes the new conversation (or keeps an existing one's saved messages untouched), and the person can send again at once.
- Shutdown: A's runner hook settles its running turn as `interrupted` within its 2 seconds.
- Stop: the stop route ends a turn running on the other instance within about a second, saves nothing, records the cost and ends every reader with `stopped`; a second stop answers 200; another person's stop is 404; under view-as it is refused.
- Budget exhausted mid-turn: `done` `budget`, saved, seen by the tail.
- Timeout, refusal and provider failure: the same endings as today, now also on the tail.
- Lease lost: deleting the conversation (or the location, or the person) mid-turn ends the turn without saving and leaves no record.
- Batching: many deltas are stored as a few `text` events; an ambiguous write is not doubled (a fake store that applies a write and then throws).
- Privacy: sentinel strings in the person's message, the reply, a tool result and a visual appear in no log line and no audit event of a turn, a tail, a stop, a sweep or a shutdown (the log capture the chat tests already use).
- Isolation: another organization's or another person's turn id is 404 on both routes (`api/test/isolation.test.ts` pins the new cross-tenant import to the sweeper only), and every route has its table entry (`api/test/routes.test.ts`).

Client tests (`client/test/chat/`): the SSE parser reads `id:`; the reducer replays a stored turn from `after=0` into the same reply a live stream draws; reconnect resumes from the last number without repeating text; Stop calls the route and waits for `stopped`; opening the page with a live turn opens its conversation; native resume on `AppState` `active`.

## Risks / Trade-offs

- [A person who walks away still spends the turn's cost] → It was charged before too; now it is also saved and shown when they return. The per-turn and monthly bounds are unchanged.
- [A replica death loses the in-flight call's cost and the turn] → Rare (manual deploys, 1 to 2 replicas); the turn ends `interrupted` within about 45 seconds, the page says so, and the person sends again. The uncharged call is bounded by one call, as today.
- [Mongo load from batching and polling] → About 5 writes a second per running turn and 2 reads a second per open tail, at most a few turns at a time for this product. The tail stops at the turn's end or after 200 seconds.
- [Record writes fail for longer than the lease] → The turn is settled as interrupted and its own save fails the compare-and-set, so it saves nothing rather than half a turn.
- [An old tab's Stop no longer stops] → The turn finishes and is saved; reloading shows it. Bundles are replaced on deploy.
- [DocumentDB differences] → The design uses only `updateOne` with `$push`/`$each`, `$set`, compare-and-set filters and indexed `find`; the `$slice` projection for reading events after a cursor is used only if DocumentDB supports it with a skip (task 1.1 checks), else the record is read whole, which is at most about 1 MB.

## Migration Plan

1. Deploy API and web together, as every release does. No data migration: a new collection with indexes built at boot; claims and conversations are unchanged.
2. Turns in flight on the old revision end as they do today when it drains.
3. Rollback: activate the previous revision. Records left in `tw_chat_turns` are ignored by the old code and can be dropped; claims they held are released by age after 3 minutes, as today.

## Open Questions

For the owner, each with the default this change builds:

1. Should a stopped turn keep what was written before Stop? Default: no, it saves nothing, as today.
2. Should an interrupted turn be retried automatically? Default: no; the page says it was interrupted and the person sends again (a retry would charge the finished calls again).
3. Now that the connection no longer limits a turn, should the 150-second limit rise? Default: keep 150 seconds.
4. How long should an ended turn's record be kept for late readers? Default: 15 minutes.
5. Should the chat page open the conversation with a running turn on load? Default: yes.
6. Is it acceptable to ship with no environment switch to turn this off? Default: yes, rollback is the previous revision.

## As built

- **DocumentDB operators (task 1.1, 2026-11-17).** Azure DocumentDB's compatibility page (learn.microsoft.com/azure/documentdb/compatibility-features, updated 2026-05-22) lists only what is unsupported, and neither `$push`, `$each` nor `$slice` is on it. `$push` with `$each` is already in production use: `conversations.finish` appends a turn's messages with it. No Azure page could be found for the find projection's `$slice: [skip, limit]` form (the one Azure `$slice` page found is the aggregation expression), so that form is not relied on: `tw_chat_turns` records are read whole and the events after a cursor are picked in code. A record is at most about 1 MB (decision 2), so a tail's read every 500 ms stays small.
- **Deletion (task 1.3).** The conversation DELETE deletes the conversation's records after the conversation; `removeLocation` (the org admin's D44 delete and staff setup's) deletes the location's after its conversations, which already runs after the location row is gone, so it is that path's late sweep; organization deletion deletes them with the other chat records in its first pass; person deletion deletes them by `userId` in every organization, uncounted, so the audit details are unchanged. Organization deletion's second sweep does not repeat them: a record inserted after the first pass belongs to a turn that ends within 150 seconds, and the sweep deletes every ended record 15 minutes later.
