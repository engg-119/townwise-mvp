// People in town for a range of days (spec 13.2): the term state, town events and holidays, the county's seasonal
// food-service jobs index, visitor counts where researched, and a headcount range only where every input to it has a
// source. Pure. Every number names the source ids it came from, and nothing else is added: no multipliers, no shares,
// no fitted constants. A missing input is a null with a reason, never a guess.
import { utcDay } from '../dates.ts';
import { weekdayOf, type Weekday } from '../time-zones.ts';
import type { TownEvent } from '../town-calendar.ts';
import { SOURCES as JOB_SOURCES, TOWN_DATA_YEAR, type TownProfileData } from '../town-profiles.ts';
import type { TownRecord } from '../towns.ts';
import type { YourHistory } from './history.ts';
import type { PeopleData, TownPeopleData } from './sources.ts';
import type { TermDay, TermState } from './term.ts';

export type HeadcountWhy = 'no_population' | 'visitors_unknown' | 'no_term_dates' | 'no_enrollment';

export interface Headcount { low: number; high: number; sourceIds: string[]; excludes: string[] }

export interface PeriodEvent { id: string; title: string; kind: 'event' | 'holiday'; attendanceHigh: number | null; sourceIds: string[] }

export interface PeoplePeriod {
  from: string; to: string; fromWeekday: Weekday; toWeekday: Weekday;
  termState: TermState;
  termLabel: string | null;
  /** The calendar entries the term state rests on. */
  termSourceIds: string[];
  headcount: Headcount | null;
  headcountWhy: HeadcountWhy | null;
  events: PeriodEvent[];
}

export interface SeasonMonth { month: string; countyFoodServiceJobsIndex: number; baseYear: number; county: string; sourceIds: string[] }
export interface VisitorMonth { month: string; label: string; perDayAverage: number; sourceIds: string[] }

/** confidence: the lowest rating of the entries citing it; null when none of them is rated (a town key date). */
export interface WindowSource { id: string; label: string; url: string; confidence: 'high' | 'medium' | 'low' | null }

export interface PeopleInTownWindow {
  /** False only for a town outside the twelve. */
  available: boolean;
  reason: 'town_not_researched' | null;
  from: string;
  to: string;
  town: { name: string; state: string; kind: TownRecord['kind'] | null };
  timeZone: string;
  /** Consecutive days with identical components, merged. */
  periods: PeoplePeriod[];
  season: SeasonMonth[];
  visitors: VisitorMonth[];
  yourHistory: YourHistory;
  /** Every id used above: researched ids as given, 'bls-qcew' for the jobs index, 'cal-{n}' for calendar sources. */
  sources: WindowSource[];
  /** Fixed sentences, chosen by which inputs were used. */
  caveats: string[];
}

export const CAVEATS = {
  county: 'County, not town: the jobs index covers the whole county.',
  employment: 'Employment is a stand-in for demand, not a count of people.',
  census: 'The census counts students where they live at school.',
  betweenTerms: 'Between terms, Townwise doesn’t know how many students who live off campus leave, so the range is wide.',
  attendance: 'Event attendance is an upper bound; many attendees already live in town.',
  visitors: 'Visits count a person each time they enter, so they aren’t people in town.',
} as const;

export const JOBS_SOURCE_ID = 'bls-qcew';

/** A window's longest range, both ends included. */
export const MAX_PEOPLE_RANGE_DAYS = 92;

export interface WindowInput {
  readonly town: { readonly name: string; readonly state: string };
  /** The town's record among the twelve; undefined for another town. */
  readonly record: TownRecord | undefined;
  readonly profile: TownProfileData | undefined;
  readonly data: PeopleData;
  readonly range: { readonly from: string; readonly to: string };
  readonly timeZone: string;
  /** The calendar over the range. */
  readonly events: readonly TownEvent[];
  readonly termOn: (date: string) => TermDay;
  readonly history: YourHistory;
}

type Rating = WindowSource['confidence'];
const RANK: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 };

function lower(a: Rating, b: Rating): Rating {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[a] <= RANK[b] ? a : b;
}

/** Hands out source ids in first-use order and keeps each source's lowest rating. */
function sourceBook(data: PeopleData) {
  const byId = new Map<string, WindowSource>();
  const calendarIds = new Map<string, string>();
  const add = (source: WindowSource): string => {
    const known = byId.get(source.id);
    byId.set(source.id, known === undefined ? source : { ...known, confidence: lower(known.confidence, source.confidence) });
    return source.id;
  };
  return {
    researched(id: string): string {
      const found = data.sources.find((source) => source.id === id);
      return found === undefined ? id : add({ id, label: found.label, url: found.url, confidence: found.confidence });
    },
    calendar(event: TownEvent): string[] {
      // Holidays are set by law; key dates carry no rating.
      const rating: Rating = event.kind === 'holiday' ? 'high' : event.confidence;
      return event.sources.map((source) => {
        const id = calendarIds.get(source.url) ?? `cal-${String(calendarIds.size + 1)}`;
        calendarIds.set(source.url, id);
        return add({ id, label: source.label, url: source.url, confidence: rating });
      });
    },
    jobs(): string {
      const [source] = JOB_SOURCES;
      return add({ id: JOBS_SOURCE_ID, label: source?.label ?? '', url: source?.url ?? '', confidence: 'high' });
    },
    all: (): WindowSource[] => [...byId.values()],
  };
}

type Book = ReturnType<typeof sourceBook>;

function roundDown(value: number): number {
  return Math.max(0, Math.floor(value / 100) * 100);
}

function roundUp(value: number): number {
  return Math.max(0, Math.ceil(value / 100) * 100);
}

interface DayHeadcount { headcount: Headcount | null; why: HeadcountWhy | null; caveats: string[] }

/** Spec 13.2's rules for one day. Only a college town with a researched population and known term dates gets one. */
function headcountOn(
  kind: TownRecord['kind'] | null, people: TownPeopleData | undefined, term: TermDay, events: readonly TownEvent[], book: Book,
): DayHeadcount {
  const none = (why: HeadcountWhy): DayHeadcount => ({ headcount: null, why, caveats: [] });
  if (kind === null) return none('no_population');
  if (kind !== 'college') return none('visitors_unknown');
  const residents = people?.residents ?? null;
  if (people === undefined || residents === null) return none('no_population');
  if (term.state === 'unknown') return none('no_term_dates');
  const ids = [book.researched(residents.sourceId)];
  const caveats: string[] = [CAVEATS.census];
  const moe = residents.moe90 ?? 0;
  if (residents.moe90 === null) caveats.push(`Residents are a single count from ${residents.vintage}, with no margin of error.`);
  let low = residents.value - moe;
  let high = residents.value + moe;
  if (term.state === 'between_terms' || term.state === 'summer_session') {
    const { enrollment, studentHousing, housingClosesBetweenTerms } = people;
    if (enrollment === null || (term.state === 'between_terms' && studentHousing === null)) return none('no_enrollment');
    low -= enrollment.value;
    ids.push(book.researched(enrollment.sourceId));
    if (term.state === 'between_terms') {
      caveats.push(CAVEATS.betweenTerms);
      if (housingClosesBetweenTerms !== null && studentHousing !== null) {
        high -= studentHousing.value;
        ids.push(book.researched(studentHousing.sourceId), book.researched(housingClosesBetweenTerms.sourceId));
      }
    }
  }
  const excludes: string[] = [];
  for (const event of events) {
    if (event.kind !== 'event') continue;
    const attendance = people.eventAttendance.find((row) => row.group === event.group);
    if (attendance === undefined) {
      excludes.push(`This range leaves out visitors for ${event.title}; Townwise has no attendance figure.`);
      continue;
    }
    // Attendees may already be in town, so only the high end moves.
    high += attendance.high;
    ids.push(book.researched(attendance.sourceId));
    caveats.push(CAVEATS.attendance);
  }
  return { headcount: { low: roundDown(low), high: roundUp(high), sourceIds: [...new Set(ids)], excludes }, why: null, caveats };
}

function nextDay(date: string): string {
  return utcDay(new Date(`${date}T00:00:00.000Z`), 1);
}

/** Every YYYY-MM the range touches, in order. */
function monthsOf(range: { from: string; to: string }): string[] {
  const months: string[] = [];
  for (let month = range.from.slice(0, 7); month <= range.to.slice(0, 7);) {
    months.push(month);
    const year = Number(month.slice(0, 4));
    const next = Number(month.slice(5, 7)) + 1;
    month = next > 12 ? `${String(year + 1)}-01` : `${String(year)}-${String(next).padStart(2, '0')}`;
  }
  return months;
}

function daysInMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

/** The window for `range` (at most 92 days; callers check). */
export function peopleInTownWindow(input: WindowInput): PeopleInTownWindow {
  const { record, profile, data, range } = input;
  const kind = record?.kind ?? null;
  const people = record === undefined ? undefined : data.towns.find((town) => town.townId === record.townId);
  const book = sourceBook(data);
  const caveats = new Set<string>();

  const periods: PeoplePeriod[] = [];
  let previousKey: string | null = null;
  for (let date = range.from; date <= range.to; date = nextDay(date)) {
    const term = input.termOn(date);
    const dayEvents = input.events.filter((event) => event.start <= date && date <= event.end);
    const count = headcountOn(kind, people, term, dayEvents, book);
    for (const caveat of count.caveats) caveats.add(caveat);
    // Term and season entries are context, not events (as the client's day classes treat them).
    const events = dayEvents.flatMap((event): PeriodEvent[] => {
      if (event.kind !== 'event' && event.kind !== 'holiday') return [];
      const attendance = people?.eventAttendance.find((row) => row.group === event.group);
      const sourceIds = book.calendar(event);
      if (attendance !== undefined) sourceIds.push(book.researched(attendance.sourceId));
      return [{ id: event.id, title: event.title, kind: event.kind, attendanceHigh: attendance?.high ?? null, sourceIds }];
    });
    const termSourceIds = [...new Set(term.events.flatMap((event) => book.calendar(event)))];
    const shape = {
      termState: term.state, termLabel: term.label, termSourceIds, headcount: count.headcount, headcountWhy: count.why, events,
    };
    const key = JSON.stringify(shape);
    const last = periods.at(-1);
    if (last !== undefined && key === previousKey) {
      last.to = date;
      last.toWeekday = weekdayOf(date);
    } else {
      periods.push({ from: date, to: date, fromWeekday: weekdayOf(date), toWeekday: weekdayOf(date), ...shape });
    }
    previousKey = key;
  }

  const season: SeasonMonth[] = profile === undefined ? [] : monthsOf(range).flatMap((month) => {
    const index = profile.series.index[Number(month.slice(5, 7)) - 1];
    return index === undefined ? [] : [{
      month, countyFoodServiceJobsIndex: index, baseYear: TOWN_DATA_YEAR, county: profile.county, sourceIds: [book.jobs()],
    }];
  });
  if (season.length > 0) {
    caveats.add(CAVEATS.county);
    caveats.add(CAVEATS.employment);
  }

  const visitorData = people?.visitors ?? null;
  const visitors: VisitorMonth[] = visitorData === null ? [] : monthsOf(range).flatMap((month) => {
    const row = visitorData.monthly.find((each) => each.month === month);
    return row === undefined ? [] : [{
      month, label: visitorData.label, perDayAverage: Math.round(row.value / daysInMonth(month)),
      sourceIds: [book.researched(visitorData.sourceId)],
    }];
  });
  if (visitors.length > 0) caveats.add(CAVEATS.visitors);

  return {
    available: record !== undefined,
    reason: record === undefined ? 'town_not_researched' : null,
    from: range.from,
    to: range.to,
    town: { name: input.town.name, state: input.town.state, kind },
    timeZone: input.timeZone,
    periods,
    season,
    visitors,
    yourHistory: input.history,
    sources: book.all(),
    caveats: [...caveats],
  };
}
