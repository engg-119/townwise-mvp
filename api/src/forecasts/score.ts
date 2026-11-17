// How published forecasts compared with what happened (spec 14.4): live accuracy over the days that have passed,
// misses included. A day counts when it was forecast open, has a stored guest count and is before today; booked days
// are left out (the booking rule: a private buyout has no walk-in forecast), and so are days that were closed or likely
// closed (spec D32: a closure, not a forecast miss). [CONFIRM: live accuracy leaves out closed and likely-closed days]
// The measure is the notebook's, WAPE: the sum of |actual - mid| over the sum of actuals. Under 5 scored days there is
// no figure. Pure.

/** Fewer scored days than this give no live accuracy. */
export const MIN_SCORED_DAYS = 5;

export interface ScoredDay {
  readonly date: string;
  readonly status: 'open' | 'closed' | 'booked';
  readonly low: number | null;
  readonly mid: number | null;
  readonly high: number | null;
  /** The day's stored guests, null when there is none. */
  readonly actual: number | null;
  /** The day was closed or likely closed (spec D32, closed-days.ts): left out of live accuracy. */
  readonly closed?: boolean;
}

export interface LiveAccuracy {
  /** Days scored. */
  days: number;
  /** Of those, days whose actual landed inside the range. */
  inRange: number;
  /** Percent, one decimal; null when the scored days had no guests at all. */
  typicalErrorPct: number | null;
  from: string;
  to: string;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Whether an actual landed in [low, high]; null when either side is missing. */
export function inRangeOf(actual: number | null, low: number | null, high: number | null): boolean | null {
  if (actual === null || low === null || high === null) return null;
  return actual >= low && actual <= high;
}

/** Whether live accuracy counts the day: forecast open with a middle and stored guests, and not closed or likely closed. */
export function scoredDay(day: ScoredDay): day is ScoredDay & { mid: number; actual: number } {
  return day.status === 'open' && day.closed !== true && day.mid !== null && day.actual !== null;
}

/**
 * Live accuracy over the given days (oldest first or not); null under 5 scored days. Over one run's days it is the
 * run's live accuracy; over a read's days, each from the run the reader chose for it, the window's (D42).
 */
export function liveAccuracy(days: readonly ScoredDay[]): LiveAccuracy | null {
  const scored = days.filter(scoredDay).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = scored[0];
  const last = scored.at(-1);
  if (scored.length < MIN_SCORED_DAYS || first === undefined || last === undefined) return null;
  const actual = scored.reduce((sum, day) => sum + day.actual, 0);
  const missed = scored.reduce((sum, day) => sum + Math.abs(day.actual - day.mid), 0);
  return {
    days: scored.length,
    inRange: scored.filter((day) => inRangeOf(day.actual, day.low, day.high) === true).length,
    typicalErrorPct: actual === 0 ? null : round1((100 * missed) / actual),
    from: first.date,
    to: last.date,
  };
}

/**
 * A week's actual: the sum of its days' guests, only when every day it forecast open has one and none is booked;
 * otherwise null (a part week is never compared with a whole week's range).
 */
export function weekActual(days: readonly ScoredDay[]): number | null {
  if (days.some((day) => day.status === 'booked')) return null;
  const open = days.filter((day) => day.status === 'open');
  if (open.length === 0 || open.some((day) => day.actual === null)) return null;
  return open.reduce((sum, day) => sum + (day.actual ?? 0), 0);
}
