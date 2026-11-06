import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'expo-router';
import {
  Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type LayoutRectangle, type PressableStateCallbackType,
} from 'react-native';

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
// - client app: `ground`; wordmark, a 20px rule, the organization name, the nav (the location's sections, then
//   Team and Settings as a group on the right), the email and Sign out;
// - staff console: `panel`; wordmark and the “Staff console” kind tag, the nav with “Requests {n}”, then
//   “Verified until {time}”, the staff email and Sign out.
// Nav links never hide: below 900px (1024px in the console, 1280px when the client app's bar carries a
// location's sections, which need the room) they take a second row under a rule. At 640px and
// below the email hides and the organization name truncates; the console puts “Verified until” under the wordmark,
// beside Sign out, so its bar is one band and the nav. The client app's second row is then one line in a
// focusable region that scrolls sideways, kept on the current section.

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

function NavLink(props: { item: NavItem; onMeasure?: (href: string, layout: LayoutRectangle) => void }): React.JSX.Element {
  const { item, onMeasure } = props;
  const current = item.current !== null;
  return (
    <Link href={item.href} asChild>
      <Pressable
        role="link"
        accessibilityState={{ selected: current }}
        {...webAria({ 'aria-current': item.current ?? undefined })}
        {...(onMeasure === undefined ? {} : { onLayout: (event: LayoutChangeEvent) => { onMeasure(item.href, event.nativeEvent.layout); } })}
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

/** The nav, with the items from the first `end` one on as a group at the row's far end. */
function Nav(props: { items: readonly NavItem[]; wrapped: boolean }): React.JSX.Element {
  const gap = { columnGap: props.wrapped ? 20 : 24 };
  const split = props.items.findIndex((item) => item.end === true);
  if (split <= 0) {
    return (
      <View role="navigation" aria-label="Main" style={[styles.nav, gap]}>
        {props.items.map((item) => <NavLink key={item.href} item={item} />)}
      </View>
    );
  }
  return (
    <View role="navigation" aria-label="Main" style={[styles.nav, styles.navSplit, gap]}>
      {props.items.slice(0, split).map((item) => <NavLink key={item.href} item={item} />)}
      <View style={[styles.navEnd, gap]}>
        {props.items.slice(split).map((item) => <NavLink key={item.href} item={item} />)}
      </View>
    </View>
  );
}

/** The phone gutter the scroller reaches into, so a link's focus ring at either end is not cut off. */
const BLEED = 16;

/**
 * The client app's nav on phones: one row in a focusable region that scrolls sideways when it doesn't fit, as
 * far into the margins as the screen. The row scrolls (without animating) to keep the current item in view, on
 * mount and whenever the route changes.
 */
function ScrollingNav(props: { items: readonly NavItem[] }): React.JSX.Element {
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [viewport, setViewport] = useState(0);
  const [spans, setSpans] = useState<Readonly<Record<string, { x: number; width: number }>>>({});
  const current = props.items.find((item) => item.current !== null)?.href;
  const span = current === undefined ? undefined : spans[current];
  // The least scroll that shows the whole current item and the margin after it: none for the first items, the
  // row's end for the last. A link's x is measured from the nav, which starts after the row's BLEED.
  const target = span === undefined || viewport === 0 ? null : Math.max(0, BLEED + span.x + span.width + BLEED - viewport);
  useEffect(() => {
    if (target !== null) scroller.current?.scrollTo({ x: target, animated: false });
  }, [current, target]);
  const measure = useCallback((href: string, { x, width }: LayoutRectangle) => {
    setSpans((before) => (before[href]?.x === x && before[href].width === width ? before : { ...before, [href]: { x, width } }));
  }, []);
  return (
    <View
      role="region"
      aria-label="Sections"
      focusable
      onLayout={(event) => { setViewport(event.nativeEvent.layout.width); }}
      style={styles.scrollRegion}
    >
      <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollRow}>
        {/* Keyed by the items: when the sections arrive (the organization loaded) the links mount again and measure
            where they now sit, as the web's onLayout reports a change of size, not a move. */}
        <View key={props.items.map((item) => item.href).join(' ')} role="navigation" aria-label="Main" style={[styles.nav, styles.navLine]}>
          {props.items.map((item) => <NavLink key={item.href} item={item} onMeasure={measure} />)}
        </View>
      </ScrollView>
    </View>
  );
}

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { phone, width } = useBreakpoint();
  const consoleBar = props.kind === 'console';
  const sections = (props.nav ?? []).findIndex((item) => item.end === true) > 0;
  const wrapped = width < (consoleBar ? 1024 : sections ? 1280 : 900);
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
  // At 640px and below the gaps tighten to 12px and Sign out holds its width: the organization name takes the
  // squeeze and truncates with an ellipsis, so Sign out stays inside the 16px margin at 320px and never wraps. The
  // console has no organization name to squeeze, so its kind tag keeps the 16px gap from the wordmark.
  const tight = phone ? styles.tight : null;
  const identity = (
    <View style={[styles.identity, consoleBar ? null : tight]}>
      <Link href={home} style={styles.wordmark}>Townwise</Link>
      {props.orgName === undefined ? null : (
        <View style={[styles.org, tight]}>
          <View style={styles.rule} />
          <Text numberOfLines={1} style={styles.orgName}>{props.orgName}</Text>
        </View>
      )}
      {consoleBar ? <View style={styles.tagSlot}><StatusTag label="Staff console" /></View> : null}
    </View>
  );
  const verified = props.verifiedUntil === undefined || props.verifiedUntil === null ? null : (
    <Text style={styles.mail}>{`Verified until ${formatTime(props.verifiedUntil)}`}</Text>
  );
  let me: React.JSX.Element;
  if (phone) {
    // Only Sign out, which never shrinks.
    me = <View style={[styles.me, styles.hold]}>{signOut}</View>;
  } else if (consoleBar) {
    me = (
      <View style={styles.me}>
        <View style={styles.status}>
          {verified}
          <Text numberOfLines={1} style={styles.mail}>{props.email}</Text>
        </View>
        {signOut}
      </View>
    );
  } else {
    me = (
      <View style={styles.me}>
        <Text numberOfLines={1} style={[styles.mail, styles.shrink]}>
          {props.kind === 'gate' ? `Signed in as ${props.email}` : props.email}
        </Text>
        {signOut}
      </View>
    );
  }
  const nav = props.nav === undefined || props.nav.length === 0 ? null : props.nav;
  let navRow: React.ReactNode = null;
  if (nav !== null && wrapped) {
    navRow = <View style={styles.navRow}>{phone && props.kind === 'client' ? <ScrollingNav items={nav} /> : <Nav items={nav} wrapped />}</View>;
  }
  return (
    <View role="banner" style={[styles.bar, consoleBar ? styles.panel : null]}>
      <Wrap>
        <View style={[styles.row, tight]}>
          {consoleBar && phone ? <View style={styles.stacked}>{identity}{verified}</View> : identity}
          {nav !== null && !wrapped ? <Nav items={nav} wrapped={false} /> : null}
          {me}
        </View>
        {navRow}
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
  // StatusTag sets alignSelf: 'flex-start' for list rows; here it centers on the 44px wordmark.
  tagSlot: { alignSelf: 'center' },
  org: { flexDirection: 'row', alignItems: 'center', columnGap: 16, flexShrink: 1, minWidth: 0 },
  rule: { width: 1, height: 20, backgroundColor: c.border },
  orgName: { ...theme.type.ui, color: c.text2, flexShrink: 1 },
  nav: { flexDirection: 'row', flexWrap: 'wrap', flexShrink: 0 },
  // With a right-hand group the nav takes the row's free width, and the group sits at its far end.
  navSplit: { flexGrow: 1 },
  navEnd: { flexDirection: 'row', marginLeft: 'auto' },
  navLine: { flexWrap: 'nowrap', columnGap: 20 },
  scrollRegion: { marginHorizontal: -BLEED },
  scrollRow: { flexGrow: 1, paddingHorizontal: BLEED },
  navRow: { borderTopWidth: 1, borderTopColor: c.border },
  navLink: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  navText: { ...theme.type.ui, color: c.text2 },
  white: { color: c.white },
  count: { fontFamily: theme.type.mono.fontFamily, fontVariant: ['tabular-nums'] },
  me: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', columnGap: 20, flexShrink: 1, minWidth: 0 },
  hold: { flexShrink: 0 },
  status: { alignItems: 'flex-end', minWidth: 0, flexShrink: 1 },
  // The console on phones: the wordmark and kind tag, “Verified until” under them, and 12px below it.
  stacked: { flexShrink: 1, minWidth: 0, paddingBottom: 12 },
  mail: { ...theme.type.mono, color: c.text3 },
  shrink: { flexShrink: 1 },
  tight: { columnGap: 12 },
  foot: { borderTopWidth: 1, borderTopColor: c.border },
  footRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 24, minHeight: 64 },
  footText: { ...theme.type.mono, color: c.text3 },
  footLinks: { flexDirection: 'row', columnGap: 24 },
  footLink: { ...theme.type.mono, color: c.text3, textDecorationLine: 'underline', textDecorationColor: c.line, minHeight: 44, lineHeight: 44 },
});
