## Why

On 2026-11-17 the owner asked: "shouldn't TownwiseAI messages run as background jobs and connect through a websocket so I can refresh the page and still see my response regardless of my connection?" Today a TownwiseAI turn lives inside its POST request (`postTurn` in `api/src/handlers/chat.ts`): closing the connection aborts the model call, and a turn is saved only when it finishes, so a refresh, a dropped Wi-Fi link or a phone that locks mid-reply loses the person's message and the reply, and still spends the organization's budget on it. The owner agreed to the shape of the fix: a turn runs on the server whatever the browser does, its progress is kept in Mongo, and the page picks it back up when it loads. The stream stays server-sent events, not a websocket, because the traffic is one way, the Container Apps ingress already carries SSE, and the two API replicas share no memory (Valkey is a per-replica sidecar).

## What Changes

- **A turn no longer depends on its connection.** `POST .../chat/turns` still streams the turn as today, but closing the connection no longer aborts it. The turn runs to its end on the replica that took it, bounded as before (150 seconds, 8 model calls, the organization's monthly budget before each call). **BREAKING** (contract only): `docs/portal/tuning-chat.md` section 3's "closing the connection aborts the provider call" is removed.
- **Progress is kept while the turn runs.** A new collection, `tw_chat_turns`, holds one record per turn: its state, a lease the running replica renews, a stop flag, the person's message and the events the stream sent, in order and numbered. Ended records are deleted 15 minutes after their turn ends. Text and thinking are written in short batches, every other event at once. The conversation itself is still written once, when the turn finishes, by the existing compare-and-set, so nothing partial ever reads as a saved turn.
- **The page reattaches.** `GET .../chat` names the person's running turn at that location, `GET .../chat/:conversationId` reports a running turn with its id, and a new SSE route, `GET .../chat/:conversationId/turns/:turnId?after=<n>`, replays the stored events after a cursor and then follows the record by polling Mongo until the turn ends. Either replica can serve it. Each streamed event carries its number as the SSE `id`, so a dropped stream resumes where it stopped.
- **Stop is explicit.** A new route, `POST .../chat/:conversationId/turns/:turnId/stop`, asks the running turn to stop; the replica running it sees the flag and aborts. A stopped turn saves nothing but its cost, as Stop does today, and now ends with a `stopped` event any reader sees.
- **A turn whose replica dies is settled.** A record still `running` after its lease ran out (a crash, a scale-in, a deploy that outlasted the drain) reads as `interrupted` to every reader at once, and a sweep loop in each replica then settles it: its claims are released, a conversation it created is deleted and the record is marked `interrupted`. It is never continued on another replica. A shutting-down replica ends its running turns as `interrupted` itself, so the page says so within seconds.
- **A dead turn's claims are released by the sweep.** The per-person and per-conversation live-turn claims are unchanged, 3-minute backstop included, but the sweep that settles an interrupted turn releases them, so a person whose turn died can send again within about 45 seconds instead of 3 minutes.
- **The client.** The chat page reopens the conversation with a running turn on load, tails it, reconnects with its cursor when a stream drops, and on native resumes when the app returns to the foreground. Stop calls the stop route. Several tabs can watch the same turn; any of the author's tabs can stop it.
- **Spec decision D45** records the owner's request and these choices. It is reserved for this change in the sessions' reservation list (D43 is `home-week-forecast`, D44 the one-step location delete); check that list and the spec on `develop` again before writing it.

## Capabilities

### New Capabilities
- `resumable-chat-turns`: how a TownwiseAI turn runs independently of its connection, what is kept while it runs, how a reader reattaches and resumes, how it is stopped, and how a turn whose replica died is settled.

### Modified Capabilities
None. The tuning chat has no capability spec under `openspec/specs/`; its contract is `docs/portal/tuning-chat.md`, updated by this change's tasks.

## Impact

- API: `api/src/handlers/chat.ts` (`postTurn` split into claim, start and run; the turn's events go through a recorder), new `api/src/chat/turn-runner.ts` (the detached run, its heartbeat and stop polling, shutdown), new `api/src/chat/turn-sweeper.ts` (a loop in each replica shaped like `api/src/files/ai-reader.ts`), new `api/src/stores/chat-turns.ts` (`tw_chat_turns`), `api/src/stores/chat-conversations.ts` (the GET's live turn and the path shown during it), `api/src/access/policy.ts` (a scope for the sweep), `api/src/stores/cross-tenant.ts` (the sweep's query and person deletion), `api/src/access/routes.ts` (two routes and a `chat_tail` limiter), `api/src/main.ts` (start the sweeper, add the runner to `onShutdown`), deletion paths (conversation, location, organization, person).
- Client: `client/src/api/client.ts` (`stream` for a GET with a cursor), `client/src/chat/api.ts` (the resume and stop calls, `id` on events), `client/src/chat/useTuningChat.ts` (reattach, resume, Stop, Stop and send).
- Docs: `docs/portal/tuning-chat.md` (header line, sections 2, 3, 5, 7 and Built), `api/README.md` (Tuning chat, endpoints, collections, logs), `docs/portal/spec.md` (D45, P25's Stop and live region words, 6.29 `tw_chat_turns`, deletion in 10.7), `client/MODULE.md` (`## Local changes` for `stream`).
- Infra: none required. Two replicas, the ingress and the DocumentDB settings stay as they are.
- Cost: one Mongo write about every 250 ms per running turn and one read every 500 ms per reader; no new paid service.

## Owner sign-offs

1. Turns keep running after the page closes, so a turn the person walked away from is still charged and saved (it was charged before too, but not saved).
2. A stopped turn still saves nothing, as today.
3. A turn whose replica dies or restarts mid-turn is not continued; it ends `interrupted` and the person sends again.
