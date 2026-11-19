import type { DataCalendar, DataItem } from './api';

// Your data's folders and its one list (D61). The API files each item (api/src/data/folders.ts, by what Townwise knows
// of it, never its name) and answers the scope's calendars beside the items; here both become entries of one list,
// newest first, a calendar being an item of the Calendars folder. A folder this client doesn't know files under Not
// sorted yet.

export const FOLDERS = [
  { key: 'sales', label: 'Sales' },
  { key: 'calendars', label: 'Calendars' },
  { key: 'menus', label: 'Menus and recipes' },
  { key: 'inventory', label: 'Inventory and orders' },
  { key: 'staffing', label: 'Staffing' },
  { key: 'notes', label: 'Notes and pasted text' },
  { key: 'other', label: 'Other' },
  { key: 'unsorted', label: 'Not sorted yet' },
] as const;
export type Folder = (typeof FOLDERS)[number]['key'];

const KNOWN: ReadonlySet<string> = new Set(FOLDERS.map((folder) => folder.key));

export function folderOf(raw: string): Folder {
  return KNOWN.has(raw) ? (raw as Folder) : 'unsorted';
}

/** One entry of the list: an upload or stored file, or a calendar. `at` is when it was added, `key` unique in the list. */
export type Entry =
  | { readonly type: 'item'; readonly key: string; readonly at: string; readonly folder: Folder; readonly item: DataItem }
  | { readonly type: 'calendar'; readonly key: string; readonly at: string; readonly folder: 'calendars'; readonly calendar: DataCalendar };

/**
 * Every item and calendar, newest first (a tie keeps items before calendars, each in the order given). With `more` (an
 * older page is still to load), a calendar older than the oldest item loaded waits for that page, so Newest first never
 * shows it out of order; Organized passes false, since a folder holds every calendar there is.
 */
export function entriesOf(items: readonly DataItem[], calendars: readonly DataCalendar[], more: boolean): Entry[] {
  const oldest = items.at(-1)?.addedAt ?? null;
  const shownCalendars = more && oldest !== null ? calendars.filter((calendar) => Date.parse(calendar.createdAt) >= Date.parse(oldest)) : calendars;
  const all: Entry[] = [
    ...items.map((item): Entry => ({ type: 'item', key: item.ref, at: item.addedAt, folder: folderOf(item.folder), item })),
    ...shownCalendars.map((calendar): Entry => ({ type: 'calendar', key: `c_${calendar.id}`, at: calendar.createdAt, folder: 'calendars', calendar })),
  ];
  // Array.prototype.sort is stable: equal times keep the order above.
  return all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The entries of each folder, in FOLDERS' order, every folder present (an empty one with none). */
export function byFolder(entries: readonly Entry[]): { folder: (typeof FOLDERS)[number]; entries: Entry[] }[] {
  return FOLDERS.map((folder) => ({ folder, entries: entries.filter((entry) => entry.folder === folder.key) }));
}
