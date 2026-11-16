## Why

A restaurant's own calendar (buyouts, private parties, closures, catering) is the strongest signal Townwise does not have. Today the Calendar page (P28) reads an exported `.ics` file in the browser and forgets it when the page closes, so the forecast, TownwiseAI and the next visit never see it, and a calendar that changes every week has to be exported again every week (GitHub issue #10). The spec leaves both gaps open: a live link to the owner's calendar and keeping an imported calendar are each `[DECISION NEEDED]` (spec section 21, Deferred, and 22.3; P28).

Owner decision, 2026-11-12, on issue #10: Townwise keeps a location's calendars on its server, titles included. TownwiseAI reads the titles, so they reach Anthropic as note text already does. Calendar events change the forecast only through notes the owner saves. The two `[DECISION NEEDED]` rows are resolved by this decision, recorded as a new D entry.

## What Changes

- **Stored calendars per location.** A location keeps up to a small number of calendars, each either an imported `.ics` file or a subscription link. Each calendar's single events are stored with their title, dates and hours, and nothing else from the event (no description, location or attendees). Removing a calendar deletes its events. Deleting a location or organization deletes its calendars.
- **ICS subscription.** An owner pastes a calendar's iCal address (Google Calendar's secret address, Outlook, Apple, or a booking system's feed). Townwise fetches it on its server when it is added and then on a fixed cadence, with a "Refresh now" action. The address is a credential: it is encrypted at rest, never returned to the browser after it is saved, and never logged or audited. The fetch is guarded against server-side request forgery.
- **One ICS parser, on the server.** The browser-only parser (`client/src/portal/calendar/ics.ts`) moves to the API with the same rules (single events within 400 days, at most 2,000, repeating events counted not imported, canceled events left out, the 06:00 late-night rule). An imported file is sent to the API as text and parsed there.
- **Calendar page (P28).** "Your calendar" reads the stored events once per grid (`gridRange`, the 42 days the grid shows) on web and native. A "Your calendars (N)" button in the header row's trailing slot opens a full-width panel under the row that lists, imports (web), adds, refreshes and removes calendars, with every failure code in plain words, read-only under view-as. It replaces the header row's "Import a calendar file" button and "How importing works" link from `calendar-views` (user decision, 2026-11-14); the help moves into the panel, rewritten for kept calendars. A file import is named after the file. "Make a note" from an event is unchanged: the note's detail stays empty.
- **TownwiseAI reads the calendar.** A new tool, appended to the frozen tool list, returns the location's calendar events (title, dates, hours, calendar name) for a date range. The prompt tells TownwiseAI to propose a note with `propose_note` for an event that changes guests, which the owner saves, and never to copy a name from a title into a note.
- **Unstructured uploads are not in this change.** Reading PDF, Word and other files for TownwiseAI (the "unstructured upload" part of issue #10) belongs to the change `read-files-with-townwise-ai` (PR #69, an owner request of 2026-11-12 with a per-file opt-in), not to this one (owner decision, 2026-11-13).
- **Docs and privacy page.** Spec P28 (its intro, header row, Your own calendar, Loading and View-as text from `calendar-views`), section 17 (privacy), the two `[DECISION NEEDED]` rows in section 21 and their 22.3 bullet, a new 10.18 (routes) and a new D entry, D33; `client/MODULE.md` and `client/src/portal/README.md`; `api/README.md`; `docs/portal/tuning-chat.md`; the public privacy page, which now says calendars are kept with their titles and may be read by Anthropic through TownwiseAI.

Not in this change: Google Calendar sign-in (OAuth), expanding repeating events (RRULE), calendar events changing the forecast without a note, TownwiseAI saving notes without the owner, the owner calendar in `get_day` or on Home, images and spreadsheets for TownwiseAI.

## Capabilities

### New Capabilities

- `owner-calendar`: a location's stored calendars (imported file or subscription link), their events, limits, who may manage them, how they appear on the Calendar page, and how they are deleted.
- `calendar-subscription`: fetching a subscription link on the server: encryption of the address, the request-forgery guards, the refresh cadence and lease, and failure states.
- `townwise-ai-owner-calendar`: the TownwiseAI tool that reads the owner's calendar and the rules for turning events into proposed notes.

### Modified Capabilities

None. `openspec/specs/` is empty; the existing behavior lives in `docs/portal/spec.md`, which this change updates.

## Impact

- **API** (`api/src`): new stores for calendars and their events (`tw_` collections, indexes in `ensureIndexes`); a server ICS parser, a guarded fetcher and a refresh loop (shaped like the file worker and sweeper, under a Mongo lease); new routes in `TOWNWISE_ROUTES`; a new chat tool and prompt line; deletion, audit allowlists, `config.ts` and `main.ts`.
- **Client** (`client/src/portal/calendar/`): a new `api.ts` for the five routes and a pure `calendars.ts` for the panel's words; `YourCalendars.tsx` (the header button and its panel, web and native) replaces the header row's import pair; `IcsImport.web.tsx` posts the file's text instead of parsing it; the page reads the calendar list and, per grid, the stored events instead of holding a file in memory; `ics.ts` and its client test removed; `ui/Button.tsx` gains `expanded` and `controls`; the Calendar skeleton's header holds one 170px block for the button.
- **Infra**: one new Key Vault secret (the calendar address key), referenced from `infra/terraform/production/containerapp.tf`, and a runbook step in `infra/README.md`. No CSP change: the browser only talks to the API.
- **Cost and privacy**: calendar titles reach Anthropic when TownwiseAI reads them, within the existing per-organization monthly budget. Townwise makes outbound requests to owner-supplied URLs, which is new.
- **Depends on** the Calendar page and business-rules work (P28, D30 to D32) and `calendar-views`. Phase 1 (the server) is PR #71 from `origin/develop`; phase 2 (the client and spec) is built on `feat/owner-calendar-client`, which is `feat/calendar-views` with phase 1 merged in, and lands after them.
