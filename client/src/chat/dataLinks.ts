import { calendarHref, isAllowed, itemHref, locationHref } from '../portal/routing';
import type { MeResponse } from '../portal/schemas';
import { dayText } from './format';
import type { DataTarget } from './tools';

// Where a TownwiseAI step or Based on piece that read the team's own data opens (spec P25 build note, 2026-11-18): the
// path of the Calendar's day or the Your data item or list `dataTarget` names, only when this person may open it
// (`isAllowed`, for their access, role and view-as), else nothing and the words stay plain text. Paths carry ids and
// dates only.

export function targetHref(target: DataTarget | null, locationId: string, me: MeResponse | null): string | null {
  if (target === null || me === null) return null;
  const href = target.kind === 'day'
    ? calendarHref(locationId, target.date)
    : target.kind === 'item' ? itemHref(locationId, target.ref) : locationHref(locationId, 'data');
  return isAllowed(me, href) ? href : null;
}

/** A step's link under its words: what it says, and its name, which says where it goes. */
export function targetWords(target: DataTarget): { text: string; label: string } {
  if (target.kind === 'day') return { text: 'Open in Calendar', label: `Open ${dayText(target.date)} in Calendar` };
  if (target.kind === 'item') return { text: 'Open on Your data', label: 'Open the upload with these sales on Your data' };
  return { text: 'Open Your data', label: 'Open Your data' };
}
