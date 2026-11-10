import { scaleTop } from '../../portal/analytics/AnalyticsCharts.web';
import { metricNumber } from '../../portal/analytics/words';
import { SERIES_TITLE } from '../../portal/locations/sales';
import { theme } from '../../theme';
import type { DailyChartProps } from './DailyChart';
import { unitsOf } from './words';

// The daily chart of a visual on web (D21), inline SVG like Sales data's: one mint 2px line with gaps at days with
// no value, and the forecast's 80% range as a `raised` band with 1px `line` edges, only on days a published forecast
// covers. The y scale runs from 0 to a round top and is printed. The SVG is aria-hidden: the summary and
// "Show the numbers" carry the same numbers.

const C = theme.color;
const HEIGHT = 196;
const INSET = 8;
const WIDTH = 300;
const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function DailyChart(props: DailyChartProps): React.JSX.Element | null {
  const { visual } = props;
  const { metric, days } = visual;
  const top = scaleTop(Math.max(0, ...days.flatMap((day) => [day.value, day.high].flatMap((value) => (value === null ? [] : [unitsOf(value, metric)])))));
  if (!days.some((day) => day.value !== null)) return null;
  const span = Math.max(1, days.length - 1);
  const x = (index: number): number => r2((index / span) * WIDTH);
  const y = (value: number): number => r2(INSET + (1 - unitsOf(value, metric) / top) * (HEIGHT - 2 * INSET));

  // The line: a new segment after each gap; a lone day is a dot.
  const segments: string[] = [];
  const dots: string[] = [];
  let run: { x: number; y: number }[] = [];
  const flush = (): void => {
    const only = run[0];
    if (run.length === 1 && only !== undefined) dots.push(`M${String(only.x)} ${String(only.y)} h0.01`);
    if (run.length > 1) segments.push(run.map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`).join(' '));
    run = [];
  };
  days.forEach((day, index) => {
    if (day.value === null) flush();
    else run.push({ x: x(index), y: y(day.value) });
  });
  flush();

  // The band: one closed path per run of days with a range, low edge left to right, high edge back.
  const bands: string[] = [];
  let band: { x: number; low: number; high: number }[] = [];
  const closeBand = (): void => {
    const only = band[0];
    if (band.length === 1 && only !== undefined) band = [{ ...only, x: Math.max(0, only.x - 1.5) }, { ...only, x: Math.min(WIDTH, only.x + 1.5) }];
    if (band.length > 1) {
      const forward = band.map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.low)}`);
      const back = [...band].reverse().map((point) => `L${String(point.x)} ${String(point.high)}`);
      bands.push(`${[...forward, ...back].join(' ')} Z`);
    }
    band = [];
  };
  days.forEach((day, index) => {
    if (day.low === null || day.high === null) closeBand();
    else band.push({ x: x(index), low: y(day.low), high: y(day.high) });
  });
  closeBand();

  const tick = metricNumber(top, metric);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div aria-hidden="true" style={{ ...mono, color: C.text2, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 16, borderTop: `2px solid ${C.mint}` }} />{SERIES_TITLE[metric]}
        </span>
        {bands.length > 0 ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 12, height: 12, boxSizing: 'border-box', background: C.raised, border: `1px solid ${C.line}` }} />Forecast range
          </span>
        ) : null}
      </div>
      <svg
        data-chart="daily"
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        style={{ width: '100%', height: HEIGHT, display: 'block', overflow: 'visible' }}
      >
        <path d={`M0 ${String(INSET)} H${String(WIDTH)} M0 ${String(HEIGHT - INSET)} H${String(WIDTH)}`} fill="none" stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {bands.map((d) => (
          <path key={d} data-series="band" d={d} fill={C.raised} stroke={C.line} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <path data-series="line" d={segments.join(' ')} fill="none" stroke={C.mint} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {dots.map((d) => (
          <path key={d} d={d} stroke={C.mint} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <p style={{ ...mono, margin: 0 }}>{`Scale 0 to ${tick}${metric === 'guests' ? ' guests' : ''}. Scale fitted to this location.`}</p>
    </div>
  );
}
