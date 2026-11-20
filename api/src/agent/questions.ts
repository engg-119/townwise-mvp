// TownwiseAI's "Questions for you" (spec 10.12, docs/portal/tuning-chat.md section 8): rule-based questions about
// days with no sales and days with almost no guests, computed at read time from the location's own days, notes, rule
// schedules and earlier answers. Pure: no store, no clock. Nothing here estimates, scores or predicts; a question only says which days
// look closed, with the numbers that make them look so (dates, day counts and guest counts, never net sales), and asks why.
//
// - The window is the last 365 days of coverage, from max(first day, last day - 364) to the last day with sales.
//   Questions look only from the first day with sales in the window: before it the window holds no data at all. The
//   days read reach 56 days further back, so each day in the window has its 8 same weekdays before it (spec D32).
// - D46: a weekday is usually closed when at least 60% of its counted days have no sales, with at least 4 counted days.
//   A day counts only when its week (Monday to Sunday) has sales on another day, so a week with no data at all, a long
//   hole in the data or a seasonal closure, never makes a weekday look closed. It is no longer asked as a question:
//   weekdayEvidence adds a recency bar (its last 4 counted days have no sales) and salesSuggestionsFor makes it a
//   suggested standing closure rule (agent/rule-suggestion-views.ts) starting after its last day with sales. Weekday
//   questions answered before stay answered, and their ids still parse.
// - A day is usually busy when its weekday had guests on at least 5 of the 8 same weekdays before it and its typical
//   guests (D32, closed-days.ts) are at least 10. Gap and likely-closed questions ask only about usually busy days that
//   are not on a weekday the location is usually closed on, so a location with no guest counts is asked weekday
//   questions only.
// - A gap question asks about each run of consecutive days with no sales that no note or earlier answer explains, when
//   at least one of its days is usually busy, with the lowest and highest typical guests of those days. Days of a
//   weekday the location is usually closed on (60% rule on all its counted days) never start or end a gap, but bridge
//   one. A run that starts the window before the first day with sales is cut off by the window, so it is not asked.
// - A likely-closed question asks "were you open?" about a usually busy day D32 calls likely closed (guests under a
//   tenth of its typical guests) that no note or earlier answer explains, with the day's guests and typical guests.
// - A business rule's schedule (D31), its end null meaning none, explains a day only as it decides it, unlike a note: a
//   closure schedule (isClosure) explains the days it covers as a closure note does (a likely-closed day too, which D32
//   then reads as closed); one with more or fewer guests explains only a likely-closed day, which D32 then reads as open,
//   since no sales under "busy Fridays" is more suspicious, not less; any other schedule explains nothing.
// - An answered question's days are never asked about again, whatever the answer. At most 5 questions: gaps and
//   likely-closed days together, newest first by their last day.
// - A day a turned-off upload holds (D28) is explained, as a covering note makes it: turning data off never asks
//   "Were you closed?" about it.
// - D59 slice 5: a day an event on one of the location's calendars plainly says was closed is explained, as a covering
//   closure note makes it, so a gap shrinks to the days left and a likely-closed day is not asked. Weekday evidence is
//   read from sales alone.
import { closureOf, isClosure, trustedGuestDays, TYPICAL_WEEKS, typicalGuests } from '../closed-days.ts';
import { daysBetween, isCalendarDate } from '../dates.ts';
import type { SalesEvidence } from '../stores/agent-suggestions.ts';
import type { BusinessRuleRecord, RuleSchedule, RuleSeason } from '../stores/business-rules.ts';
import { closureKeyOf, isSuggestable } from './closure-suggestions.ts';
import type { NoteContent } from '../stores/notes.ts';
import type { SalesDay } from '../stores/sales-days.ts';

/**
 * The answers a question takes. `closed` saves a closure note over the question's days, and `open` on a likely-closed
 * question saves the open-day note; the others save nothing. `other` is Something else: the client sends the person's
 * words to the chat, and the answer itself holds none.
 */
export const QUESTION_ANSWERS = ['closed', 'open', 'not_sure', 'other'] as const;
export type QuestionAnswer = (typeof QUESTION_ANSWERS)[number];

/** At most this many questions at once. */
export const MAX_QUESTIONS = 5;
/** The window: the last 365 days of coverage. */
const WINDOW_DAYS = 365;
/**
 * A weekday is usually closed when this share of its days in the window have no sales, and suggested as closed (D46)
 * when its last WEEKDAY_RECENT_DAYS counted days have none too.
 */
const WEEKDAY_SHARE = 0.6;
const WEEKDAY_MIN_DAYS = 4;
const WEEKDAY_RECENT_DAYS = 4;
/**
 * A day is usually busy when its weekday had guests on at least this many of the 8 same weekdays before it, and its
 * typical guests (spec D32) are at least BUSY_TYPICAL_GUESTS, compared before rounding. [CONFIRM: a day is asked about
 * only when its weekday had guests on at least 5 of the 8 same weekdays before it, with typical guests of at least 10]
 */
export const BUSY_OPEN_WEEKS = 5;
export const BUSY_TYPICAL_GUESTS = 10;
/**
 * The detail of the note "Yes, it was just slow" saves on a likely-closed question. [CONFIRM: "Yes, it was just slow"
 * saves an Other note with fewer guests and the detail "Open, with very few guests (your answer to TownwiseAI)."]
 */
export const OPEN_DAY_DETAIL = 'Open, with very few guests (your answer to TownwiseAI).';

/** What a question asks about; its id encodes exactly this, so an answer can be completed from the id alone. */
export type AskedQuestion =
  | { readonly kind: 'weekday'; readonly weekday: number; readonly from: string; readonly to: string }
  | { readonly kind: 'gap'; readonly from: string; readonly to: string }
  | { readonly kind: 'likely_closed'; readonly date: string };

/** A question as the side panel shows it: ids, dates and counts only; the client words it. */
export type Question =
  | {
    readonly id: string; readonly kind: 'weekday'; readonly weekday: number; readonly from: string; readonly to: string;
    /** Counted days of this weekday with no sales, and all its counted days (weeks with sales on another day). */
    readonly noSalesCount: number; readonly weekdayCount: number;
  }
  | {
    readonly id: string; readonly kind: 'gap'; readonly from: string; readonly to: string; readonly dayCount: number;
    /** The lowest and highest typical guests (D32), each rounded to a whole guest, of the run's usually busy days. */
    readonly typicalGuestsLow: number; readonly typicalGuestsHigh: number;
  }
  | {
    readonly id: string; readonly kind: 'likely_closed'; readonly date: string;
    /** The day's stored guests, and its typical guests (D32) rounded to a whole guest. */
    readonly guests: number; readonly typicalGuests: number;
  };

export interface QuestionInput {
  readonly coverage: { readonly firstDate: string | null; readonly lastDate: string | null };
  /** The location's stored days from 56 days before the window to its end (more are ignored). */
  readonly days: readonly SalesDay[];
  readonly notes: readonly NoteContent[];
  /**
   * D31: the schedules of the location's business rules. Unlike a note, a schedule explains a day only as it decides the
   * day: a closure explains days with no sales and likely-closed days, one with more or fewer guests only a likely-closed
   * day (D32 reads it as open), and any other nothing.
   */
  readonly rules?: readonly RuleSchedule[];
  /** Ids of questions already answered. */
  readonly answered: readonly string[];
  /** D28: dates a turned-off upload holds, treated as explained, as a covering note is. */
  readonly turnedOff?: readonly string[];
  /**
   * D59 slice 5: dates an event on one of the location's calendars plainly says it was closed (calendar/closed-events.ts),
   * explained as a covering closure note explains them: a calendar answers the question.
   */
  readonly calendarClosed?: readonly string[];
  /**
   * The town's today (D32): a day on or after it is never asked about as likely closed, since today's upload may be
   * partial. Absent, every day is before today.
   */
  readonly today?: string;
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
  switch (asked.kind) {
    case 'weekday': return `weekday_${asked.weekday}_${asked.from}_${asked.to}`;
    case 'gap': return `gap_${asked.from}_${asked.to}`;
    case 'likely_closed': return `likely_closed_${asked.date}`;
  }
}

/** The question an id stands for, or null when it names none (malformed dates, or an end before the start). */
export function parseQuestionId(id: string): AskedQuestion | null {
  const likely = /^likely_closed_(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (likely !== null) {
    const date = likely[1] ?? '';
    return isCalendarDate(date) ? { kind: 'likely_closed', date } : null;
  }
  const weekday = /^weekday_([0-6])_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(id);
  const gap = /^gap_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(id);
  const asked = weekday !== null
    ? { kind: 'weekday' as const, weekday: Number(weekday[1]), from: weekday[2] ?? '', to: weekday[3] ?? '' }
    : gap === null ? null : { kind: 'gap' as const, from: gap[1] ?? '', to: gap[2] ?? '' };
  if (asked === null || !isCalendarDate(asked.from) || !isCalendarDate(asked.to) || asked.to < asked.from) return null;
  if (daysBetween(asked.from, asked.to) >= WINDOW_DAYS) return null;
  return asked;
}

/** Whether `asked` is about `day`. */
function asksAbout(asked: AskedQuestion, day: string): boolean {
  if (asked.kind === 'likely_closed') return day === asked.date;
  return day >= asked.from && day <= asked.to && (asked.kind === 'gap' || weekdayOf(day) === asked.weekday);
}

/** Whether `day`'s month and day fall in the yearly season (D46), `to` before `from` crossing the new year. */
function inSeason(season: RuleSeason, day: string): boolean {
  const monthDay = day.slice(5);
  return season.from <= season.to
    ? monthDay >= season.from && monthDay <= season.to
    : monthDay >= season.from || monthDay <= season.to;
}

/**
 * Whether `note` covers `day`: inside its dates and, when it names weekdays, on one of them. A business rule's schedule
 * (D31) is read the same way, its `endDate` null meaning no end, and, with a yearly season (D46), only on the season's
 * months and days.
 */
export function noteCovers(
  note: Pick<NoteContent, 'startDate' | 'weekdays'> & { readonly endDate: string | null; readonly season?: RuleSeason | null },
  day: string,
): boolean {
  const season = note.season ?? null;
  return day >= note.startDate && (note.endDate === null || day <= note.endDate)
    && (note.weekdays === null || note.weekdays.includes(weekdayOf(day)))
    && (season === null || inSeason(season, day));
}

// A closure note, or any note whose effect is closed: closed-days.ts keeps the one definition.
export { isClosure };

/** The closure note a `closed` answer saves: every day of a gap, the weekday over the window, or the likely-closed day. */
export function closureNoteOf(asked: AskedQuestion): NoteContent {
  const [startDate, endDate] = asked.kind === 'likely_closed' ? [asked.date, asked.date] : [asked.from, asked.to];
  return {
    kind: 'closure', startDate, endDate, weekdays: asked.kind === 'weekday' ? [asked.weekday] : null,
    effect: 'closed', expectedGuests: null, detail: null, title: null, startTime: null, endTime: null,
  };
}

/**
 * The note an answer saves, or null when it saves none: `closed` saves the closure note, and `open` on a likely-closed
 * question saves the open-day note, an Other note with fewer guests that D32 reads as open.
 */
export function noteFor(asked: AskedQuestion, answer: QuestionAnswer): NoteContent | null {
  if (answer === 'closed') return closureNoteOf(asked);
  if (answer !== 'open' || asked.kind !== 'likely_closed') return null;
  return {
    kind: 'other', startDate: asked.date, endDate: asked.date, weekdays: null, effect: 'fewer_guests', expectedGuests: null,
    detail: OPEN_DAY_DETAIL, title: null, startTime: null, endTime: null,
  };
}

/**
 * The answer a written note stands for. A likely-closed question's `closed` and `open` both write with the answer's one
 * note id, so the note written first decides; on the other kinds only `closed` writes one.
 */
export function answerOfNote(asked: AskedQuestion, note: Pick<NoteContent, 'kind' | 'effect'>): QuestionAnswer {
  return asked.kind === 'likely_closed' && !isClosure(note) ? 'open' : 'closed';
}

/** D46: a weekday the sales history shows closed, with the counts and the dates that show it. */
export interface WeekdayEvidence {
  readonly weekday: number;
  /** The first day with sales in the window, and the window's last day. */
  readonly from: string;
  readonly to: string;
  readonly noSalesCount: number;
  readonly weekdayCount: number;
  /** The last counted day of the weekday with sales (guests or net sales), or null when it had none. */
  readonly lastSalesDate: string | null;
}

/** The window's days from the first with sales, the days with sales, and which days count for a weekday. */
interface Counted {
  readonly from: string;
  readonly to: string;
  readonly withSales: ReadonlySet<string>;
  /** Every day from `from` to `to`. */
  readonly dates: readonly string[];
  /** Each weekday's counted days, oldest first: in a week with sales on another day, and not turned off. */
  readonly byWeekday: readonly (readonly string[])[];
}

function countedDays(input: QuestionInput): Counted | null {
  const window = questionWindow(input.coverage);
  if (window === null) return null;
  const withSales = new Set(input.days
    .filter((day) => day.guests !== null || day.netSalesCents !== null)
    .map((day) => day.date));
  const turnedOff = new Set(input.turnedOff);
  const all = datesIn(window.from, window.to);
  const firstWithSales = all.findIndex((day) => withSales.has(day));
  const dates = firstWithSales < 0 ? [] : all.slice(firstWithSales);
  const from = dates[0];
  if (from === undefined) return null;
  const salesInWeek = new Map<string, number>();
  for (const day of dates) if (withSales.has(day)) salesInWeek.set(weekOf(day), (salesInWeek.get(weekOf(day)) ?? 0) + 1);
  /** Whether the location had sales on another day of `day`'s week. */
  const weekHasSales = (day: string): boolean => (salesInWeek.get(weekOf(day)) ?? 0) > (withSales.has(day) ? 1 : 0);
  // A turned-off day counts as no data, like a week with no sales: it never makes a weekday look usually closed.
  const byWeekday = Array.from({ length: 7 }, (_, weekday) => dates.filter((day) => weekdayOf(day) === weekday && weekHasSales(day) && !turnedOff.has(day)));
  return { from, to: window.to, withSales, dates, byWeekday };
}

/**
 * D46: the weekdays the sales history shows closed: at least 60% of at least 4 counted days with no sales, as a usually
 * closed weekday, and no day of the weekday with sales on or after the first of its last 4 counted days, so a past or
 * seasonal pattern never becomes a standing rule. The last day with sales is read over every day of the weekday in the
 * window, counted or not (a Monday alone in its week, as an export that ends on a Monday leaves it, still had sales), so
 * the rule never covers a past day with recorded sales.
 */
export function weekdayEvidence(input: QuestionInput): WeekdayEvidence[] {
  const counted = countedDays(input);
  if (counted === null) return [];
  return counted.byWeekday.flatMap((days, weekday): WeekdayEvidence[] => {
    if (days.length < WEEKDAY_MIN_DAYS) return [];
    const noSales = days.filter((day) => !counted.withSales.has(day));
    if (noSales.length < WEEKDAY_SHARE * days.length) return [];
    const lastSalesDate = counted.dates.findLast((day) => weekdayOf(day) === weekday && counted.withSales.has(day)) ?? null;
    const recentFrom = days[days.length - WEEKDAY_RECENT_DAYS] ?? '';
    if (lastSalesDate !== null && lastSalesDate >= recentFrom) return [];
    return [{ weekday, from: counted.from, to: counted.to, noSalesCount: noSales.length, weekdayCount: days.length, lastSalesDate }];
  });
}

/** A suggested standing closure from the sales history (D46). */
export interface SalesSuggestion { readonly weekday: number; readonly schedule: RuleSchedule; readonly evidence: SalesEvidence }

/** Earlier weekday answers that say the weekday is not closed: they suppress its suggestion. A `closed` answer does not. */
const NOT_CLOSED: readonly QuestionAnswer[] = ['open', 'not_sure', 'other'];

/**
 * D46: each weekday's evidence as a standing closure, "Closed on Mondays", starting the day after its last day with
 * sales (or the first day with sales when it had none), so it never covers a past day with recorded sales; no end.
 * Suppressed when the weekday's earlier question was answered open, not sure or something else, when a suggestion row
 * already holds its closure key (in any status), or when the location's rules already make it pointless (isSuggestable).
 */
export function salesSuggestionsFor(input: {
  readonly evidence: readonly WeekdayEvidence[];
  readonly answers: readonly { readonly questionId: string; readonly answer: QuestionAnswer }[];
  readonly rules: readonly Pick<BusinessRuleRecord, 'text' | 'schedule'>[];
  readonly takenKeys: ReadonlySet<string>;
}): SalesSuggestion[] {
  const notClosed = new Set(input.answers.flatMap(({ questionId, answer }) => {
    const asked = parseQuestionId(questionId);
    return asked?.kind === 'weekday' && NOT_CLOSED.includes(answer) ? [asked.weekday] : [];
  }));
  return input.evidence.flatMap((each): SalesSuggestion[] => {
    if (notClosed.has(each.weekday)) return [];
    const schedule: RuleSchedule = {
      kind: 'closure', startDate: each.lastSalesDate === null ? each.from : plusDays(each.lastSalesDate, 1), endDate: null,
      weekdays: [each.weekday], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
    };
    if (input.takenKeys.has(closureKeyOf(schedule)) || !isSuggestable(schedule, { rules: input.rules })) return [];
    return [{
      weekday: each.weekday, schedule,
      evidence: { noSalesCount: each.noSalesCount, weekdayCount: each.weekdayCount, lastSalesDate: each.lastSalesDate },
    }];
  });
}

export function questionsFor(input: QuestionInput): Question[] {
  const counted = countedDays(input);
  if (counted === null) return [];
  const { withSales } = counted;
  const answered = input.answered.flatMap((id) => {
    const asked = parseQuestionId(id);
    return asked === null ? [] : [asked];
  });
  const rules = input.rules ?? [];
  const ruleClosures = rules.filter(isClosure);
  const turnedOff = new Set(input.turnedOff);
  const calendarClosed = new Set(input.calendarClosed);
  const { dates } = counted;
  const answeredAbout = (day: string): boolean => answered.some((asked) => asksAbout(asked, day));

  // Weekdays usually closed (60% of their counted days with no sales, at least 4): never asked about (D46), but they
  // bridge gaps and are left out of likely-closed days.
  const closedWeekdays = new Set(counted.byWeekday.flatMap((days, weekday) => {
    if (days.length < WEEKDAY_MIN_DAYS) return [];
    return days.filter((day) => !withSales.has(day)).length >= WEEKDAY_SHARE * days.length ? [weekday] : [];
  }));

  // Any covering note explains a day; of the rule schedules, only a closure does (a likely-closed day's are read below).
  const explained = (day: string): boolean => input.notes.some((note) => noteCovers(note, day))
    || ruleClosures.some((rule) => noteCovers(rule, day)) || answeredAbout(day) || turnedOff.has(day) || calendarClosed.has(day);
  const closedDay = (day: string): boolean => closedWeekdays.has(weekdayOf(day));
  // Usually busy, from the same stored days D32's typical guests read (the window and the 56 days before it). D67: a
  // count a note marks wrong is in none of them (that day still has sales, as `withSales` reads it).
  const rows = new Map(trustedGuestDays(input.days, input.notes).map((day) => [day.date, day]));
  const guestsOn = (day: string): number | null | undefined => rows.get(day)?.guests;
  /** The typical guests of a day a gap or likely-closed question may ask about, or null for any other day. */
  const askedTypical = (day: string): number | null => {
    if (closedDay(day)) return null;
    let openWeeks = 0;
    for (let week = 1; week <= TYPICAL_WEEKS; week += 1) {
      const guests = guestsOn(plusDays(day, -7 * week));
      if (guests !== null && guests !== undefined && guests > 0) openWeeks += 1;
    }
    const typical = typicalGuests(day, guestsOn);
    return openWeeks >= BUSY_OPEN_WEEKS && typical !== null && typical >= BUSY_TYPICAL_GUESTS ? typical : null;
  };

  // Gaps (runs of days with no sales) and likely-closed days, oldest first.
  const dayQuestions: Question[] = [];
  let run: string[] = [];
  const endRun = (): void => {
    // A usually closed weekday never starts or ends a gap; the gap is asked only when one of its days is usually busy.
    const start = run.findIndex((day) => !closedDay(day));
    const end = run.findLastIndex((day) => !closedDay(day));
    const first = run[start];
    const last = run[end];
    const typicals = run.flatMap((day) => {
      const typical = askedTypical(day);
      return typical === null ? [] : [Math.round(typical)];
    });
    if (first !== undefined && last !== undefined && typicals.length > 0) {
      const asked: AskedQuestion = { kind: 'gap', from: first, to: last };
      dayQuestions.push({
        id: questionId(asked), ...asked, dayCount: daysBetween(first, last) + 1,
        typicalGuestsLow: Math.min(...typicals), typicalGuestsHigh: Math.max(...typicals),
      });
    }
    run = [];
  };
  for (const day of dates) {
    if (!withSales.has(day) && (closedDay(day) || !explained(day))) {
      run.push(day);
      continue;
    }
    endRun();
    // A day with sales: likely closed by D32's own rule, with the rule schedules covering it (a schedule with more or
    // fewer guests says it was open), asked when it is usually busy and nothing explains it.
    const row = rows.get(day);
    const typical = askedTypical(day);
    if (row === undefined || row.guests === null || typical === null || explained(day)) continue;
    if (closureOf(row, typical, [], {
      rules: rules.filter((rule) => noteCovers(rule, day)), past: input.today === undefined || day < input.today,
    }) !== 'likely_closed') continue;
    const asked = { kind: 'likely_closed', date: day } as const;
    dayQuestions.push({ id: questionId(asked), ...asked, guests: row.guests, typicalGuests: Math.round(typical) });
  }
  endRun();
  dayQuestions.reverse();

  const asked = new Set(input.answered);
  return dayQuestions.filter((question) => !asked.has(question.id)).slice(0, MAX_QUESTIONS);
}
