import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';
import { formatCount } from '../format';
import { ForecastPlot, PlotKey } from '../chart/ForecastPlot';
import type { CalendarChart } from './chart';
import { FIGURE_KEY } from './model';

// The month view's forecast chart (P28, D64), on web and native (react-native-svg through chart/ForecastPlot.tsx):
// above the grid, one column per day of the grid's month (calendar/chart.ts), with the forecast's middle and range, an
// outlook day's range dashed, a past day's stored guests, the same weekday last year, and a status word standing
// upright in a column with no point. Today's column is shaded and its date `white` and bold; the selected day's column
// is lit with a `mint` mark under its date; a mouse or pen over another column (web, never touch) lights that one
// instead. A column is at least 24px wide, so a month that doesn't fit (a phone) scrolls sideways, brought to the
// selected day. Pressing a column selects its day as pressing it in the grid does. The chart is hidden from screen
// readers and its columns are not focusable: the grid's cells say each day's forecast and range. Under it, the key
// (only what is drawn) and the printed scale. [CONFIRM: the forecast chart shown by default on the Calendar with a
// “Forecast chart” chip to hide it]

const C = theme.color;
const HEIGHT = 120;
/** The narrowest column, so a point and an upright word stay readable. */
export const MIN_SLOT = 24;
/** The width until it is measured. */
const START_WIDTH = 320;

/** A column's width: the measured width shared by the days, never under MIN_SLOT. */
export function monthSlot(width: number, days: number): number {
  return days <= 0 ? MIN_SLOT : Math.max(MIN_SLOT, width / days);
}

export function MonthChart(props: {
  chart: CalendarChart;
  selected: string;
  onSelect: (date: string) => void;
  /** Dimmed while the page's reads load again. */
  busy: boolean;
}): React.JSX.Element {
  const { chart, selected } = props;
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(START_WIDTH);
  const [hovered, setHovered] = useState<string | null>(null);
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const slot = monthSlot(width, chart.days.length);
  const total = slot * chart.days.length;
  const index = (date: string | null): number | null => {
    const at = chart.days.findIndex((day) => day.date === date);
    return at < 0 ? null : at;
  };
  const chosen = index(selected);
  const today = chart.days.findIndex((day) => day.isToday);

  // A month wider than the box keeps the selected day in view.
  useEffect(() => {
    if (chosen === null || total <= width) return;
    scroller.current?.scrollTo({ x: Math.max(0, (chosen + 0.5) * slot - width / 2), animated: reduced === false });
  }, [chosen, slot, total, width, reduced]);

  const onLayout = (event: LayoutChangeEvent): void => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0) setWidth((prev) => (prev === next ? prev : next));
  };

  return (
    <View
      testID="calendar-month-chart"
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.box, props.busy ? styles.busy : null]}
    >
      <View onLayout={onLayout}>
        <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={total > width} contentContainerStyle={{ width: total }}>
          <View style={{ width: total }}>
            <View style={styles.plot}>
              <ForecastPlot
                days={chart.days}
                top={chart.top}
                width={total}
                height={HEIGHT}
                shaded={today < 0 ? null : today}
                lit={index(hovered) ?? chosen}
                words={chart.days.map((day) => day.status)}
              />
            </View>
            <View style={styles.days}>
              {chart.days.map((day) => {
                const isChosen = day.date === selected;
                return (
                  <Pressable
                    key={day.date}
                    testID={`calendar-month-chart-${day.date}`}
                    accessible={false}
                    tabIndex={-1}
                    onPress={() => { props.onSelect(day.date); }}
                    onHoverIn={() => { setHovered(day.date); }}
                    onHoverOut={() => { setHovered((prev) => (prev === day.date ? null : prev)); }}
                    style={[styles.column, { width: slot }]}
                  >
                    <View style={styles.zone} />
                    <Text style={[styles.date, day.isToday ? styles.today : null]}>{String(Number(day.date.slice(8, 10)))}</Text>
                    <View style={[styles.mark, isChosen ? styles.markOn : null]} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        </ScrollView>
      </View>
      <PlotKey drawn={chart.drawn} actual={FIGURE_KEY.actual} testID="calendar-month-chart-key" />
      <Text style={styles.scale}>{`Scale 0 to ${formatCount(chart.top)} guests.`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: theme.space[2] },
  busy: { opacity: 0.6 },
  plot: { position: 'absolute', top: 0, left: 0, right: 0, height: HEIGHT },
  days: { flexDirection: 'row' },
  column: { alignItems: 'center' },
  zone: { height: HEIGHT },
  date: { ...theme.type.mono, fontSize: 11, lineHeight: 16, color: C.text3, fontVariant: ['tabular-nums'], paddingTop: 4 },
  today: { color: C.white, fontWeight: '600' },
  mark: { width: 12, height: 2, marginTop: 2 },
  markOn: { backgroundColor: C.mint },
  scale: { ...theme.type.mono, color: C.text3 },
});
