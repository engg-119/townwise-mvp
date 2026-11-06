// The heatmap's four fill levels (home.md 4.4, 5.3), from the quartiles of the included days' values: at or below
// the first quartile is level 1, the median level 2, the third quartile level 3, above it level 4. Quartiles are
// interpolated between the sorted values. With fewer than 4 distinct values there is no spread to show, so every
// day is level 3.

export type Level = 1 | 2 | 3 | 4;

function quantile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const lower = sorted[low] ?? 0;
  const upper = sorted[Math.min(low + 1, sorted.length - 1)] ?? lower;
  return lower + (upper - lower) * (at - low);
}

export function levelsFor(values: readonly number[]): (value: number) => Level {
  if (new Set(values).size < 4) return () => 3;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q2 = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  return (value) => {
    if (value <= q1) return 1;
    if (value <= q2) return 2;
    if (value <= q3) return 3;
    return 4;
  };
}
