import { StyleSheet, View } from 'react-native';

import { Mono } from '../ui/text';
import type { ImportedCalendar } from './model';

// The owner's calendar file on native (P28, spec 16.3): no file picker is installed, so the header row says
// where to import one instead, on the full-width line under the row where web shows its help. Web has its own file
// (IcsImport.web.tsx), which takes the same props.

export const NATIVE_IMPORT_LINE = 'To add events from your own calendar file, open Townwise on the web.';

export interface IcsImportProps {
  /** The page's day, for the 400 days either side that a file's events are kept within. */
  today: string;
  /** The file read last, while the page is open; null before one. */
  imported: ImportedCalendar | null;
  onImport: (imported: ImportedCalendar) => void;
}

export const IcsImport: (props: IcsImportProps) => React.JSX.Element = () => (
  <View style={styles.line}><Mono>{NATIVE_IMPORT_LINE}</Mono></View>
);

const styles = StyleSheet.create({
  line: { flexBasis: '100%' },
});
