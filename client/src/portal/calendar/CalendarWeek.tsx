import { useEffect, useRef, useState } from 'react';
import {
  Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';
import { ForecastPlot } from '../chart/ForecastPlot';
import { addDays, daysBetween } from '../locations/dates';
import { AgendaCard } from './AgendaCard';
import type { CalendarChart } from './chart';
import { cardWords, CELL_GAP, headLine, weekHead, type InertCell, type MonthBounds, type WeekDay, type WeekSlot } from './grid';
import { figureTone, markedFigure, statusWord, type TooltipLines } from './model';
import { nearestDay, snapOffsets, stripStep, STRIP_GROW_DAYS, VIEW_DAYS } from './strip';

// The Calendar's week view (P28, spec 16.3, step 2), on native at every width: on top, the days as a strip that
// scrolls sideways and snaps to a day (D64; a horizontal ScrollView with `snapToOffsets` at each day's left edge and a
// fast deceleration), 7 in view, each day its slice of the forecast chart (chart/ForecastPlot.tsx, when the page passes
// one) over a short head (the day, and its figure or status word); a tap on one selects it. The strip is hidden from
// screen readers. A stop (momentum's end, or a drag's end with none) hands the day nearest the scroll to the page
// (`onSettle`), which keeps it as the first day in view (`weekStart`); a change of `weekStart` from the page scrolls
// there, animated unless Reduce Motion is on, and days the page adds before the first move the scroll by their width.
// Under the strip, an agenda of the 7 days in view: each row a Pressable labeled as its month cell, with its selected
// state, holding the day's head line (the day, a Today tag under today, the status word, the figure with "+70", an
// actual solid and a forecast lighter after a "~", D49 decision 10, and under a forecast "forecast" with its range) over
// the day's full-width cards (AgendaCard.tsx). Pressing a row selects its day; the selected row and strip day have a
// 2px `mint` border over the `state` fill (D64). An inert day (outside the 25 months) is a disabled row with its head
// line only; a pending one (its reads in flight) shows its head line only. Web has its own file (CalendarWeek.web.tsx):
// day columns from 641px and an agenda below, with the keys and the tooltip. Only types are shared with it, since on
// web './CalendarWeek' is that file itself.

export interface CalendarWeekProps {
  /** The days rendered (grid.ts buildDays over the page's strip, calendar/strip.ts), first to last. */
  days: readonly WeekSlot[];
  /** The selected day. */
  selected: string;
  /** The first day in view, where Home and End go from (web), and where the strip scrolls to. */
  weekStart: string;
  /** The 25 months the page shows: a key past them is consumed (web). */
  bounds: MonthBounds;
  /**
   * `moved`: a key moved the selection (web), so the page leaves the scroll where it is. `month`: the month the grid
   * then shows, after PageUp or PageDown; null otherwise.
   */
  onSelect: (date: string, moved?: boolean, month?: string | null) => void;
  /** Dimmed and aria-busy while the reads of the shown range (grid.ts readRangeFor) load again. */
  busy: boolean;
  /** “Nov 15 to 21, 2026”: the 7 days in view. */
  label: string;
  /** Web only: the hover tooltip's lines for a day; null for none. */
  tooltip: (date: string) => TooltipLines | null;
  /** The forecast chart over `days`, in the same order (D64); none when hidden or with nothing to draw. */
  chart?: CalendarChart | null;
  /** A scroll stopped with this day first in view (D64). */
  onSettle?: (start: string) => void;
}

const STRIP_CHART_HEIGHT = 72;
/** A day's width until the view is measured. */
const START_DAY = 48;

function Head(props: { day: WeekDay }): React.JSX.Element {
  const { day } = props;
  const status = statusWord(day.status);
  const last = headLine(day);
  return (
    <View style={styles.head}>
      <Text style={[styles.day, day.isToday ? styles.today : null]}>{weekHead(day.date)}</Text>
      {day.isToday ? <Text style={styles.tag}>Today</Text> : null}
      {day.pending || status === null ? null : <Text style={styles.status}>{status}</Text>}
      {day.pending || day.figure === null ? null : (
        <Text style={[styles.figure, figureTone(day.figure) === 'text2' ? styles.forecast : null]}>{markedFigure(String(day.figure.value), day.figure)}</Text>
      )}
      {day.pending || day.noteGuests === 0 ? null : <Text style={styles.added}>{`+${String(day.noteGuests)}`}</Text>}
      {day.pending || last === null ? null : <Text style={styles.line}>{last}</Text>}
    </View>
  );
}

function Row(props: { day: WeekDay; selected: boolean; onSelect: (date: string) => void }): React.JSX.Element {
  const { day } = props;
  // One accessible element, so the cards inside it are heard through its hint (none on a day without cards).
  const hint = cardWords(day.cards);
  return (
    <Pressable
      role="button"
      accessibilityLabel={day.label}
      {...(hint === null ? {} : { accessibilityHint: hint })}
      accessibilityState={{ selected: props.selected }}
      onPress={() => { props.onSelect(day.date); }}
      style={[styles.row, props.selected ? styles.selected : null]}
    >
      <Head day={day} />
      {day.pending ? null : day.cards.map((card) => <AgendaCard key={card.key} card={card} />)}
    </Pressable>
  );
}

function InertRow(props: { day: InertCell }): React.JSX.Element {
  return (
    <Pressable
      role="button"
      disabled
      accessibilityLabel={props.day.label}
      accessibilityState={{ disabled: true }}
      style={[styles.row, styles.inert]}
    >
      <Text style={[styles.day, styles.muted]}>{weekHead(props.day.date)}</Text>
    </Pressable>
  );
}

/** A day of the strip: its chart slice and short head; hidden from screen readers with the strip. */
function StripDay(props: {
  day: WeekSlot; width: number; selected: boolean; chart: CalendarChart | null; index: number | null; selectedIndex: number | null;
  todayIndex: number | null; onSelect: (date: string) => void;
}): React.JSX.Element {
  const { day, chart, index } = props;
  const inert = day.kind === 'inert';
  const status = inert || day.pending ? null : statusWord(day.status);
  const figure = inert || day.pending ? null : day.figure;
  return (
    <Pressable
      testID={`calendar-strip-${day.date}`}
      accessible={false}
      disabled={inert}
      onPress={() => { props.onSelect(day.date); }}
      style={[styles.stripDay, { width: props.width }, inert ? styles.inert : props.selected ? styles.stripSelected : null]}
    >
      {chart === null || index === null ? null : (
        <View style={styles.stripChart}>
          <ForecastPlot
            days={chart.days}
            top={chart.top}
            width={props.width - 2 * (props.selected ? 2 : 1)}
            height={STRIP_CHART_HEIGHT}
            from={index}
            to={index + 1}
            shaded={props.todayIndex}
            lit={props.selectedIndex}
          />
        </View>
      )}
      <Text style={[styles.stripHead, !inert && day.isToday ? styles.today : null]}>{weekHead(day.date)}</Text>
      {figure === null ? null : (
        <Text style={[styles.stripFigure, figureTone(figure) === 'text2' ? styles.forecast : null]}>{markedFigure(String(figure.value), figure)}</Text>
      )}
      {figure !== null || status === null ? null : <Text style={styles.stripStatus}>{status}</Text>}
    </Pressable>
  );
}

export function CalendarWeek(props: CalendarWeekProps): React.JSX.Element {
  const { days, weekStart, onSettle } = props;
  const chart = props.chart ?? null;
  const reduced = useReducedMotion();
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [viewport, setViewport] = useState(0);
  /** The first day rendered and the first day in view, as the last scroll saw them. */
  const placed = useRef<{ first: string; start: string } | null>(null);
  const step = stripStep(viewport);
  const dayWidth = step > 0 ? step - CELL_GAP : START_DAY;
  const first = days[0]?.date ?? weekStart;
  const startIndex = Math.max(0, days.findIndex((day) => day.date === weekStart));
  const last = addDays(weekStart, VIEW_DAYS - 1);
  const chartIndex = (date: string | null): number | null => {
    if (chart === null || date === null) return null;
    const at = chart.days.findIndex((day) => day.date === date);
    return at < 0 ? null : at;
  };
  const todayIndex = chartIndex(chart?.days.find((day) => day.isToday)?.date ?? null);
  const selectedIndex = chartIndex(props.selected);

  // Keep the strip where the page says: at once on its first layout, after days are added before the first, a jump of
  // more than 3 weeks, or under Reduce Motion; animated otherwise.
  useEffect(() => {
    if (step <= 0) return;
    const before = placed.current;
    placed.current = { first, start: weekStart };
    const jump = before?.first !== first || Math.abs(daysBetween(before.start, weekStart)) > STRIP_GROW_DAYS || reduced !== false;
    scroller.current?.scrollTo({ x: startIndex * step, animated: !jump });
  }, [first, weekStart, startIndex, step, reduced]);

  const onLayout = (event: LayoutChangeEvent): void => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0) setViewport((prev) => (prev === next ? prev : next));
  };

  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const day = days[nearestDay(event.nativeEvent.contentOffset.x, step, days.length)];
    if (day !== undefined && day.date !== weekStart) onSettle?.(day.date);
  };

  return (
    <View accessibilityLabel={props.label} accessibilityState={{ busy: props.busy }} style={[styles.week, props.busy ? styles.busy : null]}>
      <View onLayout={onLayout} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <ScrollView
          ref={scroller}
          testID="calendar-strip"
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToOffsets={step > 0 ? snapOffsets(step, days.length) : undefined}
          snapToStart
          snapToEnd
          decelerationRate="fast"
          onMomentumScrollEnd={settle}
          onScrollEndDrag={(event) => { if (Math.abs(event.nativeEvent.velocity?.x ?? 0) < 0.05) settle(event); }}
        >
          {days.map((day, at) => (
            <View key={day.date} style={at < days.length - 1 ? styles.stripGap : null}>
              <StripDay
                day={day}
                width={dayWidth}
                selected={day.date === props.selected}
                chart={chart}
                index={chartIndex(day.date)}
                selectedIndex={selectedIndex}
                todayIndex={todayIndex}
                onSelect={props.onSelect}
              />
            </View>
          ))}
        </ScrollView>
      </View>
      {days.filter((day) => day.date >= weekStart && day.date <= last).map((day) => (day.kind === 'inert'
        ? <InertRow key={day.date} day={day} />
        : <Row key={day.date} day={day} selected={day.date === props.selected} onSelect={props.onSelect} />))}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  week: { gap: 3, width: '100%' },
  busy: { opacity: 0.6 },
  row: { gap: 6, padding: 8, backgroundColor: c.raised, borderWidth: 1, borderColor: c.raised },
  // 2px, its padding 1px less, so nothing inside moves (D64).
  selected: { borderColor: c.mint, borderWidth: 2, padding: 7, backgroundColor: c.state },
  inert: { backgroundColor: 'transparent', borderColor: c.border },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2 },
  day: { ...theme.type.mono, color: c.text2, fontVariant: ['tabular-nums'] },
  today: { color: c.white, fontWeight: '600' },
  muted: { color: c.text3 },
  tag: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.white, borderWidth: 1, borderColor: c.line, paddingHorizontal: 4 },
  status: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text2, textTransform: 'uppercase' },
  figure: { ...theme.type.monoValue, fontSize: 22, lineHeight: 26, color: c.white, fontVariant: ['tabular-nums'] },
  forecast: { color: c.text2 },
  added: { ...theme.type.mono, color: c.mint, fontVariant: ['tabular-nums'] },
  line: { ...theme.type.mono, fontSize: 11, lineHeight: 14, color: c.text3 },
  stripGap: { marginRight: CELL_GAP },
  stripDay: { alignItems: 'center', gap: 2, paddingVertical: 4, backgroundColor: c.raised, borderWidth: 1, borderColor: c.raised },
  stripSelected: { borderColor: c.mint, borderWidth: 2, paddingVertical: 3, backgroundColor: c.state },
  stripChart: { height: STRIP_CHART_HEIGHT, alignSelf: 'stretch' },
  stripHead: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text3, fontVariant: ['tabular-nums'] },
  stripFigure: { ...theme.type.monoValue, color: c.white, fontVariant: ['tabular-nums'] },
  stripStatus: { ...theme.type.mono, fontSize: 9, lineHeight: 12, color: c.text2, textTransform: 'uppercase', textAlign: 'center' },
});
