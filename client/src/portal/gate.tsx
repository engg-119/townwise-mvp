import { useCallback } from 'react';
import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { CONTACT_HREF } from '../marketing/links';
import { theme } from '../theme';
import { COPY } from './errors';
import { useAction, useBreakpoint } from './hooks';
import { usePortal, useReadOnly } from './PortalProvider';
import type { Invitation, MeResponse } from './schemas';
import { webAria } from './ui/aria';
import { ErrorNotice } from './ui/feedback';
import { Mono } from './ui/text';

// Pieces the gate pages share (spec 16.2, the RequestAccess, Pending, NoAccess and Joining boards).

/** The person a page speaks to: the view-as target during view-as, otherwise the signed-in person. */
export function personEmail(me: MeResponse): string {
  return me.viewAs?.target.email ?? me.user.email;
}

/** Who added an invitation: the org admin's email, “Townwise staff”, or the organization when that account is gone. */
export function inviterOf(invitation: Invitation): string {
  if (invitation.invitedBy.staff) return 'Townwise staff';
  return invitation.invitedBy.email ?? invitation.orgName;
}

/** A side column's heading in the eyebrow style (“What happens next”). */
export function SideHeading(props: { children: string }): React.JSX.Element {
  return <Text role="heading" {...webAria({ 'aria-level': 2 })} style={styles.sideHeading}>{props.children}</Text>;
}

/** The numbered, ruled list of a gate page's side column (01 to 03). */
export function NumberedList(props: { items: readonly string[]; label?: string }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <View role="list" {...(props.label === undefined ? {} : { 'aria-label': props.label })} style={styles.list}>
      {props.items.map((item, index) => (
        <View key={item} role="listitem" style={styles.item}>
          <Mono tone="text3" style={styles.counter}>{String(index + 1).padStart(2, '0')}</Mono>
          <Text style={[phone ? theme.type.sub : theme.type.small, styles.itemText]}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * “Signed in as {email}. Using the wrong Google account? Sign out and continue with another one.” The email is
 * the signed-in person's (the staff member's during view-as, when Sign out is disabled).
 */
export function SignedInLine(): React.JSX.Element {
  const auth = useAuth();
  const { me } = usePortal();
  const { readOnly, line } = useReadOnly();
  const { phone } = useBreakpoint();
  const signOut = useAction(useCallback(() => auth.signOut(), [auth]));
  return (
    <View style={styles.me}>
      <Text style={[phone ? theme.type.sub : theme.type.small, styles.meText]}>
        {`Signed in as ${me.user.email}. Using the wrong Google account? `}
        <Text
          role="link"
          aria-disabled={readOnly}
          {...(readOnly ? { accessibilityHint: line } : { onPress: signOut.run })}
          style={readOnly ? styles.linkDisabled : styles.link}
        >
          Sign out
        </Text>
        {' and continue with another one.'}
      </Text>
      {signOut.error === null ? null : <ErrorNotice message={COPY.signOutFailed} />}
    </View>
  );
}

/** “Questions: hello@townwise.tech.” */
export function QuestionsLine(): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <Text style={[phone ? theme.type.sub : theme.type.small, styles.meText]}>
      {'Questions: '}
      <Link href={CONTACT_HREF} style={styles.link}>hello@townwise.tech</Link>
      .
    </Text>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  sideHeading: { ...theme.type.label, color: c.text3, marginBottom: 12 },
  list: { borderTopWidth: 1, borderTopColor: c.border },
  item: { flexDirection: 'row', columnGap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  counter: { width: 28, lineHeight: 20 },
  itemText: { color: c.text2, flex: 1, minWidth: 0 },
  me: { gap: theme.space[4], paddingTop: theme.space[4], borderTopWidth: 1, borderTopColor: c.border },
  meText: { color: c.text2 },
  link: { color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  linkDisabled: { color: c.text3, textDecorationLine: 'underline', textDecorationColor: c.border },
});
