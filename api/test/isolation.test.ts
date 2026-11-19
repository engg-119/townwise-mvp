import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

function sourceFiles(): { path: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({ path: relative(SRC, join(SRC, file)).split('\\').join('/'), text: readFileSync(join(SRC, file), 'utf8') }));
}

describe('isolation (source)', () => {
  it('only access/resolve.ts, the active days recorder, the join and decline handlers, the staff handlers, the file reader, the TownwiseAI reader, the sweeper, the lab callback, the calendar refresh loop, Google access, the weekly refresh, the TownwiseAI turn sweep, the title backfill and research’s planner and runner import stores/cross-tenant.ts', () => {
    // A type-only import grants no access to the operations, so it is not counted.
    const importers = sourceFiles()
      .filter((file) => /^import (?!type )[^;]*from '[./]+(stores\/)?cross-tenant\.ts';/m.test(file.text))
      .map((file) => file.path)
      .sort();
    // handlers/me.ts holds the join and decline handlers; handlers/admin.ts and handlers/deletion.ts hold the staff handlers.
    // lab/callback.ts holds the forecast lab job's callback, which finds its calibration by id and token before any
    // organization is known. files/ai-reader.ts (spec 11A.9) claims the next file someone asked TownwiseAI to read,
    // across organizations, as the file reader claims the next import. calendar/refresher.ts claims a due calendar link
    // or Google calendar, and a due Google connection check, in any organization. calendar/google-access.ts checks a
    // person's seat before reading their Google calendar, and whether they hold a Google connection in another
    // organization before revoking (connect-google-calendar). lab/schedule.ts, the weekly refresh (D42), lists its
    // candidates, its live calibrations and its week rows left starting across organizations, and counts the week's starts.
    // access/activity.ts, the active days recorder (staff-overview), removes every organization's rows older than the
    // 180 days kept, once a day. handlers/overview.ts, the staff Overview, reads active days, people's actions, open
    // invitations, chat spend and the Organizations page's counts across organizations.
    // chat/turn-sweeper.ts (resumable-chat-turns) finds the running turns whose lease passed, and the records past their
    // keep, in any organization.
    // files/note-titles.ts, the boot-time title backfill (D49), finds the notes from before titles in every organization.
    // research/plan.ts (D66) lists the towns in use and the locations to research, and sweeps runs ready to merge;
    // research/runner.ts claims location threads and merges and finds a dead lane's thread, in any organization.
    expect(importers).toEqual([
      'access/activity.ts', 'access/resolve.ts', 'calendar/google-access.ts', 'calendar/refresher.ts', 'chat/turn-sweeper.ts', 'files/ai-reader.ts', 'files/note-titles.ts', 'files/sweeper.ts', 'files/worker.ts',
      'handlers/admin.ts', 'handlers/deletion.ts',
      'handlers/me.ts', 'handlers/overview.ts', 'lab/callback.ts', 'lab/schedule.ts', 'research/plan.ts', 'research/runner.ts',
    ]);
  });

  it('D59: only stores/index.ts and the writer import the ledger of TownwiseAI’s changes, and only agent/apply.ts adds to it', () => {
    const importers = sourceFiles()
      .filter((file) => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
        .some((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')) === 'stores/agent-changes.ts'))
      .map((file) => file.path)
      .sort();
    // agent/apply.ts reads the why's length cap from it; stores/cross-tenant.ts clears a deleted person's id from its rows.
    expect(importers).toEqual(['agent/apply.ts', 'stores/cross-tenant.ts', 'stores/index.ts']);
    // The one writer: every change TownwiseAI saves goes through applyChange. Undo moves a row's status
    // (handlers/agent-changes.ts), a file's own undo marks its rows (handlers/data.ts), and (D59 slice 5) a removed
    // calendar's answer notes are taken back as TownwiseAI (calendar/answers.ts takeBackAnswers).
    const writers = sourceFiles().filter((file) => /agentChanges\.(insertApplying|setWritten|markApplied|removeApplying)\(/.test(file.text)).map((file) => file.path);
    expect(writers).toEqual(['agent/apply.ts']);
    const undoers = sourceFiles().filter((file) => /agentChanges\.(markUndoing|markUndone|markAdopted|markSourceUndone)\(/.test(file.text)).map((file) => file.path).sort();
    expect(undoers.every((path) => ['calendar/answers.ts', 'handlers/agent-changes.ts', 'handlers/data.ts'].includes(path))).toBe(true);
  });

  it('product code answers 401 only through userGone() in access/resolve.ts', () => {
    const with401 = sourceFiles().filter((file) => /\b401\b/.test(file.text)).map((file) => file.path).sort();
    // calendar/google.ts reads Google's 401 to pick its `unauthorized` code and never answers one: it builds no AppError,
    // and its callers answer 409 google_reconnect for it (connect-google-calendar, design decision 8).
    expect(with401).toEqual(['access/resolve.ts', 'calendar/google.ts']);
    expect(sourceFiles().find((file) => file.path === 'calendar/google.ts')?.text).not.toMatch(/AppError/);
    const resolve = sourceFiles().find((file) => file.path === 'access/resolve.ts')?.text ?? '';
    expect(resolve.match(/\b401\b/g)).toHaveLength(1);
    expect(resolve).toMatch(/export function userGone\(\): never \{\n\s+throw new AppError\(401, 'unauthenticated'/);
  });

  it('only access/policy.ts mints an OrgScope', () => {
    const casts = sourceFiles().filter((file) => /as OrgScope\b/.test(file.text)).map((file) => file.path);
    expect(casts).toEqual(['access/policy.ts']);
  });

  it('only files/blobs.ts imports the Azure storage SDK', () => {
    const importers = sourceFiles().filter((file) => file.text.includes('from \'@azure/storage-blob\'')).map((file) => file.path);
    expect(importers).toEqual(['files/blobs.ts']);
  });

  it('only the file code reaches stored files, and chat/* never does', () => {
    // Every value import (type-only grants nothing), resolved to a path under src/.
    const imports = (file: { path: string; text: string }): string[] => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
      .map((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')));
    const importersOf = (target: string): string[] => sourceFiles().filter((file) => imports(file).includes(target)).map((file) => file.path).sort();
    const fileCode = (path: string): boolean => path.startsWith('files/')
      || ['handlers/files.ts', 'handlers/sales.ts', 'handlers/locations.ts', 'handlers/deletion.ts', 'stores/index.ts', 'stores/file-entries.ts', 'stores/cross-tenant.ts', 'main.ts'].includes(path);
    for (const target of ['stores/files.ts', 'stores/file-entries.ts', 'files/blobs.ts', 'files/worker.ts', 'files/ai-reader.ts']) {
      expect(importersOf(target).filter((path) => !fileCode(path))).toEqual([]);
    }
    expect(importersOf('stores/files.ts')).toEqual(['stores/cross-tenant.ts', 'stores/file-entries.ts', 'stores/index.ts']);
    expect(importersOf('stores/file-entries.ts')).toEqual(['stores/index.ts']);
    expect(sourceFiles().filter((file) => file.path.startsWith('chat/') && imports(file).some((path) => path.startsWith('files/') || path === 'stores/files.ts')))
      .toEqual([]);
  });

  it('chat/* never touches ctx.files or stores.files, so item text comes only through ctx.items', () => {
    // Dotted reads, destructuring (flat or nested) and bracket reads of `files` from ctx or its stores.
    const reaches = /\bctx\.files\b|\.stores\.files\b|\bfileEntries\b|\{[^}]*\bfiles\b[^}]*\}\s*=\s*[\w.]*\b(?:ctx|stores)\b|\b(?:ctx|stores)\s*:\s*\{[^}]*\bfiles\b|\[\s*['"`]files['"`]\s*\]/;
    for (const sample of ['tc.ctx.files', 'ctx.stores.files.get(', 'const { files } = ctx.stores;', 'const { now, files } = tc.ctx;', 'const { stores: { files } } = ctx;', 'ctx.stores[\'files\']']) {
      expect(sample).toMatch(reaches);
    }
    const touching = sourceFiles()
      .filter((file) => file.path.startsWith('chat/') && reaches.test(file.text))
      .map((file) => file.path);
    expect(touching).toEqual([]);
  });

  it('only chat/model.ts and files/extract/model.ts construct a model client', () => {
    const constructs = sourceFiles().filter((file) => /^import Anthropic(?:,| )[^;]*from '@anthropic-ai\/sdk';/m.test(file.text)).map((file) => file.path).sort();
    expect(constructs).toEqual(['chat/model.ts', 'files/extract/model.ts']);
  });

  it('only files/parse/pdf.ts imports the PDF parser, and only files/parse/docx.ts the XML parser', () => {
    expect(sourceFiles().filter((file) => file.text.includes('from \'unpdf\'')).map((file) => file.path)).toEqual(['files/parse/pdf.ts']);
    expect(sourceFiles().filter((file) => file.text.includes('from \'saxen\'')).map((file) => file.path)).toEqual(['files/parse/docx.ts']);
  });

  it('only access/policy.ts mints the weekly refresh’s scope, and only lab/schedule.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForWeeklyRefresh(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'lab/schedule.ts']);
  });

  it('D66: only access/policy.ts mints research’s scope, and only the research planner and runner ask for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForResearch(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'research/plan.ts', 'research/runner.ts']);
  });

  it('only access/policy.ts mints the title backfill’s scope, and only files/note-titles.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForNoteTitleBackfill(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'files/note-titles.ts']);
  });

  it('only access/policy.ts mints the reader’s scope, and only files/worker.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForClaimedImport(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'files/worker.ts']);
  });

  it('only access/policy.ts mints the TownwiseAI reader’s scope, and only files/ai-reader.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForClaimedAiRead(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'files/ai-reader.ts']);
  });

  it('D59 slice 2: only access/policy.ts mints a claimed calendar sort’s scope, and only files/ai-reader.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForClaimedCalendarSort(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'files/ai-reader.ts']);
  });

  it('a file’s own text leaves the parse code only for a file someone let TownwiseAI read (spec 11A.9), attached (D36) or gave Ordering setup (D41)', () => {
    // readPdfText and readWordText are the only ways a PDF's or Word document's text outside a table leaves the parse
    // code; only the AI text thread calls them, and only the TownwiseAI readers' input (files/extract/input.ts), the
    // item reader and that thread import its runner. The input is asked only by the TownwiseAI reader and the ordering
    // setup's read, whose request is the person's consent to send what they gave it (D41). files/items.ts reads a PDF,
    // Word or Excel file a person attached to a TownwiseAI message and sent: attaching it and pressing Send is that
    // turn's consent (D36), and the item reader is the door chat/* reads it through (ctx.items.readForModel).
    const imports = (file: { path: string; text: string }): string[] => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
      .map((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')));
    expect(sourceFiles().filter((file) => imports(file).includes('files/parse/ai-text.ts')).map((file) => file.path).sort())
      .toEqual(['files/extract/input.ts', 'files/items.ts', 'files/parse/ai-text-thread.ts']);
    expect(sourceFiles().filter((file) => imports(file).includes('files/extract/input.ts')).map((file) => file.path).sort())
      .toEqual(['files/ai-reader.ts', 'handlers/order-setup-read.ts']);
    for (const call of ['readPdfText(', 'readWordText(']) {
      const callers = sourceFiles().filter((file) => file.text.includes(call)).map((file) => file.path).sort();
      expect(callers.filter((path) => path !== 'files/parse/pdf.ts' && path !== 'files/parse/docx.ts')).toEqual(['files/parse/ai-text-thread.ts']);
    }
  });

  it('only access/policy.ts mints the lab callback’s scope, and only lab/callback.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForLabCallback(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'lab/callback.ts']);
  });

  it('only access/policy.ts mints the sweep’s scope, and only files/sweeper.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForSweep(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'files/sweeper.ts']);
  });

  it('only access/policy.ts mints the TownwiseAI turn sweep’s scope, and only chat/turn-sweeper.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForStaleChatTurn(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'chat/turn-sweeper.ts']);
  });

  it('only access/policy.ts mints the calendar refresh’s scope, and only calendar/refresher.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForCalendarRefresh(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'calendar/refresher.ts']);
  });

  it('only access/policy.ts mints the connection check’s scope, and only calendar/refresher.ts asks for it, opening no token itself (connect-google-calendar)', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForGoogleCheck(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'calendar/refresher.ts']);
    // The loop reaches a Google token only through calendar/google-access.ts: it seals nothing and reads no token back.
    const loop = sourceFiles().find((file) => file.path === 'calendar/refresher.ts')?.text ?? '';
    expect(loop).not.toMatch(/\bseal\(/);
    expect(loop).not.toContain('.sealedToken(');
  });

  it('only the calendar routes, the refresh loop and Google access open a sealed secret or read one back from the store, and only the routes and Google access seal one', () => {
    const importers = sourceFiles()
      .filter((file) => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
        .some((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')) === 'calendar/secret.ts'))
      .map((file) => file.path)
      .sort();
    expect(importers).toEqual(['calendar/google-access.ts', 'calendar/refresher.ts', 'handlers/google-calendars.ts', 'handlers/owner-calendars.ts']);
    // A link's address and a Google calendar's id (the owner calendar routes), connect's refresh token (the Google
    // calendar routes), and a refresh token Google replaced (Google access); never the refresh loop.
    expect(sourceFiles().filter((file) => file.path !== 'calendar/secret.ts' && /\bseal\(/.test(file.text)).map((file) => file.path).sort())
      .toEqual(['calendar/google-access.ts', 'handlers/google-calendars.ts', 'handlers/owner-calendars.ts']);
    // A link's address only.
    expect(sourceFiles().filter((file) => file.text.includes('.sealedAddress(')).map((file) => file.path).sort())
      .toEqual(['calendar/refresher.ts', 'handlers/owner-calendars.ts']);
  });

  it('only calendar/google-access.ts reads a stored Google token back, and a Google calendar’s sealed id is read only there and in the Google calendar routes (connect-google-calendar)', () => {
    // The refresh loop, Refresh now, the add, connect, the choices, team removal, leaving, staff removal and location,
    // organization and person deletion all reach a token through google-access.ts, so handlers/deletion.ts never does.
    expect(sourceFiles().filter((file) => file.text.includes('.sealedToken(')).map((file) => file.path)).toEqual(['calendar/google-access.ts']);
    // The owner calendar routes reach them through google-access.ts (markCalendarForCheck, readGoogleSource) and the
    // Google calendar routes' storedGoogleIds.
    expect(sourceFiles().filter((file) => /\.googleSources?\(/.test(file.text)).map((file) => file.path).sort())
      .toEqual(['calendar/google-access.ts', 'handlers/google-calendars.ts']);
  });

  it('only calendar/google.ts names Google’s OAuth and Calendar hosts or reads a token answer’s fields, and only calendar/google-access.ts writes the Google log lines', () => {
    expect(sourceFiles().filter((file) => /oauth2\.googleapis\.com|www\.googleapis\.com\/calendar/.test(file.text)).map((file) => file.path))
      .toEqual(['calendar/google.ts']);
    // azure-identity.ts reads the managed identity's own `access_token` from Azure (older than Google calendars).
    const tokenFields = /\.(?:refresh_token|access_token|id_token)\b|\[\s*['"`](?:refresh_token|access_token|id_token)['"`]\s*\]/;
    for (const sample of ['body.refresh_token', 'body.access_token ?? null', 'parsed.data.id_token', 'raw[\'access_token\']']) expect(sample).toMatch(tokenFields);
    expect(sourceFiles().filter((file) => tokenFields.test(file.text)).map((file) => file.path).sort()).toEqual(['azure-identity.ts', 'calendar/google.ts']);
    for (const line of ['townwise.google_calendar_failed', 'townwise.google_revoke_failed', 'townwise.google_access_ended']) {
      expect({ line, files: sourceFiles().filter((file) => file.text.includes(`'${line}'`)).map((file) => file.path) })
        .toEqual({ line, files: ['calendar/google-access.ts'] });
    }
  });

  it('handlers reach a calendar link only through ctx.calendarFetcher: only app.ts and the refresh loop build one, and only calendar/fetch.ts opens a connection', () => {
    const importers = sourceFiles()
      .filter((file) => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
        .some((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')) === 'calendar/fetch.ts'))
      .map((file) => file.path)
      .sort();
    expect(importers).toEqual(['app.ts', 'calendar/refresher.ts']);
    const sockets = sourceFiles().filter((file) => /from 'node:(?:https?|http2|net|tls|dgram)'/.test(file.text)).map((file) => file.path);
    expect(sockets).toEqual(['calendar/fetch.ts']);
  });

  it('only the calendar routes, the refresh loop, Google access, TownwiseAI’s calendar tool, the deletions and the lab input’s confirmed labels reach stored calendars', () => {
    // A value import of the store, a read of stores.ownerCalendars (dotted, destructured or bracketed) or a collection by name.
    const reaches = (file: { path: string; text: string }): boolean => /\bownerCalendars\b|\btw_calendar_/.test(file.text)
      || [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
        .some((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')) === 'stores/owner-calendars.ts');
    // The owner-calendar spec: a stored event changes no forecast figure, so forecasts/*, people-in-town/*, every lab/*
    // file but the weekly suggestions call, and the estimates and forecast-run handlers stay off this list. Make a note's
    // link (handlers/notes.ts), the follow-up of linked notes (calendar/follow-up.ts), the panel's owner-calendar cards and
    // their accepts (handlers/weekly-suggestions.ts) and the weekly suggestions call, which sends the events' titles to
    // spot private events (lab/suggestions.ts), read events to write notes and suggestions and to word the cards, never
    // a figure (calendar-event-suggestions). D58 (learn-from-calendar-bookings): the booking routes
    // (handlers/calendar-bookings.ts) label a file calendar's events and write notes from them, and the lab input
    // (lab/input.ts) reads only the confirmed buyouts and parties, as dates and label, through bookingsBetween (below).
    // D63: a calendar file attached to a TownwiseAI message is told to the model with what its import did
    // (files/calendar-import.ts attachedCalendars: the calendar's id, label, event count and date added). D61: Your data's
    // list shows each calendar as a row through the calendar routes' own view (handlers/data.ts). Neither reads an event.
    // D59 slice 2: TownwiseAI's sort on import (calendar/auto-sort.ts) labels a file calendar's events and notes its
    // upcoming bookings as the booking routes do, and its Undo per calendar (handlers/agent-changes.ts) and the changes'
    // views (agent/changes.ts) clear and count the labels that sort set, never reading a title. D59 slice 5: the
    // questions' input (agent/question-input.ts) and a calendar's answers (calendar/answers.ts) read the events whose
    // titles plainly say closed, to explain question days and to answer suggestions with notes and rules through the one
    // writer, never a figure; a stored event still changes no forecast figure by itself.
    expect(sourceFiles().filter(reaches).map((file) => file.path).sort()).toEqual([
      'agent/changes.ts', 'agent/question-input.ts', 'calendar/answers.ts', 'calendar/auto-sort.ts', 'calendar/follow-up.ts', 'calendar/google-access.ts', 'calendar/refresher.ts',
      'chat/tools/owner-calendar.ts', 'files/calendar-import.ts', 'handlers/agent-changes.ts', 'handlers/calendar-bookings.ts', 'handlers/data.ts',
      'handlers/deletion.ts', 'handlers/google-calendars.ts', 'handlers/locations.ts', 'handlers/notes.ts', 'handlers/owner-calendars.ts',
      'handlers/weekly-suggestions.ts', 'lab/input.ts', 'lab/suggestions.ts', 'stores/cross-tenant.ts', 'stores/index.ts',
      'stores/owner-calendars.ts',
    ]);
    const input = sourceFiles().find((each) => each.path === 'lab/input.ts')?.text ?? '';
    expect([...input.matchAll(/\bownerCalendars\b\.?(\w*)/g)].map((match) => match[1])).toEqual(['bookingsBetween']);
    // Seat loss ends a person's Google calendars only through calendar/google-access.ts (connect-google-calendar).
    const imports = (file: { path: string; text: string }): string[] => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
      .map((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')));
    for (const path of ['handlers/team.ts', 'handlers/org.ts', 'handlers/admin.ts']) {
      const file = sourceFiles().find((each) => each.path === path);
      expect({ path, reaches: file !== undefined && reaches(file), viaGoogleAccess: file !== undefined && imports(file).includes('calendar/google-access.ts') })
        .toEqual({ path, reaches: false, viaGoogleAccess: true });
    }
  });

  it('only access/policy.ts mints the listed organization’s scope, and only handlers/overview.ts asks for it (staff-overview)', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForListedOrg(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'handlers/overview.ts']);
  });

  it('only access/policy.ts mints the open-as-admin scope, and only access/resolve.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForOpenAsAdmin(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'access/resolve.ts']);
  });

  describe('D66, town research (design decisions 4, 9 and 14)', () => {
    /** The files a file imports by a relative path, resolved from src/; `values` leaves out type-only imports. */
    const importsOf = (file: { path: string; text: string }, values: boolean): string[] => [
      ...file.text.matchAll(values ? /^import (?!type )[^;]*from '(\.[^']+)';/gm : /^import [^;]*from '(\.[^']+)';/gm),
    ].map((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')));
    const importersOf = (target: string): string[] => sourceFiles()
      .filter((file) => importsOf(file, true).includes(target)).map((file) => file.path).sort();

    it('pins who imports the research stores', () => {
      // The registry builds them, and person deletion clears a deleted person's id from the edits (spec 10.7); the two
      // stores share their sub-schemas and moves through research-shared.ts. stores/cross-tenant.ts finds location
      // research's work across organizations (the claim, the merge claim, the stale sweep; task 3.2). The planner and the
      // runner (tasks 3.3 and 3.4), the reader and the revisions (task 5 and 6) reach them through ctx.stores and join a
      // list only by a value import.
      expect(importersOf('stores/research-shared.ts')).toEqual([
        'stores/cross-tenant.ts', 'stores/research-locations.ts', 'stores/research-revisions.ts', 'stores/research-towns.ts',
      ]);
      expect(importersOf('stores/research-towns.ts')).toEqual(['stores/index.ts']);
      expect(importersOf('stores/research-spend.ts')).toEqual(['stores/index.ts']);
      expect(importersOf('stores/research-locations.ts')).toEqual(['stores/cross-tenant.ts', 'stores/index.ts']);
      expect(importersOf('stores/research-revisions.ts')).toEqual(['stores/cross-tenant.ts', 'stores/index.ts']);
    });

    it('nothing under research/ reaches notes, sales, owner calendars, chat conversations or turns, files or orders', () => {
      // Research sends only public facts (decision 16), so it never holds what these keep. Type imports count too: a
      // record's type in a research file means its data passes through. call.ts takes the model name and the failure
      // mapping from chat/turn.ts, as lab/suggestions.ts does, never a conversation.
      const privateStores = [
        'notes', 'sales-days', 'uploads', 'upload-days', 'item-sales', 'owner-calendars', 'chat-conversations', 'chat-live-turns',
        'chat-turns', 'chat-proposals', 'files', 'file-entries', 'files-usage', 'imports', 'orders', 'order-setups', 'order-counts',
      ].map((name) => `stores/${name}.ts`);
      // A read of one of their stores, dotted or destructured from `stores` (`ctx.stores.notes`, `{ notes } = ctx.stores`).
      const names = 'notes|salesDays|uploads|uploadDays|itemSales|ownerCalendars|chatConversations|chatLiveTurns|chatTurns|chatProposals|files|fileEntries|filesUsage|imports|orders|orderSetups|orderCounts';
      const accessors = new RegExp(`\\bstores\\??\\.(${names})\\b|\\{[^}]*\\b(${names})\\b[^}]*\\}\\s*=\\s*[\\w.]*\\bstores\\b`);
      const research = sourceFiles().filter((file) => file.path.startsWith('research/'));
      expect(research.length).toBeGreaterThan(0);
      for (const file of research) {
        const reached = importsOf(file, false).filter((path) => privateStores.includes(path) || /^(files|orders|calendar)\//.test(path));
        expect({ file: file.path, reached, accessor: accessors.exec(file.text)?.[0] ?? null }).toEqual({ file: file.path, reached: [], accessor: null });
      }
    });

    it('under research/ only read.ts and revisions.ts reach the edits, and the prompt, the calls and the runner reach neither', () => {
      // A member's typed edit (a title, a `where`) never reaches Anthropic: prompts are built from base values (decision 4).
      const research = sourceFiles().filter((file) => file.path.startsWith('research/'));
      const reachesEdits = (file: { path: string; text: string }): boolean => importsOf(file, false).includes('stores/research-revisions.ts')
        || /\bresearchRevisions\b|\btw_research_revisions\b/.test(file.text);
      expect(research.filter(reachesEdits).map((file) => file.path).every((path) => ['research/read.ts', 'research/revisions.ts'].includes(path))).toBe(true);
      for (const path of ['research/prompt.ts', 'research/call.ts', 'research/runner.ts']) {
        const file = research.find((each) => each.path === path);
        const reached = file === undefined ? [] : importsOf(file, false).filter((each) => ['research/read.ts', 'research/revisions.ts', 'stores/research-revisions.ts'].includes(each));
        expect({ path, reached, edits: file !== undefined && reachesEdits(file) }).toEqual({ path, reached: [], edits: false });
      }
    });
  });
});
