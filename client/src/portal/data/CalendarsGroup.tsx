import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { fetchOwnerCalendars } from '../calendar/api';
import { rowLines } from '../calendar/calendars';
import { useLoad } from '../hooks';
import { usePortal } from '../PortalProvider';
import { itemHref } from '../routing';
import { LinkButton } from '../ui/Button';
import { Heading, Mono } from '../ui/text';

// Your data's Calendars group (D49, calendar-detail): the location's own calendars, from the list the Calendar reads
// (GET .../owner-calendars, at most 5), each opening its page, P27 at `c_<calendarId>` (item/CalendarItem.tsx). Each row
// is its name, then its kind and host as text, its count and last refresh. Hidden while it loads, if the read fails, and
// with no calendar; shown with stored files off, since calendars are not stored files.

export function CalendarsGroup(props: { locationId: string }): React.JSX.Element | null {
  const { api } = usePortal();
  const { state } = useLoad(useCallback(() => fetchOwnerCalendars(api, props.locationId), [api, props.locationId]));
  if (state.status !== 'ready' || state.data.calendars.length === 0) return null;
  return (
    <View style={styles.root}>
      <Heading level={3}>Calendars</Heading>
      <View role="list" aria-label="Calendars" style={styles.list}>
        {state.data.calendars.map((calendar) => {
          const row = rowLines(calendar);
          return (
            <View key={calendar.id} role="listitem" style={styles.row}>
              <LinkButton href={itemHref(props.locationId, `c_${calendar.id}`)} label={calendar.label} accessibilityLabel={`${calendar.label}. ${row.summary}`} />
              <Mono>{row.summary}</Mono>
              {row.updated === null ? null : <Mono tone="text3">{row.updated}</Mono>}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: theme.space[2] },
  list: { gap: theme.space[3] },
  row: { gap: 0, minWidth: 0 },
});
