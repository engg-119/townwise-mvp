# Townwise client portal and staff console: build spec

Status at merge into `develop` (2026-11-04): the API this spec describes is built in `api/`; `api/README.md` lists what is built and what is not yet. The client screens are not built; their mockups are on the Townwise design canvas, in the three "Client portal" and "Staff console" rows. Branch facts below (`feature/townwise-web`, the `kit-infra` and `portal-api` worktrees, `feature/infra` with MongoDB Atlas) describe the repository before those branches merged; production now runs on Azure DocumentDB (`infra/README.md`). The three source designs this spec cites were working files and are not in the repository.

Original status: spec, 2026-11-04, revised the same day after a critic review (Section 23 lists the changes). Synthesized from the three designs in this folder (`design-security.md`, `design-product.md`, `design-minimal.md`). Nothing in this document is built unless it is marked **Exists**. Spec verbs (“returns”, “refuses”, “shows”) say what the build must do.

Markers:

- `[CONFIRM: …]` is a default the build ships with; the user can change it. Lead defaults say “lead default”.
- `[DECISION NEEDED: …]` has no default; the build shows the honest gap until the user decides.
- On mockups, both render as Placeholder chips (design system), so nobody mistakes them for final copy. Neither ever ships.

Facts marked **Exists** were checked in these files for this spec, not copied from the designs:

- Kit, in the `portal-api` worktree: `api/kit/auth/MODULE.md` (never its Changes from source section); `api/kit/auth/src/create-auth.ts` (`AuthContext`, `revokeAllSessions`, optional `onUserCreated`); `src/middleware.ts` (`authenticatedAt` is `session.createdAt`, and refresh never moves it); `src/totp/factor.ts` (confirming TOTP revokes the user’s other sessions and keeps the current one); `src/sign-in.ts` (`onUserCreated` failures are logged and swallowed); `src/stores/types.ts` (`users.findById`, `users.findByEmail`, `totp.get` with `status` and `enabledAt`; no user listing); `src/routes.ts` (`AUTH_ROUTES`, including `/auth/logout-all` and `/auth/me`); `api/kit/server-core/MODULE.md` (per-router body parsers, CORS allows only `Content-Type` and `Authorization`, request logs keep `url`, query key `q` is redacted); `api/kit/mongo/MODULE.md` and `src/documentDb.ts` (partial filters may not use `$or`, `$not`, `$nor`, `$xor`, `$all`, `$mod`; no collation); `api/kit/rate-limit/MODULE.md`; `compose.yaml` (standalone Mongo, no replica set); `api/src/main.ts`; `api/package.json`; `package-lock.json` (`express` 5.3.0, `mongoose` 9.11.2, `vitest` 5.0.5, `testcontainers` 12.2.1, `@testcontainers/mongodb` 12.2.1 and `@types/express` 5.0.6 are already installed).
- Client: `client/README.md` says the client is `client`. On `feature/townwise-web` (staged in the `kit-infra` worktree, not committed): routes `/` (marketing home), `/about`, `/privacy`, `/security` (the marketing Security page), `/terms`, `/sign-in`, `/totp`, `/dashboard`, `/settings/security`, a Google button that reads “Continue with Google” on web and native, and self-hosted fonts.
- Design: `townwise-ds/project/README.md`, `tokens.json`, and the Nav, AppFrame, Button, StatusTag, FormField, Placeholder, NumbersTable, Toggle and Section READMEs; `ConsoleV2.dc.html`, `SignIn.dc.html`, `Privacy.dc.html`.
- Data: `townwise-home.json` (schema 1, year 2024, generated 2026-11-03): twelve towns with ids `hanover-nh`, `amherst-ma`, `ithaca-ny`, `burlington-vt`, `middlebury-vt`, `state-college-pa`, `bar-harbor-me`, `stowe-vt`, `conway-nh`, `north-elba-ny`, `provincetown-ma`, `nantucket-ma`. Conway, North Elba and Provincetown have one driver and no dates; Nantucket has neither.
- Checked again for the revision: `api/kit/auth/src/stores/types.ts` (`UserStore` has `findById`, `findByEmail`, `findByGoogleSubject`, `create`, `linkGoogleSubject` and `updateEmail`, and no delete; `TotpStore` has `startEnrollment`, `confirmEnrollment({ userId, step, recoveryCodeHashes, now })` and `remove`); `create-auth.ts` (`AuthDeps.now`, `revokeAllSessions`); `src/limits.ts` (`auth:ml-send-ip`, 20 per hour); `src/tokens.ts` (access tokens last 600 seconds); `api/kit/auth/package.json` (exports only `./src/index.ts`; the test helpers in `api/kit/auth/test/helpers/` are not exported); `api/kit/redis` (`RedisHandle.client`); `api/kit/rate-limit/src/limiter.ts` (keys are SHA-256 hashed before storage); `eslint.config.js` (`import-x/no-extraneous-dependencies` with `includeTypes: true` and devDependencies allowed only under `**/test/**`, `**/*.config.{js,ts}` and `tooling/**`; `import-x/no-relative-packages`); the installed `mongodb` driver is 7.7.0 and accepts `monitorCommands` in the connection string. On `feature/townwise-web`: `TownPanel.web.tsx` takes `cardRef` and `onBack`; no DeltaChart, MonthScrubber or NumbersTable component exists; `package.json` has no `react-native-svg`; `towns.ts` is staged, not committed; the privacy, security, terms and home copy quoted in Sections 17 and 22.4. On `feature/infra`: `infra/README.md` plans a MongoDB Atlas M0 cluster with a `readWrite` user on `townwise`.

---

## 1. Judging the three designs

### 1.1 Scores (1 to 10)

| Criterion | Security-first | Product-first | Minimal |
|---|---|---|---|
| Correctness against the requirements | 8 | 9 | 7 |
| Security | 10 | 7 | 6 |
| Clarity for restaurant owners | 7 | 10 | 7 |
| Simplicity | 4 | 6 | 9 |
| Fit with the kit | 7 | 8 | 6 |
| **Total, of 50** | **36** | **40** | **35** |

**Security-first.** It has the strongest isolation. Invitations are per organization, so adding an email never reveals or blocks anything in another organization. It also has one route table, GET-only view-as and audit written before the effect, and it noticed that server-core redacts the `q` query key. It costs too much for a beta: a hash-chained audit log with a verify endpoint, a Mongoose tenant-guard plugin, ESLint bans, a mirrored view-as namespace, eight limiters, an org Activity log, multi-location upload batches and per-location time zones. Its Overview at `/` collides with the marketing homepage on `feature/townwise-web`. It defers “Continue with Google” as a kit change, but that branch already renders it. Its staff check (“TOTP on, session under 60 minutes”) accepts the session that enrolled TOTP, which passed a code only to enroll, never at sign-in. Removed members land on Request access with no explanation.

**Product-first.** It has the clearest owner path. Approval creates the first location. The Waiting page shows the requester’s town. No access explains rejected, removed and paused separately, and the Forecast tab mirrors the homepage’s four steps. Its routes match the `(gate)` and `(app)` groups on `feature/townwise-web`. It reads the kit precisely: “session created after `enabledAt`” is exactly “this session passed a code”. Its weaknesses:

- It allows one live invitation per email across all organizations. That gives org admins an “unavailable” oracle and lets a hostile org admin squat a stranger’s address.
- It sets a 365-day calibration threshold that the homepage says is still being tested.
- It sums every row per date, which inflates guests on item-level exports.
- Its People page reads the kit’s `users` collection directly.

**Minimal.** It is the smallest build, and it has two ideas worth keeping. It asks whether a row is a day or a check, because item-level exports repeat the check’s guest count on every line. It reports file errors by row and column, never by value. Its weaknesses:

- View-as rides a `?viewAs=` query parameter authorized by any audit row from the last hour, so it is bound to the staff user, not the session.
- Membership is resolved by email on every request, so a Google email change loses access.
- It allows one email per organization, with the same oracle and squatting.
- Home at `/` and staff setup at `/security` both collide with marketing routes.
- An “In progress” tag on the client’s calibration step reads as work on their own model.

### 1.2 Base and grafts

The base is **Product-first**: its flows, pages, copy, routes, access-state model and per-session staff gate.

Grafted from Security-first:

- per-organization invitations with no cross-organization uniqueness, and a chooser when several organizations invited one email;
- change, recount, revert for the last admin;
- author-or-admin note edits, with `canEdit` on each note;
- uploads recorded as `applying`, then `applied`;
- the `q` key for email lookup;
- a 60-minute staff window;
- “Sign out everywhere” for staff;
- a log line per view-as read;
- product denials that are never 401;
- per-route body parsers;
- a branded `OrgScope`;
- a `strict: 'throw'` sales schema.

Grafted from Minimal:

- the day-or-check question and the refusal of item-level exports;
- errors by row and column;
- the `tw_` collection prefix;
- status derived from the data, with no stored calibration record in v1.

New in this synthesis:

- a Leave action and a one-time “Not your team?” notice after an automatic join that names who added the person, and a press-to-join screen for anyone who already has a pending request (the auto-join risk in F1);
- org admins see every Townwise staff action on their organization, view-as included;
- honest calibration states with no day threshold;
- a daily guests chart on the Sales data tab, on web, with a text and table fallback on native (D21);
- a staff-only deletion path for a person or a suspended organization (D22).

Not taken, and why:

- The hash-chained audit, tenant-guard plugin, ESLint import bans and mirrored view-as namespace are strong but heavy. The branded `OrgScope`, one route table, and isolation and view-as tests generated from that table cover the same failures for a beta. They are listed in Deferred.
- Security-first’s audit-before-the-effect for every action. This spec writes only staff actions first, refusing the action if the write fails (9.3, a [CONFIRM]). Client actions keep Product-first’s order: written after the effect, with a failed write logged at error level.
- The `?viewAs=` query parameter is not bound to a session.
- One live invitation per email creates an oracle and allows squatting.
- A 365-day threshold is an input claim the homepage says is untested.
- “Approve into an existing organization” is unnecessary: staff add the requester’s email on that organization instead (F2b).
- Reading the kit’s `users` collection touches a kit internal. The spec uses exact-email lookup through `users.findByEmail` instead.
- A `web_only` rule for staff is unnecessary: a 60-minute window behind TOTP already bounds a native session.
- Per-location time zones and archived locations are not needed: business dates are strings, and deleting an empty location is simpler.

---

## 2. Decisions at a glance

| # | Decision | Why | Marker |
|---|---|---|---|
| D1 | Three roles: `superadmin` (Townwise staff), `org_admin`, `member`. A staff address never resolves as a member. | Staff manage any organization’s team, name and status from the console, and each of those actions is shown to that organization’s admins (D9). They read sales figures and note text only through audited view-as (D7). | [CONFIRM: lead default, the three roles] |
| D2 | Staff are listed in `TOWNWISE_SUPERADMIN_EMAILS`. Every staff request needs TOTP enabled, a session created after TOTP was enabled, and a session at most 60 minutes old. | The kit cannot check a code per action without a kit change (Section 19). Once TOTP is on, every new session passes a code at sign-in. Confirming TOTP revokes the other sessions and keeps the current one, so “created after `enabledAt`” means “passed a code”. 60 minutes is as close to “every action” as the kit allows. | [CONFIRM: lead default, staff by config and TOTP for every staff action, read as a code at sign-in no more than 60 minutes ago] |
| D3 | An email on an organization’s list joins it automatically, with no click, the first time that person continues with Google. Anyone else lands on Request access. Staff approve, which creates the organization and makes the requester its org admin. One exception: a person who already has a pending request presses Join, and only then is the request withdrawn (F2b). | Lead default. The exception keeps an invitation the person never chose from skipping staff review. | [CONFIRM: lead default, auto-join, request access, approval. Conflict: the critic review recommends a one-click Join screen for every invitation, because auto-join lets an org admin pull a stranger into their organization (F1).] |
| D4 | Invitations are per organization. Two organizations may invite the same email; the person chooses. | No add result depends on another organization, so an org admin learns nothing about other customers and cannot block a stranger. | [CONFIRM: per-organization invitations] |
| D5 | One active organization per person. | A restaurant group is one organization with several locations. One unique index replaces an organization picker. | [CONFIRM: one organization per person] |
| D6 | Approval creates the organization, its first location and the requester’s admin seat. | The owner’s first page already shows their town and the upload step. | [CONFIRM: first location at approval] |
| D7 | Staff see client sales figures and note text only through view-as. Without it, the console shows team emails, location names and towns, counts, date coverage and recent audit events, and those reads are not recorded. Setup writes (D23) give staff no read access. | One audited exception to “visible only to that client”. | [CONFIRM: staff see values only through view-as] |
| D8 | View-as is bound to the staff session, lasts 30 minutes, needs a reason, refuses every write and every console route, resolves exactly as the target user, gate pages included, and ends when the target’s organization changes. | “Exactly what the client sees.” | [CONFIRM: lead default, read-only, audited, bannered; 30 minutes; any non-staff user as target] |
| D9 | Org admins see every Townwise staff action on their organization: each view-as with the staff email and reason, and every team, name and status change staff make. | Trust around private data. Not requested by the user. | [CONFIRM: show staff activity to org admins, with staff emails] |
| D10 | The browser parses the file and sends only `{ date, guests, netSalesCents }` per day for one location. | Lead default. POS exports can contain customer names. | [CONFIRM: lead default, browser-side parsing, three fields] |
| D11 | The column mapper never renders a cell, except the distinct values of a column the user names as the location column. | Names stay off the screen and out of screenshots. | [CONFIRM: no cell contents in the mapper] |
| D12 | Calibration states in v1: no sales data, and not calibrated. No day threshold is shown. | No fake output. The homepage says the history needed is still being tested. | [CONFIRM: lead default, honest states] [DECISION NEEDED: minimum days of history before calibration] |
| D13 | Tuning is structured notes per location: closure, private event, opening, other. An AI chat waits. | Lead default. | [CONFIRM: lead default, notes first, AI chat later] |
| D14 | Townwise sends two emails, each only to the person it concerns and only after the change it reports is written: request received (F2) and you’re in (F3, from the call that seats the requester). They come from `no-reply@townwise.tech` through Azure Communication Services, sent with the API’s managed identity, with Reply-To from `TOWNWISE_EMAIL_REPLY_TO`, no images and tracking off. Invitations, rejections, view-as and every other flow send none. A failed send is logged as a code, with no address, and never blocks, fails or retries the action. Email is off until `EMAIL_ENDPOINT` is set; production turns it on in the release whose F2, F3, P3, P4 and C3 copy stops saying “We don’t send email yet”. | Owner decision, 2026-11-05. People are held until staff approve, so they need to hear when they’re in. A rejection email waits on an owner question (whether it quotes the staff message). | Decided (owner, 2026-11-05) |
| D15 | An organization has one or more locations. Sales, uploads and notes belong to a location. | Lead default. | [CONFIRM: lead default, per-location data] |
| D16 | Members and org admins can upload and write notes. A member’s upload adds new days only; an org admin’s replaces the days it covers. Only org admins manage the team, locations, the organization name and deletion. | The person with POS access is often a manager. Replacing history is as destructive as deleting it, which is admin-only. | [CONFIRM: member permissions; members add new days only] |
| D17 | No multi-document transactions. Writes are ordered so a retry completes them, and unique indexes catch races. | Local Mongo is standalone (`compose.yaml`), and production DocumentDB sets `retryWrites=false`. | none (a fact) |
| D18 | Authorization is resolved on every request from the primary. Removing a member never signs them out. | They see an honest page on their next request, not a sign-in loop. | [CONFIRM: no session revoke on removal] |
| D19 | Product denials are 403 or 404, never 401. | The shell refreshes on any 401 (kit client contract). | none (a kit contract) |
| D20 | Upload is web only. | A native file picker is a new dependency. | [CONFIRM: web-only upload] |
| D21 | The town profile (P4, P15) and the sales chart (P12) render on web only. Native shows each chart’s text summary and “Show the numbers” table, built from View and Text, plus “See the chart at townwise.tech.” | The client has no `react-native-svg`, and adding it is a new dependency. | [CONFIRM: web-only charts] |
| D22 | Staff can delete a person’s Townwise records, or a suspended organization’s. The audit log keeps the events with the email or names replaced. The kit’s user record is then deleted by hand. | The privacy page and Terms on `feature/townwise-web` already promise deletion on request. | [CONFIRM: staff-only deletion in v1; suspend before deleting an organization] |
| D23 | Staff setup. While an organization is active and nobody has ever held a seat in it (open invitations don’t count), staff can add, rename, change the town of and delete (when empty) its locations, and upload or delete its daily totals, from its console page (F10b, 10.7). It is write-only: answers carry ids, names, towns, counts and date coverage, never a figure, and staff still read values only through view-as (D7). It ends at the first join and never reopens, even once everyone has left, and it is closed while the organization is suspended (409 `org_not_in_setup`). Each setup write is recorded before it takes effect and shown to the organization’s admins once they join (D9), and the uploads it makes read “Townwise staff”, never the staff email. Staff use it with a real client’s data only with that client’s consent. | A client who sends their history before anyone on their team signs in finds a populated page on their first visit, not an empty one. It never reopens because an organization everyone left belongs to a former client, with no admin to see a staff write in their activity. | [CONFIRM: staff can add locations and upload daily totals for an organization nobody has joined yet; write-only; ends at the first join; used only with the client's consent] |
| D24 | A request and Add location take up to 25 checked Google places; each becomes a location. | Owner request, 2026-11-09: a restaurant group checks each of its places in one search, instead of adding them one at a time after approval. | [CONFIRM: a request carries up to 25 checked Google places, and approval creates a location for each, named by staff from Google's name] |

---

## 3. Roles and permissions

| Capability | Staff | Staff in view-as | Org admin | Member | Signed in, no organization |
|---|---|---|---|---|---|
| Read own access state (`GET /api/me`) | yes | the target’s | yes | yes | yes |
| Send an access request | no | no | no | no | yes, in `no_org`, `rejected`, `removed` |
| Join, or decline, an organization that invited their email | no | no | no | no | yes, in `invited` |
| Read the organization, locations, town profiles, sales, notes, calibration | team emails, location names and towns, counts and date coverage (D7) | read-only | yes | yes | no |
| Upload sales | only during setup (D23), new and replaced days | no | yes, new and replaced days | yes, new days only | no |
| Delete all sales for a location | only during setup (D23) | no | yes | no | no |
| Add notes; edit or delete own notes | no | no | yes | yes | no |
| Edit or delete anyone’s notes | no | no | yes | no | no |
| Add, rename, change the town of, or delete (when empty) a location | only during setup (D23) | no | yes | no | no |
| Rename the organization | any | no | own | no | no |
| Read the team | any | read-only, if the target is an org admin | own | no | no |
| Add emails, change roles, remove people | any | no | own | no | no |
| Leave the organization | no | no | yes, unless last admin | yes | no |
| See Townwise staff activity on the organization | audit log | read-only, if the target is an org admin | yes | no | no |
| Approve or reject requests; create, rename, suspend, reactivate organizations | yes | no | no | no | no |
| See everyone across organizations; sign a person out everywhere | yes | no | no | no | no |
| Read the audit log | yes | no | no | no | no |
| Delete a person’s records, or a suspended organization’s (D22) | yes | no | no | no | no |
| Start view-as | yes | no | no | no | no |
| End view-as | yes | yes | no | no | no |
| Two-step sign-in (`/settings/security`, **Exists**) | required | not applicable | optional, recommended | optional | optional |

Rules behind the matrix:

- An organization always keeps at least one active org admin. Demoting, removing or leaving as the last one answers 409 `last_admin`, for org admins and staff alike.
- A staff email can be invited like any other, but it never resolves as a member, because the staff branch runs first.
- Only the addresses in `TOWNWISE_SUPERADMIN_EMAILS` are staff. Any other address a staff member adds to an organization, a personal Gmail included, joins as an ordinary member with full member access, no banner and no time limit. That row shows “Added by Townwise staff” on Team (P17), and the add appears in the organization’s staff activity (9.3).
- Every staff action on an organization (team, name, status, view-as, setup) is recorded before it takes effect and shown to that organization’s admins (9.3).
- Removed people keep their kit user. They may request access for another organization, or join another that invited them.

---

## 4. Access states and routing

### 4.1 Types

```ts
type Role = 'org_admin' | 'member';

type Access =
  | { state: 'staff' }
  | { state: 'staff_setup_required' }                          // staff email, TOTP not enabled
  | { state: 'staff_reauth_required'; reason: 'session_before_codes' | 'session_too_old' }
  | { state: 'member'; org: { id: string; name: string }; role: Role }
  | { state: 'invited'; invitations: InvitationView[]; pendingRequest: AccessRequestView | null }
  | { state: 'pending'; request: AccessRequestView }
  | { state: 'rejected'; request: AccessRequestView }
  | { state: 'removed'; org: { name: string }; removedAt: string; byYou: boolean }
  | { state: 'org_suspended'; org: { name: string } }
  | { state: 'no_org' };

interface InvitationView {
  inviteId: string; orgName: string; role: Role;
  invitedBy: { staff: boolean; email: string | null };  // email: the org admin's current kit email;
                                                         // null when staff added it, or that account no longer exists
}

interface MeResponse {
  user: { id: string; email: string };        // always the signed-in person; during view-as, built from the staff actor (7.2)
  access: Access;                              // during view-as: the target's access
  viewAs: ViewAsView | null;
  staff: { verifiedUntil: string } | null;    // set whenever the signed-in person's own state is 'staff'
  welcome: { firstName: string | null; restaurant: string } | null;   // GET /api/me only (15.8); null in every other answer
}
```

### 4.2 Resolution order (`resolveAccess`)

Input: the kit’s `AuthContext` (`userId`, `sessionId`, `platform`, `authenticatedAt`). Output: `{ self: Access; effective: Access; grant: Grant | null }`. `self` is the signed-in person’s own access, computed before any view-as substitution; `effective` is what policies evaluate. Every read is from the primary. The resolver never writes. It reads the time only from the injected `now` (7.1).

1. Load the kit user (`users.findById`). If it is missing, answer 401 `unauthenticated`, the kit’s own answer for a deleted user, through the one helper `userGone()`. No other product code answers 401 (D19).
2. **Staff branch**, when the user’s current email is in `TOWNWISE_SUPERADMIN_EMAILS`:
   1. `totp.get(userId)` is not `enabled`: `staff_setup_required`.
   2. `authenticatedAt <= factor.enabledAt`: `staff_reauth_required`, reason `session_before_codes`.
   3. `now − authenticatedAt > 60 minutes`: `staff_reauth_required`, reason `session_too_old`.
   4. Otherwise `self` is `staff`, with `verifiedUntil = authenticatedAt + 60 minutes`. If a grant for this `sessionId` is live by time (Section 8), resolve its target with steps 3 to 7 (never step 2). The target’s resolved organization id is the organization of its active seat (step 3, active or suspended), or null. If that id equals `grant.orgId` (null equals null), the target’s access is `effective` and the grant is returned, so `viewAs` is set. Otherwise the grant is ignored exactly as an expired one, and `effective` is `self`.
3. An active seat (`tw_members.activeUserId == userId`): `member` if the organization is `active`, `org_suspended` if it is `suspended`.
4. Open invitations for the user’s current email (`tw_members.inviteEmail == email`, `status: 'invited'`) in active organizations: `invited`, listing all of them.
5. A pending request by this user: `pending`.
6. The newer of the latest rejected request and the latest removed seat: `rejected` or `removed`.
7. Otherwise `no_org`.

Outside the staff branch, `self` and `effective` are the same access.

An invitation outranks a pending request, so a second employee who requested access by mistake sees their team on `/joining` as soon as an admin adds them. With a pending request, the state carries it as `pendingRequest`, and `/joining` never joins on load: the request is withdrawn only when the person presses Join, and “Not my team” deletes the invitation and returns them to Waiting (F2b).

### 4.3 Client routing

The client calls `GET /api/me` after restore, after sign-in, after join and after leave. It calls it again whenever an `/api` call answers 403 `no_access`, `forbidden`, `staff_setup_required` or `staff_reauth_required`, or 409 `view_as_active`. It clears cached organization data before it re-routes.

| State | Route |
|---|---|
| `staff` | `/admin`; with `viewAs` set, the target’s route under the view-as banner |
| `staff_setup_required` | `/settings/security` with the staff notice (**Exists**; notice added) |
| `staff_reauth_required` | `/staff/sign-in-again` |
| `member` | `/dashboard` |
| `invited` | `/joining` |
| `pending` | `/waiting` |
| `rejected`, `removed`, `org_suspended` | `/no-access` |
| `no_org` | `/request-access` |

The gate also allows `/request-access` from `rejected` and `removed`, when the person chooses it on No access. Any other route opened in the wrong state redirects to that state’s route. Route names extend the `(gate)` and `(app)` groups on `feature/townwise-web`. [CONFIRM: route names]

---

## 5. Flows

### F1. First sign-in with an invited email

1. An org admin adds `{email}` on Team. A `tw_members` row is created with `status: 'invited'`, `inviteEmail: {email}` and the chosen role (default `member`). Audit `member.invited`.
2. The admin tells the person. Townwise doesn’t email invitations (D14), and the Team page says so.
3. The person presses “Continue with Google”. The kit creates or finds their user (**Exists**).
4. `GET /api/me` answers `invited`. With one invitation and no pending request, `/joining` shows “Joining {org}…” and who added them, and calls `POST /api/me/join { inviteId }` at once (lead default). With a pending request, or with two or more invitations, `/joining` lists them and waits for a press: Join on one, or “Not my team” on any (P6).
5. The server compare-and-sets the invitation to `active`. It matches `_id`, `status: 'invited'`, `inviteEmail` equal to the caller’s current email, and an active organization. It sets `userId`, `activeUserId` and `joinedAt`, and unsets `inviteEmail`. Then it withdraws any pending request of the caller (`withdrawnReason: 'joined_org'`), audits `member.joined`, and answers the new `MeResponse`.
6. `/dashboard` shows once: “You joined {org}. {inviter} added {email}. Not your team? Leave {org}.” {inviter} is the org admin’s email, “Townwise staff”, or {org} when that account no longer exists. Leave is on Settings.

[CONFIRM: lead default, auto-join without a click. Conflict: the critic review recommends dropping the automatic join for every invitation. The attack it describes: the org admin of any vetted organization renames it to a stranger’s business name (`PATCH /api/org`, not unique, not reviewed), adds a location in the stranger’s town, and adds the stranger’s Gmail address, often published on a restaurant’s website. The next time the stranger continues with Google, they join silently, see their own business name and town and the upload step, and cannot see the team (members have no Team page). Anything they upload, the org admin reads. Staff vetting covers the org admin’s own organization, not a right to enroll strangers, and the Leave notice shows once. A joined invitation also turns Active on the inviter’s Team page, which tells the inviter that the address uses Townwise. The recommended alternative: `/joining` always shows a one-click screen naming the organization and who added the person, with the primary “Join {org}” and the text link “Not my team”, and a test that join never runs from `GET /api/me` or on page load. It still needs no email and no approval, only one press. This spec keeps the lead default and narrows it: the notice names who added the person, and a pending request is never withdrawn without a press (F2b).]

Branches:

- **Different Google account than the one invited:** the state is `no_org`, so Request access. That page leads with “Joining a team that already uses Townwise? Ask an admin there to add {email}.” and ends with “Signed in as {email}. Using the wrong Google account? Sign out and continue with another one.”
- **An address Google is not authoritative for** (not Gmail, not Workspace): the kit refuses sign-in with 403 `google_email_not_authoritative`, and the sign-in page shows its existing message (**Exists**). Team warns admins before they add an address.
- **Already active elsewhere:** the update hits the unique `activeUserId` index, which answers 409 `already_in_org`. The client re-reads `/api/me`.
- **Invitation removed meanwhile:** 409 `no_invite`. The client re-reads `/api/me`.
- **Not my team:** `POST /api/me/decline { inviteId }` deletes that invitation, matching it exactly as join does. Audit `member.declined`. The row disappears from the inviter’s Team page. The client re-reads `/api/me`.

### F2. Request access

1. A person in `no_org` lands on `/request-access`. The form asks for organization name, their name, their role, the town (one of the twelve, or another town and state), number of locations and an optional note. The business can be found on Google Places first (10.2a); the request then also carries the places the person checked, `places` (each `{ placeId, name, town }`), optional (D24).
2. `POST /api/access-requests`. A unique partial index allows one pending request per user. Audit `access_request.created`, with `hasPlace`, `placeCount` and never a place id or name. [CONFIRM: a request keeps the place the requester picked; staff check it by hand]
3. `/waiting` shows what was sent, “We don’t send email yet, so check back here.”, and the public profile of the town they named. [CONFIRM: town profile while waiting]

**F2b. Invited while pending.** At the next `GET /api/me` the person is `invited`, with `pendingRequest` set. `/joining` does not join on load. It names the organization and who added them, and offers “Join {org}” and “Not my team”. Join withdraws the request. “Not my team” deletes the invitation, and the request stays with staff, so an invitation the person never chose cannot skip staff review. This is also how staff place a requester into an existing organization: they add the requester’s email on that organization’s page, and the requester presses Join.

### F3. Staff approve a request

1. Staff open `/admin` (Requests, Pending) and read the request: organization, contact name and role, email (and the email at request time if it changed), town, location count, note, the place id when there is one, sent date. A warning shows when the requester already holds a seat.
2. Staff validate the person by hand, outside Townwise: for example, the email domain matches the restaurant, or a phone call. [CONFIRM: what “validated manually” means in practice]
3. “Approve” opens a dialog with the organization name and first location name, both prefilled and editable, and the town shown. For a request with places, the dialog shows a Location name per place instead (prefilled with Google’s name, empty for a request stored before places) with the place’s town, and “Each location needs its own name.” stops an empty or repeated name (C3).
4. `POST /api/admin/requests/:requestId/approve`, with `{ orgName, locationName }` for a request without places and `{ orgName, locationNames }` for one with them (`locationNames` in the same order and number as the places, each 1 to 80, unique by name key, 6.4; any other body is 400 `invalid_request`, before anything is written):
   1. Load the request (404 if missing). If it is `approved` with an `orgId`, skip to step 6 (a retry completes the work).
   2. If it is not `pending`: 409 `request_not_pending`.
   3. If the requester holds an active seat: 409 `requester_has_org`.
   4. Generate `orgId`. Audit `access_request.approved` with it, before the change (staff events are written first, 9.3).
   5. Compare-and-set the request from `pending` to `approved`, with `orgId`, `decidedAt` and `decidedBy`. No match: 409 `request_not_pending` (another staff member got there first), and the server writes `staff_action.not_applied`.
   6. Upsert the organization `{ _id: orgId }` with `$setOnInsert`: name, `active`, `createdAt`, `createdBy`, `fromRequestId`. Audit `org.created` on insert.
   7. Without places: upsert the first location keyed by `{ orgId, nameKey }` with `$setOnInsert`: name, the town from the request, and `placeId` null. Audit `location.created` on insert. With places (D24), while the organization is new or nobody has ever joined it (no `firstJoinedAt`, 6.1, and no member row with `joinedAt`, active or removed, as staff setup reads it): upsert one location per place the same way, with its name, the place’s town and its `placeId`, skipping places that already have a location in it, and audit `location.created` on each insert. So a retry fills only the missing ones; a retry whose name is on another place’s location answers 409 `location_name_taken`, never a merge.
   8. Insert the requester’s seat: `role: 'org_admin'`, `status: 'active'`, `userId`, `activeUserId`, `joinedAt`, `email` (the requester’s current kit email). A duplicate key in this organization counts as success. A duplicate in another organization (the requester joined elsewhere in the gap) answers 409 `requester_has_org`; the organization then exists with no admin, and its detail page shows “No admin yet”. Audit `member.joined`. [Build note: after inserting the seat, the server reads the request again. Gone means the requester was deleted meanwhile (10.7, Deletion): the seat is deleted, and, when nobody else is in it, the organization and the locations made for the request, with their names redacted as in an organization deletion; no `member.joined` is written, and the answer is 404, with `staff_action.not_applied` (`not_found`) for the approval event this call wrote.]
5. The requester sees their organization at their next `GET /api/me`. No email is sent.

### F4. Staff reject a request

1. “Reject” opens a dialog with an optional message of up to 500 characters, which the requester will see.
2. `POST /api/admin/requests/:requestId/reject { message? }` audits `access_request.rejected` with `hasMessage` (never the message) first (9.3), then compare-and-sets `pending` to `rejected`. No match: 409 `request_not_pending`, and `staff_action.not_applied`.
3. The requester sees `/no-access` (rejected variant) with the message and “Send a new request”. [CONFIRM: rejected people may send a new request]

### F5. Org admin adds emails

1. On `/team` the admin pastes up to 20 addresses (one per line, or comma separated) and picks a role (default Member). [CONFIRM: role chosen at invite, default member]
2. `POST /api/org/members` normalizes each address exactly as the kit does (`trim().toLowerCase()`, then `z.email().max(254)`) and collapses duplicates. Each address gets one outcome, which never depends on any other organization:
   - `invited`: a row was created. Audit `member.invited`.
   - `already_invited`: this organization has an open invitation for it.
   - `already_member`: an active member of this organization has that email.
   - `invalid`: not an email.
3. The page lists the outcomes and the updated team.

Staff do the same for any organization from its detail page. Those rows carry `addedByStaff: true`, Team shows them as “Added by Townwise staff”, and each add appears in the organization’s staff activity (9.3).

### F6. Org admin edits the team

- **Change role:** `PATCH /api/org/members/:memberId { role }`. For a demotion, update, then count active admins. If the count is zero, set the role back and answer 409 `last_admin`. Audit `member.role_changed`.
- **Remove an invitation** (never joined): delete the row. Audit `member.removed` with `wasStatus: 'invited'`.
- **Remove a member:** set `status: 'removed'`, `removedAt` and `removedBy`, unset `activeUserId`, then count active admins. If zero, restore the row and answer 409 `last_admin`. Audit `member.removed`. An admin may remove themself when another admin exists.
- Change, recount, revert never ends with zero admins, needs no lock, and two concurrent demotions either both revert or one wins. [Build note: this holds for staff edits and for leaving (F7) too, against any mix of concurrent demotions and removals. A demotion from org admin marks the row (`demotingSince`) in the same write and clears the mark after its recount or revert; a removal recounts when the seat was an org admin or carried that mark, read in the same write as the removal, so a member can still leave, and be removed from, an organization with no active admin yet. A demotion recounts only when the row was an active seat at its write, so an invitation’s role never counts. A demotion’s revert matches the row by id, organization and the role it set, whatever its status, so a seat removed meanwhile gets its admin role back and the removal’s own recount puts the seat back. When a seat can’t be put back because the person took a seat in another organization meanwhile, the removal stands and is answered and recorded as done.]

### F7. Losing access, and leaving

- **Removed by an admin:** the person’s next `/api` call answers 403 `no_access`. The client re-reads `/api/me` (`removed`), clears cached organization data and shows `/no-access` (removed variant). Their session stays (D18).
- **Leave:** `POST /api/org/leave` from Settings. It is the same as remove, for oneself, with `byYou: true` and audit `member.left`. The last admin gets 409 `last_admin`.
- **Organization suspended by staff:** members see `/no-access` (paused variant). Data is kept, and reactivation restores access with no other step.
- **Rejected request:** `/no-access` (rejected variant).
- **Compromised account:** staff use “Sign out everywhere” on People (kit `revokeAllSessions`, **Exists**).

### F8. View-as

1. Staff pick a person (on People, a request’s detail, or a member row on an organization’s page) and press “View as”. A dialog asks for a reason (5 to 200 characters) and says it is recorded.
2. `POST /api/admin/view-as { userId, reason }`. Staff targets get 400 `invalid_target`; unknown users get 404. The server clears any grant still holding this session, expired or not (Section 8), writes audit `view_as.started` first, and then inserts the grant. If the audit write fails, no grant exists.
3. The response is a `MeResponse` with the target’s access and `viewAs` set. The client renders the target’s screens under a banner that cannot be dismissed.
4. While the grant is live, every route with the `staff` policy, any method, answers 409 `view_as_active`. Every other non-GET answers 403 `view_as_read_only`. `POST /api/admin/view-as/end` (policy `staff_self`) is exempt from both (7.2).
5. “End view-as” ends the grant (audit `view_as.ended`) and returns to `/admin`. The resolver ignores a grant past its end, and a grant whose target has joined, left or changed organization since it started. The next request returns staff access, and the client shows “View-as ended at {time}.” on `/admin`.

### F9. Staff first sign-in, and the hourly sign-in

1. A staff email continues with Google, and `GET /api/me` answers `staff_setup_required`. The client opens `/settings/security` (**Exists**) with the notice “Townwise staff accounts need two-step sign-in. Set up your authenticator app, then sign in again with a code.”
2. After enrollment the kit shows recovery codes once and revokes the other sessions (**Exists**). This session predates `enabledAt`, so the resolver answers `staff_reauth_required` (`session_before_codes`), and the client offers “Sign in again”. The second sign-in goes through the code step, which also proves the authenticator works.
3. Every 60 minutes staff sign in again with a code on `/staff/sign-in-again`. The shell has no return-to route (expo-shell Known gaps, **Exists**), so staff land on `/admin`.

Runbook line: add a staff email only when that person will sign in and enroll within minutes. Until they enroll, anyone who takes over their Google account could enroll a factor of their own. People shows each staff email’s two-step status.

### F10. Staff create an organization directly

For an organization signed outside the app: on `/admin/orgs`, “New organization” asks for the name and the first admin’s email. `POST /api/admin/orgs` creates the organization and an invitation with `role: 'org_admin'` and `addedByStaff: true`. That person joins as admin the next time they continue with Google (F1). [Build note: the request may carry `id`, a 24-hex id the client generates once per new organization. A repeat with that `id` (a retry) creates nothing new: it answers 200 with that organization and writes no second `org.created`. It is a repeat only for an active organization made this way (no `fromRequestId`) with the same name, whose team holds the same admin address or nobody yet; any other organization with that `id` is 409 `conflict`. The one thing a repeat adds is the admin invitation of a create that stopped before it, with `member.invited` written before the insert. A repeat that races the first past its check loses on the unique `_id`, and its `org.created` is followed by `staff_action.not_applied` (`conflict`).] No location is created yet; the admin’s first page asks for one. The organization’s staff activity lists its creation and the invitation. [CONFIRM: staff can create organizations without a request]

### F10b. Staff set up an organization nobody has joined yet

For a client whose daily totals Townwise already holds, used only with that client’s consent (D23). While the organization is active and nobody has ever held a seat in it (after F10 it has only its admin invitation), staff add, rename and delete its locations and upload or delete their daily totals from its console page (P21), through the setup routes of 10.7. The checks are the org admin routes’ (10.3, 11.3), town and place included, and an upload replaces the days it covers, as an org admin’s does. Each write is recorded before it takes effect (9.3), and staff see the result as counts and date coverage only, never a figure (D7). Once anyone joins (F1) or is seated by approval (F3), every setup route answers 409 `org_not_in_setup` for good, even after everyone has left or been removed and their records are deleted; so does a suspended organization. The admin who joins finds the locations and their days, sees each staff upload as by “Townwise staff”, and finds every setup write in their Townwise staff activity (D9). [Build note: setup is checked before the event, with no lock, so a join that lands between the check and the write is accepted; the write is still recorded and shown in staff activity.]

### F11. Upload sales history (web)

Rules are in Section 11. The entry points are Home’s history step and upload links (P11), the Sales data tab, and its empty state. An org admin’s upload replaces the days it covers; a member’s adds new days only and leaves existing days unchanged (D16, 11.4).

### F13. Delete a person or an organization (staff)

Rules are in 10.7 (Deletion). Staff delete a person from People (P22) after removing any active seat, or delete an organization from its detail page (P21) after suspending it. Each writes its audit event first, deletes the Townwise records, and replaces the email or names in older audit events. A deleted person’s kit user record is then deleted by hand (Section 19, item 7).

### F12. Add a note

Rules are in Section 12. The entry points are the Notes tab and “Add a closure note” beside the missing-days count on Sales data, which prefills kind `closure` and effect `closed`.

---

## 6. Data model

All collections take the `tw_` prefix, so they never collide with the kit’s `users` and `auth_*`. Each is a Mongoose model with a fresh schema built inside a factory, registered on `mongo.connection` before `ensureIndexes` (**Exists**). Schemas use `strict: true` (`strict: 'throw'` for sales), `versionKey: false` and `read: 'primary'`. Ids are ObjectIds, and `userId` is the kit’s user id string (24 hex). Business days are `'YYYY-MM-DD'` strings with no time zone. Money is integer cents. Partial indexes use only `$type` and equality filters; DocumentDB 5.0 rejects `$or`, `$not` and others (**Exists**).

### 6.1 `tw_orgs`

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | |
| `name` | string | 2 to 120, trimmed, not unique |
| `status` | `'active' \| 'suspended'` | |
| `createdAt`, `createdBy` | Date, userId | |
| `fromRequestId` | ObjectId or null | set when created by approval |
| `suspendedAt` | Date or null | |
| `firstJoinedAt` | Date, or absent | when someone first took a seat: set only while unset (a compare-and-set) right after the seat write of a join (F1) or an approval (F3), and by a person deletion, from the person’s earliest `joinedAt` there, before it deletes their removed seats (10.7); never cleared, so staff setup never reopens (D23). Absent on organizations nobody has joined and on documents from before the field |

Indexes: `{ createdAt: -1 }`.

### 6.2 `tw_members` (invitations and memberships, one collection)

| Field | Type | Rule |
|---|---|---|
| `_id`, `orgId` | ObjectId | |
| `email` | string | normalized; the invited address, or the requester’s email for an approval seat; kept for history |
| `role` | `'org_admin' \| 'member'` | |
| `status` | `'invited' \| 'active' \| 'removed'` | |
| `inviteEmail` | string, present only while `invited` | |
| `userId` | string or null | set on join |
| `activeUserId` | string, present only while `active` | |
| `invitedAt`, `invitedBy` | Date, userId | `invitedBy` is the org admin or staff member who added it |
| `addedByStaff` | boolean | true when a staff principal added the address (F5 from the console, F10); false for org admins’ invitations and for the requester’s seat at approval |
| `joinedAt` | Date or null | |
| `removedAt`, `removedBy` | Date or null, userId or null | `removedBy == userId` means they left |

Indexes:

- `{ orgId: 1, inviteEmail: 1 }` unique, `partialFilterExpression: { inviteEmail: { $type: 'string' } }`: one open invitation per address per organization.
- `{ activeUserId: 1 }` unique, `partialFilterExpression: { activeUserId: { $type: 'string' } }`: one active organization per person (D5).
- `{ inviteEmail: 1 }`: the resolver’s invitation lookup.
- `{ orgId: 1, status: 1 }`: team lists and admin counts.
- `{ userId: 1, removedAt: -1 }`: the `removed` state.

Email changes: the kit updates `users.email` when Google is authoritative for a new address (kit T27). A seat is bound by `userId` after joining, so access survives the change, and the display uses the current kit email.

### 6.3 `tw_access_requests`

| Field | Type | Rule |
|---|---|---|
| `_id`, `userId` | ObjectId, string | |
| `emailAtRequest` | string | snapshot for staff review |
| `orgName` | string | 2 to 120 |
| `contactName` | string | 1 to 120 |
| `contactRole` | string | 1 to 80 |
| `town` | `{ townId: TownId \| null; name: string; state: string }` | Section 13 |
| `locationCount` | integer | 1 to 50 |
| `note` | string or null | up to 1,000; shown to staff only as plain text |
| `places` | `{ placeId, name, town }[]` | up to 25 checked Google places in check order; ids as `placeId`, unique; `name` Google’s name as checked, 1 to 80; each its own town (Section 13). (D24) |
| `placeId` | string or null | optional Google place id, 10 to 512 letters, digits, `_` or `-` (`api/src/place-id.ts`) [CONFIRM: place ID format]; documents from before it read as null; set by the requester, so staff check it by hand [CONFIRM: a request keeps the place the requester picked; staff check it by hand] No longer written; a document that has one reads it as `places: [{ placeId, name: null, town }]` with the request’s town. |
| `status` | `'pending' \| 'approved' \| 'rejected' \| 'withdrawn'` | |
| `createdAt`, `decidedAt`, `decidedBy` | | |
| `decisionMessage` | string or null | up to 500; shown to the requester on rejection |
| `orgId` | ObjectId or null | set on approval |
| `withdrawnReason` | `'joined_org'` or null | |

Indexes: `{ userId: 1 }` unique with `partialFilterExpression: { status: 'pending' }` (one pending request per person); `{ status: 1, createdAt: -1 }`; `{ userId: 1, createdAt: -1 }`.

### 6.4 `tw_locations`

| Field | Type | Rule |
|---|---|---|
| `_id`, `orgId` | ObjectId | |
| `name` | string | 1 to 80 |
| `nameKey` | string | `name` trimmed, lowercased, inner spaces collapsed |
| `town` | `{ townId: TownId \| null; name: string; state: string }` | |
| `placeId` | string or null | the Google place id. Approval copies the request’s (F3 step 7). An org admin sets or changes it through the Places search on Add location (P10) or Location settings (P16), and the API stores Google’s current id once the town is checked against Google (10.3). Null otherwise: a location added without the search, a `placeId: null` write, or a town changed by hand. Older documents read as null |
| `createdAt`, `createdBy` | | |
| `byStaff` | `true`, or absent | set only on a location staff added during setup (D23), whose `createdBy` is the staff user id |

Indexes: `{ orgId: 1, nameKey: 1 }` unique; `{ orgId: 1, createdAt: 1 }`. Limit: 25 per organization. [CONFIRM: 25 locations]

### 6.5 `tw_sales_days`

| Field | Type | Rule |
|---|---|---|
| `_id`, `orgId`, `locationId` | ObjectId | `orgId` and `locationId` come from the location the server read, never from input |
| `date` | `'YYYY-MM-DD'` | |
| `guests` | integer or null | 0 to 20,000 |
| `netSalesCents` | integer or null | 0 to 100,000,000 |
| `uploadId` | ObjectId | the upload that last wrote this day |
| `updatedAt` | Date | |

Indexes: `{ orgId: 1, locationId: 1, date: 1 }` unique. The schema is `strict: 'throw'`, and the write path builds documents field by field, so no other field can be stored.

### 6.6 `tw_uploads`

`_id`, `orgId`, `locationId`, `uploadedBy` (userId), `uploadedAt`, `status` (`'applying' | 'applied'`), `dayCount`, `inserted`, `replaced`, `kept` (days a member’s upload left unchanged because they already had data; always 0 for an org admin’s), `firstDate`, `lastDate`, `hasGuests`, `hasNetSales`, and `byStaff: true` only on an upload staff made during setup (D23), whose `uploadedBy` is the staff user id. It holds no file name (file names can contain people’s names), no column names and no row count. Index: `{ orgId: 1, locationId: 1, uploadedAt: -1 }`. A stored file's days (11A) get their own record too, written by the file reader; until this record gains a `fileId` (with the sales history work, 10.10), the link is the file's `uploadId` (6.11).

### 6.7 `tw_notes`

Fields are in Section 12. Index: `{ orgId: 1, locationId: 1, startDate: 1 }`. Limit: 1,000 per location. [CONFIRM: 1,000 notes]

### 6.8 `tw_view_as_grants`

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | |
| `actorUserId`, `actorSessionId` | string | the staff member and their kit session id |
| `activeSessionId` | string, present only while not ended | |
| `targetUserId` | string | |
| `orgId` | ObjectId or null | the target’s resolved organization at start (4.2 step 2.4); the grant is live only while the target’s resolved organization still equals it |
| `reason` | string | 5 to 200 |
| `startedAt`, `expiresAt` | Date | `expiresAt = startedAt + 30 minutes` [CONFIRM: 30 minutes] |
| `endedAt`, `endReason` | Date or null, `'ended' \| 'replaced' \| 'expired'` or null | `expired` when the grant is cleared after `expiresAt` (Section 8) |

Indexes: `{ activeSessionId: 1 }` unique, `$type` partial (one live grant per session); `{ actorUserId: 1, startedAt: -1 }`. Grants are never deleted.

### 6.9 `tw_audit_events`

Fields are in Section 9. Indexes: `{ at: -1 }`, `{ orgId: 1, at: -1 }`, `{ actorUserId: 1, at: -1 }`, `{ orgId: 1, actorRole: 1, at: -1 }` (staff activity for org admins). No TTL. The only update is the deletion redaction (9.3). [CONFIRM: keep audit events indefinitely]

### 6.10 Isolation rules

1. Every tenant document (`tw_members`, `tw_locations`, `tw_sales_days`, `tw_uploads`, `tw_notes`, `tw_files`, `tw_imports`, `tw_upload_days`, `tw_file_entries`, `tw_files_usage`) carries `orgId`. Every tenant compound index leads with `orgId`, except the two seat indexes, which are keyed by the person.
2. Tenant store functions take a branded `OrgScope` as their first argument and add `orgId: scope.orgId` to every filter, update, delete and insert. Only `api/src/access/policy.ts` can mint an `OrgScope`, and only through these six functions:
   - `scopeOf(memberPrincipal)`: member routes (rule 3).
   - `scopeForStaffOrg(staff, orgId)`: `/api/admin/orgs/:orgId/*` (rule 5). It reads the organization first and answers 404 if it is absent.
   - `scopeForNewOrg(staff, orgId)`: approval (F3) and staff creation (F10) only, for the organization those handlers just created.
   - `scopeForJoinedInvite(invite)`: the join handler only, after its compare-and-set succeeds.
   - `scopeForClaimedImport(claim)`: the file reader only (`files/worker.ts`, 11A), for the organization of the import it just claimed.
   - `scopeForSweep(found)`: the daily file sweep only (`files/sweeper.ts`, 11A.7), for the organization of a file, an import or a blob it found.
3. Handlers on `/api/org/*` take the organization only from the principal. No member route carries an organization id in its path, query or body.
4. Location-scoped routes first load `{ _id: locationId, orgId }`. Another organization’s location answers 404 `not_found`, exactly like a location that does not exist. Children (sales, uploads, notes) copy `orgId` and `locationId` from that read.
5. Staff routes on `/api/admin/orgs/:orgId/*` mint a scope from the path through one function that requires the `staff` principal and reads the organization first (404 if absent).
6. Responses never include another organization’s ids or names, except the invitation list shown to its invitee.
7. Path ids are parsed with the mongo module’s `objectId` schema, so a malformed id is 400. Filter values are zod scalars. The only operators are built in code and wrapped in `trusted(...)` (**Exists**).
8. Operations keyed by a person, or spanning organizations, live in one file, `api/src/stores/cross-tenant.ts`, with a closed list: `findActiveSeat(userId)`, `findOpenInvites(email)`, `claimInvite(inviteId, email, userId)`, `declineInvite(inviteId, email)`, `latestRemovedSeat(userId)`, `adminOrgStats()`, `peopleRecords()`, `deletePersonRecords(userId, email)` (10.7, Deletion), the file reader's `claimNextImport()` (11A) and the daily file sweep's `claimFileSweep()`, `finishFileSweep()`, `sweepCandidates()`, `removeOldUploadDays()` and `existingFileIds()` (11A.7). Only `access/resolve.ts`, the join and decline handlers, the staff handlers, `files/worker.ts` and `files/sweeper.ts` import it, and a test enforces that list.
9. Stored files' blob names are ids only, `{orgId}/{locationId}/{fileId}`, built in `api/src/files/blobs.ts` from the scope's `orgId` and ids the files store already checked belong to it; no request value becomes a path. `blobs.ts` is the only file that imports the Azure SDK, and `chat/*` imports no file code (test-enforced). One API identity reaches every organization's blobs, so isolation is in code and tests; the custom role keeps the API to the two client-file containers, and the private endpoint keeps the data plane off the internet.

### 6.11 `tw_files`

One row per stored file (11A). `_id` (the file id, used in blob names), `orgId`, `locationId`, `importId`, `purpose` (`'history'`), `uploadedBy` (userId), `uploaderRole` (`'org_admin' | 'member'` at upload; decides replace or add, 11.4), `uploadedAt`, `name` (the original file name: last path part, control characters removed, NFC, at most 255 characters; shown to the organization only, never logged, audited, put in a blob name or a URL, or sent to a model), `kind` (`'text' | 'xlsx' | 'xls' | 'pdf' | 'docx' | 'doc' | 'zip' | 'other'`), `sizeBytes`, `fingerprint` (SHA-256 over the chunk size and each chunk's SHA-256 in order, `townwise-chunks-v1:{chunkSize}:{hashes}`, so the same file uploaded again matches; it is not the file's plain SHA-256), `upload` (while uploading: `{ chunkSize, chunkCount, chunks: ({ bytes, sha256 } | null)[], head (first 8 KiB, base64), expiresAt }`; null after complete), `status` (`'uploading' | 'stored' | 'queued' | 'reading' | 'waiting' | 'read' | 'kept' | 'failed' | 'deleting'`), `outcome` (11A.6), `progress` (while reading: `{ phase, done, total, unit, phaseStartedAt, updatedAt }`), `readStartedAt`, `readMs`, `answers` (per sheet index), `uploadId`, `result` (counts and dates), `report` (11A.5), `cleanBytes`, `rawDeletedAt` (the name becomes the kind's label then, a workbook's sheet names in `report.sheets` become `Sheet 1`, `Sheet 2` and so on, and a ZIP's entry paths are cleared), `attempts`, `entries` (a ZIP's `{ total, used, kept }`, once listed), `modelCalls` and `costMicroUsd` (the AI column step's calls for this file, 11A.4), `aiChoices` (each call's answer, column indexes only, keyed by a SHA-256 of the redacted profile it was asked about, so a re-read of the same table reuses it without a call), `purgeRaw` (set by a staff purge while the file was busy, 10.7). The person's answers are keyed by sheet index, or `family:<signature>` for a family of a ZIP's tables. `strict: 'throw'`. Indexes: `{ orgId: 1, locationId: 1, uploadedAt: -1 }`, `{ orgId: 1, importId: 1, uploadedAt: 1 }`, `{ orgId: 1, locationId: 1, fingerprint: 1 }`, `{ status: 1, 'upload.expiresAt': 1 }`, `{ status: 1, uploadedAt: 1 }` and `{ purgeRaw: 1 }` (sparse) (the sweep).

### 6.12 `tw_imports`

A batch of files dropped for one location (11A). `orgId`, `locationId`, `createdBy`, `createdAt`, `lastDropAt`, `status` (`'open' | 'queued' | 'reading' | 'waiting' | 'done'`), `activeLocation` (equals `locationId` until done, then unset), `startedAt`, `finishedAt`, `question` (11A.4, while waiting), `appliedVersion` (+1 each time a file's days are written), `drops` (+1 each time a file completes into it), `lease` (`{ owner, until }`), `claimedAt`, `bytesRead`, `msRead` (over its finished files, for the reading speed). Indexes: `{ activeLocation: 1 }` unique with a `$type` partial filter (one active import per location; two first drops race on it and the loser reads the winner), `{ orgId: 1, locationId: 1, createdAt: -1 }`, `{ status: 1, startedAt: 1 }` (the reader's claim).

### 6.13 `tw_files_usage`

What the file reader's AI column step (11A.4) has cost each organization per UTC month: `{ orgId, month (YYYY-MM), costMicroUsd, updatedAt }`, unique `{ orgId: 1, month: 1 }`, only ever `$inc`'d. Apart from `tw_chat_usage`, so neither budget eats the other's. Deleted with the organization.

### 6.14 `tw_file_sweeps`

One document, `{ _id: 'sweeper', owner, leaseUntil, lastRunAt }`: the daily file sweep's leader lease across replicas (11A.7). Cross-tenant by nature, so only `stores/cross-tenant.ts` reads or writes it.

### 6.15 `tw_welcomes`

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | |
| `orgId` | ObjectId | the organization the welcome was shown in |
| `userId` | string | the person it was shown to |
| `seenAt` | Date | when the client started showing it; a later record keeps the first time (`$setOnInsert`) |

Index: `{ orgId: 1, userId: 1 }` unique. A display marker, not an action, so it has no audit event. Deleted with the organization (10.7) and with the person, in every organization. [Build note: numbered 6.15 by the build plan, which reserves 6.11 to 6.14 for stored files.]

### 6.16 `tw_chat_proposals`

What the author did with each note TownwiseAI proposed in their conversation (10.12). One document per proposal they acted on; none means the proposal is still open.

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | |
| `orgId`, `locationId`, `conversationId` | ObjectId | from the caller's seat and their own conversation |
| `userId` | string | the conversation's author |
| `proposalId` | string | the `propose_note` call's id, 1 to 128 of `A-Za-z0-9_-` |
| `status` | `'saving' \| 'saved' \| 'dismissed'` | `saving` between the claim and the note's write; reads as open |
| `noteId` | ObjectId | set when the document is inserted, a dismissed one too, so every try of a save writes the same note |
| `edited` | boolean | the saved note differs from the proposal ("Edit first") |
| `createdAt`, `updatedAt` | Date | |

Indexes: `{ orgId: 1, conversationId: 1, proposalId: 1 }` unique; `{ orgId: 1, locationId: 1 }`. It never holds the note's content. Deleted with the conversation, the location, the organization (10.7) and the author's person deletion (10.7, by `userId`); notes saved from proposals stay with the organization. Rows left by a crash during a conversation's delete, or by a Save racing it, hold only ids and go with the location, the organization or the person (`tuning-chat.md` section 5).

### 6.17 `tw_agent_answers`

The answers to TownwiseAI's questions about a location's days with no sales (10.12). One document per question answered; none means it is still asked.

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | |
| `orgId`, `locationId` | ObjectId | from the caller's seat and the location route |
| `questionId` | string | `weekday_{0-6}_{from}_{to}` or `gap_{from}_{to}`: dates and a weekday number only |
| `answer` | `'closed' \| 'open' \| 'not_sure'` | a later try of a `saving` answer may change it, unless it is `closed` with its note written; a `done` one stands, except that a `closed` try whose note is written overrules a different answer finished at the same moment |
| `noteId` | ObjectId | set when the document is inserted, whatever the answer, so every try of a `closed` answer writes the same closure note |
| `status` | `'saving' \| 'done'` | `saving` between the claim and the end; the question is still asked until `done` |
| `createdAt`, `updatedAt` | Date | |

Index: `{ orgId: 1, locationId: 1, questionId: 1 }` unique. No person id (the audit event `agent.question_answered` carries the actor) and no text. Deleted with the location's sales data (10.4: an answer was about those days, so the same days uploaded again are asked about again), the location and the organization (10.7); a person's deletion has nothing of it to delete. Closure notes saved from answers stay with the organization, as every note does.

### 6.18 `tw_file_entries`

One row per entry of a stored ZIP (11A.4): `{ orgId, locationId, fileId, index (central-directory order), path (sanitized: control characters removed, NFC, at most 300 characters; shown to the organization only, null under view-as, cleared when the ZIP's original is deleted), depth (1 or 2), kind, sizeBytes (declared, uncompressed), status ('used' | 'kept' | 'failed'), outcome, family (its table's header signature), dayCount }`. Unique `{ orgId: 1, fileId: 1, index: 1 }`; `{ orgId: 1, locationId: 1 }`. Written in batches of 500 when the ZIP is read, replaced on a re-read; deleted with the file, the location's sales data and the organization.

### 6.19 `tw_upload_days`

`{ orgId, day (YYYY-MM-DD, UTC), bytes, updatedAt }`, unique `{ orgId: 1, day: 1 }`. Creating an upload reserves its size with a conditional `$inc` that fails past the daily cap; cancelling an unfinished upload the same day gives it back.

### 6.20 `tw_forecast_runs`

One per forecast run file staff imported for a location (14.4). Outputs and metadata only; the model never reaches the API.

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | the run id |
| `orgId`, `locationId` | ObjectId | from the staff route's organization and a location loaded with its scope |
| `metric` | `'guests'` | |
| `model` | `{ family, version, notebookCommit }` | family `hybrid_linear_xgboost \| linear_median \| weekday_median`; version `v{n}`; the `modeling/` commit |
| `trainingSource` | `'files_from_owner'` | `'townwise_uploads'` is reserved until the DECISION NEEDED in 14.1 is answered |
| `trainedFrom`, `dataThrough`, `madeAt` | `YYYY-MM-DD` | the first and last day of sales the model saw, and when it was made |
| `frozen` | `{ files: { name, sha256 }[] } \| null` | the frozen CSVs in `modeling/forecasts/` it was exported from |
| `interval` | `{ level: 0.8, widened }` | |
| `backtest` | `{ from, to, weeks, weeklyTypicalErrorPct, weeksOver20Pct, weeklyRangePct } \| null` | typed in from the forecasts README |
| `range`, `dayCount`, `weekCount` | | the first and last day; counts |
| `fileSha256` | string | over the file's canonical JSON |
| `status` | `'importing' \| 'draft' \| 'published' \| 'withdrawn'` | |
| `importedBy`, `publishedBy` | string \| null | staff user ids; set to null on that person's deletion |
| `importedAt`, `publishedAt`, `withdrawnAt` | Date \| null | |

Indexes: `{ orgId: 1, locationId: 1, fileSha256: 1 }` unique; `{ orgId: 1, locationId: 1, status: 1, dataThrough: -1 }`; `{ orgId: 1, importedAt: -1 }`. Strict (`'throw'`). Deleted with its rows by staff, with the location, with the location's sales data and with the organization (10.7).

### 6.21 `tw_forecasts`

One row per day and per week of a run: `orgId`, `locationId`, `runId`, `span` (`'day' | 'week'`), `from`, `to` (equal for a day), `status` (a day's `open | closed | booked`; null for a week), `low`, `mid`, `high` (null on a closed or booked day), `baseline` (null unless the run recorded one), `openDays` (a week's), `reasons` (`{ kind, ref, effectPct }[]`, kind `weekday | term | event | holiday | level | closure | booking`; `ref` a town calendar id or group, kept only when it names an entry on that day). Labels are never stored. Indexes: `{ orgId: 1, locationId: 1, runId: 1, span: 1, from: 1 }` unique; `{ orgId: 1, locationId: 1, span: 1, from: 1 }`; `{ orgId: 1, runId: 1 }`. Strict (`'throw'`); rows are built field by field and upserted on their key, so a retried import writes only what is missing.

---

## 7. Authorization in one place

### 7.1 Module layout

All of it lives under `api/`; nothing changes in `api/kit/*`.

```
api/
  src/
    main.ts            Exists. Composition root: builds config, logger, Mongo, Redis and auth as today, calls
                       createTownwiseApi() before ensureIndexes, and mounts its router at /api
    app.ts             createTownwiseApi({ config, logger, connection, authStores, auth, redis, now }): registers the
                       Townwise models on `connection` and returns the /api router. main.ts and the tests both use it
    email.ts           Exists. Unchanged (the kit's magic-link sender, which rejects every send)
    mail/              templates, layout, the Communication Services transport and the mailer (D14)
    azure-identity.ts  managed-identity tokens for Azure services, cached per resource (D14; file storage too)
    config.ts          Townwise env schema (TOWNWISE_SUPERADMIN_EMAILS), spread into the one loadEnv call
    towns.ts           the twelve { townId, name, state, kind } (Section 13) and the US state codes
    normalize-email.ts the kit's email rule, repeated and pinned by a parity test (Section 19)
    access/
      resolve.ts       resolveAccess(): the only code that decides staff, membership, organization and view-as
      policy.ts        Principal, the five policies, the view-as guard, the four OrgScope mint functions (6.10)
      routes.ts        TOWNWISE_ROUTES and mountTownwiseRoutes()
    stores/            one file per collection; tenant stores require OrgScope; cross-tenant.ts (6.10 rule 8)
    handlers/          me, requests, org, locations, sales, notes, team, admin, view-as, deletion
  test/                integration tests against Mongo and Valkey in Docker, as the kit's are; helpers/ (Section 20)
```

**One clock.** `now` is the same function `main.ts` passes to `createAuth` (`AuthDeps.now`, **Exists**), and Townwise code reads the time only from it: the staff window, view-as grants, the upload date rule and audit timestamps. A test clock then ages kit sessions and Townwise rules together.

**Types without new packages.** The Redis client is typed `RedisHandle['client']` from `@ckeith26/redis`, and driver types come from `mongoose.mongo.*`, so `src/` imports no `ioredis` or `mongodb` types (Section 19, item 5).

### 7.2 The route table

```ts
type Policy = 'signed_in' | 'member' | 'org_admin' | 'staff' | 'staff_self';

interface TownwiseRoute {
  readonly id: string;                          // 'org.locations.create'
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: `/${string}`;                  // under /api
  readonly policy: Policy;
  readonly bodyLimit: 'none' | '2kb' | '32kb' | '256kb'; // 'none' for GET and DELETE; '2kb' only on the two Places routes; '256kb' only on the upload route
  readonly limiter?: 'uploads' | 'requests' | 'view-as' | 'chat' | 'places';   // 'writes' applies to every non-GET automatically, before resolveAccess
  readonly handler: (req: Request, res: Response, principal: Principal) => Promise<void>;
}
```

`mountTownwiseRoutes(router, TOWNWISE_ROUTES)` builds every route with the same chain:

1. `auth.requireAuth` (kit): 401 `unauthenticated`; 403 `origin_not_allowed` for a cookie request without an allowlisted Origin (**Exists**).
2. **`townwise:writes` limiter**, for every non-GET, keyed on `acct:<userId>` from `authOf(req)`. It runs before any read or parse, so refused and probing writes count too.
3. `resolveAccess(authOf(req))` produces the `Principal` (from `self` and `effective`, 4.2).
4. **View-as guard**, in this order, when the principal is in view-as:
   1. A route with policy `staff`, any method, answers 409 `view_as_active`.
   2. Any other non-GET answers 403 `view_as_read_only`.
   3. The route with policy `staff_self` (`POST /api/admin/view-as/end`) is exempt from both.
   
   Each GET that passes logs `townwise.view_as_read { grantId, routeId }`.
5. **Policy**, evaluated on `effective` except `staff_self`:
   - `signed_in`: anyone who passed step 1.
   - `member`: `access.state === 'member'`, else 403 `no_access`.
   - `org_admin`: `member` and `role === 'org_admin'`. A member gets 403 `forbidden`; anyone else gets 403 `no_access`.
   - `staff`: passes only for a principal of kind `staff`, which never carries view-as. `staff_setup_required` and `staff_reauth_required` answer 403 with those codes. Everyone else gets 403 `forbidden`, and the staff checks run after the email check, so a non-staff caller never learns anything about staff two-step state.
   - `staff_self`: the signed-in person’s own staff gate (`self`: TOTP enabled, session created after `enabledAt`, under 60 minutes), computed before the view-as substitution. It passes for a `staff` principal and for any principal in view-as, because a grant is live only while its actor passes that gate. Otherwise it answers exactly as `staff` does. Used only by `POST /api/admin/view-as/end`.
6. **Body parser**, `express.json({ limit })`, when the spec names a body limit. The guard and the policies never read the body, so a refused request is never parsed. The `/api` router mounts no router-wide parser, so the upload route’s 256 KB parser never widens the others (server-core: body parsing is per router, **Exists**).
7. **Route limiter**, when named (`uploads`, `requests`, `view-as`, `places`; Section 10.8; `chat` in `docs/portal/tuning-chat.md`), keyed on `acct:<userId>`.
8. The handler receives the principal. For member routes, `principal.scope` is the only organization it can use.

Boot throws if two specs share a method and path, if a GET spec names a body limit, or if any route other than `view-as/end` uses `staff_self`. Paths not in the table reach server-core’s `notFound` (**Exists**).

```ts
interface StaffActor { userId: string; email: string; sessionId: string; verifiedUntil: string }
interface ViewAsContext { grantId: string; actor: StaffActor }   // the staff member doing the viewing

type Principal =
  | { kind: 'staff'; actor: StaffActor }
  | { kind: 'member'; userId: string; email: string; scope: OrgScope; role: Role; memberId: string;
      viewAs: ViewAsContext | null }
  | { kind: 'other'; userId: string; email: string; access: Access; viewAs: ViewAsContext | null };
```

In view-as, `userId` and `email` are the target’s, and `viewAs.actor` is the staff member. `MeResponse.user` and `MeResponse.staff` are built from the actor whenever there is one (`actor`, or `viewAs.actor`). `view-as/end` takes the session id from `viewAs.actor.sessionId`. Audit events use the actor, and view-as writes nothing except its own start and end.

### 7.3 GET is side-effect free

Every GET handler only reads (kit Security 5: GET handlers must be side-effect free). A test runs every GET route with Mongo command monitoring and fails on any `insert`, `update`, `delete`, `findAndModify` or `bulkWrite` (Section 20).

---

## 8. View-as mechanics

- **Start** (`POST /api/admin/view-as`, policy `staff`). The server validates the target: it must exist and must not be staff. Before writing `view_as.started`, it compare-and-sets every grant with `activeSessionId == ctx.sessionId`, whether or not it has expired: `$set { endedAt: now, endReason: expiresAt <= now ? 'expired' : 'replaced' }`, `$unset { activeSessionId }`, and audits `view_as.ended` for each. Under a live grant the guard has already answered 409, so this clears a grant that expired without End, or one ignored because its target changed organization. Then it audits `view_as.started` with the target user and email, organization, reason and `expiresAt`, and inserts the grant with `activeSessionId = sessionId` and `orgId` = the target’s resolved organization (4.2 step 2.4). A duplicate key that remains (two tabs starting at once) answers 409 `view_as_active`. It returns the new `MeResponse`.
- **Live grant:** `activeSessionId == ctx.sessionId`, `endedAt == null`, `expiresAt > now`, the staff gate passes on this request, and the target’s resolved organization id equals `grant.orgId` (null equals null). If any of these fails, there is no view-as for that request.
- **Effect:** the resolver runs steps 3 to 7 of Section 4.2 for `targetUserId` and returns that access with `viewAs` set. Whatever the target sees now (dashboard, Waiting, No access) is what staff see, including the target’s 403s.
- **Tracks the target’s organization.** If the target joins, leaves, is removed from or is approved into an organization while the grant runs, the grant stops being live at once, exactly as on expiry: the next `GET /api/me` returns staff access, and `/admin` shows “View-as ended at {time}.” Viewing the target again starts a new grant and writes a new `view_as.started` with the new `orgId`, which that organization’s admins see.
- **End time shown to staff:** `viewAs.endsAt = min(grant.expiresAt, staff.verifiedUntil)`, because the 60-minute staff window ends view-as too.
- **Bound to one session:** another tab of the same browser shares the session cookies, so it shares the view-as, and every tab shows the banner because every tab reads `/api/me`. A different device or browser does not share it.
- **End** (`POST /api/admin/view-as/end`, policy `staff_self`, exempt from the view-as guard). It compare-and-sets the grant holding this session, live or expired: `endedAt`, `endReason: 'ended'` (or `'expired'` when `expiresAt <= now`), and unsets `activeSessionId`. Then it audits `view_as.ended`. It is idempotent: with no grant on the session it answers 200 with the current `MeResponse`.
- **Client:** the banner and disabled controls are specified in Section 15.5. The upload wizard’s file step is disabled too, so no client file is ever read into a staff browser.
- **Record:** the audit log keeps start and end with the reason. Each request in between writes the log line `townwise.view_as_read { grantId, routeId }` and no response data. [CONFIRM: no audit event per read]

```ts
interface ViewAsView {
  id: string;
  target: { userId: string; email: string };
  org: { id: string; name: string } | null;
  role: Role | null;
  reason: string;
  startedAt: string;
  endsAt: string;
}
```

---

## 9. Audit log

### 9.1 Record

```ts
interface AuditEvent {
  _id: ObjectId;
  at: Date;
  actorUserId: string;
  actorEmail: string;                         // snapshot
  actorRole: 'superadmin' | 'org_admin' | 'member' | 'user';
  viewAsGrantId: string | null;
  orgId: ObjectId | null;
  action: AuditAction;
  target: { type: 'org' | 'member' | 'request' | 'location' | 'upload' | 'note' | 'user' | 'grant' | 'conversation' | 'file'; id: string };
  details: Record<string, string | number | boolean | null>;   // allowlist per action, below
}
```

### 9.2 Actions and their allowlisted details

| Action | Details |
|---|---|
| `access_request.created` | `orgName`, `townId`, `townName`, `hasPlace` (boolean: whether any place was sent), `placeCount` (never a place id, a place name or an address) |
| `access_request.approved` | `orgId` |
| `access_request.rejected` | `hasMessage` |
| `access_request.withdrawn` | `reason: 'joined_org'` |
| `org.created` | `name`, `via: 'request' \| 'staff'` |
| `org.renamed` | `from`, `to` |
| `org.suspended`, `org.reactivated` | none |
| `org.deleted` | none (ids only: the event’s `orgId` and target) |
| `member.invited` | `email`, `role` |
| `member.declined` | `email` |
| `member.joined` | `email`, `role` |
| `member.role_changed` | `email`, `from`, `to` |
| `member.removed` | `email`, `wasStatus` |
| `member.left` | `email` |
| `location.created`, `location.updated`, `location.deleted` | `name`, `townId`; from `POST` and `PATCH /api/org/locations` also `hasPlace` (boolean: whether the location has a Google place after the write; never the place id or an address; approval’s `location.created` leaves it out); staff setup’s (D23) are written before the effect, with the values the write will leave, `hasPlace` included |
| `sales.uploaded` | `locationId`, `dayCount`, `inserted`, `replaced`, `firstDate`, `lastDate`; from the file reader also `fileId` and `via: 'file'`, with the uploader as actor; staff setup’s (D23) is written before the days and leaves out `inserted` and `replaced`, which exist only after |
| `sales.deleted` | `locationId`, `deletedDays`, `deletedFiles`; staff setup’s (D23) is written before the delete, with `deletedDays` the days with a value at that moment and no `deletedFiles` |
| `file.uploaded` | `locationId`, `kind`, `sizeBytes` |
| `file.deleted` | `locationId`, `kind`, `reason: 'owner'` |
| `file.raw_deleted` | `locationId`, `kind` |
| `files.raw_deleted_all` | `locationId`, `count` (an org admin deleted every original of a location) |
| `org.originals_deleted` | `count`, `basis` (`data_subject_request`, `org_request` or `other`, an enum, never free text); staff, target the organization, recorded before the effect (9.3), and shown in the organization's staff activity |
| `note.created`, `note.updated`, `note.deleted` | `locationId`, `kind`, `startDate`, `endDate` |
| `agent.question_answered` | `locationId`, `questionId` (dates and a weekday number only), `answer` (`closed`, `open` or `not_sure`); a `closed` answer's closure note is also recorded `note.created` (10.12) |
| `forecast.imported`, `forecast.published`, `forecast.withdrawn`, `forecast.deleted` | `locationId`, `modelVersion`, `from`, `to`, `dayCount` (target `forecast_run`; staff actions, written before the effect; never a figure) |
| `view_as.started` | `targetUserId`, `targetEmail`, `reason`, `expiresAt` |
| `view_as.ended` | `endReason` (`ended`, `replaced` or `expired`) |
| `people.signed_out_everywhere` | none (written before the effect, 9.3; the revoked count is in the response) |
| `person.deleted` | `userId` (null when the address never signed in); ids only |
| `staff_action.not_applied` | `eventId` (the staff event it qualifies), `code` |

Never in an audit event: guest or sales figures, note `detail` text, request notes, decision messages, a file name or anything from a file, tokens.

An event’s `orgId` is the organization it touches: for `people.signed_out_everywhere`, the target’s active organization at the time, or null; for `view_as.*`, the grant’s `orgId`.

### 9.3 Rules

- **Append only, with one redaction path.** The store exposes `insert`, `query`, and `redact`, which only the deletion handlers call (10.7, Deletion). For a deleted person, `redact` replaces their email with “deleted person” in `actorEmail`, `details.email` and `details.targetEmail`. For a deleted organization, it replaces the organization’s name with “deleted organization” and its locations’ names with “deleted location” in `details.name`, `details.from`, `details.to` and `details.orgName`, in events with that `orgId` and in its request’s `access_request.created`. No other code path updates or deletes an event. [Build note: the organization’s fields are chosen by action (`org.created` name, `org.renamed` from and to, `location.*` name, the request’s `orgName`), so names from before a rename go too and `member.role_changed`’s from and to, which are roles, stay. A person’s events are also found by user id: the `actorEmail` of every event they acted in, the `details.email` of their own `member.joined`, `member.left` and `member.declined`, and the `targetEmail` of every view-as of them, whatever address they had then. And `details.email` is redacted, in anyone’s events, for every address the person is known by: the current one, those on their seats (`email`) and requests (`emailAtRequest`), read before they are deleted, and those their own events and the events about their seats hold. So other people’s `member.invited`, `member.role_changed`, `member.removed` and approval-time `member.joined` under an older address go too.]
- **When it is written.**
  - Events by org members and org admins are written after the effect succeeds. If such a write fails, the action stands, the server logs `townwise.audit_write_failed { action, orgId, targetId }` at error level, and the response is still success.
  - Every staff action’s event (actor role `superadmin`) is written before the effect, `view_as.started` included. Handlers run their read-only checks first (404, validation), then write the event, then act. If the write fails, the action is refused with 503 `unavailable` and nothing changes. If the effect then fails or is refused (for example 409 `last_admin`, or a duplicate key), the server writes `staff_action.not_applied { eventId, code }`, so the record never claims a change that did not happen. [Build note: a request with several changes (a staff rename and status change together, or several addresses added) writes all its events first, then makes its changes in one write, so a refusal never follows an applied change; an event already written when a later one is refused gets `staff_action.not_applied` with code `unavailable`. The codes are a closed list: the refusal’s error code, `conflict`, `unavailable` or `internal`.]
  - For approval and staff creation, the staff action’s event is `access_request.approved` or `org.created`; the follow-on records (`org.created` at approval, `location.created`, `member.joined`, `member.invited`) are written after their steps, as client events are.
  - `view_as.ended` is written after the grant is cleared. A missing end record can only make a view look longer than it was, never hide one.
  
  [CONFIRM: audit after the effect for client actions; before the effect, refused on failure, for staff actions]
- **Email writes no audit event.** Sending one of the D14 emails is a side effect of an action already audited; its event is unchanged, and nothing records the send.
- **Readers.** Staff read everything on `/admin/audit`. Org admins read every event on their own organization whose actor role is `superadmin` (view-as, team, name, status, setup writes (D23), and `staff_action.not_applied`), on Settings as “Townwise staff activity” (D9). Members read none.

---

## 10. API

The `/api` router mounts beside `/auth` in `createServer`’s `routes`; the two are disjoint (**Exists**: `createServer` refuses an overlapping mount order). Bodies are JSON. Error bodies are the kit’s `{ error, message, retryAfterSeconds? }` (**Exists**). Ids are 24-hex strings and times are ISO 8601.

No route puts an email, a name or a figure in its path or query, because server-core logs `url` (**Exists**). The one exception is the people lookup, which uses the query key `q`, which server-core redacts (**Exists**).

### 10.1 Shared shapes

```ts
type TownId = 'hanover-nh' | 'amherst-ma' | 'ithaca-ny' | 'burlington-vt' | 'middlebury-vt' | 'state-college-pa'
  | 'bar-harbor-me' | 'stowe-vt' | 'conway-nh' | 'north-elba-ny' | 'provincetown-ma' | 'nantucket-ma';
interface Town { townId: TownId | null; name: string; state: string }          // state: two capital letters
type TownInput = { townId: TownId } | { townId: null; name: string; state: string };

interface AccessRequestView {
  id: string; orgName: string; contactName: string; contactRole: string; town: Town;
  locationCount: number; note: string | null; places: { placeId: string; name: string | null; town: Town }[];
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  createdAt: string; decidedAt: string | null; decisionMessage: string | null;
}

interface Coverage {
  dayCount: number;                 // days with guests or net sales
  guestsDayCount: number; netSalesDayCount: number;
  firstDate: string | null; lastDate: string | null;
  missingDays: number;              // days between first and last with no row
}

type Calibration =
  | { state: 'no_sales_data' }
  | { state: 'not_calibrated'; dayCount: number; firstDate: string; lastDate: string };

interface LocationSummary {
  id: string; name: string; town: Town; placeId: string | null; coverage: Coverage; calibration: Calibration;
  notesCount: number; lastUploadAt: string | null;
}

interface SalesDay { date: string; guests: number | null; netSalesCents: number | null }

interface UploadView {
  id: string; uploadedAt: string; uploadedByEmail: string; status: 'applying' | 'applied';
  dayCount: number; inserted: number; replaced: number; kept: number; firstDate: string; lastDate: string;
  hasGuests: boolean; hasNetSales: boolean;
}

interface MemberView {
  id: string; email: string; role: Role; status: 'invited' | 'active';
  invitedAt: string; joinedAt: string | null; isYou: boolean; addedByStaff: boolean;
}

type AddResult = { email: string; outcome: 'invited' | 'already_invited' | 'already_member' | 'invalid' };

interface StaffActivityView {
  at: string; staffEmail: string;
  summary: string;                     // the server's plain-words summary, as in AuditEventView
  viewAs: { targetEmail: string; reason: string; endsAt: string } | null;   // view_as.started only
  notApplied: boolean;                 // a staff_action.not_applied event qualifies this one
}
```

[Build note: `notApplied` is built as `applied: boolean` (false when a `staff_action.not_applied` event qualifies the row) and `notAppliedReason: string | null` (that event’s code in plain words, for example “The organization needs at least one admin”). A `staff_action.not_applied` event is never a row of its own, so a refused staff change shows once, as not applied, and the newest 50 rows are 50 staff actions.]

Emails shown for people (`uploadedByEmail`, `createdByEmail`, `MemberView.email` for a seat) are the current kit email, read at response time. When the kit user no longer exists, they read “Deleted person”. An upload staff made during setup (D23) reads “Townwise staff”, never the staff email.

### 10.2 Access

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/me` | signed_in | | 200 `MeResponse`, with `welcome` filled for the welcome statement (15.8) | |
| `POST /api/me/join` | signed_in | `{ inviteId }` | 200 `MeResponse` | 403 `forbidden` (staff); 409 `no_invite`, `already_in_org` |
| `POST /api/me/decline` | signed_in | `{ inviteId }` | 200 `MeResponse` | 403 `forbidden` (staff); 409 `no_invite` |
| `POST /api/me/welcome` | member; `writes` only | no body | 204, idempotent (the first `seenAt` stays) | 403 `no_access`; 403 `view_as_read_only`; 429 |
| `POST /api/access-requests` | signed_in, in `no_org`, `rejected` or `removed` | `{ orgName, contactName, contactRole, town: TownInput, locationCount, note?, places? }`, `places` 1 to 25 of `{ placeId, name (1 to 80), town: TownInput }`, ids unique, `locationCount` at least `places.length` | 201 `MeResponse` (state `pending`; the request answers `places`, `[]` when none) | 403 `forbidden` (staff or another state); 409 `request_exists`; 400 `unknown_town` (the request’s town or a place’s); 400 `invalid_request` (malformed places, repeated ids or a count below the places); 429 |

Only `GET /api/me` fills `welcome`; every other answer that carries a `MeResponse` (join, decline, a request, view-as start and end, leaving) carries `welcome: null`. `GET /api/me` still writes nothing (7.3): `POST /api/me/welcome` records the marker (6.15). [Build note: the route is `me.welcome`, `bodyLimit: 'none'`, no route limiter and no audit event.]

### 10.2a Places search

Two routes let the request form (P3), Add location (P10) and Location settings (P16) find the business on Google Places (New). The API calls Google itself, so the browser talks only to the API, except for the map image below, which it loads from Google (the CSP's `img-src` allows `https://maps.googleapis.com`). Both are `signed_in`, take a 2 KB body and use the `places` limiter (10.8).

| Method and path | Request | Success | Extra errors |
|---|---|---|---|
| `POST /api/places/autocomplete` | `{ input, sessionToken? }`, `input` 2 to 120 characters after trimming, `sessionToken` a version 4 UUID | 200 `{ suggestions, sessionToken }`, up to 5 `{ placeId, name, detail }` (`detail` empty when Google has none) | 400 `invalid_request`; 413; 429; 503 `places_unavailable` |
| `POST /api/places/details` | `{ placeId, sessionToken }`, `placeId` as in 6.3, `sessionToken` required | 200 `{ place: { placeId, address, town, map } }`, `town` a `TownInput` or null, `map` `{ url, width: 640, height: 320 }` or null | 400 `invalid_request`; 404 `place_not_found` (Google answered 404, or 400 `INVALID_ARGUMENT` for the id); 413; 429; 503 `places_unavailable` |

- Off until `GOOGLE_PLACES_API_KEY` is set: both routes answer 503 `places_unavailable` to every request, and the client shows the manual fields. Google failing, or not answering within 5 seconds, answers the same.
- Both calls of one search carry the same session token; Google bills the typing and the pick as one session, and the details call ends it. Without a token, autocomplete makes one and returns it. The server checks only its format and keeps no record of it.
- Autocomplete asks for US results in English, of any business type. `name` is Google’s main text and `detail` its secondary text. Details asks for the place’s id, formatted address and address components only; `address` is for display, and the client keeps the name from the suggestion it picked. `placeId` in the answer is Google’s current id for the place, which can differ from the one sent.
- `town` is one of the twelve researched towns when the locality, postal town, sublocality or `administrative_area_level_3` matches one by name and state, ignoring case, or when any of them is an alias (Lake Placid, NY is `north-elba-ny`; North Conway, NH is `conway-nh`). Otherwise it is `{ townId: null, name, state }`, named by the first of those components. It is null outside the 50 states and DC, or when no usable town name exists. [CONFIRM: the town matching rules, which are not yet checked against live Google answers]
- Nothing from these routes is stored. The typed text, place ids, addresses, Google’s answers and the signed map URL never reach a log or an audit event; a Google failure logs `townwise.places_failed { routeId, code, status, errType }`.
- `map` is a Google Maps Static image of the place for the found card: `url` is a `https://maps.googleapis.com/maps/api/staticmap` URL the API signs with `GOOGLE_MAPS_SIGNING_SECRET`, holding `GOOGLE_MAPS_STATIC_KEY`, a key restricted to the Maps Static API with unsigned requests refused. The browser or the native app loads it straight from Google, which sees the viewer’s IP address; the API never fetches, relays or keeps the image. `map` is null while either variable is unset, and a map URL is never unsigned (`api/README.md`, Places search).
- The request form (P3) uses the search while it is on (Places unit). Step 1 of 3, "Find your restaurant": one field ("Search for your restaurant or bar") whose suggestions come from autocomplete, debounced 250 ms, nothing under 2 characters, one call at a time, one session token per search (the API's, from the first answer). On web it is an ARIA combobox with a listbox (Down, Up, Enter, Escape); on native each suggestion is a button. A status line says how many places match the text searched ("3 places match “Lou”."), so each answer reads differently and is heard once, and "Results from Google Maps." credits Google. Picking one calls details and shows "Here's what we found": the map when there is one, the name from the suggestion, Google's address, the town line (one of the twelve, another town, or "Townwise works with businesses in a US town, and Google Maps puts this place in none.", which has no Looks right), and "From Google Maps. Townwise keeps Google's id for the place and its town, not the address or the map." The card's heading takes focus. "Looks right" opens Step 2 of 3, "About you", and moves focus to its heading: the form with the place in place of Town (and "Change place" back to Step 1, which moves focus to the search field, as "Search again" does), Organization name filled with the place's name when empty (for the requester to edit), and the request sends `placeId` with the place's town. "Can't find it? Enter it yourself" opens the form as it is without the search, which offers "Search Google Maps instead". The client learns whether the search is on by sending autocomplete `{}`: 503 `places_unavailable` is off, 400 `invalid_request` is on, and Google is not called. While off, under view-as (nothing is sent), for a rejected request (its answers are filled in) and after a 503 during the search (with "Google Maps isn't answering right now, so you can enter your restaurant yourself."), the form is as it is without the search. Step 3 is the history upload after approval.

### 10.3 Organization and locations

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org` | member | | 200 `{ org: { id, name }, role, locations: LocationSummary[], requestedLocationCount: number \| null, placeSearch: boolean }` (`placeSearch`: the Places search is on, 10.2a) | |
| `PATCH /api/org` | org_admin | `{ name }` | 200 `{ org }` | |
| `GET /api/org/staff-activity` | org_admin | | 200 `{ events: StaffActivityView[] }` (newest 50 events on this organization whose actor role is `superadmin`) | |
| `POST /api/org/leave` | member | `{}` | 200 `MeResponse` | 409 `last_admin` |
| `POST /api/org/locations` | org_admin | `{ name, town: TownInput, placeId?: string \| null }` | 201 `{ location: LocationSummary }` | 409 `location_name_taken`, `location_limit`; 400 `unknown_town`; with a `placeId`: 400 `unknown_place`, `place_not_supported`, `place_town_mismatch`; 429; 503 `places_unavailable` |
| `PATCH /api/org/locations/:locationId` | org_admin | `{ name?, town?, placeId?: string \| null }`, at least one; a `placeId` needs `town`; null takes the place off | 200 `{ location }` | 404; 409 `location_name_taken`; with a `placeId`: as `POST` |
| `DELETE /api/org/locations/:locationId` | org_admin | | 204 | 404; 409 `location_has_data` (any sales day or note) |

[CONFIRM: org admins can rename their own organization]

A location's Google place (Places unit; P10, P16 "Change this location's place"): the API asks Google for the place (Place Details, a session of its own) and takes its town with the 10.2a rules; the town sent must be that town (one of the twelve by id, another by name ignoring case and by state), else 400 `place_town_mismatch`. Google not knowing the place is 400 `unknown_place`; outside the 50 states and DC or with no town, 400 `place_not_supported`; the search off or Google failing, 503 `places_unavailable` (`townwise.places_failed` with the route id). Each write with a place spends one call of the account's `townwise:places` budget (10.8) before Google is asked: used up, 429 `rate_limited`; its store down, 503 `places_unavailable`. A write without a place spends none. The location stores Google's current id and the place's town, nothing else. A town changed by hand takes the place off; a rename or the same town keeps it. `location.created` and `location.updated` add `hasPlace`, never the id. P10 and P16 offer the search only while `placeSearch` is true and never under view-as; P10 starts with it ("Search Google Maps for the location", "Looks right" fills Name and gives the town, "Can't find it? Enter it yourself"), and a 503 on Add leaves the fields with the place's town filled in and "Google Maps isn't answering right now, so the place wasn't added. Check the town, then add the location without it." Focus follows the steps: "Looks right" on P10 moves it to the place in the form, and opening P16's search moves it to the field and closing it (Cancel, Use this place, or a refusal) to the line that says whether the location is linked. P16's section says whether the location is linked, finds a place with "Use this place" (with "Using this place moves {name} to {town}." when the town changes) and answers "Saved."; its Town field says "Changing the town here takes the Google Maps place off this location." while linked.

### 10.4 Sales

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/sales` | member | | 200 `{ coverage, calibration, months: { month: 'YYYY-MM'; dayCount; guests: number \| null; netSalesCents: number \| null }[], uploads: UploadView[] }` (newest 20 uploads) | 404 |
| `GET /api/org/locations/:locationId/sales/days?from=&to=` | member | dates `YYYY-MM-DD`, `from <= to`, span at most 366 days | 200 `{ days: SalesDay[] }` | 400; 404 |
| `GET /api/org/locations/:locationId/sales/history` | member | | 200 `SalesHistory` (10.10): every stored day, oldest first, each upload with the stored file it was read from | 400; 404 |
| `POST /api/org/locations/:locationId/sales/uploads` | member, 256 KB, limiter `uploads` | `{ days: SalesDay[] }` (Section 11.3) | 201 `{ upload: UploadView, coverage, calibration }`; a member’s upload adds new days only (11.4) | 400; 404; 413; 429 |
| `DELETE /api/org/locations/:locationId/sales` | org_admin | | 200 `{ deletedDays, deletedUploads, deletedFiles }`: with the days and upload records go the location's stored files (11A), forecast runs (6.20, 6.21) and answers to TownwiseAI's questions (6.17); notes stay, closure notes saved from answers included | 404; 409 `import_running`; 503 `files_unavailable` (10.9) |

Month sums run over the days that have a value. A month whose days have no guest counts returns `guests: null`.

### 10.5 Notes

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/notes` | member | | 200 `{ notes: Note[] }`, sorted by `startDate` | 404 |
| `POST /api/org/locations/:locationId/notes` | member | `NoteInput` | 201 `{ note }` | 404; 409 `note_limit` |
| `PATCH /api/org/locations/:locationId/notes/:noteId` | member (author or org admin) | `NoteInput` (full replace) | 200 `{ note }` | 403 `forbidden`; 404 |
| `DELETE /api/org/locations/:locationId/notes/:noteId` | member (author or org admin) | | 204 | 403 `forbidden`; 404 |

### 10.6 Team

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org/members` | org_admin | | 200 `{ members: MemberView[] }` (active and invited) | |
| `POST /api/org/members` | org_admin | `{ emails: string[] (1 to 20, each up to 320 characters), role }` | 200 `{ results: AddResult[], members: MemberView[] }` | 409 `member_limit` (200 active plus invited) |
| `PATCH /api/org/members/:memberId` | org_admin | `{ role }` | 200 `{ member }` | 404; 409 `last_admin` |
| `DELETE /api/org/members/:memberId` | org_admin | | 204 | 404; 409 `last_admin` |

### 10.7 Staff console

Every route here has policy `staff`, except `view-as/end`, which has `staff_self` and is the only one that runs during view-as (7.2).

| Method and path | Request | Success | Extra errors |
|---|---|---|---|
| `GET /api/admin/requests?status=pending\|approved\|rejected\|withdrawn` | | 200 `{ requests: (AccessRequestView & { requester: { userId, email }, emailAtRequest, requesterHasOrg: boolean, decidedBy: { email } \| null, orgId: string \| null })[], pendingCount }` | |
| `POST /api/admin/requests/:requestId/approve` | `{ orgName (2 to 120), locationName (1 to 80) }` for a request without places; `{ orgName, locationNames: string[] }` for one with them, one name per place in order, each 1 to 80, unique by name key (F3) | 200 `{ org: { id, name }, request }` | 404; 409 `request_not_pending`, `requester_has_org`, `location_name_taken` (a retry’s name on another place’s location) |
| `POST /api/admin/requests/:requestId/reject` | `{ message?: string (up to 500) }` | 200 `{ request }` | 404; 409 `request_not_pending` |
| `GET /api/admin/orgs` | | 200 `{ orgs: { id, name, status, createdAt, adminCount, memberCount, inviteCount, locationCount, salesDayCount, lastUploadAt }[] }` | |
| `POST /api/admin/orgs` | `{ name, adminEmail }` [Build note: and an optional `id`, which makes a retry idempotent (F10)] | 201 `{ org: { id, name }, result: AddResult }` [Build note: 200, the same shape, for a repeat of that `id`] | |
| `GET /api/admin/orgs/:orgId` | | 200 `{ org: { id, name, status, createdAt, fromRequestId, suspendedAt }, members: MemberView[], locations: { id, name, town, coverage, notesCount, lastUploadAt }[], recent: AuditEventView[] }` (counts only, D7; newest 20 events) [Build note: `org` also carries `fromRequestSentAt`, the request’s `createdAt` for P21’s “From request {date}”, or null without a request or once it is deleted, and `inSetup: boolean`, whether the setup routes are open (D23), from the same check they make] | 404 |
| `PATCH /api/admin/orgs/:orgId` | `{ name?, status?: 'active' \| 'suspended' }` | 200 `{ org }` | 404 |
| `DELETE /api/admin/orgs/:orgId` | | 200 `{ deletedDays, deletedUploads, deletedNotes, deletedLocations, deletedSeats, redactedEvents }` | 404; 409 `org_not_suspended`; 503 `files_unavailable` (stored files are off while it has files) |
| `POST /api/admin/orgs/:orgId/originals/delete` | `{ basis: 'data_subject_request' \| 'org_request' \| 'other' }` | 200 `{ deletedOriginals, skippedBusy }` | 400; 404; 503 `files_unavailable` |
| `POST /api/admin/orgs/:orgId/members` | as 10.6 | as 10.6 | 404 |
| `PATCH /api/admin/orgs/:orgId/members/:memberId` | as 10.6 | as 10.6 | 404; 409 `last_admin` |
| `DELETE /api/admin/orgs/:orgId/members/:memberId` | | 204 | 404; 409 `last_admin` |
| `POST /api/admin/orgs/:orgId/locations` (setup, D23) | as `POST /api/org/locations` (10.3) | 201 `{ location: LocationSummary }` | 404; 409 `org_not_in_setup`; then as 10.3 |
| `PATCH /api/admin/orgs/:orgId/locations/:locationId` (setup) | as `PATCH /api/org/locations/:locationId` | 200 `{ location }` | 404; 409 `org_not_in_setup`; then as 10.3 |
| `DELETE /api/admin/orgs/:orgId/locations/:locationId` (setup) | | 204 | 404; 409 `org_not_in_setup`, `location_has_data` |
| `POST /api/admin/orgs/:orgId/locations/:locationId/sales/uploads` (setup) | `{ days: SalesDay[] }` (11.3), up to 256 KB | 201 `{ upload: UploadView, coverage, calibration }`, replacing the days it covers; `uploadedByEmail` is “Townwise staff” | 400; 404; 409 `org_not_in_setup`; 413 |
| `DELETE /api/admin/orgs/:orgId/locations/:locationId/sales` (setup) | | 200 `{ deletedDays, deletedUploads, deletedFiles }`, as 10.4 | 404; 409 `org_not_in_setup`, `import_running`; 503 `files_unavailable` |
| `GET /api/admin/orgs/:orgId/forecast-runs` | | 200 `{ runs }` (14.4), newest import first, at most 100 | 404 |
| `POST /api/admin/orgs/:orgId/locations/:locationId/forecast-runs` | a run file (14.4), up to 256 KB | 201 `{ run }` (draft); 200 `{ run }` for a file the location already has | 400 `invalid_forecast_file` `{ issues: { path, code }[] }`; 404 |
| `POST /api/admin/orgs/:orgId/forecast-runs/:runId/publish` | `{}` | 200 `{ run }` | 404; 409 `forecast_run_not_draft` |
| `POST /api/admin/orgs/:orgId/forecast-runs/:runId/withdraw` | `{}` | 200 `{ run }` | 404; 409 `forecast_run_importing` |
| `DELETE /api/admin/orgs/:orgId/forecast-runs/:runId` | | 204 | 404 |
| `GET /api/admin/people?kind=` | | 200 `{ people: PersonView[], truncated: boolean }` (up to 1,000) | |
| `GET /api/admin/people/lookup?q=<exact email>` | | 200 `{ person: PersonView \| null }` | |
| `POST /api/admin/people/:userId/sign-out-everywhere` | `{}` | 200 `{ revoked: number }` | 400 `invalid_target` (staff); 404 |
| `POST /api/admin/people/delete` | `{ email }` (in the body, never the path, because `url` is logged) | 200 `{ deletedRequests, deletedSeats, redactedEvents, kitUserId: string \| null }` | 400 `invalid_target` (staff); 404 (no kit user and no Townwise record); 409 `person_has_seat` |
| `GET /api/admin/audit?orgId=&actorUserId=&action=&before=&limit=` | `limit` 1 to 200, default 50; `before` an ISO time | 200 `{ events: AuditEventView[], nextBefore: string \| null }` | |
| `POST /api/admin/view-as` | `{ userId, reason }` | 201 `MeResponse` | 400 `invalid_target`; 404; 429 |
| `POST /api/admin/view-as/end` | `{}` | 200 `MeResponse` | |

```ts
interface PersonView {
  userId: string | null; email: string;
  kind: 'staff' | 'org_admin' | 'member' | 'invited' | 'pending' | 'rejected' | 'removed' | 'signed_in';
  org: { id: string; name: string } | null;
  since: string | null;
  staffTwoStep: { state: 'on'; since: string } | { state: 'not_set_up' } | { state: 'not_signed_in' } | null;   // staff rows only
}

interface AuditEventView {
  id: string; at: string; actorEmail: string; actorRole: string;
  viewAs: { targetEmail: string } | null;
  orgId: string | null; orgName: string | null; action: string;
  summary: string;                                // built on the server from the action and its allowlisted details
  details: Record<string, string | number | boolean | null>;
}
```

**Setup (D23, F10b).** The five setup routes run while the organization is in setup: `status: 'active'`, no `firstJoinedAt` (6.1), and no member row that has joined (`joinedAt` set, active or removed; the row check covers organizations from before the field). Open invitations never count, and setup never reopens: `firstJoinedAt` outlives every seat, and a person deletion that takes the removed seats. Each scopes through `scopeForStaffOrg` (404 for an unknown organization), then answers 409 `org_not_in_setup` outside setup, then runs the org admin route’s own checks in its order (the body, the location, 404 for one in another organization, the town and place, the location limit, `location_has_data`, `import_running`). A place id is checked with Google on the staff member’s own `townwise:places` budget. Then the staff event is written (9.3) and the org route’s write runs. A name another location has is 409 `location_name_taken` after the event, which is followed by `staff_action.not_applied`; so are a location gone meanwhile (404) and stored files off while the location has some (503 `files_unavailable`). Locations and uploads made here hold the staff user id in `createdBy` and `uploadedBy`, with `byStaff: true` (6.4, 6.6). Answers carry ids, names, towns, counts and date coverage, never a figure (D7). Setup is checked before the event with no lock: a join landing between the check and the write is accepted, and the write shows in staff activity like any other.

People come only from Townwise records and config: staff from `TOWNWISE_SUPERADMIN_EMAILS` (with `users.findByEmail` and `totp.get` for their two-step state), plus seats, invitations and requests. A person who signed in and has none of these is found only by exact email through `users.findByEmail`, as kind `signed_in`. The kit’s collections are never read directly. “Sign out everywhere” calls the kit’s `revokeAllSessions(userId)` (**Exists**) and audits `people.signed_out_everywhere`. [CONFIRM: sign out everywhere for staff]

**Deletion (D22).** The one v1 deletion path. Both actions follow the staff audit rule (9.3): checks, then the event, then the effect. Each step is a delete by filter, so a retry completes the work.

- **Delete a person** (`POST /api/admin/people/delete { email }`). The server normalizes the email and looks up the kit user with `users.findByEmail` (there may be none, for an address that was only invited).
  1. Refuse a staff address (400 `invalid_target`) and a person who holds an active seat (409 `person_has_seat`; staff remove the seat first, and the last-admin rule still applies). Answer 404 when there is no kit user and no Townwise record for the email. [Build note: after step 3 the server checks for an active seat again, since a join or an approval can seat the person while the deletion runs. One found then answers 409 `person_has_seat`, recorded as `staff_action.not_applied` (`person_has_seat`), before steps 4 and 5; the records step 3 deleted stay deleted, and a retry after the seat is removed completes the work. An approval that seats the person after this check finds the request gone and takes the seat back (F3 step 8); a join needs an invitation, which step 3 deleted, so only one added later can seat them, which the runbook checks for (Section 19, item 7).]
  2. Audit `person.deleted` with ids only.
  3. Through `deletePersonRecords(userId, email)` (6.10 rule 8): delete the person’s access requests (by `userId`), their open invitations in every organization (`inviteEmail == email`), and their removed seats (`userId`, `status: 'removed'`). [Build note: also their tuning chat conversations, live turns and TownwiseAI proposal records in every organization (`tw_chat_conversations`, `tw_chat_live_turns`, `tw_chat_proposals`, by `userId`), which postdate this list (`tuning-chat.md`), and their welcome markers in every organization (`tw_welcomes`, by `userId`, 6.15; not counted in the answer). Notes they saved from proposals stay, as every note does. The 404 in step 1 counts audit events as Townwise records, because the audit log keeps an address until its person is deleted (Section 17).]
     [Build note: and set `importedBy` and `publishedBy` to null on the forecast runs the person imported or published (6.20), in every organization.]
     [Build note: before the removed seats go, each organization one of them joined that has no `firstJoinedAt` gets it, from the person’s earliest `joinedAt` there (6.1), so the deletion never reopens staff setup (D23).]
  4. When a kit user exists: call `revokeAllSessions(userId)` and `authStores.totp.remove(userId)` (both public, **Exists**).
  5. `redact` the email in the audit log (9.3).
  6. Answer the counts and `kitUserId`. The kit’s user record and its revoked session records are then deleted by hand, as a runbook step, because the kit has no user delete (Section 19, item 7). Until then, the person can still continue with Google, and they resolve to `no_org`.
  
  Notes and uploads the person wrote stay with their organization; the author shows as “Deleted person” once the kit user is gone. View-as grants keep only ids and the staff-written reason.
- **Delete an organization** (`DELETE /api/admin/orgs/:orgId`). The organization must be suspended first (409 `org_not_suspended`), so its members have already seen the paused page.
  1. Audit `org.deleted` with ids only.
  2. Through `scopeForStaffOrg`: delete its `tw_sales_days`, `tw_uploads`, `tw_notes`, `tw_locations` and `tw_members`, and its access request (`fromRequestId`). [Build note: also its `tw_chat_conversations`, `tw_chat_live_turns`, `tw_chat_usage` and `tw_chat_proposals`, which postdate this list (`tuning-chat.md`), and its `tw_welcomes` (6.15), `tw_agent_answers` (6.17), `tw_forecast_runs` and `tw_forecasts` (6.20, 6.21). The response keeps the six counts above.]
  3. `redact` its name and its locations’ names in the audit log (9.3).
  
  [Build note: stored files (11A) go first, before any other record: its imports, every unfinished upload discarded (its staged chunks dropped at once), every blob under `{orgId}/` in both containers, its `tw_file_entries`, `tw_files`, `tw_upload_days` and `tw_files_usage`. When stored files are off but the organization has file rows, nothing is deleted and the answer is 503 `files_unavailable`, recorded as `staff_action.not_applied` (`files_unavailable`), so blobs are never left behind silently. After the row goes, its stored files are swept once more (a reader mid-file can write a cleaned copy late), and the daily sweep's orphan check catches anything later still. Logged as `townwise.org_files_deleted { orgId, deletedFiles, deletedBlobs }`; the response keeps its six counts.]
  4. Delete the `tw_orgs` row last, so a retry still finds the organization. [Build note: the delete matches `status: 'suspended'`, so an organization reactivated during the deletion keeps its row and the answer is 409 `org_not_suspended`, recorded as `staff_action.not_applied`; the records already deleted stay deleted, and suspending it and deleting again finishes. After the row goes, its `tw_sales_days` and `tw_chat_usage` are swept once more, since an upload or a tuning chat turn in flight can upsert after the first sweep; the late days count in `deletedDays`. This narrows the gap without closing it: a chat turn started before the suspension can still add chat usage for up to 150 seconds, an upload still running can write days after the second sweep, and its `tw_uploads` row, if written after the first sweep, is never swept. Forecast runs and their rows are swept then too, since a staff import already past its organization check can still write them.]
  
  Former members then resolve to `no_org`. View-as grants keep only ids.
- **Purge an organization's originals** (`POST /api/admin/orgs/:orgId/originals/delete { basis }`). For a person's deletion request about someone named inside an export (a diner, a server): their details exist only in the original files (and possibly in a file's name, a ZIP's entry paths or a workbook's sheet names, all cleared with the original), never in the cleaned copies, the rest of the reports or the days. Staff delete the originals without reading them. The read-only check counts the originals; the event `org.originals_deleted { count, basis }` is recorded first; then each original is deleted, its name replaced by the kind's label and its entry paths cleared. A file not read yet (stored, queued, or waiting on a question, which is dropped so its import can finish) is first kept unread with the outcome `raw_deleted`, so the reader never reads it. A file still uploading or being read is flagged (`purgeRaw`): the reader never reads a flagged file, and its original goes as soon as the upload or the read ends; the daily sweep finishes any it missed. The event's `count` is every original found; the answer's `skippedBusy` counts the flagged ones. The cleaned copies, reports and days stay.
- **A person's own deletion** (above) leaves the files they uploaded with their organization, as uploads and notes; the uploader shows as “Deleted person”.

[DECISION NEEDED: retention periods. The mechanism above exists in v1; how long each record is kept before staff delete it is still open (Section 17).]

### 10.8 Rate limits

Built with the rate-limit module and keyed on `acct:<userId>`, a key the caller cannot rotate. The module stores each key as a SHA-256 hash (**Exists**). The kit’s per-IP ceiling (**Exists**, 2,000 per minute) still applies first. `townwise:writes` runs right after `requireAuth` (7.2 step 2), so refused writes count; the others run after the policy. [CONFIRM: limits]

| Name | Applies to | Limit | When Redis is down |
|---|---|---|---|
| `townwise:writes` | every non-GET `/api` route, before access is resolved | 300 per 10 minutes | allow |
| `townwise:uploads` | the member upload route (staff setup’s carries only `townwise:writes`, as every staff write does) | 30 per hour | allow |
| `townwise:requests` | `POST /api/access-requests` | 5 per day | deny (503 `unavailable`) |
| `townwise:view-as` | `POST /api/admin/view-as` | 20 per hour | deny (503 `unavailable`) |
| `townwise:places` | both Places routes together; each location write with a `placeId` also spends one (10.3) | 300 per hour | deny (503 `unavailable`; on a location write, 503 `places_unavailable`) |
| `townwise:files` | `POST .../files` (10.11) | 120 per hour | allow |
| `townwise:file-chunks` | `PUT .../files/:fileId/chunks/:index` | 1,500 per hour | allow |
| `townwise:downloads` | both file downloads together | 300 per hour | allow |

A search is 10 to 15 debounced autocompletes and one details call, so `townwise:places` allows about 20 searches an hour. The Places routes are POSTs, so `townwise:writes` counts them too.

### 10.9 Error codes

| Status | Code | When | Client handling |
|---|---|---|---|
| 400 | `invalid_request` | zod failure through `parseInput`, with no field details (**Exists**) | client validation should have caught it: “Something went wrong with that request. Reload the page and try again.” |
| 400 | `malformed_json` | server-core (**Exists**) | as above |
| 400 | `unknown_town`, `invalid_target` | as in the tables | as in the pages |
| 401 | `unauthenticated` | the kit, and `userGone()` when the kit user no longer exists (4.2 step 1) | the shell refreshes once (**Exists**) |
| 403 | `origin_not_allowed` | kit and server-core | configuration error |
| 403 | `no_access` | member route, caller not an active member | re-read `/api/me` and route |
| 403 | `forbidden` | role too low, not staff, not the note’s author | re-read `/api/me`; hide the control |
| 403 | `staff_setup_required`, `staff_reauth_required` | staff gate | route per 4.3 |
| 403 | `view_as_read_only` | a non-GET without the `staff` policy during view-as | should not happen: controls are disabled |
| 404 | `place_not_found` | the details route: Google has no such place (10.2a) | the client keeps the manual fields |
| 400 | `unknown_place`, `place_not_supported`, `place_town_mismatch` | a location write with a `placeId` (10.3): Google has no such place, it has no US town, or the sent town is not its town | “Google Maps answered differently this time.”, then the search again |
| 404 | `not_found` | unknown id, or an id in another organization | “This {thing} isn’t available.” with a way back |
| 409 | `view_as_active` | any route with the `staff` policy, any method, during view-as; a second view-as start racing the first | re-read `/api/me` |
| 409 | `no_invite`, `already_in_org`, `request_exists`, `request_not_pending`, `requester_has_org`, `last_admin`, `location_name_taken`, `location_limit`, `location_has_data`, `note_limit`, `member_limit`, `person_has_seat`, `org_not_suspended`, `org_not_in_setup` | as in the tables | inline copy per page |
| 413 | `payload_too_large` | server-core | unreachable from the app (Section 11.3) |
| 415 | `unsupported_media_type` | server-core | client bug |
| 429 | `rate_limited` | Section 10.8, with `retryAfterSeconds` | “Too many attempts. Try again in {minutes} minutes.” |
| 500 | `internal` | server | “Something went wrong on our side. Try again in a minute.” |
| 503 | `places_unavailable` | a Places route while the search is off, or Google failed or timed out (10.2a); a location write with a `placeId` for the same reasons, or while the `places` limiter’s store is down (10.3) | the client shows the manual fields |
| 503 | `unavailable` | a deny-when-down limiter, a store outage, or a staff action whose audit write failed (9.3) | “Townwise isn’t responding. Try again in a minute.” |
| 400 | `purpose_unavailable` | `POST .../files` with a purpose other than `history` (10.11) | client bug |
| 403 | `view_as_no_download` | a file download during view-as | controls are hidden |
| 404 | `no_clean_file` | the cleaned-copy download of a file that produced no days | the button is hidden |
| 404 | `no_entries` | the entries list of a file that is not a ZIP | client bug |
| 409 | `import_full`, `too_many_uploading`, `storage_full`, `daily_upload_limit`, `file_not_uploading`, `chunks_missing`, `file_duplicate`, `file_busy`, `import_not_open`, `import_empty`, `question_stale`, `import_running` | the stored-files routes (10.11), and deleting a location's sales data while one of its files is being read (`import_running`); `storage_full` carries `storedBytesLeft`, `daily_upload_limit` `resetsAt`, `chunks_missing` `missing`, `file_duplicate` `fileId` | words per code in the files module |
| 410 | `upload_expired`, `raw_expired` | an upload session past 24 hours; an original already deleted | “Drop it again.” / the download is hidden |
| 413 | `file_too_large` | `POST .../files` over 200 MiB, with `maxBytes` | “This file is over 200 MB. Split it or zip it.” |
| 503 | `files_unavailable` | every stored-files route while `FILES_BLOB_ACCOUNT_URL` is unset; deleting a location's sales data, or an organization, that has stored files while they are off | the browser upload (P13) instead |
| 503 | `uploads_busy`, `storage_unavailable` | a replica at 12 chunk streams (`Retry-After: 2`); blob storage refused or failed (`Retry-After: 5`) | the upload queue waits and retries |

### 10.10 Calendar and sales history

Two reads for Home, Analytics and TownwiseAI. Both are `member` GETs in `TOWNWISE_ROUTES` with no body and no route limiter (`app:api-ceiling` still applies). Both are allowed during view-as, where the chain logs `townwise.view_as_read` with the grant id and route id only. Neither handler logs or audits anything, and neither imports `stores/cross-tenant.ts`.

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/sales/history` | member | | 200 `SalesHistory` | 400 (malformed id); 404 |
| `GET /api/org/locations/:locationId/calendar?from=&to=` | member | `from` and `to` as `YYYY-MM-DD`, exactly those two keys; `from` on or after 2010-01-01; `from <= to`; `to` at most 400 days after the server’s UTC day; a span under 7,320 days | 200 `LocationCalendar` | 400 `invalid_request`, with no field details; 404 |

```ts
interface SalesHistory {
  coverage: Coverage;
  days: {                              // columns of equal length, oldest first, one entry per stored day
    date: string[];
    guests: (number | null)[];
    netSalesCents: (number | null)[];
    upload: number[];                  // index into `uploads` of the upload that last wrote the day; -1 if it has no record
  };
  uploads: {                           // every upload some day references, newest first
    id: string; uploadedAt: string; uploadedByEmail: string; status: 'applying' | 'applied';
    firstDate: string; lastDate: string;
    file: null | { id: string; name: string | null; kind: 'text' | 'xlsx' | 'xls' | 'pdf' | 'docx' | 'doc' | 'zip' | 'other' };
                                       // the stored file (11A) the upload was read from: null for a browser upload, a
                                       // deleted file, and every upload while stored files are off; name null in view-as
  }[];
}

interface LocationCalendar {
  town: Town;                          // the location's town
  researched: boolean;                 // the town has at least one researched event (13.1)
  covers: { from: string; to: string } | null;   // the span of the town's researched events, all years; null when none
  events: TownEvent[];                 // overlapping [from, to], sorted by start, then id
}

interface TownEvent {
  id: string;                          // stable: 'us:thanksgiving:2026', 'hanover-nh:2026-11-17:fall-term-classes-end'
  title: string;
  start: string; end: string;          // inclusive; a single day has end === start
  kind: 'holiday' | 'event' | 'term' | 'season';
  scope: 'national' | 'town';
  group: string | null;                // a recurring kind ('us:thanksgiving', 'hanover-nh:classes:fall'); null for a one-off
  groupLabel: string | null;
  confidence: 'high' | 'medium' | 'low' | null;  // the research's rating; null for holidays and key dates
  sources: { label: string; url: string }[];     // at least one
}
```

- The history route exists because `sales/days` caps at 366 days, and the heatmap and year over year need every year. It reads the days and the referenced uploads in two queries, and one current email per distinct uploader (10.1, “Deleted person”). Aggregates (weekly shape, months, drivers) are computed in the client from this one response.
- `file` is always null until stored files link uploads to files; then `name` is null during view-as.
- The calendar is location-scoped, not `/towns/:townId`, so a town outside the twelve still gets its holidays, and a restaurant’s own calendar can join the same response later as a separate field.

### 10.11 Files and imports

All under `/api/org/locations/:locationId`, all members, all 503 `files_unavailable` while stored files are off; every non-GET also passes `townwise:writes`, and view-as refuses every non-GET (403 `view_as_read_only`) and both downloads (403 `view_as_no_download`). The full table, with each route's errors, is `api/README.md` (Stored files); the shapes are in 11A.

| id | Method and path | Who | Body | Limiter |
|---|---|---|---|---|
| `org.files.create` | `POST /files` | member | 2 KB `{ name, sizeBytes, purpose: 'history' }` | `files` |
| `org.files.chunk` | `PUT /files/:fileId/chunks/:index` | the uploader | raw, exact `Content-Length` (`bodyLimit: 'stream'`, this route only) | `file_chunks` |
| `org.files.complete` | `POST /files/:fileId/complete` | the uploader | 2 KB `{}` | |
| `org.files.list` | `GET /files?before=` | member | | |
| `org.files.get` | `GET /files/:fileId` | member | | |
| `org.files.entries` | `GET /files/:fileId/entries?after=` | member | | |
| `org.files.raw` | `GET /files/:fileId/raw?part=` | the uploader or an org admin | | `downloads` |
| `org.files.clean` | `GET /files/:fileId/clean` | member | | `downloads` |
| `org.files.remove_raw` | `DELETE /files/:fileId/raw` | the uploader or an org admin | | |
| `org.files.remove` | `DELETE /files/:fileId` | the uploader or an org admin | | |
| `org.originals.remove` | `DELETE /originals` | org admin | | |
| `org.imports.current` | `GET /imports/current` (declared before `:importId`) | member | | |
| `org.imports.get` | `GET /imports/:importId` | member | | |
| `org.imports.start` | `POST /imports/:importId/start` | member | 2 KB `{}` | |
| `org.imports.answer` | `POST /imports/:importId/answer` | member | 2 KB `{ questionId, choice }` | |

`PUT` is allowed only with `bodyLimit: 'stream'`, and `'stream'` only on `org.files.chunk` (boot refuses anything else). The staff purge of an organization's originals is `admin.orgs.originals.remove` (10.7). The chunk handler reads the body itself after the policy passed, and a chunk it refuses is answered with the connection closed, unread.

### 10.12 TownwiseAI proposals and side panel

`POST /api/org/locations/:locationId/chat/:conversationId/proposals/:proposalId` (`org.chat.proposal`, member, body `8kb`, `writes` only). The conversation's author saves a note TownwiseAI proposed, as shown or edited first, or sets it aside. Contract and views: `docs/portal/tuning-chat.md` section 2.

| Request | Success | Errors |
|---|---|---|
| `{ action: 'save', note?: NoteInput }` (`note` is the author's edit) or `{ action: 'dismiss' }` | 200 `{ proposal: { id, status: 'saved' \| 'dismissed', noteId, edited }, note: Note \| null }` | 400 `invalid_request` (body, malformed id, or an edit that breaks a Section 12 rule); 404 (the location is not the caller's organization's, the conversation is not the caller's in this location, or no proposal with this id was shown in a stored turn); 409 `note_limit`; 403 `view_as_read_only`; 429 |

- Only the author's press saves a note, and only a proposal they were shown: a `propose_note` call with valid input and a result that is not an error. The note goes through Section 12's rules again and is audited `note.created`, as from the notes route.
- Only a proposal in a stored turn: a turn is stored when it ends with `done` (not `refusal`), so a proposal streamed during a live turn is 404 until then, and one from a turn that failed, was refused or was stopped stays 404. The client keeps the card's actions disabled until `done`, and after a failure offers the notes route instead (`tuning-chat.md` section 2).
- No transactions (DocumentDB): the save claims the proposal in `tw_chat_proposals` (6.16), writes the note with the claim's `noteId`, then marks it `saved`. A retry, a crash between the steps or two tabs pressing Save end with one note; only the request that wrote it records `note.created`. Saving a saved proposal again, or setting it aside, answers its saved state.
- `GET .../chat/:conversationId` shows each proposal's `status` (`open`, `saved` or `dismissed`) and `noteId`. One with no record reads as saved when a note the author wrote at the location says exactly the same, so a proposal added with the notes route is not offered twice; a colleague's note never counts (`tuning-chat.md` section 2, [CONFIRM]).
- Logged as `townwise.chat_proposal { orgId, locationId, conversationId, status, edited }`, never the note's text.

**Side panel.** `GET /api/org/locations/:locationId/agent` (`org.agent.get`, member, no body, no limiter) and `POST /api/org/locations/:locationId/agent/questions/:questionId` (`org.agent.answer`, member, body `1kb`, `writes` only). Both work whether or not the chat is on. Contract: `docs/portal/tuning-chat.md` section 8.

| Route | Success | Errors |
|---|---|---|
| GET | 200 `{ questions: Question[], activity: ActivityItem[] }`, both computed at read time | 400; 404 |
| POST `{ answer: 'closed' \| 'open' \| 'not_sure' }` | 200 `{ question: { id, answer }, note: Note \| null }` | 400 `invalid_request` (body, or an id that is not `weekday_`/`gap_` with dates); 404 (the location, or a question not asked now); 409 `note_limit`; 403 `view_as_read_only`; 429 |

- **Questions** are rules over the location's own days, never an estimate, over the last 365 days of coverage (from the later of the first day and 364 days before the last day with sales, to that last day). A weekday question (`{ id, kind: 'weekday', weekday, from, to, noSalesCount, weekdayCount }`) asks about a weekday with no sales on at least 60% of its counted days, with at least 4 of them, that no closure note and no earlier answer explains. A day counts from the first day with sales in the window (the question's `from`), and only when its week (Monday to Sunday) has sales on another day, so a week with no data at all never makes a weekday look closed. A gap question (`{ id, kind: 'gap', from, to, dayCount }`) asks about a run of consecutive days with no sales that no note and no earlier answer explains; a weekday the location is usually closed on (the 60% rule over all its counted days) bridges a run but never starts or ends one, and a run the window cuts off before its first day with sales is not asked. At most 5, weekdays first, then gaps newest first. An answered question's days are not asked about again until the location's sales data is deleted, which deletes the answers too. [CONFIRM: 60% of a weekday's days, at least 4 of them]
- **Answers.** `closed` saves a closure note (`effect: 'closed'`) over the question's days, the weekday only for a weekday question, through Section 12's rules and the note limit, recorded `note.created`; `open` (the data is missing) and `not_sure` save nothing. The answer belongs to the location: answering one already done, by anyone, answers what was saved. No transactions: the answer claims its question in `tw_agent_answers` (6.17), writes the note with the claim's `noteId`, then marks the answer `done` and records `agent.question_answered` once. A retry, a crash between the steps or several tabs end with one note. A question whose claim stopped before `done` is still asked, and its next answer finishes it, with that answer, while the question is still asked; a stopped `closed` claim whose note is written finishes as `closed` whatever the next answer is. An answer is marked `done` only while the row still holds it, and the request answers with what the row holds; a `closed` answer whose note is written overrules a different answer sent at the same moment (the note exists), as a saved proposal overrules Not now.
- **Activity** (`ActivityItem`, newest 20) lists only real, dated records of the location: `{ at, kind: 'upload_applied', firstDate, lastDate, dayCount }` for applied uploads, `{ at, kind: 'note_saved', via: 'chat' | 'question', noteId, noteKind, startDate, endDate }` for notes the caller saved from their own proposals and closure notes saved by answers (left out once the note is deleted), and `{ at, kind: 'question_answered', questionId, answer }` for `open` and `not_sure`, and (F3) `{ at, kind: 'file_processed', fileId, firstDate, lastDate, dayCount }` for stored files Townwise read, dated when the read ended, in place of the upload record that read wrote. Later sources append their own kinds (forecasts' `forecast_made`); a client shows a kind it does not know as nothing. Never a file name (the panel is read under view-as too), a note's detail or a figure.
- Logged as `townwise.agent_answer { orgId, locationId, answer }`. Under view-as the GET is logged `townwise.view_as_read`, and the POST is refused by the guard.

### 10.13 Estimates

People in town and "How Townwise estimates" (13.2), and the published forecast (14.4). All three are `member` GETs in `TOWNWISE_ROUTES` with no body and no route limiter (`app:api-ceiling` still applies), allowed during view-as, where the chain logs `townwise.view_as_read`. None logs or audits anything. The build contract, with every field, is `docs/portal/estimates.md`; the staff routes that import and publish forecast runs are in 10.7.

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/people-in-town?from=&to=` | member | `from` and `to` as `YYYY-MM-DD`, exactly those two keys; `from` on or after 2010-01-01; `from <= to`; at most 92 days counting both ends; `to` at most 400 days after the server’s UTC day | 200 `PeopleInTownWindow` | 400 `invalid_request`, with no field details; 404 |
| `GET /api/org/locations/:locationId/estimates/about` | member | | 200 `EstimatesAbout` | 400 (malformed id); 404 |
| `GET /api/org/locations/:locationId/forecast?from=&to=` | member | as people in town, but at most 31 days and `from` at most 400 days before the server’s UTC day | 200 `ForecastWindow` (14.4) | 400 `invalid_request`; 404 |

```ts
interface PeopleInTownWindow {
  available: boolean;                  // false only for a town outside the twelve
  reason: 'town_not_researched' | null;
  from: string; to: string;
  town: { name: string; state: string; kind: 'college' | 'seasonal' | 'event' | null };
  timeZone: string;                    // the town's IANA zone
  periods: {                           // consecutive days with identical components, merged
    from: string; to: string; fromWeekday: Weekday; toWeekday: Weekday;
    termState: 'in_session' | 'finals' | 'between_terms' | 'summer_session' | 'unknown';
    termLabel: string | null;          // 'Fall term classes', 'Between terms (from the term dates)'
    termSourceIds: string[];
    headcount: { low: number; high: number; sourceIds: string[]; excludes: string[] } | null;
    headcountWhy: 'no_population' | 'visitors_unknown' | 'no_term_dates' | 'no_enrollment' | null;
    events: { id: string; title: string; kind: 'event' | 'holiday'; attendanceHigh: number | null; sourceIds: string[] }[];
  }[];
  season: { month: string; countyFoodServiceJobsIndex: number; baseYear: number; county: string; sourceIds: string[] }[];
  visitors: { month: string; label: string; perDayAverage: number; sourceIds: string[] }[];
  yourHistory: {                       // this location's open regular days with a known term state
    metric: 'guests' | 'netSales';     // mean: whole guests, or whole US dollars
    cells: { state: TermState; weekday: Weekday; days: number; mean: number | null }[];   // mean null under 3 days
    first: string | null; last: string | null;
  };
  sources: { id: string; label: string; url: string; confidence: 'high' | 'medium' | 'low' | null }[];
  caveats: string[];
}

interface EstimatesAbout {
  version: string;
  card: { estimates: string; inputs: string[]; cannotSee: string[]; limits: string[]; checked: string; whoCanSee: string };
  location: { name: string; town: { name: string; state: string } };
  today: { date: string; weekday: Weekday; timeZone: string; approximate: boolean };
  forecast: { run: ForecastRunView | null; live: LiveAccuracy | null };   // the newest published run (14.4) and its own live accuracy, or both null
  calendar: { researched: boolean; covers: { from: string; to: string } | null };
  people: { headcountInputs: ('residents' | 'studentHousing' | 'enrollment' | 'housingCloses' | 'eventAttendance' | 'visitors')[]; sources: PeopleSource[] };
}
```

TownwiseAI reads the same window through `get_people_in_town`, the calendar through `get_town_calendar` and the published forecast through `get_forecast` (`tuning-chat.md` section 4), and its "today" is the town's local date (13.2). Home and Analytics keep the device's local date; both are Eastern for the twelve towns.

---

## 11. Upload format and validation

### 11.1 What leaves the browser

This is the browser path (P13). It stays as the fallback while stored files (11A) are off, and as the visible choice to send only daily totals. On this path, only this leaves the browser, for one location:

```
{ "days": [ { "date": "YYYY-MM-DD", "guests": <integer or null>, "netSalesCents": <integer or null> }, ... ] }
```

Nothing else leaves the browser: no file name, column names, row count, other columns or raw values. The file is read with `File.text()`, held in component state only, never written to `localStorage`, IndexedDB or a log, and dropped when the wizard closes or finishes. The client sends no telemetry (expo-shell rule 12, **Exists**).

### 11.2 Browser steps (web)

1. **Choose a file.** `.csv` or `.txt`, up to 50 MB [CONFIRM: 50 MB]. UTF-8 with any leading byte-order mark stripped. The delimiter is detected from the header line (comma, semicolon or tab). A small RFC 4180 parser in the client handles quoted fields, doubled quotes, and CRLF or LF; no CSV library is added. An Excel file gets “Save it as CSV first.”
2. **Match columns.**
   - “What is one row in this file?” One day (a daily summary); One check or order; One item on a check. The third blocks Continue with “Item-level exports aren’t supported. Export daily totals or checks, not items.” Item lines repeat the check’s guest count, so adding them up would inflate guests.
   - Four pickers list the header names, each with a type detected locally from the first 200 non-empty cells (“dates”, “numbers”, “text”). Cell contents are never shown (D11).
   - **Date** (required) accepts `YYYY-MM-DD`, `YYYYMMDD`, `M/D/YYYY`, `M/D/YY`, any of them followed by a space and a time, which is ignored. For slash dates the user confirms the order: “Month first (03/04/2025 is March 4, 2025)” or “Day first (03/04/2025 is April 3, 2025)”. If a first part above 12 appears, the order is set and shown. The helper reads: “If your export has a business date column, pick it, so a 1 a.m. order counts toward the night before.”
   - **Guests** and **Net sales** are optional, but at least one is required.
   - **Location** is optional. If it is mapped, the user picks which value of that column is this location, from up to 50 distinct values. These are the only cell contents ever displayed, because the user named that column as locations. Only matching rows are used.
   - Header guesses preselect the pickers: date from `date` or `business date`; guests from `guests`, `covers` or `guest count`; net sales from `net sales`. [CONFIRM: header guesses]
3. **Check the totals.**
   - Numbers: strip `$`, thousands commas and spaces. Parentheses or a leading minus (hyphen or U+2212) mean negative, so refunds net out. Guests must be whole numbers. Net sales becomes integer cents, rounded half up once per day.
   - In “one day” mode, a repeated date is an error: “{n} dates appear more than once (rows {list}). Choose “One check or order”, or fix the file.” In “one check” mode, rows are added up per date: “We add up rows that share a date.”
   - The screen shows “{rows} rows became {days} days, {first} to {last}.”
   - Skipped rows by reason, with up to 10 row numbers each and never a value: “{n} rows had no readable date (rows {list}).”, “{n} rows had a number Townwise couldn’t read (rows {list}).”, “{n} rows were for other locations.”
   - Excluded days, listed by date with the reason (up to 10, then “and {n} more”): a date after tomorrow, a date before 2010-01-01, a negative daily total, a total above the caps in 11.3, or a day with neither value.
   - Totals for the file (guests, net sales), with “Check these against your point-of-sale system.”, and a table of the first 7 and last 7 days.
   - If the location already has data, for an org admin: “You already have {first} to {last}. Days in both will be replaced by this file.” For a member: “You already have {first} to {last}. Days you already have stay as they are. Only an admin can replace them.”
   - More than 3,660 days: “This file covers more than 10 years. Upload up to 10 years at a time.”
4. **Send.** One request. On success, all file state is cleared, and the result reads, for an org admin: “Saved {days} days for {location}: {inserted} new, {replaced} replaced.” For a member: “Saved {inserted} new days for {location}.”, then, when `kept` is above zero, “{kept} days already had data. Ask an admin to replace them.” It is followed by the calibration line and the links “Add notes for unusual days” and “See your sales data”.

### 11.3 Server rules (zod `.strict()` at every level)

| Rule | Value |
|---|---|
| Body | exactly `{ days }`; any other key is 400 |
| Day | exactly `{ date, guests, netSalesCents }`; any other key is 400 |
| `days` length | 1 to 3,660 [CONFIRM: ten years per upload] |
| `date` | `^\d{4}-\d{2}-\d{2}$`, a real calendar date, not before 2010-01-01, not after the server’s UTC date plus one day (covers every US zone) [CONFIRM: earliest date] |
| `guests` | integer 0 to 20,000, or null [CONFIRM: cap] |
| `netSalesCents` | integer 0 to 100,000,000 (one million dollars a day), or null [CONFIRM: cap] |
| Per day | at least one of `guests` and `netSalesCents` is not null |
| Dates | unique within the request |
| Size | a 256 KB parser on this route only. 3,660 days at the largest allowed values serialize to 230,590 bytes (measured for this spec), under 262,144 |

Any failure is 400 `invalid_request` with no field details (**Exists**). The client applies the same rules first, so a 400 means a client bug.

### 11.4 Write

1. Insert the `tw_uploads` record with `status: 'applying'`.
2. One unordered `bulkWrite` of upserts keyed by `{ orgId, locationId, date }`. Days not in the upload are untouched.
   - **Org admin:** each upsert `$set`s `guests`, `netSalesCents`, `uploadId` and `updatedAt`, so an uploaded day replaces that day in full, nulls included.
   - **Member:** each upsert writes those four fields with `$setOnInsert` only, so a day that already exists is never changed. A member’s upload therefore cannot overwrite or zero out history, which matches the matrix reserving deletion for org admins (Section 3).
   
   [CONFIRM: replace by day for org admins; members add new days only. If members should replace data too, the matrix must say that a member’s upload can overwrite all of a location’s history.]
3. Set the record to `applied`, with `inserted` (upserted count) and, from the matched count, `replaced` for an org admin or `kept` for a member.
4. Audit `sales.uploaded`. Log `townwise.upload_applied { orgId, locationId, uploadId, dayCount }`.

A crash leaves `applying`, which the Sales data tab shows as “This upload didn’t finish. Upload the file again.” Sending again is safe, because every write is an upsert on the day; a member’s resend keeps the days that already saved. The request body is never logged: server-core logs no bodies (**Exists**), and Townwise code adds no body logging.

Delete all sales for a location removes its `tw_sales_days` and `tw_uploads`; the audit log keeps the history.

---

## 11A. Stored files and the file reader

The other way in: a person drops their exports as they are, they are stored privately for the organization, and Townwise reads them on the server. Off until `FILES_BLOB_ACCOUNT_URL` is set (10.11), and in production until the stored-files release (`infra/README.md`, step 18). [CONFIRM: every cap and limit in this section]

### 11A.1 Storage

One private Azure storage account for every organization (owner decision, 2026-11-05), with public network access disabled: the only way in is a private endpoint in the endpoints subnet, open to the apps subnet on 443. Two containers: `client-raw` (originals) and `client-clean` (cleaned copies), blob names ids only (6.10 rule 9). Entra ID only, through a custom role on the two containers with four blob data actions and no SAS rights. Every blob read, write and delete is logged, ids only, to the audit account for a year. Soft delete keeps a deleted blob 7 days. Models never live here.

### 11A.2 Uploads

Chunked sessions, because the Container Apps ingress closes a request at 240 seconds and a 200 MiB body needs a sustained 7 Mbps to beat it; an 8 MiB chunk needs 0.3 Mbps, survives a dropped connection (one chunk is retried), and never holds a file in memory.

1. `POST /files` joins the location's active import (creating an `open` one), reserves the size against the organization's day, inserts the row as `uploading`, and answers the caps. Refusals in order: 400 shape, 400 purpose, 404, 413 size, 409 `import_full`, `too_many_uploading`, `storage_full`, `daily_upload_limit`.
2. Each `PUT` streams its body through a hashing, counting Transform into Azure's Put Block with retries off (a stream cannot be replayed; the browser retries the chunk). Node pauses the request when storage is slower, so TCP pushes back to the browser. A replica takes 12 chunk streams at once. A client abort aborts the storage call and records nothing; a re-sent chunk replaces the staged one.
3. `complete` checks every chunk arrived, commits the block list (`If-None-Match: *`; a blob already there counts as committed), computes the fingerprint and the kind, removes a second copy of a live file of the location (409 `file_duplicate`), and sets the file `stored`, or `queued` when its import already started. The import's `drops` then moves, so the reader never finishes an import past a file that just joined it; a file whose import finished meanwhile moves into the location's next import. When it is that import's first file, the import starts at once (the person already asked for the file to be read); an open import someone already dropped files into stays open, with this file among its `stored` rows, until they start it.

| Cap | Value |
|---|---|
| A file | 200 MiB, in 8 MiB chunks; downloads of originals in 32 MiB parts |
| An import / a location / uploading at once in a location | 50 / 500 / 10 files |
| An organization | 5 GiB stored (originals not deleted), 2 GiB uploaded a UTC day |
| An upload session | 24 hours; after that it counts toward no cap above |
| Reading | text streamed (the upload cap); workbooks and Word documents 10 MiB, 2,000 parts, 64 MiB a part, 200 MiB declared, 100 to 1 a part over 1 MiB, `word/document.xml` 50 MiB; PDFs 25 MiB, 1,000 pages, 20,000 text items a page; 2,000,000 rows, 200 columns, 10 sheets; 192 MiB of heap and 20 minutes a file |
| ZIP archives | 20,000 entries and 2 GiB declared, every depth together; 100 to 1 for the archive and for each entry over 1 MiB; a 16 MiB central directory; a ZIP inside a ZIP opened from memory up to 50 MiB (50 MiB of them at once), one inside that never opened |
| AI column step | 2 calls a file, 5 a ZIP (at most one a family of its tables), 20 an import; `TOWNWISE_FILES_MONTHLY_BUDGET_USD` per organization per month (default 5; 0 turns it off) |

The drop screen (P11 step 3) is the client of these routes, through `client/src/portal/files/` (storage2 15.3): it never hard-codes a cap, sends each file’s name and size only in the create body, and offers the browser path (11.1) while stored files are off.

### 11A.3 Kinds

No file is refused for its type; the browser's MIME type is ignored. From the extension and the first bytes: `%PDF-` is `pdf`; a ZIP signature is `xlsx` (.xlsx, .xlsm), `docx`, `other` (.numbers, kept `numbers`) or `zip`; an OLE container is `xls` (kept `old_excel`), `doc` (kept `old_word`) or, for .xlsx, .xlsm and .docx, a password-protected file (kept `encrypted`); images are kept `image`; text extensions with a UTF-16 mark or no NUL byte are `text`; anything else is kept `type_not_read`. `text`, `xlsx`, `pdf`, `docx` and `zip` are read; a ZIP's entries are told apart the same way, from their names and first inflated bytes.

### 11A.4 Reading

The file reader (`api/src/files/worker.ts`) runs in each API replica: every 5 seconds, or at once when nudged, it claims the oldest started import that is queued with no live lease, or reading under a lease that ran out (`claimNextImport`, 6.10 rule 8), holds a 90-second lease renewed every 30 seconds, and reads the import's files one at a time in upload order. It takes a `stored` file of a started import as it takes a `queued` one, because starting an import and queueing its files are two writes and a claim can land between them; so it never finishes an import past a file it has not read. A suspended organization's import is held back an hour. A file is attempted at most three times, then failed with `internal`.

Each file is read in a worker thread with memory and time limits; the main thread feeds it 1 MiB at a time, acknowledged. The time limit covers the reads from storage as well, and aborts a read that stalls, so a stalled download never holds the replica's reader or the import's lease. Text is decoded as UTF-16 by its mark, else strict UTF-8, else windows-1252, and read in two passes with the browser's tokenizer (11.2), rewritten to take pieces (`CsvPushReader`, which yields exactly the whole-text reader's records). The first pass finds the header row (the first of the first 30 records with two or more filled cells that is a header and names a date, else the first header), profiles every column over every row, and collects the location column's values; the mapping is decided; the second pass adds rows up per date with the browser's `DayAggregator`. A workbook's sheets are each a table, read in sheet order; a later sheet's day replaces an earlier one's only for an org admin's file. Raw rows never leave the thread.

The mapping, in order, with the person's answers overriding each step: the date column (a guessed date header, earlier names first, `business date` before `date`; else the one column of dates; a tie is a question); the date order (proven by a part above 12 over the whole column, else a question); guests and net sales (guessed headers; else a question among the number columns, or kept `notes_not_read_yet` when there are none); the location (a guessed location column with one value is ignored, a value equal to the location's name is used, otherwise a question; over 50 values is kept `too_many_locations`); and after the second pass, what one row is (no repeated date is day-level; repeats with check headers and no item headers are checks, added up; item headers are kept `item_level`; otherwise a question). Header guesses extend the browser's: date `business date`, `date`, `day`, `order date`, `opened date`, `closed date`; guests `guests`, `covers`, `guest count`, `total guests`, `number of guests`, `# of guests`; net sales `net sales`, `net amount`, `net revenue`, `sales (net)`, `net`; location `location`, `restaurant`, `store`, `site`; checks `check`, `check #`, `check number`, `order id`, `order #`, `order number`; items `item`, `menu item`, `qty`, `quantity`, `modifier`. [CONFIRM: header guesses]

**When the rules find no guests or net sales column** (the `columns` question) and the person has not answered it, the AI column step may choose them. The parse thread builds a redacted profile: each column's header text (at most 40 characters), the kind of its values, how filled it is, a count of its distinct values in four buckets, and for number columns whether they are whole and the order of magnitude of the median; and up to 15 rows with every cell replaced by a token (`<date:iso>`, `<date:slash>`, `<int>`, `<decimal>`, `<money>`, `<empty>`, `<text>`). Only that profile crosses to the main thread, which asks Claude Opus 5.5 at low effort (`api/src/files/extract/`, structured output `{ guests, netSales, confidence }`, the chat's server-side refusal fallback, 60 seconds, the SDK's logger off). No row, figure, file name, ZIP entry path, sheet name, organization or location name, paragraph or text outside a table is ever in the request (`test/files/profile.test.ts` pins it). A confident choice of number columns is applied and reported as `ai`; an unsure one becomes the question's suggestion; off (no `ANTHROPIC_API_KEY`), out of budget, or failed, the person is asked. Each call is charged to `tw_files_usage` (6.13) and the file after it returns, whatever it answered; the budget is checked before each call. Never retried beyond the SDK.

**PDFs** are read in the parse thread with `unpdf` (a serverless pdf.js; fonts never loaded, nothing rendered, nothing logged below errors). Each page's text items are grouped into lines (the same baseline within 2 points). A table starts at a header line, one whose items include a date header and a guests or net sales header; the header items' extents make the column bands (midpoints between neighbours); each following line's items fall into the band their centre is in; a line with fewer than two filled bands, or one that starts with "total", ends the table. A header repeated on a later page continues its table. Kept: `encrypted`, `pdf_scanned` (no text on any page), `pdf_no_table`, `too_complex` (over 1,000 pages or 20,000 items a page). **Word documents** (`.docx`) pass the package guards, then each top-level `w:tbl` of `word/document.xml` is read with `saxen` into rows of cells; none: `word_no_table`. Every table of a PDF or a Word document is read as a workbook's sheet is. Text outside tables never leaves the thread.

**ZIP archives** are read in place: the parse thread asks the main thread for byte ranges, which answers them from storage, continuing one open download while the reads are in order, so the archive is never downloaded whole. The central directory (and its ZIP64 record) is read from the end, and the archive guards (the table in 11A.2, plus entry ranges that overlap the next entry, the overlapping-entry bomb) run on declared sizes before anything is inflated; any failure keeps the whole ZIP (`zip_too_big`, `zip_bomb`), as does an entry that inflates past its declared size (`zip_damaged`). Each entry is a file of its own: `__MACOSX/` and `.DS_Store` are `system_file`, an encrypted entry `encrypted`, a method other than stored or deflate `zip_method`, a ZIP inside a ZIP inside the ZIP `nested_zip`. Its tables are read as **families**: every table with the same normalized header row (its signature is the SHA-256 of the names, its label the first six). A family's mapping is decided once, on the stats of all its tables together (so a date order is proven across daily files), with the person's answers under `family:<signature>`; one aggregator runs across all its tables, so check rows split across daily files add up per date. Families with a guests or net sales header are read first; the others only when none of those gave days, and are otherwise kept `no_sales_columns` without a question. Families that gave days are ranked (rules before AI before answers; day-level before check-level; more dates first; then signature order) and each adds only dates no higher-ranked family produced, so two report types covering the same days are never added together; a family that added none is `other_table_used`. The ZIP is one `tw_uploads` record and one cleaned copy. Its entries are listed in `tw_file_entries` (6.18) with what became of each; none used keeps the ZIP as `nothing_usable`, or with its families' one shared reason.

A question pauses the import (`waiting`) and names the file and sheet, or for a ZIP the family by its label. Its options are header names, the location column's values (the D11 exception) or fixed ids, never other cells, and always `not_sure`, which keeps the file as `needs_help`. An answer is stored on the file and the file is read again from the start. The file moves back to the queue (or to `kept`) before the import does, while no reader can claim the import, and that move is the compare-and-set a second answer loses with 409 `question_stale`.

### 11A.5 Products

1. **Days** through the existing store and rules (11.3, 11.4): an org admin's file replaces the days it covers, a member's adds new days only. One `tw_uploads` record per file, created once and kept on the file, so a retry reuses it.
2. **Cleaned copy** `client-clean/{orgId}/{locationId}/{fileId}.csv`: `date,guests,net_sales`, CRLF, net sales in dollars with two decimals, empty for none. Nothing else.
3. **Report** on the file: the sheets and what became of each, the header row, the header names mapped, which rule or answer decided each column and the row mode, the location value chosen, the date order, the encoding, rows and days, skipped rows by number (never a value), excluded days with reasons, closed days, missing days, and how many days already had data. No data cell except the location value. A ZIP's report adds `families`: per family (at most 50) its label, how many tables, whether it was used, its row mode, the days it added and why (`sales`, `other_table_used` or the reason it was kept). `decidedBy` names `rules`, `ai` or `you` for each field.

### 11A.6 Status, outcomes and time left

`read` (shown as Used), `kept` (stored, not used, with the reason) or `failed` (only our fault: `internal`, `raw_missing`). Kept outcomes: `old_excel`, `old_word`, `numbers`, `encrypted`, `image`, `type_not_read`, `too_large_to_read`, `not_a_table`, `no_header`, `no_dates`, `notes_not_read_yet`, `no_sales_columns`, `too_many_locations`, `item_level`, `decimal_comma`, `repeated_dates`, `too_many_days`, `not_a_workbook`, `too_complex`, `bad_encoding`, `needs_help`, `pdf_no_table`, `pdf_scanned`, `word_no_table`, `zip_too_big`, `zip_bomb`, `zip_damaged`, `zip_empty`, `nothing_usable`, `raw_deleted` (the original was deleted before Townwise read it: a staff purge, or retention). A ZIP entry's outcome is one of those that applies to one file, or `system_file`, `nested_zip`, `zip_method` or `other_table_used`. A PDF's progress counts pages; a ZIP's (phase `unpacking`) counts the compressed bytes read, over both passes.

Time left is measured, never guessed: a reading file's from its own rate in the current phase, only after 3 seconds and 5 percent; a queued file's from the reading file's plus the queued bytes before it at the speed this import's finished files were read, so the first file of an import says "Estimating" until it finishes; null above six hours and while the import waits for a turn (queued 10 seconds, unclaimed). Rounded up to 5 seconds. Progress is written at most every 2 seconds.

### 11A.7 Downloads, deletion and view-as

Downloads stream through the API (no SAS: the account has no public endpoint), as attachments with `nosniff`, `no-store` and `default-src 'none'; sandbox`. The original goes only to its uploader and the organization's admins, in 32 MiB parts when asked; the cleaned copy to every member. Deleting the original keeps the cleaned copy, report and days and replaces the name with the kind's label, and a workbook's sheet names in the report with `Sheet 1`, `Sheet 2` and so on (either can itself name a person). It is refused (409 `file_busy`) until the file is read, kept or failed: a file not yet read still needs its original, and reading one whose original the person deleted would fail it as our fault. Deleting the whole file stays open, except while it is being read. Deleting a file removes both blobs and the row, and says how many days stay; an unfinished upload is cancelled (its staged blocks discarded at once) and its bytes given back. Under view-as, names and ZIP entry paths are null, nothing downloads, and every write is refused; each read logs `townwise.view_as_read` as every GET does.

An org admin can delete every original of a location at once (`DELETE /originals`, the "delete my files" control): each one the reader is done with goes as a single one does, and the rest are skipped and counted (`files.raw_deleted_all`). Deleting a location's sales data deletes its stored files too: imports first, unfinished uploads discarded, every blob under `{orgId}/{locationId}/`, the entry lists and the rows (409 `import_running` while one of its files is being read; 503 `files_unavailable` when stored files are off but it has files); `sales.deleted` counts `deletedFiles`. Files are data for a location's deletion (409 `location_has_data`). An organization's deletion and the staff purge of its originals are in 10.7.

**Retention** [CONFIRM: retention periods]. The daily sweep (`api/src/files/sweeper.ts`), one replica a day under the `tw_file_sweeps` lease (6.14), discards upload sessions past their 24 hours, deletes originals 365 days after upload, read or not (a file never read is kept unread as `raw_deleted`; name and entry paths cleared; the cleaned copy, report and days stay; the storage lifecycle rule is the backstop at 400 days), deletes files dropped into an import never sent for reading 30 days after its last drop (with the import), finishes staff purges of flagged files, drops daily upload counters after 3 days, and deletes blobs whose file row is gone once they are a day old. It logs counts only.

### 11A.8 Not in this build

- Old Excel (`.xls`) and Word (`.doc`) files are kept, not read; reading them needs a library from outside the registry (an owner question).
- Text and notes inside files (closure lists, event notes) are stored with the original and never read or sent to any model.
- The AI step chooses guests and net sales columns only; it never chooses the header row, the date column or the location value.
- Other upload purposes (a calendar upload, a TownwiseAI attachment) and the processor registry they would use: `POST /files` answers 400 `purpose_unavailable` for anything but `history`.
- Malware scanning (Defender for Storage) is off: nothing stored is executed, rendered or served inline.

Stored files stay off in production until the client pieces, the drop screen and the privacy page ship with them (`infra/README.md`, step 18).

---

## 12. Notes (the tuning step)

```ts
type NoteKind = 'closure' | 'private_event' | 'opening' | 'other';
type NoteEffect = 'closed' | 'more_guests' | 'fewer_guests' | 'unknown';

interface NoteInput {
  kind: NoteKind;
  startDate: string;                 // YYYY-MM-DD, 2010-01-01 to today plus two years
  endDate: string;                   // inclusive, >= startDate, at most 366 days after it
  weekdays: number[] | null;         // 0 (Sunday) to 6, unique, 1 to 7 entries; null means every day in the range
  effect: NoteEffect;
  expectedGuests: number | null;     // integer 1 to 20,000; must be null when effect is 'closed'
  detail: string | null;             // up to 280 characters; required when kind is 'other'
}

interface Note extends NoteInput {
  id: string; createdByEmail: string; createdAt: string; updatedAt: string; canEdit: boolean;
}
```

Stored in `tw_notes`: the `NoteInput` fields, `_id`, `orgId`, `locationId`, `createdBy` (userId), `createdAt` and `updatedAt`. No email is stored; `createdByEmail` is read from the kit user at response time (10.1).

- Each kind sets the form’s default effect: closure is `closed`, private event is `more_guests`, opening and other are `unknown`. The owner can change it.
- `weekdays` covers the homepage’s own example, “closed Mondays in March”, with one field.
- Past notes explain history, and upcoming notes are for forecasts once they exist. Both are allowed.
- Authors edit and delete their own notes; org admins edit and delete any. [CONFIRM: author or admin]
- `detail` has the helper “Describe the event, not the guests. Leave out names.” The server cannot detect names and does not try. `detail` is never logged and never copied into an audit event.
- In v1, notes are stored and shown. Nothing reads them yet, and the pages say so.
- An AI chat to tune the model waits, because sending client data to an AI provider is a privacy decision not yet made (D13).

---

## 13. Town profile source

- **Display data.** The client renders the twelve towns on `feature/townwise-web` from generated modules in `client/src/marketing/map/` (`towns.ts`, `countyData.ts`, built from `townwise-home.json`). The portal reuses those data modules, so the app holds one copy of the town data and no `/api/towns` route exists. [CONFIRM: depends on `feature/townwise-web` merging first]
- **Components.** On that branch the chart, month scrubber and numbers table live inside `TownPanel.web.tsx`, which is web-only and tied to the map (`cardRef`, crossfade class names, `onBack`). No DeltaChart, MonthScrubber or NumbersTable component exists in the client; they exist only as HTML in the design-system bundle. This build extracts them from `TownPanel.web.tsx` into map-independent web components (`TownProfile`, `DeltaChart`, `MonthScrubber`, `NumbersTable`, each a `.web.tsx` file), and the homepage map then uses those components.
- **Native (D21).** The client has no `react-native-svg`. On native, the town profile shows the text summary and the “Show the numbers” table, built from View and Text, plus “See the chart at townwise.tech.”
- **Validation data.** `api/src/towns.ts` holds the twelve `{ townId, name, state, kind }`. The API uses it to validate `townId` and to fill `name` and `state` on locations and requests. `api/test/towns.test.ts` pins the twelve ids as a literal array, copied from this spec’s Data facts, and the client’s test on `feature/townwise-web` asserts the same literal list. Neither side imports across packages (`import-x/no-relative-packages`, and api cannot depend on the Expo app). Another town is stored with `townId: null`, a name (1 to 80) and a two-letter US state code from a fixed list.
- **What the Town tab and the Waiting page show** follows every design system rule: county, not town; employment, not sales. The kicker is “Historical public data, 2024”, with “Measured across {county}, 2024.” The page shows the kind tag, the anchor, the 2024 food-service employment pattern against the Northeast with “Show the numbers”, drivers and key dates with source links, the Curve line, the three caveats, the index definition and the source list.
- **Honest gaps:**
  - A town outside the twelve: “Townwise hasn’t researched {town}, {state} yet. Profiles cover twelve Northeast towns today.” No chart.
  - A listed town with no drivers or dates (Nantucket today): the curve, then “No drivers or key dates are researched for {town} yet.” Conway, North Elba and Provincetown show their one driver and the same line for dates.
  - A missing county series: “BLS does not publish this series for {county}.” (design system).
  - Key dates print with their year, so dates that have passed read as history, not as a live calendar.

### 13.1 Town calendar

One calendar, in `api/src/town-calendar.ts` (pure, no I/O, stored nowhere), serves the calendar route (10.10), TownwiseAI’s tools and the term state (13.2). `townEvents(townId, range)` merges three sources, each event with at least one source:

- **US federal holidays**, computed for every year the range touches from their legal rules (5 U.S.C. 6103), on the actual day rather than the observed weekday, since restaurants feel the real day. Source: the U.S. Office of Personnel Management’s federal holidays page. New Year’s Day (Jan 1), Birthday of Martin Luther King, Jr. (third Monday of January), Washington’s Birthday (third Monday of February), Memorial Day (last Monday of May), Juneteenth (June 19, from 2021), Independence Day (July 4), Labor Day (first Monday of September), Columbus Day (second Monday of October), Veterans Day (Nov 11), Thanksgiving Day (fourth Thursday of November), Christmas Day (Dec 25). `kind: 'holiday'`, `scope: 'national'`, `group: 'us:{slug}'`. Non-federal days (Valentine’s Day, Mother’s Day) are left out: they have no official source.
- **Key dates** from the town profile (Section 13): single-day `event`s with the profile’s sources, labelled by hostname, no group and no confidence.
- **Researched entries** in `api/src/town-calendar-data.ts`, hand-curated, each with its sources and the confidence its research gave it. Hanover is seeded from the committed public file `modeling/dartmouth_calendar_2025_2026.csv` (38 rows from winter 2025 to fall 2026: classes and finals, Commencement, Green Key, Homecoming, Winter Carnival, Family Weekend, orientation and home football), one entry per row, and `api/test/town-calendar.test.ts` compares the two row by row. After them come winter and spring 2027 classes and finals and Commencement 2027 from the registrar’s 2026-27 key dates (researched 2026-11-06), so the term state stays known past fall 2026 finals; the CSV feeds the modeling notebook and is left as it is, so the test pins these five apart from it. No other town has entries yet.

Term entries follow one convention, which the term state reads: `kind: 'term'`, `group: '{townId}:classes:{season}'` for the class period or `'{townId}:finals:{season}'` for the exam period, with season `fall`, `winter`, `spring` or `summer`. Between-terms periods are not entries; the term state derives them.

`townCalendarCovers(townId)` is the span of the town’s researched events (key dates and entries) over all years, or null; `researched` is true when it is not null. Hanover covers 2025-01-06 to 2027-01-05, with only key dates after fall 2026 finals. A town outside the twelve, and a listed town with nothing researched (Nantucket), get holidays only.

Headcount inputs (residents, students in college housing, enrollment, whether dorms close between terms) are not part of the calendar. None is researched yet for any town; they stay empty, and say so, until a teammate researches them with a source for each number (13.2).

### 13.2 People in town

Who is likely in a location's town each day, from public sources, in `api/src/people-in-town/` (pure, stored nowhere), for the people in town route (10.13), Home's month card and TownwiseAI. It never invents a number: a headcount is printed only when every input to it has a stored source, and otherwise is null with the reason.

- **Term state**, from the calendar's term entries (13.1 convention): `in_session` when a classes entry covers the day (`summer_session` for summer classes, when most of the college is away), `finals` when a finals entry does, `between_terms` only when the last entry before the day is a finals entry and the next one after it a classes entry, and `unknown` otherwise, including the days between classes and finals and any day outside the researched span. Hanover's calendar ends with fall 2026 finals, so from Nov 26, 2026 its days read `unknown` until the winter 2027 term is added.
- **Events and holidays** from the calendar, each with its sources; term and season entries are context, never events.
- **Season**: the county’s 2024 food-service jobs index for each month (Section 13’s data, labelled as employment, not people).
- **Headcount** (`api/src/people-in-town/estimate.ts`), only for a college town with a researched population: residents plus or minus their 90% margin in session and during finals; between terms, low minus enrollment and high minus students in college housing when housing is known to close; in the summer session, low minus enrollment; an event with a researched attendance figure raises only the high end (attendees may already live in town), and one without is listed as left out. Low is rounded down and high up to the nearest 100, never below 0. No multipliers, shares or fitted constants. Seasonal and event towns get none in v1 (`visitors_unknown`): no public source turns visits into people present on a day.
- **Researched inputs** (`api/src/people-in-town/sources.ts`): resident population with its margin, students in college housing, enrollment (one institution per town), whether housing closes between terms, event attendance and visitor counts, each with a source id whose source has a label, an https URL, the date retrieved and a confidence. Empty for every town today (owner decision, 2026-11-05); `api/test/people-sources.test.ts` holds the rules a filled entry must pass.
- **Your history by term state**: the location’s mean guests (net sales, in whole dollars, when no day has guests) by term state and weekday over its open regular days, with day counts; a cell under 3 days has no mean. Open regular uses the client's day classes (closed, noted, holiday, event, regular), pinned on both sides by the shared fixture `day-classes.json`.
- **Sources and caveats**: every number names source ids that resolve in `sources` (`bls-qcew` for the jobs index, `cal-{n}` for calendar sources, researched ids as given); caveats are fixed sentences chosen by which inputs were used.
- **Today** for TownwiseAI is the town’s local date (`api/src/time-zones.ts`): the twelve towns are `America/New_York`; another town gets its state's most populous zone, marked approximate in the thirteen states split between two.
- **Honest gaps**: with no headcount, Home's card says “Townwise can’t put a number on how many people are in {town} yet.” with a Planned tag; the model card says no forecast exists yet with an In progress tag, how far the town's calendar is researched, and that no public count is researched; a town outside the twelve says Townwise hasn’t researched it.

---

## 14. Calibration and forecast states

### 14.1 States in v1 (derived on every read, never stored)

| State | Condition | Heading | Body |
|---|---|---|---|
| `no_sales_data` | no day with guests or net sales | “Not calibrated yet” | “Upload your sales history to start. The upload sends Townwise only the date, guest count and net sales for each day.” |
| `not_calibrated` | one or more days | “Not calibrated yet” | “Your sales history is in: {n} days, {first} to {last}. Calibration isn’t built yet, so there is no forecast.” |

Mockups add the chip [DECISION NEEDED: minimum days of history before calibration] under the `not_calibrated` body. When the user decides, a `needs_more_history` state with the copy “Calibration needs {min} days of history. You have {n}.” joins the table. Until then, no page states a threshold.

[DECISION NEEDED: whether staff may copy a client’s uploaded days into research notebooks, for that client’s calibration only, and how the copy is recorded, shown to org admins and deleted.] Until it is decided, no client page mentions research notebooks or promises that a forecast will appear. The API has no export route, so today the only ways to get the figures would be copying view-as tables or reading the database directly, and both bypass the audit. If the answer is yes, the build adds an audited staff export route instead: a `sales.exported` audit event, listed in the org admins’ staff activity next to view-as, and a line on the privacy page. Terms (“Your data”, on `feature/townwise-web`) allow use for “calibrating your forecasts” and say “we will not use your data to improve Townwise for other customers”, so using a client’s days to work on shared candidate models would break Terms as written.

**Data checks**, shown under the state and computed from the client’s own rows: days with data, first and last day, missing days in between, days with guests, days with net sales, and the last upload with its date and who sent it.

### 14.2 What the app never shows in v1

No forecast numbers, ranges, reasons or accuracy, except from a run staff published (14.4). [Build note: owners see a published run on the model card and through TownwiseAI; Home and Analytics keep showing none until a later change.] No “calibrating” or “calibrated” states, and no progress for a process that does not run. No sample values. The one forward-looking block is the design system’s own pattern (Section 16, P11): a layout headed “Illustrative layout, not real output”, with slots only. [CONFIRM: show the illustrative layout in the app] Home replaced the Forecast page at P11 (owner decision, 2026-11-05), so the app shows no illustrative layout today.

### 14.3 Reserved for later (not in the v1 API)

`queued`, `calibrating`, `calibrated` (with model version and fitted date), `stale` (sales or notes changed since the last fit) and `failed`. They arrive with model storage, as a `tw_calibrations` collection keyed by location. The forecast shape, also reserved: `{ horizon: 7 | 28; frozenAt; modelVersion; interval: 0.8; days: { date; guests: { low, mid, high }; netSalesCents: { low, mid, high }; reasons: { text, source }[] }[] }`. [Build note: forecasts now arrive as staff-imported runs in the shape of 14.4 (guests only, reasons labelled in code, never free text); the calibration states and `tw_calibrations` stay reserved.]

### 14.4 Forecast runs

The API never computes a forecast and never holds a model. Staff export a run's outputs on the team's computers (`modeling/export_forecast_run.py`, from the frozen files in `modeling/forecasts/`, written to the gitignored `modeling/outputs/`), import the run file for one location from P21, and publish it. [Build note: owner decision 2026-11-05: staff may import and publish Sawtooth's frozen v3 forecast once Sawtooth is an organization in Townwise and the owner confirms its consent to see it and to its being sent to Anthropic through TownwiseAI. The build ships the machinery only; nothing is published.]

- **The run file** (`townwise.forecast-run/1`, `api/src/forecasts/file.ts`, at most 256 KB as sent: P21 reads the file in the browser, refuses one over 2 MB on disk unread, and checks the 256 KB on the parsed file as compact JSON, so the exporter's indenting doesn't count; strict at every level): `schema`, `metric: 'guests'`, `model { family, version, notebookCommit }`, `trainingSource: 'files_from_owner'`, `trainedFrom`, `dataThrough`, `madeAt`, `frozen`, `interval { level: 0.8, widened }`, `backtest`, `days` (1 to 400: `date`, `status`, `low`, `mid`, `high`, `baseline`, up to 6 `reasons { kind, ref, effectPct }`) and `weeks` (up to 60: `from`, `to`, `openDays`, `low`, `mid`, `high`). No location id, name, note, URL or other free text. Rules: `trainedFrom <= dataThrough <= madeAt <= today`; every day after `dataThrough` and within 400 days of it, each once; an open day has `low <= mid <= high` (0 to 20,000), a closed or booked day no numbers; only term, event and holiday reasons may carry a `ref`; each week lies inside one Monday-to-Sunday week, on days the file has, without overlap, with `openDays` between its open days and its open and booked days. A refusal is 400 `invalid_forecast_file` with at most 50 `{ path, code }` issues, never a value.
- **Import** (staff, 10.7): the run is upserted on `{ orgId, locationId, fileSha256 }` as `importing`, its rows upserted on their key (a duplicate key from a concurrent import of the same file is a row the other one wrote, not an error), and it becomes `draft` when every row is there. The same file again answers 200 with the run; a run left `importing` finishes on the retry. Publish is a compare-and-set from `draft`; withdraw from `draft` or `published`. Each is a staff action (9.2), written before the effect and listed in the org's Townwise staff activity.
- **Who sees it.** Owners, view-as and TownwiseAI read published runs only: drafts, unfinished imports and withdrawn runs never show. For each date the reader uses the newest published run whose `dataThrough` is before it, so no forecast is shown for a day its model saw. Week rows come only from a run that supplied every day of the week, and are the run's own, never sums of days.
- **Labels** are made in code (`api/src/forecasts/reasons.ts`): the weekday; the term from the town calendar's term state on the day; an event or holiday by the calendar entry its `ref` names (by id, or a group with one entry that day), a federal holiday on the day, or plain words ("Town event", "Holiday"); "Your recent level", "Closed", "Private event booked". A partner's text can never reach a label.
- **Accuracy.** Each past day carries its stored guests and whether they landed in the range. Live accuracy is per run: it counts the open days that have passed which that run supplied (the reader chose it for them), booked days left out, as WAPE with the in-range count, misses included, and is null under 5 of its own scored days. A newer run is never credited with an older run's days, so a run published today reads "not scored yet" even when older runs have been scored. A day is past once it has ended in the town (its local date, `localDay`, 10.13), on the forecast route, the model card and in TownwiseAI alike. Scored weeks are not listed separately: a week row in a read carries its `actual` and `inRange`. A week's actual is summed only when all its open days have passed and none was booked.
- **Read view** (`ForecastWindow`): `{ available, reason: 'no_published_forecast' | 'not_covered' | null, runs: (ForecastRunView & { live: LiveAccuracy | null })[], days: ForecastDayView[], weeks: ForecastWeekView[], notCovered: { from, to }[] }`, each run with its own live accuracy. `ForecastRunView` is `{ id, metric, model: { family, version, label }, trainingSource, trainedFrom, dataThrough, madeAt, frozen, interval, backtest }`; a day `{ date, weekday, status, low, mid, high, baseline, reasons: { kind, label, effectPct, sources }[], runId, madeAt, madeAfterDay, actual, inRange }`; a week `{ from, to, openDays, low, mid, high, runId, madeAt, actual, inRange }`; `LiveAccuracy` `{ days, inRange, typicalErrorPct, from, to }`. Numbers are raw; clients and TownwiseAI round low down and high up.
- **TownwiseAI** reads it through `get_forecast { from, to }` (at most 31 days, from at most 92 days back), which answers "Townwise has no forecast for this location yet." when none is published; its prompt gives every forecast as a range, never the middle alone, uses week rows for weeks, names the model when asked, mentions accuracy and misses when the owner is deciding, and never makes up a forecast (`tuning-chat.md` section 4).
- **Deletion.** Runs and rows go with the location's sales data (they are derived from it), the location, the organization, and by staff delete; a person's deletion clears their staff id (10.7). Fitted models and the partner's exports stay on the team's computers, with a deletion duty in the runbook (`infra/README.md`, Forecasts).

---

## 15. App shell

Mockup builders work from this section in parallel, so every page uses exactly these frames, bars, tabs, banner and patterns. Tokens are from `townwise-ds/project/tokens.json`. Class names are from `components/bundle.css`.

### 15.1 Four frames

| Frame | Used by | Top bar | Nav items |
|---|---|---|---|
| **Public** | `/sign-in`, `/totp` | the marketing Nav and footer, as on the SignIn artboard (**Exists**) | the marketing links |
| **Gate** | `/request-access`, `/waiting`, `/no-access`, `/joining`, `/staff/sign-in-again`, the staff notice on `/settings/security` | `ground` fill, 64px; wordmark left; right: “Signed in as {email}” (`mono`, `text3`, hidden below 641px) and “Sign out” (text link) | none |
| **Client app** | members and org admins, and staff in view-as | `ground` fill, 64px | per role (15.3) |
| **Staff console** | staff | `panel` fill, 64px | Requests, Organizations, People, Audit log |

Every signed-in frame ends with a slim footer: a 1px `border` rule, then one `mono`, `text3` row: “Townwise is a student project. It is not an official Dartmouth product.” and the links Privacy and Terms, `space-6` apart.

### 15.2 The client app layout

```
+--------------------------------------------------------------------------------------+
| VIEWING AS  {email}, {Role} at {org}. Read-only until {time}.        [End view-as]   |  view-as only (15.5)
+--------------------------------------------------------------------------------------+
| Townwise | {Org}  Home Analytics TownwiseAI Notes Town Upload   Team Settings  {email} Sign out |  top bar
+--------------------------------------------------------------------------------------+
| {LOCATION NAME}, HANOVER, NH          Location [{name} v]  All locations  Location settings |  page header
| {Page title}                                                                         |
+--------------------------------------------------------------------------------------+
| content, 12 columns                                                                  |
|                                                                                      |
+--------------------------------------------------------------------------------------+
| Townwise is a student project. It is not an official Dartmouth product.  Privacy Terms |  slim footer
+--------------------------------------------------------------------------------------+
```

- **Grid.** Content max `content-max` (1280px), centred. Side margins `margin-fluid` from 1024px, `margin-tablet` (32px) from 641px, `margin-phone` (16px) at 640px and below, plus safe-area insets as on the SignIn artboard. Columns: 12 from 1024px, 8 from 641px, 4 below; gutters `gutter` (20px) and `gutter-phone` (16px).
- **Top bar.** At least `nav-height` (64px), with a 1px `border` rule below. In order:
  - the wordmark “Townwise” (`wordmark`, `white`), which links to `/dashboard`;
  - a 1px `border` vertical rule, 20px tall, then the organization name in `ui`, `text2`;
  - the nav links in `ui`, `text2`, `space-6` apart, turning `white` on hover and with `aria-current="page"`, as Nav does. On the client app they are the location’s sections (15.3), then Team and Settings as a group at the nav’s far end;
  - right (`margin-left: auto`): the signed-in email in `mono`, `text3`, then “Sign out” as a text link.
  
  `<header>` holds `<nav aria-label="Main">`, and the skip link is the first focusable element (Nav, **Exists**).
- **Below 900px** (`bp-nav-wrap`; below 1280px when the client app’s bar carries a location’s sections, which need the room), the nav links wrap to a second row under a `border` rule. They never hide: the app has no footer that repeats them. At 640px and below the email hides; the organization name stays and truncates with an ellipsis, and the client app’s second row is one line that scrolls sideways in a focusable region (`role="region"`, `tabindex="0"`, `aria-label="Sections"`), reaching into the side margins and scrolled to keep the current link in view.
- **Page header.** `space-8` above, `space-6` below.
  - Left, columns 1 to 8: the eyebrow (`tw-eyebrow`, `text3`), then the page title as the page’s one `<h1>`, styled `tw-h2` (40/44, then 32/36 below 1024px, then 28/32 at 640px and below), `text-wrap: balance`.
  - Right, columns 9 to 12, aligned to the title’s last baseline: the page’s actions (at most one primary), or on location pages the location switcher, “All locations” and “Location settings”.
  - On location pages the eyebrow is “{Location name}, {Town}, {ST}” and the title is the page’s own: Home “Week of {Mon d, yyyy}” (the Monday of the current week, on the device’s calendar), Analytics “Analytics”, Sales data “Sales data”, Upload “Upload”, Notes “Notes”, Town “Town”, TownwiseAI “TownwiseAI”, Location settings “Location settings”. “All locations” (a text link to `/dashboard`) shows only with more than one location; “Location settings” (a text link) only for org admins, and not on that page itself. On phones TownwiseAI’s header is compact (the eyebrow, and the title on one line, with no side links) and scrolls away with the conversation.
  - Below 1024px the two stack.
  - Gate pages use the same header with the lead paragraph (`sub`, `text2`) under the title, in columns 1 to 7, and an optional side column 9 to 12, as on the SignIn artboard.
- **Location switcher.** Shown only when the organization has more than one location. It is a labeled select (“Location”) styled like a FormField input, and changing it navigates to the same page of the other location.
- **No location tabs.** The location’s sections are in the top bar (15.3); Sales data is reached from Analytics and from Upload’s result, and Location settings from the page header.
- **Content.** Sections are separated by a 1px `border` rule with `space-8` between them. Panels have a `panel` fill, a 1px `border`, square corners, and `space-5` padding (`space-4` at 640px and below). Never put a `raised` fill inside a `raised` surface; outline the inner element with `line` instead. Reading width for forms and prose is columns 1 to 7; the side column 9 to 12 holds help text and summaries.

### 15.3 Navigation per role

| Who | Top bar nav | Page header links | Notes |
|---|---|---|---|
| Member | Home, Analytics, TownwiseAI, Notes, Town, Upload; then Settings | All locations (more than one location) | No Team. Upload and notes are allowed (D16). |
| Org admin | Home, Analytics, TownwiseAI, Notes, Town, Upload; then Team, Settings | All locations (more than one), Location settings | |
| Staff | Requests, Organizations, People, Audit log | none | Staff console frame (15.4). |
| Staff in view-as | the target’s items | the target’s links | Client app frame under the banner; no console items. |
| Signed in, no organization | none | none | Gate frame. |

The sections are Home (`/locations/[id]`), Analytics (`/locations/[id]/analytics`), TownwiseAI (`/locations/[id]/agent`), Notes, Town and Upload (`/locations/[id]/sales/upload`). They open the location in the path; on a page outside a location (Locations, Team, Settings), the last location opened in this sign-in, held in memory only and never in storage, else the organization’s first. With no location the bar has only Team and Settings. `aria-current="page"` marks the section of the current page; Analytics is also marked (`aria-current="true"`) on Sales data, which lives under it, and on Location settings no section is marked. The wordmark goes to `/dashboard` (Locations), which redirects to the only location’s Home when there is one. Settings is the account page, `/settings`. Two-step sign-in (`/settings/security`, **Exists**) is reached from Settings.

### 15.4 How the staff console differs

- **Unmistakable chrome.** The console top bar has a `panel` fill (the client app’s is `ground`). After the wordmark comes a kind tag, “Staff console” (`tw-tag` with no square: the StatusTag kind form, so no new status is invented).
- **Right side of the top bar:** “Verified until {time}” in `mono`, `text3`, then the staff email in `mono`, `text3`, then “Sign out”. The time is `staff.verifiedUntil`, a real time, not a live counter, and the page does not tick.
- **No organization name and no location tabs.** Console pages are full-width tables: NumbersTable styling (`mono` 12/16, tabular figures, 1px `border` rules, heads in `text3`, values in `text2`, row hover `raised`, rows at least 44px), each inside a focusable, named scroll region.
- **Requests** shows its count in the nav as “Requests {n}”, with `{n}` in `mono`. The count is a number, not a dot or badge, and it is never animated.
- **Detail panels.** A selected row opens its detail in a panel: on the right from 1200px (columns 8 to 12), below the table under 1200px. The selected row takes the selected-row idiom (raised, border outline, 6px mint square, mint name).
- **No client figures.** Location rows show counts and date ranges only, with the line “Sales figures and notes are visible only through View as.” (D7).
- **Web only by layout.** The console is designed for 1024px and up and stays usable at 641px. At 640px and below, tables become stacked rows. Native builds do not include console routes. [CONFIRM: console on web only]

### 15.5 The view-as banner

```
+--------------------------------------------------------------------------------------+
| VIEWING AS   {email}, {Admin|Member} at {org}.   Read-only until {time}.  [End view-as]|
+--------------------------------------------------------------------------------------+
```

- **Position.** First in the page, above the top bar, full bleed, `position: sticky; top: 0`, above every other layer. At least 52px tall (`toolbar-height`). It is the second focusable element, after the skip link.
- **Look.** A `raised` fill with a 1px `line` rule below. `line` is a mark colour, so the edge reads as a boundary, not decoration. Inside the content grid:
  - “Viewing as” as `tw-eyebrow` in `text3`;
  - “{email}, {Admin or Member} at {org}.” in `ui`, `white`;
  - “Read-only until {time}.” in `mono`, `text2`;
  - right: an outline button (`tw-ob`), “End view-as”.
  
  For a target with no organization, the middle reads “{email}, signed in, no organization.”
- **Never colour alone.** No mint (mint is data and selection), and no `warning` or `error` (proposed, not adopted). The words carry the meaning.
- **Not dismissible.** It is `role="region"` with `aria-label="View-as"`. The document title is prefixed “Viewing as {email} · ”.
- **Phone (640px and below).** Two rows: the text, then “End view-as” at full width.
- **Read-only controls.** Every write control stays in place, so the layout matches the client’s, but renders disabled (15.7). Each form or section with writes shows one helper line: “Read-only while viewing as {email}.” Sign out in the client top bar is disabled too; End view-as is the way out.
- **On expiry**, or when the target’s organization changes (Section 8), the next `GET /api/me` returns staff access without `viewAs`. The client goes to `/admin` and shows the notice “View-as ended at {time}.”

### 15.6 Visual language

- **Dark, one theme.** The page is `ground` (#080a0d). Surfaces step to `panel` (#101317) and then `raised` (#181c21). Depth comes only from the fill step and 1px `border` (#34383e) rules: no shadows, gradients or blur.
- **Swiss.** A visible grid, flush-left sans, objective labels, asymmetric headers. Square corners everywhere (`radius-none`); the app frame’s 8px edge belongs to the homepage console, not to app pages. Round shapes only for data marks.
- **Type.** Instrument Sans: display 600, UI 500, reading 400. Geist Mono for every numeral, with `tabular-nums`, for labels (`label`, uppercase, through `tw-eyebrow` and `tw-tag`) and for table cells. Sentence case. Fonts are self-hosted in the app (**Exists** on `feature/townwise-web`); mockups may link Google Fonts as the design system previews do.
- **Colour roles.**
  - `white` (#eff2f6): primary text.
  - `text2` (#b5bbc2): secondary text.
  - `text3` (#9a9fa6): mono labels and fine print.
  - `line` (#7b8187): outlines and controls.
  - **Mint (#7bd2b4) is for data and selection only**: chart series, the selected tab or row (6px square and label), pressed controls, the focus ring and the skip link. It never fills a button, never colours a message, and never marks a warning.
  - Labels on a mint fill are `ground` (`on-mint`), never `white`.
- **The primary button is white** (`cta`): `white` fill, `ground` label, `text2` fill on hover. It is square, at least 44px tall, with a 15px `button` label and 18px side padding. **One primary per page**, for its main action; everything else is an outline button (`tw-ob`) or a text link (`tw-tl`). [CONFIRM: extends the Button rules to app screens, where labels vary by page]
- **StatusTag only for build status and kinds.** In progress (6px mint square) and Planned (6px outlined square) describe Townwise features, as on the homepage; College town, Seasonal town and Event town describe towns. A client’s own data state (“Not calibrated yet”, “Active”, “Invited”) is plain words, never a tag.
- **Charts** follow the design system: every chart has a text summary and “Show the numbers”, prints its scale and year, and keeps its SVG `aria-hidden`. Client sales series are `mint`, solid, 2px (`stroke-series`), with “Scale fitted to this location.” Town charts keep the Northeast dashed and the county solid.
- **Motion.** State changes only, 150 to 200ms with `--ease-out`. No spinners, shimmer, pulsing or counters. One reduced-motion switch zeroes everything. The one exception is the two statement moments of 15.8, whose words fade in over 200ms each, 80ms apart, and which end within 5 seconds; reduced motion shows them whole and still.
- **Voice.** Second person to the operator, first person plural for the team, short declarative sentences, no exclamation marks. Say what exists, and only that. U+2019 apostrophes and curly quotes in every visible string, no em dashes, ranges as “80 to 115”, a true minus (U+2212) for negatives.

### 15.7 Shared patterns

- **Forms (FormField).** The label is `ui`, `white`. The input has a `ground` fill, a 1px `line` border, square corners, at least 44px height, and 16px typed text. The helper is `small`, `text2`, tied by `aria-describedby`. Focus is a 2px `mint` outline offset 2px, plus a `mint` border. Selects, number inputs, date inputs and textareas use the same anatomy. Field messages print in white in the numbered, ruled list (`tw-msgs`), with `aria-invalid` on the field. [CONFIRM: error and notice colours stay unadopted, as the design system proposes]
- **Page notices** (“Saved.”, “You joined {org}.”, “View-as ended at {time}.”) use the same ruled message style in `white` with `role="status"`, at the top of the content. No colour, no toast, no auto-dismiss.
- **Disabled controls** are not defined in the design system. Here they get `aria-disabled="true"` (not the `disabled` attribute), so they stay focusable and screen readers reach them and their helper line. They use a `text3` label with a 1px `border` outline and do nothing when pressed. A disabled primary has a `raised` fill, a `text3` label (6.43:1) and a 1px `border` outline, with no hover change. [CONFIRM: disabled style]
- **Destructive actions** have no red. Each is an outline button that opens a confirm dialog. Deleting data asks the person to type the location name, and the dialog’s action stays disabled until it matches.
- **Dialogs** have a `panel` fill, a 1px `border`, square corners, at most 560px width, and `space-6` padding. The title is `tw-h3`, the body is `small` and `text2`. Actions sit flush left: the dialog’s one primary, then “Cancel” as a text link. The backdrop is `ground` at 80% opacity. Focus is trapped while open and returns to the opener on close; Escape closes. [Build note: while a dialog’s action is pending, Cancel and Escape wait for its answer.]
- **Tables** use NumbersTable styling in a focusable, named region. At 640px and below, rows become stacked label and value pairs.
- **Loading** is a text line in place of the content (“Loading your locations”), in `small`, `text2`, inside a box that keeps the content’s height, so nothing shifts. There are no skeletons that suggest numbers.
- **Errors** reuse the SignIn artboard’s strings word for word: “Can’t reach Townwise. Check your connection and try again.”, “Townwise isn’t responding. Try again in a minute.”, “Something went wrong on our side. Try again in a minute.”, “Something went wrong with that request. Reload the page and try again.”, “Too many attempts. Try again in {minutes} minutes.” Each comes with an outline “Try again”.
- **Empty states** say what is missing and what to do next, in one or two sentences, with the action as the page’s primary or a text link.
- **Numbers and dates.** Every numeral is `mono`, tabular. Guests print as whole numbers with thousands commas (“{n} guests”). Money prints in whole dollars with a `$` and thousands commas, rounded half up [CONFIRM: whole dollars in v1]. Dates always print their year (“Mar 2, 2026”), and times as “3:42 PM” in the viewer’s time zone. Day counts print as “{n} days”. No sample values ever appear in mockups: use `{slots}` (Placeholder data slot) for every number that comes from data.
- **Hit targets** are at least 44px. Every control shows the focus ring.
- **Phone (640px and below).** One column, 16px side margins, the top bar and banner as above, tables stacked, dialogs full width with 16px margins. There is no horizontal page scroll.

### 15.8 Statement moments

Two full-screen statements reveal word by word, hold, then dissolve into the page underneath. [Build note: `MomentProvider` (`client/src/portal/moments/`) is mounted in `PortalGate` and decides both moments from each access answer with `momentFor` (`moments.ts`).]

| Moment | When | Lead (`white`) | Follow (`text2`) |
|---|---|---|---|
| Request received | right after a request is sent: the access goes from `no_org`, `rejected` or `removed` to `pending` in this session | We’ve received your request for {orgName}. | We’ll let you in soon. |
| Welcome | the first visit after approval, while `GET /api/me` carries `welcome` | Welcome to Townwise, {firstName}. (Welcome to Townwise. when `firstName` is null) | {restaurant}, ready to set up. |

- **Who gets the welcome.** Only the person whose approved request created the organization, while the organization has no sales day, never under view-as. Invited teammates and admins of organizations staff created have the Joining notice instead. `firstName` is the first word of the request’s contact name, or null for an honorific (`Mr`, `Mrs`, `Ms`, `Mx`, `Dr`, `Prof`), an initial or a word over 40 characters. The client calls `POST /api/me/welcome` once when the moment starts, so it plays once across devices. [CONFIRM: welcome for the requester only]
- **Copy.** No doubled full stop when a name already ends a sentence. The follow line of the request moment repeats the held page’s own sentence, so it stays true whether or not the approval email has shipped.
- **Layout.** A `ground` layer over the portal frame, the top bar included, with no shadow, gradient or blur. The wordmark sits exactly where the top bar draws it. The statement is flush left in the content column, at most 760px wide, vertically centered, both lines at the h2 scale for the breakpoint, 12px apart. Every word is laid out at full size from the first frame and only its opacity changes, so nothing shifts. No horizontal scroll at any width.
- **Timing.** The first word starts at 120ms. Each word fades in over 200ms (`--ease-out`), 80ms after the one before, closer together when a line would take longer than 640ms. A clause or a sentence inside a line holds 140ms more (at most twice a line). The follow starts 360ms after the lead lands, holds 1.4s once it lands, and the layer fades out over 200ms. Request received for a two-word name is gone at about 3.3s, and every moment ends within 5 seconds.
- **Reduced motion.** Both lines whole at once, still for 2.4s, then gone at once.
- **Any input ends it.** A press, touch or wheel is absorbed (it never reaches the page under the opaque layer) and fades the layer out; once that press is over, presses reach the page. On web a press is over when its click has landed on the layer, or 350ms after it lifts if no click comes, because a touch's click is aimed when the finger lifts; under reduced motion the layer goes at that point too. A key removes it at once and still does its job on the page (Tab moves focus). Repeats and lone modifier keys are ignored, and so is any input in the first 300ms, so the press that sent a request can’t end its moment. Android back dismisses it and is consumed. A moment that would start in a hidden tab keeps its ground up and waits until the tab is visible.
- **Screen readers.** The visual words are hidden from assistive tech, and the statement is said once, as plain text: on web through a polite live region that exists before any moment (`aria-live="polite"` without `role="status"`, so it never competes with a page's own status notice), on native through an announcement. On native with a screen reader running there are no visuals at all. The layer never takes focus.
- **One player.** `MomentProvider` in `PortalGate` plays one moment at a time; a page may call `useMoment().play(statement)` for its own statements and hold its own entrance while `useMoment().playing`.
- **When it decides.** On every new access answer (`GET /api/me`, or an answer applied in its place), in the same render, so the layer and `playing` are up before the page paints. Request received needs this session's previous answer in `no_org`, `rejected` or `removed` and the new one `pending`: a fresh load or Check again on Waiting plays nothing, and neither does a decline that returns an invited person to Waiting. Each moment is keyed (the request's id; the person and the organization for the welcome) and plays once in a session, so a later re-read that still carries `welcome` (its `POST` failed) does not replay it. Under view-as, or on the first answer after it, nothing plays and nothing is posted. Nothing is stored on the device.

---

## 16. Pages

### 16.1 Page list

| # | Route | Page | Who | Frame |
|---|---|---|---|---|
| P1 | `/sign-in` | Sign in (**Exists**; copy change) | everyone | Public |
| P2 | `/totp` | Two-step code (**Exists**) | anyone with TOTP | Public |
| P3 | `/request-access` | Request access | `no_org`; `rejected`, `removed` by choice | Gate |
| P4 | `/waiting` | Waiting for approval | `pending` | Gate |
| P5 | `/no-access` | No access (rejected, removed, left, paused) | `rejected`, `removed`, `org_suspended` | Gate |
| P6 | `/joining` | Joining your team, choosing one, or saying it isn’t yours | `invited` | Gate |
| P7 | `/settings/security` | Two-step sign-in (**Exists**), with the staff setup notice | everyone; staff in setup | Gate for staff in setup, Client app otherwise |
| P8 | `/staff/sign-in-again` | Staff sign in again | `staff_reauth_required` | Gate |
| P9 | `/dashboard` | Locations, home and first-run | members | Client app |
| P10 | `/locations/new` | Add location | org admins | Client app |
| P11 | `/locations/[id]` | Home: this week on the calendar and in past years, bar order (Planned), last week, this month in town, your history | members | Client app |
| P12 | `/locations/[id]/sales` | Sales data | members | Client app |
| P13 | `/locations/[id]/sales/upload` | Upload sales history (web) | members | Client app |
| P14 | `/locations/[id]/notes` | Notes, the tuning step | members | Client app |
| P15 | `/locations/[id]/town` | Town profile | members | Client app |
| P16 | `/locations/[id]/settings` | Location settings | org admins | Client app |
| P17 | `/team` | Team: add teammates’ emails, roles, removal | org admins | Client app |
| P18 | `/settings` | Settings: account, organization name, staff activity, leave | members | Client app |
| P19 | `/admin` | Requests: approvals | staff | Staff console |
| P20 | `/admin/orgs` | Organizations | staff | Staff console |
| P21 | `/admin/orgs/[orgId]` | Organization detail: team, locations, suspend, view as, delete | staff | Staff console |
| P22 | `/admin/people` | People: everyone across organizations, sign out everywhere, delete | staff | Staff console |
| P23 | `/admin/audit` | Audit log | staff | Staff console |
| P24 | `/locations/[id]/analytics` | Analytics: your days, your town’s calendar and your notes | members | Client app |
| P25 | `/locations/[id]/agent` | TownwiseAI, the tuning chat (`/locations/[id]/chat` redirects here) | members | Client app |

Components that are not routes: C1 View-as dialog, C2 View-as banner (15.5), C3 Approve dialog, C4 Reject dialog, C5 New organization dialog, C6 Note form, C7 Confirm dialogs (deletion dialogs ask for the typed name or email, 15.7).

No sign-up page exists or is added. New people continue with Google, then request access.

Every page below lists its content top to bottom, its one primary action, and its states. “View-as” says what changes under the banner; pages a target can see behave as for the target, with writes disabled.

### 16.2 Public and gate pages

**P1. Sign in (`/sign-in`).** This page **Exists** on `feature/townwise-web`, with “Continue with Google”. Copy change only: the sub becomes “Use your Google account. Townwise has no passwords.”, and the line under the button becomes “New to Townwise? Continue with Google, then tell us about your restaurant. Joining your team? Use the email address your admin added.” [CONFIRM: replaces “Your first sign-in creates your account.”] Signing in shows “Signing you in…”. Errors are the SignIn artboard’s message list (**Exists**). On success the client calls `GET /api/me` and routes per 4.3.

**P2. Two-step code (`/totp`).** **Exists**, unchanged.

**P3. Request access (`/request-access`)**

- Eyebrow “Early access”. Title “Request access”. Lead: “Townwise is in early access. Tell us about your restaurant or group, and someone on our team will review it by hand.”
- A panel above the form reads: “Joining a team that already uses Townwise? You don’t need to request access. Ask an admin on that team to add {email}, then reload this page.”
- Fields:
  - Organization name, with the helper “Your restaurant or group, as you’d like it to appear in Townwise.”
  - Your name.
  - Your role, with the helper “For example, owner or general manager.”
  - Town: a select grouped “College towns” (six) and “Seasonal and event towns” (six), then “Another town”, which reveals Town name and State.
  - Number of locations (1 to 50).
  - “Anything we should know? (optional)”, with the helper “Don’t include guest names or sales figures.”
- While the Google Places search is on, Step 1 “Find your restaurant” comes before these fields, and a confirmed place takes Town’s place (10.2a).
- Primary: “Send request”.
- Side column, “What happens next”, numbered 01 to 03: “Someone on our team reviews your request.”, “We don’t send email yet. Check back here.”, “Once you’re approved, you’ll upload your sales history and see your town.”
- Footer line: “Signed in as {email}. Using the wrong Google account? Sign out and continue with another one.”
- Variants: for `removed`, the lead adds “Setting up a different organization? Tell us about it below.” For `rejected`, the previous answers are prefilled.

| State | Shows |
|---|---|
| Loading | Never blank: the form renders at once (the town list is bundled); only Send shows “Sending…” and is disabled while it sends |
| Empty | The empty form |
| Error | Field messages: “Enter your organization’s name.”, “Enter your name.”, “Enter a whole number from 1 to 50.”, “Pick a town, or choose Another town.”, “Enter a two-letter state, for example NH.” 409 `request_exists` re-reads `/api/me`. 429 and network errors use the shared copy. |
| Success | Route to `/waiting` |
| View-as | Form disabled |

**P4. Waiting for approval (`/waiting`)**

- Eyebrow “Request sent {date}”. Title “Your request is in”. Lead: “Someone on the Townwise team reviews every new organization by hand. We don’t send email yet, so check back here.” [DECISION NEEDED: whether to state a review time]
- “What you sent”, a two-column definition list: Organization, Your name, Your role, Town, Locations, Note.
- “While you wait: {town}, {state}”: the town profile (Section 13; on native, the text summary and numbers table, D21), or the gap copy for another town.
- Hint: “Expecting to join a teammate’s organization instead? Ask their admin to add {email}. The next time you open Townwise, you can join it with one press.”
- Actions: “Check again” (outline; re-reads `/api/me`) and “Sign out” (text link). The page has no primary.

| State | Shows |
|---|---|
| Loading | “Checking your access” |
| Empty | Not applicable: the page exists only with a pending request |
| Error | Network copy with Try again; the town profile still renders from bundled data |
| Success | As above. “Check again” routes to any new state; if nothing changed, the notice reads “Still waiting. Your organization will appear here once it’s approved.” |

**P5. No access (`/no-access`).** Every variant ends with “Signed in as {email}. Using the wrong Google account? Sign out and continue with another one.” The page has no primary; actions are outline buttons or text links.

| Variant | Title | Body | Action |
|---|---|---|---|
| Rejected | “We can’t give you access yet” | “We reviewed your request for {orgName} on {date} and didn’t approve it.” If a message was given: “Message from the Townwise team: “{message}”” Then: “If something has changed, you can send a new request.” | “Send a new request” (outline, to `/request-access`) |
| Removed | “You no longer have access to {org}” | “{email} isn’t on {org}’s team anymore. If that’s a mistake, ask an admin there to add you again.” | “Request access for a different organization” (text link) |
| Left (`byYou`) | “You left {org}” | “If you left by mistake, ask an admin there to add {email} again.” | “Request access for a different organization” (text link) |
| Paused | “Access to {org} is paused” | “The Townwise team has paused access for {org}. Your organization’s data is kept. Questions: hello@townwise.tech.” [CONFIRM: the mailbox exists] | none |

States: Loading shows “Checking your access”; Error shows the network copy with Try again; there is no empty state.

**P6. Joining (`/joining`)**

{inviter} below is the inviting org admin’s email, “Townwise staff”, or {org} when that account no longer exists (`invitedBy`, 4.1).

- **One invitation, no pending request** (lead default): the title “Joining {org}…” and the line “{inviter} added {email}.” show while `POST /api/me/join` runs. On success it goes to `/dashboard` with the one-time notice (F1).
- **One invitation, with a pending request** (F2b): title “Join {org}?”. Lead: “{inviter} added {email} to {org}. Your request for {pendingRequest.orgName} is still with our team. If you join {org}, we withdraw that request.” Primary: “Join {org}”. Text link: “Not my team”, which deletes the invitation and returns to Waiting.
- **Two or more:** title “Choose your team”. Lead: “{count} organizations added {email}. You can belong to one. Choose the team you work with.” With a pending request, the lead adds: “Joining one withdraws your request for {pendingRequest.orgName}.” Each row shows the organization name, “as Admin” or “as Member” in `mono`, “Added by {inviter}” in `small`, `text2`, an outline “Join”, and the text link “Not my team”. The page has no primary.
- After “Not my team”, the client re-reads `/api/me`. With invitations left, the page shows the rest with the notice “Removed the invitation from {org}.”; otherwise it routes per 4.3 (Waiting with a pending request, Request access with none).
- Errors: 409 `no_invite` or `already_in_org` re-reads `/api/me` and routes. Network errors show the shared copy with Try again.
- View-as: Join and Not my team are disabled. A staff member viewing an invited person sees this page without the automatic join.

**P7. Two-step sign-in (`/settings/security`).** **Exists.** For staff in `staff_setup_required`, a notice sits above the existing screen: “Townwise staff accounts need two-step sign-in. Set up your authenticator app, then sign in again with a code.” After the recovery codes, the page shows the primary “Sign in again”, which signs out and opens `/sign-in`. Enrolling needs a sign-in within the last 15 minutes; the shell already handles the kit’s `reauth_required` (**Exists**).

**P8. Staff sign in again (`/staff/sign-in-again`).** Title “Sign in again to use the staff console”. The body depends on the reason:

- `session_before_codes`: “This session started before two-step sign-in was on.”
- `session_too_old`: “Staff sessions need a fresh sign-in with your code every 60 minutes.”

Primary: “Sign in again” (kit `POST /auth/logout`, then `/sign-in`).

### 16.3 Client app pages

**P9. Locations (`/dashboard`)**

- With one location, it redirects to that location’s Home (P11) and keeps any one-time notice.
- With several: eyebrow is the organization name, title “Locations”. Org admins get an outline “Add location” on the right. One row per location: name (link), town, “{n} days of sales” (`mono`), the calibration heading in words, and “{n} notes”. Rows are at least 44px, with a `raised` hover.
- For org admins, while the request’s location count is higher than the locations created: “Your request mentioned {n} locations. Add the others when you’re ready.”

| State | Shows |
|---|---|
| Loading | “Loading your locations” |
| Empty, org admin | Title “Add your first location”. Lead: “Pick its town. For the twelve towns Townwise profiles, you’ll see public data on what moves demand there.” The P10 form inline; primary “Add location”. |
| Empty, member | “Your admin hasn’t added a location yet.” |
| Error | Network copy with Try again |
| Success | The list, or the redirect. After a join, the notice “You joined {org}. {inviter} added {email}. Not your team? Leave {org}.” (F1) |

**P10. Add location (`/locations/new`, org admins).** Fields: Name, and Town (as P3); while the Google Places search is on, the form starts with it (10.3). Primary: “Add location”. Errors: “Another location already uses that name.” and “You’ve reached 25 locations. Write to hello@townwise.tech for more.” On success it opens the new location’s Home (P11).

**P11. Home (`/locations/[id]`, the location’s first page)**

Home replaced the Forecast page here (owner decision, 2026-11-05); its data checks live in P24’s Your data. It is built around the Monday decisions: what is on this week, the bar order, last week against what happened, and this month in town. Until forecasts exist it shows only history and the calendar, never a guess: every figure is a sum, an average or a share of the location’s own stored days, always of a past day, apart from Who’s in town’s headcount range, which is printed only where public counts with stored sources support it (13.2; none is researched today). No figure from the location’s days is shown for a day after the last day of data or after today. It reads `GET .../sales/history`, `GET .../notes` and `GET .../calendar` (10.4, 10.10) in parallel, from two years and four weeks before this week’s Monday to the later of this month’s last day and this week’s Sunday, then on their own `GET .../agent` (the questions count) and `GET .../people-in-town` for this month (10.13), and writes nothing. “Today” is the device’s date and weeks run Monday to Sunday (all twelve towns are Eastern). Built from `client/src/portal/home/` and `client/src/portal/analytics/week.ts`.

- Page header (15.2): the title is “Week of {Monday}”.
- Lead: “From your sales through {Wed, Nov 4, 2026} and {Hanover}’s researched calendar.” (“US federal holidays” for a town with no researched calendar; “No sales history yet. Home shows …” with no days). Then an In progress line, “Forecasts are in development. Until then, Home shows your history and the calendar, never a guess.”, and, when TownwiseAI has questions, a text link to P25, “{2} questions from TownwiseAI” (“1 question”), counting the questions `GET .../agent` asks that the client knows (P25’s side panel’s read, made on its own after Home’s three). While that read loads, when it fails and when there are none, the line is left out: P25 says “No questions right now” or the error. Side: outline “Ask TownwiseAI” (P25).
- **This week in {Town}**, “What’s on the calendar, and how this week went before”. When last year’s same week has at least 5 days with data: its total, “Same week last year, {Mon, Nov 3} to {Sun, Nov 9, 2025}. From all 7 days.” (or “From {n} of its 7 days.”), “{+9%} against that year’s usual for those days, compared over {n} days.” (when at least 5 have a usual), the busiest day and the quietest open day. Always: “On the calendar this week: {title} ({weekday}), and {n} more.” or “Nothing on {Town}’s researched calendar this week.”, over holidays and town events only. Term and season periods span weeks, so they mark no day: each one covering the week is said once under that line with its whole span and sources (“Fall term classes. Term, Sep 14 to Nov 17, 2026.”), and with no holiday or event the line reads “No holiday or town event on {Town}’s researched calendar this week.” Then a row per day, Monday to Sunday (today in the selected-row idiom): Day (with this week’s own figure only for a past day with data), On the calendar (each event with its kind and “Source: {label}” links, each note in words with its detail, or “Nothing listed”), Last year and Two years ago (the same weekday 52 and 104 weeks earlier: “{Sat, Nov 8, 2025}: {241} guests”, “{+31%} vs usual”, closed, and the holidays and town events on that day; “No data”; the second column only when any of its days has data). The footnote defines both terms: “Last year means the same weekday 52 weeks earlier. Usual is your average for that weekday in the 4 weeks either side, leaving out closed days, days with a note, and holiday and event days.” [CONFIRM: the baseline for usual] The coverage line, always: “{Town}’s researched calendar covers {from} to {to} so far, plus US federal holidays.”, or the not-researched lines of P24’s Day panel. “Show the numbers”: Day, Last year, Two years ago, Usual (last year). With no days at all, only Day and On the calendar show.
- **Bar order** (panel), StatusTag Planned, “Order suggestions are planned”: “Townwise will suggest how much more or less beer, wine and spirits to order each week, and by when. It needs a forecast and your usual weekly order first. Townwise can’t see your stock.” No inputs. One line of history when last year’s same week has data for Thursday to Sunday: “Last year this week, Thursday to Sunday brought {58%} of the week’s guests.” (with the day count when the week is partial). [DECISION NEEDED: where the usual order comes from]
- **Last week, {Oct 26} to {Nov 1}** (panel), “Against the same week last year”: on web, seven pairs of bars (last week solid `mint`, last year outlined `line`, aria-hidden) with the key and the printed scale; on native the text and the table only (D21). “Last week: {1,020} guests, {4%} more than the same week last year ({980}), compared over 7 days.”, or “on the {n} days both weeks have” when partial: the totals and the change are over the days with data in both weeks. States: “Your history ends {date}. Upload the days since to compare last week.” with the upload link (web), when the history ends before last week; “No {guests} stored for last week, so there is nothing to compare yet.” with the same link, when it reaches past a gap; “No data for the same week last year, so there is nothing to compare yet.”; no days in common; no history. “Show the numbers”: Day, Last week, Last year, Change. When forecasts arrive (14.3) this card compares forecast with what happened; until then it never shows a prediction.
- **This month in {Town}**, eyebrow “{November 2026}”: the month as a grid (aria-hidden, with a key: a white corner for a town event or holiday, a `text2` corner for a note, this week outlined); every event and note on the month in date order with its sources (“Veterans Day. Federal holiday.”, “Your note: Private event, more guests than usual.”); for one of the twelve towns, “Food-service jobs in {Grafton County}, {November} 2024: {97.4} (2024 average = 100).” with “County, not town. Employment is a stand-in for demand.” and the BLS source; “Your {November} in past years” with one line per past year, newest first, at most three (“{118} guests a day over {30} days in 2025, {9%} below your 2025 daily average over {364} days.”, closed days left out; the year’s day count shows how much of that year the history covers); and **Who’s in town**: the month’s people in town (13.2, `GET .../people-in-town` for the month, read on its own; `client/src/portal/estimates/PeopleInTownSummary.tsx`): the term periods in words (“Fall term classes until Tue, Nov 17.”), a headcount range per run of days only where every input has a source (“About {9,500} to {10,500} people in town, from {2} sources.”), otherwise “Townwise can’t put a number on how many people are in {town} yet.” with a Planned tag, “A headcount from public counts is planned.”; “Your Saturdays averaged …” when the location has days both in term and between terms; and the provenance lines naming each source host as a link. A town Townwise hasn’t researched says so. A failed read shows its error and Try again in that place only.
- **Your history** (panel, root `nativeID` “home-history” for the Reading screen’s animation): “{n} days”, “{first} to {last}. {n} missing days in between. Last upload {date} by {email}.”, the newest year as a heatmap that takes no focus (web; `role="img"` named by its summary), and links “See it in Analytics” and “Upload sales history” (web; native says where to upload).
- **While onboarding’s `needsHistory(org, locations)` is true** (agreement 1 with session 54: the organization has locations and none has a stored day) and this location’s own history has no day: step 3, below, takes the place of Bar order, Last week and Your history; This week (calendar only) and This month still show.
- **Step 3, Your history** (`client/src/portal/onboarding/`, `HistoryStep`; the Home2-Drop and Home2-Reading boards; 11A, 10.11). Mono “Step 3 of 3: Your history”, then “Drop in everything you have” and “Drop your exports as they are, as many as you have. Townwise reads the date, guest count and net sales for each day from them on its server.” Two columns from 1024px: the drop on the left; on the right the location card (“Your restaurant”, the name, the town and its kind) and “What Townwise keeps” (the files, stored privately with no public internet address, each original deleted after 365 days or sooner when deleted; from each file the three values a day and a cleaned copy; download or delete them on Sales data). On the first view of a fresh step the card moves from the left into the rail once (280ms) while the drop fades in; with reduced motion, on narrower screens and on native it is simply in place. Nothing is kept in browser storage.
  - **Drop** (web): a dashed zone, “Drop files here”, “Many files at once is fine, by dragging them here or choosing them.”, the accept hint (11A’s cap from the create answer, never a constant) and “Choose files” (`multiple`, any type). Files dragged anywhere on the step drop there (“Drop to add {n} files”); one dropped elsewhere on the page is ignored, so the browser never opens it over the app and stops the uploads. Each file is its own row through the upload queue (storage2 15.2): name, size, a progress bar, “{speed} · About {t} left” or “Estimating”, “Waiting to upload”, “Reconnecting…”, the refusal’s words, and Cancel or Remove; above the rows “{n} files, {size} · About {t} left to upload”. Files from an earlier visit still uploading show “Upload interrupted. Drop it again.” with Remove. Primary “Read my history”, disabled with “Add at least one file.” until a file is stored. Then “What to drop in”: daily sales summaries; sales reports as Excel, CSV or PDF (a PDF needs a table, scans can’t be read); ZIPs of exports; check-level exports (item-level don’t work); as many years as you have; closures and events go on the Notes page (notes inside files aren’t read).
  - **The browser path** (11.1) is always linked under the drop as “Prefer to send only daily totals? Read the file in your browser instead.”, and after a refusal or a failed status read as “Or read a CSV file in your browser and send only the date, guest count and net sales for each day.” While stored files are off (503 `files_unavailable`, from the status read or a create) the drop is replaced by “Read a file in your browser” and P13’s “Upload sales history”.
  - **Reading** (“Reading your history”, “You can close this page. Townwise keeps reading on its server, and Home shows your history when it’s done.”): “{done} of {n} files read · {About {t} left to read, Estimating, Waiting for a turn or Waiting for your answer}”; each file’s line (11A.6) with its own time left to read or “Estimating”, a bar when the server knows the total, a ZIP’s count and “See what’s inside” (its files inside, each with its status and reason, as on Sales data); the question (ImportQuestion) when the reader needs an answer; every file kept and not used with its reason; “Found so far” from the import’s counts; and the calendar of days read so far (the analytics heatmap, one picture named by its summary, unread days of the drawn years up to yesterday as “Not read yet”), re-read when the import applies more days. New drops join the started import. Native shows the same in words, with no calendar and no drop (“Drop your files from a computer at townwise.tech.”).
  - **Done**: “Done. {n} days, {first} to {last}.” and “Opening Home.”; after 2.5 seconds, or on “Go to Home now”, Home and the organization load again and the step leaves; on web Home’s history card grows from where the calendar was (280ms; reduced motion: it just appears), and focus moves to it when the step held focus. While this screen still has uploads running it waits (“Some files are still uploading. Going to Home now stops them.”). An import that found no day says “Done. Townwise found no days it could use in these files.”, keeps every file’s reason listed and the drop zone open.
  - **View-as**: no drop and no upload (no file input, the queue never created), “Choose files”, “Read my history” and the browser path’s link disabled with the read-only line, file names shown as their kind; the status reads run as any GET does.
  - A screen reader hears one status line when the step changes (reading, a question, done), never a time left or a byte count.
- No primary button of Home’s own.

| State | Shows |
|---|---|
| Loading | “Loading {location}” |
| Empty | No days here: the calendar parts, and each card saying it has no history (“No sales history yet for this location.”, “No sales history yet, so there is nothing to compare.”); the HistoryStep while `needsHistory` |
| Error | Network copy with Try again. A location id that is not in the organization (deleted, or never theirs): “This location isn’t available.” and a link to Locations. |
| Success | As above |
| View-as | The same page; the upload links are disabled with the read-only line |

**P12. Sales data (`/locations/[id]/sales`)**

- Coverage line: “{n} days, {first} to {last}. {missing} days missing in between.” With missing days, it adds: “Missing days might be closures. Add a closure note.” as a text link that opens C6 prefilled (closure, closed).
- **Chart**: “Daily guests”, or “Daily net sales” when the location has no guest counts. It covers the last 365 days of data, ending at the last day, from `sales/days`. The line is `mint`, solid, 2px. The y scale is printed with “Scale fitted to this location.” and the x ticks are months with their year. Text summary: “Daily guests, {first} to {last}. Highest: {value} on {date}. Lowest day with data: {value} on {date}.” “Show the numbers” opens the daily table (Date, Guests, Net sales) in a focusable scroll region. On native (D21), the page shows the text summary and the table, plus “See the chart at townwise.tech.” [CONFIRM: daily chart on Sales data]
- **By month** (NumbersTable styling): Month, Days, Guests, Net sales. Selecting a month shows its days below the row.
- **Uploads**: Date, By, Days, New, Replaced, Unchanged (days a member’s upload left as they were), Range, and Status (“Finished”, or “This upload didn’t finish. Upload the file again.”).
- Primary: “Upload sales history” (web; on native, the line “Upload from a computer at townwise.tech.”).
- Org admins only, at the bottom: a section “Delete sales data” with an outline “Delete all sales data”. Its dialog reads: “This deletes {n} days of sales data for {location}. Notes stay. This can’t be undone. Type {location} to confirm.”

| State | Shows |
|---|---|
| Loading | “Loading sales data” |
| Empty | “No sales history yet for {location}. Upload a CSV export from your point-of-sale system. The upload sends Townwise only the date, guest count and net sales for each day.” with the primary |
| Error | Network copy with Try again; 404 as on P11 |
| Success | As above; after a delete, the notice “Deleted {n} days.” |
| View-as | Upload, delete and the closure-note link are disabled |

**P13. Upload sales history (`/locations/[id]/sales/upload`, web)**

- Header: eyebrow {location name}, title “Upload sales history”, and a step line in `mono`: “Step {n} of 4: Choose a file, Match columns, Check the totals, Send.” Back is a text link on steps 2 and 3.
- Step 1 copy: “Export a daily sales summary from your point-of-sale system as a CSV file. Your browser reads the file on this computer. Townwise receives only the date, guest count and net sales for each day; nothing else in the file leaves this computer.” The control is an outline button, “Choose a CSV file”.
- Steps 2 to 4 follow Section 11.2, including the member and org admin wording for days the location already has. The primary on each step: “Check the totals” (step 2), “Send {days} days” (step 3), and “See your sales data” on the result.

| State | Shows |
|---|---|
| Loading | “Reading {size} file…” while parsing; “Sending {days} days…” while sending |
| Empty | Step 1 |
| Error | “That file is larger than 50 MB.”, “That doesn’t look like a CSV file. Excel file? Save it as CSV first.”, “That file has no header row.”, “Choose a guests column, a net sales column, or both.”, “No rows had a readable date. Check the Date column.”, the item-level refusal, “This file covers more than 10 years. Upload up to 10 years at a time.” A server 400 shows “Something went wrong with that request. Reload the page and try again.” A 500 or 503 shows “The upload didn’t finish, and some days may have saved. Send again. Days are never duplicated.” A 429 or network error uses the shared copy; the parsed days stay in memory so Send can be retried. |
| Success | The result line (11.2, step 4) |
| Native | Not offered; the Forecast and Sales data tabs say “Upload from a computer at townwise.tech.” |
| View-as | “Choose a CSV file” is disabled, so no client file is ever read into a staff browser |

**P14. Notes (`/locations/[id]/notes`)**

- Intro: “Notes record what your sales can’t show: a closure, a private event, an opening. Add past ones to explain unusual days, and upcoming ones for the dates ahead. Townwise keeps them with this location. Nothing reads them yet.”
- A line with a StatusTag, Planned: “Talking to your model is planned.”
- Primary: “Add a note”, which opens C6 inline above the lists.
- Two lists, “Coming up” (end date today or later) and “Past”. Each note is a row:
  - the kind (`ui`, `white`);
  - the dates (“{start} to {end}”, plus “{Mondays} only” when weekdays are set);
  - the effect in words (“Closed”, “More guests than usual”, “Fewer guests than usual”, “Not sure”);
  - “About {n} guests”, when given;
  - the details (`small`, `text2`);
  - “Added by {email}, {date}”;
  - Edit and Delete text links when `canEdit`.
- **C6, the note form.** Fields:
  - Kind: Closure, Private event, Opening, Other.
  - Starts.
  - Ends (optional; defaults to the start).
  - “Only on these days”: seven weekday buttons with `aria-pressed`; pressed takes the `mint` fill and the `on-mint` label, as pressed controls do in the design system.
  - Effect, defaulted by kind.
  - Expected guests (optional; hidden when the effect is Closed).
  - Details (optional; required for Other), with the helper “Describe the event, not the guests. Leave out names.”
  
  Its primary is “Save note”, then “Cancel” as a text link.
- Delete asks “Delete this note? This can’t be undone.”

| State | Shows |
|---|---|
| Loading | “Loading notes” |
| Empty | “No notes yet.” and the intro |
| Error | Field messages: “The end date is before the start date.”, “Pick a range of a year or less.”, “Add details for an Other note.”, “Enter a whole number from 1 to 20,000.” A save failure: “Couldn’t save the note. Try again.” 409 `note_limit`: “This location has 1,000 notes. Delete old ones to add more.” |
| Success | The lists. The saved note takes the selected-row idiom, and the notice reads “Saved.” |
| View-as | Add, Edit and Delete are disabled |

**P15. Town (`/locations/[id]/town`).** The town profile from Section 13, using the `TownProfile`, `DeltaChart`, `MonthScrubber` and `NumbersTable` web components this build extracts from `TownPanel.web.tsx`, styled as the design system builds them, followed by the notes row content (drivers and dates with sources, the Curve line, the caveats, the index definition and the sources). On native (D21): the text summary and the “Show the numbers” table, then the same notes row content, plus “See the chart at townwise.tech.” Loading shows “Loading map data”. Failure shows “The town data did not load. Try again.” The gaps follow Section 13.

**P16. Location settings (`/locations/[id]/settings`, org admins)**

- Fields: Name, and Town. Primary: “Save changes”.
- While the Google Places search is on, a section “Change this location’s place” (10.3).
- A section “Delete location”. When the location has no sales and no notes, it shows an outline “Delete location” with a typed-name confirmation. Otherwise it says “Delete this location’s sales data and notes first.”
- States: loading; the field error “Another location already uses that name.”; success notice “Saved.”; after a delete, `/dashboard` with “Deleted {name}.”

**P17. Team (`/team`, org admins)**

- Title “Team”. Lead: “Each person signs in with Continue with Google using the exact address you add here. Townwise accepts Gmail addresses and Google Workspace accounts. We don’t send invitations yet, so let them know yourself.”
- **Add people** panel: a textarea “Email addresses” (helper “One per line or separated by commas, up to 20.”), a Role select (Member by default, or Admin), and the primary “Add”.
- **Results** under the form, one line per address:
  - “Added. They can join the next time they continue with Google.”
  - “Already invited.”
  - “Already on your team.”
  - “That isn’t an email address.”
- **Members table**: Email, Role, Status (Active or Invited), and “Joined {date}” or “Invited {date}”.
  - Row actions: “Make admin” or “Make member”, and “Remove”. Invited rows get “Remove invitation”.
  - The signed-in admin’s row says “You”.
  - Rows with `addedByStaff` show “Added by Townwise staff” under the email (`small`, `text2`). The add is also listed under Townwise staff activity on Settings.
- Remove asks: “Remove {email}? They lose access on their next visit. Their notes and uploads stay.”

| State | Shows |
|---|---|
| Loading | “Loading your team” |
| Empty | “It’s just you so far. Add your teammates’ email addresses, and they can join the next time they continue with Google.” |
| Error | 409 `last_admin`: “Your organization needs at least one admin. Make someone else an admin first.” 409 `member_limit`: “Your organization has reached 200 people.” Network copy. |
| Success | As above |
| View-as | Visible only when the target is an org admin. Add, role changes and removal are disabled. |

**P18. Settings (`/settings`)**

- **Account**: Email, Organization, Role, as a definition list.
- **Two-step sign-in**: “Recommended for admins.” plus the link “Two-step sign-in settings” to `/settings/security` (**Exists**).
- **Organization name** (org admins): a field and the page’s primary, “Save name”.
- **Townwise staff activity** (org admins, from `GET /api/org/staff-activity`). Above the table: “Each time Townwise staff use View as to see your sales and notes, it’s recorded here with its reason. Without View as, staff can see your team’s email addresses, your location names and towns, and which dates your data covers. Any change staff make to your team, name or status is listed here too.” Table: When, Staff (“Townwise staff ({email})”), Action (the server’s summary, for example “Viewed as {email}” or “Added {email} as member”), Reason and Until (view-as rows only). A row with `notApplied` adds “Didn’t take effect.” [Build note: the field is `applied: false`, with `notAppliedReason`, the reason in plain words, to show beside it.] Empty: “Townwise staff haven’t viewed or changed your organization.” (D9)
- **Leave {org}**: an outline button. Confirm: “Leave {org}? You lose access right away. Your notes and uploads stay with {org}.” 409 `last_admin` uses the P17 copy.
- **Sign out**: “Sign out” and “Sign out on every device” (kit `POST /auth/logout-all`, **Exists**; the shell has no screen for it yet), both text links. [CONFIRM: add sign out on every device]
- States: loading, and network error with Try again.
- View-as: every write is disabled.

**P24. Analytics (`/locations/[id]/analytics`)**

Every figure is a count or an average of the location’s own stored days that the filters keep, from `GET .../sales/history`, `GET .../notes` and `GET .../calendar` (10.4, 10.10); the model card reads `GET .../estimates/about` (10.13). Nothing is estimated, nothing is shown for a day after today, and a figure with too few days behind it says so instead. The page writes nothing; its filters live in the page’s state only (never the URL or storage) and reset when it closes. Built from `client/src/portal/analytics/`.

- Lead: “{n} days, {first} to {last}.”
- **Filters**, one block that drives the page (labelled groups in a row on desktop, stacked on phones; a change never animates or moves focus):
  - Colour by: Guests (default when any day has guests) or Net sales, a radio group with one tab stop whose arrows move the choice. A metric with no data is disabled, with “No guest counts in your history.” or “No net sales in your history.”
  - Show on the calendar (checkboxes, all on): Town events, Holidays, Your notes, Closures. They change only the heatmap’s marks and labels.
  - Include in the numbers: Closed days (off), Days with a note (on; closures follow Closed days only), Holiday and event days (on). They change every average, chart, type of night and the heatmap’s levels; a value they leave out is drawn as “Left out”.
  - Years: one per year with data, all on. Unchecking the last is refused: the box stays checked and “Keep at least one year.” describes it.
  - The checkbox is a shared control (`ui/Checkbox`): a real `<input type="checkbox">` in its `<label>` on web, a Pressable with the checkbox role and state on native; checked takes the `mint` fill with an `on-mint` check; disabled keeps its focus with `aria-disabled`.
- **Every day.** The heatmap (web): one grid per checked year, newest first, 7 weekday rows (Monday first) by week columns of square cells; four `mint` levels from the quartiles of the kept values, “No data” `raised`, “Left out” `state`, closed outlined, a white corner square for a holiday or town event and a `text2` one for a note. A visible legend above; under it the summary (“{Daily guests}, {first} to {last}. Busiest: … Quietest open day: … {n} closed days.” and what the town calendar covers) and the basis line; “Show the numbers” is the month table (Month, Days with data, Total, Average; every value in the checked years, kept or left out). Each year is `role="grid"` named “{year}, daily {guests}”, with row headers; each cell’s label says everything its fill and marks show. One tab stop for the whole heatmap, starting at the selected day or the last day with data: arrows move a day (up and down) or a week (left and right), Home and End the week’s Monday and Sunday, PageUp and PageDown 52 weeks across years, Ctrl+Home and Ctrl+End the first and last day with data; Enter or Space selects, Escape clears, and while a day is selected the selection follows focus. Days after today are blank and never focusable. A mouse or pen over a cell previews it; leaving the grid restores the selection. Native (D21): a month list, newest first (“{month}, {n} days with data, {average} on average”); a month opens its days as 44px rows (date, value, marks in words), and a day opens the Day panel under its row.
- **Day panel** (columns 9 to 12 and sticky from 1024px; under the heatmap below): the date and its status (Closed, No data for this day, Left out of the numbers by your filters, Today); Your numbers (Guests, Net sales, Usual for a {weekday} with the day count and the day’s change, Same day last year); On the town calendar, each event with its kind, dates and “Source: {label}” links, and the line when the town’s research doesn’t cover the day; Your notes in words with “Open Notes”; Where it came from (“From the upload on {date} by {email}.”, “This upload didn’t finish.”, “Upload record not found.”) and, for an upload read from a stored file (F4), “File: {name} ({kind}).”, “Download cleaned CSV” (web, a finished upload; never under view-as, where the line reads “File: {kind}. Its name is hidden in view-as.”; native says “Download from a computer at townwise.tech.”) and “Open Your files” (P12); Previous day and Next day (they move the selection, and on web focus the matching cell); “Ask TownwiseAI about this day”, which opens P25 at `?about={YYYY-MM-DD}` to fill its composer with the day (it never sends by itself). Empty: “Point at or select a day to see everything Townwise has for it. Use the arrow keys to move between days.”
- **Weekly shape**, **By month**, **Year over year**, **By type of night**: each a text summary, the chart (web: inline SVG, `aria-hidden`, `mint` 2px marks with square ends, printed scale “Scale 0 to {n} guests. Scale fitted to this location.”; year over year draws the newest year `mint` and older years `line`, each labelled with its year, months that are not complete as hollow points), the basis line and “Show the numbers”. Year over year compares only months with at least 15 kept days in both years and says what is missing otherwise, with “Upload older history” when older exports would help. A type of night with fewer than 2 nights shows its count and “Not enough nights yet.”
- **Biggest drivers**: a table (#, Driver, an effect bar from 50% fewer to 50% more on web, Effect, Seen), “(rough)” under 4 days, the footnote on how effects are measured, the basis line, and a Planned line: “Weather as a driver.” With nothing seen twice: “Townwise needs each kind of day to happen at least twice before it can say how much it moves your numbers.” [CONFIRM: driver thresholds] [CONFIRM: the baseline for usual]
- **How Townwise estimates** (F9): the model card (13.2), in the reading column, above Your data.
- **Your data**: the data checks (Days with data, First day, Last day, Missing days in between, Days with guests, Days with net sales, Last upload “{date} by {email}”), “Analytics reads your stored days, your notes, your town’s calendar and how Townwise estimates. It changes nothing and keeps nothing, not even your filters: they reset when you leave the page.”, and a link to Sales data.

| State | Shows |
|---|---|
| Loading | “Loading analytics” |
| Empty | The filters, disabled, and “No sales history yet.” with “Upload sales history” (web) or “Upload from a computer at townwise.tech.” (native) |
| Error | Network copy with Try again; 404 as on P11 |
| Success | As above |
| View-as | The same page; the upload links are disabled with the read-only line |

**P25. TownwiseAI (`/locations/[id]/agent`, members; `/locations/[id]/chat` redirects here)**

The location's chat with TownwiseAI and its side panel (server contract: `docs/portal/tuning-chat.md` and 10.12). The page's h1 is “TownwiseAI”, under the eyebrow naming the location. From 1024px the chatbox takes columns 1 to 8 and fills the screen, and the side panel takes 9 to 12 and scrolls on its own. Below 1024px one column under a three-way switch, Chat, Questions ({n}) and Activity; the chat keeps its state while another view shows. On phones the location's compact header and the switch sit at the top of what scrolls, and the composer is one row.

- **Header**: the open conversation's title, or “New conversation”; **Conversations** opens the list under it (each row: title and date, and **Delete**, which asks “Delete this conversation?” with “TownwiseAI’s replies and your messages in it are deleted. Notes you saved from it stay.”; Escape closes the list and returns focus); **New chat**. Both off while a reply streams.
- **Empty conversation**: “Ask TownwiseAI about {location}”, a line saying what it reads (from the tool table), and up to four chips. Ask chips send at once and show only when Townwise can answer them (“How did last week go?” when the last sales day is within 10 days, “Which days last month were unusual?” with 60 days of sales, “What’s coming up in {next month} in {town}?” for a researched town, “What should I upload?” with no sales); Tell chips (“We’re closed on …”, “We have a private event on …”) fill the composer. No chip asks for a forecast. With no sales: “You haven’t uploaded sales yet, so TownwiseAI can only use {what it reads, from the tool table, leaving out what needs sales}.” and Upload sales (web).
- **Messages**: “You” in a square panel (right-aligned at 80% from 641px); TownwiseAI's reply as its parts in streamed order: text, tool cards, more text, proposal cards. “TownwiseAI is thinking…” while nothing is being written or read. Text deltas are drawn at most every 32ms. Under a finished reply, the **Based on** line, built in the client from that reply's tool cards and never written by the model (“Based on your sales from Oct 1 to Oct 31, 2026, your 12 notes, and Hanover’s town profile (bls.gov).”; no reads: “Based on this conversation only.”). A failed or stopped reply keeps what arrived, says it wasn't saved, and offers **Try again**, which sends the same message as a new turn.
- **Tool cards**: one row per call, a mono status word (Reading, Read, Couldn’t read) and what it read, with a detail line from the call's result view (dates, counts and source links only). Once the reply is done the group folds to “Read {n} things” with Show and Hide; a row opens to its views as a definition list and its https sources, which open in a new tab. A tool the client has no words for reads “Looking something up”. The words live in `client/src/chat/tools.ts`, with rows for every registered tool and for `get_town_calendar` and `get_people_in_town` ahead of their landing.
- **Proposed note card**: Kind, Date or Dates, Weekdays, Effect, Expected guests and Detail (dates and counts in mono mint). **Save note**, **Edit first** (the note form, filled in) and **Not now** (folds to “Not now.” with Show the note; recorded, still saveable). Saved: “Saved to Notes.” or “Saved to Notes, with your changes.” with Open Notes, and focus moves to it. The actions wait until the reply is stored; a card from a reply that wasn't kept says so and saves through the notes route. Errors stay on the card (note limit, a note Townwise couldn't accept, not found).
- **Composer**: label “Ask about your sales, or tell TownwiseAI what it can’t see” (the input's name on phones), and under it “Leave out guest names. TownwiseAI answers from {what it reads}.” Grows to 200px, then scrolls; 4,000 characters, with a counter from 3,600. Web: Enter sends, Shift+Enter is a new line, and Enter while an input method composes does nothing. Send becomes Stop while a reply streams. No attachments. `?about=YYYY-MM-DD` (from Analytics' day panel) fills an empty composer with “Tell me about Sat, Nov 21” (with the year for another year) and sends nothing; a date that isn't real, or is outside 2010-01-01 to 400 days after today, is ignored (F7).
- **Scrolling**: the log keeps its end in view until the person scrolls up more than 4px; coming back within 40px of the end pins it again; a **Latest** button shows while content grows below the view.
- **Side panel**: **Questions for you** (“{n} open”): rule-based questions from the location's own sales and notes (a weekday with no sales on most of its days in weeks with sales on other days, a run of days with no sales), each with what it saw, three answers and a help line saying what an answer does; answered, it says what it did. Empty: “No questions right now.” A Planned tag: “TownwiseAI’s own research (unusual nights, town events it finds) is planned.” **What it’s been doing** (newest first): only real, dated events (uploads read, stored files read, “Read your file for {dates}, {n} days.”, never its name, notes saved from a card or an answer, answers given); an event kind the client doesn't know shows as nothing. Empty: “Nothing yet. Upload sales or save a note and it shows here.” **This month’s budget**: “{Month}: {n}% used. Resets {Mon} 1.”, and from 80% “Most of {Month}’s budget is used. TownwiseAI pauses when it runs out.” [CONFIRM: show owners the monthly chat budget, as percent used] **How TownwiseAI works** (closed by default): what it reads, what it can't see (the weather, staffing, bookings not in notes, guest names), that it never saves a note without you, whether Townwise has a forecast for this location (from `GET .../estimates/about`: “Townwise has no forecast for this location yet, so TownwiseAI answers from {what it reads}.”, or once one is published, “TownwiseAI also reads the forecast Townwise published: {model}, trained on {source} from {date} to {date}, made {date}.”, which also adds “Townwise’s forecast” to what it reads; “Couldn’t check whether Townwise has a forecast for this location.” with Try again if the read fails), **How Townwise estimates**, which opens the model card (13.2) in a sheet (Close or Escape shuts it), and that messages and the data it reads go to Anthropic (with a Privacy link) (F10).
- A live region (polite) says “TownwiseAI is replying”, each thing it starts reading, and “TownwiseAI replied”, never the streamed text; the log is `role="log"`. Card fade-ins (200ms) and Latest (150ms) are instant under reduced motion.

[Build note: the side panel reads `GET .../agent` as `{ questions, activity }` and reads each item on its own, dropping any it doesn't know. A question is `{ id, kind: 'weekday', weekday, from, to, noSalesCount, weekdayCount }` (no sales on `noSalesCount` of the `weekdayCount` days of that weekday in weeks with sales on other days, worded “{Location} has no sales on {noSalesCount} of the {weekdayCount} Mondays in weeks with sales on other days.”) or `{ id, kind: 'gap', from, to, dayCount }`, as `api/README.md` (Tuning chat) documents them; an activity item is `{ at, kind: 'upload_applied', firstDate, lastDate, dayCount }`, `{ at, kind: 'note_saved', via: 'chat' | 'question', noteId, noteKind, startDate, endDate }`, `{ at, kind: 'question_answered', questionId, answer: 'open' | 'not_sure' }` or `{ at, kind: 'file_processed', fileId, firstDate, lastDate, dayCount }` (F3). The words are the client's, so the API sends ids, dates and counts only. An answer is `POST .../agent/questions/:questionId` `{ answer: 'closed' | 'open' | 'not_sure' }`, answered `{ question: { id, answer }, note }`; a 404 reads the panel again.]

| State | Shows |
|---|---|
| Loading | “Loading TownwiseAI…” in the chat column; the side panel loads on its own |
| Not found | “This location wasn’t found.” |
| Error | The error and Try again (each of the chat and the side panel) |
| Off | “TownwiseAI isn’t turned on yet.”; the side panel still loads |
| Budget used up | In place of the composer: “{Org} has used its TownwiseAI budget for {Month}. It comes back on {Mon} 1. Home and Analytics don’t depend on it.” [CONFIRM: what owners see when the budget runs out] |
| View-as | Everything reads; Send, Stop, New chat, Delete, the chips, Try again, Save note, Edit first, Not now and the answers stay in place, disabled, described by the one read-only line |
| Success | As above. Nothing is kept in browser or device storage. |

### 16.4 Staff console pages

**P19. Requests (`/admin`)**

- Title “Requests”. Tabs, styled as in 15.2: Pending {n}, Approved, Rejected, Withdrawn.
- **Table**, oldest first under Pending and newest first elsewhere: Organization, Contact (name and role), Email, Town, Locations, Sent.
- **Detail panel** for the selected row:
  - every field, with the note as plain text;
  - “Requested as {emailAtRequest}” when the email changed;
  - the warning “This person already belongs to an organization.” when `requesterHasOrg` is true;
  - actions: the primary “Approve” (C3), an outline “Reject” (C4), and a text link “View as” (C1), which shows the Waiting page as they see it.
- **C3, Approve.** Title “Approve {orgName}”. Fields: Organization name, and First location name (prefilled with the organization name). The town is shown read-only. For a request with places, in place of those two: one group per place, “Place {i} of {n}”, showing the place’s Google name and town (the town alone for a request stored before places) above a Location name field prefilled with Google’s name (empty for a request stored before places). An empty name, or one that matches another ignoring case and spaces, stops the approve with “Each location needs its own name.” on each such field. Text for one place is the text below with that place’s town; for two or more: “This creates the organization and its {n} locations, and makes {email} its admin. We email them that they’re in, and they get access the next time they open Townwise.” Text without places: “This creates the organization and its first location in {town}, and makes {email} its admin. They get access the next time they open Townwise. We don’t send email yet.” Primary: “Approve”.
- **C4, Reject.** Title “Reject {orgName}?” Field: “Message to {contactName} (optional)”, with the helper “Shown on their No access page. Up to 500 characters.” Primary: “Reject”.

| State | Shows |
|---|---|
| Loading | “Loading requests” |
| Empty | Pending: “No requests are waiting.” Other tabs: “No approved requests.”, “No rejected requests.”, “No withdrawn requests.” |
| Error | 409 `request_not_pending`: “Someone already decided this request.” and the list reloads. 409 `requester_has_org`: the warning copy. Network copy. |
| Success | The request moves to its tab. After approval: “Approved. {org} is set up, and {email} is its admin.” with a link “Open {org}”. |

**P20. Organizations (`/admin/orgs`)**

- Title “Organizations”. Primary: “New organization” (C5).
- **C5.** Fields: Name, and First admin email. Text: “They join as admin the next time they continue with Google with this address. Townwise doesn’t email invitations. {org}’s admins will see that Townwise staff created it.”
- **Table**: Name, Status (Active or Suspended), Admins, Members, Invited, Locations, Days of sales, Last upload, Created. A row with no admin shows “No admin yet” under Admins.
- A client-side filter box (name), and a status filter.

| State | Shows |
|---|---|
| Loading | “Loading organizations” |
| Empty | “No organizations yet. Approve a request or create one.” |
| Error | Network copy |
| Success | As above |

**P21. Organization detail (`/admin/orgs/[orgId]`)**

- Header: eyebrow “Organization”, title {name}, then a line with the status, “Created {date}”, and “From request {date}” as a link to that request.
- Actions: outline “Rename”, and outline “Suspend” or “Reactivate”. The suspend confirmation reads “Members of {org} lose access until you reactivate it. Data is kept.”
- Under the actions, one line in `small`, `text2`: “What you change here is listed in {org}’s Townwise staff activity, which its admins see.”
- With no admin: “No admin yet. Add an admin email.”
- **Team**: P17’s table and add form, with a “View as” text link on each active member. Above the add form: “Addresses you add here show as added by Townwise staff. Don’t add your own addresses.”
- **Locations**, metadata only: Name, Town, Days, First day, Last day, Notes, Last upload. Under the table: “Sales figures and notes are visible only through View as.”
- **Setup** (D23, F10b) [Build note: `client/src/portal/console/SetupPanel.tsx`, with `SetupUpload.web.tsx`]: while the organization is in setup (`org.inSetup`: active, and nobody has ever joined it), a section after Locations, kicker “Staff setup”, title “Set up before anyone joins”, through the setup routes of 10.7. Outside setup the page has none of it. Its line: “Nobody has joined {org} yet. You can add its locations and upload their daily totals so its first admin finds a ready page. Use this only with {org}’s consent. Each change is listed in {org}’s Townwise staff activity, and setup closes for good when the first person joins.” In setup the Locations empty state reads “No locations yet. Add the first one below.” The section shows names, towns, day counts and dates, never a figure (D7):
  - A table of the locations (Name, Town, Days with the first and last day) with row actions: text “Rename”, outline “Delete sales data” while the location has days, and outline “Delete” while it has no day and no note. Each opens a console dialog.
  - **Rename** (“Rename {location}”, “Change its name, and its town or its place on Google Maps.”): Name and Town as P16, with “Changing the town takes off the location’s Google Maps place, if it has one.”, and “Search Google Maps instead” while the search is on, which finds a place as P10 does (“Looks right”, then the place in the form with “Change place”). “Save changes”, then “Saved.”.
  - **Delete sales data** (“Delete {location}’s sales data?”, “This deletes its {n} days of daily totals, its uploads and any stored files. This can’t be undone. It’s listed in {org}’s Townwise staff activity.”, with the typed name), then “Deleted {n} days and {k} uploads from {location}.” (“ and {f} stored files” before “from” when there were any). 409 `import_running`: “Townwise is reading files for this location. Try again when it’s done.” 503 `files_unavailable`: “Stored files are off right now, so nothing was deleted. Try again later.”
  - **Delete** (“Delete {location}?”, “This deletes the location from {org}. This can’t be undone. It’s listed in {org}’s Townwise staff activity.”, with the typed name), then “Deleted {location}.”. 409 `location_has_data`: “Delete {location}’s sales data first.”
  - **Add a location**: P10’s form, with the Places search first while it is on (the section asks once with autocomplete `{}`, as P3 does), then “Added {location}.” and the form empty again. Its refusals read as on P10, except 409 `location_limit`: “{org} has 25 locations, the most an organization can have.”
  - **Upload daily totals** (web only; native says “Upload daily totals for {org} from a computer.”, D20): “Your browser reads the file here, and Townwise receives only each day’s date, guests and net sales. The days it covers replace the ones the location has. This page shows how many days and which dates, never a figure.”, an “Upload for” location select, “Use an export that covers only {location}.”, and an outline “Choose a CSV file”. The browser reads the file as P13 does (11.2 steps 1 and 2: the same checks and Match columns, with Back and no Cancel), except that Match columns has no location column, so no column’s values are listed, and a header name that reads as a date or an amount shows as “Unnamed (column {n})”: no cell of the file shows. Then “Check the days”: “{n} days for {location}, {first} to {last}.”, “{k} days in this file can’t be sent, so they are left out.” when any are, and “{location} already has {first} to {last}. Days in both are replaced by this file.” when it has days, with “Send {n} days”, Back and “Choose another file”. Only `{ days }` is sent (11.1). Then “Saved {n} days for {location}, {first} to {last}.” and “{location} now has {n} days, {first} to {last}.”, with “Upload another file”. No total, no day’s values and no reason a day was left out show, and the answer keeps only the day counts and dates (its calibration is dropped). The location’s name and days are read as the organization has them now, so a rename during the upload shows at once. Send errors read as P13’s.
  - After each write the page reads the organization again, so Locations shows the days, and the section says how the write ended, where focus moves. A location write’s 404: “{location} was deleted meanwhile.” When any read of the page finds setup closed that it showed open (after a setup write, Suspend, or a join meanwhile), the section goes and the notice says why, from that read: “{org} was suspended, so setup is closed.” when it is suspended, otherwise “Someone joined {org}, so setup is closed. Use View as to see their page.” A setup write that answers 409 `org_not_in_setup` hides the section at once and reads again; if that read fails, the notice says someone joined. Once a newer read lands, `org.inSetup` decides, so an organization reactivated on the page gets the section back while nobody has joined.
- **Recent activity**: the newest 20 audit events for this organization, with a link to `/admin/audit` filtered to it.
- **Forecasts** (14.4) [Build note: the section's component is `client/src/portal/console/ForecastRuns.tsx`]: kicker "Staff only". One line: "A forecast is a draft until you publish it. {org}’s members and TownwiseAI see only published forecasts, never the model. Each import, publish, withdrawal and deletion is listed in {org}’s Townwise staff activity." Per location a table (Model, Dates with the day count, Trained to, Made, Status, Actions), or "No forecast imported for {location}." Actions: primary "Publish" on a draft only, text "Withdraw" on a draft or published run, outline "Delete" on every run, each through a console dialog whose body ends "Its admins see this in their Townwise staff activity." **Import a forecast** (web only; native says "Import a forecast for {org} from a computer."): a location select and "Choose a run file"; the browser reads the file and shows "For {location}: Model {v}, guests, {n} days ({k} open) from {first} to {last}, trained to {date}, made {date}." and "Saved as a draft; owners and TownwiseAI see it only after you publish it." before "Import". Problems read "{path} {words}." from the issue codes, never a value. No figure from a run shows in the console.
- **Delete organization**, last on the page. While the organization is active: “Suspend {org} before deleting it.” and no button. While suspended: an outline “Delete organization”. Its dialog: “This deletes {org}: its {n} locations, their sales data and notes, its team and its request. The audit log keeps the events, with the organization’s and locations’ names removed. This can’t be undone. Type {org} to confirm.” On success, `/admin/orgs` with the notice “Deleted {org}.” (The notice uses the name typed into the dialog; the server no longer has it.)
- States: loading; 404 “This organization doesn’t exist.”; network error; success. 409 `org_not_suspended`: “Suspend {org} before deleting it.”

**P22. People (`/admin/people`)**

- Title “People”. Lead: “Everyone Townwise has a record for: staff, members, invited emails and requesters.”
- A kind filter, plus a client-side search box (email or organization).
- **Lookup** panel: “Find a signed-in person by exact email”, with a field and an outline “Look up”, which calls `?q=`. The result row shows kind “Signed in only” when there is no other record, or “No one with that email has signed in or been added.”
- **Table**: Email, Kind, Organization, Since, and Two-step (staff rows only).
  - Kind is one of Townwise staff, Admin, Member, Invited, Requested, Rejected, Removed, Signed in only.
  - Two-step reads “On since {date}”, “Not set up” or “Not signed in yet”.
- **Row actions**: “View as” (C1) on every non-staff row with a user, and “Sign out everywhere” on the same rows. Its confirmation reads “This signs {email} out on every device. They can sign in again.”
- **Delete person**, an outline action on every non-staff row, invited addresses included (D22). On a row with an active seat it is disabled (15.7), with the helper “Remove {email} from {org} first.” Its dialog: “This deletes {email}’s requests and invitations, signs them out everywhere, removes their authenticator, and replaces {email} with “deleted person” in the audit log. Their notes and uploads stay with their organization. This can’t be undone. Type {email} to confirm.” On success, the notice: “Deleted {email}’s Townwise records. Delete their kit user record by hand (runbook).” When no kit user exists, the second sentence is left out.
- With `truncated`: “Showing the first 1,000 people. Use the search or the lookup.”
- States: loading, network error, success. There is no empty state, because the viewer is staff. 409 `person_has_seat`: “Remove {email} from {org} first.”

**P23. Audit log (`/admin/audit`)**

- Filters: organization, actor, action. “Load more” pages with `before`.
- **Table**: When, Who (email and role, plus “viewing as {email}” where relevant), Action (the server’s plain-words `summary`, for example “Added {email} as member”), Organization, Details. A staff event qualified by `staff_action.not_applied` adds “Didn’t take effect ({code}).” Redacted values read “deleted person”, “deleted organization” or “deleted location” (9.3).
- States: Loading “Loading the audit log”; Empty “Nothing recorded yet.”; Error network copy.

**C1. View-as dialog.** Title “View Townwise as {email}”. Body: “You’ll see what {email} sees, read-only, for 30 minutes. This is recorded in the audit log with your reason, and {org}’s admins can see it. It ends early if {email} joins, leaves or changes organization.” (The clause about {org}’s admins appears only when the target has an organization.) Field: Reason, required, 5 to 200 characters, with the helper “For example, the question you’re helping with.” Primary: “Start viewing”. Errors: 400 `invalid_target` reads “Staff accounts can’t be viewed as.”; 404 reads “This person no longer exists.”; 429 uses the shared copy.

---

## 17. Logging and privacy

- Townwise server code logs ids and counts only: `userId`, `orgId`, `locationId`, `memberId`, `requestId`, `grantId`, `uploadId`, `routeId`. It never logs emails, names, organization or location names, note text, request notes, view-as reasons, figures, file content or request bodies. This matches the privacy page’s promise for sign-in logs (“its own log lines carry your account ID, never your email address”).
- Product log lines: `townwise.view_as_read`, `townwise.upload_applied`, `townwise.audit_write_failed` (error level), `townwise.access_denied { policy, code }`, `townwise.email_sent { kind, requestId, orgId? }` (info), `townwise.email_failed { kind, requestId, orgId?, code, status, upstreamCode, errType }` (warn; D14), and the stored-files lines in `api/README.md` (Audit and logs), which carry ids, kinds, sizes, counts and codes. An email’s log line never holds its address, subject or body. A stored-files line never holds a file name, header, sheet name, location value, cell, figure or the storage SDK's message; the SDK's own logger stays off.
- The welcome’s first name and organization name travel only in the `GET /api/me` body, never in a URL, log line or audit event. The welcome marker (6.15) is deleted with the organization and with the person.
- Forecast runs (14.4) log `townwise.forecast_imported { orgId, locationId, runId, days, weeks }` and `townwise.forecast_status { orgId, runId, status }`, never a figure or the run file; their audit events carry the model version, dates and day count only. The run file holds no free text, and the model, its features and its training rows never reach the API.
- A stored file is read only by the file reader and returned only to its organization; TownwiseAI and every model read `tw_sales_days`, notes and the town calendar, never files (6.10 rule 9). The one exception is the AI column step (11A.4), which sends Anthropic a redacted profile of one table (header text and value tokens), never a row, a figure, a file name or an entry path; only `chat/model.ts` and `files/extract/model.ts` construct a model client (test-enforced).
- The audit log (a database record) holds emails, organization names and view-as reasons. It never holds figures, note text, request notes or decision messages.
- The client never logs (expo-shell rule 12, **Exists**) and never persists the file or the parsed rows.
- **The privacy page must change before the portal ships.** The sentences on `feature/townwise-web` that become false are listed in 22.4. The new content needs to cover:
  - what an access request stores (name, role, town, note);
  - what a membership stores, including addresses an org admin adds for people who have never signed in and have never seen this notice: the address is stored on the admin’s action, kept on the invitation, and kept in the audit log until that person is deleted (10.7, Deletion);
  - what an upload stores (date, guests and net sales per day, plus upload counts);
  - locations (name, town);
  - notes: kind, dates, weekdays, effect, expected guests, a detail of up to 280 characters, and the author; the organization’s members see them; nothing reads them yet;
  - view-as grants and their reasons;
  - per-account rate-limit counters: keys are SHA-256 hashed, and the longest is kept 24 hours;
  - what the audit log stores;
  - who sees each, stated exactly:
    - the organization’s members;
    - Townwise staff, who see sales figures and note text only through View as, which is audited and shown to org admins;
    - Townwise staff in the console, who see team email addresses, location names and towns, date coverage, counts and recent audit events without View as; those reads are not recorded;
    - the people with access to the production database (members of the MongoDB Atlas project that `infra/README.md` on `feature/infra` sets up), named on the page; anyone with that access can read every collection, and their reads are not recorded by Townwise [CONFIRM: who holds Atlas project access];
  - how long each is kept, and how to ask for deletion (the staff path in 10.7);
  - the emails Townwise sends (D14): the recipient’s address and the email’s content go to Azure Communication Services, which delivers them and keeps its own delivery records.
  
  [DECISION NEEDED: retention and deletion terms for sales data, requests and audit events]
- **The Security page’s Hosting section** (`security.tsx` on `feature/townwise-web`, which today says hosting “has not been chosen” and that the section will say “who has access”) gains the same who-has-access facts: who holds production database access, and that their reads are not recorded.
- **Raw exports sent directly.** The privacy page already covers “Exports you send us directly” during early access, with its own [DECISION NEEDED]. [DECISION NEEDED: what happens to a raw export a client sent directly once that client uploads through the portal.] Recommended answer: delete the raw export once its days are in the portal, and say so on the privacy page. Raw exports can hold customer names, which is exactly what the upload design keeps away from Townwise.

---

## 18. Configuration and constants

| Name | Kind | Value | Notes |
|---|---|---|---|
| `TOWNWISE_SUPERADMIN_EMAILS` | env, not secret | comma-separated, normalized like the kit, up to 20 | Parsed in `api/src/config.ts` and spread into the one `loadEnv` call in `main.ts`. Empty is allowed in development and test; production boot refuses an empty list. [CONFIRM: refuse empty in production] |
| Staff window | constant | 60 minutes | [CONFIRM] |
| View-as length | constant | 30 minutes | [CONFIRM] |
| Upload | constants | 3,660 days, 256 KB, 50 MB file in the browser | [CONFIRM] |
| Caps | constants | 25 locations per organization; 1,000 notes per location; 20 emails per add; 200 people per organization | [CONFIRM] |
| Stored files | constants | 11A.2's table | `api/src/files/limits.ts` [CONFIRM] |
| `FILES_BLOB_ACCOUNT_URL`, `FILES_AZURITE_CONNECTION_STRING` | env, not secret | the client files account URL; Azurite's connection string in development only (production refuses it) | `api/src/config.ts`. In Azure the API signs in with its managed identity (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`, `AZURE_CLIENT_ID`) through the token source email uses, or boot fails |
| `TOWNWISE_FILES_MONTHLY_BUDGET_USD` | env, not secret | 5 (0 to 1,000; 0 turns the AI column step off) | the file reader's AI spend per organization per month (11A.4); on only with `ANTHROPIC_API_KEY` [CONFIRM] |
| Clock | dependency | the one `now` function `main.ts` passes to both `createAuth` and `createTownwiseApi` | 7.1 |
| `EMAIL_ENDPOINT` | env, not secret | the Communication Services endpoint, a bare `https://*.communication.azure.com` origin | Absent turns email off (D14). Set together with `EMAIL_SENDER`; email also needs the managed identity (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`, `AZURE_CLIENT_ID`), or boot fails |
| `EMAIL_SENDER` | env, not secret | `no-reply@townwise.tech` | D14 |
| `TOWNWISE_EMAIL_REPLY_TO` | env, not secret | a team member’s address in production | Absent: no Reply-To, and the footer does not offer replies (D14) |
| `TOWNWISE_WEB_URL` | env, not secret | `https://townwise.tech` in production, `http://localhost:8081` by default | A bare origin, for the links in emails; production email requires `https:` (D14) |

---

## 19. Kit reports (no kit file is edited)

1. **Per-action TOTP** needs a kit export. `api/kit/auth` checks codes only inside its own routes, and its verifier is internal. A staff action that asks for a fresh code would need something like `verifyTotpCode(userId, code)` exported from `api/kit/auth`. This is reported, not made. D2 meets the requirement without it.
2. **No user listing.** `UserStore` has `findById`, `findByEmail` and `findByGoogleSubject`, and no list. People uses Townwise records plus exact-email lookup (10.7), and never reads the kit’s collections.
3. **`normalizeEmail` is not exported.** Townwise repeats `trim().toLowerCase()` then `z.email().max(254)` and pins the rule with a parity test against addresses the kit accepts and rejects.
4. **`onUserCreated` swallows failures** (`auth.on_user_created_failed`), and it never fires for an existing user who is invited later. Townwise does not use it; joining is an explicit POST (F1).
5. **Package manifest for `api/`.** The router, models and tests import `express`, `mongoose`, `vitest`, `testcontainers`, `@testcontainers/mongodb` and `@types/express`. All six are already in `package-lock.json` at 5.3.0, 9.11.2, 5.0.5, 12.2.1, 12.2.1 and 5.0.6 through the kit modules. Declaring them in `api/package.json` at those exact versions adds no new package. [CONFIRM: this counts as no new dependency; if not, the build is blocked on these six]
   
   The lint gate (`eslint.config.js`: `import-x/no-extraneous-dependencies` with `includeTypes: true`) requires every import, type-only ones included, to be declared, and lets only `**/test/**`, `**/*.config.{js,ts}` and `tooling/**` import devDependencies. The kit’s own pattern (`import type { Redis } from 'ioredis'`) would need a seventh package. To stay within six:
   - type the Redis client as `RedisHandle['client']` from `@ckeith26/redis`;
   - take driver types (command-monitoring events included) from `mongoose.mongo.*`;
   - sign in during tests through magic link, so no `jose` is needed for a fake Google signer;
   - turn on command monitoring with the `monitorCommands=true` connection-string option, which the installed `mongodb` 7.7.0 driver accepts;
   - declare `express` and `mongoose` as dependencies, and `@types/express`, `vitest`, `testcontainers` and `@testcontainers/mongodb` as devDependencies;
   - keep every test under `api/test/`, so the devDependencies glob matches.
6. **Gmail and Workspace only.** The kit’s A-L2 rule refuses other email hosts (403 `google_email_not_authoritative`). An owner whose Google account uses a custom domain without Workspace cannot sign in until email delivery and magic links exist. [CONFIRM: accept for the beta]
7. **No user delete.** `UserStore` has `findById`, `findByEmail`, `findByGoogleSubject`, `create`, `linkGoogleSubject` and `updateEmail`, and nothing that deletes. `SessionStore.revokeAllForUser` revokes but keeps the records, and `TotpStore.remove` deletes the factor. The privacy page on `feature/townwise-web` already promises “we will delete your account record, sessions and any authenticator record”. Until the kit adds a user delete, the Townwise path (10.7, Deletion) revokes sessions and removes the factor, and the user record and its revoked session records are deleted by hand in the database, as a runbook step. Kit user records are deleted only after the Townwise path succeeds, so no active seat ever outlives its user and the last-admin rule never counts a missing person. [Build note: the person can still sign in until the manual step, so the runbook first confirms that no `tw_members` row has `activeUserId` equal to the user id (`api/README.md`, Deletion).]
8. **Test helpers are not exported.** The kit’s helpers (`startAuthServer`, `signIn`, `seedTotp`, mail capture, `global-setup.ts`, `images.ts`) live in `api/kit/auth/test/`; the package exports only `./src/index.ts`, and `import-x/no-relative-packages` forbids reaching into it. `seedTotp` also uses internals that are not exported (`createTokenCrypto`, `parseKeyring`, `generateSecret`). Townwise writes its own helpers against the public API (Section 20).

---

## 20. Tests and verification

Backend gate: from the worktree root, `npm run verify` with no new failures against the first stage’s baseline. `api/package.json` gains a `test` script (vitest), so the root `npm test --workspaces --if-present` runs it. Integration tests use Mongo and Valkey in Docker through testcontainers, as the kit’s do.

**Harness (`api/test/helpers/`).** The kit’s helpers cannot be imported (Section 19, item 8), and `api/src/main.ts` is a top-level-await script, so the tests build the app through `createTownwiseApi` (7.1). The helpers provide:

- `global-setup.ts`, which starts Mongo and Valkey with the same image digests as `compose.yaml`.
- `startTownwiseServer()`, which composes server-core’s `createServer` with `/auth` (the kit’s `createAuth`) and `/api` (`createTownwiseApi`). It passes one shared, mutable test clock as `now` to both, and a capturing `sendMagicLink` (production `email.ts` rejects every magic link). It runs `flushdb` on Valkey per test file, which also resets the kit’s magic-link send limit (`auth:ml-send-ip`, 20 per hour per IP).
- `signIn(email)`, through the kit’s magic-link routes and the captured link, so no fake Google signer and no `jose` is needed.
- `makeStaff(userId, { enabledAt })`, which seeds the factor through the public `TotpStore`: `startEnrollment` with any `secretEnc`, then `confirmEnrollment({ userId, step, recoveryCodeHashes: [], now: enabledAt })`, with `enabledAt` placed before or after the session’s `createdAt`. The resolver reads only `status` and `enabledAt`, so no code is ever generated.
- Command monitoring through a connection opened with `monitorCommands=true` (Section 19, item 5).

Because access tokens last 600 seconds (**Exists**), a test that advances the clock past 10 minutes calls `POST /auth/refresh` before its next `/api` request; otherwise the kit answers 401 before Townwise code runs.

Named tests:

- **Routes:** every Express route on `/api` is in `TOWNWISE_ROUTES`, with no duplicates.
- **Routes:** every GET route issues no write command, checked with Mongo command monitoring. This covers `GET /api/me`, which never joins and never withdraws a request.
- **Routes:** product code answers 401 only from `resolveAccess` when the kit user no longer exists (4.2 step 1), through the one helper `userGone()`.
- **Routes:** a non-GET refused by policy still counts toward `townwise:writes`, and is never body-parsed: a 300 KB body to the upload route from a `no_org` account answers 403, not 413.
- **Access:** each state of 4.2 from fixtures.
- **Access:** an invitation beats a pending request and carries it as `pendingRequest`, and the newer of rejected and removed wins.
- **Access:** a staff email that is also invited resolves as staff, never as member.
- **Join:** five concurrent joins of one invitation leave exactly one active seat.
- **Join:** joining with a different email than the invitation’s is 409 `no_invite`.
- **Join:** a second organization’s join is 409 `already_in_org`.
- **Join:** an invited person with a pending request stays pending until they press Join; “Not my team” deletes only the caller’s own invitation, and the request stays pending.
- **Invitations:** the same email invited by two organizations answers `invited` to both, and the person is offered both.
- **Staff gate:** a session created before `enabledAt` is refused, and one created after is accepted.
- **Staff gate:** after the clock advances 60 minutes and one second and the client calls `POST /auth/refresh`, a staff route answers 403 `staff_reauth_required`.
- **Staff gate:** no factor is `staff_setup_required`, and a member gets `forbidden`, never a staff code.
- **Isolation:** for every `member` and `org_admin` route with an id, organization A presenting organization B’s location, note or member id gets 404, and B is unchanged. The cases are generated from the route table.
- **Isolation:** only `access/resolve.ts`, the join and decline handlers and the staff handlers import `stores/cross-tenant.ts`.
- **View-as:** under a live grant, every non-GET route without the `staff` policy answers 403 `view_as_read_only`. The cases are generated from the route table.
- **View-as:** under a live grant, every route with the `staff` policy, any method, answers 409 `view_as_active`; `view-as/end` is the only staff route excluded. The cases are generated from the route table.
- **View-as:** under a live grant, `POST /api/admin/view-as/end` answers 200, and the next `GET /api/me` is `staff` with `viewAs: null`.
- **View-as:** `end` with a stale staff session answers 403 `staff_reauth_required`.
- **View-as:** a second session of the same staff user has no view-as.
- **View-as:** an expired grant is ignored.
- **View-as:** a grant that expired without End does not block a new Start on the same session.
- **View-as:** view-as ends when the target joins or changes organization.
- **View-as:** the target’s exact access is returned, including Waiting.
- **View-as:** `view_as.started` exists for every grant.
- **Audit:** a staff invite appears in the org admin’s staff activity.
- **Audit:** a staff action whose audit write fails is refused with 503, and nothing changes; a staff role change refused with 409 `last_admin` is followed by `staff_action.not_applied`.
- **Team:** concurrent demotion of the last two admins leaves at least one.
- **Team:** removing the last admin is 409 and the row is restored.
- **Team:** a removed member’s next member request is 403 `no_access`.
- **Uploads:** an extra key in the body or in a day is 400, and nothing is written.
- **Uploads:** a 3,661-day body is 400, and a 257 KB body is 413.
- **Uploads:** replace-by-day counts are right for an org admin.
- **Uploads:** a member upload never changes an existing day, and reports it as `kept`.
- **Uploads:** stored documents have exactly the eight keys of 6.5.
- **Uploads:** a log capture during upload contains no figures.
- **Notes:** range, weekday and kind rules hold.
- **Notes:** a member editing another member’s note is 403.
- **Notes:** `detail` is absent from logs and audit.
- **Deletion:** deleting a person with an active seat is 409 `person_has_seat`; otherwise their requests, invitations and removed seats are gone, and no audit event holds their email.
- **Deletion:** deleting an active organization is 409 `org_not_suspended`; deleting a suspended one leaves no tenant document with its `orgId`, and no audit event holds its name.
- **Forecast runs (14.4):** `api/test/forecast-file.test.ts` (strict shape, cross-field rules, issues without values, labels from code), `forecast-score.test.ts`, `forecast-runs.int.test.ts` (import, retry, publish and withdraw, staff only, staff activity, deletion), `estimates.int.test.ts` (drafts invisible, newest eligible run per date, actuals and live accuracy), `chat-estimate-tools.test.ts` (`get_forecast`), and `client/test/portal/console/forecasts.test.web.tsx`.
- **Staff setup (D23):** `api/test/staff-setup.int.test.ts`: each setup route works in setup and records its event before the effect; 409 `org_not_in_setup` after the invited admin joins, with any active seat, while suspended, and for good after the only person who joined leaves or is removed and is deleted (`firstJoinedAt`, set once at a join or an approval), or with a removed seat on an organization from before that field; open with only open, withdrawn or declined invitations; 403 for a member and an org admin; 404 for an unknown organization and another organization’s location; 503 with nothing changed when the audit write fails; `staff_action.not_applied` after `location_name_taken` and `files_unavailable`; after the join, staff activity lists the setup writes and the admin reads the days, with staff uploads as “Townwise staff”; no figure in an answer, a log line or an event. `api/test/routes.test.ts` pins the five routes.
- **Audit:** every mutation writes its event with only the allowlisted keys.
- **Email:** normalization matches the kit for case and spaces.
- **Towns:** `api/test/towns.test.ts` matches `api/src/towns.ts` against the literal list of twelve ids (Section 13).
- **Calendar:** `api/test/town-calendar.test.ts`: holidays on their legal days (Thanksgiving 2024 to 2026, Memorial Day, MLK Day, the actual day for July 4, Juneteenth from 2021 only); every event has a labelled https source and `start <= end`; ids unique and stable; overlapping multi-day events kept; the term convention; Hanover’s entries equal `modeling/dartmouth_calendar_2025_2026.csv` row by row. `api/test/calendar.int.test.ts`: Hanover’s events with sources, holidays only and `researched: false` elsewhere, every range rule 400, 404 across organizations.
- **Sales history:** `api/test/sales-history.int.test.ts`: oldest-first columns with exact figures, each day’s upload index and email, -1 for a day whose upload has no record, “Deleted person”, empty columns and `NO_COVERAGE` for a location with no days, exactly the contract’s keys, 404 across organizations, 200 during view-as with `townwise.view_as_read` holding ids only, and no figure or email in any log line.
- **Indexes:** `documentDbIndexProblems(connection)` is empty with the Townwise models registered (mongo MODULE.md, DocumentDB).
- **Welcome:** `api/test/welcome.int.test.ts`: only the approved requester of an organization with no sales day gets it, with their first name and the organization’s name; `POST /api/me/welcome` is 204 twice and then `welcome` is null; teammates, staff-created organizations, view-as (GET null, POST 403 `view_as_read_only`), `pending` and `no_org` (POST 403 `no_access`) get none; join, decline and request answers carry null; deleting the organization or the person deletes the markers; no log line holds the name. `api/test/welcome.test.ts` pins `firstNameOf`.

Client tests:

- routing per 4.3;
- `/joining` never calls join on load with a `pendingRequest` or with two or more invitations;
- the CSV parser’s RFC 4180 cases, delimiters, date orders, number formats, row modes and per-day sums;
- the mapper never renders a cell: a file whose cells contain a sentinel name must never show it, except a mapped location value;
- the view-as banner renders, and writes are disabled;
- staff setup on P21 (`test/portal/console/setup.test.web.tsx`): the panel only while `inSetup`; each write goes to its setup route and the page reads again; the deletes confirm with the typed name first; an upload sends only `{ days }`, has no location column, and no figure or other cell from the file or the answer shows; 409 `org_not_in_setup` takes the panel away, even when the read after it fails, and says someone joined, or that the organization was suspended when the read finds it so, and a reactivation brings it back; a read after a write that finds someone joined says so; a 404 on the send; `useRefreshable.test.ts`: an older read never lands over a newer one;
- the twelve town ids in the client’s `towns.ts` match the same literal list as the api test;
- statement moments (`test/portal/moments/`): the copy and the timeline (`timing.test.ts`, `moments.test.ts`), and the player on native and web (`provider.test.native.tsx`, `provider.test.web.tsx`): one moment at a time, said once, hidden from assistive tech, dismissed by a key at once and by a press after the grace period, reduced motion, a native screen reader, Android back and a hidden tab.
- which moment plays when (`moments.test.ts` > `momentFor`; `decisions.test.native.tsx` and `decisions.test.web.tsx`, the whole app with `PortalGate`): the send's `pending` answer covers the redirect to Waiting with request received; a fresh load of Waiting plays nothing; the welcome is up, with `playing` true, in the first render of the first page; it posts `/api/me/welcome` once and a re-read does not replay it; under view-as nothing plays or posts; the live region says it once.
- Analytics (`test/portal/analytics/`): the compute modules (`compute.test.ts`); the heatmap’s grids, one tab stop, keys, hover preview, the Day panel’s sources and the filters’ effect on the marks and the basis line, with no write and no storage, the same under view-as (`heatmap.test.web.tsx`); the native month list, its Day panel and the thin and empty copy (`analytics.test.native.tsx`); the shared checkbox (`test/portal/ui/checkbox.test.*.tsx`).

---

## 21. Deferred

| Item | Why it waits | What it needs |
|---|---|---|
| Email for invitations and rejections | D14 sends only request received and you’re in | An owner decision for each; a rejection email would also decide whether it quotes the staff message |
| Calibration, forecasts, model storage | Models exist only in research notebooks | The reserved states and shape (14.3), and `tw_calibrations` |
| AI chat for tuning | The privacy decision about sending client data to an AI provider | That decision, a provider agreement, a redaction step |
| Per-action TOTP for staff | Kit gap 1 | A kit export |
| Hash-chained audit, tenant-guard plugin, ESLint import bans | Heavy for a beta; covered by `OrgScope`, the route table and the generated tests | Revisit with paying customers |
| An org activity log beyond staff activity | Not requested | An org-filtered audit view |
| More than one organization per person | Simplicity (D5) | An organization switcher; organization ids on member routes |
| Native upload, `.xlsx` upload, POS integrations | New dependencies or vendor terms | `expo-document-picker`, a vetted parser, vendor APIs |
| Per-upload undo, a business-day cutoff setting | Not needed for v1 | Per-day history, or a per-location cutoff hour |
| Self-serve deletion of accounts, organizations and data; export; a retention schedule | Privacy decisions pending. Staff deletion on request exists in v1 (D22) | Section 17 decision, then flows and a job |
| Deleting the kit user record in code | The kit has no user delete (Section 19, item 7) | A kit addition; until then, a runbook step |
| An audited staff export of a client’s days for notebook calibration | Waits on the Section 14.1 decision | A `sales.exported` audit event shown in staff activity, and a privacy page line |
| Native charts | No `react-native-svg` (D21) | That dependency, vetted, or a View-based chart |
| Withdrawing or editing a pending request | Staff can fix names at approval | A withdraw action on Waiting |
| Last sign-in times on People | The kit exposes no session listing | A kit addition, or a Townwise `lastSeenAt` |
| Required TOTP for org admins | Friction for owners | [CONFIRM: optional for org admins] |

---

## 22. Index of decisions

### 22.1 Lead defaults to confirm

Each is marked inline with “lead default”:

- the three roles (D1);
- staff by `TOWNWISE_SUPERADMIN_EMAILS`, with TOTP for every staff action (D2);
- auto-join for invited emails, Request access for everyone else, and staff approval that creates the organization and its first admin (D3); kept despite the critic’s recommendation of a one-click Join screen for every invitation, which the F1 note explains;
- view-as read-only, audited, bannered, with writes refused by the server (D8);
- browser-side parsing that sends only date, guests and net sales per location per day (D10);
- no fake output (D12);
- tuning as structured notes, AI chat later (D13);
- organizations with one or more locations (D15).

### 22.2 Judgment calls to confirm

1. Per-organization invitations (D4).
2. One organization per person (D5).
3. Auto-join without a click, with Leave as the remedy and the inviter named (F1); a press to join when a request is pending, and “Not my team” to decline (F2b).
4. Role chosen at invite, default member (F5).
5. First location at approval (D6).
6. Town profile while waiting (F2).
7. What “validated manually” means (F3).
8. Rejected people may request again, with an optional message (F4).
9. Staff create organizations directly (F10).
10. Staff see values only through view-as (D7).
11. The 60-minute staff window, read as the TOTP requirement (D2).
12. View-as for 30 minutes, any non-staff target, no audit event per read, ending when the target’s organization changes (D8, 8).
13. Org admins see all staff activity on their organization, with staff emails (D9).
14. No session revoke on removal (D18).
15. Member permissions: upload and notes for members, with member uploads adding new days only (D16, 11.4).
16. Notes edited by author or admin (12).
17. Org admins rename their organization (10.3).
18. Sign out everywhere for staff (10.7), and sign out on every device in Settings (P18).
19. No cell contents in the mapper (D11).
20. Header guesses (11.2).
21. Replace by day for org admins (11.4).
22. Web-only upload (D20).
23. Limits, caps and file size (6, 10.8, 11.3, 18).
24. Earliest date 2010-01-01 (11.3).
25. Audit after the effect for client actions; before the effect, refused on failure, for staff actions (9.3).
26. Audit kept indefinitely (6.9).
27. Town data from the client modules on `feature/townwise-web` (13).
28. Route names (4.3).
29. The illustrative layout in the app (14.2).
30. The daily chart on Sales data (P12).
31. Whole dollars (15.7).
32. One primary per app page (15.6).
33. Disabled style (15.7).
34. Error and notice colours unadopted (15.7).
35. Console on web only (15.4).
36. Sign-in copy (P1).
37. `hello@townwise.tech` (P5, P10).
38. Web address for native users (P11).
39. Production refuses an empty staff list (18).
40. Manifest entries for `api/` (19.5).
41. Gmail and Workspace only (19.6).
42. Optional TOTP for org admins (21).
43. Web-only charts, with text and tables on native (D21).
44. Staff-only deletion in v1, with suspension before an organization is deleted (D22).
45. Who holds Atlas project access, named on the privacy page (17).
46. Staff setup for an organization nobody has joined yet: write-only, ending at the first join, used only with the client’s consent (D23, F10b).
47. Up to 25 checked Google places on a request and on Add location, each a location (D24).

### 22.3 Decisions needed

- The minimum days of history before calibration (D12, 14.1).
- Whether Waiting states a review time (P4).
- Retention and deletion terms for the privacy page (17, 10.7).
- Whether staff may copy a client’s uploaded days into research notebooks, for that client’s calibration only, and how the copy is recorded, shown to org admins and deleted (14.1).
- What happens to a raw export a client sent directly once that client uploads through the portal (17). Recommended: delete it once its days are in the portal.
- Retention periods for stored files (11A.7). Defaults [CONFIRM]: originals 365 days (lifecycle backstop 400), cleaned copies and reports until the file, its location's sales data or the organization is deleted, never-read drops 30 days, unfinished uploads 24 hours, deleted blobs 7 days in soft delete, storage access logs 365 days.

### 22.4 Conflicts in existing copy

- The homepage FAQ says the data needed is “what sold, how much, and when”. This spec stores only daily guests and net sales per location. One of them should change.
- The homepage step 02 says “Today: the app has no upload yet.”, and the Privacy page says “The Townwise app has no place to upload sales data yet.” and “That is the whole account record.” All three change when the portal ships.
- The SignIn artboard’s button says “Sign in with Google”. `feature/townwise-web` already says “Continue with Google”, but its sub still says “Your first sign-in creates your account.” (P1).
- The homepage step 03 carries [DECISION NEEDED: confirm step 03 status]. P11 no longer mirrors it: the client’s calibration step carries no StatusTag, whatever the homepage decides.
- More copy on `feature/townwise-web` that becomes false when the portal ships and has to change first:
  - `privacy.tsx`: “We do not keep your name, your photo or the Google token itself.” (false once a request stores `contactName`).
  - `privacy.tsx`, “Where your data lives”: “Account, session, authenticator and email-link records are stored in a MongoDB database.” (the portal adds requests, memberships, locations, sales days, uploads, notes, view-as grants and audit events).
  - `privacy.tsx`, rate limiting: “the server counts requests from each IP address: one limit for the whole service and a tighter one for sign-in” (the portal adds per-account counters).
  - `Home.web.tsx` FAQ: “There is no upload in the app yet.” and “The app has no upload yet.”
  - `security.tsx`, Hosting: “Hosting has not been chosen.” gains the who-has-access facts (17).
- Raw exports sent directly: the privacy page’s “Exports you send us directly” has its own [DECISION NEEDED]; the portal adds the question of what happens to them once the client uploads (22.3).

---

## 23. Changelog

**2026-11-09, several places from one search (D24).** A request carries up to 25 checked Google places, `places: { placeId, name, town }[]`, in place of one `placeId`; a request stored with one `placeId` reads as one place named null (F2, 6.3, 10.1, 10.2). `access_request.created` adds `placeCount` (9.2). Approval takes `locationNames` for a request with places and creates a location for each; a retry fills only the missing ones (F3, 10.7). C3 names each place.

**2026-11-06, staff setup.** While an organization is active and nobody has ever held a seat in it, staff add, rename and delete its locations and upload or delete their daily totals (D23, F10b), through five staff routes that reuse the org routes’ checks and writes (10.7). Each write is recorded before its effect and shown in the organization’s staff activity once someone joins (9.2, 9.3); answers carry no figure (D7). Setup ends at the first join and never reopens, kept by the organization’s new `firstJoinedAt` (6.1), and is closed while suspended (409 `org_not_in_setup`, 10.9). Locations and uploads made in setup carry `byStaff` (6.4, 6.6), and every view names those uploads “Townwise staff” (10.1). P21’s setup panel is the console side (16.4).

**2026-11-06, places search in the app.** The Google Places search is on P3 (Step 1, “Find your restaurant”), P10 and P16 while it is on (10.2a); P3 learns that by sending autocomplete `{}`, and P10 and P16 from `placeSearch` in `GET /api/org` (10.3). `POST` and `PATCH /api/org/locations` take a `placeId`: the API asks Google for the place, refuses a town that isn’t its own, stores Google’s current id, and spends one call of the `places` budget for it (6.4, 10.3, 10.8, 10.9). `location.created` and `location.updated` add `hasPlace` (9.2). A location keeps the place’s id and town, never the address or the map.

**2026-11-06, onboarding step 3.** Home shows the drop screen (P11, “Step 3, Your history”) while the organization has locations and none has a stored day: files go to stored files (10.11, 11A) through the upload queue, the import is read on the server with its questions on the screen, and Done hands over to Home. While stored files are off (503 `files_unavailable`) it offers the browser upload (11.1) instead. It replaces `home/onboarding.ts`’s stub.

**2026-11-06, statement moments on.** `MomentProvider` is mounted in `PortalGate`, and the two moments play (15.8): request received when this session's access goes to `pending`, and the welcome while `GET /api/me` carries it (`welcome` joins the client's `MeResponse` schema). Never under view-as. The web live region drops `role="status"` so it never competes with a page's notice. Tests in Section 20.

**2026-11-06, forecast runs.** Staff import a model run's outputs for a location (`townwise.forecast-run/1`, 14.4) from P21 as a draft, then publish, withdraw or delete it, each a staff action in the org's staff activity (9.2, 10.7). Owners, view-as and TownwiseAI's `get_forecast` read published runs only, the newest one whose data ends before each day, with ranges, labels made in code, actuals and live accuracy; the model card shows the run (10.13). Two collections (6.20, 6.21), deleted with the location's sales data, the location and the organization. Nothing is published yet (owner decision 2026-11-05: Sawtooth's v3 once it joins and consents).

**2026-11-05, stored files (stages 5 to 9).** ZIP archives read in place with bomb guards, entries listed in `tw_file_entries` (6.18) and served by `GET .../files/:fileId/entries`, and their tables read as families; PDF tables (`unpdf`) and Word tables (`saxen`); the AI column step on a redacted profile within a monthly budget (`tw_files_usage`, 6.13; `TOWNWISE_FILES_MONTHLY_BUDGET_USD`, 18); stored files deleted with a location's sales data and an organization, the owner's "delete every original" (`DELETE .../originals`), the staff purge for a person's deletion request (10.7), and the daily sweep for retention (11A.7, `tw_file_sweeps`, 6.14); two audit actions (9.2) and `deletedFiles` on `sales.deleted`. Stored files in Azure sign in with the managed identity. Still off in production (11A.8).

**2026-11-05, Analytics page.** P24 is built (16.1, 16.3): the filters, the heatmap with its keys and the Day panel, the weekly shape, by month, year over year, types of night, the biggest drivers and Your data, from the two reads of 10.4 and 10.10 and the notes. A shared checkbox joins the portal’s controls. The page writes nothing and keeps its filters in its own state. The model card (F9) and the day panel’s file details (F4) are Planned.

**2026-11-05, calendar and sales history.** Two member reads, `GET .../sales/history` and `GET .../calendar` (10.4, 10.10), for Home, Analytics and TownwiseAI. The town calendar (13.1) merges computed federal holidays, the profile’s key dates and researched entries; Hanover’s entries come from the committed public `modeling/dartmouth_calendar_2025_2026.csv`, each with its source and confidence. Headcount inputs stay empty until researched. Tests in Section 20.

**2026-11-05, stored files (stages 1 to 4).** The private client files account (11A.1), chunked uploads, the file list, downloads and deletion (10.11), and the file reader for text and Excel files (11A.4 to 11A.6), with three collections (6.11, 6.12, 6.19), three audit actions and the reader's sales uploads (9.2), three limiters (10.8) and the error codes (10.9). The browser upload stays as the fallback and the daily-totals choice (11.1). Off in production until the later stages and the privacy page ship together (11A.8).

**2026-11-05, statement moments.** Two statements reveal word by word over the portal (15.6, 15.8): request received and the welcome. `GET /api/me` carries `welcome` for the approved requester’s first visit (4.1, 10.2), recorded by `POST /api/me/welcome` in `tw_welcomes` (6.15), which is deleted with the organization and the person (10.7, 17).

**2026-11-05, Google place id.** An access request and a location carry an optional Google place id (F2, F3, 6.3, 6.4, 10.1, 10.2). Approval copies it to the first location. `access_request.created` records only `hasPlace` (9.2). The two Places routes, the `places` limiter and their error codes are in 7.2, 10.2a, 10.8 and 10.9.

**2026-11-04, critic review.** Twenty-three findings applied. Where one conflicted with a lead default, the default stayed and the conflict went into its [CONFIRM] note.

- **Auto-join (F1, D3, F2b, P6).** The lead default stays: one invitation and no pending request still joins on load. The F1 [CONFIRM] now describes the stranger-enrollment attack and the declined alternative (a one-click Join screen for every invitation). Within the default: the inviter is named on `/joining` and in the notice (`invitedBy`); a person with a pending request presses Join, and only then is the request withdrawn; “Not my team” (`POST /api/me/decline`, audit `member.declined`) deletes an invitation.
- **View-as (4.2, 6.8, 7.2, 8, F8).** A grant is live only while the target’s resolved organization equals `grant.orgId`. `resolveAccess` returns `self`, `effective` and the grant. The new `staff_self` policy lets End pass during view-as, while `staff` stays strict. The principal carries the staff actor. Start clears any grant still holding the session, expired or not (`endReason: 'expired'`). The guard answers 409 for staff routes first, then 403 for other writes.
- **Staff activity (D1, D7, D9, 9.3, 10.1, P17, P18, P21).** Org admins see every staff action on their organization, not only view-as. `MemberView.addedByStaff` marks addresses staff added. Staff events are written before the effect and refused on a failed write, with `staff_action.not_applied` when the effect then fails.
- **Request chain (7.2, 10.8).** `townwise:writes` runs right after `requireAuth`. Bodies are parsed only after the guard and the policy pass.
- **Member uploads (D16, 3, 11.2, 11.4, P12, P13).** A member’s upload adds new days only (`$setOnInsert`, counted as `kept`); org admins keep replace-by-day.
- **Deletion (D22, F13, 9.3, 10.7, P21, P22, Section 19 item 7).** Staff delete a person (after removing their seat) or a suspended organization. Each deletes the Townwise records and redacts emails or names in the audit log, which is otherwise still append-only. The kit has no user delete, so the user record is deleted by hand.
- **Honest copy (14.1, P9, P11, P12, P14, 13).** No research-notebook or future-forecast promises. The upload copy says what the upload sends, not what Townwise keeps. Step 03 has no StatusTag. The illustrative block sits under the homepage’s “In development” qualifier. Notes copy says nothing reads them yet. Town progress comes from the bundled data.
- **Privacy (17, 22.3, 22.4).** Says exactly who sees what, including console metadata and Atlas project access, neither of which is recorded. The privacy checklist gains notes, locations, invited addresses, grants and counters. New decisions cover research notebooks and raw exports. 22.4 lists five more sentences on `feature/townwise-web` that become false.
- **Build facts (7.1, 13, 19, 20, D21).** New `api/src/app.ts` with one shared clock. A test harness contract written against the public kit API. A way to stay within the six packages. Named OrgScope mint functions and `stores/cross-tenant.ts`. Town components extracted from `TownPanel.web.tsx`, with charts on web only. Town ids pinned as a literal list on each side. Two tests reworded to match the body (eight sales-day keys; the one 401 from `userGone()`).
