## Why

A restaurant's own calendar (buyouts, private parties, closures, catering) is the strongest signal Townwise does not have. Today the Calendar page (P27) reads an exported `.ics` file in the browser and forgets it when the page closes, so the forecast, TownwiseAI and the next visit never see it, and a calendar that changes every week has to be exported again every week (GitHub issue #10). The spec leaves both gaps open: a live link to the owner's calendar and keeping an imported calendar are each `[DECISION NEEDED]` (spec 22.4, P27).

Owner decision, 2026-11-12, on issue #10: Townwise keeps a location's calendars on its server, titles included. TownwiseAI reads the titles, so they reach Anthropic as note text already does. Calendar events change the forecast only through notes the owner saves. TownwiseAI also reads PDF and Word files from Your data. The two `[DECISION NEEDED]` rows are resolved by this decision, recorded as a new D entry.

## What Changes

- **Stored calendars per location.** A location keeps up to a small number of calendars, each either an imported `.ics` file or a subscription link. Each calendar's single events are stored with their title, dates and hours, and nothing else from the event (no description, location or attendees). Removing a calendar deletes its events. Deleting a location or organization deletes its calendars.
- **ICS subscription.** An owner pastes a calendar's iCal address (Google Calendar's secret address, Outlook, Apple, or a booking system's feed). Townwise fetches it on its server when it is added and then on a fixed cadence, with a "Refresh now" action. The address is a credential: it is encrypted at rest, never returned to the browser after it is saved, and never logged or audited. The fetch is guarded against server-side request forgery.
- **One ICS parser, on the server.** The browser-only parser (`client/src/portal/calendar/ics.ts`) moves to the API with the same rules (single events within 400 days, at most 2,000, repeating events counted not imported, canceled events left out, the 06:00 late-night rule). An imported file is sent to the API as text and parsed there.
- **Calendar page (P27).** "Your calendar" reads the stored events for the month on web and native, and a "Your calendars" panel lists, adds, refreshes and removes calendars. "Make a note" from an event is unchanged: the note's detail stays empty.
- **TownwiseAI reads the calendar.** A new tool, appended to the frozen tool list, returns the location's calendar events (title, dates, hours, calendar name) for a date range. The prompt tells TownwiseAI to propose a note with `propose_note` for an event that changes guests, which the owner saves, and never to copy a name from a title into a note.
- **TownwiseAI reads PDF and Word files.** `read_data_item` extends from text items to PDF (sent to the model as a document block) and Word `.docx` (text extracted on the server) reference items, under the same on, kept and stored-files rules. The existing prompt line that proposes notes for dated events in an added item then covers these files too.
- **Docs and privacy page.** Spec P27, section 17 (privacy), 22.4 (decisions), a new 10.17 (routes) and a new D entry; `api/README.md`; `docs/portal/tuning-chat.md`; the public privacy page, which now says calendars and PDF/Word files are kept and may be read by Anthropic through TownwiseAI.

Not in this change: Google Calendar sign-in (OAuth), expanding repeating events (RRULE), calendar events changing the forecast without a note, TownwiseAI saving notes without the owner, the owner calendar in `get_day` or on Home, images and spreadsheets for TownwiseAI.

## Capabilities

### New Capabilities

- `owner-calendar`: a location's stored calendars (imported file or subscription link), their events, limits, who may manage them, how they appear on the Calendar page, and how they are deleted.
- `calendar-subscription`: fetching a subscription link on the server: encryption of the address, the request-forgery guards, the refresh cadence and lease, and failure states.
- `townwise-ai-owner-calendar`: the TownwiseAI tool that reads the owner's calendar and the rules for turning events into proposed notes.
- `townwise-ai-document-items`: TownwiseAI reading PDF and Word reference items from Your data.

### Modified Capabilities

None. `openspec/specs/` is empty; the existing behavior lives in `docs/portal/spec.md`, which this change updates.

## Impact

- **API** (`api/src`): new stores for calendars and their events (`tw_` collections, indexes in `ensureIndexes`); a server ICS parser, a guarded fetcher and a refresh loop (shaped like the file worker and sweeper, under a Mongo lease); new routes in `TOWNWISE_ROUTES`; a new chat tool and prompt line; `read_data_item`, `readableByTownwiseAi` and the item reader for PDF and Word; deletion, audit allowlists, `config.ts` and `main.ts`.
- **Client** (`client/src/portal/calendar/`): `IcsImport` uploads instead of parsing; the page reads stored events; a new calendars panel; `ics.ts` removed once the API owns parsing; Your data marks PDF and Word items as readable by TownwiseAI.
- **Infra**: one new Key Vault secret (the calendar address key), referenced from `infra/terraform/production/containerapp.tf`, and a runbook step in `infra/README.md`. No CSP change: the browser only talks to the API.
- **Cost and privacy**: calendar titles and PDF/Word contents reach Anthropic when TownwiseAI reads them, within the existing per-organization monthly budget. Townwise makes outbound requests to owner-supplied URLs, which is new.
- **Depends on** the uncommitted Calendar page and business-rules work (P27, D30 to D32) landing on `develop` first; implementation starts on a branch from that `develop`.
