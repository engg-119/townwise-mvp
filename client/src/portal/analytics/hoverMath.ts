// Where a pointer is on a chart, as pure arithmetic (shared by the chat's charts and Analytics' bars).

/** The index of the point nearest an x position given as a fraction (0 to 1) of the points' span, or null for none. */
export function nearestIndex(fraction: number, count: number): number | null {
  if (!Number.isFinite(fraction) || count < 1) return null;
  if (count === 1) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * (count - 1));
}

/** The index of the equal-width slot (a bar) an x fraction falls in, or null outside 0 to 1. */
export function slotIndex(fraction: number, count: number): number | null {
  if (!Number.isFinite(fraction) || count < 1 || fraction < 0 || fraction > 1) return null;
  return Math.min(count - 1, Math.floor(fraction * count));
}
