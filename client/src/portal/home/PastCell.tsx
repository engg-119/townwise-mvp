import { StyleSheet, View } from 'react-native';

import { pastDayPhrase, vsUsualDayPhrase, type PastDay } from '../analytics/week';
import type { Metric } from '../analytics/words';
import { PhraseParts } from '../ui/PhraseParts';
import { Mono, Small } from '../ui/text';

// A day in a past year, as This week's rows, This week's chart panel and This month's day detail show it. Its own file,
// so ThisWeek.tsx, WeekChart.tsx and DayDetail.tsx import it without importing each other in a circle.

/** A day in a past year: "Sat, Nov 8, 2025: 241 guests", closed, against usual, and its holidays and events. */
export function PastCell(props: { day: PastDay; metric: Metric }): React.JSX.Element {
  const { day, metric } = props;
  const line = pastDayPhrase(day, metric);
  if (line === null) return <Mono tone="text3">No data</Mono>;
  const change = vsUsualDayPhrase(day);
  return (
    <View style={styles.item}>
      <Mono tone="white"><PhraseParts phrase={line} /></Mono>
      {day.closed ? <Mono>{day.likelyClosed ? 'Likely closed' : 'Closed'}</Mono> : null}
      {change === null ? null : <Mono><PhraseParts phrase={change} /></Mono>}
      {day.events.map((title) => <Small key={title}>{title}</Small>)}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { gap: 2, minWidth: 0 },
});
