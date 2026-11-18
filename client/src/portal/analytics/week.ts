import { guestsFromWords, yoursDid, type ForecastDay, type ForecastWindow, type LiveAccuracy } from '../estimates/api';
import { formatCount, formatDate, plural } from '../format';
import type { Note } from '../locations/api';
import { addDays, daysBetween, EARLIEST_DATE, monthRange } from '../locations/dates';
import { valueOf } from '../locations/sales';
import type { Calendar, TownEvent } from './api';
import { usual, type Usual } from './baseline';
import { rowOf } from './cells';
import { dayFlags, eventsOf, likelyClosedWords, notesOf, type DayContext } from './days';
import type { DayRecord } from './history';
import { plainOf, strong, type Phrase } from './phrase';
import { METRIC_NOUN, MONTH_NAMES, metricNumber, metricText, shortDate, signedPercent, WEEKDAY_NAMES, weekdayOf, type Metric } from './words';

// Home's numbers (home.md 2 and 5.6): this week against the same weeks in past years, last week against the same
// week last year, the late-week share for the bar order, and this month in past years. Every figure is a sum, an
// average or a share of the location's own stored days, and every one is of a past day: no function here returns a
// figure for a day after the last day of data or after today, and nothing here estimates. The one exception is the
// month grid's cells from today on, which show a published forecast day's own figures when Home passes the month's
// forecast read (spec 16.3 P11 and 14.5), as the API leaves them after the notes: nothing here adds a
// note's guests itself. Last week also carries the published forecast's own days for its seven days, with the read's
// `scored`, `inRange` and `accuracy` (D42, home-last-week): nothing here scores or adjusts a forecast figure, so
// every forecast figure Home shows is a published run's, never an unpublished guess. The one sum is weekForecast's
// (D43): This week's figures as its Forecast row shows them, added up. Daily ranges don't add, so its range is the
// run's own weekly 80% band from its backtest, applied to the estimated part of the total.
// "Last year" is the same weekday 52 weeks (364 days) earlier; "usual" is baseline.ts's, with every day allowed by
// the filters.

/** 52 weeks: the same weekday a year earlier. */
export const YEAR_DAYS = 364;
/** The fewest days of last year's week that Home sums or compares (home.md 2.2). */
export const SUMMARY_MIN_DAYS = 5;
/** Past years of this month that Home lists, newest first (home.md 2.5). */
export const MONTH_YEARS = 3;

const EVERY_DAY = (): boolean => true;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const LAST_YEAR_FOOTNOTE = 'Last year means the same weekday 52 weeks earlier. Usual is your average for that weekday in the 4 weeks either side, leaving out closed days, days with a note, and holiday and event days.';

export function mondayOf(date: string): string {
  return addDays(date, -rowOf(date));
}

/** Seven days from `start`, in order: Monday to Sunday from a Monday. */
export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function sameWeekdayYearsAgo(date: string, years: number): string {
  return addDays(date, -YEAR_DAYS * years);
}

/** "Nov 2", with no year. */
export function dayMonth(date: string): string {
  return `${SHORT_MONTHS[Number(date.slice(5, 7)) - 1] ?? ''} ${String(Number(date.slice(8, 10)))}`;
}

/** "Nov 11", "Nov 20 to 22", or "Oct 26 to Nov 17" across months. */
export function dayMonthRange(start: string, end: string): string {
  if (start === end) return dayMonth(start);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${dayMonth(start)} to ${String(Number(end.slice(8, 10)))}`;
  return `${dayMonth(start)} to ${dayMonth(end)}`;
}

/**
 * The calendar range Home asks for: from two years before this week's Monday (the late-week share reads
 * Monday weeks), less the 4 weeks either side that "usual" reads, to the later of this month's last day and This
 * week's last day, six days from today.
 */
export function homeCalendarRange(today: string): { from: string; to: string } {
  const back = addDays(mondayOf(today), -(2 * YEAR_DAYS + 28));
  const from = back < EARLIEST_DATE ? EARLIEST_DATE : back;
  const monthEnd = monthRange(today.slice(0, 7)).to;
  const last = addDays(today, 6);
  return { from, to: monthEnd > last ? monthEnd : last };
}

/** The days Home reads the forecast for: this month, and This week's seven days from today when they run past it. */
export function forecastRange(today: string): { from: string; to: string } {
  const month = monthRange(today.slice(0, 7));
  const last = addDays(today, 6);
  return { from: month.from, to: month.to > last ? month.to : last };
}

export interface HomeInput {
  today: string;
  byDate: ReadonlyMap<string, DayRecord>;
  context: DayContext;
  metric: Metric;
  /** The last stored day; null with no history. */
  lastDate: string | null;
  /** No day shows because every upload holding days is turned off (D28). */
  uploadsOff?: boolean;
}

/** A stored figure, only for a day that is past: on or before the last day of data and today. */
/**
 * A holiday or a town event marks its day. Term and season periods span weeks or months, so they are context
 * (days.ts, home.md 4.3): This week names them once, and no day cell, headline or month grid square repeats them.
 */
export function marksDay(event: Pick<TownEvent, 'kind'>): boolean {
  return event.kind === 'holiday' || event.kind === 'event';
}

function dayEventsOf(context: DayContext, date: string): TownEvent[] {
  return eventsOf(context, date).filter(marksDay);
}

function figureOf(date: string, input: HomeInput): number | null {
  if (input.lastDate === null || date > input.lastDate || date > input.today) return null;
  const day = input.byDate.get(date);
  return day === undefined ? null : valueOf(day, input.metric);
}

// This week

export interface PastDay {
  date: string;
  value: number | null;
  closed: boolean;
  /** Closed only because its guests were near zero for its weekday (spec D32). */
  likelyClosed: boolean;
  usual: Usual | null;
  /** The value against usual, as a fraction; null without both. */
  change: number | null;
  /** Titles of the holidays and town events on the calendar that day; term and season periods are left out. */
  events: string[];
}

export function pastDay(date: string, input: HomeInput): PastDay {
  const value = figureOf(date, input);
  const day = input.byDate.get(date);
  const found = value === null ? null : usual(date, input.metric, input.byDate, input.context, EVERY_DAY);
  const flags = dayFlags(date, day, input.context);
  return {
    date,
    value,
    closed: value !== null && flags.closed,
    likelyClosed: value !== null && flags.likelyClosed,
    usual: found,
    change: value === null || found === null || found.mean === 0 ? null : value / found.mean - 1,
    events: dayEventsOf(input.context, date).map((event) => event.title),
  };
}

export interface WeekRow {
  date: string;
  isToday: boolean;
  /** The day's holidays and town events; term and season periods are in ThisWeek.periods. */
  events: readonly TownEvent[];
  notes: readonly Note[];
  /** This week's own stored figure; null for any day after the last day of data. */
  value: number | null;
  /** The day's figure was so few guests for its weekday that it was likely closed (spec D32), as monthDay says. */
  likelyClosed: boolean;
  lastYear: PastDay;
  twoYearsAgo: PastDay;
}

export interface WeekSummary {
  /** Last year's same week, Monday and Sunday. */
  from: string;
  to: string;
  /** Days of that week with the metric, and their total. */
  days: number;
  total: number;
  /** The days' total against the sum of their usuals, over the days that have both. */
  vsUsual: { change: number; days: number } | null;
  busiest: string | null;
  quietest: string | null;
  /** Their figures, shown beside them (owner request, 2026-11-15). */
  busiestValue: number | null;
  quietestValue: number | null;
}

/** This week in {Town}: the seven days from today, today first (owner request, 2026-11-15). */
export interface ThisWeek {
  /** Today. */
  from: string;
  /** Six days from today. */
  to: string;
  rows: WeekRow[];
  /** Whether any of the seven days two years ago has data, so the column shows. */
  twoYears: boolean;
  /** Null when fewer than 5 of the same 7 days last year have data. */
  summary: WeekSummary | null;
  /** The first town event or holiday of the week, and how many others there are. */
  firstEvent: { title: string; date: string; more: number } | null;
  /** Term and season periods covering any day of the week, each once, in calendar order. */
  periods: TownEvent[];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function summaryOf(days: readonly PastDay[]): WeekSummary | null {
  const kept = days.filter((each): each is PastDay & { value: number } => each.value !== null);
  const first = days[0];
  const last = days.at(-1);
  if (kept.length < SUMMARY_MIN_DAYS || first === undefined || last === undefined) return null;
  const withUsual = kept.filter((each): each is PastDay & { value: number; usual: Usual } => each.usual !== null);
  const usualTotal = sum(withUsual.map((each) => each.usual.mean));
  const vsUsual = withUsual.length >= SUMMARY_MIN_DAYS && usualTotal > 0
    ? { change: sum(withUsual.map((each) => each.value)) / usualTotal - 1, days: withUsual.length }
    : null;
  const open = kept.filter((each) => !each.closed);
  const busiest = kept.reduce<(PastDay & { value: number }) | null>((best, each) => (best === null || each.value > best.value ? each : best), null);
  const quietest = open.reduce<(PastDay & { value: number }) | null>((best, each) => (best === null || each.value < best.value ? each : best), null);
  return {
    from: first.date, to: last.date, days: kept.length, total: sum(kept.map((each) => each.value)), vsUsual,
    busiest: busiest?.date ?? null, quietest: quietest?.date ?? null,
    busiestValue: busiest?.value ?? null, quietestValue: quietest?.value ?? null,
  };
}

export function thisWeek(input: HomeInput): ThisWeek {
  const dates = weekDates(input.today);
  const rows = dates.map((date): WeekRow => {
    const value = figureOf(date, input);
    return {
      date,
      isToday: date === input.today,
      events: dayEventsOf(input.context, date),
      notes: notesOf(input.context, date),
      value,
      likelyClosed: value !== null && dayFlags(date, input.byDate.get(date), input.context).likelyClosed,
      lastYear: pastDay(sameWeekdayYearsAgo(date, 1), input),
      twoYearsAgo: pastDay(sameWeekdayYearsAgo(date, 2), input),
    };
  });
  const seen = new Set<string>();
  const periods: TownEvent[] = [];
  for (const date of dates) {
    for (const event of eventsOf(input.context, date)) {
      if (marksDay(event) || seen.has(event.id)) continue;
      seen.add(event.id);
      periods.push(event);
    }
  }
  let firstEvent: ThisWeek['firstEvent'] = null;
  for (const row of rows) {
    for (const event of row.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (firstEvent === null) firstEvent = { title: event.title, date: row.date, more: 0 };
      else firstEvent.more += 1;
    }
  }
  return {
    from: input.today,
    to: addDays(input.today, 6),
    rows,
    twoYears: rows.some((row) => row.twoYearsAgo.value !== null),
    summary: summaryOf(rows.map((row) => row.lastYear)),
    firstEvent,
    periods,
  };
}

/** "Same 7 days last year, Thu, Nov 6 to Wed, Nov 12, 2025. From all 7 days." */
export function summaryLabel(summary: WeekSummary): string {
  const range = `${shortDate(summary.from).replace(/, \d{4}$/, '')} to ${shortDate(summary.to)}`;
  const days = summary.days === 7 ? 'From all 7 days.' : `From ${formatCount(summary.days)} of its 7 days.`;
  return `Same 7 days last year, ${range}. ${days}`;
}

/**
 * A day's published forecast in This week (owner request, 2026-11-15), as This month's grid reads it, the figure strong:
 * "About 90 guests, 68 to 112", "Closed", "Booked: a private buyout, 40 guests"; null when the run has no figure for it.
 */
export function forecastPhrase(day: ForecastDay | undefined): Phrase | null {
  if (day === undefined) return null;
  if (day.status === 'closed') return ['Closed'];
  if (day.status === 'booked') {
    if (!yoursDid(day, 'booked')) return ['Booked for a private event'];
    return day.noteGuests > 0 ? ['Booked: a private buyout, ', strong(plural(day.noteGuests, 'guest', 'guests'))] : ['Booked: a private buyout'];
  }
  if (day.low === null || day.mid === null || day.high === null) return null;
  const mid = Math.round(day.mid);
  // The range's low rounds down and its high up (spec 14.4), as the Calendar and TownwiseAI give it.
  return [strong(`About ${plural(mid, 'guest', 'guests')}`), `, ${formatCount(Math.floor(day.low))} to ${formatCount(Math.ceil(day.high))}`];
}

/** A day's guests as This week's Forecast row shows them: closed is 0, your buyout its party; null when it shows none. */
function forecastGuests(day: ForecastDay): number | null {
  if (day.status === 'closed') return 0;
  if (day.status === 'booked') return yoursDid(day, 'booked') && day.noteGuests > 0 ? day.noteGuests : null;
  // forecastPhrase's own check, so a day the row shows no figure for never counts.
  return day.low === null || day.mid === null || day.high === null ? null : Math.round(day.mid);
}

/** This week's published forecast, added up for At a glance's first tile (D43). */
export interface WeekForecast {
  from: string;
  to: string;
  /** The figures of the days that have one, added up as the Forecast row rounds them, so the row adds up to it. */
  total: number;
  /** The days with no figure in the Forecast row, left out of the total; at most 7 - SUMMARY_MIN_DAYS. */
  missing: string[];
  /**
   * The week's 80% range, only when all 7 days count and the run that gave today has a backtest band: the estimated
   * part (open days' figures less the guests notes and rules add) times the band, plus those guests and buyouts' parties,
   * which are exact. The low rounds down and the high up.
   */
  range: { low: number; high: number } | null;
  /** Null when today has no figure. */
  today: ForecastDay | null;
  /** `booked`: a buyout's party, an exact count, not an estimate. */
  busiest: { date: string; value: number; booked: boolean } | null;
  /** The quietest open day; closed and booked days are left out. */
  quietest: { date: string; value: number; booked: boolean } | null;
}

/**
 * The total of This week's published forecast (D43), or null, which keeps the tile on last year: with nothing
 * published, for a metric other than guests (forecasts are guests), and when fewer than 5 of the seven days have a
 * figure in the Forecast row (not covered, booked for a private event that isn't your buyout, or your buyout with no
 * party), the same 5 of 7 the last-year summary needs. With 5 or 6, the total says which days it leaves out.
 */
export function weekForecast(week: Pick<ThisWeek, 'from' | 'to' | 'rows'>, forecast: ForecastWindow | null, metric: Metric): WeekForecast | null {
  if (forecast === null || !forecast.available || metric !== 'guests') return null;
  const byDay = new Map(forecast.days.map((day) => [day.date, day]));
  const days: { date: string; value: number; open: boolean; booked: boolean; exact: number }[] = [];
  const missing: string[] = [];
  for (const row of week.rows) {
    const day = byDay.get(row.date);
    const value = day === undefined ? null : forecastGuests(day);
    if (day === undefined || value === null) {
      missing.push(row.date);
      continue;
    }
    // A buyout's party and the guests notes and rules add to an open day are fixed numbers, not estimates.
    const exact = day.status === 'booked' ? value : day.status === 'open' ? day.noteGuests : 0;
    days.push({ date: row.date, value, open: day.status === 'open', booked: day.status === 'booked', exact });
  }
  if (days.length < SUMMARY_MIN_DAYS) return null;
  const todayDay = byDay.get(week.from);
  const today = todayDay !== undefined && forecastGuests(todayDay) !== null ? todayDay : null;
  const total = sum(days.map((each) => each.value));
  const band = today === null ? null : forecast.runs.find((run) => run.id === today.runId)?.backtest?.weeklyRangePct ?? null;
  let range: WeekForecast['range'] = null;
  if (missing.length === 0 && band !== null) {
    const exact = sum(days.map((each) => each.exact));
    const estimated = Math.max(0, total - exact);
    range = { low: exact + Math.floor(estimated * (1 - band.below / 100)), high: exact + Math.ceil(estimated * (1 + band.above / 100)) };
  }
  const counted = days.filter((each) => each.value > 0);
  const busiest = counted.reduce<(typeof days)[number] | null>((best, each) => (best === null || each.value > best.value ? each : best), null);
  const quietest = days.filter((each) => each.open).reduce<(typeof days)[number] | null>((best, each) => (best === null || each.value < best.value ? each : best), null);
  return {
    from: week.from, to: week.to, total, missing, range, today,
    busiest: busiest === null ? null : { date: busiest.date, value: busiest.value, booked: busiest.booked },
    quietest: quietest === null || quietest.date === busiest?.date ? null : { date: quietest.date, value: quietest.value, booked: false },
  };
}

/**
 * "Tue, Nov 17 to Mon, Nov 23, 2026: the 7 days’ forecasts added up.", or with days left out "…: 6 of the 7 days’
 * forecasts added up. Sat, Nov 21 has no forecast figure." ("Sat, Nov 21 and Sun, Nov 22 have …").
 */
export function weekForecastLabel(found: Pick<WeekForecast, 'from' | 'to' | 'missing'>): string {
  const span = `${shortDate(found.from).replace(/, \d{4}$/, '')} to ${shortDate(found.to)}`;
  if (found.missing.length === 0) return `${span}: the 7 days’ forecasts added up.`;
  const days = found.missing.map((date) => shortDate(date).replace(/, \d{4}$/, ''));
  const named = days.length === 1 ? `${days[0] ?? ''} has` : `${days.slice(0, -1).join(', ')} and ${days.at(-1) ?? ''} have`;
  return `${span}: ${formatCount(7 - found.missing.length)} of the 7 days’ forecasts added up. ${named} no forecast figure.`;
}

/** "Likely 600 to 900 guests: 8 in 10 of this forecast’s backtest weeks landed in a range this wide.", the range strong. */
export function weekRangePhrase(range: { low: number; high: number }): Phrase {
  return ['Likely ', strong(`${formatCount(range.low)} to ${formatCount(range.high)} guests`), ': 8 in 10 of this forecast’s backtest weeks landed in a range this wide.'];
}

/** "Today: about 110 guests, 90 to 130.", "Today: closed.", "Today: a private buyout, 40 guests."; the figure strong. */
export function todayForecastPhrase(day: ForecastDay | null): Phrase {
  if (day === null) return ['Today: no forecast figure.'];
  if (day.status === 'closed') return ['Today: closed.'];
  if (day.status === 'booked') return ['Today: a private buyout, ', strong(plural(day.noteGuests, 'guest', 'guests')), '.'];
  // weekForecast only passes an open today with all three figures; the range's low rounds down and its high up
  // (spec 14.4), as forecastPhrase gives it.
  const { low, mid, high } = day;
  if (low === null || mid === null || high === null) return ['Today: no forecast.'];
  return ['Today: ', strong(`about ${plural(Math.round(mid), 'guest', 'guests')}`), `, ${formatCount(Math.floor(low))} to ${formatCount(Math.ceil(high))}.`];
}

/** "Busiest: Sat, Nov 21, 2026 (about 220 guests).", the figure strong; a buyout's party has no "about". */
export function forecastDayPhrase(which: 'Busiest' | 'Quietest', found: { date: string; value: number; booked: boolean }): Phrase {
  const guests = plural(found.value, 'guest', 'guests');
  return [`${which}: ${shortDate(found.date)} (`, strong(found.booked ? `a private buyout, ${guests}` : `about ${guests}`), ').'];
}

/** "Same 7 days last year: 757 guests, −19% against that year’s usual.", the total strong; "From 6 of its 7 days." when short. */
export function lastYearBesidePhrase(summary: WeekSummary, metric: Metric): Phrase {
  const usualPart = summary.vsUsual === null ? '.' : `, ${signedPercent(summary.vsUsual.change)} against that year’s usual.`;
  const short = summary.days === 7 ? '' : ` From ${formatCount(summary.days)} of its 7 days.`;
  return ['Same 7 days last year: ', strong(metricText(summary.total, metric)), `${usualPart}${short}`];
}

/** "Busiest last year: Sat, Nov 22, 2025 (253 guests).", the figure strong. */
export function lastYearDayPhrase(which: 'Busiest' | 'Quietest', date: string, value: number, metric: Metric): Phrase {
  return [`${which} last year: ${shortDate(date)} (`, strong(metricText(value, metric)), ').'];
}

/** "+9% against that year’s usual for those days, compared over 7 days.", the change strong. */
export function vsUsualPhrase(summary: WeekSummary): Phrase | null {
  if (summary.vsUsual === null) return null;
  return [strong(signedPercent(summary.vsUsual.change)), ` against that year’s usual for those days, compared over ${plural(summary.vsUsual.days, 'day', 'days')}.`];
}

export function vsUsualLine(summary: WeekSummary): string | null {
  const phrase = vsUsualPhrase(summary);
  return phrase === null ? null : plainOf(phrase);
}

function weekdayName(date: string): string {
  return WEEKDAY_NAMES[weekdayOf(date)] ?? '';
}

/** "On the calendar this week: Veterans Day (Wednesday), and 1 more." Term and season periods are periodLine's. */
export function calendarWeekLine(week: Pick<ThisWeek, 'firstEvent' | 'periods'>, calendar: Pick<Calendar, 'town' | 'researched' | 'covers'>): string {
  const first = week.firstEvent;
  if (first === null) {
    const researched = calendar.town.townId !== null && calendar.researched && calendar.covers !== null;
    if (week.periods.length > 0) {
      return researched ? `No holiday or town event on ${calendar.town.name}’s researched calendar this week.` : 'No holiday or town event this week.';
    }
    return researched ? `Nothing on ${calendar.town.name}’s researched calendar this week.` : 'Nothing on the calendar this week.';
  }
  const more = first.more === 0 ? '' : `, and ${formatCount(first.more)} more`;
  return `On the calendar this week: ${first.title} (${weekdayName(first.date)})${more}.`;
}

/** "Fall term classes. Term, Sep 14 to Nov 17, 2026." A period, with its whole span, said once for the week. */
export function periodLine(event: Pick<TownEvent, 'title' | 'kind' | 'start' | 'end'>): string {
  const span = event.start.slice(0, 4) === event.end.slice(0, 4)
    ? `${dayMonthRange(event.start, event.end)}, ${event.end.slice(0, 4)}`
    : `${formatDate(event.start)} to ${formatDate(event.end)}`;
  return `${event.title}. ${EVENT_WORDS[event.kind]}, ${span}.`;
}

/** What the town calendar covers (home.md 2.2), always under This week. */
export function calendarCoverageLine(calendar: Pick<Calendar, 'town' | 'researched' | 'covers'>): string {
  const { town, covers } = calendar;
  if (town.townId === null) return `Townwise hasn’t researched ${town.name}, ${town.state} yet. Only US federal holidays and your notes show here.`;
  if (!calendar.researched || covers === null) return `Townwise’s ${town.name} calendar has no researched town events yet. Only US federal holidays and your notes show here.`;
  return `${town.name}’s researched calendar covers ${formatDate(covers.from)} to ${formatDate(covers.to)} so far, plus US federal holidays.`;
}

/** "Sat, Nov 8, 2025: 241 guests". */
export function pastDayPhrase(day: PastDay, metric: Metric): Phrase | null {
  return day.value === null ? null : [`${shortDate(day.date)}: `, strong(metricText(day.value, metric))];
}

export function pastDayLine(day: PastDay, metric: Metric): string | null {
  const phrase = pastDayPhrase(day, metric);
  return phrase === null ? null : plainOf(phrase);
}

/** "+31% vs usual", the change strong. */
export function vsUsualDayPhrase(day: PastDay): Phrase | null {
  return day.change === null ? null : [strong(signedPercent(day.change)), ' vs usual'];
}

export function vsUsualDay(day: PastDay): string | null {
  const phrase = vsUsualDayPhrase(day);
  return phrase === null ? null : plainOf(phrase);
}

// Last week

export interface ComparedDay { date: string; value: number | null; lastYear: number | null }

/** One of last week's seven days with the published forecast read's day for it, if the read has one. */
export interface LastWeekDay extends ComparedDay {
  /** The read's own day, as the API sends it: its figures, `scored` and `inRange`. Null when no published run covers it. */
  forecast: ForecastDay | null;
  /** A published forecast and no stored guests: the row reads as the forecast, never as sales. */
  forecastOnly: boolean;
}

/** The published forecast's part of Last week (D42): only what the read gives, never a figure of Home's. */
export interface LastWeekForecast {
  /** The read's own accuracy over these days; null under 5 scored days. */
  accuracy: LiveAccuracy | null;
  /** Days the read scored, and of those the days it says landed in range; for the sentence when `accuracy` is null. */
  scored: number;
  inRange: number;
  /** The seven days, oldest first. */
  days: LastWeekDay[];
}

type LastWeekState =
  | { state: 'no_history' }
  /** Every upload holding days is turned off on Your data. */
  | { state: 'uploads_off' }
  /** The history ends before last week. */
  | { state: 'no_recent'; from: string; to: string; lastDate: string }
  /** Last week has no day with the metric, though the history reaches it: a gap, or days without this metric. */
  | { state: 'no_days'; from: string; to: string }
  | { state: 'no_last_year'; from: string; to: string; days: ComparedDay[] }
  | { state: 'no_overlap'; from: string; to: string; days: ComparedDay[] }
  | {
    state: 'compared'; from: string; to: string; days: ComparedDay[];
    /** Days with the metric in both weeks; the totals and the change are over these days only. */
    comparedDays: number; total: number; lastYearTotal: number; change: number | null;
  };

/**
 * Today's comparison of stored days, and, when the published forecast read covers any of the seven days, its part. The
 * totals and the change are over stored days only: nothing is summed over a forecast day.
 */
export type LastWeek = LastWeekState & { forecast?: LastWeekForecast };

/** The days Last week reads the published forecast for: the seven days before today. */
export function lastWeekRange(today: string): { from: string; to: string } {
  return { from: addDays(today, -7), to: addDays(today, -1) };
}

function comparedDays(input: HomeInput): ComparedDay[] {
  return weekDates(lastWeekRange(input.today).from).map((date) => ({
    date, value: figureOf(date, input), lastYear: figureOf(sameWeekdayYearsAgo(date, 1), input),
  }));
}

/**
 * The run's own day as the read gives it for a past day (14.5 rule 1, `model`): open with its middle and 80% range,
 * closed or booked; null when the run has no figure for it.
 */
function runDay(day: ForecastDay): { status: 'closed' | 'booked' } | { status: 'open'; low: number; mid: number; high: number } | null {
  const { model } = day;
  if (model.status !== 'open') return { status: model.status };
  if (model.low === null || model.mid === null || model.high === null) return null;
  return { status: 'open', low: model.low, mid: model.mid, high: model.high };
}

/** The forecast part, or null when the read failed, has nothing published, or covers none of the seven days. */
function lastWeekForecast(input: HomeInput, read: ForecastWindow | null): LastWeekForecast | null {
  // With every upload turned off the stored days are hidden, not missing: "no guest count uploaded" would be untrue.
  if (read === null || !read.available || input.uploadsOff === true) return null;
  const byDay = new Map(read.days.map((day): [string, ForecastDay] => [day.date, day]));
  const days = comparedDays(input).map((each): LastWeekDay => {
    const found = byDay.get(each.date);
    const forecast = found !== undefined && runDay(found) !== null ? found : null;
    const guests = input.byDate.get(each.date)?.guests ?? null;
    return { ...each, forecast, forecastOnly: forecast !== null && guests === null && each.value === null };
  });
  if (days.every((each) => each.forecast === null)) return null;
  const scored = days.filter((each) => each.forecast?.scored === true);
  return {
    accuracy: read.accuracy ?? null,
    scored: scored.length,
    inRange: scored.filter((each) => each.forecast?.inRange === true).length,
    days,
  };
}

/**
 * Last week: the seven days before today, This week's weekdays a week earlier (owner request, 2026-11-15), against the
 * days 364 days earlier; with `forecast`, Last week's own read of the published forecast (D42), its part beside them.
 * While that read loads, if it fails, or with nothing published, Last week is exactly the comparison.
 */
export function lastWeekComparison(input: HomeInput, forecast: ForecastWindow | null = null): LastWeek {
  const comparison = storedComparison(input);
  const part = lastWeekForecast(input, forecast);
  return part === null ? comparison : { ...comparison, forecast: part };
}

function storedComparison(input: HomeInput): LastWeekState {
  if (input.lastDate === null) return input.uploadsOff === true ? { state: 'uploads_off' } : { state: 'no_history' };
  const { from, to } = lastWeekRange(input.today);
  const days = comparedDays(input);
  if (days.every((each) => each.value === null)) {
    return input.lastDate < from ? { state: 'no_recent', from, to, lastDate: input.lastDate } : { state: 'no_days', from, to };
  }
  if (days.every((each) => each.lastYear === null)) return { state: 'no_last_year', from, to, days };
  const both = days.filter((each): each is ComparedDay & { value: number; lastYear: number } => each.value !== null && each.lastYear !== null);
  if (both.length === 0) return { state: 'no_overlap', from, to, days };
  const total = sum(both.map((each) => each.value));
  const lastYearTotal = sum(both.map((each) => each.lastYear));
  return {
    state: 'compared', from, to, days, comparedDays: both.length, total, lastYearTotal,
    change: lastYearTotal === 0 ? null : total / lastYearTotal - 1,
  };
}

/** "10% more than" with "10% more" strong, or "about the same as". */
function moreOrLess(change: number, metric: Metric): Phrase {
  const whole = Math.round(change * 100);
  if (whole === 0) return ['about the same as'];
  const word = whole > 0 ? 'more' : metric === 'guests' ? 'fewer' : 'less';
  return [strong(`${formatCount(Math.abs(whole))}% ${word}`), ' than'];
}

/** The card's text summary, in every state; when compared, last week's total and the change strong. */
export function lastWeekPhrase(comparison: LastWeek, metric: Metric): Phrase {
  switch (comparison.state) {
    case 'no_history': return ['No sales history yet, so there is nothing to compare.'];
    case 'uploads_off': return ['Every sales upload is turned off, so there is nothing to compare.'];
    case 'no_recent': return [`Your history ends ${formatDate(comparison.lastDate)}. Upload the days since to compare last week.`];
    case 'no_days': return [`No ${METRIC_NOUN[metric]} stored for last week, so there is nothing to compare yet.`];
    case 'no_last_year': return ['No data for the same week last year, so there is nothing to compare yet.'];
    case 'no_overlap': return ['Last week and the same week last year have no day with data in common, so there is nothing to compare yet.'];
    case 'compared': {
      const total = strong(metricText(comparison.total, metric));
      const before = metricNumber(comparison.lastYearTotal, metric);
      if (comparison.change === null) {
        return ['Last week: ', total, `, against ${before} on the same days last year, compared over ${plural(comparison.comparedDays, 'day', 'days')}.`];
      }
      const against = moreOrLess(comparison.change, metric);
      if (comparison.comparedDays === 7) {
        return ['Last week: ', total, ', ', ...against, ` the same week last year (${before}), compared over 7 days.`];
      }
      return ['Last week: ', total, ` on the ${formatCount(comparison.comparedDays)} days both weeks have, `, ...against, ` the same days last year (${before}).`];
    }
  }
}

export function lastWeekLine(comparison: LastWeek, metric: Metric): string {
  return plainOf(lastWeekPhrase(comparison, metric));
}

/** "12%": the read's typical error, whole. */
function wholePercent(value: number): string {
  return `${formatCount(Math.round(value))}%`;
}

/**
 * "Townwise’s forecast was off by 12% over 6 days. 5 of 6 days landed in its range." from the read's `accuracy`, or,
 * under 5 scored days, "2 of 3 days landed in Townwise’s range."; the percentage and counts strong. Null with no scored day.
 */
function forecastErrorPhrase(part: LastWeekForecast): Phrase | null {
  const { accuracy } = part;
  if (accuracy !== null && accuracy.typicalErrorPct !== null) {
    return [
      'Townwise’s forecast was off by ', strong(wholePercent(accuracy.typicalErrorPct)), ' over ', strong(plural(accuracy.days, 'day', 'days')), '. ',
      strong(`${formatCount(accuracy.inRange)} of ${plural(accuracy.days, 'day', 'days')}`), ' landed in its range.',
    ];
  }
  const days = accuracy?.days ?? part.scored;
  if (days === 0) return null;
  return [strong(`${formatCount(accuracy?.inRange ?? part.inRange)} of ${plural(days, 'day', 'days')}`), ' landed in Townwise’s range.'];
}

/** "these days" for all seven, "Sat, Nov 21" for one, "Sat and Sun" or "Thu, Fri and Sat" for a few. */
function whichDays(dates: readonly string[]): string {
  if (dates.length === 7) return 'these days';
  const [only] = dates;
  if (dates.length === 1 && only !== undefined) return shortDate(only).replace(/, \d{4}$/, '');
  const names = dates.map((date) => (WEEKDAY_NAMES[weekdayOf(date)] ?? '').slice(0, 3));
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function forecastOnlyDates(part: LastWeekForecast): string[] {
  return part.days.filter((each) => each.forecastOnly).map((each) => each.date);
}

/** Every one of the seven days is a published forecast with no stored guests. */
export function everyDayForecastOnly(comparison: LastWeek): boolean {
  return comparison.forecast?.days.every((each) => each.forecastOnly) === true;
}

/**
 * The card's sentences in order: the forecast's error (when a day is scored), "No guest count uploaded for … yet; this
 * is Townwise’s forecast." (when a day is forecast only), then today's sentence, which the second replaces when every
 * day is forecast only. Without a forecast part, today's sentence alone.
 */
export function lastWeekPhrases(comparison: LastWeek, metric: Metric): Phrase[] {
  const part = comparison.forecast;
  if (part === undefined) return [lastWeekPhrase(comparison, metric)];
  const error = forecastErrorPhrase(part);
  const only = forecastOnlyDates(part);
  return [
    ...(error === null ? [] : [error]),
    ...(only.length === 0 ? [] : [[`No guest count uploaded for ${whichDays(only)} yet; this is Townwise’s forecast.`]]),
    ...(everyDayForecastOnly(comparison) ? [] : [lastWeekPhrase(comparison, metric)]),
  ];
}

export function lastWeekLines(comparison: LastWeek, metric: Metric): string[] {
  return lastWeekPhrases(comparison, metric).map(plainOf);
}

/** "About 150, 120 to 180", "Closed" or "Booked": Show the numbers' Forecast cell, from the run's own day. */
export function lastWeekForecastCell(day: ForecastDay): string | null {
  const own = runDay(day);
  if (own === null) return null;
  if (own.status !== 'open') return own.status === 'closed' ? 'Closed' : 'Booked';
  // The range's low rounds down and its high up (spec 14.4), as the Calendar and TownwiseAI give it.
  return `About ${formatCount(Math.round(own.mid))}, ${formatCount(Math.floor(own.low))} to ${formatCount(Math.ceil(own.high))}`;
}

/**
 * "Forecast, no guest count uploaded yet: about 150 guests, 120 to 180" (or "…: closed", "…: booked"): a forecast-only
 * day's row and label, so it never reads like a sales figure.
 */
export function lastWeekForecastOnly(day: ForecastDay): string | null {
  const own = runDay(day);
  if (own === null) return null;
  const what = own.status !== 'open' ? own.status
    : `about ${plural(Math.round(own.mid), 'guest', 'guests')}, ${formatCount(Math.floor(own.low))} to ${formatCount(Math.ceil(own.high))}`;
  return `Forecast, no guest count uploaded yet: ${what}`;
}

// Bar order helper

/**
 * "Last year this week, Thursday to Sunday brought 58% of the week’s guests." Over last year's same week, the
 * share of the days with data that fell Thursday to Sunday. Null when any of Thursday to Sunday has no data.
 */
export function lateWeekShare(input: HomeInput): { share: number; days: number } | null {
  const dates = weekDates(sameWeekdayYearsAgo(mondayOf(input.today), 1));
  const values = dates.map((date) => figureOf(date, input));
  const late = values.slice(3);
  if (late.some((value) => value === null)) return null;
  const known = values.filter((value): value is number => value !== null);
  const total = sum(known);
  if (total <= 0) return null;
  return { share: sum(late.filter((value): value is number => value !== null)) / total, days: known.length };
}

/** "Last year this week, Thursday to Sunday brought 59% of the week’s guests.", the share strong. */
export function lateWeekPhrase(found: { share: number; days: number }, metric: Metric): Phrase {
  const share = `${formatCount(Math.round(found.share * 100))}%`;
  const days = found.days === 7 ? '' : ` (${formatCount(found.days)} days of that week have data)`;
  return ['Last year this week, Thursday to Sunday brought ', strong(share), ` of the week’s ${METRIC_NOUN[metric]}${days}.`];
}

export function lateWeekLine(found: { share: number; days: number }, metric: Metric): string {
  return plainOf(lateWeekPhrase(found, metric));
}

// This month

export interface MonthFact {
  year: number;
  /** Days of this month in that year with the metric, closed days left out, and their average. */
  days: number;
  /** Open days of that year with the metric, which its daily average is over: fewer than a year when history starts or ends in it. */
  yearDays: number;
  mean: number;
  /** That month's average against the year's daily average; null when the year's average is 0. */
  change: number | null;
}

/** This month in past years, newest first, at most 3: each from the location's own open days. */
export function monthFacts(input: HomeInput): MonthFact[] {
  const year = Number(input.today.slice(0, 4));
  const month = input.today.slice(5, 7);
  const byYear = new Map<number, { month: number[]; all: number[] }>();
  for (const [date, day] of input.byDate) {
    const y = Number(date.slice(0, 4));
    if (y >= year) continue;
    const value = figureOf(date, input);
    if (value === null || dayFlags(date, day, input.context).closed) continue;
    const entry = byYear.get(y) ?? { month: [], all: [] };
    entry.all.push(value);
    if (date.slice(5, 7) === month) entry.month.push(value);
    byYear.set(y, entry);
  }
  return [...byYear.entries()]
    .filter(([, entry]) => entry.month.length > 0)
    .sort(([a], [b]) => b - a)
    .slice(0, MONTH_YEARS)
    .map(([y, entry]) => {
      const mean = sum(entry.month) / entry.month.length;
      const yearMean = sum(entry.all) / entry.all.length;
      return { year: y, days: entry.month.length, yearDays: entry.all.length, mean, change: yearMean === 0 ? null : mean / yearMean - 1 };
    });
}

/** "118 guests a day over 30 days in 2025, 9% below your 2025 daily average over 364 days." */
/** "170 guests a day over 25 days in 2025, 16% above your 2025 daily average over 315 days.", the figure and change strong. */
export function monthFactPhrase(fact: MonthFact, metric: Metric): Phrase {
  const value = metric === 'guests' ? `${metricNumber(fact.mean, metric)} guests a day` : `${metricNumber(fact.mean, metric)} a day`;
  const head: Phrase = [strong(value), ` over ${plural(fact.days, 'day', 'days')} in ${String(fact.year)}`];
  if (fact.change === null) return [...head, '.'];
  const whole = Math.round(fact.change * 100);
  const average = `your ${String(fact.year)} daily average over ${plural(fact.yearDays, 'day', 'days')}`;
  if (whole === 0) return [...head, `, level with ${average}.`];
  return [...head, ', ', strong(`${formatCount(Math.abs(whole))}% ${whole > 0 ? 'above' : 'below'}`), ` ${average}.`];
}

export function monthFactLine(fact: MonthFact, metric: Metric): string {
  return plainOf(monthFactPhrase(fact, metric));
}

/** "Your November in past years". */
export function monthFactsHead(today: string): string {
  return `Your ${MONTH_NAMES[Number(today.slice(5, 7)) - 1] ?? ''} in past years`;
}

export interface MonthCell {
  date: string;
  /** A holiday or town event (term and season periods span months, so they mark no day). */
  event: boolean;
  note: boolean;
  inWeek: boolean;
  isToday: boolean;
  /**
   * Before today, the stored figure in the location's metric; from today on, a published forecast day's rounded
   * middle figure, or a buyout's party on a booked day. Null otherwise, and always without the month's figures.
   */
  figure: { value: number; kind: 'forecast' | 'actual' | 'booked'; text: string } | null;
  /** From today on, a day the published forecast has closed or booked; before today, a likely-closed day (closed). */
  status: 'closed' | 'booked' | null;
  /**
   * Before today, a day whose guests were near zero for its weekday (spec D32): status closed, and no figure. monthGrid
   * always sets it; optional so a cell built elsewhere (a test's) reads as not likely closed.
   */
  likelyClosed?: boolean;
  /** Guests the location's notes add to a forecast figure (“+70”); 0 when none. */
  noteGuests: number;
  /** What a screen reader hears for the cell: everything its number, figure and marks show, in words. */
  label: string;
}

/** The word a cell shows for its status: “Likely closed”, “Closed” or “Booked”; null for an open day. */
export function monthStatusWord(cell: Pick<MonthCell, 'status' | 'likelyClosed'>): string | null {
  if (cell.likelyClosed === true) return 'Likely closed';
  return cell.status === 'closed' ? 'Closed' : cell.status === 'booked' ? 'Booked' : null;
}

/** A likely-closed day's stored figure, for “Likely closed (1 guest recorded)”: “1 guest”, “3 guests” or “$12”. */
function recordedText(value: number, metric: Metric): string {
  return metric === 'guests' ? plural(value, 'guest', 'guests') : metricText(value, metric);
}

/** The figures Home's month grid shows: the location's history, and the month's published forecast days by date. */
export interface MonthFigures {
  input: HomeInput;
  forecast: ReadonlyMap<string, ForecastDay>;
}

interface CellFigure {
  figure: MonthCell['figure'];
  status: MonthCell['status'];
  likelyClosed: boolean;
  noteGuests: number;
  /** The figure in the cell's label. */
  words: string | null;
}

const NO_FIGURE: CellFigure = { figure: null, status: null, likelyClosed: false, noteGuests: 0, words: null };

/** A day's figure: stored before today (figureOf), the published forecast's own from today on. */
function cellFigure(date: string, figures: MonthFigures | undefined): CellFigure {
  if (figures === undefined) return NO_FIGURE;
  const { input } = figures;
  if (date < input.today) {
    const value = figureOf(date, input);
    if (value === null) return NO_FIGURE;
    if (dayFlags(date, input.byDate.get(date), input.context).likelyClosed) {
      return { ...NO_FIGURE, status: 'closed', likelyClosed: true, words: `${likelyClosedWords(recordedText(value, input.metric))}.` };
    }
    return { ...NO_FIGURE, figure: { value, kind: 'actual', text: metricNumber(value, input.metric) }, words: `${metricText(value, input.metric)}.` };
  }
  const day = figures.forecast.get(date);
  if (day === undefined) return NO_FIGURE;
  if (day.status === 'closed') return { ...NO_FIGURE, status: 'closed', words: 'Closed.' };
  if (day.status === 'booked') {
    const words = !yoursDid(day, 'booked') ? 'Booked for a private event.'
      : day.noteGuests > 0 ? `Booked: a private buyout, ${plural(day.noteGuests, 'guest', 'guests')}.` : 'Booked: a private buyout.';
    const figure = day.noteGuests > 0 ? { value: day.noteGuests, kind: 'booked' as const, text: formatCount(day.noteGuests) } : null;
    return { ...NO_FIGURE, status: 'booked', figure, words };
  }
  if (day.low === null || day.mid === null || day.high === null) return NO_FIGURE;
  const mid = Math.round(day.mid);
  const words = [
    // The range's low rounds down and its high up (spec 14.4), as the Calendar and TownwiseAI give it.
    `Forecast about ${plural(mid, 'guest', 'guests')}, ${formatCount(Math.floor(day.low))} to ${formatCount(Math.ceil(day.high))}.`,
    day.noteGuests > 0 ? `Includes ${plural(day.noteGuests, 'guest', 'guests')} from ${guestsFromWords(day)}.` : null,
  ].filter((part) => part !== null).join(' ');
  return { figure: { value: mid, kind: 'forecast', text: formatCount(mid) }, status: null, likelyClosed: false, noteGuests: day.noteGuests, words };
}

/** "Wed, Nov 11, 2026. Today. This week. Forecast about 212 guests, 180 to 240. Veterans Day. 1 note." */
function monthCellLabel(date: string, events: readonly TownEvent[], notes: number, inWeek: boolean, isToday: boolean, figure: string | null): string {
  return [
    `${shortDate(date)}.`,
    isToday ? 'Today.' : null,
    inWeek ? 'This week.' : null,
    figure,
    ...events.map((event) => `${event.title}.`),
    notes === 0 ? null : `${plural(notes, 'note', 'notes')}.`,
  ].filter((part) => part !== null).join(' ');
}

/**
 * This month as week rows, Monday first; null where a row's day is in another month. Without `figures` no cell has a
 * figure; with them, a day before today has its stored figure and a day from today on only the published forecast's.
 * "This week" marks This week in {Town}'s days: the seven from today.
 */
export function monthGrid(today: string, context: DayContext, figures?: MonthFigures): (MonthCell | null)[][] {
  const { from, to } = monthRange(today.slice(0, 7));
  const last = addDays(today, 6);
  const rows: (MonthCell | null)[][] = [];
  for (let start = mondayOf(from); start <= to; start = addDays(start, 7)) {
    rows.push(weekDates(start).map((date) => {
      if (date < from || date > to) return null;
      const events = dayEventsOf(context, date);
      const notes = notesOf(context, date).length;
      const inWeek = date >= today && date <= last;
      const isToday = date === today;
      const found = cellFigure(date, figures);
      return {
        date, event: events.length > 0, note: notes > 0, inWeek, isToday, figure: found.figure, status: found.status, likelyClosed: found.likelyClosed,
        noteGuests: found.noteGuests,
        label: monthCellLabel(date, events, notes, inWeek, isToday, found.words),
      };
    }));
  }
  return rows;
}

/**
 * The month grid's keys (rows are weeks, Monday first): Left and Right move a day, Up and Down a week, Home and End
 * the row's Monday and Sunday, Ctrl+Home and Ctrl+End the month's first and last day. Every move stays in `date`'s
 * month; a key that would leave it keeps the day where it is. Null for any other key.
 */
export function monthMove(date: string, key: string, ctrl: boolean): string | null {
  const { from, to } = monthRange(date.slice(0, 7));
  const clamp = (next: string): string => (next < from ? from : next > to ? to : next);
  const step = (days: number): string => {
    const next = addDays(date, days);
    return next < from || next > to ? date : next;
  };
  switch (key) {
    case 'ArrowLeft': return step(-1);
    case 'ArrowRight': return step(1);
    case 'ArrowUp': return step(-7);
    case 'ArrowDown': return step(7);
    case 'Home': return ctrl ? from : clamp(mondayOf(date));
    case 'End': return ctrl ? to : clamp(addDays(mondayOf(date), 6));
    default: return null;
  }
}

/** Everything Home's month card shows for one day of the month (the day detail beside the grid). */
export interface MonthDay {
  date: string;
  isToday: boolean;
  /** After today: no figure of its own, ever. */
  future: boolean;
  /** Holidays and town events on the day; term and season periods are in the month's list. */
  events: readonly TownEvent[];
  notes: readonly Note[];
  /** The day's own stored figure; null for a day after the last day of data or after today. */
  value: number | null;
  /** The day's figure was so few guests for its weekday that it was likely closed (spec D32). */
  likelyClosed: boolean;
  lastYear: PastDay;
  twoYearsAgo: PastDay;
}

export function monthDay(date: string, input: HomeInput): MonthDay {
  const value = figureOf(date, input);
  return {
    date,
    isToday: date === input.today,
    future: date > input.today,
    events: dayEventsOf(input.context, date),
    notes: notesOf(input.context, date),
    value,
    likelyClosed: value !== null && dayFlags(date, input.byDate.get(date), input.context).likelyClosed,
    lastYear: pastDay(sameWeekdayYearsAgo(date, 1), input),
    twoYearsAgo: pastDay(sameWeekdayYearsAgo(date, 2), input),
  };
}

/** The day detail's “This day” and This week's own day: “241 guests”, “Likely closed (1 guest recorded)”, or that nothing is stored. */
/** A day's own figure, strong, or what stands in for it. */
export function thisDayPhrase(day: Pick<MonthDay, 'value' | 'likelyClosed'>, metric: Metric): Phrase {
  if (day.value === null) return ['No sales stored for this day.'];
  return day.likelyClosed ? [likelyClosedWords(recordedText(day.value, metric))] : [strong(metricText(day.value, metric))];
}

export function thisDayLine(day: Pick<MonthDay, 'value' | 'likelyClosed'>, metric: Metric): string {
  return plainOf(thisDayPhrase(day, metric));
}

/** The next holiday or town event on the calendar, from today to the end of what Home reads. */
export interface NextEvent {
  event: TownEvent;
  /** The first day from today that it covers. */
  date: string;
  /** Days from today to `date`: 0 when it is on today. */
  days: number;
}

export function nextEvent(today: string, context: DayContext): NextEvent | null {
  const { to } = homeCalendarRange(today);
  for (let date = today; date <= to; date = addDays(date, 1)) {
    const [event] = dayEventsOf(context, date);
    if (event !== undefined) return { event, date, days: daysBetween(today, date) };
  }
  return null;
}

/** "Today", "Tomorrow", "Sat, Nov 7, 2026, in 2 days". */
export function nextEventWhen(next: NextEvent): string {
  if (next.days === 0) return next.event.start < next.date ? `On now, until ${shortDate(next.event.end)}` : 'Today';
  if (next.days === 1) return `Tomorrow, ${shortDate(next.date)}`;
  return `${shortDate(next.date)}, in ${plural(next.days, 'day', 'days')}`;
}

export type MonthItem =
  | { kind: 'event'; key: string; first: string; dates: string; event: TownEvent }
  | { kind: 'note'; key: string; first: string; dates: string; note: Note };

/** Every event and note on the calendar this month, by the first day of the month each covers. */
export function monthItems(today: string, context: DayContext): MonthItem[] {
  const { from, to } = monthRange(today.slice(0, 7));
  const items = new Map<string, MonthItem>();
  for (let date = from; date <= to; date = addDays(date, 1)) {
    for (const event of eventsOf(context, date)) {
      const key = `event:${event.id}`;
      if (!items.has(key)) items.set(key, { kind: 'event', key, first: date, dates: dayMonthRange(event.start, event.end), event });
    }
    for (const note of notesOf(context, date)) {
      const key = `note:${note.id}`;
      if (!items.has(key)) items.set(key, { kind: 'note', key, first: date, dates: dayMonthRange(note.startDate, note.endDate), note });
    }
  }
  return [...items.values()].sort((a, b) => a.first.localeCompare(b.first));
}

export const EVENT_WORDS: Readonly<Record<TownEvent['kind'], string>> = { holiday: 'Holiday', event: 'Town event', term: 'Term', season: 'Season' };

/** "Veterans Day. Federal holiday." */
export function eventLine(event: Pick<TownEvent, 'title' | 'kind' | 'scope'>): string {
  const kind = event.kind === 'holiday' && event.scope === 'national' ? 'Federal holiday' : EVENT_WORDS[event.kind];
  return `${event.title}. ${kind}.`;
}

/** The lead under the title (home.md 2.1). */
export function leadLine(
  lastDate: string | null, calendar: Pick<Calendar, 'town' | 'researched' | 'covers'>, uploadsOff = false,
): string {
  const researched = calendar.town.townId !== null && calendar.researched && calendar.covers !== null;
  const source = researched ? `${calendar.town.name}’s researched calendar` : 'US federal holidays';
  if (lastDate === null && uploadsOff) return `Every sales upload is turned off. Home shows ${source} and your notes.`;
  if (lastDate === null) return `No sales history yet. Home shows ${source} and your notes.`;
  return `From your sales through ${shortDate(lastDate)} and ${source}.`;
}
