import { useCallback } from 'react';
import Head from 'expo-router/head';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { endViewAs } from '../api';
import { useAction, useBreakpoint } from '../hooks';
import { usePortal } from '../PortalProvider';
import type { OpenAsAdmin } from '../schemas';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { Wrap } from '../ui/layout';

// The open-as-admin banner (spec 15.5a): the view-as banner's place, look and phone layout (ViewAsBanner), with one
// line and no time. It cannot be dismissed. End (POST /api/admin/view-as/end with this grant's id, so a tab left on an
// earlier grant never ends a newer one) answers the staff member's own access, so the portal layout opens /admin, where “Setting up {org} as
// Townwise staff ended at {time}.” shows once. Every control on the pages below stays enabled, Sign out among them.

export function openAsAdminLine(org: string): string {
  return `You’re setting up ${org} as Townwise staff. This ends when someone joins.`;
}

export function OpenAsAdminBanner(props: { openAsAdmin: OpenAsAdmin }): React.JSX.Element {
  const { openAsAdmin } = props;
  const { api, applyMe } = usePortal();
  const { phone } = useBreakpoint();
  const end = useAction(useCallback(async () => { applyMe(await endViewAs(api, openAsAdmin.id)); }, [api, applyMe, openAsAdmin.id]));
  const failed = end.error !== null;
  const line = openAsAdminLine(openAsAdmin.org.name);
  return (
    <View role="region" aria-label="Townwise staff setup" style={styles.banner}>
      {Platform.OS === 'web' ? <Head><title>{`Setting up ${openAsAdmin.org.name} · Townwise`}</title></Head> : null}
      <Wrap>
        <View style={phone ? styles.columns : styles.row}>
          <Text style={styles.text}>{line}</Text>
          <Button variant="outline" label="End" disabled={end.pending} block={phone} onPress={end.run} />
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
  text: { ...theme.type.ui, color: c.white, flex: 1, minWidth: 0 },
  error: { paddingBottom: 12 },
});
