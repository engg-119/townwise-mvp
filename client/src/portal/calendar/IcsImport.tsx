import { Mono } from '../ui/text';
import { nativeLine } from './calendars';

// The calendar file import on native (P28, spec 16.3; connect-owner-calendar design decision 11): no file picker is
// installed, so the "Your calendars" popover says where to import one instead, in the place web's "Import a calendar
// file" has, which while Google calendars are on also points to the web for connecting one. Web has its own file
// (IcsImport.web.tsx), which takes the same props. The siblings share only this type: on web a value exported here
// would resolve to the .web file itself, so their words are in calendars.ts.

export interface IcsImportProps {
  /** The id of the popover's help, which describes the import button (web). */
  describedBy: string;
  /** While the popover posts the file chosen last: the button reads "Importing…", disabled (web). */
  pending: boolean;
  /** Under view-as, the popover's read-only line: the button stays in place, disabled and described by it (web). */
  readOnlyId: string | null;
  /** A file of at most 1 MB, read: its name and its text, which the API parses. */
  onFile: (file: { name: string; text: string }) => void;
  /** The words for a file refused before or as it is read. */
  onRefusal: (words: string) => void;
  /** The list answers Google calendars on (`google.available`): the line also names connecting one (native). */
  google?: boolean;
}

export const IcsImport: (props: IcsImportProps) => React.JSX.Element = (props) => <Mono>{nativeLine(props.google === true)}</Mono>;
