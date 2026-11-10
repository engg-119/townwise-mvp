// TownwiseAI's "Questions for you" (spec 10.12, docs/portal/tuning-chat.md section 8): rule-based questions about
// days with no sales, computed at read time from the location's own days, notes and earlier answers. Pure: no store,
// no clock. Nothing here estimates, scores or predicts; a question only says which days have no sales and asks why.
//
// - The window is the last 365 days of coverage, from max(first day, last day - 364) to the last day with sales.
//   Questions look only from the first day with sales in the window: before it the window holds no data at all.
// - A weekday question asks "closed on Mondays?" when at least 60% of that weekday's counted days have no sales and
//   are not explained (by a closure note, or by an earlier answer), with at least 4 counted days. A day counts only
//   when its week (Monday to Sunday) has sales on another day, so a week with no data at all, a long hole in the data
//   or a seasonal closure, never makes a weekday look closed. The question runs from the first day with sales.
// - A gap question asks about each run of consecutive days with no sales that no note or earlier answer explains.
//   Days of a weekday the location is usually closed on (60% rule on all its counted days) never start or end a gap, but
//   bridge one. A run that starts the window before the first day with sales is cut off by the window, so it is not
//   asked.
// - An answered question's days are never asked about again. At most 5 questions: weekdays first, then gaps newest
//   first.
// - A day a turned-off upload holds (D28) is explained, as a covering note makes it: turning data off never asks
//   "Were you closed?" about it.
import { daysBetween, isCalendarDate } from '../dates.ts';
import type { NoteContent } from '../stores/notes.ts';
import type { SalesDay } from '../stores/sales-days.ts';

/** The answers a question takes. `closed` saves a closure note over the question's days. */
export const QUESTION_ANSWERS = ['closed', 'open', 'not_sure'] as const;
export type QuestionAnswer = (typeof QUESTION_ANSWERS)[number];

/** At most this many questions at once. */
export const MAX_QUESTIONS = 5;
/** The window: the last 365 days of coverage. */
const WINDOW_DAYS = 365;
/** A weekday is asked about when this share of its days in the window have no sales. [CONFIRM: 60%, at least 4] */
const WEEKDAY_SHARE = 0.6;
const WEEKDAY_MIN_DAYS = 4;

/** What a question asks about; its id encodes exactly this, so an answer can be completed from the id alone. */
export type AskedQuestion =
  | { readonly kind: 'weekday'; readonly weekday: number; readonly from: string; readonly to: string }
  | { readonly kind: 'gap'; readonly from: string; readonly to: string };

/** A question as the side panel shows it: ids, dates and counts only; the client words it. */
export type Question =
  | {
    readonly id: string; readonly kind: 'weekday'; readonly weekday: number; readonly from: string; readonly to: string;
    /** Counted days of this weekday with no sales, and all its counted days (weeks with sales on another day). */
    readonly noSalesCount: number; readonly weekdayCount: number;
  }
  | { readonly id: string; readonly kind: 'gap'; readonly from: string; readonly to: string; readonly dayCount: number };

export interface QuestionInput {
  readonly coverage: { readonly firstDate: string | null; readonly lastDate: string | null };
  /** The location's stored days in the window (more are ignored). */
  readonly days: readonly SalesDay[];
  readonly notes: readonly NoteContent[];
  /** Ids of questions already answered. */
  readonly answered: readonly string[];
  /** D28: dates a turned-off upload holds, treated as explained, as a covering note is. */
  readonly turnedOff?: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function timeOf(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function plusDays(day: string, days: number): string {
  return new Date(timeOf(day) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(day: string): number {
  return new Date(timeOf(day)).getUTCDay();
}

/** The Monday that starts `day`'s week. */
function weekOf(day: string): string {
  return plusDays(day, -((weekdayOf(day) + 6) % 7));
}

/** The days from `from` to `to`, inclusive. */
function datesIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = plusDays(day, 1)) out.push(day);
  return out;
}

/** The window questions look at, or null when the location has no sales yet. */
export function questionWindow(coverage: QuestionInput['coverage']): { from: string; to: string } | null {
  const { firstDate, lastDate } = coverage;
  if (firstDate === null || lastDate === null) return null;
  const earliest = plusDays(lastDate, -(WINDOW_DAYS - 1));
  return { from: firstDate > earliest ? firstDate : earliest, to: lastDate };
}

export function questionId(asked: AskedQuestion): string {
  return asked.kind === 'weekday' ? `weekday_${asked.weekday}_${asked.from}_${asked.to}` : `gap_${asked.from}_${asked.to}`;
}

/** The question an id stands for, or null when it names none (malformed dates, or an end before the start). */
export function parseQuestionId(id: string): AskedQuestion | null {
  const weekday = /^weekday_([0-6])_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(id);
  const gap = /^gap_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(id);
  const asked: AskedQuestion | null = weekday !== null
    ? { kind: 'weekday', weekday: Number(weekday[1]), from: weekday[2] ?? '', to: weekday[3] ?? '' }
    : gap === null ? null : { kind: 'gap', from: gap[1] ?? '', to: gap[2] ?? '' };
  if (asked === null || !isCalendarDate(asked.from) || !isCalendarDate(asked.to) || asked.to < asked.from) return null;
  if (daysBetween(asked.from, asked.to) >= WINDOW_DAYS) return null;
  return asked;
}

/** Whether `asked` is about `day`. */
function asksAbout(asked: AskedQuestion, day: string): boolean {
  return day >= asked.from && day <= asked.to && (asked.kind === 'gap' || weekdayOf(day) === asked.weekday);
}

function noteCovers(note: NoteContent, day: string): boolean {
  return day >= note.startDate && day <= note.endDate && (note.weekdays === null || note.weekdays.includes(weekdayOf(day)));
}

function isClosure(note: NoteContent): boolean {
  return note.kind === 'closure' || note.effect === 'closed';
}

/** The closure note a `closed` answer saves: every day of a gap, or the weekday over the window. */
export function closureNoteOf(asked: AskedQuestion): NoteContent {
  return {
    kind: 'closure', startDate: asked.from, endDate: asked.to, weekdays: asked.kind === 'weekday' ? [asked.weekday] : null,
    effect: 'closed', expectedGuests: null, detail: null,
  };
}

export function questionsFor(input: QuestionInput): Question[] {
  const window = questionWindow(input.coverage);
  if (window === null) return [];
  const withSales = new Set(input.days
    .filter((day) => day.guests !== null || day.netSalesCents !== null)
    .map((day) => day.date));
  const answered = input.answered.flatMap((id) => {
    const asked = parseQuestionId(id);
    return asked === null ? [] : [asked];
  });
  const closures = input.notes.filter(isClosure);
  const turnedOff = new Set(input.turnedOff);
  const all = datesIn(window.from, window.to);
  const firstWithSales = all.findIndex((day) => withSales.has(day));
  const dates = firstWithSales < 0 ? [] : all.slice(firstWithSales);
  const from = dates[0];
  if (from === undefined) return [];
  const answeredAbout = (day: string): boolean => answered.some((asked) => asksAbout(asked, day));
  const salesInWeek = new Map<string, number>();
  for (const day of dates) if (withSales.has(day)) salesInWeek.set(weekOf(day), (salesInWeek.get(weekOf(day)) ?? 0) + 1);
  /** Whether the location had sales on another day of `day`'s week. */
  const weekHasSales = (day: string): boolean => (salesInWeek.get(weekOf(day)) ?? 0) > (withSales.has(day) ? 1 : 0);

  // Weekdays: the share of each weekday's counted days with no sales, over all of them and over those still unexplained.
  const weekdayQuestions: Question[] = [];
  const closedWeekdays = new Set<number>();
  for (let weekday = 0; weekday < 7; weekday += 1) {
    // A turned-off day counts as no data, like a week with no sales: it never makes a weekday look usually closed.
    const ofWeekday = dates.filter((day) => weekdayOf(day) === weekday && weekHasSales(day) && !turnedOff.has(day));
    if (ofWeekday.length < WEEKDAY_MIN_DAYS) continue;
    const noSales = ofWeekday.filter((day) => !withSales.has(day));
    if (noSales.length >= WEEKDAY_SHARE * ofWeekday.length) closedWeekdays.add(weekday);
    const unexplained = noSales.filter((day) => !closures.some((note) => noteCovers(note, day)) && !answeredAbout(day));
    if (unexplained.length < WEEKDAY_SHARE * ofWeekday.length) continue;
    const asked: AskedQuestion = { kind: 'weekday', weekday, from, to: window.to };
    weekdayQuestions.push({ id: questionId(asked), ...asked, noSalesCount: noSales.length, weekdayCount: ofWeekday.length });
  }

  // Gaps: runs of days with no sales.
  const explained = (day: string): boolean => input.notes.some((note) => noteCovers(note, day)) || answeredAbout(day) || turnedOff.has(day);
  const closedDay = (day: string): boolean => closedWeekdays.has(weekdayOf(day));
  const gapQuestions: Question[] = [];
  let run: string[] = [];
  const endRun = (): void => {
    // A usually closed weekday never starts or ends a gap.
    const start = run.findIndex((day) => !closedDay(day));
    const end = run.findLastIndex((day) => !closedDay(day));
    const first = run[start];
    const last = run[end];
    if (first !== undefined && last !== undefined) {
      const asked: AskedQuestion = { kind: 'gap', from: first, to: last };
      gapQuestions.push({ id: questionId(asked), ...asked, dayCount: daysBetween(first, last) + 1 });
    }
    run = [];
  };
  for (const day of dates) {
    if (!withSales.has(day) && (closedDay(day) || !explained(day))) run.push(day);
    else endRun();
  }
  endRun();
  gapQuestions.reverse();

  const asked = new Set(input.answered);
  return [...weekdayQuestions, ...gapQuestions].filter((question) => !asked.has(question.id)).slice(0, MAX_QUESTIONS);
}
