import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../../theme';
import { useAction } from '../../hooks';
import { usePortal } from '../../PortalProvider';
import { itemHref } from '../../routing';
import { Actions, Button, LinkButton } from '../../ui/Button';
import { Messages } from '../../ui/feedback';
import { Small } from '../../ui/text';
import { isUnimportedCalendarFile, retryCalendar, type DataItem } from '../api';
import { dataError } from '../copy';
import { CALENDAR_IMPORT, calendarImportLine } from './copy';

// What importing a calendar file kept in Your data did (D60, P27), under the item's status lines, on web and native:
// "Added to your calendars as {label}: {n} events." with "Open the calendar" (the calendar's own page, P27 at
// `c_<calendarId>`); that its calendar was removed since; or why it wasn't added, with "Try again" while the API says a
// retry may mend it (the location had 5 calendars, or the file couldn't be read). Try again posts
// POST .../data/:ref/calendar and shows the item it answers, whose line says how it went, refused again included; a
// failed request says why under the button. Under view-as Try again stays in place, disabled, described by the page's
// read-only line (`readOnlyId`). Nothing shows for an item that is no calendar file.
//
// UI review 2026-11-19: a calendar file kept before D60 (no import record) says so, with "Import as a calendar" while its
// original is kept, through the same POST (the API imports such a file once), or that its original was deleted. Add a
// file shows this part too, beside a calendar file it just added.

export function CalendarImport(props: {
  item: DataItem;
  /** The page's read-only line under view-as, else null. */
  readOnlyId: string | null;
  /** Shows the item Try again answers, then reads it again. */
  showItem: (item: DataItem) => void;
}): React.JSX.Element | null {
  const { api } = usePortal();
  const { item, showItem } = props;
  const retry = useAction(useCallback(async () => {
    showItem(await retryCalendar(api, item.locationId, item.ref));
  }, [api, item.locationId, item.ref, showItem]));
  const calendar = item.calendar ?? null;
  const disabled = retry.pending || props.readOnlyId !== null;
  const describedBy = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };
  const error = retry.error === null ? null : <Messages live="alert" items={[dataError(retry.error)]} />;
  if (calendar === null) {
    if (!isUnimportedCalendarFile(item)) return null;
    const kept = item.file?.rawAvailable === true;
    return (
      <View style={styles.root}>
        <Small>{kept ? CALENDAR_IMPORT.unimported : CALENDAR_IMPORT.unimportedGone}</Small>
        {kept ? (
          <Actions>
            <Button
              variant="outline" label={retry.pending ? CALENDAR_IMPORT.importingOld : CALENDAR_IMPORT.importOld} disabled={disabled} {...describedBy}
              onPress={retry.run}
            />
          </Actions>
        ) : null}
        {error}
      </View>
    );
  }
  return (
    <View style={styles.root}>
      <Small>{calendarImportLine(calendar)}</Small>
      {calendar.status === 'added'
        ? <LinkButton variant="link" href={itemHref(item.locationId, `c_${calendar.calendarId}`)} label={CALENDAR_IMPORT.open} />
        : null}
      {calendar.status === 'refused' && calendar.retry ? (
        <Actions>
          <Button
            variant="outline"
            label={retry.pending ? CALENDAR_IMPORT.retrying : CALENDAR_IMPORT.retry}
            disabled={disabled}
            {...describedBy}
            onPress={retry.run}
          />
        </Actions>
      ) : null}
      {error}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: theme.space[1] },
});
