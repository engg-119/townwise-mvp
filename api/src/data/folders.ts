// Your data's folders (D61): every item, and every calendar, sits in one folder, from what Townwise knows about it,
// never from its name (a file's name is never sent to a model to sort it, and nothing here reads it). In order:
//
// 1. A sales upload (`u_`), and a sales file Townwise kept or is still reading (purpose `history`): Sales.
// 2. A calendar file (one D60 tried to import as a calendar, unless it found no calendar in it): Calendars. A calendar
//    itself is always in Calendars; the list shows a file that became a calendar once, as the calendar.
// 3. The file's own `folder` (tw_files.folder): pasted text and text TownwiseAI kept are saved with `notes`. This is
//    the hook for a later agent (D59) to file an item: FileStore.setFolder writes it, and it outranks 4 but never 1 or 2.
// 4. Text TownwiseAI kept from a conversation or a read (`addedVia` or `source`, saved before `folder` was): Notes.
// 5. A file TownwiseAI read (a done read): the kind it found (AI_FILE_KINDS) by AI_KIND_FOLDERS.
// 6. Anything else: Not sorted yet (`unsorted`).
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

/** A file D60 tried to import as a calendar and found one in (added, or refused for its size, the limit or a read). */
function isCalendarFile(file: FileRecord): boolean {
  const record = file.calendarImport;
  return record !== null && !(record.state === 'refused' && record.code === 'not_calendar');
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
