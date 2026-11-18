import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../../theme';
import { fetchOwnerCalendarEvents, fetchOwnerCalendars } from '../../calendar/api';
import { rowLines, statusWords } from '../../calendar/calendars';
import { monthBounds, monthLabel, stepMonth } from '../../calendar/model';
import { errorCopy } from '../../errors';
import { useLoad } from '../../hooks';
import { localToday, monthRange } from '../../locations/dates';
import { usePortal } from '../../PortalProvider';
import { calendarHref, locationHref } from '../../routing';
import { useLocation } from '../../shell/LocationShell';
import { Actions, Button, LinkButton } from '../../ui/Button';
import { ErrorNotice, InlineNotice, LoadingLine } from '../../ui/feedback';
import { Section, Stack } from '../../ui/layout';
import { Heading, Mono, Small } from '../../ui/text';
import { agendaMonths, calendarEventItem, emptyMonthLine } from './agenda';
import { CalendarAgenda } from './CalendarAgenda';
import { ITEM } from './copy';

// A calendar's page in Your data (D49, calendar-detail): P27's route at the client-only ref `c_<calendarId>`, for a
// file, a link or a Google calendar alike. It reads the calendars list (GET .../owner-calendars) and the events route
// for one month at a time, never the data item route. Its name, kind and host as text ("Link, calendar.google.com, 12
// events"; never the link's address, which no answer holds, D33), the repeating events left out, its status and last
// refresh; then the month's events as an agenda (data/item/CalendarAgenda.tsx), today's month first, with Earlier and
// Later across the months the Calendar shows. An unknown or removed calendar, or another organization's, is P27's
// not-found state, a line that stays on the page (InlineNotice, never a toast). Refresh and Remove stay in the
// Calendar's Your calendars, so one place manages calendars; a calendar with a status links there.

export function CalendarItem(props: { calendarId: string }): React.JSX.Element {
  const { api } = usePortal();
  const { location } = useLocation();
  const [today] = useState(localToday);
  const bounds = monthBounds(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const list = useLoad(useCallback(() => fetchOwnerCalendars(api, location.id), [api, location.id]));
  const events = useLoad(useCallback(() => fetchOwnerCalendarEvents(api, location.id, monthRange(month)), [api, location.id, month]));
  const back = <LinkButton variant="link" href={locationHref(location.id, 'data')} label={ITEM.back} />;

  if (list.state.status === 'loading') return <Section><LoadingLine text="Loading this calendar" /></Section>;
  if (list.state.status === 'failed') return <Section><ErrorNotice message={errorCopy(list.state.error)} onRetry={list.reload} />{back}</Section>;
  const calendar = list.state.data.calendars.find((each) => each.id === props.calendarId) ?? null;
  if (calendar === null) return <Section><InlineNotice text={ITEM.calendarGone} />{back}</Section>;

  const row = rowLines(calendar);
  const status = statusWords(calendar.status, calendar.kind);
  const shown = events.state.status === 'ready'
    ? agendaMonths(events.state.data.filter((event) => event.calendarId === calendar.id).map((event) => calendarEventItem(location.id, event)), month)
    : [];
  return (
    <Section title={calendar.label}>
      <Stack>
        {back}
        <View style={styles.facts}>
          <Mono>{row.summary}</Mono>
          {row.repeating === null ? null : <Small>{row.repeating}</Small>}
          {status === null ? null : <Small white>{status}</Small>}
          {status === null ? null : <LinkButton variant="link" href={calendarHref(location.id)} label={ITEM.manageCalendars} />}
          {row.updated === null ? null : <Mono>{row.updated}</Mono>}
        </View>
        <Heading level={3}>Events</Heading>
        <Actions>
          <Button
            variant="outline"
            label="Earlier"
            accessibilityLabel={`Earlier: ${monthLabel(stepMonth(month, -1))}`}
            disabled={month <= bounds.first}
            onPress={() => { setMonth(stepMonth(month, -1)); }}
          />
          <Button
            variant="outline"
            label="Later"
            accessibilityLabel={`Later: ${monthLabel(stepMonth(month, 1))}`}
            disabled={month >= bounds.last}
            onPress={() => { setMonth(stepMonth(month, 1)); }}
          />
        </Actions>
        {events.state.status === 'loading' ? <LoadingLine text={`Loading ${monthLabel(month)}`} /> : null}
        {events.state.status === 'failed' ? <ErrorNotice message={errorCopy(events.state.error)} onRetry={events.reload} /> : null}
        {events.state.status === 'ready' && shown.length === 0 ? <Small>{emptyMonthLine(month)}</Small> : null}
        {shown.length === 0 ? null : <CalendarAgenda months={shown} label={`${calendar.label} events`} />}
      </Stack>
    </Section>
  );
}

const styles = StyleSheet.create({
  facts: { gap: theme.space[1], minWidth: 0 },
});
