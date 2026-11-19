import type { ResearchedEvent } from '../analytics/api';
import { formatCount } from '../format';
import { clockWords, datesLine, weekdaysLine } from '../locations/noteRules';
import type { LocationRun } from './api';
import { LIVE_RUN_STATUSES } from './api';

// The words of town research (D66, OpenSpec change town-research-agent, design decision 15), as pure functions beside
// the components that print them, each pinned by test/portal/research-copy.test.ts. Research works in "topics" (never
// "threads"), in plain words (15.6), with no em dash. This part holds the Calendar's (P28): the filter and the day
// panel's group, a found event's where and who, its chips, its actions and their answers, the edit sheet, and the
// banner for a run a person started. [CONFIRM: the Town tab's, Calendar's, banner's, switch's, activity's and
// dashboard's words for research]

/** The Calendar's filter and the day panel's group. */
export const FOUND_LABEL = 'Found by research';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** “Thu, Dec 3”: a day as the draft and the banner say it. */
function shortDay(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  return `${SHORT_WEEKDAYS[day.getUTCDay()] ?? ''}, ${SHORT_MONTHS[day.getUTCMonth()] ?? ''} ${String(day.getUTCDate())}`;
}

/** “at Example Hall · by Example Club”, either half alone, or null with neither. */
export function whereWho(event: Pick<ResearchedEvent, 'where' | 'who'>): string | null {
  const parts = [event.where === null ? null : `at ${event.where}`, event.who === null ? null : `by ${event.who}`].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** “From 7 pm”, or null for an event with no start time. */
export function foundTime(event: Pick<ResearchedEvent, 'startTime'>): string | null {
  return event.startTime === null ? null : `From ${clockWords(event.startTime)}`;
}

/** “Dec 3, 2026, Thursdays only, from 7 pm”: the event's dates and whatever else it has. */
export function foundLine(event: Pick<ResearchedEvent, 'start' | 'end' | 'weekdays' | 'startTime'>): string {
  const time = foundTime(event);
  return [
    datesLine({ startDate: event.start, endDate: event.end }), weekdaysLine(event.weekdays), time === null ? null : time.toLowerCase(),
  ].filter((part) => part !== null).join(', ');
}

/** The chips a found event carries on the Calendar: Unconfirmed for a low-confidence finding, Cancelled when it is. */
export function foundChips(event: Pick<ResearchedEvent, 'confidence' | 'status'>): string[] {
  return [event.confidence === 'low' ? 'Unconfirmed' : null, event.status === 'cancelled' ? 'Cancelled' : null].filter((chip) => chip !== null);
}

/** What a compact surface (a cell, the tooltip, a week card) prints: the title, and “(cancelled)” after a cancelled one. */
export function foundWords(event: Pick<ResearchedEvent, 'title' | 'status'>): string {
  return event.status === 'cancelled' ? `${event.title} (cancelled)` : event.title;
}

/** A cell's screen-reader label for a found event, as “From your calendar:” is for an imported one. */
export function foundEntryLabel(words: string): string {
  return `${FOUND_LABEL}: ${words}`;
}

/** An edited event's line, beside its Reset. */
export const EDITED_LINE = 'Edited by your team';

/** The day panel's actions on a found event, and what each says to a screen reader. */
export const FOUND_ACTIONS = { edit: 'Edit', hide: 'Hide', ask: 'Ask TownwiseAI', reset: 'Reset' } as const;

export function foundActionLabel(action: keyof typeof FOUND_ACTIONS, title: string): string {
  if (action === 'ask') return `Ask TownwiseAI about ${title}`;
  return `${FOUND_ACTIONS[action]} ${title}`;
}

/** The draft Ask TownwiseAI leaves in a new conversation's composer: “Is Trivia night on Thu, Dec 3 right?”. */
export function askDraft(title: string, date: string, today: string): string {
  const day = shortDay(date);
  return `Is ${title} on ${date.slice(0, 4) === today.slice(0, 4) ? day : `${day}, ${date.slice(0, 4)}`} right?`;
}

/** The line under the group: what research is, and that a change here is this location's only. */
export const FOUND_NOTE = 'Found by Townwise’s research on public websites. A change here applies to this location only. They change the forecast only through a note you add or accept.';

/** The answers to the day panel's actions. */
export const FOUND_NOTICES = {
  saved: 'Saved. Only this location’s calendar changes.',
  hidden: 'Hidden for this location. Restore it from the Town tab.',
  reset: 'Back to what research found.',
  changedSince: 'Someone changed this event since you opened it. It now reads as shown. Make your change again, then save.',
  changedSinceAction: 'Someone changed this event since you opened it. Here is how it reads now.',
  gone: 'This event isn’t available any more.',
  tooManyEdits: 'This location has reached its limit of 1,000 edits to researched events.',
  invalid: 'Check the title, dates and time.',
} as const;

/** The edit sheet. */
export const EDIT_SHEET = {
  heading: 'Edit event',
  title: 'Title',
  start: 'Starts',
  end: 'Ends',
  time: 'Time (optional)',
  where: 'Where (optional)',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  needTitle: 'Enter a title.',
  badDate: 'Enter a date as YYYY-MM-DD.',
  endBeforeStart: 'The end can’t be before the start.',
  badTime: 'Enter a time as HH:MM, or leave it empty.',
} as const;

/** The banner's link to the Town tab and its dismiss. */
export const BANNER_LINK = 'Open the Town tab';
export const BANNER_DISMISS = 'Dismiss';

/**
 * The Calendar's banner for the location's last run, only for one a person started (Research now, or the early run
 * after the location was created or its place picked); null for a weekly run or none.
 */
export function bannerWords(run: Pick<LocationRun, 'trigger' | 'status' | 'counts'> | null, locationName: string): string | null {
  if (run === null || run.trigger === 'weekly') return null;
  if (LIVE_RUN_STATUSES.includes(run.status)) return `Researching ${locationName} and its town. What it finds shows on the calendar when it finishes.`;
  if (run.status === 'done' || run.status === 'partial') {
    const added = run.counts.added;
    const found = added === 0 ? 'nothing new this time' : `${formatCount(added)} new ${added === 1 ? 'event' : 'events'} on the calendar`;
    return run.status === 'partial'
      ? `Research for ${locationName} finished with some topics left undone: ${found}.`
      : `Research for ${locationName} finished: ${found}.`;
  }
  return `Research for ${locationName} didn’t finish. The Town tab says why.`;
}

// TownwiseAI's, Home's and the dashboard's words (task 7.4): the correction card drawn from a correct_calendar_event
// tool part (design decision 12), its tool row when nothing was changed, the activity's research_done line, the
// budget line's research part and the dashboard's line while a location's run is live.

/** What correct_calendar_event can do to an event. */
export type CorrectionChange = 'edit' | 'hide' | 'restore';

/** The fields a correction proposes; only those it changes are present. */
export interface CorrectionFields {
  title?: string;
  start?: string;
  end?: string;
  weekdays?: number[] | null;
  startTime?: string | null;
  where?: string | null;
}

/** The correction card. */
export const CORRECTION = {
  eyebrow: 'Calendar correction',
  undo: 'Undo',
  undoing: 'Undoing…',
  undone: 'Undone. The event reads as it did before.',
  apply: 'Apply',
  applying: 'Applying…',
  applied: 'Applied. Only this location’s calendar changed. Reset it on the Calendar to undo.',
  why: 'This conversation read a web page or a file, so nothing changes until you apply it. It changes this location’s calendar only.',
  open: 'Open the Calendar',
} as const;

/** The card's lead for a correction TownwiseAI made. */
export function correctionDoneLine(change: CorrectionChange): string {
  const did = change === 'edit' ? 'changed' : change === 'hide' ? 'hid' : 'restored';
  return `TownwiseAI ${did} an event town research found, on this location’s calendar only.`;
}

/** The card's lead for a correction it proposes for one tap. */
export function correctionProposedLine(change: CorrectionChange): string {
  const what = change === 'edit' ? 'changing' : change === 'hide' ? 'hiding' : 'restoring';
  return `TownwiseAI suggests ${what} an event town research found.`;
}

/** The proposed change's lines: “Title: Trivia night”, “Dates: Dec 3, 2026”, “Thursdays only”, “From 7 pm”, “Where: Example Hall”. */
export function correctionFieldLines(fields: CorrectionFields | null): string[] {
  if (fields === null) return [];
  const lines: string[] = [];
  if (fields.title !== undefined) lines.push(`Title: ${fields.title}`);
  if (fields.start !== undefined && fields.end !== undefined) lines.push(`Dates: ${datesLine({ startDate: fields.start, endDate: fields.end })}`);
  else if (fields.start !== undefined) lines.push(`Starts ${datesLine({ startDate: fields.start, endDate: fields.start })}`);
  else if (fields.end !== undefined) lines.push(`Ends ${datesLine({ startDate: fields.end, endDate: fields.end })}`);
  if (fields.weekdays !== undefined) lines.push(weekdaysLine(fields.weekdays) ?? 'Every day of its dates');
  if (fields.startTime !== undefined) lines.push(fields.startTime === null ? 'No start time' : `From ${clockWords(fields.startTime)}`);
  if (fields.where !== undefined) lines.push(fields.where === null ? 'No place' : `Where: ${fields.where}`);
  return lines;
}

/** Why Apply did not change the event. */
export const APPLY_NOTICES = {
  changedSince: 'Someone changed this event just now. Check it on the Calendar, then apply again if it’s still right.',
  gone: 'This event isn’t available any more.',
  tooManyEdits: 'This location has reached its limit of 1,000 edits to researched events.',
  invalid: 'This change can’t be applied as it is now. Make it on the Calendar instead.',
  viewAs: 'View-as is read-only, so you can’t apply this.',
  failed: 'Couldn’t apply this. Try again.',
} as const;

/** The tool row's words for a correct_calendar_event call that changed nothing, by the result's code. */
export const CORRECTION_CODES: Readonly<Record<string, string>> = {
  not_researched: 'Only events town research found can be changed',
  not_found: 'This location has no such event',
  bad_title: 'That title or place can’t be used',
  bad_dates: 'Those dates can’t be used',
  staff: 'Townwise staff can’t change a calendar here',
  view_as: 'Nothing changes while viewing as someone else',
  too_many: 'At most 5 corrections in one reply',
  too_many_edits: 'This location has reached its 1,000 edits',
  changed_since: 'Someone changed this event just now',
  invalid: 'It couldn’t be saved',
  duplicate: 'This correction was already made',
};

/** The activity's and the changes log's line for a correction TownwiseAI made (chat/agentChanges.ts changeLine). */
export const CORRECTED_LINE = 'Corrected an event town research found, on this location’s calendar only, from your message.';

/** A research run that ended, as the activity's `research_done` item gives it. */
export interface ResearchDone {
  subject: 'town' | 'location';
  status: 'done' | 'partial' | 'failed' | 'budget';
  found: number;
  added: number;
  competitors: number | null;
  threadsFailed: number;
}

/**
 * The activity's line for a research run: “Researched Hanover: 12 events found, 4 new.”; the location's names how many
 * of its new events are at competitors, and a partial run the topics that didn't finish. `town` is the town's name.
 */
export function researchDoneLine(item: ResearchDone, town: string): string {
  const subject = item.subject === 'town' ? town : 'your restaurant and nearby';
  if (item.status === 'failed') return `Research of ${subject} didn’t finish. Nothing changed on the calendar.`;
  if (item.status === 'budget') {
    return item.subject === 'town'
      ? `Research of ${subject} waited: Townwise’s research budget for this month is used.`
      : `Research of ${subject} didn’t run: little of this month’s TownwiseAI budget was left.`;
  }
  const found = item.found === 0 ? 'nothing found this time'
    : `${formatCount(item.found)} ${item.found === 1 ? 'event' : 'events'} found, ${item.added === 0 ? 'none new' : `${formatCount(item.added)} new`}`;
  const competitors = item.subject === 'location' && item.added > 0 && item.competitors !== null && item.competitors > 0
    ? `, ${formatCount(item.competitors)} of them at competitors` : '';
  const undone = item.status === 'partial' && item.threadsFailed > 0
    ? ` ${formatCount(item.threadsFailed)} ${item.threadsFailed === 1 ? 'topic' : 'topics'} didn’t finish.` : '';
  return `Researched ${subject}: ${found}${competitors}.${undone}`;
}

/** The budget line's research part, in dollars and cents; null when research spent nothing (or the API sent none). */
export function researchBudgetLine(researchUsd: number | undefined): string | null {
  if (researchUsd === undefined || !(researchUsd > 0)) return null;
  return `Research used $${researchUsd.toFixed(2)} of this month’s budget.`;
}

/** The dashboard's line while a location's research run is live, linked to its Town tab (plain words, 15.6). */
export const DASHBOARD_RESEARCHING = 'Researching';
