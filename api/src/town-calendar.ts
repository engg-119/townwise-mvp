// The public town calendar (spec 13.1): US federal holidays computed from their legal rules, each town's key dates
// (town-profiles.ts) and the researched dated entries (town-calendar-data.ts). Pure: no I/O, and nothing is stored.
// The calendar route, TownwiseAI's tools and the term state all read this one calendar.
import { TOWN_CALENDAR } from './town-calendar-data.ts';
import { TOWN_PROFILES } from './town-profiles.ts';

export interface TownEventSource { readonly label: string; readonly url: string }

export interface TownEvent {
  /** Stable: 'us:thanksgiving:2026', 'hanover-nh:2026-11-17:fall-term-classes-end'. */
  readonly id: string;
  readonly title: string;
  /** Inclusive ISO days; a single day has end equal to start. */
  readonly start: string;
  readonly end: string;
  readonly kind: 'holiday' | 'event' | 'term' | 'season';
  /** national: a US federal holiday; observance: a widely kept day set by no law (Halloween, D68); town: researched. */
  readonly scope: 'national' | 'observance' | 'town';
  /** A recurring kind, for drivers ('us:thanksgiving', 'hanover-nh:classes:fall'); null for a one-off. */
  readonly group: string | null;
  readonly groupLabel: string | null;
  /** The research's rating of a dated entry; null for holidays (set by law) and key dates (not rated). */
  readonly confidence: 'high' | 'medium' | 'low' | null;
  /** At least one. */
  readonly sources: readonly TownEventSource[];
}

export interface DayRange { readonly from: string; readonly to: string }

const OPM: TownEventSource = {
  label: 'U.S. Office of Personnel Management',
  url: 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/',
};

/** First Juneteenth as a federal holiday (Pub. L. 117-17, June 17, 2021). */
const JUNETEENTH_FROM = 2021;

const MONDAY = 1;
const THURSDAY = 4;

function day(year: number, month: number, date: number): string {
  return new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10);
}

/** The nth `weekday` (0 is Sunday) of `month` (1 to 12). */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return day(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}

/** The last `weekday` of `month`. */
function lastWeekday(year: number, month: number, weekday: number): string {
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDate)).getUTCDay();
  return day(year, month, lastDate - ((last - weekday + 7) % 7));
}

type HolidayRow = [slug: string, title: string, groupLabel: string, date: string];

/**
 * The eleven US federal holidays of `year` (5 U.S.C. 6103, as OPM lists them), on the actual day rather than the
 * observed weekday, because restaurants feel the real day. Juneteenth from 2021. Valid for every year Townwise
 * accepts (2010 on).
 */
export function federalHolidays(year: number): TownEvent[] {
  const rows: HolidayRow[] = [
    ['new-years-day', 'New Year’s Day', 'New Year’s Day', day(year, 1, 1)],
    ['martin-luther-king-jr-day', 'Birthday of Martin Luther King, Jr.', 'Martin Luther King Jr. Day', nthWeekday(year, 1, MONDAY, 3)],
    ['washingtons-birthday', 'Washington’s Birthday', 'Washington’s Birthday', nthWeekday(year, 2, MONDAY, 3)],
    ['memorial-day', 'Memorial Day', 'Memorial Day', lastWeekday(year, 5, MONDAY)],
    ...(year >= JUNETEENTH_FROM ? [['juneteenth', 'Juneteenth National Independence Day', 'Juneteenth', day(year, 6, 19)] satisfies HolidayRow] : []),
    ['independence-day', 'Independence Day', 'Independence Day', day(year, 7, 4)],
    ['labor-day', 'Labor Day', 'Labor Day', nthWeekday(year, 9, MONDAY, 1)],
    ['columbus-day', 'Columbus Day', 'Columbus Day', nthWeekday(year, 10, MONDAY, 2)],
    ['veterans-day', 'Veterans Day', 'Veterans Day', day(year, 11, 11)],
    ['thanksgiving', 'Thanksgiving Day', 'Thanksgiving', nthWeekday(year, 11, THURSDAY, 4)],
    ['christmas', 'Christmas Day', 'Christmas', day(year, 12, 25)],
  ];
  return rows.map(([slug, title, groupLabel, date]) => ({
    id: `us:${slug}:${String(year)}`, title, start: date, end: date, kind: 'holiday', scope: 'national',
    group: `us:${slug}`, groupLabel, confidence: null, sources: [OPM],
  }));
}

// [CONFIRM: the Library of Congress's Halloween page as Halloween's source; no law sets the day (D68)]
const LOC_HALLOWEEN: TownEventSource = { label: 'Library of Congress', url: 'https://blogs.loc.gov/folklife/category/halloween/' };

const FRIDAY = 5;
const SATURDAY = 6;

/**
 * Halloween's nights of `year` (D68), the same as the forecasting lab's hol_halloween (modeling/lab/townwise_lab/
 * features.py halloween_weekend): Oct 31, the Friday from Oct 27 to Nov 2 and the Saturday after it. Oct 31 is
 * "Halloween", the others "Halloween weekend", all one group. Not sent to the lab (lab/input.ts), which has its own flag.
 */
export function halloween(year: number): TownEvent[] {
  const nights: string[] = [];
  for (let date = 27; date <= 34; date += 1) { // Oct 27 to Nov 3
    const at = new Date(Date.UTC(year, 9, date));
    const weekday = at.getUTCDay();
    const friday = weekday === SATURDAY ? date - 1 : date;
    const weekend = (weekday === FRIDAY || weekday === SATURDAY) && friday >= 27 && friday <= 33; // Friday Oct 27 to Nov 2
    if (weekend || date === 31) nights.push(at.toISOString().slice(0, 10));
  }
  return nights.map((night) => {
    const isEve = night.endsWith('-10-31');
    return {
      id: isEve ? `us:halloween:${String(year)}` : `us:halloween-weekend:${night}`, title: isEve ? 'Halloween' : 'Halloween weekend',
      start: night, end: night, kind: 'holiday', scope: 'observance', group: 'us:halloween', groupLabel: 'Halloween',
      confidence: null, sources: [LOC_HALLOWEEN],
    };
  });
}

function slug(text: string): string {
  return text.normalize('NFKD').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The hostname, without www., as the town profile's source links show it. */
function hostLabel(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

/** Every researched event of one town, all years, sorted. Key dates and calendar entries never share an id. */
function townOnly(townId: string): TownEvent[] {
  const keyDates: TownEvent[] = (TOWN_PROFILES.find((profile) => profile.townId === townId)?.dates ?? []).map((date) => ({
    id: `${townId}:${date.start}:${slug(date.text)}`, title: date.text, start: date.start, end: date.end ?? date.start,
    kind: 'event', scope: 'town', group: null, groupLabel: null, confidence: null,
    sources: date.sourceUrls.map((url) => ({ label: hostLabel(url), url })),
  }));
  const entries: TownEvent[] = TOWN_CALENDAR.filter((entry) => entry.townId === townId).map((entry) => ({
    id: `${townId}:${entry.start}:${slug(entry.title)}`, title: entry.title, start: entry.start, end: entry.end,
    kind: entry.kind, scope: 'town', group: entry.group, groupLabel: entry.groupLabel, confidence: entry.confidence,
    sources: entry.sources,
  }));
  return sortEvents([...keyDates, ...entries]);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortEvents(events: TownEvent[]): TownEvent[] {
  return events.sort((a, b) => compare(a.start, b.start) || compare(a.id, b.id));
}

/**
 * The town's researched events, the federal holidays and Halloween (D68) that overlap `range` (inclusive), sorted by
 * start, then id. A town outside the twelve (`null`) gets holidays only.
 */
export function townEvents(townId: string | null, range: DayRange): TownEvent[] {
  const overlaps = (event: TownEvent): boolean => event.start <= range.to && event.end >= range.from;
  const fromYear = Number(range.from.slice(0, 4));
  const toYear = Number(range.to.slice(0, 4));
  const holidays: TownEvent[] = [];
  for (let year = fromYear; year <= toYear; year += 1) holidays.push(...federalHolidays(year), ...halloween(year));
  const town = townId === null ? [] : townOnly(townId);
  return sortEvents([...holidays, ...town].filter(overlaps));
}

/** The span of the town's researched events over all years, or null when it has none (spec 13.1 `covers`). */
export function townCalendarCovers(townId: string | null): DayRange | null {
  if (townId === null) return null;
  const events = townOnly(townId);
  const [first] = events;
  if (first === undefined) return null;
  return { from: first.start, to: events.reduce((max, event) => (event.end > max ? event.end : max), first.end) };
}
