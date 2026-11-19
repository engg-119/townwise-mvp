// Your data's folders (D61): every item, and every calendar, sits in one folder, from what Townwise knows about it,
// never from its name (a file's name is never sent to a model to sort it), but for one thing: a calendar file's
// extension (rule 2). In order:
//
// 1. A sales upload (`u_`), and a sales file Townwise kept or is still reading (purpose `history`): Sales.
// 2. A calendar file (one D60 tried to import as a calendar, unless it found no calendar in it, or, UI review
//    2026-11-19, an .ics or .ical file kept before D60 with no import record, which only its extension tells, as D63
//    tells a calendar file): Calendars. A calendar itself is always in Calendars; the list shows a file that became a
//    calendar once, as the calendar.
// 3. The file's own `folder` (tw_files.folder): pasted text and text TownwiseAI kept are saved with `notes`. This is
//    the hook for a later agent (D59) to file an item: FileStore.setFolder writes it, and it outranks 4 but never 1 or 2.
// 4. Text TownwiseAI kept from a conversation or a read (`addedVia` or `source`, saved before `folder` was): Notes.
// 5. A file TownwiseAI read (a done read): the kind it found (AI_FILE_KINDS) by AI_KIND_FOLDERS.
// 6. Anything else: Not sorted yet (`unsorted`).
import { isCalendarFileName } from '../files/sniff.ts';
import type { AiFileKind, FileRecord } from '../stores/files.ts';
import type { DataItemRecord } from './library.ts';

/** The folders, in the order Your data shows them. */
export const DATA_FOLDERS = ['sales', 'calendars', 'menus', 'inventory', 'staffing', 'notes', 'other', 'unsorted'] as const;
export type DataFolder = (typeof DATA_FOLDERS)[number];

/** The folders a file's own `folder` may name: Sales and Calendars come only from what the item is. */
export const FILEABLE_FOLDERS = ['menus', 'inventory', 'staffing', 'notes', 'other', 'unsorted'] as const satisfies readonly DataFolder[];
export type FileableFolder = (typeof FILEABLE_FOLDERS)[number];

/** A TownwiseAI read's kind (spec 11A.9) as a folder. */
export const AI_KIND_FOLDERS: Readonly<Record<AiFileKind, DataFolder>> = {
  sales: 'sales', calendar: 'calendars', menu: 'menus', inventory: 'inventory', staffing: 'staffing', other: 'other',
};

/**
 * An .ics or .ical file kept before D60 imported calendar files: no import record, and the kind sniff keeps such a file
 * as, `other`. Its page offers Import as a calendar (handlers/data.ts retryDataCalendar).
 */
export function isUnimportedCalendarFile(file: FileRecord): boolean {
  return file.calendarImport === null && file.kind === 'other' && isCalendarFileName(file.name);
}

/**
 * A file D60 tried to import as a calendar and found one in (added, or refused for its size, the limit or a read), or one
 * kept before D60 that was never tried.
 */
function isCalendarFile(file: FileRecord): boolean {
  const record = file.calendarImport;
  if (record === null) return isUnimportedCalendarFile(file);
  return !(record.state === 'refused' && record.code === 'not_calendar');
}

/** The item's folder, by the rules above. */
export function folderOf(item: DataItemRecord): DataFolder {
  const file = item.ref.type === 'file' ? item.file : null;
  if (item.ref.type === 'upload' || file?.purpose === 'history') return 'sales';
  if (file === null) return 'unsorted';
  if (isCalendarFile(file)) return 'calendars';
  if (file.folder !== null) return file.folder;
  if (file.addedVia === 'townwise_ai' || file.source !== null) return 'notes';
  const ai = file.ai;
  if (ai?.status === 'done' && ai.result !== null) return AI_KIND_FOLDERS[ai.result.kind];
  return 'unsorted';
}
