import { Link } from 'expo-router';
import { useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { theme } from '../../theme';
import { dayMonth, thisDayPhrase } from '../analytics/week';
import { metricNumber, shortDate, WEEKDAY_NAMES, weekdayOf, type Metric } from '../analytics/words';
import { dayView, FIGURE_KEY, type CalendarInput } from '../calendar/model';
import { useBreakpoint } from '../hooks';
import { calendarHref } from '../routing';
import { webAria } from '../ui/aria';
import { PhraseParts } from '../ui/PhraseParts';
import { Heading, Mono, Small } from '../ui/text';
import { CalendarPart, forecastDayLines, forecastPartLabel, Part, WHY_LINES, WhyPart, whyRows } from './DayDetail';
import { PastCell } from './PastCell';
import type { ChartDay, WeekChart as Model } from './weekChartData';

// This week's chart (spec P11, owner request 2026-11-18), on web and native alike (react-native-svg, as TownwiseAI's
// icons draw): This week's seven days from today, each a column. The published forecast's middle is a hollow `mint`
// point on a dashed `mint` line, its range (low to high, as the words give it) a `raised` band with 1px `line` edges;
// a stored figure (only today can have one) is a solid `mint` point beside it, the actual; the same weekday last year
// is a faint 1px `line` line with small dots. A closed or booked day says so in words in its column (“Closed”,
// “Booked” and a buyout's party), and a day the run gives no figure says “No forecast”, a gap in the line; with
// nothing published no column says anything. Shapes and dashes tell the series apart as well as color, and the key
// names only what is drawn. The scale is printed. The drawing is aria-hidden: each day's column is a button whose name
// says everything the column shows and the day's calendar in words, and Show the numbers (ThisWeek.tsx) gives the
// table. A tap, a click, Enter or Space chooses a day (focus alone does not, so Tab passes the later days and reaches
// the panel with the chosen day still in it), and the panel beside or under the chart shows the chosen day (today at
// first): its forecast and range, its actual, Why and On the calendar in This month's day detail's words
// (DayDetail.tsx), the same weekday last year, and a link that opens the day on the Calendar. The chosen column is lit;
// a mouse or pen over another (web; never touch) lights that one instead and leaves the panel alone, so the pointer
// never shows content it can't reach and never hides a keyboard choice (WCAG 1.4.13).

const C = theme.color;
const HEIGHT = 140;
const INSET = 12;
/** The plot's width until it is measured; the viewBox follows the measured width, so points stay round. */
const START_WIDTH = 320;
export const WEEK_PANEL_ID = 'home-week-day';

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface At { x: number; y: number }

/** One path through each run of two or more neighboring points; a lone point draws no line. */
function linePath(points: readonly (At | null)[]): string {
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
function bandPaths(points: readonly ({ x: number; low: number; high: number } | null)[], half: number): string[] {
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

function Plot(props: { model: Model; width: number; active: number | null }): React.JSX.Element {
  const { model, width, active } = props;
  const slot = width / 7;
  const x = (index: number): number => r2((index + 0.5) * slot);
  const y = (value: number): number => r2(INSET + (1 - value / model.top) * (HEIGHT - 2 * INSET));
  const beside = Math.min(9, slot * 0.2);
  const bands = bandPaths(model.days.map((day, index) => (day.point === null ? null : { x: x(index), low: y(day.point.low), high: y(day.point.high) })), slot * 0.25);
  const middle = linePath(model.days.map((day, index) => (day.point === null ? null : { x: x(index), y: y(day.point.mid) })));
  const lastYear = linePath(model.days.map((day, index) => (day.lastYear === null ? null : { x: x(index), y: y(day.lastYear) })));
  return (
    <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`} preserveAspectRatio="none" aria-hidden>
      {active === null ? null : (
        <Path data-hover="day" d={`M${String(r2(active * slot))} 0 h${String(r2(slot))} V${String(HEIGHT)} h${String(-r2(slot))} Z`} fill={C.white} fillOpacity={0.08} />
      )}
      <Path d={`M0 0.5 H${String(width)} M0 ${String(HEIGHT - 0.5)} H${String(width)}`} stroke={C.border} strokeWidth={1} />
      {bands.map((d) => <Path key={d} data-series="range" d={d} fill={C.raised} stroke={C.line} strokeWidth={1} />)}
      {lastYear === '' ? null : <Path data-series="last-year" d={lastYear} fill="none" stroke={C.line} strokeOpacity={0.7} strokeWidth={1} />}
      {model.days.map((day, index) => (day.lastYear === null ? null : (
        <Circle key={day.date} data-series="last-year-point" cx={x(index)} cy={y(day.lastYear)} r={2} fill={C.line} fillOpacity={0.7} />
      )))}
      {middle === '' ? null : <Path data-series="forecast" d={middle} fill="none" stroke={C.mint} strokeWidth={1.5} strokeDasharray="4 3" />}
      {model.days.map((day, index) => (day.point === null ? null : (
        <Circle key={day.date} data-series="forecast-point" cx={x(index)} cy={y(day.point.mid)} r={4} fill={C.panel} stroke={C.mint} strokeWidth={1.5} />
      )))}
      {model.days.map((day, index) => (day.actual === null ? null : (
        <Circle key={day.date} data-series="actual" cx={r2(x(index) + (day.point === null ? 0 : beside))} cy={y(day.actual)} r={4.5} fill={C.mint} />
      )))}
    </Svg>
  );
}

function Swatch(props: { kind: 'forecast' | 'range' | 'actual' | 'lastYear' }): React.JSX.Element {
  return <View style={swatch[props.kind]} />;
}

/** The key, naming only what is drawn; aria-hidden, since each day's name says the same. */
function Key(props: { model: Model; metric: Metric }): React.JSX.Element | null {
  const { drawn } = props.model;
  const items: { kind: 'forecast' | 'range' | 'actual' | 'lastYear'; words: string }[] = [
    ...(drawn.forecast ? [{ kind: 'forecast' as const, words: 'Forecast' }, { kind: 'range' as const, words: 'Likely range' }] : []),
    ...(drawn.actual ? [{ kind: 'actual' as const, words: props.metric === 'guests' ? FIGURE_KEY.actual : 'Actual net sales' }] : []),
    ...(drawn.lastYear ? [{ kind: 'lastYear' as const, words: 'Same weekday last year' }] : []),
  ];
  if (items.length === 0) return null;
  return (
    <View testID="home-week-chart-key" aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.key}>
      {items.map((item) => (
        <View key={item.kind} style={styles.keyItem}><Swatch kind={item.kind} /><Mono tone="text3">{item.words}</Mono></View>
      ))}
    </View>
  );
}

/** The chosen day: its forecast, actual, Why, calendar and last year, and its link to the Calendar. */
function DayPanel(props: {
  day: ChartDay; input: CalendarInput; metric: Metric; history: boolean; published: boolean; locationId: string;
}): React.JSX.Element {
  const { day, input, metric, history, locationId } = props;
  const view = useMemo(() => dayView(day.date, input), [day.date, input]);
  const why = day.forecast === null ? [] : whyRows(day.forecast, WHY_LINES);
  const lines = day.forecast === null ? [] : forecastDayLines(day.forecast);
  return (
    <View role="region" aria-label="This week’s chosen day" nativeID={WEEK_PANEL_ID} style={styles.panel}>
      <Heading level={3}>{day.isToday ? `Today, ${shortDate(day.date)}` : shortDate(day.date)}</Heading>
      {props.published ? (
        <Part label={forecastPartLabel(day.forecast)}>
          {(lines.length === 0 ? ['No forecast figure for this day.'] : lines).map((line) => <Small key={line} white>{line}</Small>)}
        </Part>
      ) : null}
      {day.actual === null ? null : (
        <Part label="Actual"><Mono tone="white"><PhraseParts phrase={thisDayPhrase(day.row, metric)} /></Mono></Part>
      )}
      <WhyPart why={why} notes={view.notes} />
      <CalendarPart events={day.row.events} why={why} view={view} locationId={locationId} />
      {history ? <Part label="Same weekday last year"><PastCell day={day.row.lastYear} metric={metric} /></Part> : null}
      <Link href={calendarHref(locationId, day.date)} style={styles.link}>Open this day on the Calendar</Link>
    </View>
  );
}

export function WeekChart(props: {
  model: Model; input: CalendarInput; metric: Metric; history: boolean; published: boolean; locationId: string;
}): React.JSX.Element {
  const { model, metric } = props;
  const { desktop, phone } = useBreakpoint();
  const [width, setWidth] = useState(START_WIDTH);
  const [chosen, setChosen] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const first = model.days[0];
  const chosenDate = chosen ?? first?.date ?? null;
  const shown = model.days.find((day) => day.date === chosenDate);
  const active = model.days.findIndex((day) => day.date === (hovered ?? chosenDate));
  const noun = metric === 'guests' ? ' guests' : '';
  const onLayout = (event: LayoutChangeEvent): void => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0) setWidth((prev) => (prev === next ? prev : next));
  };
  return (
    <View style={desktop ? styles.wide : styles.stack}>
      <View style={styles.chartSide}>
        <View style={styles.chart} onLayout={onLayout}>
          <View style={styles.plot}><Plot model={model} width={width} active={active < 0 ? null : active} /></View>
          <View role="group" aria-label="This week’s days" style={styles.days}>
            {model.days.map((day) => {
              const isChosen = day.date === chosenDate;
              return (
                <Pressable
                  key={day.date}
                  testID={`home-week-chart-${day.date}`}
                  role="button"
                  accessibilityLabel={day.label}
                  accessibilityState={{ selected: isChosen }}
                  {...webAria({ 'aria-pressed': isChosen, 'aria-controls': WEEK_PANEL_ID })}
                  onPress={() => { setChosen(day.date); }}
                  onHoverIn={() => { setHovered(day.date); }}
                  onHoverOut={() => { setHovered((prev) => (prev === day.date ? null : prev)); }}
                  style={styles.slot}
                >
                  <View style={styles.zone}>
                    {day.status?.map((words) => <Mono key={words} tone="text2" style={phone ? [styles.status, styles.statusPhone] : styles.status}>{words}</Mono>)}
                  </View>
                  <View style={styles.dayLabel}>
                    <View style={styles.weekday}>
                      {day.isToday ? <View style={styles.square} /> : null}
                      <Mono tone={isChosen ? 'white' : 'text3'}>{(WEEKDAY_NAMES[weekdayOf(day.date)] ?? '').slice(0, 3)}</Mono>
                    </View>
                    <Mono tone="text3" style={styles.center}>{dayMonth(day.date)}</Mono>
                    <View style={[styles.mark, isChosen ? styles.markOn : null]} />
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
        <Key model={model} metric={metric} />
        <Mono tone="text3">{`Scale 0 to ${metricNumber(model.top, metric)}${noun}. Scale fitted to this location.`}</Mono>
        <Mono tone="text3">{Platform.OS === 'web' ? 'Choose a day to see it in full.' : 'Tap a day to see it in full.'}</Mono>
      </View>
      {shown === undefined ? null : (
        <View style={styles.panelSide}>
          <DayPanel day={shown} input={props.input} metric={metric} history={props.history} published={props.published} locationId={props.locationId} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wide: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space.gutter },
  stack: { gap: theme.space[5] },
  chartSide: { flex: 3, minWidth: 0, gap: theme.space[2] },
  panelSide: { flex: 2, minWidth: 0 },
  chart: { position: 'relative' },
  plot: { position: 'absolute', top: 0, left: 0, right: 0, height: HEIGHT },
  days: { flexDirection: 'row' },
  slot: { flex: 1, minWidth: 0 },
  zone: { height: HEIGHT, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 6, paddingHorizontal: 2 },
  status: { textAlign: 'center' },
  // A phone's column is about 44px at 375: “forecast”, 8 letters of 0.6em less 0.5px each, fits it at 10px.
  statusPhone: { fontSize: 10, lineHeight: 12, letterSpacing: -0.5 },
  dayLabel: { alignItems: 'center', paddingTop: theme.space[2], gap: 2 },
  weekday: { flexDirection: 'row', alignItems: 'center', columnGap: 4 },
  square: { width: 6, height: 6, backgroundColor: C.mint },
  center: { textAlign: 'center' },
  mark: { width: 16, height: 2, marginTop: 2 },
  markOn: { backgroundColor: C.mint },
  key: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4, alignItems: 'center' },
  keyItem: { flexDirection: 'row', alignItems: 'center', columnGap: 6 },
  panel: { gap: theme.space[4], minWidth: 0 },
  link: { ...theme.type.mono, color: C.text2, paddingVertical: 14, textDecorationLine: 'underline', textDecorationColor: C.line },
});

const swatch = StyleSheet.create({
  forecast: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: C.mint, backgroundColor: C.panel },
  range: { width: 12, height: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.raised },
  actual: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.mint },
  lastYear: { width: 16, height: 1, backgroundColor: C.line },
});
