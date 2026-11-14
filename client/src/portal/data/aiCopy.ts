import { ApiError } from '../../api/client';
import { formatDate, plural } from '../format';
import type { AiRead, DataItem } from './api';
import { dataError } from './copy';

// Every word of reading a file with TownwiseAI (D34, spec 11A.9): the item page's TownwiseAI section (P27), the
// opt-in under Your data's Add a file and its rows' Status (P26), and the opt-in under onboarding's drop (P11 step 3).
// Codes are read as strings, so a code the server adds later gets the general line for its place. Nothing here prints
// a name, a figure or the file's content beyond what the API sends (under view-as it sends no summary, facts or note
// titles).

export const AI = {
  heading: 'TownwiseAI',
  explain: 'TownwiseAI can read this file and use what it finds. The whole file is sent to Anthropic’s Claude to read. TownwiseAI then adds what it finds to your account: dated events as notes, daily totals it can check against the file as new sales days (it never changes a day you already have), and a summary TownwiseAI can read later. When an org admin asks, it may also start updating the forecast. Everything it adds can be undone.',
  privacy: 'How Townwise handles your data',
  privacyHref: '/privacy',
  read: 'Let TownwiseAI read this file',
  asking: 'Asking TownwiseAI…',
  queued: 'TownwiseAI is reading this file. It’s next in line, and this page updates when it’s done.',
  reading: 'TownwiseAI is reading this file. This can take a few minutes, and this page updates when it’s done.',
  finished: 'TownwiseAI finished reading this file.',
  undone: 'What TownwiseAI added from this file was undone. You can let it read the file again.',
  found: 'What it found',
  added: 'What it added',
  notesList: 'Notes TownwiseAI added',
  notesLink: 'Open Notes',
  daysLink: 'Open the days',
  summaryLink: 'Open the summary',
  noNotes: 'It added no notes.',
  partial: 'This file was too long to read whole, so TownwiseAI read only the start of it.',
  daysCut: 'This file has daily totals for more dates than TownwiseAI reads at once, so it read the newest 1,500 of them.',
  stopped: 'TownwiseAI stopped before it finished, and may have added some notes, days or a summary first. You can undo what it added.',
  madeBy: 'Made by TownwiseAI from a file',
  undo: 'Undo what TownwiseAI added',
  undoTitle: 'Undo what TownwiseAI added?',
  undoConfirm: 'Undo',
  undoing: 'Undoing…',
  undid: 'Removed what TownwiseAI added from this file.',
  forecastKept: 'The forecast update it started keeps running.',
  optIn: 'Let TownwiseAI read these files and use what it finds',
  optInHelp: 'Each file you add is sent whole to Anthropic’s Claude to read. You can undo what TownwiseAI adds from a file on its page.',
} as const;

/** What TownwiseAI found a file to be, in a sentence. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  sales: 'sales figures',
  calendar: 'a calendar of events',
  inventory: 'an inventory',
  menu: 'a menu',
  staffing: 'a staff schedule',
  other: 'something other than sales, events, inventory, a menu or a schedule',
};

export function kindFoundLine(kind: string | null): string | null {
  if (kind === null) return null;
  return `TownwiseAI read this file as ${KIND_WORDS[kind] ?? KIND_WORDS.other ?? ''}.`;
}

/** Why a read was skipped or failed (`ai.reason`). */
const SKIPPED: Readonly<Record<string, string>> = {
  budget_spent: 'TownwiseAI didn’t read this file: your organization’s TownwiseAI budget for reading files is spent for this month.',
  too_large: 'TownwiseAI didn’t read this file: it’s bigger than TownwiseAI reads.',
  kind_not_read: 'TownwiseAI didn’t read this file: it can’t read this kind of file.',
  encrypted: 'TownwiseAI didn’t read this file: it has a password.',
  raw_missing: 'TownwiseAI didn’t read this file: its original was deleted.',
  requester_gone: 'TownwiseAI added nothing from this file: the person who asked is no longer on your team.',
  too_complex: 'TownwiseAI didn’t read this file: it’s too complex to turn into text.',
  not_readable: 'TownwiseAI didn’t read this file: it couldn’t be opened, so it may be damaged.',
};
const FAILED: Readonly<Record<string, string>> = {
  refused: 'TownwiseAI declined to read this file.',
  answer_too_long: 'TownwiseAI couldn’t finish reading this file: what it found was too long to write down. A shorter file, such as one year of sales, will work.',
  internal: 'TownwiseAI couldn’t read this file because something went wrong on Townwise’s side.',
};

/**
 * What TownwiseAI did with a row's file, said after what Townwise did in Your data's Status cell (P26): null with no
 * read, once it was undone, and for a status the client doesn't know.
 */
export function rowAiLine(ai: Pick<AiRead, 'status'> | null): string | null {
  switch (ai?.status) {
    case 'queued':
    case 'reading':
      return 'TownwiseAI is reading it';
    case 'done':
      return 'Read by TownwiseAI';
    case 'failed':
      return 'TownwiseAI couldn’t read it';
    case 'skipped':
      return 'TownwiseAI didn’t read it';
    default:
      return null;
  }
}

/** The line for a read that ended without an answer, or null for any other status. */
export function settledLine(ai: Pick<AiRead, 'status' | 'reason'>): string | null {
  const reason = ai.reason ?? '';
  if (ai.status === 'skipped') return SKIPPED[reason] ?? 'TownwiseAI didn’t read this file.';
  if (ai.status === 'failed') return FAILED[reason] ?? 'TownwiseAI couldn’t read this file.';
  if (ai.status === 'undone') return AI.undone;
  return null;
}

function dates(startDate: string, endDate: string): string {
  return startDate === endDate ? formatDate(startDate) : `${formatDate(startDate)} to ${formatDate(endDate)}`;
}

/** A note it made: the event's title (null under view-as) and its dates. */
export function noteLine(note: AiRead['notes'][number]): string {
  return note.title === null ? dates(note.startDate, note.endDate) : `${note.title}, ${dates(note.startDate, note.endDate)}`;
}

export function notesLine(count: number): string {
  return `It added ${plural(count, 'note', 'notes')} to Notes:`;
}

/** The closed periods the guard left out (`notesSkipped.guard`), or null when it left none. */
export function guardLine(skipped: AiRead['notesSkipped']): string | null {
  const count = skipped?.guard ?? 0;
  if (count === 0) return null;
  return `It left out ${plural(count, 'closed period', 'closed periods')}: TownwiseAI never closes more than 14 days in a row, or 31 days in all, from one file. If ${count === 1 ? 'it’s' : 'they’re'} right, add ${count === 1 ? 'it' : 'them'} in Notes.`;
}

const ADD_YOURSELF = ' To add them yourself, use Upload sales history.';

/** Why it wrote no days (`ai.daysReason`). */
const NO_DAYS: Readonly<Record<string, string>> = {
  not_sales: 'It added no sales days: this isn’t a sales file.',
  no_days: 'It added no sales days: the file doesn’t list totals day by day.',
  file_wrote_days: 'It added no sales days: Townwise already read this file’s days when it was uploaded.',
  picture: `It added no sales days: TownwiseAI doesn’t take days from a picture, because it can’t check the figures against the file’s text.${ADD_YOURSELF}`,
  not_high_confidence: `It added no sales days: TownwiseAI wasn’t sure enough that it read the totals right.${ADD_YOURSELF}`,
  days_not_verified: `It added no sales days: too few of the dates and figures it read could be found in the file’s own text.${ADD_YOURSELF}`,
  already_had_days: 'It added no sales days: you already have every day it found, and TownwiseAI never changes a day you already have.',
};

/** The days line: what it added (and the days it left as they were), or why it added none. */
export function daysLine(ai: Pick<AiRead, 'daysWritten' | 'daysAlreadyHad' | 'uploadRef' | 'daysReason'>): string {
  if (ai.daysWritten > 0) {
    const kept = ai.daysAlreadyHad > 0 ? ` It left ${plural(ai.daysAlreadyHad, 'day', 'days')} you already had as ${ai.daysAlreadyHad === 1 ? 'it was' : 'they were'}.` : '';
    const added = `It added ${plural(ai.daysWritten, 'day', 'days')} of sales.${kept}`;
    return ai.uploadRef === null ? `${added} That upload isn’t on Your data anymore.` : added;
  }
  return NO_DAYS[ai.daysReason ?? ''] ?? 'It added no sales days.';
}

/** Why it kept no summary item (`ai.itemReason`). */
const NO_ITEM: Readonly<Record<string, string>> = {
  no_summary: 'It kept no summary: it found nothing to summarize.',
  storage_full: 'It kept no summary: your organization’s file storage is full.',
  daily_upload_limit: 'It kept no summary: your organization reached today’s upload limit.',
};

/** The summary item line: kept, gone since, or why none was kept. */
export function itemLine(ai: Pick<AiRead, 'itemRef' | 'itemReason'>): string {
  if (ai.itemRef !== null) return 'It kept a summary on Your data that TownwiseAI can read later.';
  if (ai.itemReason === null) return 'The summary it kept isn’t on Your data anymore.';
  return NO_ITEM[ai.itemReason] ?? 'It kept no summary.';
}

/** The forecast update (`ai.calibration.status`). */
const FORECAST: Readonly<Record<string, string>> = {
  started: 'Started updating the forecast. It goes live once Townwise turns forecasts on for you.',
  not_needed: 'The forecast wasn’t updated: TownwiseAI added no notes or days.',
  not_admin: 'An org admin can update the forecast from this.',
  lab_unavailable: 'The forecast wasn’t updated: forecast updates are off right now.',
  not_enough_history: 'The forecast wasn’t updated: it needs at least 595 days from the first to the last day of sales history.',
  regime: 'The forecast wasn’t updated: this location’s sales history doesn’t allow an update right now.',
  budget_spent: 'The forecast wasn’t updated: this month’s TownwiseAI budget is spent.',
  in_progress: 'The forecast wasn’t updated: an update for this location is already running.',
  daily_limit: 'The forecast wasn’t updated: your organization already started 4 updates today.',
  org_not_active: 'The forecast wasn’t updated: your organization isn’t active.',
  start_failed: 'The forecast wasn’t updated: Townwise couldn’t start the update.',
};

export function forecastLine(calibration: AiRead['calibration']): string | null {
  if (calibration === null) return null;
  return FORECAST[calibration.status] ?? 'The forecast wasn’t updated.';
}

/** The undo dialog: what goes, what stays, and that a started forecast update keeps running. */
export function undoBody(ai: AiRead): string {
  const goes: string[] = [];
  if (ai.notes.length > 0) goes.push(`the ${plural(ai.notes.length, 'note', 'notes')} it added (even if someone edited them since)`);
  if (ai.uploadRef !== null) goes.push(`the sales upload it added, with the days it still holds`);
  if (ai.itemRef !== null) goes.push('its summary on Your data');
  const list = goes.length === 0 ? 'what TownwiseAI added from this file' : joinAnd(goes);
  const forecast = ai.calibration?.status === 'started' ? ` ${AI.forecastKept}` : '';
  return `This deletes ${list}.${forecast} The file stays on Your data, and you can let TownwiseAI read it again. This can’t be undone.`;
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1) ?? ''}`;
}

export function undidLine(calibrationKept: string | null): string {
  return calibrationKept === null ? AI.undid : `${AI.undid} ${AI.forecastKept}`;
}

/** A refusal of asking for a read or of an undo: this feature's codes, then Your data's words. */
export function aiError(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.status === 503 && error.code === 'ai_unavailable') return 'TownwiseAI can’t read files right now. Try again later.';
    if (error.status === 409 && error.code === 'ai_read_running') return 'TownwiseAI is already reading this file.';
    if (error.status === 429 && error.code === 'ai_read_queue_full') {
      return 'TownwiseAI is already reading 10 of your organization’s files. Try again when one of them is done.';
    }
    if (error.status === 400 && error.code === 'nothing_to_undo') return 'There’s nothing TownwiseAI added from this file left to undo.';
    if (error.status === 400) return 'TownwiseAI can’t read this file now. It may still be uploading, or its original was deleted.';
  }
  return dataError(error);
}

// ---- Which files TownwiseAI reads -------------------------------------------------------------------------------

const PICTURES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function extensionOf(name: string | null): string {
  const dot = name?.lastIndexOf('.') ?? -1;
  return name === null || dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Why TownwiseAI can't read a file of this kind, or null when it can (spec 11A.9): a PDF, a CSV or text file, an Excel
 * workbook, a Word document, a ZIP of those, or a picture. A picture is told by its bytes, which the page doesn't have,
 * so here by its name; one named otherwise is said to be unreadable, and old Excel and Word files and Numbers never are.
 */
export function cantReadLine(item: Pick<DataItem, 'kind' | 'name'>): string | null {
  switch (item.kind) {
    case 'text':
    case 'xlsx':
    case 'pdf':
    case 'docx':
    case 'zip':
      return null;
    case 'xls':
      return 'TownwiseAI can’t read old Excel files (.xls). Save it as .xlsx and add it again to let TownwiseAI read it.';
    case 'doc':
      return 'TownwiseAI can’t read old Word files (.doc). Save it as .docx and add it again to let TownwiseAI read it.';
    default: {
      const extension = extensionOf(item.name);
      if (PICTURES.has(extension)) return null;
      if (extension === 'numbers') return 'TownwiseAI can’t read Numbers files. Export it as CSV or Excel and add it again to let TownwiseAI read it.';
      return 'TownwiseAI reads PDFs, pictures, Excel and Word files, CSV and text files, and ZIPs of them, so it can’t read this file.';
    }
  }
}

// ---- The opt-in under Add a file --------------------------------------------------------------------------------

/** What happened to one finished file the person let TownwiseAI read. */
export type OptInState =
  | { state: 'asking' }
  | { state: 'asked' }
  | { state: 'not_read'; why: string }
  | { state: 'refused'; error: unknown };

export function optInLine(asked: OptInState): string {
  switch (asked.state) {
    case 'asking':
      return 'Added. Asking TownwiseAI to read it…';
    case 'asked':
      return 'Added. TownwiseAI is reading it; open it on Your data to see what it finds.';
    case 'not_read':
      return `Added. ${asked.why}`;
    case 'refused':
      return `Added, but TownwiseAI didn’t start reading it. ${aiError(asked.error)}`;
  }
}
