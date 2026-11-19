import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { addOwnerCalendar, fetchOwnerCalendars } from '../calendar/api';
import { addedLines, addRefusal, CALENDARS_COPY, labelOfFile, rowLines, WEEKLY_TITLES_NOTICE } from '../calendar/calendars';
import { IcsImport } from '../calendar/IcsImport';
import { useAction, useLoad } from '../hooks';
import { usePortal } from '../PortalProvider';
import { itemHref } from '../routing';
import { LinkButton } from '../ui/Button';
import { Messages, Notice } from '../ui/feedback';
import { Heading, Mono, Small } from '../ui/text';

// Your data's Calendars group (D49, calendar-detail): the location's own calendars, from the list the Calendar reads
// (GET .../owner-calendars, at most 5), each opening its page, P27 at `c_<calendarId>` (item/CalendarItem.tsx). Each row
// is its name, then its kind and host as text, its count and last refresh; "No calendars yet." with none. Hidden while
// it loads and if the read fails; shown with stored files off, since calendars are not stored files. It is read again
// whenever `stamp` changes (a file finished uploading on Your data, which may have been imported as a calendar, D60).
// D60: under the list, the weekly reading's words (CALENDARS_COPY.weeklyReading, as in Your calendars) and "Import a
// calendar file", the same import (IcsImport: the file picker on web, native's line pointing to the web), posted as
// Your calendars posts it, `titlesNotice` included since this group shows those words; any member, open as admin
// included. What it did is a toast (D55), and a refusal says why in the group; the list is read again after an add.
// Under view-as the button stays in place, disabled, described by the page's read-only line (`readOnlyId`).

const HELP_ID = 'data-calendars-help';

export function CalendarsGroup(props: { locationId: string; readOnlyId: string | null; stamp: number }): React.JSX.Element | null {
  const { api } = usePortal();
  const { locationId, stamp } = props;
  const { state, reload } = useLoad(useCallback(() => fetchOwnerCalendars(api, locationId), [api, locationId]));
  useEffect(() => { if (stamp > 0) reload(); }, [stamp, reload]);
  // The list as last read, kept on screen while it is read again, so the group and its button stay put.
  const [shown, setShown] = useState<Awaited<ReturnType<typeof fetchOwnerCalendars>> | null>(null);
  if (state.status === 'ready' && shown !== state.data) setShown(state.data);
  // The last import's result (a new object each time, so the same words toast again) or refusal.
  const [result, setResult] = useState<{ text: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const importFile = useAction(useCallback(async (file: { name: string; text: string }) => {
    setResult(null);
    setRefusal(null);
    try {
      const added = await addOwnerCalendar(api, locationId, { kind: 'file', label: labelOfFile(file.name), ics: file.text, titlesNotice: WEEKLY_TITLES_NOTICE });
      setResult({ text: addedLines(added.calendar, added.skippedRows).join(' ') });
    } catch (error) {
      setRefusal(addRefusal(error, 'file', Platform.OS === 'web' ? 'web' : 'native'));
      return;
    }
    reload();
  }, [api, locationId, reload]));
  const onRefusal = useCallback((words: string) => { setResult(null); setRefusal(words); }, []);

  const data = state.status === 'ready' ? state.data : shown;
  if (state.status === 'failed' || data === null) return null;
  return (
    <View style={styles.root}>
      <Heading level={3}>Calendars</Heading>
      {result === null ? null : <Notice text={result.text} result={result} />}
      {data.calendars.length === 0 ? <Small>{CALENDARS_COPY.none}</Small> : (
        <View role="list" aria-label="Calendars" style={styles.list}>
          {data.calendars.map((calendar) => {
            const row = rowLines(calendar);
            return (
              <View key={calendar.id} role="listitem" style={styles.row}>
                <LinkButton href={itemHref(locationId, `c_${calendar.id}`)} label={calendar.label} accessibilityLabel={`${calendar.label}. ${row.summary}`} />
                <Mono>{row.summary}</Mono>
                {row.updated === null ? null : <Mono tone="text3">{row.updated}</Mono>}
              </View>
            );
          })}
        </View>
      )}
      <Small nativeID={HELP_ID}>{CALENDARS_COPY.weeklyReading}</Small>
      <View style={styles.actions}>
        <IcsImport
          describedBy={HELP_ID}
          pending={importFile.pending}
          readOnlyId={props.readOnlyId}
          onFile={importFile.run}
          onRefusal={onRefusal}
          google={data.google.available}
        />
      </View>
      {refusal === null ? null : <Messages live="alert" items={[refusal]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: theme.space[2] },
  list: { gap: theme.space[3] },
  row: { gap: 0, minWidth: 0 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
});
