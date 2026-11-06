import { Link, type Href } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { fmt1 } from '../../marketing/format';
import { theme } from '../../theme';
import type { Calendar } from '../analytics/api';
import type { DayContext } from '../analytics/days';
import { noteWords } from '../analytics/panel';
import { eventLine, monthFactLine, monthFactsHead, monthGrid, monthItems, type MonthFact } from '../analytics/week';
import { MONTH_NAMES, type Metric } from '../analytics/words';
import { weekdaysLine } from '../locations/noteRules';
import { useBreakpoint } from '../hooks';
import { PeopleInTownSummary } from '../estimates/PeopleInTownSummary';
import { DATA_YEAR, SOURCES, townProfile } from '../towns';
import { Stack } from '../ui/layout';
import { Eyebrow, Heading, Mono, Small } from '../ui/text';
import { MonthGrid } from './MonthGrid';

// This month in {Town} (home.md 2.5): only sourced facts. The month as a grid, then every town event, holiday and
// note on it in date order with its sources; the county's food-service employment for the month from the bundled
// BLS data (one of the twelve towns only), with its caveat; and this month in the location's past years, each with
// its day count. Then who's in town: the month's people in town summary (spec 13.2), which reads on its own and
// says the term periods in words, a headcount range only where every input has a source (otherwise that Townwise
// can't put a number on it, Planned), the location's own days by term, and where each came from.

const BLS = SOURCES.find((source) => source.url.startsWith('https://www.bls.gov/'));

export const PEOPLE_HEAD = 'Who’s in town';

export function ThisMonth(props: {
  today: string;
  context: DayContext;
  calendar: Calendar;
  facts: readonly MonthFact[];
  metric: Metric;
  locationId: string;
}): React.JSX.Element {
  const { today, context, calendar, facts, metric, locationId } = props;
  const town = calendar.town;
  const monthIndex = Number(today.slice(5, 7)) - 1;
  const monthName = MONTH_NAMES[monthIndex] ?? '';
  const items = monthItems(today, context);
  const profile = townProfile(town.townId);
  const index = profile?.series.index[monthIndex];
  const { phone } = useBreakpoint();
  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Eyebrow>{`${monthName} ${today.slice(0, 4)}`}</Eyebrow>
        <Heading>{`This month in ${town.name}`}</Heading>
      </View>
      <MonthGrid rows={monthGrid(today, context)} />
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
      {profile === null || index === undefined ? null : (
        <Stack gap={4}>
          <Small white>{`Food-service jobs in ${profile.county}, ${monthName} ${String(DATA_YEAR)}: ${fmt1(index)} (${String(DATA_YEAR)} average = 100).`}</Small>
          <Mono tone="text3">County, not town. Employment is a stand-in for demand.</Mono>
          {BLS === undefined ? null : <Link href={BLS.url} style={styles.source}>Source: U.S. Bureau of Labor Statistics, QCEW</Link>}
        </Stack>
      )}
      {facts.length === 0 ? null : (
        <Stack gap={4}>
          <Small white>{monthFactsHead(today)}</Small>
          {facts.map((fact) => <Small key={fact.year}>{monthFactLine(fact, metric)}</Small>)}
          <Mono tone="text3">Averages leave out closed days.</Mono>
        </Stack>
      )}
      <Stack gap={4}>
        <Small white>{PEOPLE_HEAD}</Small>
        <PeopleInTownSummary locationId={locationId} month={today.slice(0, 7)} />
      </Stack>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  root: { gap: theme.space[5] },
  head: { gap: theme.space[2] },
  list: { gap: theme.space[3] },
  item: { flexDirection: 'row', columnGap: theme.space[4], alignItems: 'flex-start' },
  itemPhone: { gap: 2 },
  date: { ...theme.type.ui, color: c.white, fontWeight: '600' },
  dateWide: { width: 112 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  source: { ...theme.type.mono, color: c.text2, minHeight: 44, lineHeight: 44, textDecorationLine: 'underline', textDecorationColor: c.line },
});
