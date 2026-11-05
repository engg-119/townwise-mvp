import { useCallback } from 'react';
import Head from 'expo-router/head';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { endViewAs } from '../api';
import { formatTime, roleLabel } from '../format';
import { useAction, useBreakpoint } from '../hooks';
import { usePortal } from '../PortalProvider';
import type { ViewAs } from '../schemas';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { Wrap } from '../ui/layout';
import { Eyebrow } from '../ui/text';

// The view-as banner (spec 15.5, shell.md 5.6): first in the page above the top bar, at least 52px, a `raised`
// fill with a 1px `line` rule below, and no mint, warning or error colour: the words carry the meaning. It cannot
// be dismissed. End view-as (POST /api/admin/view-as/end) is the way out; the answer is the staff member's own
// access, so the portal layout opens /admin, where “View-as ended at {time}.” shows once. On phones it is two rows
// (spec 15.5): the words as one paragraph, then End view-as at full width.

/** The banner's “Read-only until {time}.” line, which also explains the disabled Sign out in the top bar. */
export const VIEW_AS_LINE_ID = 'view-as-until';

export function viewAsWho(viewAs: ViewAs): string {
  const { email } = viewAs.target;
  if (viewAs.org === null || viewAs.role === null) return `${email}, signed in, no organization.`;
  return `${email}, ${roleLabel(viewAs.role)} at ${viewAs.org.name}.`;
}

export function ViewAsBanner(props: { viewAs: ViewAs }): React.JSX.Element {
  const { viewAs } = props;
  const { api, applyMe } = usePortal();
  const { phone } = useBreakpoint();
  const end = useAction(useCallback(async () => { applyMe(await endViewAs(api)); }, [api, applyMe]));
  const failed = end.error !== null;
  const until = <Text nativeID={VIEW_AS_LINE_ID} style={styles.until}>{`Read-only until ${formatTime(viewAs.endsAt)}.`}</Text>;
  // Phones run the three parts together as one wrapping paragraph instead of stacking them with gaps between.
  const text = phone ? (
    <Text style={styles.paragraph}>
      <Eyebrow>Viewing as</Eyebrow>{'  '}<Text style={styles.who}>{viewAsWho(viewAs)}</Text>{'  '}{until}
    </Text>
  ) : (
    <View style={styles.text}>
      <Eyebrow>Viewing as</Eyebrow>
      <Text style={styles.who}>{viewAsWho(viewAs)}</Text>
      {until}
    </View>
  );
  return (
    <View role="region" aria-label="View-as" style={styles.banner}>
      {Platform.OS === 'web' ? <Head><title>{`Viewing as ${viewAs.target.email} · Townwise`}</title></Head> : null}
      <Wrap>
        <View style={phone ? styles.columns : styles.row}>
          {text}
          <Button variant="outline" label="End view-as" disabled={end.pending} block={phone} onPress={end.run} />
        </View>
        {failed ? <View style={styles.error}><ErrorNotice error={end.error} /></View> : null}
      </Wrap>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  banner: { backgroundColor: c.raised, borderBottomWidth: 1, borderBottomColor: c.line },
  row: { flexDirection: 'row', alignItems: 'center', columnGap: 20, minHeight: 52, paddingVertical: 4 },
  columns: { gap: 8, paddingVertical: 8 },
  text: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 16, rowGap: 4 },
  paragraph: { ...theme.type.ui, color: c.white },
  who: { ...theme.type.ui, color: c.white, flexShrink: 1 },
  until: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  error: { paddingBottom: 12 },
});
