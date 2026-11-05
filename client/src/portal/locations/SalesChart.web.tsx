import { theme } from '../../theme';
import { formatCount } from '../format';
import { chartGeometry, formatDollars, SERIES_TITLE } from './sales';
import type { SalesChartProps } from './SalesChart';

// The daily chart on Sales data (spec P12, D21), drawn on web only as inline SVG with no chart library: one mint,
// solid, 2px line over the last 365 days of data, the y scale fitted to this location and printed, and month
// ticks with their year. A day with no value is a gap. The SVG is aria-hidden: the text summary and “Show the
// numbers” beside it carry the same numbers. Coordinates round to 0.01 and are never printed.

const C = theme.color;
const HEIGHT = 196;
/** Room above and below the line inside the frame, so the extremes are not clipped. */
const INSET = 8;

export function SalesChart(props: SalesChartProps): React.JSX.Element | null {
  const geometry = chartGeometry(props.days, props.series, HEIGHT - 2 * INSET);
  if (geometry === null) return null;
  const tick = (value: number): string => (props.series === 'guests' ? formatCount(value) : formatDollars(value));
  const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;
  const top = INSET;
  const bottom = HEIGHT - INSET;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div aria-hidden="true" style={{ ...mono, color: C.text2, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 16, borderTop: `2px solid ${C.mint}` }} />{SERIES_TITLE[props.series]}
        </span>
      </div>
      <div style={{ position: 'relative', height: HEIGHT, marginLeft: 72 }}>
        <svg
          viewBox={`0 0 300 ${String(HEIGHT)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
        >
          <path d={`M0 ${String(top)} H300 M0 ${String(bottom)} H300`} fill="none" stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <g transform={`translate(0 ${String(INSET)})`}>
            <path d={geometry.path} fill="none" stroke={C.mint} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {geometry.dots.map((dot) => (
              <path key={`${String(dot.x)} ${String(dot.y)}`} d={`M${String(dot.x)} ${String(dot.y)} h0.01`} stroke={C.mint} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            ))}
          </g>
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
      </div>
      <div aria-hidden="true" style={{ ...mono, display: 'flex', justifyContent: 'space-between', gap: 8, marginLeft: 72 }}>
        {geometry.ticks.map((label, index) => <span key={`${label}-${String(index)}`}>{label}</span>)}
      </div>
      <p style={{ ...mono, margin: 0 }}>Scale fitted to this location.</p>
    </div>
  );
}
