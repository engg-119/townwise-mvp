import { theme } from '../../theme';
import { formatCount } from '../format';
import type { BarChartProps, EffectBarProps, LineChartProps } from './AnalyticsCharts';
import type { ChartTip, TipBar } from './barTips';
import { scaleTop } from './chartScale';
import { nearestIndex, slotIndex } from './hoverMath';
import { ChartTooltip, useChartHover } from './ChartTooltip.web';
import { MONTH_NAMES, metricNumber, metricText, type Metric } from './words';

// Analytics' charts on web (home.md 4.6, spec 15.6, D21), inline SVG with no chart library, as the Sales data
// chart is drawn: mint bars and lines, solid, 2px, square ends, on recessive `border` rules at 0, the middle and the
// top of the scale, each with its count up the side, and the scale printed with "Scale fitted to this location."
// Every SVG and count is aria-hidden: the section's summary, basis line and table carry
// the same numbers. With more than one year, the newest is mint and solid and the others `line` gray, each with a dash
// pattern of its own (YEAR_DASHES) and labeled with its year at its end and in the key, so a year is never told by
// color alone. A mouse or pen over a vertical bar
// highlights it and shows its tooltip (ChartTooltip.web.tsx); a bar may bring its own words (TipBar). Over the year
// lines it marks the nearest month and shows each year's value there, newest first. The lines keep a gutter at the
// right (END_GUTTER) so December's year label stays inside the chart's box at any width.

const C = theme.color;
const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;

export { scaleTop };

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

/** Room at the right of the year lines for a year label at December: 6px out, then 4 mono digits (29px at 12px). */
const END_GUTTER = 40;

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

/** Each tick's count, centered on its rule at the left of a `position: relative` box with a GUTTER margin. */
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

/** Vertical bars, one per label (weekdays, months). Hovering a bar highlights it and shows its label and value. */
export function BarChart(props: BarChartProps): React.JSX.Element | null {
  const bars: readonly TipBar[] = props.bars;
  const top = scaleTop(maxOf(bars.map((bar) => bar.value)));
  const n = bars.length;
  const [hover, bind] = useChartHover((fraction) => {
    const index = slotIndex(fraction, n);
    return index === null || bars[index]?.value === null ? null : index;
  });
  if (bars.every((bar) => bar.value === null)) return null;
  const width = 300;
  const slot = width / n;
  const bar = Math.min(28, slot * 0.6);
  const y = (value: number): number => HEIGHT - 0.5 - (value / top) * (HEIGHT - 1);
  const values = ticks(top, props.metric);
  const hovered = hover.index === null ? undefined : bars[hover.index];
  const tip = hovered === undefined || hovered.value === null ? null
    : hovered.tip === undefined ? { title: hovered.label, lines: [metricText(hovered.value, props.metric)] } : hovered.tip;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ position: 'relative', height: HEIGHT, marginLeft: GUTTER }}>
        <svg {...bind} viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ width: '100%', height: HEIGHT, display: 'block' }}>
          <path d={rulesPath(values, y, width)} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {hover.index !== null && tip !== null ? <rect data-hover="bar" x={hover.index * slot} y={0} width={slot} height={HEIGHT} fill={C.white} fillOpacity={0.1} /> : null}
          {bars.map((each, index) => {
            if (each.value === null) return null;
            const h = (each.value / top) * (HEIGHT - 1);
            return <rect key={each.label} x={index * slot + (slot - bar) / 2} y={HEIGHT - h} width={bar} height={h} fill={C.mint} />;
          })}
        </svg>
        <Counts values={values} metric={props.metric} y={y} />
        {hover.index !== null && tip !== null ? <ChartTooltip tip={tip} from={(hover.index / n) * hover.width} to={((hover.index + 1) / n) * hover.width} alignRight={hover.index + 0.5 > n / 2} /> : null}
      </div>
      <div aria-hidden="true" style={{ ...mono, display: 'grid', gridTemplateColumns: `repeat(${String(n)}, minmax(0, 1fr))`, textAlign: 'center', marginLeft: GUTTER }}>
        {bars.map((each) => <span key={each.label} style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>{each.label}</span>)}
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

/**
 * The dash of each year older than the newest, newest first: dashed as the Town chart's Northeast line, then dotted,
 * then dash-dot, repeating. Drawn with butt ends, since square ends would close the gaps.
 */
export const YEAR_DASHES: readonly string[] = ['4 3', '2 3', '7 3 2 3'];

/** A year's color and dash: the newest mint and solid, each older one `line` gray with the next of YEAR_DASHES. */
export function yearStroke(year: number, years: readonly number[]): { color: string; dash: string | null } {
  const rank = [...years].sort((a, b) => b - a).indexOf(year);
  return rank <= 0 ? { color: C.mint, dash: null } : { color: C.line, dash: YEAR_DASHES[(rank - 1) % YEAR_DASHES.length] ?? null };
}

/** A key's 16px by 2px swatch of a year's line, its dashes drawn as a repeating gradient of the same lengths. */
function Swatch(props: { color: string; dash: string | null }): React.JSX.Element {
  let at = 0;
  const stops = (props.dash ?? '').split(' ').filter(Boolean).map((length, index) => {
    const from = at;
    at += Number(length);
    return `${index % 2 === 0 ? props.color : 'transparent'} ${String(from)}px ${String(at)}px`;
  });
  const background = props.dash === null ? props.color : `repeating-linear-gradient(to right, ${stops.join(', ')})`;
  return <span data-swatch="" style={{ display: 'inline-block', width: 16, height: 2, background }} />;
}

/**
 * One line per year over its months: average per day; a month that is not complete is a hollow point, and a complete
 * month with no month beside it a solid one.
 */
export function LineChart(props: LineChartProps): React.JSX.Element | null {
  const width = 300;
  const inset = 6;
  const [hover, bind] = useChartHover((fraction) => {
    const index = nearestIndex((fraction * width - inset) / (width - 2 * inset), 12);
    return index !== null && props.lines.some((line) => (line.points[index] ?? null) !== null) ? index : null;
  });
  const values = props.lines.flatMap((line) => line.points.map((point) => point?.value ?? null));
  if (values.every((value) => value === null)) return null;
  const top = scaleTop(maxOf(values));
  const x = (month: number): number => inset + ((month - 1) / 11) * (width - 2 * inset);
  const y = (value: number): number => inset + (1 - value / top) * (HEIGHT - 2 * inset);
  const years = props.lines.map((line) => line.year);
  const color = (year: number): string => yearStroke(year, years).color;
  const ticked = ticks(top, props.metric);
  const tip = hover.index === null ? null : monthTip(props.lines, hover.index, props.metric);
  const plot = { marginLeft: GUTTER, marginRight: END_GUTTER };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div aria-hidden="true" style={{ ...mono, color: C.text2, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        {props.lines.map((line) => (
          <span key={line.year} data-year={line.year} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Swatch {...yearStroke(line.year, years)} />{line.year}
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, boxSizing: 'border-box', border: `2px solid ${C.line}`, borderRadius: 4 }} />Month not complete
        </span>
      </div>
      <div style={{ position: 'relative', height: HEIGHT, ...plot }}>
        <svg {...bind} viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }}>
          <path d={rulesPath(ticked, y, width)} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {hover.index === null || tip === null ? null : (
            <path data-hover="month" d={`M${x(hover.index + 1).toFixed(2)} 0 V${String(HEIGHT)}`} stroke={C.line} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}
          {[...props.lines].sort((a, b) => a.year - b.year).map((line) => {
            const parts: string[] = [];
            let open = false;
            line.points.forEach((point, index) => {
              if (point === null) { open = false; return; }
              parts.push(`${open ? 'L' : 'M'}${x(index + 1).toFixed(2)} ${y(point.value).toFixed(2)}`);
              open = true;
            });
            const { dash } = yearStroke(line.year, years);
            return (
              <g key={line.year} data-year={line.year}>
                <path
                  d={parts.join(' ')}
                  fill="none"
                  stroke={color(line.year)}
                  strokeWidth={2}
                  strokeLinecap={dash === null ? 'square' : 'butt'}
                  strokeLinejoin="miter"
                  vectorEffect="non-scaling-stroke"
                  {...(dash === null ? {} : { strokeDasharray: dash })}
                />
                {line.points.map((point, index) => {
                  if (point === null) return null;
                  const d = `M${x(index + 1).toFixed(2)} ${y(point.value).toFixed(2)} h0.01`;
                  // A complete month with no month beside it has no line to sit on, so it is a dot of its own.
                  const lone = (line.points[index - 1] ?? null) === null && (line.points[index + 1] ?? null) === null;
                  if (point.complete) {
                    return lone ? <path key={index} data-lone="" d={d} stroke={color(line.year)} strokeWidth={6} strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null;
                  }
                  return (
                    <g key={index}>
                      <path d={d} stroke={color(line.year)} strokeWidth={9} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
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
        {hover.index !== null && tip !== null ? <ChartTooltip tip={tip} from={(x(hover.index + 1) / width) * hover.width} to={(x(hover.index + 1) / width) * hover.width} alignRight={hover.index >= 6} /> : null}
      </div>
      <div aria-hidden="true" style={{ ...mono, position: 'relative', height: 16, ...plot }}>
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

/** A month's tooltip on the year lines: the month, then each year with a value there, newest first. */
function monthTip(lines: LineChartProps['lines'], index: number, metric: Metric): ChartTip | null {
  const rows = [...lines].sort((a, b) => b.year - a.year).flatMap((line) => {
    const point = line.points[index] ?? null;
    return point === null ? [] : [`${String(line.year)}: ${metricText(point.value, metric)}${point.complete ? '' : ' (month not complete)'}`];
  });
  return rows.length === 0 ? null : { title: MONTH_NAMES[index] ?? '', lines: rows };
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
