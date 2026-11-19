import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../../theme';
import { shortDate } from '../../analytics/words';
import { fetchOwnerCalendarEvents, fetchOwnerCalendars, type BookingLabel, type OwnerCalendar, type OwnerCalendarEvent } from '../../calendar/api';
import { rowLines, statusWords } from '../../calendar/calendars';
import { monthBounds, monthLabel, stepMonth } from '../../calendar/model';
import { errorCopy } from '../../errors';
import { useBreakpoint, useLoad } from '../../hooks';
import { localToday, monthRange } from '../../locations/dates';
import { usePortal, useReadOnly } from '../../PortalProvider';
import { calendarHref, locationHref } from '../../routing';
import { useLocation } from '../../shell/LocationShell';
import { Actions, Button, LinkButton } from '../../ui/Button';
import { ErrorNotice, InlineNotice, LoadingLine } from '../../ui/feedback';
import { Section, Stack } from '../../ui/layout';
import { Select } from '../../ui/Select';
import { Heading, Mono, Small } from '../../ui/text';
import { agendaMonths, calendarEventItem, emptyMonthLine, FILE_MONTHS_BACK, monthsBefore, type AgendaItem } from './agenda';
import { BookingChoiceField, bookingsAccess, BookingsSummary } from './Bookings';
import { BOOKING_NAMES, BOOKINGS, choiceOf, emptyFilterLine, filterItems, FILTER_ALL, shortName, type BookingFilter } from './bookingWords';
import { CalendarAgenda } from './CalendarAgenda';
import { ITEM } from './copy';
import { EventMonth } from './EventMonth';
import { defaultDay, emptyDayLine, eventMonthRows, eventsOnDay } from './eventDays';

// A calendar's page in Your data (D49, calendar-detail): P27's route at the client-only ref `c_<calendarId>`, for a
// file, a link or a Google calendar alike. It reads the calendars list (GET .../owner-calendars) and the events route
// for one month at a time, never the data item route. Its name, kind and host as text ("Link, calendar.google.com, 12
// events"; never the link's address, which no answer holds, D33), the repeating events left out, its status and last
// refresh; then the month's events as an agenda (data/item/CalendarAgenda.tsx), today's month first, with Earlier and
// Later across the months the Calendar shows (a file calendar's Earlier goes back 36 months, as it keeps 3 years, D58).
// An unknown or removed calendar, or another organization's, is P27's not-found state, a line that stays on the page
// (InlineNotice, never a toast). Refresh and Remove stay in the Calendar's Your calendars, so one place manages
// calendars; a calendar with a status links there.
// A file calendar (one the list answers with `bookings`, D58) also has a Bookings section above its events
// (item/Bookings.tsx): its state, counts per label, Sort with TownwiseAI and Use for forecasts for an org admin, and
// their results. Its events then show each one's label, with a label filter over the month (All events, or one label),
// and for an org admin outside view-as a label choice under each card. A write's answer carries the calendar, which the
// page shows in place of the list's; a label set is kept for its event until a sort reads the month again.
// Wider than a phone (D62) the month's events are a month grid (item/EventMonth.tsx) under the month's name, Monday
// first, each day listing its events (a start time, a booking label's tag and the title cut to a line); the selected
// day (today in today's month, else the month's first day with an event) lists its events under the grid as the
// agenda's rows, with the label choice under each, and on web a hovered day's tooltip says its events in full. Phones
// (640px and below), where seven cells are too narrow to read, keep the month's agenda.

export function CalendarItem(props: { calendarId: string }): React.JSX.Element {
  const { api, me } = usePortal();
  const { location, org } = useLocation();
  const { line: readOnlyLine } = useReadOnly();
  const [today] = useState(localToday);
  const bounds = monthBounds(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  // The day chosen on the grid; null for the month's default day (D62).
  const [picked, setPicked] = useState<string | null>(null);
  const { phone } = useBreakpoint();
  const list = useLoad(useCallback(() => fetchOwnerCalendars(api, location.id), [api, location.id]));
  const events = useLoad(useCallback(() => fetchOwnerCalendarEvents(api, location.id, monthRange(month)), [api, location.id, month]));
  // What the bookings writes answered: the calendar, and each labeled event's label since the month was read.
  const [answered, setAnswered] = useState<OwnerCalendar | null>(null);
  const [labels, setLabels] = useState<ReadonlyMap<string, BookingLabel | null>>(new Map());
  const [filter, setFilter] = useState<BookingFilter>(FILTER_ALL);
  const onLabeled = useCallback((uid: string, booking: BookingLabel | null, calendar: OwnerCalendar) => {
    setAnswered(calendar);
    setLabels((current) => new Map(current).set(uid, booking));
  }, []);
  const reloadEvents = events.reload;
  const onSorted = useCallback(() => {
    setLabels(new Map());
    reloadEvents();
  }, [reloadEvents]);
  const back = <LinkButton variant="link" href={locationHref(location.id, 'data')} label={ITEM.back} />;

  if (list.state.status === 'loading') return <Section><LoadingLine text="Loading this calendar" /></Section>;
  if (list.state.status === 'failed') return <Section><ErrorNotice message={errorCopy(list.state.error)} onRetry={list.reload} />{back}</Section>;
  const listed = list.state.data.calendars.find((each) => each.id === props.calendarId) ?? null;
  if (listed === null) return <Section><InlineNotice text={ITEM.calendarGone} />{back}</Section>;
  const calendar = answered?.id === listed.id ? answered : listed;
  const bookings = calendar.bookings;
  const access = bookingsAccess({
    admin: org.role === 'org_admin', viewAs: me.viewAs !== null, openAsAdmin: me.openAsAdmin != null,
    sortAvailable: list.state.data.bookingSort.available,
  });
  const first = calendar.kind === 'file' ? monthsBefore(today.slice(0, 7), FILE_MONTHS_BACK) : bounds.first;

  const row = rowLines(calendar);
  const status = statusWords(calendar.status, calendar.kind);
  const mine: OwnerCalendarEvent[] = events.state.status === 'ready'
    ? events.state.data
      .filter((event) => event.calendarId === calendar.id)
      .map((event) => {
        const label = labels.get(event.uid);
        return label === undefined ? event : { ...event, booking: label, bookingBy: 'person' };
      })
    : [];
  const byKey = new Map(mine.map((event) => [`${event.calendarId}:${event.uid}`, event]));
  const shownEvents = bookings === null || filter === FILTER_ALL ? mine : mine.filter((event) => choiceOf(event.booking) === filter);
  const itemOf = (event: OwnerCalendarEvent): AgendaItem => {
    const item = calendarEventItem(location.id, event);
    if (bookings === null) return item;
    const choice = choiceOf(event.booking);
    const by = event.booking !== null && event.bookingBy === 'ai' ? ', suggested by TownwiseAI' : '';
    return { ...item, status: `${BOOKING_NAMES[choice]}${by}`, label: `${item.label} ${shortName(choice)}${by}.` };
  };
  const shown = agendaMonths(shownEvents.map(itemOf), month);
  const rows = eventMonthRows(month, today, shownEvents, bookings !== null);
  const selected = picked?.startsWith(month) === true ? picked : defaultDay(month, today, rows);
  const dayItems = eventsOnDay(selected, shownEvents).map(itemOf);
  const toMonth = (step: -1 | 1): void => {
    setMonth(stepMonth(month, step));
    setPicked(null);
  };
  const below = bookings === null || !access.canWrite ? undefined : (item: AgendaItem) => {
    const event = byKey.get(item.key);
    return event === undefined ? null : (
      <BookingChoiceField locationId={location.id} calendarId={calendar.id} event={event} item={item} onLabeled={onLabeled} />
    );
  };
  const empty = events.state.status === 'ready' && shown.length === 0
    ? (bookings !== null && filter !== FILTER_ALL && mine.length > 0 ? emptyFilterLine(filter, month) : emptyMonthLine(month))
    : null;
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
        {bookings === null ? null : (
          <>
            <Heading level={3}>{BOOKINGS.heading}</Heading>
            <BookingsSummary
              locationId={location.id}
              calendar={calendar}
              bookings={bookings}
              access={access}
              readOnlyLine={readOnlyLine}
              onCalendar={setAnswered}
              onSorted={onSorted}
            />
          </>
        )}
        <Heading level={3}>Events</Heading>
        <Actions>
          <Button
            variant="outline"
            label="Earlier"
            accessibilityLabel={`Earlier: ${monthLabel(stepMonth(month, -1))}`}
            disabled={month <= first}
            onPress={() => { toMonth(-1); }}
          />
          <Button
            variant="outline"
            label="Later"
            accessibilityLabel={`Later: ${monthLabel(stepMonth(month, 1))}`}
            disabled={month >= bounds.last}
            onPress={() => { toMonth(1); }}
          />
        </Actions>
        {bookings === null ? null : (
          <View style={styles.filter}>
            <Select
              label={BOOKINGS.filterField}
              value={filter}
              items={filterItems()}
              onChange={(value) => { setFilter(value as BookingFilter); }}
            />
          </View>
        )}
        {/* The grid draws only weekdays and day numbers, so the month it shows is named here (a phone's agenda heads its list). */}
        {phone ? null : <Heading level={4}>{monthLabel(month)}</Heading>}
        {events.state.status === 'loading' ? <LoadingLine text={`Loading ${monthLabel(month)}`} /> : null}
        {events.state.status === 'failed' ? <ErrorNotice message={errorCopy(events.state.error)} onRetry={events.reload} /> : null}
        {empty === null ? null : <Small>{empty}</Small>}
        {phone ? (
          shown.length === 0 ? null : <CalendarAgenda months={shown} label={`${calendar.label} events`} {...(below === undefined ? {} : { below })} />
        ) : events.state.status === 'failed' ? null : (
          <>
            <EventMonth
              rows={rows}
              selected={selected}
              onSelect={setPicked}
              label={`${calendar.label}, ${monthLabel(month)}`}
              busy={events.state.status === 'loading'}
            />
            {shown.length === 0 ? null : dayItems.length === 0 ? <Small>{emptyDayLine(selected)}</Small> : (
              <CalendarAgenda
                months={[{ month: selected, label: shortDate(selected), items: dayItems }]}
                label={`${calendar.label} events`}
                {...(below === undefined ? {} : { below })}
              />
            )}
          </>
        )}
      </Stack>
    </Section>
  );
}

const styles = StyleSheet.create({
  facts: { gap: theme.space[1], minWidth: 0 },
  filter: { maxWidth: 360 },
});
