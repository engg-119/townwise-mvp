import { Link, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { Calendar } from '../analytics/api';
import type { DayContext } from '../analytics/days';
import { noteWords } from '../analytics/panel';
import { eventLine, monthDay, monthFactLine, monthFactsHead, monthGrid, monthItems, type HomeInput, type MonthFact } from '../analytics/week';
import { MONTH_NAMES, type Metric } from '../analytics/words';
import { ALL_FILTERS, tooltipLines, type CalendarInput } from '../calendar/model';
import type { ForecastDay, ForecastWindow } from '../estimates/api';
import type { Note } from '../locations/api';
import { monthRange } from '../locations/dates';
import type { Rule } from '../rules/api';
import { weekdaysLine } from '../locations/noteRules';
import { useBreakpoint, type LoadState } from '../hooks';
import type { OrderBoard } from '../orders/api';
import { calendarHref } from '../routing';
import { LinkButton } from '../ui/Button';
import { Stack } from '../ui/layout';
import { Mono, Small } from '../ui/text';
import { Block } from './Block';
import { DayDetail } from './DayDetail';
import { InTown } from './InTown';
import { MonthGrid } from './MonthGrid';

// This month in {Town} (spec P11): only sourced facts, in four blocks. The month card is the month as a grid, each
// day with its figure (stored before today, the published forecast's from today on, spec 16.3 P11), and the
// day the keys select (today at first) or a pointer rests on with its detail beside the grid; on web a pointer also
// shows the day's tooltip (the Calendar's lines). Choosing a day (a click, Enter, a tap) opens it in the Calendar
// (P28), which the card also links to. On the calendar in {month} is every town event, holiday and note of the month
// in date order with its sources. Who's in town is the month's people in town from today on, grouped by time under
// headings, then the county's food-service jobs for the month (InTown.tsx). Your {month} in past years is the
// location's own days, each year with its day count.

export const PEOPLE_HEAD = 'Who’s in town';

const monthNameOf = (today: string): string => MONTH_NAMES[Number(today.slice(5, 7)) - 1] ?? '';

export function ThisMonth(props: {
  input: HomeInput; calendar: Calendar; notes: readonly Note[]; rules: readonly Rule[]; forecast: ForecastWindow | null; history: boolean;
  locationId: string; board: LoadState<OrderBoard>;
}): React.JSX.Element {
  const { input, calendar, notes, rules, forecast, history, locationId } = props;
  const { today, context, metric } = input;
  const router = useRouter();
  const town = calendar.town;
  const monthName = monthNameOf(today);
  const label = `${monthName} ${today.slice(0, 4)}`;
  const forecastDays = useMemo(() => new Map((forecast?.days ?? []).map((day): [string, ForecastDay] => [day.date, day])), [forecast]);
  const rows = useMemo(() => monthGrid(today, context, { input, forecast: forecastDays }), [today, context, input, forecastDays]);
  // The Calendar's own tooltip words, with the same business rules as the grid (D31, D32); nothing is imported on Home
  // and no filter is off.
  const tipInput = useMemo<CalendarInput>(() => ({
    today, covered: monthRange(today.slice(0, 7)), forecast, salesDays: [...input.byDate.values()], events: calendar.events, notes, rules, imported: [],
    filters: ALL_FILTERS,
  }), [today, forecast, input.byDate, calendar.events, notes, rules]);
  const tooltip = useCallback((date: string) => tooltipLines(date, tipInput), [tipInput]);
  const [selected, setSelected] = useState(today);
  const [preview, setPreview] = useState<string | null>(null);
  const shown = preview ?? selected;
  const day = useMemo(() => monthDay(shown, input), [shown, input]);
  const forecastDay = shown >= today ? forecastDays.get(shown) ?? null : null;
  return (
    <Block label={`This month in ${town.name}`} eyebrow={label} title={`This month in ${town.name}`}>
      <Small>{Platform.OS === 'web' ? 'Point at a day to see what’s on it. Choose one to open it in the Calendar.' : 'Tap a day to open it in the Calendar.'}</Small>
      <View style={styles.split}>
        <View style={styles.gridSide}>
          <MonthGrid
            rows={rows}
            selected={selected}
            onSelect={(date) => { setPreview(null); setSelected(date); }}
            onPreview={setPreview}
            onOpen={(date) => { router.push(calendarHref(locationId, date)); }}
            tooltip={tooltip}
            label={label}
          />
        </View>
        <View style={styles.detailSide}>
          <DayDetail day={day} forecast={forecastDay} metric={metric} history={history} locationId={locationId} board={props.board} />
        </View>
      </View>
      <View style={styles.open}><LinkButton href={calendarHref(locationId)} label="Open the calendar" /></View>
    </Block>
  );
}

/** Every town event, holiday and note on the month, in date order, with its sources. */
export function MonthList(props: { today: string; context: DayContext }): React.JSX.Element {
  const { today, context } = props;
  const monthName = monthNameOf(today);
  const items = useMemo(() => monthItems(today, context), [today, context]);
  const { phone } = useBreakpoint();
  return (
    <Block label={`On the calendar in ${monthName}`} eyebrow={`${monthName} ${today.slice(0, 4)}`} title={`On the calendar in ${monthName}`}>
      {items.length === 0 ? <Small>{`Nothing on the calendar in ${monthName}.`}</Small> : (
        <View role="list" style={styles.list}>
          {items.map((item) => (
            <View key={item.key} role="listitem" style={phone ? styles.itemPhone : styles.item}>
              <Text style={[styles.date, phone ? null : styles.dateWide]}>{item.dates}</Text>
              <View style={styles.body}>
                {item.kind === 'event' ? (
                  <>
                    <Small white>{eventLine(item.event)}</Small>
                    {item.event.sources.map((source) => (
                      <Link key={source.url} href={source.url as Href} style={styles.source}>{`Source: ${source.label}`}</Link>
                    ))}
                  </>
                ) : (
                  <Small white>
                    {[`Your note: ${noteWords(item.note)}`, weekdaysLine(item.note.weekdays)].filter((part) => part !== null).join(', ')}.
                  </Small>
                )}
              </View>
            </View>
          ))}
        </View>
      )}
    </Block>
  );
}

/** Who's in town this month, and the county's food-service jobs for the month. */
export function WhoIsInTown(props: { today: string; calendar: Calendar; locationId: string }): React.JSX.Element {
  const { today, calendar } = props;
  return (
    <Block label={PEOPLE_HEAD} eyebrow={`${calendar.town.name}, ${monthNameOf(today)}`} title={PEOPLE_HEAD}>
      <InTown today={today} townId={calendar.town.townId} locationId={props.locationId} />
    </Block>
  );
}

/** This month in the location's past years, newest first; nothing at all without one. */
export function PastYears(props: { today: string; facts: readonly MonthFact[]; metric: Metric }): React.JSX.Element | null {
  if (props.facts.length === 0) return null;
  return (
    <Block label={monthFactsHead(props.today)} eyebrow={`Past ${monthNameOf(props.today)}s`} title={monthFactsHead(props.today)}>
      <Stack gap={8}>
        {props.facts.map((fact) => <Small key={fact.year} white>{monthFactLine(fact, props.metric)}</Small>)}
      </Stack>
      <Mono tone="text3">Averages leave out closed days.</Mono>
    </Block>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  open: { flexDirection: 'row' },
  split: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[6], rowGap: theme.space[5], alignItems: 'flex-start' },
  gridSide: { flexGrow: 1, flexShrink: 1, flexBasis: 280, maxWidth: 420, minWidth: 0 },
  detailSide: { flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0 },
  list: { gap: theme.space[3] },
  item: { flexDirection: 'row', columnGap: theme.space[4], alignItems: 'flex-start' },
  itemPhone: { gap: 2 },
  date: { ...theme.type.ui, color: c.white, fontWeight: '600' },
  dateWide: { width: 112 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  source: { ...theme.type.mono, color: c.text2, minHeight: 44, lineHeight: 44, textDecorationLine: 'underline', textDecorationColor: c.line },
});
