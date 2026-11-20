import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';

import { theme } from '../../theme';
import { Mono } from '../ui/text';

// The forecast plot (spec P11's This week chart, generalized for the Calendar by D64), on web and native alike
// (react-native-svg): one column a day. The published forecast's middle is a hollow `mint` point on a dashed `mint`
// line, its range (low to high, as the words give it) a `raised` band with 1px `line` edges, and an outlook day's range
// (D52) the same band lighter with dashed edges; a backtest day's (D72, the Calendar's past dates no run covers) is a
// hollow `text2` point on its own dotted `text2` line over the lighter band with dotted edges, so it never joins or
// passes for a forecast's, by color or pattern alone; a stored figure, the actual, is a solid `mint` point beside its
// forecast; the same weekday last year is a faint 1px `line` line with small dots. A day with no point leaves a gap in
// the lines. Home draws its 7 days with it (home/WeekChart.tsx), the Calendar its month above the grid
// (calendar/MonthChart.tsx) and each day of its week view as a slice (`from`, `to`): the viewBox shows only those
// columns, and the lines keep the neighbors' points, so a line runs on across a slice's edge (a slice is handed only its
// own day and its neighbors, calendar/chart.ts chartWindow, so a long week strip draws each day in constant time).
// `shaded` is today's column (`white` at 5%), `lit` the chosen or hovered one (`white` at 8% on Home, as before), and
// `chosen` the Calendar's selected day (`mint` at 16% with 1px `mint` edges, D64), so it never reads as today's shade
// and a hovered column beside it doesn't take its place. `words` stand upright in
// columns too narrow for words across (the month's); a column with a word draws no same-weekday-last-year point and
// the line breaks around it, so the faint line never runs through the word (D64; `wordedLastYear` keeps the key honest).
// A word in a column with a stored figure (a likely closed day's few guests) starts just above that point, never under it.
// The drawing is always aria-hidden: the surface that draws it says each day in words. `PlotKey` names only what is
// drawn.

const C = theme.color;
/** The plot's top and bottom inset, so a point at 0 or at the top is whole. */
const INSET = 12;

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface PlotPoint { low: number; mid: number; high: number }

/** One day of the plot: its forecast point, its stored figure and the same weekday last year, in one metric. */
export interface PlotDay {
  date: string;
  /** The forecast to draw: its middle and range. */
  point: PlotPoint | null;
  /** An outlook day (D52): its range drawn lighter with dashed edges. */
  outlook?: boolean;
  /** A backtest's figure (D72): its own dotted line and hollow `text2` point, its range lighter with dotted edges. */
  backtest?: boolean;
  /** The stored figure, drawn beside the forecast. */
  actual: number | null;
  lastYear: number | null;
}

/** Which series have at least one figure drawn, for the key. */
export interface PlotDrawn { forecast: boolean; actual: boolean; lastYear: boolean; outlook?: boolean; backtest?: boolean }

interface At { x: number; y: number }

/** One path through each run of two or more neighboring points; a lone point draws no line. */
export function linePath(points: readonly (At | null)[]): string {
  const parts: string[] = [];
  let run: At[] = [];
  const flush = (): void => {
    if (run.length > 1) parts.push(run.map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`).join(' '));
    run = [];
  };
  for (const point of points) {
    if (point === null) flush();
    else run.push(point);
  }
  flush();
  return parts.join(' ');
}

/** The range: one closed path per run of days with one, low edge forward and high edge back; a lone day a short box. */
export function bandPaths(points: readonly ({ x: number; low: number; high: number } | null)[], half: number): string[] {
  const bands: string[] = [];
  let run: { x: number; low: number; high: number }[] = [];
  const flush = (): void => {
    const only = run[0];
    if (run.length === 1 && only !== undefined) run = [{ ...only, x: r2(only.x - half) }, { ...only, x: r2(only.x + half) }];
    if (run.length > 1) {
      const forward = run.map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.low)}`);
      const back = [...run].reverse().map((point) => `L${String(point.x)} ${String(point.high)}`);
      bands.push(`${[...forward, ...back].join(' ')} Z`);
    }
    run = [];
  };
  for (const point of points) {
    if (point === null) flush();
    else run.push(point);
  }
  flush();
  return bands;
}

/** Whether a day's same weekday last year is drawn: never in a column whose status word stands in it. */
export function wordedLastYear(day: PlotDay, word: string | null | undefined): boolean {
  return day.lastYear !== null && (word ?? null) === null;
}

/**
 * Where a column's upright word starts, bottom up: at the plot's foot, or with a stored figure in the column just above
 * its point (radius 4.5, then 3px), so the point never covers a letter.
 */
export function wordFoot(actual: number | null, height: number, y: (value: number) => number): number {
  return actual === null ? height - INSET : Math.min(height - INSET, r2(y(actual) - 8));
}

/** A column's fill: today's shade or the lit column. */
function columnBox(index: number, slot: number, height: number): string {
  return `M${String(r2(index * slot))} 0 h${String(r2(slot))} V${String(height)} h${String(-r2(slot))} Z`;
}

/** The chosen column's box, half a pixel in, so its 1px edges are whole. */
function chosenBox(index: number, slot: number, height: number): string {
  const inner = r2(Math.max(0, slot - 1));
  return `M${String(r2(index * slot + 0.5))} 0.5 h${String(inner)} V${String(height - 0.5)} h${String(-inner)} Z`;
}

export function ForecastPlot(props: {
  days: readonly PlotDay[];
  /** The scale's round top. */
  top: number;
  /** The drawn columns' width in px, which the viewBox follows so points stay round. */
  width: number;
  height: number;
  /** The columns drawn, from `from` up to but not including `to`; every day by default. */
  from?: number;
  to?: number;
  /** The chosen or hovered column, lit. */
  lit?: number | null;
  /** Today's column, shaded. */
  shaded?: number | null;
  /** The Calendar's selected day's column, tinted `mint` with `mint` edges. */
  chosen?: number | null;
  /** Words standing upright in each column, bottom up (a status word in place of a point). */
  words?: readonly (string | null)[];
}): React.JSX.Element {
  const { days, width, height } = props;
  const from = props.from ?? 0;
  const to = props.to ?? days.length;
  const slot = width / Math.max(1, to - from);
  const x = (index: number): number => r2((index + 0.5) * slot);
  const y = (value: number): number => r2(INSET + (1 - value / props.top) * (height - 2 * INSET));
  // A slice keeps its neighbors' points, so its lines run on to its edges; the rest are left out.
  const near = (index: number): boolean => index >= from - 1 && index <= to;
  const beside = Math.min(9, slot * 0.2);
  const half = slot * 0.25;
  const bandOf = (day: PlotDay): 'range' | 'outlook' | 'backtest' => (day.backtest === true ? 'backtest' : day.outlook === true ? 'outlook' : 'range');
  const band = (kind: 'range' | 'outlook' | 'backtest'): string[] => bandPaths(days.map((day, index) => (
    day.point === null || !near(index) || bandOf(day) !== kind ? null : { x: x(index), low: y(day.point.low), high: y(day.point.high) }
  )), half);
  // A forecast's line and a backtest's never join.
  const middleOf = (backtest: boolean): string => linePath(days.map((day, index) => (
    day.point === null || !near(index) || (day.backtest === true) !== backtest ? null : { x: x(index), y: y(day.point.mid) }
  )));
  const middle = middleOf(false);
  const backtestMiddle = middleOf(true);
  const words = props.words ?? [];
  const lastYearAt = (index: number): number | null => {
    const day = days[index];
    return day === undefined || !wordedLastYear(day, words[index]) ? null : day.lastYear;
  };
  const lastYear = linePath(days.map((_, index) => {
    const value = lastYearAt(index);
    return value === null || !near(index) ? null : { x: x(index), y: y(value) };
  }));
  const drawn = (index: number): boolean => index >= from && index < to;
  const shaded = props.shaded ?? null;
  const lit = props.lit ?? null;
  const chosen = props.chosen ?? null;
  return (
    <Svg width="100%" height={height} viewBox={`${String(r2(from * slot))} 0 ${String(r2(width))} ${String(height)}`} preserveAspectRatio="none" aria-hidden>
      {shaded === null || !drawn(shaded) ? null : <Path data-shade="today" d={columnBox(shaded, slot, height)} fill={C.white} fillOpacity={0.05} />}
      {lit === null || !drawn(lit) ? null : <Path data-hover="day" d={columnBox(lit, slot, height)} fill={C.white} fillOpacity={0.08} />}
      {chosen === null || !drawn(chosen) ? null : (
        <Path data-chosen="day" d={chosenBox(chosen, slot, height)} fill={C.mint} fillOpacity={0.16} stroke={C.mint} strokeWidth={1} />
      )}
      <Path d={`M${String(r2(from * slot))} 0.5 h${String(r2(width))} M${String(r2(from * slot))} ${String(height - 0.5)} h${String(r2(width))}`} stroke={C.border} strokeWidth={1} />
      {band('range').map((d) => <Path key={d} data-series="range" d={d} fill={C.raised} stroke={C.line} strokeWidth={1} />)}
      {band('outlook').map((d) => <Path key={d} data-series="outlook-range" d={d} fill={C.raised} fillOpacity={0.5} stroke={C.line} strokeWidth={1} strokeDasharray="3 2" />)}
      {band('backtest').map((d) => <Path key={d} data-series="backtest-range" d={d} fill={C.raised} fillOpacity={0.5} stroke={C.line} strokeWidth={1} strokeDasharray="1 2" />)}
      {lastYear === '' ? null : <Path data-series="last-year" d={lastYear} fill="none" stroke={C.line} strokeOpacity={0.7} strokeWidth={1} />}
      {days.map((day, index) => {
        const value = lastYearAt(index);
        return value === null || !drawn(index) ? null : (
          <Circle key={day.date} data-series="last-year-point" cx={x(index)} cy={y(value)} r={2} fill={C.line} fillOpacity={0.7} />
        );
      })}
      {middle === '' ? null : <Path data-series="forecast" d={middle} fill="none" stroke={C.mint} strokeWidth={1.5} strokeDasharray="4 3" />}
      {days.map((day, index) => (day.point === null || day.backtest === true || !drawn(index) ? null : (
        <Circle key={day.date} data-series="forecast-point" cx={x(index)} cy={y(day.point.mid)} r={4} fill={C.panel} stroke={C.mint} strokeWidth={1.5} />
      )))}
      {backtestMiddle === '' ? null : <Path data-series="backtest" d={backtestMiddle} fill="none" stroke={C.text2} strokeWidth={1.5} strokeDasharray="1 3" />}
      {days.map((day, index) => (day.point === null || day.backtest !== true || !drawn(index) ? null : (
        <Circle key={day.date} data-series="backtest-point" cx={x(index)} cy={y(day.point.mid)} r={3.5} fill={C.panel} stroke={C.text2} strokeWidth={1.5} />
      )))}
      {days.map((day, index) => (day.actual === null || !drawn(index) ? null : (
        <Circle key={day.date} data-series="actual" cx={r2(x(index) + (day.point === null ? 0 : beside))} cy={y(day.actual)} r={4.5} fill={C.mint} />
      )))}
      {words.map((word, index) => {
        if (word === null || !drawn(index)) return null;
        const at = { x: r2(x(index) + 3), y: wordFoot(days[index]?.actual ?? null, height, y) };
        return (
          <SvgText
            key={days[index]?.date ?? String(index)}
            data-series="status"
            transform={`translate(${String(at.x)} ${String(at.y)}) rotate(-90)`}
            fill={C.text2}
            fontFamily={theme.font.mono}
            fontSize={9}
          >
            {word.toUpperCase()}
          </SvgText>
        );
      })}
    </Svg>
  );
}

type SwatchKind = 'forecast' | 'range' | 'outlook' | 'backtest' | 'backtestRange' | 'actual' | 'lastYear';

function Swatch(props: { kind: SwatchKind }): React.JSX.Element {
  return <View style={swatch[props.kind]} />;
}

/** The key, naming only what is drawn; aria-hidden, since the surface says each day in words. */
export function PlotKey(props: { drawn: PlotDrawn; actual: string; testID: string }): React.JSX.Element | null {
  const { drawn } = props;
  const items: { kind: SwatchKind; words: string }[] = [
    ...(drawn.forecast ? [{ kind: 'forecast' as const, words: 'Forecast' }, { kind: 'range' as const, words: 'Likely range' }] : []),
    ...(drawn.outlook === true ? [{ kind: 'outlook' as const, words: 'Outlook range' }] : []),
    ...(drawn.backtest === true ? [{ kind: 'backtest' as const, words: 'Backtest' }, { kind: 'backtestRange' as const, words: 'Backtest range' }] : []),
    ...(drawn.actual ? [{ kind: 'actual' as const, words: props.actual }] : []),
    ...(drawn.lastYear ? [{ kind: 'lastYear' as const, words: 'Same weekday last year' }] : []),
  ];
  if (items.length === 0) return null;
  return (
    <View testID={props.testID} aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.key}>
      {items.map((item) => (
        <View key={item.kind} style={styles.keyItem}><Swatch kind={item.kind} /><Mono tone="text3">{item.words}</Mono></View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  key: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4, alignItems: 'center' },
  keyItem: { flexDirection: 'row', alignItems: 'center', columnGap: 6 },
});

const swatch = StyleSheet.create({
  forecast: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: C.mint, backgroundColor: C.panel },
  range: { width: 12, height: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.raised },
  outlook: { width: 12, height: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: C.line },
  backtest: { width: 9, height: 9, borderRadius: 4.5, borderWidth: 1.5, borderColor: C.text2, backgroundColor: C.panel },
  backtestRange: { width: 12, height: 12, borderWidth: 1, borderStyle: 'dotted', borderColor: C.line },
  actual: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.mint },
  lastYear: { width: 16, height: 1, backgroundColor: C.line },
});
