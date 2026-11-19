import { addDays, daysBetween } from '../locations/dates';
import { CELL_GAP, weekDays, weekStartFor, type DateRange, type MonthBounds } from './grid';

// The week view's scroll (P28, D64), pure. The week view is a strip of day columns, 7 in view, that scrolls sideways
// and snaps to a day once the person stops: each day is a seventh of the view wide less its share of the 3px gaps, so
// a day's step (its width and the gap after it) is a seventh of the view plus a seventh of a gap, and the stops are
// the days' left edges. The page keeps the first day in view (`start`) and the days rendered (the strip): 5 weeks
// around the view at first, growing 3 weeks at an end each time a scroll stops within a week of it, inside the first
// and last 7-day blocks (from today) of the 25 months. When a scroll leaves the selected day out of view, the nearest
// day in view is selected. Every date is a 'YYYY-MM-DD' string moved in UTC (locations/dates.ts).

/** The days in view. */
export const VIEW_DAYS = 7;
/** How many days the strip grows by at an end. */
export const STRIP_GROW_DAYS = 21;
/** A fresh strip's days before the view, and after its last day. */
const AROUND_DAYS = 14;

/** A day's step: its width and the gap after it, so that 7 days and 6 gaps fill `viewport`. 0 while unmeasured. */
export function stripStep(viewport: number, gap: number = CELL_GAP): number {
  return viewport <= 0 ? 0 : (viewport + gap) / VIEW_DAYS;
}

/** The last stop's index: the strip's last 7 days in view. */
function lastStop(count: number): number {
  return Math.max(0, count - VIEW_DAYS);
}

/**
 * The stop a scroll settles on: the index of the day whose left edge is nearest `offset` (half a step rounds on), from
 * 0 to the last full view. 0 while the view is unmeasured.
 */
export function nearestDay(offset: number, step: number, count: number): number {
  if (step <= 0) return 0;
  return Math.min(lastStop(count), Math.max(0, Math.round(offset / step)));
}

/** Every stop's offset: each day's left edge, up to the last full view (native's snapToOffsets). */
export function snapOffsets(step: number, count: number): number[] {
  return Array.from({ length: lastStop(count) + 1 }, (_, index) => index * step);
}

/** The 7 days in view from `start`. */
export function viewDates(start: string): string[] {
  return weekDays(start);
}

/** The selected day when it is in view; else the nearest day in view: the first when the view moved past it, else the last. */
export function followSelection(selected: string, start: string): string {
  const last = addDays(start, VIEW_DAYS - 1);
  if (selected < start) return start;
  if (selected > last) return last;
  return selected;
}

/** The strip's widest days: the first day of the 25 months' first block, to the last day of their last block. */
export function stripLimits(bounds: MonthBounds, today: string): DateRange {
  return { from: weekStartFor(`${bounds.first}-01`, today), to: addDays(weekStartFor(bounds.lastDay, today), VIEW_DAYS - 1) };
}

function clampTo(range: DateRange, limits: DateRange): DateRange {
  return { from: range.from < limits.from ? limits.from : range.from, to: range.to > limits.to ? limits.to : range.to };
}

/**
 * The days rendered when the view starts on `start`. With no strip yet, or a view far outside it (a jump of more than
 * 3 weeks: PageUp, a link), 5 weeks: 2 before the view, the view and 2 after. A view that leaves the strip by less runs
 * the strip on to that fresh 5 weeks; a view inside it, within a week of an end, grows that end 3 weeks; otherwise
 * `current` itself, so a stop that changes nothing keeps it. Always inside stripLimits.
 */
export function stripFor(current: DateRange | null, start: string, bounds: MonthBounds, today: string): DateRange {
  const limits = stripLimits(bounds, today);
  const end = addDays(start, VIEW_DAYS - 1);
  const fresh = clampTo({ from: addDays(start, -AROUND_DAYS), to: addDays(end, AROUND_DAYS) }, limits);
  if (current === null) return fresh;
  let next: DateRange;
  if (start < current.from || end > current.to) {
    const gap = start > current.to ? daysBetween(current.to, start) : end < current.from ? daysBetween(end, current.from) : 0;
    if (gap > STRIP_GROW_DAYS) return fresh;
    next = { from: fresh.from < current.from ? fresh.from : current.from, to: fresh.to > current.to ? fresh.to : current.to };
  } else {
    next = {
      from: daysBetween(current.from, start) < VIEW_DAYS ? addDays(current.from, -STRIP_GROW_DAYS) : current.from,
      to: daysBetween(end, current.to) < VIEW_DAYS ? addDays(current.to, STRIP_GROW_DAYS) : current.to,
    };
  }
  const clamped = clampTo(next, limits);
  return clamped.from === current.from && clamped.to === current.to ? current : clamped;
}

/** The strip's dates, first to last. */
export function stripDates(strip: DateRange): string[] {
  return Array.from({ length: daysBetween(strip.from, strip.to) + 1 }, (_, index) => addDays(strip.from, index));
}

/**
 * Previous week and Next week: the view's first day 7 days back or on, from wherever a scroll left it, clamped to the
 * first and last blocks of the 25 months; null (the button disabled in place) when the view is already there.
 */
export function stepView(start: string, step: -1 | 1, bounds: MonthBounds, today: string): string | null {
  const limits = stripLimits(bounds, today);
  const lastStart = addDays(limits.to, -(VIEW_DAYS - 1));
  if (step < 0 ? start <= limits.from : start >= lastStart) return null;
  const target = addDays(start, VIEW_DAYS * step);
  return target < limits.from ? limits.from : target > lastStart ? lastStart : target;
}
