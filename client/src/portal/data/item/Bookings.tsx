import { useCallback, useId } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../../theme';
import {
  confirmBookings, labelBooking, sortBookings, type BookingLabel, type CalendarBookings, type OwnerCalendar, type OwnerCalendarEvent,
} from '../../calendar/api';
import { useAction } from '../../hooks';
import { usePortal } from '../../PortalProvider';
import { Actions, Button } from '../../ui/Button';
import { DefinitionList } from '../../ui/DataTable';
import { ErrorNotice, Notice, ReadOnlyLine, useNoticeState } from '../../ui/feedback';
import { Select } from '../../ui/Select';
import { Small } from '../../ui/text';
import type { AgendaItem } from './agenda';
import {
  BOOKING_NAMES, BOOKINGS, bookingsError, bookingsStateLine, choiceItems, choiceOf, confirmedLines, countRows, labeledLine, sortedLines,
  type BookingChoice,
} from './bookingWords';

// The Bookings section of a file calendar's page in Your data (D58, learn-from-calendar-bookings design decisions 7,
// 10, 11 and 15), web and native: the calendar's state and its counts per label, then for an org admin outside
// view-as Use for forecasts, and Sort with TownwiseAI while the list answers `bookingSort.available`, with its words
// shown before the press and describing it (staff open as admin get a line in its place: Sort sends customers' names to
// Anthropic). `BookingChoiceField` is an event's label choice under its card, for an org admin outside view-as (staff
// open as admin included). Each write's answer carries the calendar, which the page then shows (`onCalendar`); a sort
// also reads the month's events again (`onSorted`). What a write did is a toast; a refusal stays in the section.
// Members and view-as read the counts and labels only, with view-as's read-only line.

/** Who may do what in the section, from the caller's role, view-as and open as admin. */
export interface BookingsAccess {
  /** Label events and press Use for forecasts: an org admin outside view-as. */
  canWrite: boolean;
  /** Sort with TownwiseAI: shown, replaced by the staff line, or not shown (members, view-as, no model key). */
  sort: 'show' | 'staff' | 'hide';
}

export function bookingsAccess(input: { admin: boolean; viewAs: boolean; openAsAdmin: boolean; sortAvailable: boolean }): BookingsAccess {
  const canWrite = input.admin && !input.viewAs;
  const sort = !canWrite || !input.sortAvailable ? 'hide' : input.openAsAdmin ? 'staff' : 'show';
  return { canWrite, sort };
}

export function BookingsSummary(props: {
  locationId: string;
  calendar: OwnerCalendar;
  bookings: CalendarBookings;
  access: BookingsAccess;
  /** Under view-as, “Read-only while viewing as …”; '' otherwise. */
  readOnlyLine: string;
  onCalendar: (calendar: OwnerCalendar) => void;
  onSorted: () => void;
}): React.JSX.Element {
  const { api } = usePortal();
  const { locationId, calendar, onCalendar, onSorted } = props;
  const explainId = `${useId().replace(/:/g, '')}-sort`;
  const [notice, setNotice] = useNoticeState();

  const sort = useAction(useCallback(async () => {
    setNotice(null);
    const result = await sortBookings(api, locationId, calendar.id);
    onCalendar(result.calendar);
    onSorted();
    setNotice(sortedLines(result).join(' '));
  }, [api, locationId, calendar.id, onCalendar, onSorted, setNotice]));

  const confirm = useAction(useCallback(async () => {
    setNotice(null);
    const result = await confirmBookings(api, locationId, calendar.id);
    onCalendar(result.calendar);
    setNotice(confirmedLines(result).join(' '));
  }, [api, locationId, calendar.id, onCalendar, setNotice]));

  const busy = sort.pending || confirm.pending;
  const error = sort.error ?? confirm.error;
  return (
    <View style={styles.summary}>
      <Small white>{bookingsStateLine(props.bookings)}</Small>
      <DefinitionList items={countRows(props.bookings.counts)} />
      <ReadOnlyLine text={props.readOnlyLine} />
      {props.access.sort === 'show' ? <Small nativeID={explainId}>{BOOKINGS.sortExplain}</Small> : null}
      {props.access.sort === 'staff' ? <Small>{BOOKINGS.staffNoSort}</Small> : null}
      {props.access.canWrite ? (
        <Actions>
          {props.access.sort === 'show' ? (
            <Button
              variant="outline"
              label={sort.pending ? BOOKINGS.sorting : BOOKINGS.sort}
              describedBy={explainId}
              disabled={busy}
              onPress={() => { sort.run(); }}
            />
          ) : null}
          <Button
            variant="outline"
            label={confirm.pending ? BOOKINGS.confirming : BOOKINGS.confirm}
            disabled={busy}
            onPress={() => { confirm.run(); }}
          />
        </Actions>
      ) : null}
      {notice === null ? null : <Notice text={notice.text} result={notice} />}
      {error === null ? null : <ErrorNotice message={bookingsError(error)} />}
    </View>
  );
}

/** An event's label choice, under its card: a PATCH with its uid in the body, then the answer's calendar. */
export function BookingChoiceField(props: {
  locationId: string;
  calendarId: string;
  event: OwnerCalendarEvent;
  item: AgendaItem;
  onLabeled: (uid: string, booking: BookingLabel | null, calendar: OwnerCalendar) => void;
}): React.JSX.Element {
  const { api } = usePortal();
  const { locationId, calendarId, event, onLabeled } = props;
  const [notice, setNotice] = useNoticeState();
  const label = useAction(useCallback(async (choice: BookingChoice) => {
    setNotice(null);
    const booking = choice === 'none' ? null : choice;
    const result = await labelBooking(api, locationId, calendarId, { uid: event.uid, booking });
    onLabeled(event.uid, booking, result.calendar);
    setNotice(labeledLine(event.title, choice, result));
  }, [api, locationId, calendarId, event.uid, event.title, onLabeled, setNotice]));
  return (
    <View style={styles.choice}>
      <Select
        label={BOOKINGS.labelField}
        accessibilityLabel={`${BOOKINGS.labelField} for ${event.title}, ${props.item.when}`}
        value={choiceOf(event.booking)}
        items={choiceItems()}
        readOnly={label.pending}
        onChange={(value) => { if (Object.hasOwn(BOOKING_NAMES, value)) label.run(value as BookingChoice); }}
      />
      {notice === null ? null : <Notice text={notice.text} result={notice} />}
      {label.error === null ? null : <ErrorNotice message={bookingsError(label.error)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { gap: theme.space[2], minWidth: 0 },
  choice: { gap: theme.space[1], marginTop: theme.space[1], maxWidth: 360 },
});
