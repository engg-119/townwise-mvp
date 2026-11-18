import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { theme } from '../../theme';
import type { Calendar } from '../analytics/api';
import { noteWords } from '../analytics/panel';
import {
  eventLine, monthDay, monthFactPhrase, monthFactsHead, monthGrid, monthItems, WIDE_CELL, type HomeInput, type MonthFact,
} from '../analytics/week';
import { MONTH_NAMES, type Metric } from '../analytics/words';
import { dayView, monthCheckLine, pastForecastLines, tooltipLines, type CalendarInput } from '../calendar/model';
import type { ForecastDay, ForecastWindow } from '../estimates/api';
import { weekdaysLine } from '../locations/noteRules';
import { useBreakpoint, type LoadState } from '../hooks';
import type { OrderBoard } from '../orders/api';
import { calendarHref } from '../routing';
import { LinkButton } from '../ui/Button';
import { SourceChips } from '../ui/SourceChip';
import { Stack } from '../ui/layout';
import { PhraseParts } from '../ui/PhraseParts';
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
// in date order with its sources. D49: the grid's cells are the Calendar's (dayCell, one figure rule), the tooltip and
// the day detail read the same CalendarInput, with the location's own calendars' events. The grid column grows 3 to the
// detail's 2 side by side; it measures its width, and cells of 88px or more list two entry lines. "Open the calendar"
// sits under the key, in the grid's column. Who's in town is the month's people in town from today on, grouped by time under
// headings, then the county's food-service jobs for the month (InTown.tsx). Your {month} in past years is the
// location's own days, each year with its day count.

export const PEOPLE_HEAD = 'Who’s in town';

const monthNameOf = (today: string): string => MONTH_NAMES[Number(today.slice(5, 7)) - 1] ?? '';

export function ThisMonth(props: {
  input: HomeInput; calendar: Calendar; forecast: ForecastWindow | null; history: boolean;
  /** Home's one CalendarInput (D49): the town calendar, notes, rules, the location's calendars' events and the forecast. */
  entries: CalendarInput;
  locationId: string; board: LoadState<OrderBoard>;
}): React.JSX.Element {
  const { input, calendar, forecast, history, locationId, entries } = props;
  const { today, metric } = input;
  const router = useRouter();
  const town = calendar.town;
  const monthName = monthNameOf(today);
  const label = `${monthName} ${today.slice(0, 4)}`;
  const forecastDays = useMemo(() => new Map((forecast?.days ?? []).map((day): [string, ForecastDay] => [day.date, day])), [forecast]);
  const rows = useMemo(() => monthGrid(today, entries, metric), [today, entries, metric]);
  // The Calendar's own tooltip words, from the same input as the grid.
  const tooltip = useCallback((date: string) => tooltipLines(date, entries), [entries]);
  // The grid column's width, measured: a cell is a seventh of it less the 3px gaps.
  const [gridWidth, setGridWidth] = useState(0);
  const wide = (gridWidth - 6 * 3) / 7 >= WIDE_CELL;
  const [selected, setSelected] = useState(today);
  const [preview, setPreview] = useState<string | null>(null);
  const shown = preview ?? selected;
  const day = useMemo(() => monthDay(shown, input), [shown, input]);
  const view = useMemo(() => dayView(shown, entries), [shown, entries]);
  const forecastDay = shown >= today ? forecastDays.get(shown) ?? null : null;
  // Before today: how the day's forecast did, or the run's figure with no data (D49, design decision 11).
  const pastForecast = useMemo(() => pastForecastLines(shown, entries), [shown, entries]);
  const monthLine = useMemo(() => monthCheckLine(today.slice(0, 7), entries), [today, entries]);
  return (
    <Block label={`This month in ${town.name}`} eyebrow={label} title={`This month in ${town.name}`}>
      <Small>{Platform.OS === 'web' ? 'Point at a day to see what’s on it. Choose one to open it in the Calendar.' : 'Tap a day to open it in the Calendar.'}</Small>
      <View style={styles.split}>
        <View style={styles.gridSide} onLayout={(event: LayoutChangeEvent) => { setGridWidth(event.nativeEvent.layout.width); }}>
          <MonthGrid
            rows={rows}
            wide={wide}
            metric={metric}
            footer={(
              <>
                {monthLine === null ? null : <Small>{monthLine}</Small>}
                <View style={styles.open}><LinkButton href={calendarHref(locationId)} label="Open the calendar" /></View>
              </>
            )}
            selected={selected}
            onSelect={(date) => { setPreview(null); setSelected(date); }}
            onPreview={setPreview}
            onOpen={(date) => { router.push(calendarHref(locationId, date)); }}
            tooltip={tooltip}
            label={label}
          />
        </View>
        <View style={styles.detailSide}>
          <DayDetail
            day={day} forecast={forecastDay} pastForecast={pastForecast} metric={metric} history={history} locationId={locationId} board={props.board} view={view}
          />
        </View>
      </View>
    </Block>
  );
}

/**
 * Every town event, holiday, note, business rule and event of the location's calendars on the month (D49), each once by
 * its first day, in date order; a town event with its sources (the Calendar's day panel has the rest).
 */
export function MonthList(props: { today: string; entries: CalendarInput }): React.JSX.Element {
  const { today, entries } = props;
  const monthName = monthNameOf(today);
  const items = useMemo(() => monthItems(today, entries), [today, entries]);
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
                    <SourceChips sources={item.event.sources} />
                  </>
                ) : item.kind === 'note' ? (
                  <Small white>
                    {[`Your note: ${item.note.title ?? noteWords(item.note)}`, weekdaysLine(item.note.weekdays)].filter((part) => part !== null).join(', ')}.
                  </Small>
                ) : item.kind === 'rule' ? (
                  <>
                    <Small white>{`Your rule: ${item.rule.text}`}</Small>
                    {item.rule.scheduleSummary === null || item.rule.scheduleSummary === undefined ? null : <Mono>{item.rule.scheduleSummary}</Mono>}
                  </>
                ) : <Small white>{`From your calendar: ${item.imported.title}`}</Small>}
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
        {props.facts.map((fact) => <Small key={fact.year} white><PhraseParts phrase={monthFactPhrase(fact, props.metric)} /></Small>)}
      </Stack>
      <Mono tone="text3">Averages leave out closed days.</Mono>
    </Block>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  open: { flexDirection: 'row' },
  split: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[6], rowGap: theme.space[5], alignItems: 'flex-start' },
  // Side by side from a 720px content column (416 + 24 + 280): the grid grows 3 to the detail's 2, with no cap (D49).
  gridSide: { flexGrow: 3, flexShrink: 1, flexBasis: 416, minWidth: 0, gap: theme.space[3] },
  detailSide: { flexGrow: 2, flexShrink: 1, flexBasis: 280, minWidth: 0 },
  list: { gap: theme.space[3] },
  item: { flexDirection: 'row', columnGap: theme.space[4], alignItems: 'flex-start' },
  itemPhone: { gap: 2 },
  date: { ...theme.type.ui, color: c.white, fontWeight: '600' },
  dateWide: { width: 112 },
  body: { flex: 1, minWidth: 0, gap: 2 },
});
