import { KIND_LABEL as FILE_KIND_LABEL } from '../files/copy';
import { formatCount, formatDate } from '../format';
import type { Note } from '../locations/api';
import { addDays, formatRange } from '../locations/dates';
import { datesLine, EFFECT_LABEL, KIND_LABEL, weekdaysLine } from '../locations/noteRules';
import { formatDollars, valueOf } from '../locations/sales';
import type { Calendar, EventKind, HistoryUpload } from './api';
import { usual } from './baseline';
import { dayFlags, eventsOf, notesOf, type DayContext } from './days';
import type { Included } from './filters';
import type { DayRecord } from './history';
import { longDate, metricText, shortDate, signedPercent, WEEKDAY_NAMES, weekdayOf, type Metric } from './words';

// The Day panel as data (home.md 4.5): everything Townwise has for one day, in the order the panel shows it. It
// only reads, so it is the same under view-as. No number is given for "usual" after the last day of data, because
// that would read as a forecast.

export const PANEL_EMPTY = 'Point at or select a day to see everything Townwise has for it. Use the arrow keys to move between days.';
export const NO_NOTES = 'No notes for this day.';

export const EVENT_KIND_LABEL: Readonly<Record<EventKind, string>> = {
  holiday: 'Holiday',
  event: 'Town event',
  term: 'Term',
  season: 'Season',
};

export interface PanelInput {
  byDate: ReadonlyMap<string, DayRecord>;
  context: DayContext;
  uploads: readonly HistoryUpload[];
  metric: Metric;
  included: Included;
  /** The viewer's day. */
  today: string;
  /** The last stored day; null with no history. */
  lastDate: string | null;
  calendar: Pick<Calendar, 'town' | 'researched' | 'covers'> | null;
}

export interface PanelNumber { label: string; value: string }

export interface PanelEvent {
  id: string;
  title: string;
  /** "Nov 20, 2026 to Nov 22, 2026" for a multi-day event; null for one day. */
  dates: string | null;
  kind: string;
  sources: { label: string; url: string }[];
}

export interface PanelNote {
  id: string;
  /** "Private event, more guests than usual". */
  words: string;
  dates: string | null;
  weekdays: string | null;
  expected: string | null;
  detail: string | null;
  addedBy: string;
}

export interface PanelSource {
  /** "From the upload on Nov 15, 2026 by owner@example.com." */
  line: string;
  /** "This upload didn't finish." for an upload still applying. */
  warning: string | null;
  /** The stored file the upload was read from (F1); null for a browser upload, a deleted file, or files off. */
  file: HistoryUpload['file'];
  /** "File: sales-2026.csv (CSV or text file)."; null with no file. */
  fileLine: string | null;
  /** The upload finished, so its file's cleaned copy exists to download. */
  finished: boolean;
}

/** The stored file's name and kind; under view-as the API sends no name, and the line says so. */
export function fileLine(file: NonNullable<HistoryUpload['file']>): string {
  const kind = FILE_KIND_LABEL[file.kind];
  return file.name === null ? `File: ${kind}. Its name is hidden in view-as.` : `File: ${file.name} (${kind}).`;
}

export interface DayPanelData {
  date: string;
  /** "Saturday, Nov 21, 2026". */
  heading: string;
  /** "Closed", "No data for this day", "Left out of the numbers by your filters", "Today", as they apply. */
  status: string[];
  numbers: PanelNumber[];
  events: PanelEvent[];
  /** Why the town calendar may be missing something on this day; null when the research covers it. */
  calendarNote: string | null;
  notes: PanelNote[];
  /** Null for a day with no stored row. */
  source: PanelSource | null;
}

/** "Private event, more guests than usual"; "Closure" for a closure that closed the day; "Private buyout" for a private event that did. */
export function noteWords(note: Pick<Note, 'kind' | 'effect'>): string {
  if (note.kind === 'closure' && note.effect === 'closed') return KIND_LABEL.closure;
  if (note.kind === 'private_event' && note.effect === 'closed') return 'Private buyout';
  if (note.effect === 'unknown') return `${KIND_LABEL[note.kind]}, effect not known`;
  const effect = EFFECT_LABEL[note.effect];
  return `${KIND_LABEL[note.kind]}, ${effect.charAt(0).toLowerCase()}${effect.slice(1)}`;
}

function calendarNoteFor(date: string, calendar: PanelInput['calendar']): string | null {
  if (calendar === null) return null;
  const { town, covers } = calendar;
  if (town.townId === null) return `Townwise hasn’t researched ${town.name}, ${town.state} yet. Only US federal holidays and your notes show here.`;
  if (!calendar.researched || covers === null) return `Townwise’s ${town.name} calendar has no researched town events yet. Only US federal holidays and your notes show here.`;
  return date < covers.from || date > covers.to ? `${town.name}’s researched calendar doesn’t cover this date.` : null;
}

function sourceOf(day: DayRecord, uploads: readonly HistoryUpload[]): PanelSource {
  const upload = day.upload < 0 ? undefined : uploads[day.upload];
  if (upload === undefined) return { line: 'Upload record not found.', warning: null, file: null, fileLine: null, finished: false };
  return {
    line: `From the upload on ${formatDate(upload.uploadedAt)} by ${upload.uploadedByEmail}.`,
    warning: upload.status === 'applying' ? 'This upload didn’t finish.' : null,
    file: upload.file,
    fileLine: upload.file === null ? null : fileLine(upload.file),
    finished: upload.status === 'applied',
  };
}

function usualNumber(date: string, day: DayRecord | undefined, input: PanelInput): PanelNumber | null {
  if (input.lastDate === null || date > input.lastDate) return null;
  const weekday = WEEKDAY_NAMES[weekdayOf(date)] ?? '';
  const label = `Usual for a ${weekday}`;
  const found = usual(date, input.metric, input.byDate, input.context, input.included);
  if (found === null) return { label, value: 'Not enough similar days' };
  const value = day === undefined ? null : valueOf(day, input.metric);
  const against = value === null || found.mean === 0 ? '' : ` This day: ${signedPercent(value / found.mean - 1)}.`;
  return { label, value: `${metricText(found.mean, input.metric)}, from ${formatCount(found.days)} ${weekday}s.${against}` };
}

export function dayPanel(date: string, input: PanelInput): DayPanelData {
  const day = input.byDate.get(date);
  const flags = dayFlags(date, day, input.context);
  const hasValue = day !== undefined && (day.guests !== null || day.netSalesCents !== null);
  const metricValue = day === undefined ? null : valueOf(day, input.metric);
  const status = [
    flags.likelyClosed ? 'Likely closed' : flags.closed ? 'Closed' : null,
    hasValue ? null : 'No data for this day',
    metricValue !== null && !input.included(date) ? 'Left out of the numbers by your filters' : null,
    date === input.today ? 'Today' : null,
  ].filter((part): part is string => part !== null);

  const lastYearDate = addDays(date, -364);
  const lastYearDay = input.byDate.get(lastYearDate);
  const lastYearValue = lastYearDay === undefined ? null : valueOf(lastYearDay, input.metric);
  const numbers = [
    { label: 'Guests', value: day === undefined || day.guests === null ? 'No guest count' : formatCount(day.guests) },
    { label: 'Net sales', value: day === undefined || day.netSalesCents === null ? 'No net sales' : formatDollars(day.netSalesCents) },
    usualNumber(date, day, input),
    {
      label: 'Same day last year',
      value: lastYearValue === null ? 'No data' : `${shortDate(lastYearDate)}: ${metricText(lastYearValue, input.metric)}`,
    },
  ].filter((part): part is PanelNumber => part !== null);

  const events = eventsOf(input.context, date).map((event) => ({
    id: event.id,
    title: event.title,
    dates: event.start === event.end ? null : formatRange(event.start, event.end),
    kind: EVENT_KIND_LABEL[event.kind],
    sources: event.sources.map((source) => ({ label: source.label, url: source.url })),
  }));

  const notes = notesOf(input.context, date).map((note) => ({
    id: note.id,
    words: noteWords(note),
    dates: note.startDate === note.endDate ? null : datesLine(note),
    weekdays: weekdaysLine(note.weekdays),
    expected: note.expectedGuests === null ? null : `Expected guests: ${formatCount(note.expectedGuests)}`,
    detail: note.detail,
    addedBy: `Added by ${note.createdByEmail}`,
  }));

  return {
    date,
    heading: longDate(date),
    status,
    numbers,
    events,
    calendarNote: calendarNoteFor(date, input.calendar),
    notes,
    source: day === undefined ? null : sourceOf(day, input.uploads),
  };
}
