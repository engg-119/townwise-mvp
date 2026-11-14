## Context

The Calendar page (P27, `client/src/portal/calendar/`) reads an exported `.ics` file in the browser (`ics.ts`) and keeps its events in page memory. Notes and scheduled business rules are the only inputs that change the forecast (`api/src/forecasts/reader.ts`, `adjust.ts`). TownwiseAI writes nothing itself: `propose_note` returns a proposal the owner saves through `org.chat.proposal`. `read_data_item` reads only `reference` items of kind `text` (`readableByTownwiseAi`, `api/src/data/library.ts`).

There is no server-side fetch of a user-supplied URL, no per-tenant secret and no ICS code in `api/`. Outbound calls today go to fixed vendor hosts with `AbortSignal.timeout`. The container's egress is open and the VNet, the database's private endpoint and the managed-identity endpoint are reachable from it, so request-forgery guards have to live in code. Background work runs in process: the file worker (`files/worker.ts`, a lease per import) and the daily sweeper (`files/sweeper.ts`, a lease in `tw_file_sweeps`, cross-tenant lookups in `stores/cross-tenant.ts`, effects through tenant stores under `scopeForSweep`).

This change builds on the Calendar page and business-rules work (P27, D30 to D32), which is uncommitted at the time of writing. It starts once that work is on `develop`.

Owner decisions (2026-11-12, issue #10): keep calendars on the server with titles; TownwiseAI reads titles; events change the forecast only through notes the owner saves. TownwiseAI reading PDF and Word files was first part of this design (decision 9) and moved to `read-files-with-townwise-ai` (PR #69) on 2026-11-13.

## Goals / Non-Goals

**Goals:**
- A location's calendars, imported or subscribed, are kept and visible on every visit, on web and native.
- A subscription stays current without the owner doing anything.
- TownwiseAI can read the calendar and turn the events that matter into notes the owner saves.
- No new way for a request to reach an internal address, and no calendar address in logs, audit events or responses.

**Non-Goals:**
- Google Calendar sign-in (OAuth) or any calendar write-back.
- Expanding repeating events (RRULE, RDATE). They stay counted, not imported, as today.
- Calendar events changing the forecast without a note, or TownwiseAI saving notes itself.
- The owner's calendar in `get_day`, on Home or in Analytics.
- Images or spreadsheets for TownwiseAI.

## Decisions

**1. Two collections: `tw_calendar_sources` and `tw_calendar_events`.** A source is one calendar: `orgId`, `locationId`, `kind` (`file` or `link`), `label` (the owner's name for it, at most 60 characters), for a link the encrypted address and its host, `generation`, `eventCount`, `skippedRepeating`, `lastSuccessAt`, `lastAttemptAt`, `status` (`ok` or a failure code), `nextRefreshAt`, `leaseUntil`, `createdBy`, `createdAt`. An event is `orgId`, `locationId`, `sourceId`, `generation`, `uid`, `title` (at most 200 characters), `startDate`, `endDate` (inclusive), `startTime`, `endTime`. Description, location, attendees and organizer are never stored.
*Alternative:* events embedded in the source document. Rejected: 2,000 events can approach DocumentDB's document size, and range reads by date want an index on events.

**2. Replace a calendar's events by generation, with no transaction.** A refresh writes the new events under `generation + 1`, then sets the source's `generation`, then deletes events of older generations. Reads filter on the source's current generation. A crash between steps leaves extra rows that the next refresh or removal deletes, and readers never see a mix. This is the "writes ordered so a retry completes them" rule in CLAUDE.md.

**3. One parser, on the server.** `client/src/portal/calendar/ics.ts` moves to `api/src/calendar/ics.ts` with the same rules and limits, held by its existing tests moved to the API. An imported file is posted as text (at most 1 MB) and parsed by the API; the client parser and its tests are removed. *Alternative:* parse in the browser and post the events. Rejected: a subscription needs the server parser anyway, and two parsers would drift (the closed-days mirror shows the cost of keeping two in step).

**4. The subscription address is encrypted with AES-256-GCM** under a key from a new Key Vault secret, `TOWNWISE_CALENDAR_KEY` (32 random bytes, base64), read only in `main.ts` and passed in. Without the key, adding a link answers 503 `calendar_links_unavailable` and the refresh loop does not start; file imports still work. After saving, the API returns only the label and host (`calendar.google.com`), never the address. *Alternative:* store the address in plain text and rely on the database's encryption at rest. Rejected: the address alone grants read access to the owner's whole calendar, and it would sit in plain text in every backup.

**5. A guarded fetcher: `node:https` with a checking `lookup`.** `https:` only (a `webcal:` address is rewritten to `https:`), port 443 only, no user or password in the address. Each hostname is resolved and every address is checked against blocked ranges: loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, including the managed-identity endpoint), CGNAT (100.64/10), unspecified, broadcast, multicast, documentation and reserved ranges, and their IPv6 counterparts (`::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped). The connection uses the address that was checked, so DNS rebinding cannot swap it. Redirects are followed by hand, at most 3, each re-checked. A 10 second timeout, a 1 MB streamed cap, no cookies, and a generic `User-Agent: Townwise calendar reader`. Errors map to codes: `blocked_address`, `unreachable`, `timeout`, `too_large`, `http_error`, `not_calendar`.
*Alternative:* allow only known calendar hosts. Rejected for now: booking systems publish feeds from their own domains. The address check is what keeps the fetch off internal addresses. An allowlist can be added later.
*Alternative:* Node's global `fetch` with an undici dispatcher. Rejected: it needs the `undici` package as a new dependency, and `node:https` gives the same control.

**6. Refresh in process, under a per-source lease.** A loop on every replica wakes every 15 minutes and claims a due source (`nextRefreshAt <= now`, lease free) with one compare-and-set update that sets `leaseUntil`. It fetches, parses and replaces events, then sets `nextRefreshAt` to 6 hours later. A failure keeps the last good events, sets `status` to the code, and backs off (6 hours, then 24). The claim lookup spans organizations, so it lives in `stores/cross-tenant.ts`. The writes go through the calendar store under a scope minted in `access/policy.ts`, as the sweeper does, and the isolation test is updated for both. A link is also fetched when it is added (a failure refuses the add with its code, so nothing broken is stored) and by "Refresh now", which is limited to one per calendar per 5 minutes. *Alternative:* a Container Apps Job on a schedule. Rejected: more infra for a few requests an hour. The loop is shaped like `createFileWorker` (deps in, start and drain) so it can move to a job unchanged.

**7. Routes, spec 10.17, every one `member` with `openAsAdmin`, like notes.** Writes are refused under view-as by the existing guard; reads are allowed.
- `GET /org/locations/:locationId/owner-calendars`: the calendars (no address).
- `POST /org/locations/:locationId/owner-calendars`: `{ kind: 'file', label, ics }` or `{ kind: 'link', label, url }`. The route's `bodyLimit` union (`api/src/access/routes.ts:60`) tops out at `'256kb'` today, so this adds `'2mb'`, used by this route only, and notes it in the union's comment: the file's text arrives as a JSON string, where every CRLF, quote and backslash takes two bytes, so the handler counts the file's own bytes against the 1 MB cap (400 `too_large`). Each link add is a fetch, so it spends one of the account's 12 link adds an hour before fetching (429 `rate_limited`): removing a link and adding it again then fetches it no more often than "Refresh now" may. *Alternative:* send the file through the chunked Files upload. Rejected: that needs blob storage, which is off in many environments, for a file the API parses once and does not keep.
- `POST /org/locations/:locationId/owner-calendars/:calendarId/refresh`: a link only.
- `DELETE /org/locations/:locationId/owner-calendars/:calendarId`.
- `GET /org/locations/:locationId/owner-calendars/events?from&to`: at most 92 days, `to` at most 400 days after today.

A calendar from another organization or location answers 404, the same as an unknown id (tenant isolation).

**8. TownwiseAI tool `get_owner_calendar`, appended at the end of the registry.** Input `{ from, to }` with the limits of `get_town_calendar`. Returns `{ events: [{ calendar, title, startDate, endDate, startTime, endTime }], truncated, calendars, skippedRepeating }`, at most the first 100 events by start with `truncated` true when there are more (a location can hold 10,000; 100 at the longest title and name are about 41,000 characters), or `{ available: false, reason }` when the location has no calendar. The input view shows the dates and the result view shows counts only, as for other tools. One prompt line: read it for questions about the restaurant's own bookings; for an event that changes guests, propose a note with `propose_note`; never copy a person's or group's name from a title into a note. Titles are never logged, and tool inputs and results are never logged (existing rule).

**9. (Withdrawn 2026-11-13: moved to `read-files-with-townwise-ai`, PR #69.) PDF and Word for `read_data_item`.** `readableByTownwiseAi` accepts `pdf` and `docx` as well as `text`, under the same conditions. A PDF is returned as a `document` block inside the tool result (the installed `@anthropic-ai/sdk` 1.3.0 accepts this in `BetaToolResultBlockParam.content`), capped at 10 MB and 100 pages. A larger one answers `{ available: false, reason: 'too_large' }`. A Word file's paragraph and table text is extracted in the parse thread with the existing zip guards and returned as text under today's 20,000 character cap. The saved conversation keeps only the reference and counts, as it does for text items, so the bytes are not stored twice. *Alternative:* extract PDF text with `unpdf` in the API. Rejected: `pdf.ts` is the only file allowed to import `unpdf` and it runs in the parse thread for tables; the model reads PDFs, layout included, better than our text extraction would.

**10. Privacy and audit.** Audit events `owner_calendar.added`, `owner_calendar.removed` and `owner_calendar.refreshed` carry ids, `kind`, event counts and the status code only. They never carry the label, host, address or a title. The refresh loop logs source id, status code, counts and duration. Deleting a location or organization deletes both collections in `handlers/deletion.ts`.

## Risks / Trade-offs

- [Event titles name customers and now leave the browser] → Owner decision, recorded as a D entry. Titles are never logged or audited, deleted with their calendar, and disclosed on the privacy page.
- [Server-side request forgery through an owner-supplied address] → The address check on every resolved address, pinned connection, re-checked redirects, port 443 only. Unit tests cover each blocked range, a redirect to a private address and a hostname that resolves to one.
- [A Key Vault key that is lost makes every stored address unreadable] → Each link then fails with `status: 'key_mismatch'` and the owner pastes it again. Events already stored are unaffected. The runbook says the key is never rotated without re-adding links.
- [A slow or huge feed ties up a replica] → 10 s timeout, 1 MB cap, one fetch at a time per replica, 2,000 events kept.
- [Repeating events are common in subscriptions and are not imported] → They are counted and shown ("12 repeating events weren't imported"), as today; expansion is a follow-up.
- [The base work (P27, D30 to D32) is uncommitted and still changing] → Implementation waits for it to land on `develop`, then branches.

## Migration Plan

1. The key joins `api_secrets` (`infra/terraform/production/main.tf`) only when `enable_calendar_links` is true, default false, as `enable_chat` does for the chat, so a release deploys with links off and file imports working. To turn links on, seed `townwise-calendar-key` in Key Vault, then set the flag and apply (`infra/README.md`, step 21).
2. Deploy. New collections and indexes are created at boot by `ensureIndexes`. No existing data changes.
3. Rollback: redeploy the previous image. The new collections are ignored by the old code; drop them by hand if the feature is abandoned.

## Open Questions

- [CONFIRM: 5 calendars per location, 6 hour refresh, a 60 character name] (defaults I chose).
- [CONFIRM: 12 link adds per account an hour].
- Whether "Make a note" from an event should now offer the title as the note's detail. This change keeps it empty, as the spec says today.
