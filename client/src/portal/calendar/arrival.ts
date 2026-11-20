// Item 70 (D40, owner decision 2026-11-19): a day Home's This month opens in the Calendar. On web below 1024px the
// Calendar then brings its day panel into view, as a press on a grid day does. Held here for one arrival, not in the
// URL, so a reload or any other link at `?day=` still opens the page at its top.

let pending: { locationId: string; day: string } | null = null;

/** Home's This month, before it opens `day` in the Calendar. */
export function revealOnArrival(locationId: string, day: string): void {
  pending = { locationId, day };
}

/** Whether the Calendar opening on this location and `?day=` is that arrival. It reads, and never clears. */
export function isRevealArrival(locationId: string, day: string | undefined): boolean {
  return pending !== null && pending.locationId === locationId && pending.day === day;
}

/** The Calendar has opened: the arrival is used up, whether or not it scrolled. */
export function clearArrival(): void {
  pending = null;
}
