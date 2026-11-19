// A calendar file kept in Your data becomes one of the location's calendars (D60, spec 11A.5 and 10.14): once a
// reference file's upload completes, a calendar file, an .ics or .ical file whose text starts a VCALENDAR or a text
// file whose header is a calendar CSV's (D58, calendar/csv-events.ts), is imported as a file calendar through the same
// add as Your calendars' "Import a calendar file" (handlers/owner-calendars.ts addFileCalendar): its 5 calendars a
// location, its 1 MB, its parse rules, and an `owner_calendar.added` audit event with the file's id. Its label is the
// file's name as labelOfFile words it. No model reads anything here. The upload's screen never says that TownwiseAI
// reads titles weekly, so the calendar carries no `titlesNotice` and the weekly call sends none of its titles
// (calendar-event-suggestions design decision 11). The calendar keeps the file's id under a unique index
// (stores/owner-calendars.ts), so a stored file is never imported twice; the file keeps what happened
// (`calendarImport`), which its page shows (handlers/data.ts) with a retry while the cause can be mended. An .ics or
// .ical file that is no calendar is recorded `not_calendar`; any other file is left as it was. Importing never fails
// the upload. Logs carry the file's and calendar's ids and the outcome's code, never a name, label or title. A calendar
// file attached to a TownwiseAI message (D63) is told to the model with what its import did (attachedCalendars).
import type { MemberPrincipal, OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { isCalendarCsvText } from '../calendar/csv-events.ts';
import { MAX_ICS_BYTES } from '../calendar/ics.ts';
import { addFileCalendar, labelOfFile } from '../handlers/owner-calendars.ts';
import type { CalendarImport, CalendarImportCode, FileKind, FileRecord } from '../stores/files.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { localDay } from '../time-zones.ts';
import type { FileBlobs } from './blobs.ts';
import { isCalendarFileName } from './sniff.ts';

/** Codes a retry can mend: a calendar removed, or the original read again. */
export const RETRYABLE_IMPORTS: ReadonlySet<CalendarImportCode> = new Set(['calendar_limit', 'unavailable']);

/**
 * What a stored file is to the import, from its name, kind and first bytes: a calendar file (`calendar`), an .ics or
 * .ical file that is no calendar (`named`), or anything else (null).
 */
export function calendarCandidate(name: string, kind: FileKind, head: Uint8Array): 'calendar' | 'named' | null {
  // TextDecoder drops a byte-order mark.
  const text = new TextDecoder('utf-8').decode(head);
  if (isCalendarFileName(name)) return /^\s*BEGIN:VCALENDAR\b/i.test(text) ? 'calendar' : 'named';
  return kind === 'text' && isCalendarCsvText(text) ? 'calendar' : null;
}

async function textOf(blobs: FileBlobs, member: MemberPrincipal, file: FileRecord): Promise<string> {
  const body = await blobs.openRaw(member.scope, { locationId: file.locationId, fileId: file.id }, { offset: 0, count: file.sizeBytes });
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array));
  return new TextDecoder('utf-8').decode(Buffer.concat(parts));
}

/**
 * Imports the stored calendar file as a file calendar of its location and records what happened on the file, which it
 * resolves. A failure to read the original or to store the calendar is `unavailable` (logged by its error's name); only
 * the record's own write can throw.
 */
export async function runCalendarImport(
  ctx: TownwiseContext, blobs: FileBlobs, member: MemberPrincipal, location: LocationRecord, file: FileRecord,
): Promise<CalendarImport> {
  const at = ctx.now();
  let code: CalendarImportCode | null = null;
  if (file.sizeBytes > MAX_ICS_BYTES) {
    code = 'too_large';
  } else {
    try {
      const added = await addFileCalendar(ctx, member, location, { label: labelOfFile(file.name), text: await textOf(blobs, member, file), fromFileId: file.id });
      // file_imported: another import of this file made its calendar first, which is this one's outcome too.
      if (typeof added === 'string' && added !== 'file_imported') code = added;
    } catch (err) {
      ctx.logger.warn({ fileId: file.id, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.file_calendar_import_failed');
      code = 'unavailable';
    }
  }
  const record: CalendarImport = code === null ? { state: 'added', at } : { state: 'refused', code, at };
  await ctx.stores.files.setCalendarImport(member.scope, file.id, record);
  ctx.logger.info({ fileId: file.id, outcome: code ?? 'added' }, 'townwise.file_calendar_imported');
  return record;
}

/**
 * After a reference file's upload completes: imports it when it is a calendar file (`head` is its first bytes), records
 * `not_calendar` for an .ics or .ical file that is not one, and leaves any other file alone. Never throws.
 */
export async function importIfCalendar(
  ctx: TownwiseContext, blobs: FileBlobs, member: MemberPrincipal, location: LocationRecord, file: FileRecord, head: Uint8Array,
): Promise<void> {
  try {
    const candidate = calendarCandidate(file.name, file.kind, head);
    if (candidate === 'calendar') await runCalendarImport(ctx, blobs, member, location, file);
    if (candidate === 'named') {
      await ctx.stores.files.setCalendarImport(member.scope, file.id, { state: 'refused', code: 'not_calendar', at: ctx.now() });
      ctx.logger.info({ fileId: file.id, outcome: 'not_calendar' }, 'townwise.file_calendar_imported');
    }
  } catch (err) {
    ctx.logger.warn({ fileId: file.id, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.file_calendar_import_failed');
  }
}

/**
 * D63: what importing a calendar file attached to a TownwiseAI message did, as of the send (chat/attachments.ts
 * CalendarNote words it for the model). `added` while its calendar exists and was made at most JUST_ADDED_MS ago,
 * `already` for an older one, by its age alone: a copy Your data refused as a duplicate is attached as the file it
 * copies, so a recent calendar may be from an earlier upload of that file, and neither says which upload made it; both
 * with the calendar's id, label and event count and the town's date it was added. `removed` once that calendar was removed (the file is never imported again);
 * `refused` with the code and whether Try again on the file's page may mend it (as handlers/data.ts calendarOf says);
 * `not_imported` for an .ics or .ical file with no import record (one kept before D60, which Import as a calendar on its
 * page imports, handlers/data.ts retryDataCalendar).
 */
export type AttachedCalendar =
  | { readonly outcome: 'added' | 'already'; readonly calendarId: string; readonly label: string; readonly eventCount: number; readonly addedOn: string }
  | { readonly outcome: 'removed' | 'not_imported' }
  | { readonly outcome: 'refused'; readonly code: CalendarImportCode; readonly retry: boolean };

/** How recent a calendar's import is for a turn to call it just added. [CONFIRM: 30 minutes] */
export const JUST_ADDED_MS = 30 * 60 * 1000;

/**
 * D63: by file id, what importing each of these attached files as a calendar did, for the ones that are calendar files
 * (with an import record, or named .ics or .ical); any other file, and one not kept for reference at this location, is
 * left out. Reads each file's record and, only when one is a calendar file, the location's calendars. Nothing is logged.
 */
export async function attachedCalendars(
  ctx: TownwiseContext, scope: OrgScope, locationId: string, fileIds: readonly string[], timeZone: string,
): Promise<Map<string, AttachedCalendar>> {
  const found = await Promise.all(fileIds.map((id) => ctx.stores.files.get(scope, locationId, id)));
  const files = found.filter((file): file is FileRecord => (
    file !== null && file.purpose === 'reference' && file.status === 'kept' && (file.calendarImport !== null || isCalendarFileName(file.name))
  ));
  const notes = new Map<string, AttachedCalendar>();
  if (files.length === 0) return notes;
  const calendars = await ctx.stores.ownerCalendars.list(scope, locationId);
  const now = ctx.now().getTime();
  for (const file of files) {
    const calendar = calendars.find((one) => one.fromFileId === file.id);
    const record = file.calendarImport;
    if (calendar !== undefined) {
      notes.set(file.id, {
        outcome: now - calendar.createdAt.getTime() <= JUST_ADDED_MS ? 'added' : 'already', calendarId: calendar.id,
        label: calendar.label, eventCount: calendar.eventCount, addedOn: localDay(calendar.createdAt, timeZone),
      });
    } else if (record === null) {
      notes.set(file.id, { outcome: 'not_imported' });
    } else if (record.state === 'added') {
      notes.set(file.id, { outcome: 'removed' });
    } else {
      notes.set(file.id, { outcome: 'refused', code: record.code, retry: RETRYABLE_IMPORTS.has(record.code) && file.rawDeletedAt === null });
    }
  }
  return notes;
}
