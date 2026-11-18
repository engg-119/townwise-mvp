import { ChartTooltip, useChartHover } from '../analytics/ChartTooltip.web';
import { nearestIndex } from '../analytics/hoverMath';
import { metricText, shortDate } from '../analytics/words';
import { theme } from '../../theme';
import { formatCount } from '../format';
import { chartDay, chartDayCount, chartGeometry, formatDollars, SERIES_TITLE } from './sales';
import type { SalesChartProps } from './SalesChart';

// The daily chart on Sales data (spec P12, D21), drawn on web only as inline SVG with no chart library: one mint,
// solid, 2px line over the last 365 days of data, the y scale fitted to this location and printed, and month
// ticks with their year. A day with no value is a gap. A mouse or pen over the plot (never a touch, as on every
// chart) marks the nearest calendar day with a 1px `line` rule and a mint dot on its value, and shows the charts'
// shared tooltip (ChartTooltip.web) with the day and "486 guests", the net sales in dollars, or "No data" with no
// dot. The SVG, its marks and the tooltip are aria-hidden: the text summary and “Show the numbers” beside it carry
// the same numbers. Coordinates round to 0.01 and are never printed.

const C = theme.color;
const HEIGHT = 196;
/** Room above and below the line inside the frame, so the extremes are not clipped. */
const INSET = 8;
const WIDTH = 300;

export function SalesChart(props: SalesChartProps): React.JSX.Element | null {
  const count = chartDayCount(props.days);
  const [hover, bind] = useChartHover((fraction) => nearestIndex(fraction, count));
  const geometry = chartGeometry(props.days, props.series, HEIGHT - 2 * INSET);
  if (geometry === null) return null;
  const tick = (value: number): string => (props.series === 'guests' ? formatCount(value) : formatDollars(value));
  const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;
  const top = INSET;
  const bottom = HEIGHT - INSET;
  const at = hover.index === null ? null : chartDay(props.days, props.series, HEIGHT - 2 * INSET, hover.index);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div aria-hidden="true" style={{ ...mono, color: C.text2, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 16, borderTop: `2px solid ${C.mint}` }} />{SERIES_TITLE[props.series]}
        </span>
      </div>
      <div style={{ position: 'relative', height: HEIGHT, marginLeft: 72 }}>
        <svg
          {...bind}
          data-chart="sales"
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
        >
          <path d={`M0 ${String(top)} H${String(WIDTH)} M0 ${String(bottom)} H${String(WIDTH)}`} fill="none" stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <g transform={`translate(0 ${String(INSET)})`}>
            <path d={geometry.path} fill="none" stroke={C.mint} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {geometry.dots.map((dot) => (
              <path key={`${String(dot.x)} ${String(dot.y)}`} d={`M${String(dot.x)} ${String(dot.y)} h0.01`} stroke={C.mint} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            ))}
          </g>
          {at === null ? null : (
            <g data-hover="day">
              <path d={`M${String(at.x)} ${String(top)} V${String(bottom)}`} fill="none" stroke={C.line} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              {at.y === null ? null : (
                <g data-hover="dot" transform={`translate(0 ${String(INSET)})`}>
                  <path d={`M${String(at.x)} ${String(at.y)} h0.01`} stroke={C.mint} strokeWidth={9} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                  <path d={`M${String(at.x)} ${String(at.y)} h0.01`} stroke={C.ground} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </g>
              )}
            </g>
          )}
        </svg>
        {[{ label: tick(geometry.max), y: top }, { label: tick(geometry.min), y: bottom }].map((mark) => (
          <span
            key={mark.label + String(mark.y)}
            aria-hidden="true"
            style={{ ...mono, position: 'absolute', left: -72, width: 64, textAlign: 'right', transform: 'translateY(-50%)', top: mark.y }}
          >
            {mark.label}
          </span>
        ))}
        {at === null ? null : (
          <ChartTooltip
            tip={{ title: shortDate(at.date), lines: [at.value === null ? 'No data' : metricText(at.value, props.series)] }}
            from={(at.x / WIDTH) * hover.width}
            to={(at.x / WIDTH) * hover.width}
            alignRight={at.x > WIDTH / 2}
          />
        )}
      </div>
      <div aria-hidden="true" style={{ ...mono, display: 'flex', justifyContent: 'space-between', gap: 8, marginLeft: 72 }}>
        {geometry.ticks.map((label, index) => <span key={`${label}-${String(index)}`}>{label}</span>)}
      </div>
      <p style={{ ...mono, margin: 0 }}>Scale fitted to this location.</p>
    </div>
  );
}
