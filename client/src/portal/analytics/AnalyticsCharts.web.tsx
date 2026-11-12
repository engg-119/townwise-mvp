import { theme } from '../../theme';
import { formatCount } from '../format';
import type { BarChartProps, EffectBarProps, LineChartProps } from './AnalyticsCharts';
import { MONTH_NAMES, metricNumber, type Metric } from './words';

// Analytics' charts on web (home.md 4.6, spec 15.6, D21), inline SVG with no chart library, as the Sales data
// chart is drawn: mint bars and lines, solid, 2px, square ends, on recessive `border` rules at 0, the middle and the
// top of the scale, each with its count up the side, and the scale printed with "Scale fitted to this location."
// Every SVG and count is aria-hidden: the section's summary, basis line and table carry
// the same numbers. With more than one year, the newest is mint and the others `line` grey, each labelled with its
// year at its end and in the key, so a year is never told by colour alone.

const C = theme.color;
const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;

/** A round top for the scale: 1, 2, 2.5 or 5 times a power of ten, at or above `max`. */
export function scaleTop(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((each) => each * power >= max) ?? 10;
  return step * power;
}

const NOUN: Readonly<Record<Metric, string>> = { guests: ' guests', netSales: '' };

function Scale(props: { top: number; metric: Metric }): React.JSX.Element {
  return (
    <p style={{ ...mono, margin: 0 }}>
      {`Scale 0 to ${metricNumber(props.top, props.metric)}${NOUN[props.metric]}. Scale fitted to this location.`}
    </p>
  );
}

/** Room at the left for the counts up the side, as the Sales data chart has. */
const GUTTER = 72;

/**
 * The top of the scale, its middle and 0. `scaleTop` makes the middle a round number, except under 2.5 times a
 * power of ten, where it is a half (12.5 guests): that middle is left out rather than printed rounded off its rule.
 */
function ticks(top: number, metric: Metric): number[] {
  const middle = top / 2;
  const whole = metric === 'guests' ? Number.isInteger(middle) : middle % 100 === 0;
  return whole ? [top, middle, 0] : [top, 0];
}

function rulesPath(values: readonly number[], y: (value: number) => number, width: number): string {
  return values.map((value) => `M0 ${String(y(value))} H${String(width)}`).join(' ');
}

/** Each tick's count, centred on its rule at the left of a `position: relative` box with a GUTTER margin. */
function Counts(props: { values: readonly number[]; metric: Metric; y: (value: number) => number }): React.JSX.Element {
  return (
    <>
      {props.values.map((value) => (
        <span
          key={value}
          data-count=""
          aria-hidden="true"
          style={{ ...mono, position: 'absolute', left: -GUTTER, width: GUTTER - 8, textAlign: 'right', top: props.y(value), transform: 'translateY(-50%)' }}
        >
          {metricNumber(value, props.metric)}
        </span>
      ))}
    </>
  );
}

function maxOf(values: readonly (number | null)[]): number {
  return values.reduce<number>((max, value) => (value !== null && value > max ? value : max), 0);
}

const HEIGHT = 160;

/** Vertical bars, one per label (weekdays, months). */
export function BarChart(props: BarChartProps): React.JSX.Element | null {
  const top = scaleTop(maxOf(props.bars.map((bar) => bar.value)));
  if (props.bars.every((bar) => bar.value === null)) return null;
  const n = props.bars.length;
  const width = 300;
  const slot = width / n;
  const bar = Math.min(28, slot * 0.6);
  const y = (value: number): number => HEIGHT - 0.5 - (value / top) * (HEIGHT - 1);
  const values = ticks(top, props.metric);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ position: 'relative', height: HEIGHT, marginLeft: GUTTER }}>
        <svg viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ width: '100%', height: HEIGHT, display: 'block' }}>
          <path d={rulesPath(values, y, width)} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {props.bars.map((each, index) => {
            if (each.value === null) return null;
            const h = (each.value / top) * (HEIGHT - 1);
            return <rect key={each.label} x={index * slot + (slot - bar) / 2} y={HEIGHT - h} width={bar} height={h} fill={C.mint} />;
          })}
        </svg>
        <Counts values={values} metric={props.metric} y={y} />
      </div>
      <div aria-hidden="true" style={{ ...mono, display: 'grid', gridTemplateColumns: `repeat(${String(n)}, minmax(0, 1fr))`, textAlign: 'center', marginLeft: GUTTER }}>
        {props.bars.map((each) => <span key={each.label} style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>{each.label}</span>)}
      </div>
      <Scale top={top} metric={props.metric} />
    </div>
  );
}

/** Horizontal bars with their labels at the left (types of night). */
export function HorizontalBars(props: BarChartProps): React.JSX.Element | null {
  const top = scaleTop(maxOf(props.bars.map((bar) => bar.value)));
  if (props.bars.every((bar) => bar.value === null)) return null;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 200px) minmax(0, 1fr)', columnGap: 12, rowGap: 6, alignItems: 'center' }}>
        {props.bars.map((each) => [
          <span key={`${each.label}-label`} style={{ ...mono, color: C.text2 }}>{each.label}</span>,
          <span key={`${each.label}-bar`} style={{ display: 'block', height: 12, borderLeft: `1px solid ${C.border}` }}>
            {each.value === null ? null : <span style={{ display: 'block', height: 12, width: `${String((each.value / top) * 100)}%`, background: C.mint }} />}
          </span>,
        ])}
      </div>
      <Scale top={top} metric={props.metric} />
    </div>
  );
}

/** Each year's label at its last point, nudged apart so two years that end close together never overlap. */
function endLabels(lines: LineChartProps['lines'], y: (value: number) => number): { year: number; month: number; top: number }[] {
  const labels = lines.flatMap((line) => {
    const last = [...line.points.entries()].reverse().find(([, point]) => point !== null);
    const point = last?.[1];
    return last === undefined || point === null || point === undefined ? [] : [{ year: line.year, month: last[0] + 1, top: y(point.value) }];
  }).sort((a, b) => a.top - b.top);
  for (let index = 1; index < labels.length; index += 1) {
    const above = labels[index - 1];
    const label = labels[index];
    if (above === undefined || label === undefined) continue;
    if (label.month === above.month && label.top - above.top < 14) label.top = above.top + 14;
  }
  return labels;
}

/** One line per year over its months: average per day; a month that is not complete is a hollow point. */
export function LineChart(props: LineChartProps): React.JSX.Element | null {
  const values = props.lines.flatMap((line) => line.points.map((point) => point?.value ?? null));
  if (values.every((value) => value === null)) return null;
  const top = scaleTop(maxOf(values));
  const width = 300;
  const inset = 6;
  const x = (month: number): number => inset + ((month - 1) / 11) * (width - 2 * inset);
  const y = (value: number): number => inset + (1 - value / top) * (HEIGHT - 2 * inset);
  const newest = Math.max(...props.lines.map((line) => line.year));
  const colour = (year: number): string => (year === newest ? C.mint : C.line);
  const ticked = ticks(top, props.metric);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div aria-hidden="true" style={{ ...mono, color: C.text2, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        {props.lines.map((line) => (
          <span key={line.year} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 16, borderTop: `2px solid ${colour(line.year)}` }} />{line.year}
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, boxSizing: 'border-box', border: `2px solid ${C.line}`, borderRadius: 4 }} />Month not complete
        </span>
      </div>
      <div style={{ position: 'relative', height: HEIGHT, marginLeft: GUTTER }}>
        <svg viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }}>
          <path d={rulesPath(ticked, y, width)} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {[...props.lines].sort((a, b) => a.year - b.year).map((line) => {
            const parts: string[] = [];
            let open = false;
            line.points.forEach((point, index) => {
              if (point === null) { open = false; return; }
              parts.push(`${open ? 'L' : 'M'}${x(index + 1).toFixed(2)} ${y(point.value).toFixed(2)}`);
              open = true;
            });
            return (
              <g key={line.year}>
                <path d={parts.join(' ')} fill="none" stroke={colour(line.year)} strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" vectorEffect="non-scaling-stroke" />
                {line.points.map((point, index) => {
                  if (point === null || point.complete) return null;
                  const d = `M${x(index + 1).toFixed(2)} ${y(point.value).toFixed(2)} h0.01`;
                  return (
                    <g key={index}>
                      <path d={d} stroke={colour(line.year)} strokeWidth={9} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                      <path d={d} stroke={C.ground} strokeWidth={5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
        {endLabels(props.lines, y).map((label) => (
          <span
            key={label.year}
            aria-hidden="true"
            style={{ ...mono, color: C.text2, position: 'absolute', left: `${String((x(label.month) / width) * 100)}%`, top: label.top, transform: 'translate(6px, -50%)' }}
          >
            {label.year}
          </span>
        ))}
        <Counts values={ticked} metric={props.metric} y={y} />
      </div>
      <div aria-hidden="true" style={{ ...mono, position: 'relative', height: 16, marginLeft: GUTTER }}>
        {MONTH_NAMES.map((name, index) => (
          <span key={name} style={{ position: 'absolute', left: `${String((x(index + 1) / width) * 100)}%`, transform: 'translateX(-50%)' }}>
            {name.slice(0, 1)}
          </span>
        ))}
      </div>
      <Scale top={top} metric={props.metric} />
    </div>
  );
}

/** A driver's effect from 50% fewer to 50% more, with the middle marked; beyond that it runs to the end. */
export function EffectBar(props: EffectBarProps): React.JSX.Element {
  const clamped = Math.max(-0.5, Math.min(0.5, props.effect));
  const width = `${formatCount(Math.abs(clamped) * 100)}%`;
  return (
    <span aria-hidden="true" style={{ position: 'relative', display: 'block', width: '100%', minWidth: 80, height: 10 }}>
      <span style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, borderLeft: `1px solid ${C.line}` }} />
      <span style={{ position: 'absolute', top: 0, height: 10, background: C.mint, width, ...(clamped >= 0 ? { left: '50%' } : { right: '50%' }) }} />
    </span>
  );
}
