import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';

import { theme } from '../../theme';
import { formatTime } from '../format';
import { useBreakpoint } from '../hooks';
import type { NavItem } from '../routing';
import { webAria } from '../ui/aria';
import { Button } from '../ui/Button';
import { StatusTag } from '../ui/feedback';
import { Wrap } from '../ui/layout';

// The top bars of spec 15.1 to 15.4 (shell.md 5.1 to 5.4). At least 64px with a 1px `border` rule below:
// - gate: `ground`; wordmark; “Signed in as {email}” and Sign out;
// - client app: `ground`; wordmark, a 20px rule, the organization name, the nav, the email and Sign out;
// - staff console: `panel`; wordmark and the “Staff console” kind tag, the nav with “Requests {n}”, then
//   “Verified until {time}”, the staff email and Sign out.
// Nav links never hide: below 900px (1024px in the console) they take a second row under a rule. At 640px and
// below the email hides and the organization name truncates.

export interface TopBarProps {
  kind: 'gate' | 'client' | 'console';
  email: string;
  orgName?: string;
  nav?: readonly NavItem[];
  /** The console's staff.verifiedUntil, printed as a time, never a counter. */
  verifiedUntil?: string | null;
  /** View-as: End view-as is the way out. */
  signOutDisabled?: boolean;
  /** The id of the line that says why Sign out is disabled. */
  signOutDescribedBy?: string;
  onSignOut: () => void;
}

function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

function NavLink(props: { item: NavItem }): React.JSX.Element {
  const { item } = props;
  const current = item.current !== null;
  return (
    <Link href={item.href} asChild>
      <Pressable
        role="link"
        accessibilityState={{ selected: current }}
        {...webAria({ 'aria-current': item.current ?? undefined })}
        style={styles.navLink}
      >
        {(state) => (
          <Text style={[styles.navText, current || hovered(state) ? styles.white : null]}>
            {item.label}
            {item.count === undefined || item.count === null ? null : <Text style={styles.count}>{` ${String(item.count)}`}</Text>}
          </Text>
        )}
      </Pressable>
    </Link>
  );
}

function Nav(props: { items: readonly NavItem[]; wrapped: boolean }): React.JSX.Element {
  return (
    <View role="navigation" aria-label="Main" style={[styles.nav, { columnGap: props.wrapped ? 20 : 24 }]}>
      {props.items.map((item) => <NavLink key={item.href} item={item} />)}
    </View>
  );
}

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { phone, width } = useBreakpoint();
  const consoleBar = props.kind === 'console';
  const wrapped = consoleBar ? width < 1024 : width < 900;
  const home = consoleBar ? '/admin' : '/dashboard';
  const signOut = (
    <Button
      variant="link"
      label="Sign out"
      disabled={props.signOutDisabled === true}
      {...(props.signOutDescribedBy === undefined ? {} : { describedBy: props.signOutDescribedBy })}
      onPress={props.onSignOut}
    />
  );
  // At 640px and below the gaps tighten to 12px, so the wordmark, the organization and Sign out fit at 320px.
  const tight = phone ? styles.tight : null;
  const identity = (
    <View style={[styles.identity, tight]}>
      <Link href={home} style={styles.wordmark}>Townwise</Link>
      {props.orgName === undefined ? null : (
        <View style={[styles.org, tight]}>
          <View style={styles.rule} />
          <Text numberOfLines={1} style={styles.orgName}>{props.orgName}</Text>
        </View>
      )}
      {consoleBar ? <StatusTag label="Staff console" /> : null}
    </View>
  );
  const me = consoleBar ? (
    <View style={[styles.me, phone ? styles.meRow : null]}>
      <View style={phone ? styles.statusLeft : styles.status}>
        {props.verifiedUntil === undefined || props.verifiedUntil === null ? null : (
          <Text style={styles.mail}>{`Verified until ${formatTime(props.verifiedUntil)}`}</Text>
        )}
        {phone ? null : <Text numberOfLines={1} style={styles.mail}>{props.email}</Text>}
      </View>
      {signOut}
    </View>
  ) : (
    <View style={[styles.me, tight]}>
      {phone ? null : (
        <Text numberOfLines={1} style={[styles.mail, styles.shrink]}>
          {props.kind === 'gate' ? `Signed in as ${props.email}` : props.email}
        </Text>
      )}
      {signOut}
    </View>
  );
  const nav = props.nav === undefined || props.nav.length === 0 ? null : props.nav;
  return (
    <View role="banner" style={[styles.bar, consoleBar ? styles.panel : null]}>
      <Wrap>
        <View style={[styles.row, tight]}>
          {identity}
          {nav !== null && !wrapped ? <Nav items={nav} wrapped={false} /> : null}
          {consoleBar && phone ? null : me}
        </View>
        {consoleBar && phone ? <View style={styles.secondRow}>{me}</View> : null}
        {nav !== null && wrapped ? <View style={styles.navRow}><Nav items={nav} wrapped /></View> : null}
      </Wrap>
    </View>
  );
}

/** The slim footer every signed-in frame ends with (spec 15.1). */
export function Footer(props: { bottomInset: number }): React.JSX.Element {
  return (
    <View role="contentinfo" style={[styles.foot, { paddingBottom: props.bottomInset }]}>
      <Wrap>
        <View style={styles.footRow}>
          <Text style={styles.footText}>Townwise is a student project. It is not an official Dartmouth product.</Text>
          <View role="list" aria-label="Legal" style={styles.footLinks}>
            <View role="listitem"><Link href="/privacy" style={styles.footLink}>Privacy</Link></View>
            <View role="listitem"><Link href="/terms" style={styles.footLink}>Terms</Link></View>
          </View>
        </View>
      </Wrap>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  bar: { backgroundColor: c.ground, borderBottomWidth: 1, borderBottomColor: c.border },
  panel: { backgroundColor: c.panel },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 64, columnGap: 32 },
  identity: { flexDirection: 'row', alignItems: 'center', columnGap: 16, flexShrink: 1, minWidth: 0 },
  wordmark: { ...theme.type.wordmark, color: c.white, minHeight: 44, lineHeight: 44, textDecorationLine: 'none' },
  org: { flexDirection: 'row', alignItems: 'center', columnGap: 16, flexShrink: 1, minWidth: 0 },
  rule: { width: 1, height: 20, backgroundColor: c.border },
  orgName: { ...theme.type.ui, color: c.text2, flexShrink: 1 },
  nav: { flexDirection: 'row', flexWrap: 'wrap', flexShrink: 0 },
  navRow: { borderTopWidth: 1, borderTopColor: c.border },
  navLink: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  navText: { ...theme.type.ui, color: c.text2 },
  white: { color: c.white },
  count: { fontFamily: theme.type.mono.fontFamily, fontVariant: ['tabular-nums'] },
  me: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', columnGap: 20, flexShrink: 1, minWidth: 0 },
  meRow: { marginLeft: 0, flex: 1, justifyContent: 'space-between' },
  status: { alignItems: 'flex-end', minWidth: 0, flexShrink: 1 },
  statusLeft: { alignItems: 'flex-start' },
  secondRow: { flexDirection: 'row', minHeight: 44, alignItems: 'center' },
  mail: { ...theme.type.mono, color: c.text3 },
  shrink: { flexShrink: 1 },
  tight: { columnGap: 12 },
  foot: { borderTopWidth: 1, borderTopColor: c.border },
  footRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 24, minHeight: 64 },
  footText: { ...theme.type.mono, color: c.text3 },
  footLinks: { flexDirection: 'row', columnGap: 24 },
  footLink: { ...theme.type.mono, color: c.text3, textDecorationLine: 'underline', textDecorationColor: c.line, minHeight: 44, lineHeight: 44 },
});
