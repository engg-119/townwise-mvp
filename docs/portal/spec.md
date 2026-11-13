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
| D1 | Three roles: `superadmin` (Townwise staff), `org_admin`, `member`. A staff address never resolves as a member. | Staff manage any organization’s team, name and status from the console, and each of those actions is shown to that organization’s admins (D9). They read sales figures and note text only through audited view-as (D7), or, before anyone has joined an organization, by opening it as its admin (D25). | [CONFIRM: lead default, the three roles] |
| D2 | Staff are listed in `TOWNWISE_SUPERADMIN_EMAILS`. Every staff request needs TOTP enabled, a session created after TOTP was enabled, and a session at most 60 minutes old. | The kit cannot check a code per action without a kit change (Section 19). Once TOTP is on, every new session passes a code at sign-in. Confirming TOTP revokes the other sessions and keeps the current one, so “created after `enabledAt`” means “passed a code”. 60 minutes is as close to “every action” as the kit allows. | [CONFIRM: lead default, staff by config and TOTP for every staff action, read as a code at sign-in no more than 60 minutes ago] |
| D3 | An email on an organization’s list joins it automatically, with no click, the first time that person continues with Google. Anyone else lands on Request access. Staff approve, which creates the organization and makes the requester its org admin. One exception: a person who already has a pending request presses Join, and only then is the request withdrawn (F2b). | Lead default. The exception keeps an invitation the person never chose from skipping staff review. | [CONFIRM: lead default, auto-join, request access, approval. Conflict: the critic review recommends a one-click Join screen for every invitation, because auto-join lets an org admin pull a stranger into their organization (F1).] |
| D4 | Invitations are per organization. Two organizations may invite the same email; the person chooses. | No add result depends on another organization, so an org admin learns nothing about other customers and cannot block a stranger. | [CONFIRM: per-organization invitations] |
| D5 | One active organization per person. | A restaurant group is one organization with several locations. One unique index replaces an organization picker. | [CONFIRM: one organization per person] |
| D6 | Approval creates the organization, its first location and the requester’s admin seat. | The owner’s first page already shows their town and the upload step. | [CONFIRM: first location at approval] |
| D7 | Staff see client sales figures and note text only through view-as, except in an organization nobody has joined, which staff can open as its admin (D25). Without either, the console shows team emails, location names and towns, counts, date coverage and recent audit events, and those reads are not recorded. The setup panel’s routes (D23) give staff no read access; D25 does. | One audited exception to “visible only to that client”. | [CONFIRM: staff see values only through view-as] |
| D8 | View-as is bound to the staff session, lasts 30 minutes, needs a reason, refuses every write and every console route, resolves exactly as the target user, gate pages included, and ends when the target’s organization changes. | “Exactly what the client sees.” | [CONFIRM: lead default, read-only, audited, bannered; 30 minutes; any non-staff user as target] |
| D9 | Org admins see every Townwise staff action on their organization: each view-as with the staff email and reason, and every team, name and status change staff make. | Trust around private data. Not requested by the user. | [CONFIRM: show staff activity to org admins, with staff emails] |
| D10 | The browser parses the file and sends only `{ date, guests, netSalesCents }` per day for one location. | Lead default. POS exports can contain customer names. | [CONFIRM: lead default, browser-side parsing, three fields] |
| D11 | The column mapper never renders a cell, except the distinct values of a column the user names as the location column. | Names stay off the screen and out of screenshots. | [CONFIRM: no cell contents in the mapper] |
| D12 | Calibration states in v1: no sales data, and not calibrated. No day threshold is shown. [Build note: since D27 the console’s Calibrate refusal and TownwiseAI’s `start_calibration` state the lab’s minimum history, 595 days (409 `not_enough_history`), decided by the owner on 2026-11-10 (D27); the calibration states of 14.1 still show no threshold, and this decision stays open.] | No fake output. The homepage says the history needed is still being tested. | [CONFIRM: lead default, honest states] [DECISION NEEDED: minimum days of history before calibration] |
| D13 | Tuning is structured notes per location: closure, private event, opening, other. An AI chat waits. | Lead default. | [CONFIRM: lead default, notes first, AI chat later] |
| D14 | Townwise sends two emails, each only to the person it concerns and only after the change it reports is written: request received (F2) and you’re in (F3, from the call that seats the requester). They come from `no-reply@townwise.tech` through Azure Communication Services, sent with the API’s managed identity, with Reply-To from `TOWNWISE_EMAIL_REPLY_TO`, no images and tracking off. Invitations, rejections, view-as and every other flow send none. A failed send is logged as a code, with no address, and never blocks, fails or retries the action. Email is on when `EMAIL_ENDPOINT` is set: in production from this release (2026-11-09), whose F2, F3, P3, P4 and C3 copy says so; locally, when `EMAIL_ENDPOINT` is set in `api/.env.local`, it sends through the developer’s `az login` instead of the managed identity. | Owner decision, 2026-11-05. People are held until staff approve, so they need to hear when they’re in. A rejection email waits on an owner question (whether it quotes the staff message). | Decided (owner, 2026-11-05) |
| D15 | An organization has one or more locations. Sales, uploads and notes belong to a location. | Lead default. | [CONFIRM: lead default, per-location data] |
| D16 | Members and org admins can upload and write notes. A member’s upload adds new days only; an org admin’s replaces the days it covers. Only org admins manage the team, locations, the organization name and deletion. | The person with POS access is often a manager. Replacing history is as destructive as deleting it, which is admin-only. | [CONFIRM: member permissions; members add new days only] |
| D17 | No multi-document transactions. Writes are ordered so a retry completes them, and unique indexes catch races. | Local Mongo is standalone (`compose.yaml`), and production DocumentDB sets `retryWrites=false`. | none (a fact) |
| D18 | Authorization is resolved on every request from the primary. Removing a member never signs them out. | They see an honest page on their next request, not a sign-in loop. | [CONFIRM: no session revoke on removal] |
| D19 | Product denials are 403 or 404, never 401. | The shell refreshes on any 401 (kit client contract). | none (a kit contract) |
| D20 | Upload is web only. | A native file picker is a new dependency. | [CONFIRM: web-only upload] |
| D21 | The town profile (P4, P15) and the sales chart (P12) render on web only. Native shows each chart’s text summary and “Show the numbers” table, built from View and Text, plus “See the chart at townwise.tech.” | The client has no `react-native-svg`, and adding it is a new dependency. | [CONFIRM: web-only charts] |
| D22 | Staff can delete a person’s Townwise records, or a suspended organization’s. The audit log keeps the events with the email or names replaced. The kit’s user record is then deleted by hand. | The privacy page and Terms on `feature/townwise-web` already promise deletion on request. | [CONFIRM: staff-only deletion in v1; suspend before deleting an organization] |
| D23 | Staff setup. While an organization is active and nobody has ever held a seat in it (open invitations don’t count), staff can add, rename, change the town of and delete (when empty) its locations, and upload or delete its daily totals, from its console page (F10b, 10.7). It is write-only: answers carry ids, names, towns, counts and date coverage, never a figure, and staff still read values only through view-as (D7). It ends at the first join and never reopens, even once everyone has left, and it is closed while the organization is suspended (409 `org_not_in_setup`). Each setup write is recorded before it takes effect and shown to the organization’s admins once they join (D9), and the uploads it makes read “Townwise staff”, never the staff email. Staff use it with a real client’s data only with that client’s consent. D25 (2026-11-09) supersedes its write-only limit: staff can also open such an organization as its admin, reads included. The setup panel’s own routes stay write-only. | A client who sends their history before anyone on their team signs in finds a populated page on their first visit, not an empty one. It never reopens because an organization everyone left belongs to a former client, with no admin to see a staff write in their activity. | [CONFIRM: staff can add locations and upload daily totals for an organization nobody has joined yet; write-only; ends at the first join; used only with the client's consent] |
| D24 | A request and Add location take up to 25 checked Google places; each becomes a location. | Owner request, 2026-11-09: a restaurant group checks each of its places in one search, instead of adding them one at a time after approval. | [CONFIRM: a request carries up to 25 checked Google places, and approval creates a location for each, named by staff from Google's name] |
| D25 | Open as admin. While an organization is in setup (D23: active, and nobody has ever joined it), staff can open its portal as its admin from its console page (P21). They see and change everything an org admin can, except people (Team, invitations, roles, leaving, joining), until the first join, a suspension, End, sign-out or the end of their staff sign-in (D2). It asks no reason and has no timer of its own. One at a time per staff session. Every change is recorded with actor role `superadmin` and shown to the organization’s admins once they join (D9), and the records it makes read “Townwise staff”. It supersedes D23’s write-only limit and relaxes D7 for organizations nobody has joined. D23’s consent rule still applies. | Owner decision, 2026-11-09. Setting up a client before anyone signs in needs the real pages; until the first join, the organization holds only what staff put in it. | [CONFIRM: staff can open an organization nobody has joined as its admin, with full read and write except people, until the first join or the end of their sign-in session] |
| D26 | TownwiseAI is a chat page with no page header (a hidden h1, the chat header under the top bar, the chat filling the screen); Home greets by the name the person gives in Settings; rounded composer, bubbles and chips on that page only, Markdown replies with charts Townwise draws from its own data, conversation trees (edit and regenerate), ratings with an optional fixed reason, and three suggested next questions, with “Working for {n}s” and a live thinking summary while a reply streams, folding to “Worked for {n}s”. | Owner decisions, 2026-11-09. | Decided (owner, 2026-11-09) |
| D27 | Forecast lab. Org admins (through TownwiseAI) and staff (from the console) start calibrations: a job on Townwise’s Azure servers refits a location’s model on its own uploaded days and notes with the notebook’s method (modeling/lab/) and returns a draft run and a scorecard. It publishes itself only when staff have switched the organization’s forecasts on (G1) and it passes api/src/lab/gate.ts (G2); staff can withdraw it. Each costs $0.10 of the organization’s TownwiseAI budget, at most 4 a day per organization and one at a time per location. | Owner decision, 2026-11-09 (decisions 1 to 5; controller guardrails G1 to G4). | Decided (owner, 2026-11-09) [CONFIRM: gate values: 12 held-out weeks, half a point of weekly WAPE, 80% ranges holding 65% to 95% of weeks, 2 points of weekday bias] [CONFIRM: $0.10 a calibration, 4 a day]. The 595 days of history before a calibration starts (the span that always gives a first forecast its 12 backtest weeks with a range) was decided by the owner on 2026-11-10 and no longer awaits confirmation. |
| D28 | Your data. One page per location (P26) lists everything Townwise received: sales uploads, stored files and items kept for reference (any file, pasted text, or text kept from TownwiseAI). An item can be turned off, which leaves it out of every read, or deleted; deleting an upload deletes the days it still holds (org admins). TownwiseAI lists items and reads text items kept for reference, never sales files or file names, and keeps pasted text only after the person presses Keep. | Owner request, 2026-11-09. | [CONFIRM: Your data: turn off, per-upload delete by org admins, reference items under the stored-files caps and retention, TownwiseAI reading reference text] |
| D29 | Onboarding locations. The places search offers only a business or an exact street address (10.2a), and wherever the checklist shows, one signed static map has a pin for every checked place (`POST /api/places/map`). Request access (P3) is one screen. With one location, member pages never show the location's own name: they name it by the organization's name (16.3) and the header eyebrow is the town alone (15.2), and TownwiseAI's `get_location_overview` gives the model the organization's name, so its replies do not name the location (`tuning-chat.md` section 4); pending: TownwiseAI's landing (P25) still names the stored name until its route changes. A new location's name defaults to “{Business name}, {Town}” (“{Organization name}, {Town}” for a street address), editable; a single first location is not asked for a name; existing names never change (10.3, C3). | Owner request, 2026-11-11: search for a location exactly, see the map with every pin, and “if the user has just one restaurant we shouldn't name it”; an organization's restaurants are likely in different towns. | [CONFIRM: with one location, member pages name it by the organization's name] |
| D30 | Notes in the forecast. From the town's today on, a location's saved notes adjust its published forecast on every read (14.5): a private event with a guest count adds its guests to the day's range, a buyout (a private event, closed, now allowed a guest count) books the day, a closure closes it, and each shows as a reason labeled in code, never from its detail. Runs are never rewritten; past days, `inRange` and live accuracy stay the model's. Notes take optional local hours (12), shown in the reason; there is no hourly forecast. Home's This month (P11) and the Calendar (P27) show published forecast figures, including a day's middle figure beside its range (14.2). | Owner request (the calendar brief): a calendar with each day's predicted guests, where adding "a private event with 70 people" changes that day's forecast right away. Adjusting on read keeps frozen runs auditable and scorable, and an edit or delete shows everywhere through one function. | [CONFIRM: notes change the forecast from today on, never a past day] [CONFIRM: a buyout books the whole day] [CONFIRM: an event with hours ends by midnight on its own day] [CONFIRM: the Calendar and Home show a published forecast day's middle figure, with its range beside it; TownwiseAI, citations and the TownwiseAI landing keep ranges only] |
| D31 | Business rules. A location keeps a short list of standing facts about how it runs (“Closed Mondays”, “Brunch only on weekends”): at most 30, each one line of 1 to 200 characters, and a rule already saved in another case or spacing is refused (6.24, 10.16). Any member adds one; its author or an org admin edits or deletes it, as with notes. TownwiseAI reads them with every message the person sends: the location's current list goes into the person's stored message as a `business_rules` block whenever it differs from the last list on the conversation's path, and the conversation view never shows the block (`tuning-chat.md` section 3). A rule may carry a schedule, its forecast effect: a note's fields but the detail (kind, effect, weekdays, start and end dates, an optional guest count and hours), checked with a note's rules (12) by the same code, with an end date that may be left empty for no end ("ongoing", for a rule like “Closed Mondays”). The forecast read applies a rule's schedule from the town's today on exactly as it applies a note with those fields (14.5): its closure closes the day, its buyout books it, its private event with a guest count adds its guests, and every other schedule is listed with why it changed nothing; rules and notes on one day all apply (guests add up, and a closure from either wins). Each covering rule is a reason worded from its schedule (“Your rule: closed on Mondays”), never from its text. The lab's input reads a schedule's flags as a note's (10.15), and its more or fewer guests say a near-empty history day was open (D32). A rule without a schedule is for TownwiseAI only and never changes the forecast, and P28 says which each rule is. The `business_rules` block puts a scheduled rule's summary on its own line, so TownwiseAI knows which rules change the forecast. Rules belong to one location, go with the location and the organization, and never block deleting a location. | Owner request, 2026-11-11: “a set of rules about the business and the owner should be able to easily view and edit them”. The system prompt and tools are frozen and cached, so the rules travel in the person's message, added only when they change: unchanged rules cost nothing and keep the cached prefix, and a location with no rules sends exactly what it sent before. Schedules, owner decision 2026-11-12: “if there is a new rule, we need to support that forecasting and rationale so we don't predict something wrong on a new day”; a schedule with a note's fields reuses the note rules, the forecast read and the reasons, so a rule and a note with the same fields always do the same thing. | [CONFIRM: 30 business rules per location, 200 characters each] [DECISION NEEDED: should business rules ever be shared across an organization's locations (an organization-wide rule), or stay per location?] [CONFIRM: a rule's schedule may have no end date ("ongoing"); one with an end keeps a note's 366-day span] [CONFIRM: an Other schedule needs no details, since the rule's text says what it is] [CONFIRM: rule reasons are never cut by the six-note cap and come before the notes' in each group] |
| D32 | Likely closed. A past day whose guests are under 10% of its weekday's typical guests counts as likely closed: the restaurant was most likely shut, and the guests a staff meal or a stray check, not a very slow day. The typical guests are the median (the mean of the middle two for an even count) over the open days, those with guests above 0, among the 8 same weekdays before the day by date (the 8 weeks before it), so the line scales with the restaurant; with fewer than 3 such days there is none, and only the closed rule applies (a closure note, or an all-zero row). A note covering the day with more guests or fewer guests says it was open, so a slow storm day stays a real day; a closure note or an all-zero row keeps the day closed, never “likely”. The rule reads guests only: a day with net sales and no guest count is never likely closed, and one with 0 guests and some net sales is, given typical guests. One pure rule in `api/src/closed-days.ts`, mirrored in `client/src/portal/analytics/days.ts`, both held to the shared `day-classes.json` fixture. The forecast lab never learns from a likely-closed day: the lab input (10.15) marks it closed with no guest count, so the lab neither trains on it nor counts it as a day with guests when it finds closed weekdays and closing holidays. A likely-closed day is closed in every day class: Analytics leaves it out under “Closed days” (P24), and your history by term state (13.2) and Home's usual and past Novembers skip it. The Calendar (P27), Home's This month, its day detail and This week's past years (P11), and Analytics' day panel and heatmap label call it likely closed and keep its count (“Likely closed (1 guest recorded)”), and TownwiseAI's `get_sales_days` and `get_day` mark it `likelyClosed` (`tuning-chat.md` section 4). | Owner decision, 2026-11-12: “if there are no guests on a day maybe that day is closed so we need to factor that in correctly”, after two history days with 1 guest each showed as real, very slow days. A share of the weekday's own typical guests scales with the restaurant's size where a fixed count would not. | Decided (owner, 2026-11-12) [CONFIRM: likely closed under 10% of the typical guests, which come from the 8 same weekdays before the day by date (not the last 8 with data, so a long gap never brings back an old level) and need at least 3 of them with guests] |

D27’s controller guardrails, cited as G1 to G4: **G1**, nothing is published, by staff or by a calibration, unless staff have switched the organization’s forecasts on; **G2**, a calibration publishes only when it passes the strict gate in `api/src/lab/gate.ts`, and ties do not publish; **G3**, every published run is frozen with its training cutoff, input hash, code version and parameters, scored prospectively as later days arrive, and never overwritten; **G4**, no figure, date with a value or name in any log line or audit event, the training data stays on Townwise’s own Azure infrastructure, and the model is never sent to Anthropic.

---

## 3. Roles and permissions

| Capability | Staff | Staff in view-as | Staff open as admin (D25) | Org admin | Member | Signed in, no organization |
|---|---|---|---|---|---|---|
| Read own access state (`GET /api/me`) | yes | the target’s | the org admin’s, with `openAsAdmin` | yes | yes | yes |
| Send an access request | no | no | no | no | no | yes, in `no_org`, `rejected`, `removed` |
| Join, or decline, an organization that invited their email | no | no | no | no | no | yes, in `invited` |
| Read the organization, locations, town profiles, sales, notes, calibration | team emails, location names and towns, counts and date coverage (D7) | read-only | yes | yes | yes | no |
| Upload sales | only during setup (D23), new and replaced days | no | yes, new and replaced days | yes, new and replaced days | yes, new days only | no |
| Delete all sales for a location | only during setup (D23) | no | yes | yes | no | no |
| Add notes; edit or delete own notes | no | no | yes | yes | yes | no |
| Edit or delete anyone’s notes | no | no | yes | yes | no | no |
| Add, rename, change the town of, or delete (when empty) a location | only during setup (D23) | no | yes | yes | no | no |
| Rename the organization | any | no | the one open | own | no | no |
| Read the team | any | read-only, if the target is an org admin | no (the console) | own | no | no |
| Add emails, change roles, remove people | any | no | no (the console) | own | no | no |
| Leave the organization | no | no | no | yes, unless last admin | yes | no |
| See Townwise staff activity on the organization | audit log | read-only, if the target is an org admin | yes | yes | no | no |
| Approve or reject requests; create, rename, suspend, reactivate organizations | yes | no | no (409 until End) | no | no | no |
| See everyone across organizations; sign a person out everywhere | yes | no | no (409 until End) | no | no | no |
| Read the audit log | yes | no | no (409 until End) | no | no | no |
| Delete a person’s records, or a suspended organization’s (D22) | yes | no | no (409 until End) | no | no | no |
| Start view-as | yes | no | no (409 until End) | no | no | no |
| End view-as | yes | yes | yes (End ends open as admin) | no | no | no |
| Two-step sign-in (`/settings/security`, **Exists**) | required | not applicable | required (the staff member’s own) | optional, recommended | optional | optional |

Rules behind the matrix:

- An organization always keeps at least one active org admin. Demoting, removing or leaving as the last one answers 409 `last_admin`, for org admins and staff alike.
- A staff email can be invited like any other, but it never resolves as a member, because the staff branch runs first.
- Only the addresses in `TOWNWISE_SUPERADMIN_EMAILS` are staff. Any other address a staff member adds to an organization, a personal Gmail included, joins as an ordinary member with full member access, no banner and no time limit. That row shows “Added by Townwise staff” on Team (P17), and the add appears in the organization’s staff activity (9.3).
- Every staff action on an organization (team, name, status, view-as, setup, opening it as its admin) is recorded before it takes effect and shown to that organization’s admins (9.3). The changes staff make while open as admin (D25) are recorded after they take effect, as an org admin’s are (9.3).
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
  openAsAdmin: { id: string; org: { id: string; name: string }; startedAt: string } | null;   // D25: set while staff have
                                               // the organization open as its admin; `access` is then its org admin's
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
   4. Otherwise `self` is `staff`, with `verifiedUntil = authenticatedAt + 60 minutes`. If a grant for this `sessionId` is live by time (Section 8), resolve its target with steps 3 to 7 (never step 2). The target’s resolved organization id is the organization of its active seat (step 3, active or suspended), or null. If that id equals `grant.orgId` (null equals null), the target’s access is `effective` and the grant is returned, so `viewAs` is set. Otherwise the grant is ignored exactly as an expired one, and `effective` is `self`. An open-as-admin grant (`kind: 'open_as_admin'`, D25, Section 8a) is live by time and while its organization exists and is in setup (D23); then `effective` is that organization’s `member` access with role `org_admin`, `openAsAdmin` is set, and steps 3 to 7 do not run. Otherwise it is ignored the same way.
3. An active seat (`tw_members.activeUserId == userId`): `member` if the organization is `active`, `org_suspended` if it is `suspended`.
4. Open invitations for the user’s current email (`tw_members.inviteEmail == email`, `status: 'invited'`) in active organizations: `invited`, listing all of them.
5. A pending request by this user: `pending`.
6. The newer of the latest rejected request and the latest removed seat: `rejected` or `removed`.
7. Otherwise `no_org`.

Outside the staff branch, `self` and `effective` are the same access.

An invitation outranks a pending request, so a second employee who requested access by mistake sees their team on `/joining` as soon as an admin adds them. With a pending request, the state carries it as `pendingRequest`, and `/joining` never joins on load: the request is withdrawn only when the person presses Join, and “Not my team” deletes the invitation and returns them to Waiting (F2b).

### 4.3 Client routing

The client calls `GET /api/me` after restore, after sign-in, after join and after leave. It calls it again whenever an `/api` call answers 403 `no_access`, `forbidden`, `staff_setup_required` or `staff_reauth_required`, or 409 `view_as_active` or `open_as_admin_active`. It clears cached organization data before it re-routes. When a read of `GET /api/me` shows open as admin gone (someone joined, the organization was suspended), the client sends `POST /api/admin/view-as/end` once, with the grant id it showed, because the resolver never writes and a reactivation inside the staff window would otherwise bring the grant back.

| State | Route |
|---|---|
| `staff` | `/admin`; with `viewAs` set, the target’s route under the view-as banner; with `openAsAdmin` set, the organization admin’s route under the open-as-admin banner (D25) |
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

1. A person in `no_org` lands on `/request-access`. The form asks for organization name, their name, their role, the town (one of the twelve, or another town and state), number of locations and an optional note. The business can be found on Google Places first (10.2a), on the same page as the form (D29); the request then also carries the places the person checked, `places` (each `{ placeId, name, kind, town }`), optional (D24).
2. `POST /api/access-requests`. A unique partial index allows one pending request per user. Audit `access_request.created`, with `hasPlace`, `placeCount` and never a place id or name. [CONFIRM: a request keeps the place the requester picked; staff check it by hand]
3. `/waiting` shows what was sent, “We’ll email you when you’re approved.”, and the public profile of the town they named. [CONFIRM: town profile while waiting]

**F2b. Invited while pending.** At the next `GET /api/me` the person is `invited`, with `pendingRequest` set. `/joining` does not join on load. It names the organization and who added them, and offers “Join {org}” and “Not my team”. Join withdraws the request. “Not my team” deletes the invitation, and the request stays with staff, so an invitation the person never chose cannot skip staff review. This is also how staff place a requester into an existing organization: they add the requester’s email on that organization’s page, and the requester presses Join.

### F3. Staff approve a request

1. Staff open `/admin` (Requests, Pending) and read the request: organization, contact name and role, email (and the email at request time if it changed), town, location count, note, the place id when there is one, sent date. A warning shows when the requester already holds a seat.
2. Staff validate the person by hand, outside Townwise: for example, the email domain matches the restaurant, or a phone call. [CONFIRM: what “validated manually” means in practice]
3. “Approve” opens a dialog with the organization name and first location name, both prefilled and editable, and the town shown. The first location name starts as “{organization name}, {Town}” (D29). For a request with places, the dialog shows a Location name per place instead (prefilled “{Google name}, {Town}”, or “{organization name}, {Town}” for a street address or a place stored before places had names) with the place’s town, and “Each location needs its own name.” stops an empty or repeated name (C3).
4. `POST /api/admin/requests/:requestId/approve`, with `{ orgName, locationName }` for a request without places and `{ orgName, locationNames }` for one with them (`locationNames` in the same order and number as the places, each 1 to 80, unique by name key, 6.4; any other body is 400 `invalid_request`, before anything is written):
   1. Load the request (404 if missing). If it is `approved` with an `orgId`, skip to step 6 (a retry completes the work).
   2. If it is not `pending`: 409 `request_not_pending`.
   3. If the requester holds an active seat: 409 `requester_has_org`.
   4. Generate `orgId`. Audit `access_request.approved` with it, before the change (staff events are written first, 9.3).
   5. Compare-and-set the request from `pending` to `approved`, with `orgId`, `decidedAt` and `decidedBy`. No match: 409 `request_not_pending` (another staff member got there first), and the server writes `staff_action.not_applied`.
   6. Upsert the organization `{ _id: orgId }` with `$setOnInsert`: name, `active`, `createdAt`, `createdBy`, `fromRequestId`. Audit `org.created` on insert.
   7. Without places: upsert the first location keyed by `{ orgId, nameKey }` with `$setOnInsert`: name, the town from the request, and `placeId` null. Audit `location.created` on insert. With places (D24), while the organization is new or nobody has ever joined it (no `firstJoinedAt`, 6.1, and no member row with `joinedAt`, active or removed, as staff setup reads it): upsert one location per place the same way, with its name, the place’s town and its `placeId`, skipping places that already have a location in it, and audit `location.created` on each insert. So a retry fills only the missing ones; a retry whose name is on another place’s location answers 409 `location_name_taken`, never a merge.
   8. Insert the requester’s seat: `role: 'org_admin'`, `status: 'active'`, `userId`, `activeUserId`, `joinedAt`, `email` (the requester’s current kit email). A duplicate key in this organization counts as success. A duplicate in another organization (the requester joined elsewhere in the gap) answers 409 `requester_has_org`; the organization then exists with no admin, and its detail page shows “No admin yet”. Audit `member.joined`. [Build note: after inserting the seat, the server reads the request again. Gone means the requester was deleted meanwhile (10.7, Deletion): the seat is deleted, and, when nobody else is in it, the organization and the locations made for the request, with their names redacted as in an organization deletion; no `member.joined` is written, and the answer is 404, with `staff_action.not_applied` (`not_found`) for the approval event this call wrote.]
5. The requester sees their organization at their next `GET /api/me`, and gets the you’re in email (D14).

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
| `forecasts` | `{ on, at, by }`, or absent | whether staff have switched the organization’s forecasts on (D27, G1), when, and by which staff user id (null once that person is deleted, 10.7); absent until first switched, which reads as off. Nothing is published, by staff or by a calibration, while it is off |
| `firstJoinedAt` | Date, or absent | when someone first took a seat: set only while unset (a compare-and-set) right after the seat write of a join (F1) or an approval (F3), and by a person deletion, from the person’s earliest `joinedAt` there, before it deletes their removed seats (10.7); never cleared, so staff setup never reopens (D23). Absent on organizations nobody has joined and on documents from before the field |
| `lastSuspendedAt` | Date, or absent | when it was last suspended: set at each suspension, never cleared (a reactivation clears only `suspendedAt`), so an open-as-admin grant started at or before it is never live again (8a, D25). Absent until the first suspension, and on older documents. |

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
| `places` | `{ placeId, name, kind, town }[]` | up to 25 checked Google places in check order; ids as `placeId`, unique; `name` Google’s name as checked, 1 to 80; `kind` `'business'` or `'address'` (a street address, for a business Google does not list), `'business'` when the request left it out, and read as `'business'` when absent from a document written before it (D29; no migration); each its own town (Section 13). (D24) |
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
| `byStaff` | `true`, or absent | set only on a location staff added during setup (D23) or while open as admin (D25), whose `createdBy` is the staff user id |

Indexes: `{ orgId: 1, nameKey: 1 }` unique; `{ orgId: 1, createdAt: 1 }`. Limit: 25 per organization. [CONFIRM: 25 locations]

### 6.5 `tw_sales_days`

| Field | Type | Rule |
|---|---|---|
| `_id`, `orgId`, `locationId` | ObjectId | `orgId` and `locationId` come from the location the server read, never from input |
| `date` | `'YYYY-MM-DD'` | |
| `guests` | integer or null | 0 to 20,000 |
| `netSalesCents` | integer or null | 0 to 100,000,000 |
| `uploadId` | ObjectId | the upload that last wrote this day; for a member’s add-only upload (D16), the upload that first wrote it. A day belongs to that upload alone (D28): turning the upload off leaves the day out of every read below, with no fallback to another upload’s values |
| `updatedAt` | Date | |

Indexes: `{ orgId: 1, locationId: 1, date: 1 }` unique; `{ orgId: 1, uploadId: 1 }` (D28: the days an upload still holds, for Your data’s counts and deleting one upload). The schema is `strict: 'throw'`, and the write path builds documents field by field, so no other field can be stored.

**One read rule for “off” (D28).** `SalesDayStore.coverage`, `coverageByLocation`, `months`, `days` and `history` leave out days whose `uploadId` is a turned-off upload (6.6); `hasAny`, `hasAnyForOrg`, `ownedDayCounts` (Your data’s counts), `apply` and the deletes see every day, and `disabledDates` gives only the days that are off (TownwiseAI’s questions). Two counts outside the store also see every day, and return counts and dates only, never a figure: the found days on an import’s drop screen (`ImportStore.found`, `stores/imports.ts`) and the staff console’s day count per organization (`adminOrgStats`, `stores/cross-tenant.ts`; the same console’s per-location coverage follows the rule). Every reader of figures (Home, Analytics, Sales data, `GET /api/org`, forecast scoring, people in town, the agent panel and every TownwiseAI tool) goes through those methods, so turning an upload off is one update with no fan-out. Published forecast runs are trained off-platform (6.20) and cannot change; their live accuracy scores against days that are on. TownwiseAI’s questions (10.12) treat a turned-off upload’s dates as explained, not as gaps.

### 6.6 `tw_uploads`

`_id`, `orgId`, `locationId`, `uploadedBy` (userId), `uploadedAt`, `status` (`'applying' | 'applied'`), `dayCount`, `inserted`, `replaced`, `kept` (days a member’s upload left unchanged because they already had data; always 0 for an org admin’s), `firstDate`, `lastDate`, `hasGuests`, `hasNetSales`, and `byStaff: true` only on an upload staff made during setup (D23) or while open as admin (D25, including the file reader’s record for a file staff stored), whose `uploadedBy` is the staff user id. It holds no file name (file names can contain people’s names), no column names and no row count. Index: `{ orgId: 1, locationId: 1, uploadedAt: -1 }`. `disabledAt` and `disabledBy` (userId) are set while the upload is turned off (D28) and absent otherwise; index `{ orgId: 1, disabledAt: 1 }` (partial, on dates). A stored file's days (11A) get their own record too, written by the file reader; until this record gains a `fileId` (with the sales history work, 10.10), the link is the file's `uploadId` (6.11).

### 6.7 `tw_notes`

Fields are in Section 12, and `byStaff: true` only on a note staff wrote while open as admin (D25), whose `createdBy` is the staff user id. Index: `{ orgId: 1, locationId: 1, startDate: 1 }`. Limit: 1,000 per location. [CONFIRM: 1,000 notes] [Build note: from the calendar change (D30) a note also stores `startTime` and `endTime`, local wall-clock `HH:MM` (24-hour), each `null` by default; a note stored before them reads as null (no hours), with no backfill. The forecast reader reads the notes overlapping a window (`NoteStore.overlapping`: `startDate <= to` and `endDate >= from`, sorted by `startDate`, `createdAt`, `_id`) on the same index; no new index.]

### 6.8 `tw_view_as_grants`

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | |
| `kind` | `'open_as_admin'`, or absent | absent on a view-as grant (every grant before D25); `'open_as_admin'` on an open-as-admin grant (Section 8a) |
| `actorUserId`, `actorSessionId` | string | the staff member and their kit session id |
| `activeSessionId` | string, present only while not ended | |
| `targetUserId` | string | view-as only |
| `orgId` | ObjectId or null | view-as: the target’s resolved organization at start (4.2 step 2.4); the grant is live only while the target’s resolved organization still equals it. Open as admin: the organization opened, never null |
| `reason` | string | 5 to 200; view-as only |
| `startedAt`, `expiresAt` | Date | view-as: `expiresAt = startedAt + 30 minutes` [CONFIRM: 30 minutes]; open as admin: the end of the staff window (D2) |
| `endedAt`, `endReason` | Date or null, `'ended' \| 'replaced' \| 'expired'` or null | `expired` when the grant is cleared after `expiresAt` (Section 8) |

Indexes: `{ activeSessionId: 1 }` unique, `$type` partial (one live grant per session, across both kinds); `{ actorUserId: 1, startedAt: -1 }` (also finds a staff member’s open-as-admin grants that expired holding another session, 8a). Grants are never deleted.

### 6.9 `tw_audit_events`

Fields are in Section 9. Indexes: `{ at: -1 }`, `{ orgId: 1, at: -1 }`, `{ actorUserId: 1, at: -1 }`, `{ orgId: 1, actorRole: 1, at: -1 }` (staff activity for org admins). No TTL. The only update is the deletion redaction (9.3). [CONFIRM: keep audit events indefinitely]

### 6.10 Isolation rules

1. Every tenant document (`tw_members`, `tw_locations`, `tw_sales_days`, `tw_uploads`, `tw_notes`, `tw_files`, `tw_imports`, `tw_upload_days`, `tw_file_entries`, `tw_files_usage`) carries `orgId`. Every tenant compound index leads with `orgId`, except the two seat indexes, which are keyed by the person.
2. Tenant store functions take a branded `OrgScope` as their first argument and add `orgId: scope.orgId` to every filter, update, delete and insert. Only `api/src/access/policy.ts` can mint an `OrgScope`, and only through these seven functions:
   - `scopeOf(memberPrincipal)`: member routes (rule 3).
   - `scopeForStaffOrg(staff, orgId)`: `/api/admin/orgs/:orgId/*` (rule 5). It reads the organization first and answers 404 if it is absent.
   - `scopeForNewOrg(staff, orgId)`: approval (F3) and staff creation (F10) only, for the organization those handlers just created.
   - `scopeForJoinedInvite(invite)`: the join handler only, after its compare-and-set succeeds.
   - `scopeForClaimedImport(claim)`: the file reader only (`files/worker.ts`, 11A), for the organization of the import it just claimed.
   - `scopeForSweep(found)`: the daily file sweep only (`files/sweeper.ts`, 11A.7), for the organization of a file, an import or a blob it found.
   - `scopeForOpenAsAdmin(grant)`: the resolver only (`access/resolve.ts`), for the organization of the open-as-admin grant holding the staff session (D25, 8a).
3. Handlers on `/api/org/*` take the organization only from the principal. No member route takes an organization id from its path, query or body. In open as admin (D25), `PATCH /api/org` and `POST /api/org/locations` carry the `orgId` the page shows, which is only compared with the grant’s and refused when it differs (8a).
4. Location-scoped routes first load `{ _id: locationId, orgId }`. Another organization’s location answers 404 `not_found`, exactly like a location that does not exist. Children (sales, uploads, notes) copy `orgId` and `locationId` from that read.
5. Staff routes on `/api/admin/orgs/:orgId/*` mint a scope from the path through one function that requires the `staff` principal and reads the organization first (404 if absent).
6. Responses never include another organization’s ids or names, except the invitation list shown to its invitee.
7. Path ids are parsed with the mongo module’s `objectId` schema, so a malformed id is 400. Filter values are zod scalars. The only operators are built in code and wrapped in `trusted(...)` (**Exists**).
8. Operations keyed by a person, or spanning organizations, live in one file, `api/src/stores/cross-tenant.ts`, with a closed list: `findActiveSeat(userId)`, `findOpenInvites(email)`, `claimInvite(inviteId, email, userId)`, `declineInvite(inviteId, email)`, `latestRemovedSeat(userId)`, `adminOrgStats()`, `peopleRecords()`, `deletePersonRecords(userId, email)` (10.7, Deletion), the file reader's `claimNextImport()` (11A) and the daily file sweep's `claimFileSweep()`, `finishFileSweep()`, `sweepCandidates()`, `removeOldUploadDays()` and `existingFileIds()` (11A.7). Only `access/resolve.ts`, the join and decline handlers, the staff handlers, `files/worker.ts` and `files/sweeper.ts` import it, and a test enforces that list.
9. Stored files' blob names are ids only, `{orgId}/{locationId}/{fileId}`, built in `api/src/files/blobs.ts` from the scope's `orgId` and ids the files store already checked belong to it; no request value becomes a path. `blobs.ts` is the only file that imports the Azure SDK, and `chat/*` imports no file code (test-enforced). The one door (D28) is `ctx.items.readText`, built in `app.ts` from `files/items.ts`: TownwiseAI’s `read_data_item` reaches the text of a turned-on, `kind: 'text'` reference item through it, the first 64 KiB decoded and at most 20,000 characters, and `api/test/isolation.test.ts` pins that no `chat/*` file touches `ctx.files` or `stores.files`. A sales file is never read by a model, and a file name or title is never sent. One API identity reaches every organization's blobs, so isolation is in code and tests; the custom role keeps the API to the two client-file containers, and the private endpoint keeps the data plane off the internet.

### 6.11 `tw_files`

One row per stored file (11A). `_id` (the file id, used in blob names), `orgId`, `locationId`, `importId`, `purpose` (`'history' | 'reference'`; D28: a reference item is any file, or text pasted on Your data or kept from TownwiseAI as a `.txt` file named from its title, kept as it was sent and never read for sales), `disabledAt` and `disabledBy` (userId; set while a reference item is turned off), `addedVia` (`'townwise_ai'` when kept from a TownwiseAI card, else absent), `uploadedBy` (userId), `uploaderRole` (`'org_admin' | 'member'` at upload; decides replace or add, 11.4), `byStaff` (`true` only on a file staff stored while open as admin, D25: it reads “Townwise staff”, and the file reader records its upload as staff’s), `openAsAdminGrantId` (on such a file only, the grant it was stored under, so the reader’s `sales.uploaded` carries it in `viewAsGrantId` too), `uploadedAt`, `name` (the original file name: last path part, control characters removed, NFC, at most 255 characters; shown to the organization only, never logged, audited, put in a blob name or a URL, or sent to a model), `kind` (`'text' | 'xlsx' | 'xls' | 'pdf' | 'docx' | 'doc' | 'zip' | 'other'`), `sizeBytes`, `fingerprint` (SHA-256 over the chunk size and each chunk's SHA-256 in order, `townwise-chunks-v1:{chunkSize}:{hashes}`, so the same file uploaded again matches; it is not the file's plain SHA-256), `upload` (while uploading: `{ chunkSize, chunkCount, chunks: ({ bytes, sha256 } | null)[], head (first 8 KiB, base64), expiresAt }`; null after complete), `status` (`'uploading' | 'stored' | 'queued' | 'reading' | 'waiting' | 'read' | 'kept' | 'failed' | 'deleting'`), `outcome` (11A.6; `reference` for a reference item, shown as Kept for reference), `progress` (while reading: `{ phase, done, total, unit, phaseStartedAt, updatedAt }`), `readStartedAt`, `readMs`, `answers` (per sheet index), `uploadId`, `result` (counts and dates), `report` (11A.5), `cleanBytes`, `rawDeletedAt` (the name becomes the kind's label then, a workbook's sheet names in `report.sheets` become `Sheet 1`, `Sheet 2` and so on, and a ZIP's entry paths are cleared), `attempts`, `entries` (a ZIP's `{ total, used, kept }`, once listed), `modelCalls` and `costMicroUsd` (the AI column step's calls for this file, 11A.4), `aiChoices` (each call's answer, column indexes only, keyed by a SHA-256 of the redacted profile it was asked about, so a re-read of the same table reuses it without a call), `purgeRaw` (set by a staff purge while the file was busy, 10.7). The person's answers are keyed by sheet index, or `family:<signature>` for a family of a ZIP's tables. `strict: 'throw'`. Indexes: `{ orgId: 1, locationId: 1, uploadedAt: -1 }`, `{ orgId: 1, importId: 1, uploadedAt: 1 }`, `{ orgId: 1, locationId: 1, fingerprint: 1 }`, `{ status: 1, 'upload.expiresAt': 1 }`, `{ status: 1, uploadedAt: 1 }` and `{ purgeRaw: 1 }` (sparse) (the sweep), and `{ orgId: 1, uploadId: 1 }` with a `$type: 'objectId'` partial filter (D28: the file each upload on Your data was read from).

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

What the author did with each note, or each text item (D28), TownwiseAI proposed in their conversation (10.12). One document per proposal they acted on; none means the proposal is still open.

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | |
| `orgId`, `locationId`, `conversationId` | ObjectId | from the caller's seat and their own conversation |
| `userId` | string | the conversation's author |
| `proposalId` | string | the `propose_note` or `propose_data_item` call's id, 1 to 128 of `A-Za-z0-9_-` |
| `kind` | `'item'` | D28: set only on a `propose_data_item` call’s row, whose `noteId` is the kept file's id; absent on a note’s row |
| `status` | `'saving' \| 'saved' \| 'dismissed'` | `saving` between the claim and the note's write; reads as open |
| `noteId` | ObjectId | set when the document is inserted, a dismissed one too, so every try of a save writes the same note |
| `edited` | boolean | the saved note differs from the proposal ("Edit first") |
| `createdAt`, `updatedAt` | Date | |

Indexes: `{ orgId: 1, conversationId: 1, proposalId: 1 }` unique; `{ orgId: 1, locationId: 1 }`. It never holds the note's content or an item’s title or text. Deleted with the conversation, the location, the organization (10.7) and the author's person deletion (10.7, by `userId`); notes saved from proposals stay with the organization. Rows left by a crash during a conversation's delete, or by a Save racing it, hold only ids and go with the location, the organization or the person (`tuning-chat.md` section 5).

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

`{ orgId, day (YYYY-MM-DD, UTC), bytes, updatedAt }`, unique `{ orgId: 1, day: 1 }`. Creating an upload reserves its size with a conditional `$inc` that fails past the daily cap; canceling an unfinished upload the same day gives it back.

### 6.20 `tw_forecast_runs`

One per forecast run file staff imported for a location (14.4). Outputs and metadata only; the model never reaches the API.

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | the run id |
| `orgId`, `locationId` | ObjectId | from the staff route's organization and a location loaded with its scope |
| `metric` | `'guests'` | |
| `model` | `{ family, version, notebookCommit }` | family `hybrid_linear_xgboost \| linear_median \| weekday_median`; version `v{n}`; the `modeling/` commit |
| `trainingSource` | `'files_from_owner' \| 'townwise_lab'` | staff import accepts only `files_from_owner`; `'townwise_lab'` is set only by the lab's result callback (10.15) for a run it trained on the location's own uploaded days (D27); `'townwise_uploads'` stays reserved until the DECISION NEEDED in 14.1 is answered |
| `trainedFrom`, `dataThrough`, `madeAt` | `YYYY-MM-DD` | the first and last day of sales the model saw, and when it was made |
| `frozen` | `{ files: { name, sha256 }[] } \| null` | the frozen CSVs in `modeling/forecasts/` it was exported from |
| `interval` | `{ level: 0.8, widened }` | |
| `backtest` | `{ from, to, weeks, weeklyTypicalErrorPct, weeksOver20Pct, weeklyRangePct } \| null` | typed in from the forecasts README |
| `range`, `dayCount`, `weekCount` | | the first and last day; counts |
| `fileSha256` | string | over the file's canonical JSON |
| `lab` | `{ calibrationId, codeVersion, imageDigest, inputSha256, paramsJson } \| null` | set on a `townwise_lab` run (G3): the calibration that made it, the lab's code version, the job image digest, the hash of the input it was given and the parameters as JSON. The code version, parameters and input hash reproduce the model, which is stored nowhere. Null on an imported run |
| `status` | `'importing' \| 'draft' \| 'published' \| 'withdrawn'` | |
| `importedBy`, `publishedBy` | string \| null | staff user ids; set to null on that person's deletion; null from the start on a lab run, and on a run the lab published |
| `importedAt`, `publishedAt`, `withdrawnAt` | Date \| null | |

Indexes: `{ orgId: 1, locationId: 1, fileSha256: 1 }` unique; `{ orgId: 1, locationId: 1, status: 1, dataThrough: -1 }`; `{ orgId: 1, importedAt: -1 }`. Strict (`'throw'`). Deleted with its rows by staff, with the location, with the location's sales data and with the organization (10.7).

### 6.21 `tw_forecasts`

One row per day and per week of a run: `orgId`, `locationId`, `runId`, `span` (`'day' | 'week'`), `from`, `to` (equal for a day), `status` (a day's `open | closed | booked`; null for a week), `low`, `mid`, `high` (null on a closed or booked day), `baseline` (null unless the run recorded one), `openDays` (a week's), `reasons` (`{ kind, ref, effectPct }[]`, kind `weekday | term | event | holiday | level | closure | booking`; `ref` a town calendar id or group, kept only when it names an entry on that day). Labels are never stored. Indexes: `{ orgId: 1, locationId: 1, runId: 1, span: 1, from: 1 }` unique; `{ orgId: 1, locationId: 1, span: 1, from: 1 }`; `{ orgId: 1, runId: 1 }`. Strict (`'throw'`); rows are built field by field and upserted on their key, so a retried import writes only what is missing.

### 6.22 `tw_profiles`

The name a person gave Townwise for Home's greeting: `userId` (the kit user id, a string), `displayName` (a string or null; a null row is on purpose: “no name”), `createdAt`, `updatedAt`. Account-level, one row per person, never per organization, and read and written only for the caller's own `userId`, like `tw_access_requests`. It is not the kit's user record and not from Google. Index: `{ userId: 1 }` unique. Strict (`'throw'`); `PATCH` is an upsert with `$setOnInsert: { createdAt }`. No audit event. Deleted with the person (10.7), never with an organization.

### 6.23 `tw_calibrations`

One per calibration (D27), not per location: a retrain of one location's forecast model by the lab job. Metadata and the scorecard only; the model is stored nowhere.

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | the calibration id |
| `orgId`, `locationId` | ObjectId | from the caller's seat or the staff route's organization, and a location loaded with its scope |
| `requestedBy` | `{ userId, role, via }` | role `org_admin \| superadmin`; via `chat \| console`; `userId` null once that person is deleted |
| `regimeStart` | `YYYY-MM-DD` \| null | the first day of a lasting change in the weekly pattern the owner described |
| `status` | `'queued' \| 'running' \| 'succeeded' \| 'failed'` | `queued` until the job fetches its input, `running` until it posts its result; each change is a compare-and-set |
| `failure` | `start_failed \| timeout \| job_failed \| not_enough_history \| invalid_result` \| null | |
| `championRunId`, `runId` | string \| null | the published run it was compared with when it started, and the draft run it made |
| `dataThrough`, `inputSha256`, `imageDigest`, `codeVersion` | string \| null | the last day of sales the job was given, the hash of its input, the job image digest and the lab's code version (G3) |
| `scorecardJson` | string \| null | the scorecard as JSON (backtest weeks, metrics, the comparison with the published model); read through `lab/views.ts`, which gives staff percentages and counts only |
| `gate` | `{ published, reason } \| null` | the gate's decision (G2), set once by compare-and-set; `reason` a closed list of codes (`published`, `forecasts_off`, `champion_changed`, `too_few_weeks`, `not_better`, `coverage_out_of_band`, `weekday_bias_worse`, `not_enough_history`, `baseline_not_beaten`) |
| `chargedMicroUsd` | number | 100,000 (\$0.10) once the job has started, charged to the organization's `tw_chat_usage` month |
| `requestedAt`, `startedAt`, `finishedAt` | Date \| null | |
| `liveLocation` | ObjectId, or absent | equals `locationId` while queued or running, then removed; a unique partial index allows one live calibration per location (the `tw_imports.activeLocation` pattern) |
| `tokenSha256`, `tokenExpiresAt` | string or absent, Date | the sha256 of the 32-byte result token the input fetch hands the job, set by that fetch and removed when the calibration finishes (a token itself is never stored; the job holds no other secret, 10.15); and the end of the callback window, 20 minutes after the request |

Indexes: `{ liveLocation: 1 }` unique, partial; `{ orgId: 1, requestedAt: -1 }`; `{ orgId: 1, locationId: 1, requestedAt: -1 }`; `{ _id: 1, tokenSha256: 1 }`. Strict (`'throw'`). A live calibration older than 20 minutes is failed `timeout` by compare-and-set on the next start or read (no background loop). Deleted with the location's sales data, the location and the organization, before their runs (10.7).

### 6.24 `tw_business_rules`

A location's business rules (D31, 10.16): standing facts about how it runs that TownwiseAI reads with every message. One document per rule.

| Field | Type | Rule |
|---|---|---|
| `_id` | ObjectId | the rule id |
| `orgId`, `locationId` | ObjectId | from the caller's seat (`OrgScope`) and a location of that organization |
| `text` | string | normalized by `ruleTextOf` (`api/src/handlers/rules.ts`): NFC, every run of whitespace (newlines included) one space, trimmed; then 1 to 200 code points with no control or format character (`\p{Cc}`, `\p{Cf}`) |
| `key` | string | `text.toLowerCase()`: the duplicate check |
| `addedVia` | `'page' \| 'townwise_ai'` | how it was added; the rules route writes `page`, and nothing writes `townwise_ai` yet |
| `schedule` | object, or absent | the rule's forecast effect (D31): `{ kind, startDate, endDate, weekdays, effect, expectedGuests, startTime, endTime }`, a note's fields (6.7) but `detail`, with `endDate` null for no end; checked by `readRuleSchedule` (`api/src/handlers/notes.ts`) with a note's rules. A rule without one has no `schedule` field at all, and taking a schedule off unsets it |
| `createdBy` | string | the kit user id of its author |
| `byStaff` | `true`, or absent | only on a rule staff added while open as admin (D25), whose `createdBy` is the staff user id; shown as “Townwise staff” |
| `createdAt`, `updatedAt` | Date | |

Index: `{ orgId: 1, locationId: 1, key: 1 }` unique, which refuses a rule that differs from a saved one only in case or spacing and also serves the list and the forecast read's scheduled rules (`BusinessRuleStore.scheduled`: filtered on `orgId`, `locationId` and a `schedule` present, sorted by `createdAt`, `_id`, at most 30 rows in the query, so no other index is needed). Strict, `versionKey: false`, read from the primary, like `tw_notes`. Limit: 30 per location. [CONFIRM: 30 business rules per location, 200 characters each] No transactions: an add checks the count, inserts, then counts again and deletes its own row when the location went over 30 (change, recount, revert), so two adds racing at 29 never leave 31. Deleted with the location and the organization (10.7); rules never block deleting a location (`location_has_data` counts sales days, notes and stored files, never rules). Not deleted with a person: like a note, the rule keeps `createdBy` and shows its author as “Deleted person”. The text never reaches a log line or an audit event (9.2, 17).

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
    azure-identity.ts  managed-identity tokens for Azure services (locally, the developer's az login), cached per resource (D14; file storage too)
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

   Then the **open-as-admin guard** (D25, 8a), when the principal is in open as admin: `staff_self` passes; a route with policy `staff`, any method, answers 409 `open_as_admin_active`; a route not marked `openAsAdmin` answers 403 `open_as_admin_refused`, GETs included; a marked route goes on. So a new route stays closed in that mode until someone marks it.
5. **Policy**, evaluated on `effective` except `staff_self`:
   - `signed_in`: anyone who passed step 1.
   - `member`: `access.state === 'member'`, else 403 `no_access`.
   - `org_admin`: `member` and `role === 'org_admin'`. A member gets 403 `forbidden`; anyone else gets 403 `no_access`.
   - `staff`: passes only for a principal of kind `staff`, which never carries view-as. `staff_setup_required` and `staff_reauth_required` answer 403 with those codes. Everyone else gets 403 `forbidden`, and the staff checks run after the email check, so a non-staff caller never learns anything about staff two-step state.
   - `staff_self`: the signed-in person’s own staff gate (`self`: TOTP enabled, session created after `enabledAt`, under 60 minutes), computed before the view-as substitution. It passes for a `staff` principal and for any principal in view-as or open as admin, because a grant is live only while its actor passes that gate. Otherwise it answers exactly as `staff` does. Used only by `POST /api/admin/view-as/end`.
6. **Body parser**, `express.json({ limit })`, when the spec names a body limit. The guard and the policies never read the body, so a refused request is never parsed. The `/api` router mounts no router-wide parser, so the upload route’s 256 KB parser never widens the others (server-core: body parsing is per router, **Exists**).
7. **Route limiter**, when named (`uploads`, `requests`, `view-as`, `places`; Section 10.8; `chat` in `docs/portal/tuning-chat.md`), keyed on `acct:<userId>`.
8. The handler receives the principal. For member routes, `principal.scope` is the only organization it can use.

Boot throws if two specs share a method and path, if a GET spec names a body limit, if any route other than `view-as/end` uses `staff_self`, or if a `staff` or `staff_self` route is marked `openAsAdmin`. Paths not in the table reach server-core’s `notFound` (**Exists**).

```ts
interface StaffActor { userId: string; email: string; sessionId: string; verifiedUntil: string }
interface ViewAsContext { grantId: string; actor: StaffActor }   // the staff member doing the viewing
interface OpenAsAdminContext { grantId: string; actor: StaffActor }   // D25: the staff member with the organization open

type Principal =
  | { kind: 'staff'; actor: StaffActor }
  | { kind: 'member'; userId: string; email: string; scope: OrgScope; role: Role; memberId: string | null;   // null only in open as admin
      viewAs: ViewAsContext | null; openAsAdmin: OpenAsAdminContext | null }
  | { kind: 'other'; userId: string; email: string; access: Access; viewAs: ViewAsContext | null };
```

In view-as, `userId` and `email` are the target’s, and `viewAs.actor` is the staff member. `MeResponse.user` and `MeResponse.staff` are built from the actor whenever there is one (`actor`, or `viewAs.actor`). `view-as/end` takes the session id from `viewAs.actor.sessionId`. Audit events use the actor, and view-as writes nothing except its own start and end. In open as admin (D25), the principal is the grant organization’s org admin, with the staff member’s `userId` and `email`, `memberId` null (they hold no seat), the resolver’s scope, and `openAsAdmin.actor` the staff member; the changes it makes are recorded with actor role `superadmin` and the grant id (9.3).

### 7.3 GET is side-effect free

Every GET handler only reads (kit Security 5: GET handlers must be side-effect free). A test runs every GET route with Mongo command monitoring and fails on any `insert`, `update`, `delete`, `findAndModify` or `bulkWrite` (Section 20).

---

## 8. View-as mechanics

- **Start** (`POST /api/admin/view-as`, policy `staff`). The server validates the target: it must exist and must not be staff. Before writing `view_as.started`, it compare-and-sets every grant with `activeSessionId == ctx.sessionId`, whether or not it has expired: `$set { endedAt: now, endReason: expiresAt <= now ? 'expired' : 'replaced' }`, `$unset { activeSessionId }`, and audits `view_as.ended` for each. Under a live grant the guard has already answered 409, so this clears a grant that expired without End, or one ignored because its target changed organization. It also ends the caller’s open-as-admin grants that expired holding another session (8a, Ends); view-as grants in other sessions are left as they are. Then it audits `view_as.started` with the target user and email, organization, reason and `expiresAt`, and inserts the grant with `activeSessionId = sessionId` and `orgId` = the target’s resolved organization (4.2 step 2.4). A duplicate key that remains (two tabs starting at once) answers 409 `view_as_active`. It returns the new `MeResponse`.
- **Live grant:** `activeSessionId == ctx.sessionId`, `endedAt == null`, `expiresAt > now`, the staff gate passes on this request, and the target’s resolved organization id equals `grant.orgId` (null equals null). If any of these fails, there is no view-as for that request.
- **Effect:** the resolver runs steps 3 to 7 of Section 4.2 for `targetUserId` and returns that access with `viewAs` set. Whatever the target sees now (dashboard, Waiting, No access) is what staff see, including the target’s 403s.
- **Tracks the target’s organization.** If the target joins, leaves, is removed from or is approved into an organization while the grant runs, the grant stops being live at once, exactly as on expiry: the next `GET /api/me` returns staff access, and `/admin` shows “View-as ended at {time}.” Viewing the target again starts a new grant and writes a new `view_as.started` with the new `orgId`, which that organization’s admins see.
- **End time shown to staff:** `viewAs.endsAt = min(grant.expiresAt, staff.verifiedUntil)`, because the 60-minute staff window ends view-as too.
- **Bound to one session:** another tab of the same browser shares the session cookies, so it shares the view-as, and every tab shows the banner because every tab reads `/api/me`. A different device or browser does not share it.
- **End** (`POST /api/admin/view-as/end`, policy `staff_self`, exempt from the view-as guard). It compare-and-sets the grant holding this session, live or expired: `endedAt`, `endReason: 'ended'` (or `'expired'` when `expiresAt <= now`), and unsets `activeSessionId`. Then it audits `view_as.ended`, or `open_as_admin.ended` for an open-as-admin grant (8a). With `{ grantId }`, a grant with another id is left running. It also ends the caller’s open-as-admin grants that expired holding another session (8a, Ends). It is idempotent: with no grant on the session, and none of those, it answers 200 with the current `MeResponse` and writes nothing.
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

## 8a. Open as admin (D25)

- **Start** (`POST /api/admin/orgs/:orgId/open-as-admin`, policy `staff`, limiter `view-as`): the console’s “Open as admin” on P21, shown only while `org.inSetup`. No body and no reason. The server reads the organization (404), checks that it is in setup (409 `org_not_in_setup` once someone has joined or while it is suspended), and clears the grant still holding this session only when it is no longer live, recording `open_as_admin.ended` (`expired` or `replaced`). A live one is never replaced: the guard has already answered 409, and a grant another tab started since answers the same 409. It also ends this staff member’s open-as-admin grants that expired holding another session (Ends, below). Then it writes `open_as_admin.started` (ids only) and inserts the grant: `kind: 'open_as_admin'`, the organization, `activeSessionId = sessionId`, `expiresAt` the end of the staff window (D2). A duplicate key (two tabs starting at once) writes `staff_action.not_applied` and answers 409 `open_as_admin_active`. It returns the new `MeResponse`.
- **Live grant:** `activeSessionId == ctx.sessionId`, `endedAt == null`, `expiresAt > now`, the staff gate passes on this request, the organization exists and is in setup (D23: active, no `firstJoinedAt`, no member row with `joinedAt`), and it has not been suspended since the grant started (`grant.startedAt > org.lastSuspendedAt`, or no `lastSuspendedAt`), checked on every request. If any of these fails, the session is plain staff for that request.
- **Effect:** `GET /api/me` answers the organization’s `member` access with role `org_admin`, `openAsAdmin` set and `viewAs` null; `user` and `staff` stay the staff member’s. Requests run as that organization’s org admin, scoped to the grant’s organization, never one from the request. Only routes marked `openAsAdmin` run (7.2): every member and org admin route but those for people, seats and requests (`me.join`, `me.decline`, `me.welcome`, `requests.create`, `org.leave`, `org.members.*`), which answer 403 `open_as_admin_refused`, GETs included; Team stays in the console. Staff routes answer 409 `open_as_admin_active`, except End. A test pins the list, so a new route forces a decision.
- **One organization at a time per session.** A second start answers 409 while one is live, so a session’s other tabs never move from one organization to another between two requests. A different device or browser (another session) may hold its own.
- **A tab left on an earlier organization.** Every tab of a session shares its grant, and a tab reads `GET /api/me` only when it loads or an answer tells it to. Renaming the organization and adding a location name nothing of it in their path, so in this mode they carry the `orgId` the page shows; one naming another organization, or none, answers 409 `open_as_admin_active`, and the client reads `/api/me` again. End carries the `grantId` the page shows and then ends that grant only. Every other write names a location, note, file or conversation, which another organization answers with 404. So a tab still showing an organization that was joined or ended never writes into, or ends, the one the session has open now.
- **Ends** at End (`POST /api/admin/view-as/end`, shared with view-as), sign-out (the client’s Sign out sends End first, 15.5a), the end of the staff window (D2), a suspension, or the first join. The resolver never writes (7.3), so a suspension or a join makes the grant not live without ending it: a join for good (setup never reopens), and a suspension for good too, because the grant started at or before the organization’s `lastSuspendedAt`, which a reactivation never clears. So a reactivation inside the staff window cannot bring it back, whether or not End was ever sent. The client also sends End once when a `GET /api/me` read shows the mode gone (4.3, 15.5a), which records the end promptly; otherwise the next start or End in the session clears it. A grant that runs to the end of the staff window can no longer be ended from its own session, so the next start or End by the same staff member, from any session, ends it as `expired` and records it. The grant’s `endedAt` and its `open_as_admin.ended` carry its `expiresAt`, when it stopped working, not the time of the record, so the staff activity never shows it running past its end. Until then the organization’s staff activity shows its start without an end.
- **Record:** `open_as_admin.started` is written before the grant exists, so no open-as session is unrecorded. Changes made inside go through the org routes and are written after the effect, as an org admin’s are, with actor role `superadmin`, the staff email and the grant id in `viewAsGrantId` (9.3). What they create (locations, uploads, notes, stored files) is stored `byStaff` and reads “Townwise staff”, never the staff email (10.1). `open_as_admin.ended` is written after the grant is cleared. No log line is written per request: the organization holds only what staff put in it, and every write is audited.
- **TownwiseAI:** turns count against the organization’s monthly budget, as any admin’s do, and stop at it (409 `chat_budget_exhausted`). A saved proposal is a note by Townwise staff.
- **The name (owner call, 2026-11-10; the client stopped asking, 2026-11-11).** `GET /api/me/profile` answers `askName` for a staff member who opens an organization as admin and has no `tw_profiles` row, as for anyone (only view-as suppresses it); no screen asks for the name any more, so it comes from Settings (P18). The name saves to the staff member’s own profile, keyed by their user id (6.22), never to the organization, so it is the same name wherever they sign in as themselves. `api/test/open-as-admin.int.test.ts` pins it.
- **Your data (owner call, 2026-11-10).** The page works fully in this mode (`org.data.list`, `org.data.update` and `org.data.remove` are marked `openAsAdmin`): staff list every upload, file and item, turn them off or on, and delete them, as an org admin does. What is recorded is the audit event (`data.turned_off`, `data.turned_on`, `sales.upload_deleted`, `file.deleted`) with the staff member as actor (role `superadmin`, their email) and the open-as-admin grant id in `viewAsGrantId` (9.3), and details of ids, the item type and kind and counts only (no file name, no text). A turned-off upload’s `disabledBy` is the staff member’s user id. Items staff stored read “Townwise staff” to the organization.
- **Client:** the banner is 15.5a; the top bar has no Team, and Settings has no Leave section.

```ts
interface OpenAsAdminView {
  id: string;                                   // the grant id
  org: { id: string; name: string };
  startedAt: string;
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
| `file.uploaded` | `locationId`, `kind`, `sizeBytes`, `purpose` (`history` or `reference`), `via` (`townwise_ai` only, when the item was kept from a TownwiseAI card) |
| `data.turned_off`, `data.turned_on` | `locationId`, `item` (`upload` or `file`), `kind` (D28; target the upload or file; written after the effect, only when the state changed; never a name or title) |
| `sales.upload_deleted` | `locationId`, `deletedDays`, `deletedFiles` (D28; an org admin deleted one upload and the days it still held; target the upload) |
| `file.deleted` | `locationId`, `kind`, `reason: 'owner'` |
| `file.raw_deleted` | `locationId`, `kind` |
| `files.raw_deleted_all` | `locationId`, `count` (an org admin deleted every original of a location) |
| `org.originals_deleted` | `count`, `basis` (`data_subject_request`, `org_request` or `other`, an enum, never free text); staff, target the organization, recorded before the effect (9.3), and shown in the organization's staff activity |
| `note.created`, `note.updated`, `note.deleted` | `locationId`, `kind`, `startDate`, `endDate` |
| `rule.created` | `locationId`, `via` (`page` from the rules route; `townwise_ai` is reserved, and nothing writes it yet), `scheduled` (whether it has a schedule) (D31; target `rule`; never the rule's text or its schedule) |
| `rule.updated` | `locationId`, `scheduled` (whether it has a schedule after the edit) (D31; target `rule`; only when the text or the schedule changed; never the text or the schedule) |
| `rule.deleted` | `locationId` (D31; target `rule`; never the text) |
| `agent.question_answered` | `locationId`, `questionId` (dates and a weekday number only), `answer` (`closed`, `open` or `not_sure`); a `closed` answer's closure note is also recorded `note.created` (10.12) |
| `forecast.imported`, `forecast.published`, `forecast.withdrawn`, `forecast.deleted` | `locationId`, `modelVersion`, `from`, `to`, `dayCount` (target `forecast_run`; staff actions, written before the effect; never a figure). A publish by the lab also has `via: 'lab'` and `calibrationId`, and its actor is `system` (9.3) |
| `calibration.requested` | `locationId`, `calibrationId`, `via` (`chat` or `console`), `hasRegime` (boolean; never the date) (target `calibration`; by an org admin through TownwiseAI after the effect, by staff before it) |
| `calibration.finished` | `locationId`, `calibrationId`, `status` (`succeeded` or `failed`), `gate` (the gate's reason code), `failure` (the failure code), `runId`, `heldOutWeeks` (a count) (target `calibration`; actor `system`, written after the finish; never a figure or a date) |
| `org.forecasts_switched` | `on` (boolean) (target the organization; a staff action, written before the effect; only when the switch changes) |
| `view_as.started` | `targetUserId`, `targetEmail`, `reason`, `expiresAt` |
| `view_as.ended` | `endReason` (`ended`, `replaced` or `expired`) |
| `open_as_admin.started` | none (D25; ids only: the grant is the target and the organization the event’s `orgId`; written before the grant exists, 9.3) |
| `open_as_admin.ended` | `endReason` (`ended`, `replaced` or `expired`); written after the grant is cleared |
| `people.signed_out_everywhere` | none (written before the effect, 9.3; the revoked count is in the response) |
| `person.deleted` | `userId` (null when the address never signed in); ids only |
| `staff_action.not_applied` | `eventId` (the staff event it qualifies), `code` |

Never in an audit event: guest or sales figures, note `detail` text, a business rule's text, request notes, decision messages, a file name or anything from a file, tokens.

An event’s `orgId` is the organization it touches: for `people.signed_out_everywhere`, the target’s active organization at the time, or null; for `view_as.*` and `open_as_admin.*`, the grant’s `orgId`.

### 9.3 Rules

- **Append only, with one redaction path.** The store exposes `insert`, `query`, and `redact`, which only the deletion handlers call (10.7, Deletion). For a deleted person, `redact` replaces their email with “deleted person” in `actorEmail`, `details.email` and `details.targetEmail`. For a deleted organization, it replaces the organization’s name with “deleted organization” and its locations’ names with “deleted location” in `details.name`, `details.from`, `details.to` and `details.orgName`, in events with that `orgId` and in its request’s `access_request.created`. No other code path updates or deletes an event. [Build note: the organization’s fields are chosen by action (`org.created` name, `org.renamed` from and to, `location.*` name, the request’s `orgName`), so names from before a rename go too and `member.role_changed`’s from and to, which are roles, stay. A person’s events are also found by user id: the `actorEmail` of every event they acted in, the `details.email` of their own `member.joined`, `member.left` and `member.declined`, and the `targetEmail` of every view-as of them, whatever address they had then. And `details.email` is redacted, in anyone’s events, for every address the person is known by: the current one, those on their seats (`email`) and requests (`emailAtRequest`), read before they are deleted, and those their own events and the events about their seats hold. So other people’s `member.invited`, `member.role_changed`, `member.removed` and approval-time `member.joined` under an older address go too.]
- **When it is written.**
  - Events by org members and org admins are written after the effect succeeds. If such a write fails, the action stands, the server logs `townwise.audit_write_failed { action, orgId, targetId }` at error level, and the response is still success.
  - Every staff action’s event (actor role `superadmin`) is written before the effect, `view_as.started` and `open_as_admin.started` included, except the changes made while open as admin (below). Handlers run their read-only checks first (404, validation), then write the event, then act. If the write fails, the action is refused with 503 `unavailable` and nothing changes. If the effect then fails or is refused (for example 409 `last_admin`, or a duplicate key), the server writes `staff_action.not_applied { eventId, code }`, so the record never claims a change that did not happen. [Build note: a request with several changes (a staff rename and status change together, or several addresses added) writes all its events first, then makes its changes in one write, so a refusal never follows an applied change; an event already written when a later one is refused gets `staff_action.not_applied` with code `unavailable`. The codes are a closed list: the refusal’s error code, `conflict`, `unavailable` or `internal`.]
  - For approval and staff creation, the staff action’s event is `access_request.approved` or `org.created`; the follow-on records (`org.created` at approval, `location.created`, `member.joined`, `member.invited`) are written after their steps, as client events are.
  - The forecast lab's own events (actor role `system`, actor id `system`, shown as “Townwise forecast lab”) have no person to refuse: `forecast.published` with `via: 'lab'` is written before the publish takes effect, `calibration.finished` after the calibration is finished, each once, by compare-and-set. A refused or lost publish adds `staff_action.not_applied` with code `conflict`.
  - `view_as.ended` and `open_as_admin.ended` are written after the grant is cleared. A missing end record can only make a view look longer than it was, never hide one.
  - Changes made while open as admin (D25) go through the org routes and are written after the effect, as an org admin’s are, with actor role `superadmin`, the staff email and the grant id in `viewAsGrantId`; `open_as_admin.started` is written before the grant exists, so no open-as session is unrecorded. [CONFIRM: in-portal staff changes recorded after the effect, as an org admin’s]
  
  [CONFIRM: audit after the effect for client actions; before the effect, refused on failure, for staff actions]
- **Email writes no audit event.** Sending one of the D14 emails is a side effect of an action already audited; its event is unchanged, and nothing records the send.
- **Readers.** Staff read everything on `/admin/audit`. Org admins read every event on their own organization whose actor role is `superadmin` or `system` (view-as, team, name, status, setup writes (D23), open as admin’s starts, ends and every change made in it (D25), forecast switches, calibrations the lab finished and forecasts it published, and `staff_action.not_applied`), on Settings as “Townwise staff activity” (D9). Members read none.

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
  offDayCount: number;               // D28: days that turned-off uploads hold, which `coverage` leaves out; a count only
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

Emails shown for people (`uploadedByEmail`, `createdByEmail`, `MemberView.email` for a seat) are the current kit email, read at response time. When the kit user no longer exists, they read “Deleted person”. What staff made during setup (D23) or while open as admin (D25), uploads, notes and stored files, reads “Townwise staff”, never the staff email.

### 10.2 Access

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/me` | signed_in | | 200 `MeResponse`, with `welcome` filled for the welcome statement (15.8) | |
| `POST /api/me/join` | signed_in | `{ inviteId }` | 200 `MeResponse` | 403 `forbidden` (staff); 409 `no_invite`, `already_in_org` |
| `POST /api/me/decline` | signed_in | `{ inviteId }` | 200 `MeResponse` | 403 `forbidden` (staff); 409 `no_invite` |
| `POST /api/me/welcome` | member; `writes` only | no body | 204, idempotent (the first `seenAt` stays) | 403 `no_access`; 403 `view_as_read_only`; 429 |
| `GET /api/me/profile` | member | | 200 `{ displayName: string \| null, askName: boolean }` | 403 `no_access` |
| `PATCH /api/me/profile` | member; `writes` only | `{ displayName: string \| null }`, strict; `null` is “no name” and the answer to Not now | 200 `{ displayName, askName: false }` | 400 `invalid_request` (not a valid name, or an extra key); 403 `no_access`; 403 `view_as_read_only`; 429 |
| `POST /api/access-requests` | signed_in, in `no_org`, `rejected` or `removed` | `{ orgName, contactName, contactRole, town: TownInput, locationCount, note?, places? }`, `places` 1 to 25 of `{ placeId, name (1 to 80), kind?: 'business' \| 'address', town: TownInput }` (`kind` `'business'` when left out, D29), ids unique, `locationCount` at least `places.length` | 201 `MeResponse` (state `pending`; the request answers `places`, each `{ placeId, name, kind, town }`, `[]` when none; staff's request list answers the same) | 403 `forbidden` (staff or another state); 409 `request_exists`; 400 `unknown_town` (the request’s town or a place’s); 400 `invalid_request` (malformed places, another kind, repeated ids or a count below the places); 429 |

Only `GET /api/me` fills `welcome`; every other answer that carries a `MeResponse` (join, decline, a request, view-as start and end, leaving) carries `welcome: null`. `GET /api/me` still writes nothing (7.3): `POST /api/me/welcome` records the marker (6.15). [Build note: the route is `me.welcome`, `bodyLimit: 'none'`, no route limiter and no audit event.]

**The display name.** A name is trimmed, NFC-normalized and has inner whitespace collapsed, then must be 1 to 40 characters: letters and marks with inner spaces, hyphens, apostrophes (straight or curly) and periods, starting with a letter or mark and ending with a letter, mark or period; anything else is 400 `invalid_request`. With no row, `GET` answers `displayName` as the first name of the approved request that created the caller's organization when the caller made it (the welcome's rule, `firstNameOf`, 15.8), computed on read and never written (7.3). `askName` is true only with no row, no such name and no view-as; a stored row, even a null one, never asks again. Under view-as `GET` reads the target's name and never asks, and `PATCH` is refused by the view-as guard. [Build note: the routes are `me.profile.get` and `me.profile.update`, with `bodyLimit` `'none'` and `'1kb'` and no route limiter.]

### 10.2a Places search

Two routes let the request form (P3), Add location (P10) and Location settings (P16) find the business on Google Places (New), and a third (D29) signs one map of every checked place. The API calls Google itself, so the browser talks only to the API, except for the map images below, which it loads from Google (the CSP's `img-src` allows `https://maps.googleapis.com`). All three are `signed_in` and use the `places` limiter (10.8); autocomplete and details take a 2 KB body, the map 32 KB (25 ids of up to 512 characters).

| Method and path | Request | Success | Extra errors |
|---|---|---|---|
| `POST /api/places/autocomplete` | `{ input, sessionToken? }`, `input` 2 to 120 characters after trimming, `sessionToken` a version 4 UUID | 200 `{ suggestions, sessionToken }`, up to 5 `{ placeId, name, detail, kind }` (`detail` empty when Google has none; `kind` `'business'` or `'address'`, D29) | 400 `invalid_request`; 413; 429; 503 `places_unavailable` |
| `POST /api/places/details` | `{ placeId, sessionToken? }`, `placeId` as in 6.3, `sessionToken` a version 4 UUID, optional (without one the server makes one) | 200 `{ place: { placeId, address, town, map } }`, `town` a `TownInput` or null, `map` `{ url, width: 640, height: 320 }` or null | 400 `invalid_request`; 404 `place_not_found` (Google answered 404, or 400 `INVALID_ARGUMENT` for the id); 413; 429; 503 `places_unavailable` |
| `POST /api/places/map` | `{ placeIds }`, 1 to 25 distinct ids, each as `placeId` in 6.3 | 200 `{ map }`, `{ url, width: 640, height: 320 }` of every place, or null while the map is off | 400 `invalid_request` (empty, more than 25, a repeated or malformed id, no body); 413; 429; 503 `unavailable` (the limiter's store is down) |

- Off until `GOOGLE_PLACES_API_KEY` is set: autocomplete and details answer 503 `places_unavailable` to every request, and the client shows the manual fields. Google failing, or not answering within 5 seconds, answers the same.
- Both calls of one search carry the same session token; Google bills the typing and the pick as one session. A details call ends the session whose token it carries. A checked place after the first in one list carries none, and the server sends Google a new token, so the next autocomplete starts a new session. Without a token, autocomplete makes one and returns it. The server checks only its format and keeps no record of it.
- Autocomplete asks for US results in English, with no type filter. `name` is Google’s main text and `detail` its secondary text. D29: each suggestion's `kind` comes from Google's types: `'business'` for `establishment` or `point_of_interest` (and for a prediction without types, so nothing unclassified is lost), `'address'` for `street_address`, `premise` or `subpremise`; any other prediction (a town, county, street without a number, postal code, neighborhood or plus code) is dropped, like a query prediction, so whatever is checked is a business or an exact address. [CONFIRM: suggestion kinds read from Google's types; towns, streets and postal codes are not offered] Autocomplete also sends a `locationBias` rectangle from 40.4, -80.6 to 47.5, -66.9 (State College, PA to Bar Harbor, ME with margin) in place of Google's IP biasing, which would lean toward the API's data center; a bias, not a restriction, so a business elsewhere in the US is still found by its name, and Google is sent a fixed region, nothing about the person. [CONFIRM: the search leans toward the Northeast, where the twelve researched towns are] Details asks for the place’s id, formatted address and address components only; `address` is for display, and the client keeps the name from the suggestion it picked. `placeId` in the answer is Google’s current id for the place, which can differ from the one sent.
- `town` is one of the twelve researched towns when the locality, postal town, sublocality or `administrative_area_level_3` matches one by name and state, ignoring case, or when any of them is an alias (Lake Placid, NY is `north-elba-ny`; North Conway, NH is `conway-nh`). Otherwise it is `{ townId: null, name, state }`, named by the first of those components. It is null outside the 50 states and DC, or when no usable town name exists. [CONFIRM: the town matching rules, which are not yet checked against live Google answers]
- Nothing from these routes is stored. The typed text, place ids, addresses, Google’s answers and the signed map URL never reach a log or an audit event; a Google failure logs `townwise.places_failed { routeId, code, status, errType }`.
- `map` is a Google Maps Static image of the place for the found card: `url` is a `https://maps.googleapis.com/maps/api/staticmap` URL the API signs with `GOOGLE_MAPS_SIGNING_SECRET`, holding `GOOGLE_MAPS_STATIC_KEY`, a key restricted to the Maps Static API with unsigned requests refused. The browser or the native app loads it straight from Google, which sees the viewer’s IP address; the API never fetches, relays or keeps the image. `map` is null while either variable is unset, and a map URL is never unsigned (`api/README.md`, Places search).
- D29: the map route signs one such image of every place sent, a mint pin each. One id is exactly details' `map` (centered on the place at zoom 15); several leave out the center and zoom, so Google fits every pin, with one `markers` parameter holding the ids in the order sent. 25 ids at 512 characters stay under Google's 16,384-character URL cap. Signing is local: the route never calls Google, answers with the search off, and stores, logs and audits nothing (no id, no count, no URL).
- The request form (P3) uses the search while it is on (Places unit). Step 1 of 3, "Find your restaurants": one field ("Search for your restaurant or bar") whose suggestions come from autocomplete, debounced 250 ms, nothing under 2 characters, one call at a time, one session token per search (the API's, from the first answer). On web it is an ARIA combobox whose listbox is `aria-multiselectable`: each option shows a drawn checkbox, Down and Up move the active option, Enter and Space check or uncheck it, the list stays open, and Escape closes it; on native each suggestion is a checkbox button. Each suggestion shows its name, then its line: Google's secondary text for a business, and for a street address "Street address · " before it ("12 South Main Street" / "Street address · Hanover, NH, USA"); its box or option is named "{name}, {line}" (D29). A status line says how many places match the text searched ("3 places match “Lou”. Check each one that’s yours."), so each answer reads differently and is heard once, and "Results from Google Maps." credits Google. Checking a suggestion calls details (the first check after an answer ends that search's session with its token; a later check sends none, 10.2a) and adds the place below the field, in check order: while it loads the row says "Getting {name} from Google Maps…", then it shows the name, Google's address and the town line (one of the twelve, another town, or "Townwise works with businesses in a US town, and Google Maps puts this place in none."), with "Remove". The row and its Remove are named as its box is, by the suggestion's name and line ("Remove {name}, {line}", such as "Remove Lou’s Restaurant, Hanover, NH, USA"), since one business's locations often share a name. D29: no row has a map of its own. With at least one place checked (a loading row does not count), one map sits under the field and above the rows, wherever the checklist shows (P3, P10, P9's first location, P21's staff setup): the map route's image of every checked place, a mint pin each, full width up to 640 at 2:1, named "Map of {name}" for one place and "Map of your {n} places" for several. It is asked for 400 ms after the checked set last changed (a check, a Remove), with the ids sorted so the same set is the same URL, and a set seen before in that checklist is not asked again; the last map stays while the next is asked. It never takes or moves focus, and sitting under the field it never moves the field or its open list. With nothing checked, the map off, the map route refused (429, 503, the network) or the image failing to load, there is no map and no error line: the rows carry the information. A place outside a US town cannot be checked, and a line names it and says why; a 503 leaves it unchecked with "Google Maps isn’t answering right now, so you can enter your restaurant yourself."; a lost place says "Google Maps can’t find that place any more. Search again, or enter it yourself." Searching again keeps the checked places. At 25 checked (an organization's location limit) the other boxes are disabled and "You can add up to 25 places." appears. Under the places, "From Google Maps. Townwise keeps Google’s id for each place, its name and its town, not the address or the map." [CONFIRM: Townwise keeps each checked place's Google name] D29: P3 is one screen, with no Continue. Under the checklist, the text link "Can't find it? Enter your town yourself"; directly below it on the same page, Step 2 of 3, "About you": the form with the checked places in place of Town, Organization name showing the first checked business's Google name (cut to 120) until the person types in it (a street address never fills it), and Send request, which sends `places` (each place's id, name cut to 80 characters, kind and town) with the first place's town as the request's town. Number of locations follows the checked count live: the larger of the number the person typed and the places checked, and sending a typed number below the checked count says "You checked {n} places, so enter at least {n}." Send with nothing checked says "Check your restaurant above, or enter your town yourself." under the checklist and sends nothing, and Send is disabled while a checked place is loading. "Can't find it? Enter your town yourself" hides the checklist, shows Town in the form and moves focus to it; "Search Google Maps instead" brings the checklist back with its places still checked and moves focus to the search field. There is no summary of the places and no "Change places". The client learns whether the search is on by sending autocomplete `{}`: 503 `places_unavailable` is off, 400 `invalid_request` is on, and Google is not called. While off, under view-as (nothing is sent), for a rejected request (its answers are filled in) and after a 503 during the search (with "Google Maps isn't answering right now, so you can enter your restaurant yourself."), the form is as it is without the search. Step 3 is the history upload after approval.

### 10.3 Organization and locations

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org` | member | | 200 `{ org: { id, name }, role, locations: LocationSummary[], requestedLocationCount: number \| null, placeSearch: boolean }` (`placeSearch`: the Places search is on, 10.2a) | |
| `PATCH /api/org` | org_admin | `{ name, orgId? }`; `orgId`, the organization the page shows, is required in open as admin (D25, 8a) | 200 `{ org }` | 409 `open_as_admin_active` (open as admin, another or no `orgId`) |
| `GET /api/org/staff-activity?before=` | org_admin | `before` (optional, ISO time): the `nextBefore` of the page before | 200 `{ events: StaffActivityView[], nextBefore: string \| null }`: a page of 50 events on this organization whose actor role is `superadmin`, newest first, before `before` when given; a page also carries every event sharing its last event’s time, and `nextBefore` (that time) reads the next older page, null when there is none (D25 makes every change in open as admin a staff event, so the oldest are a page away, never gone) | 400 `invalid_request` (`before` not an ISO time) |
| `POST /api/org/leave` | member | `{}` | 200 `MeResponse` | 409 `last_admin` |
| `POST /api/org/locations` | org_admin | `{ name, town: TownInput, placeId?: string \| null, orgId? }` (`orgId` as `PATCH /api/org`) | 201 `{ location: LocationSummary }` | 409 `location_name_taken`, `location_limit`, `open_as_admin_active` (as `PATCH /api/org`); 400 `unknown_town`; with a `placeId`: 400 `unknown_place`, `place_not_supported`, `place_town_mismatch`; 429; 503 `places_unavailable` |
| `PATCH /api/org/locations/:locationId` | org_admin | `{ name?, town?, placeId?: string \| null }`, at least one; a `placeId` needs `town`; null takes the place off | 200 `{ location }` | 404; 409 `location_name_taken`; with a `placeId`: as `POST` |
| `DELETE /api/org/locations/:locationId` | org_admin | | 204; its business rules go with it (6.24) | 404; 409 `location_has_data` (any sales day, note or stored file; business rules never block it) |

[CONFIRM: org admins can rename their own organization]

A location's Google place (Places unit; P10, P16 "Change this location's place"): the API asks Google for the place (Place Details, a session of its own) and takes its town with the 10.2a rules; the town sent must be that town (one of the twelve by id, another by name ignoring case and by state), else 400 `place_town_mismatch`. Google not knowing the place is 400 `unknown_place`; outside the 50 states and DC or with no town, 400 `place_not_supported`; the search off or Google failing, 503 `places_unavailable` (`townwise.places_failed` with the route id). Each write with a place spends one call of the account's `townwise:places` budget (10.8) before Google is asked: used up, 429 `rate_limited`; its store down, 503 `places_unavailable`. A write without a place spends none. The location stores Google's current id and the place's town, nothing else. A town changed by hand takes the place off; a rename or the same town keeps it. `location.created` and `location.updated` add `hasPlace`, never the id. P10 and P16 offer the search only while `placeSearch` is true and never under view-as; P10 starts with the places checklist ("Search Google Maps for the location", helper "Type its name or street address. Google Maps suggests places in the US.", each checked place with a Name, and "Can't find it? Enter it yourself"). D29: a Name starts as "{Google name}, {Town}" ("Sawtooth Kitchen, Hanover"), or "{Organization name}, {Town}" for a street address; the town is not repeated when the name already holds it as a whole word ("Hanover Inn"), and the name is cut so the town stays within 80 characters. While the organization has no location yet (and the form has added none), a single checked place has no Name field and is sent with that default, and "Enter it yourself" shows Town alone and names the location "{Organization name}, {Town}"; a second checked place shows Name on every row, and a name the API refuses as taken (someone added one meanwhile) shows Name with the name sent. Existing locations are never renamed; "Add location" or "Add {n} locations" sends one `POST` per checked place, in order, each spending its own call, and each row then says how it went (P10): a 503 says "Google Maps isn't answering right now, so the place wasn't added. Check the town, then add the location without it." on its row and stops the rest. Focus follows the steps: opening P16's search moves it to the field and closing it (Cancel, Use this place, or a refusal) to the line that says whether the location is linked. P16's section says whether the location is linked, finds a place with "Use this place" (with "Using this place moves {name} to {town}." when the town changes) and answers "Saved."; its Town field says "Changing the town here takes the Google Maps place off this location." while linked.

### 10.4 Sales

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/sales` | member | | 200 `{ coverage, uploadsOff, calibration, months: { month: 'YYYY-MM'; dayCount; guests: number \| null; netSalesCents: number \| null }[], uploads: UploadView[] }` (newest 20 uploads) | 404 |
| `GET /api/org/locations/:locationId/sales/days?from=&to=` | member | dates `YYYY-MM-DD`, `from <= to`, span at most 366 days | 200 `{ days: SalesDay[] }` | 400; 404 |
| `GET /api/org/locations/:locationId/sales/history` | member | | 200 `SalesHistory` (10.10): every stored day, oldest first, each upload with the stored file it was read from | 400; 404 |
| `POST /api/org/locations/:locationId/sales/uploads` | member, 256 KB, limiter `uploads` | `{ days: SalesDay[] }` (Section 11.3) | 201 `{ upload: UploadView, coverage, calibration }`; a member’s upload adds new days only (11.4) | 400; 404; 413; 429 |
| `DELETE /api/org/locations/:locationId/sales` | org_admin | | 200 `{ deletedDays, deletedUploads, deletedFiles }`: with the days and upload records go the location's stored files (11A), forecast runs (6.20, 6.21) and answers to TownwiseAI's questions (6.17); notes stay, closure notes saved from answers included | 404; 409 `import_running`; 503 `files_unavailable` (10.9) |

Month sums run over the days that have a value. A month whose days have no guest counts returns `guests: null`.

`uploadsOff` (here and on `SalesHistory`, 10.10) is true when `coverage.dayCount` is 0 and a turned-off upload (D28) still holds at least one day at the location, so every upload holding days is off. The client then says the uploads are turned off and points to Your data instead of “No sales history yet”. It is a boolean only: no count, date or upload id. A location with no stored day at all answers false.

### 10.5 Notes

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/notes` | member | | 200 `{ notes: Note[] }`, sorted by `startDate` | 404 |
| `POST /api/org/locations/:locationId/notes` | member | `NoteInput` | 201 `{ note }` | 404; 409 `note_limit` |
| `PATCH /api/org/locations/:locationId/notes/:noteId` | member (author or org admin) | `NoteInput` (full replace) | 200 `{ note }` | 403 `forbidden`; 404 |
| `DELETE /api/org/locations/:locationId/notes/:noteId` | member (author or org admin) | | 204 | 403 `forbidden`; 404 |

[Build note: from the calendar change (D30) a `NoteInput` body (body limit `32kb`, unchanged) also takes `startTime?: string | null` and `endTime?: string | null` (Section 12); a missing value reads as null, so older clients keep working. A body breaking the hours rules or the buyout guest rule is 400 `invalid_request`, as any other invalid body. `Note` carries both. The audit details of `note.created`, `note.updated` and `note.deleted` are unchanged: no hours, guests or detail.]

### 10.6 Team

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org/members` | org_admin | | 200 `{ members: MemberView[] }` (active and invited) | |
| `POST /api/org/members` | org_admin | `{ emails: string[] (1 to 20, each up to 320 characters), role }` | 200 `{ results: AddResult[], members: MemberView[] }` | 409 `member_limit` (200 active plus invited) |
| `PATCH /api/org/members/:memberId` | org_admin | `{ role }` | 200 `{ member }` | 404; 409 `last_admin` |
| `DELETE /api/org/members/:memberId` | org_admin | | 204 | 404; 409 `last_admin` |

### 10.7 Staff console

Every route here has policy `staff`, except `view-as/end`, which has `staff_self` and is the only one that runs during view-as (7.2) or while staff have an organization open as its admin (D25); it ends either. During view-as every other route here answers 409 `view_as_active`, and while open as admin 409 `open_as_admin_active`.

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
| `POST /api/admin/orgs/:orgId/open-as-admin` (D25) | none (no body is parsed) | 201 `MeResponse`: the organization’s admin access, with `openAsAdmin` set | 400; 404; 409 `org_not_in_setup`, `open_as_admin_active`, `view_as_active`; 429; 503 |
| `GET /api/admin/orgs/:orgId/forecast-runs` | | 200 `{ runs }` (14.4), newest import first, at most 100 | 404 |
| `POST /api/admin/orgs/:orgId/locations/:locationId/forecast-runs` | a run file (14.4), up to 256 KB | 201 `{ run }` (draft); 200 `{ run }` for a file the location already has | 400 `invalid_forecast_file` `{ issues: { path, code }[] }`; 404 |
| `POST /api/admin/orgs/:orgId/forecast-runs/:runId/publish` | `{}` | 200 `{ run }` | 404; 409 `forecast_run_not_draft`, `forecasts_off` (the organization's forecasts switch is off, D27) |
| `GET /api/admin/orgs/:orgId/calibrations` | | 200 `{ forecasts: { on, at }, calibrations }`, the newest 50 (a live one past 20 minutes failed `timeout` first), each `{ id, locationId, status, failure, failureWords, via, requestedByRole, regimeStart, requestedAt, startedAt, finishedAt, runId, chargedUsd, gate: { published, reason, words } \| null, summary }`, `summary` the scorecard as percentages and counts only (weeks, weekly WAPE, the current model's, the 80% range's weeks inside, weekday bias), never a guest figure (D7) | 404 |
| `POST /api/admin/orgs/:orgId/locations/:locationId/calibrations` | `{ regimeStart?: date }` | 201 `{ calibration }`, running | 400 `invalid_regime_start`; 404; 409 `calibration_in_progress`, `not_enough_history`, `chat_budget_exhausted`; 429 `calibrations_rate_limited`; 503 `lab_unavailable`, `lab_start_failed` |
| `POST /api/admin/orgs/:orgId/forecasts-switch` | `{ on: true, ownerAgreed: true }` or `{ on: false }` | 200 `{ forecasts: { on, at } }`; the switch already in that position changes and records nothing; switching off leaves published runs as they are | 400; 404 |
| `POST /api/admin/orgs/:orgId/forecast-runs/:runId/withdraw` | `{}` | 200 `{ run }` | 404; 409 `forecast_run_importing` |
| `DELETE /api/admin/orgs/:orgId/forecast-runs/:runId` | | 204 | 404 |
| `GET /api/admin/people?kind=` | | 200 `{ people: PersonView[], truncated: boolean }` (up to 1,000) | |
| `GET /api/admin/people/lookup?q=<exact email>` | | 200 `{ person: PersonView \| null }` | |
| `POST /api/admin/people/:userId/sign-out-everywhere` | `{}` | 200 `{ revoked: number }` | 400 `invalid_target` (staff); 404 |
| `POST /api/admin/people/delete` | `{ email }` (in the body, never the path, because `url` is logged) | 200 `{ deletedRequests, deletedSeats, redactedEvents, kitUserId: string \| null }` | 400 `invalid_target` (staff); 404 (no kit user and no Townwise record); 409 `person_has_seat` |
| `GET /api/admin/audit?orgId=&actorUserId=&action=&before=&limit=` | `limit` 1 to 200, default 50; `before` an ISO time | 200 `{ events: AuditEventView[], nextBefore: string \| null }` | |
| `POST /api/admin/view-as` | `{ userId, reason }` | 201 `MeResponse` | 400 `invalid_target`; 404; 429 |
| `POST /api/admin/view-as/end` | `{ grantId? }` | 200 `MeResponse`; ends view-as or open as admin, whichever holds the session; with `grantId`, only that grant (8a). Also ends, as `expired` at their `expiresAt`, the caller’s open-as-admin grants that expired holding another session | |

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
  3. Through `deletePersonRecords(userId, email)` (6.10 rule 8): delete the person’s access requests (by `userId`), their open invitations in every organization (`inviteEmail == email`), and their removed seats (`userId`, `status: 'removed'`). [Build note: also their tuning chat conversations, live turns and TownwiseAI proposal records in every organization (`tw_chat_conversations`, `tw_chat_live_turns`, `tw_chat_proposals`, by `userId`), which postdate this list (`tuning-chat.md`), and their welcome markers in every organization (`tw_welcomes`, by `userId`, 6.15; not counted in the answer), and their display name (`tw_profiles`, by `userId`, 6.22; not counted either). Notes they saved from proposals stay, as every note does. The 404 in step 1 counts audit events as Townwise records, because the audit log keeps an address until its person is deleted (Section 17).]
     [Build note: and set `importedBy` and `publishedBy` to null on the forecast runs the person imported or published (6.20), in every organization.]
     [Build note: and, for the forecast lab, set `requestedBy.userId` to null on the calibrations the person started (6.23) and `forecasts.by` to null on the organizations whose forecasts switch they last set (6.1), in every organization; the switch itself stays as it is.]
     [Build note: before the removed seats go, each organization one of them joined that has no `firstJoinedAt` gets it, from the person’s earliest `joinedAt` there (6.1), so the deletion never reopens staff setup (D23).]
  4. When a kit user exists: call `revokeAllSessions(userId)` and `authStores.totp.remove(userId)` (both public, **Exists**).
  5. `redact` the email in the audit log (9.3).
  6. Answer the counts and `kitUserId`. The kit’s user record and its revoked session records are then deleted by hand, as a runbook step, because the kit has no user delete (Section 19, item 7). Until then, the person can still continue with Google, and they resolve to `no_org`.
  
  Notes and uploads the person wrote stay with their organization; the author shows as “Deleted person” once the kit user is gone. View-as grants keep only ids and the staff-written reason.
- **Delete an organization** (`DELETE /api/admin/orgs/:orgId`). The organization must be suspended first (409 `org_not_suspended`), so its members have already seen the paused page.
  1. Audit `org.deleted` with ids only.
  2. Through `scopeForStaffOrg`: delete its `tw_sales_days`, `tw_uploads`, `tw_notes`, `tw_locations` and `tw_members`, and its access request (`fromRequestId`). [Build note: also its `tw_chat_conversations`, `tw_chat_live_turns`, `tw_chat_usage` and `tw_chat_proposals`, which postdate this list (`tuning-chat.md`), and its `tw_welcomes` (6.15), `tw_agent_answers` (6.17), `tw_forecast_runs` and `tw_forecasts` (6.20, 6.21), and `tw_business_rules` (6.24, D31). The response keeps the six counts above.]
  3. `redact` its name and its locations’ names in the audit log (9.3).
  
  [Build note: stored files (11A) go first, before any other record: its imports, every unfinished upload discarded (its staged chunks dropped at once), every blob under `{orgId}/` in both containers, its `tw_file_entries`, `tw_files`, `tw_upload_days` and `tw_files_usage`. When stored files are off but the organization has file rows, nothing is deleted and the answer is 503 `files_unavailable`, recorded as `staff_action.not_applied` (`files_unavailable`), so blobs are never left behind silently. After the row goes, its stored files are swept once more (a reader mid-file can write a cleaned copy late), and the daily sweep's orphan check catches anything later still. Logged as `townwise.org_files_deleted { orgId, deletedFiles, deletedBlobs }`; the response keeps its six counts.]
  4. Delete the `tw_orgs` row last, so a retry still finds the organization. [Build note: the delete matches `status: 'suspended'`, so an organization reactivated during the deletion keeps its row and the answer is 409 `org_not_suspended`, recorded as `staff_action.not_applied`; the records already deleted stay deleted, and suspending it and deleting again finishes. After the row goes, its `tw_sales_days` and `tw_chat_usage` are swept once more, since an upload or a tuning chat turn in flight can upsert after the first sweep; the late days count in `deletedDays`. This narrows the gap without closing it: a chat turn started before the suspension can still add chat usage for up to 150 seconds, an upload still running can write days after the second sweep, and its `tw_uploads` row, if written after the first sweep, is never swept. Forecast runs and their rows are swept then too, since a staff import already past its organization check can still write them.]
  
  Former members then resolve to `no_org`. View-as grants keep only ids.
- **Purge an organization's originals** (`POST /api/admin/orgs/:orgId/originals/delete { basis }`). For a person's deletion request about someone named inside an export (a diner, a server): their details exist only in the original files (and possibly in a file's name, a ZIP's entry paths or a workbook's sheet names, all cleared with the original), never in the cleaned copies, the rest of the reports or the days. Staff delete the originals without reading them. The read-only check counts the originals; the event `org.originals_deleted { count, basis }` is recorded first; then each original is deleted, its name replaced by the kind's label and its entry paths cleared. A file not read yet (stored, queued, or waiting on a question, which is dropped so its import can finish) is first kept unread with the outcome `raw_deleted`, so the reader never reads it. A file still uploading or being read is flagged (`purgeRaw`): the reader never reads a flagged file, and its original goes as soon as the upload or the read ends; the daily sweep finishes any it missed. The event's `count` is every original found; the answer's `skippedBusy` counts the flagged ones. The cleaned copies, reports and days stay. A reference item (D28) is its original, so its content goes too and only its row is left, named by its kind.
- **A person's own deletion** (above) leaves the files they uploaded with their organization, as uploads and notes; the uploader shows as “Deleted person”.

[DECISION NEEDED: retention periods. The mechanism above exists in v1; how long each record is kept before staff delete it is still open (Section 17).]

### 10.8 Rate limits

Built with the rate-limit module and keyed on `acct:<userId>`, a key the caller cannot rotate. The module stores each key as a SHA-256 hash (**Exists**). The kit’s per-IP ceiling (**Exists**, 2,000 per minute) still applies first. `townwise:writes` runs right after `requireAuth` (7.2 step 2), so refused writes count; the others run after the policy. [CONFIRM: limits]

| Name | Applies to | Limit | When Redis is down |
|---|---|---|---|
| `townwise:writes` | every non-GET `/api` route, before access is resolved | 300 per 10 minutes | allow |
| `townwise:uploads` | the member upload route (staff setup’s carries only `townwise:writes`, as every staff write does) | 30 per hour | allow |
| `townwise:requests` | `POST /api/access-requests` | 5 per day | deny (503 `unavailable`) |
| `townwise:view-as` | `POST /api/admin/view-as` and `POST /api/admin/orgs/:orgId/open-as-admin` together | 20 per hour | deny (503 `unavailable`) |
| `townwise:places` | the three Places routes together (10.2a); each location write with a `placeId` also spends one (10.3) | 300 per hour | deny (503 `unavailable`; on a location write, 503 `places_unavailable`) |
| `townwise:calibrations` | starting a calibration, from TownwiseAI or the console, per organization | 4 per day [CONFIRM] | deny (429 `calibrations_rate_limited`, as when the 4 are used; `start_calibration` answers `rate_limited`) |
| `townwise:files` | `POST .../files` (10.11), `POST .../data/text` and the item-proposal `POST` (keeping text TownwiseAI proposed, or setting the card aside) (10.14), together | 120 per hour | allow |
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
| 403 | `forbidden` | role too low, not staff, not the note’s or business rule’s author | re-read `/api/me`; hide the control |
| 403 | `staff_setup_required`, `staff_reauth_required` | staff gate | route per 4.3 |
| 403 | `view_as_read_only` | a non-GET without the `staff` policy during view-as | should not happen: controls are disabled |
| 403 | `open_as_admin_refused` | a route that does not run while staff have an organization open as its admin (D25): people, seats and requests | should not happen: Team and Leave are hidden |
| 404 | `place_not_found` | the details route: Google has no such place (10.2a) | the client keeps the manual fields |
| 400 | `unknown_place`, `place_not_supported`, `place_town_mismatch` | a location write with a `placeId` (10.3): Google has no such place, it has no US town, or the sent town is not its town | “Google Maps answered differently this time.”, then the search again |
| 404 | `not_found` | unknown id, or an id in another organization | “This {thing} isn’t available.” with a way back |
| 409 | `view_as_active` | any route with the `staff` policy, any method, during view-as; a second view-as start racing the first | re-read `/api/me` |
| 409 | `open_as_admin_active` | any route with the `staff` policy, any method, while open as admin (D25); a start racing another start of the same session; a rename or new location naming another organization than the one open, or none (8a) | re-read `/api/me` |
| 409 | `no_invite`, `already_in_org`, `request_exists`, `request_not_pending`, `requester_has_org`, `last_admin`, `location_name_taken`, `location_limit`, `location_has_data`, `note_limit`, `member_limit`, `person_has_seat`, `org_not_suspended`, `org_not_in_setup`, `rule_limit`, `rule_exists` | as in the tables (the last two, business rules: 10.16) | inline copy per page |
| 409 | `forecasts_off`, `calibration_in_progress`, `not_enough_history`, `chat_budget_exhausted` | publishing while the organization's forecasts are off; a calibration already live for the location; fewer than 595 days of history; the month's TownwiseAI budget spent (10.7) | the console says why |
| 400 | `invalid_regime_start`, `invalid_lab_result` | a pattern-change date outside the history or less than 8 weeks before its last day; a lab result that fails its checks, with `issues: { path, code }[]` (10.15) | the console says why; the job logs the code |
| 429 | `calibrations_rate_limited` | the organization's 4 calibrations a day, or the limiter's store is down (10.8) | “This organization has started 4 calibrations in the last day. Try again tomorrow.” |
| 503 | `lab_unavailable` | `TOWNWISE_LAB_RUNNER` is `off` (10.7) | “Calibration isn’t available right now.” |
| 503 | `lab_start_failed` | the job could not start (10.7) | “The calibration couldn’t start. Try again in a few minutes.” |
| 503 | `lab_auth_unavailable` | the lab callback, while Entra's signing keys cannot be fetched (10.15) | none: only the lab job sees it, and retries its result once |
| 413 | `payload_too_large` | server-core | unreachable from the app (Section 11.3) |
| 415 | `unsupported_media_type` | server-core | client bug |
| 429 | `rate_limited` | Section 10.8, with `retryAfterSeconds` | “Too many attempts. Try again in {minutes} minutes.” |
| 500 | `internal` | server | “Something went wrong on our side. Try again in a minute.” |
| 503 | `places_unavailable` | Places autocomplete or details while the search is off, or Google failed or timed out (10.2a); a location write with a `placeId` for the same reasons, or while the `places` limiter’s store is down (10.3) | the client shows the manual fields |
| 503 | `unavailable` | a deny-when-down limiter, a store outage, or a staff action whose audit write failed (9.3) | “Townwise isn’t responding. Try again in a minute.” |
| 400 | `purpose_unavailable` | `POST .../files` with a purpose other than `history` or `reference` (10.11) | client bug |
| 403 | `view_as_no_download` | a file download during view-as | controls are hidden |
| 404 | `no_clean_file` | the cleaned-copy download of a file that produced no days | the button is hidden |
| 404 | `no_entries` | the entries list of a file that is not a ZIP | client bug |
| 409 | `import_full`, `too_many_uploading`, `storage_full`, `daily_upload_limit`, `file_not_uploading`, `chunks_missing`, `file_duplicate`, `file_busy`, `import_not_open`, `import_empty`, `question_stale`, `import_running`, `item_busy` | the stored-files routes (10.11), deleting a location's sales data while one of its files is being read (`import_running`), and turning an item off or on while Townwise is still reading it (`item_busy`, Your data, 10.14); `storage_full` carries `storedBytesLeft`, `daily_upload_limit` `resetsAt`, `chunks_missing` `missing`, `file_duplicate` `fileId` | words per code in the files module |
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
  uploadsOff: boolean;                 // D28: no day shows because every upload holding days is turned off (10.4)
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
| `org.files.create` | `POST /files` | member | 2 KB `{ name, sizeBytes, purpose: 'history' \| 'reference' }` | `files` |
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

A `reference` file (D28, 10.14) takes the same chunks and caps but joins no import and is never read for sales: `complete` sets it `kept` with outcome `reference`.

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

**Feedback.** The author rates a reply with `POST /api/org/locations/:locationId/chat/:conversationId/feedback/:nodeId { rating: 'up' | 'down' | null, reason? }` (`org.chat.feedback`, member, body `1kb`, `writes` only): `null` clears it, `reason` is one of six fixed values and goes only with `down`, and `nodeId` must be a reply of the caller's conversation on any branch (else 404). It is stored in the conversation document as an enum and a time, never text, shown in the conversation view (staff in view-as read it, and the guard refuses the write), and logged as `townwise.chat_feedback { orgId, rating, reason }`; no audit event.

**Versions.** A conversation is a tree of the person's messages and TownwiseAI's replies (`tuning-chat.md` sections 2, 3 and 5). Edits and regenerates are turns on `POST /api/org/locations/:locationId/chat/turns` (`org.chat.turn`): an edit sends `parentId`, the edited message's parent (null for the first message), and a regenerate sends `{ conversationId, replyTo }` for a new reply to the person's message `replyTo`. So each one takes the live-turn claims, counts toward the 40-turn and 1.5 MB caps (every branch counts), is checked against the monthly budget and spends `townwise:chat` and `writes`, and each sends the model only its own path, byte for byte. `POST /api/org/locations/:locationId/chat/:conversationId/active { nodeId }` (`org.chat.active`, member, body `1kb`, `writes` only) stores the newest leaf under that node as the version shown and answers the conversation as `GET .../chat/:conversationId` does; `PATCH /api/org/locations/:locationId/chat/:conversationId { title }` (`org.chat.rename`, member, body `1kb`, `writes` only; trimmed, 1 to 60 characters, no control characters) answers `{ id, title }`. Neither moves the conversation in the list, records an audit event or logs; an unknown node or another person's conversation is 404, and under view-as `?node=` reads any version while the guard refuses both.

**Keeping text (D28).** `GET` and `POST /api/org/locations/:locationId/chat/:conversationId/item-proposals/:proposalId` (`org.chat.item_proposal.get`, `org.chat.item_proposal`, member, body `2kb`, `writes` and, on the POST, `files`, the budget Paste text uses) are the card of a `propose_data_item` call: GET shows `{ proposal: { id, title, text, status, item } }` (a read that writes nothing and logs nothing), POST `{ action: 'save' }` keeps the text and `{ action: 'dismiss' }` sets it aside. Save writes exactly the text of the stored call, never text from the request, as a `.txt` reference item added via TownwiseAI (6.11), claiming the proposal first (6.16) so a retry or a second tab ends with one item; it answers 503 `files_unavailable` while stored files are off. Only the conversation’s author reaches it; anything else is 404. Contract: `docs/portal/tuning-chat.md` section 2.

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

[Build note: from the calendar change (D30) the forecast read includes the location's notes from the town's today on (14.5). Each `ForecastDayView` adds `model: { status, low, mid, high }` (the run's own figures, always present, equal to the day's when no note changed it), `noteGuests` (the guests notes add on an open day, or the buyouts' party on a booked day; 0 when none) and `moreNotes` (note reasons past the first 6, still counted). A reason is `{ kind: ReasonKind | 'note', label, effectPct, sources, note: { id, guests, outcome } | null }`: `note` is null on the run's reasons, and a note's reason has `effectPct` null and `sources` empty. A `ForecastWeekView` adds `noteGuests`. The status codes are unchanged, and the read still logs and stores nothing.]

### 10.14 Your data

The list and the actions of P26 (D28). All members; view-as lists with names hidden and is refused every write (403 `view_as_read_only`); every non-GET also passes `townwise:writes`. Another organization’s location or item answers 404, exactly like an unknown one. Names travel only in JSON bodies, never in a path, a log line or an audit event. The full table, with each route’s errors, is `api/README.md` (Your data).

| id | Method and path | Who | Body | Limiter |
|---|---|---|---|---|
| `org.data.list` | `GET /api/org/data?locationId=&after=` | member | | |
| `org.data.update` | `PATCH /api/org/locations/:locationId/data/:ref` | the person who added it or an org admin | 2 KB `{ enabled }` | |
| `org.data.remove` | `DELETE /api/org/locations/:locationId/data/:ref` | an upload: org admins; a file: the person who added it or an org admin | | |
| `org.data.text` | `POST /api/org/locations/:locationId/data/text` | member | 32 KB `{ title, text }` | `files` |
| `org.chat.item_proposal.get` | `GET /api/org/locations/:locationId/chat/:conversationId/item-proposals/:proposalId` | the conversation’s author | | |
| `org.chat.item_proposal` | `POST` the same path | the conversation’s author | 2 KB `{ action }` | `files` |

- `ref` is `u_` plus an upload’s id or `f_` plus a stored file’s id. The list merges `tw_uploads` and the `tw_files` rows that wrote no days (a stored file that wrote days shows once, as its upload, with its file’s actions), newest first by time and id, 100 a page, with `next` as the cursor `<ISO time>_<24 hex id>`. Each item has its kind (`daily_totals` or a file kind), how it arrived (`browser`, `file`, `staff`, `townwise_ai`), who added it (a current email, “Townwise staff” or “Deleted person”), its size, `enabled`, its state, its days (`count`, `inUse`, `firstDate`, `lastDate`) and what the caller may do.
- **Turn off or on** sets or clears `disabledAt` and `disabledBy` in one update on an upload (6.6) or a reference item (6.11), then records `data.turned_off` or `data.turned_on`. Asking for the state it is already in changes nothing and records nothing. A sales file that wrote no days cannot be turned off (400 `invalid_request`); an item Townwise is still reading is 409 `item_busy`; anyone but the person who added it or an org admin (an org admin only, for a Townwise staff upload) is 403.
- **Delete** of an upload (org admins only, even a member’s own, D16): its stored file, then the days it still holds (days a later upload replaced stay), then its record last, so a retry finds it; answers `{ deletedDays, deletedFiles }` and records `sales.upload_deleted`. Delete of a file works as `DELETE /files/:fileId` and answers `{ deletedDays: 0, deletedFiles: 1 }`.
- **Paste text** keeps text of 1 to 10,000 characters with a title of 1 to 120 characters as a `.txt` reference item under the stored-files caps and retention (11A.2, 11A.7); 503 `files_unavailable` while stored files are off. The list, turning an upload off or on, and deleting an upload work with stored files off, because an upload holds only days.
- Downloads keep the existing routes (10.11) and their log line; a GET never writes, so a download records no audit event (7.3).

### 10.15 The lab callback (`/lab`)

The forecast lab's job (D27, `modeling/lab`) calls back to the API on two routes mounted at `/lab`, outside `/api` and outside the kit's auth: the job holds no session and no secret, only its calibration's id. It signs in with its managed identity: before each call it asks Entra for a token for the lab callback app (`townwise-lab-callback`, a credential-free app registration whose only role is to be this audience) as the lab identity, and the API (`api/src/lab/caller.ts`) checks the token's RS256 signature against the tenant's keys, its issuer (`https://login.microsoftonline.com/{tenant}/v2.0`), its audience (the app's client id), its tenant (`tid`) and its caller (`oid`, the lab identity's object id), with 5 seconds of clock tolerance. Any principal in the tenant can get a token for the app; only the lab identity's passes. Locally the job sends the API process's own random secret instead, compared in constant time. They are the only routes outside `/auth` and `/api` (`api/test/routes.test.ts`), and sit outside `TOWNWISE_ROUTES`. The identity token is not tied to one calibration, so the input is fetched once, by compare-and-set, and the result is bound to that fetch: the input answer carries a fresh result token in `X-Townwise-Result-Token`, stored only as its sha256 (6.23), and a result needs it with the identity token; a second fetch, by anyone, is 404. Whoever fetches first gets the result token, so code running as the lab identity that fetches another calibration's input first can read it and post a forged result for it (a known risk the owner deferred, `infra/README.md`). The identity is checked first, then the live calibration is found by id within its 20-minute callback window (and, for a result, by the result token's hash), and `access/policy.ts` mints the `OrgScope` from the calibration, so the job reads and writes one location of one organization. The body is parsed only after both checks pass. Every refusal is 404 `not_found`: a missing or wrong token, an unknown id, another calibration's result token and a finished calibration look alike (never 401); while the lab is off (no runner) both routes answer 404 to everything. Every refusal while the lab is on logs `townwise.lab_callback_refused { route, reason }`, never an id or a token: the identity check's reason (`missing`, `malformed`, `signature`, `expired`, `issuer`, `audience`, `tenant`, `caller`), then `not_live` for a signed-in caller naming no live calibration or one whose input was already fetched, and `result_token` for a result whose token is missing or not that calibration's, so probing calibrations shows in the log. Only when Entra's keys cannot be fetched do they answer 503 `lab_auth_unavailable` (and warn `townwise.lab_callback_unavailable`). A job that cannot sign in or fetch its input posts nothing, so its calibration fails `timeout` after 20 minutes.

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /lab/calibrations/:id/input`, once | `Authorization: Bearer {the lab identity's token for the lab callback app}` (locally, the API process's secret) | 200 `townwise.lab-input/1`, with the result token in `X-Townwise-Result-Token`: `calibrationId`, `metric`, `today`, `dataThrough`, `horizonDays` (182), `regimeStart`, `days` (guests per day with term, week of term, event groups and three flags from the notes, which after `dataThrough` leave out the notes the forecast read applies, 14.5; never a note's text, a calendar title or a name), `champion` (the published model's forecast to compare with, or null). A queued calibration becomes running here | 404; 503 `lab_auth_unavailable` |
| `POST /lab/calibrations/:id/result` (up to 256 KB) | `Authorization: Bearer {the lab identity's token}` and `X-Townwise-Result-Token: {result token}` (so nothing is taken before the input was fetched); a lab result: a success (a run file with `trainingSource: 'townwise_lab'`, the scorecard, the code version and parameters) or a failure code | 200 `{ status }` once stored | 400 `invalid_lab_result` `{ issues: { path, code }[] }`, which fails the calibration `invalid_result`; 404; 503 `lab_auth_unavailable` |

Ingesting a result follows D17, in an order a retry completes: the draft run upserted on its file hash (the lab never changes a run that exists), its rows, `draft`, the result on the calibration, the gate (set once, by compare-and-set), the publish the gate decides, and the finish. The gate (`api/src/lab/gate.ts`, G2) publishes only when forecasts are on for the organization and it is active (G1), the published forecast did not change meanwhile, and the draft beats the current forecast on at least 12 held-out weeks by at least half a point of weekly WAPE, with 80% ranges holding 65% to 95% of weeks and weekday bias no more than 2 points worse; with no current forecast it needs 12 backtest weeks with an 80% range (595 days of history always gives them) with coverage in band and weekly WAPE at least half a point under a weekday-median baseline. Either way coverage is judged on at least 12 weeks that have a range (`too_few_weeks` or `not_enough_history` otherwise). Ties do not publish. A duplicate or retried POST ends with one run, at most one publish and one `calibration.finished`; a retry that finds the gate recorded as publishing and the run still a draft (an outage between the two) publishes it. The job retries its POST once on a connection error, a lost answer or a 5xx. The job's log lines carry counts and codes only (`fetched input: {n} days`, `posted result: ok`).

### 10.16 Business rules

A location's standing facts (D31, 6.24): “Closed Mondays”, “Patio opens in May”. Four routes in `TOWNWISE_ROUTES` (`org.rules.list`, `org.rules.create`, `org.rules.update`, `org.rules.remove`), each `member`, `openAsAdmin: true` and with no route limiter (the writes spend `townwise:writes`, as every non-GET does); `api/src/handlers/rules.ts`.

| Method and path | Policy | Request | Success | Extra errors |
|---|---|---|---|---|
| `GET /api/org/locations/:locationId/rules` | member | | 200 `{ rules: RuleView[], limit: 30 }`, oldest first | 400 (malformed id); 404 |
| `POST /api/org/locations/:locationId/rules` | member; body `2kb` | `{ text, schedule? }`, strict: `text` at most 2,000 characters before `ruleTextOf`; `schedule` a `RuleSchedule` or null (or left out) for none | 201 `{ rule }` | 400 `invalid_request` (the body, a text `ruleTextOf` refuses, or a schedule `readRuleSchedule` refuses); 404; 409 `rule_limit`; 409 `rule_exists` |
| `PATCH /api/org/locations/:locationId/rules/:ruleId` | member (author or org admin); body `2kb` | `{ text?, schedule? }`, strict, at least one: a field left out keeps what it holds; `schedule: null` takes the schedule off | 200 `{ rule }`; only the fields that differ from the stored rule are written, and nothing different writes nothing and records nothing | 400; 403 `forbidden`; 404; 409 `rule_exists` |
| `DELETE /api/org/locations/:locationId/rules/:ruleId` | member (author or org admin) | | 204 | 400; 403 `forbidden`; 404 |

`RuleView` is `{ id, text, addedVia: 'page' | 'townwise_ai', createdByEmail, createdAt, updatedAt, canEdit, schedule, scheduleSummary }`: `createdByEmail` is the author's current email, “Townwise staff” for a rule staff added while open as admin (D25), or “Deleted person” when the author's account is gone, as for notes; `canEdit` is true for the author and for org admins; `schedule` is the rule's `RuleSchedule` or null, and `scheduleSummary` its plain words, built in code from the fields only (`scheduleSummary` in `api/src/forecasts/reasons.ts`: what it does, its weekdays Monday first, its dates and its hours, as in “Closed on Mondays from Jan 5, 2027” or “Adds 40 guests on Fridays from Jan 2, 2026, 6 pm to 9 pm”), or null.

`RuleSchedule` (D31) is `{ kind, startDate, endDate, weekdays, effect, expectedGuests, startTime, endTime }`, a note's `NoteInput` (Section 12) but `detail`, which it never has. `readRuleSchedule` (`api/src/handlers/notes.ts`) checks it with the code that checks a note (`validDays`): the start from 2010-01-01 to today plus two years, the end on or after it and at most 366 days later, unique weekdays, guests only on a closed schedule that is a buyout, hours both or neither, start before end, none on a closure. `endDate` may be null or left out for no end. [CONFIRM: a rule's schedule may have no end date ("ongoing"); one with an end keeps a note's 366-day span] An Other schedule needs no detail, since the rule's own text says what it is. [CONFIRM: an Other schedule needs no details, since the rule's text says what it is] Any other key, a `detail` included, is 400.

- **The text rule** (`ruleTextOf`): NFC, every run of whitespace (newlines included) one space, trimmed; then 1 to 200 code points with no control or format character left. The stored text is that normalized form, and its lowercase is the duplicate key, so a rule that differs from a saved one only in case or spacing is 409 `rule_exists`, on an add and on an edit (the unique index, 6.24).
- **The limit.** 30 rules per location: an add at 30 is 409 `rule_limit`. The add then inserts and counts again, deleting its own row and answering 409 `rule_limit` when the location went over 30, so two adds racing at 29 never leave 31 (both may be refused). [CONFIRM: 30 business rules per location, 200 characters each]
- **Who changes a rule.** Any member adds one; its author or an org admin edits or deletes it. Another location's or organization's rule id is 404, checked before 403 `forbidden`, as `editableNote` does.
- **Edits racing.** PATCH reads the rule, then writes only the fields that differ from what it read (`BusinessRuleStore.update`, one `findOneAndUpdate` that `$set`s the text or the schedule, or `$unset`s the schedule), so an edit of the text and an edit of the schedule racing both land, and a field a request sends unchanged keeps whatever a racing edit wrote. Two edits of the same field are last writer wins, as for notes. Pinned in `api/test/business-rules.int.test.ts`.
- **Audit.** `rule.created { locationId, via: 'page', scheduled }`, `rule.updated { locationId, scheduled }` (only when the text or the schedule changed; `scheduled` is whether the rule has a schedule after it) and `rule.deleted { locationId }`, target `rule`, written after the effect (9.2, 9.3). In open as admin (D25) the rule is marked `byStaff` and its events are staff events, so they show in Townwise staff activity as “Added a business rule”, “Edited a business rule” and “Deleted a business rule”. The routes log only the request line (route id and status); the text never reaches a log line or an audit event.
- **View-as.** Staff read the list; the guard refuses every write with 403 `view_as_read_only`.
- **TownwiseAI.** A turn that sends a new message (not a regenerate) reads the location's rules after the budget check and before the live-turn claim, so a store failure there needs no release. When the list differs from the last `business_rules` block on the turn's path, the person's stored message starts with a new block holding it (with no rules after earlier ones, the line “There are no business rules for this location now.”); unchanged rules, and a location that never had any, add nothing. In the block a rule's `<` and `>` become the full-width `＜` and `＞`, so no rule can close it early: any member writes rules, and every member's chat at the location reads them, an org admin's included. The stored rule and P28 keep the text as written. [CONFIRM: rule angle brackets sent to TownwiseAI as full-width look-alikes, rather than refused when the rule is saved] Only the newest block on the turn's path (the new message's included) is sent in full; each earlier one is sent as “[Earlier business rules, replaced by a later list.]”, so a deleted or edited rule's text is not sent again, while the stored messages keep their blocks. Contract: `docs/portal/tuning-chat.md` section 3. A rule with a schedule has a second line in the block, “  Forecast schedule: {scheduleSummary}”, which a rule's one-line text can never forge; with no schedule anywhere the block is what it was before schedules. The text and the schedule never reach a log line or an audit event.
- **The forecast.** A rule's schedule changes Townwise's forecast from the town's today on exactly as a note with the same fields does (14.5); a rule without one never changes it.

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
   - If the location already has data, for an org admin: “You already have {first} to {last}. Days in both will be replaced by this file.” For a member: “You already have {first} to {last}. Days you already have stay as they are. Only an admin can replace them.” The range counts only days that are on; a day held by a turned-off upload (D28) is still an existing day to the write (11.4), so when `offDayCount` is above zero a second line says so, and shows even with no days on. For an org admin: “{n} days are held by turned-off uploads. Any of them this file covers will be replaced, and will show again.” For a member: “{n} days are held by turned-off uploads. Any of them this file covers stay as they are, and stay hidden.” (“1 day is held …” for one.)
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

Reference items (D28) are kept under the same rules: any file up to the caps in 11A.2, or pasted text of 1 to 10,000 characters with a title of 1 to 120, written as a `.txt` file in one put. They join no import, are never read for sales, and carry the outcome `reference`.

No file is refused for its type; the browser's MIME type is ignored. From the extension and the first bytes: `%PDF-` is `pdf`; a ZIP signature is `xlsx` (.xlsx, .xlsm), `docx`, `other` (.numbers, kept `numbers`) or `zip`; an OLE container is `xls` (kept `old_excel`), `doc` (kept `old_word`) or, for .xlsx, .xlsm and .docx, a password-protected file (kept `encrypted`); images are kept `image`; text extensions with a UTF-16 mark or no NUL byte are `text`; anything else is kept `type_not_read`. `text`, `xlsx`, `pdf`, `docx` and `zip` are read; a ZIP's entries are told apart the same way, from their names and first inflated bytes.

### 11A.4 Reading

The file reader (`api/src/files/worker.ts`) runs in each API replica: every 5 seconds, or at once when nudged, it claims the oldest started import that is queued with no live lease, or reading under a lease that ran out (`claimNextImport`, 6.10 rule 8), holds a 90-second lease renewed every 30 seconds, and reads the import's files one at a time in upload order. It takes a `stored` file of a started import as it takes a `queued` one, because starting an import and queueing its files are two writes and a claim can land between them; so it never finishes an import past a file it has not read. A suspended organization's import is held back an hour. A file is attempted at most three times, then failed with `internal`.

Each file is read in a worker thread with memory and time limits; the main thread feeds it 1 MiB at a time, acknowledged. The time limit covers the reads from storage as well, and aborts a read that stalls, so a stalled download never holds the replica's reader or the import's lease. Text is decoded as UTF-16 by its mark, else strict UTF-8, else windows-1252, and read in two passes with the browser's tokenizer (11.2), rewritten to take pieces (`CsvPushReader`, which yields exactly the whole-text reader's records). The first pass finds the header row (the first of the first 30 records with two or more filled cells that is a header and names a date, else the first header), profiles every column over every row, and collects the location column's values; the mapping is decided; the second pass adds rows up per date with the browser's `DayAggregator`. A workbook's sheets are each a table, read in sheet order; a later sheet's day replaces an earlier one's only for an org admin's file. Raw rows never leave the thread.

The mapping, in order, with the person's answers overriding each step: the date column (a guessed date header, earlier names first, `business date` before `date`; else the one column of dates; a tie is a question); the date order (proven by a part above 12 over the whole column, else a question); guests and net sales (guessed headers; else a question among the number columns, or kept `notes_not_read_yet` when there are none); the location (a guessed location column with one value is ignored, a value equal to the location's name is used, otherwise a question; over 50 values is kept `too_many_locations`); and after the second pass, what one row is (no repeated date is day-level; repeats with check headers and no item headers are checks, added up; item headers are kept `item_level`; otherwise a question). Header guesses extend the browser's: date `business date`, `date`, `day`, `order date`, `opened date`, `closed date`; guests `guests`, `covers`, `guest count`, `total guests`, `number of guests`, `# of guests`; net sales `net sales`, `net amount`, `net revenue`, `sales (net)`, `net`; location `location`, `restaurant`, `store`, `site`; checks `check`, `check #`, `check number`, `order id`, `order #`, `order number`; items `item`, `menu item`, `qty`, `quantity`, `modifier`. [CONFIRM: header guesses]

**When the rules find no guests or net sales column** (the `columns` question) and the person has not answered it, the AI column step may choose them. The parse thread builds a redacted profile: each column's header text (at most 40 characters), the kind of its values, how filled it is, a count of its distinct values in four buckets, and for number columns whether they are whole and the order of magnitude of the median; and up to 15 rows with every cell replaced by a token (`<date:iso>`, `<date:slash>`, `<int>`, `<decimal>`, `<money>`, `<empty>`, `<text>`). Only that profile crosses to the main thread, which asks Claude Opus 5.5 at low effort (`api/src/files/extract/`, structured output `{ guests, netSales, confidence }`, the chat's server-side refusal fallback, 60 seconds, the SDK's logger off). No row, figure, file name, ZIP entry path, sheet name, organization or location name, paragraph or text outside a table is ever in the request (`test/files/profile.test.ts` pins it). A confident choice of number columns is applied and reported as `ai`; an unsure one becomes the question's suggestion; off (no `ANTHROPIC_API_KEY`), out of budget, or failed, the person is asked. Each call is charged to `tw_files_usage` (6.13) and the file after it returns, whatever it answered; the budget is checked before each call. Never retried beyond the SDK.

**PDFs** are read in the parse thread with `unpdf` (a serverless pdf.js; fonts never loaded, nothing rendered, nothing logged below errors). Each page's text items are grouped into lines (the same baseline within 2 points). A table starts at a header line, one whose items include a date header and a guests or net sales header; the header items' extents make the column bands (midpoints between neighbors); each following line's items fall into the band their center is in; a line with fewer than two filled bands, or one that starts with "total", ends the table. A header repeated on a later page continues its table. Kept: `encrypted`, `pdf_scanned` (no text on any page), `pdf_no_table`, `too_complex` (over 1,000 pages or 20,000 items a page). **Word documents** (`.docx`) pass the package guards, then each top-level `w:tbl` of `word/document.xml` is read with `saxen` into rows of cells; none: `word_no_table`. Every table of a PDF or a Word document is read as a workbook's sheet is. Text outside tables never leaves the thread.

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

Downloads stream through the API (no SAS: the account has no public endpoint), as attachments with `nosniff`, `no-store` and `default-src 'none'; sandbox`. The original goes only to its uploader and the organization's admins, in 32 MiB parts when asked; the cleaned copy to every member. Deleting the original keeps the cleaned copy, report and days and replaces the name with the kind's label, and a workbook's sheet names in the report with `Sheet 1`, `Sheet 2` and so on (either can itself name a person). It is refused (409 `file_busy`) until the file is read, kept or failed: a file not yet read still needs its original, and reading one whose original the person deleted would fail it as our fault. Deleting the whole file stays open, except while it is being read. Deleting a file removes both blobs and the row, and says how many days stay; an unfinished upload is canceled (its staged blocks discarded at once) and its bytes given back. Under view-as, names and ZIP entry paths are null, nothing downloads, and every write is refused; each read logs `townwise.view_as_read` as every GET does.

An org admin can delete every original of a location at once (`DELETE /originals`, the owner's "delete every original", P26's "Delete all originals for this location"): each sales file's original the reader is done with goes as a single one does, and the rest are skipped and counted (`files.raw_deleted_all`). Items kept for reference are left whole (D28): their original is the whole item, so the route deletes only `purpose: 'history'` originals, and the dialog says reference items stay. On P26 the person who added a sales file, or an org admin, can also delete its original alone (Delete original), and an item kept for reference has Delete only. Deleting a location's sales data deletes its stored files too, reference items included (D28: one retry-safe prefix delete, and the dialog says so): imports first, unfinished uploads discarded, every blob under `{orgId}/{locationId}/`, the entry lists and the rows (409 `import_running` while one of its files is being read; 503 `files_unavailable` when stored files are off but it has files); `sales.deleted` counts `deletedFiles`. Files are data for a location's deletion (409 `location_has_data`). An organization's deletion and the staff purge of its originals are in 10.7.

**Retention** [CONFIRM: retention periods]. The daily sweep (`api/src/files/sweeper.ts`), one replica a day under the `tw_file_sweeps` lease (6.14), discards upload sessions past their 24 hours, deletes originals 365 days after upload, read or not (a file never read is kept unread as `raw_deleted`; name and entry paths cleared; the cleaned copy, report and days stay; the storage lifecycle rule is the backstop at 400 days), deletes files dropped into an import never sent for reading 30 days after its last drop (with the import), finishes staff purges of flagged files, drops daily upload counters after 3 days, and deletes blobs whose file row is gone once they are a day old. It logs counts only.

### 11A.8 Not in this build

- Old Excel (`.xls`) and Word (`.doc`) files are kept, not read; reading them needs a library from outside the registry (an owner question).
- Text and notes inside sales files (closure lists, event notes) are stored with the original and never read or sent to any model. The one exception (D28) is a text item the team kept for reference on Your data: TownwiseAI reads it only when asked, through `read_data_item` (6.10 rule 9), the first 64 KiB decoded and at most 20,000 characters, never a file’s name or title and never a `history` file. The text reaches the model only in the turn that read it: the saved conversation keeps its length, not its text (tuning-chat.md section 3), so an item turned off, deleted or purged is never sent again.
- The AI step chooses guests and net sales columns only; it never chooses the header row, the date column or the location value.
- Other upload purposes (a calendar upload, a TownwiseAI attachment) and the processor registry they would use: `POST /files` answers 400 `purpose_unavailable` for anything but `history` and `reference` (D28). The chat composer's + adds a file to Your data as a `reference` upload (P25), so it needs no purpose of its own; a file attached to one message only would.
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
  expectedGuests: number | null;     // integer 1 to 20,000; must be null when effect is 'closed', except on a buyout (kind 'private_event', effect 'closed'), where it is the party's size
  detail: string | null;             // up to 280 characters; required when kind is 'other'
  startTime?: string | null;         // local HH:MM, 24-hour; missing reads as null (all day)
  endTime?: string | null;           // both or neither; startTime < endTime, the same day; both null when kind is 'closure'
}

interface Note extends NoteInput {
  id: string; createdByEmail: string; createdAt: string; updatedAt: string; canEdit: boolean;
}
```

Stored in `tw_notes`: the `NoteInput` fields, `_id`, `orgId`, `locationId`, `createdBy` (userId), `createdAt` and `updatedAt`, and `byStaff: true` only on a note staff wrote while open as admin (D25). No email is stored; `createdByEmail` is read from the kit user at response time (10.1).

- Each kind sets the form’s default effect: closure is `closed`, private event is `more_guests`, opening and other are `unknown`. The owner can change it.
- `weekdays` covers the homepage’s own example, “closed Mondays in March”, with one field.
- Past notes explain history, and upcoming notes are for forecasts once they exist. Both are allowed.
- Authors edit and delete their own notes; org admins edit and delete any. [CONFIRM: author or admin]
- `detail` has the helper “Describe the event, not the guests. Leave out names.” The server cannot detect names and does not try. `detail` is never logged and never copied into an audit event.
- In v1, notes are stored and shown. Nothing reads them yet, and the pages say so. [Build note: from the calendar change, notes adjust the published forecast on read (14.5, D30).]
- Hours (`startTime`, `endTime`) are local wall-clock times on each covered day, both or neither, and never on a closure. An event with hours ends on the day it starts. [CONFIRM: an event with hours ends by midnight on its own day] Uploads are daily totals, so hours are informational: a timed event changes the day's total and its hours show in the forecast reason.
- A buyout is a private event with effect `closed`; there is no separate buyout field, because the lab and the exporter already read that pair as a booked day. Its `expectedGuests` is the party's size. Every other closed note keeps `expectedGuests` null.
- Only a private event with more guests and a guest count, a buyout and a closure change the forecast's numbers (14.5). An opening, an other note, fewer guests or unknown are listed with the day's reasons but change nothing. [DECISION NEEDED: what expected guests means on an opening or other note, extra guests or the day's total, before those notes change a forecast; and whether a fewer-guests note with a count lowers it.]
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
- **Key dates** from the town profile (Section 13): single-day `event`s with the profile’s sources, labeled by hostname, no group and no confidence.
- **Researched entries** in `api/src/town-calendar-data.ts`, hand-curated, each with its sources and the confidence its research gave it. Hanover is seeded from the committed public file `modeling/dartmouth_calendar_2025_2026.csv` (38 rows from winter 2025 to fall 2026: classes and finals, Commencement, Green Key, Homecoming, Winter Carnival, Family Weekend, orientation and home football), one entry per row, and `api/test/town-calendar.test.ts` compares the two row by row. After them come winter and spring 2027 classes and finals and Commencement 2027 from the registrar’s 2026-27 key dates (researched 2026-11-06), then summer and fall 2027 classes and finals from the 2027-28 key dates, and Winter Carnival, Homecoming and five home football games from the October 2026 five-year calendar (researched 2026-11-09; it lists Green Key, Family Weekend and orientation for 2027 without dates, so they are left out), so the term state stays known through fall 2027 finals; the CSV feeds the modeling notebook and is left as it is, so the test pins these sixteen apart from it. No other town has entries yet.

Term entries follow one convention, which the term state reads: `kind: 'term'`, `group: '{townId}:classes:{season}'` for the class period or `'{townId}:finals:{season}'` for the exam period, with season `fall`, `winter`, `spring` or `summer`. Between-terms periods are not entries; the term state derives them.

`townCalendarCovers(townId)` is the span of the town’s researched events (key dates and entries) over all years, or null; `researched` is true when it is not null. Hanover covers 2025-01-06 to 2027-11-24 (fall 2027 finals). A town outside the twelve, and a listed town with nothing researched (Nantucket), get holidays only.

Headcount inputs (residents, students in college housing, enrollment, whether dorms close between terms) are not part of the calendar. None is researched yet for any town; they stay empty, and say so, until a teammate researches them with a source for each number (13.2).

### 13.2 People in town

Who is likely in a location's town each day, from public sources, in `api/src/people-in-town/` (pure, stored nowhere), for the people in town route (10.13), Home's month card and TownwiseAI. It never invents a number: a headcount is printed only when every input to it has a stored source, and otherwise is null with the reason.

- **Term state**, from the calendar's term entries (13.1 convention): `in_session` when a classes entry covers the day (`summer_session` for summer classes, when most of the college is away), `finals` when a finals entry does, `between_terms` only when the last entry before the day is a finals entry and the next one after it a classes entry, and `unknown` otherwise, including the days between classes and finals and any day outside the researched span. Hanover's calendar ends with fall 2027 finals, so from Nov 25, 2027 its days read `unknown` until the winter 2028 term is added.
- **Events and holidays** from the calendar, each with its sources; term and season entries are context, never events.
- **Season**: the county’s 2024 food-service jobs index for each month (Section 13’s data, labeled as employment, not people).
- **Headcount** (`api/src/people-in-town/estimate.ts`), only for a college town with a researched population: residents plus or minus their 90% margin in session and during finals; between terms, low minus enrollment and high minus students in college housing when housing is known to close; in the summer session, low minus enrollment; an event with a researched attendance figure raises only the high end (attendees may already live in town), and one without is listed as left out. Low is rounded down and high up to the nearest 100, never below 0. No multipliers, shares or fitted constants. Seasonal and event towns get none in v1 (`visitors_unknown`): no public source turns visits into people present on a day.
- **Researched inputs** (`api/src/people-in-town/sources.ts`): resident population with its margin, students in college housing, enrollment (one institution per town), whether housing closes between terms, event attendance and visitor counts, each with a source id whose source has a label, an https URL, the date retrieved and a confidence. Empty for every town today (owner decision, 2026-11-05); `api/test/people-sources.test.ts` holds the rules a filled entry must pass.
- **Your history by term state**: the location’s mean guests (net sales, in whole dollars, when no day has guests) by term state and weekday over its open regular days, with day counts; a cell under 3 days has no mean. Open regular uses the client's day classes (closed, noted, holiday, event, regular), pinned on both sides by the shared fixture `day-classes.json`; closed includes likely closed (D32).
- **Sources and caveats**: every number names source ids that resolve in `sources` (`bls-qcew` for the jobs index, `cal-{n}` for calendar sources, researched ids as given); caveats are fixed sentences chosen by which inputs were used.
- **Today** for TownwiseAI is the town’s local date (`api/src/time-zones.ts`): the twelve towns are `America/New_York`; another town gets its state's most populous zone, marked approximate in the thirteen states split between two.
- **Honest gaps**: with no headcount, Home's card says “Townwise can’t put a number on how many people are in {town} yet.” with a Planned tag; the model card says no forecast exists yet with an In progress tag, how far the town's calendar is researched, and that no public count is researched; a town outside the twelve says Townwise hasn’t researched it.

---

## 14. Calibration and forecast states

### 14.1 States in v1 (derived on every read, never stored)

| State | Condition | Heading | Body |
|---|---|---|---|
| `no_sales_data` | no day with guests or net sales | “Not calibrated yet” | “Upload your sales history to start. The upload sends Townwise only the date, guest count and net sales for each day.” |
| `not_calibrated` | one or more days | “Not calibrated yet” | “Your sales history is in: {n} days, {first} to {last}.” |

Mockups add the chip [DECISION NEEDED: minimum days of history before calibration] under the `not_calibrated` body. When the user decides, a `needs_more_history` state with the copy “Calibration needs {min} days of history. You have {n}.” joins the table. Until then, no page states a threshold. [Build note: since D27 the console’s Calibrate refusal and TownwiseAI’s `start_calibration` state the lab’s minimum history, 595 days (409 `not_enough_history`), decided by the owner on 2026-11-10 (D27). The states above and their copy still state no threshold, and this DECISION NEEDED stays open.]

[DECISION NEEDED: whether staff may copy a client’s uploaded days into research notebooks, for that client’s calibration only, and how the copy is recorded, shown to org admins and deleted.] Until it is decided, no client page mentions research notebooks or promises that a forecast will appear. The API has no export route, so today the only ways to get the figures would be copying view-as tables or reading the database directly, and both bypass the audit. If the answer is yes, the build adds an audited staff export route instead: a `sales.exported` audit event, listed in the org admins’ staff activity next to view-as, and a line on the privacy page. Terms (“Your data”, on `feature/townwise-web`) allow use for “calibrating your forecasts” and say “we will not use your data to improve Townwise for other customers”, so using a client’s days to work on shared candidate models would break Terms as written.

**Data checks**, shown under the state and computed from the client’s own rows: days with data, first and last day, missing days in between, days with guests, days with net sales, and the last upload with its date and who sent it.

### 14.2 What the app never shows in v1

No forecast numbers, ranges, reasons or accuracy, except from a run staff published (14.4). [Build note: owners see a published run on the model card and through TownwiseAI; Home and Analytics keep showing none until a later change.] [Build note: the calendar change (D30) is that later change for Home: Home's This month (P11) and the Calendar (P27) show a published run's days, with the owner's notes included from today on (14.5). The forecasts switch (G1), which needs the owner's agreement, still decides whether any run is published.] [CONFIRM: the Calendar and Home show a published forecast day's middle figure, with its range beside it; TownwiseAI, citations and the TownwiseAI landing keep ranges only] [Build note: since D27 a calibration publishes its own run when it passes the gate (14.4), and TownwiseAI’s `get_calibration` and `compare_forecast_models` show org admins, and send Anthropic, a calibration’s backtest ranges and accuracy on held-out weeks of the owner’s own history, even while the organization’s forecasts are off; never a draft forecast day. That exception is marked for confirmation in `tuning-chat.md` section 4.] No “calibrating” or “calibrated” states on the calibration state itself. [Build note: since D27 a calibration's status (running, finished, failed, and whether it was published and why) shows in TownwiseAI's replies and in the staff console's Forecasts section (14.4); the derived state in 14.1 is unchanged, and no page shows progress for a process that is not running.] No sample values. The one forward-looking block is the design system’s own pattern (Section 16, P11): a layout headed “Illustrative layout, not real output”, with slots only. [CONFIRM: show the illustrative layout in the app] Home replaced the Forecast page at P11 (owner decision, 2026-11-05), so the app shows no illustrative layout today.

### 14.3 Reserved for later (not in the v1 API)

`queued`, `calibrating`, `calibrated` (with model version and fitted date), `stale` (sales or notes changed since the last fit) and `failed`. They arrive with model storage, as a `tw_calibrations` collection keyed by location. [Build note: `tw_calibrations` is built as of D27, but per calibration, not per location (6.23): it records each lab run's status, gate and scorecard, and the states above stay reserved because the model itself is stored nowhere.] The forecast shape, also reserved: `{ horizon: 7 | 28; frozenAt; modelVersion; interval: 0.8; days: { date; guests: { low, mid, high }; netSalesCents: { low, mid, high }; reasons: { text, source }[] }[] }`. [Build note: forecasts now arrive as runs in the shape of 14.4, imported by staff or made by the forecast lab (guests only, reasons labeled in code, never free text); the calibration states stay reserved.]

### 14.4 Forecast runs

The API never computes a forecast and never holds a model. [Build note: since D27 the forecast lab computes forecasts too. A job on Townwise's Azure servers (`modeling/lab`, not the API) refits a location's model from that location's own uploaded days and notes, returns its outputs to the API's callback (10.15) and keeps no model; the API still computes nothing and holds nothing but outputs and the code version, parameters and input hash that reproduce them.] Staff export a run's outputs on the team's computers (`modeling/export_forecast_run.py`, from the frozen files in `modeling/forecasts/`, written to the gitignored `modeling/outputs/`), import the run file for one location from P21, and publish it. [Build note: owner decision 2026-11-05: staff may import and publish Sawtooth's frozen v3 forecast once Sawtooth is an organization in Townwise and the owner confirms its consent to see it and to its being sent to Anthropic through TownwiseAI. The build ships the machinery only; nothing is published.]

- **The run file** (`townwise.forecast-run/1`, `api/src/forecasts/file.ts`, at most 256 KB as sent: P21 reads the file in the browser, refuses one over 2 MB on disk unread, and checks the 256 KB on the parsed file as compact JSON, so the exporter's indenting doesn't count; strict at every level): `schema`, `metric: 'guests'`, `model { family, version, notebookCommit }`, `trainingSource: 'files_from_owner'`, `trainedFrom`, `dataThrough`, `madeAt`, `frozen`, `interval { level: 0.8, widened }`, `backtest`, `days` (1 to 400: `date`, `status`, `low`, `mid`, `high`, `baseline`, up to 6 `reasons { kind, ref, effectPct }`) and `weeks` (up to 60: `from`, `to`, `openDays`, `low`, `mid`, `high`). No location id, name, note, URL or other free text. Rules: `trainedFrom <= dataThrough <= madeAt <= today`; every day after `dataThrough` and within 400 days of it, each once; an open day has `low <= mid <= high` (0 to 20,000), a closed or booked day no numbers; only term, event and holiday reasons may carry a `ref`; each week lies inside one Monday-to-Sunday week, on days the file has, without overlap, with `openDays` between its open days and its open and booked days. A refusal is 400 `invalid_forecast_file` with at most 50 `{ path, code }` issues, never a value.
- **Import** (staff, 10.7): the run is upserted on `{ orgId, locationId, fileSha256 }` as `importing`, its rows upserted on their key (a duplicate key from a concurrent import of the same file is a row the other one wrote, not an error), and it becomes `draft` when every row is there. The same file again answers 200 with the run; a run left `importing` finishes on the retry. Publish is a compare-and-set from `draft`; withdraw from `draft` or `published`. Each is a staff action (9.2), written before the effect and listed in the org's Townwise staff activity.
- **Lab runs** (D27). Org admins (through TownwiseAI's `start_calibration`) and staff (the console's Calibrate button) start a calibration for a location. Its job returns a draft run with `trainingSource: 'townwise_lab'` and a `lab` block (6.20), plus a scorecard on held-out weeks (WAPE, typical-week error, weeks over 20% off, the worst week, 80% range coverage, weekday bias). It publishes itself only when staff have switched the organization's forecasts on (`POST .../forecasts-switch`, which needs the staff member's word that the owner agreed) and the gate passes (10.15); otherwise the draft and its scorecard stay for staff, who see percentages and counts only (D7). Staff publish a draft with the existing Publish, which also answers 409 `forecasts_off` while the switch is off, and withdraw any run, lab or imported, with Withdraw. A lab run is frozen with its training cutoff, input hash, code version and parameters, scored prospectively like any published run, and never overwritten. Each calibration costs the organization's TownwiseAI month $0.10 and is limited to 4 a day per organization and one live per location. Privacy: the job sees only the one location's days, and nothing about a calibration reaches a log or an audit event except ids, codes and counts. TownwiseAI's three lab tools (`tuning-chat.md` section 4) give the model the scorecard as chart data and cards, never a draft forecast day; no chat view draws them yet [DECISION NEEDED: how lab results render in the redesigned chat].
- **Who sees it.** Owners, view-as and TownwiseAI read published runs only: drafts, unfinished imports and withdrawn runs never show. For each date the reader uses the newest published run whose `dataThrough` is before it, so no forecast is shown for a day its model saw. Week rows come only from a run that supplied every day of the week, and are the run's own, never sums of days.
- **Labels** are made in code (`api/src/forecasts/reasons.ts`): the weekday; the term from the town calendar's term state on the day; an event or holiday by the calendar entry its `ref` names (by id, or a group with one entry that day), a federal holiday on the day, or plain words ("Town event", "Holiday"); "Your recent level", "Closed", "Private event booked". A partner's text can never reach a label.
- **Accuracy.** Each past day carries its stored guests and whether they landed in the range. Live accuracy is per run: it counts the open days that have passed which that run supplied (the reader chose it for them), booked days left out, as WAPE with the in-range count, misses included, and is null under 5 of its own scored days. A newer run is never credited with an older run's days, so a run published today reads "not scored yet" even when older runs have been scored. A day is past once it has ended in the town (its local date, `localDay`, 10.13), on the forecast route, the model card and in TownwiseAI alike. Scored weeks are not listed separately: a week row in a read carries its `actual` and `inRange`. A week's actual is summed only when all its open days have passed and none was booked.
- **Read view** (`ForecastWindow`): `{ available, reason: 'no_published_forecast' | 'not_covered' | null, runs: (ForecastRunView & { live: LiveAccuracy | null })[], days: ForecastDayView[], weeks: ForecastWeekView[], notCovered: { from, to }[] }`, each run with its own live accuracy. `ForecastRunView` is `{ id, metric, model: { family, version, label }, trainingSource, trainedFrom, dataThrough, madeAt, frozen, interval, backtest }`; a day `{ date, weekday, status, low, mid, high, baseline, reasons: { kind, label, effectPct, sources }[], runId, madeAt, madeAfterDay, actual, inRange }`; a week `{ from, to, openDays, low, mid, high, runId, madeAt, actual, inRange }`; `LiveAccuracy` `{ days, inRange, typicalErrorPct, from, to }`. Numbers are raw; clients and TownwiseAI round low down and high up. [Build note: from the calendar change (D30) a day also carries `model`, `noteGuests` and `moreNotes`, a reason `note`, and a week `noteGuests` (10.13, 14.5).]
- **TownwiseAI** reads it through `get_forecast { from, to }` (at most 31 days, from at most 92 days back), which answers "Townwise has no forecast for this location yet." when none is published; its prompt gives every forecast as a range, never the middle alone, uses week rows for weeks, names the model when asked, mentions accuracy and misses when the owner is deciding, and never makes up a forecast (`tuning-chat.md` section 4).
- **Deletion.** Runs and rows go with the location's sales data (they are derived from it), the location, the organization, and by staff delete; a person's deletion clears their staff id (10.7). Fitted models and the partner's exports stay on the team's computers, with a deletion duty in the runbook (`infra/README.md`, Forecasts).

### 14.5 Notes in the forecast

From the calendar change (D30), the location's notes adjust each published forecast day on read (`api/src/forecasts/adjust.ts`, pure, called by `api/src/forecasts/reader.ts`). The adjustment is computed on every read and stored nowhere: runs and their rows (`tw_forecasts`) are never rewritten, so frozen and published runs stay exactly as made, and an added, edited or deleted note shows on the next read everywhere (the forecast route, Home, the Calendar, `get_forecast` and `show_visual`). The reader reads the notes overlapping the window once (`NoteStore.overlapping`, under the caller's `OrgScope`) and takes, for each day, the notes that cover it (dates and weekdays), oldest first. It reads the location's business rules with a schedule once too (`BusinessRuleStore.scheduled`, at most 30, under the same scope, D31), and a rule's schedule covers a day as a note does, an end of null meaning no end. A rule's schedule is applied exactly as a note with the same fields: everything below about a note holds for a rule (its closure, its buyout, its private event with a guest count, and every outcome), and rules and notes on one day all apply together, so their guests add up and a closure from either wins. Another location's or organization's rule never reaches the read. Rules, in order:

1. **Past days.** A day before the town's today (the reader's `today`, 13.2) keeps the model's figures, and every note covering it has outcome `past_day`. Past days keep the forecast as it was made, so `actual`, `inRange` and live accuracy stay comparable with what the model said. [CONFIRM: notes change the forecast from today on, never a past day]
2. **Status.** A closure (a closure note, or any closed note but a buyout) makes the day `closed` whatever the model said (outcome `closed`). Otherwise a buyout (a private event with effect `closed`) makes it `booked`, even a day the model closed (outcome `booked`; `day_closed` under a closure). Otherwise the model's status stands (`row.status`, open when none), except that on a day the model closed (a learned closure, such as a weekday or a holiday, not a note) a private event with effect `more_guests` and a guest count opens it (rule 3). A closed or booked day has `low`, `mid` and `high` null, as the run file's booking rule says. [CONFIRM: a buyout books the whole day] [CONFIRM: a closure note beats every other note; on a day the model closed, a buyout books it with its guests and a private event with a guest count opens it with only those guests]
3. **Guests.** On a day that ends `open`, each private event with effect `more_guests` and a guest count adds its guests to `low`, `mid` and `high`, and the guests are summed (outcome `added`). On a day the model closed, which has no figures of its own, `low`, `mid` and `high` are all the summed guests. The exception is a day whose run reasons include `kind: 'booking'`: the notebook exporter (`modeling/export_forecast_run.py`, `EVENT_REASONS`) marks open private-event days that way, so every such note there gets `already_in_forecast` instead of counting the party twice.
4. **noteGuests.** On an open day, the guests the counted private events add; on a booked day, the sum of its buyouts' guests (0 when none gave a count); on a closed day, 0.
5. **Every other note** is listed with why it changed nothing: `no_guest_count` (a private event with more guests and no count, unless a closure note closed the day), `not_counted` (an opening, an other note, fewer guests or unknown), `day_closed` (a private event on a day that stays closed) or `day_booked` (a private event, not a buyout, on a booked day).
6. A model day that is open with null figures can't happen (`file.ts` refuses it), so it needs no rule.

- **Day fields.** `status`, `low`, `mid` and `high` are the adjusted values; `model` keeps the run's own `{ status, low, mid, high }`; `noteGuests` and `moreNotes` as in 10.13. `inRange` is computed on the model's figures and status, and `baseline` is null when a note changed the status.
- **Reasons.** Notes with outcome `added`, `booked` or `closed` come first, then the run's reasons in run order, then every other note, with at most 6 note reasons in all; `moreNotes` counts the rest, whose guests still count. A note's reason (`kind: 'note'`) is labeled in code from its kind, guest count and hours, never its detail: "Your private event, 70 guests, 6 pm to 9 pm"; "Your private buyout, 70 guests" (the count left out when null); "Your closure" (or "Your note: closed" for another closed note); otherwise "Your {opening | note | private event}{, N guests}{, hours}". A rule's reason (`kind: 'rule'`, D31) carries `rule: { id, guests, outcome }` (and `note: null`; every other reason has `rule: null`), and is labeled in code from its schedule without its dates, never the rule's text: "Your rule: closed on Mondays", "Your rule: adds 40 guests on Fridays, 6 pm to 9 pm", "Your rule: private buyout, 70 guests on Saturdays", "Your rule: other, fewer guests than usual on Tuesdays". Rules that changed the day come before the notes that did, and the rules that didn't before the other notes; rule reasons are never cut by the six-note cap (a location has at most 30 rules) and never counted in `moreNotes`. [CONFIRM: rule reasons are never cut by the six-note cap and come before the notes' in each group] `REASON_KINDS` in `file.ts` is not extended, so a run file still can't carry a note or rule reason.
- **Weeks.** If a note changed any day's status in a week, the week row is left out of the read: the run's week can't be re-summed honestly, and the reader never sums days. Otherwise the week's `low`, `mid` and `high` shift by the summed `noteGuests` of its open days (exact, since a party is a fixed number), and the row carries `noteGuests`. A week's `inRange` stays the model's.
- **The lab's input** (`api/src/lab/input.ts`, 10.15): on days after `dataThrough` (the forecast horizon) the notes this read applies are left to it. `closed` and `booked` are false, so a closure or buyout note never becomes the run's own day status (`statuses()` in `modeling/lab/townwise_lab/forecast.py`), which editing or deleting the note could not undo until the next calibration; closures the lab learns from the history (weekdays, closing holidays) still come from the model. `privateEvent` is true only for covering private events this read will not count, that is, any but a buyout or one with effect `more_guests` and a guest count; otherwise a lab run would apply its learned private-event lift and this read would add the headcount on top. History days (on or before `dataThrough`) keep all three flags, for training. A business rule's schedule (D31) sets the three flags exactly as a note with the same fields does, on history and future days alike (`buildLabInput` reads `BusinessRuleStore.scheduled` under the calibration's scope), and its more or fewer guests say a near-empty history day was open, as a note's do (D32); a rule's text never reaches the input. The lab (`modeling/lab`) reads the same booleans and needs no change. A lab run made before these changes keeps the statuses and lifts it baked in for its future days (a deleted closure or buyout still closed or booked there) until the location is calibrated again.
- **Known limitation.** A lab run made while a private event had no guest count applied the lab's learned private-event lift; if the owner later adds a count, this read adds the count on top until the next calibration. The lab's reasons carry no `booking` on open private-event days (`modeling/lab/townwise_lab/forecast.py`), so rule 3's exception does not catch it.
- **Privacy.** A note's reason carries its kind words, guest count and hours, never its detail; TownwiseAI's `get_forecast` sends each note reason's guests and outcome, never its detail or id. A rule's reason carries its schedule's words, guest count and hours, never the rule's text, and `get_forecast` sends its `rule: { guests, outcome }`, never the text or id. The read logs nothing and stores nothing, as before.
- **Not yet.** TownwiseAI's `get_sales_days` and `get_day` and your history by term state (13.2) still read only notes when they mark a day likely closed or noted, and Analytics (P24) has no rules; the forecast, the lab's input and the Calendar read rules. A later change can add them there.
- Tests: `api/test/forecast-adjust.test.ts`, `api/test/forecast-reasons.test.ts`, `api/test/estimates.int.test.ts` (the forecast route's describe, rules with a schedule included), `api/test/lab-input.test.ts`, `api/test/chat-estimate-tools.test.ts`, `api/test/chat-visual.test.ts`, `api/test/business-rules.test.ts`, `api/test/business-rules.int.test.ts`.

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

- **Grid.** Content max `content-max` (1280px), centered. Side margins `margin-fluid` from 1024px, `margin-tablet` (32px) from 641px, `margin-phone` (16px) at 640px and below, plus safe-area insets as on the SignIn artboard. Columns: 12 from 1024px, 8 from 641px, 4 below; gutters `gutter` (20px) and `gutter-phone` (16px).
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
  - On location pages the eyebrow is the town alone, “{Town}, {ST}”, when the organization has one location (D29: with one location the UI never shows the location’s own name), and with several it names the location: “{Location name}, {ST}” when the name already ends with its town (“Sawtooth Kitchen, Hanover, NH”), else “{Location name}, {Town}, {ST}” (`locationEyebrow` in `client/src/portal/locations/naming.ts`). The title is the page’s own: Home “Welcome back, {name}.” or “Welcome back.” (P11), Calendar “Calendar” (P27), Analytics “Analytics”, Sales data “Sales data”, Upload “Upload”, Notes “Notes”, Town “Town”, Business rules “Business rules” (P28), Location settings “Location settings”. TownwiseAI has no page header: no eyebrow, title or side links (P25). “All locations” (a text link to `/dashboard`) shows only with more than one location; “Location settings” (a text link) only for org admins, and not on that page itself.
  - Below 1024px the two stack.
  - Gate pages use the same header with the lead paragraph (`sub`, `text2`) under the title, in columns 1 to 7, and an optional side column 9 to 12, as on the SignIn artboard.
- **Location switcher.** Shown only when the organization has more than one location. It is a labeled select (“Location”) styled like a FormField input, and changing it navigates to the same page of the other location.
- **No location tabs.** The location’s sections are in the top bar (15.3); Sales data is reached from Analytics and from Upload’s result, and Location settings from the page header.
- **Content.** Sections are separated by a 1px `border` rule with `space-8` between them. Panels have a `panel` fill, a 1px `border`, square corners, and `space-5` padding (`space-4` at 640px and below). Never put a `raised` fill inside a `raised` surface; outline the inner element with `line` instead. Reading width for forms and prose is columns 1 to 7; the side column 9 to 12 holds help text and summaries.

### 15.3 Navigation per role

| Who | Top bar nav | Page header links | Notes |
|---|---|---|---|
| Member | Home, Calendar, Analytics, TownwiseAI, Notes, Rules, Town, Your data; then Settings | All locations (more than one location) | No Team. Upload and notes are allowed (D16). |
| Org admin | Home, Calendar, Analytics, TownwiseAI, Notes, Rules, Town, Your data; then Team, Settings | All locations (more than one), Location settings | |
| Staff | Requests, Organizations, People, Audit log | none | Staff console frame (15.4). |
| Staff in view-as | the target’s items | the target’s links | Client app frame under the banner; no console items. |
| Staff open as admin (D25) | the org admin’s items without Team: Home, Calendar, Analytics, TownwiseAI, Notes, Rules, Town, Upload; then Settings | the org admin’s links | Client app frame under the open-as-admin banner (15.5a); no console items. `/team` redirects to Home; Settings has no Leave section. |
| Signed in, no organization | none | none | Gate frame. |

The sections are Home (`/locations/[id]`), Calendar (`/locations/[id]/calendar`, P27, D30), Analytics (`/locations/[id]/analytics`), TownwiseAI (`/locations/[id]/agent`), Notes, Rules (`/locations/[id]/rules`, P28, D31, for every member), Town and Your data (`/locations/[id]/data`, D28, which replaces Upload; the upload page stays at `/locations/[id]/sales/upload` and marks Your data current). They open the location in the path; on a page outside a location (Locations, Team, Settings), the last location opened in this sign-in, held in memory only and never in storage, else the organization’s first. With no location the bar has only Team and Settings. `aria-current="page"` marks the section of the current page; Analytics is also marked (`aria-current="true"`) on Sales data, which lives under it, and on Location settings no section is marked. The wordmark goes to `/dashboard` (Locations), which redirects to the only location’s Home when there is one. Settings is the account page, `/settings`. Two-step sign-in (`/settings/security`, **Exists**) is reached from Settings.

### 15.4 How the staff console differs

- **Unmistakable chrome.** The console top bar has a `panel` fill (the client app’s is `ground`). After the wordmark comes a kind tag, “Staff console” (`tw-tag` with no square: the StatusTag kind form, so no new status is invented).
- **Right side of the top bar:** “Verified until {time}” in `mono`, `text3`, then the staff email in `mono`, `text3`, then “Sign out”. The time is `staff.verifiedUntil`, a real time, not a live counter, and the page does not tick.
- **No organization name and no location tabs.** Console pages are full-width tables: NumbersTable styling (`mono` 12/16, tabular figures, 1px `border` rules, heads in `text3`, values in `text2`, row hover `raised`, rows at least 44px), each inside a focusable, named scroll region.
- **Requests** shows its count in the nav as “Requests {n}”, with `{n}` in `mono`. The count is a number, not a dot or badge, and it is never animated.
- **Detail panels.** A selected row opens its detail in a panel: on the right from 1200px (columns 8 to 12), below the table under 1200px. The selected row takes the selected-row idiom (raised, border outline, 6px mint square, mint name).
- **No client figures.** Location rows show counts and date ranges only, with the line “Sales figures and notes are visible only through View as.” (D7), or, while the organization is in setup, “Sales figures and notes are visible through Open as admin until someone joins, then only through View as.” (D25).
- **Web only by layout.** The console is designed for 1024px and up and stays usable at 641px. At 640px and below, tables become stacked rows. Native builds do not include console routes. [CONFIRM: console on web only]

### 15.5 The view-as banner

```
+--------------------------------------------------------------------------------------+
| VIEWING AS   {email}, {Admin|Member} at {org}.   Read-only until {time}.  [End view-as]|
+--------------------------------------------------------------------------------------+
```

- **Position.** First in the page, above the top bar, full bleed, `position: sticky; top: 0`, above every other layer. At least 52px tall (`toolbar-height`). It is the second focusable element, after the skip link.
- **Look.** A `raised` fill with a 1px `line` rule below. `line` is a mark color, so the edge reads as a boundary, not decoration. Inside the content grid:
  - “Viewing as” as `tw-eyebrow` in `text3`;
  - “{email}, {Admin or Member} at {org}.” in `ui`, `white`;
  - “Read-only until {time}.” in `mono`, `text2`;
  - right: an outline button (`tw-ob`), “End view-as”.
  
  For a target with no organization, the middle reads “{email}, signed in, no organization.”
- **Never color alone.** No mint (mint is data and selection), and no `warning` or `error` (proposed, not adopted). The words carry the meaning.
- **Not dismissible.** It is `role="region"` with `aria-label="View-as"`. The document title is prefixed “Viewing as {email} · ”.
- **Phone (640px and below).** Two rows: the text, then “End view-as” at full width.
- **Read-only controls.** Every write control stays in place, so the layout matches the client’s, but renders disabled (15.7). Each form or section with writes shows one helper line: “Read-only while viewing as {email}.” Sign out in the client top bar is disabled too; End view-as is the way out. It sends `{ grantId }`, the grant the banner shows, so a tab left on an ended view-as never ends a grant the session started since (8a).
- **On expiry**, or when the target’s organization changes (Section 8), the next `GET /api/me` returns staff access without `viewAs`. The client goes to `/admin` and shows the notice “View-as ended at {time}.”

### 15.5a The open-as-admin banner

```
+--------------------------------------------------------------------------------------+
| You’re setting up {org} as Townwise staff. This ends when someone joins.        [End] |
+--------------------------------------------------------------------------------------+
```

- **As 15.5.** Same position, look, never-color-alone rule and phone layout (two rows: the text, then “End” at full width), shown on every portal page while `openAsAdmin` is set. It is `role="region"` with `aria-label="Townwise staff setup"`, not dismissible, and the document title is “Setting up {org} · Townwise”.
- **No time.** The mode has no timer of its own (D25), so the line has none.
- **Every control is enabled**, Sign out included: signing out ends the staff sign-in, and with it the mode. Sign out first sends End with `{ grantId }`, so `open_as_admin.ended` is recorded at the sign-out; a failed End never stops the sign-out. Nothing is read-only and there is no helper line.
- **End** sends `POST /api/admin/view-as/end` with `{ grantId }`, the grant the banner shows (8a), and applies the answer, the staff member’s own access, so the client goes to `/admin`.
- **When it ends** (End, a join, a suspension), the next `GET /api/me` returns staff access without `openAsAdmin`. The client goes to `/admin` and shows the notice “Setting up {org} as Townwise staff ended at {time}.” once. A read that finds it ended sends End once, naming the grant it showed (4.3). When the staff sign-in ends, `GET /api/me` answers `staff_reauth_required` instead and the client goes to `/staff/sign-in-again`, with no notice and no End; the next start or End records the end (8a).

### 15.6 Visual language

- **Dark, one theme.** The page is `ground` (#080a0d). Surfaces step to `panel` (#101317) and then `raised` (#181c21). Depth comes only from the fill step and 1px `border` (#34383e) rules: no shadows, gradients or blur.
- **Swiss.** A visible grid, flush-left sans, objective labels, asymmetric headers. Square corners everywhere (`radius-none`); the app frame’s 8px edge belongs to the homepage console, not to app pages. Round shapes only for data marks. Exception (D26): on TownwiseAI only, the composer (radius 28), the person's message bubbles (16) and the chips and the composer's button (22) are rounded; everything else there stays square.
- **Type.** Instrument Sans: display 600, UI 500, reading 400. Geist Mono for every numeral, with `tabular-nums`, for labels (`label`, uppercase, through `tw-eyebrow` and `tw-tag`) and for table cells. Sentence case. Fonts are self-hosted in the app (**Exists** on `feature/townwise-web`); mockups may link Google Fonts as the design system previews do.
- **Color roles.**
  - `white` (#eff2f6): primary text.
  - `text2` (#b5bbc2): secondary text.
  - `text3` (#9a9fa6): mono labels and fine print.
  - `line` (#7b8187): outlines and controls.
  - **Mint (#7bd2b4) is for data and selection only**: chart series, the selected tab or row (6px square and label), pressed controls, the focus ring and the skip link. It never fills a button, never colors a message, and never marks a warning.
  - Labels on a mint fill are `ground` (`on-mint`), never `white`.
- **The primary button is white** (`cta`): `white` fill, `ground` label, `text2` fill on hover. It is square, at least 44px tall, with a 15px `button` label and 18px side padding. **One primary per page**, for its main action; everything else is an outline button (`tw-ob`) or a text link (`tw-tl`). [CONFIRM: extends the Button rules to app screens, where labels vary by page]
- **StatusTag only for build status and kinds.** In progress (6px mint square) and Planned (6px outlined square) describe Townwise features, as on the homepage; College town, Seasonal town and Event town describe towns. A client’s own data state (“Not calibrated yet”, “Active”, “Invited”) is plain words, never a tag.
- **Charts** follow the design system: every chart has a text summary and “Show the numbers”, prints its scale and year, and keeps its SVG `aria-hidden`. Client sales series are `mint`, solid, 2px (`stroke-series`), with “Scale fitted to this location.” Town charts keep the Northeast dashed and the county solid.
- **Motion.** State changes only, 150 to 200ms with `--ease-out`. No spinners, shimmer or counters, and no pulsing but a loading skeleton’s opacity (15.7). One reduced-motion switch zeroes everything. The one exception is the two statement moments of 15.8, whose words fade in over 200ms each, 80ms apart, and which end within 5 seconds; reduced motion shows them whole and still.
- **Voice.** Second person to the operator, first person plural for the team, short declarative sentences, no exclamation marks. Say what exists, and only that. U+2019 apostrophes and curly quotes in every visible string, no em dashes, ranges as “80 to 115”, a true minus (U+2212) for negatives.

### 15.7 Shared patterns

- **Forms (FormField).** The label is `ui`, `white`. The input has a `ground` fill, a 1px `line` border, square corners, at least 44px height, and 16px typed text. The helper is `small`, `text2`, tied by `aria-describedby`. Focus is a 2px `mint` outline offset 2px, plus a `mint` border. Selects, number inputs, date inputs and textareas use the same anatomy. A select's open list is drawn in the app's style on every platform, never the operating system's: on web a `panel` list under the control (over it when the room below is short) with a 1px `line` border, square corners, 44px choices, group labels in `label` type, the highlighted choice `raised` with a 3px `mint` bar, and the current choice `mint` with a drawn check; on native the sheet. On web it is an ARIA select-only combobox (Down, Up, Home, End, Page Up and Page Down move; Enter or Space picks; Escape closes; typing jumps to a choice). Field messages print in white in the numbered, ruled list (`tw-msgs`), with `aria-invalid` on the field. [CONFIRM: error and notice colors stay unadopted, as the design system proposes]
- **Page notices** (“Saved.”, “You joined {org}.”, “View-as ended at {time}.”) use the same ruled message style in `white` with `role="status"`, at the top of the content. No color, no toast, no auto-dismiss.
- **Disabled controls** are not defined in the design system. Here they get `aria-disabled="true"` (not the `disabled` attribute), so they stay focusable and screen readers reach them and their helper line. They use a `text3` label with a 1px `border` outline and do nothing when pressed. A disabled primary has a `raised` fill, a `text3` label (6.43:1) and a 1px `border` outline, with no hover change. [CONFIRM: disabled style]
- **Destructive actions** have no red. Each is an outline button that opens a confirm dialog. Deleting data asks the person to type the location name, and the dialog’s action stays disabled until it matches.
- **Dialogs** have a `panel` fill, a 1px `border`, square corners, at most 560px width, and `space-6` padding. The title is `tw-h3`, the body is `small` and `text2`. Actions sit flush left: the dialog’s one primary, then “Cancel” as a text link. The backdrop is `ground` at 80% opacity. Focus is trapped while open and returns to the opener on close; Escape closes. [Build note: while a dialog’s action is pending, Cancel and Escape wait for its answer.]
- **Tables** use NumbersTable styling in a focusable, named region. At 640px and below, rows become stacked label and value pairs. A table in a TownwiseAI reply scrolls sideways inside its own region instead (D26).
- **Loading** is a skeleton of the page in place of its content (`client/src/portal/skeleton/`): the page’s own sections, columns and tables (stacked at 640px and below, as the tables are) as square shapes, each the size of what it stands for, so nothing shifts when the content arrives. Text and figures are `raised` blocks as tall as their type and line, controls 44px `line` outlines, panels the `panel` surface. No mint and no sample values, so no skeleton suggests a number. The shapes pulse in opacity alone, from 1 to 0.5 and back over 1.6s on the ease-in-out curve, and are still under reduced motion (on native, also until the system answers). Screen readers hear one polite status line with the page’s loading words (“Loading your locations”), and the shapes are hidden from them. A part of a page that loads on its own (a month’s days, a place from Google, the audit log’s Load more) keeps a text line in place of that part, in `small`, `text2`, inside a box that keeps its height. [CONFIRM: loading skeletons, and their opacity pulse]
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
| P11 | `/locations/[id]` | Home, a dashboard of blocks: at a glance, this week on the calendar and in past years, this month’s calendar with a day’s detail, last week, bar order (Planned), who’s in town, past years, your history | members | Client app |
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
| P26 | `/locations/[id]/data` | Your data: every upload, file and text item, with Turn off and Delete (D28) | members | Client app |
| P27 | `/locations/[id]/calendar` | Calendar: each day’s published forecast with what drives it, the town’s calendar and your notes, filters, a day’s panel to add or change notes, and your own calendar file (web) (D30) | members | Client app |
| P28 | `/locations/[id]/rules` | Business rules: the standing facts TownwiseAI reads with every message, added, edited and deleted here; the top bar's Rules section (D31) | members | Client app |

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
  - Town: a select grouped “College towns” (six) and “Seasonal and event towns” (six), then “Another town”, which reveals Town name and State (a select of the 50 states and DC by name, “Choose a state” until one is picked).
  - Number of locations (1 to 50). With places checked it is at least their count, live as places are checked: checking more raises it, unchecking lowers it again but never below the number the person typed, and sending a smaller number says “You checked {n} places, so enter at least {n}.”
  - “Anything we should know? (optional)”, with the helper “Don’t include guest names or sales figures.”
- While the Google Places search is on, the page is one screen (D29; before it, two steps with Continue): “Step 1 of 3”, “Find your restaurants”, the checklist with its map (10.2a), with the helper “Type its name or street address. Google Maps suggests places in the US.” and the text link “Can’t find it? Enter your town yourself” under it; then, directly below on the same page, “Step 2 of 3”, “About you”, these fields without Town (the checked places stand in for it, D24), and Send request. Organization name shows the first checked business’s Google name (cut to 120) until the person types in it; a street address never fills it. Send with nothing checked says “Check your restaurant above, or enter your town yourself.” under the checklist and sends nothing; Send is disabled while a checked place is loading. The request carries each place with its kind. “Can’t find it? Enter your town yourself” hides the checklist and shows Town in the form, with “Search Google Maps instead”, which brings the checklist back with its places still checked. Focus: “Can’t find it?” moves it to Town, and “Search Google Maps instead” to the search field. There is no Continue, no summary of the places and no “Change places”.
- Primary: “Send request”.
- Side column, “What happens next”, numbered 01 to 03: “Someone on our team reviews your request.”, “We’ll email you when you’re approved.”, “Once you’re approved, you’ll upload your sales history and see your town.”
- Footer line: “Signed in as {email}. Using the wrong Google account? Sign out and continue with another one.”
- Variants: for `removed`, the lead adds “Setting up a different organization? Tell us about it below.” For `rejected`, the previous answers are prefilled.

| State | Shows |
|---|---|
| Loading | Never blank: the form renders at once (the town list is bundled); only Send shows “Sending…” and is disabled while it sends. While it asks whether the Google Places search is on, the skeleton of Step 1 and the form (15.7) stands under the first panel, with “Checking for the Google Maps search…” |
| Empty | The empty form |
| Error | Field messages: “Enter your organization’s name.”, “Enter your name.”, “Enter a whole number from 1 to 50.”, “Pick a town, or choose Another town.”, “Choose a state.”; with the checklist and nothing checked, “Check your restaurant above, or enter your town yourself.” 409 `request_exists` re-reads `/api/me`. 429 and network errors use the shared copy. |
| Success | Route to `/waiting` |
| View-as | Form disabled |

**P4. Waiting for approval (`/waiting`)**

- Eyebrow “Request sent {date}”. Title “Your request is in”. Lead: “Someone on the Townwise team reviews every new organization by hand. We’ll email you when you’re approved.” [DECISION NEEDED: whether to state a review time]
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

**P7. Two-step sign-in (`/settings/security`).** **Exists.** For staff in `staff_setup_required`, a notice sits above the existing screen: “Townwise staff accounts need two-step sign-in. Set up your authenticator app, then sign in again with a code.” After the recovery codes, the page shows the primary “Sign in again”, which signs out and opens `/sign-in`. Enrolling needs a sign-in within the last 15 minutes; the shell already handles the kit’s `reauth_required` (**Exists**). Until the account is read, the skeleton of the “Before you start” panel (15.7), with “Loading two-step sign-in”.

**P8. Staff sign in again (`/staff/sign-in-again`).** Title “Sign in again to use the staff console”. The body depends on the reason:

- `session_before_codes`: “This session started before two-step sign-in was on.”
- `session_too_old`: “Staff sessions need a fresh sign-in with your code every 60 minutes.”

Primary: “Sign in again” (kit `POST /auth/logout`, then `/sign-in`).

### 16.3 Client app pages

D29: on these member pages, `{location}` in copy is the location's shown name (`shownLocationName` in `client/src/portal/locations/naming.ts`): the organization's name while it has one location, the location's own name with several. That covers Home's loading line (P11), the no-forecast line of “How Townwise estimates” (13.2), Step 3's location card and import question, every Sales data line, the delete dialog and its typed name (P12), the upload's “Which value is {location}?” and result lines (P13), Your data's lead, table and empty line (P26) and Location settings' lines (P16). Pending: TownwiseAI's landing (P25, “Ask TownwiseAI about {location}”) still names the stored name until its route passes the shown name. Typed confirmations compare against the shown text the dialog prints. The upload still preselects a location column's value by the stored name, and the staff console always shows stored names. [CONFIRM: with one location, member pages name it by the organization's name]

**P9. Locations (`/dashboard`)**

- With one location, it redirects to that location’s Home (P11) and keeps any one-time notice.
- With several: eyebrow is the organization name, title “Locations”. Org admins get an outline “Add location” on the right. One row per location: name (link), town, “{n} days of sales” (`mono`), the calibration heading in words, and “{n} notes”. Rows are at least 44px, with a `raised` hover.
- For org admins, while the request’s location count is higher than the locations created: “Your request mentioned {n} locations. Add the others when you’re ready.”

| State | Shows |
|---|---|
| Loading | The skeleton of the table and Your towns (15.7), with “Loading your locations” |
| Empty, org admin | Title “Add your first location”. Lead: “Pick its town. For the twelve towns Townwise profiles, you’ll see public data on what moves demand there.” The P10 form inline; primary “Add location”. D29: a single checked place has no Name field and is added as “{Google name}, {Town}”, and by hand there is Town alone, named “{Organization name}, {Town}” (10.3); with two or more checked, each has a Name with its default. When a press adds some checked places and leaves rows, the form stays with them, rather than the redirect or the list, until a press adds the rest or one is added by hand. |
| Empty, member | “Your admin hasn’t added a location yet.” |
| Error | Network copy with Try again |
| Success | The list, or the redirect. After a join, the notice “You joined {org}. {inviter} added {email}. Not your team? Leave {org}.” (F1) |

**P10. Add location (`/locations/new`, org admins).** Fields: Name, and Town (as P3); while the Google Places search is on, the form starts with the places checklist instead (as P3’s Step 1, 10.2a, with “Search Google Maps for the location”), and each checked place has a Name field that starts as “{Google name}, {Town}”, or “{Organization name}, {Town}” for a street address, with the town not repeated when the name holds it and the name cut so the town stays within 80 characters (D29, 10.3). While the organization has no location yet, a single checked place has no Name and is added with that default, and “Can’t find it? Enter it yourself” shows Town alone and names the location “{Organization name}, {Town}”; with a location already, Name shows on every row and is required, and existing locations are never renamed. Staff setup (P21) follows the same rules with the organization’s name and location count. Primary: “Add location”, or “Add {n} locations” with two or more checked, disabled with none checked or while one is loading. A Name left empty says “Enter the location’s name.” on its row, and nothing is sent. Otherwise it adds the checked places one after another, each with its place (the Names read-only and “Can’t find it? Enter it yourself” disabled meanwhile), and each row says how it went: an added row leaves the list; a name another location uses says “Another location already uses that name.” under that row’s Name, and the rest go on; a place Google now answers differently says “Google Maps answered differently this time. Search for the place again, or enter it yourself.” on its row, and the rest go on; the location limit stops the rest with “You’ve reached 25 locations. Write to hello@townwise.tech for more.”; a 503 says “Google Maps isn’t answering right now, so the place wasn’t added. Check the town, then add the location without it.” on its row and stops the rest; any other failure stops the rest with the error and “Try again”, which adds the rows left. Once every row is added, it opens the Home (P11) of the first location that press added. “Can’t find it? Enter it yourself” adds one location by hand, with Name and Town (after a row’s 503, filled in from that row) and “Search Google Maps instead” back to the checked places. Errors by hand: “Another location already uses that name.” and “You’ve reached 25 locations. Write to hello@townwise.tech for more.” On success it opens the new location’s Home (P11).

**P11. Home (`/locations/[id]`, the location’s first page)**

Home replaced the Forecast page here (owner decision, 2026-11-05); its data checks live in P24’s Your data. It is built around the Monday decisions: what is on this week, the bar order, last week against what happened, and this month in town. Until forecasts exist it shows only history and the calendar, never a guess: every figure is a sum, an average or a share of the location’s own stored days, always of a past day, apart from Who’s in town’s headcount range, which is printed only where public counts with stored sources support it (13.2; none is researched today). No figure from the location’s days is shown for a day after the last day of data or after today. It reads `GET .../sales/history`, `GET .../notes` and `GET .../calendar` (10.4, 10.10) in parallel, from two years and four weeks before this week’s Monday to the later of this month’s last day and this week’s Sunday, then on their own `GET .../agent` (the questions count) and `GET .../people-in-town` for this month (10.13), and writes nothing. “Today” is the device’s date and weeks run Monday to Sunday (all twelve towns are Eastern). Built from `client/src/portal/home/` and `client/src/portal/analytics/week.ts`. [Build note: from the calendar change (D30) the one exception to history only is This month’s days from today on, which show a published forecast day’s own figures, as the forecast read leaves them after the owner’s notes (14.5); Home never computes or adds to one. Home also reads `GET .../forecast` for this month (10.13, one read of at most 31 days) on its own: Home never waits for it or fails with it, and while it loads or when it fails no day shows a forecast figure.]

- **Layout: a dashboard of blocks** (2026-11-09, owner request: “more like a dashboard … things fit together like blocks”; `home/Block.tsx`). Every card is a `panel` region with its eyebrow (and any tag) and its h2, on the 12-column grid with the 20px gutter between blocks. From 1024px the blocks of a row sit side by side by their spans and each grows to the row’s height, so edges line up; below 1024px they stack (the glance tiles stay side by side down to 641px). Top to bottom: the lead; At a glance (4, 4, 4); This week (12); This month (8) beside Last week (4); On the calendar in {November} (6) beside Who’s in town (6); Your {November} in past years (6) beside Bar order (6); Your history (12). A block with nothing to show is left out and the others keep their spans.
- Page header (15.2): the title is the greeting “Welcome back, {name}.” with the name the person gave Townwise in Settings (6.22; no doubled full stop when the name ends in one), else “Welcome back.”, which also shows while the name loads or if it can't be read. Under view-as it greets with the target's name, as the target sees it. This is the only page that reads `GET /api/me/profile`.
- Lead: “From your sales through {Wed, Nov 4, 2026} and {Hanover}’s researched calendar.” (“US federal holidays” for a town with no researched calendar; “No sales history yet. Home shows …” with no days; “Every sales upload is turned off. Home shows …” when `uploadsOff`). Then an In progress line, “Townwise hasn’t published a forecast for {location} yet. Until then, Home shows your history and the calendar, never a guess.” ({location} is the shown name, D29), while the month’s forecast read loads, when it fails, and when it answers `no_published_forecast`; with a published forecast (also one that doesn’t cover this month, `not_covered`) there is no In progress line (D30), and, when TownwiseAI has questions, a text link to P25, “{2} questions from TownwiseAI” (“1 question”), counting the questions `GET .../agent` asks that the client knows (P25’s side panel’s read, made on its own after Home’s three). While that read loads, when it fails and when there are none, the line is left out: P25 says “No questions right now” or the error. Side: outline “Ask TownwiseAI” (P25).
- **At a glance** (region), three tiles, shown when the location has days and the history step is not: **This week, last year**: when last year’s same week has at least 5 days with data, its total (40px `value` type), “Same week last year, {Mon, Nov 3} to {Sun, Nov 9, 2025}. From all 7 days.” (or “From {n} of its 7 days.”), “{+9%} against that year’s usual for those days, compared over {n} days.” (when at least 5 have a usual), the busiest day and the quietest open day; otherwise “Fewer than 5 days of the same week last year have data, so there is no total to show.” **Last week**: last week’s total and “{+10%} against the same week last year ({740}), over all 7 days.” (“over the {n} days both weeks have”), or for the other states of the Last week card “Your sales stop at {date}.”, “No {guests} stored for last week.”, “No data for the same week last year.” or “No day has data in both weeks.”; the first two add “Upload sales history” (web; native says where to upload), as the card does. **Next on the calendar**: the first holiday or town event from today to the end of Home’s calendar read (term and season periods mark no day), its title, “{Sat, Nov 7, 2026}, in {2} days” (“Today”, “Tomorrow, {date}”, or “On now, until {date}” for one that began earlier) and its kind; otherwise “Nothing on {Town}’s calendar through {date}.”. Each figure is history; none is a guess.
- **This week in {Town}**, “What’s on the calendar, and how this week went before”. Always: “On the calendar this week: {title} ({weekday}), and {n} more.” or “Nothing on {Town}’s researched calendar this week.”, over holidays and town events only. Term and season periods span weeks, so they mark no day: each one covering the week is said once under that line with its whole span and sources (“Fall term classes. Term, Sep 14 to Nov 17, 2026.”), and with no holiday or event the line reads “No holiday or town event on {Town}’s researched calendar this week.” From 1024px the week is a strip, a column per day, Monday to Sunday, with today’s column `raised` and its 6px `mint` square: the day (with this week’s own figure only for a past day with data), then rows On the calendar (each event with its kind and “Source: {label}” links, each note in words with its detail, or “Nothing listed”), Last year and Two years ago (the same weekday 52 and 104 weeks earlier: “{Sat, Nov 8, 2025}: {241} guests”, “{+31%} vs usual”, closed, and the holidays and town events on that day; “No data”; the second row only when any of its days has data). Last year’s cells start with a `mint` bar (aria-hidden) scaled to the busiest of those seven days, over the printed figure. The strip is a table: a column header per day, a row header per row. Below 1024px the same content is a row per day (today in the selected-row idiom), with columns Day, On the calendar, Last year and Two years ago. The footnote defines both terms: “Last year means the same weekday 52 weeks earlier. Usual is your average for that weekday in the 4 weeks either side, leaving out closed days, days with a note, and holiday and event days.” [CONFIRM: the baseline for usual] With the strip, “Bars show last year’s days, scaled to the busiest of them.” The coverage line, always: “{Town}’s researched calendar covers {from} to {to} so far, plus US federal holidays.”, or the not-researched lines of P24’s Day panel. “Show the numbers”: Day, Last year, Two years ago, Usual (last year). With no days at all, only Day and On the calendar show.
- **Bar order** (panel), StatusTag Planned, “Order suggestions are planned”: “Townwise will suggest how much more or less beer, wine and spirits to order each week, and by when. It needs a forecast and your usual weekly order first. Townwise can’t see your stock.” No inputs. One line of history when last year’s same week has data for Thursday to Sunday: “Last year this week, Thursday to Sunday brought {58%} of the week’s guests.” (with the day count when the week is partial). [DECISION NEEDED: where the usual order comes from]
- **Last week, {Oct 26} to {Nov 1}** (panel), “Against the same week last year”: on web, seven pairs of bars (last week solid `mint`, last year outlined `line`, aria-hidden) with the key and the printed scale; on native the text and the table only (D21). “Last week: {1,020} guests, {4%} more than the same week last year ({980}), compared over 7 days.”, or “on the {n} days both weeks have” when partial: the totals and the change are over the days with data in both weeks. States: “Your history ends {date}. Upload the days since to compare last week.” with the upload link (web), when the history ends before last week; “No {guests} stored for last week, so there is nothing to compare yet.” with the same link, when it reaches past a gap; “No data for the same week last year, so there is nothing to compare yet.”; no days in common; no history. “Show the numbers”: Day, Last week, Last year, Change. When forecasts arrive (14.3) this card compares forecast with what happened; until then it never shows a prediction.
- **This month in {Town}**, eyebrow “{November 2026}”, whose days open in the Calendar (P27; D30): “Point at a day to see what’s on it. Choose one to open it in the Calendar.” (native: “Tap a day to open it in the Calendar.”), then the month as a grid beside the selected day’s detail (side by side where both fit, the detail under the grid otherwise), and the text link “Open the calendar” (`/locations/[id]/calendar`). The grid, Monday first, with a key (a white corner for a town event or holiday, a `text2` corner for a note, this week outlined `line`, the selected day outlined `mint`). Each day shows its number (mono 13px) and its figure, centered, 18px tabular (15px at 640px and below): before today the day’s stored figure in the location’s metric (`text2`); from today on, with a published forecast day, its middle figure rounded (`white`), a `mint` “+{70}” under it when notes added guests, a booked day’s buyout party with “Booked”, and “Closed” with no figure on a closed day; any other day only its number. Each day’s label says everything it shows, the figure with its range (“Wed, Nov 11, 2026. Veterans Day.”, “Fri, Nov 6, 2026. This week. 1 note.”, “Sat, Nov 7, 2026. This week. Forecast about 282 guests, 250 to 310. Includes 70 guests from your notes. Sample game.”, “Tue, Nov 3, 2026. This week. 110 guests.”). Today is selected at first. On web the grid is `role="grid"`, named by its month, and one tab stop, each day at least 64px tall from 641px (still square): Left and Right move a day, Up and Down a week, Home and End the row’s Monday and Sunday, Ctrl+Home and Ctrl+End the month’s first and last day, never leaving the month; the selection follows focus; a click, Enter or Space opens the day in the Calendar (`/locations/[id]/calendar?day={date}`); a mouse or pen over a day previews it and shows the Calendar’s tooltip (`aria-hidden`: the date, “About {212} guests ({180} to {240})”, “Includes {70} guests from your notes”, and up to three of the day’s reasons, or its events and notes), and leaving the grid restores the selection and hides it; touch shows none. On native each day is a 52px button with its label and selected state, and a tap opens the day in the Calendar. The detail (region “Selected day”): the date as an h3 (“Today, {Thu, Nov 5, 2026}” for today); from today on, with a published forecast day, Forecast (“About {282} guests, likely {250} to {310}.”, plus “Includes {70} guests from your notes.” when notes added guests (“from your rules” or “from your notes and rules” when business rules with a schedule added them, D31); “Booked: a private buyout, {70} guests. No walk-in forecast.”; “Closed.”) and Why (the day’s first three reasons, in the read’s order); On the calendar (each holiday and town event as “Veterans Day. Federal holiday.” with its sources, each note in words with its detail, or “Nothing on the calendar this day.”; term and season periods are left to the list); then, with any history, This day (the day’s own figure for a past day with data, or “No sales stored for this day.”; a day after today has no line, ever), Same weekday last year (as This week’s Last year cell) and Two years ago (only with data).
- **On the calendar in {November}** (block, eyebrow “{November 2026}”): every event and note on the month in date order with its sources (“Veterans Day. Federal holiday.”, “Your note: Private event, more guests than usual.”), or “Nothing on the calendar in {November}.”.
- **Who’s in town** (block, eyebrow “{Hanover}, {November}”): the month’s people in town from today on (13.2, `GET .../people-in-town` for the month, read on its own; `client/src/portal/home/InTown.tsx`), laid out for a glance (2026-11-12, owner request: “make the who’s in town easier to read”). With no headcount on any day of the month it opens with “Townwise can’t put a number on how many people are in {town} yet.” beside a Planned tag. Then the term by time, each group an h3 in `label` type over a 1px `border` rule. **This week** leads with today’s run of days: its headcount first where every input has a source (“{9,500} to {10,500} people in town”, the figure in 40px `value` type with its unit, then “Fall term classes until Tue, Nov 17.”), otherwise the term as one sentence at h3 size (“Fall term classes until Tue, Nov 17.”; “… for the rest of {November}.” when the run reaches the month’s end; “Townwise has no term dates until …” without a term); then a row for each run that starts by Sunday. **Later in {November}**: a row for each run that starts after this week, the dates beside the words (“{Nov 20 to 25}”, “Fall term finals”; “From {Nov 26}”, “Townwise has no term dates”; “Between terms”), the dates over the words at 640px and below, and, when any day of the month has a headcount, the run’s figure (“{9,500} to {10,500} people”, mono 18px) or “No headcount”. Days before today are left out, and events are left to On the calendar. Under the groups, “Between terms is worked out from the term dates.” when a run shown is between terms, and the sources of the runs shown, once each, as “Source: {label}” links (no bare hosts, and none of the holidays’ sources). **Your sales by term**: “Your Saturdays averaged …” when the location has days both in term and between terms, with its “From your sales, …” line. A town Townwise hasn’t researched says so. A failed read shows its error and Try again in that place only. Then, for one of the twelve towns, **Food-service jobs in {Grafton County}**: “{2.6% fewer} jobs in {November} 2024 than in an average month that year.” (“more”, or “About as many jobs … as …” when the gap rounds to 0.0; the figure in mono 18px), with “County, not town. Employment is a stand-in for demand.” and “Source: U.S. Bureau of Labor Statistics, QCEW”.
- **Your {November} in past years** (block, eyebrow “Past {November}s”, only with a past year): one line per past year, newest first, at most three (“{118} guests a day over {30} days in 2025, {9%} below your 2025 daily average over {364} days.”, closed days left out; the year’s day count shows how much of that year the history covers), and “Averages leave out closed days.”.
- **Your history** (panel, root `nativeID` “home-history” for the Reading screen’s animation): “{n} days”, “{first} to {last}. {n} missing days in between. Last upload {date} by {email}.”, the newest year as a heatmap that takes no focus (web; `role="img"` named by its summary), and links “See it in Analytics” and “Upload sales history” (web; native says where to upload).
- **While onboarding’s `needsHistory(org, locations)` is true** (agreement 1 with session 54: the organization has locations and none has a stored day) and this location’s own history has no day: step 3, below, takes the place of At a glance, Bar order, Last week and Your history; This week (calendar only), This month and Who’s in town still show.
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
| Loading | “Loading {location}” (the shown name, D29: the organization's with one location) |
| Empty | No days here: the calendar parts, and each card saying it has no history (“No sales history yet for this location.”, “No sales history yet, so there is nothing to compare.”). When `uploadsOff` they say “Every sales upload for this location is turned off. Turn one back on in Your data to see its days.” (Your history, with an “Open Your data” link) and “Every sales upload is turned off, so there is nothing to compare.” instead; the HistoryStep while `needsHistory` |
| Error | Network copy with Try again. A location id that is not in the organization (deleted, or never theirs): “This location isn’t available.” and a link to Locations. |
| Success | As above |
| View-as | The same page; the upload links are disabled with the read-only line |

**P12. Sales data (`/locations/[id]/sales`)**

- Coverage line: “{n} days, {first} to {last}. {missing} days missing in between.” With missing days, it adds: “Missing days might be closures. Add a closure note.” as a text link that opens C6 prefilled (closure, closed).
- **Chart**: “Daily guests”, or “Daily net sales” when the location has no guest counts. It covers the last 365 days of data, ending at the last day, from `sales/days`. The line is `mint`, solid, 2px. The y scale is printed with “Scale fitted to this location.” and the x ticks are months with their year. Text summary: “Daily guests, {first} to {last}. Highest: {value} on {date}. Lowest day with data: {value} on {date}.” “Show the numbers” opens the daily table (Date, Guests, Net sales) in a focusable scroll region. On native (D21), the page shows the text summary and the table, plus “See the chart at townwise.tech.” [CONFIRM: daily chart on Sales data]
- **By month** (NumbersTable styling): Month, Days, Guests, Net sales. Selecting a month shows its days below the row.
- **Uploads and files** (D28): the line “Every upload and file for {location} is on Your data, where your team can download it, turn it off or delete it.” and a link, “Open Your data” (P26). The Uploads table and Your files moved there.
- Primary: “Upload sales history” (web; on native, the line “Upload from a computer at townwise.tech.”).
- Org admins only, at the bottom: a section “Delete sales data” with an outline “Delete all sales data”. Its dialog reads: “This deletes {n} days of sales data for {location}, any days turned off on its Your data page, and every file on that page. Notes stay. This can’t be undone. Type {location} to confirm.”

| State | Shows |
|---|---|
| Loading | The skeleton of the lead, the chart (its text line on native), By month and Uploads and files (15.7), with “Loading sales data” |
| Empty, uploads off | “Every sales upload for this location is turned off. Turn one back on in Your data to see its days.” (`uploadsOff`), with the Your data link below; no upload prompt |
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
| Loading | While parsing, the skeleton of Match columns (15.7) with “Reading {size} file…”; while sending, the skeleton of the result with “Sending {days} days…” |
| Empty | Step 1 |
| Error | “That file is larger than 50 MB.”, “That doesn’t look like a CSV file. Excel file? Save it as CSV first.”, “That file has no header row.”, “Choose a guests column, a net sales column, or both.”, “No rows had a readable date. Check the Date column.”, the item-level refusal, “This file covers more than 10 years. Upload up to 10 years at a time.” A server 400 shows “Something went wrong with that request. Reload the page and try again.” A 500 or 503 shows “The upload didn’t finish, and some days may have saved. Send again. Days are never duplicated.” A 429 or network error uses the shared copy; the parsed days stay in memory so Send can be retried. |
| Success | The result line (11.2, step 4) |
| Native | Not offered; the Forecast and Sales data tabs say “Upload from a computer at townwise.tech.” |
| View-as | “Choose a CSV file” is disabled, so no client file is ever read into a staff browser |

**P14. Notes (`/locations/[id]/notes`)**

- Intro: “Notes record what your sales can’t show: a closure, a private event, an opening. Add past ones to explain unusual days, and upcoming ones for the dates ahead. Townwise keeps them with this location. Nothing reads them yet.” [Build note: from the calendar change (D30, 14.5) the intro's last sentence is “From today on, a private event with a guest count, a buyout or a closure changes Townwise’s forecast for its days. TownwiseAI reads every note.” in place of “Nothing reads them yet.”]
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

  [Build note: from the calendar change (D30) a note with hours shows them with its weekdays under the dates, “{Mondays} only, {6 pm} to {9 pm}” or “{6 pm} to {9 pm}” alone.]
- **C6, the note form.** Fields:
  - Kind: Closure, Private event, Opening, Other.
  - Starts.
  - Ends (optional; defaults to the start).
  - “Only on these days”: seven weekday buttons with `aria-pressed`; pressed takes the `mint` fill and the `on-mint` label, as pressed controls do in the design system.
  - Effect, defaulted by kind.
  - Expected guests (optional; hidden when the effect is Closed).
  - Details (optional; required for Other), with the helper “Describe the event, not the guests. Leave out names.”
  
  [Build note: from the calendar change (D30, 12) the form adds “Starts at” and “Ends at” after Ends: optional local hours, 24-hour `HH:MM` with the helper “24-hour, like 18:30. Leave empty for all day.”, both or neither, the start before the end, hidden for a closure (anything typed there is dropped). Field messages: “Enter a time as HH:MM, for example 18:30.”, “Enter both times, or neither.” and “The end time is before the start time.” On a private event, the Closed effect reads “Buyout, closed to walk-ins all day” (a label of this form only), and with it Expected guests stays, labeled “Guests at the buyout (optional)”; it is still hidden for Closed on any other kind. On a private event with more guests, Expected guests has the helper “Townwise forecasts whole days, so these guests add to the whole day’s total, on each day the note covers.”, since forecasts are daily and hours don’t narrow them (12).]

  Its primary is “Save note”, then “Cancel” as a text link.
- Delete asks “Delete this note? This can’t be undone.”

| State | Shows |
|---|---|
| Loading | Under the intro, the skeleton of Add a note and Coming up’s table (15.7), with “Loading notes” |
| Empty | “No notes yet.” and the intro |
| Error | Field messages: “The end date is before the start date.”, “Pick a range of a year or less.”, “Add details for an Other note.”, “Enter a whole number from 1 to 20,000.” A save failure: “Couldn’t save the note. Try again.” 409 `note_limit`: “This location has 1,000 notes. Delete old ones to add more.” |
| Success | The lists. The saved note takes the selected-row idiom, and the notice reads “Saved.” |
| View-as | Add, Edit and Delete are disabled |

**P15. Town (`/locations/[id]/town`).** The town profile from Section 13, using the `TownProfile`, `DeltaChart`, `MonthScrubber` and `NumbersTable` web components this build extracts from `TownPanel.web.tsx`, styled as the design system builds them, followed by the notes row content (drivers and dates with sources, the Curve line, the caveats, the index definition and the sources). On native (D21): the text summary and the “Show the numbers” table, then the same notes row content, plus “See the chart at townwise.tech.” Loading shows “Loading map data”. Failure shows “The town data did not load. Try again.” The gaps follow Section 13.

**P16. Location settings (`/locations/[id]/settings`, org admins)**

- Fields: Name, and Town. Primary: “Save changes”. D29: with one location, Name keeps the location's own name with the helper “Shown only once {org} has more than one location.”; with several it has no helper.
- Beside Name and town: “Another restaurant is its own location, with its own sales, notes and forecast.” and the outline link “Add another location” to P10, disabled under view-as. With one location, Locations (P9) opens that location's Home, so this and Settings (P18) are the ways to P10.
- After Name and town, a section kicked “TownwiseAI”, titled “Business rules” (D31): “The standing facts TownwiseAI keeps in mind for {location}. Only a rule with a schedule changes Townwise’s forecast.” ({location} is the shown name, D29) and the outline link “Edit business rules” to P28. It reads nothing.
- While the Google Places search is on, a section “Change this location’s place” (10.3).
- A section “Delete location”. When the location has no sales and no notes, it shows an outline “Delete location” with a typed-name confirmation. Otherwise it says “Delete this location’s sales data and notes first.”
- States: loading; the field error “Another location already uses that name.”; success notice “Saved.”; after a delete, `/dashboard` with “Deleted {name}.”
- D29: “Using this place moves {name} to {town}.”, the dialog title “Delete {name}?”, its typed name and “Deleted {name}.” use the shown name, so with one location they name the organization.

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
| Loading | The list’s table skeleton (15.7), with “Loading your team”; the add form is already there |
| Empty | “It’s just you so far. Add your teammates’ email addresses, and they can join the next time they continue with Google.” |
| Error | 409 `last_admin`: “Your organization needs at least one admin. Make someone else an admin first.” 409 `member_limit`: “Your organization has reached 200 people.” Network copy. |
| Success | As above |
| View-as | Visible only when the target is an org admin. Add, role changes and removal are disabled. |

**P18. Settings (`/settings`)**

- **Account**: Email, Organization, Role, as a definition list.
- **Two-step sign-in**: “Recommended for admins.” plus the link “Two-step sign-in settings” to `/settings/security` (**Exists**).
- **Your name**, in Your account: a field with the helper “TownwiseAI greets you by this name. Leave it empty for no name.” and “Save your name” (outline), from `GET` and `PATCH /api/me/profile` (10.2). An invalid name shows “Use letters, spaces, hyphens or apostrophes, up to 40 characters.” Under view-as the field shows the target's name, disabled.
- **Organization name** (org admins): a field and the page’s primary, “Save name”. Beside it: “Locations have their own pages. Rename one or change its town from Location settings on that location’s page.” and the outline link “Add location” to P10, disabled under view-as (P9 opens the only location's Home, so it never shows its own Add location then).
- **Townwise staff activity** (org admins, from `GET /api/org/staff-activity`). Above the table: “Each time Townwise staff use View as to see your sales and notes, it’s recorded here with its reason. Before anyone from your organization joined, staff setting it up may have opened it as its admin, which shows them what an admin sees; each time is listed here, with every change they made. Otherwise staff can see your team’s email addresses, your location names and towns, and which dates your data covers. Any change staff make to your team, name or status is listed here too.” (D25) Table: When, Staff (“Townwise staff ({email})”), Action (the server’s summary, for example “Viewed as {email}” or “Added {email} as member”), Reason and Until (view-as rows only). A row with `notApplied` adds “Didn’t take effect.” [Build note: the field is `applied: false`, with `notAppliedReason`, the reason in plain words, to show beside it.] The table shows 50 events at a time; while `nextBefore` is set, “Show older staff activity” below it adds the next 50. Empty: “Townwise staff haven’t viewed or changed your organization.” (D9)
- **Leave {org}**: an outline button. Confirm: “Leave {org}? You lose access right away. Your notes and uploads stay with {org}.” 409 `last_admin` uses the P17 copy.
- **Sign out**: “Sign out” and “Sign out on every device” (kit `POST /auth/logout-all`, **Exists**; the shell has no screen for it yet), both text links. [CONFIRM: add sign out on every device]
- States: loading (for an org admin, the skeleton of the whole page while the staff activity loads, 15.7, with “Loading your settings”), and network error with Try again.
- View-as: every write is disabled.

**P24. Analytics (`/locations/[id]/analytics`)**

Every figure is a count or an average of the location’s own stored days that the filters keep, from `GET .../sales/history`, `GET .../notes` and `GET .../calendar` (10.4, 10.10); the model card reads `GET .../estimates/about` (10.13). Nothing is estimated, nothing is shown for a day after today, and a figure with too few days behind it says so instead. The page writes nothing; its filters live in the page’s state only (never the URL or storage) and reset when it closes. Built from `client/src/portal/analytics/`.

- Lead: “{n} days, {first} to {last}.”
- **Filters**, one block that drives the page (labeled groups in a row on desktop, stacked on phones; a change never animates or moves focus):
  - Color by: Guests (default when any day has guests) or Net sales, a radio group with one tab stop whose arrows move the choice. A metric with no data is disabled, with “No guest counts in your history.” or “No net sales in your history.”
  - Show on the calendar (checkboxes, all on): Town events, Holidays, Your notes, Closures. They change only the heatmap’s marks and labels.
  - Include in the numbers: Closed days (off), Days with a note (on; closures follow Closed days only), Holiday and event days (on). They change every average, chart, type of night and the heatmap’s levels; a value they leave out is drawn as “Left out”.
  - Years: one per year with data, all on. Unchecking the last is refused: the box stays checked and “Keep at least one year.” describes it.
  - The checkbox is a shared control (`ui/Checkbox`): a real `<input type="checkbox">` in its `<label>` on web, a Pressable with the checkbox role and state on native; checked takes the `mint` fill with an `on-mint` check; disabled keeps its focus with `aria-disabled`.
- **Every day.** The heatmap (web): one grid per checked year, newest first, 7 weekday rows (Monday first) by week columns of square cells; four `mint` levels from the quartiles of the kept values, “No data” `raised`, “Left out” `state`, closed outlined, a white corner square for a holiday or town event and a `text2` one for a note. A visible legend above; under it the summary (“{Daily guests}, {first} to {last}. Busiest: … Quietest open day: … {n} closed days.” and what the town calendar covers) and the basis line; “Show the numbers” is the month table (Month, Days with data, Total, Average; every value in the checked years, kept or left out). Each year is `role="grid"` named “{year}, daily {guests}”, with row headers; each cell’s label says everything its fill and marks show. One tab stop for the whole heatmap, starting at the selected day or the last day with data: arrows move a day (up and down) or a week (left and right), Home and End the week’s Monday and Sunday, PageUp and PageDown 52 weeks across years, Ctrl+Home and Ctrl+End the first and last day with data; Enter or Space selects, Escape clears, and while a day is selected the selection follows focus. Days after today are blank and never focusable. A mouse or pen over a cell previews it; leaving the grid restores the selection. Native (D21): a month list, newest first (“{month}, {n} days with data, {average} on average”); a month opens its days as 44px rows (date, value, marks in words), and a day opens the Day panel under its row.
- **Day panel** (columns 9 to 12 and sticky from 1024px; under the heatmap below): the date and its status (Closed, No data for this day, Left out of the numbers by your filters, Today); Your numbers (Guests, Net sales, Usual for a {weekday} with the day count and the day’s change, Same day last year); On the town calendar, each event with its kind, dates and “Source: {label}” links, and the line when the town’s research doesn’t cover the day; Your notes in words with “Open Notes”; Where it came from (“From the upload on {date} by {email}.”, “This upload didn’t finish.”, “Upload record not found.”) and, for an upload read from a stored file (F4), “File: {name} ({kind}).”, “Download cleaned CSV” (web, a finished upload; never under view-as, where the line reads “File: {kind}. Its name is hidden in view-as.”; native says “Download from a computer at townwise.tech.”) and “Open Your data” (P26); Previous day and Next day (they move the selection, and on web focus the matching cell); “Ask TownwiseAI about this day”, which opens P25 at `?about={YYYY-MM-DD}` to fill its composer with the day (it never sends by itself). Empty: “Point at or select a day to see everything Townwise has for it. Use the arrow keys to move between days.”
- **Weekly shape**, **By month**, **Year over year**, **By type of night**: each a text summary, the chart (web: inline SVG, `aria-hidden`, `mint` 2px marks with square ends, printed scale “Scale 0 to {n} guests. Scale fitted to this location.”; the weekly shape, by month and year over year charts also print their counts up the side at 0, the middle and the top of the scale, each on a `border` rule, leaving out a middle that is not a whole number of guests or dollars; year over year draws the newest year `mint` and older years `line`, each labeled with its year, and a month the stored history does not cover from its first day to its last, such as the month so far, as a hollow point), the basis line and “Show the numbers”. Year over year compares only months with at least 15 kept days in both years and says what is missing otherwise, with “Upload older history” when older exports would help. A type of night with fewer than 2 nights shows its count and “Not enough nights yet.”
- **Biggest drivers**: a table (#, Driver, an effect bar from 50% fewer to 50% more on web, Effect, Seen), “(rough)” under 4 days, the footnote on how effects are measured, the basis line, and a Planned line: “Weather as a driver.” With nothing seen twice: “Townwise needs each kind of day to happen at least twice before it can say how much it moves your numbers.” [CONFIRM: driver thresholds] [CONFIRM: the baseline for usual]
- **How Townwise estimates** (F9): the model card (13.2), in the reading column, above Your data.
- **Your data**: the data checks (Days with data, First day, Last day, Missing days in between, Days with guests, Days with net sales, Last upload “{date} by {email}”), “Analytics reads your stored days, your notes, your town’s calendar and how Townwise estimates. It changes nothing and keeps nothing, not even your filters: they reset when you leave the page.”, and a link to Sales data.

| State | Shows |
|---|---|
| Loading | “Loading analytics” |
| Empty, uploads off | The filters, disabled, and “Every sales upload for this location is turned off. Turn one back on in Your data to see its days.” (`uploadsOff`) with an “Open Your data” link |
| Empty | The filters, disabled, and “No sales history yet.” with “Upload sales history” (web) or “Upload from a computer at townwise.tech.” (native) |
| Error | Network copy with Try again; 404 as on P11 |
| Success | As above |
| View-as | The same page; the upload links are disabled with the read-only line |

**P25. TownwiseAI (`/locations/[id]/agent`, members; `/locations/[id]/chat` redirects here)**

The location's chat with TownwiseAI (server contract: `docs/portal/tuning-chat.md` and 10.12), a chat page (D26). The page has no page header at any width: no eyebrow naming the location, no greeting, no location switcher, “All locations” or “Location settings” (those stay on the location's other pages). Its one h1 is visually hidden and reads “TownwiseAI”. The chat header (the conversation's title, History, New chat and Questions and activity) is the first thing under the top bar, and the chat, the thread with the composer docked under it, fills the rest of the screen's height. The page asks for no name; the name comes from Settings (P18) and greets on Home (P11). Messages and the composer sit in one centered column at most 760px wide. **Questions and activity**, closed by default, is the right column from 1024px (the chat takes columns 1 to 8 while it is open, 1 to 12 while it is closed) and a full-screen sheet below. The composer's button is the page's one primary; the composer, the person's bubbles and the chips are rounded (15.6, D26). Under view-as everything reads and versions still switch, by reading; every write control stays in place, disabled, described by the one read-only line.

- **Header**: no title and no rule under it, so the thread gets the height (History's list marks the open conversation); at the right **History**, **New chat** and **Questions and activity** (“Questions and activity ({n})” while n questions are open; `aria-expanded`), wrapping on narrow phones. History is a disclosure over a small square dropdown, at most 360px and 60% of the window tall and scrolling inside, drawn over the thread on web (on iOS and Android it opens under the header, since Android does not deliver a touch outside its parent's box): each row is the title and date (mono), the open one marked with a mint 6px square and `aria-current`, with **Rename** (the title becomes the field “Conversation name”: Enter saves, Escape cancels; “Use 1 to 60 characters.”) and **Delete**, which asks “Delete this conversation?” with “TownwiseAI’s replies and your messages in it are deleted. Notes you saved from it stay.”; with none, “No conversations yet.” Escape, or opening a conversation from it, closes it and returns focus to History; on web a press outside it and History closes it and leaves focus where that press put it (not while a Rename field or the delete dialog is open). On web focus never falls to the page: a Rename field that closes returns it to that row's **Rename**, and after a delete it goes to History; when New chat, or opening or deleting a conversation, swaps the landing and the thread and focus went with the control used (on phones the header is drawn in each), the composer takes it. History and New chat are off while a reply streams; Questions and activity never is. While TownwiseAI is off or can't load, Questions and activity shows on its own.
- **Empty conversation**: the landing, one column centered top to bottom: “Ask TownwiseAI about {location}” (h2), a line saying what it reads (from the tool table), the composer, then up to four quick-start chips in a group “Suggestions”. Ask chips send at once and show only when Townwise can answer them (“How did last week go?” when the last sales day is within 10 days, “Which days last month were unusual?” with 60 days of sales, “What’s coming up in {next month} in {town}?” for a researched town, “What should I upload?” with no sales); Tell chips (“We’re closed on …”, “We have a private event on …”) fill the composer. No chip asks for a forecast. With no sales: “You haven’t uploaded sales yet, so TownwiseAI can only use {what it reads, from the tool table, leaving out what needs sales}.” and Upload sales (web). The first send docks the composer under the thread, and focus goes with it.
- **Messages**: each starts with a hidden speaker label, “You said” or “TownwiseAI said”. The person's message is a right-aligned bubble (`panel` with a 1px `border`, radius 16, never mint; at most 70% of the column from 641px and 85% on phones), with a row under it, right-aligned: its time, **Edit** (a pencil icon) and **Copy** (web, a copy icon that becomes a check for 2 seconds), then the version navigator when it has other versions. TownwiseAI's reply has no box: its parts in streamed order, Markdown text (paragraphs, lists, bold, links, inline code, code blocks and tables; raw HTML shows as text, only `http:` and `https:` links are links, and they open in a new tab; an image shows as its alt text and is never fetched), tool cards, visuals Townwise drew from its own data (a daily chart of guests or net sales with the forecast's 80% band where a published forecast exists, a weekday or month bar chart, a days table, or metric cards, each with a title, a text summary and “Show the numbers”; native shows the summary and the numbers with “See the chart at townwise.tech.”, D21), and proposal cards. Text deltas are drawn as they arrive, at most every 32ms; while text is what streams, a static caret (▍) ends it, gone on done, stop or failure. While a reply streams, its top reads “Working for {n}s” (whole seconds since the person sent the message, redrawn once a second as plain text, no animation, never announced), then a live timeline: its thinking summary streaming in (small type, `text2`) and each tool step as it runs (“Reading your sales for Oct 1 to Oct 31, 2026” becoming “Read your sales for Oct 1 to Oct 31, 2026”), with nothing under the counter before the first thinking text and between steps (the counter says it is working). Once the reply has ended (done, stopped or failed) the timeline folds into a collapsed button “Worked for {n}s” above the reply (`aria-expanded`, `aria-controls`; named “Worked for {n} seconds”, “1 second” for one, since some screen readers say “12s” as “12 s”) that opens to the same summary and steps; a stored reply shows the same line, from the person's message to the reply's end, for the first reply to a message only, and a later version read back shows “Worked” without a time, or nothing when it has no summary or steps. A reply with no summary or steps shows “Worked for {n}s” as plain text. The page's polite region still says only “TownwiseAI is replying” and “TownwiseAI replied” (and each thing it starts reading), never the counter or the thinking text. Under a finished reply, a compact row of 18px icon buttons, each still named by its words (the icons are decorative): **Copy** (web, its Markdown source; a check while it reads “Copied”), **Helpful** and **Not helpful**, **Regenerate** (the newest reply only), then the reply's time and the version navigator when it has other versions. The time is `mono` in `text3`: “8:59 PM” today, “Nov 9, 8:59 PM” on another day, “Nov 9, 2025, 8:59 PM” in another year; none when it is not known and none while the reply streams. Only the last message of the thread shows its row always; on web every other row is transparent (`opacity` only, so its controls stay in the tab order) until the pointer is over the message or focus is inside it, and on devices with no hover and on iOS and Android every row shows. Behavior of the actions: **Helpful** and **Not helpful** (once rated, only the chosen one shows, pressed, in mint, and pressing it again clears it; after Not helpful, “What went wrong? Optional.” with Got my numbers wrong, Made something up, Missed something I told it, Didn’t answer my question, Too long, Something else, and Skip), and under the row the **Based on** line, built in the client from that reply's tool cards and never written by the model (“Based on your sales from Oct 1 to Oct 31, 2026, your 12 notes, and Hanover’s town profile (bls.gov).”; no reads: “Based on this conversation only.”). A failed or stopped reply keeps what arrived, says it wasn't saved, and offers **Try again**, which sends the same message as a new turn.
- **Versions**: Edit swaps the bubble for the field “Edit your message” (4,000 characters; web: Enter sends, Escape cancels) with **Save and send** and **Cancel**; the edit is sent as a new version of the message, under its parent, and what followed it leaves the page. Regenerate streams a new version of the newest reply in its place; if that one isn't saved, the earlier one comes back. The navigator ‹ {n}/{m} › (a group “Versions”: “Previous version”, “Version {n} of {m}”, “Next version”) shows another version and the path after it, and keeps it as the one shown (under view-as it only reads it). Its ends, and every action while a reply streams, are disabled in place. Edit moves focus into the field; Escape or Cancel returns it to Edit, and Save and send moves it to the composer; Regenerate moves it to the new reply's navigator; a switch keeps it on the pressed arrow.
- **Next questions**: under the newest settled reply only, exactly three, in a group “Suggested next questions”: the model's, or three by fixed rules when it gave none (an older reply, or one that ended early), never the message just sent. One press sends; the chips go with the reply above them, so on web focus goes to the composer, where Stop is. They wrap from 641px and scroll sideways in their own row on phones; none show under a streaming, failed or stopped reply, and they are disabled under view-as or with the budget used up. The model may suggest a forecast question only after `get_forecast` returned a published forecast in that conversation; the fixed rules never do.
- **Tool cards**: one row per call, a mono status word (Reading, Read, Couldn’t read) and what it read, with a detail line from the call's result view (dates, counts and source links only). Once the reply is done the rows sit inside the “Worked for {n}s” disclosure; a row opens to its views as a definition list and its https sources, which open in a new tab. A tool the client has no words for reads “Looking something up”. The words live in `client/src/chat/tools.ts`, with rows for every registered tool and for `get_town_calendar` and `get_people_in_town` ahead of their landing.
- **Proposed note card**: Kind, Date or Dates, Weekdays, Effect, Expected guests and Detail (dates and counts in mono mint). **Save note**, **Edit first** (the note form, filled in) and **Not now** (folds to “Not now.” with Show the note; recorded, still saveable). Saved: “Saved to Notes.” or “Saved to Notes, with your changes.” with Open Notes, and focus moves to it. The actions wait until the reply is stored; a card from a reply that wasn't kept says so and saves through the notes route. Errors stay on the card (note limit, a note Townwise couldn't accept, not found).
- **Proposed for Your data card** (D28, `propose_data_item`; not a tool card, and not in the Based on line): shown for a call whose result view says `shown`. Until the reply is stored it reads “The text shows here when this reply finishes.”; then it reads its own GET (10.12) and shows the title and the text in a focusable scroll region, with **Keep on Your data** and **Not now** (folds to “Not now.” with Show the text; recorded, still keepable). Kept: “Kept on Your data.” (or “Kept on Your data, and deleted there since.”) with Open Your data, and focus moves to it. A reply that wasn't kept reads “This reply wasn’t saved, so there’s nothing to keep from it. Paste the text on Your data to keep it.” Errors stay on the card (storage full, today's upload limit, file storage off, not found). View-as reads it with both actions disabled in place.
- **Composer**: one rounded box (radius 28, `ground`, a 1px `line` border, 5px inside it; a mint border and ring on focus) holding the input and its button, a 44px circle drawn as an icon and named by its words (an up arrow for Send and Stop and send, a filled square for Stop); once the text needs a second line the input takes the box's width and the button sits under it. The input's name is “Ask about your sales, or tell TownwiseAI what it can’t see” (nothing visible), and under the box “Leave out guest names. TownwiseAI answers from {what it reads}.” Grows to 200px at once, then scrolls; 4,000 characters, with a counter from 3,600. Placeholder: “Ask TownwiseAI” on phones; on the landing “Ask about a closure, an event or an unusual day”; docked, the Ask chips' questions and, with sales, “Tell me about last Saturday”, swapping every 4.2 seconds while the composer is empty (web from 641px; never under reduced motion), and Tab in an empty composer takes the one shown. The button (radius 22, 44px, `white`) reads **Send**, **Stop** while a reply streams, and **Stop and send** while one streams and the composer holds text: that stops the reply (it saves nothing, as Stop) and sends the text after the last saved message, trying again up to three times, 500ms apart, while the server still holds the stopped turn, and keeps the text in the composer if it can't. Web: Enter sends, Shift+Enter is a new line, Enter while an input method composes does nothing, and Enter does nothing while a reply streams. **Add a file to Your data** (web, while stored files are on; off in place under view-as): a 44px outlined circle with a plus at the box's left that opens the file picker. Each file goes to Your data as a reference file through the same upload as Your data's Add a file (D28); nothing is attached to the message itself. A line above the composer says “Adding {name} to Your data”, then “{name} is on Your data. TownwiseAI can read it.” for a text file or “{name} is on Your data. TownwiseAI reads only text files, so it can’t open this one.” for any other kind (said once in the polite region); a refused or failed file shows its reason as an alert. The lines go when the next message is sent. From 80% of the month's budget, “Most of {Month}’s budget is used. TownwiseAI pauses when it runs out.” shows above it. What the person typed and hasn't sent is kept per conversation in memory only: it survives opening another conversation and leaving the page and coming back in the same session, not a reload. `?about=YYYY-MM-DD` (from Analytics' day panel) fills an empty composer with “Tell me about Sat, Nov 21” (with the year for another year) and sends nothing; a date that isn't real, or is outside 2010-01-01 to 400 days after today, is ignored (F7).
- **Scrolling**: the log keeps its end in view until the person scrolls up more than 4px; coming back within 40px of the end pins it again; a **Latest** button shows while content grows below the view.
- **Questions and activity** (the header's button): from 1024px the right column (9 to 12), scrolling on its own; below 1024px a full-screen sheet with the heading “Questions and activity” and **Close** (focus stays inside; Escape, Close and Android's back shut it, and focus returns to the button). Closed by default; whether it is open is kept in memory for the session. It holds **Questions for you** (“{n} open”): rule-based questions from the location's own sales and notes (a weekday with no sales on most of its days in weeks with sales on other days, a run of days with no sales), each with what it saw, three answers and a help line saying what an answer does; answered, it says what it did. Empty: “No questions right now.” A Planned tag: “TownwiseAI’s own research (unusual nights, town events it finds) is planned.” **What it’s been doing** (newest first): only real, dated events (uploads read, stored files read, “Read your file for {dates}, {n} days.”, never its name, notes saved from a card or an answer, answers given); an event kind the client doesn't know shows as nothing. Empty: “Nothing yet. Upload sales or save a note and it shows here.” **This month’s budget**: “{Month}: {n}% used. Resets {Mon} 1.”, and from 80% “Most of {Month}’s budget is used. TownwiseAI pauses when it runs out.” [CONFIRM: show owners the monthly chat budget, as percent used] **How TownwiseAI works** (closed by default): what it reads, what it can't see (the weather, staffing, bookings not in notes, guest names), that it never saves a note without you, whether Townwise has a forecast for this location (from `GET .../estimates/about`: “Townwise has no forecast for this location yet, so TownwiseAI answers from {what it reads}.”, or once one is published, “TownwiseAI also reads the forecast Townwise published: {model}, trained on {source} from {date} to {date}, made {date}.”, which also adds “Townwise’s forecast” to what it reads; “Couldn’t check whether Townwise has a forecast for this location.” with Try again if the read fails), **How Townwise estimates**, which opens the model card (13.2) in a sheet (Close or Escape shuts it), and that messages and the data it reads go to Anthropic (with a Privacy link) (F10).
- The log is `role="log"`, named “Conversation with TownwiseAI”, and is not live. One polite live region outside the messages says only “TownwiseAI is replying”, each thing it starts reading, “TownwiseAI replied”, “You stopped the reply”, “TownwiseAI’s reply didn’t finish” and “Showing version {n} of {m}.” (and, once each, that a file the composer's + added is on Your data), and Copy's own says “Copied the reply.”; never the streamed text or a figure. Chips are buttons in a named group, in tab order; every target is 44px, and a disabled control keeps its place and its focus. Card fade-ins (200ms) and Latest (150ms) are instant under reduced motion; the composer grows at once and the caret never blinks.

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

**P26. Your data (`/locations/[id]/data`)**

- Header: kicker “Everything your team added”, title “Your data”, and the lead “Sales uploads, files and text your team added for {location}, newest first. Turn an item off to leave it out of your numbers, forecasts and TownwiseAI without deleting it.” With more than one location, a “Show” select (“{location}” or “All locations”) widens the list to the organization.
- Actions: the primary “Upload sales history” (P13; native says “Upload from a computer at townwise.tech.”), then “Add a file” (any kind of file up to 200 MB, kept as it is for the team; Townwise doesn’t read it for sales) and “Paste text” (a title of up to 120 characters and text of up to 10,000), both web only (D20). The page never guesses that a file is sales. Org admins, with one location shown and a sales file’s original stored, also get “Delete all originals for this location” (11A.7), whose dialog says “This deletes the original of every sales file for {location}. Cleaned copies and days stay, and so do items kept for reference. Files still uploading or being read are skipped. This can’t be undone.” and whose outcome reads “Deleted {n} originals.” (with “{m} files were busy and kept.” when some were).
- **Table** (`ui/DataTable`, “Your data for {location}”): Item (the name, “Daily totals” or the kind’s label; under view-as the API sends no name), Location (all locations only), Added (date and who: an email, “Townwise staff”, “Deleted person”, or “Saved from TownwiseAI”), Kind, Size, Status (On or Off, then what Townwise did: Used, Kept for reference, Kept, not used with the reason, Couldn’t read it, Reading, Waiting for an answer, Uploading, Didn’t finish), Days (“{inUse} of {count} in use, {first} to {last}”, or None) and Actions. Every action’s name names the item (“Turn off: sales.csv”); an item with no name is named by its kind and its days (“Turn off: Daily totals, May 1, 2026 to May 10, 2026”), else by when it was added (“PDF, added Nov 5, 2026”), and so is it in the notices.
- **Actions per row**: Turn off or Turn on (acts at once, announces “Turned off {item}. {location}’s numbers, forecasts and TownwiseAI leave it out until it’s turned on.”), Download original and Download cleaned CSV (web; native says “Download from a computer at townwise.tech.”), Delete original, and Delete. Delete opens a confirm dialog saying what goes and what stays: an upload’s dialog names the days it still holds, its file, that days a later upload replaced and notes stay, and that turning it off keeps the days out without deleting them; a file’s says it is deleted for everyone on the team. Focus moves to the outcome line after a dialog closes. A download waits in its own row (only that row’s download buttons wait), and a failed one says why in that row. “Show older items” loads the next page.
- Rights follow 10.14: the person who added an item or an org admin turns it off or on; an upload’s delete is for org admins only; a Townwise staff upload is managed by org admins.

| State | Shows |
|---|---|
| Loading | The table’s skeleton with its columns (15.7), with “Loading your data” |
| Empty | “Nothing here yet. What your team uploads or adds for {location} shows here.” |
| Error | Network copy with Try again; 404 as on P11 |
| Files off | Add a file, Paste text and the file actions are hidden; uploads still list, turn off and delete. A refusal reads “File storage is off right now, so this can’t be done.” |
| View-as | Names and rights are hidden; every action is disabled in place under the read-only line |

Turning an item off or on and deleting one change the location’s day counts, so the organization is read again when the page closes. “Delete all sales data” (P12) also deletes the files and text items listed here.

**P27. Calendar (`/locations/[id]/calendar`, members; D30)**

One month of the location: each day’s published forecast with what drives it, the town’s calendar, the owner’s notes and, on web, the owner’s own calendar file, with a day’s panel to add, change or delete notes, which change that day’s forecast on the next read (14.5). Built from `client/src/portal/calendar/` (`model.ts` is pure: cells, the day panel, the tooltip, the filters and the months; `ics.ts` reads a calendar file). It reads five existing member routes and adds none: `GET .../notes` (10.5) with `GET .../rules` (10.16, read and read again together; a failure of either is the page's load failure), `GET .../calendar` for the month (10.10), `GET .../sales/days` for the month’s days before today (10.4), and `GET .../forecast` for the month (10.13, one read of at most 31 days); notes are written through 10.5, which carry `openAsAdmin` and the `writes` limiter. “Today” is the device’s date.

- Header (15.2): the location’s eyebrow and the title “Calendar”; the top bar marks Calendar (15.3).
- **Toolbar** (one row from 1024px, wrapping below): “Previous month” and “Next month” icon buttons around the month in words (“November 2026”, `aria-live="polite"`), then the text button “Today”. The page shows 12 months before the current one to 12 after it; the buttons at either end are disabled, which keeps every read inside the API’s 400-day bounds. The filters, a ToggleGroup of chips, all on at first: “Holidays”, “Town events”, “Term dates” (term and season periods), “Your notes”, and “Your calendar” (only after an import). Filters hide marks, chips and list items only; forecast figures and the forecast’s reasons always show. Filter state is the page’s, never stored. Web adds “Import a calendar file” (below); native says “To add events from your own calendar file, open Townwise on the web.” (no file picker is installed).
- **Banner** (only when the forecast read answers `no_published_forecast`): “Townwise hasn’t published a forecast for {location} yet. Days show your history, your notes and {Town}’s calendar. Notes you add now count as soon as a forecast is published.” ({location} is the shown name, D29). A month the run doesn’t cover (`not_covered`), or covers in part, has no banner: those days show no figure, and the panel says “No forecast for this day.”
- **Month grid** (columns 1 to 8 from 1024px, full width below), Monday first, with weekday heads. On web it is `role="grid"` named by its month, one tab stop with a roving tabIndex and P11’s keys; Enter, Space or a click selects a day. Each cell is at least 96px tall from 1024px, 64px from 641px and 52px below (native the same). A cell shows its day number (mono 13px; today `white`, bold), “Closed” or “Booked” when the day is not open, and its figure (22px tabular from 1024px, 18px below, 15px on a phone): from today on, the published forecast’s middle figure rounded, with a `mint` “+{70}” under it when notes added guests, a booked day’s buyout party over “booked”, and no figure on a closed day; before today the day’s stored guests (`text2`) over “guests”, never a forecast. From 1024px up to two one-line chips of the day’s entries (holiday and town event titles, a note’s kind words such as “Private event, 70”, an imported event’s title) and “+{n} more”; below that corner marks as on Home (white for a holiday or town event, `text2` for a note, a `mint` outline for an imported event). The selected day is outlined `mint`, today’s week `line`. Each cell’s label says everything it shows, the range with the figure (“Sat, Nov 21, 2026. Forecast about 212 guests, 180 to 240. Dartmouth home football. 1 note.”, with “Includes {70} guests from your notes.” when notes added guests). A mouse or pen over a day (never touch) shows an `aria-hidden` tooltip: the date, “About {212} guests ({180} to {240})”, “Includes {70} guests from your notes”, and up to three of the day’s reasons (or its entries). [CONFIRM: the Calendar and Home show a published forecast day's middle figure, with its range beside it; TownwiseAI, citations and the TownwiseAI landing keep ranges only]
- **Day panel** (region “Selected day”; a sticky side column 9 to 12 from 1024px, under the grid below, scrolled into view on web when a day is clicked or entered). The heading (h2) “Today, {Wed, Nov 11}” or “{Sat, Nov 21, 2026}”. **Forecast**: “About **{212}** guests”, then “Likely {180} to {240}. About 8 in 10 days land in the range.”; when notes changed the day, “Likely {250} to {310}.” and “Townwise’s model: {180} to {240}. About 8 in 10 days land in that range. Your notes add {70} guests.” (“Your rules add …” or “Your notes and rules add …” when business rules added guests, D31, and the same words in a cell's label, “Includes {40} guests from your rules.”, and the tooltip) (the 8 in 10 sentence goes only with the model’s own range); “Booked: a private buyout, {70} guests. No walk-in forecast.” (“Booked for a private event.” when the model booked it); “Closed.” with “From your closure note.”, “From your business rule.” (a rule's schedule closed it) or “Townwise’s model expects you closed.”; a day the model closed that a private event opened (14.5), “Townwise’s model expects you closed. Your notes open the day with {70} guests.” with no range; a past day “{138} guests” and, when a run covered it, “Townwise’s model forecast {120} to {150}, and the day landed in that range.” (or “outside it”; the run’s own range and `inRange`); otherwise “No forecast for this day.” with the reason in one line. **Why**: the day’s reasons in the read’s order (rules, then notes, that changed the day, the run’s reasons, the other rules and notes; 14.5): a business rule’s reason (“Your rule: closed on Mondays”, worded from its schedule) with its outcome in mono as a note’s; a run reason’s label with “+{12}%” when it has an effect and its source links; a note reason’s label (“Your private event, 70 guests, 6 pm to 9 pm”, made in code from its kind, guests and hours, never its detail) and its outcome in mono: “Adds {70} guests”, “Books the day”, “Closes the day”, “Already in this forecast”, “No guest count, so the forecast is unchanged”, “Townwise only counts guests for private events so far”, “The day is closed”, “The day is booked” or “This day has passed”; and “+{n} more of your notes” past the read’s six. Ranges round low down and high up, the middle figure to the nearest guest (14.4). **On the calendar**: the day’s holidays, town events and term periods with sources (as the filters allow), each note in words with its dates, hours, guests and detail, with Edit and Delete, each business rule whose schedule covers the day (D31; no filter hides it) as “Your rule: {text}” with its schedule summary in mono and, under them, the text link “Open business rules” to P28, where rules are changed (no inline Edit), and each imported event’s title and hours with “Make a note” (“Events from your calendar don’t change the forecast until you make a note from them.”). **Add an event** (the panel’s primary): the note form (C6) inline, prefilled as a private event, more guests, on that day. After a save, “Saved.” until the forecast is read again, then what the saved note did to the selected day, from its reason’s outcome: “Saved. The forecast for {Sat, Nov 21} now includes its {70} guests.”, “… now shows the day booked.”, “… now shows the day closed.”, “… already includes this event.”, “Saved. Add a guest count to change the forecast.”, “Saved. Townwise only counts guests for private events so far, so the forecast is unchanged.”, “Saved. The day is closed, so the forecast is unchanged.”, “Saved. The day is booked, so the forecast is unchanged.” or “Saved. This day has passed, so its forecast stays as it was made.”; plain “Saved.” with no forecast for the day or when the note isn’t among its reasons; Delete asks “Delete this note? The forecast for its days goes back to Townwise’s model.”; after either, the notes and the month’s forecast are read again, the old figures staying dimmed with `aria-busy` until they answer. A 404 on a write says “This note isn’t available.” and reads again; a 409 `note_limit` uses the shared save copy.
- **Your own calendar** (web only). “Import a calendar file” opens a file input (`.ics`, `text/calendar`), with “Export a calendar from Google Calendar, Outlook or Apple Calendar as an .ics file and choose it here. Townwise reads it in your browser and keeps it only while this page is open. Nothing from the file is sent to Townwise unless you make a note from an event.” A file over 1 MB is refused unread (“This file is over 1 MB. Export a shorter range of your calendar.”); a file that isn’t a calendar gets “This doesn’t look like a calendar file (.ics).”; one that can’t be read “Couldn’t read this file. Choose it again.” Otherwise “{n} events from {file}.”, plus “{k} repeating events weren’t imported. Add them as notes with weekdays.” when it had any, and “Your calendar” appears, on. Events within 400 days of today are kept, at most 2,000, the first by start; repeating events are counted, not imported; canceled ones are left out. [CONFIRM: 1 MB and 2,000 events for a calendar file] Imported events live in the page’s memory only: gone on reload, on sign-out and on leaving the page. “Make a note” opens the note form as a private event, more guests, with the event’s dates and, for a timed one-day event, its hours; its detail stays empty, because calendar titles often name customers. A timed event that ends by 06:00 the next morning (a party from 18:00 to 01:00) is its start day’s only, shown there with its hours, so its note covers the start day alone and its guests count once; the note leaves the hours out, since a note’s end comes after its start. [CONFIRM: 06:00 cutoff] Only notes, and business rules with a schedule (D31), change the forecast.
- **URL.** `?day=YYYY-MM-DD` is the selected day, and the month follows from it; choosing a day sets it, so a reload or a link from Home (P11) opens that day. A missing or invalid day, or one outside the 25 months, falls back to today.

| State | Shows |
|---|---|
| Loading | “Loading the calendar”; on a month change the last month stays, dimmed with `aria-busy`, until the new reads answer |
| Error | The notes, calendar or sales-days read failing: network copy with Try again for the page. The forecast read failing on its own: the page without forecast figures and “Couldn’t load the forecast for {November}. Try again.”, which reads only the forecast again |
| No published forecast | The banner; days show history, notes and the town’s calendar |
| Success | As above |
| View-as | The page reads in full; Add an event, Edit, Delete and Make a note stay in place, disabled, described by the read-only line. Importing a file is allowed: it reads a file in the staff member’s own browser and sends nothing |
| Open as admin (D25) | As an org admin; notes written then carry `byStaff` |

**P28. Business rules (`/locations/[id]/rules`, members; D31)**

The location's standing facts, which TownwiseAI reads with every message the person sends (10.16, `tuning-chat.md` section 3), each with an optional schedule that changes Townwise's forecast (D31, 14.5). Built from `client/src/portal/rules/` (`rules.ts` mirrors the API's text rule and says whether a schedule changes the forecast; `useRules` holds the list with the page's own writes applied in place) and the note form's fields and checks (`client/src/portal/locations/NoteFields.tsx`, `checkSchedule` in `noteRules.ts`).

- Header (15.2): the location's eyebrow and the title “Business rules”. The page is the top bar's Rules section, right after Notes, for every member (15.3); Location settings (P16) also links to it.
- Lead: “Standing facts about how {location} runs, like “Closed Mondays” or “Brunch only on weekends”. TownwiseAI reads them with every message you send. A rule changes Townwise’s forecast only when you give it a schedule under Change the forecast: a closure, a buyout or a private event with a guest count, on the days you choose. For one day that’s different, add a note.” ({location} is the shown name, D29), then the text links “Open Notes” and “Ask TownwiseAI”. Until TownwiseAI can propose rules, no copy says it suggests or saves them.
- **Add a rule:** a one-line field “New rule” (placeholder “Closed Mondays”, helper “One line, up to 200 characters. Leave out guest names.”), with “{n} of 200 characters” under it from 180 characters; then the optional **Change the forecast** section; then the page's one primary, “Add rule”. Enter submits on web. The page checks the API's text rule before it sends (“Write the rule.”, “Keep it to 200 characters.”, “Take out the special characters.”). Added: the field empties, the section closes and the page says “Added the rule.” At the limit the field is read-only and Add rule and Change the forecast disabled, all described by “This location has 30 rules, the most it can hold. Delete one to add another.”
- **Change the forecast** (in the add form and in a row's edit). Closed, the outline button “Change the forecast” and “Optional. Without it, TownwiseAI reads the rule and the forecast doesn’t change.” Open, a group named “Change the forecast”: “Townwise applies this to its forecast as it applies a note: a closure, a buyout or a private event with a guest count changes the days it covers.”, the note form's fields (C6: Kind, closure first; Starts; Ends (optional), helper “Leave it empty to keep it going.”; Starts at and Ends at; Only on these days; Effect; Expected guests, whose helper says the guests count “on each day the rule covers”), with no Details, and the link “Remove from the forecast”, which closes it. The page checks the note form's rules before it sends, with its messages under the fields (an empty end means no end). Add sends `schedule` only with the section open; Save sends the schedule when the section is open, `null` when the section was closed on a rule that had one, and nothing about it otherwise. A row's edit opens the section, filled in, when the rule has a schedule. At phone width the fields stack as on the note form. [CONFIRM: a rule's schedule may have no end date ("ongoing"); one with an end keeps a note's 366-day span]
- **Rules** (eyebrow “{n} of 30”): a list, oldest first; each row is the rule's text, then what it does to the forecast (“Changes the forecast: {scheduleSummary}” in white for a schedule the forecast applies, a closure, a buyout or a private event with more guests and a count; “On the calendar: {scheduleSummary}. Only closures, buyouts and private events with a guest count change the forecast.” for any other schedule; “TownwiseAI reads this. It doesn’t change the forecast.” with none), then “Added by {email}, {Mar 2, 2026}” or “Saved from TownwiseAI by {email}, {date}” (“Townwise staff” for a rule staff added in open as admin, “a deleted person” when the author is gone), then text buttons “Edit” and “Delete” when `canEdit`. Edit turns the row into the field “Edit rule” and its Change the forecast section, with the outline “Save” and the link “Cancel”; saved, the page says “Saved.” Delete asks “Delete this rule?”, “TownwiseAI stops reading it from your next message.”, with “Delete rule” and “Cancel”; deleted, the page says “Deleted the rule.”
- Write errors where the write happened (the add form, the row's edit, the dialog): 409 `rule_exists` “That rule is already saved.”; 409 `rule_limit` the limit line; 403 `forbidden` “Only the person who added this rule or an org admin can change it.” on an edit, the shared copy in the dialog, and either re-reads GET /api/me (4.3); 404 on an edit or a delete “This rule was deleted.”, and the list loads again; 404 on an add loads the list again, which says the location isn't available; 400 the page's text rule; anything else the shared copy (15.7).

| State | Shows |
|---|---|
| Loading | “Loading business rules” in place of the form and the list |
| Empty | “No business rules yet. Add one above.” under “0 of 30” |
| Error | The shared copy with Try again; a 404 “This location isn’t available.” with the link to Locations, as P14 |
| Success | As above |
| View-as | The list reads in full, with what each rule does to the forecast; the field, Change the forecast, Add rule, Edit and Delete stay in place, disabled, described by the read-only line |
| Open as admin (D25) | As an org admin; rules added then carry `byStaff` and show “Townwise staff” |

### 16.4 Staff console pages

**P19. Requests (`/admin`)**

- Title “Requests”. Tabs, styled as in 15.2: Pending {n}, Approved, Rejected, Withdrawn.
- **Table**, oldest first under Pending and newest first elsewhere: Organization, Contact (name and role), Email, Town, Locations, Sent.
- **Detail panel** for the selected row:
  - every field, with the note as plain text;
  - “Requested as {emailAtRequest}” when the email changed;
  - the warning “This person already belongs to an organization.” when `requesterHasOrg` is true;
  - actions: the primary “Approve” (C3), an outline “Reject” (C4), and a text link “View as” (C1), which shows the Waiting page as they see it.
- **C3, Approve.** Title “Approve {orgName}”. Fields: Organization name, and First location name (prefilled “{orgName}, {Town}”, D29). The town is shown read-only. For a request with places, in place of those two: one group per place, “Place {i} of {n}”, showing the place’s Google name, “ (street address)” after it for an address, and town (the town alone for a request stored before places) above a Location name field prefilled “{Google name}, {Town}”, or “{orgName}, {Town}” for an address or a place stored without a name (the 10.3 default, with the requested organization name). With one location (no places, or one place) the name field has the helper “Shown to them only once they have more than one location.” Two places with one name in one town start with the same name and hit the check below; staff edit one. An empty name, or one that matches another ignoring case and spaces, stops the approve with “Each location needs its own name.” on each such field. Text for one place is the text below with that place’s town; for two or more: “This creates the organization and its {n} locations, and makes {email} its admin. We email them that they’re in, and they get access the next time they open Townwise.” Text without places: “This creates the organization and its first location in {town}, and makes {email} its admin. We email them that they’re in, and they get access the next time they open Townwise.” Primary: “Approve”.
- **C4, Reject.** Title “Reject {orgName}?” Field: “Message to {contactName} (optional)”, with the helper “Shown on their No access page. Up to 500 characters.” Primary: “Reject”.

| State | Shows |
|---|---|
| Loading | The skeleton of the table and the request’s panel (15.7), with “Loading requests” |
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
| Loading | The skeleton of the filters and the table (15.7), with “Loading organizations” |
| Empty | “No organizations yet. Approve a request or create one.” |
| Error | Network copy |
| Success | As above |

**P21. Organization detail (`/admin/orgs/[orgId]`)**

- Header: eyebrow “Organization”, title {name}, then a line with the status, “Created {date}”, and “From request {date}” as a link to that request.
- Actions: outline “Open as admin” (D25, only while `org.inSetup`; it posts `/api/admin/orgs/{id}/open-as-admin` with no body, and the portal then opens the organization’s dashboard under the staff banner; 409 `org_not_in_setup` closes setup as the setup panel’s refusal does, 404 shows the page’s 404 state, and any other error shows under the header facts), outline “Rename”, and outline “Suspend” or “Reactivate”. The suspend confirmation reads “Members of {org} lose access until you reactivate it. Data is kept.”
- Under the actions, one line in `small`, `text2`: “What you change here is listed in {org}’s Townwise staff activity, which its admins see.”
- With no admin: “No admin yet. Add an admin email.”
- **Team**: P17’s table and add form, with a “View as” text link on each active member. Above the add form: “Addresses you add here show as added by Townwise staff. Don’t add your own addresses.”
- **Locations**, metadata only: Name, Town, Days, First day, Last day, Notes, Last upload. Under the table: “Sales figures and notes are visible only through View as.”, or, while `org.inSetup`, “Sales figures and notes are visible through Open as admin until someone joins, then only through View as.” (D25).
- **Setup** (D23, F10b) [Build note: `client/src/portal/console/SetupPanel.tsx`, with `SetupUpload.web.tsx`]: while the organization is in setup (`org.inSetup`: active, and nobody has ever joined it), a section after Locations, kicker “Staff setup”, title “Set up before anyone joins”, through the setup routes of 10.7. Outside setup the page has none of it. Its line: “Nobody has joined {org} yet. You can add its locations and upload their daily totals so its first admin finds a ready page. Use this only with {org}’s consent. Each change is listed in {org}’s Townwise staff activity, and setup closes for good when the first person joins.” In setup the Locations empty state reads “No locations yet. Add the first one below.” The section shows names, towns, day counts and dates, never a figure (D7):
  - A table of the locations (Name, Town, Days with the first and last day) with row actions: text “Rename”, outline “Delete sales data” while the location has days, and outline “Delete” while it has no day and no note. Each opens a console dialog.
  - **Rename** (“Rename {location}”, “Change its name, and its town or its place on Google Maps.”): Name and Town as P16, with “Changing the town takes off the location’s Google Maps place, if it has one.”, and “Search Google Maps instead” while the search is on, which finds a place with “Looks right”, then shows it in the form with “Change place”. “Save changes”, then “Saved.”.
  - **Delete sales data** (“Delete {location}’s sales data?”, “This deletes its {n} days of daily totals, its uploads and any stored files. This can’t be undone. It’s listed in {org}’s Townwise staff activity.”, with the typed name), then “Deleted {n} days and {k} uploads from {location}.” (“ and {f} stored files” before “from” when there were any). 409 `import_running`: “Townwise is reading files for this location. Try again when it’s done.” 503 `files_unavailable`: “Stored files are off right now, so nothing was deleted. Try again later.”
  - **Delete** (“Delete {location}?”, “This deletes the location from {org}. This can’t be undone. It’s listed in {org}’s Townwise staff activity.”, with the typed name), then “Deleted {location}.”. 409 `location_has_data`: “Delete {location}’s sales data first.”
  - **Add a location**: P10’s form, with the Places search first while it is on (the section asks once with autocomplete `{}`, as P3 does), then “Added {location}.” (“Added {n} locations.” when one press added more) and, once every row is added, the form empty again; rows left keep their lines. Its refusals read as on P10, except 409 `location_limit`: “{org} has 25 locations, the most an organization can have.”
  - **Upload daily totals** (web only; native says “Upload daily totals for {org} from a computer.”, D20): “Your browser reads the file here, and Townwise receives only each day’s date, guests and net sales. The days it covers replace the ones the location has. This page shows how many days and which dates, never a figure.”, an “Upload for” location select, “Use an export that covers only {location}.”, and an outline “Choose a CSV file”. The browser reads the file as P13 does (11.2 steps 1 and 2: the same checks and Match columns, with Back and no Cancel), except that Match columns has no location column, so no column’s values are listed, and a header name that reads as a date or an amount shows as “Unnamed (column {n})”: no cell of the file shows. Then “Check the days”: “{n} days for {location}, {first} to {last}.”, “{k} days in this file can’t be sent, so they are left out.” when any are, and “{location} already has {first} to {last}. Days in both are replaced by this file.” when it has days, with “Send {n} days”, Back and “Choose another file”. Only `{ days }` is sent (11.1). Then “Saved {n} days for {location}, {first} to {last}.” and “{location} now has {n} days, {first} to {last}.”, with “Upload another file”. No total, no day’s values and no reason a day was left out show, and the answer keeps only the day counts and dates (its calibration is dropped). The location’s name and days are read as the organization has them now, so a rename during the upload shows at once. Send errors read as P13’s.
  - After each write the page reads the organization again, so Locations shows the days, and the section says how the write ended, where focus moves. A location write’s 404: “{location} was deleted meanwhile.” When any read of the page finds setup closed that it showed open (after a setup write, Suspend, or a join meanwhile), the section goes and the notice says why, from that read: “{org} was suspended, so setup is closed.” when it is suspended, otherwise “Someone joined {org}, so setup is closed. Use View as to see their page.” A setup write that answers 409 `org_not_in_setup` hides the section at once and reads again; if that read fails, the notice says someone joined. Once a newer read lands, `org.inSetup` decides, so an organization reactivated on the page gets the section back while nobody has joined.
- **Recent activity**: the newest 20 audit events for this organization, with a link to `/admin/audit` filtered to it.
- **Forecasts** (14.4) [Build note: the section's component is `client/src/portal/console/ForecastRuns.tsx`]: kicker "Staff only". One line: "A forecast is a draft until you publish it. {org}’s members and TownwiseAI see only published forecasts, never the model. Each import, publish, withdrawal and deletion is listed in {org}’s Townwise staff activity." Per location a table (Model, Dates with the day count, Trained to, Made, Status, Actions), or "No forecast imported for {location}." Actions: primary "Publish" on a draft only, text "Withdraw" on a draft or published run, outline "Delete" on every run, each through a console dialog whose body ends "Its admins see this in their Townwise staff activity." **Import a forecast** (web only; native says "Import a forecast for {org} from a computer."): a location select and "Choose a run file"; the browser reads the file and shows "For {location}: Model {v}, guests, {n} days ({k} open) from {first} to {last}, trained to {date}, made {date}." and "Saved as a draft; owners and TownwiseAI see it only after you publish it." before "Import". Problems read "{path} {words}." from the issue codes, never a value. No figure from a run shows in the console. [Build note, D27: after the runs and before Import, `ForecastsSwitch.tsx` says “Forecasts are off for {org}. Nothing is published, by you or by a calibration, until they’re on.” (or “Forecasts are on for {org} since {date}.”) with a primary “Switch on” or an outline “Switch off”, each through a console dialog; switching on needs the checkbox “{org}’s owner agreed” (10.7). Then `CalibrationsPanel.tsx`: heading “Calibrations”, an outline “Calibrate” per location, whose dialog “Calibrate {location}?” takes an optional “Weekly pattern changed on” date, and the newest calibrations (or “No calibrations yet.”), each with its location and date, status, who started it, the failure or the gate in words, and its scorecard as percentages and counts only (D7): “Weekly error {x}% vs {y}% for the current forecast, on {n} held-out weeks.”, “80% range held {k} of {n} weeks.” and “Weekday bias {b}%.” A calibration’s draft run is listed with the runs above and published or withdrawn with the same buttons; start refusals read as in 10.9.]
- **Delete organization**, last on the page. While the organization is active: “Suspend {org} before deleting it.” and no button. While suspended: an outline “Delete organization”. Its dialog: “This deletes {org}: its {n} locations, their sales data and notes, its team and its request. The audit log keeps the events, with the organization’s and locations’ names removed. This can’t be undone. Type {org} to confirm.” On success, `/admin/orgs` with the notice “Deleted {org}.” (The notice uses the name typed into the dialog; the server no longer has it.)
- States: loading (the skeleton of the facts, Team, Locations and Recent activity, 15.7, with “Loading the organization”); 404 “This organization doesn’t exist.”; network error; success. 409 `org_not_suspended`: “Suspend {org} before deleting it.”

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
- States: loading (the table’s skeleton under the filters and the lookup, 15.7, with “Loading people”), network error, success. There is no empty state, because the viewer is staff. 409 `person_has_seat`: “Remove {email} from {org} first.”

**P23. Audit log (`/admin/audit`)**

- Filters: organization, actor, action. “Load more” pages with `before`.
- **Table**: When, Who (email and role, plus “viewing as {email}” where relevant), Action (the server’s plain-words `summary`, for example “Added {email} as member”), Organization, Details. A staff event qualified by `staff_action.not_applied` adds “Didn’t take effect ({code}).” Redacted values read “deleted person”, “deleted organization” or “deleted location” (9.3).
- States: Loading, the events’ skeleton under the filters (15.7) with “Loading the audit log”, and that line alone under the rows while Load more runs; Empty “Nothing recorded yet.”; Error network copy.

**C1. View-as dialog.** Title “View Townwise as {email}”. Body: “You’ll see what {email} sees, read-only, for 30 minutes. This is recorded in the audit log with your reason, and {org}’s admins can see it. It ends early if {email} joins, leaves or changes organization.” (The clause about {org}’s admins appears only when the target has an organization.) Field: Reason, required, 5 to 200 characters, with the helper “For example, the question you’re helping with.” Primary: “Start viewing”. Errors: 400 `invalid_target` reads “Staff accounts can’t be viewed as.”; 404 reads “This person no longer exists.”; 429 uses the shared copy.

---

## 17. Logging and privacy

- Townwise server code logs ids and counts only: `userId`, `orgId`, `locationId`, `memberId`, `requestId`, `grantId`, `uploadId`, `routeId`. It never logs emails, names, organization or location names, note text, request notes, view-as reasons, figures, file content or request bodies. This matches the privacy page’s promise for sign-in logs (“its own log lines carry your account ID, never your email address”).
- Product log lines: `townwise.view_as_read`, `townwise.upload_applied`, `townwise.audit_write_failed` (error level), `townwise.access_denied { policy, code }`, `townwise.email_sent { kind, requestId, orgId? }` (info), `townwise.email_failed { kind, requestId, orgId?, code, status, upstreamCode, errType }` (warn; D14), and the stored-files lines in `api/README.md` (Audit and logs), which carry ids, kinds, sizes, counts and codes. An email’s log line never holds its address, subject or body. A stored-files line never holds a file name, header, sheet name, location value, cell, figure or the storage SDK's message; the SDK's own logger stays off.
- TownwiseAI’s visuals (`show_visual`) carry figures computed from the location’s sales days and published forecast, and its suggested next questions (`suggest_next`) are text the model wrote. Both reach only the author’s browser (and staff in view-as, who can read the conversation), in the turn’s stream and the conversation GET; neither is ever logged or put in an audit event, and their tool cards have no views (`docs/portal/tuning-chat.md` section 4).
- A rating of a TownwiseAI reply logs `townwise.chat_feedback { orgId, rating, reason }` (info), with no conversation, node or person id and no audit event; the rating itself (`up` or `down` and one of six fixed reasons, no text) lives in the conversation document and goes with it (10.12).
- The welcome’s first name and organization name travel only in the `GET /api/me` body, never in a URL, log line or audit event. The welcome marker (6.15) is deleted with the organization and with the person.
- The display name (6.22) travels only in the `GET` and `PATCH /api/me/profile` bodies, never in a URL, log line or audit event; there is no audit event for setting it. It is deleted with the person (10.7), never with an organization.
- A business rule's text (6.24, D31) is the team's own words. It travels only in the rules routes' bodies (10.16) and in TownwiseAI's conversations, never in a URL, log line or audit event. It reaches Anthropic inside the person's messages: a turn adds the location's rules to the person's message only when the list changed since the last one on the conversation's path, and the conversation stores that block with the message (`tuning-chat.md` section 3), so a rule's text stays in a conversation after the rule is edited or deleted, until the conversation goes.
- Forecast runs (14.4) log `townwise.forecast_imported { orgId, locationId, runId, days, weeks }` and `townwise.forecast_status { orgId, runId, status }`, never a figure or the run file; their audit events carry the model version, dates and day count only. The run file holds no free text, and the model, its features and its training rows never reach the API.
- A stored file is read only by the file reader and returned only to its organization; TownwiseAI and every model read `tw_sales_days` (days that are on), notes and the town calendar, never sales files (6.10 rule 9). The exceptions are a text item the team kept for reference on Your data, which TownwiseAI reads only when asked and only through `ctx.items.readText` (D28), and the AI column step (11A.4), which sends Anthropic a redacted profile of one table (header text and value tokens), never a row, a figure, a file name or an entry path; only `chat/model.ts` and `files/extract/model.ts` construct a model client (test-enforced). Your data’s audit events and log lines (`data.turned_off`, `data.turned_on`, `sales.upload_deleted`, `file.uploaded`, `townwise.file_stored`) carry ids, kinds, sizes and counts, never a file name, an item’s title or text, or a figure.
- The audit log (a database record) holds emails, organization names and view-as reasons. It never holds figures, note text, request notes or decision messages.
- The client never logs (expo-shell rule 12, **Exists**) and never persists the file or the parsed rows.
- The owner’s own calendar file on the Calendar (P27, D30) never leaves the browser: it is read and parsed in the page, held in its memory only (no browser storage, no upload) and gone when the page closes. Its titles are never put into a note; a note made from an event carries only its dates and hours. Townwise never fetches a calendar link, so there is no server fetch of an outside URL and no calendar sign-in. Note reasons in the forecast read and in `get_forecast` carry a note’s kind words, guest count and hours, never its detail (14.5); the note audit events are unchanged.
- **The privacy page must change before the portal ships.** The sentences on `feature/townwise-web` that become false are listed in 22.4. The new content needs to cover:
  - what an access request stores (name, role, town, note);
  - what a membership stores, including addresses an org admin adds for people who have never signed in and have never seen this notice: the address is stored on the admin’s action, kept on the invitation, and kept in the audit log until that person is deleted (10.7, Deletion);
  - what an upload stores (date, guests and net sales per day, plus upload counts);
  - locations (name, town);
  - notes: kind, dates, weekdays, effect, expected guests, a detail of up to 280 characters, and the author; the organization’s members see them; nothing reads them yet; [Build note: since D30 notes also hold optional hours, and the published forecast and TownwiseAI read them (14.5).]
  - view-as grants and their reasons;
  - per-account rate-limit counters: keys are SHA-256 hashed, and the longest is kept 24 hours;
  - what the audit log stores;
  - who sees each, stated exactly:
    - the organization’s members;
    - Townwise staff, who see sales figures and note text only through View as, or, for an organization nobody has joined yet, by opening it as its admin to set it up (D25); both are audited and shown to org admins;
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
| Caps | constants | 25 locations per organization; 1,000 notes per location; 20 emails per add; 200 people per organization; 30 business rules per location, 200 characters each (D31) | [CONFIRM] |
| Stored files | constants | 11A.2's table | `api/src/files/limits.ts` [CONFIRM] |
| `FILES_BLOB_ACCOUNT_URL`, `FILES_AZURITE_CONNECTION_STRING` | env, not secret | the client files account URL; Azurite's connection string in development only (production refuses it) | `api/src/config.ts`. In Azure the API signs in with its managed identity (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`, `AZURE_CLIENT_ID`) through the token source email uses, or boot fails |
| `TOWNWISE_FILES_MONTHLY_BUDGET_USD` | env, not secret | 5 (0 to 1,000; 0 turns the AI column step off) | the file reader's AI spend per organization per month (11A.4); on only with `ANTHROPIC_API_KEY` [CONFIRM] |
| Clock | dependency | the one `now` function `main.ts` passes to both `createAuth` and `createTownwiseApi` | 7.1 |
| `EMAIL_ENDPOINT` | env, not secret | the Communication Services endpoint, a bare `https://*.communication.azure.com` origin | Absent turns email off (D14); set in production from 2026-11-09. Set together with `EMAIL_SENDER`; in production email also needs the managed identity (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`, `AZURE_CLIENT_ID`), or boot fails; outside production, with `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` unset, it sends through the developer’s `az login` |
| `EMAIL_SENDER` | env, not secret | `no-reply@townwise.tech` | D14 |
| `TOWNWISE_EMAIL_REPLY_TO` | env, not secret | a team member’s address in production | Absent: no Reply-To, and the footer does not offer replies (D14) |
| `TOWNWISE_WEB_URL` | env, not secret | `https://townwise.tech` in production, `http://localhost:8081` by default | A bare origin, for the links in emails; production email requires `https:` (D14) |
| `TOWNWISE_LAB_RUNNER`, `TOWNWISE_LAB_API_URL`, `TOWNWISE_LAB_JOB_ID`, `TOWNWISE_LAB_PROJECT_DIR` | env, not secret | `off` (default), `local` or `azure`; the API's bare origin the job calls back to (`local`); the `Microsoft.App/jobs` resource id (`azure`); the lab's uv project, `../modeling/lab` by default (`local`) | `api/src/config.ts` (`labRunnerOf`). `off` answers 503 `lab_unavailable`. `azure` starts the job with the API's managed identity; `local` spawns `uv run` (development only) and hands the job the API process's own secret as `TOWNWISE_LAB_TOKEN`, made per process and never stored. A runner missing a setting refuses boot, naming each one (D27) |
| `TOWNWISE_LAB_AUDIENCE`, `TOWNWISE_LAB_CALLER_ID`, `TOWNWISE_LAB_TENANT_ID` | env, not secret | `azure` only, each a GUID, set by Terraform: the lab callback app's client id (bootstrap's `lab_callback_client_id`), the lab identity's principal id, and the tenant | `api/src/config.ts` (`labRunnerOf`), `api/src/lab/caller.ts`: the callback accepts only a token for that app, from that tenant, whose `oid` is that identity (10.15) |
| Forecast lab | constants | 20-minute timeout, $0.10 a calibration, 4 a day per organization, gate values in 10.15; 595 days of history (decided by the owner, 2026-11-10) | `api/src/lab/service.ts`, `gate.ts` [CONFIRM: all but the 595 days] |

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
- **Calendar:** `api/test/town-calendar.test.ts`: holidays on their legal days (Thanksgiving 2024 to 2026, Memorial Day, MLK Day, the actual day for July 4, Juneteenth from 2021 only); every event has a labeled https source and `start <= end`; ids unique and stable; overlapping multi-day events kept; the term convention; Hanover’s entries equal `modeling/dartmouth_calendar_2025_2026.csv` row by row. `api/test/calendar.int.test.ts`: Hanover’s events with sources, holidays only and `researched: false` elsewhere, every range rule 400, 404 across organizations.
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
| Hourly forecasts (P27, D30) | A note’s hours show in its reason, but a timed event changes only the day’s total | [DECISION NEEDED: hourly forecasts. Uploads are daily totals (date, guests, net sales), so Townwise can't say how many guests come during an event's hours; an hourly view needs hourly sales from the owner's POS, a new upload field and a privacy review.] |
| A live link to the owner’s calendar (P27) | The Calendar reads an exported `.ics` file in the browser only | [DECISION NEEDED: a live link to the owner's calendar (Google Calendar sign-in, or a subscription URL Townwise fetches on its server). Either sends Townwise every event title, which often names customers, and a fetched URL needs SSRF guards; this build reads an exported file in the browser only.] |
| Keeping an imported calendar (P27) | An imported file lives in the page’s memory and is gone when the page closes | [DECISION NEEDED: whether Townwise keeps an imported calendar between visits. Today it is gone when the page closes.] |

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
10. Staff see values only through view-as (D7); D25 opens organizations nobody has joined.
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
34. Error and notice colors unadopted (15.7).
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
48. Open as admin for an organization nobody has joined yet: full read and write except people, until the first join or the end of the staff sign-in (D25, 8a); the changes made in it recorded after the effect, as an org admin’s (9.3).
49. Your data: turning an upload or reference item off, deleting an upload’s days (org admins), reference items under the stored-files caps and retention, and TownwiseAI reading reference text (D28).
50. The forecast lab's gate values, price and daily limit, and the forecasts switch (D27, 10.15): 12 held-out weeks, half a point of weekly WAPE, 80% ranges holding 65% to 95% of weeks, 2 points of weekday bias, $0.10 a calibration, 4 a day, a 20-minute timeout. (The 595 days of history before a calibration starts was decided by the owner on 2026-11-10.)
51. Notes in the forecast (D30, 14.5): from today on only, never a past day; a buyout books the whole day; a closure note beats every other note, and on a day the model closed a buyout books it and a private event with a guest count opens it with only those guests; an event with hours ends by midnight on its own day (12); an imported calendar event that ends by 06:00 the next morning is its start day's (P27); the Calendar and Home show a published day's middle figure beside its range (14.2).
52. Business rules (D31, 6.24, 10.16): 30 rules per location, 200 characters each.
53. Business rules in TownwiseAI (D31, 10.16): a rule's `<` and `>` reach the model as full-width look-alikes, so a rule never closes its block; the rule itself keeps them.
54. Business rule schedules (D31, 10.16, 14.5): a schedule may have no end date ("ongoing"), and one with an end keeps a note's 366-day span; an Other schedule needs no details; rule reasons are never cut by the six-note cap and come before the notes' in each group.

### 22.3 Decisions needed

- The minimum days of history before calibration (D12, 14.1).
- Whether Waiting states a review time (P4).
- Retention and deletion terms for the privacy page (17, 10.7).
- Whether staff may copy a client’s uploaded days into research notebooks, for that client’s calibration only, and how the copy is recorded, shown to org admins and deleted (14.1).
- What happens to a raw export a client sent directly once that client uploads through the portal (17). Recommended: delete it once its days are in the portal.
- Retention periods for stored files (11A.7). Defaults [CONFIRM]: originals 365 days (lifecycle backstop 400), cleaned copies and reports until the file, its location's sales data or the organization is deleted, never-read drops 30 days, unfinished uploads 24 hours, deleted blobs 7 days in soft delete, storage access logs 365 days.
- What expected guests means on an opening or other note, extra guests or the day's total, before those notes change a forecast; and whether a fewer-guests note with a count lowers it (12, 14.5).
- Hourly forecasts, a live link to the owner's calendar, and whether Townwise keeps an imported calendar between visits (21, P27).
- Whether business rules should ever be shared across an organization's locations (an organization-wide rule), or stay per location (D31). Today they are per location, as the chat, notes, view-as and deletion are; an owner with several locations repeats a rule.
- [DECISION NEEDED: whether admin-only TownwiseAI tools that act at once ask the person to confirm first] Any member's business rule reaches an org admin's own message (10.16), and `start_calibration` checks only the chatting person's role before it starts a calibration and spends from the monthly budget (D27, D31). Today the model is told to start one only when an org admin asks; the code doesn't ask the admin to confirm.

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

**2026-11-12, business rule schedules (D31).** A business rule may carry a schedule, a note's fields but the detail, with an end that may be left empty for no end, checked by the note rules' own code (`readRuleSchedule`, 10.16) and stored as `tw_business_rules.schedule` (6.24). Create and update take `schedule` (null takes it off; PATCH writes only the fields that changed, so racing edits of the text and the schedule both land), and `RuleView` adds `schedule` and `scheduleSummary`. The forecast read applies schedules with the notes, exactly as notes with those fields (14.5), each as a reason `kind: 'rule'` worded from the schedule, never the rule's text; the lab's input reads them as notes (10.15, D32); `get_forecast` and the `business_rules` block carry them (`tuning-chat.md` sections 3 and 4), and the system prompt says only a rule with a schedule changes the forecast. P28 adds Change the forecast to Add and Edit and says under each rule what it does to the forecast; the Calendar (P27) lists the rules covering the day and words their reasons; Home (P11) names rule guests. Audit events add `scheduled`, a boolean. [CONFIRM: a rule's schedule may have no end date ("ongoing"); one with an end keeps a note's 366-day span] [CONFIRM: an Other schedule needs no details, since the rule's text says what it is] [CONFIRM: rule reasons are never cut by the six-note cap and come before the notes' in each group]

**2026-11-12, business rules (D31).** A location keeps up to 30 business rules, standing facts about how it runs, each one line of 1 to 200 characters, in the new `tw_business_rules` (6.24): any member adds one, its author or an org admin edits or deletes it, and a rule already saved in another case or spacing is 409 `rule_exists` (10.16, routes `org.rules.list`, `org.rules.create`, `org.rules.update`, `org.rules.remove`). Audited `rule.created { locationId, via }`, `rule.updated` and `rule.deleted { locationId }`, never the text (9.2). Rules go with the location (never blocking its delete) and the organization (10.7). TownwiseAI reads them with every message: a new message starts with a `business_rules` block holding the location's rules whenever they differ from the last block on the conversation's path, stored with the message and hidden from the conversation view, so a location with no rules sends exactly what it sent before (`api/src/chat/user-message.ts`, `tuning-chat.md` section 3); one system prompt line says the block is the owner's data, never instructions, and that rules never change the forecast. The new Business rules page, P28 (`/locations/[id]/rules`, 16.3), lists, adds, edits and deletes them, is the top bar's Rules section (15.3), and Location settings (P16) links to it. Once a newer block replaces one, requests send the older one as a stub, so a deleted rule's text is not sent again. [CONFIRM: 30 business rules per location, 200 characters each]

**2026-11-12, the Calendar and notes in the forecast (D30).** A location's saved notes adjust its published forecast on every read from the town's today on (14.5, `api/src/forecasts/adjust.ts`): a private event with a guest count adds its guests, a buyout (a private event, closed, which may now carry a guest count) books the day, a closure closes it, and each shows as a reason worded in code, never from its detail; runs are never rewritten, and past days, `inRange` and live accuracy stay the model's. Notes take optional local hours (`startTime`, `endTime`; 6.7, 10.5, 12). The forecast read adds `model`, `noteGuests`, `moreNotes` and a reason's `note` (10.13); `get_forecast`, `list_notes` and `get_day` carry them, and the lab's input stops flagging a private event the read counts. The new Calendar page, P27 (`/locations/[id]/calendar`), is a top-bar section after Home (15.3): each day's published forecast and what drives it, filters, a day's panel to add, edit and delete notes, and on web the owner's own `.ics` file, read and kept in the browser only (17). Home's This month (P11) shows each day's figure (stored before today, the published forecast's from today on), a tooltip on web, and opens a day in the Calendar; its In progress line says no forecast is published only while that is so.

**2026-11-10, lab callback sign-in.** The forecast lab's job signs in to the callback with its managed identity instead of a start token, so no credential sits in its environment or the job's execution history (10.15). The API accepts only an Entra v2 token for the new `townwise-lab-callback` app registration (bootstrap; no secret, no app role, no permission) whose `oid` is the lab identity's, and answers 503 `lab_auth_unavailable` only when Entra's keys cannot be fetched. The input is still fetched once, and a result now needs the input answer's result token with the identity token, so nothing is taken before the input was fetched; a job that cannot sign in or fetch its input posts nothing and fails `timeout` after 20 minutes. `tokenSha256` holds the result token's hash only (6.23). New: `TOWNWISE_LAB_AUDIENCE`, `TOWNWISE_LAB_CALLER_ID`, `TOWNWISE_LAB_TENANT_ID` (18); `TOWNWISE_LAB_TOKEN` is a local job's only. Known risk, deferred by the owner (2026-11-10, re-confirmed 2026-11-11): code running as the lab identity that fetches a sibling calibration's input before that calibration's own job does can read it and post a forged result for it, a published forecast if its scorecard passes the gate and that organization's forecasts are on; no worse than before, since a compromised lab image already runs every calibration and can forge any result it computes (`infra/README.md`, known risks).

**2026-11-10, PR leftovers.** (1) A calibration that publishes a first forecast says what it beat, “Better than the weekday average on its backtest weeks, so Townwise published it.” (`gateWords`, `api/src/lab/gate.ts`, 10.15); one that beat a published model keeps “Better than the current forecast on held-out weeks…”. (2) `GET .../sales` and `.../sales/history` carry `uploadsOff` (10.4, 10.10), true when no day shows because every upload holding days is turned off (D28); Home, Analytics and Sales data then say “Every sales upload for this location is turned off. Turn one back on in Your data to see its days.” instead of “No sales history yet” (P11, P12, P24). (3) `LocationSummary` carries `offDayCount` (also used so Home does not show the history step, P9 says “Uploads turned off” with an Open Your data link, and TownwiseAI’s landing says the uploads are off, when every upload is off) (6.4, 10.1) so the upload check says what happens to days a turned-off upload holds: an org admin’s file replaces those it covers, a member’s leaves them hidden (11.2, 11.4). (4) Keeping text TownwiseAI proposed (`org.chat.item_proposal`) is limited by `townwise:files`, as Paste text is; setting the card aside shares that budget (10.14, Section 10 limits). (5) Owner calls: the 595 days of history before a calibration starts is decided (2026-11-10) and no longer awaits confirmation (D27); open as admin asks staff TownwiseAI’s name question, saved to their own profile, and the Your data page works fully there (8a).

**2026-11-09, forecast lab.** Org admins (TownwiseAI's `start_calibration`, `get_calibration`, `compare_forecast_models`) and staff (the console's Calibrate button) retrain a location's forecast model in an Azure job on the location's own days and notes (D27). The job returns a draft run (`trainingSource: 'townwise_lab'`, 6.20) and a scorecard through two callback routes at `/lab` (10.15), stored in `tw_calibrations` (6.23). The system publishes a draft that passes the gate only for an organization whose forecasts staff have switched on; staff can withdraw it. New: the forecasts switch, the calibration list and start routes, 409 `forecasts_off` on publish (10.7), the `townwise:calibrations` limiter (10.8), actor role `system` and four audit changes (9.2, 9.3), `TOWNWISE_LAB_*` configuration (18), the privacy page's Forecasts paragraph, and the training sentence on the privacy page and in Terms, whose effective date is now November 9, 2026. Person deletion also clears the staff id on an organization's forecasts switch (6.1, 10.7). Calibration status now shows in TownwiseAI and the console (14.2), and the dashboard no longer says calibration isn’t built.

**2026-11-09, Your data.** One page per location, P26 (10.14, D28), lists every upload, stored file and text item. An upload or a reference item can be turned off, which leaves it out of every sales read through one rule on `SalesDayStore` (6.5), or deleted; deleting an upload deletes the days it still holds (org admins). `tw_files` gains `purpose: 'reference'`, `disabledAt`, `disabledBy` and `addedVia` (6.11), `tw_uploads` gains `disabledAt` and `disabledBy` (6.6), and `tw_chat_proposals` gains `kind: 'item'` (6.16). TownwiseAI lists items and reads text items kept for reference through `ctx.items.readText` (6.10 rule 9, 11A.8) and proposes keeping pasted text on a card (10.12). The Upload top-bar section becomes Your data (15.3), and P12’s Uploads table and Your files moved to P26. The privacy page says so before stored files go on (`infra/README.md`, step 18). The chat composer's + adds a file to Your data (P25).

**2026-11-09, TownwiseAI redesign.** P25 becomes a chat page (D26): its h1 greeted the person by the name they gave Townwise (`tw_profiles`, 6.22; `GET` and `PATCH /api/me/profile`, 10.2; asked once on the page and kept in Settings, P18) in place of “TownwiseAI” (15.2) (since 2026-11-11 the greeting is Home's title, the page has no page header and asks for no name); an empty conversation is a centered landing whose composer docks under the thread on the first send; replies are Markdown, with charts, tables and totals Townwise draws from its own data, and end with Copy, Regenerate, Helpful and Not helpful and three suggested next questions; a conversation is a tree, so an edit or a regenerate is a new version with a ‹ n/m › navigator (10.12); and the side column and the phone's three-way switch give way to Questions and activity, a column from 1024px and a sheet below. On this page only the composer, the person's bubbles and the chips are rounded (15.6), and a table in a reply scrolls inside its own region (15.7). Visuals, next questions and the name are never logged, and a rating only as `townwise.chat_feedback`'s enums (17). Drafts stay in memory, never in browser or device storage.

**2026-11-09, open as admin (D25).** While an organization is in setup, staff can open its real portal as its admin from its console page (P21, `POST /api/admin/orgs/:orgId/open-as-admin`), with no reason and no timer of its own, and see and change everything an org admin can except people (Team, invitations, roles, leaving, joining). The grant is a second kind in `tw_view_as_grants` (6.8), live only while the organization stays in setup and the staff window lasts, one per session (8a). A route runs in the mode only when the route table marks it (7.2); the rest answer 403 `open_as_admin_refused`, and staff routes 409 `open_as_admin_active`. The start is recorded before the grant exists, the changes after their effect with actor role `superadmin` and the grant id (9.3), and what staff create reads “Townwise staff”. Rename and Add location carry the organization the page shows, and End the grant it shows, so a tab left on an earlier organization never writes into or ends the current one; a grant that expires with the staff window is recorded as ended, at the time it expired, by the next start or End. A suspension ends a grant for good (`lastSuspendedAt`, 6.1), whether or not End was sent; Sign out sends End first; the view-as banner’s End names its grant too; and Settings’ staff activity pages with “Show older staff activity” (10.3), since every change made in the mode is a staff event. D1, D7, D23, Section 3, 4.2, 6.4, 6.6 to 6.11, 10.1, 10.3, 10.7, 10.9, 15.5a, P18’s staff activity line, Section 17, the privacy notice and the homepage FAQ say so.

**2026-11-09, several places from one search (D24).** A request carries up to 25 checked Google places, `places: { placeId, name, town }[]`, in place of one `placeId`; a request stored with one `placeId` reads as one place named null (F2, 6.3, 10.1, 10.2). `access_request.created` adds `placeCount` (9.2). Approval takes `locationNames` for a request with places and creates a location for each; a retry fills only the missing ones (F3, 10.7). C3 names each place. Places details takes an optional session token (10.2a). P3 checks several places (P3, 10.2a). P10 adds each checked place (P10, 10.3). P9 keeps its inline form while rows are left (P9).

**2026-11-09, email on.** Production sends the two D14 emails: `api/production.env` sets `EMAIL_ENDPOINT` and `EMAIL_SENDER`, and the F2, F3, P3, P4 and C3 copy and the privacy page say so. Locally, `EMAIL_ENDPOINT` in `api/.env.local` sends through the developer’s `az login` (`azure-identity.ts`), never in production, where a missing managed identity still refuses boot (18).

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
