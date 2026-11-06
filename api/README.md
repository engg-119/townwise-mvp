# api

Townwise backend: one Node process (`src/main.ts`) composed from the kit modules in `kit/` (copied from camkeith/modules; versions in `../KIT.md`). Sign-in is Google only.

It mounts two routers. The kit’s `/auth` handles sign-in, sessions and two-step sign-in. Townwise’s `/api` (`src/app.ts`, routes in `src/access/routes.ts`) handles access, the Places search, organizations, locations, sales data, notes, the tuning chat, the team and the staff console. No kit file is changed; all Townwise code is under `api/`. "The build spec" and "spec Section N" in this README and in code comments mean `../docs/portal/spec.md`.

## Run locally

Needs Node 24 (`nvm use` reads `.nvmrc`) and Docker. From the repo root:

```sh
nvm use
npm install
docker compose up -d    # Mongo on 27017, Valkey (Redis) on 6379, Azurite (blobs) on 10000; stop a local mongod first if 27017 is taken
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

1. An org admin adds addresses (`POST /api/org/members`). Each becomes an invitation in that organization. Townwise sends no email for invitations; its only emails are the two in Email below (spec D14).
2. When that person continues with Google, `GET /api/me` answers `invited`, listing each invitation with the organization, the role and who added it.
3. `POST /api/me/join { inviteId }` claims the invitation by compare-and-set. It matches the invitation, the caller’s current email and an active organization, then withdraws any pending request of the caller. A second organization answers 409 `already_in_org`. `POST /api/me/decline { inviteId }` deletes the invitation instead.
4. The server never joins on a GET. The build spec has the client’s Joining page call join as soon as it loads, when there is one invitation and no pending request. [CONFIRM: auto-join without a click]

### Requesting access and approval

1. A person in `no_org`, `rejected` or `removed` sends `POST /api/access-requests`: organization name, their name and role, the town, the number of locations, an optional note and an optional Google place id (`placeId`, from the Places search). Each person has at most one pending request. Their state becomes `pending`.
2. Staff validate the person by hand, outside Townwise, for example by matching the email domain to the restaurant or by phone. [CONFIRM: what “validated manually” means]
3. Approve (`POST /api/admin/requests/:requestId/approve`) creates the organization, its first location in the requested town (with the request’s `placeId`, or none), and the requester’s org admin seat. A retry completes the work. If the requester is deleted while it runs (their request goes with them), the approval takes back what it made for them and answers 404 (Deletion). [CONFIRM: first location at approval] [CONFIRM: a request keeps the place the requester picked; staff check it by hand]
4. Reject (`POST /api/admin/requests/:requestId/reject`) stores an optional message of up to 500 characters, which the requester sees. They may send a new request. [CONFIRM: rejected people may request again]
5. The requester sees the result at their next `GET /api/me`. While they have not seen it and the organization has no sales day, that answer also carries `welcome: { firstName, restaurant }` for the welcome statement (`../docs/portal/spec.md` 15.8): `firstName` is the first word of the name on their request, or null for an honorific (`Mr`, `Mrs`, `Ms`, `Mx`, `Dr`, `Prof`), an initial or a word over 40 characters; `restaurant` is the organization’s current name. The client records that it showed it with `POST /api/me/welcome`, and from then on `welcome` is null on every device. Invited teammates, admins of organizations staff created, and staff in view-as never get one. [CONFIRM: welcome for the requester only]

### Email

Townwise sends two emails (spec D14), each only to the person it concerns, from `no-reply@townwise.tech` through Azure Communication Services:

| Email | When | To |
|---|---|---|
| Request received | `POST /api/access-requests` stored the request and its `access_request.created` (201) | the caller’s current address |
| You’re in | the approval call that inserts the requester’s admin seat, after `member.joined` | the requester’s current address, read at the start of that call |

- Nothing else sends email: invitations, staff-created organizations, joins, rejections, removals, view-as and deletion send none, and the kit’s magic-link route still answers 503. A 400, 403, 409 or 429 sends nothing, and so do an approval retry that finds the seat already there, a losing concurrent approval and an approval undone by the requester’s deletion.
- The send is queued after the write and the response does not wait for it. A failure never fails, delays or retries the action: it is logged and the email is lost. So is a send still in flight when the process stops (the shutdown drain waits 2 seconds).
- The words are in `src/mail/templates.ts` and the layout in `src/mail/layout.ts`: fixed subjects, no greeting by name, no images or tracking (`userEngagementTrackingDisabled` on every message), and links only to `TOWNWISE_WEB_URL`. An email carries the organization’s name, its town and the address the person signs in with, never a figure, a file or a note. Reply-To is `TOWNWISE_EMAIL_REPLY_TO` when it is set.
- `src/mail/acs.ts` calls Email - Send (`2023-03-31`) over `fetch` with an Entra token for `https://communication.azure.com` from the managed identity (`src/azure-identity.ts`: the user-assigned identity named by `AZURE_CLIENT_ID`, cached until 5 minutes before it expires). Access keys are disabled on the resource. Any refusal drops the cached token.
- Off while `EMAIL_ENDPOINT` is unset, as it is locally and, until the release that changes the waiting and approval screens, in production (`../infra/README.md`, step 9). Nothing about a send is stored, and it writes no audit event.

### Places search

The access request can start by finding the business on Google Places (New). The API calls Google Places itself, so the search goes only to the API. The one exception is the confirm card's map, an image the browser loads straight from Google (below), which is why the web CSP's `img-src` allows `https://maps.googleapis.com`.

- Off until `GOOGLE_PLACES_API_KEY` is set: both routes answer 503 `places_unavailable` to every request, and the client shows the manual fields. Google failing, or not answering within 5 seconds, also answers 503 `places_unavailable`.
- The client sends `POST /api/places/autocomplete` as the person types (debounced, 2 characters or more), then `POST /api/places/details` for the suggestion they pick. Both carry the same session token, a version 4 UUID the client makes once per search; Google bills the typing and the pick as one session, and the details call ends it. Without a token, autocomplete makes one and returns it, for the client to send from then on. The server checks only the token's format and keeps no record of it.
- Autocomplete asks Google for US results in English, of any business type, and answers up to 5 place suggestions (`name` is Google's main text, `detail` its secondary text, such as "Hanover, NH, USA").
- Details asks for the place's id, formatted address and address components only (`X-Goog-FieldMask: id,formattedAddress,addressComponents`). `address` is for display; the client keeps the name from the suggestion it picked.
- `town` is a `TownInput` the access request accepts unchanged. It is one of the twelve researched towns when the locality, postal town, sublocality or `administrative_area_level_3` (town or township) matches one by name and state, ignoring case, or when any of them is an alias: Lake Placid, NY is `north-elba-ny` and North Conway, NH is `conway-nh`. Otherwise it is `{ townId: null, name, state }`, named by the first of those components. It is null when the place is outside the 50 states and DC (a territory included: its country component is not `US`, or its state is not in the fixed list), or has no usable town name.
- Details also answers `map`: a dark Google Maps Static image of the place with a mint pin, as `{ url, width: 640, height: 320 }` (drawn at scale 2, 1280 by 640 pixels; the client sizes it by the 2:1 ratio). `url` is a `https://maps.googleapis.com/maps/api/staticmap` URL for Google's current id of the place, signed by the API with `GOOGLE_MAPS_SIGNING_SECRET` (`src/places/static-map.ts`), and the browser or the native app loads it from Google, which sees the viewer's IP address. The API never fetches, relays or keeps the image. The URL holds `GOOGLE_MAPS_STATIC_KEY`, a key of its own restricted to the Maps Static API with unsigned requests refused (`../infra/README.md`, step 17), so the key alone draws nothing. `map` is null while the map is off (either variable unset); a map URL is never made unsigned. Signing is local, so the map never fails or delays the answer.
- Nothing from these routes is stored. The typed text, place ids, addresses, Google's answers and the signed map URL never reach a log or an audit event; a Google failure logs `townwise.places_failed` with the route id and a code. [CONFIRM: the town matching rules, which are not yet checked against live Google answers]

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

- **An organization** (`DELETE /api/admin/orgs/:orgId`) must be suspended first (409 `org_not_suspended`). Its sales days, uploads, notes, tuning chat conversations, live turns, monthly chat usage and proposal records, answers to TownwiseAI’s questions, welcome markers, forecast runs and their rows (U13B), locations, every `tw_members` row and the request it was approved from are deleted, then the organization row last, and only while it is still suspended. One reactivated during the deletion keeps its row and answers 409 `org_not_suspended`, recorded as `staff_action.not_applied`; the records already deleted stay deleted, and suspending it and deleting again finishes the work. After the row goes, its sales days and chat usage are swept once more (counted in `deletedDays`), which catches what requests already running wrote after the first sweep. That narrows the gap without closing it: a tuning chat turn started before the suspension can still add chat usage for up to 150 seconds, an upload still running can write days after the second sweep, and its `tw_uploads` row, if written after the first sweep, is never swept. Such rows carry only the deleted organization’s id. In the audit log its name becomes “deleted organization” and its locations’ names “deleted location”, in its own events and in its request’s `access_request.created`. Former members resolve to `no_org`. View-as grants keep only ids. The client’s dialog asks for the typed name; the server checks only that the organization is suspended.
- **Stored files of an organization** go first in its deletion, before any other record: its imports, unfinished uploads (their staged chunks discarded), every blob under its id in both containers, its entry lists, file records, daily upload counters and AI spend. When stored files are off but it has files, nothing is deleted and the answer is 503 `files_unavailable`, recorded as `staff_action.not_applied`. They are swept again after the organization row goes.
- **An organization's originals** (`POST /api/admin/orgs/:orgId/originals/delete { basis }`), for a person's deletion request about someone named inside an export (a diner, a server): their details exist only in the original files (and possibly a file's name, a ZIP's entry paths or a workbook's sheet names), never in the cleaned copies, the rest of the reports or the days, so staff delete every original without reading any. `basis` is an enum, never free text; the event `org.originals_deleted { count, basis }` is written first and shows in the organization's staff activity. A file not read yet (stored, queued, or waiting on a question, which is dropped) is kept unread with `raw_deleted` and its original deleted at once; a file still uploading or being read is flagged (`purgeRaw`), never read afterwards, and its original goes as soon as the upload or the read ends (the daily sweep finishes any the reader missed). `skippedBusy` counts the flagged ones. Each name becomes the kind's label, a workbook's sheet names in its report become `Sheet 1`, `Sheet 2` and so on, and a ZIP's entry paths are cleared.
- **A person** (`POST /api/admin/people/delete { email }`, in the body because the URL is logged) must hold no active seat (409 `person_has_seat`: remove it first). A staff address is 400 `invalid_target`. An address with no kit user and nothing in Townwise, audit log included, is 404. Their access requests, open invitations in every organization, removed seats, and tuning chat conversations, live turns, proposal records and welcome markers in every organization are deleted (answers to TownwiseAI’s questions hold no person id, so none is theirs), and their staff id is cleared from the forecast runs they imported or published (U13B). Then the server checks for an active seat again: one taken meanwhile (a join, an approval) answers 409 `person_has_seat`, recorded as `staff_action.not_applied`, before any session is revoked or event redacted; the records already deleted stay deleted, and removing the seat and deleting again finishes the work. An approval that seats the person after that check reads the request again, finds it gone, and takes the seat back, with the organization and location made only for it (their names redacted as in an organization deletion), answering 404 with its approval recorded as not applied. Only a new invitation added after the deletion can still seat the person, which the runbook checks for. Otherwise, when a kit user exists, every session is revoked (`revokeAllSessions`) and the authenticator removed (`totp.remove`). In the audit log every address the person is known by becomes “deleted person” in `details.email`, in anyone’s events (other people’s `member.invited`, `member.role_changed`, `member.removed` and approval-time `member.joined` included): the current one, the addresses on their seats and requests, and those their own events and the events about their seats hold. Their email also goes from `actorEmail` and `targetEmail`, and events found by their user id lose whatever address they had then. Notes and uploads they wrote stay with their organization, shown as “Deleted person” once the kit user is gone.

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

1. The upload carries only the date, guest count and net sales of each day, for one location: exactly `{ days: [{ date, guests, netSalesCents }] }`. The client parses the file in the browser, so on this path the export itself never reaches the server. Stored files (below) are the other path. [CONFIRM: browser-side parsing, three fields]
2. The server checks it strictly. Any other key, in the body or in a day, is 400 and nothing is written. It takes 1 to 3,660 days with unique dates, from 2010-01-01 to the server’s UTC date plus one day. Guests are a whole number from 0 to 20,000, or null. Net sales are whole cents from 0 to 100,000,000, or null. Each day needs at least one of the two. This route alone takes bodies up to 256 KB. [CONFIRM: ten years per upload; caps; earliest date]
3. An org admin’s upload replaces the days it covers. A member’s adds new days only and reports the days it left alone as `kept`. [CONFIRM: members add new days only]
4. Each stored day has exactly eight keys: `_id`, `orgId`, `locationId`, `date`, `guests`, `netSalesCents`, `uploadId` and `updatedAt`. The upload record holds counts and dates, never a file name. A crash leaves the record `applying`; sending the same days again is safe, because every day is an upsert.

### Stored files and the file reader

The other way in for sales history (spec 11A): a person drops their exports as they are, and Townwise reads them on the server. Off until `FILES_BLOB_ACCOUNT_URL` is set (every route below answers 503 `files_unavailable`), so the browser upload above stays as the fallback and as the choice to send only daily totals. [CONFIRM: every cap and limit below]

1. **Upload, in chunks.** `POST /files { name, sizeBytes, purpose: 'history' }` opens an upload session in the location's active import (one per location; the first drop creates it, `open`) and answers with the caps (`limits`). The browser sends each 8 MiB chunk as `PUT /files/:fileId/chunks/:index` with an exact `Content-Length`; the API streams it through a hashing Transform into Azure's Put Block, so no request holds a file, and a dropped connection retries one chunk. `POST /files/:fileId/complete` commits the chunks, tells the kind from the extension and first bytes, and drops a second copy of a file already stored for the location (409 `file_duplicate`). Caps: 200 MiB a file, 50 files an import, 500 a location, 10 uploading at once in a location, 5 GiB stored and 2 GiB uploaded a UTC day per organization. An upload session past its 24 hours counts toward none of them. A replica takes 12 chunk streams at once; the 13th answers 503 `uploads_busy` with `Retry-After: 2`.
2. **No file is refused for its type.** CSV, TSV and text files, Excel workbooks (.xlsx, .xlsm), PDFs, Word documents (.docx) and ZIP archives are read. Old Excel (.xls) and Word (.doc), Numbers files, password-protected Office files, images and anything else are kept and say why.
3. **Read my history.** `POST /imports/:importId/start` queues every stored file; files that complete later are queued too. The file reader runs in each API replica (`src/files/worker.ts`): it claims the oldest started import under a 90-second lease (renewed every 30 seconds, taken over when a replica stops), reads its files one at a time in upload order, and skips a suspended organization's. Each file is read in a worker thread with 192 MiB of heap and 20 minutes; past either it is kept as `too_complex`, and the API carries on. Text is streamed twice (the first pass finds the header row under any title block, profiles every column and proves the date order; the second adds rows up per date), in UTF-8, UTF-16 or windows-1252.
4. **Rules first, then the person.** The reader's column logic is the browser's (`src/files/parse/` ports `client/src/portal/upload/`, held to the same fixtures), with longer header guess lists [CONFIRM: header guesses]. What the rules cannot settle (two date columns, an unproven date order, which columns are guests and net sales, which location value is this location, what one row is) becomes one question on the import, whose options are header names or the location column's values, never other cells. The import waits; `POST /imports/:importId/answer { questionId, choice }` stores the answer on the file and reads it again, and "not sure" keeps it as `needs_help`.
   - **AI for columns, only when the rules find no guests or net sales column.** With `ANTHROPIC_API_KEY` set, the reader asks Claude Opus 5.5 (`src/files/extract/`) to name them from a redacted profile: header text (40 characters at most), each column's kind of value and rough shape, and up to 15 rows of value tokens such as `<int>` or `<text>`. Never a row, a figure, a file name, a ZIP entry path or the restaurant's name. A confident choice is applied (reported as `ai`), an unsure one is suggested in the question. Each answer is saved on the file, so a re-read after a later question reuses it without another call. At most 2 calls a file, 5 a ZIP, 20 an import, and `TOWNWISE_FILES_MONTHLY_BUDGET_USD` an organization a month (`tw_files_usage`); off, spent or failed, the person is asked.
   - **PDFs** are read with `unpdf` in the worker thread (no fonts loaded, nothing rendered): a table starts at a line holding a date header and a guests or net sales header, its column bands come from those headers' positions, and a "total" line ends it. **Word** tables (`w:tbl`) are read with `saxen`. Text outside tables is never read into a row.
   - **ZIP archives** are read in place by ranged reads (never downloaded whole), after guards on the central directory: 20,000 entries, 2 GiB declared, 100 to 1, no overlapping entries, a ZIP inside a ZIP opened up to 50 MiB and none deeper; an entry that inflates past its declared size distrusts the whole archive. Each entry is a file of its own, listed in `tw_file_entries` with what became of it. Tables with the same header are one family, decided once and added up together; when two families cover the same days, only the higher-ranked one counts.
5. **Days, a cleaned copy and a report.** A read file's days go through the same store and rules as the browser upload: an org admin's replace the days they cover, a member's add new days only. Each file has one `tw_uploads` record (kept on the file, so a retry reuses it), a cleaned copy (`date,guests,net_sales`) and a report: header names, the header row, which rule or answer decided each column, row and day counts, skipped rows by number, and dates. The report holds no data cell except the location value chosen.
6. **Status and time left.** `GET /imports/:importId` (polled) shows each file's status and outcome, its progress in the current phase, and `etaSeconds`: measured, never guessed, and null ("Estimating") until three seconds and five percent in, until a file of the import has finished (for queued files), and while the import waits for a turn.
7. **Downloads and deletion.** The original streams back to its uploader and the organization's admins (in 32 MiB parts for large files), the cleaned copy to every member, both as attachments that are never rendered. Deleting the original keeps the cleaned copy, the report and the days, and replaces the stored name with the kind (and a ZIP's entry paths with nothing). Deleting a file removes the original, the cleaned copy, its entry list and the record; its days stay. An org admin can delete every original of a location at once (`DELETE /originals`). Deleting a location's sales data deletes its stored files; a location with files cannot be deleted before that; an organization's deletion deletes all of them (Deletion). Under view-as, names and entry paths are null, nothing downloads, and every write is refused.
8. **Retention** [CONFIRM: retention periods]. A daily sweep (`src/files/sweeper.ts`, one replica a day under a lease) discards upload sessions after 24 hours, deletes originals a year after upload (a file never read is kept unread as `raw_deleted`), deletes files dropped but never sent for reading after 30 days, finishes staff purges of flagged files, drops daily upload counters after 3 days, and deletes blobs whose record is gone once they are a day old.

Not in this build (spec 11A.8): reading `.xls` and `.doc`, reading notes or free text in files, other upload purposes. Stored files stay off in production until the client pieces, the drop screen and the privacy page ship with them (`../infra/README.md`, step 18).

### Notes (the tuning step)

- A note belongs to one location. Its kind is closure, private event, opening or other. It covers a date range of up to 366 days, optionally only certain weekdays, with an effect (closed, more guests, fewer guests, unknown), optional expected guests and a detail of up to 280 characters (required for other). [CONFIRM: notes first, AI chat later]
- Authors edit and delete their own notes; org admins edit and delete any. [CONFIRM: author or admin]
- Only the tuning chat (its `list_notes` tool, as data) and TownwiseAI’s questions (which days a note explains) read notes yet. The detail text never reaches a log or an audit event.

### Tuning chat

The build contract is `../docs/portal/tuning-chat.md`. A member chats with an assistant (Claude Opus 5.5 through the Anthropic API) about one location's demand. The assistant reads the location's sales coverage and totals, its daily rows, its notes and its town profile, and can propose a note. A proposal is a card in the client; the person saves it as shown or edited first, or sets it aside, through the proposal route, and only that press saves a note (the notes route stays open to them as always). The proposal route claims the proposal in `tw_chat_proposals`, writes the note with the id the claim gave it, then marks the proposal saved, so a retry, a crash between the steps or two tabs pressing Save make one note. A reload shows each proposal as open, saved (with its note id) or dismissed; one with no record reads as saved when a note of the location says exactly the same.

- Off until `ANTHROPIC_API_KEY` is set: the GET answers `enabled: false`, a turn answers 503 `chat_unavailable`.
- Conversations are private to their author, per location. Staff in view-as read the target’s and cannot send.
- A turn streams over the POST (`text/event-stream`): `conversation` first, then `text`, `tool` and `proposal` events, then `done` (`end_turn`, `max_tokens`, `tool_limit`, `budget` or `refusal`, with `costUsd`) or `error` (`internal`, `provider_unavailable`, `provider_overloaded`, `timeout`). A comment line every 15 seconds keeps the ingress from closing an idle stream. At most 8 model calls per turn, and at most 5 tool calls run from one reply; the rest are answered as not run because the reply asked for too many at once.
- A whole turn is bounded at 150 seconds (the ingress closes a request at about 240): past it the provider call is aborted and the stream ends with `error` `timeout`.
- A person has at most one live turn per organization, in any conversation or location (`tw_chat_live_turns`, unique per person, claimed atomically): another POST meanwhile is 409 `chat_turn_in_progress`. The claim is released by its turn id however the turn ends, and one older than 3 minutes may be taken over.
- A turn is saved in one update when it finishes, under a compare-and-set on the conversation’s live-turn claim; a claim older than 3 minutes may be taken over. A failed, timed-out or refused turn, or one the client closed, saves nothing but its cost (a refusal still ends with `done` `refusal`), and a first turn that saved nothing deletes its conversation. Every stored message is the API message param exactly as sent or received, thinking blocks included, and history is append-only.
- Each organization has a monthly budget, `TOWNWISE_CHAT_MONTHLY_BUDGET_USD` (UTC calendar month), checked before a turn starts (409) and before every later model call in it; a budget spent mid-turn ends the turn with `done` `budget` after its last complete step, and the turn is saved. Cost is recorded after every model call from its token usage at list prices (`src/chat/pricing.ts`), so one call can overrun by its own cost. A call aborted or failed before its output usage arrived is charged an output estimate from what it streamed and how long it ran (`src/chat/turn.ts`).
- Message text, tool inputs and tool results never reach a log or an audit event.
- Today is the town's local date (`src/time-zones.ts`): the twelve towns are `America/New_York`; another town gets its state's most populous zone, marked approximate in states split between two. The budget month stays UTC.

### Estimates

The build contract is `../docs/portal/estimates.md` (spec 10.13, 13.2 and 14.4). Two member reads, and TownwiseAI's `get_town_calendar` and `get_people_in_town` tools, say who is likely in the location's town and how Townwise estimates, from public data and the organization's own days and notes. Nothing of those is stored. Forecasts are stored runs that staff import and publish (below); until one is published, the model card and TownwiseAI say there is no forecast.

- People in town (`src/people-in-town/`): per day, the term state from the calendar's term entries (in session, finals, summer session, between terms only when both the finals before and the classes after are known, else unknown), town events and holidays with their sources, the county's 2024 food-service jobs index by month, and a headcount range only for a college town whose resident population, enrollment and student housing are researched with a source each (`src/people-in-town/sources.ts`). No town has those yet (owner decision, 2026-11-05), so every headcount is null with its reason (`no_population`, `visitors_unknown` for seasonal and event towns, `no_term_dates`, `no_enrollment`). Consecutive days with the same components are merged into periods, each with its weekdays.
- Your history by term state: the location's mean guests (net sales, in whole dollars, when no day has guests) by term state and weekday over its open regular days (the client's day classes, pinned by `test/fixtures/day-classes.json`), with day counts; a cell under 3 days has no mean.
- Sources: researched ids as given, `bls-qcew` for the jobs index and `cal-{n}` for calendar sources, each with the lowest rating of the entries citing it (null for unrated key dates). Fixed caveats follow which inputs were used.
- Both reads log nothing and audit nothing; under view-as they answer as for the person, logged only by the chain's `townwise.view_as_read`.
- Forecast runs (U13B, spec 14.4): staff export a model run's outputs on the team's computers (`../modeling/export_forecast_run.py`) and import the run file (`townwise.forecast-run/1`: each day's status and 80% range, reason kinds and calendar refs, week rows and the model's metadata; never a location id, a name or other free text) for one location in the staff console. It lands as a `draft`; staff publish it, withdraw it or delete it. Owners, view-as and TownwiseAI's `get_forecast` see published runs only, and for each date the newest one whose model saw no sales on or after it (`dataThrough` before the date). Week rows are the run's own, never sums of days. Reason labels are made in code from the kind and the public calendar; a ref that names no calendar entry on its day is not stored. Past days carry the stored guests and whether they landed in the range; live accuracy is scored per run, over the days that run supplied (WAPE, booked days left out, nothing under 5 scored days), and counts misses. Run files trained on days owners uploaded to Townwise are refused until the team decides whether staff may use uploaded days for research (spec 14, DECISION NEEDED). The model itself never reaches the API.
- Import, publish, withdraw and delete are staff actions, audited before the effect and listed in the org's Townwise staff activity. Deleting the location's sales data, the location or the organization deletes its runs and rows.

**TownwiseAI’s side panel** (`GET .../agent`) works whether or not the chat is on. Its questions are rules over the location’s own days, never an estimate: over the last 365 days of coverage, a weekday with no sales on at least 60% of its days (at least 4 of them, counting only weeks with sales on another day, from the first day with sales) that no closure note or earlier answer explains, then each run of days with no sales that no note or earlier answer explains (a weekday the location is usually closed on bridges a run but never starts or ends one, and a run the window cuts off before its first day with sales is not asked). At most 5, weekdays first, then gaps newest first. [CONFIRM: 60%, at least 4 of the weekday] Answering `closed` saves a closure note over the question’s days (the weekday only, for a weekday question) through the notes rules and limit; `open` (the data is missing) and `not_sure` save nothing. Either way those days are not asked about again, until the location’s sales data is deleted: the answers go with it, so the same days uploaded again are asked about again. An answer claims its row in `tw_agent_answers`, writes the note with the id the claim gave it, then marks the answer done, so a retry, a crash between the steps or several tabs make one note. A `closed` answer whose note is written stands over a different answer sent at the same time (the note exists); any other answer is marked done only while the row still holds it, and the request answers with what was stored. Once an answer is done it stands. The activity lists only real, dated records of the location, newest 20: applied uploads, notes the caller saved from their own TownwiseAI proposals, and answers (a `closed` answer as the closure note it saved, left out once that note is deleted). Never a file name, a note’s detail or a figure.

### Calibration

Each location’s calibration state is derived from its sales days on every read and never stored. It is `no_sales_data`, or `not_calibrated` with the day count and first and last dates. No forecast, threshold or progress state exists. (Forecast runs, which staff import and publish, are separate: see Estimates.) [DECISION NEEDED: minimum days of history before calibration]

### Audit and logs

- Every change writes an event to `tw_audit_events`, with details from a fixed allowlist per action (the table below, `AUDIT_DETAIL_KEYS` in `src/stores/audit-events.ts`). Events never hold guest or sales figures, note detail text, request notes, decision messages or file contents.
- Events for client actions (members, org admins and requesters) are written after the effect; a failed write is logged and the action stands. Staff events are written before the effect; a failed write refuses the action with 503, and an effect that then fails or is refused adds `staff_action.not_applied { eventId, code }`. Its code is the refusal’s error code (`request_not_pending`, `view_as_active`, `last_admin`, `already_invited`, `not_found`, `person_has_seat`, `org_not_suspended`), `conflict` when a concurrent change to the same row won, `unavailable` when a later event of the same request could not be written, or `internal` when the effect threw. The list is closed (`NOT_APPLIED_REASONS` in `src/audit.ts`, which also holds each code’s plain words). [CONFIRM: audit timing; events kept indefinitely]
- The only update to an event is deletion’s redaction; nothing deletes one.
- Org admins read their organization’s staff events (actor role `superadmin`), newest 50, as Townwise staff activity: `{ at, staffEmail, summary, viewAs, applied, notAppliedReason }`, where `viewAs` is `{ targetEmail, reason, endsAt }` on `view_as.started` only and `endsAt` is the grant’s scheduled end (an earlier end is its own `view_as.ended` row). A `staff_action.not_applied` event is never a row: the row it qualifies has `applied: false` and `notAppliedReason`, the code in plain words (for example “The organization needs at least one admin”); every other row has `applied: true` and `notAppliedReason: null`.

| Action | Details | Written |
|---|---|---|
| `access_request.created` | `orgName`, `townId`, `townName`, `hasPlace` (whether a place id was sent; never the id, which would outlive the redaction of a deleted organization, and never an address) | after, by the requester |
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
| `sales.uploaded` | `locationId`, `dayCount`, `inserted`, `replaced`, `firstDate`, `lastDate`; from the file reader also `fileId` and `via` (`file`), with the uploader as actor | after |
| `file.uploaded` | `locationId`, `kind`, `sizeBytes` | after |
| `file.deleted` | `locationId`, `kind`, `reason` (`owner`) | after |
| `file.raw_deleted` | `locationId`, `kind` | after |
| `sales.deleted` | `locationId`, `deletedDays` | after |
| `note.created`, `note.updated`, `note.deleted` | `locationId`, `kind`, `startDate`, `endDate` | after |
| `chat.turn_completed` | `locationId`, `conversationId`, `model`, `calls`, `inputTokens`, `outputTokens`, `stopReason` | after |
| `chat.conversation_deleted` | `locationId`, `conversationId` | after |
| `agent.question_answered` | `locationId`, `questionId` (dates and a weekday number only), `answer` (`closed`, `open` or `not_sure`); a `closed` answer also records the note’s `note.created` | after |
| `forecast.imported`, `forecast.published`, `forecast.withdrawn`, `forecast.deleted` | `locationId`, `modelVersion`, `from`, `to`, `dayCount` (target `forecast_run`; never a figure) | before, by staff |
| `view_as.started` | `targetUserId`, `targetEmail`, `reason`, `expiresAt` | before, by staff |
| `view_as.ended` | `endReason` (`ended`, `replaced` or `expired`) | after the grant is cleared |
| `people.signed_out_everywhere` | none (the event’s `orgId` is the person’s organization, or null) | before, by staff |
| `person.deleted` | `userId` (null for an address that never signed in) | before, by staff |
| `staff_action.not_applied` | `eventId`, `code` | after a staff effect fails or is refused |
- Townwise log lines carry ids and counts only: `townwise.access_denied { policy, code }`, `townwise.view_as_read { grantId, routeId }`, `townwise.places_failed { routeId, code, status, errType }` (code `upstream_status` with Google's HTTP status, `network` with the error class, `timeout` or `bad_response`), `townwise.upload_applied { orgId, locationId, uploadId, dayCount }`, `townwise.audit_write_failed { action, orgId, targetId }`, `townwise.email_sent { kind, requestId, orgId? }` and `townwise.email_failed { kind, requestId, orgId?, code, status, upstreamCode, errType }` (code `invalid_recipient`, `render`, `token`, `timeout`, `network`, `upstream_status` with ACS's HTTP status and `x-ms-error-code`, or `internal`; never the address, subject or body), and for the tuning chat `townwise.chat_turn`, `townwise.chat_turn_failed`, `townwise.chat_turn_aborted` and `townwise.chat_turn_not_saved` (`{ orgId, locationId, conversationId, calls, costMicroUsd }` with the stop reason, or the code and error class; `timeout` has no error class), `townwise.chat_live_turn_not_released` (`{ orgId, locationId, errType }`), `townwise.chat_proposal` (`{ orgId, locationId, conversationId, status, edited }`) and `townwise.agent_answer` (`{ orgId, locationId, answer }`). Stored files log `townwise.file_upload_started { orgId, locationId, fileId, importId, sizeBytes, chunkCount }`, `townwise.file_stored { fileId, kind, sizeBytes, durationMs }`, `townwise.file_upload_cancelled { fileId, receivedBytes }`, `townwise.uploads_busy { active }`, `townwise.blob_failed { op, errType, status }`, `townwise.file_downloaded` and `townwise.file_download_stopped { fileId, which }`, `townwise.file_deleted { fileId }`, `townwise.originals_deleted { orgId, locationId, count, by }`, `townwise.import_started`, `townwise.file_read { orgId, locationId, fileId, importId, dayCount, durationMs }`, `townwise.file_kept` and `townwise.file_failed { fileId, kind, outcome }`, `townwise.file_question { fileId, kind }`, `townwise.file_answered`, `townwise.file_read_failed { fileId, errType }`, `townwise.import_done { importId, files, durationMs }`, `townwise.file_worker_failed { importId, errType }`, `townwise.file_entries { fileId, total, used, kept }`, `townwise.extract_model_call { fileId, costMicroUsd, answered }`, `townwise.extract_model_failed { fileId, errType, status }`, `townwise.location_files_deleted { orgId, locationId, deletedFiles, deletedBlobs }`, `townwise.org_files_deleted { orgId, deletedFiles, deletedBlobs }`, `townwise.files_swept { expiredUploads, expiredOriginals, abandonedFiles, purged, uploadDays, orphans, durationMs }` and `townwise.files_sweep_failed { errType }`: never a file name, a ZIP entry path, header, sheet name, location value, cell or figure, and never the storage SDK's own message. No route puts an email, a name or a figure in its path or query, because server-core logs the URL. The one exception is the people lookup’s `q`, which server-core redacts. U13B: `townwise.forecast_imported { orgId, locationId, runId, days, weeks }` and `townwise.forecast_status { orgId, runId, status }` (`published`, `withdrawn` or `deleted`); never a figure or the run file.

## Endpoints

Every route is JSON under `/api` and runs one chain, built from the table in `src/access/routes.ts`:

1. The kit’s `requireAuth` (401 `unauthenticated`).
2. The `townwise:writes` limiter, for every method but GET, before anything is read.
3. `resolveAccess`.
4. The view-as guard.
5. The route’s policy.
6. The body parser: 32 KB, 2 KB on the two Places routes and the files JSON routes, or 256 KB on the upload route; none on GET and DELETE. It runs after the policy, so a refused request is never parsed. The chunk route has no parser: its handler streams the raw body after the policy passed, and a refused chunk's connection is closed unread.
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
| `GET /api/me` | signed_in | | 200 `{ user, access, viewAs, staff, welcome }`; `welcome` is `{ firstName, restaurant }` or null (Requesting access and approval), null under view-as and in every other answer “as `GET /api/me`” | |
| `POST /api/me/join` | signed_in | `{ inviteId }` | 200, as `GET /api/me` | 403 `forbidden` (staff); 409 `no_invite`, `already_in_org` |
| `POST /api/me/decline` | signed_in | `{ inviteId }` | 200, as `GET /api/me` | 403 `forbidden` (staff); 409 `no_invite` |
| `POST /api/me/welcome` | member; `writes` only | none (no body is parsed) | 204; again 204, keeping the first time | 403 `no_access`; 403 `view_as_read_only`; 429 |
| `POST /api/access-requests` | signed_in; limiter `requests` | `{ orgName, contactName, contactRole, town, locationCount, note?, placeId? }`, `placeId` 10 to 512 letters, digits, `_` or `-`, or null [CONFIRM: place ID format] | 201, as `GET /api/me` (`pending`); the request view answers `placeId`, null when none | 403 `forbidden` (staff, or any state but `no_org`, `rejected`, `removed`); 409 `request_exists`; 400 `unknown_town`; 400 `invalid_request` (a malformed `placeId` included) |
| `GET /api/towns/:townId` | signed_in | | 200 `{ profile }` | 404 |

### Places

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `POST /api/places/autocomplete` | signed_in; 2 KB; limiter `places` | `{ input, sessionToken? }`, input 2 to 120 characters after trimming, `sessionToken` a version 4 UUID | 200 `{ suggestions, sessionToken }`, up to 5 `{ placeId, name, detail }` (`detail` empty when Google has none) | 400; 413; 429; 503 `places_unavailable` |
| `POST /api/places/details` | signed_in; 2 KB; limiter `places` | `{ placeId, sessionToken }`, `placeId` 10 to 512 letters, digits, `_` or `-` (`api/src/place-id.ts`) | 200 `{ place: { placeId, address, town, map } }`, `town` a `TownInput` or null, `map` `{ url, width: 640, height: 320 }` or null | 400; 404 `place_not_found` (Google answered 404, or 400 `INVALID_ARGUMENT` for the id); 413; 429; 503 `places_unavailable` |

See Places search. `placeId` in the answer is Google's current id for the place, which can differ from the one sent.

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
| `GET /api/org/locations/:locationId/sales/history` | member | | 200 `{ coverage, days, uploads }`: every stored day | 400; 404 |
| `POST /api/org/locations/:locationId/sales/uploads` | member; 256 KB; limiter `uploads` | `{ days }` (see Sales upload) | 201 `{ upload, coverage, calibration }` | 400; 404; 413; 429 |
| `DELETE /api/org/locations/:locationId/sales` | org_admin | | 200 `{ deletedDays, deletedUploads, deletedFiles }`: the location's stored files go too, and so do its forecast runs and its answers to TownwiseAI’s questions (notes stay, closure notes saved from answers included) | 404; 409 `import_running` (one of its files is being read); 503 `files_unavailable` (stored files are off while it has files) |

`sales/history` answers every stored day, oldest first, as columns of equal length: `days` is `{ date, guests, netSalesCents, upload }`, where `upload` indexes `uploads` (the upload that last wrote the day, or -1 if it has no record). `uploads` lists every upload a day references, newest first, each `{ id, uploadedAt, uploadedByEmail, status, firstDate, lastDate, file }`; `file` is null until stored files link uploads to files. Neither sales read logs anything.

### Calendar

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/calendar?from=&to=` | member | exactly `from` and `to`, `YYYY-MM-DD`, from 2010-01-01, `from <= to`, `to` at most 400 days ahead, under 20 years | 200 `{ town, researched, covers, events }` | 400; 404 |

The public calendar of the location’s town: US federal holidays computed from their legal rules (OPM as the source, on the actual day), the town profile’s key dates and the researched entries in `src/town-calendar-data.ts` (Hanover’s from the committed `../modeling/dartmouth_calendar_2025_2026.csv`). Each event is `{ id, title, start, end, kind, scope, group, groupLabel, confidence, sources }`, with at least one source; term entries use `group` `{townId}:classes:{season}` or `{townId}:finals:{season}`. `researched` is true when the town has any researched event, and `covers` is their span over all years (null when none), so a town outside the twelve gets holidays only. Spec 10.10 and 13.1.

### Estimates

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/people-in-town?from=&to=` | member | exactly `from` and `to`, `YYYY-MM-DD`, from 2010-01-01, `from <= to`, at most 92 days counting both ends, `to` at most 400 days ahead | 200 `PeopleInTownWindow` | 400 `invalid_request`; 404 |
| `GET /api/org/locations/:locationId/estimates/about` | member | | 200 `{ version, card, location, today, forecast, calendar, people }` | 400; 404 |
| `GET /api/org/locations/:locationId/forecast?from=&to=` | member | exactly `from` and `to`, from 2010-01-01 and at most 400 days back, `from <= to`, at most 31 days, `to` at most 400 days ahead | 200 `ForecastWindow` | 400 `invalid_request`; 404 |

`PeopleInTownWindow` is `{ available, reason, from, to, town: { name, state, kind }, timeZone, periods, season, visitors, yourHistory, sources, caveats }`; `available` is false, with `reason: 'town_not_researched'`, only for a town outside the twelve. Each period is `{ from, to, fromWeekday, toWeekday, termState, termLabel, termSourceIds, headcount: { low, high, sourceIds, excludes } | null, headcountWhy, events }`. `estimates/about` gives the model card's facts (`src/estimates/about.ts`), the location's name and town, today in the town (`{ date, weekday, timeZone, approximate }`), `forecast: { run: null, live: null }` until forecast runs exist, the town calendar's `{ researched, covers }`, and which headcount inputs are researched for the town with their sources. Neither has a route limiter. Spec 10.13.

`ForecastWindow` (U13B) is `{ available, reason: 'no_published_forecast' | 'not_covered' | null, runs, days, weeks, notCovered }`, published runs only. A run is `{ id, metric: 'guests', model: { family, version, label }, trainingSource, trainedFrom, dataThrough, madeAt, frozen, interval: { level: 0.8, widened }, backtest, live }`, `live` scored over the days that run supplied, never another run's. A day is `{ date, weekday, status: 'open' | 'closed' | 'booked', low, mid, high, baseline, reasons: { kind, label, effectPct, sources }[], runId, madeAt, madeAfterDay, actual, inRange }`, its numbers raw as stored (clients round). A week is `{ from, to, openDays, low, mid, high, runId, madeAt, actual, inRange }`. `live` is `{ days, inRange, typicalErrorPct, from, to }` or null under 5 scored days. `estimates/about`'s `forecast` is `{ run, live }` for the newest published run and its own live accuracy, or both null.

### Stored files

All under `/api/org/locations/:locationId`, all 503 `files_unavailable` while stored files are off. A file or import id from another organization, or another location, answers 404 like an unknown one. Detail fields sit beside `error` and `message`.

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `POST /files` | member; 2 KB; limiter `files` | `{ name, sizeBytes, purpose: 'history' }` | 201 `{ file, import: { id, status }, limits }` | 400 `invalid_request`, `purpose_unavailable`; 404; 413 `file_too_large { maxBytes }`; 409 `import_full`, `too_many_uploading`, `storage_full { storedBytesLeft }`, `daily_upload_limit { resetsAt }` |
| `PUT /files/:fileId/chunks/:index` | member (the uploader); raw body; limiter `file_chunks` | `application/octet-stream`, exact `Content-Length` (8 MiB, or the remainder) | 200 `{ index, receivedBytes, chunksReceived }` | 400; 403 `forbidden`; 404; 409 `file_not_uploading`; 410 `upload_expired`; 503 `uploads_busy` (`Retry-After: 2`), `storage_unavailable` (`Retry-After: 5`) |
| `POST /files/:fileId/complete` | member (the uploader) | `{}` | 200 `{ file, import }` | 403; 404; 409 `chunks_missing { missing }`, `file_duplicate { fileId }`, `file_not_uploading`; 503 `storage_unavailable` |
| `GET /files?before=` | member | | 200 `{ files }`, newest first, 200 a page; other people's unfinished uploads left out | 400; 404 |
| `GET /files/:fileId` | member | | 200 `{ file, report }` | 400; 404 |
| `GET /files/:fileId/entries?after=` | member | `after` an entry index | 200 `{ entries, next }`, 200 a page in archive order; `next` is the `after` for the next page, or null | 400; 404 `not_found`, `no_entries` (not a ZIP) |
| `GET /files/:fileId/raw?part=` | member (the uploader or an org admin); limiter `downloads` | `part` 0-based, 32 MiB each | 200, the original as an attachment | 400; 403 `forbidden`, `view_as_no_download`; 404; 409 `file_busy`; 410 `raw_expired` |
| `GET /files/:fileId/clean` | member; limiter `downloads` | | 200, `text/csv` attachment | 403 `view_as_no_download`; 404 `not_found`, `no_clean_file` |
| `DELETE /files/:fileId/raw` | member (the uploader or an org admin) | | 200 `{ deleted: true }` | 403; 404; 409 `file_busy` (uploading, or not read yet: `stored`, `queued`, `reading`, `waiting`); 410 `raw_expired` |
| `DELETE /files/:fileId` | member (the uploader or an org admin) | | 200 `{ deleted: true, daysKept }`; an unfinished upload is cancelled and its bytes given back | 403; 404; 409 `file_busy` (being read) |
| `DELETE /originals` | org_admin | | 200 `{ deletedOriginals, skippedBusy }`: every original of the location Townwise is done with; files not read yet are skipped | 403; 404 |
| `GET /imports/current` | member | | 200 `{ import }`: the active one, or one finished in the last 24 hours, or null | 404 |
| `GET /imports/:importId` | member | | 200 `{ import }` | 400; 404 |
| `POST /imports/:importId/start` | member | `{}` | 202 `{ import }` | 404; 409 `import_not_open`, `import_empty` |
| `POST /imports/:importId/answer` | member | `{ questionId, choice }` | 200 `{ import }` | 400; 404; 409 `question_stale` |

A file is `{ id, importId, purpose, name, kind, sizeBytes, uploadedAt, uploadedByEmail, status, outcome, upload, progress, etaSeconds, queuePosition, entries, result, hasClean, rawAvailable, rawExpiresAt, canDownloadRaw, canDownloadClean, canDelete, canDeleteRaw }`; `kind` is `text`, `xlsx`, `xls`, `pdf`, `docx`, `doc`, `zip` or `other`, and `status` is `uploading`, `stored`, `queued`, `reading`, `waiting`, `read` (shown as Used), `kept` or `failed`. An import is `{ id, locationId, status, createdAt, startedAt, finishedAt, files, found, progress, etaSeconds, waitingForTurn, question, appliedVersion }`, where `found` counts the days this import's files wrote and `appliedVersion` moves each time a file's days are written. An entry is `{ index, path, depth, kind, sizeBytes, status, outcome, dayCount }` (`path` null under view-as and once the ZIP's original is deleted; `status` `used`, `kept` or `failed`). A question is `{ id, fileId, fileName, sheet, kind, options: [{ id, label }], suggested, family }` (`family` a ZIP table's label, its first header names) (`kind` is `date_column`, `date_order`, `location_value`, `row_mode` or `columns`; for `columns` the choice is `guests:<id>,netSales:<id>`; every question offers `not_sure`).

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
| `GET /api/admin/orgs/:orgId` | | 200 `{ org, members, locations, recent }`: the team, each location’s coverage and counts, and the newest 20 audit events. `org.fromRequestSentAt` is when the request it was approved from was sent, or null without one or once that request is deleted | 400; 404 |
| `PATCH /api/admin/orgs/:orgId` | `{ name?, status? }`, at least one; status `active` or `suspended` | 200 `{ org }`, as in the detail without `fromRequestSentAt` | 400; 404; 503 |
| `DELETE /api/admin/orgs/:orgId` | | 200 `{ deletedDays, deletedUploads, deletedNotes, deletedLocations, deletedSeats, redactedEvents }` | 400; 404; 409 `org_not_suspended` (also when reactivated during the deletion); 503, or 503 `files_unavailable` when stored files are off while it has files |
| `POST /api/admin/orgs/:orgId/originals/delete` | `{ basis: 'data_subject_request' \| 'org_request' \| 'other' }` | 200 `{ deletedOriginals, skippedBusy }` | 400; 404; 503 |
| `POST /api/admin/orgs/:orgId/members` | `{ emails, role? }`, as on Team | 200 `{ results, members }` | 400; 404; 409 `member_limit`; 503 |
| `PATCH /api/admin/orgs/:orgId/members/:memberId` | `{ role }` | 200 `{ member }` | 400; 404; 409 `last_admin`; 503 |
| `DELETE /api/admin/orgs/:orgId/members/:memberId` | | 204 | 400; 404; 409 `last_admin`; 503 |
| `GET /api/admin/orgs/:orgId/forecast-runs` | | 200 `{ runs }`, newest import first, at most 100: each run as in `ForecastWindow` without `live`, with `locationId`, `status` (`importing`, `draft`, `published`, `withdrawn`), `range`, `dayCount`, `weekCount`, `importedAt`, `publishedAt`, `withdrawnAt` and `importedByEmail` (null once that person is deleted); never a day's figure | 400; 404 |
| `POST /api/admin/orgs/:orgId/locations/:locationId/forecast-runs` (body up to 256 KB) | a `townwise.forecast-run/1` file | 201 `{ run }`, a new draft; 200 `{ run }` for a file this location already has, in its status (a run left `importing` finishes) | 400 `invalid_forecast_file` with `issues: { path, code }[]` (never a value); 404 (another organization's location too); 503 |
| `POST /api/admin/orgs/:orgId/forecast-runs/:runId/publish` | `{}` | 200 `{ run }`; a published run answers 200 and writes nothing | 400; 404; 409 `forecast_run_not_draft`; 503 |
| `POST /api/admin/orgs/:orgId/forecast-runs/:runId/withdraw` | `{}` | 200 `{ run }` from a draft or published run; a withdrawn run answers 200 and writes nothing | 400; 404; 409 `forecast_run_importing`; 503 |
| `DELETE /api/admin/orgs/:orgId/forecast-runs/:runId` | | 204: its rows, then the run | 400; 404; 503 |
| `GET /api/admin/people?kind=` | | 200 `{ people, truncated }`, up to 1,000 | 400 |
| `GET /api/admin/people/lookup?q=` | an exact email | 200 `{ person }`, or `{ person: null }` | 400 |
| `POST /api/admin/people/:userId/sign-out-everywhere` | `{}` | 200 `{ revoked }`, the sessions revoked | 400 `invalid_target` (staff); 404; 503 |
| `POST /api/admin/people/delete` | `{ email }` | 200 `{ deletedRequests, deletedSeats, redactedEvents, kitUserId }` | 400 `invalid_target` (staff); 404; 409 `person_has_seat` (also for a seat taken during the deletion); 503 |
| `GET /api/admin/audit?orgId=&actorUserId=&action=&before=&limit=` | `limit` 1 to 200, default 50 | 200 `{ events, nextBefore }` | 400 |
| `POST /api/admin/view-as` (limiter `view-as`) | `{ userId, reason }` | 201, as `GET /api/me`, with `viewAs` set | 400 `invalid_target`; 404; 409 `view_as_active`; 429; 503 |
| `POST /api/admin/view-as/end` (policy `staff_self`) | `{}` | 200, as `GET /api/me` | |

The console never returns sales figures or note text; forecast runs come back as metadata only (model, dates, counts, backtest accuracy), never a day's range. People come only from Townwise records, `TOWNWISE_SUPERADMIN_EMAILS` and the kit’s exact-email lookup; the kit’s collections are never read directly. Organization and team changes, sign out everywhere and deletion are staff actions (see Audit and logs), and deletion is described under Deletion, with its runbook step.

### Tuning chat

| Method and path | Policy | Request | Success | Errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/chat` | member | | 200 `{ enabled, budget, conversations }` (the caller’s own, newest 50) | 404 |
| `GET /api/org/locations/:locationId/chat/:conversationId` | member (author) | | 200 `{ id, title, updatedAt, messages }` | 400; 404 |
| `POST /api/org/locations/:locationId/chat/turns` | member; limiter `chat` | `{ conversationId?, content }`, content 1 to 4,000 characters | 200 `text/event-stream` | 400; 404; 409 `chat_turn_in_progress`, `conversation_full`, `chat_budget_exhausted`; 429; 503 `chat_unavailable` |
| `DELETE /api/org/locations/:locationId/chat/:conversationId` | member (author) | | 204, and its proposal records go too | 400; 404 |
| `POST /api/org/locations/:locationId/chat/:conversationId/proposals/:proposalId` | member (author); 8kb | `{ action: 'save', note? }` (`note`, a note body, when edited first) or `{ action: 'dismiss' }` | 200 `{ proposal: { id, status: 'saved' \| 'dismissed', noteId, edited }, note }` | 400; 404 (not the caller’s conversation, or no proposal with this id was shown); 409 `note_limit`; 429 |
| `GET /api/org/locations/:locationId/agent` | member | | 200 `{ questions, activity }` | 400; 404 |
| `POST /api/org/locations/:locationId/agent/questions/:questionId` | member; 1kb | `{ answer: 'closed' \| 'open' \| 'not_sure' }` | 200 `{ question: { id, answer }, note }` (`note`, the closure note a `closed` answer saved, in the notes route’s view, else null) | 400 (malformed id or body); 404 (the location, or a question not asked now); 409 `note_limit`; 403 `view_as_read_only`; 429 |

`budget` is `{ month, usedUsd, limitUsd, exhausted }`. Each conversation is `{ id, title, updatedAt, turnCount }`; its `messages` are `{ role, at, text, proposals, parts }`, one per message the person wrote and one per run of TownwiseAI’s replies to it. `parts` replays a reply in order: text, tool calls with the input and result views their cards show (dates, counts and source links, never a figure), and proposals. Never thinking blocks, raw tool results or calls that never ran. A proposal is exactly a note (the notes route’s body) plus `id`, its `propose_note` call’s id, `status` (`open`, `saved` or `dismissed`) and `noteId` (the saved note’s id, else null). A save answers with the note in the notes route’s view, or null when the author has deleted it since; saving again, or setting aside a saved proposal, answers the same saved state. `proposalId` is the call’s id, 1 to 128 letters, digits, `_` or `-`. The stream’s `tool` events carry `{ id, name, state, input, result }` and its `proposal` events `{ id, proposal }` (`../docs/portal/tuning-chat.md` sections 3 and 4). Another person’s conversation, or one from another location, is 404. A conversation holds at most 40 turns or 1.5 MB of stored messages (409 `conversation_full`). `chat_turn_in_progress` means the caller already has a live turn in this organization, in any conversation or location.

A question is `{ id, kind: 'weekday', weekday, from, to, noSalesCount, weekdayCount }` (`weekday` 0 for Sunday to 6; `from` is the first day with sales in the window; the counted days of that weekday, those in weeks with sales on another day, with no sales, and all of them) or `{ id, kind: 'gap', from, to, dayCount }`. Its id holds only its dates and weekday: `weekday_{d}_{from}_{to}` or `gap_{from}_{to}`. An activity item is `{ at, kind: 'upload_applied', firstDate, lastDate, dayCount }`, `{ at, kind: 'note_saved', via: 'chat' \| 'question', noteId, noteKind, startDate, endDate }` or `{ at, kind: 'question_answered', questionId, answer: 'open' \| 'not_sure' }`; a client shows a kind it does not know as nothing. Answering a question already answered, by anyone, answers what was saved. A question’s answer belongs to the location, so every member sees it; proposals stay their author’s.

### Rate limits

| Name | Applies to | Limit | When Redis is down |
|---|---|---|---|
| `app:api-ceiling` | every request, per IP (`src/main.ts`) | 2,000 per minute | allow |
| `townwise:writes` | every `/api` route but GET, per account | 300 per 10 minutes | allow |
| `townwise:uploads` | the upload route, per account | 30 per hour | allow |
| `townwise:requests` | `POST /api/access-requests`, per account | 5 per day | deny (503 `unavailable`) |
| `townwise:view-as` | `POST /api/admin/view-as`, per account | 20 per hour | deny (503 `unavailable`) |
| `townwise:chat` | `POST /api/org/locations/:locationId/chat/turns`, per account | 60 per hour | deny (503 `unavailable`) |
| `townwise:places` | both Places routes together, per account | 300 per hour | deny (503 `unavailable`) |
| `townwise:files` | `POST .../files` (opening an upload), per account | 120 per hour | allow |
| `townwise:file-chunks` | `PUT .../files/:fileId/chunks/:index`, per account | 1,500 per hour | allow |
| `townwise:downloads` | both file downloads together, per account | 300 per hour | allow |

The daily byte cap, not the files limiters, bounds what an organization can upload. A search is 10 to 15 autocompletes (debounced at 250 ms, nothing under 2 characters) and one details call, so `townwise:places` allows about 20 searches an hour, and two or three in a few minutes stay well inside it and inside `townwise:writes`, which counts them too. A refused request is 429 `rate_limited` with `retryAfterSeconds`. Account keys are `acct:<userId>`, which the rate-limit module hashes before storing. [CONFIRM: limits]

### Not built yet

These are in the build specs and have no server code yet:

- In the tuning chat (`../docs/portal/tuning-chat.md`): background turns and resumable streams, message trees, regenerate and edit, history compaction, attachments, memory and voice.

## Data

Every Townwise collection takes the `tw_` prefix. Every tenant document carries `orgId`, and tenant store functions (`src/stores/`) take an `OrgScope` that only `src/access/policy.ts` can mint. Lookups keyed by a person, or spanning organizations, live in `src/stores/cross-tenant.ts`, and a test pins which files import it.

| Collection | Holds |
|---|---|
| `tw_orgs` | name, status, who created it and from which request |
| `tw_members` | invitations and seats in one collection: email, role, status, who added it and when |
| `tw_access_requests` | the request form (with the optional Google place id; documents from before it read as none), its status and the decision message |
| `tw_locations` | name, town and the optional Google place id (set only by approval from a request, never edited; older documents read as none) |
| `tw_sales_days` | date, guests and net sales in cents per location per day, and nothing else |
| `tw_uploads` | per upload: counts, first and last dates, and who sent it; never a file name |
| `tw_notes` | the note’s fields and the author’s user id |
| `tw_view_as_grants` | staff member and session, target, organization, reason, start and end |
| `tw_audit_events` | who did what, with allowlisted details |
| `tw_chat_conversations` | per author and location: the title, every API message param of the conversation as JSON with its time, the turn count and the live-turn claim |
| `tw_chat_live_turns` | per organization and person: the one live tuning chat turn’s id and start time |
| `tw_chat_usage` | per organization and UTC month: the tuning chat’s cost in whole micro-dollars |
| `tw_chat_proposals` | per conversation and proposal: what the author did with a note TownwiseAI proposed (saving, saved or dismissed), the saved note’s id and whether it was edited first; never the note’s content |
| `tw_agent_answers` | per location and TownwiseAI question: the answer (`closed`, `open` or `not_sure`), whether it is done, and the id of the closure note a `closed` answer saves; no person id and no text; deleted with the location's sales data, the location and the organization |
| `tw_welcomes` | per organization and person: that the welcome statement was shown, and when; no audit event, deleted with the organization and with the person |
| `tw_files` | per stored file: the original name (shown to the organization only, never logged), kind, size, a fingerprint over its chunks, the upload session while uploading, status and outcome, progress while reading, the person's answers, the result (counts and dates), the report (header names, row numbers, dates, counts, the location value chosen), and when the original was deleted |
| `tw_imports` | per batch of files dropped for one location: status, the reader's lease, the current question, how much has been read and how fast, and a counter of days written |
| `tw_upload_days` | per organization and UTC day: bytes started uploading, for the daily cap |
| `tw_file_entries` | per entry of a stored ZIP: its path inside the archive (shown to the organization only, never logged, cleared with the original), depth, kind, declared size, and what became of it (used, kept with the reason, or failed) |
| `tw_files_usage` | per organization and UTC month: the file reader's AI column step's cost in whole micro-dollars |
| `tw_file_sweeps` | one document: the daily file sweep's lease and when it last ran |
| `tw_forecast_runs` | U13B: per imported run file and location: the model's family, version and notebook commit, the training source and dates, the frozen files' names and hashes, the interval, the backtest, the range, day and week counts, the file's hash, the status and who imported and published it (staff user ids, cleared on person deletion) |
| `tw_forecasts` | U13B: per run, one row per day (status, low, mid, high, baseline, reasons as kind, calendar ref and effect) and per week (open days, low, mid, high); never a label, a name or other text |

Stored files live in Azure Blob Storage (`../infra/terraform/production/files.tf`), in `client-raw` (originals) and `client-clean` (cleaned copies), named by ids only: `{orgId}/{locationId}/{fileId}`. `src/files/blobs.ts` builds every name from the caller's `OrgScope` and is the only file that imports the Azure SDK.

The town calendar (`src/town-calendar.ts`) is public data computed at request time and stored in no collection. Forecast runs (U13B) are outputs only: the model, its features and its training data never reach the API. So are people in town and the model card (`src/people-in-town/`, `src/estimates/`): they read the calendar, the town profile, the committed headcount inputs and the location's own days and notes, and store nothing.

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
| `GOOGLE_PLACES_API_KEY` | api (`src/main.ts`) | no | yes | empty locally, which turns the Places search off; in production a Key Vault reference when `enable_places` is on (`../infra/README.md`, step 17) |
| `GOOGLE_MAPS_STATIC_KEY` | api (`src/main.ts`) | no | yes | empty locally, which leaves the confirm card without a map; a key restricted to the Maps Static API, which ends up in the map URL the browser loads; in production a Key Vault reference when `enable_places` is on (step 17) |
| `GOOGLE_MAPS_SIGNING_SECRET` | api (`src/main.ts`) | no | yes | empty locally, which leaves the confirm card without a map; Google's URL signing secret (URL-safe base64; a malformed value refuses boot), never sent anywhere; in production a Key Vault reference when `enable_places` is on (step 17) |
| `EMAIL_ENDPOINT` | api (`src/config.ts`) | no | no | empty locally, which turns email off; otherwise the Communication Services endpoint, a bare `https://*.communication.azure.com` origin (`terraform output -raw communication_service_endpoint`) |
| `EMAIL_SENDER` | api (`src/config.ts`) | with `EMAIL_ENDPOINT` | no | empty locally; `no-reply@townwise.tech` in production |
| `TOWNWISE_EMAIL_REPLY_TO` | api (`src/config.ts`) | no | no | empty locally (no Reply-To); in production the team member who reads replies |
| `TOWNWISE_WEB_URL` | api (`src/config.ts`) | no | no | `http://localhost:8081`, a bare origin, for the links in emails; production email requires `https:` |
| `IDENTITY_ENDPOINT`, `IDENTITY_HEADER`, `AZURE_CLIENT_ID` | platform (Container Apps; `AZURE_CLIENT_ID` from `containerapp.tf`), read by `src/main.ts` | when `EMAIL_ENDPOINT` is set, or `FILES_BLOB_ACCOUNT_URL` without Azurite | no, but `IDENTITY_HEADER` is never logged | unset locally; boot fails if email or stored files in Azure are on without them. One token source serves both, with a token cached per resource |
| `FILES_BLOB_ACCOUNT_URL` | api (`src/config.ts`) | no | no | empty locally, which turns stored files off (every files route answers 503 `files_unavailable`); `http://127.0.0.1:10000/devstoreaccount1` with Azurite; in production `https://sttwfiles2d2c15bf.blob.core.windows.net` (HTTPS required), commented in `production.env` until `../infra/README.md`, step 18. The API authenticates with its managed identity |
| `FILES_AZURITE_CONNECTION_STRING` | api (`src/config.ts`) | no | no | development and tests only (production refuses it): `UseDevelopmentStorage=true` with `docker compose up -d`, which also starts Azurite on 10000; the API then creates the two containers itself |
| `TOWNWISE_FILES_MONTHLY_BUDGET_USD` | api (`src/config.ts`) | no | no | `5`: the file reader's AI column step's monthly spend limit per organization, in dollars, 0 to 1,000; 0 turns it off. It runs only with `ANTHROPIC_API_KEY` [CONFIRM] |

`.env.example` lists every variable above except `LOG_LEVEL`, `HTTP_KEEP_ALIVE_TIMEOUT_MS` and `SHUTDOWN_TIMEOUT_MS`, which take their defaults, and the three platform identity variables. `EMAIL_ENDPOINT` and `EMAIL_SENDER` are empty there, which turns email off. It holds local values and placeholders only: the two key rings, the Google client ids, the staff list, the Anthropic key, the Places key, the Maps static key and its signing secret are empty. Key rotation for the two key rings is in `kit/auth/MODULE.md`.

## Kit modules

The code under `kit/` is ours to own. Record any change under `## Local changes` in that module's `MODULE.md` with the test that pins it. To take a kit fix: in a camkeith/modules clone, `git diff <commit in KIT.md> <new commit> -- backend/<name>`, apply it here, run `npm run verify`, and update the line in `KIT.md`.
