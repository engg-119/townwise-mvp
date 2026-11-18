## ADDED Requirements

### Requirement: A turn runs independently of its connection
Once `POST /api/org/locations/:locationId/chat/turns` has passed its checks and holds both live-turn claims, the turn SHALL run to its end on the replica that accepted it whether or not any connection stays open. Closing the POST's connection SHALL NOT abort the model call. Only the 150-second time limit, a stop request, a lost lease or the replica's shutdown SHALL abort a running turn. A turn SHALL end in exactly one of: saved (`done` with a saved stop reason), refused (`done` `refusal`), failed (`error`), timed out (`error` `timeout`), stopped (`stopped`) or interrupted (`error` `interrupted`). The bounds of today SHALL hold unchanged: 150 seconds from the claims, at most 8 model calls, the organization's monthly budget checked before the turn and before every model call after the first, the `chat` limiter of 60 turns an hour per account, and one live turn per person per organization and per conversation.

#### Scenario: The page is closed mid-turn
- **WHEN** a person sends a message and closes the tab while the reply is streaming
- **THEN** the turn keeps running, its reply is saved to the conversation when it finishes, and its cost is recorded as for any turn

#### Scenario: The budget runs out mid-turn with no one watching
- **WHEN** the organization's budget is spent before the turn's third model call and no connection is open
- **THEN** the turn ends with `done` `budget` after its last complete step and that step is saved

#### Scenario: A second send while the turn runs
- **WHEN** the same person sends another message from another tab while their turn is running
- **THEN** the API answers 409 `chat_turn_in_progress`, as today

### Requirement: A running turn's progress is kept and numbered
Each turn SHALL have a record in `tw_chat_turns` holding its organization, location, conversation, author, turn id, state (`running`, `done`, `failed`, `stopped` or `interrupted`), lease, stop flag, its nodes, the person's message as they wrote it (null for a regenerate) and the events its stream sent, each numbered from 1 in order. The record SHALL be inserted after both claims are held and before the first event. Adjacent text deltas and adjacent thinking deltas SHALL be joined into one event per batch, a batch SHALL close after at most 200 ms or 4 KB of deltas or before any other event, and every listener SHALL receive the same events with the same numbers that are stored. The terminal event and the terminal state SHALL be written in one update. The conversation SHALL still be written only when the turn finishes, by the existing compare-and-set on the claim's turn id, so a reply in progress SHALL never appear among a conversation's saved messages. The record SHALL never hold raw API messages, attachment content, `read_data_item` text or calendar event titles beyond what the stream itself showed. The record's text, tool views and visuals SHALL never be logged or audited. A record SHALL be deleted with its conversation, location, organization or author, and 15 minutes after its turn ended.

#### Scenario: A turn's events are stored as they stream
- **WHEN** a turn streams 300 text deltas, a tool call and more text, then finishes
- **THEN** its record holds a few numbered `text` events, the `tool` events in their place, then `done`, with `state` `done`, and the conversation holds the saved turn exactly as today

#### Scenario: A failed turn
- **WHEN** the provider fails during the turn's second model call
- **THEN** the record ends with `state` `failed` and an `error` event, and the conversation's saved messages are unchanged

#### Scenario: The conversation is deleted mid-turn
- **WHEN** the author deletes the conversation while its turn runs
- **THEN** the turn's record is deleted, the turn ends at its next write without saving anything, and no record remains

### Requirement: A reader reattaches to a running turn
`GET /api/org/locations/:locationId/chat` SHALL report the caller's running turn at that location as `liveTurn: { conversationId, turnId }`, else null. `GET .../chat/:conversationId` SHALL report `liveTurn: { turnId, state, startedAt, userNodeId, replyNodeId, parentId, message }` while the conversation's turn is running or interrupted and not yet settled, else null, and while a turn is live and no `?node=` is given its `messages` SHALL be the path to the turn's `parentId`. A new route, `GET .../chat/:conversationId/turns/:turnId?after=<n>` (policy `member`, limiter `chat_tail`: 300 an hour per account, allowed when its store is down), SHALL answer `text/event-stream` with every stored event numbered above `after`, each with its number as the SSE `id`, then poll the record every 500 ms and stream new events until the terminal event. It SHALL answer 404 for a turn that is not that conversation's or a conversation that is not the caller's, and SHALL be readable under view-as as the conversation GET is. It SHALL answer a running record whose lease has passed with `error { code: "interrupted" }`. It SHALL ping every 15 seconds and end after 200 seconds without a terminal event. The POST's stream SHALL carry the same numbers, and its `conversation` event SHALL carry `turnId`. Either replica SHALL serve any of these reads.

#### Scenario: Refresh mid-reply
- **WHEN** a person refreshes the chat page while a reply is streaming
- **THEN** the page opens that conversation, shows their message and the reply so far, follows it until it ends and then shows the saved reply

#### Scenario: Resume after a dropped connection
- **WHEN** the client last received event 41 and reconnects with `after=41`
- **THEN** the stream starts at event 42 and no text is repeated

#### Scenario: The other replica serves the reader
- **WHEN** the turn runs on one replica and the reader's request reaches the other
- **THEN** the reader receives the same numbered events and the same ending

#### Scenario: Someone else's turn
- **WHEN** a member asks for a turn id of a colleague's conversation or of another organization
- **THEN** the API answers 404

#### Scenario: Several tabs
- **WHEN** the author has the conversation open in two tabs while the turn runs
- **THEN** both tabs show the reply as it is written and both show the saved reply when it ends

### Requirement: Stop ends the turn on the server
A new route, `POST .../chat/:conversationId/turns/:turnId/stop` (policy `member`, empty body under `1kb`, the `writes` limiter only, refused under view-as), SHALL set the stop flag on the author's running turn and answer 202 `{ state: "running" }`, or answer 200 `{ state }` for a turn that already ended, and 404 for a turn that is not the caller's. The replica running the turn SHALL see the flag within about a second and abort it. A stopped turn SHALL save nothing but its cost, SHALL release both claims and delete a conversation it created, and SHALL end every stream with a `stopped` event. Closing a connection SHALL NOT stop a turn.

#### Scenario: Stop from another replica
- **WHEN** the author presses Stop and the request reaches the replica that is not running the turn
- **THEN** the turn ends within about a second, nothing of it is saved, its cost is recorded and every reader sees `stopped`

#### Scenario: Stop after the end
- **WHEN** the stop request arrives after the turn was saved
- **THEN** the API answers 200 `{ state: "done" }` and the saved turn stays

#### Scenario: Stop and send
- **WHEN** the author presses Stop and sends while the reply streams
- **THEN** the client waits for `stopped`, then sends the new message, which streams without a 409

### Requirement: A turn whose replica died is settled
The replica running a turn SHALL renew the record's lease to 30 seconds ahead with every write and at least every 10 seconds, each write a compare-and-set on the record still `running`; when one matches nothing, the turn SHALL end without saving. A loop in each replica SHALL find, at least every 15 seconds, running records whose lease has passed and settle each by releasing the conversation's claim (deleting a conversation that never finished a turn), releasing the person's claim, then setting the record to `interrupted` with a final `error { code: "interrupted" }` event, in that order, so a retry completes it. A turn SHALL NOT be continued on another replica. On shutdown, after the HTTP drain, a replica SHALL stop taking turns and settle its own running turns as interrupted. The sweep and the shutdown SHALL log ids and counts only.

#### Scenario: The replica crashes mid-turn
- **WHEN** the replica running a turn stops without shutting down
- **THEN** readers see `interrupted` once the lease has passed, the sweep releases the person's claim within about 45 seconds of the last heartbeat, and the person can send again

#### Scenario: A deploy during a turn
- **WHEN** a replica receives SIGTERM while a turn runs and the turn is still running after the drain
- **THEN** the replica ends the turn as `interrupted`, releases its claims and the page says the reply was interrupted

#### Scenario: A first turn is interrupted
- **WHEN** the turn that created a conversation is interrupted
- **THEN** the conversation is deleted, as a failed first turn's is today
