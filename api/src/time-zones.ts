// A location's time zone and its local day (spec 13.2, docs/portal/estimates.md). TownwiseAI's "today" is the town's
// local date, so from 7 or 8 pm Eastern it is not already tomorrow. Locations have no time-zone field: the twelve
// researched towns are all Eastern, and another town gets its state's most populous zone, marked approximate where
// the state spans two zones. Pure; the time always comes from the caller (ctx.now).
import type { Town } from './towns.ts';

export interface TownTimeZone {
  /** An IANA zone name, such as 'America/New_York'. */
  readonly timeZone: string;
  /** True when the town's state spans more than one zone and the town may sit in the other. */
  readonly approximate: boolean;
}

const EASTERN = 'America/New_York';
const CENTRAL = 'America/Chicago';
const MOUNTAIN = 'America/Denver';
const PACIFIC = 'America/Los_Angeles';

/** Each state's (and DC's) most populous zone. */
const STATE_ZONES: Readonly<Record<string, string>> = {
  AL: CENTRAL, AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: CENTRAL, CA: PACIFIC, CO: MOUNTAIN, CT: EASTERN,
  DE: EASTERN, DC: EASTERN, FL: EASTERN, GA: EASTERN, HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: CENTRAL,
  IN: 'America/Indiana/Indianapolis', IA: CENTRAL, KS: CENTRAL, KY: EASTERN, LA: CENTRAL, ME: EASTERN, MD: EASTERN,
  MA: EASTERN, MI: 'America/Detroit', MN: CENTRAL, MS: CENTRAL, MO: CENTRAL, MT: MOUNTAIN, NE: CENTRAL, NV: PACIFIC,
  NH: EASTERN, NJ: EASTERN, NM: MOUNTAIN, NY: EASTERN, NC: EASTERN, ND: CENTRAL, OH: EASTERN, OK: CENTRAL, OR: PACIFIC,
  PA: EASTERN, RI: EASTERN, SC: EASTERN, SD: CENTRAL, TN: CENTRAL, TX: CENTRAL, UT: MOUNTAIN, VT: EASTERN, VA: EASTERN,
  WA: PACIFIC, WV: EASTERN, WI: CENTRAL, WY: MOUNTAIN,
};

/** States split between two zones. */
const SPLIT_STATES: ReadonlySet<string> = new Set(['AK', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'OR', 'SD', 'TN', 'TX']);

/** The twelve researched towns are Eastern, exactly; another town gets its state's zone. */
export function timeZoneOf(town: Town): TownTimeZone {
  if (town.townId !== null) return { timeZone: EASTERN, approximate: false };
  return { timeZone: STATE_ZONES[town.state] ?? EASTERN, approximate: SPLIT_STATES.has(town.state) };
}

/** The calendar day of `at` in `timeZone`, as YYYY-MM-DD. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Minutes since midnight of `at` in `timeZone`, 0 to 1439: the order board's "now" against an order-by time. */
export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: 'hour' | 'minute'): number => Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  return part('hour') * 60 + part('minute');
}

export type Weekday = 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';

const WEEKDAYS: readonly Weekday[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The weekday of a YYYY-MM-DD day. Every dated row TownwiseAI reads carries one, so it never counts weekdays itself. */
export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? 'Sun';
}
