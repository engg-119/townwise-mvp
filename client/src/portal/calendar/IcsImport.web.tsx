import { useId, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatCount, plural } from '../format';
import { Button } from '../ui/Button';
import { Messages } from '../ui/feedback';
import { Small } from '../ui/text';
import { parseIcs } from './ics';
import type { IcsImportProps } from './IcsImport';

// The owner's calendar file on web (P28, spec 16.3 and 17): "Import a calendar file" opens the browser's file
// picker for an .ics file exported from Google Calendar, Outlook or Apple Calendar. A file over 1 MB is refused
// unread; anything else is read with File.text() and parsed here (ics.ts). The events go to the page, which keeps
// them in memory only: nothing is stored or sent, and they are gone on reload or on leaving the page. Allowed under
// view-as, since it reads a file in the viewer's own browser. Native shows a line instead (IcsImport.tsx). The 1 MB
// and 2,000 events await the team's sign-off (the [CONFIRM] in ics.ts).
//
// It sits in the header row's trailing slot and returns its pieces as the row's own items: the button (described by
// the help), "How importing works" (aria-expanded, aria-controls; the help stays mounted while hidden, so the
// button's description always resolves) and a full-width line under the row, shown only when it has something to
// say: the help while open, and the result and refusals whether the help is open or not. That line is the last item,
// so a control the page passes before this one stays in the row. [CONFIRM: the import help behind "How importing works"]

const MAX_BYTES = 1024 * 1024;

export const ICS_COPY = {
  help: 'Export a calendar from Google Calendar, Outlook or Apple Calendar as an .ics file and choose it here. Townwise reads it in your browser and keeps it only while this page is open. Nothing from the file is sent to Townwise unless you make a note from an event.',
  tooLarge: 'This file is over 1 MB. Export a shorter range of your calendar.',
  notCalendar: 'This doesn’t look like a calendar file (.ics).',
  unreadable: 'Couldn’t read this file. Choose it again.',
};

/** “2 events from kitchen.ics.”, and the repeating events it left out. */
function importedLines(fileName: string, count: number, skipped: number): string[] {
  const lines = [`${plural(count, 'event', 'events')} from ${fileName}.`];
  if (skipped === 1) lines.push('1 repeating event wasn’t imported. Add it as a note with weekdays.');
  if (skipped > 1) lines.push(`${formatCount(skipped)} repeating events weren’t imported. Add them as notes with weekdays.`);
  return lines;
}

export function IcsImport(props: IcsImportProps): React.JSX.Element {
  const { today, imported, onImport } = props;
  const input = useRef<HTMLInputElement>(null);
  const helpId = `${useId().replace(/:/g, '')}-help`;
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function choose(file: File): Promise<void> {
    if (file.size > MAX_BYTES) { setError(ICS_COPY.tooLarge); return; }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError(ICS_COPY.unreadable);
      return;
    }
    const result = parseIcs(text, today);
    if ('error' in result) { setError(ICS_COPY.notCalendar); return; }
    setError(null);
    onImport({ fileName: file.name, events: result.events, skipped: result.skippedRepeating });
  }

  const hasMessages = error !== null || imported !== null;
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".ics,text/calendar"
        tabIndex={-1}
        aria-hidden="true"
        style={{ display: 'none' }}
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          // Clear the control so the same file can be chosen again.
          event.currentTarget.value = '';
          if (chosen !== undefined) void choose(chosen);
        }}
      />
      <Button variant="outline" label="Import a calendar file" describedBy={helpId} onPress={() => { input.current?.click(); }} />
      <Pressable
        role="button"
        aria-expanded={open}
        {...{ 'aria-controls': helpId }}
        onPress={() => { setOpen((value) => !value); }}
        style={styles.toggle}
      >
        <Text style={styles.toggleText}>How importing works</Text>
      </Pressable>
      <View style={[styles.line, open || hasMessages ? null : styles.hidden]}>
        <Small nativeID={helpId} style={open ? styles.help : styles.hidden}>{ICS_COPY.help}</Small>
        {error === null ? null : <Messages live="alert" items={[error]} />}
        {imported === null ? null : <Messages live="status" items={importedLines(imported.fileName, imported.events.length, imported.skipped)} />}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  toggle: { minHeight: 44, justifyContent: 'center' },
  toggleText: { ...theme.type.ui, color: theme.color.white, textDecorationLine: 'underline', textDecorationColor: theme.color.line },
  line: { flexBasis: '100%', gap: theme.space[2] },
  help: { maxWidth: 680 },
  hidden: { display: 'none' },
});
