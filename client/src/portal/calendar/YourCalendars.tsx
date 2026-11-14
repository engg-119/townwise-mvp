import { useCallback, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { useAction } from '../hooks';
import { usePortal } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { Button } from '../ui/Button';
import { ErrorNotice, Messages } from '../ui/feedback';
import { Small } from '../ui/text';
import { addOwnerCalendar, type OwnerCalendar } from './api';
import { addedLines, addRefusal, CALENDARS_COPY, labelOfFile } from './calendars';
import { IcsImport } from './IcsImport';

// "Your calendars" (P28, spec 16.3 and 17, D33; connect-owner-calendar design decision 11), one file for web and
// native: the header row's last control and its panel, which Toolbar's `trailing` places as the row's own items. The
// button reads "Your calendars (N)", N the location's calendar count, or "Your calendars" with none or when the list
// couldn't be read. It is a disclosure (aria-expanded and aria-controls on web, an expanded state on native), closed on
// every load. The panel is the row's last item and full width, so it opens under the row, above the grid. It stays
// mounted while closed (display: none), so aria-controls always resolves and a shown message survives closing it, and
// closed it takes no height, so nothing under the row moves. Top to bottom: the list (the calendars' names; "No
// calendars yet." with none; "Couldn't load your calendars." with Try again, which reads the list and the grid's stored
// events again, when the list couldn't be read), the messages line (results as status, refusals as alerts), the import
// (IcsImport: the file picker on web, native's line pointing to it), and "How importing works" with its help, mounted
// while hidden and describing the import. A chosen file is posted as `{ kind: 'file', label, ics }` (the label from
// its name, labelOfFile), with "Importing…" meanwhile; the API parses and keeps it, and on its 201 the page reads the
// list and the grid's stored events again and turns "Your calendar" on (`onChanged(true)`). A refusal stores nothing
// and reads nothing again. [CONFIRM: the import help behind "How importing works"]

const PANEL_ID = 'your-calendars';
const HELP_ID = 'your-calendars-help';

export interface YourCalendarsProps {
  /** The location's calendars, oldest first; null before the list's first answer. */
  calendars: OwnerCalendar[] | null;
  /** The list's last read failed. */
  failed: boolean;
  /** Reads the list and the grid's stored events again. */
  onRetry: () => void;
  /** After a calendar is added (`added`), refreshed or removed: the page reads the list and the stored events again. */
  onChanged: (added: boolean) => void;
}

/** The messages line: what the last import did, or why it was refused. */
type Message = { live: 'status' | 'alert'; items: string[] } | null;

export function YourCalendars(props: YourCalendarsProps): React.JSX.Element {
  const { onChanged } = props;
  const { api } = usePortal();
  const { location } = useLocation();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const list = props.failed ? null : props.calendars;
  const count = list === null ? 0 : list.length;
  const platform = Platform.OS === 'web' ? 'web' : 'native';

  const importFile = useAction(useCallback(async (file: { name: string; text: string }) => {
    setMessage(null);
    let added: OwnerCalendar;
    try {
      added = await addOwnerCalendar(api, location.id, { kind: 'file', label: labelOfFile(file.name), ics: file.text });
    } catch (error) {
      setMessage({ live: 'alert', items: [addRefusal(error, 'file', platform)] });
      return;
    }
    setMessage({ live: 'status', items: addedLines(added) });
    onChanged(true);
  }, [api, location.id, platform, onChanged]));

  return (
    <>
      <Button
        variant="outline"
        label={count === 0 ? 'Your calendars' : `Your calendars (${String(count)})`}
        expanded={open}
        controls={PANEL_ID}
        onPress={() => { setOpen((value) => !value); }}
      />
      <View role="region" aria-label="Your calendars" nativeID={PANEL_ID} style={[styles.panel, open ? null : styles.hidden]}>
        {/* The region is full width; its text is one column of at most 680px (design decision 11). */}
        <View style={styles.column}>
          {/* Only while open: on iOS an ErrorNotice is announced as it mounts, and a closed panel's would be heard unseen. */}
          {props.failed && open ? <ErrorNotice message="Couldn’t load your calendars." onRetry={props.onRetry} /> : null}
          {list === null ? null : list.length === 0 ? <Small>{CALENDARS_COPY.none}</Small> : (
            <View style={styles.list}>
              {list.map((calendar) => <Small key={calendar.id} white>{calendar.label}</Small>)}
            </View>
          )}
          {message === null ? null : <Messages live={message.live} items={message.items} />}
          <IcsImport
            describedBy={HELP_ID}
            pending={importFile.pending}
            onFile={importFile.run}
            onRefusal={(words) => { setMessage({ live: 'alert', items: [words] }); }}
          />
          <Button variant="link" label="How importing works" expanded={helpOpen} controls={HELP_ID} onPress={() => { setHelpOpen((value) => !value); }} />
          <Small nativeID={HELP_ID} style={helpOpen ? null : styles.hidden}>{CALENDARS_COPY.help}</Small>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  panel: { flexBasis: '100%' },
  column: { maxWidth: 680, gap: theme.space[3] },
  list: { gap: theme.space[2] },
  hidden: { display: 'none' },
});
