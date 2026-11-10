import { Link, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fmt1 } from '../../marketing/format';
import { theme } from '../../theme';
import type { Calendar } from '../analytics/api';
import type { DayContext } from '../analytics/days';
import { noteWords } from '../analytics/panel';
import { eventLine, monthDay, monthFactLine, monthFactsHead, monthGrid, monthItems, type HomeInput, type MonthFact } from '../analytics/week';
import { MONTH_NAMES, type Metric } from '../analytics/words';
import { weekdaysLine } from '../locations/noteRules';
import { useBreakpoint } from '../hooks';
import { PeopleInTownSummary } from '../estimates/PeopleInTownSummary';
import { DATA_YEAR, SOURCES, townProfile } from '../towns';
import { Stack } from '../ui/layout';
import { Mono, Small } from '../ui/text';
import { Block } from './Block';
import { DayDetail } from './DayDetail';
import { MonthGrid } from './MonthGrid';

// This month in {Town} (spec P11): only sourced facts, in four blocks. The month card is the calendar you can
// open: the month as a grid, any day of it selected (today at first) with its detail beside the grid. On the
// calendar in {month} is every town event, holiday and note of the month in date order with its sources. Who's in
// town is the month's people in town summary (spec 13.2, read on its own) with the county's food-service employment
// for the month from the bundled BLS data (one of the twelve towns only) and its caveat. Your {month} in past years
// is the location's own days, each year with its day count.

const BLS = SOURCES.find((source) => source.url.startsWith('https://www.bls.gov/'));

export const PEOPLE_HEAD = 'Who’s in town';

const monthNameOf = (today: string): string => MONTH_NAMES[Number(today.slice(5, 7)) - 1] ?? '';

export function ThisMonth(props: { input: HomeInput; calendar: Calendar; history: boolean }): React.JSX.Element {
  const { input, calendar, history } = props;
  const { today, context, metric } = input;
  const town = calendar.town;
  const monthName = monthNameOf(today);
  const label = `${monthName} ${today.slice(0, 4)}`;
  const rows = useMemo(() => monthGrid(today, context), [today, context]);
  const [selected, setSelected] = useState(today);
  const [preview, setPreview] = useState<string | null>(null);
  const shown = preview ?? selected;
  const day = useMemo(() => monthDay(shown, input), [shown, input]);
  return (
    <Block label={`This month in ${town.name}`} eyebrow={label} title={`This month in ${town.name}`}>
      <Small>Choose a day to see what’s on it and how it went last year.</Small>
      <View style={styles.split}>
        <View style={styles.gridSide}>
          <MonthGrid rows={rows} selected={selected} onSelect={(date) => { setPreview(null); setSelected(date); }} onPreview={setPreview} label={label} />
        </View>
        <View style={styles.detailSide}>
          <DayDetail day={day} metric={metric} history={history} />
        </View>
      </View>
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
  const monthIndex = Number(today.slice(5, 7)) - 1;
  const monthName = monthNameOf(today);
  const profile = townProfile(calendar.town.townId);
  const index = profile?.series.index[monthIndex];
  return (
    <Block label={PEOPLE_HEAD} eyebrow={`${calendar.town.name}, ${monthName}`} title={PEOPLE_HEAD}>
      <PeopleInTownSummary locationId={props.locationId} month={today.slice(0, 7)} />
      {profile === null || index === undefined ? null : (
        <Stack gap={4} style={styles.ruled}>
          <Small white>{`Food-service jobs in ${profile.county}, ${monthName} ${String(DATA_YEAR)}: ${fmt1(index)} (${String(DATA_YEAR)} average = 100).`}</Small>
          <Mono tone="text3">County, not town. Employment is a stand-in for demand.</Mono>
          {BLS === undefined ? null : <Link href={BLS.url} style={styles.source}>Source: U.S. Bureau of Labor Statistics, QCEW</Link>}
        </Stack>
      )}
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
  split: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[6], rowGap: theme.space[5], alignItems: 'flex-start' },
  gridSide: { flexGrow: 1, flexShrink: 1, flexBasis: 280, maxWidth: 420, minWidth: 0 },
  detailSide: { flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0 },
  ruled: { paddingTop: theme.space[4], borderTopWidth: 1, borderTopColor: c.border },
  list: { gap: theme.space[3] },
  item: { flexDirection: 'row', columnGap: theme.space[4], alignItems: 'flex-start' },
  itemPhone: { gap: 2 },
  date: { ...theme.type.ui, color: c.white, fontWeight: '600' },
  dateWide: { width: 112 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  source: { ...theme.type.mono, color: c.text2, minHeight: 44, lineHeight: 44, textDecorationLine: 'underline', textDecorationColor: c.line },
});
