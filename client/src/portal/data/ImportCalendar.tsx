import { useCallback, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { addOwnerCalendar, fetchOwnerCalendars } from '../calendar/api';
import { addedLines, addRefusal, CALENDARS_COPY, labelOfFile, WEEKLY_TITLES_NOTICE } from '../calendar/calendars';
import { IcsImport } from '../calendar/IcsImport';
import { useAction, useLoad } from '../hooks';
import { usePortal } from '../PortalProvider';
import { Messages, Notice } from '../ui/feedback';
import { Small } from '../ui/text';

// "Import a calendar file" at the top of Your data's list (D60, kept by D61 when the Calendars group went: calendars
// are items of the list, in its Calendars folder). The weekly reading's words (CALENDARS_COPY.weeklyReading, as in
// Your calendars) and the same import (IcsImport: the file picker on web, native's line pointing to the web, which also
// names connecting a Google calendar while those are on, so native reads the calendars list for that), posted as Your
// calendars posts it, `titlesNotice` included since this shows those words; any member, open as admin included. What
// it did is a toast (D55), a refusal says why here, and `onAdded` reads the list again so the calendar shows in it.
// Under view-as the button stays in place, disabled, described by the page's read-only line (`readOnlyId`). Shown with
// stored files off too: calendars are not stored files.

const HELP_ID = 'data-calendars-help';

export function ImportCalendar(props: { locationId: string; readOnlyId: string | null; onAdded: () => void }): React.JSX.Element {
  const { api } = usePortal();
  const { locationId, onAdded } = props;
  const google = useLoad(useCallback(
    () => (Platform.OS === 'web' ? Promise.resolve(false) : fetchOwnerCalendars(api, locationId).then((list) => list.google.available)),
    [api, locationId],
  ));
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
    onAdded();
  }, [api, locationId, onAdded]));
  const onRefusal = useCallback((words: string) => { setResult(null); setRefusal(words); }, []);

  return (
    <View style={styles.root}>
      {result === null ? null : <Notice text={result.text} result={result} />}
      <Small nativeID={HELP_ID}>{CALENDARS_COPY.weeklyReading}</Small>
      <View style={styles.actions}>
        <IcsImport
          describedBy={HELP_ID}
          pending={importFile.pending}
          readOnlyId={props.readOnlyId}
          onFile={importFile.run}
          onRefusal={onRefusal}
          google={google.state.status === 'ready' && google.state.data}
        />
      </View>
      {refusal === null ? null : <Messages live="alert" items={[refusal]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: theme.space[2] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
});
