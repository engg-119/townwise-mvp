import { Mono } from '../ui/text';
import { CALENDARS_COPY } from './calendars';

// The calendar file import on native (P28, spec 16.3; connect-owner-calendar design decision 11): no file picker is
// installed, so the "Your calendars" panel says where to import one instead, in the place web's "Import a calendar
// file" has. Web has its own file (IcsImport.web.tsx), which takes the same props. The siblings share only this type:
// on web a value exported here would resolve to the .web file itself, so their words are in calendars.ts.

export interface IcsImportProps {
  /** The id of the panel's help, which describes the import button (web). */
  describedBy: string;
  /** While the panel posts the file chosen last: the button reads "Importing…", disabled (web). */
  pending: boolean;
  /** Under view-as, the panel's read-only line: the button stays in place, disabled and described by it (web). */
  readOnlyId: string | null;
  /** A file of at most 1 MB, read: its name and its text, which the API parses. */
  onFile: (file: { name: string; text: string }) => void;
  /** The words for a file refused before or as it is read. */
  onRefusal: (words: string) => void;
}

export const IcsImport: (props: IcsImportProps) => React.JSX.Element = () => <Mono>{CALENDARS_COPY.nativeLine}</Mono>;
