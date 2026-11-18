import { theme } from '../../theme';
import { scaleTop } from '../analytics/AnalyticsCharts.web';
import { ChartTooltip, useChartHover } from '../analytics/ChartTooltip.web';
import { slotIndex } from '../analytics/hoverMath';
import { metricNumber, WEEKDAY_NAMES, weekdayOf } from '../analytics/words';
import type { LastWeekChartProps } from './LastWeekChart';

// Last week against the same week last year (home.md 2.4), inline SVG with no chart library, as Analytics draws:
// seven pairs, Monday to Sunday, last week a solid `mint` bar and last year an outlined `line` bar, so the two are
// told apart by shape as well as color, with the key and the scale printed. A day with a published forecast and no
// guests stored (D42) draws, in last week's place, the forecast style: a dashed `mint` outline to the run's middle with
// its 80% range as a `text2` whisker, keyed "Forecast", so it never reads as a sales bar. The key names only what is
// drawn. The SVG is aria-hidden: the card's summary and its table carry the same numbers. A day with no data draws no bar.
// A mouse or pen over a day's slot (never touch) lights the slot and shows the charts' shared tooltip with that day's
// row words, as Analytics' bars do; a click on a slot (any pointer) opens the day in the Calendar (owner request,
// 2026-11-17), as This month's days do.

const C = theme.color;
const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;
const HEIGHT = 120;
const WIDTH = 280;

export function LastWeekChart(props: LastWeekChartProps): React.JSX.Element | null {
  const count = props.days.length;
  const [hover, bind] = useChartHover((fraction) => slotIndex(fraction, count));
  const forecast = new Map(props.forecast.map((bar) => [bar.date, bar]));
  const values = [
    ...props.days.flatMap((day) => [day.value, day.lastYear]).filter((value): value is number => value !== null),
    ...props.forecast.map((bar) => bar.high),
  ];
  if (values.length === 0) return null;
  const top = scaleTop(Math.max(...values));
  const slot = WIDTH / 7;
  const bar = Math.min(12, slot * 0.3);
  const h = (value: number): number => (value / top) * (HEIGHT - 1);
  const noun = props.metric === 'guests' ? ' guests' : '';
  const tip = hover.index === null ? undefined : props.tips[hover.index];
  // From the click itself, not the hover, so a tap (which never hovers) opens its day too.
  function onClick(event: React.MouseEvent<SVGSVGElement>): void {
    const box = event.currentTarget.getBoundingClientRect();
    const index = box.width <= 0 ? null : slotIndex((event.clientX - box.left) / box.width, count);
    const day = index === null ? undefined : props.days[index];
    if (day !== undefined) props.onOpen(day.date);
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          {...bind}
          onClick={onClick}
          style={{ width: '100%', height: HEIGHT, display: 'block', cursor: 'pointer' }}
        >
          {hover.index !== null && tip !== undefined ? <rect data-hover="day" x={hover.index * slot} y={0} width={slot} height={HEIGHT} fill={C.white} fillOpacity={0.1} /> : null}
          <path d={`M0 0.5 H${String(WIDTH)} M0 ${String(HEIGHT - 0.5)} H${String(WIDTH)}`} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {props.days.map((day, index) => {
            const x = index * slot + slot / 2;
            const ahead = forecast.get(day.date);
            const mid = x - bar / 2 - 1;
            return (
              <g key={day.date}>
                {day.value === null ? null : <rect x={x - bar - 1} y={HEIGHT - h(day.value)} width={bar} height={h(day.value)} fill={C.mint} />}
                {day.value !== null || ahead === undefined ? null : (
                  <g data-series="forecast">
                    <rect
                      x={x - bar - 0.5}
                      y={HEIGHT - h(ahead.mid) + 0.5}
                      width={bar - 1}
                      height={Math.max(h(ahead.mid) - 1, 0)}
                      fill="none"
                      stroke={C.mint}
                      strokeWidth={1}
                      strokeDasharray="3 2"
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      d={`M${String(mid - 2)} ${String(HEIGHT - h(ahead.high))} h4 M${String(mid)} ${String(HEIGHT - h(ahead.high))} V${String(HEIGHT - h(ahead.low))} M${String(mid - 2)} ${String(HEIGHT - h(ahead.low))} h4`}
                      fill="none"
                      stroke={C.text2}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                )}
                {day.lastYear === null ? null : (
                  <rect
                    x={x + 1.5}
                    y={HEIGHT - h(day.lastYear) + 0.5}
                    width={bar - 1}
                    height={Math.max(h(day.lastYear) - 1, 0)}
                    fill="none"
                    stroke={C.line}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            );
          })}
        </svg>
        {hover.index !== null && tip !== undefined ? <ChartTooltip tip={tip} x={((hover.index + 0.5) / count) * hover.width} alignRight={hover.index + 0.5 > count / 2} /> : null}
      </div>
      <div aria-hidden="true" style={{ ...mono, display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', textAlign: 'center' }}>
        {props.days.map((day) => <span key={day.date}>{(WEEKDAY_NAMES[weekdayOf(day.date)] ?? '').slice(0, 3)}</span>)}
      </div>
      <p aria-hidden="true" style={{ ...mono, margin: 0, display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'center' }}>
        {props.days.some((day) => day.value !== null) ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, background: C.mint }} />Last week</span>
        ) : null}
        {props.days.some((day) => day.lastYear !== null) ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, boxSizing: 'border-box', border: `1px solid ${C.line}` }} />Same week last year</span>
        ) : null}
        {props.forecast.length > 0 ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, boxSizing: 'border-box', border: `1px dashed ${C.mint}` }} />Forecast</span>
        ) : null}
      </p>
      <p style={{ ...mono, margin: 0 }}>{`Scale 0 to ${metricNumber(top, props.metric)}${noun}. Scale fitted to this location.`}</p>
    </div>
  );
}
