# api

Townwise backend: one Node process (`src/main.ts`) composed from the kit modules in `kit/` (copied from camkeith/modules; versions in `../KIT.md`). Sign-in is Google only.

It mounts two routers. The kit’s `/auth` handles sign-in, sessions and two-step sign-in. Townwise’s `/api` (`src/app.ts`, routes in `src/access/routes.ts`) handles access, organizations, locations, sales data, notes, the tuning chat, the team and the staff console. No kit file is changed; all Townwise code is under `api/`. "The build spec" and "spec Section N" in this README and in code comments mean `../docs/portal/spec.md`.

## Run locally

Needs Node 24 (`nvm use` reads `.nvmrc`) and Docker. From the repo root:

```sh
nvm use
npm install
docker compose up -d    # Mongo on 27017, Valkey (Redis) on 6379; stop a local mongod first if 27017 is taken
grep -v -E '^AUTH_(JWT|ENCRYPTION)_KEYS=' api/.env.example > api/.env.local
printf 'AUTH_JWT_KEYS=k1:%s\nAUTH_ENCRYPTION_KEYS=e1:%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" >> api/.env.local
npm run dev -w @townwise/api
curl localhost:8080/healthz
```

`api/.env.local` is gitignored and holds throwaway local keys. Never commit it or paste its values.

Townwise staff are the addresses in `TOWNWISE_SUPERADMIN_EMAILS` (comma-separated, at most 20). Production refuses an empty list. A staff account must turn on two-step sign-in, and every staff request needs a session that passed a code within the last 60 minutes.

Google sign-in needs an OAuth web client (Google Cloud console, APIs & Services, Credentials, OAuth client ID, type Web) with `http://localhost:8081` as an authorized JavaScript origin. Put its client ID in `AUTH_GOOGLE_CLIENT_IDS`. Without it, `/auth/google` answers 404.

## Check

`npm run verify` from the repo root runs `npm ls`, lint, typecheck and every kit module's unit and integration tests (Docker required).

The api's own tests run with them (`npm test -w @townwise/api`; integration tests start Mongo and Valkey in Docker through testcontainers). `npm run test:unit -w @townwise/api` and `npm run test:int -w @townwise/api` run each half.

## Roles

Three roles: staff (`superadmin`, Townwise’s own people), org admin and member. [CONFIRM: the three roles]

| Capability | Staff | Staff in view-as | Org admin | Member | Signed in, no organization |
|---|---|---|---|---|---|
| Read own access (`GET /api/me`) | yes | the target’s | yes | yes | yes |
| Read a town profile | yes | yes | yes | yes | yes |
| Send an access request | no | no | no | no | in `no_org`, `rejected` or `removed` |
| Join or decline an invitation to their own email | no | no | no | no | in `invited` |
| Read the organization, locations, sales, notes and calibration | names, towns, team emails, counts and date coverage only, in the console | read-only, as the target | yes | yes | no |
| Upload sales | no | no | adds new days and replaces the days it covers | adds new days only | no |
| Delete all sales for a location | no | no | yes | no | no |
| Add notes; edit or delete their own | no | no | yes | yes | no |
| Edit or delete anyone’s notes | no | no | yes | no | no |
| Use the tuning chat (own conversations only) | no | reads the target’s, cannot send or delete | yes | yes | no |
| Add, rename, change the town of, or delete (when empty) a location | no | no | yes | no | no |
| Rename the organization | any organization, in the console | no | own | no | no |
| Read the team | any organization, in the console | read-only, when the target is an org admin | own | no | no |
| Add emails, change roles, remove people | any organization, in the console | no | own | no | no |
| Leave the organization | no | no | yes, unless the last admin | yes | no |
| See Townwise staff activity on the organization | the audit log | read-only, when the target is an org admin | yes | no | no |
| Approve or reject access requests | yes | no | no | no | no |
| Create, rename, suspend and reactivate organizations | yes | no | no | no | no |
| List organizations and people; read the audit log; sign a person out everywhere | yes | no | no | no | no |
| Delete a person’s Townwise records, or a suspended organization’s | yes | no | no | no | no |
| Start view-as | yes | no | no | no | no |
| End view-as | yes | yes | no | no | no |
| Two-step sign-in (kit `/auth/totp/*`) | required | not applicable | optional | optional | optional |

Rules behind the matrix:

- An organization always keeps at least one active org admin. Demoting, removing or leaving as the last one answers 409 `last_admin` and changes nothing, for org admins and staff alike, even when several of these run at once. A removal (leaving included) recounts when the seat was an org admin, or was being demoted at that moment: a demotion marks the seat (`demotingSince`) in the same write and clears the mark once its own recount or revert is done. So a member can leave, and staff can remove a member from, an organization with no active admin yet (staff created it and its admin hasn’t joined, or its approval found the requester seated elsewhere). A role change or removal of an invitation never counts, since it takes no active admin away. One exception: when the person took a seat in another organization before theirs could be put back, the removal stands and is answered as done.
- A staff address never resolves as a member, even when an organization invites it, because the staff check runs first.
- Staff see client sales figures and note text only through view-as. Member routes answer staff with 403 `no_access`. [CONFIRM: staff see values only through view-as]
- Removing someone does not sign them out. Their next member request answers 403 `no_access`, and `GET /api/me` says `removed`. [CONFIRM: no session revoke on removal] Staff can sign a person out on every device from People, which revokes every kit session and leaves their seat alone.
- Every staff action on an organization (its name, status, team, and each view-as) is recorded before it takes effect, and that organization’s admins read it as Townwise staff activity. [CONFIRM: show staff activity to org admins, with staff emails]
- One active organization per person, enforced by a unique index. Invitations are per organization, so two organizations may invite the same address, and no add result depends on another organization. [CONFIRM: one organization per person; per-organization invitations]

### Access states

`resolveAccess` (`src/access/resolve.ts`) decides who the caller is on every request, from the primary, in this order. It never writes, and nothing is cached. `GET /api/me` returns the result as `access`, for the client to route on `access.state`.

| `access.state` | When |
|---|---|
| `staff` | the current email is in `TOWNWISE_SUPERADMIN_EMAILS`, two-step sign-in is on, and this session passed a code at sign-in no more than 60 minutes ago |
| `staff_setup_required` | a staff address without two-step sign-in |
| `staff_reauth_required` | a staff session created before two-step sign-in was turned on (`session_before_codes`), or more than 60 minutes old (`session_too_old`) |
| `member` | an active seat in an active organization, with `org` and `role` |
| `org_suspended` | an active seat in a suspended organization |
| `invited` | open invitations for the current email in active organizations, each naming who added it; `pendingRequest` is set when the person also has a pending request |
| `pending` | a pending access request |
| `rejected`, `removed` | the newer of the latest rejected request and the latest removed seat; `removed.byYou` is true when the person removed themself |
| `no_org` | none of the above |

A signed-in person whose kit user no longer exists gets 401 `unauthenticated`. That is the only 401 Townwise code answers; every other denial is 403 or 404, because the client refreshes its session on any 401.

## Flows

### Sign-in

1. Google sign-in goes through the kit’s `/auth/google`. There is no sign-up step: the kit creates the user on first sign-in. The kit also mounts magic-link routes, but `src/email.ts` rejects every send, so `POST /auth/magic-link` answers 503 `email_unavailable`.
2. `GET /api/me` then answers the person’s access state. The portal pages that route on it (Waiting, No access, Joining, Request access and the rest) are not in this branch.

### Joining with an email an admin added

1. An org admin adds addresses (`POST /api/org/members`). Each becomes an invitation in that organization. No email is sent, in this flow or any other. [CONFIRM: no email in v1]
2. When that person continues with Google, `GET /api/me` answers `invited`, listing each invitation with the organization, the role and who added it.
3. `POST /api/me/join { inviteId }` claims the invitation by compare-and-set. It matches the invitation, the caller’s current email and an active organization, then withdraws any pending request of the caller. A second organization answers 409 `already_in_org`. `POST /api/me/decline { inviteId }` deletes the invitation instead.
4. The server never joins on a GET. The build spec has the client’s Joining page call join as soon as it loads, when there is one invitation and no pending request. [CONFIRM: auto-join without a click]

### Requesting access and approval

1. A person in `no_org`, `rejected` or `removed` sends `POST /api/access-requests`: organization name, their name and role, the town, the number of locations and an optional note. Each person has at most one pending request. Their state becomes `pending`.
2. Staff validate the person by hand, outside Townwise, for example by matching the email domain to the restaurant or by phone. [CONFIRM: what “validated manually” means]
3. Approve (`POST /api/admin/requests/:requestId/approve`) creates the organization, its first location in the requested town, and the requester’s org admin seat. A retry completes the work. If the requester is deleted while it runs (their request goes with them), the approval takes back what it made for them and answers 404 (Deletion). [CONFIRM: first location at approval]
4. Reject (`POST /api/admin/requests/:requestId/reject`) stores an optional message of up to 500 characters, which the requester sees. They may send a new request. [CONFIRM: rejected people may request again]
5. The requester sees the result at their next `GET /api/me`.

### Team

- An org admin adds up to 20 addresses at once, with a role (default member). [CONFIRM: role chosen at invite, default member] Each address is normalized as the kit does (trimmed, lowercased) and gets one result: `invited`, `already_invited`, `already_member` or `invalid`.
- An organization holds at most 200 people, active and invited (409 `member_limit`).
- Changing a role or removing someone uses change, recount, revert, so a demotion or removal never leaves an organization without an active admin, even when two run at once. A demotion recounts when the row was an active seat at its write, and marks the row until it is done, so a removal of that seat meanwhile recounts too; its revert matches the row by id, organization and the role it set, whatever its status, so a seat removed meanwhile gets its admin role back and that removal, finding no active admin, puts the seat back.
- Removing an invitation deletes it. Removing a member keeps the row as `removed`, for history and for the `removed` state.
- Anyone with a seat leaves with `POST /api/org/leave {}`, from Settings. It is a removal of oneself (`removed.byYou` is true), recorded as `member.left`. The body must be exactly `{}`.
- Staff edit any organization’s team from its console page (`/api/admin/orgs/:orgId/members`), with the same outcomes, caps and last-admin rule. Rows they add carry `addedByStaff`, which Team shows as added by Townwise staff.

### Staff organizations

1. `POST /api/admin/orgs { name, adminEmail, id? }` creates an active organization with no location and an `org_admin` invitation for that address, added by staff. That person joins as admin the next time they continue with Google. `id` is an optional 24-hex id the client generates once per new organization and sends again on a retry: a repeat answers 200 with the organization it made and writes no second `org.created`. It counts as a repeat only for an active organization this route made (no request) with the same name, whose team holds the same admin address, or nobody yet; any other organization with that `id` is 409 `conflict`. A repeat adds nothing, except the admin invitation when the organization has nobody yet (a create that stopped before it), and that invitation’s `member.invited` is written before it, as for a staff team edit. Two repeats racing past the check make one organization; the loser’s `org.created` is followed by `staff_action.not_applied` (`conflict`). [CONFIRM: staff can create organizations without a request]
2. `PATCH /api/admin/orgs/:orgId { name?, status? }` renames, suspends or reactivates. A value that already holds records nothing. Suspension keeps every record: members resolve to `org_suspended`, every member route answers them 403 `no_access`, and invitations into it are hidden. Reactivation restores access with no other step.
3. Each of these, and each staff team edit, writes its audit event before the change. A request with several changes (a name and a status, or several addresses) writes all its events first and then makes its changes in one write, so a refused event (503) never follows an applied change; an event already written when a later one is refused is followed by `staff_action.not_applied` (`unavailable`). The organization’s admins see all of them, and every view-as of their team, on `GET /api/org/staff-activity`.

### Deletion

Staff delete on request (the privacy page’s promise). Both actions write their audit event first, with ids only, then delete by filter, so a retry completes the work, then replace the email or names in older audit events. [CONFIRM: staff-only deletion in v1; suspend before deleting an organization]

- **An organization** (`DELETE /api/admin/orgs/:orgId`) must be suspended first (409 `org_not_suspended`). Its sales days, uploads, notes, tuning chat conversations, live turns and monthly chat usage, locations, every `tw_members` row and the request it was approved from are deleted, then the organization row last, and only while it is still suspended. One reactivated during the deletion keeps its row and answers 409 `org_not_suspended`, recorded as `staff_action.not_applied`; the records already deleted stay deleted, and suspending it and deleting again finishes the work. After the row goes, its sales days and chat usage are swept once more (counted in `deletedDays`), which catches what requests already running wrote after the first sweep. That narrows the gap without closing it: a tuning chat turn started before the suspension can still add chat usage for up to 150 seconds, an upload still running can write days after the second sweep, and its `tw_uploads` row, if written after the first sweep, is never swept. Such rows carry only the deleted organization’s id. In the audit log its name becomes “deleted organization” and its locations’ names “deleted location”, in its own events and in its request’s `access_request.created`. Former members resolve to `no_org`. View-as grants keep only ids. The client’s dialog asks for the typed name; the server checks only that the organization is suspended.
- **A person** (`POST /api/admin/people/delete { email }`, in the body because the URL is logged) must hold no active seat (409 `person_has_seat`: remove it first). A staff address is 400 `invalid_target`. An address with no kit user and nothing in Townwise, audit log included, is 404. Their access requests, open invitations in every organization, removed seats, and tuning chat conversations and live turns in every organization are deleted. Then the server checks for an active seat again: one taken meanwhile (a join, an approval) answers 409 `person_has_seat`, recorded as `staff_action.not_applied`, before any session is revoked or event redacted; the records already deleted stay deleted, and removing the seat and deleting again finishes the work. An approval that seats the person after that check reads the request again, finds it gone, and takes the seat back, with the organization and location made only for it (their names redacted as in an organization deletion), answering 404 with its approval recorded as not applied. Only a new invitation added after the deletion can still seat the person, which the runbook checks for. Otherwise, when a kit user exists, every session is revoked (`revokeAllSessions`) and the authenticator removed (`totp.remove`). In the audit log every address the person is known by becomes “deleted person” in `details.email`, in anyone’s events (other people’s `member.invited`, `member.role_changed`, `member.removed` and approval-time `member.joined` included): the current one, the addresses on their seats and requests, and those their own events and the events about their seats hold. Their email also goes from `actorEmail` and `targetEmail`, and events found by their user id lose whatever address they had then. Notes and uploads they wrote stay with their organization, shown as “Deleted person” once the kit user is gone.

**Runbook: delete the kit user record by hand.** The kit has no user delete (`../docs/portal/spec.md` Section 19, item 7), so the response’s `kitUserId` names a record that still exists. Only after the Townwise deletion answered 200, in the production database (Atlas), first confirm that no `tw_members` document has `activeUserId` equal to `kitUserId` (the person can still sign in until this step, so they may have joined an organization since; if so, remove that seat and run the deletion again). Then delete the `users` document whose `_id` is `ObjectId(kitUserId)`, then the `auth_sessions` documents whose `userId` is `ObjectId(kitUserId)` (all revoked by then). Their `auth_refresh_retired` entries hold no user id and expire on their own. Never delete a kit user first: an active seat must never outlive its user. Until this step is done, the person can still continue with Google, and resolves to `no_org`.

### Staff and two-step sign-in

1. A staff address first resolves to `staff_setup_required`. After turning on two-step sign-in in the kit (which signs out every other session), the same session resolves to `staff_reauth_required` until the person signs in again with a code.
2. From then on, every staff request needs a session that passed a code at sign-in no more than 60 minutes ago. `GET /api/me` returns the end of that window as `staff.verifiedUntil`. The kit exports no way to check a code per action, so the 60-minute window stands in for it. [CONFIRM: staff by config, TOTP read as a code at sign-in no more than 60 minutes ago]
3. Runbook: add a staff address only when that person will sign in and turn on two-step sign-in within minutes. Until they do, whoever controls that Google account could enroll an authenticator of their own. `GET /api/admin/people` shows each staff address’s two-step state.

### View-as

1. `POST /api/admin/view-as { userId, reason }`, with a reason of 5 to 200 characters. A staff target answers 400 `invalid_target`. The `view_as.started` audit event is written first; if that write fails, the answer is 503 and no grant exists.
2. The grant is bound to the staff member’s session. It lasts 30 minutes or until the staff window ends, whichever comes first (`viewAs.endsAt`). It also ends as soon as the target joins, leaves or changes organization. [CONFIRM: 30 minutes; any non-staff target]
3. While it is live, `GET /api/me` returns the target’s exact access with `viewAs` set. Every staff route except End answers 409 `view_as_active`, whatever its method. Every other write answers 403 `view_as_read_only`, and every other GET answers as the target. Each read logs `townwise.view_as_read { grantId, routeId }`, never the response. [CONFIRM: read-only, audited, no audit event per read]
4. `POST /api/admin/view-as/end {}` ends the grant and writes `view_as.ended`. With no grant it answers 200 and writes nothing.

### Sales upload

1. The upload carries only the date, guest count and net sales of each day, for one location: exactly `{ days: [{ date, guests, netSalesCents }] }`. In the build spec, the client parses the file in the browser, so the export itself never reaches the server; that upload page is not in this branch. [CONFIRM: browser-side parsing, three fields]
2. The server checks it strictly. Any other key, in the body or in a day, is 400 and nothing is written. It takes 1 to 3,660 days with unique dates, from 2010-01-01 to the server’s UTC date plus one day. Guests are a whole number from 0 to 20,000, or null. Net sales are whole cents from 0 to 100,000,000, or null. Each day needs at least one of the two. This route alone takes bodies up to 256 KB. [CONFIRM: ten years per upload; caps; earliest date]
3. An org admin’s upload replaces the days it covers. A member’s adds new days only and reports the days it left alone as `kept`. [CONFIRM: members add new days only]
4. Each stored day has exactly eight keys: `_id`, `orgId`, `locationId`, `date`, `guests`, `netSalesCents`, `uploadId` and `updatedAt`. The upload record holds counts and dates, never a file name. A crash leaves the record `applying`; sending the same days again is safe, because every day is an upsert.

### Notes (the tuning step)

- A note belongs to one location. Its kind is closure, private event, opening or other. It covers a date range of up to 366 days, optionally only certain weekdays, with an effect (closed, more guests, fewer guests, unknown), optional expected guests and a detail of up to 280 characters (required for other). [CONFIRM: notes first, AI chat later]
- Authors edit and delete their own notes; org admins edit and delete any. [CONFIRM: author or admin]
- Only the tuning chat reads notes yet (its `list_notes` tool, as data). The detail text never reaches a log or an audit event.

### Tuning chat

The build contract is `../docs/portal/tuning-chat.md`. A member chats with an assistant (Claude Opus 5.5 through the Anthropic API) about one location's demand. The assistant reads the location's sales coverage and totals, its daily rows, its notes and its town profile, and can propose a note. A proposal is a card in the client; **Add note** posts it to the notes route as the person, and nothing else writes a note.

- Off until `ANTHROPIC_API_KEY` is set: the GET answers `enabled: false`, a turn answers 503 `chat_unavailable`.
- Conversations are private to their author, per location. Staff in view-as read the target’s and cannot send.
- A turn streams over the POST (`text/event-stream`): `conversation` first, then `text`, `tool` and `proposal` events, then `done` (`end_turn`, `max_tokens`, `tool_limit`, `budget` or `refusal`, with `costUsd`) or `error` (`internal`, `provider_unavailable`, `provider_overloaded`, `timeout`). A comment line every 15 seconds keeps the ingress from closing an idle stream. At most 8 model calls per turn, and at most 5 tool calls run from one reply; the rest are answered as not run because the reply asked for too many at once.
- A whole turn is bounded at 150 seconds (the ingress closes a request at about 240): past it the provider call is aborted and the stream ends with `error` `timeout`.
- A person has at most one live turn per organization, in any conversation or location (`tw_chat_live_turns`, unique per person, claimed atomically): another POST meanwhile is 409 `chat_turn_in_progress`. The claim is released by its turn id however the turn ends, and one older than 3 minutes may be taken over.
- A turn is saved in one update when it finishes, under a compare-and-set on the conversation’s live-turn claim; a claim older than 3 minutes may be taken over. A failed, timed-out or refused turn, or one the client closed, saves nothing but its cost (a refusal still ends with `done` `refusal`), and a first turn that saved nothing deletes its conversation. Every stored message is the API message param exactly as sent or received, thinking blocks included, and history is append-only.
- Each organization has a monthly budget, `TOWNWISE_CHAT_MONTHLY_BUDGET_USD` (UTC calendar month), checked before a turn starts (409) and before every later model call in it; a budget spent mid-turn ends the turn with `done` `budget` after its last complete step, and the turn is saved. Cost is recorded after every model call from its token usage at list prices (`src/chat/pricing.ts`), so one call can overrun by its own cost. A call aborted or failed before its output usage arrived is charged an output estimate from what it streamed and how long it ran (`src/chat/turn.ts`).
- Message text, tool inputs and tool results never reach a log or an audit event.

### Calibration

Each location’s calibration state is derived from its sales days on every read and never stored. It is `no_sales_data`, or `not_calibrated` with the day count and first and last dates. No forecast, threshold or progress state exists. [DECISION NEEDED: minimum days of history before calibration]

### Audit and logs

- Every change writes an event to `tw_audit_events`, with details from a fixed allowlist per action (the table below, `AUDIT_DETAIL_KEYS` in `src/stores/audit-events.ts`). Events never hold guest or sales figures, note detail text, request notes, decision messages or file contents.
- Events for client actions (members, org admins and requesters) are written after the effect; a failed write is logged and the action stands. Staff events are written before the effect; a failed write refuses the action with 503, and an effect that then fails or is refused adds `staff_action.not_applied { eventId, code }`. Its code is the refusal’s error code (`request_not_pending`, `view_as_active`, `last_admin`, `already_invited`, `not_found`, `person_has_seat`, `org_not_suspended`), `conflict` when a concurrent change to the same row won, `unavailable` when a later event of the same request could not be written, or `internal` when the effect threw. The list is closed (`NOT_APPLIED_REASONS` in `src/audit.ts`, which also holds each code’s plain words). [CONFIRM: audit timing; events kept indefinitely]
- The only update to an event is deletion’s redaction; nothing deletes one.
- Org admins read their organization’s staff events (actor role `superadmin`), newest 50, as Townwise staff activity: `{ at, staffEmail, summary, viewAs, applied, notAppliedReason }`, where `viewAs` is `{ targetEmail, reason, endsAt }` on `view_as.started` only and `endsAt` is the grant’s scheduled end (an earlier end is its own `view_as.ended` row). A `staff_action.not_applied` event is never a row: the row it qualifies has `applied: false` and `notAppliedReason`, the code in plain words (for example “The organization needs at least one admin”); every other row has `applied: true` and `notAppliedReason: null`.

| Action | Details | Written |
|---|---|---|
| `access_request.created` | `orgName`, `townId`, `townName` | after, by the requester |
| `access_request.approved` | `orgId` | before, by staff |
| `access_request.rejected` | `hasMessage` | before, by staff |
| `access_request.withdrawn` | `reason` (`joined_org`) | after, on join |
| `org.created` | `name`, `via` (`request` or `staff`) | at approval, after its step; by `POST /api/admin/orgs`, before |
| `org.renamed` | `from`, `to` | after, by an org admin; before, by staff |
| `org.suspended`, `org.reactivated` | none | before, by staff |
| `org.deleted` | none | before, by staff |
| `member.invited` | `email`, `role` | after, by an org admin; before, by a staff team edit; after its step, for the first admin of an organization staff create |
| `member.declined` | `email` | after |
| `member.joined` | `email`, `role` | after, on join or at approval |
| `member.role_changed` | `email`, `from`, `to` | after, by an org admin; before, by staff |
| `member.removed` | `email`, `wasStatus` | after, by an org admin; before, by staff |
| `member.left` | `email` | after |
| `location.created`, `location.updated`, `location.deleted` | `name`, `townId` | after |
| `sales.uploaded` | `locationId`, `dayCount`, `inserted`, `replaced`, `firstDate`, `lastDate` | after |
| `sales.deleted` | `locationId`, `deletedDays` | after |
| `note.created`, `note.updated`, `note.deleted` | `locationId`, `kind`, `startDate`, `endDate` | after |
| `chat.turn_completed` | `locationId`, `conversationId`, `model`, `calls`, `inputTokens`, `outputTokens`, `stopReason` | after |
| `chat.conversation_deleted` | `locationId`, `conversationId` | after |
| `view_as.started` | `targetUserId`, `targetEmail`, `reason`, `expiresAt` | before, by staff |
| `view_as.ended` | `endReason` (`ended`, `replaced` or `expired`) | after the grant is cleared |
| `people.signed_out_everywhere` | none (the event’s `orgId` is the person’s organization, or null) | before, by staff |
| `person.deleted` | `userId` (null for an address that never signed in) | before, by staff |
| `staff_action.not_applied` | `eventId`, `code` | after a staff effect fails or is refused |
- Townwise log lines carry ids and counts only: `townwise.access_denied { policy, code }`, `townwise.view_as_read { grantId, routeId }`, `townwise.upload_applied { orgId, locationId, uploadId, dayCount }`, `townwise.audit_write_failed { action, orgId, targetId }`, and for the tuning chat `townwise.chat_turn`, `townwise.chat_turn_failed`, `townwise.chat_turn_aborted` and `townwise.chat_turn_not_saved` (`{ orgId, locationId, conversationId, calls, costMicroUsd }` with the stop reason, or the code and error class; `timeout` has no error class), and `townwise.chat_live_turn_not_released` (`{ orgId, locationId, errType }`). No route puts an email, a name or a figure in its path or query, because server-core logs the URL. The one exception is the people lookup’s `q`, which server-core redacts.

## Endpoints

Every route is JSON under `/api` and runs one chain, built from the table in `src/access/routes.ts`:

1. The kit’s `requireAuth` (401 `unauthenticated`).
2. The `townwise:writes` limiter, for every method but GET, before anything is read.
3. `resolveAccess`.
4. The view-as guard.
5. The route’s policy.
6. The body parser: 32 KB, or 256 KB on the upload route; none on GET and DELETE. It runs after the policy, so a refused request is never parsed.
7. The route’s own limiter, if it has one.
8. The handler.

Policies:

- `signed_in`: anyone signed in.
- `member`: an active seat in an active organization; anyone else gets 403 `no_access`.
- `org_admin`: a member whose role is `org_admin`; a member gets 403 `forbidden`, anyone else 403 `no_access`.
- `staff`: a staff address that passes the two-step gate. A staff address that fails it gets 403 `staff_setup_required` or `staff_reauth_required`; anyone else gets 403 `forbidden`.
- `staff_self`: the signed-in staff member’s own gate, which also passes during view-as. Only view-as End uses it.

Member routes take the organization from the caller’s own seat, never from the request. A location, note or member id from another organization answers 404, exactly like an unknown id. A malformed id is 400. Error bodies are the kit’s `{ error, message, retryAfterSeconds? }`, and a failed validation is 400 `invalid_request` with no field details.

### Access

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `GET /api/me` | signed_in | | 200 `{ user, access, viewAs, staff }` | |
| `POST /api/me/join` | signed_in | `{ inviteId }` | 200, as `GET /api/me` | 403 `forbidden` (staff); 409 `no_invite`, `already_in_org` |
| `POST /api/me/decline` | signed_in | `{ inviteId }` | 200, as `GET /api/me` | 403 `forbidden` (staff); 409 `no_invite` |
| `POST /api/access-requests` | signed_in; limiter `requests` | `{ orgName, contactName, contactRole, town, locationCount, note? }` | 201, as `GET /api/me` (`pending`) | 403 `forbidden` (staff, or any state but `no_org`, `rejected`, `removed`); 409 `request_exists`; 400 `unknown_town` |
| `GET /api/towns/:townId` | signed_in | | 200 `{ profile }` | 404 |

`user` is always the signed-in person, the staff member during view-as. `town` is `{ townId }` for one of the twelve researched towns (`src/towns.ts`), or `{ townId: null, name, state }` for another town, with a two-letter US state code. A town profile is public data: the county’s 2024 food-service employment pattern (BLS QCEW) against the Northeast, drivers and key dates with sources, and caveats. `src/town-profiles.ts` is a generated copy of the homepage’s town data; its header names the generator, which is not in this repo.

### Organization and locations

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `GET /api/org` | member | | 200 `{ org, role, locations, requestedLocationCount }` | |
| `PATCH /api/org` | org_admin | `{ name }`, 2 to 120 characters | 200 `{ org }` | 400 |
| `GET /api/org/staff-activity` | org_admin | | 200 `{ events }`, the newest 50 staff actions on this organization, each marked `applied` (see Audit and logs) | |
| `POST /api/org/leave` | member | `{}` exactly | 200, as `GET /api/me` (`removed`, `byYou`) | 400; 409 `last_admin` |
| `POST /api/org/locations` | org_admin | `{ name, town }` | 201 `{ location }` | 409 `location_name_taken`, `location_limit`; 400 `unknown_town` |
| `PATCH /api/org/locations/:locationId` | org_admin | `{ name?, town? }`, at least one | 200 `{ location }` | 404; 409 `location_name_taken`; 400 `unknown_town` |
| `DELETE /api/org/locations/:locationId` | org_admin | | 204 | 404; 409 `location_has_data` (any sales day or note) |

Each location is `{ id, name, town, coverage, calibration, notesCount, lastUploadAt }`. An organization holds at most 25 locations. [CONFIRM: 25 locations]

### Sales

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/sales` | member | | 200 `{ coverage, calibration, months, uploads }` (newest 20 uploads) | 404 |
| `GET /api/org/locations/:locationId/sales/days?from=&to=` | member | `YYYY-MM-DD` dates, at most 366 days inclusive | 200 `{ days }` | 400; 404 |
| `POST /api/org/locations/:locationId/sales/uploads` | member; 256 KB; limiter `uploads` | `{ days }` (see Sales upload) | 201 `{ upload, coverage, calibration }` | 400; 404; 413; 429 |
| `DELETE /api/org/locations/:locationId/sales` | org_admin | | 200 `{ deletedDays, deletedUploads }` | 404 |

### Notes

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/notes` | member | | 200 `{ notes }`, by start date, each with `createdByEmail` and `canEdit` | 404 |
| `POST /api/org/locations/:locationId/notes` | member | note | 201 `{ note }` | 404; 409 `note_limit` |
| `PATCH /api/org/locations/:locationId/notes/:noteId` | member (author or org admin) | note (full replace) | 200 `{ note }` | 403 `forbidden`; 404 |
| `DELETE /api/org/locations/:locationId/notes/:noteId` | member (author or org admin) | | 204 | 403 `forbidden`; 404 |

A note is `{ kind, startDate, endDate, weekdays, effect, expectedGuests, detail }`. A location holds at most 1,000 notes. [CONFIRM: 1,000 notes]

### Team

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `GET /api/org/members` | org_admin | | 200 `{ members }` (active and invited) | |
| `POST /api/org/members` | org_admin | `{ emails, role? }`, 1 to 20 emails | 200 `{ results, members }` | 409 `member_limit` |
| `PATCH /api/org/members/:memberId` | org_admin | `{ role }` | 200 `{ member }` | 404; 409 `last_admin` |
| `DELETE /api/org/members/:memberId` | org_admin | | 204 | 404; 409 `last_admin` |

### Staff console

Policy `staff`, except End. During view-as, every route here answers 409 `view_as_active`, except End.

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /api/admin/requests?status=` | `pending` (default), `approved`, `rejected` or `withdrawn` | 200 `{ requests, pendingCount }` | 400 |
| `POST /api/admin/requests/:requestId/approve` | `{ orgName, locationName }` | 200 `{ org, request }` | 404; 409 `request_not_pending`, `requester_has_org`; 503 |
| `POST /api/admin/requests/:requestId/reject` | `{ message? }` | 200 `{ request }` | 404; 409 `request_not_pending`; 503 |
| `GET /api/admin/orgs` | | 200 `{ orgs }`, each with team, location, sales-day counts and the last upload time | |
| `POST /api/admin/orgs` | `{ name, adminEmail, id? }`, `id` a client-generated 24-hex id | 201 `{ org: { id, name }, result }`, the admin invitation’s add result; 200, the same shape, for a repeat of that `id` | 400; 409 `conflict` (the `id` names another organization); 503 |
| `GET /api/admin/orgs/:orgId` | | 200 `{ org, members, locations, recent }`: the team, each location’s coverage and counts, and the newest 20 audit events | 400; 404 |
| `PATCH /api/admin/orgs/:orgId` | `{ name?, status? }`, at least one; status `active` or `suspended` | 200 `{ org }`, as in the detail | 400; 404; 503 |
| `DELETE /api/admin/orgs/:orgId` | | 200 `{ deletedDays, deletedUploads, deletedNotes, deletedLocations, deletedSeats, redactedEvents }` | 400; 404; 409 `org_not_suspended` (also when reactivated during the deletion); 503 |
| `POST /api/admin/orgs/:orgId/members` | `{ emails, role? }`, as on Team | 200 `{ results, members }` | 400; 404; 409 `member_limit`; 503 |
| `PATCH /api/admin/orgs/:orgId/members/:memberId` | `{ role }` | 200 `{ member }` | 400; 404; 409 `last_admin`; 503 |
| `DELETE /api/admin/orgs/:orgId/members/:memberId` | | 204 | 400; 404; 409 `last_admin`; 503 |
| `GET /api/admin/people?kind=` | | 200 `{ people, truncated }`, up to 1,000 | 400 |
| `GET /api/admin/people/lookup?q=` | an exact email | 200 `{ person }`, or `{ person: null }` | 400 |
| `POST /api/admin/people/:userId/sign-out-everywhere` | `{}` | 200 `{ revoked }`, the sessions revoked | 400 `invalid_target` (staff); 404; 503 |
| `POST /api/admin/people/delete` | `{ email }` | 200 `{ deletedRequests, deletedSeats, redactedEvents, kitUserId }` | 400 `invalid_target` (staff); 404; 409 `person_has_seat` (also for a seat taken during the deletion); 503 |
| `GET /api/admin/audit?orgId=&actorUserId=&action=&before=&limit=` | `limit` 1 to 200, default 50 | 200 `{ events, nextBefore }` | 400 |
| `POST /api/admin/view-as` (limiter `view-as`) | `{ userId, reason }` | 201, as `GET /api/me`, with `viewAs` set | 400 `invalid_target`; 404; 409 `view_as_active`; 429; 503 |
| `POST /api/admin/view-as/end` (policy `staff_self`) | `{}` | 200, as `GET /api/me` | |

The console never returns sales figures or note text. People come only from Townwise records, `TOWNWISE_SUPERADMIN_EMAILS` and the kit’s exact-email lookup; the kit’s collections are never read directly. Organization and team changes, sign out everywhere and deletion are staff actions (see Audit and logs), and deletion is described under Deletion, with its runbook step.

### Tuning chat

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/chat` | member | | 200 `{ enabled, budget, conversations }` (the caller’s own, newest 50) | 404 |
| `GET /api/org/locations/:locationId/chat/:conversationId` | member (author) | | 200 `{ id, title, updatedAt, messages }` | 400; 404 |
| `POST /api/org/locations/:locationId/chat/turns` | member; limiter `chat` | `{ conversationId?, content }`, content 1 to 4,000 characters | 200 `text/event-stream` | 400; 404; 409 `chat_turn_in_progress`, `conversation_full`, `chat_budget_exhausted`; 429; 503 `chat_unavailable` |
| `DELETE /api/org/locations/:locationId/chat/:conversationId` | member (author) | | 204 | 400; 404 |

`budget` is `{ month, usedUsd, limitUsd, exhausted }`. Each conversation is `{ id, title, updatedAt, turnCount }`; its `messages` are `{ role, text, proposals, at }`, one per message with text or a proposal, never thinking blocks, tool calls or tool results. A proposal is exactly a note (the notes route’s body). Another person’s conversation, or one from another location, is 404. A conversation holds at most 40 turns or 1.5 MB of stored messages (409 `conversation_full`). `chat_turn_in_progress` means the caller already has a live turn in this organization, in any conversation or location.

### Rate limits

| Name | Applies to | Limit | When Redis is down |
|---|---|---|---|
| `app:api-ceiling` | every request, per IP (`src/main.ts`) | 2,000 per minute | allow |
| `townwise:writes` | every `/api` route but GET, per account | 300 per 10 minutes | allow |
| `townwise:uploads` | the upload route, per account | 30 per hour | allow |
| `townwise:requests` | `POST /api/access-requests`, per account | 5 per day | deny (503 `unavailable`) |
| `townwise:view-as` | `POST /api/admin/view-as`, per account | 20 per hour | deny (503 `unavailable`) |
| `townwise:chat` | `POST /api/org/locations/:locationId/chat/turns`, per account | 60 per hour | deny (503 `unavailable`) |

A refused request is 429 `rate_limited` with `retryAfterSeconds`. Account keys are `acct:<userId>`, which the rate-limit module hashes before storing. [CONFIRM: limits]

### Not built yet

These are in the build specs and have no server code yet:

- In the tuning chat (`../docs/portal/tuning-chat.md`): background turns and resumable streams, message trees, regenerate and edit, history compaction, attachments, memory and voice.

## Data

Every Townwise collection takes the `tw_` prefix. Every tenant document carries `orgId`, and tenant store functions (`src/stores/`) take an `OrgScope` that only `src/access/policy.ts` can mint. Lookups keyed by a person, or spanning organizations, live in `src/stores/cross-tenant.ts`, and a test pins which files import it.

| Collection | Holds |
|---|---|
| `tw_orgs` | name, status, who created it and from which request |
| `tw_members` | invitations and seats in one collection: email, role, status, who added it and when |
| `tw_access_requests` | the request form, its status and the decision message |
| `tw_locations` | name and town |
| `tw_sales_days` | date, guests and net sales in cents per location per day, and nothing else |
| `tw_uploads` | per upload: counts, first and last dates, and who sent it; never a file name |
| `tw_notes` | the note’s fields and the author’s user id |
| `tw_view_as_grants` | staff member and session, target, organization, reason, start and end |
| `tw_audit_events` | who did what, with allowlisted details |
| `tw_chat_conversations` | per author and location: the title, every API message param of the conversation as JSON with its time, the turn count and the live-turn claim |
| `tw_chat_live_turns` | per organization and person: the one live tuning chat turn’s id and start time |
| `tw_chat_usage` | per organization and UTC month: the tuning chat’s cost in whole micro-dollars |

Townwise reads the kit’s data only through its store functions (`users.findById`, `users.findByEmail`, `totp.get`), and changes it only through `totp.remove` and the kit’s `revokeAllSessions`, for sign out everywhere and person deletion. Deleting a kit user is a runbook step (Deletion).

## Environment variables

`src/main.ts` is the only file that reads `process.env`. It spreads each module’s schema into one `loadEnv` call, which treats an empty value as unset and never prints values in its errors.

| Name | From | Required | Secret | Local value, or rule |
|---|---|---|---|---|
| `NODE_ENV` | server-core | yes | no | `development`; every deployed environment is `production` |
| `PORT` | server-core | no | no | `8080` |
| `LOG_LEVEL` | server-core | no | no | `info` |
| `CORS_ORIGINS` | server-core | no | no | `http://localhost:8081`, the Expo web client |
| `TRUST_PROXY` | server-core | yes | no | `loopback` locally; when deployed, only the addresses of the proxy in front of the app (`kit/server-core/MODULE.md`) |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | server-core | no | no | `65000` |
| `SHUTDOWN_TIMEOUT_MS` | server-core | no | no | `25000` |
| `MONGODB_URI` | mongo | yes | yes | `mongodb://localhost:27017/townwise` |
| `REDIS_URL` | redis | yes | yes | `redis://localhost:6379`; production requires `rediss:` |
| `REDIS_KEY_PREFIX` | redis | yes | no | `townwise:` |
| `AUTH_ISSUER` | auth | yes | no | `http://localhost:8080`, a bare origin |
| `AUTH_JWT_KEYS` | auth | yes | yes | `kid:base64` entries, first one current; generated locally as in Run locally |
| `AUTH_ENCRYPTION_KEYS` | auth | yes | yes | `kid:base64` entries of 32-byte keys; they encrypt authenticator secrets |
| `AUTH_MAGIC_LINK_URL` | auth | yes | no | `http://localhost:8081/auth/magic`; the kit requires it, though Townwise sends no magic links |
| `AUTH_TOTP_ISSUER` | auth | yes | no | `Townwise` |
| `AUTH_GOOGLE_CLIENT_IDS` | auth | no | no | Google OAuth web client ids, comma-separated; empty turns Google sign-in off |
| `TOWNWISE_SUPERADMIN_EMAILS` | api (`src/config.ts`) | in production | no | staff addresses, comma-separated, at most 20, normalized like the kit; empty locally [CONFIRM: production refuses an empty list] |
| `TOWNWISE_CHAT_MONTHLY_BUDGET_USD` | api (`src/config.ts`) | no | no | `20`: the tuning chat’s monthly spend limit per organization, in dollars, 0 to 10,000 |
| `ANTHROPIC_API_KEY` | api (`src/main.ts`) | no | yes | empty locally, which turns the tuning chat off; in production a Key Vault reference when `enable_chat` is on (`../infra/README.md`, step 16) |

`.env.example` lists every variable above except `LOG_LEVEL`, `HTTP_KEEP_ALIVE_TIMEOUT_MS` and `SHUTDOWN_TIMEOUT_MS`, which take their defaults. It holds local values and placeholders only: the two key rings, the Google client ids, the staff list and the Anthropic key are empty. Key rotation for the two key rings is in `kit/auth/MODULE.md`.

## Kit modules

The code under `kit/` is ours to own. Record any change under `## Local changes` in that module's `MODULE.md` with the test that pins it. To take a kit fix: in a camkeith/modules clone, `git diff <commit in KIT.md> <new commit> -- backend/<name>`, apply it here, run `npm run verify`, and update the line in `KIT.md`.
