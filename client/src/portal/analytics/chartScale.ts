// A chart's round scale, shared by the web charts (AnalyticsCharts.web.tsx re-exports it) and Home's week chart,
// which draws on native too, so it lives outside a .web file.

/** A round top for the scale: 1, 2, 2.5 or 5 times a power of ten, at or above `max`. */
export function scaleTop(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((each) => each * power >= max) ?? 10;
  return step * power;
}
