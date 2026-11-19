import { useRef } from 'react';

import { ids } from '../ui/aria';
import { Button } from '../ui/Button';
import { CALENDARS_COPY } from './calendars';
import type { IcsImportProps } from './IcsImport';

// The calendar file picker on web (P28, spec 16.3 and 17; connect-owner-calendar design decision 11), inside the
// "Your calendars" popover (YourCalendars.tsx), which posts what it reads: "Import a calendar file", described by the
// id the popover gives it, opens the browser's file picker for an .ics file exported from Google Calendar, Outlook or
// Apple Calendar, or a calendar CSV (learn-from-calendar-bookings design decision 2), and the input is cleared after
// each choice so the same file can be chosen again. A file over 1 MB is refused unread; anything else is read with
// File.text() and handed on as its name and text. The client parses nothing: the API reads the file
// (api/src/calendar/ics.ts, which tells an .ics from a calendar CSV) and keeps its events. While the popover posts it the
// button reads "Importing…", disabled in place; under view-as it is disabled in place too, described by the popover's
// read-only line as well, since importing now writes. Native shows a line instead (IcsImport.tsx). The 1 MB awaits the
// team's sign-off (the [CONFIRM] in api/src/calendar/ics.ts).

const MAX_BYTES = 1024 * 1024;

export function IcsImport(props: IcsImportProps): React.JSX.Element {
  const { onFile, onRefusal } = props;
  const input = useRef<HTMLInputElement>(null);

  async function choose(file: File): Promise<void> {
    if (file.size > MAX_BYTES) { onRefusal(CALENDARS_COPY.tooLarge); return; }
    let text: string;
    try {
      text = await file.text();
    } catch {
      onRefusal(CALENDARS_COPY.unreadable);
      return;
    }
    onFile({ name: file.name, text });
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".ics,text/calendar,.csv,text/csv"
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
      <Button
        variant="outline"
        label={props.pending ? 'Importing…' : 'Import a calendar file'}
        disabled={props.pending || props.readOnlyId !== null}
        describedBy={ids(props.describedBy, props.readOnlyId) ?? props.describedBy}
        onPress={() => { input.current?.click(); }}
      />
    </>
  );
}
