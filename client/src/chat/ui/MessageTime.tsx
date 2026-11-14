import { Platform, StyleSheet, Text } from 'react-native';

import { theme } from '../../theme';
import { formatMessageTime } from '../format';

// What the rows of actions under messages share. `always` is the newest message's row; `hover` is every other
// message's, which the web style sheet (PortalStyles.web.tsx) leaves transparent until the pointer is over the
// message or focus is in it. Native has no hover, so it draws every row.

export type RowShow = 'always' | 'hover';

const web = Platform.OS === 'web';

/** The attributes that mark a message (`data-msg`) on web; none on native. */
export function messageMark(): Record<string, unknown> {
  return web ? { dataSet: { msg: '' } } : {};
}

/** The attributes that mark a row of actions with when it shows, on web; none on native. */
export function rowMark(show: RowShow): Record<string, unknown> {
  return web ? { dataSet: { actions: show } } : {};
}

/** A message's time in its row; nothing when it is not known. */
export function MessageTime(props: { at: number | null }): React.JSX.Element | null {
  if (props.at === null) return null;
  return <Text style={styles.time}>{formatMessageTime(props.at)}</Text>;
}

const styles = StyleSheet.create({
  time: { ...theme.type.mono, color: theme.color.text3, fontVariant: ['tabular-nums'] },
});
